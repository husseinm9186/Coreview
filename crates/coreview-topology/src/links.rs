//! Cables. Every CDP/LLDP row is one device's claim about one of its ports;
//! the same cable claimed from both ends is one link at 1.0, from one end at
//! 0.7, and each keeps the rows it came from. Then bundles: member cables of
//! a LAG fold into one logical link that lists them, and a bundle whose
//! members do not agree is a finding rather than a silent fold.

use std::collections::{BTreeMap, BTreeSet};

use crate::identity::{name_key, serial_in_name, Identities};
use crate::ifname::{canonical, key, mac, port_id, PortId};
use crate::model::*;

/// node id → (MAC → port) from each collected device's interface table.
fn port_by_mac(devices: &[DeviceIn], ids: &Identities) -> BTreeMap<String, BTreeMap<String, String>> {
    let mut out: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for d in devices {
        let Some(node) = ids.of_device.get(&d.device_id) else { continue };
        for r in d.rows("interface") {
            if let (Some(m), Some(name)) = (r.get("mac").and_then(mac), r.get("name")) {
                out.entry(node.clone()).or_default().entry(m).or_insert_with(|| canonical(name));
            }
        }
    }
    out
}

struct Claim {
    from: String,
    from_port: String,
    to: String,
    to_port: Option<String>,
    kind: LinkKind,
    evidence: Evidence,
}

pub fn neighbor_links(devices: &[DeviceIn], graph: &mut Graph, ids: &mut Identities) {
    let macs = port_by_mac(devices, ids);
    let mut claims: Vec<Claim> = Vec::new();
    for d in devices {
        let Some(from) = ids.of_device.get(&d.device_id).cloned() else { continue };
        for r in d.rows("neighbor") {
            let Some(local) = r.get("local_if") else { continue };
            let name = r.get("rem_sysname");
            let serial = name.and_then(serial_in_name);
            let ip = r.get("rem_mgmt_ip").map(|s| s.split([',', ' ']).next().unwrap_or(s).to_string());
            let chassis = r.get("rem_chassis_id");
            let to = match ids.find(chassis, ip.as_deref(), name, serial.as_deref()) {
                Some(t) => t,
                None => placeholder(graph, ids, r, name, chassis, ip.as_deref(), serial),
            };
            if to == from {
                continue;
            }
            let to_port = match port_id(r.get("rem_port_id").unwrap_or("")) {
                PortId::Name(n) => Some(canonical(&n)),
                PortId::Mac(m) => macs.get(&to).and_then(|p| p.get(&m).cloned()).or_else(|| r.get("rem_port_descr").map(canonical)),
                // AOS-S and FortiSwitch name a port by its number; an ifIndex
                // looks the same. The description, where given, is the name.
                PortId::IfIndex(i) => r.get("rem_port_descr").map(canonical).or_else(|| Some(i.to_string())),
                PortId::Empty => r.get("rem_port_descr").map(canonical),
            };
            let proto = r.get("proto").unwrap_or("lldp");
            let kind = match proto {
                "cdp" => LinkKind::Cdp,
                "api" => LinkKind::Api,
                _ => LinkKind::Lldp,
            };
            claims.push(Claim {
                from: from.clone(),
                from_port: canonical(local),
                to,
                to_port: to_port.clone(),
                kind,
                evidence: Evidence {
                    device: d.device_id.clone(),
                    command: r.command.clone(),
                    note: format!("{} says {} on {} is {}{}", proto.to_uppercase(), name.unwrap_or("a neighbour"), local, r.get("rem_port_id").unwrap_or("an unnamed port"), ip.as_deref().map(|i| format!(" ({i})")).unwrap_or_default()),
                },
            });
        }
    }
    // One link per cable: keyed by both ends, whichever end spoke.
    let mut by_key: BTreeMap<(String, String, String, String), usize> = BTreeMap::new();
    let mut links: Vec<Link> = Vec::new();
    let mut spoke: Vec<BTreeSet<String>> = Vec::new();
    for c in claims {
        let near = (c.from.clone(), key(&c.from_port));
        let far_port_key = c.to_port.as_deref().map(key);
        // A claim whose far port is unknown matches the reverse claim on the
        // near port, if the other end spoke about it.
        let existing = match &far_port_key {
            Some(fk) => {
                let (a, b) = order(near.clone(), (c.to.clone(), fk.clone()));
                by_key.get(&(a.0, a.1, b.0, b.1)).copied()
            }
            None => links.iter().position(|l| (l.a.node == c.to && l.b.node == c.from && l.b.port.as_deref().map(key) == Some(near.1.clone())) || (l.b.node == c.to && l.a.node == c.from && l.a.port.as_deref().map(key) == Some(near.1.clone()))),
        };
        match existing {
            Some(i) => {
                let l = &mut links[i];
                spoke[i].insert(c.from.clone());
                if spoke[i].len() > 1 {
                    l.both_directions = true;
                    l.confidence = 1.0;
                }
                // Fill a port the first claim did not know.
                if l.a.node == c.to && l.a.port.is_none() {
                    l.a.port = c.to_port.clone();
                }
                if l.b.node == c.to && l.b.port.is_none() {
                    l.b.port = c.to_port.clone();
                }
                l.evidence.push(c.evidence);
            }
            None => {
                let link = Link {
                    a: End { node: c.from.clone(), port: Some(c.from_port.clone()) },
                    b: End { node: c.to.clone(), port: c.to_port.clone() },
                    kind: c.kind,
                    confidence: 0.7,
                    both_directions: false,
                    bundle: None,
                    evidence: vec![c.evidence],
                };
                let i = links.len();
                if let Some(fk) = far_port_key {
                    let (a, b) = order(near, (c.to.clone(), fk));
                    by_key.insert((a.0, a.1, b.0, b.1), i);
                }
                links.push(link);
                spoke.push([c.from].into_iter().collect());
            }
        }
    }
    graph.links.extend(links);
}

fn order(a: (String, String), b: (String, String)) -> ((String, String), (String, String)) {
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

/// A neighbour nobody collected: drawn from what its neighbour said of it.
fn placeholder(graph: &mut Graph, ids: &mut Identities, r: &Row, name: Option<&str>, chassis: Option<&str>, ip: Option<&str>, serial: Option<String>) -> String {
    let label = name.map(|n| n.split('(').next().unwrap_or(n).trim().to_string()).or_else(|| ip.map(str::to_string)).or_else(|| chassis.map(str::to_string)).unwrap_or_else(|| "unnamed neighbour".into());
    let id = format!("p-{}", name.map(name_key).filter(|k| !k.is_empty()).or_else(|| chassis.and_then(mac)).or_else(|| ip.map(str::to_string)).unwrap_or_else(|| label.clone()));
    if graph.nodes.iter().any(|n| n.id == id) {
        return id;
    }
    let node = Node {
        id: id.clone(),
        name: label,
        kind: NodeKind::Neighbor,
        os: None,
        role: None,
        model: r.get("rem_platform").map(str::to_string),
        version: None,
        serials: serial.into_iter().collect(),
        macs: chassis.and_then(mac).into_iter().collect(),
        addresses: ip.map(|i| vec![(i.to_string(), None, None, true)]).unwrap_or_default(),
        mgmt_ip: ip.map(str::to_string),
        stack_kind: None,
        members: Vec::new(),
        pair: None,
        device_ids: Vec::new(),
        platform: r.get("rem_platform").map(str::to_string),
        capabilities: r.list("rem_caps"),
        routes: Vec::new(),
    };
    ids.index(&node);
    graph.nodes.push(node);
    id
}

/// A bundle's member ports, flags such as `(P)` stripped.
fn members_of(r: &Row) -> Vec<String> {
    let mut out: Vec<String> = r.list("members").into_iter().map(|m| m.split('(').next().unwrap_or(&m).trim().to_string()).filter(|m| !m.is_empty()).collect();
    if let Some(serde_json::Value::Array(a)) = r.extra.get("member_interface").or_else(|| r.extra.get("members")) {
        out.extend(a.iter().filter_map(|v| v.as_str()).map(|s| s.split('(').next().unwrap_or(s).trim().to_string()));
    }
    out.sort();
    out.dedup();
    out
}

pub fn collapse_bundles(devices: &[DeviceIn], graph: &mut Graph, ids: &Identities) {
    // node → member port key → (bundle name, all member keys)
    let mut bundle_of: BTreeMap<String, BTreeMap<String, (String, Vec<String>)>> = BTreeMap::new();
    for d in devices {
        let Some(node) = ids.of_device.get(&d.device_id) else { continue };
        for r in d.rows("lag") {
            let Some(name) = r.get("name") else { continue };
            let members = members_of(r);
            let keys: Vec<String> = members.iter().map(|m| key(m)).collect();
            for k in &keys {
                bundle_of.entry(node.clone()).or_default().insert(k.clone(), (canonical(name), keys.clone()));
            }
        }
    }
    let lookup = |node: &str, port: &Option<String>| -> Option<(String, Vec<String>)> { port.as_deref().and_then(|p| bundle_of.get(node).and_then(|m| m.get(&key(p)).cloned())) };
    // Group member links by (a node, a bundle, b node).
    let mut groups: BTreeMap<(String, String, String), Vec<usize>> = BTreeMap::new();
    for (i, l) in graph.links.iter().enumerate() {
        let (ba, bb) = (lookup(&l.a.node, &l.a.port), lookup(&l.b.node, &l.b.port));
        // Order-independent: when both ends list the bundle, the smaller
        // (node, bundle) is the near side whichever end first spoke.
        let (near, bundle, far) = match (&ba, &bb) {
            (Some(x), Some(y)) => {
                if (&l.a.node, &x.0) <= (&l.b.node, &y.0) {
                    (l.a.node.clone(), x.0.clone(), l.b.node.clone())
                } else {
                    (l.b.node.clone(), y.0.clone(), l.a.node.clone())
                }
            }
            (Some(b), None) => (l.a.node.clone(), b.0.clone(), l.b.node.clone()),
            (None, Some(b)) => (l.b.node.clone(), b.0.clone(), l.a.node.clone()),
            (None, None) => continue,
        };
        groups.entry((near, bundle, far)).or_default().push(i);
    }
    let mut remove: BTreeSet<usize> = BTreeSet::new();
    let mut add: Vec<Link> = Vec::new();
    let mut by_bundle: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    for ((near, bundle, far), idx) in &groups {
        by_bundle.entry((near.clone(), bundle.clone())).or_default().insert(far.clone());
        let mut members = Vec::new();
        let mut evidence = Vec::new();
        let mut both = false;
        let mut conf: f32 = 0.0;
        let mut far_bundle: Option<String> = None;
        let mut kind = LinkKind::Lldp;
        for &i in idx {
            let l = &graph.links[i];
            let (np, fp) = if &l.a.node == near { (&l.a, &l.b) } else { (&l.b, &l.a) };
            members.push((np.port.clone().unwrap_or_default(), fp.port.clone().unwrap_or_default()));
            if far_bundle.is_none() {
                far_bundle = lookup(far, &fp.port).map(|b| b.0);
            }
            evidence.extend(l.evidence.iter().cloned());
            both |= l.both_directions;
            conf = conf.max(l.confidence);
            kind = l.kind;
            remove.insert(i);
        }
        members.sort();
        add.push(Link {
            a: End { node: near.clone(), port: Some(bundle.clone()) },
            b: End { node: far.clone(), port: far_bundle },
            kind,
            confidence: conf,
            both_directions: both,
            bundle: Some(Bundle { a_name: Some(bundle.clone()), b_name: None, members }),
            evidence,
        });
    }
    for l in add.iter_mut() {
        l.bundle.as_mut().unwrap().b_name = l.b.port.clone();
    }
    // Findings: a bundle whose cables reach two different boxes (unless the
    // two are a vPC/MLAG/VSX pair), and members with no cable seen.
    for ((node, bundle), fars) in &by_bundle {
        let fars: Vec<&String> = fars.iter().collect();
        if fars.len() > 1 {
            let paired = fars.len() == 2 && graph.node(fars[0]).and_then(|n| n.pair.as_ref()).map(|p| &p.1 == fars[1]).unwrap_or(false);
            if !paired {
                graph.findings.push(Finding { kind: "bundle_spans_devices".into(), note: format!("{bundle} on {} has members cabled to {} different devices", name_of(graph, node), fars.len()), nodes: std::iter::once(node.clone()).chain(fars.iter().map(|s| (*s).clone())).collect() });
            }
        }
        if let Some((_, all)) = bundle_of.get(node).and_then(|m| m.values().find(|(n, _)| n == bundle)) {
            let cabled: usize = add.iter().filter(|l| &l.a.node == node && l.a.port.as_deref() == Some(bundle.as_str())).map(|l| l.bundle.as_ref().map(|b| b.members.len()).unwrap_or(0)).sum();
            if cabled < all.len() {
                graph.findings.push(Finding { kind: "bundle_member_unseen".into(), note: format!("{bundle} on {} lists {} members; a neighbour was seen on {}", name_of(graph, node), all.len(), cabled), nodes: vec![node.clone()] });
            }
        }
    }
    let kept: Vec<Link> = graph.links.drain(..).enumerate().filter(|(i, _)| !remove.contains(i)).map(|(_, l)| l).collect();
    graph.links = kept;
    graph.links.extend(add);
}

fn name_of(graph: &Graph, id: &str) -> String {
    graph.node(id).map(|n| n.name.clone()).unwrap_or_else(|| id.to_string())
}
