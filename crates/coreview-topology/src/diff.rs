//! Two collection runs compared: what appeared, what went, what
//! changed — devices, links, CDP/LLDP neighbours, routing neighbours, routes
//! and overlays. A device is the same device across runs when a serial or a
//! MAC is shared, else when its name is, never because a run reached it on
//! the same address; one renamed box is "renamed", not one lost and one new.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::identity::name_key;
use crate::ifname::key;
use crate::model::*;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// `device`, `link`, `neighbor`, `routing_neighbor`, `route`, `overlay`.
    pub kind: String,
    /// `new`, `lost`, `changed`.
    pub change: String,
    /// What it is about, in words: `SW1 Gi1/0/1 — SW2 Gi1/0/2`.
    pub subject: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Count {
    pub kind: String,
    pub new: usize,
    pub lost: usize,
    pub changed: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunDiff {
    pub changes: Vec<Change>,
    pub counts: Vec<Count>,
}

/// One run: its devices and the graph built from them.
pub struct Side<'a> {
    pub graph: &'a Graph,
    pub devices: &'a [DeviceIn],
}

/// Each node of `after` → the name of the `before` node it is, when it is one.
fn match_nodes(before: &Graph, after: &Graph) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut taken: BTreeSet<String> = BTreeSet::new();
    // Strongest evidence first, across every node, so a name match never
    // takes a box a serial would have claimed.
    type Test = fn(&Node, &Node) -> bool;
    let tests: [Test; 3] = [
        |a, b| a.serials.iter().any(|s| b.serials.contains(s)),
        |a, b| a.macs.iter().any(|m| b.macs.contains(m)),
        |a, b| !name_key(&a.name).is_empty() && name_key(&a.name) == name_key(&b.name),
    ];
    for test in tests {
        for n in &after.nodes {
            if out.contains_key(&n.id) {
                continue;
            }
            if let Some(b) = before.nodes.iter().find(|b| b.kind == n.kind && !taken.contains(&b.id) && test(n, b)) {
                taken.insert(b.id.clone());
                out.insert(n.id.clone(), b.name.clone());
            }
        }
    }
    out
}

/// The name a node goes by in both runs: the earlier run's, when matched.
struct Names {
    of: BTreeMap<String, String>,
}

impl Names {
    fn get(&self, id: &str) -> String {
        self.of.get(id).cloned().unwrap_or_else(|| id.to_string())
    }
}

fn names_for(g: &Graph, matched: Option<&BTreeMap<String, String>>) -> Names {
    Names { of: g.nodes.iter().map(|n| (n.id.clone(), matched.and_then(|m| m.get(&n.id).cloned()).unwrap_or_else(|| n.name.clone()))).collect() }
}

fn link_key(names: &Names, l: &Link) -> (String, String) {
    let a = format!("{}\u{0}{}", name_key(&names.get(&l.a.node)), l.a.port.as_deref().map(key).unwrap_or_default());
    let b = format!("{}\u{0}{}", name_key(&names.get(&l.b.node)), l.b.port.as_deref().map(key).unwrap_or_default());
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

fn link_words(names: &Names, l: &Link) -> String {
    let end = |e: &End| format!("{}{}", names.get(&e.node), e.port.as_deref().map(|p| format!(" {}", crate::ifname::short(p))).unwrap_or_default());
    format!("{} — {}", end(&l.a), end(&l.b))
}

fn how_seen(l: &Link) -> String {
    let kind = serde_json::to_value(l.kind).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
    format!("{kind}, confidence {:.1}", l.confidence)
}

/// A collected device's name in the shared naming, from its device id.
fn device_names<'a>(g: &'a Graph, names: &'a Names) -> impl Fn(&str) -> Option<String> + 'a {
    move |device_id: &str| g.nodes.iter().find(|n| n.device_ids.iter().any(|d| d == device_id)).map(|n| names.get(&n.id))
}

pub fn diff(before: Side, after: Side) -> RunDiff {
    let matched = match_nodes(before.graph, after.graph);
    let bn = names_for(before.graph, None);
    let an = names_for(after.graph, Some(&matched));
    let mut changes: Vec<Change> = Vec::new();
    let mut push = |kind: &str, change: &str, subject: String, b: String, a: String| changes.push(Change { kind: kind.into(), change: change.into(), subject, before: b, after: a });

    // Devices: the collected ones.
    let collected = |g: &Graph| g.nodes.iter().filter(|n| n.kind == NodeKind::Collected).map(|n| n.id.clone()).collect::<Vec<_>>();
    let before_names: BTreeSet<String> = collected(before.graph).iter().map(|id| bn.get(id)).collect();
    for id in collected(after.graph) {
        let n = after.graph.node(&id).unwrap();
        match matched.get(&id) {
            Some(was) if before_names.contains(was) => {
                if name_key(was) != name_key(&n.name) {
                    push("device", "changed", was.clone(), format!("named {was}"), format!("named {}", n.name));
                }
                let b = before.graph.nodes.iter().find(|x| &x.name == was).unwrap();
                if b.version != n.version && b.version.is_some() && n.version.is_some() {
                    push("device", "changed", was.clone(), format!("version {}", b.version.clone().unwrap_or_default()), format!("version {}", n.version.clone().unwrap_or_default()));
                }
            }
            _ => push("device", "new", n.name.clone(), String::new(), n.model.clone().or(n.os.clone()).unwrap_or_default()),
        }
    }
    let after_names: BTreeSet<String> = collected(after.graph).iter().map(|id| an.get(id)).collect();
    for id in collected(before.graph) {
        let name = bn.get(&id);
        if !after_names.contains(&name) {
            let n = before.graph.node(&id).unwrap();
            push("device", "lost", name, n.model.clone().or(n.os.clone()).unwrap_or_default(), String::new());
        }
    }

    // Links, by their two ends.
    let bl: BTreeMap<(String, String), &Link> = before.graph.links.iter().map(|l| (link_key(&bn, l), l)).collect();
    let al: BTreeMap<(String, String), &Link> = after.graph.links.iter().map(|l| (link_key(&an, l), l)).collect();
    for (k, l) in &al {
        match bl.get(k) {
            None => push("link", "new", link_words(&an, l), String::new(), how_seen(l)),
            Some(b) if (b.confidence - l.confidence).abs() > f32::EPSILON => push("link", "changed", link_words(&an, l), how_seen(b), how_seen(l)),
            _ => {}
        }
    }
    for (k, l) in &bl {
        if !al.contains_key(k) {
            push("link", "lost", link_words(&bn, l), how_seen(l), String::new());
        }
    }

    // CDP/LLDP neighbours, as each device said.
    let neighbours = |side: &Side, names: &Names| -> BTreeMap<(String, String, String), (String, String)> {
        let dn = device_names(side.graph, names);
        let mut out = BTreeMap::new();
        for d in side.devices {
            let Some(me) = dn(&d.device_id) else { continue };
            for r in d.rows("neighbor") {
                let far = r.get("rem_sysname").or(r.get("rem_chassis_id")).unwrap_or("").to_string();
                let local = r.get("local_if").unwrap_or("").to_string();
                let port = r.get("rem_port_id").unwrap_or("").to_string();
                out.insert((me.clone(), key(&local), name_key(&far)), (format!("{me} {} → {far}", crate::ifname::short(&local)), port));
            }
        }
        out
    };
    let bnb = neighbours(&before, &bn);
    let anb = neighbours(&after, &an);
    for (k, (words, port)) in &anb {
        match bnb.get(k) {
            None => push("neighbor", "new", words.clone(), String::new(), port.clone()),
            Some((_, was)) if key(was) != key(port) => push("neighbor", "changed", words.clone(), was.clone(), port.clone()),
            _ => {}
        }
    }
    for (k, (words, port)) in &bnb {
        if !anb.contains_key(k) {
            push("neighbor", "lost", words.clone(), port.clone(), String::new());
        }
    }

    // Routing neighbours, and their state.
    let peers = |side: &Side, names: &Names| -> BTreeMap<(String, String, String), (String, String)> {
        let dn = device_names(side.graph, names);
        let mut out = BTreeMap::new();
        for d in side.devices {
            let Some(me) = dn(&d.device_id) else { continue };
            for r in d.rows("routing_neighbor") {
                let who = r.get("neighbor_ip").or(r.get("neighbor_id")).unwrap_or("").to_string();
                let proto = r.get("proto").unwrap_or("").to_ascii_lowercase();
                out.insert((me.clone(), proto.clone(), who.clone()), (format!("{me} {proto} {who}"), r.get("state").unwrap_or("").to_string()));
            }
        }
        out
    };
    let bp = peers(&before, &bn);
    let ap = peers(&after, &an);
    for (k, (words, state)) in &ap {
        match bp.get(k) {
            None => push("routing_neighbor", "new", words.clone(), String::new(), state.clone()),
            Some((_, was)) if was != state => push("routing_neighbor", "changed", words.clone(), was.clone(), state.clone()),
            _ => {}
        }
    }
    for (k, (words, state)) in &bp {
        if !ap.contains_key(k) {
            push("routing_neighbor", "lost", words.clone(), state.clone(), String::new());
        }
    }

    // Routes, per device and VRF.
    let routes = |g: &Graph, names: &Names| -> BTreeMap<(String, String, String), String> {
        let mut out = BTreeMap::new();
        for n in g.nodes.iter().filter(|n| n.kind == NodeKind::Collected) {
            let me = names.get(&n.id);
            for r in &n.routes {
                let mut hops = r.next_hops.clone();
                hops.sort();
                let via = if hops.is_empty() { r.interface.clone().unwrap_or_default() } else { hops.join(", ") };
                out.insert((me.clone(), r.vrf.clone().unwrap_or_else(|| "default".into()), r.prefix.clone()), format!("{} via {via}", r.proto));
            }
        }
        out
    };
    let br = routes(before.graph, &bn);
    let ar = routes(after.graph, &an);
    let words = |(dev, vrf, prefix): &(String, String, String)| if vrf == "default" { format!("{dev} {prefix}") } else { format!("{dev} {prefix} (VRF {vrf})") };
    for (k, v) in &ar {
        match br.get(k) {
            None => push("route", "new", words(k), String::new(), v.clone()),
            Some(was) if was != v => push("route", "changed", words(k), was.clone(), v.clone()),
            _ => {}
        }
    }
    for (k, v) in &br {
        if !ar.contains_key(k) {
            push("route", "lost", words(k), v.clone(), String::new());
        }
    }

    // Overlays.
    let overlays = |g: &Graph, names: &Names| -> BTreeMap<(String, String, String), String> {
        g.overlays
            .iter()
            .map(|o| {
                let far = o.b.as_deref().map(|b| names.get(b)).or(o.remote_ip.clone()).unwrap_or_default();
                ((names.get(&o.a), o.kind.clone(), far.clone()), format!("{} {} to {far}{}", names.get(&o.a), o.kind, o.name.as_deref().map(|n| format!(" ({n})")).unwrap_or_default()))
            })
            .collect()
    };
    let bo = overlays(before.graph, &bn);
    let ao = overlays(after.graph, &an);
    for (k, w) in &ao {
        if !bo.contains_key(k) {
            push("overlay", "new", w.clone(), String::new(), k.1.clone());
        }
    }
    for (k, w) in &bo {
        if !ao.contains_key(k) {
            push("overlay", "lost", w.clone(), k.1.clone(), String::new());
        }
    }

    let mut counts: Vec<Count> = Vec::new();
    for kind in ["device", "link", "neighbor", "routing_neighbor", "route", "overlay"] {
        let of = |c: &str| changes.iter().filter(|x| x.kind == kind && x.change == c).count();
        counts.push(Count { kind: kind.into(), new: of("new"), lost: of("lost"), changed: of("changed") });
    }
    RunDiff { changes, counts }
}
