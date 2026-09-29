//! Placing what does not announce itself (the spec's non-LLDP devices). A
//! box with no CDP/LLDP link — an ASA, an unmanaged switch's clients — is
//! placed where its MAC is learned: of every switch port that learned it,
//! the one with the fewest MACs behind it is its own (the others are
//! transit), and the link is drawn as inferred at 0.6 with the MAC-table row
//! as its evidence. A port with a crowd behind it and nobody announcing is an
//! unknown switch; a port with exactly one stranger is an endpoint.

use std::collections::{BTreeMap, BTreeSet};

use crate::identity::Identities;
use crate::ifname::{canonical, key, mac};
use crate::model::*;

/// Ports whose MACs are not a device plugged in: the CPU, the router, a VLAN
/// interface, a stack or fabric port.
fn not_a_cable(port: &str) -> bool {
    let p = port.to_ascii_lowercase();
    p.is_empty() || p.starts_with("cpu") || p.starts_with("router") || p.starts_with("sup") || p.starts_with("vlan") || p.starts_with("vl") && p[2..].chars().all(|c| c.is_ascii_digit()) || p == "drop" || p.starts_with("switch") || p.starts_with("stack") || p.starts_with("nve") || p.starts_with("vpc-peer") || p.contains("peer-link")
}

/// How many distinct MACs make a crowd rather than a device.
pub const CROWD: usize = 3;

pub fn mac_placements(devices: &[DeviceIn], graph: &mut Graph, ids: &mut Identities) {
    // Ports that already carry a CDP/LLDP link: their MACs are the far side's world.
    let mut linked: BTreeSet<(String, String)> = BTreeSet::new();
    let mut has_link: BTreeSet<String> = BTreeSet::new();
    for l in &graph.links {
        for e in [&l.a, &l.b] {
            has_link.insert(e.node.clone());
            if let Some(p) = &e.port {
                linked.insert((e.node.clone(), key(p)));
            }
            if let Some(b) = &l.bundle {
                for (x, y) in &b.members {
                    linked.insert((l.a.node.clone(), key(x)));
                    linked.insert((l.b.node.clone(), key(y)));
                }
            }
        }
    }
    // Every ARP table, for putting an address to a MAC.
    let mut ip_of: BTreeMap<String, String> = BTreeMap::new();
    for d in devices {
        for r in d.rows("arp") {
            if let (Some(m), Some(ip)) = (r.get("mac").and_then(mac), r.get("ip")) {
                ip_of.entry(m).or_insert_with(|| ip.to_string());
            }
        }
    }
    // (switch node, port) → MACs behind it, with the row that said so.
    struct Seen {
        port: String,
        vlan: Option<String>,
        command: String,
        device: String,
    }
    let mut behind: BTreeMap<(String, String), BTreeMap<String, Seen>> = BTreeMap::new();
    for d in devices {
        let Some(sw) = ids.of_device.get(&d.device_id).cloned() else { continue };
        let own: BTreeSet<String> = graph.node(&sw).map(|n| n.macs.clone()).unwrap_or_default();
        for r in d.rows("mac_table") {
            let (Some(m), Some(port)) = (r.get("mac").and_then(mac), r.get("interface")) else { continue };
            let port = port.split([',', ' ']).next().unwrap_or(port);
            if not_a_cable(port) || own.contains(&m) || linked.contains(&(sw.clone(), key(port))) {
                continue;
            }
            let t = r.get("type").unwrap_or("").to_ascii_lowercase();
            if t.contains("static") && !t.contains("dynamic") && !t.contains("learn") {
                continue;
            }
            behind.entry((sw.clone(), key(port))).or_default().entry(m).or_insert(Seen { port: canonical(port), vlan: r.get("vlan").map(str::to_string), command: r.command.clone(), device: d.device_id.clone() });
        }
    }
    // Known boxes with no CDP/LLDP link: place each at its quietest port.
    let mut best: BTreeMap<String, (usize, (String, String), String)> = BTreeMap::new();
    for ((sw, pk), macs) in &behind {
        for m in macs.keys() {
            let Some(node) = ids.by_mac(m).cloned() else { continue };
            if node == *sw || has_link.contains(&node) {
                continue;
            }
            let pop = macs.len();
            let better = best.get(&node).map(|(p, _, _)| pop < *p).unwrap_or(true);
            if better {
                best.insert(node, (pop, (sw.clone(), pk.clone()), m.clone()));
            }
        }
    }
    let mut placed_ports: BTreeSet<(String, String)> = BTreeSet::new();
    for (node, (pop, (sw, pk), m)) in &best {
        let seen = &behind[&(sw.clone(), pk.clone())][m];
        graph.links.push(Link {
            a: End { node: sw.clone(), port: Some(seen.port.clone()) },
            b: End { node: node.clone(), port: None },
            kind: LinkKind::InferredMac,
            confidence: 0.6,
            both_directions: false,
            bundle: None,
            evidence: vec![Evidence {
                device: seen.device.clone(),
                command: seen.command.clone(),
                note: format!("MAC {m} of {} learned on {}{} ({pop} MAC{} on that port); no CDP/LLDP neighbour there", name(graph, node), seen.port, seen.vlan.as_deref().map(|v| format!(" in VLAN {v}")).unwrap_or_default(), if *pop == 1 { "" } else { "s" }),
            }],
        });
        placed_ports.insert((sw.clone(), pk.clone()));
    }
    // What remains: crowds become unknown switches, lone strangers endpoints.
    let mut unknown = Vec::new();
    for ((sw, pk), macs) in &behind {
        if placed_ports.contains(&(sw.clone(), pk.clone())) {
            continue;
        }
        let strangers: Vec<(&String, &Seen)> = macs.iter().filter(|(m, _)| ids.by_mac(m).is_none()).collect();
        if strangers.len() >= CROWD {
            let (_, first) = strangers[0];
            // The crowd itself, so the page can hang it off the unknown switch.
            for (m, s) in &strangers {
                graph.endpoints.push(Endpoint { switch: sw.clone(), port: s.port.clone(), mac: (*m).clone(), ip: ip_of.get(*m).cloned(), vlan: s.vlan.clone() });
            }
            let id = format!("u-{sw}-{pk}");
            unknown.push((
                Node {
                    id: id.clone(),
                    name: format!("Unknown switch on {} {}", name(graph, sw), first.port),
                    kind: NodeKind::UnknownSwitch,
                    os: None,
                    role: Some("switch".into()),
                    model: None,
                    version: None,
                    serials: BTreeSet::new(),
                    macs: BTreeSet::new(),
                    addresses: Vec::new(),
                    mgmt_ip: None,
                    stack_kind: None,
                    members: Vec::new(),
                    pair: None,
                    device_ids: Vec::new(),
                    platform: None,
                    capabilities: Vec::new(),
                    routes: Vec::new(),
                },
                Link {
                    a: End { node: sw.clone(), port: Some(first.port.clone()) },
                    b: End { node: id, port: None },
                    kind: LinkKind::InferredMac,
                    confidence: 0.6,
                    both_directions: false,
                    bundle: None,
                    evidence: vec![Evidence { device: first.device.clone(), command: first.command.clone(), note: format!("{} MACs learned on {} and no CDP/LLDP neighbour there: something unmanaged is behind it", strangers.len(), first.port) }],
                },
            ));
        } else if strangers.len() == 1 {
            let (m, s) = strangers[0];
            graph.endpoints.push(Endpoint { switch: sw.clone(), port: s.port.clone(), mac: m.clone(), ip: ip_of.get(m).cloned(), vlan: s.vlan.clone() });
        }
    }
    for (n, l) in unknown {
        graph.nodes.push(n);
        graph.links.push(l);
    }
}

fn name(graph: &Graph, id: &str) -> String {
    graph.node(id).map(|n| n.name.clone()).unwrap_or_else(|| id.to_string())
}
