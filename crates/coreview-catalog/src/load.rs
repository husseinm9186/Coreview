//! Loading catalogs and holding them to their own rules: every gate
//! parses, every parser is a known kind and names a template that exists,
//! every table and flag is one the spec defines, every regex compiles, and
//! every command — probe, collection or live-path — passes the read-only
//! allowlist. A catalog that breaks any of these fails `cargo test`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::allowlist::{verdict, Verdict};
use crate::gate::Gate;
use crate::schema::{Catalog, Parser, FLAGS, TABLES};

#[derive(Debug, Error)]
pub enum CatalogError {
    #[error("{0}: {1}")]
    Read(PathBuf, std::io::Error),
    #[error("{0}: {1}")]
    Yaml(String, serde_yaml_ng::Error),
    #[error("{0}")]
    Invalid(String),
}

pub fn load_str(text: &str) -> Result<Catalog, CatalogError> {
    serde_yaml_ng::from_str(text).map_err(|e| CatalogError::Yaml("<text>".into(), e))
}

pub fn load_file(path: &Path) -> Result<Catalog, CatalogError> {
    let text = std::fs::read_to_string(path).map_err(|e| CatalogError::Read(path.to_path_buf(), e))?;
    serde_yaml_ng::from_str(&text).map_err(|e| CatalogError::Yaml(path.display().to_string(), e))
}

/// Every `*.yaml` in a directory, sorted by name. `sessions.json` and
/// `schema.json` beside them are not catalogs and are left alone.
pub fn load_dir(dir: &Path) -> Result<Vec<Catalog>, CatalogError> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| CatalogError::Read(dir.to_path_buf(), e))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("yaml"))
        .collect();
    paths.sort();
    paths.iter().map(|p| load_file(p)).collect()
}

/// The problems a catalog has, all of them, worded for the test output.
/// `templates` is the directory holding `<name>.textfsm`; `None` skips
/// that check.
pub fn problems(catalog: &Catalog, templates: Option<&Path>) -> Vec<String> {
    let mut out = Vec::new();
    let os = &catalog.os;
    let mut ids = BTreeSet::new();
    let check_regex = |what: &str, re: &str, out: &mut Vec<String>| {
        if let Err(e) = regex::Regex::new(&format!("(?m){re}")) {
            out.push(format!("{os}: {what}: regex does not compile: {e}"));
        }
    };
    let check_fancy = |what: &str, re: &str, out: &mut Vec<String>| {
        if let Err(e) = fancy_regex::Regex::new(re) {
            out.push(format!("{os}: {what}: prompt regex does not compile: {e}"));
        }
    };
    if let Some(fp) = &catalog.fingerprint {
        check_regex("fingerprint", &fp.match_regex, &mut out);
        if let Verdict::Refused(r) = verdict(&fp.probe) {
            out.push(format!("{os}: fingerprint probe {:?} refused: {r}", fp.probe));
        }
    }
    for hint in &catalog.role_hint {
        check_regex(&format!("role_hint {}", hint.role), &hint.match_regex, &mut out);
    }
    for (role, flags) in &catalog.role_defaults {
        for f in flags {
            if !FLAGS.contains(&f.as_str()) {
                out.push(format!("{os}: role_defaults.{role}: {f:?} is not a capability flag"));
            }
        }
    }
    if let Some(e) = &catalog.parser_engine {
        if e != "rust" && e != "sidecar" {
            out.push(format!("{os}: parser_engine {e:?} is not rust or sidecar"));
        }
    }
    if let Some(p) = &catalog.session.prompt_pattern {
        check_fancy("session.prompt_pattern", p, &mut out);
    }
    for (name, lvl) in &catalog.session.privilege_levels {
        check_fancy(&format!("session.privilege_levels.{name}"), &lvl.pattern, &mut out);
        if let Some(p) = &lvl.escalate_prompt {
            check_fancy(&format!("session.privilege_levels.{name}.escalate_prompt"), p, &mut out);
        }
    }
    if let Some(c) = &catalog.session.contexts {
        check_regex("session.contexts.detect", &c.detect.match_regex, &mut out);
        if let Some(l) = &c.list {
            check_regex("session.contexts.list", &l.match_regex, &mut out);
        }
        if c.enter.is_empty() || c.leave.is_empty() {
            out.push(format!("{os}: session.contexts needs enter and leave steps"));
        }
    }
    for probe in &catalog.caps_probe {
        if !ids.insert(format!("probe:{}", probe.id)) {
            out.push(format!("{os}: probe id {:?} repeats", probe.id));
        }
        if let Verdict::Refused(r) = verdict(&probe.cmd) {
            out.push(format!("{os}: probe {:?} refused by the allowlist: {r}", probe.cmd));
        }
        if let Some(g) = &probe.gate {
            if let Err(e) = Gate::parse(g) {
                out.push(format!("{os}: probe {}: {e}", probe.id));
            }
        }
        for (flag, re) in &probe.flags {
            if !FLAGS.contains(&flag.as_str()) {
                out.push(format!("{os}: probe {}: {flag:?} is not a capability flag", probe.id));
            }
            // Flag rules may use look-around (`^vrf context (?!management)`), so they are fancy regexes.
            check_fancy(&format!("probe {} flag {flag}", probe.id), &format!("(?m){re}"), &mut out);
        }
    }
    for (kind, list) in [("command", &catalog.commands), ("live_path", &catalog.live_path)] {
        for c in list {
            if !ids.insert(format!("{kind}:{}", c.id)) {
                out.push(format!("{os}: {kind} id {:?} repeats", c.id));
            }
            if let Err(e) = Gate::parse(&c.gate) {
                out.push(format!("{os}: {kind} {}: {e}", c.id));
            }
            // An `api` command is a GET path the Rust collector answers; it is never sent over SSH.
            if c.parser != "api" {
                if let Verdict::Refused(r) = verdict(&c.cmd) {
                    out.push(format!("{os}: {kind} {:?} refused by the allowlist: {r}", c.cmd));
                }
            }
            match c.parser() {
                Err(e) => out.push(format!("{os}: {kind} {}: {e}", c.id)),
                Ok(Parser::TextFsm(name)) => {
                    if let Some(dir) = templates {
                        if !dir.join(format!("{name}.textfsm")).exists() {
                            out.push(format!("{os}: {kind} {}: template {name}.textfsm is not under {}", c.id, dir.display()));
                        }
                    }
                }
                Ok(Parser::Api) if c.api.is_none() && !c.cmd.starts_with('/') => {
                    out.push(format!("{os}: {kind} {}: parser api but no api path", c.id));
                }
                Ok(_) => {}
            }
            for extra in c.also.iter().chain(c.shadow.iter()) {
                match extra.parse::<Parser>() {
                    Err(e) => out.push(format!("{os}: {kind} {}: {e}", c.id)),
                    Ok(Parser::TextFsm(name)) => {
                        if let Some(dir) = templates {
                            if !dir.join(format!("{name}.textfsm")).exists() {
                                out.push(format!("{os}: {kind} {}: template {name}.textfsm is not under {}", c.id, dir.display()));
                            }
                        }
                    }
                    Ok(_) => {}
                }
            }
            if c.feeds.is_empty() {
                out.push(format!("{os}: {kind} {}: feeds nothing", c.id));
            }
            for t in &c.feeds {
                if !TABLES.contains(&t.as_str()) {
                    out.push(format!("{os}: {kind} {}: {t:?} is not a table", c.id));
                }
            }
            // A placeholder over SSH must be filled by a foreach, or the device is
            // sent the braces (LT-524). Live-path lookups are filled by the path
            // builder, API paths by the API collector.
            if kind == "command" && c.parser != "api" && c.foreach.is_none() && c.cmd.contains('{') {
                out.push(format!("{os}: {kind} {}: {:?} has a placeholder but no foreach, so it would be sent with the braces in", c.id, c.cmd));
            }
            if let Some(f) = &c.foreach {
                if !["vrf", "vdom", "vsys", "context", "instance"].contains(&f.as_str()) {
                    out.push(format!("{os}: {kind} {}: foreach {f:?} is not vrf|vdom|vsys|context|instance", c.id));
                }
                if !c.cmd.contains(&format!("{{{f}}}")) && !c.cmd.contains("{vr}") && !c.cmd.contains("{ri}") && !c.cmd.contains("{ctx}") && f != "vdom" {
                    out.push(format!("{os}: {kind} {}: foreach {f} but the command has no {{{f}}} placeholder", c.id));
                }
            }
            if c.verified == crate::schema::Verified::Unverified && c.parser != "none" && kind == "command" {
                out.push(format!("{os}: {kind} {}: unverified yet claims parser {}", c.id, c.parser));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    #[test]
    fn every_checked_in_catalog_loads_and_has_no_problems() {
        let dir = repo().join("resources/catalog");
        let catalogs = load_dir(&dir).unwrap_or_else(|e| panic!("{e}"));
        assert!(catalogs.len() >= 12, "{} catalogs", catalogs.len());
        let templates = repo().join("resources/templates/ntc");
        let mut all = Vec::new();
        for c in &catalogs {
            all.extend(problems(c, Some(&templates)));
        }
        assert!(all.is_empty(), "{} problems:\n{}", all.len(), all.join("\n"));
    }

    #[test]
    fn the_phase_one_platforms_are_all_present_with_a_fingerprint() {
        let catalogs = load_dir(&repo().join("resources/catalog")).unwrap();
        for os in ["cisco_ios", "cisco_nxos", "cisco_iosxr", "arista_eos", "juniper_junos", "fortios", "panos", "aoscx", "aoss", "cisco_asa", "cisco_wlc_aireos", "meraki"] {
            let c = catalogs.iter().find(|c| c.os == os).unwrap_or_else(|| panic!("no catalog for {os}"));
            assert_eq!(c.phase, 1, "{os} is a phase-1 platform");
            if os != "meraki" {
                assert!(c.fingerprint.is_some(), "{os} has no fingerprint");
                assert!(!c.commands.is_empty(), "{os} has no commands");
            }
        }
    }

    #[test]
    fn a_catalog_command_outside_the_allowlist_fails() {
        let text = r#"
vendor: T
os: t
name: T
phase: 1
session: {}
commands:
  - { id: bad, cmd: configure terminal, gate: always, parser: none, feeds: [device], verified: unverified }
"#;
        let c = load_str(text).unwrap();
        let p = problems(&c, None);
        assert!(p.iter().any(|m| m.contains("refused by the allowlist")), "{p:?}");
    }

    #[test]
    fn a_typo_in_a_command_key_is_an_error_not_a_silence() {
        let text = r#"
vendor: T
os: t
name: T
phase: 1
session: {}
commands:
  - { id: x, cmd: show version, gate: always, parser: none, feeds: [device], verified: unverified, weigth: heavy }
"#;
        assert!(load_str(text).is_err());
    }

    #[test]
    fn unknown_tables_flags_and_parsers_are_named() {
        let text = r#"
vendor: T
os: t
name: T
phase: 1
session: {}
role_defaults: { switch: [switching, warp] }
caps_probe:
  - { id: p, cmd: show feature, flags: { ospf: '^ospf', hyperdrive: 'x' }, timeout: 30 }
commands:
  - { id: a, cmd: show version, gate: always, parser: magic, feeds: [device], verified: docs }
  - { id: b, cmd: show version, gate: always, parser: json, feeds: [devices], verified: docs }
  - { id: c, cmd: show version, gate: cap.x &&, parser: json, feeds: [device], verified: docs }
"#;
        let c = load_str(text).unwrap();
        let p = problems(&c, None).join("\n");
        assert!(p.contains("\"warp\" is not a capability flag"), "{p}");
        assert!(p.contains("\"hyperdrive\" is not a capability flag"), "{p}");
        assert!(p.contains("\"magic\" is not a parser"), "{p}");
        assert!(p.contains("\"devices\" is not a table"), "{p}");
        assert!(p.contains("expected a term"), "{p}");
    }
}
