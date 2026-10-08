//! Interactive SSH sessions, one per terminal tab.
//!
//! The app could already log into a device, run a command and read the answer
//! back. That is not the same thing as being *at* a device: this gives what
//! SecureCRT gives — right-click a device, get a shell, and have every
//! open shell sitting as tabs beside each other.
//!
//! What is here is the machinery, and it is deliberately thin. Each session is
//! a task owning a `coreview_discover::ssh::Shell`; the task selects between
//! bytes arriving from the device and instructions arriving from the window,
//! and forwards each to the other. Nothing here interprets what passes: the
//! device's escape sequences are the device's business and the terminal
//! emulator in the front end is what draws them.
//!
//! **A session is never part of a project.** It belongs to the window: it is
//! not written to the database, not saved into a `.coreview` file, and closing
//! the project closes the sessions. There is nothing to persist — a live TCP
//! connection cannot be saved — and pretending otherwise is how a document
//! ends up holding a hostname and a username it should not.
use std::collections::HashMap;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

use coreview_discover::backup::{backup_path_named, BackupKind};
use coreview_discover::sessionlog::SessionLog;
use coreview_discover::ssh::{Shell, SshError, SshOptions};

use crate::commands::AppState;

type CmdResult<T> = Result<T, String>;

/// What the window asks a live session to do.
enum Instruction {
    Send(Vec<u8>),
    Resize(u32, u32),
    /// Start appending a readable transcript to this file.
    LogTo(PathBuf),
    /// Stop writing the transcript. The file is left where it is.
    LogStop,
    /// How often to tell the device we are still here, or never.
    Keepalive(Option<Duration>),
    Close,
}

/// A session the window can still reach.
pub struct Session {
    to_device: mpsc::Sender<Instruction>,
    /// What the tab is titled with, so the registry can describe itself.
    pub address: String,
}

/// Every open session, by id. Empty at startup and after a project is closed.
#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, Session>>);

impl Sessions {
    fn insert(&self, id: String, session: Session) -> CmdResult<()> {
        self.0.lock().map_err(lock_err)?.insert(id, session);
        Ok(())
    }

    fn sender(&self, id: &str) -> CmdResult<mpsc::Sender<Instruction>> {
        let map = self.0.lock().map_err(lock_err)?;
        map.get(id)
            .map(|s| s.to_device.clone())
            .ok_or_else(|| "That session is no longer open.".to_string())
    }

    fn remove(&self, id: &str) -> Option<Session> {
        self.0.lock().ok()?.remove(id)
    }

    /// The ids of every open session. Used to shut them all when the project
    /// is closed.
    fn ids(&self) -> Vec<String> {
        self.0
            .lock()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn open(&self) -> Vec<OpenSession> {
        let mut out: Vec<OpenSession> = self
            .0
            .lock()
            .map(|m| {
                m.iter()
                    .map(|(id, s)| OpenSession {
                        id: id.clone(),
                        address: s.address.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }
}

/// One live session, as the window lists it.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSession {
    pub id: String,
    pub address: String,
}

fn lock_err(e: impl std::fmt::Display) -> String {
    format!("Session registry error: {e}")
}

/// What the front end is told about a session, as it happens.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum SessionEvent {
    /// Bytes from the device, base64 so that a chunk split in the middle of a
    /// multi-byte character survives the trip. Decoding is the terminal's job.
    Data { id: String, bytes: String },
    /// The session ended, with why — the device hung up, or it was closed here.
    Closed { id: String, reason: String },
    /// A keepalive went out, and the connection was still there to
    /// take it. The window shows this so "is it still up" is answered by
    /// looking rather than by typing into somebody's command line.
    Alive { id: String, at: u64 },
    /// The transcript is being written here, or has stopped.
    Logging { id: String, path: Option<String> },
    /// Something went wrong that did not end the session — the log file could
    /// not be written to, most likely.
    Warning { id: String, message: String },
    /// A login is in progress, keyed by the address rather than a
    /// session id, which does not exist until the shell is open. `stage` is
    /// one of "connecting", "hostKey", "authenticating", "secondFactor",
    /// "openingShell", so the panel can show what it is waiting on instead of
    /// a frozen line.
    Progress { address: String, stage: String },
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// Opens a shell on a device and returns the id of the session.
///
/// The credential comes out of the vault by id, exactly as a crawl's does, and
/// its use is recorded the same way. Nothing is typed into this
/// command: a password never crosses the IPC boundary.
// A Tauri command's arguments are named fields of one JSON object, so they are
// flat by construction; grouping them into a struct here would only move the
// same names one level down and change the isolation frame's table with them.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_open(
    app: AppHandle,
    state: State<'_, AppState>,
    address: String,
    credential_id: String,
    port: Option<u16>,
    cols: Option<u32>,
    rows: Option<u32>,
    keepalive_seconds: Option<u64>,
) -> CmdResult<String> {
    state.limiter.allow(crate::ratelimit::Job::SshSession)?;
    let address = address.trim().to_string();
    if address.is_empty() {
        return Err("That device has no address to connect to.".into());
    }

    // The chosen login, then every other SSH login the project keeps, for
    // a device that refuses it.
    let chain = crate::vault_commands::ssh_login_chain(&state, &credential_id)?;
    let logins: Vec<coreview_discover::ssh::Credentials> = chain.iter().map(|(_, c)| c.clone()).collect();
    let store = crate::discovery::load_host_keys(&state)?;

    let options = SshOptions {
        port: port.unwrap_or(22),
        ..SshOptions::default()
    };

    // Forward each login stage to the panel so the wait is legible
    // instead of a frozen "Connecting…". Keyed by address: the session id
    // does not exist until the shell is open. The forwarder ends when the
    // sender is dropped, which is when the open call returns.
    let (progress_tx, mut progress_rx) = mpsc::channel::<coreview_discover::ssh::SshProgress>(16);
    let progress_app = app.clone();
    let progress_address = address.clone();
    let progress_task = tauri::async_runtime::spawn(async move {
        use coreview_discover::ssh::SshProgress::*;
        while let Some(p) = progress_rx.recv().await {
            let stage = match p {
                Connecting { .. } => "connecting",
                CheckingHostKey { .. } => "hostKey",
                Authenticating { .. } => "authenticating",
                AwaitingSecondFactor { .. } => "secondFactor",
                OpeningShell { .. } => "openingShell",
                Ready { .. } | Running { .. } => continue,
            };
            let _ = progress_app.emit("coreview://ssh", SessionEvent::Progress { address: progress_address.clone(), stage: stage.to_string() });
        }
    });

    let opened = coreview_discover::ssh::open_shell_first_accepted(
        &address,
        &logins,
        options,
        Arc::clone(&store),
        cols.unwrap_or(120),
        rows.unwrap_or(30),
        Some(progress_tx),
    )
    .await;
    // The sender is dropped with `opened` either way; make sure the forwarder
    // is finished before the session's own events start.
    progress_task.abort();
    let sent = match &opened {
        Ok((_, taken)) => taken + 1,
        Err(SshError::AuthFailed { .. }) => chain.len(),
        Err(_) => 1,
    };
    for (i, (id, _)) in chain.iter().take(sent).enumerate() {
        crate::vault_commands::note_use(&state, id, if i == 0 { "SSH session" } else { "SSH session (fallback login)" }, &address);
    }
    let (mut shell, _) = opened.map_err(describe)?;
    crate::discovery::persist_host_keys(&app, &store);

    let id = format!("ssh-{}", uuid::Uuid::new_v4());
    let (to_device, mut instructions) = mpsc::channel::<Instruction>(64);

    let emitter = app.clone();
    let session_id = id.clone();
    // The task holds the registry itself rather than reaching back through the
    // app handle: a session whose task has ended must come out of the map, or
    // the next send to it waits forever on a channel nobody is reading.
    let registry = Arc::clone(&state.sessions);
    let mut every = keepalive_seconds.filter(|s| *s > 0).map(Duration::from_secs);
    tauri::async_runtime::spawn(async move {
        // The transcript, when one is asked for: the file it is appended to
        // and the state machine that makes it readable.
        let mut log: Option<(PathBuf, std::fs::File)> = None;
        let mut shaper = SessionLog::new();
        // Never zero: `tokio::time::interval` panics on a zero period, and a
        // keepalive that is switched off is a timer that never fires rather
        // than a branch that is missing.
        let mut ticker = tokio::time::interval(every.unwrap_or(Duration::from_secs(3600)));
        // The first tick of an interval is immediate, which would send a
        // keepalive to a device we have only just finished logging into.
        ticker.tick().await;

        let reason = loop {
            tokio::select! {
                // Bytes from the device go straight to the window.
                chunk = shell.read() => match chunk {
                    Some(bytes) => {
                        if let Some((path, file)) = log.as_mut() {
                            let readable = shaper.feed(&bytes);
                            if !readable.is_empty() {
                                if let Err(e) = file.write_all(&readable) {
                                    let _ = emitter.emit("coreview://ssh", SessionEvent::Warning {
                                        id: session_id.clone(),
                                        message: format!("The session log at {} could not be written: {e}", path.display()),
                                    });
                                    // Stop rather than warn on every chunk. The
                                    // session itself is not in trouble.
                                    log = None;
                                    let _ = emitter.emit("coreview://ssh", SessionEvent::Logging {
                                        id: session_id.clone(),
                                        path: None,
                                    });
                                }
                            }
                        }
                        let _ = emitter.emit("coreview://ssh", SessionEvent::Data {
                            id: session_id.clone(),
                            bytes: base64::engine::general_purpose::STANDARD.encode(&bytes),
                        });
                    }
                    None => break "The device closed the session.".to_string(),
                },
                // Still here.
                _ = ticker.tick(), if every.is_some() => {
                    if let Err(e) = shell.keepalive().await {
                        break describe(e);
                    }
                    let _ = emitter.emit("coreview://ssh", SessionEvent::Alive {
                        id: session_id.clone(),
                        at: now_ms(),
                    });
                }
                // Instructions from the window go straight to the device.
                instruction = instructions.recv() => match instruction {
                    None | Some(Instruction::Close) => break "Closed.".to_string(),
                    Some(Instruction::Send(bytes)) => {
                        if let Err(e) = shell.send(&bytes).await {
                            break describe(e);
                        }
                    }
                    Some(Instruction::Resize(cols, rows)) => {
                        if let Err(e) = shell.resize(cols, rows).await {
                            break describe(e);
                        }
                    }
                    Some(Instruction::LogTo(path)) => {
                        match open_session_log(&path) {
                            Ok(file) => {
                                shaper = SessionLog::new();
                                let said = path.display().to_string();
                                log = Some((path, file));
                                let _ = emitter.emit("coreview://ssh", SessionEvent::Logging {
                                    id: session_id.clone(),
                                    path: Some(said),
                                });
                            }
                            Err(e) => {
                                let _ = emitter.emit("coreview://ssh", SessionEvent::Warning {
                                    id: session_id.clone(),
                                    message: format!("The session log at {} could not be opened: {e}", path.display()),
                                });
                            }
                        }
                    }
                    Some(Instruction::LogStop) => {
                        log = None;
                        let _ = emitter.emit("coreview://ssh", SessionEvent::Logging {
                            id: session_id.clone(),
                            path: None,
                        });
                    }
                    Some(Instruction::Keepalive(next)) => {
                        every = next.filter(|d| !d.is_zero());
                        ticker = tokio::time::interval(every.unwrap_or(Duration::from_secs(3600)));
                        ticker.tick().await;
                    }
                },
            }
        };
        shell.close().await;
        let _ = emitter.emit(
            "coreview://ssh",
            SessionEvent::Closed {
                id: session_id.clone(),
                reason,
            },
        );
        registry.remove(&session_id);
    });

    state
        .sessions
        .insert(id.clone(), Session { to_device, address })?;
    Ok(id)
}

/// Keystrokes, base64 as they came off the terminal.
#[tauri::command]
pub async fn ssh_send(state: State<'_, AppState>, id: String, bytes: String) -> CmdResult<()> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(bytes.as_bytes())
        .map_err(|_| "Those keystrokes were not readable.".to_string())?;
    let to_device = state.sessions.sender(&id)?;
    to_device
        .send(Instruction::Send(decoded))
        .await
        .map_err(|_| "That session is no longer open.".to_string())
}

/// The terminal changed size, so the device should rewrap its output.
#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, AppState>,
    id: String,
    cols: u32,
    rows: u32,
) -> CmdResult<()> {
    let to_device = state.sessions.sender(&id)?;
    to_device
        .send(Instruction::Resize(cols, rows))
        .await
        .map_err(|_| "That session is no longer open.".to_string())
}

/// Ends one session. Closing a tab that has already gone is not an error.
#[tauri::command]
pub async fn ssh_close(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    if let Ok(to_device) = state.sessions.sender(&id) {
        let _ = to_device.send(Instruction::Close).await;
    }
    Ok(())
}

/// Starts appending this session's transcript to a file.
///
/// The file goes exactly where a backup of the same device would: the
/// configuration folder the project already points at, one folder per device,
/// named by the same pattern with `session` as the kind, so transcripts and
/// configuration backups live side by side under the same names — and
/// reusing `backup_path_named` means it also inherits the check that a
/// device calling itself `../../etc` cannot write outside the folder.
///
/// Appended, not replaced: reconnecting to the same device on the same day
/// adds to the transcript rather than starting it again, and a session that is
/// still open already has its log on disk.
#[tauri::command]
pub async fn ssh_log_start(
    state: State<'_, AppState>,
    id: String,
    folder: String,
    device: String,
    address: String,
    site: Option<String>,
    pattern: Option<String>,
) -> CmdResult<String> {
    let folder = folder.trim();
    if folder.is_empty() {
        return Err("No configuration folder has been chosen yet — pick one on the project screen.".into());
    }
    let path = backup_path_named(
        std::path::Path::new(folder),
        device.trim(),
        address.trim(),
        site.as_deref().unwrap_or("").trim(),
        // One file per device per day. A session is not a run: reconnecting
        // three times in an afternoon should read as one afternoon.
        &stamp_for_today(),
        BackupKind::Session,
        pattern.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not make {}: {e}", parent.display()))?;
    }
    let said = path.display().to_string();
    let to_device = state.sessions.sender(&id)?;
    to_device
        .send(Instruction::LogTo(path))
        .await
        .map_err(|_| "That session is no longer open.".to_string())?;
    Ok(said)
}

/// A session log is only ever opened for appending. One file per
/// device per day (`ssh_log_start`), so a session reopened from its tab
/// — or three in an afternoon — writes on after what is there,
/// never over it.
pub fn open_session_log(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().create(true).append(true).open(path)
}

/// Stops writing the transcript. What is already on disk stays.
#[tauri::command]
pub async fn ssh_log_stop(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let to_device = state.sessions.sender(&id)?;
    to_device
        .send(Instruction::LogStop)
        .await
        .map_err(|_| "That session is no longer open.".to_string())
}

/// How often this session tells the device it is still there, or never.
#[tauri::command]
pub async fn ssh_keepalive(
    state: State<'_, AppState>,
    id: String,
    seconds: Option<u64>,
) -> CmdResult<()> {
    let to_device = state.sessions.sender(&id)?;
    to_device
        .send(Instruction::Keepalive(
            seconds.filter(|s| *s > 0).map(Duration::from_secs),
        ))
        .await
        .map_err(|_| "That session is no longer open.".to_string())
}

/// `20260919` — the day, not the minute.
///
/// A backup stamps to the second because two runs an hour apart are two
/// different captures. A session log is a transcript that is appended to, so
/// the day is the unit: one file, however many times the device was dialled.
fn stamp_for_today() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let days = now / 86_400;
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}{m:02}{d:02}-000000")
}

/// Days since the epoch as a calendar date. Howard Hinnant's `civil_from_days`,
/// which is the standard way to do this without a date library.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Which sessions are still open.
///
/// The sessions live in this process, not in the page, so reloading the window
/// does not end them — this is how the tab strip finds them again.
#[tauri::command]
pub fn ssh_sessions(state: State<'_, AppState>) -> CmdResult<Vec<OpenSession>> {
    Ok(state.sessions.open())
}

/// Ends every session. Closing a project must not leave a shell logged in.
#[tauri::command]
pub async fn ssh_close_all(state: State<'_, AppState>) -> CmdResult<usize> {
    let ids = state.sessions.ids();
    for id in &ids {
        if let Ok(to_device) = state.sessions.sender(id) {
            let _ = to_device.send(Instruction::Close).await;
        }
    }
    Ok(ids.len())
}

/// An SSH failure as a person should read it.
///
/// `SshError` already says the useful thing in every variant, so this is only
/// here to keep the mapping in one place if that stops being true.
fn describe(e: SshError) -> String {
    e.to_string()
}

// ----------------------------------------------- somebody else's terminal

/// The default command for opening a session in whatever the machine already
/// has, when nothing has been configured.
///
/// `{user}`, `{host}` and `{port}` are filled in. These are the clients people
/// actually have: PuTTY on Windows, the `ssh://` handler on macOS — which is
/// Terminal unless something else has claimed it — and the desktop's own
/// terminal on Linux, which `x-terminal-emulator` is the Debian answer to.
pub fn default_external_command() -> &'static str {
    if cfg!(target_os = "windows") {
        "putty -ssh {user}@{host} -P {port}"
    } else if cfg!(target_os = "macos") {
        "open ssh://{user}@{host}:{port}"
    } else {
        "x-terminal-emulator -e ssh -p {port} {user}@{host}"
    }
}

/// Splits a command template into a program and its arguments.
///
/// **There is no shell here, and that is the whole design.** The template is
/// split first and the host, user and port are substituted into the pieces
/// afterwards, so a device that calls itself `; rm -rf ~` can only ever end up
/// as one argument to PuTTY. Double quotes group a piece that contains spaces,
/// which is what a Windows path needs.
pub fn split_command(template: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut started = false;
    for ch in template.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            c if c.is_whitespace() && !quoted => {
                if started {
                    out.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            c => {
                current.push(c);
                started = true;
            }
        }
    }
    if started {
        out.push(current);
    }
    out
}

/// The exact argument list to run, with the device's details filled in.
///
/// Pure, so what would be executed is testable without executing it.
pub fn argv_for(template: &str, user: &str, host: &str, port: u16) -> Result<Vec<String>, String> {
    let pieces = split_command(template);
    if pieces.is_empty() {
        return Err("The external terminal command is empty.".into());
    }
    let port = port.to_string();
    let filled: Vec<String> = pieces
        .into_iter()
        .map(|p| {
            p.replace("{user}", user)
                .replace("{host}", host)
                .replace("{port}", &port)
        })
        .collect();
    Ok(filled)
}

/// Hands the connection to the terminal the machine already has.
///
/// **The password does not go with it, and it is not an oversight.** PuTTY's
/// `-pw` and every equivalent put the password on a command line, where any
/// other account on the machine can read it straight out of the process list —
/// which is the opposite of there being a vault at all. The username
/// and the address go; the client asks for the rest. Coreview knows nothing
/// about the session after this: no log, no colouring, no keepalive. Those are
/// what the panel is for.
#[tauri::command(async)]
pub fn ssh_external(
    state: State<'_, AppState>,
    address: String,
    username: String,
    port: Option<u16>,
    command: Option<String>,
) -> CmdResult<Vec<String>> {
    state.limiter.allow(crate::ratelimit::Job::SshSession)?;
    let address = address.trim();
    if address.is_empty() {
        return Err("That device has no address to connect to.".into());
    }
    let configured = command.unwrap_or_default();
    let template = match configured.trim() {
        "" => default_external_command(),
        t => t,
    };
    let argv = argv_for(template, username.trim(), address, port.unwrap_or(22))?;
    let (program, args) = argv.split_first().expect("argv_for refuses an empty template");

    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map_err(|e| {
            format!("Could not start {program}: {e}. Set the external terminal command in Settings if it lives somewhere else.")
        })?;
    Ok(argv.clone())
}

#[cfg(test)]
mod tests {
    use super::civil_from_days;

    use super::{argv_for, split_command};

    #[test]
    fn a_hostile_device_name_can_only_ever_be_one_argument() {
        // No shell runs this, so the worst a name can do is be a bad argument.
        let argv = argv_for("putty -ssh {user}@{host} -P {port}", "ops", "; rm -rf ~", 22).unwrap();
        assert_eq!(argv, ["putty", "-ssh", "ops@; rm -rf ~", "-P", "22"]);
    }

    #[test]
    fn a_quoted_windows_path_stays_one_piece() {
        assert_eq!(
            split_command("\"C:\\Program Files\\PuTTY\\putty.exe\" -ssh {host}"),
            ["C:\\Program Files\\PuTTY\\putty.exe", "-ssh", "{host}"]
        );
    }

    #[test]
    fn an_empty_command_is_refused_rather_than_run() {
        assert!(argv_for("   ", "ops", "192.0.2.10", 22).is_err());
    }

    #[test]
    fn every_placeholder_is_filled_in_including_repeats() {
        let argv = argv_for("t -e ssh {host} {host}:{port}", "", "192.0.2.10", 2222).unwrap();
        assert_eq!(argv, ["t", "-e", "ssh", "192.0.2.10", "192.0.2.10:2222"]);
    }

    #[test]
    fn a_day_number_becomes_the_date_that_names_the_log() {
        // The epoch, a leap day, and a date after one, which is where a
        // hand-rolled calendar goes wrong if it is going to.
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        assert_eq!(civil_from_days(19_783), (2024, 3, 1));
        assert_eq!(civil_from_days(20_715), (2026, 9, 19));
    }
}

// ------------------------------------------------ does this login work

/// What happened when a saved credential was tried against one device.
///
/// Three outcomes and not two, because they are three different problems with
/// three different fixes: the device never answered, it answered and refused
/// the credential, or it let us in. Collapsing the first two into "failed" is
/// what makes a bad password and an unreachable host look the same, which is
/// most of why "is this password right" is hard to answer today.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialTest {
    /// `reached`, `refused` or `unreachable`.
    pub outcome: String,
    /// What to tell the operator, in one sentence.
    pub detail: String,
    /// How long it took, so a slow success reads as slow rather than broken.
    pub millis: u64,
}

/// Tries a saved credential against one device and says what happened.
///
/// It opens a shell and closes it again immediately — nothing is typed, no
/// command is run, and no transcript is written. The point is the handshake
/// and the authentication, which is the part that is in doubt.
#[tauri::command]
pub async fn ssh_test_credential(
    app: AppHandle,
    state: State<'_, AppState>,
    address: String,
    credential_id: String,
    port: Option<u16>,
) -> CmdResult<CredentialTest> {
    state.limiter.allow(crate::ratelimit::Job::CredentialTest)?;
    let address = address.trim().to_string();
    if address.is_empty() {
        return Err("Give an address to test the login against.".into());
    }
    let credentials = crate::vault_commands::ssh_credentials(&state, &credential_id)?;
    crate::vault_commands::note_use(&state, &credential_id, "Credential test", &address);
    let store = crate::discovery::load_host_keys(&state)?;
    let options = SshOptions {
        port: port.unwrap_or(22),
        ..SshOptions::default()
    };

    let started = std::time::Instant::now();
    let outcome = Shell::open(&address, &credentials, options, Arc::clone(&store), 80, 24, None).await;
    let millis = started.elapsed().as_millis() as u64;
    crate::discovery::persist_host_keys(&app, &store);

    Ok(match outcome {
        Ok(shell) => {
            shell.close().await;
            CredentialTest {
                outcome: "reached".into(),
                detail: format!("{address} accepted this login."),
                millis,
            }
        }
        // The device answered and said no. That is a credential problem.
        Err(e @ SshError::AuthFailed { .. }) | Err(e @ SshError::AuthTimeout { .. }) => CredentialTest {
            outcome: "refused".into(),
            detail: describe(e),
            millis,
        },
        // Everything else is about getting there at all — the host key, the
        // timeout, the network. The login was never tested.
        Err(e) => CredentialTest {
            outcome: "unreachable".into(),
            detail: format!("{} The login itself was not tested.", describe(e)),
            millis,
        },
    })
}

#[cfg(test)]
mod session_log_tests {
    use std::io::Write;

    /// Opening the same log twice — as a reconnect does — keeps what
    /// the first session wrote.
    #[test]
    fn a_log_opened_again_appends_rather_than_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("20260928-session-EXAMPLE-SW.txt");
        writeln!(super::open_session_log(&path).unwrap(), "first session").unwrap();
        writeln!(super::open_session_log(&path).unwrap(), "second session").unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text, "first session\nsecond session\n");
    }
}

