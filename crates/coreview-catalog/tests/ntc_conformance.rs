//! the acceptance: the Rust TextFSM engine gives exactly the rows in
//! every vendored ntc-templates fixture — each `tests/<platform>/<command>/
//! *.raw` against its `.yml` — joining the further templates the index
//! names for that command, as ntc's own test does through clitable. Every
//! pair under `resources/templates/tests` is run; the test fails on one
//! mismatch and names every one.

use std::path::PathBuf;

use coreview_catalog::textfsm::{Engine, Index};
use serde_json::Value;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn every_vendored_ntc_fixture_parses_exactly() {
    run(&repo().join("resources/templates/ntc"), &repo().join("resources/templates/tests"), 519);
}

/// Set the bar at ntc-templates' *whole* test suite; only the
/// catalogs' share is vendored. Point `COREVIEW_NTC_CHECKOUT` at an
/// ntc-templates clone to run all of it.
#[test]
fn the_whole_upstream_suite_when_a_checkout_is_named() {
    let Ok(checkout) = std::env::var("COREVIEW_NTC_CHECKOUT") else {
        eprintln!("skipped: set COREVIEW_NTC_CHECKOUT to an ntc-templates clone");
        return;
    };
    let root = PathBuf::from(checkout);
    run(&root.join("ntc_templates/templates"), &root.join("tests"), 1);
}

fn run(ntc: &std::path::Path, tests: &std::path::Path, at_least: usize) {
    let ntc = ntc.to_path_buf();
    let tests = tests.to_path_buf();
    let engine = Engine::new(&ntc);
    let index = Index::load(&ntc).unwrap();
    let mut pairs = Vec::new();
    for platform in std::fs::read_dir(&tests).unwrap().flatten() {
        if !platform.path().is_dir() {
            continue;
        }
        for command in std::fs::read_dir(platform.path()).unwrap().flatten() {
            // As ntc's own test: the folder names the platform and the command
            // (`show_ip_arp` → `show ip arp`), and the index picks the templates.
            let platform_name = platform.file_name().to_string_lossy().to_string();
            let command_text = command.file_name().to_string_lossy().replace('_', " ");
            for f in std::fs::read_dir(command.path()).unwrap().flatten() {
                let p = f.path();
                if p.extension().and_then(|x| x.to_str()) == Some("raw") && p.with_extension("yml").exists() {
                    pairs.push(((platform_name.clone(), command_text.clone()), p));
                }
            }
        }
    }
    pairs.sort();
    assert!(pairs.len() >= at_least, "only {} fixture pairs", pairs.len());
    let mut failures = Vec::new();
    for ((platform, command), raw_path) in &pairs {
        let raw = std::fs::read_to_string(raw_path).unwrap();
        let yml: serde_yaml_ng::Value = serde_yaml_ng::from_str(&std::fs::read_to_string(raw_path.with_extension("yml")).unwrap()).unwrap();
        let expected: Value = serde_json::to_value(&yml["parsed_sample"]).unwrap();
        let Some(templates) = index.lookup(platform, command) else {
            failures.push(format!("{}: the index has no row for {platform} / {command}", raw_path.strip_prefix(&tests).unwrap().display()));
            continue;
        };
        match engine.parse(&templates[0], &templates[1..], &raw) {
            Ok(rows) => {
                let got = Value::Array(rows.into_iter().map(Value::Object).collect());
                if got != expected {
                    failures.push(format!("{}: rows differ", raw_path.strip_prefix(&tests).unwrap().display()));
                }
            }
            Err(e) => failures.push(format!("{}: {e}", raw_path.strip_prefix(&tests).unwrap().display())),
        }
    }
    println!("{} of {} ntc fixtures pass ({})", pairs.len() - failures.len(), pairs.len(), tests.display());
    assert!(failures.is_empty(), "{} of {} failed:\n{}", failures.len(), pairs.len(), failures.join("\n"));
}
