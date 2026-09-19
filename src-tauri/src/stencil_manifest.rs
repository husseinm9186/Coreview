//! The stencil manifest (LT-169): an optional `coreview-stencils.json` at the
//! root of an icon library folder that says what each shape *is* — its device
//! class, vendor, model, ports and rack units — and under what licence the
//! folder's artwork is used.
//!
//! Coreview ships no vendor artwork (D-028). A manifest is how an operator's
//! own stencils — including vendor packs they have the right to use — arrive
//! on the canvas as properly described devices rather than as bare pictures.
//! The licence statement is required because the operator, not Coreview, is
//! responsible for it, and an export of a project using these shapes names it
//! (LT-170).
//!
//! Validation is strict and all-or-nothing: unknown fields, a wrong version, a
//! path that tries to leave the folder, an unknown class or an out-of-range
//! number rejects the whole manifest with a reason naming the shape and field.
//! The shapes themselves still load — only the description is refused — so a
//! typo never empties a palette.
//!
//! ```json
//! {
//!   "coreviewStencils": 1,
//!   "name": "Lab shapes",
//!   "licence": "Drawn by the lab team; free to use internally",
//!   "source": "optional: where the artwork came from",
//!   "shapes": [
//!     { "file": "edge-router.svg", "name": "Edge router", "category": "Routing",
//!       "class": "router", "vendor": "Example Networks", "model": "ER-8",
//!       "ports": 8, "portNaming": "ge-0/0/{n}", "rackUnits": 1 }
//!   ]
//! }
//! ```

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// The file name the scan looks for, at the root of the library folder.
pub const MANIFEST_FILE: &str = "coreview-stencils.json";

/// The one version this build reads.
const VERSION: u32 = 1;

/// The device classes a shape may declare. Mirrors the device types in
/// `src/types/domain.ts` less the plain drawing shapes; a unit test on the
/// TypeScript side fails if the two lists drift apart.
pub const CLASSES: &[&str] = &[
    "generic",
    "firewall",
    "router",
    "core-switch",
    "distribution-switch",
    "access-switch",
    "l3-switch",
    "l2-switch",
    "wireless-controller",
    "access-point",
    "ip-phone",
    "blade-chassis",
    "load-balancer",
    "waf",
    "server",
    "vm",
    "vm-host",
    "storage",
    "endpoint",
    "printer",
    "camera",
    "internet",
    "private-cloud",
    "site",
    "vpn",
    "mpls-cloud",
    "rack",
    "patch-panel",
    "pdu",
    "ups",
    "application",
    "database",
];

const MAX_SHAPES: usize = 2000;
const MAX_TEXT: usize = 120;
const MAX_LONG_TEXT: usize = 500;
const MAX_PORTS: u32 = 1024;
const MAX_RACK_UNITS: u32 = 60;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawManifest {
    coreview_stencils: u32,
    #[serde(default)]
    name: Option<String>,
    licence: String,
    #[serde(default)]
    source: Option<String>,
    shapes: Vec<RawShape>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawShape {
    file: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    class: Option<String>,
    #[serde(default)]
    vendor: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    ports: Option<u32>,
    #[serde(default)]
    port_naming: Option<String>,
    #[serde(default)]
    rack_units: Option<u32>,
}

/// What a manifest says about one shape, as sent to the frontend with the
/// icon it describes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StencilMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ports: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port_naming: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rack_units: Option<u32>,
    /// The folder's licence statement, carried onto every shape so an export
    /// can name it.
    pub licence: String,
}

/// One shape's entry: its display name and category, if the manifest gives
/// them, and its description.
#[derive(Debug, Clone, PartialEq)]
pub struct ShapeEntry {
    pub name: Option<String>,
    pub category: Option<String>,
    pub meta: StencilMeta,
}

/// A validated manifest, looked up by file name.
#[derive(Debug, Default)]
pub struct Manifest {
    by_file: HashMap<String, ShapeEntry>,
}

impl Manifest {
    pub fn get(&self, file_name: &str) -> Option<&ShapeEntry> {
        self.by_file.get(file_name)
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.by_file.len()
    }
}

/// Reads the manifest at the root of `dir`.
///
/// `Ok(None)` when there is none; `Err` with a reason fit to show the
/// operator when there is one and it is refused.
pub fn load(dir: &Path) -> Result<Option<Manifest>, String> {
    let path = dir.join(MANIFEST_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{MANIFEST_FILE}: {e}"))?;
    parse(&text, |file| dir.join(file).is_file()).map(Some).map_err(|e| format!("{MANIFEST_FILE}: {e}"))
}

fn text(field: &str, value: &Option<String>, max: usize) -> Result<Option<String>, String> {
    match value.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(v) if v.chars().count() > max => Err(format!("{field} is longer than {max} characters")),
        Some(v) if v.chars().any(char::is_control) => Err(format!("{field} contains a control character")),
        Some(v) => Ok(Some(v.to_string())),
    }
}

/// Validates manifest text. `exists` says whether a named file is in the
/// folder — injected so the rules are testable without a disk.
pub fn parse(text_in: &str, exists: impl Fn(&str) -> bool) -> Result<Manifest, String> {
    let raw: RawManifest =
        serde_json::from_str(text_in).map_err(|e| format!("not a valid manifest: {e}"))?;
    if raw.coreview_stencils != VERSION {
        return Err(format!(
            "coreviewStencils is {}, and this version of Coreview reads {VERSION}",
            raw.coreview_stencils
        ));
    }
    let licence = text("licence", &Some(raw.licence), MAX_LONG_TEXT)?
        .ok_or("licence is required — say under what terms this artwork is used")?;
    text("name", &raw.name, MAX_TEXT)?;
    text("source", &raw.source, MAX_LONG_TEXT)?;
    if raw.shapes.len() > MAX_SHAPES {
        return Err(format!("{} shapes is more than the {MAX_SHAPES} a library holds", raw.shapes.len()));
    }

    let classes: HashSet<&str> = CLASSES.iter().copied().collect();
    let mut by_file = HashMap::new();
    for (i, s) in raw.shapes.into_iter().enumerate() {
        let at = |msg: String| format!("shape {} ({}): {msg}", i + 1, s.file);
        let file = s.file.trim();
        if file.is_empty() {
            return Err(format!("shape {}: file is required", i + 1));
        }
        if file.contains('/') || file.contains('\\') || file == "." || file == ".." || file.contains('\0') {
            return Err(at("file must be a plain file name in the manifest's own folder".into()));
        }
        if file.len() > 255 {
            return Err(at("file name is too long".into()));
        }
        if by_file.contains_key(file) {
            return Err(at("listed twice".into()));
        }
        if !exists(file) {
            return Err(at("no such file in the folder".into()));
        }
        let class = text("class", &s.class, MAX_TEXT).map_err(at)?;
        if let Some(c) = &class {
            if !classes.contains(c.as_str()) {
                return Err(at(format!("class \"{c}\" is not a Coreview device class")));
            }
        }
        if let Some(p) = s.ports {
            if p > MAX_PORTS {
                return Err(at(format!("ports is {p}, more than {MAX_PORTS}")));
            }
        }
        let port_naming = text("portNaming", &s.port_naming, 60).map_err(at)?;
        if let Some(n) = &port_naming {
            if !n.contains("{n}") {
                return Err(at("portNaming must contain {n}, the port number".into()));
            }
        }
        if let Some(u) = s.rack_units {
            if u > MAX_RACK_UNITS {
                return Err(at(format!("rackUnits is {u}, more than {MAX_RACK_UNITS}")));
            }
        }
        let entry = ShapeEntry {
            name: text("name", &s.name, MAX_TEXT).map_err(at)?,
            category: text("category", &s.category, MAX_TEXT).map_err(at)?,
            meta: StencilMeta {
                class,
                vendor: text("vendor", &s.vendor, MAX_TEXT).map_err(at)?,
                model: text("model", &s.model, MAX_TEXT).map_err(at)?,
                ports: s.ports,
                port_naming,
                rack_units: s.rack_units,
                licence: licence.clone(),
            },
        };
        by_file.insert(file.to_string(), entry);
    }
    Ok(Manifest { by_file })
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{
      "coreviewStencils": 1,
      "name": "Lab shapes",
      "licence": "Drawn by the lab team",
      "shapes": [
        { "file": "edge.svg", "name": "Edge router", "category": "Routing", "class": "router",
          "vendor": "Example Networks", "model": "ER-8", "ports": 8, "portNaming": "ge-0/0/{n}", "rackUnits": 1 },
        { "file": "plain.svg" }
      ]
    }"#;

    fn all_exist(_: &str) -> bool {
        true
    }

    #[test]
    fn reads_a_good_manifest() {
        let m = parse(GOOD, all_exist).expect("valid");
        assert_eq!(m.len(), 2);
        let e = m.get("edge.svg").expect("edge");
        assert_eq!(e.name.as_deref(), Some("Edge router"));
        assert_eq!(e.category.as_deref(), Some("Routing"));
        assert_eq!(e.meta.class.as_deref(), Some("router"));
        assert_eq!(e.meta.vendor.as_deref(), Some("Example Networks"));
        assert_eq!(e.meta.ports, Some(8));
        assert_eq!(e.meta.port_naming.as_deref(), Some("ge-0/0/{n}"));
        assert_eq!(e.meta.rack_units, Some(1));
        assert_eq!(e.meta.licence, "Drawn by the lab team");
        // A shape that says nothing still carries the folder's licence.
        let p = m.get("plain.svg").expect("plain");
        assert_eq!(p.meta.class, None);
        assert_eq!(p.meta.licence, "Drawn by the lab team");
    }

    #[test]
    fn serialises_camel_case_and_leaves_out_what_is_absent() {
        let m = parse(GOOD, all_exist).unwrap();
        let v = serde_json::to_value(&m.get("edge.svg").unwrap().meta).unwrap();
        assert_eq!(v["portNaming"], "ge-0/0/{n}");
        assert_eq!(v["rackUnits"], 1);
        let plain = serde_json::to_value(&m.get("plain.svg").unwrap().meta).unwrap();
        assert!(plain.get("class").is_none(), "{plain}");
    }

    fn refused(text: &str) -> String {
        parse(text, all_exist).expect_err("should be refused")
    }

    #[test]
    fn refuses_unknown_fields_anywhere() {
        assert!(refused(r#"{"coreviewStencils":1,"licence":"x","shapes":[],"extra":1}"#).contains("extra"));
        assert!(refused(r#"{"coreviewStencils":1,"licence":"x","shapes":[{"file":"a.svg","colour":"red"}]}"#)
            .contains("colour"));
    }

    #[test]
    fn refuses_another_version() {
        assert!(refused(r#"{"coreviewStencils":2,"licence":"x","shapes":[]}"#).contains("reads 1"));
    }

    #[test]
    fn requires_a_licence_statement() {
        assert!(refused(r#"{"coreviewStencils":1,"shapes":[]}"#).contains("licence"));
        assert!(refused(r#"{"coreviewStencils":1,"licence":"   ","shapes":[]}"#).contains("licence is required"));
    }

    #[test]
    fn refuses_a_file_outside_the_folder() {
        for f in ["../x.svg", "sub/x.svg", "..\\x.svg", "..", "/etc/passwd"] {
            let t = format!(r#"{{"coreviewStencils":1,"licence":"x","shapes":[{{"file":{}}}]}}"#,
                serde_json::to_string(f).unwrap());
            assert!(refused(&t).contains("plain file name"), "{f}");
        }
    }

    #[test]
    fn refuses_a_missing_or_repeated_file() {
        let t = r#"{"coreviewStencils":1,"licence":"x","shapes":[{"file":"gone.svg"}]}"#;
        assert!(parse(t, |_| false).unwrap_err().contains("no such file"));
        let t = r#"{"coreviewStencils":1,"licence":"x","shapes":[{"file":"a.svg"},{"file":"a.svg"}]}"#;
        assert!(refused(t).contains("listed twice"));
    }

    #[test]
    fn refuses_an_unknown_class_and_names_it() {
        let t = r#"{"coreviewStencils":1,"licence":"x","shapes":[{"file":"a.svg","class":"toaster"}]}"#;
        let e = refused(t);
        assert!(e.contains("toaster") && e.contains("shape 1 (a.svg)"), "{e}");
        // A plain drawing shape is not a device class.
        let t = r#"{"coreviewStencils":1,"licence":"x","shapes":[{"file":"a.svg","class":"rectangle"}]}"#;
        assert!(refused(t).contains("rectangle"));
    }

    #[test]
    fn refuses_numbers_out_of_range_and_a_naming_without_the_number() {
        let base = |shape: &str| format!(r#"{{"coreviewStencils":1,"licence":"x","shapes":[{shape}]}}"#);
        assert!(refused(&base(r#"{"file":"a.svg","ports":5000}"#)).contains("ports"));
        assert!(refused(&base(r#"{"file":"a.svg","ports":-1}"#)).contains("valid manifest"));
        assert!(refused(&base(r#"{"file":"a.svg","rackUnits":61}"#)).contains("rackUnits"));
        assert!(refused(&base(r#"{"file":"a.svg","portNaming":"Uplink"}"#)).contains("{n}"));
    }

    #[test]
    fn refuses_control_characters_in_text() {
        let t = r#"{"coreviewStencils":1,"licence":"x","shapes":[{"file":"a.svg","vendor":"AB"}]}"#;
        assert!(refused(t).contains("control character"));
    }

    #[test]
    fn no_manifest_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load(dir.path()).unwrap().is_none());
    }

    #[test]
    fn a_bad_manifest_on_disk_names_the_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(MANIFEST_FILE), "{").unwrap();
        assert!(load(dir.path()).unwrap_err().starts_with(MANIFEST_FILE));
    }
}
