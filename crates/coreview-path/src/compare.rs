//! A trace against something else (LT-533, LT-534): the same flow's way
//! back, and a traceroute taken from the source device.

use std::net::Ipv4Addr;

use serde::Serialize;

use crate::model::Net;
use crate::walk::{trace, Ending, Path, Request, Trace};

/// The routers a path crosses, in order (not the switches between them).
pub fn routers(p: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for h in &p.hops {
        if out.last() != Some(&h.device) {
            out.push(h.device.clone());
        }
    }
    out
}

fn firewalls(p: &Path) -> Vec<String> {
    p.hops.iter().filter(|h| h.firewall.is_some()).map(|h| h.device.clone()).collect()
}

/// The way there against the way back.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asymmetry {
    /// Both ways cross the same routers.
    pub symmetric: bool,
    pub only_forward: Vec<String>,
    pub only_reverse: Vec<String>,
    /// In sentences, the differences that matter.
    pub notes: Vec<String>,
}

pub fn asymmetry(forward: &Trace, reverse: &Trace) -> Option<Asymmetry> {
    let there: Vec<&Path> = forward.paths.iter().filter(|p| matches!(p.ending, Ending::Delivered { .. })).collect();
    let back: Vec<&Path> = reverse.paths.iter().filter(|p| matches!(p.ending, Ending::Delivered { .. })).collect();
    if there.is_empty() || back.is_empty() {
        return None;
    }
    let fwd: std::collections::BTreeSet<String> = there.iter().flat_map(|p| routers(p)).collect();
    let rev: std::collections::BTreeSet<String> = back.iter().flat_map(|p| routers(p)).collect();
    let only_forward: Vec<String> = fwd.difference(&rev).cloned().collect();
    let only_reverse: Vec<String> = rev.difference(&fwd).cloned().collect();
    let mut notes = Vec::new();
    let fw_there: std::collections::BTreeSet<String> = there.iter().flat_map(|p| firewalls(p)).collect();
    let fw_back: std::collections::BTreeSet<String> = back.iter().flat_map(|p| firewalls(p)).collect();
    for f in fw_there.difference(&fw_back) {
        notes.push(format!("{f} filters the way there but not the way back: a stateful firewall that sees one direction of a flow drops the other."));
    }
    for f in fw_back.difference(&fw_there) {
        notes.push(format!("{f} filters the way back but not the way there: a stateful firewall that sees one direction of a flow drops the other."));
    }
    if !only_forward.is_empty() || !only_reverse.is_empty() {
        notes.insert(0, "The way back crosses different routers from the way there.".into());
    }
    Some(Asymmetry { symmetric: only_forward.is_empty() && only_reverse.is_empty(), only_forward, only_reverse, notes })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRow {
    /// The traceroute's hop number.
    pub n: usize,
    pub traceroute: Option<String>,
    /// The collected device answering from that address, if any.
    pub traceroute_device: Option<String>,
    pub modeled: Option<String>,
    pub agrees: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verify {
    /// Which modeled path it was compared with (the best-matching one).
    pub path: usize,
    pub rows: Vec<VerifyRow>,
    pub match_percent: u8,
}

/// A traceroute from the source device against the modeled paths. The
/// traceroute's first answer is the device after the source, so it is
/// compared with the second router on, and the destination's own answer
/// with the delivery.
pub fn verify(net: &Net, forward: &Trace, hops: &[Option<String>]) -> Option<Verify> {
    if hops.is_empty() || forward.paths.is_empty() {
        return None;
    }
    let named: Vec<(Option<String>, Option<String>)> = hops
        .iter()
        .map(|h| {
            let addr = h.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && s != "*");
            let dev = addr.as_deref().and_then(|a| a.parse::<Ipv4Addr>().ok()).and_then(|a| net.by_ip.get(&a)).map(|&i| net.boxes[i].name.clone());
            (addr, dev)
        })
        .collect();
    let mut best: Option<Verify> = None;
    for (pi, p) in forward.paths.iter().enumerate() {
        let mut modeled: Vec<String> = routers(p).into_iter().skip(1).collect();
        match &p.ending {
            Ending::Unmanaged { next_hop, .. } => modeled.push(next_hop.clone()),
            Ending::Delivered { device: None, .. } => modeled.push(forward.to.clone()),
            _ => {}
        }
        let len = modeled.len().max(named.len());
        let mut rows = Vec::new();
        let mut agree = 0usize;
        for i in 0..len {
            let (addr, dev) = named.get(i).cloned().unwrap_or((None, None));
            let m = modeled.get(i).cloned();
            let ok = match (&m, &dev, &addr) {
                (Some(m), Some(d), _) => m == d,
                (Some(m), None, Some(a)) => m == a,
                _ => false,
            };
            if ok {
                agree += 1;
            }
            rows.push(VerifyRow { n: i + 1, traceroute: addr, traceroute_device: dev, modeled: m, agrees: ok });
        }
        let pct = (agree * 100).checked_div(len).unwrap_or(0) as u8;
        if best.as_ref().map(|b| pct > b.match_percent).unwrap_or(true) {
            best = Some(Verify { path: pi, rows, match_percent: pct });
        }
    }
    best
}

/// Everything one trace request gives: the way there, the way back, how
/// they differ, and the traceroute comparison when one was supplied.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub forward: Trace,
    pub reverse: Option<Trace>,
    pub asymmetry: Option<Asymmetry>,
    pub verify: Option<Verify>,
}

/// The address the way back starts from: the forward trace's destination
/// as the last device saw it (after any destination NAT).
fn back_from(forward: &Trace) -> Option<String> {
    let p = forward.paths.iter().find(|p| matches!(p.ending, Ending::Delivered { .. }))?;
    let last = p.hops.last()?;
    Some(last.nat.iter().rev().find(|r| r.field == "destination").map(|r| r.now.clone()).unwrap_or_else(|| last.dst.clone()))
}

/// The address the way back is addressed to: the source as it left.
fn back_to(forward: &Trace, req: &Request) -> String {
    let src = forward.paths.iter().find_map(|p| p.hops.first().map(|h| h.src.clone()));
    match req.from.trim().parse::<Ipv4Addr>() {
        Ok(_) => req.from.trim().to_string(),
        Err(_) => src.unwrap_or_else(|| req.from.clone()),
    }
}

pub fn run(net: &Net, req: &Request) -> Outcome {
    let forward = trace(net, req);
    let reverse = if req.no_reverse {
        None
    } else {
        back_from(&forward).map(|from| {
            let crossed: Vec<String> = forward.paths.iter().flat_map(firewalls).collect();
            let back = Request { from, to: back_to(&forward, req), vrf: None, traceroute: None, no_reverse: true, return_of: Some(crossed), ..req.clone() };
            trace(net, &back)
        })
    };
    let asymmetry = reverse.as_ref().and_then(|r| asymmetry(&forward, r));
    let verify = req.traceroute.as_ref().and_then(|t| verify(net, &forward, t));
    Outcome { forward, reverse, asymmetry, verify }
}

/// What one live command answered, reduced to what the comparison reads:
/// the next hops and interfaces its rows name (normalised as route rows),
/// and its scrubbed reply.
#[derive(Debug, Clone, Default)]
pub struct LiveEvidence {
    pub command: String,
    pub status: String,
    pub next_hops: Vec<String>,
    pub interfaces: Vec<String>,
    pub raw: String,
}

/// Whether the device's own answers agree with the modeled hop.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveCheck {
    /// `None` when nothing it answered can be read against the model.
    pub agrees: Option<bool>,
    pub detail: String,
}

fn addresses_in(text: &str) -> Vec<Ipv4Addr> {
    text.split(|c: char| !(c.is_ascii_digit() || c == '.')).filter_map(|t| t.trim_matches('.').parse().ok()).collect()
}

/// The addresses a routing answer names as where it sends traffic: after
/// `via`, `addr`, `nexthop`, `gateway`, or a `*` descriptor line.
fn stated_next_hops(raw: &str) -> Vec<Ipv4Addr> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let l = line.trim().to_ascii_lowercase();
        for marker in ["via ", "addr ", "nexthop ", "next-hop ", "gateway ", "* "] {
            let mut rest = l.as_str();
            while let Some(i) = rest.find(marker) {
                rest = &rest[i + marker.len()..];
                if let Some(a) = addresses_in(rest.split([',', ' ', '\t']).next().unwrap_or("")).into_iter().next() {
                    if !out.contains(&a) {
                        out.push(a);
                    }
                }
            }
        }
    }
    out
}

/// Held against the hop: its next hop (or, for an attached subnet, its
/// interface), then its firewall policy by name.
pub fn live_check(hop: &crate::walk::Hop, answers: &[LiveEvidence]) -> LiveCheck {
    let answered: Vec<&LiveEvidence> = answers.iter().filter(|a| a.status == "ok").collect();
    if answered.is_empty() {
        return LiveCheck { agrees: None, detail: "The device answered none of the live commands.".into() };
    }
    let nh: Option<Ipv4Addr> = hop.next_hop.as_deref().and_then(|s| s.parse().ok());
    let out_key = hop.out_interface.as_deref().map(coreview_topology::ifname::key);
    for a in &answered {
        let routing = ["route", "cef", "fib", "hash"].iter().any(|w| a.command.to_ascii_lowercase().contains(w));
        if !routing {
            continue;
        }
        // Rows first: the template read the device's own table.
        let row_hops: Vec<Ipv4Addr> = a.next_hops.iter().filter_map(|h| h.split(['%', '/']).next().and_then(|x| x.trim().parse().ok())).collect();
        if let Some(nh) = nh {
            if row_hops.contains(&nh) {
                return LiveCheck { agrees: Some(true), detail: format!("{} lists {nh}, the modeled next hop.", a.command) };
            }
            if !row_hops.is_empty() {
                return LiveCheck { agrees: Some(false), detail: format!("{} lists {}, and the model says {nh}.", a.command, row_hops.iter().map(|h| h.to_string()).collect::<Vec<_>>().join(", ")) };
            }
            let stated = stated_next_hops(&a.raw);
            if stated.contains(&nh) {
                return LiveCheck { agrees: Some(true), detail: format!("{} names {nh}, the modeled next hop.", a.command) };
            }
            if !stated.is_empty() {
                return LiveCheck { agrees: Some(false), detail: format!("{} names {}, and the model says {nh}.", a.command, stated.iter().map(|h| h.to_string()).collect::<Vec<_>>().join(", ")) };
            }
        } else if let Some(k) = &out_key {
            if a.interfaces.iter().any(|i| &coreview_topology::ifname::key(i) == k) {
                return LiveCheck { agrees: Some(true), detail: format!("{} names {}, the modeled interface.", a.command, hop.out_interface.clone().unwrap_or_default()) };
            }
        }
    }
    if let Some(policy) = hop.firewall.as_ref().and_then(|f| f.policy.clone()) {
        let bare = policy.split(" (").next().unwrap_or(&policy).to_string();
        for a in &answered {
            let l = a.command.to_ascii_lowercase();
            if l.contains("policy") || l.contains("packet-tracer") {
                return if a.raw.contains(&bare) {
                    LiveCheck { agrees: Some(true), detail: format!("{} names {bare}, the modeled policy.", a.command) }
                } else {
                    LiveCheck { agrees: None, detail: format!("{} does not name {bare}; its reply is shown as the device gave it.", a.command) }
                };
            }
        }
    }
    LiveCheck { agrees: None, detail: "The device answered, and nothing in the replies is read against the model; they are shown as the device gave them.".into() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::walk::{Decision, Hop};

    fn hop(nh: Option<&str>, out: Option<&str>) -> Hop {
        Hop {
            device: "R1".into(),
            in_interface: None,
            vrf: "default".into(),
            src: "192.0.2.10".into(),
            dst: "203.0.113.5".into(),
            decision: Decision::Lpm,
            matched: None,
            via: vec![],
            out_interface: out.map(str::to_string),
            next_hop: nh.map(str::to_string),
            next_hop_mac: None,
            next_device: None,
            l2: vec![],
            firewall: None,
            nat: vec![],
            ecmp: 0,
            overlay: None,
            notes: vec![],
        }
    }

    fn said(command: &str, raw: &str) -> LiveEvidence {
        LiveEvidence { command: command.into(), status: "ok".into(), raw: raw.into(), ..Default::default() }
    }

    #[test]
    fn an_ios_route_entry_naming_the_modeled_next_hop_agrees() {
        let raw = "Routing entry for 203.0.113.0/24\n  Known via \"ospf 1\", distance 110, metric 3\n  Routing Descriptor Blocks:\n  * 198.51.100.2, from 192.0.2.254, 00:10:11 ago, via GigabitEthernet1/0/49\n";
        let c = live_check(&hop(Some("198.51.100.2"), Some("Gi1/0/49")), &[said("show ip route 203.0.113.5", raw)]);
        assert_eq!(c.agrees, Some(true), "{}", c.detail);
        let c = live_check(&hop(Some("198.51.100.6"), Some("Gi1/0/50")), &[said("show ip route 203.0.113.5", raw)]);
        assert_eq!(c.agrees, Some(false), "{}", c.detail);
        assert!(c.detail.contains("198.51.100.2"));
    }

    #[test]
    fn a_cef_answer_is_read_by_its_adjacency() {
        let raw = "192.0.2.10 -> 203.0.113.5 =>IP adj out of GigabitEthernet1/0/49, addr 198.51.100.2\n";
        assert_eq!(live_check(&hop(Some("198.51.100.2"), None), &[said("show ip cef exact-route 192.0.2.10 203.0.113.5", raw)]).agrees, Some(true));
    }

    #[test]
    fn rows_are_read_before_the_raw_text() {
        let a = LiveEvidence { command: "show ip route 203.0.113.5".into(), status: "ok".into(), next_hops: vec!["198.51.100.6".into()], raw: "* 198.51.100.2".into(), ..Default::default() };
        assert_eq!(live_check(&hop(Some("198.51.100.2"), None), &[a]).agrees, Some(false));
    }

    #[test]
    fn nothing_readable_is_neither_agreement_nor_disagreement() {
        assert_eq!(live_check(&hop(Some("198.51.100.2"), None), &[said("show mac address-table address 0000.0000.0001", "Vlan Mac Address Type Ports")]).agrees, None);
        assert_eq!(live_check(&hop(Some("198.51.100.2"), None), &[]).agrees, None);
    }
}
