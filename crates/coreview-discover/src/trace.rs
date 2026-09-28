//! A measured path: the device's own traceroute, and the ECMP leg the device
//! itself hashes a flow onto (LT-477, LT-478).
//!
//! The path engine on the page (LT-346) is *calculated* from routing tables
//! and says so. This is the other half: what the network actually did when a
//! device sent probes, and which equal-cost leg a device's own hash picks for
//! a given flow. Neither is inferred here; both are the device's answer, and
//! a device that has no such command is reported as one rather than guessed.
//!
//! **Built from the vendors' documentation and posted sessions, not from a
//! device (D-058).** The lab's IOS was not available when this was written,
//! so even the Cisco layout is reconstructed rather than captured; the
//! fixtures say so and [`verified_against_hardware`] answers `false`.
//!
//! Only an IPv4 address ever reaches a command line: it is parsed first and
//! written back from the parsed value, exactly as `pathcheck` does.

use std::net::Ipv4Addr;

use crate::dialect::Family;

/// D-058: no layout below has met a device.
pub fn verified_against_hardware() -> bool {
    false
}

/// One hop of a traceroute as the device printed it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceHop {
    pub ttl: u32,
    /// The address that answered, or `None` where every probe timed out.
    pub address: Option<String>,
    /// Round-trip times, one per probe that answered.
    pub rtts_ms: Vec<f32>,
}

/// The traceroute command for a platform, or `None` where the platform has
/// no traceroute this reads — Gaia's clish, RouterOS's live tool, AireOS.
pub fn traceroute_command(family: Family, target: Ipv4Addr) -> Option<String> {
    use Family::*;
    Some(match family {
        Junos => format!("traceroute {target} no-resolve wait 2"),
        FortiOs => format!("execute traceroute {target}"),
        PanOs => format!("traceroute host {target}"),
        Comware | HuaweiVrp => format!("tracert {target}"),
        // LT-489, LT-493: Linux's own, numeric, in the layout read below.
        Cumulus | Sonic => format!("traceroute -n {target}"),
        Gaia | RouterOs | AireOs => return None,
        CiscoIos | CiscoNxOs | AristaEos | ArubaOsSwitch | ArubaOsCx | Dell | CiscoAsa | Vyatta | ArubaController | Generic => format!("traceroute {target}"),
    })
}

/// Reads a traceroute in either layout:
///
/// ```text
///   1 192.168.12.2 1 msec 0 msec 0 msec
///   2 10.255.2.1 2 msec 1 msec 1 msec
///   3  *  *  *
///   4 10.40.50.9 3 msec *  2 msec
/// ```
///
/// ```text
///  1  192.168.12.2 (192.168.12.2)  1.234 ms  1.100 ms  0.900 ms
///  2  * * *
///  3  10.40.50.9  3.0 ms  2.8 ms  2.9 ms
/// ```
///
/// A line is a hop when it starts with a number; the address is the first
/// IPv4 address after it, the times every number followed by `ms` or `msec`.
pub fn parse_traceroute(output: &str) -> Vec<TraceHop> {
    let mut hops = Vec::new();
    for line in output.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        let Some(ttl) = f.first().and_then(|w| w.parse::<u32>().ok()) else { continue };
        if f.len() < 2 || ttl == 0 || ttl > 255 {
            continue;
        }
        let address = f[1..].iter().find_map(|w| w.trim_matches(['(', ')', ',']).parse::<Ipv4Addr>().ok()).map(|a| a.to_string());
        let mut rtts = Vec::new();
        for (i, w) in f.iter().enumerate() {
            let unit = w.eq_ignore_ascii_case("ms") || w.eq_ignore_ascii_case("msec");
            if unit && i > 0 {
                if let Ok(v) = f[i - 1].parse::<f32>() {
                    rtts.push(v);
                }
            } else if let Some(v) = w.strip_suffix("ms").and_then(|n| n.parse::<f32>().ok()) {
                rtts.push(v);
            }
        }
        // A hop that neither answered nor timed out is not a hop: a stray
        // numbered line in a banner.
        if address.is_none() && !f[1..].contains(&"*") {
            continue;
        }
        hops.push(TraceHop { ttl, address, rtts_ms: rtts });
    }
    hops
}

/// Which leg of an equal-cost route a device hashes one flow onto, as the
/// device itself reports it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EcmpLeg {
    pub next_hop: String,
    pub interface: Option<String>,
}

/// The command that asks a device for its own hash decision, where one
/// exists: NX-OS `show routing hash`, IOS and IOS-XE `show ip cef exact-route`.
pub fn ecmp_command(family: Family, source: Ipv4Addr, destination: Ipv4Addr, protocol: Option<u8>, ports: Option<(u16, u16)>) -> Option<String> {
    match family {
        Family::CiscoNxOs => {
            let mut c = format!("show routing hash {source} {destination}");
            if let Some(p) = protocol {
                c.push_str(&format!(" ip-proto {p}"));
            }
            if let Some((s, d)) = ports {
                c.push_str(&format!(" {s} {d}"));
            }
            Some(c)
        }
        Family::CiscoIos => Some(format!("show ip cef exact-route {source} {destination}")),
        _ => None,
    }
}

/// Reads either answer:
///
/// ```text
/// Hashing to path *10.0.0.1 (Ethernet1/1)
/// ```
///
/// ```text
/// 10.1.1.1 -> 10.2.2.2 => IP adj out of GigabitEthernet0/1, addr 10.0.0.1
/// ```
pub fn parse_ecmp_leg(output: &str) -> Option<EcmpLeg> {
    for line in output.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("Hashing to path") {
            let words: Vec<&str> = rest.split_whitespace().collect();
            let hop = words.iter().find_map(|w| w.trim_matches(['*', '(', ')', ',']).parse::<Ipv4Addr>().ok())?;
            let interface = words.iter().find(|w| w.trim_matches(['(', ')']).chars().any(|c| c.is_ascii_alphabetic())).map(|w| w.trim_matches(['(', ')']).to_string());
            return Some(EcmpLeg { next_hop: hop.to_string(), interface });
        }
        if t.contains("=>") {
            let after = t.split("=>").nth(1)?;
            let interface = after.split("out of").nth(1).and_then(|s| s.split([',', ' ']).find(|w| !w.is_empty())).map(str::to_string);
            let hop = after.split("addr").nth(1).and_then(|s| s.split_whitespace().next()).and_then(|w| w.parse::<Ipv4Addr>().ok())?;
            return Some(EcmpLeg { next_hop: hop.to_string(), interface });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reconstructed from Cisco's and Juniper's documentation (D-058), not captured.
    const CISCO: &str = "Type escape sequence to abort.\nTracing the route to 10.40.50.9\nVRF info: (vrf in name/id, vrf out name/id)\n  1 192.168.12.2 1 msec 0 msec 0 msec\n  2 10.255.2.1 2 msec 1 msec 1 msec\n  3  *  *  *\n  4 10.40.50.9 3 msec *  2 msec\n";
    const LINUX: &str = "traceroute to 10.40.50.9 (10.40.50.9), 30 hops max, 40 byte packets\n 1  192.168.12.2 (192.168.12.2)  1.234 ms  1.100 ms  0.900 ms\n 2  * * *\n 3  10.40.50.9  3.0 ms  2.8 ms  2.9 ms\n";

    #[test]
    fn both_layouts_read_hop_by_hop_and_a_silent_hop_is_kept() {
        let c = parse_traceroute(CISCO);
        assert_eq!(c.iter().map(|h| (h.ttl, h.address.as_deref(), h.rtts_ms.len())).collect::<Vec<_>>(), [(1, Some("192.168.12.2"), 3), (2, Some("10.255.2.1"), 3), (3, None, 0), (4, Some("10.40.50.9"), 2)]);
        let l = parse_traceroute(LINUX);
        assert_eq!(l.iter().map(|h| (h.ttl, h.address.as_deref(), h.rtts_ms.len())).collect::<Vec<_>>(), [(1, Some("192.168.12.2"), 3), (2, None, 0), (3, Some("10.40.50.9"), 3)]);
        assert_eq!(l[0].rtts_ms, [1.234, 1.1, 0.9]);
        assert!(parse_traceroute("% Invalid input detected at '^' marker.").is_empty());
        assert!(!verified_against_hardware());
    }

    #[test]
    fn the_command_is_the_platforms_own_and_never_more_than_an_address() {
        let ip: Ipv4Addr = "10.40.50.9".parse().unwrap();
        assert_eq!(traceroute_command(Family::CiscoIos, ip).as_deref(), Some("traceroute 10.40.50.9"));
        assert_eq!(traceroute_command(Family::Junos, ip).as_deref(), Some("traceroute 10.40.50.9 no-resolve wait 2"));
        assert_eq!(traceroute_command(Family::FortiOs, ip).as_deref(), Some("execute traceroute 10.40.50.9"));
        assert_eq!(traceroute_command(Family::PanOs, ip).as_deref(), Some("traceroute host 10.40.50.9"));
        assert_eq!(traceroute_command(Family::Comware, ip).as_deref(), Some("tracert 10.40.50.9"));
        assert_eq!(traceroute_command(Family::Gaia, ip), None);
        assert_eq!(traceroute_command(Family::RouterOs, ip), None);
    }

    #[test]
    fn the_ecmp_leg_is_read_from_either_answer() {
        let nxos = "Load-share parameters used for software forwarding:\nload-share mode: address source-destination port source-destination\nUniversal-id seed: 0x3a8f2c1d\nHash for VRF \"default\"\nHashing to path *10.0.0.1 (Ethernet1/1)\n For route:\n10.20.0.0/16, ubest/mbest: 2/0\n    *via 10.0.0.1, Eth1/1, [110/41], 3d04h, ospf-1, intra\n    *via 10.0.0.5, Eth1/2, [110/41], 3d04h, ospf-1, intra\n";
        assert_eq!(parse_ecmp_leg(nxos), Some(EcmpLeg { next_hop: "10.0.0.1".into(), interface: Some("Ethernet1/1".into()) }));
        let ios = "10.1.1.1 -> 10.2.2.2 => IP adj out of GigabitEthernet0/1, addr 10.0.0.1\n";
        assert_eq!(parse_ecmp_leg(ios), Some(EcmpLeg { next_hop: "10.0.0.1".into(), interface: Some("GigabitEthernet0/1".into()) }));
        assert_eq!(parse_ecmp_leg("% Invalid input"), None);
        let (s, d): (Ipv4Addr, Ipv4Addr) = ("10.1.1.1".parse().unwrap(), "10.2.2.2".parse().unwrap());
        assert_eq!(ecmp_command(Family::CiscoNxOs, s, d, Some(6), Some((51000, 443))).as_deref(), Some("show routing hash 10.1.1.1 10.2.2.2 ip-proto 6 51000 443"));
        assert_eq!(ecmp_command(Family::CiscoIos, s, d, None, None).as_deref(), Some("show ip cef exact-route 10.1.1.1 10.2.2.2"));
        assert_eq!(ecmp_command(Family::Junos, s, d, None, None), None);
    }
}
