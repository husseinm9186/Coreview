//! The real sidecar — scrapli over paramiko, TextFSM with the vendored
//! templates — logging into a fake IOS switch served by russh, driven by
//! the collector end to end: fingerprint through a generic session, then
//! the catalog session, probes, plan, commands parsed into rows.
//!
//! Needs the development sidecar (`sidecar/.venv`, see sidecar/README.md)
//! or `COREVIEW_SIDECAR_PYTHON`; without either the test says so and
//! passes, because `cargo test` must run on a machine with no Python.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use coreview_catalog::load_dir;
use coreview_collect::run::{collect_device, Quiet, RunOptions, Target};
use coreview_collect::sidecar::{Auth, Sidecar, SidecarLocation};
use russh::server::{self, Auth as SshAuth, Msg, Session};
use russh::{Channel, ChannelId};

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn dev_sidecar() -> Option<SidecarLocation> {
    let templates = repo().join("resources/templates/ntc");
    if let Ok(python) = std::env::var("COREVIEW_SIDECAR_PYTHON") {
        let cwd = std::env::var("COREVIEW_SIDECAR_DIR").map(PathBuf::from).unwrap_or_else(|_| repo().join("sidecar"));
        return Some(SidecarLocation { python: PathBuf::from(python), cwd, templates_dir: templates });
    }
    let venv = repo().join("sidecar/.venv/bin/python");
    venv.exists().then(|| SidecarLocation { python: venv, cwd: repo().join("sidecar"), templates_dir: templates })
}

/// One per connection (russh clones the handler); `pending` holds input
/// until a newline, the way a real console does — scrapli writes the
/// command and the return as two packets, and answering the first would
/// hand it the whole reply as the echo.
#[derive(Clone, Default)]
struct FakeSwitch {
    pending: String,
}

impl server::Handler for FakeSwitch {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<SshAuth, Self::Error> {
        if password == "correct-horse-fixture" {
            Ok(SshAuth::Accept)
        } else {
            Ok(SshAuth::Reject { proceed_with_methods: None, partial_success: false })
        }
    }

    async fn channel_open_session(&mut self, _channel: Channel<Msg>, reply: server::ChannelOpenHandle, _session: &mut Session) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn pty_request(&mut self, channel: ChannelId, _term: &str, _cw: u32, _rh: u32, _pw: u32, _ph: u32, _modes: &[(russh::Pty, u32)], session: &mut Session) -> Result<(), Self::Error> {
        // paramiko waits for the request's answer; a real device sends one.
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, b"\r\nSW1#".to_vec())?;
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        let typed = String::from_utf8_lossy(data).to_string();
        // A console echoes what is typed as it is typed, and runs the line on return.
        session.data(channel, typed.replace('\n', "\r\n").into_bytes())?;
        self.pending.push_str(&typed);
        let Some(nl) = self.pending.find(['\n', '\r']) else { return Ok(()) };
        let line: String = self.pending.drain(..=nl).collect();
        self.pending = self.pending.trim_start_matches(['\r', '\n']).to_string();
        let command = line.trim();
        let body: String = match command {
            "" | "terminal length 0" | "terminal width 512" | "terminal width 511" | "enable" => String::new(),
            "show version" => "Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(4)E7, RELEASE SOFTWARE (fc2)\r\n\
                 Technical Support: http://www.cisco.com/techsupport\r\n\
                 Copyright (c) 1986-2018 by Cisco Systems, Inc.\r\n\
                 Compiled Tue 18-Sep-18 13:07 by prod_rel_team\r\n\r\n\
                 ROM: Bootstrap program is C2960X boot loader\r\n\
                 BOOTLDR: C2960X Boot Loader (C2960X-HBOOT-M) Version 15.2(3r)E, RELEASE SOFTWARE (fc1)\r\n\r\n\
                 SW1 uptime is 3 weeks, 2 days, 4 hours, 12 minutes\r\n\
                 System returned to ROM by power-on\r\n\
                 System image file is \"flash:/c2960x-universalk9-mz.152-4.E7/c2960x-universalk9-mz.152-4.E7.bin\"\r\n\r\n\
                 cisco WS-C2960X-24TS-L (APM86XXX) processor (revision A0) with 524288K bytes of memory.\r\n\
                 Processor board ID FAKE0000001\r\n\
                 Last reset from power-on\r\n\
                 24 Gigabit Ethernet interfaces\r\n\
                 512K bytes of flash-simulated non-volatile configuration memory.\r\n\
                 Base ethernet MAC Address       : 00:00:00:00:00:01\r\n\
                 Model number                    : WS-C2960X-24TS-L\r\n\
                 System serial number            : FAKE0000001\r\n\r\n\
                 Switch Ports Model                     SW Version            SW Image\r\n\
                 ------ ----- -----                     ----------            ----------\r\n\
                 *    1 28    WS-C2960X-24TS-L          15.2(4)E7             C2960X-UNIVERSALK9-M\r\n\r\n\
                 Configuration register is 0xF\r\n"
                .into(),
            "show ip protocols" => "*** IP Routing is NSF aware ***\r\n\r\nRouting Protocol is \"ospf 1\"\r\n  Router ID 192.0.2.10\r\n".into(),
            "show ip arp" => "Protocol  Address          Age (min)  Hardware Addr   Type   Interface\r\n\
                 Internet  192.0.2.1               0   0000.0000.0001  ARPA   Vlan10\r\n\
                 Internet  192.0.2.10              -   0000.0000.0010  ARPA   Vlan10\r\n"
                .into(),
            "show ip interface brief" => "Interface              IP-Address      OK? Method Status                Protocol\r\n\
                 Vlan10                 192.0.2.10      YES NVRAM  up                    up\r\n\
                 GigabitEthernet1/0/1   unassigned      YES unset  up                    up\r\n"
                .into(),
            "show cdp neighbors detail" => "-------------------------\r\n\
                 Device ID: SW2.lab.example.net\r\n\
                 Entry address(es):\r\n  IP address: 192.0.2.11\r\n\
                 Platform: cisco WS-C2960X-24TS-L,  Capabilities: Switch IGMP\r\n\
                 Interface: GigabitEthernet1/0/1,  Port ID (outgoing port): GigabitEthernet1/0/2\r\n\
                 Holdtime : 137 sec\r\n\r\n\
                 Version :\r\nCisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(4)E7\r\n\r\n\
                 advertisement version: 2\r\n\
                 Total cdp entries displayed : 1\r\n"
                .into(),
            "show running-config" => "Building configuration...\r\n\r\nhostname SW1\r\nenable secret 5 $1$FAKE$notarealhash\r\nsnmp-server community FAKE-COMMUNITY RO\r\nend\r\n".into(),
            _ => "% Invalid input detected at '^' marker.\r\n".into(),
        };
        session.data(channel, format!("{body}SW1#").into_bytes())?;
        Ok(())
    }
}

async fn start_switch() -> u16 {
    let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).expect("host key");
    let config = Arc::new(server::Config { inactivity_timeout: Some(Duration::from_secs(60)), auth_rejection_time: Duration::from_millis(1), keys: vec![key], ..Default::default() });
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let config = Arc::clone(&config);
            tokio::spawn(async move {
                let _ = server::run_stream(config, stream, FakeSwitch::default()).await;
            });
        }
    });
    port
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_real_sidecar_logs_into_a_fake_switch_and_the_collector_reads_it() {
    let Some(location) = dev_sidecar() else {
        eprintln!("skipped: no development sidecar (sidecar/.venv or COREVIEW_SIDECAR_PYTHON)");
        return;
    };
    let port = start_switch().await;
    let catalogs = load_dir(&repo().join("resources/catalog")).unwrap();
    let mut sidecar = Sidecar::spawn(&location).await.expect("the sidecar starts from the venv");
    let hello = sidecar.hello.clone().unwrap();
    assert_eq!(hello.extra.get("protocol").and_then(|v| v.as_u64()), Some(1));
    let target = Target { host: "127.0.0.1".into(), port, os_hint: None, role_override: None };
    let auth = Auth { username: "reader".into(), password: "correct-horse-fixture".into(), enable: None, private_key: None };
    let run = collect_device(&mut sidecar, &catalogs, &target, &auth, &RunOptions::default(), &Quiet).await;
    let events = sidecar.drain_events();
    assert_eq!(run.failure, None, "log: {:?}\nevents: {:?}", run.log, events.iter().map(|e| format!("{:?}", e.extra)).collect::<Vec<_>>());
    assert_eq!(run.os.as_deref(), Some("cisco_ios"));
    assert_eq!(run.identified_by.as_deref(), Some("show version"));
    assert!(run.prompt.contains("SW1#"), "{:?}", run.prompt);
    assert_eq!(run.role.as_deref(), Some("switch"));
    assert!(run.caps.contains(&"ospf".to_string()), "{:?}", run.caps);
    let by = |cmd: &str| run.results.iter().find(|r| r.step.cmd == cmd).unwrap_or_else(|| panic!("{cmd} not run: {:?}", run.results.iter().map(|r| &r.step.cmd).collect::<Vec<_>>()));
    let version = by("show version");
    assert_eq!(version.outcome.status, "ok");
    assert_eq!(version.outcome.rows[0]["hostname"], "SW1");
    assert_eq!(version.outcome.rows[0]["version"], "15.2(4)E7");
    assert_eq!(version.outcome.rows[0]["serial"][0], "FAKE0000001");
    let arp = by("show ip arp");
    assert_eq!(arp.outcome.rows.len(), 2, "{}", arp.outcome.raw);
    assert_eq!(arp.outcome.rows[0]["ip_address"], "192.0.2.1");
    assert_eq!(arp.outcome.rows[0]["mac_address"], "0000.0000.0001");
    let cdp = by("show cdp neighbors detail");
    assert_eq!(cdp.outcome.rows[0]["neighbor_name"], "SW2.lab.example.net");
    assert_eq!(cdp.outcome.rows[0]["mgmt_address"], "192.0.2.11");
    assert_eq!(cdp.outcome.rows[0]["local_interface"], "GigabitEthernet1/0/1");
    let cfg = by("show running-config");
    assert!(!cfg.outcome.raw.contains("FAKE-COMMUNITY") && !cfg.outcome.raw.contains("$1$FAKE"), "{}", cfg.outcome.raw);
    assert!(cfg.outcome.raw.contains("hostname SW1"));
    let unsupported = run.results.iter().filter(|r| r.outcome.status == "unsupported").count();
    assert!(unsupported > 0, "the fake refuses most commands, and that is recorded, not fatal");
    let wrong = Auth { username: "reader".into(), password: "wrong-password-fixture".into(), enable: None, private_key: None };
    let run2 = collect_device(&mut sidecar, &catalogs, &target, &wrong, &RunOptions::default(), &Quiet).await;
    assert_eq!(run2.failure.as_deref(), Some("auth"), "{:?}", run2.log);
    sidecar.quit().await;
}
