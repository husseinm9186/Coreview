//! FortiOS and FortiSwitchOS replies no template reads (LT-563–LT-565).
//!
//! **Written against the operator's lab** — a FortiGate 60F on FortiOS
//! 7.6.7 and a FortiSwitch 224E on FortiSwitchOS 7.6.1 (LT-558). The test
//! fixtures below keep each reply's layout exactly, spacing and tabs
//! included, with every hostname, serial, MAC and address replaced by an
//! invented one (D-027).

use serde_json::{json, Map, Value};

pub fn verified_against_hardware() -> bool {
    true
}

/// `get system status`: `Key: value` lines. FortiOS 7.6 added lines ntc's
/// template does not know, and its catch-all refused the whole reply.
pub fn system_status(raw: &str) -> Vec<Value> {
    let mut kv: Map<String, Value> = Map::new();
    for line in raw.lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        let (k, v) = (k.trim(), v.trim());
        if k.is_empty() || v.is_empty() {
            continue;
        }
        match k {
            "Hostname" => {
                kv.insert("hostname".into(), json!(v));
            }
            "Serial-Number" => {
                kv.insert("serial".into(), json!(v));
            }
            "Burn in MAC" => {
                kv.insert("base_mac".into(), json!(v));
            }
            "Current HA mode" => {
                kv.insert("ha_mode".into(), json!(v));
            }
            "Virtual domain configuration" => {
                kv.insert("vdom_mode".into(), json!(v));
            }
            "Version" => {
                // `FortiGate-60F v7.6.7,build3704,260601 (GA.M)`
                let mut parts = v.splitn(2, ' ');
                if let Some(model) = parts.next() {
                    kv.insert("model".into(), json!(model));
                }
                if let Some(rest) = parts.next() {
                    let ver = rest.trim_start_matches('v').split(',').next().unwrap_or("").to_string();
                    kv.insert("version".into(), json!(ver));
                }
            }
            _ => {}
        }
    }
    if kv.is_empty() {
        Vec::new()
    } else {
        vec![Value::Object(kv)]
    }
}

/// `get router info routing-table all`, FortiOS's layout
/// (`S*      0.0.0.0/0 [1/0] via 192.0.2.1, wan2, [1/0]`, a continuation line
/// for each further equal-cost next hop) and FortiSwitchOS's zebra layout
/// (`C>*  192.0.2.0/24 is directly connected, internal, 02:53:12`).
pub fn routing_table(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut vrf: Option<String> = None;
    let mut last: Option<(String, String)> = None; // (code, prefix) for continuation lines
    for line in raw.lines() {
        let t = line.trim_end();
        if let Some(v) = t.strip_prefix("Routing table for VRF=") {
            vrf = Some(v.trim().to_string()).filter(|v| v != "0");
            continue;
        }
        if let Some(v) = t.strip_prefix("VRF ").and_then(|x| x.strip_suffix(':')) {
            vrf = Some(v.trim().to_string()).filter(|v| v != "default");
            continue;
        }
        let words: Vec<&str> = t.split_whitespace().collect();
        if words.is_empty() {
            continue;
        }
        // A route line starts with a code and a prefix; a continuation with `[` or `via`.
        let (code, prefix, rest): (String, String, Vec<&str>) = if words.len() >= 2 && words[1].contains('/') && words[1].chars().next().map(|c| c.is_ascii_hexdigit() || c == ':').unwrap_or(false) {
            let code = words[0].trim_end_matches(['*', '>', 'b', 'r', 'q', 't', 'o', '^']).to_string();
            (code, words[1].to_string(), words[2..].to_vec())
        } else if (words[0].starts_with('[') || words[0] == "via") && t.starts_with(char::is_whitespace) {
            match &last {
                Some((c, p)) => (c.clone(), p.clone(), words.clone()),
                None => continue,
            }
        } else {
            continue;
        };
        if code.is_empty() || !code.chars().all(|c| c.is_ascii_alphabetic()) {
            continue;
        }
        let rest = rest.join(" ");
        let mut row = Map::new();
        row.insert("protocol".into(), json!(code));
        row.insert("network".into(), json!(prefix));
        if let Some(v) = &vrf {
            row.insert("vrf".into(), json!(v));
        }
        if let Some(ad) = rest.strip_prefix('[').and_then(|x| x.split(']').next()) {
            if let Some((d, m)) = ad.split_once('/') {
                row.insert("distance".into(), json!(d));
                row.insert("metric".into(), json!(m));
            }
        }
        if let Some(i) = rest.find("directly connected, ") {
            let iface = rest[i + "directly connected, ".len()..].split(',').next().unwrap_or("").trim();
            row.insert("interface".into(), json!(iface));
        } else if let Some(i) = rest.find("via ") {
            let mut parts = rest[i + 4..].split(',').map(str::trim);
            if let Some(nh) = parts.next() {
                row.insert("nexthop_ip".into(), json!(nh));
            }
            if let Some(iface) = parts.next().filter(|x| !x.starts_with('[') && !x.is_empty()) {
                row.insert("interface".into(), json!(iface));
            }
        } else {
            continue;
        }
        last = Some((code, prefix));
        out.push(Value::Object(row));
    }
    out
}

/// FortiSwitchOS `get switch lldp neighbors-summary`: one row per port with
/// a neighbour (`-` in Device-name is none).
pub fn lldp_neighbors_summary(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut in_table = false;
    for line in raw.lines() {
        let t = line.trim();
        if t.starts_with("____") {
            in_table = true;
            continue;
        }
        if !in_table {
            continue;
        }
        let w: Vec<&str> = t.split_whitespace().collect();
        if w.len() < 7 || w[2] == "-" {
            continue;
        }
        out.push(json!({"local_interface": w[0], "neighbor_name": w[2], "capabilities": w[4], "neighbor_interface": w[6], "proto": "lldp"}));
    }
    out
}

/// FortiSwitchOS `diagnose switch mac-address list`: the MACs the switch
/// learned. Its own static entries (thousands, one per VLAN on `internal`)
/// are left out.
pub fn mac_address_list(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let lines: Vec<&str> = raw.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        let Some(rest) = line.trim().strip_prefix("MAC:") else { continue };
        let flags = lines.get(i + 1).map(|l| l.trim()).unwrap_or("");
        if !flags.contains("dynamic") {
            continue;
        }
        let mac = rest.split_whitespace().next().unwrap_or("");
        let vlan = rest.split("VLAN:").nth(1).and_then(|v| v.split_whitespace().next()).unwrap_or("");
        let port = rest.split("Port:").nth(1).map(|p| p.trim().split('(').next().unwrap_or("").trim()).unwrap_or("");
        if mac.is_empty() || port.is_empty() {
            continue;
        }
        out.push(json!({"mac_address": mac, "vlan": vlan, "interface": port, "type": "dynamic"}));
    }
    out
}

/// FortiSwitchOS `get system interface physical`: `==[name]` blocks with
/// `ip: address mask` and `status:`.
pub fn interface_physical(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut cur: Option<Map<String, Value>> = None;
    let flush = |cur: &mut Option<Map<String, Value>>, out: &mut Vec<Value>| {
        if let Some(m) = cur.take() {
            out.push(Value::Object(m));
        }
    };
    for line in raw.lines() {
        let t = line.trim();
        if let Some(name) = t.strip_prefix("==[").and_then(|x| x.strip_suffix(']')) {
            flush(&mut cur, &mut out);
            let mut m = Map::new();
            m.insert("interface".into(), json!(name));
            cur = Some(m);
            continue;
        }
        let Some(m) = cur.as_mut() else { continue };
        if let Some(ip) = t.strip_prefix("ip:") {
            let mut w = ip.split_whitespace();
            if let (Some(a), Some(mask)) = (w.next(), w.next()) {
                if a != "0.0.0.0" {
                    m.insert("ip_address".into(), json!(a));
                    m.insert("netmask".into(), json!(mask));
                }
            }
        } else if let Some(s) = t.strip_prefix("status:") {
            m.insert("oper_status".into(), json!(s.trim()));
        }
    }
    flush(&mut cur, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // The lab's replies, layout kept, every value invented (D-027).
    const FGT_STATUS: &str = "Version: FortiGate-60F v7.6.7,build3704,260601 (GA.M)
First GA patch build date: 240724
Current Security Level: High
Firmware Signature: certified
AV AI/ML Model: 4.05057(2026-09-29 10:20)
IPS-MLDB: 2609.00200(2026-09-16 00:55)
OT-Patch-DB: 37.00301(2026-09-28 15:00)
Serial-Number: FGTFAKE0000001
BIOS version: 05000100
Hostname: LAB-FGT
Operation Mode: NAT
Current virtual domain: root
Virtual domain configuration: disable
Current HA mode: standalone
System time: Tue Sep 29 18:51:44 2026
";
    const FSW_STATUS: &str = "Version: FortiSwitch-224E v7.6.1,build1047,241217 (GA)
Serial-Number: FSWFAKE0000001
Firmware Signature: valid
Burn in MAC: 00:00:00:00:0f:01
Hostname: FSWFAKE0000001
Security mode: none
";

    #[test]
    fn system_status_on_7_6_reads_identity() {
        assert_eq!(system_status(FGT_STATUS), vec![json!({"version": "7.6.7", "model": "FortiGate-60F", "serial": "FGTFAKE0000001", "hostname": "LAB-FGT", "vdom_mode": "disable", "ha_mode": "standalone"})]);
        let s = &system_status(FSW_STATUS)[0];
        assert_eq!((s["model"].as_str(), s["base_mac"].as_str(), s["serial"].as_str()), (Some("FortiSwitch-224E"), Some("00:00:00:00:0f:01"), Some("FSWFAKE0000001")));
    }

    #[test]
    fn fortigate_routing_table_with_its_7_6_layout() {
        let raw = "Codes: K - kernel, C - connected, S - static, R - RIP, B - BGP
       O - OSPF, IA - OSPF inter area
       * - candidate default

Routing table for VRF=0
S*      0.0.0.0/0 [1/0] via 203.0.113.1, wan2, [1/0]
                  [1/0] via 198.51.100.1, wan1, [1/0]
C       198.51.100.0/24 is directly connected, vlan20
S       172.16.1.0/24 [10/0] via 192.0.2.22, internal, [1/0]
C       192.0.2.0/24 is directly connected, internal
";
        let rows = routing_table(raw);
        assert_eq!(rows.len(), 5, "{rows:#?}");
        assert_eq!(rows[0], json!({"protocol": "S", "network": "0.0.0.0/0", "distance": "1", "metric": "0", "nexthop_ip": "203.0.113.1", "interface": "wan2"}));
        assert_eq!((rows[1]["network"].as_str(), rows[1]["nexthop_ip"].as_str(), rows[1]["interface"].as_str()), (Some("0.0.0.0/0"), Some("198.51.100.1"), Some("wan1")), "the equal-cost continuation");
        assert_eq!(rows[2], json!({"protocol": "C", "network": "198.51.100.0/24", "interface": "vlan20"}));
        assert_eq!(rows[3]["distance"], "10");
    }

    #[test]
    fn fortiswitch_routing_table_in_zebra_layout() {
        let raw = "Codes: K - kernel route, C - connected, L - local, S - static,
       > - selected route, * - FIB route, q - queued, r - rejected, b - backup, ^ - HW install failed

VRF default:
C>*  192.0.2.0/24 is directly connected, internal, 02:53:12
L>*  192.0.2.203/32 is directly connected, internal, 02:53:12
S>*  0.0.0.0/0 [10/0] via 192.0.2.1, internal, 02:53:12
";
        let rows = routing_table(raw);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], json!({"protocol": "C", "network": "192.0.2.0/24", "interface": "internal"}));
        assert_eq!(rows[1]["protocol"], "L");
        assert_eq!((rows[2]["nexthop_ip"].as_str(), rows[2]["interface"].as_str()), (Some("192.0.2.1"), Some("internal")));
    }

    #[test]
    fn fortiswitch_lldp_mac_and_interfaces() {
        let lldp = "Capability codes:
\tR:Router, B:Bridge, T:Telephone, C:DOCSIS Cable Device
MED type codes:
\tGeneric:Generic Endpoint (Class 1), Media:Media Endpoint (Class 2)

  Portname    Status   Device-name                 TTL   Capability  MED-type  Port-ID
  __________  _______  __________________________  ____  __________  ________  _______
  port1       Down     -                           -     -           -         -
  port13      Up       -                           -     -           -         -
  port24      Up       LAB-SW1.lab.example.net     120   BR          -         Gi0/9
";
        assert_eq!(lldp_neighbors_summary(lldp), vec![json!({"local_interface": "port24", "neighbor_name": "LAB-SW1.lab.example.net", "capabilities": "BR", "neighbor_interface": "Gi0/9", "proto": "lldp"})]);
        let macs = "flag bit pattern: 0x00000000
vlan map: 0-4094

MAC: 00:00:00:00:0f:02\tVLAN: 2178 Port: internal(port-id 29)
  Flags: 0x00000020 [ static ]

MAC: 00:00:00:00:0a:01\tVLAN: 10 Port: port24(port-id 24)
  Flags: 0x00010441 [ hit dynamic src-hit native ]

MAC: 00:00:00:00:0a:02\tVLAN: 1 Port: port13(port-id 13)
  Flags: 0x00000001 [ dynamic ]
";
        assert_eq!(mac_address_list(macs), vec![
            json!({"mac_address": "00:00:00:00:0a:01", "vlan": "10", "interface": "port24", "type": "dynamic"}),
            json!({"mac_address": "00:00:00:00:0a:02", "vlan": "1", "interface": "port13", "type": "dynamic"}),
        ]);
        let ifs = "== [onboard]
\t==[internal]
\t\tmode: static
\t\tip: 192.0.2.203 255.255.255.0
\t\tipv6: ::/0
\t\tstatus: up
\t\tspeed: n/a (Duplex: n/a)
\t==[mgmt]
\t\tmode: dhcp
\t\tip: 0.0.0.0 0.0.0.0
\t\tstatus: down
";
        assert_eq!(interface_physical(ifs), vec![
            json!({"interface": "internal", "ip_address": "192.0.2.203", "netmask": "255.255.255.0", "oper_status": "up"}),
            json!({"interface": "mgmt", "oper_status": "down"}),
        ]);
    }
}
