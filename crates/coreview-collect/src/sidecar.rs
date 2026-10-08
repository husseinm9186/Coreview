//! The JSON-lines client for the sidecar (`sidecar/coreview_sidecar/protocol.py`
//! is the other half). One process, spawned from a path the caller resolved
//! — the install directory in production, a venv in development — with
//! requests on stdin and responses and events on stdout. Secrets go down
//! stdin inside `open` and nowhere else: never argv, never the environment.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};

/// Where the sidecar's interpreter is and how to start it.
#[derive(Debug, Clone)]
pub struct SidecarLocation {
    /// The interpreter: `<resources>/sidecar/python.exe` installed, or a venv's `python` in development.
    pub python: PathBuf,
    /// The directory holding the `coreview_sidecar` package (`-m` finds it from here).
    pub cwd: PathBuf,
    /// `resources/templates/ntc` — sent in `hello`.
    pub templates_dir: PathBuf,
}

#[derive(Debug, Error)]
pub enum SidecarError {
    #[error("the sidecar could not be started: {0}")]
    Spawn(std::io::Error),
    #[error("the sidecar closed its output")]
    Closed,
    #[error("the sidecar answered something that is not JSON: {0}")]
    BadLine(String),
    #[error("the sidecar did not answer within {0:?}")]
    Timeout(Duration),
    /// A command timed out on the device and the SSH session closed
    /// with it; the sidecar itself is fine and keeps serving.
    #[error("the device's session closed after a command timed out")]
    SessionGone,
    #[error("the sidecar refused: {0}")]
    Protocol(String),
}

/// One answer from the sidecar, as the contract defines it.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct Reply {
    pub id: Value,
    pub status: String,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub device: Option<String>,
    #[serde(default)]
    pub cmd: Option<String>,
    #[serde(default)]
    pub rows: Vec<Value>,
    #[serde(default)]
    pub raw: String,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub error: Option<String>,
    /// Anything else the sidecar put beside the contract's fields (`prompt`, `contexts`, versions).
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// An `event` line: a log line or a host key seen.
#[derive(Debug, Clone, Deserialize)]
pub struct Event {
    pub event: String,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// A login, as the sidecar's `open` wants it. Deliberately not `Debug`.
#[derive(Clone, Serialize)]
pub struct Auth {
    pub username: String,
    pub password: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private_key: Option<String>,
}

/// The few variables the interpreter needs from the parent. The rest of
/// the environment is not passed: nothing of the operator's reaches the
/// sidecar but what it needs to run. On Windows, Python cannot open a
/// socket or seed its random source without `SYSTEMROOT` (WSAStartup fails
/// with 10106), and paramiko reads `USERPROFILE` for `~`.
fn inherited_env() -> Vec<(String, String)> {
    let keep: &[&str] = if cfg!(windows) {
        &["PATH", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]
    } else {
        &["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]
    };
    keep.iter().filter_map(|k| std::env::var(k).ok().map(|v| ((*k).to_string(), v))).collect()
}

pub struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>>,
    events: mpsc::UnboundedReceiver<Event>,
    /// Kept so a caller can drain events after the fact.
    pub hello: Option<Reply>,
}

impl Sidecar {
    /// Start the process and say hello. Fails if it cannot start or does not
    /// answer within ten seconds — a wrong interpreter path shows up here,
    /// not on the first device.
    pub async fn spawn(location: &SidecarLocation) -> Result<Sidecar, SidecarError> {
        let mut command = Command::new(&location.python);
        // The interpreter is a console program; started from a windowed
        // app, Windows gives it a console window of its own unless told not to.
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = command
            .arg("-m")
            .arg("coreview_sidecar")
            .current_dir(&location.cwd)
            .env_clear()
            .envs(inherited_env())
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            // Only the interpreter's own folder and its ._pth decide what is imported.
            .env("PYTHONNOUSERSITE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(SidecarError::Spawn)?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>> = Arc::default();
        let (event_tx, events) = mpsc::unbounded_channel();
        let reader_pending = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                if value.get("event").is_some() {
                    if let Ok(ev) = serde_json::from_value::<Event>(value) {
                        let _ = event_tx.send(ev);
                    }
                    continue;
                }
                let Ok(reply) = serde_json::from_value::<Reply>(value) else { continue };
                let id = reply.id.as_u64();
                if let Some(id) = id {
                    if let Some(tx) = reader_pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(reply);
                    }
                }
            }
            // The process went away: every waiter learns it.
            reader_pending.lock().unwrap().clear();
        });
        let mut sidecar = Sidecar { child, stdin, next_id: AtomicU64::new(1), pending, events, hello: None };
        let hello = sidecar
            .request(json!({"op": "hello", "protocol": 1, "templates_dir": location.templates_dir.to_string_lossy()}), Duration::from_secs(10))
            .await?;
        if hello.status != "ok" {
            return Err(SidecarError::Protocol(hello.error.unwrap_or_else(|| "hello failed".into())));
        }
        sidecar.hello = Some(hello);
        Ok(sidecar)
    }

    /// Send one request and wait for its answer. `body` must not carry `id`.
    pub async fn request(&mut self, mut body: Value, timeout: Duration) -> Result<Reply, SidecarError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        body["id"] = json!(id);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut line = serde_json::to_string(&body).map_err(|e| SidecarError::Protocol(e.to_string()))?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await.map_err(|_| SidecarError::Closed)?;
        self.stdin.flush().await.map_err(|_| SidecarError::Closed)?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => Ok(reply),
            Ok(Err(_)) => Err(SidecarError::Closed),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(SidecarError::Timeout(timeout))
            }
        }
    }

    // Ten arguments because that is what `open` carries; a struct would only move the names.
    #[allow(clippy::too_many_arguments)]
    /// Open a session. `known_host_key` is the fingerprint Coreview's store
    /// holds for this host: the sidecar checks the presented key
    /// against it before any credential is sent and answers `host_key` on a
    /// mismatch. `None` is first contact; the reply's `host_key` is then the
    /// key to remember.
    #[allow(clippy::too_many_arguments)] // one request, every field of it
    pub async fn open(&mut self, session: &str, host: &str, port: u16, os: &str, auth: &Auth, session_spec: &Value, connect_ms: u64, auth_ms: u64, known_host_key: Option<&str>, transport: &str) -> Result<Reply, SidecarError> {
        let body = json!({
            "op": "open", "session": session, "host": host, "port": port, "os": os,
            "auth": auth, "session_spec": session_spec,
            "timeouts": {"connect_ms": connect_ms, "auth_ms": auth_ms},
            "known_host_key": known_host_key,
            // "ssh" or "telnet".
            "transport": transport,
        });
        self.request(body, Duration::from_millis(connect_ms + auth_ms + 30_000)).await
    }

    /// Send one command. **The read-only guard lives here**: every
    /// command that leaves Rust for a device passes through this method,
    /// and one the allowlist refuses is answered `refused` without a byte
    /// written to the process — whatever built it, catalog or not.
    pub async fn run(&mut self, session: &str, cmd: &str, parser: &str, also: &[String], timeout_ms: u64) -> Result<Reply, SidecarError> {
        if let coreview_catalog::Verdict::Refused(reason) = coreview_catalog::verdict(cmd) {
            return Ok(Reply {
                id: Value::Null,
                status: "refused".into(),
                session: Some(session.to_string()),
                cmd: Some(cmd.to_string()),
                error: Some(format!("refused by the read-only allowlist: {reason}")),
                ..Default::default()
            });
        }
        let body = json!({"op": "run", "session": session, "cmd": cmd, "parser": parser, "also": also, "timeout_ms": timeout_ms});
        self.request(body, Duration::from_millis(timeout_ms + 15_000)).await
    }

    pub async fn switch(&mut self, session: &str, kind: &str, name: Option<&str>) -> Result<Reply, SidecarError> {
        let body = json!({"op": "switch", "session": session, "context": {"kind": kind, "name": name}});
        self.request(body, Duration::from_secs(45)).await
    }

    pub async fn parse(&mut self, os: &str, cmd: &str, parser: &str, also: &[String], raw: &str) -> Result<Reply, SidecarError> {
        let body = json!({"op": "parse", "os": os, "cmd": cmd, "parser": parser, "also": also, "raw": raw});
        self.request(body, Duration::from_secs(60)).await
    }

    pub async fn close(&mut self, session: &str) -> Result<Reply, SidecarError> {
        self.request(json!({"op": "close", "session": session}), Duration::from_secs(45)).await
    }

    /// Ask it to quit, then make sure it did.
    pub async fn quit(mut self) {
        let _ = self.request(json!({"op": "quit"}), Duration::from_secs(10)).await;
        let _ = tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await;
        let _ = self.child.kill().await;
    }

    /// Events that have arrived so far (log lines, host keys), oldest first.
    pub fn drain_events(&mut self) -> Vec<Event> {
        let mut out = Vec::new();
        while let Ok(ev) = self.events.try_recv() {
            out.push(ev);
        }
        out
    }
}
