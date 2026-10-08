//! Point-to-point links, from the addressing.
//!
//! Two devices that each have a connected route for the same /30 or /31 (a
//! /127 in IPv6) are cabled to each other on those interfaces, whether or not
//! CDP or LLDP said so: a routed link to a firewall, to a provider edge, or
//! between two routers with discovery turned off. Each side gets a neighbour
//! record for the other, marked `Protocol::Subnet`, so the diagram draws the
//! link and says where it came from.
//!
//! Only the connected routes are read, because they are the one place a
//! device says both its interface and the prefix length; `show ip interface
//! brief` names no mask. A subnet three or more devices claim is a reused
//! number in different VRFs or different sites, and is joined only where the
//! VRF tells the pairs apart. A pair a discovery protocol already joined is
//! left as it is.

use std::collections::BTreeMap;
use std::net::IpAddr;

use crate::crawl::CrawledDevice;
use crate::routes::Route;
use crate::types::{DeviceAddress, Neighbor, Protocol};

/// Whether a prefix is point-to-point: /30, /31, /127.
fn p2p_prefix(prefix: &str) -> Option<(IpAddr, u8)> {
    let (addr, len) = prefix.trim().split_once('/')?;
    let addr: IpAddr = addr.trim().parse().ok()?;
    let len: u8 = len.trim().parse().ok()?;
    let ok = match addr {
        IpAddr::V4(_) => len == 30 || len == 31,
        IpAddr::V6(_) => len == 127,
    };
    ok.then_some((addr, len))
}

fn inside(ip: &str, (net, len): (IpAddr, u8)) -> bool {
    match (ip.split('/').next().unwrap_or(ip).trim().parse::<IpAddr>(), net) {
        (Ok(IpAddr::V4(a)), IpAddr::V4(n)) => {
            let mask = u32::MAX << (32 - len as u32);
            u32::from(a) & mask == u32::from(n) & mask
        }
        (Ok(IpAddr::V6(a)), IpAddr::V6(n)) => {
            let mask = u128::MAX << (128 - len as u32);
            u128::from(a) & mask == u128::from(n) & mask
        }
        _ => false,
    }
}

fn is_connected(r: &Route) -> bool {
    let p = r.protocol.to_ascii_lowercase();
    p == "connected" || p == "direct" || r.code.trim() == "C"
}

/// One device's claim on a point-to-point subnet.
#[derive(Debug, Clone)]
struct Claim {
    device: usize,
    interface: Option<String>,
    vrf: String,
}

fn same_name(a: &str, b: &str) -> bool {
    let short = |s: &str| s.split('.').next().unwrap_or(s).trim().to_ascii_lowercase();
    short(a) == short(b)
}

/// Whether `d` already lists `other` as a neighbour, by name or address.
fn already_joined(d: &CrawledDevice, other: &CrawledDevice) -> bool {
    d.neighbors.iter().any(|n| {
        same_name(&n.short_name, &other.hostname)
            || same_name(&n.device_id, &other.hostname)
            || n.addresses.iter().any(|a| other.addresses.iter().any(|o| o.ip == a.ip))
    })
}

/// Add a neighbour record on each side of every point-to-point subnet two
/// reached devices share. Returns how many links were added.
pub fn join_point_to_point(devices: &mut [CrawledDevice]) -> usize {
    // (network) → claims
    let mut claims: BTreeMap<String, Vec<Claim>> = BTreeMap::new();
    for (i, d) in devices.iter().enumerate() {
        let tables = std::iter::once(("default".to_string(), &d.details.routes)).chain(d.details.vrf_routes.iter().map(|(v, r)| (v.clone(), r)));
        for (vrf, routes) in tables {
            for r in routes.iter().filter(|r| is_connected(r)) {
                let Some(net) = p2p_prefix(&r.prefix) else { continue };
                let key = format!("{}/{}", net.0, net.1);
                let list = claims.entry(key).or_default();
                if !list.iter().any(|c| c.device == i) {
                    list.push(Claim { device: i, interface: r.interface.clone(), vrf: vrf.clone() });
                }
            }
        }
    }
    let mut pairs: Vec<(String, Claim, Claim)> = Vec::new();
    for (net, list) in claims {
        if list.len() == 2 {
            pairs.push((net, list[0].clone(), list[1].clone()));
        } else if list.len() > 2 {
            let mut by_vrf: BTreeMap<&str, Vec<&Claim>> = BTreeMap::new();
            for c in &list {
                by_vrf.entry(c.vrf.as_str()).or_default().push(c);
            }
            for group in by_vrf.values().filter(|g| g.len() == 2) {
                pairs.push((net.clone(), group[0].clone(), group[1].clone()));
            }
        }
    }
    let mut added = 0;
    for (net, a, b) in pairs {
        let Some(net_parsed) = p2p_prefix(&net) else { continue };
        if already_joined(&devices[a.device], &devices[b.device]) || already_joined(&devices[b.device], &devices[a.device]) {
            continue;
        }
        let to_b = record(&devices[b.device], &a, &b, net_parsed);
        let to_a = record(&devices[a.device], &b, &a, net_parsed);
        devices[a.device].neighbors.push(to_b);
        devices[b.device].neighbors.push(to_a);
        added += 1;
    }
    added
}

/// The neighbour record for `to`, as seen from the device on `local`.
fn record(to: &CrawledDevice, local: &Claim, remote: &Claim, net: (IpAddr, u8)) -> Neighbor {
    // Its address on this link, or failing that the one it was reached on.
    let address = to
        .addresses
        .iter()
        .find(|x| inside(&x.ip, net))
        .map(|x| DeviceAddress { ip: x.ip.clone(), interface: x.interface.clone().or_else(|| remote.interface.clone()), is_management: false })
        .unwrap_or_else(|| DeviceAddress::new(to.address.clone()));
    Neighbor {
        device_id: to.hostname.clone(),
        short_name: to.hostname.clone(),
        addresses: vec![address],
        local_interface: local.interface.clone(),
        remote_interface: remote.interface.clone(),
        platform: to.platform.clone(),
        capabilities: Vec::new(),
        version: to.version.clone(),
        class: to.class,
        discovered_by: Protocol::Subnet,
        serial: to.serial.clone(),
        chassis_id: None,
        vendor: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crawl::{DeviceDetails, ReachedBy};
    use crate::types::DeviceClass;

    /// A reached router, its connected routes read from `show ip route` text
    /// written for this test from documentation ranges (no device's capture).
    fn router(name: &str, address: &str, routes: &str) -> CrawledDevice {
        CrawledDevice {
            hostname: name.into(),
            address: address.into(),
            addresses: vec![DeviceAddress::new(address)],
            probe_target: address.into(),
            class: DeviceClass::Router,
            platform: Some("ISR4331".into()),
            serial: None,
            version: None,
            neighbors: vec![],
            hops: 0,
            reached_by: ReachedBy::Ssh,
            attached: vec![],
            port_channels: vec![],
            default_next_hop: None,
            stack: None,
            dns_name: None,
            evidence: Default::default(),
            details: DeviceDetails { routes: crate::routes::parse_routes(routes), ..Default::default() },
        }
    }

    const R1: &str = "Gateway of last resort is not set\n\n      192.0.2.0/24 is variably subnetted, 2 subnets, 2 masks\nC        192.0.2.0/30 is directly connected, GigabitEthernet0/0/1\nL        192.0.2.1/32 is directly connected, GigabitEthernet0/0/1\n      198.51.100.0/24 is variably subnetted, 2 subnets, 2 masks\nC        198.51.100.0/24 is directly connected, GigabitEthernet0/0/0\nL        198.51.100.1/32 is directly connected, GigabitEthernet0/0/0\n";
    const R2: &str = "Gateway of last resort is not set\n\n      192.0.2.0/24 is variably subnetted, 2 subnets, 2 masks\nC        192.0.2.0/30 is directly connected, GigabitEthernet0/0/2\nL        192.0.2.2/32 is directly connected, GigabitEthernet0/0/2\n      198.51.100.0/24 is variably subnetted, 2 subnets, 2 masks\nC        198.51.100.0/24 is directly connected, GigabitEthernet0/0/0\nL        198.51.100.2/32 is directly connected, GigabitEthernet0/0/0\n";

    #[test]
    fn two_routers_on_one_slash_30_are_joined_on_those_interfaces() {
        let mut d = vec![router("R1", "203.0.113.1", R1), router("R2", "203.0.113.2", R2)];
        assert!(d[0].details.routes.iter().any(|r| r.prefix == "192.0.2.0/30"), "the test's table reads: {:?}", d[0].details.routes);
        assert_eq!(join_point_to_point(&mut d), 1);
        let n = &d[0].neighbors[0];
        assert_eq!((n.short_name.as_str(), n.local_interface.as_deref(), n.remote_interface.as_deref(), n.discovered_by), ("R2", Some("GigabitEthernet0/0/1"), Some("GigabitEthernet0/0/2"), Protocol::Subnet));
        let back = &d[1].neighbors[0];
        assert_eq!((back.short_name.as_str(), back.local_interface.as_deref()), ("R1", Some("GigabitEthernet0/0/2")));
        // The shared /24 is a LAN, not a cable between the two: not joined.
        assert_eq!(d[0].neighbors.len(), 1);
    }

    #[test]
    fn a_pair_cdp_already_joined_is_not_joined_twice() {
        let mut d = vec![router("R1", "203.0.113.1", R1), router("R2", "203.0.113.2", R2)];
        let mut cdp = record(&d[1], &Claim { device: 0, interface: Some("Gi0/0/1".into()), vrf: "default".into() }, &Claim { device: 1, interface: Some("Gi0/0/2".into()), vrf: "default".into() }, (IpAddr::from([192, 0, 2, 0]), 30));
        cdp.discovered_by = Protocol::Cdp;
        cdp.short_name = "R2.example.net".into();
        d[0].neighbors.push(cdp);
        assert_eq!(join_point_to_point(&mut d), 0);
        assert!(d[1].neighbors.is_empty());
    }

    #[test]
    fn a_slash_31_counts_and_a_subnet_three_devices_claim_is_left_alone() {
        let r31 = |iface: &str, me: &str| format!("C        192.0.2.8/31 is directly connected, {iface}\nL        {me}/32 is directly connected, {iface}\n");
        let mut d = vec![router("A", "203.0.113.1", &r31("Te1/0/1", "192.0.2.8")), router("B", "203.0.113.2", &r31("Te1/0/2", "192.0.2.9"))];
        assert_eq!(join_point_to_point(&mut d), 1);
        let mut three = vec![router("A", "203.0.113.1", R1), router("B", "203.0.113.2", R2), router("C", "203.0.113.3", R2)];
        assert_eq!(join_point_to_point(&mut three), 0, "a reused number is not a cable");
    }
}
