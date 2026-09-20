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

fn main() {
    let path = std::env::args().nth(1).expect("give a capture file");
    let text = std::fs::read_to_string(&path).expect("could not read it");
    println!("== {path}  ({} bytes)", text.len());

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
        let n = coreview_discover::fortios::parse_lldp_summary(out);
        println!("{command:<22} {} neighbour(s)", n.len());
        for one in &n {
            println!("                       - {} on {}", one.device_id, one.local_interface.as_deref().unwrap_or("?"));
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
