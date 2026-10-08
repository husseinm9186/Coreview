//! A fake IOS switch on loopback, for driving the real sidecar by hand:
//!
//!     cargo run -p coreview-collect --example fake_switch [port]
//!
//! Password `correct-horse-fixture`, prompt `SW1#`, a handful of `show`
//! answers, `% Invalid input` for the rest. The same answers as
//! `tests/real_sidecar_against_a_fake_switch.rs`. A lab harness: kept.

use std::sync::Arc;
use std::time::Duration;

use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId};

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

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        if password == "correct-horse-fixture" {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject { proceed_with_methods: None, partial_success: false })
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
        eprintln!("shell requested");
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
        eprintln!("asked: {command:?}");
        let body: String = match command {
            "" | "terminal length 0" | "terminal width 512" | "terminal width 511" | "enable" => String::new(),
            "show version" => "Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(4)E7, RELEASE SOFTWARE (fc2)\r\nSW1 uptime is 3 weeks\r\ncisco WS-C2960X-24TS-L (APM86XXX) processor (revision A0) with 524288K bytes of memory.\r\nProcessor board ID FAKE0000001\r\nModel number                    : WS-C2960X-24TS-L\r\nSystem serial number            : FAKE0000001\r\n".into(),
            "show ip arp" => "Protocol  Address          Age (min)  Hardware Addr   Type   Interface\r\nInternet  192.0.2.1               0   0000.0000.0001  ARPA   Vlan10\r\n".into(),
            _ => "% Invalid input detected at '^' marker.\r\n".into(),
        };
        session.data(channel, format!("{body}SW1#").into_bytes())?;
        Ok(())
    }
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::args().nth(1).and_then(|p| p.parse().ok()).unwrap_or(2222);
    let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).expect("host key");
    let config = Arc::new(server::Config { inactivity_timeout: Some(Duration::from_secs(120)), auth_rejection_time: Duration::from_millis(1), keys: vec![key], ..Default::default() });
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.expect("bind");
    println!("fake switch on 127.0.0.1:{port} (password correct-horse-fixture)");
    loop {
        let Ok((stream, _)) = listener.accept().await else { break };
        let config = Arc::clone(&config);
        tokio::spawn(async move {
            if let Err(e) = server::run_stream(config, stream, FakeSwitch::default()).await {
                eprintln!("session ended: {e}");
            }
        });
    }
}
