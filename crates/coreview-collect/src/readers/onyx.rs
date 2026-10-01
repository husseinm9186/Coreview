//! NVIDIA Onyx (MLNX-OS Ethernet) — the SN2010/SN2100/SN2700 Spectrum
//! switches when they run NVIDIA's own CLI rather than Cumulus or SONiC
//! (LT-651).
//!
//! **Built from NVIDIA's Onyx User Manual at the operator's instruction
//! (D-058):** the Rev 5.7 manual's 3.6.8 examples, the 3.8.2 manual, and
//! the 3.10 pages, whose examples NVIDIA has largely emptied. ntc-templates
//! has nothing for Onyx, so every reader here is Coreview's own. Each
//! layout a reader accepts is the manual's; where the manual says a layout
//! changed after 3.9 and the new example is gone, the reader takes the
//! last layout it shows and says so. None has met a device: every catalog
//! entry is `verified: docs` until the operator's support capture replaces
//! these fixtures.
//!
//! The tables are read by their header line: each column's start is where
//! its name begins in the header, and a row is sliced at those starts. The
//! manual's tables are fixed-width, and this survives a wider column on a
//! real box, which a split on whitespace would not where a cell has a
//! space (`Dynamic ETH`, `100 Gbps`, `vlan 6`).

use serde_json::{json, Map, Value};

use super::text::{cells, is_rule, starts};

/// The manual's spellings of one port, as the catalog's other rows will
/// name it: `ethernet 1/2`, `eth 1/10`, `Eth1/10` → `Eth1/10`; `vlan 6`,
/// `Vlan 100` → `Vlan100`; `Loopback 1` → `Loopback1`; `port-channel 1` →
/// `Po1`; `mlag-port-channel 1` → `Mpo1`; `mgmt0` and `nve1` stay.
pub fn ifname(raw: &str) -> String {
    let t = raw.trim();
    let lower = t.to_ascii_lowercase();
    let rest = |prefix: &str| lower[prefix.len()..].trim().to_string();
    if lower.starts_with("ethernet") {
        return format!("Eth{}", rest("ethernet"));
    }
    if lower.starts_with("eth") {
        return format!("Eth{}", rest("eth"));
    }
    if lower.starts_with("mlag-port-channel") {
        return format!("Mpo{}", rest("mlag-port-channel"));
    }
    if lower.starts_with("port-channel") {
        return format!("Po{}", rest("port-channel"));
    }
    if lower.starts_with("mpo") {
        return format!("Mpo{}", rest("mpo"));
    }
    if lower.starts_with("po") && lower[2..].trim().chars().all(|c| c.is_ascii_digit()) && lower.len() > 2 {
        return format!("Po{}", rest("po"));
    }
    if lower.starts_with("vlan") {
        return format!("Vlan{}", rest("vlan"));
    }
    if lower.starts_with("loopback") {
        return format!("Loopback{}", rest("loopback"));
    }
    t.to_string()
}

/// `7CFE9058E01E` (the Host ID) as `7c:fe:90:58:e0:1e`.
fn mac_of_host_id(id: &str) -> Option<String> {
    let hex: String = id.trim().chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 12 {
        return None;
    }
    let lower = hex.to_ascii_lowercase();
    Some((0..6).map(|i| &lower[i * 2..i * 2 + 2]).collect::<Vec<_>>().join(":"))
}

/// `show version`: release, uptime, the base MAC from the Host ID, and
/// whether the box still calls itself MLNX-OS (≤ 3.6.4).
pub fn version(raw: &str) -> Vec<Value> {
    let mut kv: Map<String, Value> = Map::new();
    kv.insert("vendor".into(), json!("NVIDIA"));
    for line in raw.lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        let (k, v) = (k.trim(), v.trim());
        match k {
            // Not `product`/`platform`: the device table reads those as the model.
            "Product name" => {
                kv.insert("os_name".into(), json!(v));
            }
            "Product release" => {
                kv.insert("os_version".into(), json!(v));
            }
            "Host ID" => {
                if let Some(m) = mac_of_host_id(v) {
                    kv.insert("base_mac".into(), json!(m));
                }
            }
            "Uptime" => {
                kv.insert("uptime".into(), json!(v));
            }
            _ => {}
        }
    }
    if kv.len() <= 1 {
        return Vec::new();
    }
    vec![Value::Object(kv)]
}

/// `show inventory`: the CHASSIS row's part number is the model and its
/// serial the box's.
pub fn inventory(raw: &str) -> Vec<Value> {
    for line in raw.lines() {
        let w: Vec<&str> = line.split_whitespace().collect();
        if w.len() >= 3 && w[0].eq_ignore_ascii_case("CHASSIS") {
            return vec![json!({"model": w[1], "serial": w[2]})];
        }
    }
    Vec::new()
}

/// `show system type`: one word, `SN2100`.
pub fn system_type(raw: &str) -> Vec<Value> {
    raw.lines().map(str::trim).find(|l| !l.is_empty() && !l.contains(' ') && !l.contains('#') && !l.contains('>')).map(|l| vec![json!({"model": l})]).unwrap_or_default()
}

/// `show hosts`, either layout: the `Hostname:` line.
pub fn hosts(raw: &str) -> Vec<Value> {
    for line in raw.lines() {
        if let Some(v) = line.trim().strip_prefix("Hostname:") {
            let v = v.trim();
            if !v.is_empty() {
                return vec![json!({"hostname": v})];
            }
        }
    }
    Vec::new()
}

/// `show interfaces status` (3.6.4006+): every port with its state, admin,
/// speed, MTU (3.9.0300+) and description. The 3.6 header says `Oper
/// State`, the 3.9 one `Operational state`; both are read.
pub fn interfaces_status(raw: &str) -> Vec<Value> {
    let lines: Vec<&str> = raw.lines().collect();
    let Some(h) = lines.iter().position(|l| l.contains("Port") && l.contains("Admin") && l.contains("Speed")) else { return Vec::new() };
    let header = lines[h];
    let with_mtu = header.contains("MTU");
    let oper = if header.contains("Operational state") { "Operational state" } else { "Oper State" };
    let names: Vec<&str> = if with_mtu { vec!["Port", oper, "Admin", "Speed", "MTU", "Description"] } else { vec!["Port", oper, "Admin", "Speed", "Description"] };
    let Some(st) = starts(header, &names) else { return Vec::new() };
    let mut out = Vec::new();
    for line in &lines[h + 1..] {
        if is_rule(line) || line.trim().is_empty() {
            continue;
        }
        let c = cells(line, &st);
        if c[0].is_empty() || c[0].contains('#') || c[0].contains('>') {
            continue;
        }
        let mut row = json!({"name": ifname(&c[0]), "oper": c[1], "admin": c[2], "speed": c[3]});
        let descr = c.last().cloned().unwrap_or_default();
        if !descr.is_empty() && descr != "-" {
            row["descr"] = json!(descr);
        }
        if with_mtu && !c[4].is_empty() {
            row["mtu"] = json!(c[4]);
        }
        out.push(row);
    }
    out
}

/// `show interfaces ethernet` / `port-channel` / `vlan` / `loopback`, the
/// long form: one block per interface (`Eth1/10:` at the margin, then
/// `  Key : value` lines, an `IPv4 address:` list with `[primary]`, a
/// `VRF` line). An interface row per block, and an address row per
/// address with the interface and VRF on it.
pub fn interface_blocks(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut cur: Option<Map<String, Value>> = None;
    let mut addrs: Vec<(String, bool)> = Vec::new();
    let mut in_v4 = false;
    let flush = |cur: &mut Option<Map<String, Value>>, addrs: &mut Vec<(String, bool)>, out: &mut Vec<Value>| {
        if let Some(m) = cur.take() {
            let name = m.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            let vrf = m.get("vrf").and_then(Value::as_str).unwrap_or("default").to_string();
            out.push(Value::Object(m));
            for (a, primary) in addrs.drain(..) {
                out.push(json!({"interface": name, "ip": a, "vrf": vrf, "kind": if primary { "primary" } else { "secondary" }}));
            }
        }
    };
    for line in raw.lines() {
        let t = line.trim_end();
        if t.is_empty() {
            continue;
        }
        let indented = t.starts_with(' ');
        if !indented && t.ends_with(':') && !t.contains("Rx") && !t.contains("Tx") {
            flush(&mut cur, &mut addrs, &mut out);
            let mut m = Map::new();
            m.insert("name".into(), json!(ifname(t.trim_end_matches(':'))));
            cur = Some(m);
            in_v4 = false;
            continue;
        }
        let Some(m) = cur.as_mut() else { continue };
        let tt = t.trim();
        if tt == "IPv4 address:" {
            in_v4 = true;
            continue;
        }
        if tt.ends_with(':') && !tt.contains(' ') || tt.starts_with("Broadcast address") || tt.starts_with("IPv6 address") {
            in_v4 = false;
        }
        if in_v4 && tt.contains('/') && !tt.contains(':') {
            let primary = tt.contains("[primary]");
            let a = tt.split_whitespace().next().unwrap_or("").to_string();
            addrs.push((a, primary));
            continue;
        }
        let Some((k, v)) = tt.split_once(':') else { continue };
        let (k, v) = (k.trim(), v.trim());
        let v = v.replace("N\\A", "").replace("N/A", "");
        let v = v.trim();
        match k {
            "Admin state" => {
                m.insert("admin".into(), json!(v));
            }
            "Operational state" => {
                m.insert("oper".into(), json!(v));
            }
            "Description" => {
                if !v.is_empty() {
                    m.insert("descr".into(), json!(v));
                }
            }
            "Mac address" | "Mac Address" => {
                m.insert("mac".into(), json!(v.to_ascii_lowercase()));
            }
            "MTU" => {
                m.insert("mtu".into(), json!(v.split_whitespace().next().unwrap_or("")));
            }
            "Actual speed" => {
                if !v.is_empty() {
                    m.insert("speed".into(), json!(v));
                }
            }
            "Switchport mode" => {
                m.insert("mode".into(), json!(v));
            }
            "VRF" => {
                m.insert("vrf".into(), json!(v));
            }
            _ => {}
        }
    }
    flush(&mut cur, &mut addrs, &mut out);
    out
}

/// `show interfaces switchport`: mode, access VLAN, allowed VLANs.
pub fn switchport(raw: &str) -> Vec<Value> {
    let lines: Vec<&str> = raw.lines().collect();
    let Some(h) = lines.iter().position(|l| l.contains("Interface") && l.contains("Mode") && l.contains("Access vlan")) else { return Vec::new() };
    let Some(st) = starts(lines[h], &["Interface", "Mode", "Access vlan", "Allowed vlans"]) else { return Vec::new() };
    let mut out = Vec::new();
    for line in &lines[h + 1..] {
        if is_rule(line) || line.trim().is_empty() {
            continue;
        }
        let c = cells(line, &st);
        if c[0].is_empty() || c[0].contains('#') {
            continue;
        }
        let mut row = json!({"name": ifname(&c[0]), "mode": c[1]});
        if !c[2].is_empty() && c[2] != "N/A" {
            row["vlan"] = json!(c[2]);
        }
        if !c[3].is_empty() {
            row["allowed_vlans"] = json!(c[3]);
        }
        out.push(row);
    }
    out
}

/// `show vlan`: id, name and the ports, which may run on to further
/// indented lines.
pub fn vlan(raw: &str) -> Vec<Value> {
    let lines: Vec<&str> = raw.lines().collect();
    let Some(h) = lines.iter().position(|l| l.trim_start().starts_with("VLAN") && l.contains("Name") && l.contains("Ports")) else { return Vec::new() };
    let Some(st) = starts(lines[h], &["VLAN", "Name", "Ports"]) else { return Vec::new() };
    let mut out: Vec<Value> = Vec::new();
    for line in &lines[h + 1..] {
        if is_rule(line) || line.trim().is_empty() {
            continue;
        }
        let c = cells(line, &st);
        if c[0].is_empty() && !c[2].is_empty() {
            // A continuation of the previous VLAN's port list.
            if let Some(last) = out.last_mut() {
                let ports = last["ports"].as_str().unwrap_or("").to_string();
                last["ports"] = json!(format!("{ports}, {}", c[2]).trim_matches([',', ' ']).to_string());
            }
            continue;
        }
        if c[0].chars().all(|ch| ch.is_ascii_digit()) && !c[0].is_empty() {
            let ports: Vec<String> = c[2].split(',').map(|p| p.trim().trim_end_matches("...").trim().to_string()).filter(|p| !p.is_empty()).map(|p| ifname(&p)).collect();
            out.push(json!({"vlan_id": c[0], "name": c[1], "ports": ports.join(", ")}));
        }
    }
    out
}

/// `show mac-address-table` (3.6 and 3.8+ layouts) and its `unicast`
/// variant, whose last column is `Port\Next Hop`: a MAC behind a VTEP
/// reads `192.168.2.2(nve1)` — the interface is `nve1` and the VTEP is
/// kept as `remote_ip`.
pub fn mac_table(raw: &str) -> Vec<Value> {
    let lines: Vec<&str> = raw.lines().collect();
    let Some(h) = lines.iter().position(|l| l.contains("Vlan") && l.contains("Mac Address") && l.contains("Type")) else { return Vec::new() };
    let header = lines[h];
    let last = if header.contains("Port\\Next Hop") { "Port\\Next Hop" } else if header.contains("Interface") { "Interface" } else { "Port" };
    let Some(st) = starts(header, &["Vlan", "Mac Address", "Type", last]) else { return Vec::new() };
    let mut out = Vec::new();
    for line in &lines[h + 1..] {
        if is_rule(line) || line.trim().is_empty() {
            continue;
        }
        let c = cells(line, &st);
        if c[0].is_empty() || !c[0].chars().all(|ch| ch.is_ascii_digit()) || c[1].is_empty() {
            continue;
        }
        let mut row = json!({"vlan": c[0], "mac": c[1].to_ascii_lowercase(), "type": c[2]});
        let port = &c[3];
        match port.split_once('(') {
            Some((ip, rest)) if rest.ends_with(')') => {
                row["interface"] = json!(rest.trim_end_matches(')'));
                row["remote_ip"] = json!(ip.trim());
            }
            _ => {
                row["interface"] = json!(ifname(port));
            }
        }
        out.push(row);
    }
    out
}

/// `show lldp remote` (3.6.3004+): one row per neighbour, the Device ID
/// being the chassis ID and `Not Advertised` meaning no system name.
pub fn lldp_remote(raw: &str) -> Vec<Value> {
    let lines: Vec<&str> = raw.lines().collect();
    let Some(h) = lines.iter().position(|l| l.contains("Local Interface") && l.contains("Device ID")) else { return Vec::new() };
    let Some(st) = starts(lines[h], &["Local Interface", "Device ID", "Port ID", "System Name"]) else { return Vec::new() };
    let mut out = Vec::new();
    for line in &lines[h + 1..] {
        if is_rule(line) || line.trim().is_empty() {
            continue;
        }
        let c = cells(line, &st);
        if c[0].is_empty() || c[0].contains('#') {
            continue;
        }
        let mut row = json!({"local_interface": ifname(&c[0]), "chassis_id": c[1], "neighbor_interface": c[2]});
        if !c[3].is_empty() && c[3] != "Not Advertised" {
            row["neighbor_name"] = json!(c[3]);
        }
        out.push(row);
    }
    out
}

/// `show lldp interfaces ethernet <port> remote`: the per-port detail,
/// with port description, system description and capabilities.
pub fn lldp_interface_remote(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut cur: Option<Map<String, Value>> = None;
    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if !line.starts_with(' ') && (t.starts_with("Ethernet") || t.starts_with("Eth")) && !t.contains(':') {
            if let Some(m) = cur.take() {
                out.push(Value::Object(m));
            }
            let mut m = Map::new();
            m.insert("local_interface".into(), json!(ifname(t)));
            cur = Some(m);
            continue;
        }
        let Some(m) = cur.as_mut() else { continue };
        let Some((k, v)) = t.split_once(':') else { continue };
        let (k, v) = (k.trim(), v.trim());
        match k {
            "Remote chassis id" => {
                m.insert("chassis_id".into(), json!(v.split(';').next().unwrap_or("").trim()));
            }
            "Remote port-id" => {
                m.insert("neighbor_interface".into(), json!(v.split(';').next().unwrap_or("").trim()));
            }
            "Remote port description" => {
                m.insert("neighbor_port_description".into(), json!(v));
            }
            "Remote system name" => {
                m.insert("neighbor_name".into(), json!(v));
            }
            "Remote system description" => {
                m.insert("platform".into(), json!(v));
            }
            "Remote system capabilities supported" => {
                m.insert("capabilities".into(), json!(v.split(';').next().unwrap_or("").trim()));
            }
            _ => {}
        }
    }
    if let Some(m) = cur.take() {
        out.push(Value::Object(m));
    }
    out
}

/// `show ip interface brief`: an address row per line, a secondary
/// address being a row with only the first two columns, which takes the
/// VRF and states of the primary above it.
pub fn ip_interface_brief(raw: &str) -> Vec<Value> {
    let lines: Vec<&str> = raw.lines().collect();
    let Some(h) = lines.iter().position(|l| l.contains("Interface") && l.contains("Address/Mask")) else { return Vec::new() };
    let Some(st) = starts(lines[h], &["Interface", "Address/Mask", "Primary", "Admin-state", "Oper-state", "MTU", "VRF"]) else { return Vec::new() };
    let mut out: Vec<Value> = Vec::new();
    let mut last: Option<(String, String, String, String)> = None;
    for line in &lines[h + 1..] {
        if is_rule(line) || line.trim().is_empty() {
            continue;
        }
        let c = cells(line, &st);
        if c[0].is_empty() || c[0].contains('#') {
            continue;
        }
        let name = ifname(&c[0]);
        let (admin, oper, mtu, vrf) = if c[6].is_empty() {
            last.clone().filter(|l| l.0 == name).map(|l| (l.1, l.2, l.3, String::new())).unwrap_or_default()
        } else {
            (c[3].clone(), c[4].clone(), c[5].clone(), c[6].clone())
        };
        let vrf = if vrf.is_empty() { last.as_ref().map(|_| "default".to_string()).unwrap_or_default() } else { vrf };
        let mut row = json!({"interface": name, "admin": admin, "oper": oper, "vrf": vrf});
        if !mtu.is_empty() {
            row["mtu"] = json!(mtu);
        }
        if c[1] != "Unassigned" && !c[1].is_empty() {
            row["ip"] = json!(c[1]);
            // A continuation row (no VRF column) is a secondary address.
            row["kind"] = json!(if c[6].is_empty() { "secondary" } else { "primary" });
        }
        if !c[6].is_empty() {
            last = Some((name.clone(), c[3].clone(), c[4].clone(), c[5].clone()));
        }
        out.push(row);
    }
    out
}

/// `show ip route [vrf all]` and `show ipv6 route`: the `VRF Name X:`
/// heading names the table; `default` is the default route; a gateway of
/// `0.0.0.0`/`::` is no gateway; AD/M is `1/1`. The pre-3.6.5 layout with
/// no Flag or AD/M columns is read too. ECMP is repeated rows, which the
/// builders merge.
pub fn ip_route(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut vrf = "default".to_string();
    let mut st: Option<(Vec<usize>, bool, bool)> = None;
    for line in raw.lines() {
        let t = line.trim();
        if let Some(v) = t.strip_prefix("VRF Name").and_then(|x| x.strip_suffix(':')) {
            vrf = v.trim().to_string();
            continue;
        }
        if t.starts_with("Destination") && t.contains("Gateway") {
            let has_mask = t.contains("Mask");
            let has_flag = t.contains("Flag");
            let mut names = vec!["Destination"];
            if has_mask {
                names.push("Mask");
            }
            if has_flag {
                names.push("Flag");
            }
            names.extend(["Gateway", "Interface", "Source"]);
            if t.contains("AD/M") {
                names.push("AD/M");
            }
            st = starts(line, &names).map(|s| (s, has_mask, has_flag));
            continue;
        }
        let Some((starts, has_mask, has_flag)) = &st else { continue };
        if is_rule(line) || t.is_empty() || t.starts_with("Flags") || t.contains('#') {
            continue;
        }
        let c = cells(line, starts);
        let mut i = 0;
        let dest = c[i].clone();
        i += 1;
        let mask = if *has_mask { let m = c[i].clone(); i += 1; m } else { String::new() };
        let flag = if *has_flag { let f = c[i].clone(); i += 1; f } else { String::new() };
        let gw = c.get(i).cloned().unwrap_or_default();
        let iface = c.get(i + 1).cloned().unwrap_or_default();
        let source = c.get(i + 2).cloned().unwrap_or_default();
        let adm = c.get(i + 3).cloned().unwrap_or_default();
        if dest.is_empty() || source.is_empty() {
            continue;
        }
        let mut row = json!({"vrf": vrf, "protocol": source, "interface": ifname(&iface)});
        if dest == "default" {
            row["prefix"] = json!(if gw.contains(':') { "::/0" } else { "0.0.0.0/0" });
        } else {
            row["prefix"] = json!(dest);
            if !mask.is_empty() {
                row["mask"] = json!(mask);
            }
        }
        if !gw.is_empty() && gw != "0.0.0.0" && gw != "::" {
            row["next_hop"] = json!(gw);
        }
        if let Some((ad, m)) = adm.split_once('/') {
            row["ad"] = json!(ad.trim());
            row["metric"] = json!(m.trim());
        }
        if !flag.is_empty() {
            row["flags"] = json!(flag);
        }
        out.push(row);
    }
    out
}

/// `show ip arp [vrf all]`, with or without the 3.9.0500 `Flags` column:
/// the type is two words (`Dynamic ETH`), the interface may be `vlan 6` or
/// `eth 1/10`.
pub fn ip_arp(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut vrf = "default".to_string();
    let mut st: Option<Vec<usize>> = None;
    for line in raw.lines() {
        let t = line.trim();
        if let Some(v) = t.strip_prefix("VRF Name") {
            vrf = v.trim().trim_end_matches(':').trim().to_string();
            continue;
        }
        if t.starts_with("Address") && t.contains("Hardware Address") {
            let names: Vec<&str> = if t.contains("Flags") { vec!["Address", "Type", "Flags", "Hardware Address", "Interface"] } else { vec!["Address", "Type", "Hardware Address", "Interface"] };
            st = starts(line, &names);
            continue;
        }
        let Some(starts) = &st else { continue };
        if is_rule(line) || t.is_empty() || t.contains('#') || t.starts_with("Total") {
            continue;
        }
        let c = cells(line, starts);
        let n = c.len();
        let (ip, kind, mac, iface) = (&c[0], &c[1], &c[n - 2], &c[n - 1]);
        if ip.parse::<std::net::IpAddr>().is_err() || mac.is_empty() {
            continue;
        }
        let mut row = json!({"ip": ip, "mac": mac.to_ascii_lowercase(), "interface": ifname(iface), "type": kind, "vrf": vrf});
        if n == 5 && !c[2].is_empty() {
            row["flags"] = json!(c[2]);
        }
        out.push(row);
    }
    out
}

/// `show vrf [all]`: `VRF Info:` blocks with `Name`, `RD` and an
/// `Interfaces:` line whose members follow, inline or indented.
pub fn vrf(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut cur: Option<Map<String, Value>> = None;
    let mut in_ifaces = false;
    let mut ifaces: Vec<String> = Vec::new();
    let flush = |cur: &mut Option<Map<String, Value>>, ifaces: &mut Vec<String>, out: &mut Vec<Value>| {
        if let Some(mut m) = cur.take() {
            if !ifaces.is_empty() {
                m.insert("interfaces".into(), json!(ifaces.join(", ")));
            }
            ifaces.clear();
            if m.contains_key("name") {
                out.push(Value::Object(m));
            }
        }
    };
    for line in raw.lines() {
        let t = line.trim();
        if t == "VRF Info:" {
            flush(&mut cur, &mut ifaces, &mut out);
            cur = Some(Map::new());
            in_ifaces = false;
            continue;
        }
        let Some(m) = cur.as_mut() else { continue };
        if in_ifaces && !t.contains(':') && !t.is_empty() {
            ifaces.extend(t.split(',').map(|x| ifname(x.trim())).filter(|x| !x.is_empty()));
            continue;
        }
        in_ifaces = false;
        let Some((k, v)) = t.split_once(':') else { continue };
        let (k, v) = (k.trim(), v.trim());
        match k {
            "Name" => {
                m.insert("name".into(), json!(v));
            }
            "RD" => {
                if !v.is_empty() && v != "NA" && v != "N/A" {
                    m.insert("rd".into(), json!(v));
                }
            }
            "Interfaces" => {
                in_ifaces = true;
                if !v.is_empty() {
                    ifaces.extend(v.split(',').map(|x| ifname(x.trim())).filter(|x| !x.is_empty()));
                }
            }
            _ => {}
        }
    }
    flush(&mut cur, &mut ifaces, &mut out);
    out
}

/// `show ip ospf neighbors [vrf X]`: `Neighbor <id>, interface address
/// <ip>` / `In the area <a> via Interface Vlan 21` (or `via 1/22`) /
/// `… State is FULL`.
pub fn ospf_neighbors(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut cur: Option<Map<String, Value>> = None;
    for line in raw.lines() {
        let t = line.trim();
        // `Neighbor 192.0.2.1, interface address …` opens a neighbour;
        // `Neighbor priority is 1, State is FULL` is a line inside one.
        if let Some(rest) = t.strip_prefix("Neighbor ").filter(|r| r.starts_with(|c: char| c.is_ascii_digit())) {
            if let Some(m) = cur.take() {
                out.push(Value::Object(m));
            }
            let mut m = Map::new();
            let (id, addr) = rest.split_once(',').unwrap_or((rest, ""));
            m.insert("neighbor_id".into(), json!(id.trim()));
            if let Some(a) = addr.trim().strip_prefix("interface address") {
                m.insert("neighbor_ip".into(), json!(a.trim()));
            }
            cur = Some(m);
            continue;
        }
        let Some(m) = cur.as_mut() else { continue };
        if let Some(rest) = t.strip_prefix("In the area ") {
            let (area, via) = rest.split_once("via").unwrap_or((rest, ""));
            m.insert("area".into(), json!(area.trim()));
            let via = via.trim();
            let via = via.strip_prefix("Interface ").or_else(|| via.strip_prefix("interface ")).unwrap_or(via).trim();
            let name = if via.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) { format!("Eth{via}") } else { ifname(via) };
            m.insert("local_interface".into(), json!(name));
        } else if let Some(i) = t.find("State is ") {
            m.insert("state".into(), json!(t[i + 9..].trim()));
        }
    }
    if let Some(m) = cur.take() {
        out.push(Value::Object(m));
    }
    out
}

/// `show ip bgp [vrf all] summary` and `show ip bgp evpn summary`: the
/// 3.6.8100+ key-value header (`VRF name : x`) and ruled table, or the
/// older one-line `BGP router identifier … local AS number N` form. An
/// unnumbered peer is its interface (`Eth1/17`) in the Neighbor column.
pub fn bgp_summary(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut vrf = "default".to_string();
    let mut st: Option<Vec<usize>> = None;
    for line in raw.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("VRF name") {
            vrf = rest.trim_start_matches([' ', ':']).trim().to_string();
            st = None;
            continue;
        }
        if t.starts_with("Neighbor") && t.contains("State/PfxRcd") {
            st = starts(line, &["Neighbor", "V", "AS", "MsgRcvd", "MsgSent"]).map(|mut s| {
                // Everything from Up/Down on: the two last columns are read from the right.
                s.truncate(3);
                s
            });
            continue;
        }
        let Some(starts) = &st else { continue };
        if is_rule(line) || t.is_empty() || t.contains('#') {
            continue;
        }
        let w: Vec<&str> = t.split_whitespace().collect();
        if w.len() < 6 {
            continue;
        }
        let c = cells(line, starts);
        let neighbor = c[0].clone();
        let asn = w.get(2).unwrap_or(&"").to_string();
        let state_pfx = w[w.len() - 1];
        let updown = w[w.len() - 2];
        let (state, pfx) = state_pfx.split_once('/').unwrap_or((state_pfx, ""));
        let mut row = json!({"vrf": vrf, "as": asn, "state": state, "uptime": updown});
        if neighbor.parse::<std::net::IpAddr>().is_ok() {
            row["neighbor_ip"] = json!(neighbor);
        } else {
            row["local_interface"] = json!(ifname(&neighbor));
        }
        if !pfx.is_empty() && pfx.chars().all(|c| c.is_ascii_digit()) {
            row["prefixes_received"] = json!(pfx);
        }
        out.push(row);
    }
    out
}

/// `show interfaces port-channel summary` and `show interfaces
/// mlag-port-channel summary`: `1 Po2(U)  LACP  Eth1/58(D) Eth1/59(I)`.
/// A member's flag is kept beside it in `members_state`; the MLAG form's
/// peer ports go to `peer_members`.
pub fn port_channel_summary(raw: &str) -> Vec<Value> {
    let lines: Vec<&str> = raw.lines().collect();
    let mlag = raw.contains("MLAG Port-Channel");
    let mut out = Vec::new();
    let mut seen_rule = 0;
    for line in &lines {
        let t = line.trim();
        if is_rule(line) {
            seen_rule += 1;
            continue;
        }
        if seen_rule < 2 || t.is_empty() || t.contains('#') {
            continue;
        }
        let w: Vec<&str> = t.split_whitespace().collect();
        if w.len() < 3 || !w[0].chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let (name, flag) = w[1].split_once('(').map(|(n, f)| (n, f.trim_end_matches(')'))).unwrap_or((w[1], ""));
        let kind = w[2];
        let mut local = Vec::new();
        let mut peer = Vec::new();
        for (i, m) in w[3..].iter().enumerate() {
            let (p, f) = m.split_once('(').map(|(p, f)| (p, f.trim_end_matches(')'))).unwrap_or((m, ""));
            let item = format!("{}({f})", ifname(p));
            // The MLAG table has local ports then peer ports, which the manual
            // separates by a wide gap the whitespace split loses; a port that
            // repeats a local one's number on the other side is the peer's.
            let repeats_a_local = i > 0 && local.iter().any(|x: &String| x.split('(').next() == Some(ifname(p).as_str()));
            if mlag && (repeats_a_local || !peer.is_empty()) {
                peer.push(item);
            } else {
                local.push(item);
            }
        }
        let members: Vec<String> = local.iter().map(|x| x.split('(').next().unwrap_or("").to_string()).collect();
        let state = match flag {
            "U" => "up",
            "D" => "down",
            "P" => "partial",
            "S" => "suspended",
            _ => flag,
        };
        let mut row = json!({"name": ifname(name), "protocol": kind, "members": members.join(", "), "state": state, "members_state": local.join(" ")});
        if !peer.is_empty() {
            row["peer_members"] = json!(peer.join(" "));
        }
        out.push(row);
    }
    out
}

/// `show mlag`: the pair's members (`System-id  State  Hostname`, this
/// switch's name in angle brackets), the IPL port-channel and the peer
/// address.
pub fn mlag(raw: &str) -> Vec<Value> {
    let lines: Vec<&str> = raw.lines().collect();
    let mut ipl: Option<(String, String, String)> = None;
    let mut system_mac = None;
    let mut oper = None;
    let mut out = Vec::new();
    let mut in_members = false;
    let mut in_ipl = false;
    for line in &lines {
        let t = line.trim();
        if let Some(v) = t.strip_prefix("System-mac:") {
            system_mac = Some(v.trim().to_ascii_lowercase());
        }
        if let Some(v) = t.strip_prefix("Operational status:") {
            oper = Some(v.trim().to_string());
        }
        if t.starts_with("MLAG IPLs Summary") {
            in_ipl = true;
            in_members = false;
            continue;
        }
        if t.starts_with("MLAG Members Summary") {
            in_members = true;
            in_ipl = false;
            continue;
        }
        if in_ipl {
            let w: Vec<&str> = t.split_whitespace().collect();
            if w.len() >= 6 && w[0].chars().all(|c| c.is_ascii_digit()) && !w[0].is_empty() {
                ipl = Some((ifname(w[1]), w[4].to_string(), w[5].to_string()));
            }
        }
        if in_members {
            let w: Vec<&str> = t.split_whitespace().collect();
            if w.len() >= 3 && w[0].contains(':') {
                let name_raw = w[2..].join(" ");
                let this = name_raw.starts_with('<');
                let name = name_raw.trim_matches(['<', '>']).to_string();
                out.push(json!({"mac": w[0].to_ascii_lowercase(), "state": w[1], "member": name, "role": if this { "this" } else { "peer" }}));
            }
        }
    }
    for row in &mut out {
        if let Some((po, local, peer)) = &ipl {
            row["peer_link"] = json!(po);
            row["local_ip"] = json!(local);
            row["peer_ip"] = json!(peer);
        }
        if let Some(m) = &system_mac {
            row["system_mac"] = json!(m);
        }
        if let Some(o) = &oper {
            row["mlag_state"] = json!(o);
        }
    }
    out
}

/// `show mlag-vip`: each node's hostname, VIP role and address.
pub fn mlag_vip(raw: &str) -> Vec<Value> {
    let lines: Vec<&str> = raw.lines().collect();
    let Some(h) = lines.iter().position(|l| l.contains("Hostname") && l.contains("VIP-State")) else { return Vec::new() };
    let Some(st) = starts(lines[h], &["Hostname", "VIP-State", "IP Address"]) else { return Vec::new() };
    let mut out = Vec::new();
    for line in &lines[h + 1..] {
        if is_rule(line) || line.trim().is_empty() {
            continue;
        }
        let c = cells(line, &st);
        if c[0].is_empty() || c[0].contains('#') {
            continue;
        }
        out.push(json!({"member": c[0], "role": c[1], "ip": c[2]}));
    }
    out
}

/// `show vrrp`, the 3.6 table (`Interface VR Pri Time Pre State VR IP
/// addr`) or the 3.9 one (`… Admin State Priority Adv-Intvl Preempt State
/// VR IP addr`): one row per virtual router.
pub fn vrrp(raw: &str) -> Vec<Value> {
    let lines: Vec<&str> = raw.lines().collect();
    let Some(h) = lines.iter().position(|l| l.contains("Interface") && l.contains("VR") && l.contains("IP addr")) else { return Vec::new() };
    let new_layout = lines[h].contains("Priority");
    let mut out = Vec::new();
    for line in &lines[h + 1..] {
        let t = line.trim();
        if is_rule(line) || t.is_empty() || t.contains('#') {
            continue;
        }
        let w: Vec<&str> = t.split_whitespace().collect();
        let row = if new_layout {
            // Interface VR Admin Priority Adv Preempt State VIP
            if w.len() < 8 {
                continue;
            }
            json!({"interface": ifname(w[0]), "group": w[1], "priority": w[3], "state": w[6], "vip": w[7]})
        } else {
            // Interface VR Pri Time Pre State VIP
            if w.len() < 7 {
                continue;
            }
            json!({"interface": ifname(w[0]), "group": w[1], "priority": w[2], "state": w[5], "vip": w[6]})
        };
        out.push(row);
    }
    out
}

/// `show magp`: NVIDIA's active-active gateway, `MAGP 100:` blocks.
pub fn magp(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut cur: Option<Map<String, Value>> = None;
    for line in raw.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("MAGP ") {
            if let Some(m) = cur.take() {
                out.push(Value::Object(m));
            }
            let mut m = Map::new();
            m.insert("group".into(), json!(rest.trim_end_matches(':').trim()));
            cur = Some(m);
            continue;
        }
        let Some(m) = cur.as_mut() else { continue };
        let Some((k, v)) = t.split_once(':') else { continue };
        let (k, v) = (k.trim(), v.trim());
        match k {
            "Interface vlan" => {
                m.insert("interface".into(), json!(format!("Vlan{v}")));
            }
            "State" => {
                m.insert("state".into(), json!(v));
            }
            "Virtual IP" => {
                m.insert("vip".into(), json!(v));
            }
            "Virtual MAC" => {
                m.insert("virtual_mac".into(), json!(v.to_ascii_lowercase()));
            }
            _ => {}
        }
    }
    if let Some(m) = cur.take() {
        out.push(Value::Object(m));
    }
    out
}

/// `show interfaces nve`: the VTEP itself — its source interface and, from
/// 3.10, its effective tunnel address. The 3.6 layout's `Remote Manager IP
/// Address` is the controller, not a peer, and is kept as `controller`.
pub fn nve(raw: &str) -> Vec<Value> {
    let mut m = Map::new();
    m.insert("name".into(), json!("nve1"));
    m.insert("kind".into(), json!("vxlan"));
    let mut in_remote = false;
    for line in raw.lines() {
        let t = line.trim();
        if t.starts_with("Remote Manager IP Address") {
            in_remote = true;
            continue;
        }
        if in_remote {
            let w: Vec<&str> = t.split_whitespace().collect();
            if w.first().map(|x| x.parse::<std::net::IpAddr>().is_ok()).unwrap_or(false) {
                m.insert("controller".into(), json!(w[0]));
            }
            if !t.starts_with('-') && !w.first().map(|x| x.parse::<std::net::IpAddr>().is_ok()).unwrap_or(false) {
                in_remote = false;
            }
        }
        if let Some(rest) = t.strip_prefix("Interface NVE ") {
            if let Some(n) = rest.split_whitespace().next() {
                m.insert("name".into(), json!(format!("nve{n}")));
            }
        }
        let Some((k, v)) = t.split_once(':') else { continue };
        let (k, v) = (k.trim(), v.trim());
        match k {
            "Admin state" => {
                m.insert("state".into(), json!(v));
            }
            "Source interface" => {
                m.insert("source_interface".into(), json!(ifname(v)));
            }
            "Source interface ip" => {
                m.insert("local_ip".into(), json!(v));
            }
            "Effective tunnel ip" => {
                if v.parse::<std::net::IpAddr>().is_ok() {
                    m.insert("local_ip".into(), json!(v));
                }
            }
            "Controller mode" => {
                m.insert("controller_mode".into(), json!(v));
            }
            _ => {}
        }
    }
    if m.len() <= 2 {
        return Vec::new();
    }
    vec![Value::Object(m)]
}

/// `show interfaces nve <n> peers` (3.10): one tunnel row per peer VTEP,
/// with the VLAN and VNI it carries.
pub fn nve_peers(raw: &str) -> Vec<Value> {
    let lines: Vec<&str> = raw.lines().collect();
    let Some(h) = lines.iter().position(|l| l.contains("NVE Interface") && l.contains("Peer IP")) else { return Vec::new() };
    let mut out = Vec::new();
    for line in &lines[h + 1..] {
        let t = line.trim();
        if is_rule(line) || t.is_empty() || t.contains('#') {
            continue;
        }
        let w: Vec<&str> = t.split_whitespace().collect();
        if w.len() < 4 || w[3].parse::<std::net::IpAddr>().is_err() {
            continue;
        }
        out.push(json!({"name": format!("nve{}", w[0]), "kind": "vxlan", "remote_ip": w[3], "vlan": w[1], "vni": w[2]}));
    }
    out
}

/// `show spanning-tree`: the root and bridge identifiers, then a row per
/// port with role, state, cost and type.
pub fn spanning_tree(raw: &str) -> Vec<Value> {
    let lines: Vec<&str> = raw.lines().collect();
    let mut root_mac = None;
    let mut bridge_prio = None;
    let mut root_seen = false;
    let mut is_root = false;
    for line in &lines {
        let t = line.trim();
        if t.starts_with("Root ID") {
            root_seen = true;
        }
        if t.starts_with("Bridge ID") {
            root_seen = false;
        }
        if t == "This bridge is the root" {
            is_root = true;
        }
        if let Some(v) = t.strip_prefix("Address").map(|x| x.trim_start_matches([' ', ':']).trim()) {
            if root_seen && root_mac.is_none() {
                root_mac = Some(v.to_ascii_lowercase());
            }
        }
        if let Some(v) = t.strip_prefix("Priority").map(|x| x.trim_start_matches([' ', ':']).trim()) {
            if !root_seen {
                bridge_prio = Some(v.to_string());
            }
        }
    }
    let Some(h) = lines.iter().position(|l| l.contains("Interface") && l.contains("Role") && l.contains("Sts")) else { return Vec::new() };
    let mut out = Vec::new();
    for line in &lines[h + 1..] {
        let t = line.trim();
        if is_rule(line) || t.is_empty() || t.contains('#') {
            continue;
        }
        let w: Vec<&str> = t.split_whitespace().collect();
        if w.len() < 5 {
            continue;
        }
        let (state, flag) = w[2].split_once('(').map(|(s, f)| (s, f.trim_end_matches(')'))).unwrap_or((w[2], ""));
        let mut row = json!({"interface": ifname(w[0]), "role": w[1], "state": state, "cost": w[3], "priority": w[4], "instance": "rst"});
        if let Some(r) = &root_mac {
            row["root_bridge"] = json!(r);
        }
        if let Some(p) = &bridge_prio {
            row["bridge_priority"] = json!(p);
        }
        if is_root {
            row["this_is_root"] = json!("yes");
        }
        if !flag.is_empty() {
            row["flags"] = json!(flag);
        }
        if w.len() > 5 {
            row["port_type"] = json!(w[5]);
        }
        out.push(row);
    }
    out
}

#[cfg(test)]
mod tests {
    //! Every fixture is the manual's example with hostnames, addresses and
    //! MACs invented (D-027): NVIDIA Onyx UM Rev 5.7 (3.6.8008 examples),
    //! Onyx UM for 3.8.2004, and the 3.10.4504 manual where it still
    //! carries one. The layouts are documentation's, not a device's — D-058.
    use super::*;

    #[test]
    fn version_reads_release_and_the_host_id_as_the_base_mac() {
        let raw = "Product name:      Onyx\nProduct release:   3.6.8008\nBuild ID:          #1-dev\nBuild date:        2018-07-18 13:46:44\nTarget arch:       x86_64\nTarget hw:         x86_64\nBuilt by:          jenkins@c5de6027485e\nVersion summary:   X86_64 3.6.8008 2018-07-18 13:46:44 x86_64\nProduct model:     x86onie\nHost ID:           0002C9AABB01\nSystem UUID:       03000200-0400-0500-0006-000700080009\nUptime:            16h 50m 41.260s\nCPU load averages: 2.38 / 2.25 / 2.24\nNumber of CPUs:    2\nSystem memory:     2860 MB used / 12988 MB free / 15848 MB total\nSwap:              0 MB used / 0 MB free / 0 MB total\n";
        let v = &version(raw)[0];
        assert_eq!((v["os_version"].as_str(), v["base_mac"].as_str(), v["uptime"].as_str(), v["os_name"].as_str(), v["vendor"].as_str()), (Some("3.6.8008"), Some("00:02:c9:aa:bb:01"), Some("16h 50m 41.260s"), Some("Onyx"), Some("NVIDIA")));
        assert!(v.get("model").is_none() && v.get("platform").is_none(), "x86onie is not a model");
        // MLNX-OS 3.6.4 and earlier is the same dialect.
        let old = version("Product name:      MLNX-OS\nProduct release:   3.6.4006\nHost ID:           0002C9AABB02\n");
        assert_eq!(old[0]["os_name"], "MLNX-OS");
    }

    #[test]
    fn inventory_gives_model_and_serial_from_the_chassis_row() {
        let raw = "-----------------------------------------------------------------------\nModule     Part Number        Serial Number        Asic Rev.    HW Rev.\n-----------------------------------------------------------------------\nCHASSIS    MSN2010-CB2F       MT0000X00001         N/A          B3\nMGMT       MSN2010-CB2F       MT0000X00001         1            B3\n";
        assert_eq!(inventory(raw), vec![json!({"model": "MSN2010-CB2F", "serial": "MT0000X00001"})]);
        assert_eq!(system_type("SN2010\n"), vec![json!({"model": "SN2010"})]);
        assert_eq!(hosts("Hostname: lab-onyx-1\nName servers:\n 192.0.2.53 dynamic (DHCP on mgmt0)\n"), vec![json!({"hostname": "lab-onyx-1"})]);
        assert_eq!(hosts("Hostname: lab-onyx-1\nName server: 192.0.2.53 (configured)\nDomain name: example.test (configured)\n")[0]["hostname"], "lab-onyx-1");
    }

    #[test]
    fn interfaces_status_in_the_3_6_and_3_9_layouts() {
        let old = "-------------------------------------------------------------------\nPort       Oper State      Admin      Speed            Description\n-------------------------------------------------------------------\nmgmt0      Down            Enabled    1000Mb/s (auto)  -\nmgmt1      Down            Enabled    UNKNOWN          -\nEth1/1     Down            Enabled    100 Gbps         -\nEth1/2     Up              Enabled    100 Gbps         uplink to core\n";
        let rows = interfaces_status(old);
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[3], json!({"name": "Eth1/2", "oper": "Up", "admin": "Enabled", "speed": "100 Gbps", "descr": "uplink to core"}));
        assert_eq!(rows[0]["speed"], "1000Mb/s (auto)");
        let new = "------------------------------------------------------------------------------------------------\nPort             Operational state     Admin              Speed             MTU     Description\n------------------------------------------------------------------------------------------------\nmgmt0            Up                    Enabled            1000Mb/s (auto)   1500      -\nEth1/1           Down                  Disabled           Unknown           1500      -\nEth1/10          Up                    Enabled            100Gx4            1500      -\nEth1/21/1        Up                    Enabled            10G               9216      to host 7\n";
        let rows = interfaces_status(new);
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[2], json!({"name": "Eth1/10", "oper": "Up", "admin": "Enabled", "speed": "100Gx4", "mtu": "1500"}));
        assert_eq!((rows[3]["name"].as_str(), rows[3]["mtu"].as_str(), rows[3]["descr"].as_str()), (Some("Eth1/21/1"), Some("9216"), Some("to host 7")));
    }

    #[test]
    fn interface_blocks_give_an_interface_and_its_addresses() {
        let raw = "Eth1/10:\n  Admin state                      : Enabled\n  Operational state                : Up\n  Last change in operational status: 0:00:47 ago (1 oper change)\n  Boot delay time                  : 0 sec\n  Description                      : N\\A\n  Mac address                      : 00:02:C9:F5:8D:2E\n  MTU                              : 1500 bytes (Maximum packet size 1522 bytes)\n  Fec                              : auto\n  Actual speed                     : 100G\n  Switchport mode                  : access\n  Rx:\n    25                    packets\n  Tx:\n    3                     packets\nPo1:\n  Admin state         : Enabled\n  Operational state   : Down\n  Description         : N/A\n  Mac address         : 00:02:C9:83:30:C8\n  MTU                 : 1500 bytes (Maximum packet size 1522 bytes)\n  Actual speed        : N/A\n  DHCP client         : Disabled\n  IPv4 address:\n    192.0.2.254/24 [primary]\n    198.51.100.254/24\n  Broadcast address:\n    192.0.2.255 [primary]\n    198.51.100.255\n  IPv6 address:\n    2001:db8::1/64 [primary]\n  Arp responder  : Disabled\n  Arp timeout    : 1500 seconds\n  VRF            : default\n  Forwarding mode: inherited cut-through\n";
        let rows = interface_blocks(raw);
        assert_eq!(rows.len(), 4, "{rows:?}");
        assert_eq!(rows[0], json!({"name": "Eth1/10", "admin": "Enabled", "oper": "Up", "mac": "00:02:c9:f5:8d:2e", "mtu": "1500", "speed": "100G", "mode": "access"}));
        assert_eq!(rows[1]["name"], "Po1");
        assert_eq!(rows[1]["vrf"], "default");
        assert_eq!(rows[2], json!({"interface": "Po1", "ip": "192.0.2.254/24", "vrf": "default", "kind": "primary"}));
        assert_eq!(rows[3]["kind"], "secondary");
        let vlan = interface_blocks("Vlan 100:\n  Admin state      : Enabled\n  Operational state: Down\n  Mac Address      : 00:02:C9:83:30:C8\n  IPv4 address:\n    192.0.2.1/24 [primary]\n  MTU              : 1500 bytes\n  VRF              : CUST-A\n");
        assert_eq!(vlan[0]["name"], "Vlan100");
        assert_eq!(vlan[1], json!({"interface": "Vlan100", "ip": "192.0.2.1/24", "vrf": "CUST-A", "kind": "primary"}));
    }

    #[test]
    fn switchport_and_vlan_tables() {
        let sp = switchport("--------------------------------------------------------------------\nInterface         Mode           Access vlan          Allowed vlans\n--------------------------------------------------------------------\nEth1/1            trunk          N/A                  3-10\nEth1/2            access         1\nPo1               hybrid         5                    6-8\nMpo2              trunk          N/A                  1-3, 5-10\n");
        assert_eq!(sp.len(), 4);
        assert_eq!(sp[0], json!({"name": "Eth1/1", "mode": "trunk", "allowed_vlans": "3-10"}));
        assert_eq!(sp[1], json!({"name": "Eth1/2", "mode": "access", "vlan": "1"}));
        assert_eq!(sp[3]["name"], "Mpo2");
        let v = vlan("VLAN    Name                    Ports\n----    -----------             --------------------------------------\n1       default                 Eth1/2, Eth1/3, Eth1/4/1, Eth1/4/2\n                                Eth1/5, Eth1/6\n10      my-vlan-name\n");
        assert_eq!(v.len(), 2, "{v:?}");
        assert_eq!(v[0], json!({"vlan_id": "1", "name": "default", "ports": "Eth1/2, Eth1/3, Eth1/4/1, Eth1/4/2, Eth1/5, Eth1/6"}));
        assert_eq!(v[1], json!({"vlan_id": "10", "name": "my-vlan-name", "ports": ""}));
    }

    #[test]
    fn mac_table_in_both_layouts_and_the_nve_next_hop() {
        let old = "Switch ethernet-default\nVlan    Mac Address         Type     Interface\n----    -----------         ----     ------------\n1       00:00:00:00:00:01   Static   Po5\n1       00:00:3D:5C:FE:16   Dynamic  Eth1/1\nNumber of unicast:      2\nNumber of multicast:    0\n";
        let rows = mac_table(old);
        assert_eq!(rows, vec![json!({"vlan": "1", "mac": "00:00:00:00:00:01", "type": "Static", "interface": "Po5"}), json!({"vlan": "1", "mac": "00:00:3d:5c:fe:16", "type": "Dynamic", "interface": "Eth1/1"})]);
        let unicast = "-----------------------------------------------------------\nVlan    Mac Address         Type         Port\\Next Hop\n-----------------------------------------------------------\n1       00:00:3d:2e:61:72   Dynamic      Eth1/31\n6       00:00:11:22:33:44   Static       192.0.2.2(nve1)\n";
        let rows = mac_table(unicast);
        assert_eq!(rows[1], json!({"vlan": "6", "mac": "00:00:11:22:33:44", "type": "Static", "interface": "nve1", "remote_ip": "192.0.2.2"}));
    }

    #[test]
    fn lldp_remote_table_and_per_port_detail() {
        let raw = "------------------------------------------------------------------------------\nLocal Interface      Device ID            Port ID              System Name\n------------------------------------------------------------------------------\nEth1/4               00:00:3d:a5:f3:35    00:00:3d:a5:f3:35    Not Advertised\nEth1/10              00:00:3d:44:65:00    Eth1/10              lab-onyx-2\nEth1/11              00:00:3d:44:65:00    Eth1/11              lab-onyx-2\n";
        let rows = lldp_remote(raw);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], json!({"local_interface": "Eth1/4", "chassis_id": "00:00:3d:a5:f3:35", "neighbor_interface": "00:00:3d:a5:f3:35"}));
        assert_eq!(rows[1], json!({"local_interface": "Eth1/10", "chassis_id": "00:00:3d:44:65:00", "neighbor_interface": "Eth1/10", "neighbor_name": "lab-onyx-2"}));
        let detail = lldp_interface_remote("Ethernet 1/1\nRemote Index: 1\nRemote chassis id: 00:11:22:33:44:55 ; chassis id subtype: mac\nRemote port-id: ethernet 1/2; port id subtype: local\nRemote port description: ethernet 1/2\nRemote system name: lab-onyx-2\nRemote system description: MSN2010\nRemote system capabilities supported: B ; B\n");
        assert_eq!(detail[0], json!({"local_interface": "Eth1/1", "chassis_id": "00:11:22:33:44:55", "neighbor_interface": "ethernet 1/2", "neighbor_port_description": "ethernet 1/2", "neighbor_name": "lab-onyx-2", "platform": "MSN2010", "capabilities": "B"}));
    }

    #[test]
    fn ip_interface_brief_carries_secondary_addresses_and_the_vrf() {
        let raw = "---------------------------------------------------------------------------------------------------\nInterface     Address/Mask          Primary      Admin-state      Oper-state      MTU       VRF\n---------------------------------------------------------------------------------------------------\nmgmt0         192.0.2.33/25                      Enabled          Up              1500      default\nmgmt1         Unassigned                         Enabled          Up              1500      default\nVlan 100      198.51.100.254/24     primary      Enabled          Down            1500      CUST-A\nVlan 100      198.51.100.126/25\nEth1/1        203.0.113.254/24      primary      Enabled          Up              1500      default\nLoopback 1    192.0.2.1/32          primary      Enabled          Up              1500      default\n";
        let rows = ip_interface_brief(raw);
        assert_eq!(rows.len(), 6, "{rows:?}");
        assert_eq!(rows[0]["ip"], "192.0.2.33/25");
        assert!(rows[1].get("ip").is_none(), "Unassigned is no address");
        assert_eq!(rows[2], json!({"interface": "Vlan100", "ip": "198.51.100.254/24", "kind": "primary", "admin": "Enabled", "oper": "Down", "mtu": "1500", "vrf": "CUST-A"}));
        assert_eq!(rows[3], json!({"interface": "Vlan100", "ip": "198.51.100.126/25", "kind": "secondary", "admin": "Enabled", "oper": "Down", "mtu": "1500", "vrf": "default"}));
        assert_eq!(rows[5]["interface"], "Loopback1");
    }

    #[test]
    fn ip_route_in_the_3_6_5_layout_the_legacy_one_and_ipv6() {
        let raw = "Flags:\n  F: Failed to install in H/W\n  B: BFD protected (static route)\n  c: consistent hashing\nVRF Name default:\n  -----------------------------------------------------------------------------------\n  Destination     Mask            Flag   Gateway         Interface      Source   AD/M\n  -----------------------------------------------------------------------------------\n  default         0.0.0.0                192.0.2.126     mgmt0          DHCP     1/1\n  192.0.2.0       255.255.255.128        0.0.0.0         mgmt0          direct   0/0\n  198.51.100.0    255.255.255.0     c    0.0.0.0         vlan1          direct   0/0\n  203.0.113.0     255.255.255.0          198.51.100.2    vlan20         static   1/1\n  203.0.113.0     255.255.255.0          198.51.100.3    vlan20         static   1/1\nVRF Name CUST-A:\n  -----------------------------------------------------------------------------------\n  Destination     Mask            Flag   Gateway         Interface      Source   AD/M\n  -----------------------------------------------------------------------------------\n  10.80.80.0      255.255.255.0          10.20.20.2      vlan80         ospf     110/20\n";
        let rows = ip_route(raw);
        assert_eq!(rows.len(), 6, "{rows:?}");
        assert_eq!(rows[0], json!({"vrf": "default", "prefix": "0.0.0.0/0", "next_hop": "192.0.2.126", "interface": "mgmt0", "protocol": "DHCP", "ad": "1", "metric": "1"}));
        assert_eq!(rows[1], json!({"vrf": "default", "prefix": "192.0.2.0", "mask": "255.255.255.128", "interface": "mgmt0", "protocol": "direct", "ad": "0", "metric": "0"}));
        assert_eq!(rows[2]["flags"], "c");
        assert_eq!(rows[2]["interface"], "Vlan1");
        assert_eq!((rows[3]["next_hop"].as_str(), rows[4]["next_hop"].as_str()), (Some("198.51.100.2"), Some("198.51.100.3")));
        assert_eq!(rows[5], json!({"vrf": "CUST-A", "prefix": "10.80.80.0", "mask": "255.255.255.0", "next_hop": "10.20.20.2", "interface": "Vlan80", "protocol": "ospf", "ad": "110", "metric": "20"}));
        let legacy = ip_route("Destination     Mask            Gateway         Interface      Source\n-----------     ----            -------         ---------      ------\ndefault         0.0.0.0         192.0.2.1       mgmt0          static\n192.0.2.0       255.255.255.0   0.0.0.0         mgmt0          direct\n");
        assert_eq!(legacy.len(), 2);
        assert_eq!(legacy[0], json!({"vrf": "default", "prefix": "0.0.0.0/0", "next_hop": "192.0.2.1", "interface": "mgmt0", "protocol": "static"}));
        let v6 = ip_route("VRF Name default:\n  ---------------------------------------------------------------------------\n  Destination        Flag   Gateway           Interface      Source   AD/M\n  ---------------------------------------------------------------------------\n  fe80::/64                 ::                mgmt0          direct   256/256\n  default                   ::                mgmt0          direct   1/1\n  2001:db8::/32             2001:db8:1::1     vlan10         static   1/1\n");
        assert_eq!(v6.len(), 3);
        assert_eq!(v6[1]["prefix"], "::/0");
        assert_eq!(v6[2], json!({"vrf": "default", "prefix": "2001:db8::/32", "next_hop": "2001:db8:1::1", "interface": "Vlan10", "protocol": "static", "ad": "1", "metric": "1"}));
    }

    #[test]
    fn ip_arp_with_and_without_the_flags_column() {
        let old = "Total number of entries: 3\n  Address              Type            Hardware Address          Interface\n  ---------------------------------------------------------------------\n  192.0.2.1            Dynamic ETH     00:00:5E:00:01:01         mgmt0\n  192.0.2.120          Dynamic ETH     00:02:C9:62:E8:C2         mgmt0\n  198.51.100.2         Static ETH      00:02:C9:BE:EF:01         vlan 10\n";
        let rows = ip_arp(old);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], json!({"ip": "192.0.2.1", "mac": "00:00:5e:00:01:01", "interface": "mgmt0", "type": "Dynamic ETH", "vrf": "default"}));
        assert_eq!(rows[2]["interface"], "Vlan10");
        let new = "Flags:\nG: EVPN Default GW\nVRF Name default:\nTotal number of entries: 4\n--------------------------------------------------------------------------------------\n Address              Type            Flags      Hardware Address          Interface\n--------------------------------------------------------------------------------------\n 192.0.2.1            Dynamic ETH                00:00:5e:00:01:01         mgmt0\n 198.51.100.6         Dynamic EVPN    G          00:02:c9:ca:cd:48         vlan 6\n 203.0.113.1          Dynamic ETH                00:02:c9:ca:cd:49         eth 1/10\nVRF Name CUST-A:\nTotal number of entries: 1\n--------------------------------------------------------------------------------------\n Address              Type            Flags      Hardware Address          Interface\n--------------------------------------------------------------------------------------\n 10.20.20.2           Dynamic ETH                00:02:c9:ca:cd:50         vlan 80\n";
        let rows = ip_arp(new);
        assert_eq!(rows.len(), 4, "{rows:?}");
        assert_eq!(rows[1], json!({"ip": "198.51.100.6", "mac": "00:02:c9:ca:cd:48", "interface": "Vlan6", "type": "Dynamic EVPN", "vrf": "default", "flags": "G"}));
        assert_eq!(rows[2]["interface"], "Eth1/10");
        assert_eq!(rows[3]["vrf"], "CUST-A");
    }

    #[test]
    fn vrf_blocks() {
        let raw = "VRF Info:\n   Name: default\n   RD: NA\n   Description: NA\n   IP routing state: Enabled\n   IPv6 routing state: Disabled\n   IP multicast routing state: Disabled\n   Protocols:\n   Interfaces:\nVRF Info:\n   Name: CUST-A\n   RD: 65000:10\n   Description: NA\n   IP routing state: Enabled\n   Protocols: ospf\n   Interfaces: Vlan 80, Loopback 2\n";
        let rows = vrf(raw);
        assert_eq!(rows, vec![json!({"name": "default"}), json!({"name": "CUST-A", "rd": "65000:10", "interfaces": "Vlan80, Loopback2"})]);
    }

    #[test]
    fn ospf_neighbours_by_vlan_and_by_port() {
        let raw = "Neighbor 192.0.2.1, interface address 198.51.100.1\nIn the area 0.0.0.0  via Interface Vlan 21\nNeighbor priority is 1, State is FULL\nDR is  192.0.2.2\nBackup Designated Router is 192.0.2.1\nOptions 2\nDead timer due in 36\nNeighbor 192.0.2.1, interface address 198.51.100.5\nIn the area 0.0.0.0  via  1/22\nNeighbor priority is 1, State is FULL\nNo designated router on this network\nOptions 2\nDead timer due in 36\n";
        let rows = ospf_neighbors(raw);
        assert_eq!(rows, vec![
            json!({"neighbor_id": "192.0.2.1", "neighbor_ip": "198.51.100.1", "area": "0.0.0.0", "local_interface": "Vlan21", "state": "FULL"}),
            json!({"neighbor_id": "192.0.2.1", "neighbor_ip": "198.51.100.5", "area": "0.0.0.0", "local_interface": "Eth1/22", "state": "FULL"}),
        ]);
    }

    #[test]
    fn bgp_summary_in_the_current_layout_with_an_unnumbered_peer() {
        let raw = "VRF name                  : default\nBGP router identifier     : 192.0.2.1\nlocal AS number           : 65300\nBGP table version         : 31\nMain routing table version: 31\nIPV4 Prefixes             : 8\nIPV6 Prefixes             : 2\nL2VPN EVPN Prefixes       : 0\n------------------------------------------------------------------------------------------\nNeighbor      V   AS      MsgRcvd   MsgSent   TblVer   InQ   OutQ   Up/Down      State/PfxRcd\n------------------------------------------------------------------------------------------\nEth1/17       4   65023   378       377       31       0     0      0:05:05:14   ESTABLISHED/6\n198.51.100.23 4   65023   79        80        31       0     0      0:01:04:34   ESTABLISHED/4\n2001:db8::1   4   65100   0         0         31       0     0      Never        IDLE/0\n";
        let rows = bgp_summary(raw);
        assert_eq!(rows.len(), 3, "{rows:?}");
        assert_eq!(rows[0], json!({"vrf": "default", "local_interface": "Eth1/17", "as": "65023", "state": "ESTABLISHED", "uptime": "0:05:05:14", "prefixes_received": "6"}));
        assert_eq!(rows[1]["neighbor_ip"], "198.51.100.23");
        assert_eq!((rows[2]["neighbor_ip"].as_str(), rows[2]["state"].as_str()), (Some("2001:db8::1"), Some("IDLE")));
        let evpn = bgp_summary("VRF name                                 : vrf-default\nBGP router identifier                    : 192.0.2.5\nlocal AS number                          : 65001\nL2VPN EVPN Prefixes                      : 1\n----------------------------------------------------------------------------------------------\nNeighbor      V   AS      MsgRcvd   MsgSent   TblVer   InQ   OutQ   Up/Down      State/PfxRcd\n----------------------------------------------------------------------------------------------\n192.0.2.3     4   65002   25        29        2        0     0      0:00:11:10   ESTABLISHED/1\n");
        assert_eq!(evpn[0]["vrf"], "vrf-default");
        assert_eq!(evpn[0]["neighbor_ip"], "192.0.2.3");
    }

    #[test]
    fn port_channels_and_mlag_port_channels() {
        let raw = "Flags: D - Down, U - Up, P - Up in port-channel (members)\n       S - Suspend in port-channel (members), I - Individual\n-----------------------------------------------------------------------\nGroup Port-      Type       Member Ports\nChannel\n-----------------------------------------------------------------------\n1 Po2(U)         LACP       Eth1/58(D) Eth1/59(I) Eth1/60(S)\n2 Po5(D)         LACP       Eth1/1(S) Eth1/33(I)\n3 Po10(U)        Static     Eth1/49(P) Eth1/50(P)\n";
        let rows = port_channel_summary(raw);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], json!({"name": "Po2", "protocol": "LACP", "members": "Eth1/58, Eth1/59, Eth1/60", "state": "up", "members_state": "Eth1/58(D) Eth1/59(I) Eth1/60(S)"}));
        assert_eq!((rows[2]["protocol"].as_str(), rows[2]["members"].as_str()), (Some("Static"), Some("Eth1/49, Eth1/50")));
        let mlag = "MLAG Port-Channel Flags: D-Down, U-Up, P-Partial UP, S-suspended by MLAG\nPort Flags:\n  D: Down\n  P: Up in port-channel (members)\n  S: Suspend in port-channel (members)\n  I: Individual\nMLAG Port-Channel Summary:\n  ---------------------------------------------------------------------\n  Group              Type     Local                     Peer\n  Port-Channel                Ports                     Ports\n  (D/U/P/S)                   (D/P/S/I)                 (D/P/S/I)\n  ---------------------------------------------------------------------\n  1 Mpo61(U)         LACP     Eth1/4(P)                 Eth1/4(P)\n";
        let rows = port_channel_summary(mlag);
        assert_eq!(rows, vec![json!({"name": "Mpo61", "protocol": "LACP", "members": "Eth1/4", "state": "up", "members_state": "Eth1/4(P)", "peer_members": "Eth1/4(P)"})]);
    }

    #[test]
    fn mlag_members_and_the_ipl() {
        let raw = "Admin status: Enabled\nOperational status: Up\nReload-delay: 1 sec\nKeepalive-interval: 30 sec\nUpgrade-timeout: 60 min\nSystem-mac: 00:00:5e:00:01:5d\nMLAG Ports Configuration Summary:\nConfigured: 1\n Disabled: 0\n Enabled: 1\nMLAG Ports Status Summary:\nInactive: 0\n Active-partial: 0\n Active-full: 1\nMLAG IPLs Summary:\nID   Group          Vlan        Operational    Local         Peer           Up Time           Toggle Counter\n     Port-Channel   Interface   State          IP address    IP address\n----------------------------------------------------------------------------------------------------------\n1    Po1            1           Up             10.10.10.1    10.10.10.2     0 days 00:00:09   5\nMLAG Members Summary:\nSystem-id          State   Hostname\n-----------------------------------\n00:00:3d:2d:9b:88  Up      <lab-onyx-2>\n00:00:3d:2d:9b:08  Up       lab-onyx-1\n";
        let rows = mlag(raw);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], json!({"mac": "00:00:3d:2d:9b:88", "state": "Up", "member": "lab-onyx-2", "role": "this", "peer_link": "Po1", "local_ip": "10.10.10.1", "peer_ip": "10.10.10.2", "system_mac": "00:00:5e:00:01:5d", "mlag_state": "Up"}));
        assert_eq!((rows[1]["member"].as_str(), rows[1]["role"].as_str()), (Some("lab-onyx-1"), Some("peer")));
        let vip = mlag_vip("MLAG-VIP\n MLAG group name: Test\n MLAG VIP address: 10.10.10.3/24\n Active nodes: 2\n--------------------------------------------------------------\nHostname             VIP-State              IP Address\n--------------------------------------------------------------\nlab-onyx-1           master                 10.10.10.1\nlab-onyx-2           standby                10.10.10.2\n");
        assert_eq!(vip, vec![json!({"member": "lab-onyx-1", "role": "master", "ip": "10.10.10.1"}), json!({"member": "lab-onyx-2", "role": "standby", "ip": "10.10.10.2"})]);
    }

    #[test]
    fn vrrp_in_both_layouts_and_magp() {
        let old = vrrp("Interface  VR Pri Time  Pre  State VR  IP addr\n------------------------------------------------------\nEth1/5     1  200  2s   Y    Init      192.0.2.10\n");
        assert_eq!(old, vec![json!({"interface": "Eth1/5", "group": "1", "priority": "200", "state": "Init", "vip": "192.0.2.10"})]);
        let new = vrrp("Interface VR Admin State Priority Adv-Intvl Preempt State VR IP addr\n----------------------------------------------------------------------\nVlan20 100 Enabled 100 1 Enabled Master 198.51.100.40\nVlan20 100 Enabled 100 1 Enabled Master 2001:db8::40\n");
        assert_eq!(new[0], json!({"interface": "Vlan20", "group": "100", "priority": "100", "state": "Master", "vip": "198.51.100.40"}));
        let m = magp("MAGP 100:\n Interface vlan: 20\n Admin state   : Enabled\n State         : Master\n Virtual IP    : 198.51.100.200\n V6 State      : Master\n Virtual IPv6  : 2001:db8::254\n Virtual MAC   : AA:BB:CC:DD:EE:FF\n Associated IP Addresses:\n  198.51.100.254\n");
        assert_eq!(m, vec![json!({"group": "100", "interface": "Vlan20", "state": "Master", "vip": "198.51.100.200", "virtual_mac": "aa:bb:cc:dd:ee:ff"})]);
    }

    #[test]
    fn nve_in_the_3_6_and_3_10_layouts_and_its_peers() {
        let old = nve("Remote Manager IP Address                        Port    Connection Type\n-------------------------                        ----    ---------------\n192.0.2.2                                        200     tcp\n  NVE member interfaces: Eth1/2, Eth1/7\nInterface NVE 1 status:\n  Admin state: up\n  Source interface: loopback 1\n  17971                encapsulated (Tx) NVE packets\n");
        assert_eq!(old, vec![json!({"name": "nve1", "kind": "vxlan", "controller": "192.0.2.2", "state": "up", "source_interface": "Loopback1"})]);
        let new = nve("Admin state              : enabled\nSource interface         : loopback 1\nSource interface ip      : 192.0.2.11\nController mode          : BGP\nMlag tunnel ip           : not configured\nEffective tunnel ip      : 192.0.2.11\nGlobal neigh-suppression : Disabled\nAuto-vlan-map            : Disabled\n");
        assert_eq!(new[0], json!({"name": "nve1", "kind": "vxlan", "state": "enabled", "source_interface": "Loopback1", "local_ip": "192.0.2.11", "controller_mode": "BGP"}));
        let peers = nve_peers("NVE Interface  VLAN ID  VNI ID  Peer IP Address\n----------------------------------------------\n1              5        50      192.0.2.12\n1              6        60      192.0.2.13\n");
        assert_eq!(peers, vec![json!({"name": "nve1", "kind": "vxlan", "remote_ip": "192.0.2.12", "vlan": "5", "vni": "50"}), json!({"name": "nve1", "kind": "vxlan", "remote_ip": "192.0.2.13", "vlan": "6", "vni": "60"})]);
    }

    #[test]
    fn spanning_tree_ports_with_the_root_and_bridge() {
        let raw = "Switch                     : ethernet-default\nSpanning tree protocol rst : enabled\nSpanning tree force version: 2\nRoot ID:\n  Priority: 32768\n  Address : 00:02:c9:ff:2c:40\n  This bridge is the root\n  Hello Time (sec)   : 2\nBridge ID:\n  Priority           : 32768\n  Address            : 00:02:c9:ff:2c:40\n  Hello Time (sec)   : 2\nL: Loop Inconsistent\nR: Root Inconsistent\nG: BPDU Guard Inconsistent\n-----------------------------------------------------------------------\nInterface         Role         Sts              Cost     Prio   Type\n-----------------------------------------------------------------------\nEth1/7            Designated   Forwarding       200      128    normal\nEth1/8            Disabled     Discarding(G)    200      128    edge\n";
        let rows = spanning_tree(raw);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], json!({"interface": "Eth1/7", "role": "Designated", "state": "Forwarding", "cost": "200", "priority": "128", "instance": "rst", "root_bridge": "00:02:c9:ff:2c:40", "bridge_priority": "32768", "this_is_root": "yes", "port_type": "normal"}));
        assert_eq!((rows[1]["state"].as_str(), rows[1]["flags"].as_str()), (Some("Discarding"), Some("G")));
    }

    /// Every reader's rows land in the columns the builders read, through
    /// the same normaliser the collection stores through.
    #[test]
    fn onyx_rows_land_in_the_builders_columns() {
        use crate::tables::normalise_all;
        let col = |table: &str, rows: Vec<Value>, i: usize, c: &str| normalise_all(&[table.to_string()], &rows)[i].columns.get(c).cloned().unwrap_or_default();
        let dev = version("Product name:      Onyx\nProduct release:   3.9.3210\nHost ID:           0002C9AABB01\nUptime:            1d 2h\n");
        assert_eq!((col("device", dev.clone(), 0, "os_version"), col("device", dev.clone(), 0, "base_mac"), col("device", dev, 0, "model")), ("3.9.3210".into(), "00:02:c9:aa:bb:01".into(), String::new()));
        let inv = inventory("Module     Part Number        Serial Number        Asic Rev.    HW Rev.
CHASSIS    MSN2010-CB2F       MT0000X00001         N/A          B3
");
        assert_eq!((col("device", inv.clone(), 0, "model"), col("device", inv, 0, "serial")), ("MSN2010-CB2F".into(), "MT0000X00001".into()));
        let n = lldp_remote("Local Interface      Device ID            Port ID              System Name
------------------------------------------------------------------------------
Eth1/10              00:00:3d:44:65:00    Eth1/10              lab-onyx-2
");
        assert_eq!((col("neighbor", n.clone(), 0, "local_if"), col("neighbor", n.clone(), 0, "rem_chassis_id"), col("neighbor", n.clone(), 0, "rem_port_id"), col("neighbor", n, 0, "rem_sysname")), ("Eth1/10".into(), "00:00:3d:44:65:00".into(), "Eth1/10".into(), "lab-onyx-2".into()));
        let r = ip_route("VRF Name default:
  Destination     Mask            Flag   Gateway         Interface      Source   AD/M
  default         0.0.0.0                192.0.2.126     mgmt0          DHCP     1/1
");
        assert_eq!((col("route", r.clone(), 0, "prefix"), col("route", r.clone(), 0, "next_hop"), col("route", r.clone(), 0, "interface"), col("route", r.clone(), 0, "proto"), col("route", r, 0, "ad")), ("0.0.0.0/0".into(), "192.0.2.126".into(), "mgmt0".into(), "DHCP".into(), "1".into()));
        let a = ip_arp(" Address              Type            Hardware Address          Interface
 192.0.2.1            Dynamic ETH     00:00:5E:00:01:01         vlan 10
");
        assert_eq!((col("arp", a.clone(), 0, "ip"), col("arp", a.clone(), 0, "mac"), col("arp", a, 0, "interface")), ("192.0.2.1".into(), "00:00:5e:00:01:01".into(), "Vlan10".into()));
        let l = port_channel_summary("-----
Group Port-      Type       Member Ports
-----
1 Po2(U)         LACP       Eth1/58(P) Eth1/59(P)
");
        assert_eq!((col("lag", l.clone(), 0, "name"), col("lag", l.clone(), 0, "proto"), col("lag", l.clone(), 0, "members"), col("lag", l, 0, "state")), ("Po2".into(), "LACP".into(), "Eth1/58, Eth1/59".into(), "up".into()));
        let m = mlag("MLAG IPLs Summary:
1    Po1            1           Up             10.10.10.1    10.10.10.2     0 days 00:00:09   5
MLAG Members Summary:
00:00:3d:2d:9b:88  Up      <lab-onyx-2>
");
        assert_eq!((col("ha_pair", m.clone(), 0, "member"), col("ha_pair", m.clone(), 0, "role"), col("ha_pair", m.clone(), 0, "mac"), col("ha_pair", m, 0, "peer_link")), ("lab-onyx-2".into(), "this".into(), "00:00:3d:2d:9b:88".into(), "Po1".into()));
        let f = magp("MAGP 100:
 Interface vlan: 20
 State         : Master
 Virtual IP    : 198.51.100.200
");
        assert_eq!((col("fhrp", f.clone(), 0, "group"), col("fhrp", f.clone(), 0, "interface"), col("fhrp", f.clone(), 0, "vip"), col("fhrp", f, 0, "state")), ("100".into(), "Vlan20".into(), "198.51.100.200".into(), "Master".into()));
        let t = nve_peers("NVE Interface  VLAN ID  VNI ID  Peer IP Address
1              5        50      192.0.2.12
");
        assert_eq!((col("tunnel", t.clone(), 0, "name"), col("tunnel", t.clone(), 0, "kind"), col("tunnel", t, 0, "remote_ip")), ("nve1".into(), "vxlan".into(), "192.0.2.12".into()));
        let s = spanning_tree("Interface         Role         Sts              Cost     Prio   Type
Eth1/8            Disabled     Discarding(G)    200      128    edge
");
        assert_eq!((col("stp", s.clone(), 0, "interface"), col("stp", s.clone(), 0, "state"), col("stp", s, 0, "cost")), ("Eth1/8".into(), "Discarding".into(), "200".into()));
        let b = bgp_summary("VRF name : default
Neighbor      V   AS      MsgRcvd   MsgSent   TblVer   InQ   OutQ   Up/Down      State/PfxRcd
Eth1/17       4   65023   378       377       31       0     0      0:05:05:14   ESTABLISHED/6
");
        assert_eq!((col("routing_neighbor", b.clone(), 0, "local_if"), col("routing_neighbor", b.clone(), 0, "area_or_as"), col("routing_neighbor", b, 0, "state")), ("Eth1/17".into(), "65023".into(), "ESTABLISHED".into()));
        let i = ip_interface_brief("Interface     Address/Mask          Primary      Admin-state      Oper-state      MTU       VRF
Vlan 100      198.51.100.254/24     primary      Enabled          Down            1500      CUST-A
");
        assert_eq!((col("ip_address", i.clone(), 0, "interface"), col("ip_address", i.clone(), 0, "ip"), col("ip_address", i.clone(), 0, "vrf"), col("interface", i.clone(), 0, "name"), col("interface", i, 0, "oper")), ("Vlan100".into(), "198.51.100.254/24".into(), "CUST-A".into(), "Vlan100".into(), "Down".into()));
    }

    #[test]
    fn interface_names_come_out_the_way_the_other_rows_spell_them() {
        for (raw, want) in [("ethernet 1/2", "Eth1/2"), ("eth 1/10", "Eth1/10"), ("Eth1/10", "Eth1/10"), ("vlan 6", "Vlan6"), ("Vlan 100", "Vlan100"), ("vlan100", "Vlan100"), ("loopback 1", "Loopback1"), ("port-channel 1", "Po1"), ("mlag-port-channel 61", "Mpo61"), ("Po2", "Po2"), ("Mpo2", "Mpo2"), ("mgmt0", "mgmt0"), ("nve1", "nve1")] {
            assert_eq!(ifname(raw), want, "{raw}");
        }
    }
}
