//! Palo Alto PAN-OS identity and tables (LT-468).
//!
//! **Built from Palo Alto's documentation and posted sessions, not from a
//! device (D-058).** A Palo Alto has been seen on the operator's network over
//! SNMP and by its OUI (LT-134); nothing had logged into one. The fixtures
//! below are reconstructed and [`verified_against_hardware`] says `false`.
//!
//! What is read:
//!
//! - `show system info` — `hostname:`, `model:`, `serial:`, `sw-version:`.
//! - `show interface all` — the *logical* section, whose last column is the
//!   address in CIDR; `N/A` is a unit with none.
//! - `show lldp neighbors all` — interface, chassis id, port id, TTL. No
//!   system name in the summary, so a neighbour is named by its chassis id
//!   and its maker looked up from the OUI.
//! - `show arp all` — read by the ordinary ARP reader, which finds the first
//!   address and the first MAC on each line.
//! - `show routing route` — every virtual router's table, in
//!   [`parse_routes`], reached through `routes::parse_routes` by shape.
//!
//! Paging is `set cli pager off`. There is no CDP and no MAC table to read.

use crate::arp::normalise_mac;
use crate::interfaces::Interface;
use crate::routes::Route;
use crate::types::{DeviceClass, Neighbor, Protocol};

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

/// `model: PA-220`, upper-cased for the classifier.
pub fn model_of(info: &str) -> Option<String> {
    labelled(info, "model").map(|m| m.to_ascii_uppercase())
}

/// `serial: 012345678901`.
pub fn serials_of(info: &str) -> Vec<String> {
    labelled(info, "serial").map(|s| vec![s.to_string()]).unwrap_or_default()
}

/// `show interface all`, the logical section.
///
/// ```text
/// total configured logical interfaces: 3
/// name                id    vsys zone             forwarding               tag    address
/// ------------------- ----- ---- ---------------- ------------------------ ------ ------------------
/// ethernet1/1         16    1    untrust          vr:default               0      203.0.113.2/24
/// ethernet1/2         17    1    trust            vr:default               0      10.0.0.1/24
/// vlan                4     1                     vr:default               0      N/A
/// ```
///
/// The zone column may be empty, so the row is read from its ends: the name
/// first, the address last. The state is in the hardware section above and
/// is not joined; an interface with an address is taken as up.
pub fn parse_interface_all(out: &str) -> Vec<Interface> {
    let mut found = Vec::new();
    let mut logical = false;
    for line in out.lines() {
        let t = line.trim();
        if t.starts_with("total configured logical interfaces") {
            logical = true;
            continue;
        }
        if !logical || t.is_empty() || t.starts_with("name") || t.starts_with('-') {
            continue;
        }
        let f: Vec<&str> = t.split_whitespace().collect();
        let (Some(name), Some(last)) = (f.first(), f.last()) else { continue };
        let address = last.split('/').next().unwrap_or("");
        if f.len() < 3 || address.parse::<std::net::Ipv4Addr>().is_err() {
            continue;
        }
        found.push(Interface { name: name.to_string(), address: Some(address.to_string()), up: true });
    }
    found
}

/// `show lldp neighbors all`.
///
/// ```text
/// Interface            Chassis-ID                  Port-ID               TTL
/// -----------------------------------------------------------------------------
/// ethernet1/1          00:1c:73:aa:bb:cc           Ethernet3             120
/// ```
pub fn parse_lldp_neighbors(out: &str) -> Vec<Neighbor> {
    let lines: Vec<&str> = out.lines().collect();
    let Some(at) = lines.iter().position(|l| l.contains("Interface") && l.contains("Chassis-ID")) else {
        return Vec::new();
    };
    lines[at + 1..]
        .iter()
        .filter(|l| !l.trim().is_empty() && !l.trim().starts_with('-'))
        .filter_map(|row| {
            let f: Vec<&str> = row.split_whitespace().collect();
            if f.len() < 3 {
                return None;
            }
            let chassis = f[1].to_string();
            let mac = normalise_mac(&chassis);
            Some(Neighbor {
                serial: None,
                short_name: chassis.clone(),
                device_id: chassis,
                addresses: Vec::new(),
                local_interface: Some(f[0].to_string()),
                remote_interface: Some(f[2].to_string()),
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

/// Whether a routing table is PAN-OS's, by shape.
pub fn is_route_table(out: &str) -> bool {
    out.contains("VIRTUAL ROUTER:") || (out.contains("flags:") && out.contains("A:active"))
}

/// `show routing route`, every virtual router.
///
/// ```text
/// flags: A:active, ?:loose, C:connect, H:host, S:static, ~:internal, R:rip, O:ospf, B:bgp,
///        Oi:ospf intra-area, Oo:ospf inter-area, O1:ospf ext-type-1, O2:ospf ext-type-2, E:ecmp, M:multicast
///
/// VIRTUAL ROUTER: default (id 1)
///   ==========
/// destination                                 nexthop                                 metric flags      age   interface          next-AS
/// 0.0.0.0/0                                   203.0.113.1                             10     A S              ethernet1/1
/// 10.0.0.0/24                                 10.0.0.1                                0      A C              ethernet1/2
/// 10.0.0.1/32                                 0.0.0.0                                 0      A H
/// ```
///
/// A connected route's next hop is the interface's own address and is not
/// one; a host route (`H`) is the device itself and is dropped. PAN-OS
/// prints no administrative distance.
pub fn parse_routes(out: &str) -> Vec<Route> {
    let mut routes = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 3 {
            continue;
        }
        let Some((network, bits)) = f[0].split_once('/') else { continue };
        let (Ok(addr), Ok(bits)) = (network.parse::<std::net::IpAddr>(), bits.parse::<u8>()) else { continue };
        let Ok(metric) = f[2].parse::<u32>() else { continue };
        // Flags are one or two characters starting with a letter (`A`, `S`,
        // `O2`, `?`, `~`); an age is digits and ends them.
        let flags: Vec<&str> = f[3..]
            .iter()
            .take_while(|w| w.len() <= 2 && w.starts_with(|c: char| c.is_ascii_alphabetic() || c == '?' || c == '~') && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '?' || c == '~'))
            .copied()
            .collect();
        let protocol = if flags.contains(&"C") {
            "connected"
        } else if flags.contains(&"S") {
            "static"
        } else if flags.iter().any(|w| w.starts_with('O')) {
            "ospf"
        } else if flags.contains(&"B") {
            "bgp"
        } else if flags.contains(&"R") {
            "rip"
        } else if flags.contains(&"H") {
            continue;
        } else {
            "unknown"
        };
        let interface = f[3 + flags.len()..].iter().find(|w| w.chars().any(|c| c.is_ascii_alphabetic())).map(|w| w.to_string());
        let next_hops = if protocol == "connected" || f[1] == "0.0.0.0" { Vec::new() } else { vec![f[1].to_string()] };
        routes.push(Route {
            family: if addr.is_ipv4() { 4 } else { 6 },
            prefix: format!("{addr}/{bits}"),
            code: flags.join(" "),
            protocol: protocol.to_string(),
            next_hops,
            interface,
            distance: None,
            metric: Some(metric),
            next_hop_vrf: None,
            segment_id: None,
        });
    }
    routes
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reconstructed from Palo Alto's documentation (D-058), not captured.
    const INFO: &str = "hostname: fw-1\nip-address: 10.0.0.1\nnetmask: 255.255.255.0\ndefault-gateway: 10.0.0.254\nmac-address: 00:1b:17:00:01:10\ntime: Thu Sep 26 10:00:00 2026\nuptime: 12 days, 3:04:05\nfamily: 220\nmodel: PA-220\nserial: 012345678901\nsw-version: 10.1.6\n";
    const INTERFACES: &str = "total configured hardware interfaces: 2\nname                    id    speed/duplex/state    mac address\n--------------------------------------------------------------------------------\nethernet1/1             16    1000/full/up          00:1b:17:00:01:10\nethernet1/2             17    1000/full/up          00:1b:17:00:01:11\naggregation groups: 0\n\ntotal configured logical interfaces: 3\nname                id    vsys zone             forwarding               tag    address\n------------------- ----- ---- ---------------- ------------------------ ------ ------------------\nethernet1/1         16    1    untrust          vr:default               0      203.0.113.2/24\nethernet1/2         17    1    trust            vr:default               0      10.0.0.1/24\nvlan                4     1                     vr:default               0      N/A\n";
    const LLDP: &str = "Interface            Chassis-ID                  Port-ID               TTL\n-----------------------------------------------------------------------------\nethernet1/2          00:1c:73:aa:bb:cc           Ethernet3             120\n";
    const ROUTES: &str = "flags: A:active, ?:loose, C:connect, H:host, S:static, ~:internal, R:rip, O:ospf, B:bgp,\n       Oi:ospf intra-area, Oo:ospf inter-area, O1:ospf ext-type-1, O2:ospf ext-type-2, E:ecmp, M:multicast\n\nVIRTUAL ROUTER: default (id 1)\n  ==========\ndestination                                 nexthop                                 metric flags      age   interface          next-AS\n0.0.0.0/0                                   203.0.113.1                             10     A S              ethernet1/1\n10.0.0.0/24                                 10.0.0.1                                0      A C              ethernet1/2\n10.0.0.1/32                                 0.0.0.0                                 0      A H\n192.168.50.0/24                             10.0.0.9                                30     A O2      1234  ethernet1/2\ntotal routes shown: 4\n";
    const ARP: &str = "maximum of entries supported :     1500\ndefault timeout:                   1800 seconds\ntotal ARP entries in table :       1\ntotal ARP entries shown :          1\nstatus: s - static, c - complete, e - expiring, i - incomplete\n\ninterface         ip address      hw address        port       status  ttl\n--------------------------------------------------------------------------------\nethernet1/2       10.0.0.10       00:50:56:aa:bb:cc ethernet1/2 c       1770\n";

    #[test]
    fn identity_comes_off_show_system_info() {
        assert_eq!(model_of(INFO).as_deref(), Some("PA-220"));
        assert_eq!(serials_of(INFO), ["012345678901"]);
        assert_eq!(crate::classify::classify(model_of(INFO).as_deref(), &[], None), DeviceClass::Firewall);
        assert_eq!(crate::dialect::family_of(INFO), crate::dialect::Family::PanOs);
        assert!(!verified_against_hardware());
    }

    #[test]
    fn addresses_come_off_the_logical_section_and_na_is_none() {
        let got = parse_interface_all(INTERFACES);
        let rows: Vec<(&str, &str)> = got.iter().map(|i| (i.name.as_str(), i.address.as_deref().unwrap())).collect();
        assert_eq!(rows, [("ethernet1/1", "203.0.113.2"), ("ethernet1/2", "10.0.0.1")]);
    }

    #[test]
    fn a_neighbour_is_named_by_its_chassis_and_the_arp_table_reads_as_usual() {
        let got = parse_lldp_neighbors(LLDP);
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].device_id.as_str(), got[0].local_interface.as_deref(), got[0].remote_interface.as_deref()), ("00:1c:73:aa:bb:cc", Some("ethernet1/2"), Some("Ethernet3")));
        assert_eq!(got[0].chassis_id.as_deref(), Some("001c73aabbcc"));
        let arp = crate::arp::parse_arp_table(ARP);
        assert_eq!(arp.get("005056aabbcc").map(String::as_str), Some("10.0.0.10"), "keyed by MAC, as the crawl reads it: {arp:?}");
    }

    #[test]
    #[allow(clippy::type_complexity)]
    fn the_routing_table_is_read_by_shape() {
        assert!(is_route_table(ROUTES));
        let got = crate::routes::parse_routes(ROUTES);
        let rows: Vec<(&str, &str, Vec<String>, Option<&str>, Option<u32>)> =
            got.iter().map(|r| (r.prefix.as_str(), r.protocol.as_str(), r.next_hops.clone(), r.interface.as_deref(), r.metric)).collect();
        assert_eq!(
            rows,
            [
                ("0.0.0.0/0", "static", vec!["203.0.113.1".to_string()], Some("ethernet1/1"), Some(10)),
                ("10.0.0.0/24", "connected", vec![], Some("ethernet1/2"), Some(0)),
                ("192.168.50.0/24", "ospf", vec!["10.0.0.9".to_string()], Some("ethernet1/2"), Some(30)),
            ]
        );
        assert_eq!(crate::defaultroute::parse_default_route(ROUTES).map(|a| a.to_string()).as_deref(), Some("203.0.113.1"));
    }
}
