//! Point this at a real stack and find out whether the parsers were right.
//!
//! The stacking parsers were written from vendor documentation rather than
//! from captured output (D-026), which means every one of them is a guess
//! until a device has answered it. This is how that guess gets checked: it
//! runs the commands for the platform, prints **exactly what came back**, and
//! then prints what the parser made of it, so the two can be compared by eye.
//!
//!     CV_HOST=10.1.1.1 CV_USER=admin CV_PASS=... \
//!       cargo run -p coreview-discover --example probe_stack
//!
//! Optional: `CV_PLATFORM` picks the command set when the device's own banner
//! is not enough (`aruba`, `junos`, `forti`, anything else means Cisco-like).
//! `CV_PORT` for a non-standard SSH port.
//!
//! When a family is confirmed, say so in `stacking.rs` —
//! `verified_against_hardware` is the field that tells a proven parser from a
//! plausible one, and this is the tool that earns the change.

use std::sync::Arc;
use std::time::Duration;

use coreview_discover::hostkeys::HostKeyStore;
use coreview_discover::ssh::{Credentials, Device, Secret, SshOptions, SshProgress};
use coreview_discover::stacking::{command_rejected, parse_any, probe_commands_for};

#[tokio::main]
async fn main() {
    let host = std::env::var("CV_HOST").expect("set CV_HOST");
    let user = std::env::var("CV_USER").expect("set CV_USER");
    let pass = std::env::var("CV_PASS").expect("set CV_PASS");
    let port: u16 = std::env::var("CV_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(22);
    let platform = std::env::var("CV_PLATFORM").unwrap_or_default();

    let (tx, mut rx) = tokio::sync::mpsc::channel::<SshProgress>(32);
    tokio::spawn(async move { while rx.recv().await.is_some() {} });

    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let options = SshOptions {
        port,
        connect_timeout: Duration::from_secs(10),
        auth_timeout: Duration::from_secs(90),
        command_timeout: Duration::from_secs(45),
    };
    let credentials = Credentials {
        username: user,
        password: Secret::new(pass),
        enable_password: std::env::var("CV_ENABLE").ok().map(Secret::new),
    };

    let commands = probe_commands_for(&platform);
    println!("asking {host} {} command(s) for platform hint {platform:?}\n", commands.len());

    let mut device =
        match Device::connect(&host, &credentials, options, Arc::clone(&store), Some(tx)).await {
            Ok(d) => d,
            Err(e) => {
                eprintln!("could not log in: {e}");
                std::process::exit(1);
            }
        };
    println!("prompt: {:?}\n", device.prompt.text);

    let mut recognised = false;
    for command in commands {
        println!("=== {command}");
        let output = match device.run(command).await {
            Ok(o) => o,
            Err(e) => {
                println!("    (failed to run: {e})\n");
                continue;
            }
        };
        // Raw first and in full. The whole value of this tool is that the
        // bytes can be pasted into a test afterwards.
        for line in output.lines() {
            println!("    | {line}");
        }
        if command_rejected(&output) {
            println!("    -> the device does not know this command\n");
            continue;
        }
        match parse_any(&output) {
            None => println!("    -> NOT RECOGNISED by any parser -- this is the interesting case\n"),
            Some(info) => {
                recognised = true;
                println!(
                    "    -> {} ({}), {} member(s), draws as {}",
                    info.kind.label(),
                    if info.unverified { "parser still unverified" } else { "verified" },
                    info.members.len(),
                    if info.kind.draws_as_one_node() { "one node" } else { "separate chassis" },
                );
                for m in &info.members {
                    println!(
                        "       member {} role={:?} state={:?} model={:?} serial={:?} mac={:?}",
                        m.id, m.role, m.state, m.model, m.serial, m.mac
                    );
                }
                if let Some(isl) = &info.inter_switch_link {
                    println!("       inter-switch link: {isl}");
                }
                if let Some(peer) = &info.peer {
                    println!("       peer: {peer}");
                }
                println!("       really stacked: {}", info.is_really_stacked());
                println!();
            }
        }
    }

    if !recognised {
        println!(
            "Nothing here reported a stack. That is the right answer for a switch that is \
             not stacked -- and the wrong one if this device is. If it is, the raw output \
             above is what a parser should be written against."
        );
    }
}
