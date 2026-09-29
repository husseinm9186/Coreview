//! One device, start to finish: fingerprint → open → capabilities → plan →
//! run light-first, every command optional → close. Contexts (VDOM, ASA
//! context, vsys) are entered and left around the steps that need them;
//! VRFs found on the way expand the `foreach vrf` steps in a second pass.
//! A raw configuration is scrubbed here, before it can reach anything.

use std::collections::BTreeSet;

use coreview_catalog::{plan, Catalog, Facts, Plan, Step, Verified, Weight};
use serde::Serialize;
use serde_json::Value;

use crate::capabilities::{apply_probe, initial_facts};
use crate::fingerprint::{identify, is_refusal, probes, Identified};
use crate::scrub::scrub;
use crate::sidecar::{Auth, Reply, Sidecar, SidecarError};

#[derive(Debug, Clone)]
pub struct Target {
    pub host: String,
    pub port: u16,
    /// The catalog `os`, when the operator or a previous run already knows it; skips the fingerprint pass.
    pub os_hint: Option<String>,
    /// The operator's role override, which survives re-runs.
    pub role_override: Option<String>,
}

#[derive(Clone)]
pub struct RunOptions {
    pub connect_ms: u64,
    pub auth_ms: u64,
    /// Skip commands marked heavy — the quick look a first crawl wants.
    pub light_only: bool,
    /// Stop after the plan: fingerprint, probe, plan, close — the preview the
    /// operator sees before a run (LT-517). Nothing from `commands:` is sent.
    pub plan_only: bool,
    /// LT-521: the Rust TextFSM engine. With it, a catalog marked
    /// `parser_engine: rust` is parsed in Rust (the sidecar only carries the
    /// session); and with `shadow`, every other `textfsm:` reply is parsed by
    /// both and the rows compared.
    pub engine: Option<std::sync::Arc<coreview_catalog::textfsm::Engine>>,
    pub shadow: bool,
}

impl Default for RunOptions {
    fn default() -> Self {
        RunOptions { connect_ms: 8000, auth_ms: 20000, light_only: false, plan_only: false, engine: None, shadow: false }
    }
}

/// What one command came back with: the contract's status and fields.
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct CommandOutcome {
    pub status: String,
    pub rows: Vec<Value>,
    pub raw: String,
    pub duration_ms: u64,
    pub error: Option<String>,
    /// LT-521: what the other parser made of the same reply, when shadow mode is on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadow: Option<Shadow>,
    /// Which parser produced `rows`: `sidecar` or `rust`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
}

/// One reply parsed twice (LT-521).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Shadow {
    /// `match`, `mismatch`, or `error` (the shadow parser failed where the primary did not, or the reverse).
    pub verdict: String,
    /// The first difference, for the command log: `row 3 field vlan: "10" vs "20"`, or the error.
    pub detail: Option<String>,
}

/// What the sidecar is asked to parse a step with (LT-521): nothing for a
/// configuration, nothing when this OS has been flipped to the Rust engine
/// — the sidecar then only carries the session — the catalog's parser
/// otherwise.
pub fn sidecar_parser(step: &Step, catalog: &Catalog, options: &RunOptions) -> String {
    let rust_primary = step.parser.starts_with("textfsm:") && options.engine.is_some() && catalog.parser_engine.as_deref() == Some("rust");
    if step.parser == "raw" || rust_primary {
        "none".to_string()
    } else {
        step.parser.clone()
    }
}

/// After the sidecar answered (LT-521): a flipped OS gets its rows from the
/// Rust engine; with shadow mode on, every other `textfsm:` reply is parsed
/// by the Rust engine too and the two row sets compared.
pub fn settle(outcome: &mut CommandOutcome, step: &Step, catalog: &Catalog, also: &[String], options: &RunOptions) {
    let (Some(template), Some(engine)) = (step.parser.strip_prefix("textfsm:"), &options.engine) else { return };
    if outcome.status != "ok" && outcome.status != "parse_error" {
        return;
    }
    let rust = engine.parse(template, also, &outcome.raw).map(|rows| rows.into_iter().map(Value::Object).collect::<Vec<_>>());
    if catalog.parser_engine.as_deref() == Some("rust") {
        match rust {
            Ok(rows) => {
                outcome.rows = rows;
                outcome.status = "ok".into();
                outcome.error = None;
            }
            Err(e) => {
                outcome.rows.clear();
                outcome.status = "parse_error".into();
                outcome.error = Some(e);
            }
        }
        outcome.engine = Some("rust".into());
    } else if options.shadow {
        outcome.shadow = Some(match (outcome.status.as_str(), rust) {
            ("ok", Ok(rows)) => match first_difference(&outcome.rows, &rows) {
                None => Shadow { verdict: "match".into(), detail: None },
                Some(d) => Shadow { verdict: "mismatch".into(), detail: Some(d) },
            },
            ("ok", Err(e)) => Shadow { verdict: "error".into(), detail: Some(format!("rust: {e}")) },
            (_, Ok(_)) => Shadow { verdict: "error".into(), detail: Some(format!("sidecar: {}", outcome.error.clone().unwrap_or_default())) },
            (_, Err(_)) => Shadow { verdict: "match".into(), detail: Some("both parsers refused it".into()) },
        });
    }
}

/// The first place two row sets differ, or `None` when they are the same.
pub fn first_difference(primary: &[Value], shadow: &[Value]) -> Option<String> {
    if primary.len() != shadow.len() {
        return Some(format!("{} rows vs {}", primary.len(), shadow.len()));
    }
    for (i, (a, b)) in primary.iter().zip(shadow).enumerate() {
        if a == b {
            continue;
        }
        let (Some(ao), Some(bo)) = (a.as_object(), b.as_object()) else {
            return Some(format!("row {i}: {a} vs {b}"));
        };
        let mut keys: Vec<&String> = ao.keys().chain(bo.keys()).collect();
        keys.sort();
        keys.dedup();
        for k in keys {
            let (x, y) = (ao.get(k), bo.get(k));
            if x != y {
                let show = |v: Option<&Value>| v.map(|v| v.to_string()).unwrap_or_else(|| "(absent)".into());
                return Some(format!("row {i} field {k}: {} vs {}", show(x), show(y)));
            }
        }
    }
    None
}

impl From<Reply> for CommandOutcome {
    fn from(r: Reply) -> Self {
        CommandOutcome { status: r.status, rows: r.rows, raw: r.raw, duration_ms: r.duration_ms, error: r.error, shadow: None, engine: Some("sidecar".into()) }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProbeResult {
    pub id: String,
    pub cmd: String,
    pub outcome: CommandOutcome,
    pub flags_set: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StepResult {
    pub step: Step,
    pub outcome: CommandOutcome,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DeviceRun {
    pub host: String,
    pub os: Option<String>,
    pub identified_by: Option<String>,
    pub version_text: String,
    pub prompt: String,
    pub role: Option<String>,
    pub caps: Vec<String>,
    pub contexts: Vec<String>,
    pub context_kind: Option<String>,
    pub probes: Vec<ProbeResult>,
    pub plan: Option<Plan>,
    pub results: Vec<StepResult>,
    pub log: Vec<String>,
    /// Why the run stopped before its plan, if it did: `auth`, `timeout`, `unrecognised`, `sidecar`, …
    pub failure: Option<String>,
}

/// Progress, for a screen that watches the run.
pub enum RunEvent<'a> {
    Identified(&'a Identified),
    Probe(&'a ProbeResult),
    Planned(&'a Plan),
    Step(&'a StepResult),
    Log(String),
}

pub trait RunSink: Sync {
    fn event(&self, ev: RunEvent<'_>);
}

/// A sink that keeps nothing.
pub struct Quiet;
impl RunSink for Quiet {
    fn event(&self, _ev: RunEvent<'_>) {}
}

fn session_spec(catalog: &Catalog) -> Value {
    serde_json::to_value(&catalog.session).unwrap_or(Value::Null)
}

/// VRF names a step's rows revealed, from whichever column carries them.
fn vrf_names(rows: &[Value]) -> Vec<String> {
    let mut out = BTreeSet::new();
    for row in rows {
        for key in ["name", "vrf", "vrf_name", "routing_instance", "instance", "vpn_instance", "vrf-name-out"] {
            if let Some(v) = row.get(key).and_then(Value::as_str) {
                let v = v.trim();
                if !v.is_empty() && v != "default" && v != "management" && v != "mgmt" && v != "<not set>" {
                    out.insert(v.to_string());
                }
            }
        }
    }
    out.into_iter().collect()
}

/// Collect one device. Exactly one login is tried (the lockout rule: never
/// cycle credentials against a device); an authentication failure ends the
/// run with `failure = "auth"` and the caller decides what to do next.
pub async fn collect_device(sidecar: &mut Sidecar, catalogs: &[Catalog], target: &Target, auth: &Auth, options: &RunOptions, sink: &dyn RunSink) -> DeviceRun {
    let mut run = DeviceRun { host: target.host.clone(), ..Default::default() };
    let session = format!("s-{}", target.host);

    // 1. Which catalog.
    let identified = match &target.os_hint {
        Some(os) => catalogs.iter().find(|c| &c.os == os).map(|c| Identified { os: c.os.clone(), probe: String::new(), answer: String::new() }),
        None => match fingerprint(sidecar, catalogs, target, auth, options, &mut run).await {
            Ok(found) => found,
            Err(failure) => {
                run.failure = Some(failure);
                return run;
            }
        },
    };
    let Some(identified) = identified else {
        run.failure = Some("unrecognised".into());
        run.log.push("no catalog's fingerprint matched what the device answered".into());
        return run;
    };
    sink.event(RunEvent::Identified(&identified));
    run.os = Some(identified.os.clone());
    run.identified_by = Some(identified.probe.clone());
    run.version_text = identified.answer.clone();
    let catalog = catalogs.iter().find(|c| c.os == identified.os).expect("identified from these catalogs");

    // 2. Open the real session.
    let opened = match sidecar.open(&session, &target.host, target.port, &catalog.os, auth, &session_spec(catalog), options.connect_ms, options.auth_ms).await {
        Ok(r) => r,
        Err(e) => {
            run.failure = Some("sidecar".into());
            run.log.push(e.to_string());
            return run;
        }
    };
    if opened.status != "ok" {
        run.failure = Some(opened.status.clone());
        run.log.push(opened.error.clone().unwrap_or_default());
        return run;
    }
    run.prompt = opened.extra.get("prompt").and_then(Value::as_str).unwrap_or("").to_string();
    run.contexts = opened.extra.get("contexts").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
    run.context_kind = opened.extra.get("context_kind").and_then(Value::as_str).map(str::to_string);

    // 3. Facts: role, defaults, contexts, then the probes.
    let mut facts: Facts = initial_facts(catalog, &run.version_text, target.role_override.as_deref());
    if let (Some(kind), false) = (&run.context_kind, run.contexts.is_empty()) {
        facts.contexts.insert(kind.clone(), run.contexts.clone());
        facts.caps.insert(kind.clone());
    }
    if run.version_text.is_empty() {
        // Opened straight from a hint: fetch the version text for the role hint and the device table.
        if let Some(fp) = &catalog.fingerprint {
            if let Ok(r) = sidecar.run(&session, &fp.probe, "none", &[], 20_000).await {
                if r.status == "ok" {
                    run.version_text = r.raw.clone();
                    let role = crate::capabilities::role_hint(catalog, &run.version_text);
                    if target.role_override.is_none() {
                        facts = initial_facts(catalog, &run.version_text, None);
                        if let Some(kind) = &run.context_kind {
                            if !run.contexts.is_empty() {
                                facts.contexts.insert(kind.clone(), run.contexts.clone());
                                facts.caps.insert(kind.clone());
                            }
                        }
                    }
                    run.log.push(format!("role hint: {role}"));
                }
            }
        }
    }
    for probe in &catalog.caps_probe {
        if let Some(g) = &probe.gate {
            if !coreview_catalog::Gate::parse(g).map(|g| g.eval(&facts)).unwrap_or(false) {
                continue;
            }
        }
        let parser = probe.parser.clone().unwrap_or_else(|| "none".into());
        let outcome: CommandOutcome = match sidecar.run(&session, &probe.cmd, &parser, &[], u64::from(probe.timeout) * 1000).await {
            Ok(r) => r.into(),
            Err(e) => {
                run.failure = Some("sidecar".into());
                run.log.push(e.to_string());
                let _ = sidecar.close(&session).await;
                return run;
            }
        };
        let flags_set = if outcome.status == "ok" { apply_probe(catalog, &probe.id, &outcome.raw, &mut facts) } else { vec![] };
        let pr = ProbeResult { id: probe.id.clone(), cmd: probe.cmd.clone(), outcome, flags_set };
        sink.event(RunEvent::Probe(&pr));
        run.probes.push(pr);
    }

    // 4. Plan and run; a second pass for VRFs the first pass found.
    let mut ran: BTreeSet<String> = BTreeSet::new();
    for pass in 0..2 {
        let mut p = plan(catalog, &facts);
        if options.light_only {
            p.steps.retain(|s| s.weight == Weight::Light);
        }
        if pass == 0 {
            sink.event(RunEvent::Planned(&p));
            run.plan = Some(p.clone());
            if options.plan_only {
                break;
            }
        }
        let steps: Vec<Step> = p.steps.into_iter().filter(|s| !ran.contains(&step_key(s))).collect();
        if steps.is_empty() {
            break;
        }
        if let Err(e) = run_steps(sidecar, &session, catalog, &steps, &mut run, &mut ran, sink, options).await {
            run.failure = Some("sidecar".into());
            run.log.push(e.to_string());
            let _ = sidecar.close(&session).await;
            return run;
        }
        // Anything that fed the vrf table may have named VRFs we did not know.
        let mut found: Vec<String> = Vec::new();
        for r in &run.results {
            if r.step.feeds.iter().any(|t| t == "vrf") && r.outcome.status == "ok" {
                found.extend(vrf_names(&r.outcome.rows));
            }
        }
        found.sort();
        found.dedup();
        let known = facts.contexts.get("vrf").cloned().unwrap_or_default();
        if found.is_empty() || found == known {
            break;
        }
        run.log.push(format!("VRFs found: {}", found.join(", ")));
        facts.contexts.insert("vrf".into(), found);
        facts.caps.insert("vrf".into());
        if let Some(p0) = &mut run.plan {
            let again = plan(catalog, &facts);
            p0.steps = again.steps;
            p0.skipped = again.skipped;
        }
    }
    run.role = facts.role.clone();
    run.caps = facts.caps.iter().cloned().collect();
    let _ = sidecar.close(&session).await;
    run
}

fn step_key(s: &Step) -> String {
    format!("{}\u{0}{}", s.id, s.cmd)
}

async fn fingerprint(sidecar: &mut Sidecar, catalogs: &[Catalog], target: &Target, auth: &Auth, options: &RunOptions, run: &mut DeviceRun) -> Result<Option<Identified>, String> {
    let session = format!("fp-{}", target.host);
    let opened = sidecar
        .open(&session, &target.host, target.port, "generic", auth, &Value::Object(Default::default()), options.connect_ms, options.auth_ms)
        .await
        .map_err(|e| {
            run.log.push(e.to_string());
            "sidecar".to_string()
        })?;
    if opened.status != "ok" {
        run.log.push(opened.error.unwrap_or_default());
        return Err(opened.status);
    }
    run.prompt = opened.extra.get("prompt").and_then(Value::as_str).unwrap_or("").to_string();
    let mut found = None;
    for probe in probes(catalogs) {
        let reply = match sidecar.run(&session, &probe, "none", &[], 20_000).await {
            Ok(r) => r,
            Err(e) => {
                run.log.push(e.to_string());
                let _ = sidecar.close(&session).await;
                return Err("sidecar".into());
            }
        };
        run.log.push(format!("fingerprint {probe}: {}", reply.status));
        if reply.status != "ok" || is_refusal(&reply.raw) {
            continue;
        }
        if let Some(id) = identify(catalogs, &probe, &reply.raw) {
            found = Some(id);
            break;
        }
    }
    let _ = sidecar.close(&session).await;
    Ok(found)
}

#[allow(clippy::too_many_arguments)] // the run's state, threaded through one loop
async fn run_steps(sidecar: &mut Sidecar, session: &str, catalog: &Catalog, steps: &[Step], run: &mut DeviceRun, ran: &mut BTreeSet<String>, sink: &dyn RunSink, options: &RunOptions) -> Result<(), SidecarError> {
    let has_contexts = catalog.session.contexts.is_some() && !run.contexts.is_empty();
    let mut current: Option<String> = None; // None = system
    for step in steps {
        // Where this step runs: a named VDOM/context/vsys, the global scope, or the system prompt.
        let wanted: Option<String> = match (&step.context, &step.scope) {
            (Some((kind, name)), _) if kind != "vrf" && kind != "instance" => Some(name.clone()),
            (_, Some(scope)) if scope == "global" && has_contexts => Some("global".into()),
            _ => None,
        };
        if wanted != current {
            if has_contexts || wanted.is_none() {
                let kind = run.context_kind.clone().unwrap_or_else(|| "context".into());
                let r = sidecar.switch(session, &kind, wanted.as_deref()).await?;
                if r.status != "ok" {
                    run.log.push(format!("could not enter {}: {}", wanted.clone().unwrap_or_else(|| "system".into()), r.error.unwrap_or_default()));
                    ran.insert(step_key(step));
                    let sr = StepResult { step: step.clone(), outcome: CommandOutcome { status: "unsupported".into(), error: Some("context not entered".into()), ..Default::default() } };
                    sink.event(RunEvent::Step(&sr));
                    run.results.push(sr);
                    continue;
                }
            }
            current = wanted;
        }
        let also: Vec<String> = catalog.commands.iter().find(|c| c.id == step.id).map(|c| c.also.clone()).unwrap_or_default();
        let parser = sidecar_parser(step, catalog, options);
        let reply = sidecar.run(session, &step.cmd, &parser, &also, u64::from(step.timeout) * 1000).await?;
        let mut outcome: CommandOutcome = reply.into();
        settle(&mut outcome, step, catalog, &also, options);
        if step.parser == "raw" || step.feeds.iter().any(|t| t == "raw_config") {
            outcome.raw = scrub(&outcome.raw);
        }
        if step.verified == Verified::Unverified && outcome.status == "ok" {
            run.log.push(format!("{}: answered; unverified until a capture is kept", step.cmd));
        }
        ran.insert(step_key(step));
        let sr = StepResult { step: step.clone(), outcome };
        sink.event(RunEvent::Step(&sr));
        run.results.push(sr);
    }
    if current.is_some() && has_contexts {
        let kind = run.context_kind.clone().unwrap_or_else(|| "context".into());
        let _ = sidecar.switch(session, &kind, None).await;
    }
    Ok(())
}
