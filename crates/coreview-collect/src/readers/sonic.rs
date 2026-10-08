//! SONiC — community SONiC and Enterprise SONiC by Broadcom.
//!
//! **Built from the SONiC command reference,** as the classic
//! crawler's dialect was; the layouts are the documentation's and
//! `verified: docs` until a capture. SONiC's `show` commands answer from
//! bash on both editions; their tables are tabulate's, right-aligned under
//! a rule line, so each is sliced by the rule's dash runs. Routing is FRR,
//! read by [`super::frr`].

use serde_json::{json, Value};

use super::text::{cells_by_spans, is_rule, rule_spans};

fn labelled<'a>(out: &'a str, label: &str) -> Option<&'a str> {
    out.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k.trim().eq_ignore_ascii_case(label) && !v.trim().is_empty()).then(|| v.trim())
    })
}

/// `show version`: `SONiC Software Version:`, `HwSKU:` (the model —
/// `Mellanox-SN2010`, `DellEMC-S5248f-P-25G-DPB`), `Platform:`, `Serial
/// Number:`.
pub fn version(raw: &str) -> Vec<Value> {
    let mut m = serde_json::Map::new();
    if let Some(v) = labelled(raw, "SONiC Software Version") {
        m.insert("os_version".into(), json!(v.trim_start_matches("SONiC.").trim_start_matches("SONiC-")));
    }
    if let Some(v) = labelled(raw, "HwSKU").or_else(|| labelled(raw, "Platform")) {
        m.insert("model".into(), json!(v));
    }
    if let Some(v) = labelled(raw, "Platform") {
        m.insert("platform_string".into(), json!(v));
    }
    if let Some(v) = labelled(raw, "Serial Number") {
        m.insert("serial".into(), json!(v));
    }
    if let Some(v) = labelled(raw, "Product") {
        m.insert("os_name".into(), json!(v));
    }
    if let Some(v) = labelled(raw, "Uptime") {
        m.insert("uptime".into(), json!(v));
    }
    if m.is_empty() {
        return Vec::new();
    }
    vec![Value::Object(m)]
}

/// The rows of a tabulate table: everything under its rule line, sliced
/// by the rule, until a blank or a `Total` line.
fn table(raw: &str, must: &[&str]) -> Vec<Vec<String>> {
    let lines: Vec<&str> = raw.lines().collect();
    let Some(h) = lines.iter().position(|l| must.iter().all(|m| l.contains(m))) else { return Vec::new() };
    let Some(r) = lines[h + 1..].iter().position(|l| is_rule(l)) else { return Vec::new() };
    let spans = rule_spans(lines[h + 1 + r]);
    let mut out = Vec::new();
    for line in &lines[h + 2 + r..] {
        let t = line.trim();
        if t.is_empty() || t.starts_with("Total") || is_rule(line) {
            break;
        }
        out.push(cells_by_spans(line, &spans));
    }
    out
}

/// `show ip interfaces`: `Interface  Master  IPv4 address/mask  Admin/Oper
/// BGP Neighbor  Neighbor IP` — the Master column is the VRF.
pub fn ip_interfaces(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for c in table(raw, &["Interface", "IPv4 address/mask", "Admin/Oper"]) {
        if c.len() < 4 || c[2].is_empty() || !c[2].contains('/') {
            continue;
        }
        let name = if c[0].is_empty() { out.last().and_then(|r: &Value| r["interface"].as_str()).unwrap_or("").to_string() } else { c[0].clone() };
        let (admin, oper) = c[3].split_once('/').unwrap_or((c[3].as_str(), ""));
        let mut row = json!({"interface": name, "ip": c[2], "admin": admin, "oper": oper, "vrf": if c[1].is_empty() { "default".to_string() } else { c[1].clone() }});
        if c.len() >= 6 && !c[4].is_empty() && c[4] != "N/A" {
            row["bgp_neighbor"] = json!(c[4]);
            row["bgp_neighbor_ip"] = json!(c[5]);
        }
        out.push(row);
    }
    out
}

/// `show arp`: `Address  MacAddress  Iface  Vlan`.
pub fn arp(raw: &str) -> Vec<Value> {
    table(raw, &["Address", "MacAddress", "Iface"])
        .into_iter()
        .filter(|c| c.len() >= 3 && c[0].parse::<std::net::IpAddr>().is_ok())
        .map(|c| {
            let mut row = json!({"ip": c[0], "mac": c[1].to_ascii_lowercase(), "interface": c[2]});
            if let Some(v) = c.get(3).filter(|v| !v.is_empty() && *v != "-") {
                row["vlan"] = json!(v);
            }
            row
        })
        .collect()
}

/// `show mac`: `No.  Vlan  MacAddress  Port  Type`.
pub fn mac(raw: &str) -> Vec<Value> {
    table(raw, &["Vlan", "MacAddress", "Port"])
        .into_iter()
        .filter(|c| c.len() >= 5 && c[2].contains(':'))
        .map(|c| json!({"vlan": c[1], "mac": c[2].to_ascii_lowercase(), "interface": c[3], "type": c[4]}))
        .collect()
}

/// `show interfaces portchannel`: `No.  Team Dev  Protocol  Ports` —
/// `PortChannel0001  LACP(A)(Up)  Ethernet112(S) Ethernet108(D)`.
pub fn portchannel(raw: &str) -> Vec<Value> {
    table(raw, &["Team Dev", "Protocol", "Ports"])
        .into_iter()
        .filter(|c| c.len() >= 4 && c[1].starts_with("PortChannel"))
        .map(|c| {
            let members: Vec<String> = c[3].split_whitespace().map(|m| m.split('(').next().unwrap_or("").to_string()).filter(|m| !m.is_empty()).collect();
            let proto = c[2].split('(').next().unwrap_or("");
            let state = if c[2].contains("(Up)") { "up" } else if c[2].contains("(Dw)") { "down" } else { "" };
            json!({"name": c[1], "protocol": proto, "members": members.join(", "), "state": state})
        })
        .collect()
}

/// `show lldp table`: `LocalPort  RemoteDevice  RemotePortID  Capability
/// RemotePortDescr`.
pub fn lldp_table(raw: &str) -> Vec<Value> {
    table(raw, &["LocalPort", "RemoteDevice", "RemotePortID"])
        .into_iter()
        .filter(|c| c.len() >= 3 && !c[0].is_empty() && !c[1].is_empty())
        .map(|c| {
            let mut row = json!({"local_interface": c[0], "neighbor_name": c[1], "neighbor_interface": c[2]});
            if let Some(caps) = c.get(3).filter(|v| !v.is_empty()) {
                row["capabilities"] = json!(caps);
            }
            if let Some(d) = c.get(4).filter(|v| !v.is_empty()) {
                row["neighbor_port_description"] = json!(d);
            }
            row
        })
        .collect()
}

/// `show interfaces status`: `Interface  Lanes  Speed  MTU  FEC  Alias
/// Vlan  Oper  Admin  Type  Asym PFC`.
pub fn interfaces_status(raw: &str) -> Vec<Value> {
    let lines: Vec<&str> = raw.lines().collect();
    let Some(h) = lines.iter().position(|l| l.contains("Interface") && l.contains("Oper") && l.contains("Admin")) else { return Vec::new() };
    let header: Vec<&str> = lines[h].split_whitespace().collect();
    let idx = |name: &str| header.iter().position(|w| *w == name);
    let (Some(ii), Some(oi), Some(ai)) = (idx("Interface"), idx("Oper"), idx("Admin")) else { return Vec::new() };
    let mut out = Vec::new();
    for c in table(raw, &["Interface", "Oper", "Admin"]) {
        if c.len() <= ai || c[ii].is_empty() {
            continue;
        }
        let mut row = json!({"name": c[ii], "oper": c[oi], "admin": c[ai]});
        for (col, key) in [("Speed", "speed"), ("MTU", "mtu"), ("Alias", "alias"), ("Vlan", "mode"), ("Type", "transceiver")] {
            if let Some(i) = idx(col) {
                if let Some(v) = c.get(i).filter(|v| !v.is_empty() && *v != "N/A") {
                    row[key] = json!(v);
                }
            }
        }
        out.push(row);
    }
    out
}

/// `show vrf`: `VRF  Interfaces`, a VRF's further interfaces on their own
/// lines under it.
pub fn vrf(raw: &str) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for c in table(raw, &["VRF", "Interfaces"]) {
        if c.len() < 2 {
            continue;
        }
        if c[0].is_empty() {
            if let Some(last) = out.last_mut() {
                let cur = last["interfaces"].as_str().unwrap_or("").to_string();
                last["interfaces"] = json!(if cur.is_empty() { c[1].clone() } else { format!("{cur}, {}", c[1]) });
            }
            continue;
        }
        out.push(json!({"name": c[0], "interfaces": c[1]}));
    }
    out
}

#[cfg(test)]
mod tests {
    //! Reconstructed from the SONiC command reference, invented values.
    use super::*;

    #[test]
    fn version_names_the_sku_as_the_model() {
        let raw = "\nSONiC Software Version: SONiC.4.1.0-Enterprise_Base\nProduct: Enterprise SONiC Distribution by Broadcom\nDistribution: Debian 10.13\nKernel: 4.19.0-12-2-amd64\nBuild commit: 0a1b2c3d\nBuild date: Mon Jan  1 00:00:00 UTC 2024\nBuilt by: builder@example\n\nPlatform: x86_64-mlnx_msn2010-r0\nHwSKU: Mellanox-SN2010\nASIC: mellanox\nASIC Count: 1\nSerial Number: MT0000EXAMPLE\nUptime: 12:00:00 up 5 days,  3:44,  1 user,  load average: 0.50, 0.40, 0.30\n";
        let v = &version(raw)[0];
        assert_eq!((v["os_version"].as_str(), v["model"].as_str(), v["serial"].as_str(), v["platform_string"].as_str()), (Some("4.1.0-Enterprise_Base"), Some("Mellanox-SN2010"), Some("MT0000EXAMPLE"), Some("x86_64-mlnx_msn2010-r0")));
    }

    #[test]
    fn the_tables_are_read_by_their_rules() {
        let i = ip_interfaces("Interface        Master    IPv4 address/mask    Admin/Oper    BGP Neighbor    Neighbor IP\n---------------  --------  -------------------  ------------  --------------  -------------\nEthernet0                  10.0.0.0/31          up/up         SPINE01         10.0.0.1\nLoopback0                  10.1.0.1/32          up/up         N/A             N/A\nVlan100          Vrf-red   10.100.0.1/24        up/down       N/A             N/A\neth0                       192.0.2.21/24        up/up         N/A             N/A\n");
        assert_eq!(i.len(), 4, "{i:#?}");
        assert_eq!(i[0], json!({"interface": "Ethernet0", "ip": "10.0.0.0/31", "admin": "up", "oper": "up", "vrf": "default", "bgp_neighbor": "SPINE01", "bgp_neighbor_ip": "10.0.0.1"}));
        assert_eq!(i[2], json!({"interface": "Vlan100", "ip": "10.100.0.1/24", "admin": "up", "oper": "down", "vrf": "Vrf-red"}));
        let a = arp("Address        MacAddress         Iface        Vlan\n-------------  -----------------  -----------  ------\n10.0.0.1       52:54:00:12:34:56  Ethernet0    -\n10.100.0.9     52:54:00:12:34:99  Vlan100      100\nTotal number of entries 2\n");
        assert_eq!(a, vec![json!({"ip": "10.0.0.1", "mac": "52:54:00:12:34:56", "interface": "Ethernet0"}), json!({"ip": "10.100.0.9", "mac": "52:54:00:12:34:99", "interface": "Vlan100", "vlan": "100"})]);
        let m = mac("  No.    Vlan  MacAddress         Port        Type\n-----  ------  -----------------  ----------  -------\n    1    1000  52:54:00:12:34:56  Ethernet0   Dynamic\n    2    1000  52:54:00:12:34:57  Ethernet4   Static\nTotal number of entries 2\n");
        assert_eq!(m, vec![json!({"vlan": "1000", "mac": "52:54:00:12:34:56", "interface": "Ethernet0", "type": "Dynamic"}), json!({"vlan": "1000", "mac": "52:54:00:12:34:57", "interface": "Ethernet4", "type": "Static"})]);
        let p = portchannel("Flags: A - active, I - inactive, Up - up, Dw - Down, N/A - not available,\n       S - selected, D - deselected, * - not synced\n  No.  Team Dev         Protocol     Ports\n-----  ---------------  -----------  ---------------------------\n 0001  PortChannel0001  LACP(A)(Up)  Ethernet112(S) Ethernet108(D)\n");
        assert_eq!(p, vec![json!({"name": "PortChannel0001", "protocol": "LACP", "members": "Ethernet112, Ethernet108", "state": "up"})]);
        let t = lldp_table("Capability codes: (R) Router, (B) Bridge, (O) Other\nLocalPort    RemoteDevice    RemotePortID    Capability    RemotePortDescr\n-----------  --------------  --------------  ------------  -----------------\nEthernet0    spine01         Ethernet0       BR            Ethernet0\n--------------------------------------------------\nTotal entries displayed:  1\n");
        assert_eq!(t, vec![json!({"local_interface": "Ethernet0", "neighbor_name": "spine01", "neighbor_interface": "Ethernet0", "capabilities": "BR", "neighbor_port_description": "Ethernet0"})]);
        let s = interfaces_status("  Interface            Lanes    Speed    MTU    FEC    Alias    Vlan    Oper    Admin    Type    Asym PFC\n-----------  ---------------  -------  -----  -----  -------  ------  ------  -------  ------  ----------\n  Ethernet0      25,26,27,28     100G   9100     rs   etp1    routed      up       up    QSFP28         off\n  Ethernet4      29,30,31,32     100G   9100     rs   etp2    trunk     down       up    QSFP28         off\n");
        assert_eq!(s.len(), 2, "{s:#?}");
        assert_eq!(s[0], json!({"name": "Ethernet0", "oper": "up", "admin": "up", "speed": "100G", "mtu": "9100", "alias": "etp1", "mode": "routed", "transceiver": "QSFP28"}));
        assert_eq!((s[1]["oper"].as_str(), s[1]["mode"].as_str()), (Some("down"), Some("trunk")));
        let v = vrf("VRF        Interfaces\n---------  ------------\nVrf-red    Vlan100\n           Ethernet8\nVrf-blue   Vlan200\n");
        assert_eq!(v, vec![json!({"name": "Vrf-red", "interfaces": "Vlan100, Ethernet8"}), json!({"name": "Vrf-blue", "interfaces": "Vlan200"})]);
    }
}
