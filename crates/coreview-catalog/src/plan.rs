//! The collection plan: given a catalog and what the probes found, which
//! commands will be sent, in what order, expanded over which contexts —
//! and which will not, with the reason. This is what the operator sees
//! before a run (LT-517) and what the collector executes (LT-514).

use serde::Serialize;

use crate::allowlist::{verdict, Verdict};
use crate::gate::{Facts, Gate};
use crate::schema::{Catalog, Command, Verified, Weight};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Step {
    pub id: String,
    /// The command as it will be sent, placeholders filled.
    pub cmd: String,
    pub gate: String,
    /// The flags and roles the gate read, so the preview can say why.
    pub because: Vec<String>,
    pub parser: String,
    pub feeds: Vec<String>,
    pub weight: Weight,
    pub timeout: u32,
    pub verified: Verified,
    /// `Some(("vrf", "CUST-A"))` when expanded from a `foreach`.
    pub context: Option<(String, String)>,
    /// `Some("global")` when the command runs in the OS's global context.
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Skipped {
    pub id: String,
    pub cmd: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct Plan {
    pub steps: Vec<Step>,
    pub skipped: Vec<Skipped>,
}

/// Build the plan. Light commands first, heavy last, catalog order within
/// each. A command whose gate does not hold, whose `foreach` has nothing
/// to expand over, or that the allowlist refuses is skipped and says why.
pub fn plan(catalog: &Catalog, facts: &Facts) -> Plan {
    let mut out = Plan::default();
    let mut ordered: Vec<&Command> = catalog.commands.iter().collect();
    ordered.sort_by_key(|c| match c.weight() {
        Weight::Light => 0,
        Weight::Heavy => 1,
    });
    for command in ordered {
        let gate = match Gate::parse(&command.gate) {
            Ok(g) => g,
            Err(e) => {
                out.skipped.push(Skipped { id: command.id.clone(), cmd: command.cmd.clone(), reason: format!("gate does not parse: {e}") });
                continue;
            }
        };
        if !gate.eval(facts) {
            out.skipped.push(Skipped { id: command.id.clone(), cmd: command.cmd.clone(), reason: format!("gate `{}` is not met", command.gate) });
            continue;
        }
        if command.parser == "api" {
            out.skipped.push(Skipped { id: command.id.clone(), cmd: command.cmd.clone(), reason: "answered by the API collector, not over SSH".into() });
            continue;
        }
        if let Verdict::Refused(reason) = verdict(&command.cmd) {
            out.skipped.push(Skipped { id: command.id.clone(), cmd: command.cmd.clone(), reason: format!("refused by the read-only allowlist: {reason}") });
            continue;
        }
        if command.foreach.is_none() && command.cmd.contains('{') {
            out.skipped.push(Skipped { id: command.id.clone(), cmd: command.cmd.clone(), reason: "has a placeholder nothing fills".into() });
            continue;
        }
        let because = gate.names();
        let mut push = |cmd: String, context: Option<(String, String)>| {
            out.steps.push(Step {
                id: command.id.clone(),
                cmd,
                gate: command.gate.clone(),
                because: because.clone(),
                parser: command.parser.clone(),
                feeds: command.feeds.clone(),
                weight: command.weight(),
                timeout: command.timeout(),
                verified: command.verified,
                context,
                scope: command.context.clone(),
            });
        };
        match &command.foreach {
            None => push(command.cmd.clone(), None),
            Some(kind) => {
                let names = facts.contexts.get(kind).cloned().unwrap_or_default();
                if names.is_empty() {
                    out.skipped.push(Skipped { id: command.id.clone(), cmd: command.cmd.clone(), reason: format!("no {kind} known to expand over") });
                    continue;
                }
                for name in names {
                    let filled = command.cmd.replace(&format!("{{{kind}}}"), &name).replace("{vr}", &name).replace("{ri}", &name).replace("{ctx}", &name);
                    push(filled, Some((kind.clone(), name)));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::load::load_str;

    const CATALOG: &str = r#"
vendor: Test
os: test_os
name: Test OS
phase: 1
session: {}
role_hint: []
role_defaults: {}
caps_probe: []
live_path: []
commands:
  - { id: version, cmd: show version, gate: always, parser: textfsm:test_show_version, feeds: [device], weight: light, verified: lab }
  - { id: config, cmd: show running-config, gate: always, parser: raw, feeds: [raw_config], weight: heavy, verified: docs }
  - { id: routes, cmd: 'show ip route vrf {vrf}', gate: cap.vrf, foreach: vrf, parser: textfsm:test_show_ip_route, feeds: [route], weight: heavy, verified: lab }
  - { id: bgp, cmd: show bgp summary, gate: cap.bgp, parser: none, feeds: [routing_neighbor], verified: unverified }
  - { id: api_only, cmd: /api/v2/monitor/system/status, gate: always, parser: api, feeds: [device], verified: docs }
  - { id: bad, cmd: reload, gate: always, parser: none, feeds: [device], verified: docs }
  - { id: light_last, cmd: show clock, gate: always, parser: none, feeds: [device], weight: light, verified: docs }
"#;

    #[test]
    fn light_before_heavy_gates_expanded_and_refusals_named() {
        let catalog = load_str(CATALOG).unwrap();
        let facts = Facts::with_caps(["vrf"]).context("vrf", ["CUST-A", "CUST-B"]);
        let p = plan(&catalog, &facts);
        let cmds: Vec<&str> = p.steps.iter().map(|s| s.cmd.as_str()).collect();
        assert_eq!(cmds, vec!["show version", "show clock", "show running-config", "show ip route vrf CUST-A", "show ip route vrf CUST-B"]);
        assert_eq!(p.steps[3].context, Some(("vrf".into(), "CUST-A".into())));
        assert_eq!(p.steps[3].because, vec!["cap.vrf"]);
        let reasons: Vec<(&str, &str)> = p.skipped.iter().map(|s| (s.id.as_str(), s.reason.as_str())).collect();
        assert_eq!(
            reasons,
            vec![
                ("bgp", "gate `cap.bgp` is not met"),
                ("api_only", "answered by the API collector, not over SSH"),
                ("bad", "refused by the read-only allowlist: first word is not a read verb"),
            ]
        );
    }

    #[test]
    fn a_foreach_with_nothing_to_expand_is_skipped_and_says_so() {
        let catalog = load_str(CATALOG).unwrap();
        let p = plan(&catalog, &Facts::with_caps(["vrf"]));
        assert!(p.skipped.iter().any(|s| s.id == "routes" && s.reason == "no vrf known to expand over"));
        assert!(!p.steps.iter().any(|s| s.id == "routes"));
    }

    #[test]
    fn timeouts_follow_weight_when_not_given() {
        let catalog = load_str(CATALOG).unwrap();
        let p = plan(&catalog, &Facts::default());
        let by = |id: &str| p.steps.iter().find(|s| s.id == id).unwrap();
        assert_eq!(by("version").timeout, 30);
        assert_eq!(by("config").timeout, 120);
    }
}
