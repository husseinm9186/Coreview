//! A backup over SNMP, end to end: the request written into a fake Cisco's
//! configuration-copy table over UDP, the file fetched back from a fake
//! SFTP server over a real SSH session, and filed like any other capture.
//! Invented names, loopback addresses, obviously fake secrets.

mod support;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use coreview_discover::backup::BackupKind;
use coreview_discover::capture::{run_backups, BackupEvent, BackupOptions, BackupTarget, SnmpBackup};
use coreview_discover::hostkeys::HostKeyStore;
use coreview_discover::snmp::SnmpAuth;
use coreview_discover::snmp_backup::{SftpServer, SnmpCopy};
use coreview_discover::ssh::{Credentials, Secret, SshOptions};

use support::{snmp_agent, sftp_server, Copying, Seen, CC_COPY_ENTRY};

const COMMUNITY: &str = "not-a-real-rw-community";
const SYS_NAME: &str = "SNMP-CORE-01";
const STAMP: &str = "20260109-090000";
const SFTP_USER: &str = "backup-drop";
const SFTP_PASSWORD: &str = "not-a-real-sftp-password";
const STARTUP: &str = "!\nversion 17.9\nhostname SNMP-CORE-01\n!\ninterface Loopback0\n ip address 198.51.100.1 255.255.255.255\n!\nntp server 192.0.2.123\n!\nend\n";
const CONFIG: &str = "!\nversion 17.9\nhostname SNMP-CORE-01\n!\ninterface Loopback0\n ip address 198.51.100.1 255.255.255.255\n!\nend\n";

fn temp_root(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("coreview-snmpbackup-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A run with no SSH login at all: the operator ticked SNMP and gave
/// nothing else.
fn no_ssh_login() -> Credentials {
    Credentials { username: String::new(), password: Secret::new(""), enable_password: None }
}

fn options(root: std::path::PathBuf, agent_port: u16, sftp_port: u16, kinds: Vec<BackupKind>) -> BackupOptions {
    BackupOptions {
        root,
        kinds,
        ssh: SshOptions {
            port: 1,
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
        snmp_copy: Some(SnmpBackup {
            copy: SnmpCopy {
                auth: SnmpAuth::V2c { community: COMMUNITY.into() },
                port: agent_port,
                timeout: Duration::from_secs(2),
                wait: Duration::from_secs(10),
            },
            server: SftpServer {
                host: "127.0.0.1".into(),
                port: sftp_port,
                folder: "/configs/".into(),
                username: SFTP_USER.into(),
                password: Secret::new(SFTP_PASSWORD),
            },
        }),
    }
}

async fn run(options: BackupOptions) -> (coreview_discover::capture::BackupRun, Vec<BackupEvent>) {
    let (tx, mut rx) = mpsc::channel(256);
    let targets = vec![BackupTarget { address: "127.0.0.1".into(), name: "typed-name".into(), commands: Vec::new(), site: String::new() }];
    let run = run_backups(
        targets,
        no_ssh_login(),
        options,
        Arc::new(std::sync::Mutex::new(HostKeyStore::new())),
        STAMP.to_string(),
        tx,
        CancellationToken::new(),
    )
    .await;
    let mut events = Vec::new();
    while let Ok(e) = rx.try_recv() {
        events.push(e);
    }
    (run, events)
}

fn notes(events: &[BackupEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            BackupEvent::Note { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_running_config_asked_for_over_snmp_is_fetched_from_the_sftp_server_and_filed() {
    let expected_path = format!("/configs/{SYS_NAME}-running-config-{STAMP}.cfg");
    let sftp = sftp_server(SFTP_USER, SFTP_PASSWORD, HashMap::from([(expected_path.clone(), CONFIG.as_bytes().to_vec())])).await;
    let agent = snmp_agent(COMMUNITY, SYS_NAME, Copying::Succeeds).await;
    let root = temp_root("running");

    let (run, events) = run(options(root.clone(), agent.port, sftp.port, vec![BackupKind::Running])).await;

    assert!(run.failed.is_empty(), "{:?}", run.failed);
    assert_eq!(run.saved.len(), 1, "{:?}", run.saved);
    let saved = &run.saved[0];
    assert_eq!(saved.name, SYS_NAME, "filed under the device's own name, as an SSH backup is");
    assert_eq!(saved.kind, BackupKind::Running);
    assert_eq!(std::fs::read_to_string(&saved.path).unwrap(), CONFIG, "the file reaches the folder intact");
    assert!(saved.path.starts_with(root.to_str().unwrap()));

    // What the device was told, column by column.
    let sets = agent.sets.lock().unwrap().clone();
    assert_eq!(sets.len(), 2, "one SET creates the row, one destroys it: {sets:?}");
    let create = &sets[0];
    let col = |n: u64| -> &Seen {
        let prefix = format!("{CC_COPY_ENTRY}.{n}.");
        &create.iter().find(|(oid, _)| oid.starts_with(&prefix)).unwrap_or_else(|| panic!("column {n} not written: {create:?}")).1
    };
    assert_eq!(col(2), &Seen::Int(5), "ccCopyProtocol sftp");
    assert_eq!(col(3), &Seen::Int(4), "ccCopySourceFileType runningConfig");
    assert_eq!(col(4), &Seen::Int(1), "ccCopyDestFileType networkFile");
    assert_eq!(col(15), &Seen::Int(1), "ccCopyServerAddressType ipv4");
    assert_eq!(col(16), &Seen::Oct(vec![127, 0, 0, 1]), "ccCopyServerAddressRev1 as four octets");
    assert_eq!(col(6).text(), expected_path, "ccCopyFileName is the folder and the file");
    assert_eq!(col(7).text(), SFTP_USER);
    assert_eq!(col(8).text(), SFTP_PASSWORD, "the device logs in to the server itself, so it is given the login");
    assert_eq!(col(14), &Seen::Int(4), "ccCopyEntryRowStatus createAndGo");
    let row = create.iter().find(|(oid, _)| oid.starts_with(&format!("{CC_COPY_ENTRY}.14."))).unwrap().0.rsplit('.').next().unwrap().to_string();
    let destroy = &sets[1];
    assert_eq!(destroy.len(), 1);
    assert_eq!(destroy[0].0, format!("{CC_COPY_ENTRY}.14.{row}"), "the same row is destroyed");
    assert_eq!(destroy[0].1, Seen::Int(6), "RowStatus destroy");

    // And the server was asked for exactly that file.
    assert_eq!(sftp.opened.lock().unwrap().clone(), vec![expected_path]);
    let said = notes(&events);
    assert!(said.iter().any(|n| n.contains("asked over SNMP to send its running-config")), "{said:?}");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn both_configurations_travel_as_two_files() {
    let running = format!("/configs/{SYS_NAME}-running-config-{STAMP}.cfg");
    let startup = format!("/configs/{SYS_NAME}-startup-config-{STAMP}.cfg");
    let sftp = sftp_server(
        SFTP_USER,
        SFTP_PASSWORD,
        HashMap::from([(running.clone(), CONFIG.as_bytes().to_vec()), (startup.clone(), STARTUP.as_bytes().to_vec())]),
    )
    .await;
    let agent = snmp_agent(COMMUNITY, SYS_NAME, Copying::Succeeds).await;
    let root = temp_root("both");

    let (run, events) = run(options(root.clone(), agent.port, sftp.port, vec![BackupKind::Running, BackupKind::Startup])).await;

    assert!(run.failed.is_empty(), "{:?}", run.failed);
    let kinds: Vec<BackupKind> = run.saved.iter().map(|s| s.kind).collect();
    assert_eq!(kinds, vec![BackupKind::Running, BackupKind::Startup], "{:?}", notes(&events));
    let sets = agent.sets.lock().unwrap().clone();
    let sources: Vec<&Seen> = sets
        .iter()
        .filter_map(|s| s.iter().find(|(oid, _)| oid.starts_with(&format!("{CC_COPY_ENTRY}.3."))).map(|(_, v)| v))
        .collect();
    assert_eq!(sources, vec![&Seen::Int(4), &Seen::Int(3)], "runningConfig then startupConfig");
    assert_eq!(sftp.opened.lock().unwrap().clone(), vec![running, startup]);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_device_without_the_table_is_reported_so_and_with_no_ssh_login_there_is_nothing_to_fall_back_to() {
    let sftp = sftp_server(SFTP_USER, SFTP_PASSWORD, HashMap::new()).await;
    let agent = snmp_agent(COMMUNITY, "SOME-OTHER-MAKER", Copying::NoTable).await;
    let root = temp_root("notable");

    let (run, events) = run(options(root.clone(), agent.port, sftp.port, vec![BackupKind::Running, BackupKind::Startup])).await;

    assert!(run.saved.is_empty());
    assert_eq!(run.failed.len(), 1, "{:?}", run.failed);
    let reason = &run.failed[0].reason;
    assert!(reason.contains("no configuration-copy table over SNMP"), "{reason}");
    assert!(reason.contains("notWritable"), "{reason}");
    assert!(reason.contains("no SSH login was given to fall back to"), "{reason}");
    // One refusal is the device's answer for every kind.
    assert_eq!(agent.sets.lock().unwrap().len(), 1, "the startup copy is not asked for after the running one was refused");
    assert!(sftp.opened.lock().unwrap().is_empty(), "nothing is fetched for a copy that never happened");
    assert!(notes(&events).iter().any(|n| n.contains("trying SSH instead")), "{:?}", notes(&events));
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_read_only_credential_is_told_apart_from_a_missing_table() {
    let sftp = sftp_server(SFTP_USER, SFTP_PASSWORD, HashMap::new()).await;
    let agent = snmp_agent(COMMUNITY, SYS_NAME, Copying::ReadOnly).await;
    let root = temp_root("readonly");

    let (run, _) = run(options(root.clone(), agent.port, sftp.port, vec![BackupKind::Running])).await;

    let reason = &run.failed[0].reason;
    assert!(reason.contains("refused the SNMP write"), "{reason}");
    assert!(reason.contains("read-only"), "{reason}");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_copy_the_device_reports_failed_names_the_cause_and_the_row_is_still_destroyed() {
    let sftp = sftp_server(SFTP_USER, SFTP_PASSWORD, HashMap::new()).await;
    // ccCopyFailCause timeout(3): the device could not reach the server.
    let agent = snmp_agent(COMMUNITY, SYS_NAME, Copying::Fails(3)).await;
    let root = temp_root("failed");

    let (run, _) = run(options(root.clone(), agent.port, sftp.port, vec![BackupKind::Running])).await;

    let reason = &run.failed[0].reason;
    assert!(reason.contains("could not send its configuration"), "{reason}");
    assert!(reason.contains("can the device reach the SFTP server"), "{reason}");
    let sets = agent.sets.lock().unwrap().clone();
    assert_eq!(sets.len(), 2, "{sets:?}");
    assert_eq!(sets[1][0].1, Seen::Int(6), "the row is destroyed after a failure too");
    assert!(sftp.opened.lock().unwrap().is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_the_server_does_not_have_blames_the_server_not_the_device() {
    let sftp = sftp_server(SFTP_USER, SFTP_PASSWORD, HashMap::new()).await;
    let agent = snmp_agent(COMMUNITY, SYS_NAME, Copying::Succeeds).await;
    let root = temp_root("nofile");

    let (run, _) = run(options(root.clone(), agent.port, sftp.port, vec![BackupKind::Running])).await;

    let reason = &run.failed[0].reason;
    assert!(reason.contains("has no file at"), "{reason}");
    assert!(reason.contains(&format!("/configs/{SYS_NAME}-running-config-{STAMP}.cfg")), "{reason}");
    assert!(std::fs::read_dir(&root).unwrap().next().is_none(), "no folder is created for a capture that never arrived");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wrong_sftp_login_is_reported_as_the_servers_refusal() {
    let expected_path = format!("/configs/{SYS_NAME}-running-config-{STAMP}.cfg");
    let sftp = sftp_server("someone-else", "another-fake-password", HashMap::from([(expected_path, CONFIG.as_bytes().to_vec())])).await;
    let agent = snmp_agent(COMMUNITY, SYS_NAME, Copying::Succeeds).await;
    let root = temp_root("badlogin");

    let (run, _) = run(options(root.clone(), agent.port, sftp.port, vec![BackupKind::Running])).await;

    let reason = &run.failed[0].reason;
    assert!(reason.contains("the SFTP server"), "{reason}");
    assert!(reason.contains("rejected the credentials"), "{reason}");
    let _ = std::fs::remove_dir_all(root);
}
