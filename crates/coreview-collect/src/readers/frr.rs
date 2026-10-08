//! FRRouting's `show` output — the routing suite under Cumulus Linux,
//! SONiC, VyOS and many a Linux router.
//!
//! **Built from FRR's documentation,** whose layouts are the same
//! whichever shell wraps vtysh: NCLU's `net show route`, SONiC's `show ip
//! route`, or vtysh itself. No capture yet; `verified: docs` until one.

use serde_json::{json, Map, Value};

use super::text::{cells, starts};

/// `show ip route [vrf all]` / `show ipv6 route`: a selected route is the
/// line whose code carries `>` (`B>* 10.2.2.0/24 [20/0] via 10.0.0.1,
/// swp51, weight 1, 00:01:00`), an equal-cost leg is the `  *   via …` line
/// under it, a connected route `is directly connected, swp1`, a blackhole
/// `unreachable (blackhole)`. `VRF <name>:` names the table under `vrf
/// all`. Routes FRR did not select are left out.
pub fn ip_route(raw: &str) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut vrf = "default".to_string();
    let mut last_selected = false;
    for line in raw.lines() {
        let t = line.trim_end();
        let tt = t.trim();
        if tt.is_empty() || tt.starts_with("Codes:") {
            continue;
        }
        if let Some(v) = tt.strip_prefix("VRF ").and_then(|x| x.strip_suffix(':')) {
            vrf = v.trim().to_string();
            continue;
        }
        let indented = t.starts_with(' ');
        let w: Vec<&str> = tt.split_whitespace().collect();
        if w.is_empty() {
            continue;
        }
        // A further leg of the route above.
        if indented && (w[0] == "*" || w[0] == "via") {
            if !last_selected {
                continue;
            }
            if let Some((nh, iface)) = leg(tt.trim_start_matches('*').trim()) {
                if let Some(last) = out.last_mut() {
                    push_leg(last, nh, iface);
                }
            }
            continue;
        }
        // The code: letters plus `>` for selected and `*` for in the FIB.
        let code = w[0];
        if !code.chars().all(|c| c.is_ascii_alphabetic() || c == '>' || c == '*') || code.len() > 4 {
            continue;
        }
        let Some(prefix) = w.get(1).filter(|p| p.contains('/') || p.parse::<std::net::IpAddr>().is_ok()) else { continue };
        last_selected = code.contains('>');
        if !last_selected {
            continue;
        }
        let proto = proto_of(code.trim_matches(['>', '*']));
        let mut m = Map::new();
        m.insert("vrf".into(), json!(vrf));
        m.insert("prefix".into(), json!(prefix));
        m.insert("protocol".into(), json!(proto));
        let rest = tt[tt.find(prefix).map(|i| i + prefix.len()).unwrap_or(tt.len())..].trim();
        let rest = if let Some(r) = rest.strip_prefix('[') {
            if let Some((adm, after)) = r.split_once(']') {
                if let Some((ad, metric)) = adm.split_once('/') {
                    m.insert("ad".into(), json!(ad.trim()));
                    m.insert("metric".into(), json!(metric.trim()));
                }
                after.trim()
            } else {
                rest
            }
        } else {
            rest
        };
        if rest.starts_with("unreachable") || rest.contains("(blackhole)") {
            m.insert("interface".into(), json!("Null0"));
        } else if let Some(r) = rest.strip_prefix("is directly connected,") {
            let iface = r.trim().split([',', ' ']).next().unwrap_or("").to_string();
            m.insert("interface".into(), json!(iface));
        } else if let Some((nh, iface)) = leg(rest) {
            m.insert("next_hop".into(), json!(nh));
            if let Some(i) = iface {
                m.insert("interface".into(), json!(i));
            }
        }
        out.push(Value::Object(m));
    }
    out
}

/// `via 10.0.0.1, swp51, weight 1, 00:01:00` → the next hop and interface;
/// `via 10.0.0.1 (recursive)` has no interface.
fn leg(text: &str) -> Option<(String, Option<String>)> {
    let r = text.trim().strip_prefix("via")?.trim();
    let mut parts = r.split(',').map(str::trim);
    let nh = parts.next()?.split_whitespace().next()?.to_string();
    nh.parse::<std::net::IpAddr>().ok()?;
    let iface = parts.next().filter(|p| !p.is_empty() && !p.starts_with("weight") && !p.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)).map(|p| p.split_whitespace().next().unwrap_or("").to_string()).filter(|p| !p.is_empty() && p != "(recursive)");
    Some((nh, iface))
}

fn push_leg(row: &mut Value, nh: String, iface: Option<String>) {
    let join = |row: &mut Value, key: &str, v: &str| {
        let cur = row.get(key).and_then(Value::as_str).unwrap_or("").to_string();
        row[key] = json!(if cur.is_empty() { v.to_string() } else { format!("{cur}, {v}") });
    };
    join(row, "next_hop", &nh);
    if let Some(i) = iface {
        join(row, "interface", &i);
    }
}

/// FRR's code letters as the words the path builder knows.
fn proto_of(code: &str) -> &'static str {
    match code {
        "K" => "kernel",
        "C" => "connected",
        "L" => "local",
        "S" => "static",
        "R" => "rip",
        "O" => "ospf",
        "I" => "isis",
        "B" => "bgp",
        "E" => "eigrp",
        "N" => "nhrp",
        "T" => "table",
        "F" => "pbr",
        "A" => "babel",
        "D" => "sharp",
        _ => "other",
    }
}

/// `show ip bgp summary` (and the IPv6 and EVPN summaries): per address
/// family a `… Summary (VRF x):` heading, a `Neighbor V AS … Up/Down
/// State/PfxRcd [PfxSnt Desc]` table; the last word before the
/// optional PfxSnt/Desc is a number of prefixes when established and a
/// state word otherwise. An unnumbered peer is its interface.
pub fn bgp_summary(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut vrf = "default".to_string();
    let mut af = String::new();
    let mut in_table = false;
    let mut extra_cols = 0usize;
    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() {
            in_table = false;
            continue;
        }
        if let Some(i) = t.find("Summary") {
            af = t[..i].trim().to_string();
            if let Some(v) = t.split("(VRF ").nth(1) {
                vrf = v.trim().trim_end_matches(':').trim_end_matches(')').trim().to_string();
            }
            in_table = false;
            continue;
        }
        if t.starts_with("Neighbor") && t.contains("State/PfxRcd") {
            in_table = true;
            extra_cols = ["PfxSnt", "Desc"].iter().filter(|c| t.contains(*c)).count();
            continue;
        }
        if !in_table || t.starts_with("Total") || t.starts_with("Displayed") {
            continue;
        }
        let w: Vec<&str> = t.split_whitespace().collect();
        if w.len() < 10 {
            continue;
        }
        let neighbor = w[0];
        let asn = w[2];
        // Desc may have spaces, so count from the known position, not the end.
        let state_pfx = w[9];
        let updown = w[8];
        let mut row = json!({"vrf": vrf, "as": asn, "uptime": updown, "address_family": af});
        if state_pfx.chars().all(|c| c.is_ascii_digit()) {
            row["state"] = json!("Established");
            row["prefixes_received"] = json!(state_pfx);
        } else {
            row["state"] = json!(state_pfx);
        }
        if extra_cols == 2 {
            if let Some(d) = w.get(11) {
                if *d != "N/A" {
                    row["description"] = json!(w[11..].join(" "));
                }
            }
        }
        if neighbor.parse::<std::net::IpAddr>().is_ok() {
            row["neighbor_ip"] = json!(neighbor);
        } else {
            row["local_interface"] = json!(neighbor);
        }
        out.push(row);
    }
    out
}

/// `show ip ospf neighbor`: a fixed-width table whose `Up Time` column
/// newer FRR adds; the Interface cell is `swp51:10.1.1.1` — port and the
/// local address on it.
pub fn ospf_neighbor(raw: &str) -> Vec<Value> {
    let lines: Vec<&str> = raw.lines().collect();
    let Some(h) = lines.iter().position(|l| l.contains("Neighbor ID") && l.contains("State") && l.contains("Interface")) else { return Vec::new() };
    let header = lines[h];
    let mut names = vec!["Neighbor ID", "Pri", "State"];
    if header.contains("Up Time") {
        names.push("Up Time");
    }
    names.extend(["Dead Time", "Address", "Interface", "RXmtL"]);
    let Some(st) = starts(header, &names) else { return Vec::new() };
    let mut out = Vec::new();
    for line in &lines[h + 1..] {
        let t = line.trim();
        if t.is_empty() || t.starts_with("Neighbor") {
            continue;
        }
        let c = cells(line, &st);
        if c[0].parse::<std::net::IpAddr>().is_err() {
            continue;
        }
        let n = names.len();
        let iface_cell = &c[n - 2];
        let (iface, local_ip) = iface_cell.split_once(':').map(|(i, a)| (i.to_string(), Some(a.to_string()))).unwrap_or((iface_cell.clone(), None));
        let mut row = json!({"neighbor_id": c[0], "priority": c[1], "state": c[2], "neighbor_ip": c[n - 3], "local_interface": iface});
        if let Some(a) = local_ip {
            row["local_ip"] = json!(a);
        }
        if header.contains("Up Time") {
            row["uptime"] = json!(c[3]);
        }
        out.push(row);
    }
    out
}

#[cfg(test)]
mod tests {
    //! Layouts from FRR's documentation with invented addresses.
    use super::*;

    #[test]
    fn selected_routes_with_ecmp_legs_connected_and_blackhole() {
        let raw = "Codes: K - kernel route, C - connected, S - static, R - RIP,\n       O - OSPF, I - IS-IS, B - BGP, E - EIGRP, N - NHRP,\n       > - selected route, * - FIB route, q - queued, r - rejected, b - backup\n\nVRF default:\nK>* 0.0.0.0/0 [0/0] via 192.0.2.1, eth0, 00:10:00\nC>* 10.0.0.0/31 is directly connected, swp51, 00:10:00\nB>* 10.2.2.0/24 [20/0] via 10.0.0.1, swp51, weight 1, 00:01:00\n  *                    via 10.0.0.5, swp52, weight 1, 00:01:00\nB   10.2.3.0/24 [200/0] via 10.0.0.9 inactive, 00:01:00\nO>* 10.3.0.0/24 [110/20] via 10.0.0.1, swp51, weight 1, 00:02:00\nS>* 10.9.0.0/16 [1/0] unreachable (blackhole), 00:10:00\nL>* 10.1.0.11/32 is directly connected, lo, 00:10:00\n\nVRF mgmt:\nC>* 192.0.2.0/24 is directly connected, eth0, 00:10:00\n";
        let rows = ip_route(raw);
        assert_eq!(rows.len(), 7, "{rows:#?}");
        assert_eq!(rows[0], json!({"vrf": "default", "prefix": "0.0.0.0/0", "protocol": "kernel", "ad": "0", "metric": "0", "next_hop": "192.0.2.1", "interface": "eth0"}));
        assert_eq!(rows[1], json!({"vrf": "default", "prefix": "10.0.0.0/31", "protocol": "connected", "interface": "swp51"}));
        assert_eq!(rows[2], json!({"vrf": "default", "prefix": "10.2.2.0/24", "protocol": "bgp", "ad": "20", "metric": "0", "next_hop": "10.0.0.1, 10.0.0.5", "interface": "swp51, swp52"}));
        assert_eq!(rows[3]["prefix"], "10.3.0.0/24", "the unselected BGP route is left out");
        assert_eq!(rows[4], json!({"vrf": "default", "prefix": "10.9.0.0/16", "protocol": "static", "ad": "1", "metric": "0", "interface": "Null0"}));
        assert_eq!(rows[5]["protocol"], "local");
        assert_eq!(rows[6]["vrf"], "mgmt");
    }

    #[test]
    fn bgp_summary_with_unnumbered_peers_and_both_column_sets() {
        let raw = "IPv4 Unicast Summary (VRF default):\nBGP router identifier 10.0.0.11, local AS number 65011 vrf-id 0\nBGP table version 8\nRIB entries 15, using 2760 bytes of memory\nPeers 2, using 41 KiB of memory\n\nNeighbor        V         AS   MsgRcvd   MsgSent   TblVer  InQ OutQ  Up/Down State/PfxRcd   PfxSnt Desc\nswp51           4      65020       118       120        0    0    0 00:05:27            7        8 spine01\n10.0.0.9        4      65021         0         0        0    0    0    never       Active        0 N/A\n\nTotal number of neighbors 2\n\nL2VPN EVPN Summary (VRF default):\nBGP router identifier 10.0.0.11, local AS number 65011 vrf-id 0\n\nNeighbor        V         AS   MsgRcvd   MsgSent   TblVer  InQ OutQ  Up/Down State/PfxRcd\nswp51           4      65020       118       120        0    0    0 00:05:27           12\n\nTotal number of neighbors 1\n";
        let rows = bgp_summary(raw);
        assert_eq!(rows.len(), 3, "{rows:#?}");
        assert_eq!(rows[0], json!({"vrf": "default", "as": "65020", "uptime": "00:05:27", "address_family": "IPv4 Unicast", "state": "Established", "prefixes_received": "7", "description": "spine01", "local_interface": "swp51"}));
        assert_eq!(rows[1], json!({"vrf": "default", "as": "65021", "uptime": "never", "address_family": "IPv4 Unicast", "state": "Active", "neighbor_ip": "10.0.0.9"}));
        assert_eq!((rows[2]["address_family"].as_str(), rows[2]["prefixes_received"].as_str()), (Some("L2VPN EVPN"), Some("12")));
    }

    #[test]
    fn ospf_neighbours_with_and_without_up_time() {
        let new = ospf_neighbor("Neighbor ID     Pri State           Up Time         Dead Time Address         Interface                        RXmtL RqstL DBsmL\n10.0.0.1          1 Full/DR         1h07m31s          36.123s 10.1.1.0        swp51:10.1.1.1                       0     0     0\n");
        assert_eq!(new, vec![json!({"neighbor_id": "10.0.0.1", "priority": "1", "state": "Full/DR", "neighbor_ip": "10.1.1.0", "local_interface": "swp51", "local_ip": "10.1.1.1", "uptime": "1h07m31s"})]);
        let old = ospf_neighbor("Neighbor ID     Pri State           Dead Time Address         Interface            RXmtL RqstL DBsmL\n10.0.0.2          1 Full/Backup       39.000s 10.1.1.2        Vlan100:10.1.1.1         0     0     0\n");
        assert_eq!(old[0], json!({"neighbor_id": "10.0.0.2", "priority": "1", "state": "Full/Backup", "neighbor_ip": "10.1.1.2", "local_interface": "Vlan100", "local_ip": "10.1.1.1"}));
    }
}
