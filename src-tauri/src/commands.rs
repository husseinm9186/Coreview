//! The complete IPC surface. Every command is narrow and typed; there is no
//! generic exec, no shell plugin, and no path passed through from JavaScript
//! except through the dialog plugin's user-chosen file handles.

use std::sync::{Arc, Mutex};

use coreview_probe::engine::{run_once, EngineEvent, SessionState};
use coreview_probe::sweep::{parse_sweepable_cidr, sweep_many, SweepEvent, SweepOptions, MAX_SWEEP_HOSTS};
use coreview_probe::{run_traceroute, Engine, ProbeConfig, ProbeResult, ProbeSnapshot, TracerouteResult};
use base64::Engine as _;
use rusqlite::Connection;
use tokio_util::sync::CancellationToken;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::db::{self, EventRow, ProjectMeta, ProjectPackage};

pub struct AppState {
    pub engine: Arc<Engine>,
    pub db: Mutex<Connection>,
    pub session_id: Mutex<Option<String>>,
    pub project_id: Mutex<Option<String>>,
    /// Cancels the sweep that is currently running, if any. A sweep is a
    /// one-shot job rather than a session, so it needs its own handle — the
    /// validation engine's Stop must not cancel a discovery scan, and vice
    /// versa.
    pub sweep_cancel: Mutex<Option<CancellationToken>>,
    /// Cancels the running crawl. Separate from the sweep and the backup: they
    /// are three different jobs and stopping one must not stop the others.
    pub crawl_cancel: Mutex<Option<CancellationToken>>,
    pub backup_cancel: Mutex<Option<CancellationToken>>,
    /// The unlocked vault key, for as long as the app is running. Never
    /// written anywhere, and zeroed when it is dropped.
    pub vault_key: Mutex<Option<coreview_discover::vault::VaultKey>>,
    /// LT-260: how often each kind of network job may start.
    pub limiter: crate::ratelimit::RateLimiter,
}

type CmdResult<T> = Result<T, String>;

fn db_err(e: impl std::fmt::Display) -> String {
    format!("Local database error: {e}")
}

// ---------------------------------------------------------------- projects

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> CmdResult<Vec<ProjectMeta>> {
    let conn = state.db.lock().map_err(db_err)?;
    db::list_projects(&conn).map_err(db_err)
}

#[tauri::command]
pub fn save_project(state: State<'_, AppState>, package: ProjectPackage) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    db::upsert_project(&conn, &package).map_err(db_err)
}

#[tauri::command]
pub fn load_project(state: State<'_, AppState>, id: String) -> CmdResult<Option<ProjectPackage>> {
    let conn = state.db.lock().map_err(db_err)?;
    db::load_project(&conn, &id).map_err(db_err)
}

#[tauri::command]
pub fn delete_project(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    db::delete_project(&conn, &id).map_err(db_err)
}

#[tauri::command]
pub fn set_project_archived(
    state: State<'_, AppState>,
    id: String,
    archived: bool,
) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    db::set_archived(&conn, &id, archived).map_err(db_err)
}

// ------------------------------------------------------------------ probes

/// One-off test. Runs exactly once and registers no schedule, so `Test Now`
/// can never leave background monitoring behind (test case 12).
#[tauri::command]
pub async fn test_probe_now(state: State<'_, AppState>, config: ProbeConfig) -> CmdResult<ProbeResult> {
    state.limiter.allow(crate::ratelimit::Job::ProbeTest)?;
    Ok(run_once(&config).await)
}

/// Validate a target without probing it — used for live inspector feedback.
#[tauri::command]
pub fn validate_target(target: String) -> CmdResult<String> {
    coreview_probe::parse_target(&target)
        .map(|t| t.as_str())
        .map_err(|e| e.to_string())
}

/// On-demand diagnostic (LT-090): the current path to a target, once — not a
/// scheduled probe, and nothing is written to the event log. Useful mid-drill
/// when something is not reaching the backup site and the question is where
/// it is actually going, not whether it is up.
#[tauri::command]
pub async fn traceroute_now(state: State<'_, AppState>, target: String) -> CmdResult<TracerouteResult> {
    state.limiter.allow(crate::ratelimit::Job::Traceroute)?;
    run_traceroute(&target, 30_000).await
}

/// Open a hyperlink on a device or note (LT-095) in the OS's own browser.
/// There is no shell/HTTP plugin in this app by design (see
/// `capabilities/default.json`), so this is the one narrow, explicit door:
/// http(s) only, checked here rather than trusted from the frontend, since a
/// link can arrive inside an imported or shared project file.
#[tauri::command]
pub fn open_external_url(url: String) -> CmdResult<()> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http:// and https:// links can be opened".into());
    }
    open::that(url).map_err(|e| e.to_string())
}

/// LT-234: the kinds of file a device attachment may open as. Documents,
/// pictures, drawings and text — never anything the system would run, because
/// a path can arrive inside an imported project file.
const ATTACHMENT_KINDS: &[&str] = &[
    "pdf", "txt", "log", "cfg", "conf", "md", "csv", "json", "xml", "yaml", "yml", "png", "jpg", "jpeg", "gif", "svg",
    "webp", "bmp", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "vsd", "vsdx", "drawio", "pcap",
    "pcapng", "rtf", "zip",
];

/// Whether a path may be opened as a device attachment: absolute, an existing
/// file, of a document kind. Returns why not.
pub fn attachment_problem(path: &std::path::Path) -> Option<String> {
    if !path.is_absolute() {
        return Some("An attachment needs a full path.".into());
    }
    if !path.is_file() {
        return Some(format!("{} is not there any more.", path.display()));
    }
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !ATTACHMENT_KINDS.contains(&ext.as_str()) {
        return Some(format!("A .{ext} file is not opened from here; use Show in folder."));
    }
    None
}

/// LT-234: opens a device attachment, or shows the folder it is in. Showing
/// the folder never opens the file itself.
#[tauri::command]
pub fn open_attachment(path: String, reveal: bool) -> CmdResult<()> {
    let p = std::path::PathBuf::from(path.trim());
    if reveal {
        if !p.is_absolute() || !p.exists() {
            return Err(format!("{} is not there any more.", p.display()));
        }
        let folder = if p.is_dir() { p.clone() } else { p.parent().map(|x| x.to_path_buf()).ok_or("That file has no folder.")? };
        return open::that(folder).map_err(|e| e.to_string());
    }
    if let Some(why) = attachment_problem(&p) {
        return Err(why);
    }
    open::that(p).map_err(|e| e.to_string())
}

// ------------------------------------------------------------- validation

#[derive(Serialize, Clone)]
pub struct SessionInfo {
    pub session_id: Option<String>,
    pub project_id: Option<String>,
    pub state: SessionState,
    pub probe_count: usize,
}

#[tauri::command]
pub async fn start_validation(
    state: State<'_, AppState>,
    project_id: String,
    operator: String,
    probes: Vec<ProbeConfig>,
) -> CmdResult<SessionInfo> {
    state.limiter.allow(crate::ratelimit::Job::Validation)?;
    // Switching projects always stops the prior session first.
    stop_internal(&state).await?;

    let session_id = Uuid::new_v4().to_string();
    {
        let conn = state.db.lock().map_err(db_err)?;
        db::open_session(&conn, &session_id, &project_id, &operator).map_err(db_err)?;
    }

    let count = state
        .engine
        .start(session_id.clone(), project_id.clone(), probes)
        .await?;

    *state.session_id.lock().map_err(db_err)? = Some(session_id.clone());
    *state.project_id.lock().map_err(db_err)? = Some(project_id.clone());

    Ok(SessionInfo {
        session_id: Some(session_id),
        project_id: Some(project_id),
        state: SessionState::Running,
        probe_count: count,
    })
}

/// Bring a running session's targets in line with the document (LT-062).
/// Adding a check while validation runs starts probing it within one
/// interval; deleting one stops its probe; nothing restarts. With no session
/// running this quietly does nothing — the next start carries the change.
#[tauri::command]
pub async fn update_validation(
    state: State<'_, AppState>,
    probes: Vec<ProbeConfig>,
) -> CmdResult<SessionInfo> {
    let sid = state.session_id.lock().map_err(db_err)?.clone();
    let pid = state.project_id.lock().map_err(db_err)?.clone();
    let (Some(sid), Some(pid)) = (sid, pid) else {
        return Ok(SessionInfo {
            session_id: None,
            project_id: None,
            state: SessionState::Stopped,
            probe_count: 0,
        });
    };
    let count = state.engine.update(probes).await?;
    Ok(SessionInfo {
        session_id: Some(sid),
        project_id: Some(pid),
        state: SessionState::Running,
        probe_count: count,
    })
}

#[tauri::command]
pub async fn stop_validation(state: State<'_, AppState>) -> CmdResult<SessionInfo> {
    stop_internal(&state).await?;
    Ok(SessionInfo {
        session_id: None,
        project_id: None,
        state: SessionState::Stopped,
        probe_count: 0,
    })
}

async fn stop_internal(state: &State<'_, AppState>) -> CmdResult<()> {
    state.engine.stop().await;
    let sid = state.session_id.lock().map_err(db_err)?.take();
    *state.project_id.lock().map_err(db_err)? = None;
    if let Some(sid) = sid {
        let conn = state.db.lock().map_err(db_err)?;
        db::close_session(&conn, &sid).map_err(db_err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn session_status(state: State<'_, AppState>) -> CmdResult<SessionInfo> {
    let engine_state = state.engine.session_state().await;
    let snapshot = state.engine.snapshot().await;
    let project_id = state.engine.active_project().await;
    // Every await happens above. A std::sync::MutexGuard is !Send, so taking
    // this lock inside the struct literal below would hold it across the
    // `active_project().await` and make the whole future !Send, which Tauri
    // rejects. Bind it after the last await instead.
    let session_id = state.session_id.lock().map_err(db_err)?.clone();
    Ok(SessionInfo {
        session_id,
        project_id,
        state: engine_state,
        probe_count: snapshot.len(),
    })
}

#[tauri::command]
pub async fn probe_snapshot(state: State<'_, AppState>) -> CmdResult<Vec<ProbeSnapshot>> {
    Ok(state.engine.snapshot().await)
}

// ------------------------------------------------------------------ events

#[tauri::command]
pub fn list_events(
    state: State<'_, AppState>,
    project_id: String,
    limit: Option<i64>,
) -> CmdResult<Vec<EventRow>> {
    let conn = state.db.lock().map_err(db_err)?;
    db::list_events(&conn, &project_id, limit.unwrap_or(2000)).map_err(db_err)
}

/// The frontend records the object *name* alongside the transition, because the
/// engine only knows ids.
#[tauri::command]
pub fn record_event(state: State<'_, AppState>, event: EventRow) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    db::insert_event(&conn, &event).map_err(db_err)
}

#[tauri::command]
pub fn app_info() -> CmdResult<serde_json::Value> {
    Ok(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "dataDir": db::data_dir().to_string_lossy(),
        "schemaVersion": db::SCHEMA_VERSION,
        "documentVersion": db::DOCUMENT_VERSION,
    }))
}

/// Forward engine events to the webview. Runs for the life of the process.
pub fn pump_events(app: AppHandle, mut rx: tokio::sync::mpsc::UnboundedReceiver<EngineEvent>) {
    tauri::async_runtime::spawn(async move {
        let mut since_prune = 0usize;
        while let Some(event) = rx.recv().await {
            // LT-224: every result is kept for the history sparklines. The
            // table existed; nothing wrote to it.
            if let EngineEvent::Sample { session_id, result, status } = &event {
                use tauri::Manager;
                let state = app.state::<AppState>();
                let guard = state.db.lock();
                if let Ok(conn) = guard {
                    let status = serde_json::to_value(status).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
                    let outcome = serde_json::to_value(result.outcome).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
                    let _ = db::insert_sample(&conn, &db::NewSample { session_id, probe_id: &result.probe_id, timestamp_ms: result.timestamp_ms, status: &status, outcome: &outcome, rtt_ms: result.rtt_ms, summary: &result.summary });
                    since_prune += 1;
                    if since_prune >= 5_000 {
                        since_prune = 0;
                        let _ = db::prune_samples(&conn, &result.probe_id);
                    }
                }
            }
            let _ = app.emit("coreview://engine", &event);
        }
    });
}

/// LT-226: a project's validation sessions, newest first.
#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>, project_id: String) -> CmdResult<Vec<db::SessionRow>> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_sessions(&conn, &project_id).map_err(|e| e.to_string())
}

/// LT-226: what each probe did in one session.
#[tauri::command]
pub fn session_summary(state: State<'_, AppState>, session_id: String) -> CmdResult<Vec<db::ProbeSummary>> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::session_summary(&conn, &session_id).map_err(|e| e.to_string())
}

/// LT-227: keeps a crawl's result so it can be compared with another. The
/// result is what the crawl already returned to the interface; it holds no
/// secret. Capped at 64 MB, so a runaway payload cannot fill the disk.
#[tauri::command]
pub fn save_crawl_run(state: State<'_, AppState>, project_id: String, seed: String, result: serde_json::Value) -> CmdResult<String> {
    let text = result.to_string();
    if text.len() > 64 * 1024 * 1024 {
        return Err("That crawl result is too large to keep.".into());
    }
    let devices = result.get("devices").and_then(|d| d.as_array()).map(|a| a.len() as i64).unwrap_or(0);
    let id = format!("crawl-{}", db::now_ms());
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::insert_crawl_run(&conn, &id, &project_id, db::now_ms(), &seed, devices, &text).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn list_crawl_runs(state: State<'_, AppState>, project_id: String) -> CmdResult<Vec<db::CrawlRunRow>> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_crawl_runs(&conn, &project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn crawl_run_result(state: State<'_, AppState>, id: String) -> CmdResult<serde_json::Value> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let text = db::crawl_run_result(&conn, &id).map_err(|e| e.to_string())?.ok_or("That crawl is no longer kept.")?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// LT-224: a probe's recorded results since `since_ms`, oldest first.
#[tauri::command]
pub fn probe_history(state: State<'_, AppState>, probe_id: String, since_ms: i64, limit: Option<i64>) -> CmdResult<Vec<db::SampleRow>> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::samples_for(&conn, &probe_id, since_ms, limit.unwrap_or(2_000).clamp(1, 20_000)).map_err(|e| e.to_string())
}

// ------------------------------------------------------------------- icons

/// Index a user-chosen folder of SVGs as an icon library.
///
/// The artwork stays on disk in the operator's own directory; nothing is
/// bundled or committed. Returns sanitised SVG source plus the list of files
/// that were skipped and why, so the palette can say what it could not read
/// rather than quietly showing fewer icons.
#[tauri::command]
pub fn list_icon_library(dir: String) -> CmdResult<crate::icons::IconLibrary> {
    crate::icons::scan(&dir)
}

/// The diagram as a PDF (LT-077). The frontend renders the drawing to SVG —
/// one function, the same one the screen and the SVG export use — and this
/// turns it into a vector PDF the operator can attach to a change record.
#[tauri::command]
pub fn diagram_pdf(svg: String) -> CmdResult<Vec<u8>> {
    crate::pdf::svg_to_pdf(&svg)
}

/// LT-251: every page asked for, as one PDF.
#[tauri::command]
pub fn diagram_pdf_pages(svgs: Vec<String>) -> CmdResult<Vec<u8>> {
    crate::pdf::svgs_to_pdf(&svgs)
}

/// The diagram as a Visio drawing (LT-078). Shapes and connectors, not a
/// picture: a colleague without Coreview can open it and move things.
#[tauri::command]
pub fn diagram_vsdx(drawing: crate::visio::VisioDrawing) -> CmdResult<Vec<u8>> {
    crate::visio::to_vsdx(&drawing)
}

/// Where the bundled stencils live. In dev that is the repo's `stencils/`.
fn stencil_dir(app: &AppHandle) -> CmdResult<String> {
    use tauri::path::BaseDirectory;
    use tauri::Manager;
    let dir = app
        .path()
        .resolve("stencils", BaseDirectory::Resource)
        .map_err(|e| format!("no bundled stencils: {e}"))?;
    dir.to_str()
        .map(str::to_string)
        .ok_or_else(|| "resource path is not unicode".to_string())
}

/// The setting holding the packs the operator has removed.
const REMOVED_PACKS: &str = "removedStencilPacks";

/// Which packs to behave as though are not installed.
///
/// Kept in settings rather than inferred from the disk, because removing a
/// pack has to work on an install whose files cannot be deleted. A read-only
/// install is the normal case, not an exotic one.
fn removed_packs(state: &State<'_, AppState>) -> Vec<String> {
    let Ok(db) = state.db.lock() else { return Vec::new() };
    let Ok(settings) = crate::db::all_settings(&db) else { return Vec::new() };
    settings
        .get(REMOVED_PACKS)
        .and_then(|v| serde_json::from_str::<Vec<String>>(v).ok())
        .unwrap_or_default()
}

/// The stencils bundled as a Tauri resource, indexed with the same scan as a
/// user's own folder, minus any pack the operator has removed. Ships empty:
/// vendor packs are no longer bundled (D-028, superseding D-022), and a test
/// keeps it that way.
#[tauri::command]
pub fn list_bundled_icons(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<crate::icons::IconLibrary> {
    crate::icons::scan_excluding(&stencil_dir(&app)?, &removed_packs(&state))
}

/// The bundled stencil packs (LT-103) — none ship since D-028 — each an
/// immediate subdirectory of the same resource
/// `list_bundled_icons` scans.
#[tauri::command]
pub fn list_stencil_packs(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<Vec<crate::icons::StencilPack>> {
    crate::icons::list_packs_excluding(&stencil_dir(&app)?, &removed_packs(&state))
}

/// Removes one bundled stencil pack (LT-103, fixed in LT-116).
///
/// Two things happen, and only one of them can fail. The pack is recorded as
/// removed, which is what makes its shapes disappear and is the part the
/// operator actually asked for; then its files are deleted to free the space,
/// which cannot happen on a read-only install. The result says which, so the
/// interface can stop claiming space was freed when it was not.
#[tauri::command]
pub fn remove_stencil_pack(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> CmdResult<crate::icons::PackRemoval> {
    let mut removed = removed_packs(&state);
    // Asked for again — the files were already deleted, or never could be.
    // Nothing to do on disk, and not an error: it is gone either way.
    let outcome = if removed.iter().any(|p| p == &name) {
        crate::icons::PackRemoval { deleted: false, reason: None }
    } else {
        let outcome = crate::icons::remove_pack(&stencil_dir(&app)?, &name)?;
        removed.push(name);
        outcome
    };
    let json = serde_json::to_string(&removed).map_err(|e| e.to_string())?;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    crate::db::set_setting(&db, REMOVED_PACKS, Some(&json)).map_err(|e| e.to_string())?;
    Ok(outcome)
}

// ------------------------------------------------------------------ exports

/// Writes an export to the path the user picked in the save dialog.
///
/// This is the only way anything in the webview can write to disk: there is no
/// filesystem plugin, so the frontend cannot name a path on its own — it can
/// only pass back one the user chose in a native dialog.
///
/// Bytes arrive base64-encoded because one of the five exports (PNG) is binary
/// and the other four are text. Encoding them all the same way keeps this to a
/// single command rather than a text one and a binary one.
#[tauri::command]
pub fn save_export(path: String, contents_b64: String) -> CmdResult<()> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents_b64.as_bytes())
        .map_err(|e| format!("Export could not be encoded: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("Could not write {path}: {e}"))
}

/// Reads a project package the user picked in the open dialog.
///
/// The counterpart to `save_export`, and the only way the webview can read a
/// file: it cannot name a path on its own, only pass back one chosen in a
/// native dialog.
///
/// Import used an `<input type="file">` instead, which is how it came to be
/// unusable on Linux — WebKitGTK turns the `accept` list into a filter that
/// matches nothing when the extension has no registered MIME type, so the
/// dialog showed an empty folder and Open stayed greyed out.
/// Reads a Visio drawing as a topology (LT-110).
///
/// A `.vsdx` is far larger than a Coreview project — the sample drawings run
/// to several MB of embedded artwork — so this gets its own, bigger limit
/// rather than borrowing the one below, which exists to reject a file that is
/// obviously not a project.
/// LT-244: a draw.io drawing, read into the same preview a Visio one gets.
#[tauri::command]
pub fn import_drawio(path: String) -> CmdResult<crate::visio_import::VisioImport> {
    const MAX: u64 = 64 * 1024 * 1024;
    let size = std::fs::metadata(&path).map_err(|e| format!("Could not read {path}: {e}"))?.len();
    if size > MAX {
        return Err(format!("{path} is {} MB, which is larger than any drawing this can read.", size / (1024 * 1024)));
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    crate::drawio_import::import_drawio(&text)
}

#[tauri::command]
pub fn import_visio(path: String) -> CmdResult<crate::visio_import::VisioImport> {
    const MAX: u64 = 128 * 1024 * 1024;
    let size = std::fs::metadata(&path)
        .map_err(|e| format!("Could not read {path}: {e}"))?
        .len();
    if size > MAX {
        return Err(format!(
            "{path} is {} MB, which is larger than any drawing this can read.",
            size / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    crate::visio_import::import_vsdx(&bytes)
}

/// LT-258: where the isolation frame sends a message it refused. Nothing the
/// page asked for runs; the call fails with why.
#[tauri::command]
pub fn ipc_refused(command: String, reason: String) -> CmdResult<()> {
    eprintln!("coreview: refused a call to {command}: {reason}");
    Err(format!("{command} was refused before it reached Coreview: {reason}."))
}

/// LT-255: a project as a folder — `project.coreview` and `project.yaml` —
/// inside `folder/name`, for version control. The name becomes one folder, so
/// anything that would climb out of the chosen folder is refused. Each file is
/// written beside itself and renamed into place, so a crash never leaves half
/// a project in a repository. Returns the folder written.
pub fn write_project_folder(folder: &str, name: &str, json: &str, yaml: &str) -> CmdResult<String> {
    let base = std::path::Path::new(folder);
    if !base.is_absolute() || !base.is_dir() {
        return Err(format!("{folder} is not a folder that exists."));
    }
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        return Err("The project folder needs a plain name.".into());
    }
    let dir = base.join(name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    for (file, body) in [("project.coreview", json), ("project.yaml", yaml)] {
        let target = dir.join(file);
        let tmp = dir.join(format!(".{file}.part"));
        std::fs::write(&tmp, body).map_err(|e| format!("Could not write {}: {e}", target.display()))?;
        std::fs::rename(&tmp, &target).map_err(|e| format!("Could not write {}: {e}", target.display()))?;
    }
    Ok(dir.display().to_string())
}

#[tauri::command]
pub fn save_project_folder(folder: String, name: String, json: String, yaml: String) -> CmdResult<String> {
    write_project_folder(&folder, &name, &json, &yaml)
}

/// LT-245: every sheet of an Excel workbook the user chose, as rows of text.
#[tauri::command]
pub fn read_spreadsheet(path: String) -> CmdResult<Vec<crate::spreadsheet::Sheet>> {
    const MAX: u64 = 64 * 1024 * 1024;
    let size = std::fs::metadata(&path).map_err(|e| format!("Could not read {path}: {e}"))?.len();
    if size > MAX {
        return Err(format!("{path} is {} MB, which is more than an inventory workbook should be.", size / (1024 * 1024)));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    crate::spreadsheet::read_xlsx(&bytes)
}

#[tauri::command]
pub fn read_import(path: String) -> CmdResult<String> {
    const MAX: u64 = 64 * 1024 * 1024;
    let size = std::fs::metadata(&path)
        .map_err(|e| format!("Could not read {path}: {e}"))?
        .len();
    if size > MAX {
        return Err(format!(
            "{path} is {} MB. A Coreview project is not that large, so this is not one.",
            size / (1024 * 1024)
        ));
    }
    std::fs::read_to_string(&path)
        .map_err(|e| format!("Could not read {path}: {e}"))
}

#[cfg(test)]
mod export_tests {

    /// LT-255: a project folder is written whole, and a name cannot climb out.
    #[test]
    fn a_project_folder_is_written_inside_the_chosen_folder_only() {
        let base = std::env::temp_dir().join(format!("cv-folder-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let dir = super::write_project_folder(base.to_str().unwrap(), "lab-network", "{}\n", "a: 1\n").unwrap();
        assert_eq!(std::fs::read_to_string(std::path::Path::new(&dir).join("project.coreview")).unwrap(), "{}\n");
        assert_eq!(std::fs::read_to_string(std::path::Path::new(&dir).join("project.yaml")).unwrap(), "a: 1\n");
        assert!(!std::path::Path::new(&dir).join(".project.yaml.part").exists());
        for bad in ["..", "../escape", "a/b", "", "."] {
            assert!(super::write_project_folder(base.to_str().unwrap(), bad, "{}", "").is_err(), "{bad:?}");
        }
        assert!(super::write_project_folder("relative/path", "x", "{}", "").is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// LT-234: only existing documents open; anything runnable, relative or
    /// missing is refused.
    #[test]
    fn attachments_open_only_documents_that_exist() {
        let dir = std::env::temp_dir().join(format!("cv-attach-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let doc = dir.join("rack-photo.PNG");
        let script = dir.join("setup.sh");
        std::fs::write(&doc, b"x").unwrap();
        std::fs::write(&script, b"x").unwrap();
        assert_eq!(super::attachment_problem(&doc), None);
        assert!(super::attachment_problem(&script).unwrap().contains(".sh file is not opened"));
        assert!(super::attachment_problem(std::path::Path::new("relative.pdf")).unwrap().contains("full path"));
        assert!(super::attachment_problem(&dir.join("gone.pdf")).unwrap().contains("not there"));
        assert!(super::attachment_problem(&dir.join("folder.pdf")).is_some());
        std::fs::remove_dir_all(&dir).ok();
    }
    use super::*;

    #[test]
    fn writes_decoded_bytes_to_the_given_path() {
        let dir = std::env::temp_dir().join(format!("coreview-export-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("diagram.png");
        // PNG magic, so this also covers the binary case rather than only text.
        let png = [0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);

        save_export(path.to_string_lossy().into_owned(), b64).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), png);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_a_payload_that_is_not_base64() {
        let path = std::env::temp_dir().join("coreview-should-not-appear");
        std::fs::remove_file(&path).ok();

        let err = save_export(path.to_string_lossy().into_owned(), "not base64!!".into())
            .unwrap_err();

        assert!(err.contains("could not be encoded"), "unexpected error: {err}");
        // Fail closed: a bad payload must not leave a truncated or empty file.
        assert!(!path.exists());
    }

    #[test]
    fn reports_the_path_when_the_directory_does_not_exist() {
        let path = std::env::temp_dir().join("coreview-no-such-dir").join("x.svg");
        let err = save_export(path.to_string_lossy().into_owned(), String::new()).unwrap_err();
        assert!(err.contains("Could not write"), "unexpected error: {err}");
    }
}

#[cfg(test)]
mod link_tests {
    use super::*;

    // Not a live-open assertion — nothing here can assume a browser is
    // installed on CI. This tests the actual security boundary: a link on a
    // device or note can arrive inside an imported or shared project file,
    // and must never be trusted to name anything but a web page.
    #[test]
    fn rejects_a_file_url() {
        let err = open_external_url("file:///etc/passwd".into()).unwrap_err();
        assert!(err.contains("http"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_a_javascript_url() {
        let err = open_external_url("javascript:alert(1)".into()).unwrap_err();
        assert!(err.contains("http"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_a_bare_string_with_no_scheme() {
        let err = open_external_url("not-a-url".into()).unwrap_err();
        assert!(err.contains("http"), "unexpected error: {err}");
    }
}

// ----------------------------------------------------------------- settings

/// Every stored preference, read once on startup.
///
/// These are the folders the user has chosen — backups, exports, icon library
/// — and nothing else. No secret is stored here: the table is unencrypted and
/// sits in the same database as the projects.
#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CmdResult<std::collections::HashMap<String, String>> {
    let conn = state.db.lock().map_err(db_err)?;
    db::all_settings(&conn).map_err(db_err)
}

/// Stores a preference, or clears it when `value` is absent or empty.
#[tauri::command]
pub fn set_setting(
    state: State<'_, AppState>,
    key: String,
    value: Option<String>,
) -> CmdResult<()> {
    // A fixed key list rather than an open map: this table is read on startup
    // and fed straight into the UI, and an unbounded key space invites it
    // becoming a dumping ground for things that belong in a typed column.
    //
    // The `scan*` keys are LT-135 — what a discovery run was set up with, so
    // it can be repeated without retyping. **Not one of them is a secret.**
    // Passwords, enable secrets, community strings and v3 passphrases live in
    // the encrypted vault and are referenced from here only by the id of the
    // credential that holds them (`scanCredentialId`, `scanSnmpCredentialId`).
    // This table is plain text in the same database as the projects, and the
    // operator asked in as many words that nothing he types is ever written
    // where it could leave the machine.
    const ALLOWED: [&str; 16] = [
        "backupFolder",
        "exportFolder",
        "iconLibraryDir",
        "addressPreference",
        "scanSeed",
        "scanSubnets",
        "scanPort",
        "scanMaxHops",
        "scanCredentialId",
        // LT-142: several SNMP credentials, so their *shape* is one JSON
        // string rather than four keys. Version, v3 user name and the two
        // algorithm choices only — communities and passphrases are secrets
        // and stay in the vault, referenced here by credential id.
        "scanSnmpRows",
        // LT-149: the Backups tab's global show commands and paging choice.
        // The operator's own list, kept on his machine — never a secret, and
        // never shipped as a default (D-027).
        "backupShowCommands",
        "backupPaging",
        // LT-150: named command sets applied by role or tag, as one JSON
        // string. Commands and the words they match on — no secrets, and no
        // set ships built in (D-027).
        "backupCommandSets",
        // LT-151: the capture filename pattern, tokens and literal text only.
        "backupFilePattern",
        // LT-153: checks against captured output, as one JSON string — a
        // command, an expectation and a pattern each. No secrets; none ship
        // built in (D-027).
        "backupChecks",
        // LT-154: ordered collection groups — names and the roles and tags
        // they match. No secrets; none ship built in (D-027).
        "backupGroups",
    ];
    if !ALLOWED.contains(&key.as_str()) {
        return Err(format!("{key} is not a setting Coreview stores"));
    }
    let conn = state.db.lock().map_err(db_err)?;
    db::set_setting(&conn, &key, value.as_deref()).map_err(db_err)
}

/// Confirms a chosen folder is usable before it is stored.
///
/// The folder picker returns a path the user selected, but selecting a folder
/// is not the same as being able to write into it — a read-only mount or a
/// removed USB stick both pick cleanly and fail later, at which point the
/// failure looks like the backup feature being broken.
#[tauri::command]
pub fn check_folder_writable(path: String) -> CmdResult<()> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let probe = dir.join(".coreview-write-test");
    std::fs::write(&probe, b"")
        .map_err(|e| format!("Coreview cannot write into {path}: {e}"))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

// ---------------------------------------------------------------- discovery

/// Starts a ping sweep of one subnet, streaming results as hosts answer.
///
/// Returns as soon as the sweep is scheduled; progress and hits arrive on the
/// `coreview://sweep` event. A /24 takes the better part of a minute even at
/// full concurrency, and a caller blocked on the whole thing could not draw a
/// progress bar or offer a Stop button.
///
/// Starting a sweep cancels any sweep already running. Two at once would fight
/// over the same concurrency budget and report interleaved progress that adds
/// up to nothing sensible.
#[tauri::command]
pub async fn start_sweep(
    app: AppHandle,
    state: State<'_, AppState>,
    subnets: Vec<String>,
    options: SweepOptions,
) -> CmdResult<u32> {
    state.limiter.allow(crate::ratelimit::Job::Sweep)?;
    // Parsed here, before anything is spawned, so a typo comes back as an
    // error on the button press rather than as a sweep that finds nothing.
    // Named in the message, because with several subnets "invalid subnet" does
    // not say which one.
    let mut cidrs = Vec::new();
    for subnet in subnets.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        cidrs.push(parse_sweepable_cidr(subnet).map_err(|e| format!("{subnet}: {e}"))?);
    }
    if cidrs.is_empty() {
        return Err("Enter at least one subnet to sweep.".into());
    }

    let total: u32 = cidrs.iter().map(|c| c.host_count()).sum();
    // The per-subnet limit is checked above; this catches a set of subnets
    // that are each reasonable and absurd together.
    if total > MAX_SWEEP_HOSTS {
        return Err(format!(
            "Those subnets hold {total} addresses between them; the most that can be swept at once is {MAX_SWEEP_HOSTS}."
        ));
    }

    let token = CancellationToken::new();
    {
        let mut slot = state.sweep_cancel.lock().map_err(db_err)?;
        if let Some(previous) = slot.replace(token.clone()) {
            previous.cancel();
        }
    }

    let (tx, mut rx) = tokio::sync::mpsc::channel::<SweepEvent>(1024);
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = emitter.emit("coreview://sweep", &event);
        }
    });

    tauri::async_runtime::spawn(async move {
        sweep_many(cidrs, options, tx, token).await;
    });

    Ok(total)
}

/// Stops the running sweep. Harmless when none is running, so the UI can call
/// it without first asking whether there is anything to stop.
#[tauri::command]
pub fn cancel_sweep(state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(token) = state.sweep_cancel.lock().map_err(db_err)?.take() {
        token.cancel();
    }
    Ok(())
}

/// Checks a subnet without starting anything, so the form can say what is
/// wrong — and how many addresses are involved — while it is being typed.
#[tauri::command]
pub fn describe_subnet(subnet: String) -> CmdResult<SubnetInfo> {
    let cidr = parse_sweepable_cidr(&subnet).map_err(|e| e.to_string())?;
    Ok(SubnetInfo {
        network: cidr.network().to_string(),
        broadcast: cidr.broadcast().to_string(),
        prefix: cidr.prefix(),
        hosts: cidr.host_count(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubnetInfo {
    pub network: String,
    pub broadcast: String,
    pub prefix: u8,
    pub hosts: u32,
}
