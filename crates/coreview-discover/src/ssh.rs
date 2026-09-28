//! SSH to a network device.
//!
//! Not a general SSH client. It does the one conversation network equipment
//! expects: log in, take a terminal, stop it paging, run commands, read until
//! the prompt comes back.
//!
//! ## Duo
//!
//! Push-only, which is simpler than it sounds. The device asks Duo over RADIUS
//! and the SSH authentication simply blocks until the push is approved on the
//! phone. There is nothing to type, so there is no prompt to show and no answer
//! to collect — the client responds to the password challenge, responds to
//! anything after it with an empty answer, and waits.
//!
//! Two consequences fall out of that and are enforced here rather than left to
//! the caller. Authentication needs a much longer deadline than a connection
//! does, because a person has to reach for their phone; and only one device can
//! be authenticated at a time, because nobody can approve sixty-four pushes at
//! once.

use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, KeyboardInteractiveAuthResponse};
use russh::{cipher, kex, mac, Preferred};
use russh::keys::ssh_key::HashAlg;
use russh::keys::PublicKeyOrCertificate;
use russh::{ChannelMsg, Disconnect};
use tokio::sync::mpsc;
use tokio::time::timeout;

use crate::cli::{extract_output, find_prompt, find_prompt_on_screen, Prompt};
use crate::screen::Screen;

/// The terminal Coreview claims to be when it opens a shell, and the answer it
/// gives when a device asks how big that terminal is (LT-379). The two must
/// agree: a device that measures the screen and is told something other than
/// what was negotiated will wrap its output in the wrong place.
const PTY_COLS: u16 = 200;
const PTY_ROWS: u16 = 200;

/// The most a single command's output may grow to before it is abandoned
/// (LT-427). A device left in `terminal monitor`, or a `show log` that never
/// pages, otherwise streams for the whole `command_timeout` into a string that
/// only ever grows, with the screen rendered on every chunk. Thirty-two
/// megabytes is several times the largest running-config or forwarding table
/// a real device produces, and far short of what would hurt.
pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
use crate::hostkeys::{changed_key_message, HostKeyStore, HostKeyVerdict};

/// A password, kept out of anything that prints.
///
/// The point is the `Debug` implementation: a credential struct that derives
/// `Debug` ends up in a log line or an error message eventually, and this is
/// the cheapest way to make that impossible rather than merely unlikely.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
    /// Crate-visible, not public: the telnet transport needs it to answer a
    /// login prompt, and nothing outside this crate should be able to read a
    /// secret back out at all.
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(***)")
    }
}

#[derive(Clone, Debug)]
pub struct Credentials {
    pub username: String,
    pub password: Secret,
    /// Password for `enable`, when the device drops into user mode on login
    /// and the commands we need are privileged.
    pub enable_password: Option<Secret>,
}

impl Credentials {
    /// Every secret in the set, for a redaction that must know them all
    /// (LT-481). Not for display, not for a log.
    pub fn secrets(&self) -> Vec<String> {
        let mut out = vec![self.password.expose().to_string()];
        if let Some(e) = &self.enable_password {
            out.push(e.expose().to_string());
        }
        out
    }
}

#[derive(Clone, Debug)]
pub struct SshOptions {
    pub port: u16,
    /// How long to wait for a TCP connection and key exchange. Short: an
    /// unreachable device should fail fast so a crawl keeps moving.
    pub connect_timeout: Duration,
    /// How long to wait for authentication to complete. Long, because a Duo
    /// push waits on a person. Kept separate from `connect_timeout` for
    /// exactly that reason — one is a network fact, the other is human.
    pub auth_timeout: Duration,
    /// How long to wait for a command's output to finish arriving.
    pub command_timeout: Duration,
    /// The most one command's output may grow to before the command is
    /// abandoned with `SshError::OutputTooLarge` (LT-427). A cap in bytes
    /// rather than only in seconds, because a device that streams answers
    /// the timeout with a sixty-second string.
    pub max_output_bytes: usize,
    /// Where the login stream is written, when anybody wants it (LT-384).
    ///
    /// An out-parameter rather than an option, which is untidy — but it is the
    /// one thing that has to survive a failure, and on a failure the `Device`
    /// is dropped and the error is all that comes back. A crawl hands one of
    /// these in so that a device which never reaches a prompt can be
    /// diagnosed from what it actually sent.
    ///
    /// **The login only, never a command's output** — the boundary
    /// `last_seen_for` already draws. A command's output can hold a
    /// running-config, and on somebody's production switch that is exactly
    /// what must not be written to a file (D-006).
    pub login_transcript: Option<Arc<std::sync::Mutex<Vec<u8>>>>,
    /// LT-481: where every command's reply is written for support, when the
    /// crawl asked for it. Configurations are skipped inside `record` and
    /// secrets are redacted there; the boundary above still holds for the
    /// debug log, which never sees any of this (D-055).
    pub support_capture: Option<Arc<crate::support::SupportCapture>>,
}

impl Default for SshOptions {
    fn default() -> Self {
        Self {
            port: 22,
            connect_timeout: Duration::from_secs(8),
            auth_timeout: Duration::from_secs(90),
            command_timeout: Duration::from_secs(60),
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
            login_transcript: None,
            support_capture: None,
        }
    }
}

/// What is happening, for a progress line in the UI.
///
/// `AwaitingSecondFactor` is the one that matters: without it, a Duo push looks
/// exactly like a hung connection, and the user has no reason to look at their
/// phone.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SshProgress {
    Connecting { host: String },
    CheckingHostKey { host: String },
    Authenticating { host: String },
    AwaitingSecondFactor { host: String, message: String },
    /// LT-377: logged in, waiting for the device to draw a prompt.
    ///
    /// Its own state because the two phases fail for entirely different
    /// reasons and used to look identical: a device holding a banner open
    /// (LT-375) reported "Authenticating" for the whole wait, so a login that
    /// had plainly succeeded was indistinguishable from one that had not.
    OpeningShell { host: String },
    Ready { host: String, hostname: String },
    Running { host: String, command: String },
}

#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("could not reach {host}:{port}: {source}")]
    Connect {
        host: String,
        port: u16,
        source: std::io::Error,
    },
    #[error("{host} did not answer within {}s", .timeout.as_secs())]
    ConnectTimeout { host: String, timeout: Duration },
    #[error("{0}")]
    HostKeyChanged(String),
    #[error("{host} rejected the credentials")]
    AuthFailed { host: String },
    #[error("authentication to {host} was not completed within {}s — if this was a Duo push, it was not approved in time", .timeout.as_secs())]
    AuthTimeout { host: String, timeout: Duration },
    #[error("{host} never presented a command prompt; it may not be a device with a CLI")]
    NoPrompt { host: String },
    #[error("{host} stopped responding while running `{command}`{last_seen}")]
    CommandTimeout {
        host: String,
        command: String,
        /// LT-378: what the device had said when we gave up, for the login
        /// read only.
        ///
        /// A prompt that never arrives is otherwise undiagnosable from the
        /// outside: the app says it waited, and the one thing that would
        /// explain why — what the device actually sent — is thrown away. It
        /// is filled in **only while reading the login**, where the buffer is
        /// a banner. A command's output can hold a running-config, and an
        /// error message is the wrong place for one (D-006).
        last_seen: String,
    },
    /// LT-427: the command was abandoned because its output passed
    /// `SshOptions::max_output_bytes`. Nothing of the output is kept in the
    /// error, for the same reason `CommandTimeout` keeps none of a command's.
    #[error("{host} sent more than {} MB in reply to `{command}` and was still sending; the command was abandoned", .limit / (1024 * 1024))]
    OutputTooLarge {
        host: String,
        command: String,
        limit: usize,
    },
    #[error("ssh error talking to {host}: {source}")]
    Protocol {
        host: String,
        #[source]
        source: russh::Error,
    },
}

/// Decides whether to trust the key a device presented, and records the answer.
///
/// russh calls this during the handshake, before authentication, which is the
/// only correct place: a password must not be sent to a host whose identity has
/// not been settled.
struct Verifier {
    host: String,
    port: u16,
    store: Arc<std::sync::Mutex<HostKeyStore>>,
    /// Set when the key differed, so the connect path can report *why* it was
    /// refused rather than a bare handshake failure.
    rejection: Arc<std::sync::Mutex<Option<String>>>,
}

impl client::Handler for Verifier {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            // A certificate-based host identity is a different trust model and
            // this store cannot express it. Refusing is honest.
            *self.rejection.lock().unwrap() = Some(format!(
                "{} presented a host certificate rather than a key, which Coreview cannot verify",
                self.host
            ));
            return Ok(false);
        };
        let fingerprint = key.key_data().fingerprint(HashAlg::Sha256).to_string();

        let mut store = self.store.lock().unwrap();
        match store.check(&self.host, self.port, &fingerprint) {
            HostKeyVerdict::Known => Ok(true),
            HostKeyVerdict::New => {
                store.remember(&self.host, self.port, &fingerprint);
                Ok(true)
            }
            HostKeyVerdict::Changed { remembered } => {
                *self.rejection.lock().unwrap() = Some(changed_key_message(
                    &self.host,
                    self.port,
                    &remembered,
                    &fingerprint,
                ));
                Ok(false)
            }
        }
    }
}


/// Algorithm preferences that can actually reach network equipment.
///
/// russh's defaults are what a modern SSH client should offer, and a great deal
/// of network gear cannot meet them. A Catalyst running a current IOS image
/// offers `diffie-hellman-group14-sha1` and `diffie-hellman-group-exchange-sha1`
/// and nothing else, so a client with only SHA-2 key exchange fails the
/// handshake before it ever sees a password prompt — which is exactly what
/// happened the first time this was pointed at a real switch.
///
/// The legacy algorithms are appended **after** the modern ones rather than
/// replacing them. SSH negotiation picks the client's first choice the server
/// also supports, so a modern device still negotiates modern algorithms and
/// nothing is weakened for equipment that can do better; the old names are only
/// reached when the alternative is not connecting at all.
///
/// This is a deliberate trade, and worth being clear about: talking to a switch
/// that only speaks SHA-1 means using SHA-1. The honest options are to support
/// it or to not manage the device.
pub fn network_device_algorithms() -> Preferred {
    let mut kex: Vec<kex::Name> = Preferred::DEFAULT.kex.to_vec();
    // NIST ECDH: not in russh's defaults, but a hardened IOS-XE box is often
    // locked to exactly `ecdh-sha2-nistp521 ecdh-sha2-nistp384` — the lab
    // 9300 refused every default offer with "No common Kex algorithm"
    // (LT-054). Biggest curve first, all below the modern curves.
    kex.extend([
        kex::ECDH_SHA2_NISTP521,
        kex::ECDH_SHA2_NISTP384,
        kex::ECDH_SHA2_NISTP256,
    ]);
    kex.extend([kex::DH_G14_SHA1, kex::DH_GEX_SHA1]);
    // LT-488: an old switch that offers nothing else. A 1024-bit group, so
    // it is the very last resort — anything better that both sides speak wins.
    kex.push(kex::DH_G1_SHA1);

    let mut cipher: Vec<cipher::Name> = Preferred::DEFAULT.cipher.to_vec();
    cipher.extend([
        cipher::AES_256_CBC,
        cipher::AES_192_CBC,
        cipher::AES_128_CBC,
    ]);

    let mut mac: Vec<mac::Name> = Preferred::DEFAULT.mac.to_vec();
    mac.extend([mac::HMAC_SHA1_ETM, mac::HMAC_SHA1]);

    Preferred {
        kex: kex.into(),
        cipher: cipher.into(),
        mac: mac.into(),
        ..Preferred::DEFAULT
    }
}

/// An open session on a device.
pub struct Device {
    host: String,
    handle: client::Handle<Verifier>,
    channel: russh::Channel<client::Msg>,
    options: SshOptions,
    /// The prompt this device draws, learned at login and used to know when a
    /// command has finished.
    pub prompt: Prompt,
}

impl Device {
    /// Connects, authenticates, takes a terminal and turns paging off.
    ///
    /// `progress` receives status as it goes; it is how the UI says "waiting
    /// for Duo" instead of appearing to hang.
    pub async fn connect(
        host: &str,
        credentials: &Credentials,
        options: SshOptions,
        store: Arc<std::sync::Mutex<HostKeyStore>>,
        progress: Option<mpsc::Sender<SshProgress>>,
    ) -> Result<Self, SshError> {
        let say = |p: SshProgress| {
            if let Some(tx) = &progress {
                let _ = tx.try_send(p);
            }
        };

        crate::say!(
            crate::debuglog::Area::Ssh,
            "{host}:{} connecting as {}",
            options.port,
            credentials.username,
        );
        say(SshProgress::Connecting {
            host: host.to_string(),
        });

        let rejection = Arc::new(std::sync::Mutex::new(None));
        let verifier = Verifier {
            host: host.to_string(),
            port: options.port,
            store,
            rejection: Arc::clone(&rejection),
        };

        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(300)),
            preferred: network_device_algorithms(),
            ..Default::default()
        });

        say(SshProgress::CheckingHostKey {
            host: host.to_string(),
        });

        let connect = client::connect(config, (host, options.port), verifier);
        let mut handle = match timeout(options.connect_timeout, connect).await {
            Err(_) => {
                return Err(SshError::ConnectTimeout {
                    host: host.to_string(),
                    timeout: options.connect_timeout,
                })
            }
            Ok(Err(e)) => {
                // A refused key surfaces from russh as a generic handshake
                // failure, so the specific reason is carried out of the
                // verifier rather than lost.
                if let Some(why) = rejection.lock().unwrap().take() {
                    return Err(SshError::HostKeyChanged(why));
                }
                return Err(SshError::Protocol {
                    host: host.to_string(),
                    source: e,
                });
            }
            Ok(Ok(h)) => h,
        };

        crate::say!(crate::debuglog::Area::Ssh, "{host}: host key accepted");
        say(SshProgress::Authenticating {
            host: host.to_string(),
        });
        let auth = authenticate(&mut handle, host, credentials, &say);
        match timeout(options.auth_timeout, auth).await {
            Err(_) => {
                crate::say!(
                    crate::debuglog::Area::Ssh,
                    "{host}: authentication not completed within {}s",
                    options.auth_timeout.as_secs(),
                );
                return Err(SshError::AuthTimeout {
                    host: host.to_string(),
                    timeout: options.auth_timeout,
                })
            }
            Ok(result) => {
                if let Err(e) = &result {
                    crate::say!(crate::debuglog::Area::Ssh, "{host}: authentication refused — {e}");
                }
                result?
            }
        }
        crate::say!(crate::debuglog::Area::Ssh, "{host}: authenticated");

        let channel = handle.channel_open_session().await.map_err(|e| SshError::Protocol {
            host: host.to_string(),
            source: e,
        })?;

        // A terminal wide enough that the device does not wrap its own output,
        // and tall enough that `terminal length 0` is not the only thing
        // standing between us and a paged capture. LT-379: a device may also
        // ask how big it is, and the answer has to be this same size.
        channel
            .request_pty(true, "vt100", PTY_COLS.into(), PTY_ROWS.into(), 0, 0, &[])
            .await
            .map_err(|e| SshError::Protocol {
                host: host.to_string(),
                source: e,
            })?;
        channel.request_shell(true).await.map_err(|e| SshError::Protocol {
            host: host.to_string(),
            source: e,
        })?;

        let mut device = Device {
            host: host.to_string(),
            handle,
            channel,
            options,
            // Replaced immediately below; a shell has no prompt until it draws
            // one.
            prompt: Prompt {
                text: String::new(),
                hostname: String::new(),
                enabled: false,
            },
        };

        crate::say!(
            crate::debuglog::Area::Ssh,
            "{host}: shell open on a {PTY_COLS}x{PTY_ROWS} vt100, waiting for a prompt",
        );
        say(SshProgress::OpeningShell { host: host.to_string() });
        device.prompt = match device.read_until_prompt(None).await {
            Ok(p) => {
                crate::say!(
                    crate::debuglog::Area::Ssh,
                    "{host}: prompt {:?}, {}",
                    p.text,
                    if p.enabled { "privileged" } else { "unprivileged" },
                );
                p
            }
            Err(e) => {
                crate::say!(crate::debuglog::Area::Ssh, "{host}: no prompt — {e}");
                return Err(e);
            }
        };
        say(SshProgress::Ready {
            host: host.to_string(),
            hostname: device.prompt.hostname.clone(),
        });

        // Turn paging off. Failure is not fatal — some accounts cannot set it —
        // because strip_paging can still clean up after it.
        //
        // LT-391: two spellings, because this runs before anything has said
        // what the platform is. `terminal length 0` is rejected by
        // ArubaOS-Switch, which wants `no page`, and the operator's debug log
        // showed the cost: every long capture on that switch was paged and
        // answered a screen at a time. Sending the second only when the first
        // was refused keeps a Cisco from being asked twice.
        let paging = device.run("terminal length 0").await.unwrap_or_default();
        if crate::cli::command_was_rejected(&paging).is_some() {
            crate::say!(
                crate::debuglog::Area::Ssh,
                "{host}: `terminal length 0` was refused; trying `no page`",
            );
            let _ = device.run("no page").await;
        }

        Ok(device)
    }

    /// Runs one command and returns its output, with the echo and the trailing
    /// prompt removed.
    pub async fn run(&mut self, command: &str) -> Result<String, SshError> {
        self.channel
            .data(format!("{command}\n").as_bytes())
            .await
            .map_err(|e| SshError::Protocol {
                host: self.host.clone(),
                source: e,
            })?;

        // D-055: the command is named and the output counted, never written
        // down. A `show running-config` is the most sensitive thing on a
        // switch and this file is made to be sent to somebody.
        let started = std::time::Instant::now();
        let result = self.read_raw_until_prompt(Some(command)).await;
        match &result {
            Ok((raw, _)) => crate::say!(
                crate::debuglog::Area::Ssh,
                "{}: ran `{command}` in {}ms, {} bytes, {} lines{}",
                self.host,
                started.elapsed().as_millis(),
                raw.len(),
                raw.lines().count(),
                // LT-392: said outright rather than left to be read off the
                // byte count, which is how the whole Aruba diagnosis had to be
                // done. The device's own message is not quoted (D-055).
                if crate::cli::command_was_rejected(&extract_output(&crate::cli::readable(raw), command)).is_some() {
                    " — the device rejected it"
                } else {
                    ""
                },
            ),
            Err(e) => crate::say!(
                crate::debuglog::Area::Ssh,
                "{}: `{command}` failed after {}ms — {e}",
                self.host,
                started.elapsed().as_millis(),
            ),
        }
        let (raw, _) = result?;
        // LT-402: as text, before anything reads it. A device that paints its
        // screen wraps the echo in cursor moves, and an echo that cannot be
        // found is an echo that is never removed.
        let output = extract_output(&crate::cli::readable(&raw), command);
        if let Some(capture) = &self.options.support_capture {
            capture.record(&self.host, command, &output);
        }
        Ok(output)
    }

    /// Reads until the device draws its prompt, returning the prompt itself.
    async fn read_until_prompt(&mut self, command: Option<&str>) -> Result<Prompt, SshError> {
        let (raw, prompt) = self.read_raw_until_prompt(command).await?;
        // The rendered screen is what found it. The raw buffer is the fallback
        // for a channel that closed before the loop got that far.
        prompt
            .or_else(|| find_prompt(&raw))
            .ok_or_else(|| SshError::NoPrompt {
                host: self.host.clone(),
            })
    }

    /// The read loop. Renders what the device draws, and stops when it has
    /// drawn a prompt.
    ///
    /// **It keeps two views of the same bytes, and they answer different
    /// questions** (LT-383). The raw buffer is *what the device said*, and it
    /// is what a capture is extracted from — a 200-row screen would scroll the
    /// top off a long `show run`. The [`Screen`] is *has the device finished
    /// talking*, and it is the only one of the two that can answer, because a
    /// device paints: it clears, positions the cursor, overwrites, repaints.
    /// Read as a stream, a prompt followed by an erase sequence ends in the
    /// `K` of the erase, and for four rounds on one Aruba that meant a prompt
    /// arrived every time and was recognised none of them.
    ///
    /// Paging is answered rather than treated as the end of output: on a
    /// device where `terminal length 0` was refused, stopping at the first
    /// `--More--` would truncate every long capture.
    async fn read_raw_until_prompt(
        &mut self,
        command: Option<&str>,
    ) -> Result<(String, Option<Prompt>), SshError> {
        let mut buffer = String::new();
        let mut screen = Screen::new(PTY_ROWS, PTY_COLS);
        let deadline = tokio::time::Instant::now() + self.options.command_timeout;
        // LT-387: which line a continuation was last answered for. The buffer
        // only grows, so without this a banner that stays the last line is
        // answered again on every chunk — keystrokes nobody asked for, sent to
        // somebody's production switch. A genuine second page starts a new
        // line and so is still answered.
        let mut answered_line: Option<usize> = None;
        // LT-384: the login only. See `SshOptions::login_transcript`.
        let recording = command.is_none();

        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(self.timed_out(command, &buffer));
            }

            let data = match timeout(remaining, self.channel.wait()).await {
                Err(_) => return Err(self.timed_out(command, &buffer)),
                // The channel closed. Whatever arrived is all there is.
                Ok(None) => return Ok((buffer, find_prompt_on_screen(&screen))),
                Ok(Some(msg)) => match msg {
                    // Stderr is the same screen to a terminal, and LT-386 was
                    // that it used to be appended and then never checked for a
                    // prompt — so a device that drew one there waited for the
                    // timeout.
                    ChannelMsg::Data { ref data } | ChannelMsg::ExtendedData { ref data, .. } => {
                        data.to_vec()
                    }
                    ChannelMsg::Eof | ChannelMsg::Close => {
                        return Ok((buffer, find_prompt_on_screen(&screen)))
                    }
                    _ => continue,
                },
            };

            if recording {
                record_login(&self.options.login_transcript, &data);
            }
            buffer.push_str(&String::from_utf8_lossy(&data));
            // LT-427: bounded in bytes as well as in seconds.
            if buffer.len() > self.options.max_output_bytes {
                crate::say!(
                    crate::debuglog::Area::Ssh,
                    "{}: `{}` passed {} bytes without a prompt; abandoned",
                    self.host,
                    command.unwrap_or("<login>"),
                    self.options.max_output_bytes,
                );
                return Err(SshError::OutputTooLarge {
                    host: self.host.clone(),
                    command: command.unwrap_or("<login>").to_string(),
                    limit: self.options.max_output_bytes,
                });
            }

            // LT-379 / D-054: the device measuring the terminal. It will not
            // draw a prompt until it is told where the cursor is, which is the
            // whole reason PuTTY could log into an Aruba that this client
            // could not. The screen answers from where the cursor actually is,
            // having tracked every move, wrap and scroll that put it there.
            let replies = screen.feed(&data);
            if !replies.is_empty() {
                let (row, col) = screen.cursor();
                crate::say!(
                    crate::debuglog::Area::Ssh,
                    "{}: it asked where the cursor was; answered row {row}, column {col}",
                    self.host,
                );
                let _ = self.channel.data(replies.as_slice()).await;
            }

            // LT-375 / D-054: one table for everything a device holds the
            // session open with — a pager, a banner waiting on a keypress, a
            // FIPS box waiting for `a`. Only continuations are answered; a
            // prompt that decides something never is.
            let line_start = buffer.rfind('\n').map_or(0, |i| i + 1);
            if answered_line != Some(line_start) {
                if let Some(reply) = crate::cli::continuation_reply(&buffer) {
                    crate::say!(
                        crate::debuglog::Area::Ssh,
                        "{}: holding on {:?}; answered {reply:?}",
                        self.host,
                        crate::cli::visible_text(buffer.lines().last().unwrap_or("")),
                    );
                    let _ = self.channel.data(reply).await;
                    answered_line = Some(line_start);
                }
            }

            // The screen first, because it is the one that can read a painted
            // prompt. The raw buffer stays as a fallback so that no device
            // which already worked can stop working.
            if let Some(prompt) = find_prompt_on_screen(&screen).or_else(|| find_prompt(&buffer)) {
                return Ok((buffer, Some(prompt)));
            }
        }
    }

    fn timed_out(&self, command: Option<&str>, buffer: &str) -> SshError {
        SshError::CommandTimeout {
            host: self.host.clone(),
            command: command.unwrap_or("<login>").to_string(),
            last_seen: last_seen_for(command, buffer),
        }
    }

    /// Escalates to enable mode, if the device left us in user mode.
    ///
    /// Worth doing before a configuration capture rather than after: from user
    /// mode `show running-config` returns an error, and an error saved as a
    /// backup is worse than a backup that failed.
    pub async fn enable(&mut self, password: Option<&Secret>) -> Result<bool, SshError> {
        if self.prompt.enabled {
            return Ok(true);
        }
        self.channel
            .data(&b"enable\n"[..])
            .await
            .map_err(|e| SshError::Protocol {
                host: self.host.clone(),
                source: e,
            })?;

        // The device answers with a password prompt, which is not a CLI prompt,
        // so the ordinary read loop would wait for one that never comes.
        let mut buffer = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Ok(false);
            }
            match timeout(remaining, self.channel.wait()).await {
                Ok(Some(ChannelMsg::Data { ref data })) => {
                    buffer.push_str(&String::from_utf8_lossy(data));
                    if buffer.to_ascii_lowercase().contains("password") {
                        let secret = password.map(|p| p.expose()).unwrap_or("");
                        let _ = self.channel.data(format!("{secret}\n").as_bytes()).await;
                        buffer.clear();
                        continue;
                    }
                    if let Some(p) = find_prompt(&buffer) {
                        let ok = p.enabled;
                        self.prompt = p;
                        return Ok(ok);
                    }
                }
                Ok(Some(_)) => {}
                _ => return Ok(false),
            }
        }
    }

    pub fn hostname(&self) -> &str {
        &self.prompt.hostname
    }

    pub async fn close(self) {
        let _ = self.channel.eof().await;
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "", "English")
            .await;
    }
}

/// An interactive shell on a device: bytes in, bytes out, nothing interpreted
/// (LT-320).
///
/// `Device` is the other way to use the same connection — it drives the CLI,
/// reads until it recognises a prompt, strips echo and answers `--More--`.
/// That is exactly wrong for a person at a keyboard: they want the device's
/// own screen, escape sequences and all, and a terminal emulator on the other
/// end to draw it. So this shares the handshake and then stays out of the way.
///
/// It reads and writes raw bytes and knows nothing about prompts, paging or
/// enable. The PTY is sized by the terminal that will draw it, and resized
/// when that terminal is.
pub struct Shell {
    host: String,
    handle: client::Handle<Verifier>,
    channel: russh::Channel<client::Msg>,
}

impl Shell {
    /// Connects, authenticates and asks for a shell on a PTY of this size.
    ///
    /// The terminal type is `xterm-256color` rather than the `vt100` a capture
    /// asks for: a capture wants the plainest output a device will give, and a
    /// person wants the device to use the colour and the line editing it has.
    pub async fn open(
        host: &str,
        credentials: &Credentials,
        options: SshOptions,
        store: Arc<std::sync::Mutex<HostKeyStore>>,
        cols: u32,
        rows: u32,
        progress: Option<mpsc::Sender<SshProgress>>,
    ) -> Result<Self, SshError> {
        let say = |p: SshProgress| {
            if let Some(tx) = &progress {
                let _ = tx.try_send(p);
            }
        };

        say(SshProgress::Connecting {
            host: host.to_string(),
        });

        let rejection = Arc::new(std::sync::Mutex::new(None));
        let verifier = Verifier {
            host: host.to_string(),
            port: options.port,
            store,
            rejection: Arc::clone(&rejection),
        };

        let config = Arc::new(client::Config {
            // A person leaves a session open while they think. Five minutes of
            // silence is not a dead connection, so this one keeps going where
            // a crawl's does not.
            //
            // The keepalive is *not* set here, and that is the point (LT-325):
            // russh would send it from inside its own loop, where nothing can
            // see it happen. `keepalive()` below is driven by the session task
            // instead, on an interval the operator sets, so the window can say
            // when the device was last spoken to. `keepalive_max: 0` leaves
            // russh out of deciding a session is dead.
            inactivity_timeout: None,
            keepalive_interval: None,
            keepalive_max: 0,
            preferred: network_device_algorithms(),
            ..Default::default()
        });

        say(SshProgress::CheckingHostKey {
            host: host.to_string(),
        });

        let connect = client::connect(config, (host, options.port), verifier);
        let mut handle = match timeout(options.connect_timeout, connect).await {
            Err(_) => {
                return Err(SshError::ConnectTimeout {
                    host: host.to_string(),
                    timeout: options.connect_timeout,
                })
            }
            Ok(Err(e)) => {
                if let Some(why) = rejection.lock().unwrap().take() {
                    return Err(SshError::HostKeyChanged(why));
                }
                return Err(SshError::Protocol {
                    host: host.to_string(),
                    source: e,
                });
            }
            Ok(Ok(h)) => h,
        };

        say(SshProgress::Authenticating {
            host: host.to_string(),
        });
        let auth = authenticate(&mut handle, host, credentials, &say);
        match timeout(options.auth_timeout, auth).await {
            Err(_) => {
                return Err(SshError::AuthTimeout {
                    host: host.to_string(),
                    timeout: options.auth_timeout,
                })
            }
            Ok(result) => result?,
        }

        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::Protocol {
                host: host.to_string(),
                source: e,
            })?;
        let (cols, rows) = sane_size(cols, rows);
        channel
            .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
            .await
            .map_err(|e| SshError::Protocol {
                host: host.to_string(),
                source: e,
            })?;
        channel
            .request_shell(true)
            .await
            .map_err(|e| SshError::Protocol {
                host: host.to_string(),
                source: e,
            })?;

        say(SshProgress::Ready {
            host: host.to_string(),
            hostname: String::new(),
        });

        Ok(Shell {
            host: host.to_string(),
            handle,
            channel,
        })
    }

    /// Keystrokes, as typed. Nothing is added — not even a newline.
    pub async fn send(&mut self, bytes: &[u8]) -> Result<(), SshError> {
        self.channel
            .data(bytes)
            .await
            .map_err(|e| SshError::Protocol {
                host: self.host.clone(),
                source: e,
            })
    }

    /// Tells the device we are still here, without typing anything into the
    /// session (LT-325).
    ///
    /// This is an SSH-level global request. **Nothing is ever written to the
    /// shell to keep it alive** — a newline sent into somebody's half-typed
    /// command line is how a keepalive turns into a configuration change.
    /// What it stops is the idle timer on the device, and the NAT or firewall
    /// in between quietly dropping a connection nobody is using.
    ///
    /// It cannot promise the device answered: SSH keepalives are fire and
    /// forget unless the peer chooses to reply. What it does prove is that
    /// this end is still connected, which is what fails first when a session
    /// has gone away underneath.
    pub async fn keepalive(&self) -> Result<(), SshError> {
        self.handle
            .send_keepalive(true)
            .await
            .map_err(|e| SshError::Protocol {
                host: self.host.clone(),
                source: e,
            })
    }

    /// The window changed size, so the device should rewrap.
    pub async fn resize(&mut self, cols: u32, rows: u32) -> Result<(), SshError> {
        let (cols, rows) = sane_size(cols, rows);
        self.channel
            .window_change(cols, rows, 0, 0)
            .await
            .map_err(|e| SshError::Protocol {
                host: self.host.clone(),
                source: e,
            })
    }

    /// The next bytes the device sent, or `None` when the session has ended.
    ///
    /// Standard error is returned alongside standard output, because a
    /// terminal has one screen and that is where a device's warnings belong.
    pub async fn read(&mut self) -> Option<Vec<u8>> {
        loop {
            match self.channel.wait().await {
                None => return None,
                Some(ChannelMsg::Data { data }) => return Some(data.to_vec()),
                Some(ChannelMsg::ExtendedData { data, .. }) => return Some(data.to_vec()),
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => return None,
                Some(_) => continue,
            }
        }
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub async fn close(self) {
        let _ = self.channel.eof().await;
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "", "English")
            .await;
    }
}

/// A PTY size a device will accept.
///
/// A terminal that has not been laid out yet reports zero columns, and a
/// zero-width PTY makes some devices wrap every line at column one; an absurd
/// width makes others refuse the request outright. Pure, so the clamping is
/// tested without a device.
pub fn sane_size(cols: u32, rows: u32) -> (u32, u32) {
    (cols.clamp(20, 500), rows.clamp(5, 200))
}

/// Which method to lead with, given what the server advertised after a
/// `none` query. Separated so the decision is testable without a server.
///
/// The order matters more than it looks: a hardened IOS-XE box configured
/// `ip ssh server algorithm authentication keyboard` does not merely refuse
/// a password attempt — it tears the session down, and the fallback that
/// would have worked never gets to run ("Channel send error", LT-060). So
/// password is only attempted when the server says it takes passwords; a
/// server that advertises nothing gets keyboard-interactive, which every
/// Cisco and Fortinet in the lab answers.
fn password_first(advertised: &russh::MethodSet) -> bool {
    advertised.contains(&russh::MethodKind::Password)
}

/// Ask, then answer: a `none` query learns the advertised methods, then
/// password and keyboard-interactive are tried in the order the server can
/// survive. Both exist because devices differ about which one they offer for
/// the same credentials, and Duo lives on keyboard-interactive.
async fn authenticate(
    handle: &mut client::Handle<Verifier>,
    host: &str,
    credentials: &Credentials,
    say: &impl Fn(SshProgress),
) -> Result<(), SshError> {
    let protocol = |e: russh::Error| SshError::Protocol {
        host: host.to_string(),
        source: e,
    };

    let advertised = match handle
        .authenticate_none(&credentials.username)
        .await
        .map_err(protocol)?
    {
        russh::client::AuthResult::Success => return Ok(()),
        russh::client::AuthResult::Failure {
            remaining_methods, ..
        } => remaining_methods,
    };

    if password_first(&advertised) {
        let ok = handle
            .authenticate_password(&credentials.username, credentials.password.expose())
            .await
            .map_err(protocol)?;
        if ok.success() {
            return Ok(());
        }
    }

    let mut response = handle
        .authenticate_keyboard_interactive_start(&credentials.username, None)
        .await
        .map_err(protocol)?;

    // Bounded so a device that keeps asking cannot spin here forever. Real
    // exchanges are two or three rounds: password, then the Duo wait.
    for _ in 0..8 {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err(SshError::AuthFailed {
                    host: host.to_string(),
                })
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                instructions,
                prompts,
                ..
            } => {
                // A request with no prompts is the server talking, not asking:
                // with push-only Duo this is "a push has been sent". The
                // correct reply is an empty response, and then more waiting.
                let answers: Vec<String> = prompts
                    .iter()
                    .map(|p| {
                        if looks_like_password(&p.prompt) {
                            credentials.password.expose().to_string()
                        } else {
                            // Anything else is the second factor. Push-only
                            // means there is nothing to type; an empty answer
                            // is what triggers the push in an autopush setup.
                            String::new()
                        }
                    })
                    .collect();

                let waiting = prompts.is_empty() || prompts.iter().any(|p| !looks_like_password(&p.prompt));
                if waiting {
                    let message = second_factor_message(&instructions);
                    say(SshProgress::AwaitingSecondFactor {
                        host: host.to_string(),
                        message,
                    });
                }

                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(protocol)?;
            }
        }
    }

    Err(SshError::AuthFailed {
        host: host.to_string(),
    })
}

/// The tail of what a device sent, for a login that never reached a prompt
/// (LT-378).
///
/// **Only for the login read.** `command` is `None` there, and the buffer is a
/// banner. For a real command the buffer can be a running-config, and putting
/// that in an error message would scatter secrets through logs and screenshots
/// (D-006) — so a command timeout says nothing about content, exactly as
/// before.
///
/// Control characters are rendered rather than emitted, so a banner full of
/// escape sequences reads as text instead of redrawing the terminal it is
/// printed in.
/// Keeps the login stream, up to a point (LT-384).
///
/// Bounded because a device that floods rather than prompting would otherwise
/// fill memory while the loop waits for its timeout. A quarter of a megabyte
/// is far more than any login banner and far less than any running-config.
fn record_login(sink: &Option<Arc<std::sync::Mutex<Vec<u8>>>>, data: &[u8]) {
    const CAP: usize = 256 * 1024;
    let Some(sink) = sink else { return };
    let Ok(mut kept) = sink.lock() else { return };
    let room = CAP.saturating_sub(kept.len());
    if room > 0 {
        kept.extend_from_slice(&data[..data.len().min(room)]);
    }
}

fn last_seen_for(command: Option<&str>, buffer: &str) -> String {
    if command.is_some() {
        return String::new();
    }
    let tail: String = buffer.chars().rev().take(300).collect::<Vec<_>>().into_iter().rev().collect();
    let shown: String = tail
        .chars()
        .map(|c| match c {
            '\n' => '\n',
            c if c.is_control() => '·',
            c => c,
        })
        .collect();
    let shown = shown.trim();
    if shown.is_empty() {
        " — the device sent nothing at all".to_string()
    } else {
        format!(" — it had sent:\n{shown}")
    }
}

/// Whether a challenge is asking for the account password rather than a second
/// factor.
fn looks_like_password(prompt: &str) -> bool {
    let p = prompt.to_ascii_lowercase();
    p.contains("password") && !p.contains("passcode")
}

/// What to show while a push is outstanding.
///
/// The device's own instruction text is used when there is one, because it
/// names the service and is more use than anything invented here. Otherwise a
/// sentence that tells the user to go and look at their phone, which is the
/// entire job of this message.
fn second_factor_message(instructions: &str) -> String {
    let trimmed = instructions.trim();
    if trimmed.is_empty() {
        "Waiting for second-factor approval — approve the push on your phone.".to_string()
    } else {
        format!("{trimmed} — approve the push on your phone.")
    }
}

#[cfg(test)]
mod tests {
    use super::sane_size;

    #[test]
    fn a_terminal_that_has_not_been_laid_out_yet_still_gets_a_usable_pty() {
        // A hidden or unmeasured terminal reports zero columns. A zero-width
        // PTY makes some devices wrap every line at column one (LT-320).
        assert_eq!(sane_size(0, 0), (20, 5));
    }

    #[test]
    fn an_absurd_size_is_brought_back_to_something_a_device_will_accept() {
        assert_eq!(sane_size(100_000, 100_000), (500, 200));
    }

    #[test]
    fn an_ordinary_window_is_passed_through_untouched() {
        assert_eq!(sane_size(120, 30), (120, 30));
    }

    use super::*;

    #[test]
    fn legacy_algorithms_are_offered_but_never_preferred() {
        // The order is the whole point: a modern device must still negotiate
        // modern algorithms, and the SHA-1 names exist only so an old switch
        // is reachable at all.
        let p = network_device_algorithms();

        let kex: Vec<&str> = p.kex.iter().map(|k| k.as_ref()).collect();
        assert!(kex.contains(&"diffie-hellman-group14-sha1"), "no legacy kex: {kex:?}");
        assert!(kex.contains(&"diffie-hellman-group-exchange-sha1"));
        let modern = kex.iter().position(|k| *k == "curve25519-sha256").unwrap();
        let legacy = kex.iter().position(|k| *k == "diffie-hellman-group14-sha1").unwrap();
        assert!(modern < legacy, "SHA-1 kex must sit below the modern ones");

        let macs: Vec<&str> = p.mac.iter().map(|m| m.as_ref()).collect();
        assert!(macs.contains(&"hmac-sha1"));
        let modern = macs.iter().position(|m| *m == "hmac-sha2-256-etm@openssh.com").unwrap();
        let legacy = macs.iter().position(|m| *m == "hmac-sha1").unwrap();
        assert!(modern < legacy, "SHA-1 MACs must sit below the modern ones");

        let ciphers: Vec<&str> = p.cipher.iter().map(|c| c.as_ref()).collect();
        assert!(ciphers.contains(&"aes256-cbc"), "CBC is common on older IOS");
        let modern = ciphers.iter().position(|c| *c == "aes256-ctr").unwrap();
        let legacy = ciphers.iter().position(|c| *c == "aes256-cbc").unwrap();
        assert!(modern < legacy, "CBC must sit below CTR and GCM");
    }

    /// LT-488: an old switch answered `theirs: ["diffie-hellman-group1-sha1"]`
    /// and nothing else. russh implements it; it has to be offered — last,
    /// because it is a 1024-bit group, so anything better still wins. The
    /// same generation sometimes wants `3des-cbc` next; that one is behind
    /// russh's optional `des` feature and is added when a device asks for it.
    #[test]
    fn a_switch_that_only_speaks_group1_finds_a_match_and_nothing_better_moves() {
        let p = network_device_algorithms();
        let kex: Vec<&str> = p.kex.iter().map(|k| k.as_ref()).collect();
        assert!(kex.contains(&"diffie-hellman-group1-sha1"), "{kex:?}");
        assert_eq!(kex.iter().rfind(|k| !k.starts_with("ext-info") && !k.starts_with("kex-strict")), Some(&"diffie-hellman-group1-sha1"), "group1 must be the very last kex: {kex:?}");
        assert_eq!(kex.first(), Some(&Preferred::DEFAULT.kex[0].as_ref()), "the first choice is still russh's");
    }

    /// LT-060: the lab 9300 tears the session down on a refused password
    /// attempt, so the method choice must come from what the server
    /// advertises — and a server advertising nothing gets
    /// keyboard-interactive, never the fatal password try.
    #[test]
    fn password_only_when_the_server_takes_passwords() {
        use russh::{MethodKind, MethodSet};
        let none: MethodSet = MethodSet::empty();
        assert!(!password_first(&none), "an empty advertisement must not invite a password");
        let ki_only = MethodSet::from(&[MethodKind::KeyboardInteractive][..]);
        assert!(!password_first(&ki_only));
        let both = MethodSet::from(&[MethodKind::Password, MethodKind::KeyboardInteractive][..]);
        assert!(password_first(&both));
    }

    /// LT-054: the lab 9300 is locked to `ip ssh server algorithm kex
    /// ecdh-sha2-nistp521 ecdh-sha2-nistp384` and refused every client offer
    /// — "No common Kex algorithm". IOS-XE hardening guides recommend
    /// exactly that pair, so this is what a locked-down enterprise switch
    /// looks like, not an oddity.
    #[test]
    fn nist_ecdh_kex_is_offered_for_hardened_ios_xe() {
        let p = network_device_algorithms();
        let kex: Vec<&str> = p.kex.iter().map(|k| k.as_ref()).collect();
        for want in ["ecdh-sha2-nistp521", "ecdh-sha2-nistp384", "ecdh-sha2-nistp256"] {
            assert!(kex.contains(&want), "{want} missing: {kex:?}");
        }
        // Preference order: modern curves first, NIST ECDH next, SHA-1 last.
        let curve = kex.iter().position(|k| *k == "curve25519-sha256").unwrap();
        let nist = kex.iter().position(|k| *k == "ecdh-sha2-nistp521").unwrap();
        let sha1 = kex.iter().position(|k| *k == "diffie-hellman-group14-sha1").unwrap();
        assert!(curve < nist && nist < sha1, "order wrong: {kex:?}");
    }

    #[test]
    fn a_password_never_appears_in_debug_output() {
        // Credentials end up in an error message or a log line eventually, and
        // this is what makes that impossible rather than merely unlikely.
        let creds = Credentials {
            username: "admin".into(),
            password: Secret::new("hunter2"),
            enable_password: Some(Secret::new("enable-secret")),
        };
        let rendered = format!("{creds:?}");
        assert!(!rendered.contains("hunter2"), "password leaked: {rendered}");
        assert!(!rendered.contains("enable-secret"), "enable password leaked: {rendered}");
        assert!(rendered.contains("admin"), "the username is not secret and is useful");
    }

    #[test]
    fn the_password_challenge_is_told_apart_from_the_second_factor() {
        // Answering a Duo passcode prompt with the account password would send
        // the password to Duo and fail in a confusing way.
        assert!(looks_like_password("Password: "));
        assert!(looks_like_password("admin@10.1.1.1's password:"));
        assert!(!looks_like_password("Passcode or option (1-1): "));
        assert!(!looks_like_password("Duo two-factor login for admin"));
        assert!(!looks_like_password("Enter a passcode or select one of the following options:"));
    }

    #[test]
    fn the_waiting_message_prefers_what_the_device_said() {
        // The device names the service; anything invented here would not.
        let m = second_factor_message("Duo two-factor login for admin");
        assert!(m.contains("Duo two-factor login for admin"));
        assert!(m.contains("phone"), "it must tell the user where to look");

        let m = second_factor_message("   ");
        assert!(m.contains("phone"));
        assert!(!m.starts_with("—"), "an empty instruction should not leave a dangling dash");
    }

    #[test]
    fn the_auth_deadline_is_far_longer_than_the_connect_deadline() {
        // A person has to reach for a phone. Sharing one timeout would either
        // make unreachable devices slow to fail or make Duo impossible.
        let o = SshOptions::default();
        assert!(
            o.auth_timeout >= o.connect_timeout * 5,
            "auth {:?} should dwarf connect {:?}",
            o.auth_timeout,
            o.connect_timeout
        );
        assert!(o.connect_timeout <= Duration::from_secs(10), "a dead device must fail fast");
        assert!(o.auth_timeout >= Duration::from_secs(60), "a push needs time to be approved");
    }

    #[test]
    fn errors_say_which_device_and_what_to_do() {
        // These are read by someone deciding whether the device, the network or
        // the credentials are at fault.
        let e = SshError::AuthTimeout {
            host: "10.1.1.1".into(),
            timeout: Duration::from_secs(90),
        };
        let msg = e.to_string();
        assert!(msg.contains("10.1.1.1"));
        assert!(msg.contains("Duo"), "the likely cause should be named: {msg}");

        let e = SshError::ConnectTimeout {
            host: "10.1.1.2".into(),
            timeout: Duration::from_secs(8),
        };
        assert!(e.to_string().contains("10.1.1.2"));
    }
}
