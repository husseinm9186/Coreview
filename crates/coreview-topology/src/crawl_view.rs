//! The graph as the review screen already reads it (the approved choice for
//! Build in Rust, feed the existing review and diagram code). A
//! collected node is a `CrawledDevice` whose `neighbors` are its CDP/LLDP
//! links (a bundle's members each, with the bundle in `port_channels`, which
//! is how the page folds a LAG), whose `attached` are the devices and
//! endpoints placed on its ports by MAC (which is how the page draws what is
//! inferred, and how it finds a crowd behind a port), and whose `stack` holds
//! its members. A neighbour nobody collected is in `not_visited`. The types
//! are the crawl's own, so the stored run is exactly what a crawl stores.

use std::collections::{BTreeMap, BTreeSet};

use coreview_discover::crawl::{AttachedDevice, CrawledDevice, DeviceDetails, ReachedBy};
use coreview_discover::etherchannel::PortChannel;
use coreview_discover::routes::Route;
use coreview_discover::stacking::{StackInfo, StackKind, StackMember};
use coreview_discover::types::{DeviceAddress, DeviceClass, Neighbor, Protocol};

use crate::ifname::short;
use crate::model::*;

pub struct CrawlView {
    pub devices: Vec<CrawledDevice>,
    pub not_visited: Vec<Neighbor>,
}

/// The review toggles (the approved P2 plan): what goes to the page.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ViewOptions {
    /// A bundle's cables folded into one link (the page folds on `port_channels`).
    pub collapse_bundles: bool,
    /// A stack drawn as one node with its members; off, as the box it was reached on.
    pub collapse_stacks: bool,
    /// Neighbours nobody collected, and unknown switches' crowds.
    pub placeholders: bool,
    /// Links below this are left out: 1.0 seen from both ends, 0.7 one end, 0.6 by MAC.
    pub min_confidence: f32,
    /// Only endpoints and MAC placements in this VLAN.
    pub vlan: Option<String>,
    /// Only this VRF's routes (`default` for the global table).
    pub vrf: Option<String>,
    /// The run's seeds (addresses or names), where hop 0 is. Empty,
    /// the first collected device is the seed.
    pub seeds: Vec<String>,
}

impl Default for ViewOptions {
    fn default() -> Self {
        ViewOptions { collapse_bundles: true, collapse_stacks: true, placeholders: true, min_confidence: 0.0, vlan: None, vrf: None, seeds: Vec::new() }
    }
}

/// Each node's distance from the seeds over the graph's links, which
/// is the row the page draws it on. A node no link reaches sits one past the
/// furthest reached.
fn hops_from_seeds(graph: &Graph, seeds: &[String]) -> BTreeMap<String, usize> {
    let is_seed = |n: &Node| {
        seeds.iter().any(|s| {
            let s = s.trim();
            n.mgmt_ip.as_deref() == Some(s) || n.addresses.iter().any(|(ip, _, _, _)| ip == s) || n.device_ids.iter().any(|d| d == s) || n.name.eq_ignore_ascii_case(s)
        })
    };
    let mut adjacent: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for l in &graph.links {
        adjacent.entry(l.a.node.as_str()).or_default().push(l.b.node.as_str());
        adjacent.entry(l.b.node.as_str()).or_default().push(l.a.node.as_str());
    }
    let mut starts: Vec<&str> = graph.nodes.iter().filter(|n| is_seed(n)).map(|n| n.id.as_str()).collect();
    if starts.is_empty() {
        // No seed named: the best-connected collected device is the middle of the picture.
        starts.extend(graph.nodes.iter().filter(|n| n.kind == NodeKind::Collected).max_by_key(|n| adjacent.get(n.id.as_str()).map(Vec::len).unwrap_or(0)).map(|n| n.id.as_str()));
    }
    let mut hops: BTreeMap<String, usize> = BTreeMap::new();
    let mut queue: std::collections::VecDeque<(&str, usize)> = starts.iter().map(|s| (*s, 0)).collect();
    while let Some((id, h)) = queue.pop_front() {
        if hops.contains_key(id) {
            continue;
        }
        hops.insert(id.to_string(), h);
        for next in adjacent.get(id).into_iter().flatten() {
            if !hops.contains_key(*next) {
                queue.push_back((next, h + 1));
            }
        }
    }
    let unreached = if hops.is_empty() { 0 } else { hops.values().copied().max().unwrap_or(0) + 1 };
    for n in &graph.nodes {
        hops.entry(n.id.clone()).or_insert(unreached);
    }
    hops
}

fn class_of(node: &Node) -> DeviceClass {
    match node.role.as_deref() {
        Some("switch") | Some("access_switch") | Some("l3_switch") => DeviceClass::Switch,
        Some("router") => DeviceClass::Router,
        Some("firewall") => DeviceClass::Firewall,
        Some("wlc") => DeviceClass::WirelessController,
        Some("ap") => DeviceClass::AccessPoint,
        Some("host") => DeviceClass::Server,
        _ => coreview_discover::classify::classify(node.platform.as_deref(), &node.capabilities, node.version.as_deref()),
    }
}

fn addresses_of(node: &Node) -> Vec<DeviceAddress> {
    let mut out: Vec<DeviceAddress> = Vec::new();
    if let Some(ip) = &node.mgmt_ip {
        out.push(DeviceAddress { ip: ip.clone(), interface: None, is_management: true });
    }
    for (ip, iface, _, mgmt) in &node.addresses {
        if out.iter().any(|a| &a.ip == ip) {
            continue;
        }
        out.push(DeviceAddress { ip: ip.clone(), interface: iface.clone(), is_management: *mgmt });
    }
    out
}

/// A subnet that joins exactly two interfaces.
fn is_point_to_point(subnet: &str) -> bool {
    match subnet.split_once('/') {
        Some((a, l)) if a.contains(':') => l == "127",
        Some((_, l)) => l == "30" || l == "31",
        None => false,
    }
}

fn protocol_of(kind: LinkKind) -> Protocol {
    match kind {
        LinkKind::Cdp => Protocol::Cdp,
        LinkKind::Api => Protocol::Controller,
        _ => Protocol::Lldp,
    }
}

fn neighbor_record(other: &Node, local: Option<String>, remote: Option<String>, kind: LinkKind) -> Neighbor {
    Neighbor {
        device_id: other.name.clone(),
        short_name: other.name.clone(),
        addresses: addresses_of(other).into_iter().take(1).collect(),
        local_interface: local,
        remote_interface: remote,
        platform: other.platform.clone().or_else(|| other.model.clone()),
        capabilities: other.capabilities.clone(),
        version: other.version.clone(),
        class: class_of(other),
        discovered_by: protocol_of(kind),
        serial: other.serials.iter().next().cloned(),
        chassis_id: other.macs.iter().next().cloned(),
        vendor: None,
    }
}

/// The routing table in the crawl's form; VRF tables apart, as the crawl keeps them.
fn details_of(node: &Node, vrf: Option<&str>) -> DeviceDetails {
    let mut details = DeviceDetails::default();
    for r in &node.routes {
        if let Some(want) = vrf {
            if r.vrf.as_deref().unwrap_or("default") != want {
                continue;
            }
        }
        let spelled = match r.proto.trim_end_matches('*').trim() {
            "C" | "connected" | "direct" | "Direct" | "local" | "L" => "connected",
            "S" | "static" | "Static" => "static",
            "O" | "IA" | "E1" | "E2" | "N1" | "N2" | "ospf" | "OSPF" => "ospf",
            "B" | "bgp" | "BGP" => "bgp",
            "D" | "EX" | "eigrp" => "eigrp",
            "R" | "rip" => "rip",
            "i" | "L1" | "L2" | "isis" => "isis",
            other => other,
        };
        let route = Route {
            family: if r.prefix.contains(':') { 6 } else { 4 },
            prefix: r.prefix.clone(),
            code: r.proto.clone(),
            protocol: spelled.to_string(),
            next_hops: r.next_hops.clone(),
            interface: r.interface.clone(),
            distance: r.ad,
            metric: r.metric,
            next_hop_vrf: None,
            segment_id: None,
        };
        match &r.vrf {
            Some(v) => details.vrf_routes.entry(v.clone()).or_default().push(route),
            None => details.routes.push(route),
        }
    }
    details
}

fn stack_of(node: &Node) -> Option<StackInfo> {
    if node.members.len() < 2 {
        return None;
    }
    let kind = match (node.stack_kind.as_deref(), node.os.as_deref()) {
        (Some("svl"), _) => StackKind::StackWiseVirtual,
        (Some("vsf"), _) => StackKind::Vsf,
        (Some("virtual_chassis"), _) => StackKind::VirtualChassis,
        (_, Some("aoss")) => StackKind::ArubaStack,
        (_, Some("cisco_ios")) => StackKind::StackWise,
        _ => StackKind::VendorStack,
    };
    Some(StackInfo {
        kind,
        members: node.members.iter().map(|m| StackMember { id: m.id.clone(), role: m.role.clone(), state: None, model: m.model.clone(), serial: m.serial.clone(), mac: m.mac.clone(), priority: None }).collect(),
        peer: None,
        inter_switch_link: None,
        peer_reachable: None,
        unverified: false,
    })
}

pub fn view(graph: &Graph) -> CrawlView {
    view_with(graph, &ViewOptions::default())
}

pub fn view_with(graph: &Graph, opts: &ViewOptions) -> CrawlView {
    let by_id: BTreeMap<&str, &Node> = graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    // How many things each switch port has behind it, for the page's crowd rule.
    let mut population: BTreeMap<(String, String), usize> = BTreeMap::new();
    for e in &graph.endpoints {
        *population.entry((e.switch.clone(), e.port.clone())).or_default() += 1;
    }
    let hops = hops_from_seeds(graph, &opts.seeds);
    // A device nobody logged into but whose cable to another
    // uncollected device the graph holds — a controller's AP and the switch
    // it reports hanging off — is drawn as a device of its own,
    // marked reported rather than reached, so the cable is on the page; a
    // collected device's own neighbours draw every other placeholder.
    let kind_of = |id: &str| by_id.get(id).map(|n| n.kind);
    let promoted: BTreeSet<&str> = graph
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Neighbor && opts.placeholders)
        .filter(|n| {
            graph.links.iter().any(|l| {
                (l.a.node == n.id && kind_of(&l.b.node) == Some(NodeKind::Neighbor)) || (l.b.node == n.id && kind_of(&l.a.node) == Some(NodeKind::Neighbor))
            })
        })
        .map(|n| n.id.as_str())
        .collect();
    let mut devices = Vec::new();
    for node in graph.nodes.iter().filter(|n| n.kind == NodeKind::Collected || promoted.contains(n.id.as_str())) {
        let mut neighbors = Vec::new();
        let mut attached = Vec::new();
        let mut port_channels: Vec<PortChannel> = Vec::new();
        for l in &graph.links {
            let (me, other) = if l.a.node == node.id {
                (&l.a, &l.b)
            } else if l.b.node == node.id {
                (&l.b, &l.a)
            } else {
                continue;
            };
            let Some(other_node) = by_id.get(other.node.as_str()) else { continue };
            if l.confidence < opts.min_confidence {
                continue;
            }
            if !opts.placeholders && other_node.kind != NodeKind::Collected {
                continue;
            }
            if l.kind == LinkKind::InferredMac {
                // Only the switch side carries it; an unknown switch is drawn
                // by the page from the crowd of endpoints on that port.
                if me.port.is_none() || other_node.kind == NodeKind::UnknownSwitch {
                    continue;
                }
                attached.push(AttachedDevice {
                    mac: other_node.macs.iter().next().cloned().unwrap_or_default(),
                    port: short(me.port.as_deref().unwrap_or("")),
                    address: other_node.mgmt_ip.clone(),
                    vendor: None,
                    hostname: Some(other_node.name.clone()),
                    class: Some(class_of(other_node)),
                    port_population: 1,
                    vlan: None,
                });
                continue;
            }
            match &l.bundle {
                Some(b) => {
                    let mine_first = l.a.node == node.id;
                    let name = if mine_first { b.a_name.clone() } else { b.b_name.clone() };
                    let mut my_members = Vec::new();
                    for (x, y) in &b.members {
                        let (mp, op) = if mine_first { (x, y) } else { (y, x) };
                        my_members.push(short(mp));
                        neighbors.push(neighbor_record(other_node, Some(short(mp)).filter(|s| !s.is_empty()), Some(short(op)).filter(|s| !s.is_empty()), l.kind));
                    }
                    if let (Some(n), true) = (name, opts.collapse_bundles) {
                        port_channels.push(PortChannel { name: short(&n), protocol: "-".into(), members: my_members });
                    }
                }
                None => neighbors.push(neighbor_record(other_node, me.port.as_deref().map(short), other.port.as_deref().map(short), l.kind)),
            }
        }
        // A /30, /31 or /127 both ends of which were collected is a
        // cable, whether or not CDP or LLDP said so; drawn unless a link
        // between the two is already drawn.
        for adj in graph.l3.iter().filter(|a| is_point_to_point(&a.subnet)) {
            let (mine, theirs, their_id) = if adj.a == node.id {
                (&adj.a_if, &adj.b_if, &adj.b)
            } else if adj.b == node.id {
                (&adj.b_if, &adj.a_if, &adj.a)
            } else {
                continue;
            };
            let Some(other_node) = by_id.get(their_id.as_str()) else { continue };
            let cabled = graph.links.iter().any(|l| (l.a.node == adj.a && l.b.node == adj.b) || (l.a.node == adj.b && l.b.node == adj.a));
            if cabled || neighbors.iter().any(|n: &Neighbor| n.short_name == other_node.name) {
                continue;
            }
            let mut n = neighbor_record(other_node, mine.as_deref().map(short), theirs.as_deref().map(short), LinkKind::Lldp);
            n.discovered_by = Protocol::Subnet;
            neighbors.push(n);
        }
        let crowd = |e: &Endpoint| population.get(&(e.switch.clone(), e.port.clone())).copied().unwrap_or(1) >= crate::inferred::CROWD;
        for e in graph.endpoints.iter().filter(|e| e.switch == node.id) {
            if opts.min_confidence > 0.6 || (!opts.placeholders && crowd(e)) {
                continue;
            }
            if let Some(v) = &opts.vlan {
                if e.vlan.as_deref() != Some(v.as_str()) {
                    continue;
                }
            }
            attached.push(AttachedDevice {
                mac: e.mac.clone(),
                port: short(&e.port),
                address: e.ip.clone(),
                // The maker, from the MAC's registered prefix, as the classic crawl lists it.
                vendor: coreview_discover::oui::vendor(&e.mac).map(str::to_string),
                hostname: None,
                class: None,
                port_population: population.get(&(e.switch.clone(), e.port.clone())).copied().unwrap_or(1),
                vlan: e.vlan.clone(),
            });
        }
        let addresses = addresses_of(node);
        let address = addresses.first().map(|a| a.ip.clone()).unwrap_or_default();
        devices.push(CrawledDevice {
            hostname: node.name.clone(),
            address: address.clone(),
            addresses,
            probe_target: address,
            class: class_of(node),
            platform: node.model.clone().or_else(|| node.platform.clone()),
            serial: node.serials.iter().next().cloned(),
            version: node.version.clone(),
            neighbors,
            hops: hops.get(&node.id).copied().unwrap_or(0),
            reached_by: if node.kind == NodeKind::Collected { ReachedBy::Ssh } else { ReachedBy::Reported },
            attached,
            port_channels,
            default_next_hop: None,
            stack: if opts.collapse_stacks { stack_of(node) } else { None },
            details: coreview_discover::crawl::DeviceDetails {
                tunnels: graph
                    .overlays
                    .iter()
                    .filter(|o| o.a == node.id)
                    .map(|o| coreview_discover::overlay::Tunnel {
                        kind: o.kind.clone(),
                        name: o.name.clone(),
                        local: o.local_ip.clone(),
                        remote: o.remote_ip.clone(),
                        peer: o.b.as_deref().and_then(|b| by_id.get(b)).map(|n| n.name.clone()),
                    })
                    .collect(),
                ..details_of(node, opts.vrf.as_deref())
            },
            dns_name: None,
            evidence: Default::default(),
        });
    }
    let not_visited = graph
        .nodes
        .iter()
        .filter(|n| opts.placeholders && n.kind == NodeKind::Neighbor && !promoted.contains(n.id.as_str()))
        .map(|n| {
            let kind = graph.links.iter().find(|l| l.a.node == n.id || l.b.node == n.id).map(|l| l.kind).unwrap_or(LinkKind::Lldp);
            neighbor_record(n, None, None, kind)
        })
        .collect();
    CrawlView { devices, not_visited }
}
