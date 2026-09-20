//! Where each MAC was learned, from `show mac address-table`.
//!
//! Discovery protocols only see devices that speak them. A printer, a camera
//! or a workstation announces nothing, and on a real diagram those are most of
//! what is plugged in. The switch knows they are there: it learned their MAC
//! on a port, and its ARP table maps that MAC to an address.
//!
//! This is observation, not inference. "This MAC was seen on Gi0/7" is a fact
//! the switch reports; what the device *is* stays unknown, and the OUI lookup
//! names its maker rather than guessing a role.
//!
//! The fixtures below are from a real Catalyst 2960CX and a real FortiSwitch
//! 224E, with the MACs reduced to their vendor OUI and a counter (D-027).

use crate::arp::normalise_mac;

/// One learned address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacEntry {
    /// Twelve lowercase hex digits.
    pub mac: String,
    /// The port it was learned on, as the switch writes it.
    pub port: String,
    pub vlan: Option<String>,
}

/// Ports that are not a physical interface, and entries that are not a device.
fn is_real_port(port: &str) -> bool {
    let p = port.trim();
    !p.is_empty()
        && !p.eq_ignore_ascii_case("CPU")
        && !p.eq_ignore_ascii_case("Switch")
        && !p.eq_ignore_ascii_case("Router")
        && !p.eq_ignore_ascii_case("n/a")
        // LT-332: a FortiSwitch's CPU port. It carries the switch's own
        // address once per VLAN and nothing that is plugged into anything.
        && !p.eq_ignore_ascii_case("internal")
        && !p.starts_with("Drop")
}

/// Reads a MAC address table, keeping only dynamically learned entries.
///
/// Static entries are the switch's own multicast and protocol addresses —
/// 0180.c200.0000 and friends, all pointing at the CPU — and are not devices
/// on a diagram.
///
/// **Two shapes, told apart by looking** (LT-332). Cisco writes one line per
/// entry with the word `DYNAMIC` in it; FortiOS writes two, and puts the flag
/// on the second. The caller should not have to know which device it asked, so
/// this decides. Reading the FortiSwitch shape with the Cisco rules produced
/// nothing at all from 12,499 lines of real output, silently, which is how
/// this went unnoticed.
pub fn parse_mac_table(out: &str) -> Vec<MacEntry> {
    if out.contains("MAC:") && out.contains("Flags:") {
        return parse_fortiswitch_mac_table(out);
    }
    let mut found = Vec::new();
    for line in out.lines() {
        let upper = line.to_ascii_uppercase();
        if !upper.contains("DYNAMIC") {
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        // Column order differs between platforms, so each field is found by
        // what it looks like rather than by position.
        let mac = tokens.iter().find_map(|t| normalise_mac(t));
        let Some(mac) = mac else { continue };
        // The port is the last token that is not the type word.
        let port = tokens
            .iter()
            .rev()
            .find(|t| !t.eq_ignore_ascii_case("DYNAMIC"))
            .map(|t| t.trim().to_string());
        let Some(port) = port.filter(|p| is_real_port(p) && normalise_mac(p).is_none()) else {
            continue;
        };
        let vlan = tokens
            .first()
            .filter(|t| t.chars().all(|c| c.is_ascii_digit()))
            .map(|t| t.to_string());
        found.push(MacEntry { mac, port, vlan });
    }
    found
}

/// Reads `diagnose switch mac-address list` from a FortiSwitch.
///
/// The shape, verbatim:
///
/// ```text
/// MAC: cc:7f:75:00:00:01   VLAN: 499 Port: port24(port-id 24)
///   Flags: 0x00010441 [ hit dynamic src-hit native ]
/// ```
///
/// Two lines, and the one that says whether this is a device is the second —
/// which is exactly why the Cisco rules read none of it.
///
/// **`internal` is thrown away**, and it is most of the table. A 224E reports
/// its own address on the `internal` CPU port once per VLAN: 4,094 of the
/// 4,163 entries on the lab switch, none of them a device. What is left is
/// about thirty real endpoints on the physical ports.
pub fn parse_fortiswitch_mac_table(out: &str) -> Vec<MacEntry> {
    let mut found = Vec::new();
    let mut lines = out.lines().peekable();
    while let Some(line) = lines.next() {
        let trimmed = line.trim_start();
        let Some(rest) = trimmed.strip_prefix("MAC:") else {
            continue;
        };
        // `MAC: <mac>\tVLAN: <n> Port: <name>(port-id <n>)`
        let mut fields = rest.split_whitespace();
        let Some(mac) = fields.next().and_then(normalise_mac) else {
            continue;
        };
        let mut vlan = None;
        let mut port = None;
        let mut want: Option<&str> = None;
        for token in fields {
            match want.take() {
                Some("vlan") => vlan = Some(token.to_string()),
                Some("port") => {
                    // `port24(port-id 24)` — the name is what comes before the
                    // bracket; the port-id is the switch's own numbering and
                    // is not what anything else refers to a port by.
                    port = Some(token.split('(').next().unwrap_or(token).to_string());
                }
                _ => {}
            }
            match token {
                "VLAN:" => want = Some("vlan"),
                "Port:" => want = Some("port"),
                _ => {}
            }
        }
        let Some(port) = port.filter(|p| is_real_port(p)) else {
            continue;
        };
        // The flags are on the next line, and they are the whole test.
        let flags = lines.peek().map(|l| l.to_ascii_lowercase()).unwrap_or_default();
        if !flags.contains("flags:") || !flags.contains("dynamic") {
            continue;
        }
        found.push(MacEntry { mac, port, vlan });
    }
    found
}

/// How many distinct MACs each port has learned.
///
/// A port with one is something plugged in. A port with twenty is a link to
/// another switch, whether or not that switch runs a discovery protocol.
pub fn count_by_port(entries: &[MacEntry]) -> std::collections::HashMap<String, usize> {
    let mut counts: std::collections::HashMap<String, std::collections::HashSet<&str>> =
        Default::default();
    for e in entries {
        counts.entry(e.port.clone()).or_default().insert(&e.mac);
    }
    counts.into_iter().map(|(k, v)| (k, v.len())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim from a Catalyst 2960CX, trimmed to the interesting rows.
    const IOS: &str = r#"
          Mac Address Table
-------------------------------------------

Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
 All    0100.0ccc.cccc    STATIC      CPU
 All    0180.c200.0000    STATIC      CPU
   1    000c.2900.0001    DYNAMIC     Gi0/9
   1    7456.3c00.0001    DYNAMIC     Gi0/7
   1    74ac.b900.0005    DYNAMIC     Gi0/1
   1    e81c.ba00.0002    DYNAMIC     Gi0/9
  14    04f7.7800.0001    DYNAMIC     Gi0/1
Total Mac Addresses for this criterion: 7
"#;

    #[test]
    fn keeps_only_what_was_actually_learned() {
        let e = parse_mac_table(IOS);
        assert_eq!(e.len(), 5, "{e:?}");
        // The switch's own protocol addresses point at the CPU and are not
        // devices on anyone's diagram.
        assert!(!e.iter().any(|x| x.port.eq_ignore_ascii_case("CPU")));
        assert!(!e.iter().any(|x| x.mac.starts_with("0180c2")));
    }

    #[test]
    fn finds_the_port_a_silent_device_is_on() {
        // 7456.3c00.0001 is the workstation the switch sees on Gi0/7 and that
        // announces nothing about itself.
        let e = parse_mac_table(IOS);
        let w = e.iter().find(|x| x.mac == "74563c000001").expect("the workstation");
        assert_eq!(w.port, "Gi0/7");
        assert_eq!(w.vlan.as_deref(), Some("1"));
    }

    #[test]
    fn counts_what_is_behind_each_port() {
        // Gi0/9 has two, which is how an uplink looks even when the switch on
        // the far end says nothing.
        let counts = count_by_port(&parse_mac_table(IOS));
        assert_eq!(counts.get("Gi0/9"), Some(&2));
        assert_eq!(counts.get("Gi0/7"), Some(&1));
        assert_eq!(counts.get("Gi0/1"), Some(&2));
    }

    /// From a FortiSwitch 224E, trimmed to the interesting rows. The MACs are
    /// their real vendor OUI with the device part replaced (D-027).
    const FORTISWITCH: &str = r#"
flag bit pattern: 0x00000000
vlan map: 0-4094
port-id map: 0-29

MAC: e8:1c:ba:00:00:01	VLAN: 2178 Port: internal(port-id 29)
  Flags: 0x00000020 [ static ]

MAC: e8:1c:ba:00:00:01	VLAN: 2399 Port: internal(port-id 29)
  Flags: 0x00000020 [ static ]

MAC: cc:7f:75:00:00:01	VLAN: 499 Port: port24(port-id 24)
  Flags: 0x00010441 [ hit dynamic src-hit native ]

MAC: 08:c2:24:00:00:02	VLAN: 14 Port: port24(port-id 24)
  Flags: 0x00010441 [ hit dynamic src-hit native ]

MAC: bc:24:11:00:00:03	VLAN: 1 Port: port13(port-id 13)
  Flags: 0x00010441 [ hit dynamic src-hit native ]
"#;

    #[test]
    fn a_fortiswitch_table_is_read_at_all() {
        // It was not. 12,499 lines of real output produced zero entries,
        // because the Cisco rules want the word DYNAMIC on the same line and
        // FortiOS puts it on the next one (LT-332).
        let e = parse_mac_table(FORTISWITCH);
        assert_eq!(e.len(), 3, "{e:?}");
    }

    #[test]
    fn the_switchs_own_address_on_its_cpu_port_is_not_a_device() {
        // `internal` is 4,094 of the 4,163 entries on the lab switch: the
        // switch's own MAC, once per VLAN. None of it is plugged into anything.
        let e = parse_mac_table(FORTISWITCH);
        assert!(!e.iter().any(|x| x.port == "internal"), "{e:?}");
        assert!(!e.iter().any(|x| x.mac == "e81cba000001"), "{e:?}");
    }

    #[test]
    fn the_port_name_is_kept_and_the_port_id_is_not() {
        // `port24(port-id 24)` — the bracketed number is the switch's own
        // numbering, and nothing else in the crawl refers to a port by it.
        let e = parse_mac_table(FORTISWITCH);
        let uplink = e.iter().find(|x| x.mac == "cc7f75000001").expect("the uplink neighbour");
        assert_eq!(uplink.port, "port24");
        assert_eq!(uplink.vlan.as_deref(), Some("499"));
    }

    #[test]
    fn an_uplink_shows_as_an_uplink_on_a_fortiswitch_too() {
        let counts = count_by_port(&parse_mac_table(FORTISWITCH));
        assert_eq!(counts.get("port24"), Some(&2));
        assert_eq!(counts.get("port13"), Some(&1));
        assert_eq!(counts.get("internal"), None);
    }

    #[test]
    fn a_header_or_an_empty_table_yields_nothing() {
        assert!(parse_mac_table("Vlan    Mac Address       Type        Ports").is_empty());
        assert!(parse_mac_table("").is_empty());
        // A table with only static entries is not a table of devices.
        assert!(parse_mac_table(" All    0100.0ccc.cccc    STATIC      CPU").is_empty());
        // And the same for the other shape.
        assert!(parse_mac_table("MAC: e8:1c:ba:00:00:01\tVLAN: 1 Port: port1(port-id 1)\n  Flags: 0x20 [ static ]").is_empty());
    }
}
