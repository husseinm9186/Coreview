//! 1: `Device::hop_to` drives a real channel into a second device.
//!
//! One SSH server stands in for a jump host: on a shell it draws its own
//! prompt; given an `ssh` command it answers the fingerprint question, then a
//! password prompt, then draws the *target's* prompt and answers a couple of
//! that target's commands — exactly the sequence captured when
//! sshing from an SN2010 to a 6200. The test logs in, hops, and checks it
//! landed at the target and can read the target's `show version`.

use std::sync::Arc;
use std::time::Duration;

use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId};

use coreview_discover::hop::HopDialect;
use coreview_discover::hostkeys::HostKeyStore;
use coreview_discover::ssh::{Credentials, Device, Secret, SshOptions};

/// How far into the hop this connection has got.
#[derive(Clone, Copy, PartialEq)]
enum Stage {
    AtJump,
    AskedFingerprint,
    AskedPassword,
    AtTarget,
}

#[derive(Clone)]
struct JumpHost {
    stage: Stage,
}

impl server::Handler for JumpHost {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        if password == "correct-horse" {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject { proceed_with_methods: None, partial_success: false })
        }
    }

    async fn channel_open_session(&mut self, _c: Channel<Msg>, reply: server::ChannelOpenHandle, _s: &mut Session) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(&mut self, _c: ChannelId, _t: &str, _cw: u32, _rh: u32, _pw: u32, _ph: u32, _m: &[(russh::Pty, u32)], _s: &mut Session) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        session.data(channel, b"\r\nnetops@leaf-b02:mgmt:~$ ".to_vec())?;
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        let line = String::from_utf8_lossy(data);
        let command = line.trim();
        let reply: String = match self.stage {
            Stage::AtJump => {
                if command.starts_with("ssh ") && command.contains("198.51.100.4") {
                    self.stage = Stage::AskedFingerprint;
                    // The echo, then the fingerprint question.
                    format!("{command}\r\nThe authenticity of host '198.51.100.4' can't be established.\r\nED25519 key fingerprint is SHA256:Example.\r\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ")
                } else if command == "terminal length 0" || command == "no page" {
                    // paging attempts on the jump host before any hop
                    "\r\nnetops@leaf-b02:mgmt:~$ ".into()
                } else {
                    format!("{command}\r\nnetops@leaf-b02:mgmt:~$ ")
                }
            }
            Stage::AskedFingerprint => {
                // Whatever came (the "yes"), move to the password prompt.
                self.stage = Stage::AskedPassword;
                "\r\nWarning: Permanently added '198.51.100.4'.\r\nnetops@198.51.100.4's password: ".into()
            }
            Stage::AskedPassword => {
                // The password line: land at the target's prompt.
                self.stage = Stage::AtTarget;
                "\r\nLast login: 2026-10-06 17:13:33\r\ncx-1# ".into()
            }
            Stage::AtTarget => match command {
                "exit" => {
                    self.stage = Stage::AtJump;
                    "\r\nnetops@leaf-b02:mgmt:~$ ".into()
                }
                "terminal length 0" => "\r\ncx-1# ".into(),
                "no page" => "\r\ncx-1# ".into(),
                "show version" => "ArubaOS-CX\r\n(c) Copyright 2017-2026 Hewlett Packard Enterprise\r\nVersion : ML.10.18.1002\r\ncx-1# ".into(),
                other => format!("{other}\r\n% Invalid input\r\ncx-1# "),
            },
        };
        session.data(channel, reply.into_bytes())?;
        Ok(())
    }
}

async fn start(port: u16) {
    let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let config = Arc::new(server::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        auth_rejection_time: Duration::from_millis(1),
        keys: vec![key],
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let config = Arc::clone(&config);
            tokio::spawn(async move {
                let _ = server::run_stream(config, stream, JumpHost { stage: Stage::AtJump }).await;
            });
        }
    });
}

async fn free_port() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    port
}

#[tokio::test]
async fn a_device_hops_from_a_jump_host_into_the_next_device() {
    let port = free_port().await;
    start(port).await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let creds = Credentials { username: "netops".into(), password: Secret::new("correct-horse"), enable_password: None };
    let options = SshOptions { port, connect_timeout: Duration::from_secs(5), auth_timeout: Duration::from_secs(10), command_timeout: Duration::from_secs(10), ..SshOptions::default() };

    // Log in to the jump host.
    let mut device = Device::connect("127.0.0.1", &creds, options, store, None).await.expect("login to the jump host");
    assert_eq!(device.hostname(), "leaf-b02");

    // Hop from it into the next device over its own OpenSSH.
    device
        .hop_to(HopDialect::OpenSsh, "netops", "198.51.100.4", &Secret::new("correct-horse"), None)
        .await
        .expect("the hop lands");
    assert_eq!(device.hostname(), "cx-1", "we are at the target's prompt now");

    // And we can drive the target: its banner reads as AOS-CX.
    let version = device.run("show version").await.expect("run on the target");
    assert!(version.contains("ArubaOS-CX") && version.contains("ML.10.18.1002"), "{version:?}");
}

#[tokio::test]
async fn a_hop_to_a_dead_address_fails_with_a_reason() {
    let port = free_port().await;
    start(port).await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let creds = Credentials { username: "netops".into(), password: Secret::new("correct-horse"), enable_password: None };
    let options = SshOptions { port, connect_timeout: Duration::from_secs(5), auth_timeout: Duration::from_secs(3), command_timeout: Duration::from_secs(3), ..SshOptions::default() };
    let mut device = Device::connect("127.0.0.1", &creds, options, store, None).await.unwrap();
    // The jump host only knows how to reach 198.51.100.4; anything else just
    // echoes back its own prompt, so the hop never lands and times out with a
    // hop error naming the device it could not reach.
    let err = device.hop_to(HopDialect::OpenSsh, "netops", "10.0.0.99", &Secret::new("x"), None).await.unwrap_err();
    assert!(matches!(err, coreview_discover::ssh::SshError::Hop { .. }), "{err:?}");
    assert!(err.to_string().contains("10.0.0.99"), "{err}");
}
