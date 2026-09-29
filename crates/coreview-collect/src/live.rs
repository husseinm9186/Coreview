//! Live mode (LT-535): one device asked about one flow, with its catalog's
//! `live_path` commands — `show ip route {dst}`, `show ip cef exact-route
//! {src} {dst}`, `get router info routing-table details {dst}`, `test
//! routing fib-lookup …` and the rest. The placeholders are filled from the
//! modeled hop; a command whose placeholders cannot all be filled, or whose
//! values would not be safe on a command line, is skipped with the reason.
//! Every command still leaves through `Sidecar::run`, whose read-only guard
//! (LT-522) is the same as for a collection, and every reply is scrubbed.

use std::collections::BTreeMap;

use coreview_catalog::{Catalog, Command, Step};
use serde::Serialize;
use serde_json::Value;

use crate::run::{settle, sidecar_parser, CommandOutcome, RunOptions, Target};
use crate::scrub::scrub;
use crate::sidecar::{Auth, Sidecar};

/// What the device said to one command, or why it was not asked.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveAnswer {
    pub id: String,
    /// The command as sent, or as it would have been.
    pub command: String,
    /// `ok`, `unsupported`, `timeout`, `parse_error`, … or `skipped`.
    pub status: String,
    pub rows: Vec<Value>,
    /// The reply, scrubbed.
    pub raw: String,
    pub reason: Option<String>,
    /// The catalog's `verified` for this command: `lab`, `docs` or `unverified`.
    pub verified: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiveRun {
    pub host: String,
    pub answers: Vec<LiveAnswer>,
    pub host_key: Option<String>,
    pub host_key_first_seen: bool,
    /// Why nothing was asked: `auth`, `host_key`, `timeout`, `sidecar`, …
    pub failure: Option<String>,
    pub log: Vec<String>,
}

/// A value fit for a command line: an address, a name, an interface.
fn safe(v: &str) -> bool {
    !v.is_empty() && v.len() <= 64 && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '/' | '-'))
}

/// The placeholders a command names.
pub fn placeholders(cmd: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = cmd;
    while let Some(i) = rest.find('{') {
        let Some(j) = rest[i..].find('}') else { break };
        out.push(rest[i + 1..i + j].to_string());
        rest = &rest[i + j + 1..];
    }
    out
}

/// Reads a routing table, so in a VRF it must be told which one.
fn table_bound(cmd: &str) -> bool {
    let l = cmd.to_ascii_lowercase();
    ["route", "cef", "arp", "fib", "hash"].iter().any(|w| l.contains(w))
}

/// The command as it will be sent, or why it will not be.
pub fn fill(c: &Command, vars: &BTreeMap<String, String>) -> Result<String, String> {
    let lower = c.cmd.trim().to_ascii_lowercase();
    if lower.starts_with("traceroute") || lower.starts_with("execute traceroute") {
        return Err("a traceroute is the verify step, taken from the source device".into());
    }
    if c.api.is_some() {
        return Err("answered only over the device's API, which a live check does not use yet".into());
    }
    let names = placeholders(&c.cmd);
    let vrf = vars.get("vrf").map(String::as_str).unwrap_or("default");
    let in_vrf = vrf != "default";
    let names_vrf = names.iter().any(|n| n == "vrf" || n == "ri");
    if in_vrf && table_bound(&c.cmd) && !names_vrf && !names.iter().any(|n| n == "vr") {
        return Err(format!("reads the global table, and this hop is in VRF {vrf}"));
    }
    if !in_vrf && names_vrf {
        return Err("asks about a VRF, and this hop is in the global table".into());
    }
    let mut out = c.cmd.clone();
    for n in &names {
        let value = match n.as_str() {
            "ri" | "vrf" => Some(vrf.to_string()),
            other => vars.get(other).cloned(),
        };
        let Some(v) = value.filter(|v| !v.is_empty()) else {
            return Err(format!("needs {{{n}}}, which the trace does not give"));
        };
        if !safe(&v) {
            return Err(format!("the value for {{{n}}} is not safe on a command line"));
        }
        out = out.replace(&format!("{{{n}}}"), &v);
    }
    Ok(out)
}

fn step_of(c: &Command, cmd: String) -> Step {
    Step {
        id: c.id.clone(),
        cmd,
        gate: c.gate.clone(),
        because: vec![],
        parser: c.parser.clone(),
        feeds: c.feeds.clone(),
        weight: c.weight(),
        timeout: c.timeout(),
        verified: c.verified,
        context: None,
        scope: None,
    }
}

fn verified_word(c: &Command) -> String {
    serde_json::to_value(c.verified).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

/// Ask one device. One login, as for a collection (never cycled); the OS is
/// known from the collection, so there is no fingerprint pass.
pub async fn ask(sidecar: &mut Sidecar, catalog: &Catalog, target: &Target, auth: &Auth, options: &RunOptions, vars: &BTreeMap<String, String>) -> LiveRun {
    let mut run = LiveRun { host: target.host.clone(), ..Default::default() };
    let mut planned: Vec<(Step, String)> = Vec::new();
    for c in &catalog.live_path {
        match fill(c, vars) {
            Ok(cmd) => planned.push((step_of(c, cmd), verified_word(c))),
            Err(reason) => run.answers.push(LiveAnswer { id: c.id.clone(), command: c.cmd.clone(), status: "skipped".into(), rows: vec![], raw: String::new(), reason: Some(reason), verified: verified_word(c) }),
        }
    }
    if planned.is_empty() {
        return run;
    }
    let session = format!("live-{}", target.host);
    let spec = serde_json::to_value(&catalog.session).unwrap_or(Value::Null);
    let opened = match sidecar.open(&session, &target.host, target.port, &catalog.os, auth, &spec, options.connect_ms, options.auth_ms, target.known_host_key.as_deref()).await {
        Ok(r) => r,
        Err(e) => {
            run.failure = Some("sidecar".into());
            run.log.push(e.to_string());
            return run;
        }
    };
    if let Some(k) = opened.extra.get("host_key").and_then(Value::as_str) {
        run.host_key = Some(k.to_string());
        run.host_key_first_seen = target.known_host_key.is_none();
    }
    if opened.status != "ok" {
        run.failure = Some(opened.status.clone());
        run.log.push(opened.error.clone().unwrap_or_default());
        return run;
    }
    for (step, verified) in planned {
        let also: Vec<String> = catalog.live_path.iter().find(|c| c.id == step.id).map(|c| c.also.clone()).unwrap_or_default();
        let parser = sidecar_parser(&step, catalog, options);
        let reply = match sidecar.run(&session, &step.cmd, &parser, &also, u64::from(step.timeout) * 1000).await {
            Ok(r) => r,
            Err(e) => {
                run.failure = Some("sidecar".into());
                run.log.push(e.to_string());
                break;
            }
        };
        let mut outcome: CommandOutcome = reply.into();
        settle(&mut outcome, &step, catalog, &also, options);
        run.answers.push(LiveAnswer { id: step.id.clone(), command: step.cmd.clone(), status: outcome.status.clone(), rows: outcome.rows, raw: scrub(&outcome.raw), reason: outcome.error, verified });
    }
    let _ = sidecar.close(&session).await;
    run
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A catalog command, from the fields a catalog entry must have.
    fn cmd(id: &str, c: &str) -> Command {
        serde_json::from_value(serde_json::json!({"id": id, "cmd": c, "gate": "always", "parser": "none", "feeds": ["path_probe"], "verified": "unverified"})).unwrap()
    }

    fn vars(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn placeholders_are_filled_from_the_hop() {
        let v = vars(&[("dst", "203.0.113.5"), ("src", "192.0.2.10"), ("vrf", "default")]);
        assert_eq!(fill(&cmd("a", "show ip route {dst}"), &v).unwrap(), "show ip route 203.0.113.5");
        assert_eq!(fill(&cmd("b", "show ip cef exact-route {src} {dst}"), &v).unwrap(), "show ip cef exact-route 192.0.2.10 203.0.113.5");
    }

    #[test]
    fn a_vrf_hop_asks_the_vrf_command_and_skips_the_global_one() {
        let v = vars(&[("dst", "203.0.113.5"), ("vrf", "BLUE")]);
        assert_eq!(fill(&cmd("a", "show ip route vrf {vrf} {dst}"), &v).unwrap(), "show ip route vrf BLUE 203.0.113.5");
        assert!(fill(&cmd("b", "show ip route {dst}"), &v).unwrap_err().contains("global table"));
        let g = vars(&[("dst", "203.0.113.5"), ("vrf", "default")]);
        assert!(fill(&cmd("c", "show ip route vrf {vrf} {dst}"), &g).is_err());
        // PAN-OS's virtual router is named even when it is the default one.
        assert_eq!(fill(&cmd("d", "test routing fib-lookup virtual-router {vr} ip {dst}"), &vars(&[("dst", "203.0.113.5"), ("vr", "default")])).unwrap(), "test routing fib-lookup virtual-router default ip 203.0.113.5");
    }

    #[test]
    fn what_cannot_be_filled_or_is_unsafe_is_skipped_with_the_reason() {
        let v = vars(&[("dst", "203.0.113.5"), ("in_if", "Gi0/1; reload")]);
        assert!(fill(&cmd("a", "packet-tracer input {in_if} {proto} {src} {sport} {dst} {dport}"), &v).is_err());
        assert!(fill(&cmd("b", "show ip arp {nh}"), &v).unwrap_err().contains("{nh}"));
        let bad = vars(&[("nh", "192.0.2.1 | include x")]);
        assert!(fill(&cmd("c", "show ip arp {nh}"), &bad).unwrap_err().contains("not safe"));
        assert!(fill(&cmd("d", "traceroute {dst} source {src}"), &v).unwrap_err().contains("verify"));
    }
}
