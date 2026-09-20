//! Runs Coreview's own parsers over a captured session and says what they
//! found.
//!
//! `interactive_shell` gets output off a device; this says whether we
//! understood it. The two together are how a claim like "we read a
//! FortiSwitch's MAC table" is checked rather than assumed — and how LT-332
//! was found, which was that we read exactly none of it.
//!
//! It takes a file, not a device, so a capture can be re-run against a changed
//! parser without going near the network again.
//!
//!     cargo run -p coreview-discover --example parse_capture -- /path/to/capture.log
//!
//! A second argument narrows it to one parser, for a capture whose command
//! echoes this cannot find — an operator's own session log, a backup, a paste
//! from somewhere else. Then the *whole file* is fed to that parser and
//! nothing else is tried:
//!
//!     cargo run -p coreview-discover --example parse_capture -- routes.txt nxos-routes
//!
//! `vni`, `peers`, `evpn`, `nve`, `vrf`, `vrfs`, `routes`. This is how LT-350 was
//! found: the operator could not give out the device, only what it printed.
//!
//! **What it prints stays where it is run.** A capture is somebody's network;
//! nothing it shows belongs in a commit, a fixture or a commit message
//! (D-027). What belongs in a fixture is the *shape*, retyped with invented
//! names and documentation addresses.

use std::collections::BTreeSet;

fn section<'a>(text: &'a str, command: &str) -> &'a str {
    // A transcript is one long stream; a command's output runs from the echo
    // of that command to the echo of the next one. Finding the echo is enough
    // — the prompt in front of it differs by device and by privilege level.
    let Some(start) = text.find(command) else {
        return "";
    };
    let rest = &text[start + command.len()..];
    // The next line that looks like a prompt with a command after it.
    let end = rest
        .lines()
        .scan(0usize, |at, line| {
            let here = *at;
            *at += line.len() + 1;
            Some((here, line))
        })
        .find(|(_, line)| line.contains(" # ") || line.contains(" $ "))
        .map(|(at, _)| at)
        .unwrap_or(rest.len());
    &rest[..end.min(rest.len())]
}

/// One parser, over the whole file.
///
/// The sweep below finds a command's output by its echo, which needs a
/// transcript. A capture that is only the output of one command has no echo to
/// find, and naming the parser is how that is read at all.
fn one(which: &str, text: &str) {
    use coreview_discover::overlay::{parse_evpn, parse_peers, parse_source_interface, parse_vni_table};
    use coreview_discover::routes::parse_routes;
    use coreview_discover::vrftables::{parse_vrf_list, VrfDialect};

    match which {
        "vni" => {
            let s = parse_vni_table(text);
            println!("{} segment(s)", s.len());
            for one in &s {
                println!("  VNI {} vlan={:?} kind={:?} vrf={:?}", one.vni, one.vlan, one.kind, one.vrf);
            }
        }
        "peers" => {
            let p = parse_peers(text);
            println!("{} peer(s)", p.len());
            for one in &p {
                println!("  {} {:?}", one.address, one.state);
            }
        }
        "evpn" => {
            let r = parse_evpn(text);
            println!("{} route(s)", r.len());
            for one in r.iter().take(40) {
                println!(
                    "  type {} vni={:?} mac={:?} address={:?} behind {:?}",
                    one.route_type, one.vni, one.mac, one.address, one.next_hop
                );
            }
            let mut by_type: std::collections::BTreeMap<u8, usize> = Default::default();
            for one in &r {
                *by_type.entry(one.route_type).or_default() += 1;
            }
            println!("by type: {by_type:?}");
        }
        "nve" => println!("source address: {:?}", parse_source_interface(text)),
        "vrfs" | "vrftables" => {
            let tables = coreview_discover::vrftables::parse_vrf_tables(text);
            println!("{} table(s)", tables.len());
            for (name, routes) in &tables {
                println!("  VRF {name}: {} route(s)", routes.len());
                for one in routes.iter().take(3) {
                    println!(
                        "    {} via {:?} {} nh-vrf={:?} segid={:?}",
                        one.prefix, one.next_hops, one.protocol, one.next_hop_vrf, one.segment_id
                    );
                }
            }
        }
        "vrf" => {
            let v = parse_vrf_list(text, VrfDialect::Cisco);
            println!("{} VRF(s)", v.len());
            for one in &v {
                println!("  {} rd={:?} interfaces={:?}", one.name, one.route_distinguisher, one.interfaces);
            }
        }
        "routes" => {
            let r = parse_routes(text);
            println!("{} route(s)", r.len());
            for one in r.iter().take(20) {
                println!(
                    "  {} via {:?} {} [{}/{}] iface={:?} nh-vrf={:?} segid={:?}",
                    one.prefix,
                    one.next_hops,
                    one.protocol,
                    one.distance.unwrap_or(0),
                    one.metric.unwrap_or(0),
                    one.interface,
                    one.next_hop_vrf,
                    one.segment_id
                );
            }
        }
        other => println!("no parser called `{other}` — try vni, peers, evpn, nve, vrf, vrfs, routes"),
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("give a capture file");
    let text = std::fs::read_to_string(&path).expect("could not read it");
    println!("== {path}  ({} bytes)", text.len());

    if let Some(which) = std::env::args().nth(2) {
        println!("== {} lines, parser `{which}`", text.lines().count());
        one(&which, &text);
        return;
    }

    let status = coreview_discover::fortios::parse_system_status(section(&text, "get system status"));
    if status.hostname.is_some() || status.model.is_some() {
        println!(
            "get system status      model {:?}  vdoms {}",
            status.model.as_deref().unwrap_or("?"),
            status.vdoms_enabled
        );
    }

    let arp = coreview_discover::arp::parse_arp_table(section(&text, "get system arp"));
    if !arp.is_empty() {
        println!("get system arp         {} entries", arp.len());
    }

    for command in [
        "get switch lldp neighbors-summary",
        "get switch lldp neighbors-detail",
    ] {
        let out = section(&text, command);
        if out.trim().is_empty() {
            continue;
        }
        let n = if command.ends_with("detail") {
            coreview_discover::fortios::parse_lldp_detail(out)
        } else {
            coreview_discover::fortios::parse_lldp_summary(out)
        };
        println!("{command:<22} {} neighbour(s)", n.len());
        for one in &n {
            println!(
                "                       - {} on {} -> {} chassis {} mgmt {}",
                one.device_id,
                one.local_interface.as_deref().unwrap_or("?"),
                one.remote_interface.as_deref().unwrap_or("?"),
                one.chassis_id.as_deref().unwrap_or("-"),
                one.addresses.first().map(|a| a.ip.as_str()).unwrap_or("-"),
            );
        }
    }

    let managed = coreview_discover::fortios::parse_managed_switches(section(
        &text,
        "show switch-controller managed-switch",
    ));
    if !managed.is_empty() {
        println!("managed switches       {}", managed.len());
    }

    let aps = coreview_discover::fortios::parse_wtp_status(section(
        &text,
        "get wireless-controller wtp-status",
    ));
    if !aps.is_empty() {
        println!("wireless-controller    {} access point(s)", aps.len());
    }

    let store = coreview_discover::fortios::parse_device_store(section(
        &text,
        "diagnose user-device-store device memory list",
    ));
    let leases = coreview_discover::fortios::parse_dhcp_leases(section(&text, "execute dhcp lease-list"));
    if !store.is_empty() || !leases.is_empty() {
        println!("device store           {} endpoint(s)", store.len());
        println!("dhcp lease-list        {} endpoint(s)", leases.len());
        let wireless = leases.iter().filter(|e| e.fortiap_ssid.is_some()).count();
        println!("                       {wireless} of them wireless (an SSID is named)");
    }

    // The two MAC-table shapes. A device speaks one of them, and a parser that
    // reads none of what it was given is the failure this example exists to
    // make visible.
    for (command, entries) in [
        (
            "show mac address-table",
            coreview_discover::mac_table::parse_mac_table(section(&text, "show mac address-table")),
        ),
        (
            "diagnose switch mac-address list",
            coreview_discover::mac_table::parse_mac_table(section(
                &text,
                "diagnose switch mac-address list",
            )),
        ),
    ] {
        let out = section(&text, command);
        if out.trim().is_empty() {
            continue;
        }
        let distinct: BTreeSet<&str> = entries.iter().map(|e| e.mac.as_str()).collect();
        println!(
            "{command:<22} {} lines in, {} entries out, {} distinct MACs",
            out.lines().count(),
            entries.len(),
            distinct.len()
        );
        let mut ports: Vec<(String, usize)> =
            coreview_discover::mac_table::count_by_port(&entries).into_iter().collect();
        ports.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        for (port, n) in ports.iter().take(6) {
            println!("                       {port}: {n}");
        }
    }

    // Commands a least-privilege account is refused. Knowing it was refused is
    // the difference between "this device has no endpoints" and "this account
    // may not ask" (LT-332).
    let mut refused = Vec::new();
    for line in text.lines() {
        if coreview_discover::fortios::rejected_command(line) {
            refused.push(line.trim());
        }
    }
    println!(
        "refusals recognised    {} ({})",
        refused.len(),
        if refused.is_empty() { "none seen" } else { "see above" }
    );
}
