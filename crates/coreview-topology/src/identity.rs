//! One node per box. A collected device is known by its serials, its MACs
//! (base MAC and every interface MAC), its addresses and its name; two
//! collections that reached the same box on two addresses are one node,
//! never two (the spec: "dedupe devices by serial/base MAC, never by IP").
//! A neighbour row names its far end by chassis id, management address and
//! system name, matched in that order — the strongest first.

use std::collections::{BTreeMap, BTreeSet};

use crate::ifname::mac;
use crate::model::*;

#[derive(Debug, Default)]
pub struct Identities {
    by_mac: BTreeMap<String, String>,
    by_ip: BTreeMap<String, String>,
    by_name: BTreeMap<String, String>,
    by_serial: BTreeMap<String, String>,
    /// collected device_id → node id
    pub of_device: BTreeMap<String, String>,
    /// LT-641: what each node is known to be, so a name match alone cannot
    /// fold a neighbour whose chassis or address says it is another box.
    macs_of: BTreeMap<String, BTreeSet<String>>,
    ips_of: BTreeMap<String, BTreeSet<String>>,
}

impl Identities {
    pub fn index(&mut self, node: &Node) {
        self.macs_of.entry(node.id.clone()).or_default().extend(node.macs.iter().cloned());
        self.ips_of.entry(node.id.clone()).or_default().extend(node.addresses.iter().map(|(ip, _, _, _)| ip.clone()).chain(node.mgmt_ip.clone()));
        for m in &node.macs {
            self.by_mac.entry(m.clone()).or_insert_with(|| node.id.clone());
        }
        for s in &node.serials {
            self.by_serial.entry(s.to_ascii_uppercase()).or_insert_with(|| node.id.clone());
        }
        for (ip, _, _, _) in &node.addresses {
            self.by_ip.entry(ip.clone()).or_insert_with(|| node.id.clone());
        }
        if let Some(ip) = &node.mgmt_ip {
            self.by_ip.entry(ip.clone()).or_insert_with(|| node.id.clone());
        }
        let n = name_key(&node.name);
        if !n.is_empty() {
            self.by_name.entry(n).or_insert_with(|| node.id.clone());
        }
    }

    /// The node a neighbour row points at: chassis id, then management
    /// address, then system name (domain stripped, case folded).
    pub fn find(&self, chassis: Option<&str>, ip: Option<&str>, name: Option<&str>, serial: Option<&str>) -> Option<String> {
        if let Some(m) = chassis.and_then(mac) {
            if let Some(id) = self.by_mac.get(&m) {
                return Some(id.clone());
            }
        }
        if let Some(s) = serial {
            if let Some(id) = self.by_serial.get(&s.to_ascii_uppercase()) {
                return Some(id.clone());
            }
        }
        if let Some(ip) = ip {
            if let Some(id) = self.by_ip.get(ip.trim()) {
                return Some(id.clone());
            }
        }
        if let Some(n) = name {
            if let Some(id) = self.by_name.get(&name_key(n)) {
                // LT-641: a name match is the weakest; a chassis or address the
                // row gives that this node does not have says it is another box.
                let other_mac = chassis.and_then(mac).is_some_and(|m| self.macs_of.get(id).is_some_and(|ms| !ms.is_empty() && !ms.contains(&m)));
                let other_ip = ip.map(str::trim).is_some_and(|a| self.ips_of.get(id).is_some_and(|is| !is.is_empty() && !is.contains(a)));
                if !other_mac && !other_ip {
                    return Some(id.clone());
                }
            }
        }
        None
    }

    pub fn by_mac(&self, m: &str) -> Option<&String> {
        self.by_mac.get(m)
    }

    pub fn by_ip(&self, ip: &str) -> Option<&String> {
        self.by_ip.get(ip)
    }
}

/// A system name reduced to what identifies it: case folded, any
/// `(serial)` NX-OS appends dropped, the domain dropped unless the name is
/// an address.
pub fn name_key(name: &str) -> String {
    let mut n = name.trim().to_ascii_lowercase();
    if let Some(i) = n.find('(') {
        n.truncate(i);
    }
    let n = n.trim().to_string();
    if n.parse::<std::net::IpAddr>().is_ok() {
        return n;
    }
    n.split('.').next().unwrap_or("").to_string()
}

/// The serial NX-OS puts in a CDP device id, `N9K-1(FDO12345678)`.
pub fn serial_in_name(name: &str) -> Option<String> {
    let open = name.find('(')?;
    let close = name[open..].find(')')? + open;
    let s = name[open + 1..close].trim();
    (s.len() >= 6 && s.chars().all(|c| c.is_ascii_alphanumeric())).then(|| s.to_string())
}

fn first<'a>(rows: &'a [Row], col: &str) -> Option<&'a str> {
    rows.iter().find_map(|r| r.get(col))
}

fn prompt_name(prompt: &str) -> Option<String> {
    let p = prompt.trim().trim_end_matches(['#', '>', '$', ' ']);
    let p = p.rsplit('@').next().unwrap_or(p);
    let p = p.split([':', '(', ' ']).next().unwrap_or("").trim_matches(['[', ']', '<', '>']);
    (!p.is_empty()).then(|| p.to_string())
}

pub fn collected_nodes(devices: &[DeviceIn], graph: &mut Graph, ids: &mut Identities) {
    for d in devices {
        let dev = d.rows("device");
        let name = first(dev, "hostname").map(str::to_string).or_else(|| prompt_name(&d.prompt)).unwrap_or_else(|| d.host.clone());
        let mut serials: BTreeSet<String> = BTreeSet::new();
        for r in dev {
            for s in r.list("serial") {
                serials.insert(s.trim_matches(['[', ']', '"', '\'']).to_ascii_uppercase());
            }
        }
        for r in d.rows("ha_pair") {
            if let Some(s) = r.get("serial") {
                serials.insert(s.to_ascii_uppercase());
            }
        }
        serials.retain(|s| s.len() >= 4);
        let mut macs: BTreeSet<String> = BTreeSet::new();
        for r in dev {
            if let Some(m) = r.get("base_mac").and_then(mac) {
                macs.insert(m);
            }
        }
        for r in d.rows("interface") {
            if let Some(m) = r.get("mac").and_then(mac) {
                macs.insert(m);
            }
        }
        let mut addresses = Vec::new();
        for r in d.rows("ip_address") {
            let Some(ip) = r.get("ip") else { continue };
            let (ip, plen) = split_prefix(ip, r.get("prefixlen"));
            if ip.parse::<std::net::IpAddr>().is_err() {
                continue;
            }
            addresses.push((ip.clone(), r.get("interface").map(str::to_string), plen, ip == d.host));
        }
        // Two collections of one box (reached on two addresses) are one node.
        let existing = serials.iter().find_map(|s| ids.by_serial.get(s).cloned()).or_else(|| macs.iter().find_map(|m| ids.by_mac.get(m).cloned()));
        if let Some(node_id) = existing {
            if let Some(n) = graph.nodes.iter_mut().find(|n| n.id == node_id) {
                n.device_ids.push(d.device_id.clone());
                n.serials.extend(serials);
                n.macs.extend(macs);
                n.addresses.extend(addresses);
                let clone = n.clone();
                ids.index(&clone);
            }
            ids.of_device.insert(d.device_id.clone(), node_id);
            continue;
        }
        let node = Node {
            id: format!("n-{}", d.device_id),
            name,
            kind: NodeKind::Collected,
            os: d.os.clone(),
            role: d.role.clone(),
            model: first(dev, "model").map(|m| m.trim_matches(['[', ']', '"', '\'']).split(',').next().unwrap_or(m).trim().to_string()),
            version: first(dev, "os_version").map(str::to_string),
            serials,
            macs,
            addresses,
            mgmt_ip: Some(d.host.clone()).filter(|h| h.parse::<std::net::IpAddr>().is_ok()),
            stack_kind: None,
            members: Vec::new(),
            pair: None,
            device_ids: vec![d.device_id.clone()],
            platform: first(dev, "model").map(str::to_string),
            capabilities: Vec::new(),
            routes: routes_of(d),
        };
        ids.of_device.insert(d.device_id.clone(), node.id.clone());
        ids.index(&node);
        graph.nodes.push(node);
    }
}

/// A collected device that names no MAC of its own — a FortiGate's
/// interface replies carry none — takes the MAC a neighbour's ARP table
/// gives for one of its own addresses (LT-569), so placement can find it.
/// Only an address no other node claims, and a MAC no other node has.
pub fn macs_from_arp(devices: &[DeviceIn], graph: &mut Graph, ids: &mut Identities) {
    let mut claims: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for n in &graph.nodes {
        for (ip, _, _, _) in &n.addresses {
            claims.entry(ip.as_str()).or_default().insert(n.id.as_str());
        }
    }
    let mut found: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for d in devices {
        let seen_by = ids.of_device.get(&d.device_id);
        for r in d.rows("arp") {
            let (Some(ip), Some(m)) = (r.get("ip"), r.get("mac").and_then(mac)) else { continue };
            let Some(owners) = claims.get(ip.trim()) else { continue };
            let [owner] = owners.iter().collect::<Vec<_>>()[..] else { continue };
            if Some(&owner.to_string()) == seen_by || ids.by_mac(&m).is_some() {
                continue;
            }
            found.entry(owner.to_string()).or_default().insert(m);
        }
    }
    for (id, macs) in found {
        let Some(n) = graph.nodes.iter_mut().find(|n| n.id == id && n.kind == NodeKind::Collected && n.macs.is_empty()) else { continue };
        n.macs = macs;
        let clone = n.clone();
        ids.index(&clone);
    }
}

/// The routing table's rows as routes: a prefix in CIDR form, its next hops.
fn routes_of(d: &DeviceIn) -> Vec<NodeRoute> {
    let mut out = Vec::new();
    for r in d.rows("route") {
        let Some(p) = r.get("prefix") else { continue };
        // LT-550: iproute2 and esxcli write the default route as `default`.
        let p = if p.eq_ignore_ascii_case("default") { if r.get("next_hop").map(|h| h.contains(':')).unwrap_or(false) { "::/0" } else { "0.0.0.0/0" } } else { p };
        let (net, plen) = split_prefix(p, r.get("mask"));
        let prefix = match plen {
            Some(l) => format!("{net}/{l}"),
            None if p.contains('/') => p.to_string(),
            None => continue,
        };
        let num = |c: &str| r.get(c).and_then(|v| v.trim().parse::<u32>().ok());
        out.push(NodeRoute {
            vrf: r.get("vrf").map(str::to_string).filter(|v| v != "default"),
            prefix,
            proto: r.get("proto").unwrap_or("").to_string(),
            next_hops: r.list("next_hop").into_iter().filter(|h| h.parse::<std::net::IpAddr>().map(|a| !a.is_unspecified()).unwrap_or(false)).collect(),
            interface: r.list("interface").into_iter().next(),
            ad: num("ad"),
            metric: num("metric"),
        });
    }
    out
}

/// `192.0.2.1/24`, or an address and a prefix length or a dotted mask.
pub fn split_prefix(ip: &str, len: Option<&str>) -> (String, Option<u8>) {
    if let Some((a, p)) = ip.split_once('/') {
        return (a.trim().to_string(), p.trim().parse().ok());
    }
    let plen = len.and_then(|l| {
        let l = l.trim().trim_start_matches('/');
        l.parse::<u8>().ok().or_else(|| mask_len(l))
    });
    (ip.trim().to_string(), plen)
}

fn mask_len(mask: &str) -> Option<u8> {
    let m: std::net::Ipv4Addr = mask.parse().ok()?;
    let bits = u32::from(m);
    (bits.leading_ones() + bits.trailing_zeros() == 32).then(|| bits.leading_ones() as u8)
}

/// Stacks (`show switch`, VSS/SVL, VSF, virtual chassis) become members of
/// the one node; vPC, MLAG and VSX pairs are two nodes marked as a pair.
pub fn stacks_and_pairs(devices: &[DeviceIn], graph: &mut Graph, ids: &Identities) {
    for d in devices {
        let Some(node_id) = ids.of_device.get(&d.device_id) else { continue };
        let rows = d.rows("ha_pair");
        let mut members = Vec::new();
        let mut stack_kind = None;
        let mut peer_name: Option<String> = None;
        let mut pair_kind = None;
        for r in rows {
            let cmd = r.command.as_str();
            let kind = if cmd.contains("stackwise_virtual") || cmd.contains("switch_virtual") {
                Some("svl")
            } else if cmd.starts_with("show_switch") || cmd.contains("stacking") {
                Some("stack")
            } else if cmd.contains("vsf") {
                Some("vsf")
            } else if cmd.contains("virtual_chassis") {
                Some("virtual_chassis")
            } else {
                None
            };
            if let Some(k) = kind {
                stack_kind = Some(k.to_string());
                if let Some(id) = r.get("member") {
                    members.push(Member {
                        id: id.to_string(),
                        role: r.get("role").map(str::to_string),
                        model: r.get("model").map(str::to_string),
                        serial: r.get("serial").map(str::to_string),
                        mac: r.get("mac").and_then(mac),
                    });
                }
                continue;
            }
            let pk = if cmd.contains("vpc") {
                Some("vpc")
            } else if cmd.contains("mlag") {
                Some("mlag")
            } else if cmd.contains("vsx") {
                Some("vsx")
            } else {
                None
            };
            if let Some(p) = pk {
                pair_kind = Some(p.to_string());
                if peer_name.is_none() {
                    peer_name = ["peer", "peer_address", "peer_ip", "peer_link", "keepalive"].iter().find_map(|k| r.extra.get(*k).and_then(|v| v.as_str()).map(str::to_string)).or_else(|| r.get("peer_link").map(str::to_string));
                }
            }
        }
        if let Some(n) = graph.nodes.iter_mut().find(|n| &n.id == node_id) {
            if members.len() > 1 {
                n.stack_kind = stack_kind;
                n.members = members;
                for m in &n.members {
                    if let Some(s) = &m.serial {
                        n.serials.insert(s.to_ascii_uppercase());
                    }
                }
            }
            if let Some(k) = pair_kind {
                n.pair = Some((k, peer_name.clone().unwrap_or_default()));
            }
        }
    }
    // A pair's peer, where it was collected too: resolve the note to its node.
    let snapshot: Vec<(String, String, String)> = graph.nodes.iter().filter_map(|n| n.pair.as_ref().map(|(k, p)| (n.id.clone(), k.clone(), p.clone()))).collect();
    for (id, kind, peer) in snapshot {
        let resolved = ids.find(None, Some(&peer), Some(&peer), None).filter(|p| p != &id);
        if let Some(n) = graph.nodes.iter_mut().find(|n| n.id == id) {
            n.pair = Some((kind, resolved.unwrap_or(peer)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_fold_to_what_identifies_them() {
        assert_eq!(name_key("SW2.lab.example.net"), "sw2");
        assert_eq!(name_key("N9K-1(FDO12345678)"), "n9k-1");
        assert_eq!(name_key("192.0.2.1"), "192.0.2.1");
        assert_eq!(serial_in_name("N9K-1(FDO12345678)").as_deref(), Some("FDO12345678"));
        assert_eq!(serial_in_name("SW1"), None);
    }

    #[test]
    fn prefixes_come_as_slash_length_or_mask() {
        assert_eq!(split_prefix("192.0.2.1/24", None), ("192.0.2.1".into(), Some(24)));
        assert_eq!(split_prefix("192.0.2.1", Some("255.255.255.0")), ("192.0.2.1".into(), Some(24)));
        assert_eq!(split_prefix("192.0.2.1", Some("30")), ("192.0.2.1".into(), Some(30)));
        assert_eq!(split_prefix("192.0.2.1", Some("255.0.255.0")), ("192.0.2.1".into(), None));
    }

    #[test]
    fn a_prompt_gives_a_name_when_the_device_table_does_not() {
        assert_eq!(prompt_name("SW1#").as_deref(), Some("SW1"));
        assert_eq!(prompt_name("admin@fw1>").as_deref(), Some("fw1"));
        assert_eq!(prompt_name("FGT60F (root) #").as_deref(), Some("FGT60F"));
        assert_eq!(prompt_name("cumulus@leaf1:mgmt:~$").as_deref(), Some("leaf1"));
    }
}
