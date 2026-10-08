//! The modeled path, the spec's steps 1–8, over [`Net`].
//!
//! At each device: the destination is its own → delivered. Otherwise a
//! firewall's destination NAT (in its vendor's order, `firewall`), then a
//! policy route if one matches, else the longest prefix in the VRF. Equal-cost
//! next hops are branches, each walked. A next hop that is not on an attached
//! subnet is looked up again, to depth three, and the packet goes to the
//! *immediate* next hop that resolution found. The next hop becomes a device
//! by its address, by an FHRP address's active owner, or through this
//! device's ARP entry and a MAC; failing all three it is an unmanaged hop,
//! and the walk says so and stops. Between two routers, the MAC tables and
//! the links say which switches and ports carry it.

use std::collections::BTreeSet;
use std::net::IpAddr;

use coreview_topology::ifname::key;
use serde::{Deserialize, Serialize};

use crate::firewall::{self, FwVerdict, Kind, Rewrite, Verdict};
use crate::model::{proto_word, Box_, Net, RouteEntry};

pub const TTL: u8 = 64;
pub const MAX_PATHS: usize = 64;
const MAX_RECURSION: usize = 3;
const MAX_SWITCHES: usize = 16;

/// What is being traced.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Request {
    /// A collected device (name or address), or an address to be placed.
    pub from: String,
    pub to: String,
    /// The table to start in, when not the global one.
    pub vrf: Option<String>,
    /// `tcp`, `udp`, `icmp` or a number.
    pub protocol: Option<String>,
    pub port: Option<u16>,
    pub source_port: Option<u16>,
    /// What-if: devices treated as down.
    pub down_devices: Vec<String>,
    /// What-if: a device's interface treated as down.
    pub down_links: Vec<DownLink>,
    /// Verify: the answering address of each traceroute hop, `None` for `*`.
    pub traceroute: Option<Vec<Option<String>>>,
    /// Trace the way back too (on unless turned off).
    pub no_reverse: bool,
    /// Set by the builder, never by the page: this is the way back of a flow,
    /// and these are the firewalls the way there crossed. A stateful firewall
    /// passes the return of a flow it allowed, so its policy is not asked
    /// again, and NAT is not applied a second time.
    #[serde(skip)]
    pub return_of: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownLink {
    pub device: String,
    pub interface: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Matched {
    pub prefix: String,
    /// The device's own word, as printed.
    pub protocol: String,
    /// The same, as one word: `connected`, `static`, `ospf`, `bgp`, …
    pub kind: String,
    pub distance: Option<u32>,
    pub metric: Option<u32>,
    pub next_hop: Option<String>,
    pub command: String,
    /// `forwarding` when the hop was looked up in the device's
    /// forwarding table (CEF, `show forwarding`, the kernel), `routing`
    /// when only the RIB was collected.
    pub table: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    /// The destination is this device's own address.
    Local,
    /// On an attached subnet.
    Connected,
    /// The longest prefix in the table.
    Lpm,
    /// Only the default route matched.
    Default,
    /// A policy route matched before the table.
    Pbr,
}

/// One switch between two routers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct L2Step {
    pub device: String,
    pub in_port: Option<String>,
    pub out_port: Option<String>,
    pub vlan: Option<String>,
    /// STP has this port blocked.
    pub blocked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overlay {
    pub tunnel: String,
    pub kind: Option<String>,
    pub local: Option<String>,
    pub remote: String,
    /// The devices the underlay passes, from this one to the far end.
    pub underlay: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hop {
    pub device: String,
    pub in_interface: Option<String>,
    pub vrf: String,
    /// The addresses as the packet arrives here.
    pub src: String,
    pub dst: String,
    pub decision: Decision,
    pub matched: Option<Matched>,
    /// Recursive resolution: each lookup the next hop needed.
    pub via: Vec<Matched>,
    pub out_interface: Option<String>,
    pub next_hop: Option<String>,
    /// The next hop's MAC, from this device's ARP table.
    pub next_hop_mac: Option<String>,
    /// The device the next hop is, when known.
    pub next_device: Option<String>,
    pub l2: Vec<L2Step>,
    pub firewall: Option<FwVerdict>,
    pub nat: Vec<Rewrite>,
    /// How many equal-cost next hops the route had, when more than one.
    pub ecmp: usize,
    pub overlay: Option<Overlay>,
    pub notes: Vec<String>,
}

/// Where an address was found: the switch port its MAC is learned on.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub switch: String,
    pub port: String,
    pub vlan: Option<String>,
    pub mac: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum Ending {
    /// Arrived: at a device's own address, or on the subnet the destination is on.
    Delivered { device: Option<String>, endpoint: Option<Place> },
    /// A device had no route, or a null route.
    Dropped { at: String, reason: String },
    /// A firewall's policy denies it.
    Denied { at: String, policy: Option<String> },
    /// The next hop is nothing any collection reached.
    Unmanaged { at: String, next_hop: String, mac: Option<String>, name: Option<String> },
    /// The tables to go further were not collected. Never a guess.
    Insufficient { at: Option<String>, reason: String },
    /// A device already on the path, or 64 hops.
    Loop { at: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Path {
    pub hops: Vec<Hop>,
    pub ending: Ending,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// The device(s) the walk starts at.
    pub starts: Vec<String>,
    /// Where the source address's MAC is learned, when it is an endpoint.
    pub endpoint: Option<Place>,
    /// How the first device was chosen, in a sentence.
    pub how: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trace {
    pub from: String,
    pub to: String,
    pub source: Option<Source>,
    pub paths: Vec<Path>,
    pub warnings: Vec<String>,
    /// More than [`MAX_PATHS`] branches: the rest were not walked.
    pub truncated: bool,
}

impl Trace {
    fn refused(req: &Request, at: Option<String>, reason: String) -> Trace {
        Trace { from: req.from.clone(), to: req.to.clone(), source: None, paths: vec![Path { hops: vec![], ending: Ending::Insufficient { at, reason } }], warnings: vec![], truncated: false }
    }
}

// ------------------------------------------------------------------ walk

struct Ctx<'a> {
    net: &'a Net,
    return_of: Option<Vec<String>>,
    proto: Option<u8>,
    port: Option<u16>,
    down: BTreeSet<usize>,
    down_links: Vec<(usize, String)>,
    paths: Vec<Path>,
    warnings: std::cell::RefCell<Vec<String>>,
    truncated: bool,
    /// Walking a tunnel's underlay, where another tunnel is never
    /// entered — a full-tunnel default route would otherwise lead back into
    /// the same tunnel without end.
    in_underlay: bool,
}

#[derive(Clone)]
struct At {
    b: usize,
    vrf: String,
    in_if: Option<String>,
    src: IpAddr,
    dst: IpAddr,
    ttl: u8,
    seen: Vec<(usize, String)>,
}

/// Where a choice sends the packet.
#[derive(Clone)]
enum Toward {
    /// Onto an attached subnet: the destination itself.
    Attached,
    /// To this next hop.
    NextHop(IpAddr),
    /// Into a tunnel.
    Tunnel(crate::model::Tunnel),
    /// Nowhere: a null route.
    Null,
    /// Across an MPLS L3VPN, to the remote PE whose address the
    /// VRF's BGP route names, over the global table.
    Vpn(IpAddr),
}

#[derive(Clone)]
struct Choice {
    decision: Decision,
    matched: Option<Matched>,
    via: Vec<Matched>,
    out_if: Option<String>,
    toward: Toward,
    /// The VRF the next hop is in, when the route said another.
    nh_vrf: Option<String>,
}

fn matched_of(r: &RouteEntry, nh: Option<IpAddr>) -> Matched {
    Matched { prefix: r.net.to_string(), protocol: r.proto.clone(), kind: proto_word(&r.proto), distance: r.ad, metric: r.metric, next_hop: nh.map(|a| a.to_string()), command: r.command.clone(), table: if r.command.starts_with("fib:") { "forwarding".into() } else { "routing".into() } }
}

fn is_null(iface: &str) -> bool {
    let l = iface.trim().to_ascii_lowercase();
    l.starts_with("null") || l == "blackhole" || l == "discard" || l == "reject" || l.starts_with("dsc")
}

/// Routes in a VRF that hold an address, longest first, then by distance
/// and metric — from the forwarding table when one was collected for the
/// VRF, else the RIB.
fn candidates<'a>(b: &'a Box_, vrf: &str, ip: IpAddr) -> Vec<&'a RouteEntry> {
    let table: &Vec<RouteEntry> = if b.fib.iter().any(|r| r.vrf == vrf) { &b.fib } else { &b.routes };
    let mut v: Vec<&RouteEntry> = table.iter().filter(|r| r.vrf == vrf && r.net.contains(ip)).collect();
    v.sort_by(|x, y| y.net.len.cmp(&x.net.len).then(x.ad.unwrap_or(u32::MAX).cmp(&y.ad.unwrap_or(u32::MAX))).then(x.metric.unwrap_or(u32::MAX).cmp(&y.metric.unwrap_or(u32::MAX))));
    v
}

/// How long the attached subnet holding `ip` is, if any — the
/// connected route's, else the interface address's.
fn attached_len(b: &Box_, vrf: &str, ip: IpAddr) -> Option<u8> {
    let by_route = candidates(b, vrf, ip).into_iter().filter(|r| r.is_connected() && !r.net.is_host()).map(|r| r.net.len).max();
    let by_addr = b.addrs.iter().filter(|a| a.vrf == vrf && a.subnet().map(|n| n.contains(ip)).unwrap_or(false)).filter_map(|a| a.len).max();
    by_route.into_iter().chain(by_addr).max()
}

/// The interface an attached next hop is reached by: a connected route, else
/// an interface address on its subnet.
fn attached_iface(b: &Box_, vrf: &str, ip: IpAddr) -> Option<String> {
    if let Some(r) = candidates(b, vrf, ip).into_iter().find(|r| r.is_connected() && !r.net.is_host()) {
        if let Some(i) = r.next_hops.iter().find_map(|h| h.iface.clone()) {
            return Some(i);
        }
    }
    b.addrs.iter().filter(|a| a.vrf == vrf && a.subnet().map(|n| n.contains(ip)).unwrap_or(false)).max_by_key(|a| a.len).and_then(|a| a.iface.clone())
}

/// A next hop that is not attached, looked up again until one is (depth 3).
/// Returns every immediate (next hop, interface, lookups) it resolves to.
/// An immediate next hop, the interface it is reached by, and the lookups it took.
type Resolved = (IpAddr, Option<String>, Vec<Matched>);

fn resolve(b: &Box_, vrf: &str, ip: IpAddr, depth: usize, via: Vec<Matched>) -> Result<Vec<Resolved>, String> {
    // An attached subnet settles the next hop unless a longer route
    // — a static /32 to it, say — holds it; then that route is followed, as
    // the device would.
    let longer = candidates(b, vrf, ip).into_iter().next().filter(|r| !r.is_connected() && r.net.len > attached_len(b, vrf, ip).unwrap_or(0));
    if longer.is_none() {
        if let Some(i) = attached_iface(b, vrf, ip) {
            return Ok(vec![(ip, Some(i), via)]);
        }
    }
    if depth >= MAX_RECURSION {
        return Err(format!("the next hop {ip} was still not on an attached subnet after {MAX_RECURSION} lookups"));
    }
    let Some(r) = candidates(b, vrf, ip).into_iter().next() else {
        return Err(format!("{} has no route to its own next hop {ip}", b.name));
    };
    let mut out = Vec::new();
    for h in &r.next_hops {
        let mut v = via.clone();
        v.push(matched_of(r, h.ip));
        match (h.ip, &h.iface) {
            (Some(n), Some(i)) => out.push((n, Some(i.clone()), v)),
            (Some(n), None) => out.extend(resolve(b, vrf, n, depth + 1, v)?),
            (None, Some(i)) => out.push((ip, Some(i.clone()), v)),
            (None, None) => {}
        }
    }
    if out.is_empty() {
        return Err(format!("the route {} that holds the next hop {ip} names no next hop", r.net));
    }
    Ok(out)
}

fn port_match(want: &Option<String>, port: Option<u16>) -> firewall::Tri {
    match want {
        None => firewall::Tri::Yes,
        Some(w) => firewall::svc_match(std::slice::from_ref(w), None, port),
    }
}

impl Ctx<'_> {
    fn name(&self, b: usize) -> String {
        self.net.boxes[b].name.clone()
    }

    /// Policy routes first (the spec's step 2).
    fn pbr(&self, b: &Box_, at: &At, dst: IpAddr, notes: &mut Vec<String>) -> Option<Vec<Choice>> {
        for p in &b.pbr {
            if let (Some(want), Some(have)) = (&p.in_if, &at.in_if) {
                if key(want) != key(have) && !want.eq_ignore_ascii_case("any") {
                    continue;
                }
            }
            if let Some(v) = &p.vrf {
                if crate::model::vrf_name(Some(v)) != at.vrf {
                    continue;
                }
            }
            let m = firewall::addr_match(&p.src.iter().cloned().collect::<Vec<_>>(), at.src, &[])
                .and(firewall::addr_match(&p.dst.iter().cloned().collect::<Vec<_>>(), dst, &[]))
                .and(match (&p.proto, self.proto) {
                    (None, _) => firewall::Tri::Yes,
                    (Some(x), _) if x.eq_ignore_ascii_case("any") || x.eq_ignore_ascii_case("ip") || x == "0" => firewall::Tri::Yes,
                    (Some(x), Some(have)) => {
                        if firewall::proto_number(x) == Some(have) {
                            firewall::Tri::Yes
                        } else {
                            firewall::Tri::No
                        }
                    }
                    (Some(x), None) => firewall::Tri::Unknown(format!("the flow's protocol was not given, and it matches only {x}")),
                })
                .and(port_match(&p.port, self.port));
            match m {
                firewall::Tri::No => continue,
                firewall::Tri::Unknown(why) => {
                    notes.push(format!("Policy route {} may apply: {why}; the routing table was used.", label(&p.seq)));
                    return None;
                }
                firewall::Tri::Yes => {}
            }
            let matched = Matched { prefix: p.dst.clone().unwrap_or_else(|| "any".into()), protocol: "policy".into(), kind: "pbr".into(), distance: None, metric: None, next_hop: p.next_hop.map(|a| a.to_string()), command: p.command.clone(), table: "policy".into() };
            // A policy that sends the packet to another table is
            // looked up there — Junos's filter-based forwarding, IOS's
            // `set vrf`.
            if let (Some(target), None, None) = (&p.action_vrf, p.next_hop, &p.out_if) {
                let target = crate::model::vrf_name(Some(target));
                notes.push(format!("Policy route {} sends the packet to {}'s table, which was used.", label(&p.seq), vrf_label(&target)));
                return match self.lookup(at.b, &target, dst, notes) {
                    Ok(choices) => Some(choices.into_iter().map(|c| Choice { decision: Decision::Pbr, nh_vrf: c.nh_vrf.or_else(|| Some(target.clone())), ..c }).collect()),
                    Err(_) => {
                        notes.push(format!("{} has no route to {dst} in {}; the routing table was used.", b.name, vrf_label(&target)));
                        None
                    }
                };
            }
            let choice = match (p.next_hop, &p.out_if) {
                (Some(nh), out) => {
                    let out_if = out.clone().or_else(|| attached_iface(b, &at.vrf, nh));
                    Choice { decision: Decision::Pbr, matched: Some(matched), via: vec![], out_if, toward: Toward::NextHop(nh), nh_vrf: None }
                }
                (None, Some(i)) if is_null(i) => Choice { decision: Decision::Pbr, matched: Some(matched), via: vec![], out_if: Some(i.clone()), toward: Toward::Null, nh_vrf: None },
                (None, Some(i)) => {
                    let toward = b.is_tunnel_iface(i).cloned().map(Toward::Tunnel).unwrap_or(Toward::Attached);
                    Choice { decision: Decision::Pbr, matched: Some(matched), via: vec![], out_if: Some(i.clone()), toward, nh_vrf: None }
                }
                (None, None) => {
                    notes.push(format!("Policy route {} matches but its action was not collected; the routing table was used.", label(&p.seq)));
                    return None;
                }
            };
            return Some(vec![choice]);
        }
        None
    }

    /// The table: the longest prefix whose next hops are not all down.
    fn lookup(&self, b_idx: usize, vrf: &str, dst: IpAddr, notes: &mut Vec<String>) -> Result<Vec<Choice>, Ending> {
        let b = &self.net.boxes[b_idx];
        if !b.has_table("route") && !b.has_table("fib") {
            return Err(Ending::Insufficient { at: Some(b.name.clone()), reason: format!("No routing table was collected from {}.", b.name) });
        }
        let all = candidates(b, vrf, dst);
        // Where the forwarding table is walked, say so, and say when
        // the RIB would have sent the packet elsewhere.
        if let Some(best) = all.first().filter(|r| r.command.starts_with("fib:")) {
            let rib: Vec<&RouteEntry> = {
                let mut v: Vec<&RouteEntry> = b.routes.iter().filter(|r| r.vrf == vrf && r.net.contains(dst)).collect();
                v.sort_by(|x, y| y.net.len.cmp(&x.net.len).then(x.ad.unwrap_or(u32::MAX).cmp(&y.ad.unwrap_or(u32::MAX))));
                v
            };
            if let Some(rr) = rib.first() {
                let fib_hops: BTreeSet<String> = best.next_hops.iter().map(|h| h.ip.map(|a| a.to_string()).or_else(|| h.iface.clone()).unwrap_or_default()).collect();
                let rib_hops: BTreeSet<String> = rr.next_hops.iter().map(|h| h.ip.map(|a| a.to_string()).or_else(|| h.iface.clone()).unwrap_or_default()).collect();
                if rr.net != best.net || (!rib_hops.is_empty() && rib_hops != fib_hops) {
                    let w = format!("{}: the forwarding table sends {dst} by {} ({}) but the routing table holds {} ({}); the forwarding table was followed.", b.name, best.net, fib_hops.iter().cloned().collect::<Vec<_>>().join(", "), rr.net, rib_hops.iter().cloned().collect::<Vec<_>>().join(", "));
                    notes.push(w.clone());
                    self.warn(w);
                }
            }
        }
        if all.is_empty() {
            let vrfs: BTreeSet<&str> = b.routes.iter().chain(b.fib.iter()).map(|r| r.vrf.as_str()).collect();
            let reason = if vrfs.contains(vrf) { format!("{} has no route to {dst} in {}.", b.name, vrf_label(vrf)) } else { format!("No routing table for {} was collected from {}.", vrf_label(vrf), b.name) };
            return if vrfs.contains(vrf) { Err(Ending::Dropped { at: b.name.clone(), reason }) } else { Err(Ending::Insufficient { at: Some(b.name.clone()), reason }) };
        }
        let mut skipped: Vec<String> = Vec::new();
        for r in all {
            let mut choices = Vec::new();
            let n = r.next_hops.len();
            for h in &r.next_hops {
                let nh_vrf = h.vrf.clone();
                let lookup_vrf = nh_vrf.clone().unwrap_or_else(|| vrf.to_string());
                match (h.ip, &h.iface) {
                    (_, Some(i)) if is_null(i) => choices.push(Choice { decision: decision_of(r), matched: Some(matched_of(r, None)), via: vec![], out_if: Some(i.clone()), toward: Toward::Null, nh_vrf: None }),
                    (None, Some(i)) => {
                        let toward = b.is_tunnel_iface(i).cloned().map(Toward::Tunnel).unwrap_or(Toward::Attached);
                        choices.push(Choice { decision: decision_of(r), matched: Some(matched_of(r, None)), via: vec![], out_if: Some(i.clone()), toward, nh_vrf: None });
                    }
                    (Some(nh), None) if vrf != "default" && lookup_vrf == "default" && proto_word(&r.proto) == "bgp" => {
                        // The route itself says its next hop is in the global table.
                        choices.push(Choice { decision: decision_of(r), matched: Some(matched_of(r, Some(nh))), via: vec![], out_if: None, toward: Toward::Vpn(nh), nh_vrf: Some("default".into()) });
                    }
                    (Some(nh), iface) => {
                        let resolved = match iface {
                            Some(i) => Ok(vec![(nh, Some(i.clone()), vec![])]),
                            None => resolve(b, &lookup_vrf, nh, 0, vec![]),
                        };
                        match resolved {
                            Ok(list) => {
                                for (imm, out_if, via) in list {
                                    let toward = match out_if.as_deref().and_then(|i| b.is_tunnel_iface(i)) {
                                        Some(t) => Toward::Tunnel(t.clone()),
                                        None => Toward::NextHop(imm),
                                    };
                                    choices.push(Choice { decision: decision_of(r), matched: Some(matched_of(r, Some(nh))), via, out_if, toward, nh_vrf: nh_vrf.clone() });
                                }
                            }
                            Err(why) => {
                                // A VRF that exports a route-target this one imports.
                                let leaked = b.leaks_into(&lookup_vrf).into_iter().find_map(|(other, rt)| resolve(b, &other, nh, 0, vec![]).ok().map(|l| (other, rt, l)));
                                if let Some((other, rt, list)) = leaked {
                                    notes.push(format!("{} leaks into {} from VRF {other} by route-target {rt}; {nh} is resolved there.", r.net, vrf_label(&lookup_vrf)));
                                    for (imm, out_if, via) in list {
                                        choices.push(Choice { decision: decision_of(r), matched: Some(matched_of(r, Some(nh))), via, out_if, toward: Toward::NextHop(imm), nh_vrf: Some(other.clone()) });
                                    }
                                } else if vrf != "default" && proto_word(&r.proto) == "bgp" && resolve(b, "default", nh, 0, vec![]).is_ok() {
                                    // A VPN route whose next hop is a PE in the global table.
                                    choices.push(Choice { decision: decision_of(r), matched: Some(matched_of(r, Some(nh))), via: vec![], out_if: None, toward: Toward::Vpn(nh), nh_vrf: Some("default".into()) });
                                } else {
                                    return Err(Ending::Insufficient { at: Some(b.name.clone()), reason: format!("{}: {why}.", r.net) });
                                }
                            }
                        }
                    }
                    (None, None) if r.is_connected() => choices.push(Choice { decision: Decision::Connected, matched: Some(matched_of(r, None)), via: vec![], out_if: None, toward: Toward::Attached, nh_vrf: None }),
                    (None, None) => {}
                }
            }
            if choices.is_empty() && n == 0 && r.is_connected() {
                choices.push(Choice { decision: Decision::Connected, matched: Some(matched_of(r, None)), via: vec![], out_if: None, toward: Toward::Attached, nh_vrf: None });
            }
            // An interface the device itself reports down, or a
            // tunnel it reports down, carries nothing.
            let before = choices.len();
            choices.retain(|c| {
                let iface_down = c.out_if.as_deref().map(|i| b.down_ifaces.contains(&key(i))).unwrap_or(false);
                let tunnel_down = matches!(&c.toward, Toward::Tunnel(t) if t.down);
                if iface_down {
                    notes.push(format!("{}: {} is down on {}, so that next hop was not used.", r.net, c.out_if.clone().unwrap_or_default(), b.name));
                } else if let (true, Toward::Tunnel(t)) = (tunnel_down, &c.toward) {
                    notes.push(format!("{}: {} is down on {}, so that next hop was not used.", r.net, t.name, b.name));
                }
                !(iface_down || tunnel_down)
            });
            if choices.is_empty() && before > 0 {
                skipped.push(r.net.to_string());
                continue;
            }
            // What-if: an interface down, or the device a next hop is.
            let before = choices.len();
            choices.retain(|c| {
                let link_down = c.out_if.as_deref().map(|i| self.down_links.iter().any(|(d, p)| *d == b_idx && p == &key(i))).unwrap_or(false);
                let dev_down = match &c.toward {
                    Toward::NextHop(nh) => self.device_of(b_idx, &c.nh_vrf.clone().unwrap_or_else(|| vrf.to_string()), *nh, c.out_if.as_deref()).map(|t| self.down.contains(&t)).unwrap_or(false),
                    _ => false,
                };
                !(link_down || dev_down)
            });
            if choices.is_empty() {
                if before > 0 {
                    skipped.push(r.net.to_string());
                    continue;
                }
                return Err(Ending::Insufficient { at: Some(b.name.clone()), reason: format!("The route {} on {} names no next hop or interface.", r.net, b.name) });
            }
            if !skipped.is_empty() {
                notes.push(format!("What-if: {} pointed only at what is marked down, so {} was used. Only routes {} already held are known; a real network may converge differently.", skipped.join(", "), r.net, b.name));
            }
            return Ok(choices);
        }
        Err(Ending::Dropped { at: b.name.clone(), reason: format!("Every route {} holds for {dst} points at what is marked down ({}).", b.name, skipped.join(", ")) })
    }

    /// The collected device a next hop is: its address, an FHRP address's
    /// active owner, or this device's ARP entry and the MAC.
    fn device_of(&self, from: usize, vrf: &str, nh: IpAddr, out_if: Option<&str>) -> Option<usize> {
        self.devices_of(from, vrf, nh, out_if).0.into_iter().next()
    }

    fn devices_of(&self, from: usize, vrf: &str, nh: IpAddr, out_if: Option<&str>) -> (Vec<usize>, Option<String>, Option<String>) {
        let net = self.net;
        let arp_mac = net.boxes[from].arp.iter().find(|a| a.ip == nh && (a.vrf == vrf || a.vrf == "default")).map(|a| a.mac.clone());
        // A link-local next hop names no device; the link it is on does —
        // this device's neighbour entry for it, else the cable out of that interface.
        if crate::model::link_local(nh) {
            if let Some(&b) = arp_mac.as_ref().and_then(|m| net.by_mac.get(m)) {
                return (vec![b], arp_mac.clone(), Some("its MAC, from the neighbour table".into()));
            }
            if let Some(b) = out_if.and_then(|i| net.across(from, i)).and_then(|(node, _)| net.by_node.get(&node).copied()) {
                return (vec![b], arp_mac, Some(format!("the device cabled to {}", out_if.unwrap_or(""))));
            }
            return (vec![], arp_mac, None);
        }
        if let Some(b) = net.box_at(vrf, nh) {
            // An address that is also an FHRP VIP belongs to whoever is active.
            let active: Vec<usize> = fhrp_owners(net, nh, true);
            if !active.is_empty() {
                return (active, arp_mac, Some("the active FHRP router for that address".into()));
            }
            return (vec![b], arp_mac, None);
        }
        let active = fhrp_owners(net, nh, true);
        if !active.is_empty() {
            return (active, arp_mac, Some("the active FHRP router for that address".into()));
        }
        let listed = fhrp_owners(net, nh, false);
        if !listed.is_empty() {
            return (listed, arp_mac, Some("an FHRP address whose active router the collection did not show".into()));
        }
        if let Some(m) = &arp_mac {
            if let Some(&b) = net.by_mac.get(m) {
                return (vec![b], arp_mac.clone(), Some("its MAC, from the ARP table".into()));
            }
        }
        (vec![], arp_mac, None)
    }

    /// The switches and ports between a device's egress and a MAC.
    fn l2_path(&self, from: usize, egress: Option<&str>, target_mac: Option<&str>, target: Option<usize>) -> (Vec<L2Step>, Option<(usize, String)>) {
        let net = self.net;
        let Some(m) = target_mac else { return (vec![], None) };
        let mut vlan = egress.and_then(svi_vlan);
        let mut steps = Vec::new();
        let mut cur = from;
        let mut in_port: Option<String> = None;
        let mut visited = BTreeSet::new();
        for i in 0..MAX_SWITCHES {
            if !visited.insert(cur) {
                self.warn(format!("The MAC tables loop between switches for {m}; the layer-2 path stops at {}.", net.boxes[cur].name));
                break;
            }
            let b = &net.boxes[cur];
            // A frame from a routed port enters the switch in the
            // port's own VLAN, which the VLAN table says.
            if i > 0 && vlan.is_none() {
                vlan = in_port.as_deref().and_then(|p| b.vlan_of_port(p));
            }
            let entry = if i == 0 && vlan.is_none() { None } else { b.port_for(m, vlan.as_deref()) };
            let out = if i == 0 && vlan.is_none() { egress.map(str::to_string) } else { entry.map(|e| e.iface.clone()) };
            // A MAC learned over VXLAN is at another VTEP: the walk
            // crosses the overlay to it, and goes on there.
            if let Some(vtep) = entry.and_then(|e| e.vtep) {
                let out = out.clone().unwrap_or_else(|| "nve".into());
                steps.push(L2Step { device: b.name.clone(), in_port: in_port.clone(), out_port: Some(format!("{out} → {vtep}")), vlan: vlan.clone(), blocked: false });
                match net.by_ip.get(&vtep).copied() {
                    Some(far) if Some(far) == target => break,
                    Some(far) => {
                        cur = far;
                        in_port = Some(out);
                        continue;
                    }
                    None => return (steps, Some((cur, format!("{out} → {vtep}")))),
                }
            }
            if let (Some(o), Some(v)) = (&out, &vlan) {
                if i > 0 && b.port_outside_vlan(o, v) {
                    self.warn(format!("{}'s MAC table has {m} on {o}, which its VLAN table does not place in VLAN {v}.", b.name));
                }
            }
            let Some(out) = out else {
                if i > 0 {
                    steps.push(L2Step { device: b.name.clone(), in_port: in_port.clone(), out_port: None, vlan: vlan.clone(), blocked: false });
                }
                break;
            };
            let blocked = b.blocked(&out, vlan.as_deref());
            if blocked {
                self.warn(format!("STP has {} {} blocked, and the MAC table says the path leaves by it.", b.name, out));
            }
            steps.push(L2Step { device: b.name.clone(), in_port: in_port.clone(), out_port: Some(out.clone()), vlan: vlan.clone(), blocked });
            match net.across(cur, &out) {
                Some((node, far_port)) => match net.by_node.get(&node) {
                    Some(&next) if Some(next) == target => break,
                    Some(&next) => {
                        // A router on the far side that is not the target is not a switch hop.
                        cur = next;
                        in_port = far_port;
                    }
                    None => break,
                },
                None => return (steps, Some((cur, out))),
            }
        }
        (steps, None)
    }

    fn warn(&self, w: String) {
        let mut v = self.warnings.borrow_mut();
        if !v.contains(&w) {
            v.push(w);
        }
    }

    fn step(&mut self, at: At, hops: Vec<Hop>) {
        if self.paths.len() >= MAX_PATHS {
            self.truncated = true;
            return;
        }
        let net = self.net;
        let b = &net.boxes[at.b];
        let name = b.name.clone();
        if at.ttl == 0 || at.seen.iter().any(|(x, v)| *x == at.b && v == &at.vrf) {
            self.paths.push(Path { hops, ending: Ending::Loop { at: name } });
            return;
        }
        let mut seen = at.seen.clone();
        seen.push((at.b, at.vrf.clone()));
        let mut hop = Hop {
            device: name.clone(),
            in_interface: at.in_if.clone(),
            vrf: at.vrf.clone(),
            src: at.src.to_string(),
            dst: at.dst.to_string(),
            decision: Decision::Local,
            matched: None,
            via: vec![],
            out_interface: None,
            next_hop: None,
            next_hop_mac: None,
            next_device: None,
            l2: vec![],
            firewall: None,
            nat: vec![],
            ecmp: 0,
            overlay: None,
            notes: vec![],
        };
        if b.owns(at.dst) {
            let mut hops = hops;
            hops.push(hop);
            self.paths.push(Path { hops, ending: Ending::Delivered { device: Some(name), endpoint: None } });
            return;
        }
        let fk = firewall::kind(b);
        let zones_in = b.zones_of(at.in_if.as_deref());
        let mut dst = at.dst;
        let mut dst_names: Vec<String> = Vec::new();
        // Destination NAT first, except on PAN-OS, which routes the original first.
        // On the way back the session's own translation applies, not the rules.
        let fk_nat = if self.return_of.is_some() { None } else { fk };
        match fk_nat {
            Some(Kind::Forti) | Some(Kind::Asa) | Some(Kind::Other) => match firewall::dnat(b, &zones_in, None, at.src, dst, self.proto, self.port) {
                Ok(Some(rw)) => {
                    dst = rw.now.parse().unwrap_or(dst);
                    dst_names.push(rw.rule.clone());
                    hop.nat.push(rw);
                }
                Ok(None) => {}
                Err(n) => hop.notes.push(n),
            },
            Some(Kind::Pan) => {
                let mut scratch = Vec::new();
                let first_out = self.lookup(at.b, &at.vrf, dst, &mut scratch).ok().and_then(|c| c.into_iter().next()).and_then(|c| c.out_if);
                let zones_out1 = b.zones_of(first_out.as_deref());
                match firewall::dnat(b, &zones_in, Some(&zones_out1), at.src, dst, self.proto, self.port) {
                    Ok(Some(rw)) => {
                        dst = rw.now.parse().unwrap_or(dst);
                        hop.nat.push(rw);
                    }
                    Ok(None) => {}
                    Err(n) => hop.notes.push(n),
                }
            }
            None => {}
        }
        if dst != at.dst && b.owns(dst) {
            let mut hops = hops;
            hops.push(hop);
            self.paths.push(Path { hops, ending: Ending::Delivered { device: Some(name), endpoint: None } });
            return;
        }
        let mut notes = Vec::new();
        let choices = match self.pbr(b, &at, dst, &mut notes) {
            Some(c) => c,
            None => match self.lookup(at.b, &at.vrf, dst, &mut notes) {
                Ok(c) => c,
                Err(ending) => {
                    hop.notes.extend(notes);
                    let mut hops = hops;
                    hops.push(hop);
                    self.paths.push(Path { hops, ending });
                    return;
                }
            },
        };
        hop.notes.extend(notes);
        let ecmp = choices.len();
        for c in choices {
            let mut h = hop.clone();
            h.decision = match (&c.matched, c.decision) {
                (Some(m), Decision::Lpm) if m.prefix.ends_with("/0") => Decision::Default,
                _ => c.decision,
            };
            if h.decision == Decision::Default {
                h.notes.push("Only the default route matched.".into());
            }
            h.matched = c.matched.clone();
            h.via = c.via.clone();
            h.out_interface = c.out_if.clone();
            h.ecmp = if ecmp > 1 { ecmp } else { 0 };
            let mut src = at.src;
            if let (Some(_), Some(forward)) = (fk, &self.return_of) {
                let saw = forward.iter().any(|f| f == &name);
                let zones_out = b.zones_of(c.out_if.as_deref());
                h.firewall = Some(FwVerdict {
                    zone_in: zones_in.last().cloned(),
                    zone_out: zones_out.last().cloned(),
                    policy: None,
                    action: None,
                    verdict: if saw { Verdict::Allow } else { Verdict::Undetermined },
                    reason: if saw {
                        format!("The return of a flow {name} allowed on the way there: a stateful firewall passes it by its session.")
                    } else {
                        format!("{name} did not see the way there, and a stateful firewall drops the return of a flow it did not see.")
                    },
                });
            } else if let Some(k) = fk {
                let zones_out = b.zones_of(c.out_if.as_deref());
                // PAN-OS matches policy on the original addresses; the others on what they now are.
                let (p_dst, names) = if k == Kind::Pan { (at.dst, vec![]) } else { (dst, dst_names.clone()) };
                let v = firewall::verdict(b, k, &firewall::Flow { zones_in: &zones_in, zones_out: &zones_out, src: at.src, dst: p_dst, proto: self.proto, port: self.port, dst_names: &names });
                let denied = v.verdict == Verdict::Deny;
                if v.verdict == Verdict::Undetermined {
                    self.warn(format!("{name}: {}", v.reason));
                }
                let policy = v.policy.clone();
                h.firewall = Some(v);
                if denied {
                    let mut hs = hops.clone();
                    hs.push(h);
                    self.paths.push(Path { hops: hs, ending: Ending::Denied { at: name.clone(), policy } });
                    continue;
                }
                let egress_ip = c.out_if.as_deref().and_then(|i| b.address_on(i));
                // A FortiOS policy with NAT on translates the source
                // itself; the NAT rules (central SNAT) are read only when it does not.
                let by_policy = if k == Kind::Forti { firewall::policy_snat(b, policy.as_deref(), at.src, egress_ip) } else { None };
                match by_policy {
                    Some(Ok(rw)) => {
                        src = rw.now.parse().unwrap_or(src);
                        h.nat.push(rw);
                    }
                    Some(Err(n)) => h.notes.push(n),
                    None => {
                        let flow = firewall::Flow { zones_in: &zones_in, zones_out: &zones_out, src: at.src, dst: if k == Kind::Pan { at.dst } else { dst }, proto: self.proto, port: self.port, dst_names: &[] };
                        match firewall::snat(b, &flow, egress_ip) {
                            Ok(Some(rw)) => {
                                src = rw.now.parse().unwrap_or(src);
                                h.nat.push(rw);
                            }
                            Ok(None) => {}
                            Err(n) => h.notes.push(n),
                        }
                    }
                }
            } else if !b.nat.is_empty() && self.return_of.is_none() {
                let zones_out = b.zones_of(c.out_if.as_deref());
                let egress_ip = c.out_if.as_deref().and_then(|i| b.address_on(i));
                let flow = firewall::Flow { zones_in: &zones_in, zones_out: &zones_out, src: at.src, dst, proto: self.proto, port: self.port, dst_names: &[] };
                match firewall::snat(b, &flow, egress_ip) {
                    Ok(Some(rw)) => {
                        src = rw.now.parse().unwrap_or(src);
                        h.nat.push(rw);
                    }
                    Ok(None) => {}
                    Err(n) => h.notes.push(n),
                }
            }
            let next_at = |b2: usize, in_if: Option<String>, vrf: String, seen: &Vec<(usize, String)>| At { b: b2, vrf, in_if, src, dst, ttl: at.ttl - 1, seen: seen.clone() };
            match c.toward {
                Toward::Null => {
                    let mut hs = hops.clone();
                    let why = format!("{} sends {dst} to {} (a null route).", name, c.out_if.clone().unwrap_or_default());
                    hs.push(h);
                    self.paths.push(Path { hops: hs, ending: Ending::Dropped { at: name.clone(), reason: why } });
                }
                Toward::Attached => {
                    // The destination is on this segment. Is it a collected device?
                    if let Some(&t) = net.by_ip.get(&dst) {
                        if t != at.b && !self.down.contains(&t) {
                            let (l2, _) = self.l2_path(at.b, c.out_if.as_deref(), net.boxes[at.b].arp_for(dst).map(|a| a.mac.as_str()), Some(t));
                            h.l2 = trim_l2(l2, c.out_if.as_deref());
                            h.next_hop = Some(dst.to_string());
                            h.next_device = Some(net.boxes[t].name.clone());
                            let in_if = net.boxes[t].addr_of(dst).and_then(|a| a.iface.clone());
                            let vrf = net.boxes[t].addr_of(dst).map(|a| a.vrf.clone()).unwrap_or_else(|| at.vrf.clone());
                            let mut hs = hops.clone();
                            hs.push(h);
                            self.step(next_at(t, in_if, vrf, &seen), hs);
                            continue;
                        }
                    }
                    let arp = b.arp_for(dst).map(|a| a.mac.clone());
                    h.next_hop_mac = arp.clone();
                    let mut endpoint = None;
                    match &arp {
                        Some(m) => {
                            let (l2, edge) = self.l2_path(at.b, c.out_if.as_deref(), Some(m), None);
                            h.l2 = trim_l2(l2, c.out_if.as_deref());
                            if let Some((sw, port)) = edge {
                                endpoint = Some(Place { switch: net.boxes[sw].name.clone(), port, vlan: c.out_if.as_deref().and_then(svi_vlan), mac: m.clone() });
                            }
                        }
                        None => h.notes.push(format!("{name} has no ARP entry for {dst}: the route says it is attached, but whether anything answers there was not seen.")),
                    }
                    let mut hs = hops.clone();
                    hs.push(h);
                    self.paths.push(Path { hops: hs, ending: Ending::Delivered { device: None, endpoint } });
                }
                Toward::Vpn(pe) => {
                    let underlay = self.underlay(at.b, pe);
                    // A VTEP's VPN route is EVPN over VXLAN, not MPLS.
                    let evpn = b.tunnels.iter().any(|t| t.kind.as_deref().map(|k| k.eq_ignore_ascii_case("vxlan")).unwrap_or(false)) || c.matched.as_ref().map(|m| m.command.contains("evpn") || m.command.contains("l2vpn")).unwrap_or(false);
                    let (tunnel, kind) = if evpn { ("EVPN/VXLAN", "vxlan") } else { ("MPLS L3VPN", "mpls") };
                    h.overlay = Some(Overlay { tunnel: tunnel.into(), kind: Some(kind.into()), local: b.tunnels.iter().find_map(|t| t.local_ip.map(|a| a.to_string())).filter(|_| evpn), remote: pe.to_string(), underlay });
                    h.next_hop = Some(pe.to_string());
                    match net.by_ip.get(&pe).copied().filter(|x| !self.down.contains(x)) {
                        Some(far) => {
                            h.next_device = Some(net.boxes[far].name.clone());
                            // The remote PE's VRF: one exporting a route-target this VRF imports, else one of the same name.
                            let imports = b.vrf_rts.get(&at.vrf).map(|x| x.0.clone()).unwrap_or_default();
                            let fb = &net.boxes[far];
                            let by_rt = fb.vrf_rts.iter().find(|(_, (_, ex))| ex.iter().any(|rt| imports.contains(rt))).map(|(v, _)| v.clone());
                            let by_name = fb.forwarding().iter().any(|r| r.vrf == at.vrf).then(|| at.vrf.clone());
                            let mut hs = hops.clone();
                            match by_rt.or(by_name) {
                                Some(v) => {
                                    hs.push(h);
                                    self.step(next_at(far, None, v, &seen), hs);
                                }
                                None => {
                                    hs.push(h);
                                    self.paths.push(Path { hops: hs, ending: Ending::Insufficient { at: Some(net.boxes[far].name.clone()), reason: format!("{} is the PE for {}, and no VRF there was collected with a route-target {} imports.", net.boxes[far].name, vrf_label(&at.vrf), vrf_label(&at.vrf)) } });
                                }
                            }
                        }
                        None => {
                            let mut hs = hops.clone();
                            hs.push(h);
                            self.paths.push(Path { hops: hs, ending: Ending::Unmanaged { at: name.clone(), next_hop: pe.to_string(), mac: None, name: net.strangers.get(&pe).cloned() } });
                        }
                    }
                }
                Toward::Tunnel(t) => {
                    if self.in_underlay {
                        let mut hs = hops.clone();
                        hs.push(h);
                        self.paths.push(Path { hops: hs, ending: Ending::Insufficient { at: Some(name.clone()), reason: format!("{}'s far end is reached only through {} — a tunnel inside a tunnel's underlay, which is not followed.", name, t.name) } });
                        continue;
                    }
                    let Some(remote) = t.remote_ip else {
                        let mut hs = hops.clone();
                        hs.push(h);
                        self.paths.push(Path { hops: hs, ending: Ending::Insufficient { at: Some(name.clone()), reason: format!("{} leaves by {}, whose far end was not collected.", name, t.name) } });
                        continue;
                    };
                    let underlay = self.underlay(at.b, remote);
                    h.overlay = Some(Overlay { tunnel: t.name.clone(), kind: t.kind.clone(), local: t.local_ip.map(|a| a.to_string()), remote: remote.to_string(), underlay });
                    h.next_hop = Some(remote.to_string());
                    match net.by_ip.get(&remote).copied().filter(|x| !self.down.contains(x)) {
                        Some(far) => {
                            h.next_device = Some(net.boxes[far].name.clone());
                            let far_if = net.boxes[far].tunnels.iter().find(|x| x.remote_ip.is_some() && x.remote_ip == t.local_ip).map(|x| x.name.clone());
                            let vrf = far_if.as_deref().and_then(|i| net.boxes[far].addrs.iter().find(|a| a.iface.as_deref().map(key) == Some(key(i))).map(|a| a.vrf.clone())).unwrap_or_else(|| at.vrf.clone());
                            let mut hs = hops.clone();
                            hs.push(h);
                            self.step(next_at(far, far_if, vrf, &seen), hs);
                        }
                        None => {
                            let mut hs = hops.clone();
                            hs.push(h);
                            self.paths.push(Path { hops: hs, ending: Ending::Unmanaged { at: name.clone(), next_hop: remote.to_string(), mac: None, name: net.strangers.get(&remote).cloned() } });
                        }
                    }
                }
                Toward::NextHop(nh) => {
                    let lookup_vrf = c.nh_vrf.clone().unwrap_or_else(|| at.vrf.clone());
                    h.next_hop = Some(nh.to_string());
                    let (targets, mac, how) = self.devices_of(at.b, &lookup_vrf, nh, c.out_if.as_deref());
                    h.next_hop_mac = mac.clone();
                    if let Some(how) = &how {
                        h.notes.push(format!("{nh} is {how}."));
                    }
                    let targets: Vec<usize> = targets.into_iter().filter(|t| !self.down.contains(t) && *t != at.b).collect();
                    if targets.is_empty() {
                        let (l2, _) = self.l2_path(at.b, c.out_if.as_deref(), mac.as_deref(), None);
                        h.l2 = trim_l2(l2, c.out_if.as_deref());
                        let mut hs = hops.clone();
                        hs.push(h);
                        self.paths.push(Path { hops: hs, ending: Ending::Unmanaged { at: name.clone(), next_hop: nh.to_string(), mac, name: net.strangers.get(&nh).cloned() } });
                        continue;
                    }
                    if targets.len() > 1 {
                        self.warn(format!("{nh} is owned by {} at once (an anycast or active-active gateway); each is followed.", targets.iter().map(|t| self.name(*t)).collect::<Vec<_>>().join(" and ")));
                    }
                    for t in targets {
                        let mut h2 = h.clone();
                        let tb = &net.boxes[t];
                        h2.next_device = Some(tb.name.clone());
                        let tmac = mac.clone().or_else(|| tb.addr_of(nh).and_then(|a| a.iface.as_deref()).and_then(|i| tb.iface_mac.get(&key(i)).cloned()));
                        let (l2, _) = self.l2_path(at.b, c.out_if.as_deref(), tmac.as_deref(), Some(t));
                        h2.l2 = trim_l2(l2, c.out_if.as_deref());
                        let arrive = tb.addr_of(nh).or_else(|| tb.addr_on_subnet(nh));
                        let in_if = arrive.and_then(|a| a.iface.clone());
                        let vrf = arrive.map(|a| a.vrf.clone()).unwrap_or_else(|| lookup_vrf.clone());
                        let mut hs = hops.clone();
                        hs.push(h2);
                        self.step(next_at(t, in_if, vrf, &seen), hs);
                    }
                }
            }
        }
    }

    /// The devices a tunnel's packets cross to reach its far end, in the
    /// global table — the first path only, and never another tunnel.
    fn underlay(&self, from: usize, remote: IpAddr) -> Vec<String> {
        let mut sub = Ctx { net: self.net, return_of: None, proto: None, port: None, down: self.down.clone(), down_links: self.down_links.clone(), paths: vec![], warnings: Default::default(), truncated: false, in_underlay: true };
        let src = self.net.boxes[from].addrs.first().map(|a| a.ip).unwrap_or(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
        sub.step(At { b: from, vrf: "default".into(), in_if: None, src, dst: remote, ttl: 16, seen: vec![] }, vec![]);
        sub.paths.first().map(|p| p.hops.iter().map(|h| h.device.clone()).collect()).unwrap_or_default()
    }
}

fn label(seq: &str) -> String {
    if seq.is_empty() {
        "(unnumbered)".into()
    } else {
        seq.to_string()
    }
}

fn vrf_label(vrf: &str) -> String {
    if vrf == "default" {
        "the global table".into()
    } else {
        format!("VRF {vrf}")
    }
}

fn decision_of(r: &RouteEntry) -> Decision {
    if r.is_connected() {
        Decision::Connected
    } else {
        Decision::Lpm
    }
}

/// The VLAN an SVI carries: `Vlan10`, `vlan.10`, `irb.10`, `vlan10`.
pub fn svi_vlan(iface: &str) -> Option<String> {
    let l = iface.trim().to_ascii_lowercase();
    let rest = l.strip_prefix("vlan").or_else(|| l.strip_prefix("irb")).or_else(|| l.strip_prefix("vl"))?;
    let n = rest.trim_start_matches(['.', ' ']);
    (!n.is_empty() && n.chars().all(|c| c.is_ascii_digit())).then(|| n.to_string())
}

/// Only worth showing when a switch sits between the routers, or the port an
/// SVI leaves by: a single step that repeats the hop's own interface is noise.
fn trim_l2(steps: Vec<L2Step>, out_if: Option<&str>) -> Vec<L2Step> {
    if steps.len() == 1 && steps[0].out_port.as_deref().map(key) == out_if.map(key) {
        return vec![];
    }
    steps
}

fn fhrp_owners(net: &Net, vip: IpAddr, active_only: bool) -> Vec<usize> {
    net.boxes.iter().enumerate().filter(|(_, b)| b.fhrp.iter().any(|f| f.vip == vip && (!active_only || f.active()))).map(|(i, _)| i).collect()
}

// ------------------------------------------------------------ the source

struct Start {
    b: usize,
    vrf: String,
    in_if: Option<String>,
    src: IpAddr,
}

/// Step 1: where the walk begins, and from what address.
fn locate(ctx: &Ctx, from: &str, vrf: Option<&str>) -> Result<(Vec<Start>, Source), String> {
    let net = ctx.net;
    let want_vrf = vrf.map(|v| crate::model::vrf_name(Some(v)));
    if let Some(b) = net.find_box(from) {
        let bx = &net.boxes[b];
        let given: Option<IpAddr> = from.trim().parse().ok();
        let src = given.or_else(|| bx.host.parse().ok()).or_else(|| bx.addrs.first().map(|a| a.ip)).unwrap_or(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
        let vrf = want_vrf.clone().or_else(|| given.and_then(|g| bx.addr_of(g)).map(|a| a.vrf.clone())).unwrap_or_else(|| "default".into());
        return Ok((vec![Start { b, vrf, in_if: None, src }], Source { starts: vec![bx.name.clone()], endpoint: None, how: format!("{} is a collected device.", bx.name) }));
    }
    let Ok(src) = from.trim().parse::<IpAddr>() else {
        return Err(format!("\"{}\" is neither a collected device nor an IP address.", from.trim()));
    };
    // Gateways: the devices whose routing table has the source's subnet as attached.
    let mut gws: Vec<(usize, String, Option<String>)> = Vec::new();
    for (i, b) in net.boxes.iter().enumerate() {
        for r in b.forwarding().iter().filter(|r| r.is_connected() && !r.net.is_host() && r.net.contains(src)) {
            if want_vrf.as_ref().map(|v| v != &r.vrf).unwrap_or(false) {
                continue;
            }
            let iface = r.next_hops.iter().find_map(|h| h.iface.clone()).or_else(|| b.addr_on_subnet(src).and_then(|a| a.iface.clone()));
            if !gws.iter().any(|(x, _, _)| *x == i) {
                gws.push((i, r.vrf.clone(), iface));
            }
        }
    }
    if gws.is_empty() {
        return Err(format!("No collected device has {src}'s subnet as attached, so where it enters the network is not known."));
    }
    // A box whose only attached subnet is the source's — a switch's
    // management address — can carry the packet nowhere else. It is a host
    // on the subnet, not its gateway, while another candidate routes more.
    // Counted in the source's family, and not the Null0 routes IOS lists for
    // IPv6 multicast whether or not IPv6 is in use.
    let routes_more = |i: usize| {
        let nets: std::collections::BTreeSet<String> = net.boxes[i]
            .forwarding()
            .iter()
            .filter(|r| r.is_connected() && !r.net.is_host() && r.net.v6 == src.is_ipv6() && !r.next_hops.iter().any(|h| h.iface.as_deref().is_some_and(is_null)))
            .map(|r| r.net.to_string())
            .collect();
        nets.len() > 1
    };
    if gws.iter().any(|(i, _, _)| routes_more(*i)) {
        gws.retain(|(i, _, _)| routes_more(*i));
    }
    let src_mac = net.boxes.iter().find_map(|b| b.arp_for(src).map(|a| a.mac.clone()));
    let mut how = String::new();
    // FHRP: the active router for the subnet's virtual address.
    let subnet_vips: Vec<IpAddr> = gws.iter().flat_map(|(i, _, _)| net.boxes[*i].fhrp.iter().filter(|f| net.boxes[*i].addr_on_subnet(src).and_then(|a| a.subnet()).map(|n| n.contains(f.vip)).unwrap_or(false)).map(|f| f.vip)).collect();
    if !subnet_vips.is_empty() {
        let active: Vec<(usize, String, Option<String>)> = gws.iter().filter(|(i, _, _)| net.boxes[*i].fhrp.iter().any(|f| subnet_vips.contains(&f.vip) && f.active())).cloned().collect();
        if !active.is_empty() {
            how = format!("{} is the active FHRP router for {}.", active.iter().map(|(i, _, _)| net.boxes[*i].name.clone()).collect::<Vec<_>>().join(" and "), subnet_vips[0]);
            gws = active;
        } else {
            how = format!("The subnet has the FHRP address {}, and no collected device reported itself active for it.", subnet_vips[0]);
        }
    }
    // Anycast, VARP, active-gateway, vPC: prefer where the MAC is learned
    // locally — only between boxes that each have a MAC table; a
    // firewall with none must not lose the choice for that.
    if gws.len() > 1 && gws.iter().all(|(i, _, _)| !net.boxes[*i].macs.is_empty()) {
        if let Some(m) = &src_mac {
            let local: Vec<(usize, String, Option<String>)> = gws.iter().filter(|(i, _, _)| net.boxes[*i].port_for(m, None).map(|e| net.across(*i, &e.iface).map(|(n, _)| !net.by_node.contains_key(&n)).unwrap_or(true)).unwrap_or(false)).cloned().collect();
            if local.len() == 1 {
                how = format!("Several devices route for the subnet; {} learns {src}'s MAC on an edge port.", net.boxes[local[0].0].name);
                gws = local;
            }
        }
        if gws.len() > 1 {
            ctx.warn(format!("{} all route for {src}'s subnet; each is followed.", gws.iter().map(|(i, _, _)| net.boxes[*i].name.clone()).collect::<Vec<_>>().join(", ")));
        }
    }
    if how.is_empty() {
        how = format!("{} has {src}'s subnet as attached.", net.boxes[gws[0].0].name);
    }
    let endpoint = src_mac.as_ref().and_then(|m| {
        let (g, _, iface) = &gws[0];
        let (_, edge) = ctx.l2_path(*g, iface.as_deref(), Some(m), None);
        edge.map(|(sw, port)| Place { switch: net.boxes[sw].name.clone(), port, vlan: iface.as_deref().and_then(svi_vlan), mac: m.clone() })
    });
    let starts = gws.iter().map(|(b, vrf, iface)| Start { b: *b, vrf: vrf.clone(), in_if: iface.clone(), src }).collect();
    Ok((starts, Source { starts: gws.iter().map(|(b, _, _)| net.boxes[*b].name.clone()).collect(), endpoint, how }))
}

/// Trace one direction.
pub fn trace(net: &Net, req: &Request) -> Trace {
    let to: IpAddr = match req.to.trim().parse() {
        Ok(a) => a,
        Err(_) => match net.find_box(&req.to) {
            Some(b) => match net.boxes[b].host.parse().ok().or_else(|| net.boxes[b].addrs.first().map(|a| a.ip)) {
                Some(a) => a,
                None => return Trace::refused(req, None, format!("{} has no address to trace to.", net.boxes[b].name)),
            },
            None => return Trace::refused(req, None, format!("\"{}\" is neither an IP address nor a collected device.", req.to.trim())),
        },
    };
    let mut ctx = Ctx {
        net,
        return_of: req.return_of.clone(),
        proto: req.protocol.as_deref().and_then(firewall::proto_number),
        port: req.port,
        down: BTreeSet::new(),
        down_links: Vec::new(),
        paths: vec![],
        warnings: Default::default(),
        truncated: false,
        in_underlay: false,
    };
    for d in &req.down_devices {
        match net.find_box(d) {
            Some(b) => {
                ctx.down.insert(b);
            }
            None => {
                ctx.warn(format!("What-if: \"{d}\" is not a collected device, so marking it down changes nothing."));
            }
        }
    }
    for l in &req.down_links {
        match net.find_box(&l.device) {
            Some(b) => ctx.down_links.push((b, key(&l.interface))),
            None => {
                ctx.warn(format!("What-if: \"{}\" is not a collected device.", l.device));
            }
        }
    }
    let (starts, source) = match locate(&ctx, &req.from, req.vrf.as_deref()) {
        Ok(x) => x,
        Err(why) => return Trace::refused(req, None, why),
    };
    for s in starts {
        if ctx.down.contains(&s.b) {
            ctx.paths.push(Path { hops: vec![], ending: Ending::Dropped { at: net.boxes[s.b].name.clone(), reason: format!("{} is where the path starts, and it is marked down.", net.boxes[s.b].name) } });
            continue;
        }
        ctx.step(At { b: s.b, vrf: s.vrf, in_if: s.in_if, src: s.src, dst: to, ttl: TTL, seen: vec![] }, vec![]);
    }
    let mut warnings: Vec<String> = ctx.warnings.take();
    if !req.down_devices.is_empty() || !req.down_links.is_empty() {
        warnings.push("What-if recomputes from the same collection: only routes each device already held are known, so it approximates how the network would reconverge.".into());
    }
    if ctx.truncated {
        warnings.push(format!("More than {MAX_PATHS} equal-cost paths; the rest were not walked."));
    }
    Trace { from: req.from.clone(), to: req.to.clone(), source: Some(source), paths: ctx.paths, warnings, truncated: ctx.truncated }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The page reads these by their camelCase names.
    #[test]
    fn an_ending_serialises_with_camel_case_fields() {
        let e = Ending::Unmanaged { at: "R1".into(), next_hop: "192.0.2.1".into(), mac: None, name: None };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "unmanaged");
        assert_eq!(v["nextHop"], "192.0.2.1");
    }

    #[test]
    fn svis_name_their_vlan() {
        assert_eq!(svi_vlan("Vlan10").as_deref(), Some("10"));
        assert_eq!(svi_vlan("vlan.20").as_deref(), Some("20"));
        assert_eq!(svi_vlan("irb.30").as_deref(), Some("30"));
        assert_eq!(svi_vlan("GigabitEthernet0/1"), None);
    }

    #[test]
    fn a_net_prints_as_a_prefix() {
        assert_eq!(crate::model::Prefix::new("192.0.2.77".parse().unwrap(), 24).to_string(), "192.0.2.0/24");
    }

    #[test]
    fn a_longer_static_route_to_the_next_hop_is_followed_over_the_attached_subnet() {
        use crate::model::{Addr, NextHop, Prefix, RouteEntry};
        // 10.0.0.0/24 is attached on Gi1; a static /32 for 10.0.0.9
        // points the other way, by 10.0.1.1 on Gi2. The device follows the /32.
        let mut b = Box_::default();
        b.addrs.push(Addr { ip: "10.0.0.1".parse().unwrap(), len: Some(24), iface: Some("Gi1".into()), vrf: "default".into() });
        b.addrs.push(Addr { ip: "10.0.1.2".parse().unwrap(), len: Some(24), iface: Some("Gi2".into()), vrf: "default".into() });
        b.routes.push(RouteEntry { vrf: "default".into(), net: Prefix::parse("10.0.0.0/24").unwrap(), proto: "connected".into(), ad: Some(0), metric: Some(0), next_hops: vec![NextHop { ip: None, iface: Some("Gi1".into()), vrf: None }], command: "route".into() });
        b.routes.push(RouteEntry { vrf: "default".into(), net: Prefix::parse("10.0.0.9/32").unwrap(), proto: "static".into(), ad: Some(1), metric: Some(0), next_hops: vec![NextHop { ip: Some("10.0.1.1".parse().unwrap()), iface: None, vrf: None }], command: "route".into() });
        let got = resolve(&b, "default", "10.0.0.9".parse().unwrap(), 0, vec![]).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, "10.0.1.1".parse::<IpAddr>().unwrap());
        assert_eq!(got[0].1.as_deref(), Some("Gi2"));
        // Another address on the attached subnet, with no longer route, stays attached.
        let plain = resolve(&b, "default", "10.0.0.7".parse().unwrap(), 0, vec![]).unwrap();
        assert_eq!(plain[0].1.as_deref(), Some("Gi1"));
    }
}
