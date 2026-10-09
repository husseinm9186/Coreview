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
    /// One seed or several: addresses, hostnames and CIDR ranges,
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
    /// SNMP credentials typed for this run. A list: v2c and v3
    /// can be mixed, and each is tried in turn.
    #[serde(default)]
    pub snmp: Vec<SnmpInput>,
    /// A saved credential to use instead of typed ones. The interface sends an
    /// id; the password is fetched inside Rust and never travels.
    pub credential_id: Option<String>,
    /// The project's other saved SSH logins, tried in order after the
    /// first when a device refuses it. By id; resolved from the vault here.
    #[serde(default)]
    pub fallback_credential_ids: Vec<String>,
    /// Saved SNMP credentials, likewise by reference. A list, for the same
    /// reason as `snmp`.
    #[serde(default)]
    pub snmp_credential_ids: Vec<String>,
    /// Which extra tables to read. Absent reads all of them.
    #[serde(default)]
    pub details: coreview_discover::crawl::DetailOptions,
    /// Saved credentials bound to devices, subnets or vendors.
    #[serde(default)]
    pub bindings: Vec<BindingInput>,
    /// Look up PTR names for what was found. Absent means yes.
    #[serde(default = "yes")]
    pub reverse_dns: bool,
    /// Devices at once, the per-device limit in seconds, and retries.
    /// Absent means 4, 300 and 1.
    pub concurrency: Option<usize>,
    pub per_host_timeout_secs: Option<u64>,
    pub retries: Option<u32>,
    /// The project the run is kept under, written device by device
    /// as the crawl goes. Absent means the run is not kept at all.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Write a debug log of this run. Off unless asked for — a log
    /// nobody asked for is a file nobody is guarding.
    #[serde(default)]
    pub debug_log: bool,
    /// Keep every identity command's reply, redacted, for support.
    #[serde(default)]
    pub support_capture: bool,
    /// "direct" (the default), "throughParent", or
    /// "throughParentThenDirect" — whether to reach each device straight from
    /// this machine, or by hopping through the device that found it.
    #[serde(default)]
    pub reach: Option<String>,
    /// The subnets whose scan box is ticked — each swept for the
    /// login port, and what answers logged into after the neighbours.
    #[serde(default)]
    pub scan_subnets: Vec<String>,
}

fn yes() -> bool {
    true
}

/// A saved credential bound to a device, a subnet or a vendor.
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
/// The saved credentials a crawl offers, by kind, and the bindings
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
        // A binding names a credential by id, and an id can go stale —
        // the credential was wiped, or this project was opened on a machine
        // whose vault never had it. **One stale binding used to fail the whole
        // crawl**, because a device somewhere on the diagram still pointed at
        // a deleted credential and `?` took the run down with it. A binding is
        // "try this one here" and is best-effort by construction, so one that
        // cannot be resolved is skipped and the run goes on.
        if !crate::vault_commands::credential_exists(state, &b.credential_id) {
            continue;
        }
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

/// Logs in to `device` with the chosen saved login, or, when the device
/// refuses it, with every other SSH login the open project keeps, in
/// `project_login_order`'s order. Each login sent is noted against its own
/// id; only a refusal moves on to the next.
pub async fn connect_with_project_logins(
    state: &AppState,
    device: &str,
    credential_id: &str,
    options: SshOptions,
    store: Arc<std::sync::Mutex<HostKeyStore>>,
    purpose: &str,
) -> CmdResult<coreview_discover::ssh::Device> {
    let chain = crate::vault_commands::ssh_login_chain(state, credential_id)?;
    let logins: Vec<Credentials> = chain.iter().map(|(_, c)| c.clone()).collect();
    let outcome = coreview_discover::ssh::connect_first_accepted(device, &logins, options, store, None).await;
    let sent = match &outcome {
        Ok((_, taken)) => taken + 1,
        Err(coreview_discover::ssh::SshError::AuthFailed { .. }) => chain.len(),
        Err(_) => 1,
    };
    for (i, (id, _)) in chain.iter().take(sent).enumerate() {
        let what = if i == 0 { purpose.to_string() } else { format!("{purpose} (fallback login)") };
        crate::vault_commands::note_use(state, id, &what, device);
    }
    outcome.map(|(session, _)| session).map_err(|e| e.to_string())
}

/// Loads remembered host keys into a store the transport can use.
pub fn load_host_keys(state: &AppState) -> CmdResult<Arc<std::sync::Mutex<HostKeyStore>>> {
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
pub fn persist_host_keys(app: &AppHandle, store: &Arc<std::sync::Mutex<HostKeyStore>>) {
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

pub(crate) fn parse_classes(names: &[String]) -> Vec<DeviceClass> {
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
    // Which saved credentials this crawl offers, kept for the log.
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

    let per_host_secs = input.per_host_timeout_secs.unwrap_or(300).clamp(30, 1_800);
    // The SNMP secrets, taken before the inputs below are moved into
    // the options, for the support capture's redaction.
    let snmp_secrets: Vec<String> = input
        .snmp
        .iter()
        .flat_map(|s| [s.community.clone(), s.auth_password.clone(), s.privacy_password.clone()])
        .flatten()
        .collect();
    let mut options = CrawlOptions {
        filter: DiscoveryFilter {
            subnets,
            crawl_classes: parse_classes(&input.crawl_classes),
            ..Default::default()
        },
        max_hops: input.max_hops.clamp(0, 32),
        max_devices: input.max_devices.clamp(1, 5_000),
        // A push factor still logs in one at a time (the auth gate);
        // commands afterwards may overlap.
        // Read once, because the SSH command timeout is derived from it.
        concurrency: input.concurrency.unwrap_or(4).clamp(1, 32),
        per_host_timeout: std::time::Duration::from_secs(per_host_secs),
        retries: input.retries.unwrap_or(1).min(3),
        second_factor: input.second_factor,
        address_preference: parse_preference(&input.address_preference, input.interface_name.as_deref()),
        ssh: SshOptions {
            port: input.port,
            // The inner timeout must fire before the outer budget.
            //
            // Both defaulted to 60 seconds and an operator can set the budget
            // from the panel while this one is not exposed at all. When the
            // budget wins, the failure is a sentence with nothing in it; when
            // this one wins, it is `SshError::CommandTimeout`, which says what
            // the device had sent. The richer error should always be the one
            // that happens, so this is kept a margin below the budget.
            command_timeout: std::time::Duration::from_secs(
                per_host_secs.saturating_sub(5).clamp(10, 60),
            ),
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
        // The project's saved logins first, in its order, then any
        // typed ones. One that has gone is one fewer to try.
        fallback_credentials: {
            let mut all = Vec::new();
            // And every other SSH login the project keeps.
            for id in &crate::vault_commands::project_login_order(&state, &input.fallback_credential_ids, input.credential_id.as_deref()) {
                if !crate::vault_commands::credential_exists(&state, id) {
                    continue;
                }
                all.push(crate::vault_commands::ssh_credentials(&state, id)?);
                crate::vault_commands::note_use(&state, id, "Crawl (fallback login)", &input.seed);
            }
            all.extend(
                fallback_credentials
                    .unwrap_or_default()
                    .into_iter()
                    // A set with no username is an empty form, not a credential.
                    .filter(|c| !c.username.trim().is_empty())
                    .map(Credentials::from),
            );
            all
        },
        // Saved credentials first, then typed ones: a reference the operator
        // picked from a list is a deliberate choice, and a form left filled
        // in from last time is not. Every one that resolves is kept, because
        // trying several is the point.
        snmp: {
            let mut all = Vec::new();
            for id in &input.snmp_credential_ids {
                // "every one that resolves is kept" is what the comment
                // above has always said, and what the code did not do — a `?`
                // here meant one wiped credential in the list stopped the whole
                // scan. Trying several is the point; one that has gone is one
                // fewer to try.
                if !crate::vault_commands::credential_exists(&state, id) {
                    continue;
                }
                all.push(crate::vault_commands::snmp_credentials(&state, id)?);
            }
            all.extend(input.snmp.into_iter().filter_map(SnmpInput::into_auth));
            all
        },
        details: input.details,
        bindings: resolve_bindings(&state, &input.bindings)?,
        // Hop through the device that found each one, when asked.
        reach: input.reach.as_deref().map(coreview_discover::crawl::ReachMode::parse).unwrap_or_default(),
        scan_subnets: coreview_discover::subnetscan::parse_scan_subnets(&input.scan_subnets)?,
        ..CrawlOptions::default()
    };

    let offered = OfferedCredentials::of(&state, &input_credential_id, &input_snmp_ids, &input_bindings);
    let store = load_host_keys(&state)?;
    // One crawl at a time, and a second is refused rather than
    // silently replacing the first.
    let ticket = state.jobs.start(crate::jobs::Kind::Crawl)?;
    let token = ticket.token();

    // The run is opened now and written device by device, so a
    // process that dies under a two-hour crawl leaves what it had found. A
    // run that cannot be opened is reported now rather than discovered
    // missing afterwards — the lesson.
    let run_id = match input.project_id.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(project_id) => {
            let id = format!("crawl-{}", crate::db::now_ms());
            let conn = state.db.lock().map_err(db_err)?;
            crate::db::open_crawl_run(&conn, &id, project_id, crate::db::now_ms(), &input.seed)
                .map_err(|e| format!("could not keep this crawl: {e}"))?;
            Some(id)
        }
        None => None,
    };

    let (tx, mut rx) = tokio::sync::mpsc::channel(1024);
    let emitter = app.clone();
    let pump_run_id = run_id.clone();
    let progress = ticket.progress();
    let pump = tauri::async_runtime::spawn(async move {
        // A crawl finds its own size as it goes, so `done` counts
        // devices settled — reached or failed — and there is no total.
        let mut settled: u64 = 0;
        while let Some(event) = rx.recv().await {
            match &event {
                CrawlEvent::Visiting { address, .. } => progress.set(format!("Visiting {address}"), settled, None),
                CrawlEvent::Reached(_) | CrawlEvent::Failed { .. } => {
                    settled += 1;
                    progress.set("Crawling", settled, None);
                }
                _ => {}
            }
            if let CrawlEvent::Reached(device) = &event {
                use tauri::Manager;
                let state = emitter.state::<AppState>();
                // Every device reached, against the saved credentials
                // this crawl offered it — the chosen ones and the bindings
                // that match it.
                for id in offered.for_device(device) {
                    crate::vault_commands::note_use(&state, &id, "Crawl", &format!("{} ({})", device.hostname, device.address));
                }
                // On disk before the interface even hears of it.
                if let Some(run_id) = &pump_run_id {
                    if let (Ok(conn), Ok(json)) = (state.db.lock(), serde_json::to_string(device)) {
                        if let Err(e) = crate::db::append_crawl_device(&conn, run_id, &json) {
                            eprintln!("could not write {} to crawl run {run_id}: {e}", device.address);
                        }
                    }
                }
            }
            let _ = emitter.emit("coreview://crawl", &event);
        }
    });

    let seed = input.seed;
    let reverse_dns = input.reverse_dns;
    let credentials = resolve_ssh(&state, input.credential_id.as_deref(), credentials)?;
    let persist_store = Arc::clone(&store);

    // The support capture, opened now for the same reason as the
    // debug log below. Every secret the run holds is handed to the redaction
    // before a single reply is written.
    // One stamp for the run, so the log and the replies share a folder.
    let run_stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    if input.support_capture {
        let stamp = run_stamp;
        let mut secrets: Vec<String> = credentials.secrets();
        for c in &options.fallback_credentials {
            secrets.extend(c.secrets());
        }
        secrets.extend(snmp_secrets);
        let folder = coreview_discover::support::folder_under(&crate::db::data_dir(), stamp);
        let capture = coreview_discover::support::SupportCapture::open(folder, secrets)
            .map_err(|e| format!("could not open the support capture: {e}"))?;
        options.ssh.support_capture = Some(Arc::new(capture));
    }

    // Started here rather than inside the run, so a file that cannot
    // be opened is reported now. Somebody ticked a box and is waiting for a
    // file; silently not writing one is worse than saying so.
    if input.debug_log {
        // Beside the replies, in the run's own diagnostic folder,
        // when both were asked for; on its own otherwise.
        let dir = if input.support_capture {
            coreview_discover::support::diagnostic_folder(&crate::db::data_dir(), run_stamp)
        } else {
            crate::db::data_dir().join("logs")
        };
        let _ = std::fs::create_dir_all(&dir);
        let header = format!(
            "Coreview {} — crawl debug log\nSeeds: {seed}\nMax hops: {}",
            env!("CARGO_PKG_VERSION"),
            options.max_hops,
        );
        let file = if input.support_capture { dir.join("debug.log") } else { dir.join(format!("crawl-{run_stamp}.log")) };
        coreview_discover::debuglog::start(&file, &header)
            .map_err(|e| format!("could not open the debug log: {e}"))?;
    } else {
        // A previous run may have left it on.
        coreview_discover::debuglog::stop();
    }

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // Addresses, names and ranges, resolved and narrowed to what
        // answers on the login port; what could not be used is reported.
        let (parsed, mut skipped) = coreview_discover::seeds::parse_seeds(&seed);
        // A seed is always dialled, whatever the subnet limit says.
        //
        // "Stay inside these subnets" governs where a crawl *spreads* — it is
        // what stops it walking neighbour to neighbour into a network nobody
        // asked about, and `should_crawl` still enforces that on every
        // neighbour. A seed is not a neighbour: somebody typed it and pressed
        // scan, which is as explicit as an instruction gets. Filtering it here
        // meant a seed outside the limit was dropped silently and the run
        // reached nothing, which reads as the app being broken rather than as
        // the boundary being enforced.
        let (seeds, more) =
            coreview_discover::seeds::resolve_seeds(&parsed, options.ssh.port, |_| true).await;
        skipped.extend(more);
        for s in skipped {
            let _ = tx.send(CrawlEvent::Skipped { name: s.seed, reason: s.reason }).await;
        }
        let mut result = crawl_from(&seeds, credentials, options, store, tx, token).await;
        // A device that never reached a prompt leaves what it sent on
        // disk, without being asked. A crawl is often tested on a
        // different machine to the one being diagnosed from, so a Save dialog
        // one has to know to press is no use — the file has to already exist,
        // and the path has to be on screen.
        write_login_transcripts(&mut result.failures);
        // Names from reverse DNS where nothing else named a device.
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
        // `tx` went into `crawl_from` and is gone, so the pump drains
        // and ends; waiting for it means the last device is on disk before
        // the run is closed.
        let _ = pump.await;
        let status = if result.cancelled { "cancelled" } else { "complete" };
        if let Some(run_id) = &run_id {
            use tauri::Manager;
            let state = handle.state::<AppState>();
            let summary = serde_json::json!({
                "notVisited": result.not_visited,
                "failures": result.failures,
                "cancelled": result.cancelled,
                "firstSeenKeys": result.first_seen_keys,
            });
            // The devices as finished — point-to-point links joined,
            // reverse-DNS names — replace the copies written as each arrived.
            let finished: Vec<String> = result.devices.iter().filter_map(|d| serde_json::to_string(d).ok()).collect();
            let closed = state
                .db
                .lock()
                .map_err(|e| e.to_string())
                .and_then(|conn| {
                    if !finished.is_empty() {
                        crate::db::rewrite_crawl_devices(&conn, run_id, &finished).map_err(|e| e.to_string())?;
                    }
                    crate::db::close_crawl_run(&conn, run_id, status, &summary.to_string()).map_err(|e| e.to_string())
                });
            if let Err(e) = closed {
                eprintln!("could not close crawl run {run_id}: {e}");
            }
        }
        let _ = handle.emit(
            "coreview://crawl-result",
            serde_json::json!({
                "devices": result.devices,
                "notVisited": result.not_visited,
                "failures": result.failures,
                "cancelled": result.cancelled,
                "firstSeenKeys": result.first_seen_keys,
                "runId": run_id,
                "status": status,
                // Where the replies went.
                "supportCapture": result.support_capture,
                // The log is closed here, and its path told. The page
                // has read `debugLogPath` and nothing ever sent
                // it, so the "Open folder" button never had anything to open.
                "debugLogPath": coreview_discover::debuglog::stop(),
            }),
        );
        // The slot empties when the crawl does, however it ended.
        drop(ticket);
    });

    Ok(())
}

/// Writes the login stream of every device that failed with one, and records
/// where it went.
///
/// Into the app's own data folder — `%LOCALAPPDATA%\Coreview\logins` on
/// Windows — because that is somewhere the app can always write and somewhere
/// an operator can be told to look. One file per device per run; the address
/// and the time are in the name so two runs do not overwrite each other.
///
/// A failure to write is not reported as a crawl failure: the crawl already
/// failed, and a second error about a log file would bury the first.
fn write_login_transcripts(failures: &mut [coreview_discover::CrawlFailure]) {
    write_login_transcripts_into(&crate::db::data_dir().join("logins"), failures);
}

/// The part that does not need to know where the app keeps its data, so that
/// it can be tested somewhere harmless.
fn write_login_transcripts_into(dir: &std::path::Path, failures: &mut [coreview_discover::CrawlFailure]) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    for failure in failures.iter_mut() {
        let Some(bytes) = failure.transcript.take() else { continue };
        // The address goes in the file name, so anything that is not plainly
        // part of an address does not.
        let safe: String = failure
            .address
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
            .collect();
        let path = dir.join(format!("{safe}-{stamp}.log"));
        let body = format!(
            "Coreview {} — login transcript for {}\n\
             What this is: every byte {} sent between the password being \n\
             accepted and the crawl giving up, with control characters \n\
             written the way they would be typed. Nothing was run on the \n\
             device; this is the login only, so it holds no configuration.\n\
             Why it exists: the device never drew a prompt Coreview could \n\
             recognise. What it sent is the only thing that explains why.\n\
             \n\
             {}\n\
             \n\
             ---- begin ----\n{}\n---- end ----\n",
            env!("CARGO_PKG_VERSION"),
            failure.address,
            failure.address,
            failure.reason,
            coreview_discover::cli::escape_for_reading(&bytes),
        );
        if std::fs::write(&path, body).is_ok() {
            failure.transcript_path = Some(path.to_string_lossy().into_owned());
        }
    }
}

/// Can `device` reach `target`? Asked of the device itself, over SSH
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
    let store = load_host_keys(&state)?;
    let mut session =
        connect_with_project_logins(&state, device.trim(), &credential_id, SshOptions::default(), Arc::clone(&store), "Ping from a device").await?;
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

/// What a device saw, hop by hop, running its own traceroute.
///
/// The platform is read off the device's version banner first, the way a
/// crawl does, because the command is the platform's own. A platform with
/// no traceroute this reads is refused by name.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasuredTrace {
    pub hops: Vec<coreview_discover::trace::TraceHop>,
    pub command: String,
    pub platform: String,
    /// False when the device was still tracing at the time limit.
    pub complete: bool,
    pub elapsed_ms: u64,
}

/// A device's trace so far, on `coreview://tracert`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TracertProgress {
    pub device: String,
    pub target: String,
    pub hops: Vec<coreview_discover::trace::TraceHop>,
    pub elapsed_ms: u64,
}

/// Logs in, reads the version banner and hands back the dialect it names.
async fn identify(session: &mut coreview_discover::ssh::Device) -> (String, Box<dyn coreview_discover::dialect::Dialect>) {
    let mut version = String::new();
    for command in coreview_discover::dialect::VERSION_COMMANDS {
        let out = session.run(command).await.unwrap_or_default();
        if version.is_empty() {
            version = out.clone();
        }
        if coreview_discover::dialect::identifies(&out) {
            version = out;
            break;
        }
    }
    let dialect = coreview_discover::dialect::dialect_for(&version);
    (version, dialect)
}

#[tauri::command]
pub async fn traceroute_from_device(
    app: AppHandle,
    state: State<'_, AppState>,
    device: String,
    credential_id: String,
    target: String,
) -> CmdResult<MeasuredTrace> {
    state.limiter.allow(crate::ratelimit::Job::DeviceTraceroute)?;
    let target: std::net::Ipv4Addr = target.trim().parse().map_err(|_| format!("{} is not an IPv4 address", target.trim()))?;
    let store = load_host_keys(&state)?;
    // A traceroute waits on every silent hop; three minutes covers thirty.
    let options = SshOptions { command_timeout: std::time::Duration::from_secs(180), ..SshOptions::default() };
    let mut session =
        connect_with_project_logins(&state, device.trim(), &credential_id, options, Arc::clone(&store), "Traceroute from a device").await?;
    let (_, dialect) = identify(&mut session).await;
    // The hops as the device prints them, to the Tracert tab, with the time so far.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    session.watch(Some(tx));
    let started = std::time::Instant::now();
    let (app2, from, to) = (app.clone(), device.trim().to_string(), target.to_string());
    let relay = tokio::spawn(async move {
        let mut seen = String::new();
        let mut last = 0usize;
        while let Some(chunk) = rx.recv().await {
            seen.push_str(&chunk);
            let hops = coreview_discover::trace::parse_traceroute(&coreview_discover::cli::readable(&seen));
            if hops.len() != last {
                last = hops.len();
                let _ = app2.emit("coreview://tracert", &TracertProgress { device: from.clone(), target: to.clone(), hops, elapsed_ms: started.elapsed().as_millis() as u64 });
            }
        }
    });
    let outcome = match coreview_discover::trace::traceroute_command(dialect.family(), target) {
        Some(command) => match session.run(&command).await {
            Ok(out) => Ok((command, out, true)),
            // A trace that reaches its limit keeps what arrived.
            Err(coreview_discover::ssh::SshError::CommandTimeout { .. }) => {
                let partial = session.take_partial(&command);
                Ok((command, partial, false))
            }
            Err(e) => Err(e.to_string()),
        },
        None => Err(format!("{} runs {}, which has no traceroute this can read.", device.trim(), dialect.name())),
    };
    session.watch(None);
    session.close().await;
    relay.abort();
    persist_host_keys(&app, &store);
    let (command, output, complete) = outcome?;
    let hops = coreview_discover::trace::parse_traceroute(&output);
    if hops.is_empty() {
        return Err(if complete {
            format!("{} did not report a trace: {}", device.trim(), output.lines().last().unwrap_or("").trim())
        } else {
            format!("{} printed no hop in {} s.", device.trim(), started.elapsed().as_secs())
        });
    }
    Ok(MeasuredTrace { hops, command, platform: dialect.name().to_string(), complete, elapsed_ms: started.elapsed().as_millis() as u64 })
}

/// Which equal-cost leg a device hashes one flow onto, from the
/// device's own answer.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasuredLeg {
    pub next_hop: String,
    pub interface: Option<String>,
    pub command: String,
}

// A Tauri command takes its arguments flat, as `terminal.rs` already allows.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ecmp_leg_from_device(
    app: AppHandle,
    state: State<'_, AppState>,
    device: String,
    credential_id: String,
    source: String,
    destination: String,
    protocol: Option<u8>,
    source_port: Option<u16>,
    destination_port: Option<u16>,
) -> CmdResult<MeasuredLeg> {
    state.limiter.allow(crate::ratelimit::Job::DeviceHash)?;
    let source: std::net::Ipv4Addr = source.trim().parse().map_err(|_| format!("{} is not an IPv4 address", source.trim()))?;
    let destination: std::net::Ipv4Addr = destination.trim().parse().map_err(|_| format!("{} is not an IPv4 address", destination.trim()))?;
    let store = load_host_keys(&state)?;
    let mut session =
        connect_with_project_logins(&state, device.trim(), &credential_id, SshOptions::default(), Arc::clone(&store), "ECMP hash from a device").await?;
    let (_, dialect) = identify(&mut session).await;
    let ports = source_port.zip(destination_port);
    let outcome = match coreview_discover::trace::ecmp_command(dialect.family(), source, destination, protocol, ports) {
        Some(command) => session.run(&command).await.map_err(|e| e.to_string()).map(|out| (command, out)),
        None => Err(format!("{} runs {}, which cannot be asked which leg it hashes a flow onto.", device.trim(), dialect.name())),
    };
    session.close().await;
    persist_host_keys(&app, &store);
    let (command, output) = outcome?;
    let leg = coreview_discover::trace::parse_ecmp_leg(&output)
        .ok_or_else(|| format!("{} did not name a leg: {}", device.trim(), output.lines().last().unwrap_or("").trim()))?;
    Ok(MeasuredLeg { next_hop: leg.next_hop, interface: leg.interface, command })
}

#[tauri::command]
pub fn cancel_crawl(state: State<'_, AppState>) -> CmdResult<()> {
    state.jobs.cancel(crate::jobs::Kind::Crawl);
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
    /// Show commands run on every selected device.
    #[serde(default)]
    pub show_commands: Vec<String>,
    /// How to stop paging first: "auto", "cisco-asa", "palo-alto" and so on.
    #[serde(default)]
    pub paging: Option<String>,
    /// How capture files are named; blank or absent is the default.
    #[serde(default)]
    pub file_pattern: Option<String>,
    /// Ask each Cisco device to send its configuration over SNMP to the
    /// project's SFTP server (named in Settings), using the saved
    /// read-write SNMP credential here. Absent means every device is read
    /// over SSH. A device that cannot — no such table, a read-only
    /// credential — is read over SSH as usual.
    #[serde(default)]
    pub snmp_copy: Option<SnmpCopyInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnmpCopyInput {
    /// The saved SNMP credential the device accepts a write from.
    pub credential_id: String,
    /// Absent means 161.
    pub port: Option<u16>,
}

/// The SNMP backup a run asked for: the read-write credential from the
/// vault, and the SFTP server from the project's settings — host, port,
/// folder and the saved login the device is given. Each use is noted
/// against its credential, as every other use is.
fn snmp_backup_for(
    state: &AppState,
    project_id: &str,
    ask: &SnmpCopyInput,
    devices: usize,
) -> CmdResult<coreview_discover::capture::SnmpBackup> {
    let settings = {
        let conn = state.db.lock().map_err(db_err)?;
        db::project_settings(&conn, project_id).map_err(db_err)?
    };
    let host = settings
        .get("sftpHost")
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .ok_or("Name the SFTP server devices send their configuration to under Tools → Settings first.")?;
    let port = settings.get("sftpPort").and_then(|p| p.trim().parse::<u16>().ok()).filter(|p| *p > 0).unwrap_or(22);
    let folder = settings.get("sftpFolder").map(|f| f.trim().to_string()).unwrap_or_default();
    let login_id = settings
        .get("sftpCredentialId")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or("Save the SFTP server's login under Tools → Settings first.")?;
    let (username, password) = crate::vault_commands::sftp_credentials(state, &login_id)?;
    let auth = crate::vault_commands::snmp_credentials(state, &ask.credential_id)?;
    crate::vault_commands::note_use(state, &ask.credential_id, "Configuration backup over SNMP (write)", &format!("{devices} device(s)"));
    crate::vault_commands::note_use(state, &login_id, "SFTP server for backups over SNMP", &host);
    Ok(coreview_discover::capture::SnmpBackup {
        copy: coreview_discover::snmp_backup::SnmpCopy {
            auth,
            port: ask.port.filter(|p| *p > 0).unwrap_or(161),
            timeout: std::time::Duration::from_secs(5),
            // A large configuration over a slow management link; the device
            // is polled once a second meanwhile.
            wait: std::time::Duration::from_secs(180),
        },
        server: coreview_discover::snmp_backup::SftpServer { host, port, folder, username, password },
    })
}

/// Backs up the given devices into the chosen backup folder.
#[tauri::command]
pub async fn start_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    input: BackupInput,
    credentials: CredentialInput,
    stamp: String,
    project_id: String,
) -> CmdResult<()> {
    state.limiter.allow(crate::ratelimit::Job::Backup)?;
    // This project's folder, so one customer's captures do not land in
    // another's pile.
    let root = backup_root(&state, &project_id)?;

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

    // Checked here, before a single connection is opened, so a list
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

    // A pattern that would overwrite captures, or has a typo in a
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

    let snmp_copy = match &input.snmp_copy {
        None => None,
        Some(ask) => Some(snmp_backup_for(&state, &project_id, ask, input.targets.len())?),
    };

    let options = BackupOptions {
        root,
        kinds,
        snmp_copy,
        ssh: SshOptions {
            port: input.port,
            // A FortiGate 60F's `show` took 34 s in the lab; a larger
            // configuration would pass the default 60.
            command_timeout: std::time::Duration::from_secs(300),
            ..SshOptions::default()
        },
        second_factor: input.second_factor,
        show: wants_show.then(|| coreview_discover::capture::ShowPlan {
            commands: input.show_commands.clone(),
            paging,
        }),
        file_pattern,
        // Every other SSH login the project keeps, for a device that
        // refuses the run's own. One that has gone is one fewer to try.
        fallback_credentials: {
            let mut all = Vec::new();
            for id in &crate::vault_commands::project_login_order(&state, &[], input.credential_id.as_deref()) {
                if !crate::vault_commands::credential_exists(&state, id) {
                    continue;
                }
                if let Ok(c) = crate::vault_commands::ssh_credentials(&state, id) {
                    crate::vault_commands::note_use(&state, id, "Configuration backup (fallback login)", &format!("{} device(s)", input.targets.len()));
                    all.push(c);
                }
            }
            all
        },
    };

    let store = load_host_keys(&state)?;
    // One backup at a time; see `jobs.rs`.
    let ticket = state.jobs.start(crate::jobs::Kind::Backup)?;
    let token = ticket.token();
    let progress = ticket.progress();

    let (tx, mut rx) = tokio::sync::mpsc::channel(1024);
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        use coreview_discover::capture::BackupEvent;
        // The registry hears how many devices are done of how many.
        let mut done: u64 = 0;
        while let Some(event) = rx.recv().await {
            match &event {
                BackupEvent::Started { devices } => progress.set("Backing up", 0, Some(*devices as u64)),
                BackupEvent::Saved(_) | BackupEvent::Failed(_) => {
                    done += 1;
                    progress.set("Backing up", done, None);
                }
                _ => {}
            }
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
        drop(ticket);
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_backup(state: State<'_, AppState>) -> CmdResult<()> {
    state.jobs.cancel(crate::jobs::Kind::Backup);
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
    /// Whether the newest capture differs from the one before it of
    /// the same kind. `None` with nothing to compare against.
    pub changed_at_latest: Option<bool>,
}

/// Where this **project's** backups live.
///
/// It used to be one folder for the machine, and every listing walked it — so
/// a new project opened showing the previous customer's device names and
/// offered their runs for comparison. The folder is a property of the work,
/// and the work is the project.
fn backup_root(state: &State<'_, AppState>, project_id: &str) -> CmdResult<std::path::PathBuf> {
    if project_id.is_empty() {
        return Err("No project is open, so there is no backup folder to read.".into());
    }
    let conn = state.db.lock().map_err(db_err)?;
    let root = db::project_settings(&conn, project_id)
        .map_err(db_err)?
        .get("backupFolder")
        .cloned()
        .ok_or("No backup folder has been chosen for this project yet.")?;
    Ok(root.into())
}

/// Every device with backups, for the browser.
#[tauri::command(async)]
pub fn list_backup_devices(state: State<'_, AppState>, project_id: String) -> CmdResult<Vec<BackupDevice>> {
    let root = backup_root(&state, &project_id)?;
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
                changed_at_latest: coreview_discover::capture::changed_at_latest(&root, &name),
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
pub fn list_device_captures(state: State<'_, AppState>, device: String, project_id: String) -> CmdResult<Vec<String>> {
    let root = backup_root(&state, &project_id)?;
    Ok(coreview_discover::capture::list_captures(&root, &device, "")
        .into_iter()
        .filter_map(|p| p.file_name().map(|f| f.to_string_lossy().to_string()))
        .collect())
}

/// Every capture of one device, newest first, each flagged against
/// the previous of its kind.
#[tauri::command(async)]
pub fn device_capture_history(state: State<'_, AppState>, device: String, project_id: String) -> CmdResult<Vec<coreview_discover::capture::CaptureHistory>> {
    let root = backup_root(&state, &project_id)?;
    Ok(coreview_discover::capture::history(&root, &device))
}

/// Reads one capture.
///
/// Takes a device and a filename rather than a path, so the interface cannot
/// name a file outside the backup folder — the same reason the writer builds
/// its own paths instead of accepting them.
#[tauri::command(async)]
pub fn read_capture(
    state: State<'_, AppState>,
    device: String,
    filename: String,
    project_id: String,
) -> CmdResult<String> {
    let root = backup_root(&state, &project_id)?;
    let path = capture_path(&root, &device, &filename)?;
    std::fs::read_to_string(&path).map_err(|e| format!("Could not read {}: {e}", path.display()))
}

/// Compares two captures of one device.
#[tauri::command(async)]
pub fn diff_captures(
    state: State<'_, AppState>,
    device: String,
    before: String,
    after: String,
    project_id: String,
) -> CmdResult<Vec<coreview_discover::capture::DiffLine>> {
    let root = backup_root(&state, &project_id)?;
    let a = std::fs::read_to_string(capture_path(&root, &device, &before)?).map_err(|e| e.to_string())?;
    let b = std::fs::read_to_string(capture_path(&root, &device, &after)?).map_err(|e| e.to_string())?;
    Ok(coreview_discover::capture::diff(&a, &b))
}

/// Every backup run, newest first, for the before-and-after picker.
#[tauri::command]
pub fn list_backup_runs(state: State<'_, AppState>, project_id: String) -> CmdResult<Vec<coreview_discover::compare::RunSummary>> {
    let root = backup_root(&state, &project_id)?;
    Ok(coreview_discover::compare::list_runs(&root))
}

/// Two runs compared device by device, and command by command for show
/// commands. Takes stamps, never paths; a stamp that is not the
/// shape of one is refused before anything is read.
#[tauri::command]
pub fn compare_backup_runs(
    state: State<'_, AppState>,
    before: String,
    after: String,
    project_id: String,
) -> CmdResult<Vec<coreview_discover::compare::DeviceComparison>> {
    let root = backup_root(&state, &project_id)?;
    coreview_discover::compare::compare_runs(&root, &before, &after)
}

/// Runs checks against one run's show-command captures. Reads files
/// only; the checks are the operator's own, sent from the Backups tab.
///
/// `roles` names each device's role as the diagram has it, so a
/// check written for one role is *not applicable* elsewhere rather than
/// failed. Absent means no device has a role.
#[tauri::command]
pub fn run_backup_checks(
    state: State<'_, AppState>,
    stamp: String,
    checks: Vec<coreview_discover::checks::Check>,
    project_id: String,
    roles: Option<std::collections::HashMap<String, String>>,
) -> CmdResult<Vec<coreview_discover::checks::CheckResult>> {
    let root = backup_root(&state, &project_id)?;
    coreview_discover::checks::run_checks(&root, &stamp, &checks, &roles.unwrap_or_default())
}

/// One entry of a gateway's ARP table, with the manufacturer behind its MAC.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayArpEntry {
    pub ip: String,
    pub mac: String,
    pub vendor: Option<String>,
}

/// Reads a gateway's ARP table over SNMP with a saved credential.
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
#[tauri::command(async)]
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
#[tauri::command(async)]
pub fn clear_host_keys(state: State<'_, AppState>) -> CmdResult<usize> {
    let conn = state.db.lock().map_err(db_err)?;
    db::clear_host_keys(&conn).map_err(db_err)
}

/// Forgets one device's key, so the next connection is treated as first
/// contact. The narrower answer when a single switch was replaced.
#[tauri::command(async)]
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

/// A saved snmpwalk of one device, read into the record an SNMP crawl
/// builds. Pure text in, so nothing is contacted and nothing is stored.
#[tauri::command(async)]
pub fn read_snmp_walk(text: String, address: Option<String>) -> coreview_discover::walkfile::WalkReading {
    coreview_discover::walkfile::read_walk(&text, address.as_deref())
}

/// An Nmap XML report, read as ping-sweep rows.
#[tauri::command(async)]
pub fn read_nmap_xml(text: String) -> Result<coreview_formats::nmap_import::NmapReport, String> {
    coreview_formats::nmap_import::read_nmap_xml(&text)
}

#[cfg(test)]
mod transcript_tests {
    use coreview_discover::crawl::FailureKind;
    use coreview_discover::CrawlFailure;

    /// Diagnosis often happens on a different machine to the one
    /// running the crawl, so the file has to exist without being asked for
    /// and the path has to come back for the interface to show.
    #[test]
    fn a_failure_with_a_transcript_leaves_a_file_and_says_where() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut failure = CrawlFailure::new(
            "198.51.100.7".into(),
            "198.51.100.7 stopped responding while running `<login>`".into(),
            FailureKind::CommandTimedOut,
        );
        failure.transcript = Some(b"\x1b[2JPress any key to continue".to_vec());
        let mut failures = vec![failure];

        super::write_login_transcripts_into(dir.path(), &mut failures);

        let path = failures[0].transcript_path.clone().expect("a path came back");
        let written = std::fs::read_to_string(&path).expect("the file is there");
        assert!(written.contains("198.51.100.7"), "names the device: {written}");
        assert!(written.contains(r"\x1b[2J"), "the escapes are readable: {written}");
        assert!(!written.contains('\u{1b}'), "no raw escape reached the file");
        // The transcript itself does not also travel to the interface.
        assert!(failures[0].transcript.is_none(), "the bytes were handed over, not copied");
    }

    #[test]
    fn a_failure_with_nothing_recorded_leaves_nothing() {
        // A device that refused the connection never said anything, and an
        // empty file in a folder of transcripts is a false lead.
        let dir = tempfile::tempdir().expect("tempdir");
        let mut failures = vec![CrawlFailure::new(
            "198.51.100.8".into(),
            "nothing answered".into(),
            FailureKind::Unreachable,
        )];
        super::write_login_transcripts_into(dir.path(), &mut failures);
        assert!(failures[0].transcript_path.is_none());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn an_address_cannot_escape_the_folder_it_is_named_in() {
        // The address reaches a file name, so anything that is not plainly
        // part of an address must not survive the trip.
        let dir = tempfile::tempdir().expect("tempdir");
        let mut failure = CrawlFailure::new(
            "../../etc/passwd".into(),
            "nope".into(),
            FailureKind::Other,
        );
        failure.transcript = Some(b"x".to_vec());
        let mut failures = vec![failure];
        super::write_login_transcripts_into(dir.path(), &mut failures);
        let path = failures[0].transcript_path.clone().expect("a path");
        assert!(
            std::path::Path::new(&path).parent() == Some(dir.path()),
            "wrote outside the folder: {path}",
        );
    }
}
