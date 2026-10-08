//! TextFSM in Rust: the vendored ntc-templates
//! read without Python.
//!
//! The state machine is `textfsm-rs` (Apache-2.0). Both crates.io
//! candidates were run against the vendored fixtures first: textfsm-rs
//! 0.3.6 gave exactly ntc's rows for all 502 single-template pairs;
//! textfsm-core 0.3.1 gave 493, and the nine it missed cannot be put right
//! afterwards — it drops a List value's unmatched captures, where TextFSM
//! keeps them as `None`, so per-interface lists lose their alignment.
//!
//! What this module adds is the part of textfsm's `clitable` that ntc's
//! own tests go through: a command whose index row names several
//! templates (`a.textfsm:b.textfsm`) is parsed by each, and the later ones
//! extend the first one's rows column by column — joined on the first
//! template's `Key` values when it declares any, by row position when it
//! does not — exactly as `TextTable.extend` does. Keys are lower-cased
//! as `ParseTextToDicts` does.
//!
//! Compiled templates are cached; each parse runs on a fresh copy.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};
use textfsm_rs::{DataRecordConversion, TextFSM};

/// One parsed row, keys lower-cased, values a string or a list of strings.
pub type Row = Map<String, Value>;

/// One template's output: its header, its `Key` columns, its rows.
struct Parsed {
    header: Vec<String>,
    keys: Vec<String>,
    rows: Vec<Row>,
}

pub struct Engine {
    dir: PathBuf,
    cache: Mutex<HashMap<String, Arc<TextFSM>>>,
}

impl Engine {
    /// `dir` holds `<name>.textfsm` — `resources/templates/ntc`.
    pub fn new(dir: impl Into<PathBuf>) -> Engine {
        Engine { dir: dir.into(), cache: Mutex::new(HashMap::new()) }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn compiled(&self, name: &str) -> Result<Arc<TextFSM>, String> {
        if name.contains('/') || name.contains('\\') || name.contains("..") {
            return Err(format!("textfsm: {name:?} is not a bare template name"));
        }
        if let Some(t) = self.cache.lock().map_err(|e| e.to_string())?.get(name) {
            return Ok(Arc::clone(t));
        }
        let path = self.dir.join(format!("{name}.textfsm"));
        let text = std::fs::read_to_string(&path).map_err(|_| format!("textfsm: no template {name}"))?;
        let fsm = TextFSM::from_string(&text).map_err(|e| format!("textfsm: {name}: template error: {e}"))?;
        let fsm = Arc::new(fsm);
        self.cache.lock().map_err(|e| e.to_string())?.insert(name.to_string(), Arc::clone(&fsm));
        Ok(fsm)
    }

    /// One template over `raw`.
    fn one(&self, name: &str, raw: &str) -> Result<Parsed, String> {
        let compiled = self.compiled(name)?;
        let mut fsm = (*compiled).clone();
        fsm.reset();
        let mut header: Vec<String> = fsm.parser.values.keys().map(|k| k.to_lowercase()).collect();
        header.sort();
        let mut keys: Vec<String> = fsm.parser.values.keys().filter(|k| fsm.is_key_value(k) == Some(true)).map(|k| k.to_lowercase()).collect();
        keys.sort();
        let records = fsm.parse_string(raw, Some(DataRecordConversion::LowercaseKeys)).map_err(|e| format!("textfsm: {name}: {e}"))?;
        let rows = records
            .into_iter()
            .map(|r| {
                let mut row = Row::new();
                for (k, v) in r.iter() {
                    row.insert(k.to_lowercase(), to_json(v));
                }
                row
            })
            .collect();
        Ok(Parsed { header, keys, rows })
    }

    /// Rows for `raw` under `name`, extended by each of `also` in turn.
    pub fn parse(&self, name: &str, also: &[String], raw: &str) -> Result<Vec<Row>, String> {
        let Parsed { mut header, keys, mut rows } = self.one(name, raw)?;
        for extra in also {
            let extra = extra.strip_prefix("textfsm:").unwrap_or(extra);
            let other = self.one(extra, raw)?;
            extend(&mut header, &mut rows, &keys, &other.header, &other.rows);
        }
        Ok(rows)
    }
}

fn to_json(v: &textfsm_rs::Value) -> Value {
    match v {
        textfsm_rs::Value::Single(s) => Value::String(s.clone()),
        textfsm_rs::Value::List(l) => Value::Array(l.iter().map(|s| Value::String(s.clone())).collect()),
    }
}

/// `TextTable.extend`: the columns `other` has and `rows` lacks are added
/// (empty), then filled from the first `other` row whose key columns
/// equal this row's — or, with no keys, from the row at the same position.
fn extend(header: &mut Vec<String>, rows: &mut [Row], keys: &[String], other_header: &[String], other_rows: &[Row]) {
    let new: Vec<String> = other_header.iter().filter(|c| !header.contains(c)).cloned().collect();
    if new.is_empty() {
        return;
    }
    header.extend(new.iter().cloned());
    for row in rows.iter_mut() {
        for c in &new {
            row.insert(c.clone(), Value::String(String::new()));
        }
    }
    if keys.is_empty() {
        for (row, other) in rows.iter_mut().zip(other_rows) {
            for c in &new {
                row.insert(c.clone(), other.get(c).cloned().unwrap_or(Value::String(String::new())));
            }
        }
        return;
    }
    for row in rows.iter_mut() {
        if let Some(other) = other_rows.iter().find(|o| keys.iter().all(|k| row.get(k) == o.get(k))) {
            for c in &new {
                row.insert(c.clone(), other.get(c).cloned().unwrap_or(Value::String(String::new())));
            }
        }
    }
}

/// The templates each index row names after its first: `first → [also…]`,
/// from ntc-templates' `index`, so a caller holding only the first name
/// (a fixture folder, a catalog entry) can join the rest.
pub fn also_from_index(ntc_dir: &Path) -> Result<BTreeMap<String, Vec<String>>, String> {
    let text = std::fs::read_to_string(ntc_dir.join("index")).map_err(|e| format!("index: {e}"))?;
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("Template,") {
            continue;
        }
        let Some(first_cell) = line.split(',').next() else { continue };
        let names: Vec<String> = first_cell.trim().split(':').map(|t| t.trim().trim_end_matches(".textfsm").to_string()).collect();
        if let Some((first, rest)) = names.split_first() {
            out.entry(first.clone()).or_insert_with(|| rest.to_vec());
        }
    }
    Ok(out)
}

/// ntc-templates' `index`, matched the way textfsm's `clitable` matches
/// it: the Platform column a regex matched at the start, the Command column
/// with its `[[...]]` completions expanded and matched at the start, the
/// first row in file order winning. Returns every template the row names.
pub struct Index {
    // fancy-regex: a few Command cells use look-ahead (`((?!brief).)*$`).
    rows: Vec<(fancy_regex::Regex, fancy_regex::Regex, Vec<String>)>,
}

impl Index {
    pub fn load(ntc_dir: &Path) -> Result<Index, String> {
        let text = std::fs::read_to_string(ntc_dir.join("index")).map_err(|e| format!("index: {e}"))?;
        let mut rows = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with("Template,") {
                continue;
            }
            let cells: Vec<&str> = line.splitn(4, ',').map(str::trim).collect();
            if cells.len() < 4 {
                continue;
            }
            let templates: Vec<String> = cells[0].split(':').map(|t| t.trim().trim_end_matches(".textfsm").to_string()).collect();
            let platform = fancy_regex::Regex::new(&format!("^(?:{})", cells[2])).map_err(|e| format!("index platform {}: {e}", cells[2]))?;
            let command = fancy_regex::Regex::new(&format!("^(?:{})", expand_completion(cells[3]))).map_err(|e| format!("index command {}: {e}", cells[3]))?;
            rows.push((platform, command, templates));
        }
        Ok(Index { rows })
    }

    pub fn lookup(&self, platform: &str, command: &str) -> Option<&[String]> {
        self.rows
            .iter()
            .find(|(p, c, _)| p.is_match(platform).unwrap_or(false) && c.is_match(command).unwrap_or(false))
            .map(|(_, _, t)| t.as_slice())
    }
}

/// `sh[[ow]]` → `sh(o(w)?)?`, as clitable's `_Completion` writes it.
pub fn expand_completion(cmd: &str) -> String {
    let mut out = String::new();
    let mut rest = cmd;
    while let Some(start) = rest.find("[[") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let word: Vec<char> = after[..end].chars().collect();
        out.push('(');
        for (i, c) in word.iter().enumerate() {
            if i > 0 {
                out.push('(');
            }
            out.push(*c);
        }
        for _ in 0..word.len() {
            out.push_str(")?");
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ntc() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/templates/ntc")
    }

    #[test]
    fn an_ios_arp_table_reads_as_ntc_reads_it() {
        let e = Engine::new(ntc());
        let raw = "Protocol  Address          Age (min)  Hardware Addr   Type   Interface\nInternet  192.0.2.1               0   0000.0000.0001  ARPA   Vlan10\n";
        let rows = e.parse("cisco_ios_show_ip_arp", &[], raw).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["ip_address"], "192.0.2.1");
        assert_eq!(rows[0]["mac_address"], "0000.0000.0001");
        assert_eq!(rows[0]["interface"], "Vlan10");
    }

    #[test]
    fn a_missing_template_and_a_path_are_errors_not_panics() {
        let e = Engine::new(ntc());
        assert!(e.parse("no_such_template", &[], "x").unwrap_err().contains("no template"));
        assert!(e.parse("../index", &[], "x").unwrap_err().contains("bare template name"));
    }

    #[test]
    fn extend_joins_on_keys_and_by_position_without_them() {
        let mut header = vec!["a".to_string(), "k".to_string()];
        let mut rows: Vec<Row> = vec![json!({"k": "1", "a": "x"}).as_object().unwrap().clone(), json!({"k": "2", "a": "y"}).as_object().unwrap().clone()];
        let other: Vec<Row> = vec![json!({"k": "2", "b": "two"}).as_object().unwrap().clone(), json!({"k": "1", "b": "one"}).as_object().unwrap().clone()];
        extend(&mut header, &mut rows, &["k".into()], &["b".into(), "k".into()], &other);
        assert_eq!(rows[0]["b"], "one");
        assert_eq!(rows[1]["b"], "two");
        let mut header2 = vec!["a".to_string()];
        let mut rows2: Vec<Row> = vec![json!({"a": "x"}).as_object().unwrap().clone()];
        extend(&mut header2, &mut rows2, &[], &["c".into()], &[json!({"c": "first"}).as_object().unwrap().clone()]);
        assert_eq!(rows2[0]["c"], "first");
    }

    #[test]
    fn the_index_names_the_templates_joined_after_the_first() {
        let also = also_from_index(&ntc()).unwrap();
        assert_eq!(also["cisco_ios_show_switch_detail"], vec!["cisco_ios_show_switch_detail_stack_ports"]);
        assert!(also["cisco_ios_show_ip_arp"].is_empty());
    }

    #[test]
    fn the_index_resolves_commands_as_clitable_does() {
        assert_eq!(expand_completion("sh[[ow]] ver[[sion]]"), "sh(o(w)?)? ver(s(i(o(n)?)?)?)?");
        let idx = Index::load(&ntc()).unwrap();
        assert_eq!(idx.lookup("cisco_ios", "sh ver").unwrap(), ["cisco_ios_show_version"]);
        assert_eq!(idx.lookup("cisco_ftd", "show arp").unwrap(), ["cisco_asa_show_arp"]);
        assert_eq!(idx.lookup("cisco_ios", "show switch detail").unwrap(), ["cisco_ios_show_switch_detail", "cisco_ios_show_switch_detail_stack_ports"]);
        assert!(idx.lookup("cisco_ios", "show nothing-like-this").is_none());
    }
}
