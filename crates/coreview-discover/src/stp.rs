//! Spanning tree: which bridge is root, and which ports are blocked (LT-202).
//!
//! A drawn loop is only a fault if spanning tree is not breaking it. The
//! diagram needs two facts per VLAN to say which: who the root bridge is, and
//! which of a switch's ports are not forwarding. A link whose port is blocked
//! is a redundant path, drawn as one, rather than a live one.
//!
//! **Written against captured output** (not D-026): `show spanning-tree` from a
//! WS-C2960CX on IOS 15.2(7)E running rapid-PVST, 2026-09-16 — one VLAN where
//! the switch is not the root and names its root port, several where it is the
//! root, `Peer(STP)` in the type column, and `show spanning-tree blockedports`
//! with nothing blocked. The lab has no blocked port to capture, so the `BLK`
//! and `Altn` rows in the tests are written in the captured row layout.

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StpPort {
    pub port: String,
    /// `Root`, `Desg`, `Altn`, `Back`, as printed.
    pub role: String,
    /// `FWD`, `BLK`, `LRN`, `LIS`, `DIS`, as printed.
    pub state: String,
    pub cost: Option<u32>,
}

impl StpPort {
    /// Not forwarding: blocked, or an alternate or backup port.
    pub fn is_blocked(&self) -> bool {
        matches!(self.state.as_str(), "BLK" | "DIS" | "BKN")
            || matches!(self.role.as_str(), "Altn" | "Back")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StpInstance {
    /// `VLAN0001`, `MST0`.
    pub instance: String,
    /// The VLAN number where the instance is one.
    pub vlan: Option<u16>,
    pub protocol: Option<String>,
    /// The root bridge's MAC, lower-case dotted as printed.
    pub root_bridge: Option<String>,
    pub root_priority: Option<u32>,
    /// This switch is the root for the instance.
    pub is_root: bool,
    /// The port towards the root, when this switch is not it.
    pub root_port: Option<String>,
    pub bridge_address: Option<String>,
    pub ports: Vec<StpPort>,
}

pub const COMMAND: &str = "show spanning-tree";

fn after<'a>(line: &'a str, label: &str) -> Option<&'a str> {
    line.trim().strip_prefix(label).map(str::trim)
}

/// Parses `show spanning-tree`. Never fails; an error line is no instances.
pub fn parse_spanning_tree(output: &str) -> Vec<StpInstance> {
    let mut out: Vec<StpInstance> = Vec::new();
    // Which ID block the Address/Priority lines belong to.
    let mut block = "";
    for line in output.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if !line.starts_with(' ') && (t.starts_with("VLAN") || t.starts_with("MST")) && !t.contains(' ') {
            out.push(StpInstance {
                instance: t.to_string(),
                vlan: t.strip_prefix("VLAN").and_then(|n| n.parse().ok()),
                protocol: None,
                root_bridge: None,
                root_priority: None,
                is_root: false,
                root_port: None,
                bridge_address: None,
                ports: Vec::new(),
            });
            block = "";
            continue;
        }
        let Some(current) = out.last_mut() else { continue };
        if let Some(rest) = after(t, "Spanning tree enabled protocol") {
            current.protocol = Some(rest.to_string());
            continue;
        }
        if let Some(rest) = after(t, "Root ID") {
            block = "root";
            if let Some(p) = after(rest, "Priority") {
                current.root_priority = p.split_whitespace().next().and_then(|v| v.parse().ok());
            }
            continue;
        }
        if let Some(_rest) = after(t, "Bridge ID") {
            block = "bridge";
            continue;
        }
        if let Some(addr) = after(t, "Address") {
            let addr = addr.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
            match block {
                "root" => current.root_bridge = Some(addr),
                "bridge" => current.bridge_address = Some(addr),
                _ => {}
            }
            continue;
        }
        if t == "This bridge is the root" {
            current.is_root = true;
            continue;
        }
        if block == "root" {
            if let Some(port) = after(t, "Port") {
                // "1 (GigabitEthernet0/1)"
                if let (Some(open), Some(close)) = (port.find('('), port.rfind(')')) {
                    current.root_port = Some(port[open + 1..close].to_string());
                }
                continue;
            }
        }
        // A port row: name, role, state, cost, prio.nbr, type.
        let f: Vec<&str> = t.split_whitespace().collect();
        if f.len() >= 5
            && matches!(f[1], "Root" | "Desg" | "Altn" | "Back" | "Mstr" | "Shr" | "Bound")
            && f[2].chars().all(|c| c.is_ascii_uppercase())
        {
            current.ports.push(StpPort {
                port: f[0].to_string(),
                role: f[1].to_string(),
                state: f[2].to_string(),
                cost: f[3].parse().ok(),
            });
        }
    }
    // A switch that is the root has no root port; one that is not, says which.
    for i in &mut out {
        if i.is_root {
            i.root_port = None;
        } else if i.root_bridge.is_some() && i.root_bridge == i.bridge_address {
            i.is_root = true;
        }
    }
    out
}

/// Every port blocked in any instance, with the instances it is blocked in.
pub fn blocked_ports(instances: &[StpInstance]) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for i in instances {
        for p in i.ports.iter().filter(|p| p.is_blocked()) {
            match out.iter_mut().find(|(port, _)| port == &p.port) {
                Some((_, list)) => list.push(i.instance.clone()),
                None => out.push((p.port.clone(), vec![i.instance.clone()])),
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from a WS-C2960CX (IOS 15.2(7)E) on 2026-09-16, two of its
    /// instances; MACs renumbered (LT-277).
    const CAPTURED: &str = "\
VLAN0001
  Spanning tree enabled protocol rstp
  Root ID    Priority    32768
             Address     74ac.b900.0005
             Cost        4
             Port        1 (GigabitEthernet0/1)
             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec

  Bridge ID  Priority    32769  (priority 32768 sys-id-ext 1)
             Address     cc7f.7500.0080
             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec
             Aging Time  300 sec

Interface           Role Sts Cost      Prio.Nbr Type
------------------- ---- --- --------- -------- --------------------------------
Gi0/1               Root FWD 4         128.1    P2p
Gi0/7               Desg FWD 4         128.7    P2p
Gi0/8               Desg FWD 4         128.8    P2p Peer(STP)
Gi0/9               Desg FWD 4         128.9    P2p



VLAN0008
  Spanning tree enabled protocol rstp
  Root ID    Priority    32776
             Address     cc7f.7500.0080
             This bridge is the root
             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec

  Bridge ID  Priority    32776  (priority 32768 sys-id-ext 8)
             Address     cc7f.7500.0080
             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec
             Aging Time  300 sec

Interface           Role Sts Cost      Prio.Nbr Type
------------------- ---- --- --------- -------- --------------------------------
Gi0/1               Desg FWD 4         128.1    P2p
Gi0/8               Desg FWD 4         128.8    P2p
Gi0/9               Desg FWD 4         128.9    P2p
";

    #[test]
    fn reads_the_captured_instances() {
        let got = parse_spanning_tree(CAPTURED);
        assert_eq!(got.len(), 2);
        let v1 = &got[0];
        assert_eq!(v1.vlan, Some(1));
        assert_eq!(v1.protocol.as_deref(), Some("rstp"));
        assert_eq!(v1.root_bridge.as_deref(), Some("74ac.b900.0005"));
        assert_eq!(v1.root_priority, Some(32768));
        assert!(!v1.is_root);
        assert_eq!(v1.root_port.as_deref(), Some("GigabitEthernet0/1"));
        assert_eq!(v1.bridge_address.as_deref(), Some("cc7f.7500.0080"));
        assert_eq!(v1.ports.len(), 4);
        assert_eq!(v1.ports[0], StpPort { port: "Gi0/1".into(), role: "Root".into(), state: "FWD".into(), cost: Some(4) });
        let v8 = &got[1];
        assert!(v8.is_root);
        assert_eq!(v8.root_port, None);
        assert!(blocked_ports(&got).is_empty());
    }

    /// Not captured — nothing is blocked in the lab. The captured row layout
    /// with the states IOS prints for a port that is not forwarding.
    #[test]
    fn finds_blocked_and_alternate_ports() {
        let text = "\
VLAN0010
  Spanning tree enabled protocol rstp
  Root ID    Priority    24586
             Address     0000.5e00.5301
             Cost        4
             Port        1 (GigabitEthernet0/1)
Interface           Role Sts Cost      Prio.Nbr Type
------------------- ---- --- --------- -------- --------------------------------
Gi0/1               Root FWD 4         128.1    P2p
Gi0/2               Altn BLK 4         128.2    P2p
";
        let got = parse_spanning_tree(text);
        assert_eq!(blocked_ports(&got), vec![("Gi0/2".to_string(), vec!["VLAN0010".to_string()])]);
    }

    #[test]
    fn an_error_line_is_nothing() {
        assert!(parse_spanning_tree("% Invalid input detected at '^' marker.").is_empty());
    }
}
