//! MikroTik RouterOS identity and tables, v6 and v7 (LT-473).
//!
//! **Built from MikroTik's documentation and posted sessions, not from a
//! router (D-058).** Fixtures reconstructed; [`verified_against_hardware`]
//! says `false` until one is a capture.
//!
//! RouterOS pages in an interactive terminal, so every listing is asked
//! `without-paging` and nothing is sent to turn paging off.
//!
//! - `/system resource print` — `board-name:`, `platform: MikroTik`,
//!   `version:`: the banner the family is read from.
//! - `/system routerboard print` — `model:` and `serial-number:`.
//! - `/ip address print without-paging` — `# ADDRESS NETWORK INTERFACE`.
//! - `/ip neighbor print detail without-paging` — one `key=value` line per
//!   neighbour: LLDP, CDP and MNDP in one table.
//! - `/ip arp print without-paging` — read by the ordinary ARP reader.
//! - `/interface bridge host print without-paging` — the learned MACs.
//! - `/ip route print without-paging` — in the v6 and the v7 layouts,
//!   reached through `routes::parse_routes` by shape.
//!
//! The prompt is `[user@host] >`.

use crate::arp::normalise_mac;
use crate::cdp::short_name;
use crate::interfaces::Interface;
use crate::mac_table::MacEntry;
use crate::routes::Route;
use crate::types::{DeviceAddress, Neighbor, Protocol};

/// D-058: this platform has not met a device.
pub fn verified_against_hardware() -> bool {
    false
}

fn labelled<'a>(out: &'a str, label: &str) -> Option<&'a str> {
    out.lines().find_map(|l| {
        let (k, v) = l.trim().split_once(':')?;
        k.trim().eq_ignore_ascii_case(label).then(|| v.trim()).filter(|v| !v.is_empty())
    })
}

/// `model: RB5009UG+S+` from the routerboard listing, or `board-name:` from
/// the resource listing on a CHR, which has no routerboard.
pub fn model_of(routerboard: &str, resource: &str) -> Option<String> {
    labelled(routerboard, "model").or_else(|| labelled(resource, "board-name")).map(|m| m.to_ascii_uppercase())
}

/// `serial-number: ABC123DEF456`.
pub fn serials_of(routerboard: &str) -> Vec<String> {
    labelled(routerboard, "serial-number").map(|s| vec![s.to_string()]).unwrap_or_default()
}

/// `/ip address print without-paging`.
///
/// ```text
/// Flags: X - disabled, I - invalid, D - dynamic
///  #   ADDRESS            NETWORK         INTERFACE
///  0   10.0.0.1/24        10.0.0.0        ether2
///  1 D 203.0.113.2/24     203.0.113.0     ether1
/// ```
pub fn parse_ip_address(out: &str) -> Vec<Interface> {
    let mut found = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        let Some(at) = f.iter().position(|w| w.contains('/') && w.split('/').next().is_some_and(|a| a.parse::<std::net::Ipv4Addr>().is_ok())) else { continue };
        let Some(interface) = f.get(at + 2) else { continue };
        let disabled = f[..at].iter().any(|w| w.contains('X'));
        found.push(Interface { name: interface.to_string(), address: f[at].split('/').next().map(str::to_string), up: !disabled });
    }
    found
}

/// The `key=value` pairs of one detail line, with quoted values unquoted.
fn pairs(line: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = line.trim();
    while let Some(eq) = rest.find('=') {
        let key = rest[..eq].split_whitespace().last().unwrap_or("").to_string();
        let after = &rest[eq + 1..];
        let (value, next) = if let Some(inner) = after.strip_prefix('"') {
            match inner.find('"') {
                Some(end) => (inner[..end].to_string(), &inner[end + 1..]),
                None => (inner.to_string(), ""),
            }
        } else {
            match after.find(' ') {
                Some(end) => (after[..end].to_string(), &after[end..]),
                None => (after.to_string(), ""),
            }
        };
        out.push((key, value));
        rest = next;
    }
    out
}

/// `/ip neighbor print detail without-paging`.
///
/// ```text
///  0 interface=ether2 address=10.0.0.2 mac-address=00:1C:73:AA:BB:CC identity="leaf1"
///    platform="Arista" version="EOS 4.28.0F" board=DCS-7050 interface-name="Ethernet3"
///    system-caps=bridge,router discovered-by=lldp
///
///  1 interface=ether3 address=10.0.0.3 mac-address=00:50:56:AA:BB:CC identity="edge-2"
///    platform="MikroTik" version="7.14.3 (stable)" board=RB5009UG+S+ discovered-by=mndp
/// ```
///
/// An entry runs until a blank line; the continuation lines are joined.
pub fn parse_neighbors(out: &str) -> Vec<Neighbor> {
    let mut entries: Vec<String> = Vec::new();
    for line in out.lines() {
        let t = line.trim_end();
        if t.trim().is_empty() {
            continue;
        }
        let starts = t.split_whitespace().next().is_some_and(|w| w.chars().all(|c| c.is_ascii_digit()));
        if starts || entries.is_empty() {
            entries.push(t.trim().to_string());
        } else if let Some(last) = entries.last_mut() {
            last.push(' ');
            last.push_str(t.trim());
        }
    }
    entries
        .iter()
        .filter_map(|e| {
            let kv = pairs(e);
            let get = |k: &str| kv.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone()).filter(|v| !v.is_empty());
            let identity = get("identity");
            let mac = get("mac-address").and_then(|m| normalise_mac(&m));
            let device_id = identity.or_else(|| get("mac-address"))?;
            let discovered_by = match get("discovered-by").as_deref() {
                Some(d) if d.contains("cdp") => Protocol::Cdp,
                _ => Protocol::Lldp,
            };
            let addresses = get("address").filter(|a| a.parse::<std::net::IpAddr>().is_ok()).map(|ip| vec![DeviceAddress { ip, interface: None, is_management: true }]).unwrap_or_default();
            let capabilities: Vec<String> = get("system-caps").map(|c| c.split(',').map(|s| s.trim().to_string()).collect()).unwrap_or_default();
            let platform = get("board").or_else(|| get("platform"));
            Some(Neighbor {
                serial: None,
                short_name: short_name(&device_id),
                device_id,
                addresses,
                local_interface: get("interface"),
                remote_interface: get("interface-name"),
                class: crate::classify::classify(platform.as_deref(), &capabilities, get("version").as_deref()),
                platform,
                capabilities,
                version: get("version"),
                discovered_by,
                vendor: mac.as_deref().and_then(crate::oui::vendor).map(str::to_string),
                chassis_id: mac,
            })
        })
        .collect()
}

/// `/interface bridge host print without-paging`.
///
/// ```text
/// Flags: X - disabled, I - invalid, D - dynamic, L - local, E - external
///  #   MAC-ADDRESS        VID ON-INTERFACE   BRIDGE
///  0 D 00:50:56:AA:BB:CC    1 ether3         bridge1
///  1 DL 00:00:5E:00:53:01   1 bridge1        bridge1
/// ```
///
/// A local entry is the bridge's own address and is not a device.
pub fn parse_bridge_hosts(out: &str) -> Vec<MacEntry> {
    let mut found = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        let Some(at) = f.iter().position(|w| w.contains(':') && normalise_mac(w).is_some()) else { continue };
        if f[..at].iter().any(|w| w.contains('L')) {
            continue;
        }
        let Some(mac) = normalise_mac(f[at]) else { continue };
        let vlan = f.get(at + 1).filter(|w| w.chars().all(|c| c.is_ascii_digit())).map(|w| w.to_string());
        let Some(port) = f.get(at + if vlan.is_some() { 2 } else { 1 }) else { continue };
        found.push(MacEntry { mac, port: port.to_string(), vlan });
    }
    found
}

/// Whether a routing table is RouterOS's, by its header.
pub fn is_route_table(out: &str) -> bool {
    out.contains("DST-ADDRESS")
}

/// `/ip route print without-paging`, v7 and v6.
///
/// ```text
/// Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC, o - OSPF
/// Columns: DST-ADDRESS, GATEWAY, DISTANCE
/// #     DST-ADDRESS      GATEWAY       DISTANCE
/// 0  As 0.0.0.0/0        203.0.113.1          1
/// 1 DAc 10.0.0.0/24      ether2               0
/// ```
///
/// ```text
/// Flags: X - disabled, A - active, D - dynamic, C - connect, S - static, r - rip, b - bgp, o - ospf
///  #      DST-ADDRESS        PREF-SRC        GATEWAY            DISTANCE
///  0 A S  0.0.0.0/0                          203.0.113.1               1
///  1 ADC  10.0.0.0/24        10.0.0.1        ether2                    0
/// ```
///
/// The flags are the letters before the prefix; the distance the number at
/// the end; the gateway the last address between them (v6 prints the
/// preferred source before it). A connected route has no next hop.
pub fn parse_routes(out: &str) -> Vec<Route> {
    let mut routes = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        let Some(at) = f.iter().position(|w| w.split_once('/').is_some_and(|(a, b)| a.parse::<std::net::IpAddr>().is_ok() && b.parse::<u8>().is_ok())) else { continue };
        if at == 0 || !f[0].chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let flags: String = f[1..at].concat();
        if flags.contains('X') {
            continue;
        }
        let (network, bits) = f[at].split_once('/').unwrap();
        let addr: std::net::IpAddr = network.parse().unwrap();
        let protocol = if flags.contains('c') || flags.contains('C') {
            "connected"
        } else if flags.contains('s') || flags.contains('S') {
            "static"
        } else if flags.contains('o') {
            "ospf"
        } else if flags.contains('b') {
            "bgp"
        } else if flags.contains('r') {
            "rip"
        } else {
            "unknown"
        };
        let tail = &f[at + 1..];
        let distance = tail.last().and_then(|w| w.parse::<u32>().ok());
        let body = if distance.is_some() { &tail[..tail.len() - 1] } else { tail };
        let hop = body.iter().rev().find(|w| w.parse::<std::net::IpAddr>().is_ok()).map(|w| w.to_string());
        let interface = body.iter().find(|w| w.parse::<std::net::IpAddr>().is_err() && w.chars().any(|c| c.is_ascii_alphabetic())).map(|w| w.to_string());
        routes.push(Route {
            family: if addr.is_ipv4() { 4 } else { 6 },
            prefix: format!("{addr}/{bits}"),
            code: flags.clone(),
            protocol: protocol.to_string(),
            next_hops: if protocol == "connected" { Vec::new() } else { hop.into_iter().collect() },
            interface,
            distance,
            metric: None,
            next_hop_vrf: None,
            segment_id: None,
        });
    }
    routes
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reconstructed from MikroTik's documentation (D-058), not captured.
    const RESOURCE: &str = "  uptime: 1w2d3h4m5s\n  version: 7.14.3 (stable)\n  build-time: 2024-04-17 13:15:54\n  factory-software: 7.1\n  free-memory: 800.0MiB\n  total-memory: 1024.0MiB\n  cpu: ARM64\n  cpu-count: 4\n  board-name: RB5009UG+S+\n  platform: MikroTik\n";
    const ROUTERBOARD: &str = "  routerboard: yes\n  model: RB5009UG+S+\n  serial-number: ABC123DEF456\n  firmware-type: 88f7040\n  current-firmware: 7.14.3\n";
    const ADDRESSES: &str = "Flags: X - disabled, I - invalid, D - dynamic\n #   ADDRESS            NETWORK         INTERFACE\n 0   10.0.0.1/24        10.0.0.0        ether2\n 1 D 203.0.113.2/24     203.0.113.0     ether1\n 2 X 192.168.9.1/24     192.168.9.0     ether5\n";
    const NEIGHBORS: &str = " 0 interface=ether2 address=10.0.0.2 mac-address=00:1C:73:AA:BB:CC identity=\"leaf1\"\n   platform=\"Arista\" version=\"EOS 4.28.0F\" board=DCS-7050 interface-name=\"Ethernet3\"\n   system-caps=bridge,router discovered-by=lldp\n\n 1 interface=ether3 address=10.0.0.3 mac-address=00:50:56:AA:BB:CC identity=\"edge-2\"\n   platform=\"MikroTik\" version=\"7.14.3 (stable)\" board=RB5009UG+S+ discovered-by=mndp\n";
    const HOSTS: &str = "Flags: X - disabled, I - invalid, D - dynamic, L - local, E - external\n #   MAC-ADDRESS        VID ON-INTERFACE   BRIDGE\n 0 D 00:50:56:AA:BB:CC    1 ether3         bridge1\n 1 DL 00:00:5E:00:53:01   1 bridge1        bridge1\n";
    const ROUTES_V7: &str = "Flags: D - DYNAMIC; A - ACTIVE; c - CONNECT, s - STATIC, o - OSPF\nColumns: DST-ADDRESS, GATEWAY, DISTANCE\n#     DST-ADDRESS      GATEWAY       DISTANCE\n0  As 0.0.0.0/0        203.0.113.1          1\n1 DAc 10.0.0.0/24      ether2               0\n2 DAo 192.168.50.0/24  10.0.0.9           110\n";
    const ROUTES_V6: &str = "Flags: X - disabled, A - active, D - dynamic, C - connect, S - static, r - rip, b - bgp, o - ospf\n #      DST-ADDRESS        PREF-SRC        GATEWAY            DISTANCE\n 0 A S  0.0.0.0/0                          203.0.113.1               1\n 1 ADC  10.0.0.0/24        10.0.0.1        ether2                    0\n";
    const ARP: &str = "Flags: D - DYNAMIC; P - PUBLISHED; C - COMPLETE\nColumns: ADDRESS, MAC-ADDRESS, INTERFACE\n#    ADDRESS     MAC-ADDRESS        INTERFACE\n0 DC 10.0.0.10   00:50:56:AA:BB:CC  ether3\n";

    #[test]
    fn identity_comes_off_the_resource_and_routerboard_listings() {
        assert_eq!(crate::dialect::family_of(RESOURCE), crate::dialect::Family::RouterOs);
        assert_eq!(model_of(ROUTERBOARD, RESOURCE).as_deref(), Some("RB5009UG+S+"));
        assert_eq!(model_of("", RESOURCE).as_deref(), Some("RB5009UG+S+"), "a CHR has no routerboard");
        assert_eq!(serials_of(ROUTERBOARD), ["ABC123DEF456"]);
        assert!(!verified_against_hardware());
    }

    #[test]
    fn addresses_neighbours_and_hosts_are_read() {
        let a = parse_ip_address(ADDRESSES);
        assert_eq!(a.iter().map(|i| (i.name.as_str(), i.address.as_deref().unwrap(), i.up)).collect::<Vec<_>>(), [("ether2", "10.0.0.1", true), ("ether1", "203.0.113.2", true), ("ether5", "192.168.9.1", false)]);
        let n = parse_neighbors(NEIGHBORS);
        assert_eq!(n.len(), 2);
        assert_eq!((n[0].short_name.as_str(), n[0].local_interface.as_deref(), n[0].remote_interface.as_deref(), n[0].platform.as_deref()), ("leaf1", Some("ether2"), Some("Ethernet3"), Some("DCS-7050")));
        assert_eq!(n[0].addresses[0].ip, "10.0.0.2");
        assert_eq!(n[0].capabilities, ["bridge", "router"]);
        assert_eq!(n[0].chassis_id.as_deref(), Some("001c73aabbcc"));
        assert_eq!(n[1].short_name, "edge-2");
        let h = parse_bridge_hosts(HOSTS);
        assert_eq!(h.iter().map(|m| (m.mac.as_str(), m.port.as_str(), m.vlan.as_deref())).collect::<Vec<_>>(), [("005056aabbcc", "ether3", Some("1"))], "the bridge's own address is not a device");
        let arp = crate::arp::parse_arp_table(ARP);
        assert_eq!(arp.get("005056aabbcc").map(String::as_str), Some("10.0.0.10"));
    }

    #[test]
    fn the_route_table_is_read_in_both_layouts() {
        for table in [ROUTES_V7, ROUTES_V6] {
            assert!(is_route_table(table));
            let got = crate::routes::parse_routes(table);
            let rows: Vec<(&str, &str, Vec<String>, Option<u32>)> = got.iter().map(|r| (r.prefix.as_str(), r.protocol.as_str(), r.next_hops.clone(), r.distance)).collect();
            assert!(rows.contains(&("0.0.0.0/0", "static", vec!["203.0.113.1".to_string()], Some(1))), "{rows:?}");
            assert!(rows.contains(&("10.0.0.0/24", "connected", vec![], Some(0))), "{rows:?}");
            assert_eq!(crate::defaultroute::parse_default_route(table).map(|a| a.to_string()).as_deref(), Some("203.0.113.1"));
        }
        let v7 = crate::routes::parse_routes(ROUTES_V7);
        assert!(v7.iter().any(|r| r.prefix == "192.168.50.0/24" && r.protocol == "ospf" && r.next_hops == ["10.0.0.9"] && r.distance == Some(110)));
        let v6 = crate::routes::parse_routes(ROUTES_V6);
        assert_eq!(v6.iter().find(|r| r.prefix == "10.0.0.0/24").and_then(|r| r.interface.as_deref()), Some("ether2"), "the preferred source is not the interface");
    }
}
