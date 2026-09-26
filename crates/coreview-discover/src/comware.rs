//! HPE and H3C Comware identity and tables (LT-471), and the routing table
//! Huawei VRP prints in the same shape (LT-472).
//!
//! **Built from HPE's and H3C's documentation and posted sessions, not from a
//! switch (D-058).** Fixtures reconstructed; [`verified_against_hardware`]
//! says `false` until one is a capture.
//!
//! - `display version` — `HPE Comware Software, Version 7.1.070`, then
//!   `HPE 5130 48G 4SFP+ EI Switch uptime is …`, whose head is the model.
//! - `display device manuinfo` — `DEVICE_SERIAL_NUMBER : CN12345678`.
//! - `display ip interface brief` — Interface, Physical, Protocol, IP Address.
//! - `display lldp neighbor-information list` — System Name, Local
//!   Interface, Chassis ID, Port ID.
//! - `display arp` — read by the ordinary ARP reader.
//! - `display mac-address` — MAC Address, VLAN ID, State, Port.
//! - `display ip routing-table` — Destination/Mask, Proto, Pre, Cost,
//!   NextHop, Interface; Huawei's table has the same columns and is read by
//!   [`parse_routing_table`] too, reached through `routes::parse_routes` by
//!   shape.
//! - `display link-aggregation verbose` — each `Aggregate Interface:` and
//!   the ports under `Local:`.
//!
//! Paging is `screen-length disable`; the prompt is `<host>` or `[host]`.

use crate::arp::normalise_mac;
use crate::cdp::short_name;
use crate::etherchannel::PortChannel;
use crate::interfaces::Interface;
use crate::mac_table::MacEntry;
use crate::routes::Route;
use crate::types::{DeviceClass, Neighbor, Protocol};

/// D-058: this platform has not met a device.
pub fn verified_against_hardware() -> bool {
    false
}

/// `HPE 5130 48G 4SFP+ EI Switch uptime is 12 weeks, 3 days`: the head of
/// the uptime line, without the vendor's word.
pub fn model_of(version: &str) -> Option<String> {
    version.lines().find_map(|l| {
        let (head, _) = l.trim().split_once(" uptime is ")?;
        let model = head.trim().strip_prefix("HPE ").or_else(|| head.strip_prefix("H3C ")).or_else(|| head.strip_prefix("HP ")).unwrap_or(head).trim();
        (!model.is_empty()).then(|| model.to_ascii_uppercase())
    })
}

/// `DEVICE_SERIAL_NUMBER : CN12345678`, once per slot, in order.
pub fn serials_of(manuinfo: &str) -> Vec<String> {
    let mut out = Vec::new();
    for l in manuinfo.lines() {
        if let Some((k, v)) = l.trim().split_once(':') {
            if k.trim().eq_ignore_ascii_case("DEVICE_SERIAL_NUMBER") && !v.trim().is_empty() && !out.contains(&v.trim().to_string()) {
                out.push(v.trim().to_string());
            }
        }
    }
    out
}

/// `display ip interface brief`.
///
/// ```text
/// *down: administratively down
/// (s): spoofing  (l): loopback
/// Interface           Physical Protocol IP Address      Description
/// GE1/0/1             up       up       10.0.0.1        --
/// Vlan10              up       up       10.0.10.1       --
/// Vlan20              down     down     --              --
/// ```
pub fn parse_ip_interface_brief(out: &str) -> Vec<Interface> {
    let mut found = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 4 || f[0] == "Interface" {
            continue;
        }
        let address = f[3].split('/').next().unwrap_or("");
        if address.parse::<std::net::Ipv4Addr>().is_err() {
            continue;
        }
        let up = f[1].eq_ignore_ascii_case("up") && f[2].eq_ignore_ascii_case("up");
        found.push(Interface { name: f[0].to_string(), address: Some(address.to_string()), up });
    }
    found
}

/// `display lldp neighbor-information list`.
///
/// ```text
/// Chassis ID : * -- -- Nearest nontpmr bridge neighbor
///              # -- -- Nearest customer bridge neighbor
///              Default -- -- Nearest bridge neighbor
/// System Name          Local Interface Chassis ID      Port ID
/// leaf1                GE1/0/1         001c-73aa-bbcc  Ethernet3
/// core-2               GE1/0/48        0000-5e00-5302  GigabitEthernet1/0/24
/// ```
pub fn parse_lldp_neighbor_list(out: &str) -> Vec<Neighbor> {
    let lines: Vec<&str> = out.lines().collect();
    let Some(at) = lines.iter().position(|l| l.contains("System Name") && l.contains("Local Interface")) else {
        return Vec::new();
    };
    lines[at + 1..]
        .iter()
        .filter_map(|row| {
            let f: Vec<&str> = row.split_whitespace().collect();
            if f.len() < 4 {
                return None;
            }
            let device_id = f[0].to_string();
            let mac = normalise_mac(f[2]);
            Some(Neighbor {
                serial: None,
                short_name: short_name(&device_id),
                device_id,
                addresses: Vec::new(),
                local_interface: Some(f[1].to_string()),
                remote_interface: Some(f[3].to_string()),
                platform: None,
                capabilities: Vec::new(),
                version: None,
                class: DeviceClass::Unknown,
                discovered_by: Protocol::Lldp,
                vendor: mac.as_deref().and_then(crate::oui::vendor).map(str::to_string),
                chassis_id: mac,
            })
        })
        .collect()
}

/// `display mac-address` (Comware) and Huawei's `display mac-address`, whose
/// first columns agree: MAC, VLAN, then the port somewhere after.
///
/// ```text
/// MAC Address      VLAN ID    State           Port/Nickname            Aging
/// 0050-56aa-bbcc   10         Learned         GE1/0/3                  Y
/// ```
pub fn parse_mac_address(out: &str) -> Vec<MacEntry> {
    let mut found = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 3 {
            continue;
        }
        let Some(mac) = normalise_mac(f[0]).filter(|_| f[0].contains('-') || f[0].contains(':')) else { continue };
        let vlan = f[1].split('/').next().unwrap_or("").to_string();
        let Some(port) = f[2..].iter().find(|w| w.chars().any(|c| c.is_ascii_alphabetic()) && w.contains(|c: char| c.is_ascii_digit()) && !w.eq_ignore_ascii_case("learned")) else { continue };
        found.push(MacEntry { mac, port: port.to_string(), vlan: (!vlan.is_empty() && vlan != "-").then_some(vlan) });
    }
    found
}

/// Whether a routing table is Comware's or Huawei's, by its header.
pub fn is_routing_table(out: &str) -> bool {
    out.contains("Destination/Mask")
}

/// `display ip routing-table`, on Comware and on Huawei VRP.
///
/// ```text
/// Destinations : 4        Routes : 4
/// Destination/Mask   Proto   Pre Cost        NextHop         Interface
/// 0.0.0.0/0          Static  60  0           203.0.113.1     GE1/0/1
/// 10.0.0.0/24        Direct  0   0           10.0.0.1        Vlan10
/// 10.0.0.1/32        Direct  0   0           127.0.0.1       InLoop0
/// 192.168.50.0/24    OSPF    10  2           10.0.0.9        Vlan10
/// ```
///
/// Huawei adds a `Flags` column between Cost and NextHop; the next hop is
/// the first address after the costs either way. `Pre` is the preference
/// (administrative distance), `Cost` the metric. A `Direct` route is
/// connected and has no next hop of its own.
pub fn parse_routing_table(out: &str) -> Vec<Route> {
    let mut routes = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 5 {
            continue;
        }
        let Some((network, bits)) = f[0].split_once('/') else { continue };
        let (Ok(addr), Ok(bits)) = (network.parse::<std::net::IpAddr>(), bits.parse::<u8>()) else { continue };
        let proto = f[1].to_ascii_lowercase();
        let protocol = match proto.as_str() {
            "direct" => "connected",
            "static" => "static",
            "ospf" | "o_intra" | "o_inter" | "o_ase" | "o_nssa" => "ospf",
            "bgp" | "ibgp" | "ebgp" => "bgp",
            "rip" => "rip",
            "isis" | "isis-l1" | "isis-l2" => "isis",
            other => {
                if other.starts_with("ospf") || other.starts_with("o_") {
                    "ospf"
                } else {
                    "unknown"
                }
            }
        };
        let distance = f[2].parse::<u32>().ok();
        let metric = f[3].parse::<u32>().ok();
        let hop_at = f[4..].iter().position(|w| w.parse::<std::net::IpAddr>().is_ok()).map(|i| i + 4);
        let interface = f[hop_at.map(|i| i + 1).unwrap_or(4)..].iter().find(|w| w.chars().any(|c| c.is_ascii_alphabetic())).map(|w| w.to_string());
        let next_hops = match (protocol, hop_at) {
            ("connected", _) | (_, None) => Vec::new(),
            (_, Some(i)) => vec![f[i].to_string()],
        };
        routes.push(Route {
            family: if addr.is_ipv4() { 4 } else { 6 },
            prefix: format!("{addr}/{bits}"),
            code: f[1].to_string(),
            protocol: protocol.to_string(),
            next_hops,
            interface,
            distance,
            metric,
            next_hop_vrf: None,
            segment_id: None,
        });
    }
    routes
}

/// `display link-aggregation verbose`.
///
/// ```text
/// Aggregate Interface: Bridge-Aggregation1
/// Aggregation Mode: Dynamic
/// Loadsharing Type: Shar
/// System ID: 0x8000, 0000-5e00-0101
/// Local:
///   Port                Status  Priority Oper-Key  Flag
///   GE1/0/47            S       32768    1         {ACDEF}
///   GE1/0/48            S       32768    1         {ACDEF}
/// Remote:
///   Actor               Partner Priority Oper-Key  SystemID              Flag
///   GE1/0/47            1       32768    1         0x8000, 001c-73aa-bbcc {ACDEF}
/// ```
pub fn parse_link_aggregation(out: &str) -> Vec<PortChannel> {
    let mut channels: Vec<PortChannel> = Vec::new();
    let mut in_local = false;
    for line in out.lines() {
        let t = line.trim();
        if let Some(name) = t.strip_prefix("Aggregate Interface:") {
            channels.push(PortChannel { name: name.trim().to_string(), protocol: "-".into(), members: Vec::new() });
            in_local = false;
        } else if let Some(mode) = t.strip_prefix("Aggregation Mode:") {
            if let Some(c) = channels.last_mut() {
                c.protocol = if mode.trim().eq_ignore_ascii_case("dynamic") { "LACP".into() } else { "-".into() };
            }
        } else if t == "Local:" {
            in_local = true;
        } else if t == "Remote:" {
            in_local = false;
        } else if in_local && !t.starts_with("Port") {
            let f: Vec<&str> = t.split_whitespace().collect();
            if f.len() >= 2 && f[0].chars().any(|c| c.is_ascii_digit()) {
                if let Some(c) = channels.last_mut() {
                    c.members.push(f[0].to_string());
                }
            }
        }
    }
    channels.retain(|c| !c.members.is_empty());
    channels
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reconstructed from HPE's documentation (D-058), not captured.
    const VERSION: &str = "HPE Comware Software, Version 7.1.070, Release 6710\nCopyright (c) 2010-2023 Hewlett Packard Enterprise Development LP\nHPE 5130 48G 4SFP+ EI Switch uptime is 12 weeks, 3 days, 4 hours, 5 minutes\nLast reboot reason : User reboot\n";
    const MANUINFO: &str = "Slot 1 CPU 0:\nDEVICE_NAME          : 5130-48G-4SFP+ EI JG934A\nDEVICE_SERIAL_NUMBER : CN12345678\nMAC_ADDRESS          : 0000-5E00-5301\nMANUFACTURING_DATE   : 2020-01-15\nVENDOR_NAME          : HPE\n";
    const BRIEF: &str = "*down: administratively down\n(s): spoofing  (l): loopback\nInterface           Physical Protocol IP Address      Description\nGE1/0/1             up       up       10.0.0.1        --\nVlan10              up       up       10.0.10.1       --\nVlan20              down     down     --              --\n";
    const LLDP: &str = "Chassis ID : * -- -- Nearest nontpmr bridge neighbor\n             # -- -- Nearest customer bridge neighbor\n             Default -- -- Nearest bridge neighbor\nSystem Name          Local Interface Chassis ID      Port ID\nleaf1                GE1/0/1         001c-73aa-bbcc  Ethernet3\ncore-2.example.test  GE1/0/48        0000-5e00-5302  GigabitEthernet1/0/24\n";
    const MACS: &str = "MAC Address      VLAN ID    State           Port/Nickname            Aging\n0050-56aa-bbcc   10         Learned         GE1/0/3                  Y\n0000-5e00-5302   1          Learned         BAGG1                    Y\n";
    const ROUTES: &str = "Destinations : 4        Routes : 4\n\nDestination/Mask   Proto   Pre Cost        NextHop         Interface\n0.0.0.0/0          Static  60  0           203.0.113.1     GE1/0/1\n10.0.0.0/24        Direct  0   0           10.0.0.1        Vlan10\n10.0.0.1/32        Direct  0   0           127.0.0.1       InLoop0\n192.168.50.0/24    OSPF    10  2           10.0.0.9        Vlan10\n";
    const HUAWEI_ROUTES: &str = "Route Flags: R - relay, D - download to fib\n------------------------------------------------------------------------------\nRouting Tables: Public\n         Destinations : 3        Routes : 3\n\nDestination/Mask    Proto   Pre  Cost      Flags NextHop         Interface\n\n        0.0.0.0/0   Static  60   0          RD   203.0.113.1     GigabitEthernet0/0/1\n       10.0.0.0/24  Direct  0    0          D    10.0.0.1        Vlanif10\n   192.168.50.0/24  OSPF    10   2          D    10.0.0.9        Vlanif10\n";
    const LAG: &str = "Aggregate Interface: Bridge-Aggregation1\nAggregation Mode: Dynamic\nLoadsharing Type: Shar\nManagement VLANs: None\nSystem ID: 0x8000, 0000-5e00-0101\nLocal:\n  Port                Status  Priority Oper-Key  Flag\n  GE1/0/47            S       32768    1         {ACDEF}\n  GE1/0/48            S       32768    1         {ACDEF}\nRemote:\n  Actor               Partner Priority Oper-Key  SystemID              Flag\n  GE1/0/47            1       32768    1         0x8000, 001c-73aa-bbcc {ACDEF}\n";

    #[test]
    fn identity_comes_off_the_uptime_line_and_the_manuinfo() {
        assert_eq!(crate::dialect::family_of(VERSION), crate::dialect::Family::Comware);
        assert_eq!(model_of(VERSION).as_deref(), Some("5130 48G 4SFP+ EI SWITCH"));
        assert_eq!(serials_of(MANUINFO), ["CN12345678"]);
        assert!(!verified_against_hardware());
    }

    #[test]
    fn the_tables_are_read() {
        let brief = parse_ip_interface_brief(BRIEF);
        assert_eq!(brief.iter().map(|i| (i.name.as_str(), i.address.as_deref().unwrap(), i.up)).collect::<Vec<_>>(), [("GE1/0/1", "10.0.0.1", true), ("Vlan10", "10.0.10.1", true)]);
        let lldp = parse_lldp_neighbor_list(LLDP);
        assert_eq!(lldp.iter().map(|n| (n.short_name.as_str(), n.local_interface.as_deref().unwrap(), n.remote_interface.as_deref().unwrap())).collect::<Vec<_>>(), [("leaf1", "GE1/0/1", "Ethernet3"), ("core-2", "GE1/0/48", "GigabitEthernet1/0/24")]);
        assert_eq!(lldp[0].chassis_id.as_deref(), Some("001c73aabbcc"));
        let macs = parse_mac_address(MACS);
        assert_eq!(macs.iter().map(|m| (m.mac.as_str(), m.port.as_str(), m.vlan.as_deref())).collect::<Vec<_>>(), [("005056aabbcc", "GE1/0/3", Some("10")), ("00005e005302", "BAGG1", Some("1"))]);
        let lag = parse_link_aggregation(LAG);
        assert_eq!(lag.len(), 1);
        assert_eq!((lag[0].name.as_str(), lag[0].protocol.as_str(), lag[0].members.clone()), ("Bridge-Aggregation1", "LACP", vec!["GE1/0/47".to_string(), "GE1/0/48".to_string()]));
    }

    #[test]
    #[allow(clippy::type_complexity)]
    fn the_routing_table_is_read_by_shape_on_comware_and_on_huawei() {
        for table in [ROUTES, HUAWEI_ROUTES] {
            assert!(is_routing_table(table));
            let got = crate::routes::parse_routes(table);
            let rows: Vec<(&str, &str, Vec<String>, Option<u32>, Option<u32>)> = got.iter().map(|r| (r.prefix.as_str(), r.protocol.as_str(), r.next_hops.clone(), r.distance, r.metric)).collect();
            assert!(rows.contains(&("0.0.0.0/0", "static", vec!["203.0.113.1".to_string()], Some(60), Some(0))), "{rows:?}");
            assert!(rows.contains(&("10.0.0.0/24", "connected", vec![], Some(0), Some(0))), "{rows:?}");
            assert!(rows.contains(&("192.168.50.0/24", "ospf", vec!["10.0.0.9".to_string()], Some(10), Some(2))), "{rows:?}");
            assert_eq!(crate::defaultroute::parse_default_route(table).map(|a| a.to_string()).as_deref(), Some("203.0.113.1"));
        }
        let got = crate::routes::parse_routes(HUAWEI_ROUTES);
        assert_eq!(got.iter().find(|r| r.prefix == "0.0.0.0/0").and_then(|r| r.interface.as_deref()), Some("GigabitEthernet0/0/1"), "the interface is after the flags");
    }
}
