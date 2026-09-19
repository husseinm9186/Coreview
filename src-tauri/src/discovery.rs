//! IPC for crawling and backing up devices.
//!
//! The rule this module exists to enforce: **credentials arrive per run and are
//! never stored.** They come in as command arguments, live in memory for the
//! length of one crawl or one backup, and go away with it. Nothing here writes
//! a password anywhere, and nothing here can hand one back to the interface —
//! the frontend sends them and never receives them.
//!
//! Host key fingerprints are the exception, and are not secret: a public key
//! fingerprint is what you would read out over the phone to verify a device.

use std::sync::Arc;

use coreview_discover::backup::BackupKind;
use coreview_discover::capture::{run_backups, BackupOptions, BackupTarget};
use coreview_discover::crawl::{crawl_from, CrawlEvent, CrawlOptions};
use coreview_discover::filter::DiscoveryFilter;
use coreview_discover::hostkeys::{host_id, HostKeyStore};
use coreview_discover::snmp::{AuthKind, PrivKind, SnmpAuth};
use coreview_discover::ssh::{Credentials, Secret, SshOptions};
use coreview_discover::types::{AddressPreference, DeviceClass};
use coreview_probe::sweep::parse_cidr;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;

use crate::commands::AppState;
use crate::db;

type CmdResult<T> = Result<T, String>;

fn db_err(e: impl std::fmt::Display) -> String {
    format!("Local database error: {e}")
}

/// Credentials as they arrive from the interface.
///
/// Deliberately not `Debug`: the whole point is that this never reaches a log
/// line. It is converted to the transport's `Credentials` immediately, where
/// the password lives inside a `Secret`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialInput {
    pub username: String,
    pub password: String,
    pub enable_password: Option<String>,
}

impl From<CredentialInput> for Credentials {
    fn from(v: CredentialInput) -> Self {
        Credentials {
            username: v.username,
            password: Secret::new(v.password),
            enable_password: v
                .enable_password
                .filter(|p| !p.is_empty())
                .map(Secret::new),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CrawlInput {
    /// One seed or several (LT-207): addresses, hostnames and CIDR ranges,
    /// separated by commas, spaces or new lines.
    pub seed: String,
    /// Subnets the crawl may dial into. Empty means no limit, which is rarely
    /// what anyone wants — a crawl with no subnet limit follows a WAN link out
    /// of the estate.
    pub subnets: Vec<String>,
    /// Device classes worth logging into. Empty falls back to infrastructure.
    pub crawl_classes: Vec<String>,
    pub max_hops: usize,
    pub max_devices: usize,
    pub second_factor: bool,
    pub address_preference: String,
    /// Named interface, when `address_preference` is "interface".
    pub interface_name: Option<String>,
    pub port: u16,
    /// "ssh", "telnet", or "sshThenTelnet". Absent means SSH.
    pub transport: Option<String>,
    /// Which VDOM to enter on a FortiGate that has them enabled. Absent means
    /// `root`, which is where a management VDOM usually is.
    pub vdom: Option<String>,
    /// Optional SNMP credentials, used only for devices that refuse SSH.
    /// SNMP credentials typed for this run. A list since LT-142: v2c and v3
    /// can be mixed, and each is tried in turn.
    #[serde(default)]
    pub snmp: Vec<SnmpInput>,
    /// A saved credential to use instead of typed ones. The interface sends an
    /// id; the password is fetched inside Rust and never travels.
    pub credential_id: Option<String>,
    /// Saved SNMP credentials, likewise by reference. A list, for the same
    /// reason as `snmp`.
    #[serde(default)]
    pub snmp_credential_ids: Vec<String>,
    /// LT-200–204: which extra tables to read. Absent reads all of them.
    #[serde(default)]
    pub details: coreview_discover::crawl::DetailOptions,
    /// LT-199, LT-209: saved credentials bound to devices, subnets or vendors.
    #[serde(default)]
    pub bindings: Vec<BindingInput>,
    /// LT-206: look up PTR names for what was found. Absent means yes.
    #[serde(default = "yes")]
    pub reverse_dns: bool,
    /// LT-208: devices at once, the per-device limit in seconds, and retries.
    /// Absent means 4, 300 and 1.
    pub concurrency: Option<usize>,
    pub per_host_timeout_secs: Option<u64>,
    pub retries: Option<u32>,
}

fn yes() -> bool {
    true
}

/// LT-199, LT-209: a saved credential bound to a device, a subnet or a vendor.
/// Only the vault id travels; the secret is opened inside Rust.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingInput {
    /// "device", "subnet" or "vendor".
    pub scope: String,
    /// An address or hostname, a CIDR, or a vendor word.
    pub value: String,
    pub credential_id: String,
}

/// Opens each binding's credential. A binding whose scope does not parse is
/// dropped; one whose credential cannot be opened is an error, so a run never
/// silently skips a login the operator bound on purpose.
/// LT-264: the saved credentials a crawl offers, by kind, and the bindings
/// that decide which devices each is offered to.
struct OfferedCredentials {
    ssh: Option<String>,
    snmp: Vec<String>,
    bound: Vec<(coreview_discover::bindings::Scope, String, String)>,
}

impl OfferedCredentials {
    fn of(state: &AppState, ssh: &Option<String>, snmp: &[String], bindings: &[(String, String, String)]) -> Self {
        let bound = bindings
            .iter()
            .filter_map(|(scope, value, id)| {
                let scope = coreview_discover::bindings::Scope::parse(scope.trim(), value)?;
                let kind = crate::vault_commands::credential_kind(state, id).ok()?;
                Some((scope, id.clone(), kind))
            })
            .collect();
        Self { ssh: ssh.clone(), snmp: snmp.to_vec(), bound }
    }

    /// The credentials offered to a device, by how it was reached.
    fn for_device(&self, d: &coreview_discover::crawl::CrawledDevice) -> Vec<String> {
        use coreview_discover::crawl::ReachedBy;
        let kind = match d.reached_by {
            ReachedBy::Ssh => "ssh",
            ReachedBy::Snmp => "snmp",
            ReachedBy::Reported => return Vec::new(),
        };
        let target = coreview_discover::bindings::Target { address: &d.address, hostname: Some(&d.hostname), platform: d.platform.as_deref() };
        let mut ids: Vec<String> = match kind {
            "ssh" => self.ssh.iter().cloned().collect(),
            _ => self.snmp.clone(),
        };
        for (scope, id, k) in &self.bound {
            if (k == kind || (kind == "ssh" && k != "snmp")) && coreview_discover::bindings::scope_matches(scope, &target) && !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        ids
    }
}

fn resolve_bindings(state: &AppState, inputs: &[BindingInput]) -> CmdResult<Vec<coreview_discover::bindings::Binding>> {
    use coreview_discover::bindings::{Binding, Scope};
    let mut out = Vec::new();
    for b in inputs {
        let Some(scope) = Scope::parse(b.scope.trim(), &b.value) else { continue };
        let kind = crate::vault_commands::credential_kind(state, &b.credential_id)?;
        out.push(match kind.as_str() {
            "snmp" => Binding { scope, ssh: None, snmp: Some(crate::vault_commands::snmp_credentials(state, &b.credential_id)?) },
            _ => Binding { scope, ssh: Some(crate::vault_commands::ssh_credentials(state, &b.credential_id)?), snmp: None },
        });
    }
    Ok(out)
}

/// SNMP credentials as the interface sends them.
///
/// Not `Debug`, for the same reason the SSH credentials are not: a community
/// string is a credential and belongs in no log line.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnmpInput {
    /// "v2c" or "v3".
    pub version: String,
    /// v2c only.
    pub community: Option<String>,
    /// v3 only.
    pub username: Option<String>,
    /// "sha", "md5", "sha256"...
    pub auth_protocol: Option<String>,
    pub auth_password: Option<String>,
    /// "aes 256", "aes", "des"; absent means authentication without privacy.
    pub privacy: Option<String>,
    pub privacy_password: Option<String>,
}

impl SnmpInput {
    /// Returns `None` rather than a half-built credential: SNMP is optional,
    /// and an incomplete v3 user would fail on every device with an error that
    /// looks like the devices are at fault.
    fn into_auth(self) -> Option<SnmpAuth> {
        match self.version.as_str() {
            "v2c" => self
                .community
                .filter(|c| !c.is_empty())
                .map(|community| SnmpAuth::V2c { community }),
            "v3" => {
                let username = self.username.filter(|u| !u.is_empty())?;
                let auth_password = self.auth_password.filter(|p| !p.is_empty())?;
                Some(SnmpAuth::V3 {
                    username,
                    auth_protocol: AuthKind::parse(self.auth_protocol.as_deref().unwrap_or("sha"))?,
                    auth_password,
                    privacy: self.privacy.as_deref().and_then(PrivKind::parse),
                    privacy_password: self.privacy_password.unwrap_or_default(),
                })
            }
            _ => None,
        }
    }
}

/// Chooses between a saved credential and typed ones.
///
/// The saved reference wins when given, because sending both is how a stale
/// typed password silently overrides the one the user just picked from a list.
/// Fetching happens here, inside Rust, so the password never travels either
/// way across the interface boundary.
fn resolve_ssh(
    state: &State<'_, AppState>,
    saved: Option<&str>,
    typed: CredentialInput,
) -> CmdResult<Credentials> {
    match saved {
        Some(id) => crate::vault_commands::ssh_credentials(state, id),
        None => Ok(typed.into()),
    }
}

/// Loads remembered host keys into a store the transport can use.
fn load_host_keys(state: &AppState) -> CmdResult<Arc<std::sync::Mutex<HostKeyStore>>> {
    let conn = state.db.lock().map_err(db_err)?;
    let pairs = db::all_host_keys(&conn).map_err(db_err)?;
    Ok(Arc::new(std::sync::Mutex::new(HostKeyStore::from_pairs(pairs))))
}

/// Writes back any key learned during a run.
///
/// Called once a run finishes rather than per connection, because the store is
/// the source of truth while a crawl is in flight and the database only needs
/// to agree with it by the end.
///
/// `remember_host_key` refuses to overwrite, so this cannot launder a changed
/// key into the database: a device whose key differed never reached the point
/// of being remembered anyway, because the connection was refused.
fn persist_host_keys(app: &AppHandle, store: &Arc<std::sync::Mutex<HostKeyStore>>) {
    use tauri::Manager;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let state = app.state::<AppState>();
    let Ok(conn) = state.db.lock() else { return };
    let Ok(guard) = store.lock() else { return };
    for (id, fingerprint) in guard.entries() {
        let _ = db::remember_host_key(&conn, id, fingerprint, now_ms);
    }
}

fn parse_classes(names: &[String]) -> Vec<DeviceClass> {
    names
        .iter()
        .filter_map(|n| {
            DeviceClass::ALL
                .iter()
                .find(|c| serde_json::to_string(c).ok().as_deref() == Some(&format!("\"{n}\"")))
                .copied()
        })
        .collect()
}

fn parse_preference(kind: &str, interface: Option<&str>) -> AddressPreference {
    match kind {
        "management" => AddressPreference::Management,
        "first" => AddressPreference::First,
        "interface" => AddressPreference::Interface {
            name: interface.unwrap_or_default().to_string(),
        },
        _ => AddressPreference::Loopback,
    }
}

/// Starts a crawl. Returns as soon as it is scheduled; everything else arrives
/// on `coreview://crawl`.
#[tauri::command]
pub async fn start_crawl(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CrawlInput,
    credentials: CredentialInput,
    // Tried in order when the first is rejected. One estate rarely has one
    // login: sites migrate between TACACS realms and appliances keep a local
    // account of their own.
    fallback_credentials: Option<Vec<CredentialInput>>,
) -> CmdResult<()> {
    state.limiter.allow(crate::ratelimit::Job::Crawl)?;
    // LT-264: which saved credentials this crawl offers, kept for the log.
    let input_credential_id = input.credential_id.clone();
    let input_snmp_ids = input.snmp_credential_ids.clone();
    let input_bindings: Vec<(String, String, String)> = input.bindings.iter().map(|b| (b.scope.clone(), b.value.clone(), b.credential_id.clone())).collect();
    let mut subnets = Vec::new();
    for s in &input.subnets {
        if s.trim().is_empty() {
            continue;
        }
        subnets.push(parse_cidr(s).map_err(|e| format!("{s}: {e}"))?);
    }

    let options = CrawlOptions {
        filter: DiscoveryFilter {
            subnets,
            crawl_classes: parse_classes(&input.crawl_classes),
            ..Default::default()
        },
        max_hops: input.max_hops.clamp(0, 32),
        max_devices: input.max_devices.clamp(1, 5_000),
        // LT-208. A push factor still logs in one at a time (the auth gate);
        // commands afterwards may overlap.
        concurrency: input.concurrency.unwrap_or(4).clamp(1, 32),
        per_host_timeout: std::time::Duration::from_secs(input.per_host_timeout_secs.unwrap_or(300).clamp(30, 1_800)),
        retries: input.retries.unwrap_or(1).min(3),
        second_factor: input.second_factor,
        address_preference: parse_preference(&input.address_preference, input.interface_name.as_deref()),
        ssh: SshOptions {
            port: input.port,
            ..SshOptions::default()
        },
        transport: match input.transport.as_deref() {
            Some("telnet") => coreview_discover::crawl::Transport::Telnet,
            Some("sshThenTelnet") => coreview_discover::crawl::Transport::SshThenTelnet,
            // Anything unrecognised is SSH. Falling back to telnet because a
            // string was misspelled would put credentials on the wire in
            // clear text without anyone asking for it.
            _ => coreview_discover::crawl::Transport::Ssh,
        },
        vdom: input
            .vdom
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or("root")
            .to_string(),
        fallback_credentials: fallback_credentials
            .unwrap_or_default()
            .into_iter()
            // A set with no username is an empty form, not a credential.
            .filter(|c| !c.username.trim().is_empty())
            .map(Credentials::from)
            .collect(),
        // Saved credentials first, then typed ones: a reference the operator
        // picked from a list is a deliberate choice, and a form left filled
        // in from last time is not. Every one that resolves is kept, because
        // trying several is the point (LT-142).
        snmp: {
            let mut all = Vec::new();
            for id in &input.snmp_credential_ids {
                all.push(crate::vault_commands::snmp_credentials(&state, id)?);
            }
            all.extend(input.snmp.into_iter().filter_map(SnmpInput::into_auth));
            all
        },
        details: input.details,
        bindings: resolve_bindings(&state, &input.bindings)?,
        ..CrawlOptions::default()
    };

    let offered = OfferedCredentials::of(&state, &input_credential_id, &input_snmp_ids, &input_bindings);
    let store = load_host_keys(&state)?;
    let token = CancellationToken::new();
    {
        let mut slot = state.crawl_cancel.lock().map_err(db_err)?;
        if let Some(previous) = slot.replace(token.clone()) {
            previous.cancel();
        }
    }

    let (tx, mut rx) = tokio::sync::mpsc::channel(1024);
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            // LT-264: every device reached, against the saved credentials this
            // crawl offered it — the chosen ones and the bindings that match it.
            if let CrawlEvent::Reached(device) = &event {
                use tauri::Manager;
                let state = emitter.state::<AppState>();
                for id in offered.for_device(device) {
                    crate::vault_commands::note_use(&state, &id, "Crawl", &format!("{} ({})", device.hostname, device.address));
                }
            }
            let _ = emitter.emit("coreview://crawl", &event);
        }
    });

    let seed = input.seed;
    let reverse_dns = input.reverse_dns;
    let credentials = resolve_ssh(&state, input.credential_id.as_deref(), credentials)?;
    let persist_store = Arc::clone(&store);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // LT-207: addresses, names and ranges, resolved and narrowed to what
        // answers on the login port; what could not be used is reported.
        let (parsed, mut skipped) = coreview_discover::seeds::parse_seeds(&seed);
        let (seeds, more) = coreview_discover::seeds::resolve_seeds(&parsed, options.ssh.port, |a| {
            options.filter.subnets.is_empty() || options.filter.allows_address(a)
        })
        .await;
        skipped.extend(more);
        for s in skipped {
            let _ = tx.send(CrawlEvent::Skipped { name: s.seed, reason: s.reason }).await;
        }
        let mut result = crawl_from(&seeds, credentials, options, store, tx, token).await;
        // LT-206: names from reverse DNS where nothing else named a device.
        if reverse_dns && !result.cancelled {
            coreview_discover::ptr::enrich_names(&mut result, |ip| {
                coreview_probe::sweep::reverse_name(ip, 1_500)
            })
            .await;
        }
        // Emitted separately from the event stream because it carries the
        // neighbours that were seen but never visited, which no single event
        // contains.
        // Before the result, so a host key learned on the last device is
        // already durable by the time the interface reacts.
        persist_host_keys(&handle, &persist_store);
        let _ = handle.emit(
            "coreview://crawl-result",
            serde_json::json!({
                "devices": result.devices,
                "notVisited": result.not_visited,
                "failures": result.failures,
                "cancelled": result.cancelled,
            }),
        );
    });

    Ok(())
}

/// LT-225: can `device` reach `target`? Asked of the device itself, over SSH
/// with a saved credential, with its own ping. The target must be an IPv4
/// address; it is parsed before it goes anywhere near a command line.
#[tauri::command]
pub async fn ping_from_device(
    app: AppHandle,
    state: State<'_, AppState>,
    device: String,
    credential_id: String,
    target: String,
    count: Option<u32>,
) -> CmdResult<coreview_discover::pathcheck::PingFromDevice> {
    state.limiter.allow(crate::ratelimit::Job::DevicePing)?;
    let target: std::net::Ipv4Addr = target
        .trim()
        .parse()
        .map_err(|_| format!("{} is not an IPv4 address", target.trim()))?;
    let credentials = crate::vault_commands::ssh_credentials(&state, &credential_id)?;
    crate::vault_commands::note_use(&state, &credential_id, "Ping from a device", device.trim());
    let store = load_host_keys(&state)?;
    let mut session = coreview_discover::ssh::Device::connect(
        device.trim(),
        &credentials,
        SshOptions::default(),
        Arc::clone(&store),
        None,
    )
    .await
    .map_err(|e| e.to_string())?;
    let output = session
        .run(&coreview_discover::pathcheck::ping_command(target, count.unwrap_or(3)))
        .await
        .map_err(|e| e.to_string());
    session.close().await;
    persist_host_keys(&app, &store);
    let output = output?;
    coreview_discover::pathcheck::parse_ios_ping(&output)
        .ok_or_else(|| format!("{} did not report a result: {}", device.trim(), output.lines().last().unwrap_or("").trim()))
}

#[tauri::command]
pub fn cancel_crawl(state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(token) = state.crawl_cancel.lock().map_err(db_err)?.take() {
        token.cancel();
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupInput {
    /// A saved credential to use instead of typed ones.
    pub credential_id: Option<String>,
    pub targets: Vec<BackupTarget>,
    /// "running", "startup", or both.
    pub kinds: Vec<String>,
    pub second_factor: bool,
    pub port: u16,
    /// Show commands run on every selected device (LT-149).
    #[serde(default)]
    pub show_commands: Vec<String>,
    /// How to stop paging first: "auto", "cisco-asa", "palo-alto" and so on.
    #[serde(default)]
    pub paging: Option<String>,
    /// How capture files are named (LT-151); blank or absent is the default.
    #[serde(default)]
    pub file_pattern: Option<String>,
}

/// Backs up the given devices into the chosen backup folder.
#[tauri::command]
pub async fn start_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    input: BackupInput,
    credentials: CredentialInput,
    stamp: String,
) -> CmdResult<()> {
    state.limiter.allow(crate::ratelimit::Job::Backup)?;
    let root = {
        let conn = state.db.lock().map_err(db_err)?;
        db::all_settings(&conn)
            .map_err(db_err)?
            .get("backupFolder")
            .cloned()
    }
    .ok_or("Choose a backup folder before backing anything up.")?;

    let kinds: Vec<BackupKind> = input
        .kinds
        .iter()
        .filter_map(|k| match k.as_str() {
            "startup" => Some(BackupKind::Startup),
            "running" => Some(BackupKind::Running),
            _ => None,
        })
        .collect();
    if input.targets.is_empty() {
        return Err("Choose at least one device to back up.".into());
    }

    // LT-149. Checked here, before a single connection is opened, so a list
    // with a `reload` in it is refused as a whole rather than half-run. The
    // capture loop checks again, because it is a public function too.
    let every_command: Vec<String> = input
        .show_commands
        .iter()
        .cloned()
        .chain(input.targets.iter().flat_map(|t| t.commands.iter().cloned()))
        .collect();
    let refused = coreview_discover::showcmd::refused(&every_command);
    if !refused.is_empty() {
        let list = refused
            .iter()
            .map(|(c, why)| format!("`{c}` — {why}"))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!("Nothing was run. Only commands that read are allowed: {list}"));
    }
    let wants_show = every_command.iter().any(|c| !c.trim().is_empty());
    if kinds.is_empty() && !wants_show {
        return Err("Choose a configuration to capture, or give at least one show command.".into());
    }
    let paging = match input.paging.as_deref() {
        None => coreview_discover::showcmd::Paging::Auto,
        Some(word) => coreview_discover::showcmd::Paging::parse(word)
            .ok_or_else(|| format!("Unknown paging choice: {word}"))?,
    };

    // LT-151. A pattern that would overwrite captures, or has a typo in a
    // token, refuses the run before anything connects.
    let file_pattern = input
        .file_pattern
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string);
    if let Some(p) = &file_pattern {
        coreview_discover::backup::check_pattern(p).map_err(|why| format!("Nothing was run: {why}."))?;
    }

    let options = BackupOptions {
        root: root.into(),
        kinds,
        ssh: SshOptions {
            port: input.port,
            ..SshOptions::default()
        },
        second_factor: input.second_factor,
        show: wants_show.then(|| coreview_discover::capture::ShowPlan {
            commands: input.show_commands.clone(),
            paging,
        }),
        file_pattern,
    };

    let store = load_host_keys(&state)?;
    let token = CancellationToken::new();
    {
        let mut slot = state.backup_cancel.lock().map_err(db_err)?;
        if let Some(previous) = slot.replace(token.clone()) {
            previous.cancel();
        }
    }

    let (tx, mut rx) = tokio::sync::mpsc::channel(1024);
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = emitter.emit("coreview://backup", &event);
        }
    });

    let credentials = resolve_ssh(&state, input.credential_id.as_deref(), credentials)?;
    let targets = input.targets;
    if let Some(id) = input.credential_id.as_deref() {
        for t in &targets {
            crate::vault_commands::note_use(&state, id, "Configuration backup", &format!("{} ({})", t.name, t.address));
        }
    }
    let persist_store = Arc::clone(&store);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        run_backups(targets, credentials, options, store, stamp, tx, token).await;
        persist_host_keys(&handle, &persist_store);
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_backup(state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(token) = state.backup_cancel.lock().map_err(db_err)?.take() {
        token.cancel();
    }
    Ok(())
}

// ------------------------------------------------------------ backup browsing

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupDevice {
    pub name: String,
    pub captures: usize,
    /// Newest capture, as its filename. Sortable, because the names begin with
    /// a timestamp.
    pub latest: Option<String>,
}

fn backup_root(state: &State<'_, AppState>) -> CmdResult<std::path::PathBuf> {
    let conn = state.db.lock().map_err(db_err)?;
    let root = db::all_settings(&conn)
        .map_err(db_err)?
        .get("backupFolder")
        .cloned()
        .ok_or("No backup folder has been chosen yet.")?;
    Ok(root.into())
}

/// Every device with backups, for the browser.
#[tauri::command]
pub fn list_backup_devices(state: State<'_, AppState>) -> CmdResult<Vec<BackupDevice>> {
    let root = backup_root(&state)?;
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Ok(Vec::new());
    };

    let mut devices: Vec<BackupDevice> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let captures = coreview_discover::capture::list_captures(&root, &name, "");
            BackupDevice {
                latest: captures
                    .first()
                    .and_then(|p| p.file_name())
                    .map(|f| f.to_string_lossy().to_string()),
                captures: captures.len(),
                name,
            }
        })
        .filter(|d| d.captures > 0)
        .collect();
    devices.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(devices)
}

/// Every capture for one device, newest first, as filenames.
#[tauri::command]
pub fn list_device_captures(state: State<'_, AppState>, device: String) -> CmdResult<Vec<String>> {
    let root = backup_root(&state)?;
    Ok(coreview_discover::capture::list_captures(&root, &device, "")
        .into_iter()
        .filter_map(|p| p.file_name().map(|f| f.to_string_lossy().to_string()))
        .collect())
}

/// Reads one capture.
///
/// Takes a device and a filename rather than a path, so the interface cannot
/// name a file outside the backup folder — the same reason the writer builds
/// its own paths instead of accepting them.
#[tauri::command]
pub fn read_capture(
    state: State<'_, AppState>,
    device: String,
    filename: String,
) -> CmdResult<String> {
    let root = backup_root(&state)?;
    let path = capture_path(&root, &device, &filename)?;
    std::fs::read_to_string(&path).map_err(|e| format!("Could not read {}: {e}", path.display()))
}

/// Compares two captures of one device.
#[tauri::command]
pub fn diff_captures(
    state: State<'_, AppState>,
    device: String,
    before: String,
    after: String,
) -> CmdResult<Vec<coreview_discover::capture::DiffLine>> {
    let root = backup_root(&state)?;
    let a = std::fs::read_to_string(capture_path(&root, &device, &before)?).map_err(|e| e.to_string())?;
    let b = std::fs::read_to_string(capture_path(&root, &device, &after)?).map_err(|e| e.to_string())?;
    Ok(coreview_discover::capture::diff(&a, &b))
}

/// Every backup run, newest first, for the before-and-after picker (LT-152).
#[tauri::command]
pub fn list_backup_runs(state: State<'_, AppState>) -> CmdResult<Vec<coreview_discover::compare::RunSummary>> {
    let root = backup_root(&state)?;
    Ok(coreview_discover::compare::list_runs(&root))
}

/// Two runs compared device by device, and command by command for show
/// commands (LT-152). Takes stamps, never paths; a stamp that is not the
/// shape of one is refused before anything is read.
#[tauri::command]
pub fn compare_backup_runs(
    state: State<'_, AppState>,
    before: String,
    after: String,
) -> CmdResult<Vec<coreview_discover::compare::DeviceComparison>> {
    let root = backup_root(&state)?;
    coreview_discover::compare::compare_runs(&root, &before, &after)
}

/// Runs checks against one run's show-command captures (LT-153). Reads files
/// only; the checks are the operator's own, sent from the Backups tab.
#[tauri::command]
pub fn run_backup_checks(
    state: State<'_, AppState>,
    stamp: String,
    checks: Vec<coreview_discover::checks::Check>,
) -> CmdResult<Vec<coreview_discover::checks::CheckResult>> {
    let root = backup_root(&state)?;
    coreview_discover::checks::run_checks(&root, &stamp, &checks)
}

/// One entry of a gateway's ARP table, with the manufacturer behind its MAC.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayArpEntry {
    pub ip: String,
    pub mac: String,
    pub vendor: Option<String>,
}

/// Reads a gateway's ARP table over SNMP with a saved credential (LT-124).
///
/// The optional step after a ping sweep: a sweep reads MAC addresses only from
/// this machine's own ARP table, which never holds a host behind a router. The
/// gateway's does. Run only when the operator picks a saved SNMP credential
/// and asks — the sweep itself stays credential-free.
#[tauri::command]
pub async fn read_gateway_arp(
    state: State<'_, AppState>,
    gateway: String,
    credential_id: String,
) -> CmdResult<Vec<GatewayArpEntry>> {
    let address: std::net::Ipv4Addr = gateway
        .trim()
        .parse()
        .map_err(|_| format!("`{}` is not an IPv4 address.", gateway.trim()))?;
    let auth = crate::vault_commands::snmp_credentials(&state, &credential_id)?;
    crate::vault_commands::note_use(&state, &credential_id, "Gateway ARP table", &address.to_string());
    let entries = coreview_discover::snmp::arp_table(
        &address.to_string(),
        161,
        &auth,
        std::time::Duration::from_secs(4),
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(entries
        .into_iter()
        .map(|e| {
            let vendor = if coreview_probe::neighbour::is_locally_administered(&e.mac) {
                None
            } else {
                coreview_probe::oui::vendor(&e.mac).map(str::to_string)
            };
            GatewayArpEntry { ip: e.ip.to_string(), mac: e.mac, vendor }
        })
        .collect())
}

/// Builds a path inside the backup folder from a device and a filename, and
/// refuses anything that would land outside it.
///
/// Both components are sanitised rather than trusted. They reach here from the
/// interface, which got them from a listing — but a listing is not a
/// guarantee, and this is the only place a caller-supplied name becomes a path.
fn capture_path(
    root: &std::path::Path,
    device: &str,
    filename: &str,
) -> CmdResult<std::path::PathBuf> {
    let device = coreview_discover::backup::safe_component(device)
        .ok_or("That is not a device name Coreview would have filed a backup under.")?;
    let filename = coreview_discover::backup::safe_component(filename)
        .ok_or("That is not a capture filename.")?;
    let path = root.join(device).join(filename);
    if !coreview_discover::backup::is_inside(root, &path) {
        return Err("That path is outside the backup folder.".into());
    }
    Ok(path)
}

// --------------------------------------------------------------- host keys

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyRow {
    pub host: String,
    pub fingerprint: String,
}

/// Every remembered host key, for the settings list.
#[tauri::command]
pub fn list_host_keys(state: State<'_, AppState>) -> CmdResult<Vec<HostKeyRow>> {
    let conn = state.db.lock().map_err(db_err)?;
    let mut rows: Vec<HostKeyRow> = db::all_host_keys(&conn)
        .map_err(db_err)?
        .into_iter()
        .map(|(host, fingerprint)| HostKeyRow { host, fingerprint })
        .collect();
    rows.sort_by(|a, b| a.host.cmp(&b.host));
    Ok(rows)
}

/// Forgets every remembered host key. Returns how many went, for the
/// confirmation message.
#[tauri::command]
pub fn clear_host_keys(state: State<'_, AppState>) -> CmdResult<usize> {
    let conn = state.db.lock().map_err(db_err)?;
    db::clear_host_keys(&conn).map_err(db_err)
}

/// Forgets one device's key, so the next connection is treated as first
/// contact. The narrower answer when a single switch was replaced.
#[tauri::command]
pub fn forget_host_key(state: State<'_, AppState>, host: String, port: u16) -> CmdResult<bool> {
    let conn = state.db.lock().map_err(db_err)?;
    let id = host_id(&host, port);
    // The list shows the stored id directly, so accept either form.
    let removed = db::forget_host_key(&conn, &host).map_err(db_err)?
        + db::forget_host_key(&conn, &id).map_err(db_err)?;
    Ok(removed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_class_names_from_the_interface_are_understood() {
        // The interface sends the kebab-case names serde produces, and a
        // mismatch here would silently mean "no classes selected", which
        // reads as the filter being ignored.
        let parsed = parse_classes(&[
            "router".into(),
            "switch".into(),
            "wireless-controller".into(),
            "access-point".into(),
        ]);
        assert_eq!(
            parsed,
            vec![
                DeviceClass::Router,
                DeviceClass::Switch,
                DeviceClass::WirelessController,
                DeviceClass::AccessPoint
            ]
        );
    }

    #[test]
    fn an_unknown_class_name_is_dropped_rather_than_guessed() {
        assert!(parse_classes(&["not-a-class".into()]).is_empty());
    }

    #[test]
    fn every_class_survives_a_round_trip_through_its_name() {
        // Guards against a class being added to the enum and quietly failing
        // to appear in the filter.
        for class in DeviceClass::ALL {
            let name = serde_json::to_string(&class).unwrap();
            let name = name.trim_matches('"').to_string();
            assert_eq!(
                parse_classes(std::slice::from_ref(&name)),
                vec![class],
                "{class:?} did not survive as {name:?}"
            );
        }
    }

    #[test]
    fn a_capture_path_cannot_escape_the_backup_folder() {
        // Both components arrive from the interface. It got them from a
        // listing, but a listing is not a guarantee, and this is the only
        // place a caller-supplied name becomes a path.
        let root = std::path::Path::new("/home/me/backups");
        for (device, file) in [
            ("../../../etc", "passwd"),
            ("SW1", "../../../etc/passwd"),
            ("..", ".."),
            ("SW1", "../../secrets.txt"),
        ] {
            match capture_path(root, device, file) {
                Err(_) => {}
                Ok(p) => assert!(
                    coreview_discover::backup::is_inside(root, &p),
                    "{device:?}/{file:?} produced {p:?}"
                ),
            }
        }
    }

    #[test]
    fn an_ordinary_capture_path_is_built_as_expected() {
        let root = std::path::Path::new("/home/me/backups");
        let p = capture_path(root, "CORE-SW-01", "20260828-101530-running-config.txt").unwrap();
        assert_eq!(
            p,
            std::path::Path::new("/home/me/backups/CORE-SW-01/20260828-101530-running-config.txt")
        );
    }

    #[test]
    fn incomplete_snmp_credentials_yield_nothing_rather_than_half_a_user() {
        // A half-built v3 user fails on every device with an error that reads
        // like the devices are at fault.
        let missing_password = SnmpInput {
            version: "v3".into(),
            community: None,
            username: Some("netops".into()),
            auth_protocol: Some("sha".into()),
            auth_password: None,
            privacy: None,
            privacy_password: None,
        };
        assert!(missing_password.into_auth().is_none());

        let empty_community = SnmpInput {
            version: "v2c".into(),
            community: Some(String::new()),
            username: None,
            auth_protocol: None,
            auth_password: None,
            privacy: None,
            privacy_password: None,
        };
        assert!(empty_community.into_auth().is_none());
    }

    #[test]
    fn a_complete_v3_user_is_built_from_the_words_a_configuration_uses() {
        // These come off an `snmp-server user` line verbatim.
        let input = SnmpInput {
            version: "v3".into(),
            community: None,
            username: Some("LABUSR".into()),
            auth_protocol: Some("sha".into()),
            auth_password: Some("secret".into()),
            privacy: Some("aes 256".into()),
            privacy_password: Some("secret".into()),
        };
        match input.into_auth() {
            Some(SnmpAuth::V3 { username, auth_protocol, privacy, .. }) => {
                assert_eq!(username, "LABUSR");
                assert_eq!(auth_protocol, AuthKind::Sha1, "IOS 'sha' is SHA-1");
                assert_eq!(privacy, Some(PrivKind::Aes256));
            }
            other => panic!("expected a v3 user, got {other:?}"),
        }
    }

    #[test]
    fn address_preferences_map_from_their_names() {
        assert_eq!(parse_preference("loopback", None), AddressPreference::Loopback);
        assert_eq!(parse_preference("management", None), AddressPreference::Management);
        assert_eq!(parse_preference("first", None), AddressPreference::First);
        assert_eq!(
            parse_preference("interface", Some("Vlan100")),
            AddressPreference::Interface { name: "Vlan100".into() }
        );
        // Anything unrecognised falls back to the safest default rather than
        // failing a long run over a typo.
        assert_eq!(parse_preference("nonsense", None), AddressPreference::Loopback);
    }
}

/// LT-246: a saved snmpwalk of one device, read into the record an SNMP crawl
/// builds. Pure text in, so nothing is contacted and nothing is stored.
#[tauri::command]
pub fn read_snmp_walk(text: String, address: Option<String>) -> coreview_discover::walkfile::WalkReading {
    coreview_discover::walkfile::read_walk(&text, address.as_deref())
}

/// LT-248: an Nmap XML report, read as ping-sweep rows.
#[tauri::command]
pub fn read_nmap_xml(text: String) -> Result<crate::nmap_import::NmapReport, String> {
    crate::nmap_import::read_nmap_xml(&text)
}
