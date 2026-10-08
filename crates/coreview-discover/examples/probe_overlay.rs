//! Point this at a device with VRFs or a VXLAN fabric and find out whether the
//! parsers were right.
//!
//! `vrftables.rs` and `overlay.rs` were written from vendor documentation
//! rather than from captured output, which means every one of them is
//! a guess until a device has answered it. This is how that guess gets
//! checked: it runs the commands for the platform, prints **exactly what came
//! back**, and then prints what the parser made of it, so the two can be
//! compared by eye.
//!
//!     CV_HOST=10.1.1.1 CV_USER=admin CV_PASS=... \
//!       cargo run -p coreview-discover --example probe_overlay
//!
//! `CV_PLATFORM` picks the command set where the banner is not enough:
//! `nxos`, `arista`, `junos`, `forti`, or anything else for Cisco-like.
//! `CV_LOG=/path` writes the whole session, so a capture can be kept and a
//! fixture built from something real.
//!
//! **When a dialect is confirmed, say so in the source** —
//! `verified_against_hardware` is the field that tells a proven parser from a
//! plausible one, and this is the tool that earns the change. Name the device
//! in the commit.

use std::sync::Arc;

use coreview_discover::hostkeys::HostKeyStore;
use coreview_discover::overlay::{parse_evpn, parse_peers, parse_vni_table, OverlayDialect};
use coreview_discover::ssh::{Credentials, Device, Secret, SshOptions};
use coreview_discover::vrftables::{parse_vrf_list, VrfDialect};

/// Words a device uses when it does not know a command. Printing "0 VRFs
/// found" for a device that said "Invalid input" is how a documentation-built
/// parser looks like it works.
fn rejected(out: &str) -> bool {
    let l = out.to_ascii_lowercase();
    l.contains("invalid input")
        || l.contains("invalid command")
        || l.contains("% unrecognized")
        || l.contains("syntax error")
        || l.contains("command parse error")
        || l.contains("unknown action")
        || l.contains("permission denied")
}

fn show(title: &str, body: &str) {
    println!("\n----- {title} -----");
    for line in body.lines().take(60) {
        println!("| {line}");
    }
    if body.lines().count() > 60 {
        println!("| … {} more lines", body.lines().count() - 60);
    }
}

#[tokio::main]
async fn main() {
    let host = std::env::var("CV_HOST").expect("set CV_HOST");
    let user = std::env::var("CV_USER").expect("set CV_USER");
    let pass = std::env::var("CV_PASS").expect("set CV_PASS");
    let port: u16 = std::env::var("CV_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(22);
    let platform = std::env::var("CV_PLATFORM").unwrap_or_default().to_ascii_lowercase();

    let (vrf_dialect, overlay_dialect) = match platform.as_str() {
        "nxos" => (VrfDialect::Cisco, Some(OverlayDialect::NxOs)),
        "arista" | "eos" => (VrfDialect::Arista, Some(OverlayDialect::Arista)),
        "junos" | "juniper" => (VrfDialect::Junos, Some(OverlayDialect::Junos)),
        "forti" | "fortios" => (VrfDialect::FortiOs, None),
        _ => (VrfDialect::Cisco, Some(OverlayDialect::NxOs)),
    };

    println!("== connecting to {host}:{port}");
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::default()));
    let credentials = Credentials {
        username: user,
        password: Secret::new(pass),
        enable_password: std::env::var("CV_ENABLE").ok().map(Secret::new),
    };
    let mut device = match Device::connect(
        &host,
        &credentials,
        SshOptions { port, ..SshOptions::default() },
        store,
        None,
    )
    .await
    {
        Ok(d) => d,
        Err(e) => {
            println!("FAIL  {e}");
            std::process::exit(1);
        }
    };
    println!("ok    logged in to {}", device.hostname());

    let mut transcript = String::new();
    let run = |label: &str, out: String, transcript: &mut String| -> String {
        transcript.push_str(&format!("\n===== {label} =====\n{out}\n"));
        show(label, &out);
        if rejected(&out) {
            println!("note: this device does not know that command — nothing below is about it.");
        }
        out
    };

    // ---------------------------------------------------------------- VRFs
    println!("\n== VRFs ({vrf_dialect:?}, verified = {})", vrf_dialect.verified_against_hardware());
    let listing = device.run(vrf_dialect.list_command()).await.unwrap_or_default();
    let listing = run(vrf_dialect.list_command(), listing, &mut transcript);
    let vrfs = parse_vrf_list(&listing, vrf_dialect);
    println!("\nparsed: {} VRF(s)", vrfs.len());
    for v in &vrfs {
        println!(
            "  {} rd={} interfaces={:?}",
            v.name,
            v.route_distinguisher.as_deref().unwrap_or("-"),
            v.interfaces
        );
    }
    // An *empty* answer is not the command answering. A 2960CX with no VRF
    // support printed nothing at all for `show vrf`, and calling that a parser
    // bug sent the reader looking for one that was not there.
    if !rejected(&listing) && !listing.trim().is_empty() && vrfs.is_empty() {
        println!("  ** the command answered with content and the parser read nothing — that is a bug, not an empty device **");
    } else if listing.trim().is_empty() {
        println!("  (the device printed nothing — it has no VRFs, or does not support them)");
    }

    // One table, to prove the per-VRF read works at all.
    if let Some(first) = vrfs.first() {
        let command = vrf_dialect.table_command(&first.name);
        let table = device.run(&command).await.unwrap_or_default();
        let table = run(&command, table, &mut transcript);
        let routes = coreview_discover::vrftables::parse_vrf_table(&table);
        println!("\nparsed: {} route(s) in VRF {}", routes.len(), first.name);
        for r in routes.iter().take(8) {
            println!("  {} via {:?} {} [{}/{}]", r.prefix, r.next_hops, r.protocol,
                r.distance.unwrap_or(0), r.metric.unwrap_or(0));
        }
    }

    // ------------------------------------------------------------- overlay
    if let Some(dialect) = overlay_dialect {
        println!("\n== VXLAN / EVPN ({dialect:?}, verified = {})", dialect.verified_against_hardware());
        for command in dialect.commands() {
            let out = device.run(command).await.unwrap_or_default();
            let out = run(command, out, &mut transcript);
            if rejected(&out) {
                continue;
            }
            if command.contains("vni") {
                let s = parse_vni_table(&out);
                println!("\nparsed: {} segment(s)", s.len());
                for one in &s {
                    println!("  VNI {} vlan={:?} kind={:?}", one.vni, one.vlan, one.kind);
                }
            } else if command.contains("peer") || command.contains("vtep") || command.contains("end-point") {
                let p = parse_peers(&out);
                println!("\nparsed: {} peer(s)", p.len());
                for one in &p {
                    println!("  {} {:?}", one.address, one.state);
                }
            } else if command.contains("evpn") {
                let r = parse_evpn(&out);
                println!("\nparsed: {} EVPN route(s)", r.len());
                for one in r.iter().take(10) {
                    println!(
                        "  type {} mac={:?} address={:?} behind {:?}",
                        one.route_type, one.mac, one.address, one.next_hop
                    );
                }
            }
        }
    }

    device.close().await;
    if let Ok(path) = std::env::var("CV_LOG") {
        match std::fs::write(&path, &transcript) {
            Ok(()) => println!("\nok    session written to {path}"),
            Err(e) => println!("\nFAIL  could not write {path}: {e}"),
        }
    }
    println!(
        "\n== Compare what the device printed with what was parsed. If they agree, flip\n\
         \x20  `verified_against_hardware` for that dialect and name this device in the commit."
    );
}
