//! IPC for the catalog-driven collection (LT-514, LT-516, LT-517; D-060).
//!
//! The same rule as `discovery.rs`: **credentials arrive per run and are
//! never stored.** They go to the sidecar on its stdin, live for one run,
//! and come back nowhere. Raw replies are written only when the operator
//! ticked the diagnostic, redacted, under the run's own folder (D-055);
//! the database keeps rows, statuses and durations, never a reply.

use std::path::{Path, PathBuf};
use coreview_catalog::Catalog;
use coreview_collect::run::{DeviceRun, RunEvent, RunOptions, RunSink, Target};
use coreview_collect::sidecar::{Auth, Sidecar, SidecarLocation};
use coreview_collect::tables::normalise_all;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::collection_db as cdb;
use crate::commands::AppState;
use crate::discovery::CredentialInput;

type CmdResult<T> = Result<T, String>;

fn db_err(e: impl std::fmt::Display) -> String {
    format!("Local database error: {e}")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionInput {
    pub project_id: String,
    /// Addresses or hostnames, one per line or comma-separated. No ranges:
    /// a collection is pointed at devices, a crawl finds them.
    pub targets: String,
    pub port: u16,
    /// A catalog `os` to skip the fingerprint, when known.
    pub os_hint: Option<String>,
    /// The operator's role override, which survives re-runs.
    pub role_override: Option<String>,
    /// Fingerprint, probe, plan — and stop. The preview before a run.
    pub plan_only: bool,
    pub light_only: bool,
    /// A saved login (D-059: must belong to the open project), else `credentials`.
    pub credential_id: Option<String>,
    /// Keep every reply, redacted, under the run's diagnostic folder.
    pub keep_diagnostic: bool,
    pub connect_timeout_secs: Option<u64>,
    pub auth_timeout_secs: Option<u64>,
    /// LT-518: a saved API login for a device's own REST API (FortiOS,
    /// AOS-CX) and for an FMC.
    pub api_credential_id: Option<String>,
    /// LT-541: the FMC managing the FTDs this collection reaches.
    pub fmc_host: Option<String>,
    /// LT-549: a saved SNMP login, used only for a device whose SSH session
    /// could not be opened.
    pub snmp_credential_id: Option<String>,
    /// LT-576: follow CDP/LLDP neighbours from the targets, as "Discover
    /// devices" does. Absent, only the targets are collected.
    pub follow: Option<FollowInput>,
}

/// LT-576: how far a collection follows neighbours from its seeds.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FollowInput {
    pub max_hops: u32,
    pub max_devices: usize,
    /// `192.0.2.0/24`, several separated by commas: only neighbours inside
    /// one of them are followed.
    pub subnet_limit: Option<String>,
}

/// One event on `coreview://collection`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum CollectionEvent {
    Started { run_id: String, targets: usize },
    Device { run_id: String, device_id: String, host: String, phase: String },
    Identified { run_id: String, device_id: String, os: String, probe: String },
    Probe { run_id: String, device_id: String, id: String, cmd: String, status: String, flags: Vec<String> },
    Planned { run_id: String, device_id: String, steps: usize, skipped: usize },
    Step { run_id: String, device_id: String, step_id: String, cmd: String, status: String, rows: usize, duration_ms: u64, context: Option<String> },
    DeviceDone { run_id: String, device_id: String, host: String, os: Option<String>, failure: Option<String>, commands: usize },
    Finished { run_id: String, devices: usize, failed: usize, cancelled: bool },
    Failed { run_id: String, error: String },
}

struct Emit {
    app: AppHandle,
    run_id: String,
    device_id: String,
}

impl Emit {
    fn send(&self, ev: CollectionEvent) {
        let _ = self.app.emit("coreview://collection", &ev);
    }
}

impl RunSink for Emit {
    fn event(&self, ev: RunEvent<'_>) {
        match ev {
            RunEvent::Identified(i) => self.send(CollectionEvent::Identified { run_id: self.run_id.clone(), device_id: self.device_id.clone(), os: i.os.clone(), probe: i.probe.clone() }),
            RunEvent::Probe(p) => self.send(CollectionEvent::Probe { run_id: self.run_id.clone(), device_id: self.device_id.clone(), id: p.id.clone(), cmd: p.cmd.clone(), status: p.outcome.status.clone(), flags: p.flags_set.clone() }),
            RunEvent::Planned(p) => self.send(CollectionEvent::Planned { run_id: self.run_id.clone(), device_id: self.device_id.clone(), steps: p.steps.len(), skipped: p.skipped.len() }),
            RunEvent::Step(s) => self.send(CollectionEvent::Step {
                run_id: self.run_id.clone(),
                device_id: self.device_id.clone(),
                step_id: s.step.id.clone(),
                cmd: s.step.cmd.clone(),
                status: s.outcome.status.clone(),
                rows: s.outcome.rows.len(),
                duration_ms: s.outcome.duration_ms,
                context: s.step.context.as_ref().map(|c| c.1.clone()),
            }),
            RunEvent::Log(_) => {}
        }
    }
}

// ------------------------------------------------------------- locations

/// The repository, for a development build: the resources beside the crate.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn resource(app: &AppHandle, rel: &str) -> Option<PathBuf> {
    use tauri::path::BaseDirectory;
    use tauri::Manager;
    app.path().resolve(rel, BaseDirectory::Resource).ok().filter(|p| p.exists())
}

/// Where the catalogs are: the bundled resource, else the repository (dev).
pub fn catalog_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    resource(app, "catalog")
        .or_else(|| Some(repo_root().join("resources/catalog")).filter(|p| p.exists()))
        .ok_or_else(|| "The discovery catalogs are not installed.".to_string())
}

fn templates_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    resource(app, "templates/ntc")
        .or_else(|| Some(repo_root().join("resources/templates/ntc")).filter(|p| p.exists()))
        .ok_or_else(|| "The parser templates are not installed.".to_string())
}

/// Where the sidecar's interpreter is. `COREVIEW_SIDECAR_PYTHON` and
/// `COREVIEW_SIDECAR_DIR` override for development; otherwise the bundled
/// `sidecar/` resource; otherwise the repository's venv.
pub fn sidecar_location(app: &AppHandle) -> CmdResult<SidecarLocation> {
    let templates = templates_dir(app)?;
    if let Ok(python) = std::env::var("COREVIEW_SIDECAR_PYTHON") {
        let cwd = std::env::var("COREVIEW_SIDECAR_DIR").map(PathBuf::from).unwrap_or_else(|_| repo_root().join("sidecar"));
        return Ok(SidecarLocation { python: PathBuf::from(python), cwd, templates_dir: templates });
    }
    // The installed sidecar (LT-519): an embeddable CPython whose ._pth puts
    // Lib\site-packages — where the package is — on its path; spawned by
    // absolute path from the install directory, never from a temp folder.
    if let Some(dir) = resource(app, "sidecar") {
        let python = if cfg!(windows) { dir.join("python.exe") } else { dir.join("bin/python") };
        if python.exists() {
            return Ok(SidecarLocation { python, cwd: dir, templates_dir: templates });
        }
    }
    let dev = repo_root().join("sidecar");
    for candidate in [dev.join(".venv/bin/python"), dev.join(".venv/Scripts/python.exe")] {
        if candidate.exists() {
            return Ok(SidecarLocation { python: candidate, cwd: dev, templates_dir: templates });
        }
    }
    Err("The collector sidecar is not installed. In development: `cd sidecar && python3 -m venv .venv && .venv/bin/pip install --require-hashes -r requirements.txt`, or set COREVIEW_SIDECAR_PYTHON.".into())
}

/// The catalogs, and none of them unless every one is sound: a catalog
/// `problems()` objects to — a command outside the allowlist, a gate that
/// does not parse, a template that is not there — stops the collection
/// before it starts (LT-522). Data the app ships is still checked at the
/// door, because a resource folder is a folder.
/// LT-521: the Rust TextFSM engine over the same templates the sidecar reads.
fn rust_engine(app: &AppHandle) -> CmdResult<std::sync::Arc<coreview_catalog::textfsm::Engine>> {
    Ok(std::sync::Arc::new(coreview_catalog::textfsm::Engine::new(templates_dir(app)?)))
}

/// LT-521's feature flag: the project setting `collectorShadow`.
fn shadow_on(state: &AppState, project_id: &str) -> bool {
    let Ok(conn) = state.db.lock() else { return false };
    crate::db::project_settings(&conn, project_id).ok().and_then(|s| s.get("collectorShadow").cloned()).as_deref() == Some("true")
}

fn load_catalogs(app: &AppHandle) -> CmdResult<Vec<Catalog>> {
    let dir = catalog_dir(app)?;
    let catalogs = coreview_catalog::load_dir(&dir).map_err(|e| format!("The discovery catalogs could not be read: {e}"))?;
    let templates = templates_dir(app).ok();
    let mut problems = Vec::new();
    for c in &catalogs {
        problems.extend(coreview_catalog::load::problems(c, templates.as_deref()));
    }
    if !problems.is_empty() {
        return Err(format!("The discovery catalogs are not sound and nothing was sent: {}", problems.join("; ")));
    }
    Ok(catalogs)
}

// --------------------------------------------------------------- persist

/// The rows a step's answer yields for the tables: TextFSM rows as they
/// are, a structured answer flattened first.
fn device_id_of(host: &str) -> String {
    format!("dev-{}", host.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>())
}

/// LT-549: SNMP stands in only when SSH could not open a session — a wrong
/// login, a timeout, a refused connection. A changed host key is not one:
/// that is a refusal to talk to the box, not a reason to talk to it another
/// way.
fn snmp_eligible(run: &DeviceRun) -> bool {
    matches!(run.failure.as_deref(), Some("auth" | "timeout" | "error")) && run.os.is_none()
}

/// The SNMP tables appended to the device's run as steps, stored and
/// normalised like any other; the SSH failure stays recorded beside them.
fn apply_snmp_fallback(run: &mut DeviceRun, read: Result<Vec<coreview_discover::snmp_collect::SnmpTable>, coreview_discover::snmp::SnmpError>, sink: &dyn RunSink) {
    let ssh = run.failure.clone().unwrap_or_default();
    match read {
        Ok(tables) => {
            run.os = Some("snmp".into());
            run.log.push(format!("SSH could not open a session ({ssh}); the device was read over SNMP instead"));
            if let Some(v) = tables.iter().find(|t| t.id == "snmp_system").and_then(|t| t.rows.first()).and_then(|r| r.get("version")).and_then(|v| v.as_str()) {
                run.version_text = v.to_string();
            }
            for t in tables {
                let step = coreview_catalog::Step {
                    id: t.id.into(),
                    cmd: t.mib.into(),
                    gate: "snmp fallback".into(),
                    because: vec![format!("ssh: {ssh}")],
                    parser: "snmp".into(),
                    feeds: t.feeds.iter().map(|f| f.to_string()).collect(),
                    weight: coreview_catalog::Weight::Light,
                    timeout: 5,
                    verified: coreview_catalog::Verified::Docs,
                    context: None,
                    scope: None,
                };
                let status = if t.rows.is_empty() { "unsupported" } else { "ok" };
                let outcome = coreview_collect::run::CommandOutcome { status: status.into(), rows: t.rows, raw: String::new(), duration_ms: 0, error: None, shadow: None, engine: Some("snmp".into()) };
                let sr = coreview_collect::run::StepResult { step, outcome };
                sink.event(RunEvent::Step(&sr));
                run.results.push(sr);
            }
        }
        Err(e) => run.log.push(format!("SSH could not open a session ({ssh}), and SNMP did not answer either: {e}")),
    }
}

#[cfg(test)]
mod snmp_fallback_tests {
    use super::*;
    use coreview_collect::run::Quiet;
    use coreview_discover::snmp_collect::SnmpTable;
    use serde_json::json;

    #[test]
    fn only_a_session_that_could_not_open_falls_back() {
        let r = |f: Option<&str>, os: Option<&str>| DeviceRun { failure: f.map(str::to_string), os: os.map(str::to_string), ..Default::default() };
        assert!(snmp_eligible(&r(Some("auth"), None)));
        assert!(snmp_eligible(&r(Some("timeout"), None)));
        assert!(snmp_eligible(&r(Some("error"), None)));
        assert!(!snmp_eligible(&r(Some("host_key"), None)), "a changed host key is a refusal");
        assert!(!snmp_eligible(&r(None, Some("cisco_ios"))));
        assert!(!snmp_eligible(&r(Some("unrecognised"), None)), "SSH worked");
    }

    #[test]
    fn the_tables_become_steps_the_collection_stores() {
        let mut run = DeviceRun { host: "192.0.2.9".into(), failure: Some("auth".into()), ..Default::default() };
        let tables = vec![
            SnmpTable { id: "snmp_system", mib: "SNMPv2-MIB system, ENTITY-MIB", feeds: &["device"], rows: vec![json!({"hostname": "SNMP-SW", "version": "Cisco IOS Software"})] },
            SnmpTable { id: "snmp_cdp", mib: "CISCO-CDP-MIB", feeds: &["neighbor"], rows: vec![] },
        ];
        apply_snmp_fallback(&mut run, Ok(tables), &Quiet);
        assert_eq!(run.os.as_deref(), Some("snmp"), "so the topology builder takes the device");
        assert_eq!(run.failure.as_deref(), Some("auth"), "the SSH failure is still said");
        assert_eq!(run.version_text, "Cisco IOS Software");
        assert_eq!(run.results.len(), 2);
        assert_eq!((run.results[0].step.feeds[0].as_str(), run.results[0].outcome.status.as_str()), ("device", "ok"));
        assert_eq!(run.results[1].outcome.status, "unsupported", "a MIB with nothing in it is said as such");
        assert!(run.log.iter().any(|l| l.contains("read over SNMP instead")));
        let mut none = DeviceRun { host: "192.0.2.9".into(), failure: Some("timeout".into()), ..Default::default() };
        apply_snmp_fallback(&mut none, Err(coreview_discover::snmp::SnmpError::NothingReturned { host: "192.0.2.9".into() }), &Quiet);
        assert_eq!(none.os, None);
        assert!(none.log.iter().any(|l| l.contains("SNMP did not answer either")));
    }
}

/// Write one device's run: the device, its command log and its rows; raw
/// replies to the diagnostic folder when there is one, redacted.
fn persist_device(state: &AppState, run_id: &str, run: &DeviceRun, diagnostic: Option<&Path>, secrets: &[String]) -> CmdResult<usize> {
    let device_id = device_id_of(&run.host);
    let conn = state.db.lock().map_err(db_err)?;
    let plan = run.plan.as_ref().map(|p| serde_json::to_value(p).unwrap_or(Value::Null));
    cdb::write_device(
        &conn,
        run_id,
        &device_id,
        &run.host,
        run.os.as_deref(),
        run.role.as_deref(),
        &run.caps,
        &run.version_text,
        &run.prompt,
        run.context_kind.as_deref(),
        &run.contexts,
        run.failure.as_deref(),
        &run.log,
        plan.as_ref(),
    )
    .map_err(db_err)?;
    let mut seq: i64 = 0;
    let keep = |seq: i64, cmd: &str, raw: &str| -> Option<String> {
        let dir = diagnostic?;
        if raw.is_empty() {
            return None;
        }
        let host_dir = dir.join(run.host.replace(['/', '\\', ':'], "-"));
        let _ = std::fs::create_dir_all(&host_dir);
        let name = format!("{seq:03}-{}.txt", cmd.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect::<String>().trim_matches('-'));
        let path = host_dir.join(&name);
        // Configuration secrets as well as the login's own: a capability probe
        // such as `show run | include ^crypto` carries a pre-shared key line.
        std::fs::write(&path, coreview_discover::support::redact(&coreview_collect::scrub::scrub(raw), secrets)).ok()?;
        Some(format!("{}/{}", host_dir.file_name()?.to_string_lossy(), name))
    };
    for p in &run.probes {
        seq += 1;
        let raw_ref = keep(seq, &p.cmd, &p.outcome.raw);
        let e = cdb::LogEntry {
            device_id: device_id.clone(),
            seq,
            step_id: p.id.clone(),
            cmd: p.cmd.clone(),
            kind: "probe".into(),
            context_kind: None,
            context_name: None,
            gate: String::new(),
            parser: "regex".into(),
            feeds: vec![],
            status: p.outcome.status.clone(),
            duration_ms: p.outcome.duration_ms as i64,
            rows: p.flags_set.len() as i64,
            raw_ref,
            error: p.outcome.error.clone(),
            verified: None,
            shadow: None,
            shadow_detail: None,
            engine: None,
        };
        cdb::write_log(&conn, run_id, &device_id, seq, &e).map_err(db_err)?;
    }
    let mut commands = 0;
    for r in &run.results {
        seq += 1;
        commands += 1;
        let raw_ref = keep(seq, &r.step.cmd, &r.outcome.raw);
        let rows = if r.outcome.status == "ok" { coreview_collect::tables::rows_of(&r.step.parser, &r.outcome) } else { Vec::new() };
        let e = cdb::LogEntry {
            device_id: device_id.clone(),
            seq,
            step_id: r.step.id.clone(),
            cmd: r.step.cmd.clone(),
            kind: "command".into(),
            context_kind: r.step.context.as_ref().map(|c| c.0.clone()),
            context_name: r.step.context.as_ref().map(|c| c.1.clone()),
            gate: r.step.gate.clone(),
            parser: r.step.parser.clone(),
            feeds: r.step.feeds.clone(),
            status: r.outcome.status.clone(),
            duration_ms: r.outcome.duration_ms as i64,
            rows: rows.len() as i64,
            raw_ref,
            error: r.outcome.error.clone(),
            verified: Some(format!("{:?}", r.step.verified).to_lowercase()),
            shadow: r.outcome.shadow.as_ref().map(|s| s.verdict.clone()),
            shadow_detail: r.outcome.shadow.as_ref().and_then(|s| s.detail.clone()),
            engine: r.outcome.engine.clone(),
        };
        cdb::write_log(&conn, run_id, &device_id, seq, &e).map_err(db_err)?;
        for n in coreview_collect::tables::rows_for_step(&r.step, &rows) {
            cdb::write_row(&conn, run_id, &device_id, &r.step.id, &n).map_err(db_err)?;
        }
    }
    Ok(commands)
}

fn split_targets(text: &str) -> Vec<String> {
    let mut out: Vec<String> = text.split(|c: char| c == ',' || c == ';' || c.is_whitespace()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect();
    out.dedup();
    out
}

// -------------------------------------------------------------- commands

#[tauri::command]
pub async fn start_collection(app: AppHandle, state: State<'_, AppState>, input: CollectionInput, credentials: Option<CredentialInput>) -> CmdResult<String> {
    state.limiter.allow(crate::ratelimit::Job::Crawl)?;
    let targets = split_targets(&input.targets);
    if targets.is_empty() {
        return Err("Name at least one device to collect from.".into());
    }
    if targets.len() > 500 {
        return Err("A collection takes at most 500 devices at a time.".into());
    }
    // LT-576: the collector visits one device at a time, so a range would be
    // hundreds of timeouts in a row.
    if let Some(range) = targets.iter().find(|t| t.contains('/')) {
        return Err(format!("{range} is a range; the collector takes device addresses. Sweep the range first (Ping sweep), or choose the classic crawler."));
    }
    let project_id = input.project_id.trim().to_string();
    if project_id.is_empty() {
        return Err("A collection belongs to a project; open one first.".into());
    }
    // The login: a saved one (checked against the open project, D-059) or the typed one.
    let creds = match input.credential_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => {
            let c = crate::vault_commands::ssh_credentials(&state, id)?;
            crate::vault_commands::note_use(&state, id, "Collection", &input.targets);
            c
        }
        None => credentials.filter(|c| !c.username.trim().is_empty()).map(Into::into).ok_or("A login is needed: pick a saved one or type one.")?,
    };
    let mut secrets = creds.secrets();
    let auth = Auth { username: creds.username.clone(), password: secrets.first().cloned().unwrap_or_default(), enable: secrets.get(1).cloned(), private_key: None };
    // LT-518: the REST side, when a saved API login was chosen.
    let fmc_host = input.fmc_host.as_deref().map(str::trim).filter(|h| !h.is_empty()).map(str::to_string);
    if let Some(h) = &fmc_host {
        if h.len() > 255 || !h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']')) {
            return Err("The FMC address is not an address or a host name.".into());
        }
    }
    let api_login = match input.api_credential_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => {
            let l = crate::vault_commands::api_credentials(&state, id)?;
            crate::vault_commands::note_use(&state, id, "Collection (API)", &format!("{}{}", input.targets, fmc_host.as_deref().map(|h| format!(" via FMC {h}")).unwrap_or_default()));
            secrets.push(l.secret.clone());
            Some(l)
        }
        None => None,
    };
    // LT-549: the SNMP fallback's login, when one was chosen.
    let snmp_auth = match input.snmp_credential_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => {
            let a = crate::vault_commands::snmp_credentials(&state, id)?;
            crate::vault_commands::note_use(&state, id, "Collection (SNMP fallback)", &input.targets);
            Some(a)
        }
        None => None,
    };
    let catalogs = load_catalogs(&app)?;
    let location = sidecar_location(&app)?;
    // LT-529: the same host-key store the crawl and the terminal use.
    let host_keys = crate::discovery::load_host_keys(&state)?;
    let ticket = state.jobs.start(crate::jobs::Kind::Collect)?;
    let token = ticket.token();
    let progress = ticket.progress();
    let stamp = crate::db::now_ms();
    let run_id = format!("col-{stamp}");
    let diagnostic: Option<PathBuf> = if input.keep_diagnostic { Some(crate::db::data_dir().join("diagnostics").join(format!("collection-{stamp}"))) } else { None };
    if let Some(d) = &diagnostic {
        std::fs::create_dir_all(d).map_err(|e| format!("The diagnostic folder could not be made: {e}"))?;
    }
    {
        let conn = state.db.lock().map_err(db_err)?;
        cdb::open_run(&conn, &run_id, &project_id, &input.targets, input.plan_only, diagnostic.as_ref().map(|d| d.to_string_lossy().to_string()).as_deref(), "live").map_err(db_err)?;
    }
    let options = RunOptions {
        connect_ms: input.connect_timeout_secs.unwrap_or(8).clamp(1, 120) * 1000,
        auth_ms: input.auth_timeout_secs.unwrap_or(20).clamp(1, 300) * 1000,
        light_only: input.light_only,
        plan_only: input.plan_only,
        engine: Some(rust_engine(&app)?),
        shadow: shadow_on(&state, &project_id),
    };
    // LT-576: following neighbours, when asked; otherwise the targets alone.
    let following = input.follow.is_some();
    let limits = match &input.follow {
        Some(f) => coreview_collect::follow::Limits {
            max_hops: f.max_hops.min(16),
            max_devices: f.max_devices.clamp(1, 500),
            subnets: f.subnet_limit.as_deref().unwrap_or("").split([',', ';', ' ', '\n']).map(str::trim).filter(|s| !s.is_empty()).map(coreview_collect::follow::parse_subnet).collect::<Result<Vec<_>, _>>()?,
        },
        None => coreview_collect::follow::Limits { max_hops: 0, max_devices: targets.len(), subnets: Vec::new() },
    };
    let port = input.port;
    let os_hint = input.os_hint.clone().filter(|s| !s.trim().is_empty());
    let role_override = input.role_override.clone().filter(|s| !s.trim().is_empty());
    let app2 = app.clone();
    let run_id2 = run_id.clone();
    let _ = app.emit("coreview://collection", &CollectionEvent::Started { run_id: run_id.clone(), targets: targets.len() });
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        let _ticket = ticket;
        let state_arc = app2.state::<AppState>();
        // LT-588: started here so a wrong interpreter fails the run at once;
        // after that the slot replaces a sidecar that stops answering.
        let first = match Sidecar::spawn(&location).await {
            Ok(s) => s,
            Err(e) => {
                if let Ok(conn) = state_arc.db.lock() {
                    let _ = cdb::finish_run(&conn, &run_id2, "failed");
                }
                let _ = app2.emit("coreview://collection", &CollectionEvent::Failed { run_id: run_id2.clone(), error: e.to_string() });
                return;
            }
        };
        let mut slot = coreview_collect::collector::SidecarSlot::started(location, first);
        let mut devices = 0usize;
        let mut failed = 0usize;
        let mut cancelled = false;
        let mut frontier = coreview_collect::follow::Frontier::new(&targets, limits);
        while let Some((host, hop)) = frontier.next_device() {
            let host = &host;
            if token.is_cancelled() {
                cancelled = true;
                break;
            }
            let total = (devices + 1 + frontier.waiting()) as u64;
            progress.set(format!("Collecting {host}"), devices as u64, Some(total));
            let device_id = device_id_of(host);
            let _ = app2.emit("coreview://collection", &CollectionEvent::Device { run_id: run_id2.clone(), device_id: device_id.clone(), host: host.clone(), phase: "connecting".into() });
            let sink = Emit { app: app2.clone(), run_id: run_id2.clone(), device_id: device_id.clone() };
            let known_host_key = host_keys.lock().ok().and_then(|k| k.known(host, port));
            let target = Target { host: host.clone(), port, os_hint: os_hint.clone(), role_override: role_override.clone(), known_host_key };
            // LT-589: Stop ends the device in progress at once.
            let Some(mut run) = slot.collect(&catalogs, &target, &auth, &options, &sink, &token).await else {
                cancelled = true;
                break;
            };
            if let (Some(snmp), true) = (&snmp_auth, snmp_eligible(&run)) {
                let read = coreview_discover::snmp_collect::read_for_collection(host, 161, snmp, std::time::Duration::from_secs(5)).await;
                apply_snmp_fallback(&mut run, read, &sink);
            }
            if let Some(login) = &api_login {
                // LT-518: the REST side, its certificate pinned in the same store as SSH host keys.
                let known = |h: &str, p: u16| host_keys.lock().ok().and_then(|k| k.known(h, p));
                if let Some(first) = coreview_collect::api::collect_for(&mut run, &catalogs, login, fmc_host.as_deref(), known, &sink).await {
                    if let Ok(mut k) = host_keys.lock() {
                        k.remember(&first.host, first.port, &first.fingerprint);
                    }
                    crate::discovery::persist_host_keys(&app2, &host_keys);
                }
            }
            if let (true, Some(key)) = (run.host_key_first_seen, run.host_key.clone()) {
                if let Ok(mut k) = host_keys.lock() {
                    k.remember(host, port, &key);
                }
                crate::discovery::persist_host_keys(&app2, &host_keys);
                run.log.push(format!("host key seen for the first time and now remembered: {key}"));
            }
            let commands = persist_device(&state_arc, &run_id2, &run, diagnostic.as_deref(), &secrets).unwrap_or(0);
            if following {
                let (own, neighbours) = coreview_collect::follow::addresses_of_run(&run);
                frontier.learn(hop, &own, &neighbours);
            }
            devices += 1;
            if run.failure.is_some() {
                failed += 1;
            }
            let _ = app2.emit("coreview://collection", &CollectionEvent::DeviceDone { run_id: run_id2.clone(), device_id, host: host.clone(), os: run.os.clone(), failure: run.failure.clone(), commands });
            // LT-588: a sidecar that stopped answering has been replaced; the run goes on.
        }
        slot.quit().await;
        if let Ok(conn) = state_arc.db.lock() {
            let _ = cdb::finish_run(&conn, &run_id2, if cancelled { "cancelled" } else { "finished" });
        }
        progress.set("Finished", devices as u64, Some(devices as u64));
        let _ = app2.emit("coreview://collection", &CollectionEvent::Finished { run_id: run_id2, devices, failed, cancelled });
    });
    Ok(run_id)
}

#[tauri::command(async)]
pub fn cancel_collection(state: State<'_, AppState>) -> CmdResult<()> {
    state.jobs.cancel(crate::jobs::Kind::Collect);
    Ok(())
}

#[tauri::command(async)]
pub fn list_collection_runs(state: State<'_, AppState>, project_id: String) -> CmdResult<Vec<cdb::RunSummary>> {
    let conn = state.db.lock().map_err(db_err)?;
    cdb::list_runs(&conn, &project_id).map_err(db_err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub run: Option<cdb::RunSummary>,
    pub devices: Vec<cdb::DeviceSummary>,
    pub log: Vec<cdb::LogEntry>,
    pub tables: Vec<(String, i64)>,
}

#[tauri::command(async)]
pub fn collection_run(state: State<'_, AppState>, id: String) -> CmdResult<RunDetail> {
    let conn = state.db.lock().map_err(db_err)?;
    let project = cdb::run_project(&conn, &id).map_err(db_err)?.ok_or("That collection run no longer exists.")?;
    let run = cdb::list_runs(&conn, &project).map_err(db_err)?.into_iter().find(|r| r.id == id);
    Ok(RunDetail { run, devices: cdb::list_devices(&conn, &id).map_err(db_err)?, log: cdb::list_log(&conn, &id, None).map_err(db_err)?, tables: cdb::table_counts(&conn, &id).map_err(db_err)? })
}

/// LT-521: per (os, command), how often both parsers read a reply and how
/// often they disagreed — across every run of the project.
#[tauri::command(async)]
pub fn shadow_report(state: State<'_, AppState>, project_id: String) -> CmdResult<Vec<cdb::ShadowLine>> {
    let conn = state.db.lock().map_err(db_err)?;
    cdb::shadow_report(&conn, Some(&project_id)).map_err(db_err)
}

#[tauri::command(async)]
pub fn collection_table(state: State<'_, AppState>, run_id: String, table: String, device_id: Option<String>) -> CmdResult<Vec<Value>> {
    let conn = state.db.lock().map_err(db_err)?;
    cdb::read_table(&conn, &run_id, &table, device_id.as_deref()).map_err(db_err)
}

/// One kept reply, from the run's own diagnostic folder and nowhere else.
#[tauri::command(async)]
pub fn collection_raw(state: State<'_, AppState>, run_id: String, raw_ref: String) -> CmdResult<String> {
    let dir = {
        let conn = state.db.lock().map_err(db_err)?;
        let project = cdb::run_project(&conn, &run_id).map_err(db_err)?.ok_or("That collection run no longer exists.")?;
        cdb::list_runs(&conn, &project).map_err(db_err)?.into_iter().find(|r| r.id == run_id).and_then(|r| r.diagnostic_dir)
    };
    let Some(dir) = dir else { return Err("This run kept no replies (the diagnostic was not ticked).".into()) };
    if raw_ref.contains("..") || raw_ref.starts_with('/') || raw_ref.contains('\\') {
        return Err("Not a reply of this run.".into());
    }
    let path = Path::new(&dir).join(&raw_ref);
    std::fs::read_to_string(&path).map_err(|e| format!("That reply could not be read: {e}"))
}

// -------------------------------------------------------- offline import

/// `<folder>/<host>/<command>.txt` — a capture per file, as the support
/// capture writes them (`NNN-show-ip-arp.txt`) or by hand
/// (`show ip arp.txt`) — through the identical pipeline with no device:
/// fingerprint from the version file, capabilities from the probe files,
/// the plan, then every step whose file exists parsed by the sidecar's
/// `parse` op. VRF-expanded commands are found by their file names.
#[tauri::command]
pub async fn import_captures(app: AppHandle, state: State<'_, AppState>, project_id: String, folder: String) -> CmdResult<String> {
    let root = PathBuf::from(&folder);
    if !root.is_dir() {
        return Err("That folder does not exist.".into());
    }
    let catalogs = load_catalogs(&app)?;
    let location = sidecar_location(&app)?;
    let stamp = crate::db::now_ms();
    let run_id = format!("imp-{stamp}");
    {
        let conn = state.db.lock().map_err(db_err)?;
        cdb::open_run(&conn, &run_id, &project_id, &folder, false, Some(&folder), "import").map_err(db_err)?;
    }
    let options = RunOptions { engine: Some(rust_engine(&app)?), shadow: shadow_on(&state, &project_id), ..Default::default() };
    let mut sidecar = Sidecar::spawn(&location).await.map_err(|e| e.to_string())?;
    let mut hosts: Vec<PathBuf> = std::fs::read_dir(&root).map_err(|e| e.to_string())?.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.is_dir()).collect();
    hosts.sort();
    let mut imported = 0usize;
    for host_dir in hosts {
        let host = host_dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let files = capture_files(&host_dir);
        let run = import_one(&mut sidecar, &catalogs, &host, &files, &options).await;
        persist_device(&state, &run_id, &run, None, &[])?;
        imported += 1;
    }
    sidecar.quit().await;
    let conn = state.db.lock().map_err(db_err)?;
    cdb::finish_run(&conn, &run_id, "finished").map_err(db_err)?;
    let _ = app.emit("coreview://collection", &CollectionEvent::Finished { run_id: run_id.clone(), devices: imported, failed: 0, cancelled: false });
    Ok(run_id)
}

/// (slug, path) for every `.txt` in a host's folder; the numeric prefix the
/// support capture adds is dropped from the slug.
fn capture_files(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("txt") {
                continue;
            }
            let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let stem = stem.splitn(2, '-').collect::<Vec<_>>();
            let name = if stem.len() == 2 && stem[0].chars().all(|c| c.is_ascii_digit()) { stem[1].to_string() } else { stem.join("-") };
            out.push((slug(&name), p));
        }
    }
    out.sort();
    out
}

pub fn slug(command: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in command.trim().chars() {
        if c.is_ascii_alphanumeric() || c == '.' {
            out.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    out.trim_end_matches('-').to_string()
}

/// The file for a command, and for a `{vrf}`-shaped command every file that
/// fits, with the name the placeholder stood for.
fn files_for(files: &[(String, PathBuf)], cmd: &str) -> Vec<(Option<String>, PathBuf)> {
    if !cmd.contains('{') {
        let s = slug(cmd);
        return files.iter().filter(|(f, _)| *f == s).map(|(_, p)| (None, p.clone())).collect();
    }
    let pattern = slug(&cmd.replace(['{', '}'], ""));
    // slug("show ip route vrf {vrf}") = "show-ip-route-vrf-vrf": the placeholder's own slug is the tail to replace.
    let key = cmd.split('{').nth(1).and_then(|s| s.split('}').next()).unwrap_or("vrf");
    let (before, after) = match pattern.rsplit_once(&slug(key)) {
        Some(x) => x,
        None => return Vec::new(),
    };
    files
        .iter()
        .filter_map(|(f, p)| {
            let rest = f.strip_prefix(before)?;
            let name = rest.strip_suffix(after)?;
            if name.is_empty() || name.contains('-') && after.is_empty() && false {
                return None;
            }
            Some((Some(name.to_string()), p.clone()))
        })
        .collect()
}

async fn import_one(sidecar: &mut Sidecar, catalogs: &[Catalog], host: &str, files: &[(String, PathBuf)], options: &RunOptions) -> DeviceRun {
    use coreview_catalog::{plan, Facts};
    use coreview_collect::capabilities::{apply_probe, initial_facts};
    use coreview_collect::fingerprint::{identify, probes};
    use coreview_collect::run::{CommandOutcome, ProbeResult, StepResult};

    let mut run = DeviceRun { host: host.to_string(), ..Default::default() };
    let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();
    let mut identified = None;
    for probe in probes(catalogs) {
        for (_, p) in files_for(files, &probe) {
            if let Some(id) = identify(catalogs, &probe, &read(&p)) {
                identified = Some(id);
                break;
            }
        }
        if identified.is_some() {
            break;
        }
    }
    let Some(id) = identified else {
        run.failure = Some("unrecognised".into());
        run.log.push("no version file matched a catalog fingerprint".into());
        return run;
    };
    run.os = Some(id.os.clone());
    run.identified_by = Some(id.probe.clone());
    run.version_text = id.answer.clone();
    let catalog = catalogs.iter().find(|c| c.os == id.os).unwrap();
    let mut facts: Facts = initial_facts(catalog, &run.version_text, None);
    for probe in &catalog.caps_probe {
        for (_, p) in files_for(files, &probe.cmd) {
            let raw = read(&p);
            let flags_set = apply_probe(catalog, &probe.id, &raw, &mut facts);
            run.probes.push(ProbeResult { id: probe.id.clone(), cmd: probe.cmd.clone(), outcome: CommandOutcome { status: "ok".into(), raw, ..Default::default() }, flags_set });
        }
    }
    // VRFs from the file names of any {vrf}-shaped command.
    let mut vrfs: Vec<String> = Vec::new();
    for c in catalog.commands.iter().filter(|c| c.foreach.is_some()) {
        for (name, _) in files_for(files, &c.cmd) {
            if let Some(n) = name {
                vrfs.push(n);
            }
        }
    }
    vrfs.sort();
    vrfs.dedup();
    if !vrfs.is_empty() {
        facts.contexts.insert("vrf".into(), vrfs.clone());
        facts.caps.insert("vrf".into());
    }
    // Every command with a file is worth parsing whatever its gate said.
    for c in &catalog.commands {
        if !files_for(files, &c.cmd).is_empty() {
            for name in coreview_catalog::Gate::parse(&c.gate).map(|g| g.names()).unwrap_or_default() {
                if let Some(flag) = name.strip_prefix("cap.") {
                    facts.caps.insert(flag.to_string());
                }
            }
        }
    }
    let p = plan(catalog, &facts);
    run.plan = Some(p.clone());
    for step in &p.steps {
        let command = catalog.commands.iter().find(|c| c.id == step.id);
        let also: Vec<String> = command.map(|c| c.also.clone()).unwrap_or_default();
        let candidates: Vec<PathBuf> = files_for(files, &step.cmd).into_iter().map(|(_, p)| p).collect();
        let Some(path) = candidates.first() else { continue };
        let raw = read(path);
        let parser = coreview_collect::run::sidecar_parser(step, catalog, options);
        let outcome = match sidecar.parse(&catalog.os, &step.cmd, &parser, &also, &raw).await {
            Ok(r) => {
                let mut o: CommandOutcome = r.into();
                coreview_collect::run::settle(&mut o, step, catalog, &also, options);
                if step.parser == "raw" {
                    o.raw = coreview_collect::scrub::scrub(&o.raw);
                }
                o
            }
            Err(e) => CommandOutcome { status: "error".into(), error: Some(e.to_string()), ..Default::default() },
        };
        run.results.push(StepResult { step: step.clone(), outcome });
    }
    run.role = facts.role.clone();
    run.caps = facts.caps.iter().cloned().collect();
    run.log.push(format!("imported {} files", files.len()));
    run
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_split_on_lines_commas_and_spaces() {
        assert_eq!(split_targets("192.0.2.1, 192.0.2.2\n sw3 ;sw4"), vec!["192.0.2.1", "192.0.2.2", "sw3", "sw4"]);
        assert!(split_targets("  \n").is_empty());
    }

    #[test]
    fn capture_file_names_match_commands_with_and_without_a_prefix() {
        let files = vec![
            (slug("show ip arp"), PathBuf::from("a")),
            (slug("show ip route vrf CUST-A"), PathBuf::from("b")),
            (slug("show ip route vrf CUST-B"), PathBuf::from("c")),
            (slug("show ip route"), PathBuf::from("d")),
        ];
        assert_eq!(files_for(&files, "show ip arp").len(), 1);
        assert_eq!(files_for(&files, "show ip route").len(), 1);
        let vrf: Vec<String> = files_for(&files, "show ip route vrf {vrf}").into_iter().filter_map(|(n, _)| n).collect();
        assert_eq!(vrf, vec!["cust-a", "cust-b"]);
        let dir = std::env::temp_dir().join(format!("cv-captures-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("002-show-ip-arp.txt"), "x").unwrap();
        std::fs::write(dir.join("show version.txt"), "x").unwrap();
        std::fs::write(dir.join("notes.md"), "x").unwrap();
        let got: Vec<String> = capture_files(&dir).into_iter().map(|(s, _)| s).collect();
        assert_eq!(got, vec!["show-ip-arp", "show-version"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ------------------------------------------------------------------- diff

/// LT-542: two collection runs of one project compared — devices, links,
/// CDP/LLDP neighbours, routing neighbours, routes and overlays, with devices
/// matched by serial and MAC rather than by the address each run reached.
#[tauri::command(async)]
pub fn collection_diff(state: State<'_, AppState>, before: String, after: String) -> CmdResult<coreview_topology::diff::RunDiff> {
    let (bi, ai) = {
        let conn = state.db.lock().map_err(db_err)?;
        let bp = cdb::run_project(&conn, before.trim()).map_err(db_err)?.ok_or("The earlier run no longer exists.")?;
        let ap = cdb::run_project(&conn, after.trim()).map_err(db_err)?.ok_or("That run no longer exists.")?;
        if bp != ap {
            return Err("Those two runs belong to different projects.".into());
        }
        (cdb::topology_input(&conn, before.trim()).map_err(db_err)?, cdb::topology_input(&conn, after.trim()).map_err(db_err)?)
    };
    let (gb, ga) = (coreview_topology::build(&bi), coreview_topology::build(&ai));
    Ok(coreview_topology::diff::diff(coreview_topology::diff::Side { graph: &gb, devices: &bi }, coreview_topology::diff::Side { graph: &ga, devices: &ai }))
}

// ------------------------------------------------------------------- path

/// LT-531: what a trace request may carry. The builder is pure and bounded;
/// these limits keep one request from asking it for a runaway walk.
fn check_path_request(r: &coreview_path::Request) -> CmdResult<()> {
    let short = |s: &str, n: usize, what: &str| if s.len() > n { Err(format!("{what} is longer than {n} characters.")) } else { Ok(()) };
    if r.from.trim().is_empty() || r.to.trim().is_empty() {
        return Err("A trace needs where it starts and where it goes.".into());
    }
    short(&r.from, 255, "The source")?;
    short(&r.to, 255, "The destination")?;
    short(r.vrf.as_deref().unwrap_or(""), 64, "The VRF")?;
    short(r.protocol.as_deref().unwrap_or(""), 16, "The protocol")?;
    if r.down_devices.len() > 256 || r.down_links.len() > 256 {
        return Err("At most 256 devices and 256 links can be marked down.".into());
    }
    for d in &r.down_devices {
        short(d, 255, "A device marked down")?;
    }
    for l in &r.down_links {
        short(&l.device, 255, "A device marked down")?;
        short(&l.interface, 64, "An interface marked down")?;
    }
    if let Some(t) = &r.traceroute {
        if t.len() > 64 {
            return Err("A traceroute of more than 64 hops is not compared.".into());
        }
        for h in t.iter().flatten() {
            short(h, 64, "A traceroute hop")?;
        }
    }
    Ok(())
}

/// The model of one run: its devices, and the graph P2 builds from them.
fn path_model(state: &AppState, run_id: &str) -> CmdResult<coreview_path::Net> {
    let input = {
        let conn = state.db.lock().map_err(db_err)?;
        cdb::topology_input(&conn, run_id).map_err(db_err)?
    };
    if input.is_empty() {
        return Err("That collection run reached no device, so there is nothing to trace over.".into());
    }
    let graph = coreview_topology::build(&input);
    Ok(coreview_path::Net::build(&input, &graph))
}

/// LT-531–LT-534: the modeled path over a collection run — the way there,
/// the way back and how they differ, and the comparison with a traceroute
/// when the request carries one.
#[tauri::command(async)]
pub fn collection_path(state: State<'_, AppState>, run_id: String, request: coreview_path::Request) -> CmdResult<coreview_path::Outcome> {
    check_path_request(&request)?;
    let net = path_model(&state, run_id.trim())?;
    Ok(coreview_path::run(&net, &request))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PathLiveInput {
    pub run_id: String,
    pub request: coreview_path::Request,
    /// A saved login (D-059: must belong to the open project), else `credentials`.
    pub credential_id: Option<String>,
    pub port: u16,
    /// Which of the equal-cost paths to ask along; the first when absent.
    pub path: Option<usize>,
}

/// One device on the path, asked.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveHop {
    pub device: String,
    pub host: Option<String>,
    pub os: Option<String>,
    pub run: Option<coreview_collect::live::LiveRun>,
    pub check: coreview_path::compare::LiveCheck,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveReport {
    pub path: usize,
    pub hops: Vec<LiveHop>,
}

/// A MAC in the form the device's own commands take.
fn mac_for(os: &str, hex12: &str) -> String {
    let h = hex12.to_ascii_lowercase();
    if h.len() != 12 {
        return h;
    }
    if os.starts_with("cisco_") {
        format!("{}.{}.{}", &h[0..4], &h[4..8], &h[8..12])
    } else {
        (0..6).map(|i| &h[i * 2..i * 2 + 2]).collect::<Vec<_>>().join(":")
    }
}

/// The values a live command's placeholders are filled from, for one hop.
fn live_vars(hop: &coreview_path::walk::Hop, os: &str, request: &coreview_path::Request) -> std::collections::BTreeMap<String, String> {
    let mut v = std::collections::BTreeMap::new();
    let mut put = |k: &str, val: Option<String>| {
        if let Some(val) = val.filter(|x| !x.is_empty()) {
            v.insert(k.to_string(), val);
        }
    };
    put("dst", Some(hop.dst.clone()));
    put("src", Some(hop.src.clone()));
    put("vrf", Some(hop.vrf.clone()));
    put("vr", Some(hop.vrf.clone()));
    put("nh", hop.next_hop.clone());
    put("mac", hop.next_hop_mac.as_deref().map(|m| mac_for(os, m)));
    put("in_if", hop.in_interface.clone());
    put("zone", hop.firewall.as_ref().and_then(|f| f.zone_in.clone()));
    put("z1", hop.firewall.as_ref().and_then(|f| f.zone_in.clone()));
    put("z2", hop.firewall.as_ref().and_then(|f| f.zone_out.clone()));
    let proto = request.protocol.as_deref().map(|p| p.trim().to_ascii_lowercase());
    put("proto", proto.clone());
    put("p", proto.as_deref().and_then(coreview_path::firewall::proto_number).map(|n| n.to_string()));
    put("dport", request.port.map(|p| p.to_string()));
    put("dp", request.port.map(|p| p.to_string()));
    put("sport", request.source_port.map(|p| p.to_string()));
    put("sp", request.source_port.map(|p| p.to_string()));
    v
}

/// What the comparison reads from one answer: its rows as route rows.
fn evidence(a: &coreview_collect::live::LiveAnswer) -> coreview_path::compare::LiveEvidence {
    let rows = normalise_all(&["route".to_string()], &a.rows);
    let mut next_hops = Vec::new();
    let mut interfaces = Vec::new();
    for r in rows {
        if let Some(h) = r.columns.get("next_hop") {
            next_hops.extend(h.split([',', ' ']).map(str::trim).filter(|x| !x.is_empty()).map(str::to_string));
        }
        if let Some(i) = r.columns.get("interface") {
            interfaces.push(i.clone());
        }
    }
    coreview_path::compare::LiveEvidence { command: a.command.clone(), status: a.status.clone(), next_hops, interfaces, raw: a.raw.clone() }
}

/// LT-535: each collected device on a modeled path asked, with its
/// catalog's `live_path` commands, what it would do with this flow now.
/// One login per device, never cycled; the read-only guard in
/// `Sidecar::run` is the one every collection command passes.
#[tauri::command]
pub async fn collection_live(app: AppHandle, state: State<'_, AppState>, input: PathLiveInput, credentials: Option<CredentialInput>) -> CmdResult<LiveReport> {
    state.limiter.allow(crate::ratelimit::Job::LivePath)?;
    check_path_request(&input.request)?;
    let net = path_model(&state, input.run_id.trim())?;
    // LT-547: each device's VDOMs or contexts, as its collection found them.
    let contexts: std::collections::BTreeMap<String, (String, Vec<String>)> = {
        let conn = state.db.lock().map_err(db_err)?;
        cdb::list_devices(&conn, input.run_id.trim()).map_err(db_err)?.into_iter().filter_map(|d| d.context_kind.map(|k| (d.host, (k, d.contexts)))).collect()
    };
    let outcome = coreview_path::run(&net, &coreview_path::Request { traceroute: None, no_reverse: true, ..input.request.clone() });
    let which = input.path.unwrap_or(0);
    let path = outcome.forward.paths.get(which).ok_or("That path is not in the trace.")?.clone();
    let creds = match input.credential_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => {
            let c = crate::vault_commands::ssh_credentials(&state, id)?;
            crate::vault_commands::note_use(&state, id, "Live path check", &format!("{} to {}", input.request.from.trim(), input.request.to.trim()));
            c
        }
        None => credentials.filter(|c| !c.username.trim().is_empty()).map(Into::into).ok_or("A login is needed: pick a saved one or type one.")?,
    };
    let secrets = creds.secrets();
    let auth = Auth { username: creds.username.clone(), password: secrets.first().cloned().unwrap_or_default(), enable: secrets.get(1).cloned(), private_key: None };
    let catalogs = load_catalogs(&app)?;
    let location = sidecar_location(&app)?;
    let host_keys = crate::discovery::load_host_keys(&state)?;
    let options = RunOptions { engine: Some(rust_engine(&app)?), ..RunOptions::default() };
    // One job at a time with collections: both drive the one sidecar kind.
    let _ticket = state.jobs.start(crate::jobs::Kind::Collect)?;
    let mut sidecar = Sidecar::spawn(&location).await.map_err(|e| e.to_string())?;
    let mut hops: Vec<LiveHop> = Vec::new();
    for hop in &path.hops {
        if hops.iter().any(|h| h.device == hop.device) {
            continue;
        }
        let bx = net.find_box(&hop.device).map(|i| &net.boxes[i]);
        let host = bx.map(|b| b.host.clone()).filter(|h| !h.is_empty());
        let os = bx.and_then(|b| b.os.clone());
        let catalog = os.as_deref().and_then(|o| catalogs.iter().find(|c| c.os == o));
        let (Some(host_s), Some(os_s), Some(catalog)) = (host.clone(), os.clone(), catalog) else {
            hops.push(LiveHop { device: hop.device.clone(), host, os, run: None, check: coreview_path::compare::LiveCheck { agrees: None, detail: "Not asked: the collection did not record how to reach this device or which catalog it uses.".into() } });
            continue;
        };
        let known_host_key = host_keys.lock().ok().and_then(|k| k.known(&host_s, input.port));
        let target = Target { host: host_s.clone(), port: input.port, os_hint: Some(os_s.clone()), role_override: None, known_host_key };
        let mut vars = live_vars(hop, &os_s, &input.request);
        // A hop in a VDOM or context is asked inside it, where its table is the default one.
        let context = contexts.get(&host_s).filter(|(k, list)| (k == "vdom" || k == "context") && list.contains(&hop.vrf)).map(|(k, _)| (k.clone(), hop.vrf.clone()));
        if context.is_some() {
            vars.insert("vrf".into(), "default".into());
            vars.insert("vr".into(), "default".into());
        }
        let mut run = coreview_collect::live::ask(&mut sidecar, catalog, &target, &auth, &options, &vars, context).await;
        if let (true, Some(key)) = (run.host_key_first_seen, run.host_key.clone()) {
            if let Ok(mut k) = host_keys.lock() {
                k.remember(&host_s, input.port, &key);
            }
            crate::discovery::persist_host_keys(&app, &host_keys);
        }
        for a in &mut run.answers {
            // The login never appears in what is shown, whatever a device echoed.
            for s in &secrets {
                if !s.is_empty() {
                    a.raw = a.raw.replace(s.as_str(), "********");
                }
            }
        }
        let check = match &run.failure {
            Some(f) => coreview_path::compare::LiveCheck { agrees: None, detail: format!("Not asked: the session failed ({f}).") },
            None => coreview_path::compare::live_check(hop, &run.answers.iter().map(evidence).collect::<Vec<_>>()),
        };
        let sidecar_gone = run.failure.as_deref() == Some("sidecar");
        hops.push(LiveHop { device: hop.device.clone(), host: Some(host_s), os: Some(os_s), run: Some(run), check });
        if sidecar_gone {
            break;
        }
    }
    sidecar.quit().await;
    Ok(LiveReport { path: which, hops })
}

// --------------------------------------------------------------- topology

/// LT-527: what the Collect tab shows after building, and hands on to the
/// Discover panel's review.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyBuilt {
    /// The crawl run it was stored as — the newest run, so Path-Trace,
    /// Where-is, Tracert, the register and the change report read it too.
    pub crawl_run_id: String,
    pub devices: Vec<coreview_discover::crawl::CrawledDevice>,
    pub not_visited: Vec<coreview_discover::types::Neighbor>,
    pub graph: coreview_topology::Graph,
}

#[tauri::command(async)]
pub fn collection_topology(state: State<'_, AppState>, run_id: String, options: Option<coreview_topology::crawl_view::ViewOptions>) -> CmdResult<TopologyBuilt> {
    let options = options.unwrap_or_default();
    let conn = state.db.lock().map_err(db_err)?;
    let project = cdb::run_project(&conn, &run_id).map_err(db_err)?.ok_or("That collection run no longer exists.")?;
    let input = cdb::topology_input(&conn, &run_id).map_err(db_err)?;
    if input.is_empty() {
        return Err("That run reached no device, so there is nothing to draw.".into());
    }
    let graph = coreview_topology::build(&input);
    cdb::write_topology(&conn, &run_id, &graph).map_err(db_err)?;
    let view = coreview_topology::crawl_view::view_with(&graph, &options);
    // Stored exactly as a crawl stores a run: devices one by one, the rest as the summary.
    let crawl_run_id = format!("topo-{run_id}-{}", crate::db::now_ms());
    let seed = format!("collection {run_id}");
    crate::db::open_crawl_run(&conn, &crawl_run_id, &project, crate::db::now_ms(), &seed).map_err(db_err)?;
    for d in &view.devices {
        let json = serde_json::to_string(d).map_err(|e| e.to_string())?;
        crate::db::append_crawl_device(&conn, &crawl_run_id, &json).map_err(db_err)?;
    }
    let summary = serde_json::json!({
        "notVisited": view.not_visited,
        "failures": [],
        "cancelled": false,
        "firstSeenKeys": [],
        "collectionRunId": run_id,
        "findings": graph.findings,
    });
    crate::db::close_crawl_run(&conn, &crawl_run_id, "complete", &summary.to_string()).map_err(db_err)?;
    Ok(TopologyBuilt { crawl_run_id, devices: view.devices, not_visited: view.not_visited, graph })
}
