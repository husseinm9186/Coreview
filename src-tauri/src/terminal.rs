//! Interactive SSH sessions, one per terminal tab (LT-320).
//!
//! The app could already log into a device, run a command and read the answer
//! back. That is not the same thing as being *at* a device: the operator asked
//! for what SecureCRT gives him — right-click a device, get a shell, and have
//! every shell he has open sitting as tabs beside each other.
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
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

use coreview_discover::ssh::{Shell, SshError, SshOptions};

use crate::commands::AppState;

type CmdResult<T> = Result<T, String>;

/// What the window asks a live session to do.
enum Instruction {
    Send(Vec<u8>),
    Resize(u32, u32),
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
}

/// Opens a shell on a device and returns the id of the session.
///
/// The credential comes out of the vault by id, exactly as a crawl's does, and
/// its use is recorded the same way (LT-264). Nothing is typed into this
/// command: a password never crosses the IPC boundary.
#[tauri::command]
pub async fn ssh_open(
    app: AppHandle,
    state: State<'_, AppState>,
    address: String,
    credential_id: String,
    port: Option<u16>,
    cols: Option<u32>,
    rows: Option<u32>,
) -> CmdResult<String> {
    state.limiter.allow(crate::ratelimit::Job::SshSession)?;
    let address = address.trim().to_string();
    if address.is_empty() {
        return Err("That device has no address to connect to.".into());
    }

    let credentials = crate::vault_commands::ssh_credentials(&state, &credential_id)?;
    crate::vault_commands::note_use(&state, &credential_id, "SSH session", &address);
    let store = crate::discovery::load_host_keys(&state)?;

    let options = SshOptions {
        port: port.unwrap_or(22),
        ..SshOptions::default()
    };

    let mut shell = Shell::open(
        &address,
        &credentials,
        options,
        Arc::clone(&store),
        cols.unwrap_or(120),
        rows.unwrap_or(30),
        None,
    )
    .await
    .map_err(describe)?;
    crate::discovery::persist_host_keys(&app, &store);

    let id = format!("ssh-{}", uuid::Uuid::new_v4());
    let (to_device, mut instructions) = mpsc::channel::<Instruction>(64);

    let emitter = app.clone();
    let session_id = id.clone();
    // The task holds the registry itself rather than reaching back through the
    // app handle: a session whose task has ended must come out of the map, or
    // the next send to it waits forever on a channel nobody is reading.
    let registry = Arc::clone(&state.sessions);
    tauri::async_runtime::spawn(async move {
        let reason = loop {
            tokio::select! {
                // Bytes from the device go straight to the window.
                chunk = shell.read() => match chunk {
                    Some(bytes) => {
                        let _ = emitter.emit("coreview://ssh", SessionEvent::Data {
                            id: session_id.clone(),
                            bytes: base64::engine::general_purpose::STANDARD.encode(&bytes),
                        });
                    }
                    None => break "The device closed the session.".to_string(),
                },
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
