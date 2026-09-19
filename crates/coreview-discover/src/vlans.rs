//! VLANs, and which ports are trunks and which are access ports (LT-203).
//!
//! A link between two switches is a trunk carrying a list of VLANs; a port to
//! a host is an access port in one. The diagram draws those differently and
//! the VLAN colouring (LT-027) needs to know which is which.
//!
//! **Written against captured output** (not D-026): `show vlan brief`,
//! `show interfaces trunk` and `show interfaces status` from a WS-C2960CX on
//! IOS 15.2(7)E, 2026-09-16. VLAN names in the tests are invented (D-027): the
//! lab's own names are not examples to ship.

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vlan {
    pub id: u16,
    pub name: String,
    pub status: String,
    /// Access ports in it, as printed (`Gi0/2`).
    pub ports: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortVlans {
    pub port: String,
    /// `trunk`, `access`, or `routed` for a port with no VLAN.
    pub mode: String,
    /// The access VLAN, or the trunk's native VLAN.
    pub vlan: Option<u16>,
    /// A trunk's allowed-and-active VLANs, expanded.
    pub trunk_vlans: Vec<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortStatus {
    pub port: String,
    pub description: String,
    /// `connected`, `notconnect`, `disabled`, `err-disabled`.
    pub status: String,
    /// `trunk`, `routed`, or the access VLAN.
    pub vlan: String,
    pub duplex: String,
    pub speed: String,
    pub media: String,
}

pub const COMMANDS: &[&str] = &["show vlan brief", "show interfaces trunk", "show interfaces status"];

/// Expands `1,8,10,14-16` into every VLAN it names. Anything unreadable is
/// skipped, and `none` is empty.
pub fn expand_vlan_list(text: &str) -> Vec<u16> {
    let mut out = Vec::new();
    for part in text.split(',') {
        let part = part.trim();
        if let Some((a, b)) = part.split_once('-') {
            if let (Ok(a), Ok(b)) = (a.trim().parse::<u16>(), b.trim().parse::<u16>()) {
                // VLAN 0 is reserved and cannot be configured (LT-283).
                if a <= b && b <= 4094 && b - a < 4094 {
                    out.extend(a.max(1)..=b);
                }
            }
        } else if let Ok(v) = part.parse::<u16>() {
            if (1..=4094).contains(&v) {
                out.push(v);
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// Parses `show vlan brief`, including the continuation lines a long port list
/// wraps onto.
pub fn parse_vlan_brief(output: &str) -> Vec<Vlan> {
    let mut out: Vec<Vlan> = Vec::new();
    for line in output.lines() {
        if line.trim().is_empty() || line.starts_with("VLAN") || line.starts_with("----") {
            continue;
        }
        if line.starts_with(' ') {
            // A wrapped port list belongs to the VLAN above.
            if let Some(last) = out.last_mut() {
                last.ports.extend(split_ports(line));
            }
            continue;
        }
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 3 {
            continue;
        }
        let Ok(id) = f[0].parse::<u16>() else { continue };
        // Name, status, then ports. The status column is one word.
        let name = f[1].to_string();
        let status = f[2].to_string();
        let ports = split_ports(&f[3..].join(" "));
        out.push(Vlan { id, name, status, ports });
    }
    out
}

fn split_ports(text: &str) -> Vec<String> {
    text.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect()
}

/// Parses `show interfaces trunk`: each trunk with its native VLAN and the
/// VLANs allowed and active on it.
pub fn parse_trunks(output: &str) -> Vec<PortVlans> {
    let mut native: BTreeMap<String, Option<u16>> = BTreeMap::new();
    let mut active: BTreeMap<String, Vec<u16>> = BTreeMap::new();
    let mut allowed: BTreeMap<String, Vec<u16>> = BTreeMap::new();
    let mut section = "";
    for line in output.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if t.starts_with("Port") {
            section = if t.contains("Native vlan") {
                "native"
            } else if t.contains("allowed and active") {
                "active"
            } else if t.contains("allowed on trunk") {
                "allowed"
            } else {
                "other"
            };
            continue;
        }
        let f: Vec<&str> = t.split_whitespace().collect();
        match section {
            "native" if f.len() >= 5 => {
                native.insert(f[0].to_string(), f[4].parse().ok());
            }
            "active" if f.len() >= 2 => {
                active.insert(f[0].to_string(), expand_vlan_list(f[1]));
            }
            "allowed" if f.len() >= 2 => {
                allowed.insert(f[0].to_string(), expand_vlan_list(f[1]));
            }
            _ => {}
        }
    }
    native
        .into_iter()
        .map(|(port, vlan)| {
            let trunk_vlans = active.remove(&port).or_else(|| allowed.remove(&port)).unwrap_or_default();
            PortVlans { port, mode: "trunk".into(), vlan, trunk_vlans }
        })
        .collect()
}

/// Parses `show interfaces status`. Columns are found from the header, because
/// the description column is free text and may hold spaces.
pub fn parse_interface_status(output: &str) -> Vec<PortStatus> {
    let mut out = Vec::new();
    let mut cols: Option<[usize; 7]> = None;
    for line in output.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if line.starts_with("Port") && line.contains("Status") && line.contains("Vlan") {
            let find = |name: &str| line.find(name);
            cols = match (find("Port"), find("Name"), find("Status"), find("Vlan"), find("Duplex"), find("Speed"), find("Type")) {
                (Some(a), Some(b), Some(c), Some(d), Some(e), Some(f), Some(g)) => Some([a, b, c, d, e, f, g]),
                _ => None,
            };
            continue;
        }
        let Some(c) = cols else { continue };
        if !line.starts_with(|ch: char| ch.is_ascii_alphabetic()) {
            continue;
        }
        let port = line.split_whitespace().next().unwrap_or("").to_string();
        // Status, VLAN, duplex and speed are single words right-aligned to
        // their headers in places, so they are read as words after the name.
        let name_end = c[2].min(line.len());
        let description = line.get(c[1]..name_end).unwrap_or("").trim().to_string();
        let rest: Vec<&str> = line.get(name_end..).unwrap_or("").split_whitespace().collect();
        if rest.len() < 4 {
            continue;
        }
        out.push(PortStatus {
            port,
            description,
            status: rest[0].to_string(),
            vlan: rest[1].to_string(),
            duplex: rest[2].to_string(),
            speed: rest[3].to_string(),
            media: rest[4..].join(" "),
        });
    }
    out
}

/// Each port's mode and VLANs, from the status table and the trunk table.
pub fn port_vlans(status: &[PortStatus], trunks: &[PortVlans]) -> Vec<PortVlans> {
    let mut out: Vec<PortVlans> = Vec::new();
    for s in status {
        if let Some(t) = trunks.iter().find(|t| t.port == s.port) {
            out.push(t.clone());
        } else if s.vlan == "trunk" {
            out.push(PortVlans { port: s.port.clone(), mode: "trunk".into(), vlan: None, trunk_vlans: Vec::new() });
        } else if let Ok(v) = s.vlan.parse::<u16>() {
            out.push(PortVlans { port: s.port.clone(), mode: "access".into(), vlan: Some(v), trunk_vlans: Vec::new() });
        } else {
            out.push(PortVlans { port: s.port.clone(), mode: "routed".into(), vlan: None, trunk_vlans: Vec::new() });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    /// LT-283: a range starting at 0 named VLAN 0, which cannot exist.
    #[test]
    fn a_range_from_zero_names_no_vlan_zero() {
        assert_eq!(expand_vlan_list("0-0,"), Vec::<u16>::new());
        assert_eq!(expand_vlan_list("0-3"), vec![1, 2, 3]);
    }

    /// `show vlan brief` as captured on 2026-09-16, first rows, names invented.
    const VLAN_BRIEF: &str = "\
VLAN Name                             Status    Ports
---- -------------------------------- --------- -------------------------------
1    default                          active    Gi0/2, Gi0/3, Gi0/4, Gi0/5, Gi0/6, Gi0/7, Gi0/10, Gi0/11, Gi0/12
8    STAFF                            active
10   CLIENTS                          active
430  voice                            active    Gi0/2
1002 fddi-default                     act/unsup
";

    /// `show interfaces trunk` as captured.
    const TRUNKS: &str = "\
Port        Mode             Encapsulation  Status        Native vlan
Gi0/1       on               802.1q         trunking      1
Gi0/8       on               802.1q         trunking      1

Port        Vlans allowed on trunk
Gi0/1       1-4094
Gi0/8       1-4094

Port        Vlans allowed and active in management domain
Gi0/1       1,8,10,14-16,20
Gi0/8       1,8,10

Port        Vlans in spanning tree forwarding state and not pruned
Gi0/1       1,8,10,14-16,20
Gi0/8       1,8,10
";

    /// `show interfaces status` as captured.
    const STATUS: &str = "\
Port      Name               Status       Vlan       Duplex  Speed Type
Gi0/1                        connected    trunk      a-full   1000 10/100/1000BaseTX
Gi0/2                        notconnect   1            auto   auto 10/100/1000BaseTX
Gi0/7                        connected    1          a-full a-1000 10/100/1000BaseTX
Gi0/11                       notconnect   1            auto   auto Not Present
";

    #[test]
    fn reads_the_captured_vlan_table() {
        let v = parse_vlan_brief(VLAN_BRIEF);
        assert_eq!(v.len(), 5);
        assert_eq!(v[0].id, 1);
        assert_eq!(v[0].ports.len(), 9);
        assert_eq!(v[1], Vlan { id: 8, name: "STAFF".into(), status: "active".into(), ports: vec![] });
        assert_eq!(v[3].ports, vec!["Gi0/2"]);
        assert_eq!(v[4].status, "act/unsup");
    }

    #[test]
    fn reads_the_captured_trunks() {
        let t = parse_trunks(TRUNKS);
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].port, "Gi0/1");
        assert_eq!(t[0].vlan, Some(1));
        assert_eq!(t[0].trunk_vlans, vec![1, 8, 10, 14, 15, 16, 20]);
    }

    #[test]
    fn reads_the_captured_port_status() {
        let s = parse_interface_status(STATUS);
        assert_eq!(s.len(), 4);
        assert_eq!(s[0].status, "connected");
        assert_eq!(s[0].vlan, "trunk");
        assert_eq!(s[0].speed, "1000");
        assert_eq!(s[2].speed, "a-1000");
        assert_eq!(s[3].media, "Not Present");
        let modes = port_vlans(&s, &parse_trunks(TRUNKS));
        assert_eq!(modes[0].mode, "trunk");
        assert_eq!(modes[1].mode, "access");
        assert_eq!(modes[1].vlan, Some(1));
    }

    #[test]
    fn a_description_with_spaces_stays_in_its_column() {
        let text = "\
Port      Name               Status       Vlan       Duplex  Speed Type
Gi0/3     to printer room    connected    30         a-full  a-100 10/100/1000BaseTX
";
        let s = parse_interface_status(text);
        assert_eq!(s[0].description, "to printer room");
        assert_eq!(s[0].vlan, "30");
    }

    #[test]
    fn expands_ranges_and_ignores_rubbish() {
        assert_eq!(expand_vlan_list("1,8,10,14-16"), vec![1, 8, 10, 14, 15, 16]);
        assert_eq!(expand_vlan_list("none"), Vec::<u16>::new());
        assert_eq!(expand_vlan_list("5-3,9999,7"), vec![7]);
        assert_eq!(expand_vlan_list("1-4094").len(), 4094);
    }
}
