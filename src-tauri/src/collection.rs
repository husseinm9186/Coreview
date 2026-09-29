//! IPC for the catalog-driven collection (LT-514, LT-516, LT-517; D-060).
//!
//! The same rule as `discovery.rs`: **credentials arrive per run and are
//! never stored.** They go to the sidecar on its stdin, live for one run,
//! and come back nowhere. Raw replies are written only when the operator
//! ticked the diagnostic, redacted, under the run's own folder (D-055);
//! the database keeps rows, statuses and durations, never a reply.

use std::path::{Path, PathBuf};
use coreview_catalog::Catalog;
use coreview_collect::run::{collect_device, DeviceRun, RunEvent, RunOptions, RunSink, Target};
use coreview_collect::sidecar::{Auth, Sidecar, SidecarLocation};
use coreview_collect::tables::{normalise_all, rows_from_json, rows_from_xml};
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

fn load_catalogs(app: &AppHandle) -> CmdResult<Vec<Catalog>> {
    coreview_catalog::load_dir(&catalog_dir(app)?).map_err(|e| format!("The discovery catalogs could not be read: {e}"))
}

// --------------------------------------------------------------- persist

/// The rows a step's answer yields for the tables: TextFSM rows as they
/// are, a structured answer flattened first.
fn rows_of(parser: &str, outcome: &coreview_collect::run::CommandOutcome) -> Vec<Value> {
    match parser {
        "json" => outcome.rows.first().and_then(|r| r.get("json")).map(rows_from_json).unwrap_or_else(|| outcome.rows.clone()),
        "xml" => outcome.rows.first().and_then(|r| r.get("xml")).and_then(Value::as_str).and_then(|x| rows_from_xml(x).ok()).unwrap_or_else(|| outcome.rows.clone()),
        _ => outcome.rows.clone(),
    }
}

fn device_id_of(host: &str) -> String {
    format!("dev-{}", host.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>())
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
        std::fs::write(&path, coreview_discover::support::redact(raw, secrets)).ok()?;
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
        };
        cdb::write_log(&conn, run_id, &device_id, seq, &e).map_err(db_err)?;
    }
    let mut commands = 0;
    for r in &run.results {
        seq += 1;
        commands += 1;
        let raw_ref = keep(seq, &r.step.cmd, &r.outcome.raw);
        let rows = if r.outcome.status == "ok" { rows_of(&r.step.parser, &r.outcome) } else { Vec::new() };
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
        };
        cdb::write_log(&conn, run_id, &device_id, seq, &e).map_err(db_err)?;
        if !rows.is_empty() {
            for n in normalise_all(&r.step.feeds, &rows) {
                let mut n = n;
                if let Some((kind, name)) = &r.step.context {
                    if kind == "vrf" && !n.columns.contains_key("vrf") && (n.table == "route" || n.table == "arp" || n.table == "routing_neighbor" || n.table == "ip_address") {
                        n.columns.insert("vrf".into(), name.clone());
                    }
                }
                if n.table == "neighbor" && !n.columns.contains_key("proto") {
                    let proto = if r.step.cmd.contains("cdp") { "cdp" } else if r.step.cmd.contains("lldp") { "lldp" } else { "api" };
                    n.columns.insert("proto".into(), proto.into());
                }
                if (n.table == "routing_neighbor" || n.table == "fhrp") && !n.columns.contains_key("proto") {
                    for p in ["ospf", "eigrp", "bgp", "isis", "rip", "standby", "hsrp", "vrrp", "glbp", "ldp"] {
                        if r.step.cmd.contains(p) {
                            n.columns.insert("proto".into(), if p == "standby" { "hsrp".into() } else { p.into() });
                            break;
                        }
                    }
                }
                cdb::write_row(&conn, run_id, &device_id, &r.step.id, &n).map_err(db_err)?;
            }
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
    let secrets = creds.secrets();
    let auth = Auth { username: creds.username.clone(), password: secrets.first().cloned().unwrap_or_default(), enable: secrets.get(1).cloned(), private_key: None };
    let catalogs = load_catalogs(&app)?;
    let location = sidecar_location(&app)?;
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
        let mut sidecar = match Sidecar::spawn(&location).await {
            Ok(s) => s,
            Err(e) => {
                if let Ok(conn) = state_arc.db.lock() {
                    let _ = cdb::finish_run(&conn, &run_id2, "failed");
                }
                let _ = app2.emit("coreview://collection", &CollectionEvent::Failed { run_id: run_id2.clone(), error: e.to_string() });
                return;
            }
        };
        let mut devices = 0usize;
        let mut failed = 0usize;
        let total = targets.len() as u64;
        let mut cancelled = false;
        for (i, host) in targets.iter().enumerate() {
            if token.is_cancelled() {
                cancelled = true;
                break;
            }
            progress.set(format!("Collecting {host}"), i as u64, Some(total));
            let device_id = device_id_of(host);
            let _ = app2.emit("coreview://collection", &CollectionEvent::Device { run_id: run_id2.clone(), device_id: device_id.clone(), host: host.clone(), phase: "connecting".into() });
            let sink = Emit { app: app2.clone(), run_id: run_id2.clone(), device_id: device_id.clone() };
            let target = Target { host: host.clone(), port, os_hint: os_hint.clone(), role_override: role_override.clone() };
            let run = collect_device(&mut sidecar, &catalogs, &target, &auth, &options, &sink).await;
            let commands = persist_device(&state_arc, &run_id2, &run, diagnostic.as_deref(), &secrets).unwrap_or(0);
            devices += 1;
            if run.failure.is_some() {
                failed += 1;
            }
            let _ = app2.emit("coreview://collection", &CollectionEvent::DeviceDone { run_id: run_id2.clone(), device_id, host: host.clone(), os: run.os.clone(), failure: run.failure.clone(), commands });
            if matches!(run.failure.as_deref(), Some("sidecar")) {
                // The sidecar is gone; nothing more can be collected this run.
                break;
            }
        }
        sidecar.quit().await;
        if let Ok(conn) = state_arc.db.lock() {
            let _ = cdb::finish_run(&conn, &run_id2, if cancelled { "cancelled" } else { "finished" });
        }
        progress.set("Finished", total, Some(total));
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
    let mut sidecar = Sidecar::spawn(&location).await.map_err(|e| e.to_string())?;
    let mut hosts: Vec<PathBuf> = std::fs::read_dir(&root).map_err(|e| e.to_string())?.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.is_dir()).collect();
    hosts.sort();
    let mut imported = 0usize;
    for host_dir in hosts {
        let host = host_dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let files = capture_files(&host_dir);
        let run = import_one(&mut sidecar, &catalogs, &host, &files).await;
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

async fn import_one(sidecar: &mut Sidecar, catalogs: &[Catalog], host: &str, files: &[(String, PathBuf)]) -> DeviceRun {
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
        let parser = if step.parser == "raw" { "none".to_string() } else { step.parser.clone() };
        let outcome = match sidecar.parse(&catalog.os, &step.cmd, &parser, &also, &raw).await {
            Ok(r) => {
                let mut o: CommandOutcome = r.into();
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
