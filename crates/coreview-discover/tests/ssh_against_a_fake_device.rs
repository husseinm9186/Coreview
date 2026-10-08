//! Drives the real SSH client against a fake device.
//!
//! There is no network equipment on the machine this was written on, and the
//! parts of SSH most likely to be wrong — the handshake, the authentication
//! exchange, the Duo pause, reading until a prompt — cannot be checked by
//! feeding text to a parser. So the tests stand up an actual SSH server that
//! behaves like a switch, and point the actual client at it over a real socket.
//!
//! What this proves: the client connects, verifies a host key, survives a
//! password rejection, completes a keyboard-interactive exchange, waits through
//! a second-factor round that returns nothing to type, takes a shell, and reads
//! command output back cleanly.
//!
//! What it does not prove: how any particular vendor's box behaves. A real
//! device has a banner, its own paging quirks, and its own idea of when to
//! echo. That still needs one real device.

use std::sync::Arc;
use std::time::Duration;

use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId, MethodKind, MethodSet};
use tokio::sync::mpsc;

use coreview_discover::hostkeys::HostKeyStore;
use coreview_discover::ssh::{Credentials, Device, Secret, SshError, SshOptions, SshProgress};

/// How the fake device should behave when asked to authenticate.
#[derive(Clone, Copy, PartialEq)]
enum AuthStyle {
    /// Accepts the password immediately. The simple case.
    PasswordOnly,
    /// Refuses password auth, then runs keyboard-interactive: asks for the
    /// password, then sends a round with no prompts at all — which is what
    /// push-only Duo looks like on the wire — and only then succeeds.
    DuoPush,
    /// Refuses everything.
    AlwaysReject,
}

#[derive(Clone)]
struct FakeDevice {
    style: AuthStyle,
    hostname: String,
    /// How far through the keyboard-interactive exchange this connection is.
    step: Arc<std::sync::Mutex<u8>>,
}

impl server::Handler for FakeDevice {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        match self.style {
            AuthStyle::PasswordOnly if password == "correct-horse" => Ok(Auth::Accept),
            // Refusing password auth is what pushes a real device's client on
            // to keyboard-interactive, where Duo lives.
            _ => Ok(Auth::Reject {
                proceed_with_methods: Some(MethodSet::from(&[MethodKind::KeyboardInteractive][..])),
                partial_success: false,
            }),
        }
    }

    async fn auth_keyboard_interactive(
        &mut self,
        _user: &str,
        _submethods: &str,
        response: Option<server::Response<'_>>,
    ) -> Result<Auth, Self::Error> {
        if self.style == AuthStyle::AlwaysReject {
            return Ok(Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            });
        }

        let mut step = self.step.lock().unwrap();
        match *step {
            0 => {
                *step = 1;
                Ok(Auth::Partial {
                    name: "Password".into(),
                    instructions: "".into(),
                    prompts: vec![("Password: ".into(), false)].into(),
                })
            }
            1 => {
                // Check what came back for the password prompt.
                let answered: Vec<String> = response
                    .map(|r| r.map(|b| String::from_utf8_lossy(&b).to_string()).collect())
                    .unwrap_or_default();
                if answered.first().map(String::as_str) != Some("correct-horse") {
                    return Ok(Auth::Reject {
                        proceed_with_methods: None,
                        partial_success: false,
                    });
                }
                *step = 2;
                // The Duo round: an instruction and nothing to type. A client
                // that insists on collecting an answer from a human stalls
                // here forever.
                Ok(Auth::Partial {
                    name: "Duo".into(),
                    instructions: "Duo two-factor login for admin".into(),
                    prompts: vec![].into(),
                })
            }
            _ => Ok(Auth::Accept),
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
        // A device draws its prompt as soon as the shell is up. That is the
        // only signal the client gets that login finished.
        session.data(channel, format!("\r\n{}#", self.hostname).into_bytes())?;
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

        // Echo the command after the prompt, exactly as a real terminal does —
        // this is the case that broke extract_output before it was fixed.
        let body = match command {
            "terminal length 0" => String::new(),
            "show version" => "Cisco IOS Software, Version 15.2(4)E7\r\nuptime is 3 weeks\r\n".into(),
            "show running-config" => {
                let mut c = String::from("Building configuration...\r\n\r\n");
                c.push_str("Current configuration : 1234 bytes\r\n!\r\nversion 15.2\r\n!\r\n");
                c.push_str(&format!("hostname {}\r\n!\r\n", self.hostname));
                for i in 1..=4 {
                    c.push_str(&format!("interface GigabitEthernet0/{i}\r\n switchport mode access\r\n!\r\n"));
                }
                // A banner containing a bare '#', which is the thing that used
                // to truncate a capture by looking like a prompt.
                c.push_str("banner motd #\r\nUnauthorized access prohibited\r\n#\r\n!\r\nend\r\n");
                c
            }
            // A device that streams and never draws a prompt — a
            // `terminal monitor` left on, a log that never pages. Sent in
            // chunks the way a real channel delivers it, with no prompt at the
            // end of any of them.
            "show log" => {
                session.data(channel, format!("{command}\r\n").into_bytes())?;
                let line = "%SYS-5-CONFIG_I: Configured from console by admin on vty0 (192.0.2.10)\r\n";
                let chunk = line.repeat(64).into_bytes();
                for _ in 0..64 {
                    session.data(channel, chunk.clone())?;
                }
                return Ok(());
            }
            // A traceroute whose later hops are silent — three hops
            // printed, then nothing and no prompt before the client gives up.
            "traceroute 198.51.100.9" => {
                session.data(channel, format!("{command}\r\nType escape sequence to abort.\r\nTracing the route to 198.51.100.9\r\n").into_bytes())?;
                session.data(channel, b"  1 192.0.2.1 1 msec 0 msec 1 msec\r\n".to_vec())?;
                session.data(channel, b"  2 203.0.113.1 12 msec 10 msec 11 msec\r\n".to_vec())?;
                session.data(channel, b"  3  *  *  * \r\n".to_vec())?;
                return Ok(());
            }
            _ => "% Invalid input detected at '^' marker.\r\n".into(),
        };

        session.data(channel, format!("{command}\r\n{body}{}#", self.hostname).into_bytes())?;
        Ok(())
    }
}

/// Starts a fake device on a random port and returns its address.
async fn start_device(style: AuthStyle, hostname: &str) -> String {
    let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
        .expect("generate host key");
    let config = Arc::new(server::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        auth_rejection_time: Duration::from_millis(1),
        keys: vec![key],
        ..Default::default()
    });

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handler = FakeDevice {
        style,
        hostname: hostname.to_string(),
        step: Arc::new(std::sync::Mutex::new(0)),
    };

    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let config = Arc::clone(&config);
            // A fresh handler per connection, so the keyboard-interactive step
            // counter does not leak between tests.
            let handler = FakeDevice {
                step: Arc::new(std::sync::Mutex::new(0)),
                ..handler.clone()
            };
            tokio::spawn(async move {
                let _ = server::run_stream(config, stream, handler).await;
            });
        }
    });

    addr.to_string()
}

fn creds(password: &str) -> Credentials {
    Credentials {
        username: "admin".into(),
        password: Secret::new(password),
        enable_password: None,
    }
}

fn options(port: u16) -> SshOptions {
    SshOptions {
        port,
        connect_timeout: Duration::from_secs(10),
        auth_timeout: Duration::from_secs(20),
        command_timeout: Duration::from_secs(10),
        login_transcript: None,
        support_capture: None,
        max_output_bytes: coreview_discover::ssh::DEFAULT_MAX_OUTPUT_BYTES,
    }
}

fn port_of(addr: &str) -> u16 {
    addr.rsplit(':').next().unwrap().parse().unwrap()
}

#[tokio::test]
async fn connects_authenticates_and_runs_a_command() {
    let addr = start_device(AuthStyle::PasswordOnly, "CORE-SW-01").await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));

    let mut device = Device::connect("127.0.0.1", &creds("correct-horse"), options(port_of(&addr)), store, None)
        .await
        .expect("should connect and log in");

    assert_eq!(device.hostname(), "CORE-SW-01", "the prompt names the device");

    let out = device.run("show version").await.unwrap();
    assert!(out.contains("Cisco IOS Software"), "got: {out:?}");
    assert!(!out.contains("show version"), "the echo leaked: {out:?}");
    assert!(!out.contains("CORE-SW-01#"), "the prompt leaked: {out:?}");

    device.close().await;
}

/// A command's output is bounded in bytes, not only in seconds.
///
/// Before the ceiling this waited out the whole `command_timeout` while the
/// buffer grew and the screen was rendered on every chunk, and then reported
/// a timeout — which says nothing about what the device was doing.
#[tokio::test]
async fn a_command_that_streams_without_a_prompt_is_abandoned_at_the_ceiling() {
    let addr = start_device(AuthStyle::PasswordOnly, "LAB-SW2").await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let mut options = options(port_of(&addr));
    // Far below the default, so the test says something about the rule and
    // not about how fast loopback is. The device sends about 300 KB.
    options.max_output_bytes = 64 * 1024;
    // Long enough that only the ceiling can end the wait.
    options.command_timeout = Duration::from_secs(20);

    let mut device = Device::connect("127.0.0.1", &creds("correct-horse"), options, store, None)
        .await
        .expect("connect");
    let started = std::time::Instant::now();
    let error = match device.run("show log").await {
        Ok(out) => panic!("it never prompts, so this cannot succeed; got {} bytes", out.len()),
        Err(e) => e,
    };
    assert!(
        matches!(error, SshError::OutputTooLarge { limit: 65_536, .. }),
        "the ceiling, not the timeout: {error:?}"
    );
    assert!(started.elapsed() < Duration::from_secs(10), "it did not wait for the timeout");
    let said = error.to_string();
    assert!(said.contains("show log") && said.contains("abandoned"), "{said}");
    assert!(!said.contains("CONFIG_I"), "no output in the error");
}

#[tokio::test]
async fn a_duo_push_completes_without_anything_to_type() {
    // The case this whole design exists for: the device refuses password auth,
    // asks for the password over keyboard-interactive, then sends a round with
    // no prompts while a push is outstanding. A client that waits for a human
    // to type something stalls here forever.
    let addr = start_device(AuthStyle::DuoPush, "EDGE-RTR").await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, mut rx) = mpsc::channel(32);

    let device = Device::connect(
        "127.0.0.1",
        &creds("correct-horse"),
        options(port_of(&addr)),
        store,
        Some(tx),
    )
    .await
    .expect("a push-only Duo exchange should complete on its own");

    assert_eq!(device.hostname(), "EDGE-RTR");

    // And the user was told to look at their phone — without this a push is
    // indistinguishable from a hang.
    let mut told = None;
    while let Ok(p) = rx.try_recv() {
        if let SshProgress::AwaitingSecondFactor { message, .. } = p {
            told = Some(message);
        }
    }
    let message = told.expect("the UI must be told a second factor is pending");
    assert!(message.contains("Duo two-factor login"), "got: {message}");
    assert!(message.contains("phone"), "got: {message}");

    device.close().await;
}

#[tokio::test]
async fn a_configuration_survives_a_banner_containing_a_hash() {
    // A '#' inside a banner looks exactly like a prompt. Getting this wrong
    // truncates the capture and nobody notices until a restore.
    let addr = start_device(AuthStyle::PasswordOnly, "CORE-SW-01").await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let mut device = Device::connect("127.0.0.1", &creds("correct-horse"), options(port_of(&addr)), store, None)
        .await
        .unwrap();

    let config = device.run("show running-config").await.unwrap();

    assert!(config.contains("hostname CORE-SW-01"));
    assert!(config.contains("interface GigabitEthernet0/4"), "capture stopped early: {config:?}");
    assert!(config.trim().ends_with("end"), "capture did not reach the end: {config:?}");
    assert!(coreview_discover::cli::looks_like_config(&config).is_ok());

    device.close().await;
}

#[tokio::test]
async fn wrong_credentials_are_reported_as_such() {
    let addr = start_device(AuthStyle::AlwaysReject, "SW1").await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));

    let err = match Device::connect("127.0.0.1", &creds("wrong"), options(port_of(&addr)), store, None).await {
        Err(e) => e,
        Ok(_) => panic!("bad credentials must not connect"),
    };

    // Whoever reads this needs to know it was the credentials, not the network.
    let msg = err.to_string();
    assert!(
        matches!(err, SshError::AuthFailed { .. }) || msg.contains("rejected"),
        "unhelpful error: {msg}"
    );
    assert!(!msg.contains("wrong"), "the attempted password leaked into the error: {msg}");
}

#[tokio::test]
async fn a_host_key_is_remembered_and_a_change_is_refused() {
    let addr = start_device(AuthStyle::PasswordOnly, "SW1").await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));

    Device::connect("127.0.0.1", &creds("correct-horse"), options(port_of(&addr)), Arc::clone(&store), None)
        .await
        .unwrap()
        .close()
        .await;

    assert_eq!(store.lock().unwrap().len(), 1, "first contact should record the key");

    // A second device on a new port has a different key. Pretend it is the
    // same host by rewriting the stored fingerprint to something else, which
    // is what an intercepted connection would look like.
    let addr2 = start_device(AuthStyle::PasswordOnly, "SW1").await;
    let port2 = port_of(&addr2);
    store
        .lock()
        .unwrap()
        .remember("127.0.0.1", port2, "SHA256:definitely-not-the-real-key");

    let err = match Device::connect("127.0.0.1", &creds("correct-horse"), options(port2), Arc::clone(&store), None).await {
        Err(e) => e,
        Ok(_) => panic!("a changed host key must refuse to connect"),
    };

    assert!(matches!(err, SshError::HostKeyChanged(_)), "got: {err}");
    let msg = err.to_string();
    assert!(msg.contains("clear"), "the message must point at the way out: {msg}");
}

#[tokio::test]
async fn an_unreachable_device_fails_fast_rather_than_waiting_for_a_push() {
    // The connect deadline is short on purpose: a crawl must keep moving past
    // dead addresses, and only *authentication* waits on a human.
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let opts = SshOptions {
        // Port 1 on loopback refuses immediately.
        port: 1,
        connect_timeout: Duration::from_secs(3),
        auth_timeout: Duration::from_secs(60),
        command_timeout: Duration::from_secs(10),
        login_transcript: None,
        support_capture: None,
        max_output_bytes: coreview_discover::ssh::DEFAULT_MAX_OUTPUT_BYTES,
    };

    let started = std::time::Instant::now();
    let err = match Device::connect("127.0.0.1", &creds("x"), opts, store, None).await {
        Err(e) => e,
        Ok(_) => panic!("nothing is listening on port 1"),
    };
    let elapsed = started.elapsed();

    assert!(
        elapsed < Duration::from_secs(10),
        "took {elapsed:?}; a dead device must not wait out the auth deadline"
    );
    assert!(err.to_string().contains("127.0.0.1"), "got: {err}");
}

// ---------------------------------------------------------------------------
// A device that paints a screen instead of printing lines.
//
// This is the Aruba 2930M, reconstructed from the bytes it actually sent over
// four failed rounds. Nothing here is invented: the banner held on a keypress
// is one fix, the `\r` it wants rather than `\n` is another, and the
// `ESC[1920;1920H ESC[6n` terminal measurement it will not move past is
// The fourth thing — the one none of those fixed — is that when it
// finally draws its prompt it wraps it in erase sequences, so read as a raw
// stream the buffer ends in the `K` of `ESC[K` and there is no prompt to find.
//
// A device that does all four is the only honest test of the claim that this
// is fixed, because fixing any three of them still leaves a crawl that hangs.

/// How far through the painted login this connection has got.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    /// The banner is on screen, waiting for a keypress.
    Banner,
    /// The screen has been repainted and the terminal measured; the device is
    /// waiting to be told where the cursor is.
    Measuring,
    /// Logged in, drawing prompts.
    Ready,
}

#[derive(Clone)]
struct PaintingDevice {
    hostname: String,
    phase: Arc<std::sync::Mutex<Phase>>,
    /// Set when the device is never going to draw a prompt at all, which is
    /// what a crawl has to be able to report on rather than merely survive.
    never_prompts: bool,
}

impl PaintingDevice {
    /// The prompt as this device draws it: clear the line, write it, then
    /// erase to the end. The trailing erase is what defeated `find_prompt`.
    fn prompt(&self) -> String {
        format!("\x1b[2K{}#\x1b[K", self.hostname)
    }
}

impl server::Handler for PaintingDevice {
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
        // The copyright notice and the restricted-rights legend, then a
        // keypress it will wait on indefinitely.
        session.data(
            channel,
            concat!(
                "\r\nGathering information, please wait...\r\n",
                "\r\nRESTRICTED RIGHTS LEGEND\r\n",
                "\r\nPress any key to continue",
            )
            .to_string()
            .into_bytes(),
        )?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let phase = *self.phase.lock().unwrap();
        match phase {
            Phase::Banner => {
                // A line feed is not what the Enter key sends, and this device
                // knows the difference.
                if !data.contains(&b'\r') {
                    return Ok(());
                }
                if self.never_prompts {
                    // It answers, and then simply stops — the case a crawl has
                    // to be able to explain rather than merely time out on.
                    return Ok(());
                }
                *self.phase.lock().unwrap() = Phase::Measuring;
                // Reset the screen, then drive the cursor off the end and ask
                // where it landed. Nothing more is sent until it is told.
                session.data(
                    channel,
                    concat!(
                        "\x1b[13;1H\x1b[?25h\x1b[200;27H\x1b[?6l\x1b[1;200r\x1b[?7h",
                        "\x1b[2J\x1b[1;1H",
                        "\x1b[1920;1920H\x1b[6n",
                    )
                    .to_string()
                    .into_bytes(),
                )?;
            }
            Phase::Measuring => {
                // Only a cursor-position report moves it on.
                let said = String::from_utf8_lossy(data);
                if !(said.starts_with("\x1b[") && said.ends_with('R')) {
                    return Ok(());
                }
                *self.phase.lock().unwrap() = Phase::Ready;
                // The whole screen, in one go, with no newline anywhere in
                // it: the notice at the top, a hint pinned to the bottom, and
                // only then the prompt, drawn back up at row 3.
                //
                // **This is the part no stream reader can survive.** Read as
                // text there is one enormous line, and its last characters
                // are the prompt with the bottom-of-screen hint run into the
                // front of it — so whatever is judged, it is not a hostname.
                // Rendered, the prompt is alone on row 3 with the cursor
                // sitting after it.
                session.data(
                    channel,
                    format!(
                        "\x1b[2J\x1b[1;1HYour previous successful login was on 2026-09-21\
                         \x1b[24;1H\x1b[2KUse 'menu' for the menu interface\
                         \x1b[3;1H{}",
                        self.prompt()
                    )
                    .into_bytes(),
                )?;
            }
            Phase::Ready => {
                let line = String::from_utf8_lossy(data);
                let command = line.trim();
                let body = match command {
                    "terminal length 0" | "no page" => String::new(),
                    "show version" => {
                        "Image stamp: /ws/swbuildm/rel_WC_16_10\r\nSoftware revision: WC.16.10.0009\r\n".into()
                    }
                    _ => "Invalid input: ".to_string() + command + "\r\n",
                };
                session.data(
                    channel,
                    format!("{command}\r\n{body}{}", self.prompt()).into_bytes(),
                )?;
            }
        }
        Ok(())
    }
}

async fn start_painting_device(hostname: &str, never_prompts: bool) -> String {
    let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
        .expect("generate host key");
    let config = Arc::new(server::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        auth_rejection_time: Duration::from_millis(1),
        keys: vec![key],
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let hostname = hostname.to_string();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let config = Arc::clone(&config);
            let handler = PaintingDevice {
                hostname: hostname.clone(),
                phase: Arc::new(std::sync::Mutex::new(Phase::Banner)),
                never_prompts,
            };
            tokio::spawn(async move {
                let _ = server::run_stream(config, stream, handler).await;
            });
        }
    });
    addr.to_string()
}

#[tokio::test]
async fn a_device_that_paints_its_screen_reaches_a_prompt() {
    // Four rounds of one-fix-at-a-time on a production switch, and this is
    // the shape of all four at once. Without the fix this hangs until the
    // command timeout, every time, on a prompt that arrived immediately.
    let addr = start_painting_device("LAB-SW9", false).await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));

    let mut device = Device::connect(
        "127.0.0.1",
        &creds("correct-horse"),
        options(port_of(&addr)),
        store,
        None,
    )
    .await
    .expect("a painted prompt is still a prompt");

    assert_eq!(device.hostname(), "LAB-SW9", "read off the rendered screen");

    let out = device.run("show version").await.expect("run a command");
    assert!(out.contains("WC.16.10.0009"), "got: {out:?}");
    assert!(!out.contains("LAB-SW9#"), "the prompt leaked: {out:?}");

    device.close().await;
}

#[tokio::test]
async fn a_device_that_never_prompts_leaves_what_it_sent() {
    // The crawl cannot be fixed by guessing, and for four rounds
    // guessing was all there was, because nothing kept what the device said.
    let addr = start_painting_device("LAB-SW9", true).await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let kept: Arc<std::sync::Mutex<Vec<u8>>> = Arc::default();

    let mut options = options(port_of(&addr));
    options.command_timeout = Duration::from_secs(2);
    options.login_transcript = Some(Arc::clone(&kept));

    let error = match Device::connect("127.0.0.1", &creds("correct-horse"), options, store, None).await {
        Ok(_) => panic!("it never draws a prompt, so connecting must not succeed"),
        Err(e) => e,
    };
    assert!(matches!(error, SshError::CommandTimeout { .. }), "got: {error:?}");

    let said = kept.lock().unwrap().clone();
    let readable = coreview_discover::cli::escape_for_reading(&said);
    assert!(readable.contains("RESTRICTED RIGHTS LEGEND"), "got: {readable}");
    assert!(readable.contains("Press any key to continue"), "got: {readable}");
    // And it is safe to paste: no raw escape survived the rendering.
    assert!(!readable.contains('\x1b'), "a raw escape got through");
}

/// Enforced against the real code rather than against
/// hand-written log lines.
///
/// A whole session runs with the debug log on — connect, authenticate, take a
/// shell, find a prompt, run commands — and the assertion is that the password
/// it authenticated with is nowhere in the file. A debug log is the most
/// natural place in a program for a secret to end up, because the instinct
/// that produces one is "print everything and look at it later"; and it is the
/// file most likely to be attached to a message and sent on, because that is
/// what it is for.
#[tokio::test]
async fn a_real_session_writes_a_useful_log_and_leaks_no_password() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("crawl.log");
    coreview_discover::debuglog::start(&path, "Coreview test").expect("start the log");

    let addr = start_device(AuthStyle::PasswordOnly, "CORE-SW-02").await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let mut device = Device::connect(
        "127.0.0.1",
        &creds("correct-horse"),
        options(port_of(&addr)),
        store,
        None,
    )
    .await
    .expect("connect");
    let _ = device.run("show version").await.expect("run");
    let _ = device.run("show running-config").await.expect("run");
    device.close().await;

    coreview_discover::debuglog::stop();
    let log = std::fs::read_to_string(&path).expect("the log is there");

    // It says what happened, in order.
    assert!(log.contains("connecting as admin"), "the login is recorded:\n{log}");
    assert!(log.contains("authenticated"), "the outcome is recorded:\n{log}");
    assert!(log.contains("CORE-SW-02#"), "the prompt is recorded:\n{log}");
    assert!(log.contains("ran `show version`"), "the command is named:\n{log}");
    assert!(log.contains("ran `show running-config`"), "and so is this one:\n{log}");
    assert!(log.contains(" bytes, "), "the output is counted:\n{log}");

    // And it says nothing it should not.
    assert!(!log.contains("correct-horse"), "the password reached the log:\n{log}");
    assert!(
        !log.contains("switchport mode access"),
        "the running-config reached the log:\n{log}",
    );
    assert!(
        !log.contains("Unauthorized access prohibited"),
        "the banner reached the log:\n{log}",
    );
}

/// A command's output is seen while it runs, and what arrived before
/// a timeout is kept — a traceroute's hops so far, not nothing.
#[tokio::test]
async fn output_is_watched_as_it_arrives_and_kept_when_the_command_times_out() {
    let addr = start_device(AuthStyle::PasswordOnly, "CORE-SW-01").await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let mut options = options(port_of(&addr));
    options.command_timeout = Duration::from_secs(2);
    let mut device = Device::connect("127.0.0.1", &creds("correct-horse"), options, store, None).await.expect("connect");
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    device.watch(Some(tx));
    let err = device.run("traceroute 198.51.100.9").await.expect_err("the trace never finishes");
    assert!(matches!(err, coreview_discover::ssh::SshError::CommandTimeout { .. }), "{err}");
    let mut seen = String::new();
    while let Ok(chunk) = rx.try_recv() {
        seen.push_str(&chunk);
    }
    assert!(seen.contains("203.0.113.1"), "watched: {seen:?}");
    let partial = device.take_partial("traceroute 198.51.100.9");
    let hops = coreview_discover::trace::parse_traceroute(&partial);
    assert_eq!(hops.len(), 3, "{partial:?}");
    assert_eq!(hops[1].address.as_deref(), Some("203.0.113.1"));
    assert!(!partial.contains("traceroute 198.51.100.9"), "the echo is removed: {partial:?}");
}

/// A device that refuses one saved login is tried with the next, and the
/// caller learns which one it took.
#[tokio::test]
async fn the_next_saved_login_is_tried_when_one_is_refused() {
    let addr = start_device(AuthStyle::PasswordOnly, "ACCESS-SW-07").await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let logins = [creds("not-this-one"), creds("nor-this-one"), creds("correct-horse")];

    let (device, taken) =
        coreview_discover::ssh::connect_first_accepted("127.0.0.1", &logins, options(port_of(&addr)), store, None)
            .await
            .expect("the third login is accepted");

    assert_eq!(taken, 2);
    assert_eq!(device.hostname(), "ACCESS-SW-07");
    device.close().await;
}

/// Every login refused is reported as a refusal, not as a network fault.
#[tokio::test]
async fn every_login_refused_is_reported_as_refused() {
    let addr = start_device(AuthStyle::AlwaysReject, "SW1").await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let logins = [creds("one-fake"), creds("two-fake")];

    let err = match coreview_discover::ssh::connect_first_accepted("127.0.0.1", &logins, options(port_of(&addr)), store, None).await {
        Err(e) => e,
        Ok(_) => panic!("no login should be accepted"),
    };
    assert!(matches!(err, SshError::AuthFailed { .. }), "got: {err}");
}

/// A device nobody can reach is not tried once per login: the first
/// failure that is not a refusal ends it.
#[tokio::test]
async fn an_unreachable_device_is_not_retried_per_login() {
    // Bound and dropped, so nothing listens there.
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let logins = [creds("one-fake"), creds("two-fake"), creds("three-fake")];
    let (tx, mut rx) = mpsc::channel(32);

    let err = match coreview_discover::ssh::connect_first_accepted("127.0.0.1", &logins, options(port), store, Some(tx)).await {
        Err(e) => e,
        Ok(_) => panic!("nothing listens there"),
    };
    assert!(!matches!(err, SshError::AuthFailed { .. }), "a network fault, not a refusal: {err}");
    let mut connecting = 0;
    while let Ok(p) = rx.try_recv() {
        if matches!(p, SshProgress::Connecting { .. }) {
            connecting += 1;
        }
    }
    assert_eq!(connecting, 1, "one attempt, not one per login");
}
