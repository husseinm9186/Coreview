//! Takes a real backup off a fake device, over a real SSH session.
//!
//! The unit tests cover the writer with text handed to it directly. This covers
//! the part in between: that a configuration read off a terminal — echoed,
//! prompt-terminated, containing a banner with a bare `#` — reaches the file
//! intact, and that a device which cannot produce one leaves no file behind.

use std::sync::Arc;
use std::time::Duration;

use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use coreview_discover::backup::BackupKind;
use coreview_discover::capture::{run_backups, BackupOptions, BackupTarget};
use coreview_discover::hostkeys::HostKeyStore;
use coreview_discover::ssh::{Credentials, Secret, SshOptions};

/// A configuration with the things that trip a naive capture: a banner
/// containing a bare `#`, and enough lines to be plausible.
fn running_config(hostname: &str) -> String {
    let mut c = String::from("Building configuration...\r\n\r\nCurrent configuration : 2048 bytes\r\n!\r\nversion 15.2\r\n!\r\n");
    c.push_str(&format!("hostname {hostname}\r\n!\r\n"));
    c.push_str("banner motd #\r\nUnauthorized access prohibited\r\n#\r\n!\r\n");
    for i in 1..=6 {
        c.push_str(&format!("interface GigabitEthernet0/{i}\r\n switchport mode access\r\n!\r\n"));
    }
    c.push_str("snmp-server community s3cr3t RO\r\n!\r\nend\r\n");
    c
}

#[derive(Clone)]
struct FakeSwitch {
    hostname: String,
    /// The device logs in at `>` and refuses to escalate, like an account
    /// without privilege 15.
    stuck_in_user_mode: bool,
    enabled: Arc<std::sync::Mutex<bool>>,
    /// Every line the device received, in order.
    received: Arc<std::sync::Mutex<Vec<String>>>,
    /// A FortiGate or FortiSwitch, drawing `host # ` for a
    /// super_admin or `host $ ` for a read-only profile, with FortiOS's
    /// refusal for anything it does not have.
    fortios: Option<char>,
}

/// A FortiOS configuration as `show` prints it: the version header, then
/// `config` blocks. Invented values.
fn fortios_config(hostname: &str) -> String {
    let mut c = String::from("#config-version=FGT60F-7.6.7-FW-build3704-260601:opmode=0:vdom=0:user=reader\r\n#conf_file_ver=1\r\n#buildno=3704\r\n#global_vdom=1\r\n");
    c.push_str(&format!("config system global\r\n    set hostname \"{hostname}\"\r\n    set timezone \"US/Central\"\r\nend\r\n"));
    for i in 1..=4 {
        c.push_str(&format!("config system interface\r\n    edit \"internal{i}\"\r\n        set vdom \"root\"\r\n        set type physical\r\n    next\r\nend\r\n"));
    }
    c
}

impl server::Handler for FakeSwitch {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        if password == "correct-horse" {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject { proceed_with_methods: None, partial_success: false })
        }
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        _channel: ChannelId,
        _term: &str,
        _cw: u32,
        _rh: u32,
        _pw: u32,
        _ph: u32,
        _modes: &[(russh::Pty, u32)],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // User mode draws '>', enable mode draws '#'. That difference is the
        // whole reason `enable` exists.
        if let Some(mark) = self.fortios {
            session.data(channel, format!("\r\n{} {mark} ", self.hostname).into_bytes())?;
            return Ok(());
        }
        let mark = if self.stuck_in_user_mode { '>' } else { '#' };
        session.data(channel, format!("\r\n{}{mark}", self.hostname).into_bytes())?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let line = String::from_utf8_lossy(data);
        let command = line.trim();
        if !command.is_empty() {
            self.received.lock().unwrap().push(command.to_string());
        }
        if let Some(mark) = self.fortios {
            // FortiOS has no `enable`, no `terminal length`, no running-config:
            // its configuration is `show`, for a read-only profile too.
            let body = match command {
                "" => String::new(),
                "show" | "show full-configuration" => fortios_config(&self.hostname),
                "get system status" => format!("Version: FortiGate-60F v7.6.7,build3704,260601 (GA.M)\r\nHostname: {}\r\n", self.hostname),
                other => format!("command parse error before '{}'\r\nCommand fail. Return code -61\r\n", other.split_whitespace().last().unwrap_or(other)),
            };
            session.data(channel, format!("{command}\r\n{body}{} {mark} ", self.hostname).into_bytes())?;
            return Ok(());
        }
        let is_enabled = *self.enabled.lock().unwrap() || !self.stuck_in_user_mode;

        if command == "enable" {
            if self.stuck_in_user_mode {
                // Asks for a password and then refuses, staying at '>'.
                session.data(channel, format!("Password: \r\n% Access denied\r\n{}>", self.hostname).into_bytes())?;
            } else {
                *self.enabled.lock().unwrap() = true;
                session.data(channel, format!("\r\n{}#", self.hostname).into_bytes())?;
            }
            return Ok(());
        }

        let body: String = match command {
            "terminal length 0" | "terminal pager 0" => String::new(),
            "show version" => "Fake Switch Software, Version 1.0\r\nuptime is 1 day\r\n".into(),
            "show clock" => "*12:00:00.000 UTC Thu Jan 1 2026\r\n".into(),
            "show running-config" if is_enabled => running_config(&self.hostname),
            "show running-config" => "% Invalid input detected at '^' marker.\r\n".into(),
            "show startup-config" if is_enabled => running_config(&self.hostname),
            _ => "% Invalid input detected at '^' marker.\r\n".into(),
        };

        let mark = if is_enabled { '#' } else { '>' };
        session.data(channel, format!("{command}\r\n{body}{}{mark}", self.hostname).into_bytes())?;
        Ok(())
    }
}

async fn start(hostname: &str, stuck_in_user_mode: bool) -> u16 {
    start_with_log(hostname, stuck_in_user_mode).await.0
}

async fn start_with_log(
    hostname: &str,
    stuck_in_user_mode: bool,
) -> (u16, Arc<std::sync::Mutex<Vec<String>>>) {
    start_device(hostname, stuck_in_user_mode, None).await
}

async fn start_device(
    hostname: &str,
    stuck_in_user_mode: bool,
    fortios: Option<char>,
) -> (u16, Arc<std::sync::Mutex<Vec<String>>>) {
    let received = Arc::new(std::sync::Mutex::new(Vec::new()));
    let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let config = Arc::new(server::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        auth_rejection_time: Duration::from_millis(1),
        keys: vec![key],
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let switch = FakeSwitch {
        hostname: hostname.to_string(),
        stuck_in_user_mode,
        enabled: Arc::new(std::sync::Mutex::new(false)),
        received: Arc::clone(&received),
        fortios,
    };
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let config = Arc::clone(&config);
            let switch = FakeSwitch {
                enabled: Arc::new(std::sync::Mutex::new(false)),
                ..switch.clone()
            };
            tokio::spawn(async move {
                let _ = server::run_stream(config, stream, switch).await;
            });
        }
    });
    (port, received)
}

fn temp_root(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("coreview-e2e-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn creds(password: &str) -> Credentials {
    Credentials {
        username: "admin".into(),
        password: Secret::new(password),
        enable_password: Some(Secret::new("enable-secret")),
    }
}

fn options(root: std::path::PathBuf, port: u16, kinds: Vec<BackupKind>) -> BackupOptions {
    BackupOptions {
        root,
        kinds,
        ssh: SshOptions {
            port,
            connect_timeout: Duration::from_secs(5),
            auth_timeout: Duration::from_secs(10),
            command_timeout: Duration::from_secs(10),
            login_transcript: None,
            support_capture: None,
            max_output_bytes: coreview_discover::ssh::DEFAULT_MAX_OUTPUT_BYTES,
        },
        second_factor: false,
        show: None,
        file_pattern: None,
        fallback_credentials: Vec::new(),
        snmp_copy: None,
    }
}

#[tokio::test]
async fn a_configuration_read_off_a_terminal_reaches_the_file_intact() {
    let port = start("CORE-SW-01", false).await;
    let root = temp_root("intact");
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(128);

    let run = run_backups(
        vec![BackupTarget { address: "127.0.0.1".into(), name: "seed-name".into(), commands: Vec::new(), site: String::new() }],
        creds("correct-horse"),
        options(root.clone(), port, vec![BackupKind::Running]),
        store,
        "20260828-120000".into(),
        tx,
        CancellationToken::new(),
    )
    .await;

    assert!(run.failed.is_empty(), "unexpected failures: {:?}", run.failed);
    assert_eq!(run.saved.len(), 1);

    let saved = &run.saved[0];
    // Filed under the device's own name, not the one the caller guessed.
    assert_eq!(saved.name, "CORE-SW-01", "the device's own name should win");
    assert!(saved.path.contains("CORE-SW-01"), "got {}", saved.path);

    let text = std::fs::read_to_string(&saved.path).unwrap();
    assert!(text.contains("hostname CORE-SW-01"));
    // The banner's bare '#' must not have truncated the capture.
    assert!(text.contains("interface GigabitEthernet0/6"), "capture stopped early:\n{text}");
    assert!(text.contains("snmp-server community"), "capture stopped early:\n{text}");
    assert!(text.trim().ends_with("end"));
    // And the terminal's own noise must not have got in.
    assert!(!text.contains("CORE-SW-01#"), "a prompt reached the file:\n{text}");
    assert!(!text.contains("show running-config"), "the echo reached the file:\n{text}");

    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn a_device_stuck_in_user_mode_fails_instead_of_filing_an_error() {
    // The failure this is built to prevent: a file under the device's name
    // containing "% Invalid input", which looks like a backup until you need it.
    let port = start("EDGE-RTR", true).await;
    let root = temp_root("usermode");
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(128);

    let run = run_backups(
        vec![BackupTarget { address: "127.0.0.1".into(), name: "EDGE-RTR".into(), commands: Vec::new(), site: String::new() }],
        creds("correct-horse"),
        options(root.clone(), port, vec![BackupKind::Running]),
        store,
        "20260828-120000".into(),
        tx,
        CancellationToken::new(),
    )
    .await;

    assert!(run.saved.is_empty(), "nothing should have been written");
    assert_eq!(run.failed.len(), 1);
    assert!(
        run.failed[0].reason.contains("user mode"),
        "the reason should name the cause: {}",
        run.failed[0].reason
    );

    // No stray folder suggesting the device was ever backed up.
    assert!(!root.join("EDGE-RTR").exists(), "an empty device folder was left behind");
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn both_configurations_are_captured_separately() {
    let port = start("SW1", false).await;
    let root = temp_root("both");
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(128);

    let run = run_backups(
        vec![BackupTarget { address: "127.0.0.1".into(), name: "SW1".into(), commands: Vec::new(), site: String::new() }],
        creds("correct-horse"),
        options(root.clone(), port, vec![BackupKind::Running, BackupKind::Startup]),
        store,
        "20260828-120000".into(),
        tx,
        CancellationToken::new(),
    )
    .await;

    assert_eq!(run.saved.len(), 2, "got {:?}", run.saved);
    assert!(run.saved.iter().any(|s| s.path.contains("running-config")));
    assert!(run.saved.iter().any(|s| s.path.contains("startup-config")));
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn one_bad_device_does_not_stop_the_rest_of_a_bulk_run() {
    // Ninety-nine switches must not go unbacked because the hundredth is off.
    let good = start("SW-GOOD", false).await;
    let root = temp_root("bulk");
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let run = run_backups(
        vec![
            BackupTarget { address: "127.0.0.9".into(), name: "SW-DEAD".into(), commands: Vec::new(), site: String::new() },
            BackupTarget { address: "127.0.0.1".into(), name: "SW-GOOD".into(), commands: Vec::new(), site: String::new() },
        ],
        creds("correct-horse"),
        options(root.clone(), good, vec![BackupKind::Running]),
        store,
        "20260828-120000".into(),
        tx,
        CancellationToken::new(),
    )
    .await;

    assert_eq!(run.failed.len(), 1, "the dead one should be recorded");
    assert_eq!(run.saved.len(), 1, "the live one should still have been backed up");
    assert_eq!(run.saved[0].name, "SW-GOOD");
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn with_no_backup_folder_chosen_nothing_is_attempted() {
    let port = start("SW1", false).await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(128);

    let run = run_backups(
        vec![BackupTarget { address: "127.0.0.1".into(), name: "SW1".into(), commands: Vec::new(), site: String::new() }],
        creds("correct-horse"),
        options(std::path::PathBuf::new(), port, vec![BackupKind::Running]),
        store,
        "20260828-120000".into(),
        tx,
        CancellationToken::new(),
    )
    .await;

    assert!(run.saved.is_empty());
    assert_eq!(run.failed.len(), 1);
    assert!(run.failed[0].reason.contains("folder"), "got: {}", run.failed[0].reason);
}

// ------------------------------------------------------------------ 

fn show_options(
    root: std::path::PathBuf,
    port: u16,
    kinds: Vec<BackupKind>,
    commands: &[&str],
    paging: coreview_discover::showcmd::Paging,
) -> BackupOptions {
    let mut o = options(root, port, kinds);
    o.show = Some(coreview_discover::capture::ShowPlan {
        commands: commands.iter().map(|c| c.to_string()).collect(),
        paging,
    });
    o
}

#[tokio::test]
async fn show_commands_are_filed_as_one_capture_in_the_backup_folder() {
    let (port, received) = start_with_log("SW-SHOW", false).await;
    let root = temp_root("show");
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(128);

    let run = run_backups(
        vec![BackupTarget {
            address: "127.0.0.1".into(),
            name: "SW-SHOW".into(),
            // Per-device, on top of the global list.
            commands: vec!["show bogus".into()],
            site: String::new(),
        }],
        creds("correct-horse"),
        show_options(
            root.clone(),
            port,
            Vec::new(),
            &["show version", "show clock"],
            coreview_discover::showcmd::Paging::CiscoAsa,
        ),
        store,
        "20260101-120000".into(),
        tx,
        CancellationToken::new(),
    )
    .await;

    assert!(run.failed.is_empty(), "unexpected failures: {:?}", run.failed);
    assert_eq!(run.saved.len(), 1, "one file per device per run: {:?}", run.saved);
    let saved = &run.saved[0];
    assert!(saved.path.contains("SW-SHOW"), "filed under the device: {}", saved.path);
    // The kind is still in the name, but the default now carries the
    // device and address after it, so the file identifies itself once it is
    // copied out of the folder.
    assert!(saved.path.contains("show-commands"), "got {}", saved.path);
    assert!(saved.path.ends_with(".txt"), "got {}", saved.path);

    let text = std::fs::read_to_string(&saved.path).unwrap();
    let v = text.find("show version").expect("show version heading");
    let c = text.find("show clock").expect("show clock heading");
    let b = text.find("show bogus").expect("per-device command heading");
    assert!(v < c && c < b, "global commands first, then the device's own:\n{text}");
    assert!(text.contains("Fake Switch Software, Version 1.0"));
    assert!(text.contains("*12:00:00.000 UTC"));
    // A command the device refused is kept and marked, not silently dropped.
    assert!(text.contains("[not accepted by this device]"), "{text}");
    // The terminal's own noise stays out.
    assert!(!text.contains("SW-SHOW#"), "a prompt reached the file:\n{text}");

    // The vendor paging command went out before the first show command.
    let log = received.lock().unwrap().clone();
    let pager = log.iter().position(|c| c == "terminal pager 0").expect("pager command sent");
    let first = log.iter().position(|c| c == "show version").expect("show version sent");
    assert!(pager < first, "paging must be set before the first command: {log:?}");
    std::fs::remove_dir_all(&root).ok();
}

/// The guard the feature exists around. This tool is given to strangers, and
/// a command that could change a device must never reach it — not refused by
/// the device, never *sent*.
#[tokio::test]
async fn a_command_that_could_change_the_device_is_never_sent() {
    let (port, received) = start_with_log("SW-GUARD", false).await;
    let root = temp_root("guard");
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(128);

    let run = run_backups(
        vec![BackupTarget {
            address: "127.0.0.1".into(),
            name: "SW-GUARD".into(),
            commands: vec!["reload".into(), "show running-config | redirect flash:x".into()],
            site: String::new(),
        }],
        creds("correct-horse"),
        show_options(
            root.clone(),
            port,
            Vec::new(),
            &["show version"],
            coreview_discover::showcmd::Paging::Auto,
        ),
        store,
        "20260101-120000".into(),
        tx,
        CancellationToken::new(),
    )
    .await;

    let log = received.lock().unwrap().clone();
    assert!(!log.iter().any(|c| c.starts_with("reload")), "reload reached the device: {log:?}");
    assert!(!log.iter().any(|c| c.contains("redirect")), "a redirect reached the device: {log:?}");

    assert_eq!(run.saved.len(), 1, "{:?}", run.failed);
    let text = std::fs::read_to_string(&run.saved[0].path).unwrap();
    assert!(text.contains("(not sent:"), "the refusal is recorded in the file:\n{text}");
    std::fs::remove_dir_all(&root).ok();
}

/// Most show commands need no privilege, so a device that refuses enable still
/// yields its show output — where a configuration backup of it rightly fails.
#[tokio::test]
async fn show_commands_still_run_on_a_device_stuck_in_user_mode() {
    let port = start("SW-USER", true).await;
    let root = temp_root("show-user");
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(128);

    let run = run_backups(
        vec![BackupTarget { address: "127.0.0.1".into(), name: "SW-USER".into(), commands: Vec::new(), site: String::new() }],
        creds("correct-horse"),
        show_options(
            root.clone(),
            port,
            vec![BackupKind::Running],
            &["show version"],
            coreview_discover::showcmd::Paging::Auto,
        ),
        store,
        "20260101-120000".into(),
        tx,
        CancellationToken::new(),
    )
    .await;

    assert_eq!(run.saved.len(), 1, "show output should still be filed: {:?}", run.failed);
    assert!(run.saved[0].path.contains("show-commands"), "got {}", run.saved[0].path);
    assert!(run.saved[0].path.ends_with(".txt"), "got {}", run.saved[0].path);
    let text = std::fs::read_to_string(&run.saved[0].path).unwrap();
    assert!(text.starts_with("# Ran in user mode"), "{text}");
    // And no running-config was invented out of an error message.
    assert!(!run.saved.iter().any(|s| s.path.contains("running-config")));
    std::fs::remove_dir_all(&root).ok();
}

/// A FortiGate logged in with a read-only profile (`$`) and
/// a FortiSwitch as super_admin (`#`). FortiOS has no `show running-config`
/// and no `enable`; its configuration is read whole with `show
/// full-configuration`.
#[tokio::test]
async fn a_fortios_configuration_is_read_whole_whichever_prompt_it_draws() {
    for (name, mark) in [("LAB-FGT", '$'), ("LAB-FSW", '#')] {
        let (port, received) = start_device(name, false, Some(mark)).await;
        let root = temp_root(&format!("fortios-{name}"));
        let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
        let (tx, _rx) = mpsc::channel(128);
        let run = run_backups(
            vec![BackupTarget { address: "127.0.0.1".into(), name: name.into(), commands: Vec::new(), site: String::new() }],
            creds("correct-horse"),
            options(root.clone(), port, vec![BackupKind::Running, BackupKind::Startup]),
            store,
            "20260929-120000".into(),
            tx,
            CancellationToken::new(),
        )
        .await;
        assert_eq!(run.saved.len(), 1, "{name} at {mark}: {:?}", run.failed);
        let text = std::fs::read_to_string(&run.saved[0].path).unwrap();
        assert!(text.starts_with("#config-version=") && text.contains("edit \"internal4\""), "{name}: {text}");
        assert!(!text.contains(&format!("{name} {mark}")), "a prompt reached the file:\n{text}");
        let sent = received.lock().unwrap().clone();
        assert!(!sent.iter().any(|c| c == "enable" || c == "show running-config" || c == "show startup-config"), "{name}: FortiOS was sent {sent:?}");
        // The whole configuration, defaults included.
        assert!(sent.iter().any(|c| c == "show full-configuration"), "{name}: {sent:?}");
        // One configuration on FortiOS: the startup backup says so rather than failing.
        assert!(run.failed.iter().all(|f| f.reason.contains("one configuration")), "{name}: {:?}", run.failed);
        std::fs::remove_dir_all(&root).ok();
    }
}

/// A device that refuses the run's login is tried with every other saved
/// login, and the capture is taken with the one it accepts — its enable
/// password included.
#[tokio::test]
async fn a_refused_login_falls_back_to_the_next_saved_one() {
    let port = start("ACCESS-SW-07", false).await;
    let root = temp_root("fallback");
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(128);
    let mut opts = options(root.clone(), port, vec![BackupKind::Running]);
    opts.fallback_credentials = vec![creds("also-not-it"), creds("correct-horse")];

    let run = run_backups(
        vec![BackupTarget { address: "127.0.0.1".into(), name: "seed-name".into(), commands: Vec::new(), site: String::new() }],
        creds("not-this-one"),
        opts,
        store,
        "20260828-120000".into(),
        tx,
        CancellationToken::new(),
    )
    .await;

    assert!(run.failed.is_empty(), "unexpected failures: {:?}", run.failed);
    assert_eq!(run.saved.len(), 1);
    let text = std::fs::read_to_string(&run.saved[0].path).unwrap();
    assert!(text.contains("hostname ACCESS-SW-07"));

    std::fs::remove_dir_all(&root).ok();
}
