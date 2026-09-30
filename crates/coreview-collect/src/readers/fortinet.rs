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

/// FortiOS `get system interface` (LT-566): a `== [ name ]` line, then one
/// line of `key: value` fields separated by runs of spaces. 7.6 stops ntc's
/// template at the first of them; without it a FortiGate has no logical
/// interface — no hard-switch, no VLAN, and no address it was reached on.
pub fn system_interface(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let t = line.trim();
        if !t.starts_with("name:") {
            continue;
        }
        let mut m = Map::new();
        for field in t.split("  ").map(str::trim).filter(|f| !f.is_empty()) {
            let Some((k, v)) = field.split_once(':') else { continue };
            let v = v.trim();
            match k.trim() {
                "name" => {
                    m.insert("interface".into(), json!(v));
                }
                "status" if !v.is_empty() => {
                    m.insert("status".into(), json!(v));
                }
                "ip" => {
                    let mut w = v.split_whitespace();
                    if let (Some(a), Some(mask)) = (w.next(), w.next()) {
                        if a != "0.0.0.0" {
                            m.insert("ip_address".into(), json!(a));
                            m.insert("netmask".into(), json!(mask));
                        }
                    }
                }
                _ => {}
            }
        }
        if m.contains_key("interface") {
            out.push(Value::Object(m));
        }
    }
    out
}

/// FortiOS `get system ha status` (LT-567): nothing for a standalone box;
/// for a cluster, one row per member from its `Primary : name, serial, …`
/// lines. 7.6 writes `Group Name:` where earlier releases wrote `Group:`,
/// which ntc's template refuses. The standalone reply is the lab's; the
/// member lines are the forms in ntc's own captured fixtures — with a name
/// (`Primary : fw-a, FG…, HA cluster index = 1`) and, in the second
/// listing some releases print, without (`Primary: FG…, HA operating index`).
pub fn ha_status(raw: &str) -> Vec<Value> {
    let mode = raw.lines().find_map(|l| l.strip_prefix("Mode:")).map(str::trim).unwrap_or("");
    if mode.is_empty() || mode.eq_ignore_ascii_case("standalone") {
        return Vec::new();
    }
    let mut out: Vec<Map<String, Value>> = Vec::new();
    for line in raw.lines() {
        let Some((role, rest)) = line.split_once(':') else { continue };
        let role = role.trim();
        if !matches!(role, "Primary" | "Secondary" | "Master" | "Slave") {
            continue;
        }
        let parts: Vec<&str> = rest.split(',').map(str::trim).collect();
        let (name, serial) = match parts.as_slice() {
            [name, serial, _index] => (Some(*name), *serial),
            [serial, _index] => (None, *serial),
            _ => continue,
        };
        if serial.is_empty() || serial.contains(' ') {
            continue;
        }
        if let Some(m) = out.iter_mut().find(|m| m.get("serial").and_then(Value::as_str) == Some(serial)) {
            if let Some(n) = name {
                m.entry("member").or_insert_with(|| json!(n));
            }
            continue;
        }
        let mut m = Map::new();
        m.insert("mode".into(), json!(mode));
        if let Some(n) = name {
            m.insert("member".into(), json!(n));
        }
        m.insert("role".into(), json!(role.to_ascii_lowercase()));
        m.insert("serial".into(), json!(serial));
        out.push(m);
    }
    out.into_iter().map(Value::Object).collect()
}

/// `get wireless-controller wtp-status` (LT-596): the FortiAPs a FortiGate
/// manages, read by the classic crawler's reader, which met a FortiGate 60F
/// on 7.6.7 managing three — one `ap` row each, with what the AP's own LLDP
/// sees on its wired port.
pub fn wtp_status(raw: &str) -> Vec<Value> {
    coreview_discover::fortios::parse_wtp_status(raw)
        .into_iter()
        .map(|ap| {
            let mut m = Map::new();
            m.insert("ap_name".into(), json!(ap.name));
            if let Some(v) = ap.address {
                m.insert("ap_ip".into(), json!(v));
            }
            if let Some(v) = ap.mac {
                m.insert("ap_mac".into(), json!(v));
            }
            if let Some(v) = ap.serial {
                m.insert("serial".into(), json!(v));
            }
            if let Some(v) = ap.software_version {
                m.insert("version".into(), json!(v));
            }
            m.insert("state".into(), json!(if ap.connected { "connected" } else { "disconnected" }));
            if let Some(up) = ap.uplink {
                m.insert("nbr_switch".into(), json!(up.device_id));
                if let Some(p) = up.remote_interface {
                    m.insert("nbr_port".into(), json!(p));
                }
                if let Some(p) = up.local_interface {
                    m.insert("local_port".into(), json!(p));
                }
                if let Some(p) = up.platform {
                    m.insert("nbr_platform".into(), json!(p));
                }
                if let Some(c) = up.chassis_id {
                    m.insert("nbr_chassis".into(), json!(c));
                }
            }
            Value::Object(m)
        })
        .collect()
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

    #[test]
    fn fortigate_7_6_interfaces_keep_the_logical_ones() {
        // The lab's layout: one line of fields per interface, runs of spaces between.
        let raw = "== [ wan1 ]
name: wan1   mode: dhcp    ip: 0.0.0.0 0.0.0.0   status: down    netbios-forward: disable    type: physical   netflow-sampler: disable    sflow-sampler: disable    src-check: enable    trunk: disable    wccp: disable    drop-fragment: disable    mtu-override: disable
== [ internal1 ]
name: internal1   status: up    type: physical   trunk: disable
== [ internal ]
name: internal   mode: static    ip: 192.0.2.1 255.255.255.0   status: up    netbios-forward: disable    type: hard-switch   netflow-sampler: disable    sflow-sampler: disable    src-check: enable    trunk: disable    wccp: disable    drop-fragment: disable    mtu-override: disable
== [ vlan20 ]
name: vlan20   mode: static    ip: 198.51.100.1 255.255.255.0   status: up    netbios-forward: disable    type: vlan   netflow-sampler: disable    sflow-sampler: disable    src-check: enable    trunk: disable    switch-controller-feature: none    wccp: disable    drop-fragment: disable    mtu-override: disable
== [ a ]
name: a   status:
";
        let rows = crate::readers::read("fortios_interfaces", raw).expect("a reader for FortiOS 7.6 interfaces");
        assert_eq!(rows, vec![
            json!({"interface": "wan1", "status": "down"}),
            json!({"interface": "internal1", "status": "up"}),
            json!({"interface": "internal", "ip_address": "192.0.2.1", "netmask": "255.255.255.0", "status": "up"}),
            json!({"interface": "vlan20", "ip_address": "198.51.100.1", "netmask": "255.255.255.0", "status": "up"}),
            json!({"interface": "a"}),
        ]);
    }

    #[test]
    fn fortigate_7_6_ha_status_standalone_and_clustered() {
        // The lab's standalone reply: `Group Name:` and `Group ID:` are 7.6's.
        let standalone = "HA Health Status: OK
Model: FortiGate-60F
Mode: Standalone
Group Name:
Group ID: 0
Debug: 0
Cluster Uptime: 0 days 0h:0m:0s
Cluster state change time: N/A
ses_pickup: disable
override: disable
System Usage stats:
HBDEV stats:
number of member: 0
number of vcluster: 0
";
        assert_eq!(crate::readers::read("fortios_ha_status", standalone).expect("a reader for FortiOS 7.6 HA status"), Vec::<Value>::new());
        // A cluster in 7.6's shape; the member lines as ntc's fixtures print them.
        let cluster = "HA Health Status: OK
Model: FortiGate-60F
Mode: HA A-P
Group Name: LAB-HA
Group ID: 7
Debug: 0
Cluster Uptime: 3 days 1:31:39
ses_pickup: enable, ses_pickup_delay=disable
override: disable
Primary     : LAB-FW-A       , FGTFAKE0000001, HA cluster index = 1
Secondary   : LAB-FW-B       , FGTFAKE0000002, HA cluster index = 0
number of vcluster: 1
vcluster 1: work 169.254.0.1
Primary: FGTFAKE0000001, HA operating index = 0
Secondary: FGTFAKE0000002, HA operating index = 1
";
        assert_eq!(crate::readers::read("fortios_ha_status", cluster).unwrap(), vec![
            json!({"mode": "HA A-P", "member": "LAB-FW-A", "role": "primary", "serial": "FGTFAKE0000001"}),
            json!({"mode": "HA A-P", "member": "LAB-FW-B", "role": "secondary", "serial": "FGTFAKE0000002"}),
        ]);
    }

    #[test]
    fn a_fortigates_access_points_with_their_uplinks() {
        // The layout of the lab FortiGate 60F's reply (7.6.7, three APs, two
        // with an LLDP block); invented names, documentation addresses.
        let raw = "WTP: LAB-AP-GARAGE  0-192.0.2.22:5246
    vdom             : root
    wtp-id           : FP231FFAKE00001
    name             : LAB-AP-GARAGE
    software-version : FP231F-v7.4.6-build0771
    local-ip-addr   : 192.0.2.22
    board-mac        : 00:00:00:00:02:68
    connection-state : Connected
  LLDP               : enabled (total 1)
    local port       : lan1
    chassis id       : mac 00:00:00:00:c4:a8
    sys name         : LAB-ACC-SW
    sys description  : UBNT-USL8L
    capability       : Bridge 
    port id          : Port
    port description : Port 3
WTP: LAB-AP-OFFICE  0-192.0.2.23:15246
    vdom             : root
    wtp-id           : PU431FFAKE00002
    name             : LAB-AP-OFFICE
    software-version : PU431F-v7.0.6-build0159
    local-ip-addr   : 192.0.2.23
    board-mac        : 00:00:00:00:00:a0
    connection-state : Connected
";
        let rows = crate::readers::read("fortios_wtp_status", raw).expect("a reader for the wireless controller");
        assert_eq!(rows.len(), 2, "{rows:#?}");
        assert_eq!((rows[0]["ap_name"].as_str(), rows[0]["ap_ip"].as_str(), rows[0]["nbr_switch"].as_str(), rows[0]["nbr_port"].as_str()), (Some("LAB-AP-GARAGE"), Some("192.0.2.22"), Some("LAB-ACC-SW"), Some("Port 3")));
        assert_eq!(rows[1]["state"], "connected");
        assert!(rows[1].get("nbr_switch").is_none(), "no LLDP block, no uplink");
    }
}
