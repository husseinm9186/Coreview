//! The complete IPC surface. Every command is narrow and typed; there is no
//! generic exec, no shell plugin, and no path passed through from JavaScript
//! except through the dialog plugin's user-chosen file handles.

use std::sync::{Arc, Mutex};

use coreview_probe::engine::{run_once, EngineEvent, SessionState};
use coreview_probe::sweep::{parse_sweepable_cidr, sweep_many, SweepEvent, SweepOptions, MAX_SWEEP_HOSTS};
use coreview_probe::{run_traceroute, Engine, ProbeConfig, ProbeResult, ProbeSnapshot, TracerouteResult};
use base64::Engine as _;
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::db::{self, EventRow, ProjectMeta, ProjectPackage};

pub struct AppState {
    pub engine: Arc<Engine>,
    pub db: Mutex<Connection>,
    pub session_id: Mutex<Option<String>>,
    pub project_id: Mutex<Option<String>>,
    /// The crawl, the backup and the sweep that are running, one of
    /// each at most. Three separate slots because they are three different
    /// jobs and stopping one must not stop the others — and the validation
    /// engine's Stop must not touch any of them.
    pub jobs: Arc<crate::jobs::Jobs>,
    /// The unlocked vault key, for as long as the app is running. Never
    /// written anywhere, and zeroed when it is dropped.
    pub vault_key: Mutex<Option<coreview_discover::vault::VaultKey>>,
    /// How often each kind of network job may start.
    pub limiter: crate::ratelimit::RateLimiter,
    /// The interactive SSH sessions the window has open. Belongs to
    /// the window, never to a project — nothing here is ever written down.
    pub sessions: std::sync::Arc<crate::terminal::Sessions>,
    /// Where a native dialog pointed, by token, until it is written
    /// to once. The page never names a path to write; it names a token.
    pub export_targets: ExportTargets,
    /// The project the window has open, told by the page when it opens
    /// or closes one. Every secret is opened against it.
    pub open_project: Mutex<Option<String>>,
}

/// The project the window has open, as the vault checks against it.
pub fn open_project(state: &AppState) -> Option<String> {
    state.open_project.lock().ok().and_then(|g| g.clone()).filter(|p| !p.is_empty())
}

/// The page says which project is open, or that none is.
#[tauri::command(async)]
pub fn set_open_project(state: State<'_, AppState>, project_id: Option<String>) -> CmdResult<()> {
    *state.open_project.lock().map_err(db_err)? = project_id.filter(|p| !p.trim().is_empty());
    Ok(())
}

/// The paths a save or folder dialog returned, each spent by one
/// write. A page that could send any path could write anywhere on the
/// machine; a page that can only send back a token can write only where a
/// person just pointed, and only once.
#[derive(Default)]
pub struct ExportTargets {
    paths: Mutex<std::collections::HashMap<String, std::path::PathBuf>>,
}

impl ExportTargets {
    /// Keeps a path the dialog returned and hands back the token for it.
    pub fn keep(&self, path: std::path::PathBuf) -> String {
        let token = Uuid::new_v4().to_string();
        if let Ok(mut m) = self.paths.lock() {
            m.insert(token.clone(), path);
        }
        token
    }

    /// The path behind a token, once. A second use, or a token nobody was
    /// given, is refused.
    pub fn take(&self, token: &str) -> Result<std::path::PathBuf, String> {
        self.paths
            .lock()
            .map_err(|e| e.to_string())?
            .remove(token)
            .ok_or_else(|| "That save location is not one a dialog chose, or it was already written to.".to_string())
    }
}

/// Where an export goes. `folder` is the project's chosen export
/// folder, if any; with one, the file goes straight there without a dialog
/// (a standing answer to "where should this go"); without one, the native
/// save dialog is shown here, in Rust, and the page never sees the path
/// except to tell the person where the file went.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTarget {
    pub token: String,
    pub path: String,
}

#[tauri::command(async)]
pub fn pick_export_target(app: AppHandle, state: State<'_, AppState>, filename: String, folder: Option<String>) -> CmdResult<Option<ExportTarget>> {
    use tauri_plugin_dialog::DialogExt;
    let name = std::path::Path::new(filename.trim())
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .filter(|f| !f.is_empty())
        .ok_or("An export needs a file name.")?;
    let path = match folder.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        Some(dir) => std::path::PathBuf::from(dir).join(&name),
        None => {
            let ext = std::path::Path::new(&name).extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
            let mut dialog = app.dialog().file().set_file_name(&name);
            if !ext.is_empty() {
                dialog = dialog.add_filter(ext.to_uppercase(), &[ext.as_str()]);
            }
            match dialog.blocking_save_file() {
                Some(picked) => picked.into_path().map_err(|e| e.to_string())?,
                None => return Ok(None),
            }
        }
    };
    let shown = path.to_string_lossy().into_owned();
    Ok(Some(ExportTarget { token: state.export_targets.keep(path), path: shown }))
}

/// The folder a project folder is written into — the chosen export
/// folder, or the one a native folder dialog returns.
#[tauri::command(async)]
pub fn pick_export_folder(app: AppHandle, state: State<'_, AppState>, folder: Option<String>) -> CmdResult<Option<ExportTarget>> {
    use tauri_plugin_dialog::DialogExt;
    let path = match folder.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        Some(dir) => std::path::PathBuf::from(dir),
        None => match app.dialog().file().blocking_pick_folder() {
            Some(picked) => picked.into_path().map_err(|e| e.to_string())?,
            None => return Ok(None),
        },
    };
    let shown = path.to_string_lossy().into_owned();
    Ok(Some(ExportTarget { token: state.export_targets.keep(path), path: shown }))
}

type CmdResult<T> = Result<T, String>;

fn db_err(e: impl std::fmt::Display) -> String {
    format!("Local database error: {e}")
}

// ---------------------------------------------------------------- projects

#[tauri::command(async)]
pub fn list_projects(state: State<'_, AppState>) -> CmdResult<Vec<ProjectMeta>> {
    let conn = state.db.lock().map_err(db_err)?;
    db::list_projects(&conn).map_err(db_err)
}

#[tauri::command(async)]
pub fn save_project(state: State<'_, AppState>, package: ProjectPackage) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    db::upsert_project(&conn, &package).map_err(db_err)
}

#[tauri::command(async)]
pub fn load_project(state: State<'_, AppState>, id: String) -> CmdResult<Option<ProjectPackage>> {
    let conn = state.db.lock().map_err(db_err)?;
    db::load_project(&conn, &id).map_err(db_err)
}

#[tauri::command(async)]
pub fn delete_project(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    db::delete_project(&conn, &id).map_err(db_err)
}

#[tauri::command(async)]
pub fn set_project_archived(
    state: State<'_, AppState>,
    id: String,
    archived: bool,
) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    db::set_archived(&conn, &id, archived).map_err(db_err)
}

// -------------------------------------------------------- project folders
// This machine's arrangement of the project screen. Stored beside the
// projects, never inside a document or a package.

#[tauri::command(async)]
pub fn list_project_folders(state: State<'_, AppState>) -> CmdResult<db::FolderTree> {
    let conn = state.db.lock().map_err(db_err)?;
    db::list_folders(&conn).map_err(db_err)
}

#[tauri::command(async)]
pub fn create_project_folder(state: State<'_, AppState>, name: String, parent_id: Option<String>) -> CmdResult<db::ProjectFolder> {
    let conn = state.db.lock().map_err(db_err)?;
    db::create_folder(&conn, &name, parent_id.as_deref())
}

#[tauri::command(async)]
pub fn rename_project_folder(state: State<'_, AppState>, id: String, name: String) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    db::rename_folder(&conn, &id, &name)
}

#[tauri::command(async)]
pub fn move_project_folder(state: State<'_, AppState>, id: String, parent_id: Option<String>) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    db::move_folder(&conn, &id, parent_id.as_deref())
}

#[tauri::command(async)]
pub fn delete_project_folder(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    db::delete_folder(&conn, &id)
}

#[tauri::command(async)]
pub fn move_project_to_folder(state: State<'_, AppState>, id: String, folder_id: Option<String>) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    db::move_project(&conn, &id, folder_id.as_deref())
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

/// On-demand diagnostic: the current path to a target, once — not a
/// scheduled probe, and nothing is written to the event log. Useful mid-drill
/// when something is not reaching the backup site and the question is where
/// it is actually going, not whether it is up.
#[tauri::command]
pub async fn traceroute_now(state: State<'_, AppState>, target: String) -> CmdResult<TracerouteResult> {
    state.limiter.allow(crate::ratelimit::Job::Traceroute)?;
    run_traceroute(&target, 30_000).await
}

/// Open a hyperlink on a device or note in the OS's own browser.
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

/// The kinds of file a device attachment may open as. Documents,
/// pictures, drawings and text — never anything the system would run, because
/// a path can arrive inside an imported project file.
///
/// The legacy Office formats (`.doc`, `.xls`, `.ppt`) and `.rtf` are
/// not here, because they carry macros behind a prompt people click through;
/// nor is `.zip`, because an archive can hold anything. The OOXML forms without
/// a macro suffix (`.docx`, `.xlsx`, `.pptx`) stay.
const ATTACHMENT_KINDS: &[&str] = &[
    "pdf", "txt", "log", "cfg", "conf", "md", "csv", "json", "xml", "yaml", "yml", "png", "jpg", "jpeg", "gif", "svg",
    "webp", "bmp", "docx", "xlsx", "pptx", "odt", "ods", "odp", "vsd", "vsdx", "drawio", "pcap", "pcapng",
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

/// Opens a device attachment, or shows the folder it is in. Showing
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

/// Bring a running session's targets in line with the document.
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

#[tauri::command(async)]
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
#[tauri::command(async)]
pub fn record_event(state: State<'_, AppState>, event: EventRow) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    db::insert_event(&conn, &event).map_err(db_err)?;
    // The table is capped per project, the way samples are per probe.
    db::prune_events(&conn, &event.project_id).map_err(db_err)?;
    Ok(())
}

#[tauri::command(async)]
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
            // Every result is kept for the history sparklines. The
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

/// A project's validation sessions, newest first.
#[tauri::command(async)]
pub fn list_sessions(state: State<'_, AppState>, project_id: String) -> CmdResult<Vec<db::SessionRow>> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_sessions(&conn, &project_id).map_err(|e| e.to_string())
}

/// What each probe did in one session.
#[tauri::command(async)]
pub fn session_summary(state: State<'_, AppState>, session_id: String) -> CmdResult<Vec<db::ProbeSummary>> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::session_summary(&conn, &session_id).map_err(|e| e.to_string())
}

/// The crawls a project has kept, so two can be compared. Since
/// A run is written by the crawl itself, device by device, so there is
/// no command to save one — see `discovery::start_crawl`.
#[tauri::command(async)]
pub fn list_crawl_runs(state: State<'_, AppState>, project_id: String) -> CmdResult<Vec<db::CrawlRunRow>> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_crawl_runs(&conn, &project_id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn crawl_run_result(state: State<'_, AppState>, id: String, project_id: String) -> CmdResult<serde_json::Value> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::crawl_run_result(&conn, &id, &project_id).map_err(|e| e.to_string())?.ok_or_else(|| "That crawl is no longer kept.".into())
}

/// A probe's recorded results since `since_ms`, oldest first.
#[tauri::command(async)]
pub fn probe_history(state: State<'_, AppState>, probe_id: String, project_id: String, since_ms: i64, limit: Option<i64>) -> CmdResult<Vec<db::SampleRow>> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::samples_for(&conn, &probe_id, &project_id, since_ms, limit.unwrap_or(2_000).clamp(1, 20_000)).map_err(|e| e.to_string())
}

// ------------------------------------------------------------------- icons

/// Index a user-chosen folder of SVGs as an icon library.
///
/// The artwork stays on disk in the user's own directory; nothing is
/// bundled or committed. Returns sanitised SVG source plus the list of files
/// that were skipped and why, so the palette can say what it could not read
/// rather than quietly showing fewer icons.
///
/// A job, because a folder of stencils converts through LibreOffice
/// and that takes minutes; the header shows the count and Stop ends it.
#[tauri::command(async)]
pub fn list_icon_library(state: State<'_, AppState>, dir: String) -> CmdResult<crate::icons::IconLibrary> {
    let ticket = state.jobs.start(crate::jobs::Kind::IconScan)?;
    let token = ticket.token();
    let progress = ticket.progress();
    crate::icons::scan_watched(&dir, &[], &|phase, done, total| progress.set(phase, done, total), &|| token.is_cancelled())
}

/// The diagram as a PDF. The frontend renders the drawing to SVG —
/// one function, the same one the screen and the SVG export use — and this
/// turns it into a vector PDF the operator can attach to a change record.
#[tauri::command(async)]
pub fn diagram_pdf(svg: String) -> CmdResult<Vec<u8>> {
    crate::pdf::svg_to_pdf(&svg)
}

/// Every page asked for, as one PDF.
#[tauri::command(async)]
pub fn diagram_pdf_pages(svgs: Vec<String>) -> CmdResult<Vec<u8>> {
    crate::pdf::svgs_to_pdf(&svgs)
}

/// The diagram as a Visio drawing. Shapes and connectors, not a
/// picture: a colleague without Coreview can open it and move things.
#[tauri::command(async)]
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
/// vendor packs are no longer bundled and a test
/// keeps it that way.
#[tauri::command(async)]
pub fn list_bundled_icons(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<crate::icons::IconLibrary> {
    crate::icons::scan_excluding(&stencil_dir(&app)?, &removed_packs(&state))
}

/// The bundled stencil packs — none ship — each an
/// immediate subdirectory of the same resource
/// `list_bundled_icons` scans.
#[tauri::command(async)]
pub fn list_stencil_packs(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<Vec<crate::icons::StencilPack>> {
    crate::icons::list_packs_excluding(&stencil_dir(&app)?, &removed_packs(&state))
}

/// Removes one bundled stencil pack (fixed).
///
/// Two things happen, and only one of them can fail. The pack is recorded as
/// removed, which is what makes its shapes disappear and is the part that
/// matters; then its files are deleted to free the space,
/// which cannot happen on a read-only install. The result says which, so the
/// interface can stop claiming space was freed when it was not.
#[tauri::command(async)]
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

/// Writes an export where a dialog pointed.
///
/// This is the only way anything in the webview can write to disk: there is no
/// filesystem plugin, and the page cannot name a path at all — it
/// names the token `pick_export_target` gave it, which is spent by this write.
///
/// Bytes arrive base64-encoded because one of the five exports (PNG) is binary
/// and the other four are text. Encoding them all the same way keeps this to a
/// single command rather than a text one and a binary one.
#[tauri::command(async)]
pub fn save_export(state: State<'_, AppState>, token: String, contents_b64: String) -> CmdResult<()> {
    let path = state.export_targets.take(&token)?;
    write_export(&path, &contents_b64)
}

fn write_export(path: &std::path::Path, contents_b64: &str) -> CmdResult<()> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents_b64.as_bytes())
        .map_err(|e| format!("Export could not be encoded: {e}"))?;
    std::fs::write(path, bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))
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
/// Reads a Visio drawing as a topology.
///
/// A `.vsdx` is far larger than a Coreview project — the sample drawings run
/// to several MB of embedded artwork — so this gets its own, bigger limit
/// rather than borrowing the one below, which exists to reject a file that is
/// obviously not a project.
/// A draw.io drawing, read into the same preview a Visio one gets.
#[tauri::command(async)]
pub fn import_drawio(path: String) -> CmdResult<coreview_formats::visio_import::VisioImport> {
    const MAX: u64 = 64 * 1024 * 1024;
    let size = std::fs::metadata(&path).map_err(|e| format!("Could not read {path}: {e}"))?.len();
    if size > MAX {
        return Err(format!("{path} is {} MB, which is larger than any drawing this can read.", size / (1024 * 1024)));
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    coreview_formats::drawio_import::import_drawio(&text)
}

#[tauri::command(async)]
pub fn import_visio(path: String) -> CmdResult<coreview_formats::visio_import::VisioImport> {
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
    coreview_formats::visio_import::import_vsdx(&bytes)
}

/// Where the isolation frame sends a message it refused. Nothing the
/// page asked for runs; the call fails with why.
#[tauri::command]
pub fn ipc_refused(command: String, reason: String) -> CmdResult<()> {
    eprintln!("coreview: refused a call to {command}: {reason}");
    Err(format!("{command} was refused before it reached Coreview: {reason}."))
}

/// A project as a folder — `project.coreview` and `project.yaml` —
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
pub fn save_project_folder(state: State<'_, AppState>, token: String, name: String, json: String, yaml: String) -> CmdResult<String> {
    // The folder is the one a dialog returned, spent by this write.
    let folder = state.export_targets.take(&token)?;
    write_project_folder(&folder.to_string_lossy(), &name, &json, &yaml)
}

/// Every sheet of an Excel workbook the user chose, as rows of text.
#[tauri::command(async)]
pub fn read_spreadsheet(path: String) -> CmdResult<Vec<crate::spreadsheet::Sheet>> {
    const MAX: u64 = 64 * 1024 * 1024;
    let size = std::fs::metadata(&path).map_err(|e| format!("Could not read {path}: {e}"))?.len();
    if size > MAX {
        return Err(format!("{path} is {} MB, which is more than an inventory workbook should be.", size / (1024 * 1024)));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    crate::spreadsheet::read_xlsx(&bytes)
}

#[tauri::command(async)]
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

    /// A project folder is written whole, and a name cannot climb out.
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

    /// Only existing documents open; anything runnable, relative or
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
        // What carries a macro, or anything at all, is not opened.
        for legacy in ["rack.xls", "notes.doc", "deck.ppt", "memo.rtf", "bundle.zip", "sheet.xlsm", "form.docm"] {
            let f = dir.join(legacy);
            std::fs::write(&f, b"x").unwrap();
            assert!(super::attachment_problem(&f).unwrap().contains("not opened from here"), "{legacy}");
        }
        for fine in ["rack.xlsx", "notes.docx", "deck.pptx"] {
            let f = dir.join(fine);
            std::fs::write(&f, b"x").unwrap();
            assert_eq!(super::attachment_problem(&f), None, "{fine}");
        }
        assert!(super::attachment_problem(std::path::Path::new("relative.pdf")).unwrap().contains("full path"));
        assert!(super::attachment_problem(&dir.join("gone.pdf")).unwrap().contains("not there"));
        assert!(super::attachment_problem(&dir.join("folder.pdf")).is_some());
        std::fs::remove_dir_all(&dir).ok();
    }
    use super::*;

    /// A token is spent by one write, and a token nobody was given
    /// opens nothing.
    #[test]
    fn a_save_location_is_used_once_and_only_when_a_dialog_gave_it() {
        let targets = super::ExportTargets::default();
        let token = targets.keep(std::path::PathBuf::from("/tmp/coreview-lt456/out.svg"));
        assert_eq!(targets.take(&token).unwrap(), std::path::PathBuf::from("/tmp/coreview-lt456/out.svg"));
        assert!(targets.take(&token).unwrap_err().contains("already written"), "spent");
        assert!(targets.take("made-up").unwrap_err().contains("not one a dialog chose"));
    }

    #[test]
    fn writes_decoded_bytes_to_the_given_path() {
        let dir = std::env::temp_dir().join(format!("coreview-export-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("diagram.png");
        // PNG magic, so this also covers the binary case rather than only text.
        let png = [0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);

        write_export(&path, &b64).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), png);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_a_payload_that_is_not_base64() {
        let path = std::env::temp_dir().join("coreview-should-not-appear");
        std::fs::remove_file(&path).ok();

        let err = write_export(&path, "not base64!!").unwrap_err();

        assert!(err.contains("could not be encoded"), "unexpected error: {err}");
        // Fail closed: a bad payload must not leave a truncated or empty file.
        assert!(!path.exists());
    }

    #[test]
    fn reports_the_path_when_the_directory_does_not_exist() {
        let path = std::env::temp_dir().join("coreview-no-such-dir").join("x.svg");
        let err = write_export(&path, "").unwrap_err();
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
#[tauri::command(async)]
pub fn get_settings(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> CmdResult<std::collections::HashMap<String, String>> {
    let conn = state.db.lock().map_err(db_err)?;
    // This computer's preferences, then this project's on top. The
    // two key sets do not overlap — `is_project_key` decides which table a key
    // lives in — so the merge cannot have a winner and a loser.
    let mut all = db::all_settings(&conn).map_err(db_err)?;
    if let Some(id) = project_id.as_deref().filter(|i| !i.is_empty()) {
        all.extend(db::project_settings(&conn, id).map_err(db_err)?);
    }
    Ok(all)
}

/// Stores a preference, or clears it when `value` is absent or empty.
#[tauri::command(async)]
pub fn set_setting(
    state: State<'_, AppState>,
    key: String,
    value: Option<String>,
    project_id: Option<String>,
) -> CmdResult<()> {
    // A fixed key list rather than an open map: this table is read on startup
    // and fed straight into the UI, and an unbounded key space invites it
    // becoming a dumping ground for things that belong in a typed column.
    //
    // The `scan*` keys are what a discovery run was set up with, so
    // it can be repeated without retyping. **Not one of them is a secret.**
    // Passwords, enable secrets, community strings and v3 passphrases live in
    // the encrypted vault and are referenced from here only by the id of the
    // credential that holds them (`scanCredentialId`, `scanSnmpCredentialId`).
    // This table is plain text in the same database as the projects, and
    // nothing typed into Coreview is ever written where it could leave the
    // machine.
    const ALLOWED: [&str; 31] = [
        // The shadow-mode feature flag, per project.
        "collectorShadow",
        "backupFolder",
        "exportFolder",
        "iconLibraryDir",
        "addressPreference",
        "scanSeed",
        "scanSubnets",
        // Which of them have their scan box ticked.
        "scanSweep",
        "scanPort",
        "scanMaxHops",
        "scanCredentialId",
        // Several SNMP credentials, so their *shape* is one JSON
        // string rather than four keys. Version, v3 user name and the two
        // algorithm choices only — communities and passphrases are secrets
        // and stay in the vault, referenced here by credential id.
        "scanSnmpRows",
        // The Backups tab's global show commands and paging choice.
        // The user's own list, kept on this machine — never a secret, and
        // never shipped as a default.
        "backupShowCommands",
        "backupPaging",
        // Named command sets applied by role or tag, as one JSON
        // string. Commands and the words they match on — no secrets, and no
        // set ships built in.
        "backupCommandSets",
        // The capture filename pattern, tokens and literal text only.
        "backupFilePattern",
        // Checks against captured output, as one JSON string — a
        // command, an expectation and a pattern each. No secrets; none ship
        // built in.
        "backupChecks",
        // Ordered collection groups — names and the roles and tags
        // they match. No secrets; none ship built in.
        "backupGroups",
        // How the terminal behaves — a font, a size,
        // whether to colour plain output, how often to say we are still here,
        // whether to log by default, where a plain SSH goes, and the command
        // that opens somebody else's terminal. Preferences about reading and
        // working, so they live on the machine and not in a project. No
        // secrets: the external command carries {user} and {host}, never a
        // password.
        "sshFontFamily",
        "sshFontSize",
        "sshColourise",
        "sshKeepaliveSeconds",
        "sshLogByDefault",
        "sshOpenWith",
        "sshExternalCommand",
        // Clipboard manners in the terminal.
        "sshCopyOnSelect",
        "sshPasteOnRight",
        // The SFTP server a Cisco device is told to send its configuration
        // to when a backup is asked for over SNMP: host, port and folder,
        // and the saved login by its vault id. Per project, like the
        // backup folder; no secret here.
        "sftpHost",
        "sftpPort",
        "sftpFolder",
        "sftpCredentialId",
    ];
    if !ALLOWED.contains(&key.as_str()) {
        return Err(format!("{key} is not a setting Coreview stores"));
    }
    let conn = state.db.lock().map_err(db_err)?;
    // A key that shapes the work belongs to the project doing it.
    // Without a project open there is nothing to write it to, and writing it
    // to the shared table is precisely the bug — so it is refused instead.
    if db::is_project_key(&key) {
        let id = project_id
            .filter(|i| !i.is_empty())
            .ok_or("That setting belongs to a project, and no project is open.")?;
        return db::set_project_setting(&conn, &id, &key, value.as_deref()).map_err(db_err);
    }
    db::set_setting(&conn, &key, value.as_deref()).map_err(db_err)
}

/// Confirms a chosen folder is usable before it is stored.
///
/// The folder picker returns a path the user selected, but selecting a folder
/// is not the same as being able to write into it — a read-only mount or a
/// removed USB stick both pick cleanly and fail later, at which point the
/// failure looks like the backup feature being broken.
#[tauri::command(async)]
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

    // One sweep at a time, and a second is refused rather than
    // silently replacing the first.
    let ticket = state.jobs.start(crate::jobs::Kind::Sweep)?;
    let token = ticket.token();
    let progress = ticket.progress();

    let (tx, mut rx) = tokio::sync::mpsc::channel::<SweepEvent>(1024);
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            // The registry hears where the sweep is.
            match &event {
                SweepEvent::Started { total } => progress.set("Sweeping", 0, Some(u64::from(*total))),
                SweepEvent::Progress { done, total } => progress.set("Sweeping", u64::from(*done), Some(u64::from(*total))),
                _ => {}
            }
            let _ = emitter.emit("coreview://sweep", &event);
        }
    });

    tauri::async_runtime::spawn(async move {
        sweep_many(cidrs, options, tx, token).await;
        // The slot empties when the sweep does, however it ended.
        drop(ticket);
    });

    Ok(total)
}

/// What changed across every kept crawl, oldest run first, and the
/// newest run's changes counted by field for the landing line.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlTimeline {
    pub entries: Vec<crate::timeline::TimelineEntry>,
    pub newest_run: Option<String>,
    pub runs: usize,
    pub since_last: std::collections::BTreeMap<String, usize>,
}

/// A kept run as the timeline reads it: its id, when it was taken, and its devices.
type LoadedRun = (String, i64, Vec<serde_json::Value>);

#[tauri::command(async)]
pub fn crawl_timeline(state: State<'_, AppState>, project_id: String, device: Option<String>) -> CmdResult<CrawlTimeline> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    // Newest first from the database; the timeline wants oldest first.
    let mut rows = db::list_crawl_runs(&conn, &project_id).map_err(|e| e.to_string())?;
    rows.reverse();
    let mut loaded: Vec<LoadedRun> = Vec::with_capacity(rows.len());
    for r in &rows {
        // A run still running or aborted is a partial picture; comparing a
        // whole estate against half of one would report half of it gone.
        if r.status != "complete" && r.status != "cancelled" {
            continue;
        }
        let Some(result) = db::crawl_run_result(&conn, &r.id, &project_id).map_err(|e| e.to_string())? else { continue };
        let devices = result.get("devices").and_then(|d| d.as_array()).cloned().unwrap_or_default();
        loaded.push((r.id.clone(), r.taken_at, devices));
    }
    let runs: Vec<crate::timeline::Run<'_>> = loaded
        .iter()
        .map(|(id, taken_at, devices)| crate::timeline::Run { id, taken_at: *taken_at, devices })
        .collect();
    let entries = crate::timeline::timeline(&runs, device.as_deref());
    let newest_run = loaded.last().map(|(id, _, _)| id.clone());
    let since_last = newest_run.as_deref().map(|n| crate::timeline::since_last(&entries, n)).unwrap_or_default();
    Ok(CrawlTimeline { entries, newest_run, runs: loaded.len(), since_last })
}

/// Every job running or stopping right now.
#[tauri::command]
pub fn job_list(state: State<'_, AppState>) -> CmdResult<Vec<crate::jobs::JobSnapshot>> {
    Ok(state.jobs.list())
}

/// Stops one job by its id. Says whether there was one to stop.
#[tauri::command]
pub fn job_cancel(state: State<'_, AppState>, id: u64) -> CmdResult<bool> {
    Ok(state.jobs.cancel_id(id))
}

/// Stops the running sweep. Harmless when none is running, so the UI can call
/// it without first asking whether there is anything to stop.
#[tauri::command]
pub fn cancel_sweep(state: State<'_, AppState>) -> CmdResult<()> {
    state.jobs.cancel(crate::jobs::Kind::Sweep);
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
