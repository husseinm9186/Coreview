//! The webview's structured inputs, checked from this side (LT-259, LT-266).
//!
//! `fixtures/ipc/*.json` are written from the builders in
//! `src/lib/ipcPayloads.ts`, which send only declared fields; the frontend test
//! fails if a builder and its fixture drift apart. Here each fixture must be
//! read by the struct the command declares — and refused once one field more is
//! added at any depth, or a field has the wrong type. Then every input is fed
//! mutations of itself and arbitrary JSON, which must come back as an error or
//! a value, never a panic.

use proptest::prelude::*;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::db::{EventRow, ProjectPackage};
use crate::discovery::{BackupInput, CrawlInput, CredentialInput};
use crate::vault_commands::SaveCredential;
use crate::visio::VisioDrawing;
use coreview_discover::checks::Check;
use coreview_probe::sweep::SweepOptions;
use coreview_probe::types::ProbeConfig;

fn fixture(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/ipc").join(format!("{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

fn reads<T: DeserializeOwned>(v: &Value) -> Result<T, String> {
    serde_json::from_value::<T>(v.clone()).map_err(|e| e.to_string())
}

/// Every object inside `v`, by its path, so one field can be added to each.
fn object_paths(v: &Value, at: Vec<String>, out: &mut Vec<Vec<String>>) {
    match v {
        Value::Object(m) => {
            out.push(at.clone());
            for (k, child) in m {
                // The project document is opaque to Rust on purpose.
                if k == "document" {
                    continue;
                }
                let mut next = at.clone();
                next.push(k.clone());
                object_paths(child, next, out);
            }
        }
        Value::Array(a) => {
            for (i, child) in a.iter().enumerate() {
                let mut next = at.clone();
                next.push(i.to_string());
                object_paths(child, next, out);
            }
        }
        _ => {}
    }
}

fn at_mut<'a>(v: &'a mut Value, path: &[String]) -> &'a mut Value {
    path.iter().fold(v, |v, k| match v {
        Value::Array(a) => &mut a[k.parse::<usize>().unwrap()],
        other => other.get_mut(k).unwrap(),
    })
}

fn contract<T: DeserializeOwned>(name: &str) {
    let good = fixture(name);
    reads::<T>(&good).unwrap_or_else(|e| panic!("{name}: the frontend's own payload is refused: {e}"));
    let mut paths = Vec::new();
    object_paths(&good, Vec::new(), &mut paths);
    assert!(!paths.is_empty());
    for path in paths {
        let mut bad = good.clone();
        at_mut(&mut bad, &path).as_object_mut().unwrap().insert("injected".into(), json!(true));
        let err = reads::<T>(&bad).err().unwrap_or_else(|| panic!("{name}: an undeclared field at /{} was accepted", path.join("/")));
        assert!(err.contains("unknown field"), "{name} /{}: {err}", path.join("/"));
    }
    // A field of the wrong type is an error too.
    if let Value::Object(m) = &good {
        for key in m.keys() {
            let mut bad = good.clone();
            bad[key] = json!({ "not": ["what", "was", "expected"] });
            if key != "document" {
                assert!(reads::<T>(&bad).is_err(), "{name}: {key} as an object was accepted");
            }
        }
    }
}

#[test]
fn every_input_reads_the_frontends_payload_and_nothing_more() {
    contract::<ProbeConfig>("probe_config");
    contract::<ProjectPackage>("project_package");
    contract::<EventRow>("event_row");
    contract::<CredentialInput>("credential_input");
    contract::<CrawlInput>("crawl_input");
    contract::<BackupInput>("backup_input");
    contract::<SweepOptions>("sweep_options");
    contract::<SaveCredential>("save_credential");
    contract::<Check>("check");
    contract::<VisioDrawing>("visio_drawing");
}

/// Arbitrary JSON, a few levels deep.
fn any_json() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        any::<i64>().prop_map(|n| json!(n)),
        any::<f64>().prop_filter("finite", |f| f.is_finite()).prop_map(|f| json!(f)),
        ".{0,40}".prop_map(Value::String),
    ];
    leaf.prop_recursive(4, 64, 8, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..8).prop_map(Value::Array),
            prop::collection::hash_map("[a-z_]{1,16}", inner, 0..8).prop_map(|m| Value::Object(m.into_iter().collect())),
        ]
    })
}

fn survives<T: DeserializeOwned>(v: &Value) {
    // An error or a value; a panic fails the property.
    let _ = serde_json::from_value::<T>(v.clone());
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, ..ProptestConfig::default() })]

    #[test]
    fn arbitrary_json_is_refused_or_read_never_a_panic(v in any_json()) {
        survives::<ProbeConfig>(&v);
        survives::<ProjectPackage>(&v);
        survives::<EventRow>(&v);
        survives::<CrawlInput>(&v);
        survives::<BackupInput>(&v);
        survives::<SweepOptions>(&v);
        survives::<SaveCredential>(&v);
        survives::<Check>(&v);
        survives::<VisioDrawing>(&v);
    }

    /// Each fixture with one of its values replaced by something arbitrary:
    /// closer to a real mistake than random JSON, and still never a panic.
    #[test]
    fn a_payload_with_any_one_value_replaced_is_handled(which in 0usize..10, key in 0usize..32, v in any_json()) {
        let names = ["probe_config", "project_package", "event_row", "credential_input", "crawl_input", "backup_input", "sweep_options", "save_credential", "check", "visio_drawing"];
        let mut payload = fixture(names[which]);
        if let Value::Object(m) = &mut payload {
            let keys: Vec<String> = m.keys().cloned().collect();
            let k = &keys[key % keys.len()];
            m.insert(k.clone(), v);
        }
        survives::<ProbeConfig>(&payload);
        survives::<ProjectPackage>(&payload);
        survives::<EventRow>(&payload);
        survives::<CrawlInput>(&payload);
        survives::<BackupInput>(&payload);
        survives::<SweepOptions>(&payload);
        survives::<SaveCredential>(&payload);
        survives::<Check>(&payload);
        survives::<VisioDrawing>(&payload);
    }
}
