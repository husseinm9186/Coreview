//! Point this at a FortiGate or a FortiSwitch and find out whether the crawl's
//! command set and its parsers are right (LT-408, LT-409).
//!
//! `fortios.rs` was written against captured output, but the *set of commands
//! the crawl sends* has grown item by item and has never been run end to end
//! against a device. This runs exactly what `crawl.rs` runs, in the same
//! order, and prints three things per command:
//!
//! whether the device understood it, how much it said, and — the number that
//! matters — **what the parser made of it**. A command that answers and a
//! parser that reads nothing look identical from the crawl's side.
//!
//!     CV_HOST=192.0.2.1 CV_USER=admin CV_PASS=... \
//!       cargo run -p coreview-discover --example probe_fortios
//!
//! `CV_PORT` for a non-standard SSH port. `CV_SHOW=1` prints the raw output
//! too, for reading a shape by eye before writing a parser for it.
//!
//! **What comes back is a real device's configuration.** It is read here and
//! nowhere else: no capture from this tool becomes a fixture, a default or an
//! example (D-027).

use std::sync::Arc;
use std::time::Duration;

use coreview_discover::hostkeys::HostKeyStore;
use coreview_discover::ssh::{Credentials, Device, Secret, SshOptions, SshProgress};

/// What the crawl asks a FortiOS device, in the order `crawl.rs` asks it.
///
/// Kept here as one list so the two can be compared by eye; if `crawl.rs`
/// gains a command and this does not, the next run says so by not testing it.
const COMMANDS: &[&str] = &[
    "get system status",
    "get system performance status",
    "get system interface",
    "get switch lldp neighbors-summary",
    "get switch lldp neighbors-detail",
    "show switch-controller managed-switch",
    "get wireless-controller wtp-status",
    "get system arp",
    "diagnose switch mac-address list",
    "execute dhcp lease-list",
    "diagnose user-device-store device memory list",
];

/// What the parser for each command found, in one line.
fn parsed(command: &str, out: &str) -> String {
    use coreview_discover::fortios as f;
    match command {
        "get system status" => {
            let s = f::parse_system_status(out);
            format!(
                "model {:?}, version {:?}, serial {:?}, hostname {:?}, vdoms {}",
                s.model, s.version, s.serial, s.hostname, s.vdoms_enabled
            )
        }
        "get system performance status" => {
            format!("uptime {:?}", coreview_discover::uptime::parse_uptime(out))
        }
        "get system interface" => {
            let addresses = f::parse_system_interface(out);
            format!("{} interface address(es): {:?}", addresses.len(), first_few(&addresses))
        }
        "get switch lldp neighbors-summary" => {
            let n = f::parse_lldp_summary(out);
            format!("{} neighbour(s)", n.len())
        }
        "get switch lldp neighbors-detail" => {
            let n = f::parse_lldp_detail(out);
            format!("{} neighbour(s)", n.len())
        }
        "show switch-controller managed-switch" => {
            let s = f::parse_managed_switches(out);
            format!("{} managed switch(es)", s.len())
        }
        "get wireless-controller wtp-status" => {
            let a = f::parse_wtp_status(out);
            format!("{} access point(s)", a.len())
        }
        "get system arp" => {
            let a = coreview_discover::arp::parse_arp_table(out);
            format!("{} ARP entr(ies)", a.len())
        }
        "diagnose switch mac-address list" => {
            let m = coreview_discover::mac_table::parse_mac_table(out);
            format!("{} learned MAC(s)", m.len())
        }
        "execute dhcp lease-list" => {
            let l = f::parse_dhcp_leases(out);
            format!("{} lease(s)", l.len())
        }
        "diagnose user-device-store device memory list" => {
            let e = f::parse_device_store(out);
            format!("{} endpoint(s)", e.len())
        }
        _ => "no parser wired to this command".to_string(),
    }
}

fn first_few<T: std::fmt::Debug>(items: &[T]) -> String {
    items.iter().take(3).map(|i| format!("{i:?}")).collect::<Vec<_>>().join(", ")
}

#[tokio::main]
async fn main() {
    let host = std::env::var("CV_HOST").expect("set CV_HOST");
    let user = std::env::var("CV_USER").expect("set CV_USER");
    let pass = std::env::var("CV_PASS").expect("set CV_PASS");
    let port: u16 = std::env::var("CV_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(22);
    let show = std::env::var("CV_SHOW").is_ok();

    let (tx, mut rx) = tokio::sync::mpsc::channel::<SshProgress>(32);
    tokio::spawn(async move { while rx.recv().await.is_some() {} });

    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let options = SshOptions {
        port,
        connect_timeout: Duration::from_secs(15),
        auth_timeout: Duration::from_secs(20),
        command_timeout: Duration::from_secs(60),
        login_transcript: None,
    };
    let credentials = Credentials {
        username: user,
        password: Secret::new(pass),
        enable_password: None,
    };

    let mut device = match Device::connect(&host, &credentials, options, Arc::clone(&store), Some(tx)).await {
        Ok(d) => d,
        Err(e) => {
            eprintln!("could not log in: {e}");
            std::process::exit(1);
        }
    };
    println!("prompt: {:?}\n", device.prompt.text);

    // The crawl reaches the FortiOS arm because `show version` is rejected.
    let version = device.run("show version").await.unwrap_or_default();
    println!(
        "`show version` rejected: {}  (this is what selects the FortiOS arm)\n",
        coreview_discover::fortios::rejected_command(&version)
    );

    let mut answered = 0usize;
    let mut refused = 0usize;
    for command in COMMANDS {
        let out = device.run(command).await.unwrap_or_default();
        let rejected = coreview_discover::fortios::rejected_command(&out);
        println!("--- {command}");
        if rejected {
            refused += 1;
            println!("    REFUSED: {}", out.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim());
        } else if out.trim().is_empty() {
            println!("    empty answer");
        } else {
            answered += 1;
            println!("    {} bytes, {} lines", out.len(), out.lines().count());
            println!("    parser: {}", parsed(command, &out));
        }
        if show && !rejected {
            for line in out.lines().take(40) {
                println!("    | {line}");
            }
        }
        println!();
    }

    println!("{answered} answered, {refused} refused, of {} asked", COMMANDS.len());
    let _ = device.close().await;
}
