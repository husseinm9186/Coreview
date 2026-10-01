//! A controller's access points (LT-596): a FortiGate's FortiAPs, a WLC's
//! APs, from the `ap` table. Each is a node — the same node a switch's
//! CDP/LLDP already made of it, when one did — with its address, MAC and
//! model. What an AP reports over its own LLDP about its wired port is a
//! cable to that switch port. The controller's tunnel to an AP is control,
//! not a wire, and is not drawn as a link.

use std::collections::BTreeSet;

use crate::identity::Identities;
use crate::ifname::{canonical, mac};
use crate::model::*;

pub fn access_points(devices: &[DeviceIn], graph: &mut Graph, ids: &mut Identities) {
    for d in devices {
        let Some(controller) = ids.of_device.get(&d.device_id).cloned() else { continue };
        for r in d.rows("ap") {
            let Some(name) = r.get("ap_name") else { continue };
            let ip = r.get("ap_ip");
            let m = r.get("ap_mac").and_then(mac);
            let serial = r.extra.get("serial").and_then(|v| v.as_str()).map(str::to_ascii_uppercase);
            let id = match ids.find(m.as_deref(), ip, Some(name), serial.as_deref()) {
                Some(id) if id != controller => id,
                _ => {
                    let id = format!("ap-{}", crate::identity::name_key(name));
                    if !graph.nodes.iter().any(|n| n.id == id) {
                        graph.nodes.push(bare(&id, name));
                    }
                    id
                }
            };
            if let Some(n) = graph.nodes.iter_mut().find(|n| n.id == id) {
                if n.kind != NodeKind::Collected {
                    n.role = Some("ap".into());
                }
                if n.model.is_none() {
                    n.model = r.get("model").map(str::to_string);
                    n.platform = n.platform.clone().or_else(|| n.model.clone());
                }
                if n.mgmt_ip.is_none() {
                    n.mgmt_ip = ip.map(str::to_string);
                }
                if let Some(ip) = ip {
                    if !n.addresses.iter().any(|(a, _, _, _)| a == ip) {
                        n.addresses.push((ip.to_string(), None, None, true));
                    }
                }
                n.macs.extend(m.clone());
                n.serials.extend(serial.clone());
                let clone = n.clone();
                ids.index(&clone);
            }
            // The AP's own LLDP: the switch port it is plugged into.
            let Some(sw_name) = r.get("nbr_switch") else { continue };
            // LT-656: the switch by its chassis or address first — a CDP
            // device-id is often not the hostname the switch gave.
            let sw = ids.find(r.get("nbr_chassis"), r.get("nbr_ip"), Some(sw_name), None).unwrap_or_else(|| {
                let sid = format!("p-{}", crate::identity::name_key(sw_name));
                if !graph.nodes.iter().any(|n| n.id == sid) {
                    let mut node = bare(&sid, sw_name);
                    node.macs = r.get("nbr_chassis").and_then(mac).into_iter().collect::<BTreeSet<_>>();
                    node.platform = r.get("nbr_platform").map(str::to_string);
                    node.model = node.platform.clone();
                    ids.index(&node);
                    graph.nodes.push(node);
                }
                sid
            });
            if sw == id {
                continue;
            }
            let port = r.get("nbr_port").map(canonical);
            let already = graph.links.iter_mut().find(|l| (l.a.node == sw && l.b.node == id) || (l.a.node == id && l.b.node == sw));
            let evidence = Evidence {
                device: d.device_id.clone(),
                command: r.command.clone(),
                note: format!("{name}'s LLDP, as its controller reports it, sees {sw_name}{}", r.get("nbr_port").map(|p| format!(" on {p}")).unwrap_or_default()),
            };
            match already {
                Some(l) => {
                    let sw_end = if l.a.node == sw { &mut l.a } else { &mut l.b };
                    if sw_end.port.is_none() {
                        sw_end.port = port;
                    }
                    l.evidence.push(evidence);
                }
                None => graph.links.push(Link {
                    a: End { node: sw, port },
                    b: End { node: id.clone(), port: r.get("local_port").map(canonical) },
                    kind: LinkKind::Lldp,
                    confidence: 0.7,
                    both_directions: false,
                    bundle: None,
                    evidence: vec![evidence],
                }),
            }
        }
    }
}

fn bare(id: &str, name: &str) -> Node {
    Node {
        id: id.to_string(),
        name: name.to_string(),
        kind: NodeKind::Neighbor,
        os: None,
        role: None,
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
    }
}
