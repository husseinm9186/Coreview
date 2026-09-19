//! Drives a real device through `ssh::Shell` — the interactive session behind
//! the terminal (LT-320) and everything the operator asked for on top of it:
//! a PTY that resizes (LT-323), a keepalive that is ours to send (LT-325), and
//! a transcript with the escape sequences taken out (LT-324).
//!
//! The panel's harness stubs the backend, because a switch is not available to
//! Playwright. This is the other half: no stubs, one device, and a report of
//! what it actually did. It is how `verified_against_hardware` gets earned for
//! the terminal the same way `probe_stack` earns it for the stacking parsers.
//!
//!     CV_HOST=10.1.1.1 CV_USER=admin CV_PASS=... \
//!       CV_CMDS='show version;show ip interface brief' \
//!         cargo run -p coreview-discover --example interactive_shell
//!
//! `CV_LOG=/path/to/file` also writes the stripped transcript, so what LT-324
//! would have saved can be read back and diffed. Nothing is written anywhere
//! unless that is set, and no credential is ever written at all.

use std::sync::Arc;
use std::time::Duration;

use coreview_discover::hostkeys::HostKeyStore;
use coreview_discover::sessionlog::SessionLog;
use coreview_discover::ssh::{Credentials, Secret, Shell, SshOptions};

/// Reads whatever the device sends until it goes quiet for `idle`.
///
/// A shell has no end-of-output marker — that is the whole point of it, and
/// why `Device`'s prompt-matching read loop is the wrong tool here. Waiting
/// for silence is what a terminal in front of a person effectively does.
async fn read_until_quiet(shell: &mut Shell, idle: Duration, overall: Duration) -> Vec<u8> {
    let mut out = Vec::new();
    let deadline = tokio::time::Instant::now() + overall;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            break;
        }
        match tokio::time::timeout(idle.min(left), shell.read()).await {
            // Quiet for `idle`: the device has said what it is going to say.
            Err(_) => break,
            Ok(None) => break,
            Ok(Some(chunk)) => out.extend_from_slice(&chunk),
        }
    }
    out
}

#[tokio::main]
async fn main() {
    let host = std::env::var("CV_HOST").expect("set CV_HOST");
    let user = std::env::var("CV_USER").expect("set CV_USER");
    let pass = std::env::var("CV_PASS").expect("set CV_PASS");
    let port: u16 = std::env::var("CV_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(22);
    let commands: Vec<String> = std::env::var("CV_CMDS")
        .unwrap_or_else(|_| "show version".into())
        .split(';')
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();

    let credentials = Credentials {
        username: user,
        password: Secret::new(pass),
        enable_password: None,
    };
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::default()));
    let options = SshOptions {
        port,
        ..SshOptions::default()
    };

    println!("== opening a shell on {host}:{port}");
    let started = std::time::Instant::now();
    let mut shell = match Shell::open(&host, &credentials, options, store, 120, 30, None).await {
        Ok(s) => s,
        Err(e) => {
            println!("FAIL  could not open a shell: {e}");
            std::process::exit(1);
        }
    };
    println!("ok    shell open in {:?}", started.elapsed());

    // A transcript of everything, shaped the way LT-324 shapes it.
    let mut log = SessionLog::new();
    let mut transcript = Vec::new();

    // What the device draws before anything is typed: the banner and its
    // prompt. A shell that never says anything is a shell that did not start.
    let banner = read_until_quiet(&mut shell, Duration::from_millis(1200), Duration::from_secs(15)).await;
    transcript.extend_from_slice(&log.feed(&banner));
    if banner.is_empty() {
        println!("FAIL  the device drew nothing at all — no banner and no prompt");
    } else {
        println!("ok    the device drew {} bytes before anything was typed", banner.len());
        let text = String::from_utf8_lossy(&banner);
        let last = text.lines().last().unwrap_or("").trim().to_string();
        println!("      it is waiting at: {last:?}");
        println!(
            "      escape sequences in the banner: {}",
            banner.iter().filter(|&&b| b == 0x1b).count()
        );
    }

    // LT-323/320: the PTY resizes. A device that took the request rewraps; one
    // that refused it errors here rather than silently ignoring it.
    match shell.resize(200, 50).await {
        Ok(()) => println!("ok    the device took a window-change to 200x50"),
        Err(e) => println!("FAIL  window-change refused: {e}"),
    }

    // LT-325: a keepalive of our own, which is what "give admin real control"
    // came down to. It must not disturb the session.
    match shell.keepalive().await {
        Ok(()) => println!("ok    keepalive sent"),
        Err(e) => println!("FAIL  keepalive: {e}"),
    }
    let after_keepalive = read_until_quiet(&mut shell, Duration::from_millis(800), Duration::from_secs(4)).await;
    transcript.extend_from_slice(&log.feed(&after_keepalive));
    println!(
        "{}    a keepalive typed nothing into the session ({} bytes back)",
        if after_keepalive.is_empty() { "ok  " } else { "note" },
        after_keepalive.len()
    );

    // Keystrokes, exactly as the terminal sends them: the characters, then a
    // carriage return. Nothing is added — that is the contract the panel has.
    for command in &commands {
        println!("== typing {command:?}");
        if let Err(e) = shell.send(format!("{command}\r").as_bytes()).await {
            println!("FAIL  could not send: {e}");
            break;
        }
        let reply = read_until_quiet(&mut shell, Duration::from_millis(1500), Duration::from_secs(45)).await;
        transcript.extend_from_slice(&log.feed(&reply));
        let text = String::from_utf8_lossy(&reply);
        let lines: Vec<&str> = text.lines().collect();
        println!("ok    {} bytes, {} lines", reply.len(), lines.len());
        // The echo of what was typed is what proves the keystrokes arrived as
        // keystrokes rather than as a command run for us.
        println!(
            "      the device echoed the command back: {}",
            lines.first().map(|l| l.contains(command.as_str())).unwrap_or(false)
        );
        for line in lines.iter().take(4) {
            println!("      | {}", line.trim_end());
        }
        if lines.len() > 4 {
            println!("      | … {} more", lines.len() - 4);
        }
        // A shell does not turn paging off — a person wants the pager, and
        // `Shell` deliberately skips the `terminal length 0` that `Device`
        // sends. Worth reporting, because a device sitting at `--More--` eats
        // the next keystroke, and the command after this one then arrives
        // missing its first character. That is the pager doing its job, not a
        // byte going astray, and it cost an hour to be sure of once.
        if text.trim_end().ends_with("--More--") || text.contains("--More--") {
            println!("      note: the device is paging. The next keystroke answers the pager,");
            println!("            exactly as it would in PuTTY. Send `terminal length 0` first");
            println!("            if you want unbroken output from this example.");
        }
    }

    // LT-324: what would have been written to the session log.
    let readable = String::from_utf8_lossy(&transcript).to_string();
    println!("== transcript");
    println!("ok    {} bytes raw handled, {} bytes readable", transcript.len(), readable.len());
    println!(
        "{}    no escape sequences survived into the log",
        if readable.contains('\u{1b}') { "FAIL" } else { "ok  " }
    );
    println!(
        "{}    no bare carriage returns survived either",
        if readable.contains('\r') { "FAIL" } else { "ok  " }
    );
    if let Ok(path) = std::env::var("CV_LOG") {
        match std::fs::write(&path, &readable) {
            Ok(()) => println!("ok    written to {path}"),
            Err(e) => println!("FAIL  could not write {path}: {e}"),
        }
    }

    shell.close().await;
    println!("ok    closed");
}
