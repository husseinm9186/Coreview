//! Layer 3 and overlays. Two devices with addresses in one subnet are
//! layer-3 neighbours — confirmed when one lists the other as a routing
//! neighbour, and at 0.4 on the subnet alone. A subnet with many routers on
//! it (a user VLAN with FHRP, a transit LAN) is drawn only where a routing
//! protocol or an FHRP group says two of them talk, or every router on a
//! flat LAN would be joined to every other. Tunnels and VXLAN peers are
//! overlay edges to whichever node owns the far address.

use std::collections::{BTreeMap, BTreeSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use crate::identity::Identities;
use crate::model::*;

/// More routers than this on one subnet and only confirmed pairs are drawn.
pub const SMALL_SUBNET: usize = 4;

fn network(ip: &str, plen: u8) -> Option<String> {
    match ip.parse::<IpAddr>().ok()? {
        IpAddr::V4(a) => {
            if plen >= 32 {
                return None;
            }
            let mask = if plen == 0 { 0 } else { u32::MAX << (32 - plen) };
            Some(format!("{}/{plen}", Ipv4Addr::from(u32::from(a) & mask)))
        }
        IpAddr::V6(a) => {
            if plen >= 128 || a.segments()[0] & 0xffc0 == 0xfe80 {
                return None;
            }
            let mask = if plen == 0 { 0 } else { u128::MAX << (128 - plen) };
            Some(format!("{}/{plen}", Ipv6Addr::from(u128::from(a) & mask)))
        }
    }
}

fn is_mgmt(iface: Option<&str>) -> bool {
    let i = iface.unwrap_or("").to_ascii_lowercase();
    i.starts_with("mgmt") || i.starts_with("management") || i == "me0" || i == "fxp0" || i == "em0" || i == "vme" || i.starts_with("ma1") || i == "oob"
}

pub fn shared_subnets(devices: &[DeviceIn], graph: &mut Graph, ids: &Identities) {
    // subnet → node → interface
    let mut on: BTreeMap<String, BTreeMap<String, Option<String>>> = BTreeMap::new();
    for n in &graph.nodes {
        if n.kind != NodeKind::Collected {
            continue;
        }
        for (ip, iface, plen, _) in &n.addresses {
            let Some(p) = plen else { continue };
            if is_mgmt(iface.as_deref()) {
                continue;
            }
            if let Some(net) = network(ip, *p) {
                on.entry(net).or_default().entry(n.id.clone()).or_insert_with(|| iface.clone());
            }
        }
    }
    // Who each node says it routes with: (node, neighbour ip) → protocol.
    let mut confirms: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    for d in devices {
        let Some(node) = ids.of_device.get(&d.device_id) else { continue };
        for r in d.rows("routing_neighbor") {
            let proto = r.get("proto").unwrap_or("routing").to_string();
            for ip in [r.get("neighbor_ip"), r.get("neighbor_id")].into_iter().flatten() {
                if let Some(peer) = ids.by_ip(ip) {
                    confirms.entry((node.clone(), peer.clone())).or_default().insert(proto.clone());
                }
            }
        }
        // FHRP: two routers in one group on one VIP talk to each other.
        for r in d.rows("fhrp") {
            let proto = r.get("proto").unwrap_or("fhrp").to_string();
            for ip in [r.get("peer_ip")].into_iter().flatten() {
                if let Some(peer) = ids.by_ip(ip) {
                    confirms.entry((node.clone(), peer.clone())).or_default().insert(proto.clone());
                }
            }
        }
    }
    for (net, members) in &on {
        let nodes: Vec<(&String, &Option<String>)> = members.iter().collect();
        if nodes.len() < 2 {
            continue;
        }
        for i in 0..nodes.len() {
            for j in i + 1..nodes.len() {
                let (a, ai) = nodes[i];
                let (b, bi) = nodes[j];
                let mut by: BTreeSet<String> = BTreeSet::new();
                for k in [(a.clone(), b.clone()), (b.clone(), a.clone())] {
                    if let Some(p) = confirms.get(&k) {
                        by.extend(p.iter().cloned());
                    }
                }
                if by.is_empty() && nodes.len() > SMALL_SUBNET {
                    continue;
                }
                graph.l3.push(L3Adjacency {
                    a: a.clone(),
                    a_if: ai.clone(),
                    b: b.clone(),
                    b_if: bi.clone(),
                    vrf: None,
                    subnet: net.clone(),
                    confidence: if by.is_empty() { 0.4 } else { 1.0 },
                    confirmed_by: by.into_iter().collect(),
                });
            }
        }
    }
}

pub fn overlays(devices: &[DeviceIn], graph: &mut Graph, ids: &Identities) {
    for d in devices {
        let Some(node) = ids.of_device.get(&d.device_id) else { continue };
        for r in d.rows("tunnel") {
            let cmd = r.command.as_str();
            let kind = if cmd.contains("nve") || cmd.contains("vxlan") || cmd.contains("evpn") {
                "vxlan"
            } else if cmd.contains("dmvpn") {
                "dmvpn"
            } else if cmd.contains("crypto") || cmd.contains("ipsec") || cmd.contains("vpn") || cmd.contains("ike") {
                "ipsec"
            } else if cmd.contains("sdwan") || cmd.contains("virtual_wan") {
                "sdwan"
            } else if cmd.contains("mpls") || cmd.contains("ldp") || cmd.contains("l2vpn") {
                "mpls"
            } else {
                "gre"
            };
            let remote = r.get("remote_ip").map(|s| s.split(['/', ' ', ',']).next().unwrap_or(s).to_string());
            let peer = remote.as_deref().and_then(|ip| ids.by_ip(ip)).cloned().filter(|p| p != node);
            if remote.is_none() && peer.is_none() {
                continue;
            }
            let o = Overlay { a: node.clone(), b: peer, kind: kind.into(), name: r.get("name").map(str::to_string), local_ip: r.get("local_ip").map(str::to_string), remote_ip: remote };
            if !graph.overlays.contains(&o) {
                graph.overlays.push(o);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn networks_and_what_is_not_one() {
        assert_eq!(network("192.0.2.9", 24).as_deref(), Some("192.0.2.0/24"));
        assert_eq!(network("192.0.2.9", 30).as_deref(), Some("192.0.2.8/30"));
        assert_eq!(network("192.0.2.9", 32), None);
        assert_eq!(network("2001:db8::1", 64).as_deref(), Some("2001:db8::/64"));
        assert_eq!(network("fe80::1", 64), None);
        assert!(is_mgmt(Some("mgmt0")) && is_mgmt(Some("fxp0")) && !is_mgmt(Some("Vlan10")));
    }
}
