//! NVIDIA Cumulus Linux 3.x/4.x through NCLU — the OS the operator's
//! SN2010s were first said to run (LT-489, LT-652).
//!
//! **Built from NVIDIA's Cumulus Linux documentation (D-058),** as the
//! classic crawler's dialect was; the layouts are the documentation's and
//! `verified: docs` until a capture. Cumulus is Debian underneath, so
//! addresses, neighbours, the ARP table, the FDB and the kernel routes
//! come from the same `ip -j` / `bridge -j` / `lldpcli` commands the
//! `hosts` catalog sends; what is Cumulus's own — identity, bonds, MLAG,
//! VRFs, the LLDP table without an address — is read here. Cumulus 5.x
//! (NVUE, `nv show`) is not read by this: NCLU is gone there.

use serde_json::{json, Map, Value};

use super::text::is_rule;

/// `Label............ value` — a run of dots between the two.
fn dotted<'a>(out: &'a str, label: &str) -> Option<&'a str> {
    out.lines().find_map(|l| {
        let t = l.trim();
        let rest = t.strip_prefix(label)?;
        let value = rest.trim_start_matches(['.', ' ', ':']).trim();
        (rest.starts_with('.') && !value.is_empty()).then_some(value)
    })
}

/// `net show system`: hostname, build, model (`Product Name`, else
/// `Model`), serial, base MAC, uptime.
pub fn system(raw: &str) -> Vec<Value> {
    let mut m = Map::new();
    m.insert("vendor".into(), json!("NVIDIA"));
    if let Some(v) = dotted(raw, "Hostname") {
        m.insert("hostname".into(), json!(v));
    }
    if let Some(v) = dotted(raw, "Build") {
        m.insert("os_version".into(), json!(v.trim_start_matches("Cumulus Linux").trim()));
    }
    if let Some(v) = dotted(raw, "Product Name").or_else(|| dotted(raw, "Model")) {
        m.insert("model".into(), json!(v));
    }
    if let Some(v) = dotted(raw, "Serial Number") {
        m.insert("serial".into(), json!(v));
    }
    if let Some(v) = dotted(raw, "Base MAC Address") {
        m.insert("base_mac".into(), json!(v.to_ascii_lowercase()));
    }
    if let Some(v) = dotted(raw, "Uptime") {
        m.insert("uptime".into(), json!(v));
    }
    if m.len() <= 1 {
        return Vec::new();
    }
    vec![Value::Object(m)]
}

/// Cumulus Linux 5.x, NVUE: `nv show system` — a two-column table under a
/// header (`operational  applied  pending  description`): `hostname`,
/// `build  Cumulus Linux 5.5.0`, `uptime`, `timezone`. From NVIDIA's
/// documentation (D-058); the model and serial are not in it (they come
/// from `decode-syseeprom`, which the allowlist does not admit).
pub fn nv_system(raw: &str) -> Vec<Value> {
    let mut m = Map::new();
    m.insert("vendor".into(), json!("NVIDIA"));
    for line in raw.lines() {
        let w: Vec<&str> = line.split_whitespace().collect();
        if w.len() < 2 || w[0] == "operational" || is_rule(line) {
            continue;
        }
        let rest = line.trim_start()[w[0].len()..].trim();
        // The value ends where the description column begins, two or more spaces on.
        let value = rest.split("  ").next().unwrap_or("").trim();
        match w[0] {
            "hostname" => {
                m.insert("hostname".into(), json!(value));
            }
            "build" => {
                m.insert("os_version".into(), json!(value.trim_start_matches("Cumulus Linux").trim()));
            }
            "uptime" => {
                m.insert("uptime".into(), json!(value));
            }
            _ => {}
        }
    }
    if m.len() <= 1 {
        return Vec::new();
    }
    vec![Value::Object(m)]
}

/// `net show lldp`: `LocalPort  Speed  Mode  RemoteHost  RemotePort` —
/// a neighbour's name and port, no address or chassis.
pub fn lldp(raw: &str) -> Vec<Value> {
    let lines: Vec<&str> = raw.lines().collect();
    let Some(h) = lines.iter().position(|l| l.contains("LocalPort") && l.contains("RemoteHost")) else { return Vec::new() };
    lines[h + 1..]
        .iter()
        .filter(|l| !is_rule(l) && !l.trim().is_empty())
        .filter_map(|row| {
            let f: Vec<&str> = row.split_whitespace().collect();
            (f.len() >= 5).then(|| json!({"local_interface": f[0], "neighbor_name": f[f.len() - 2], "neighbor_interface": f[f.len() - 1]}))
        })
        .collect()
}

/// `net show interface bonds`: `UP  bond01  2G  9216  802.3ad  Bond
/// Members: swp1(UP), swp2(UP)`.
pub fn bonds(raw: &str) -> Vec<Value> {
    raw.lines()
        .filter_map(|l| {
            let (head, members) = l.split_once("Bond Members:")?;
            let f: Vec<&str> = head.split_whitespace().collect();
            let name = f.get(1)?.to_string();
            let lacp = f.iter().any(|w| *w == "802.3ad" || w.eq_ignore_ascii_case("lacp"));
            let members: Vec<String> = members.split(',').map(|m| m.trim().split('(').next().unwrap_or("").to_string()).filter(|m| !m.is_empty()).collect();
            (!members.is_empty()).then(|| json!({"name": name, "protocol": if lacp { "LACP" } else { "static" }, "members": members.join(", "), "state": f[0].to_ascii_lowercase()}))
        })
        .collect()
}

/// `net show clag`: the MLAG pair — this switch's and the peer's system
/// IDs and roles, the peer link, the backup address, the system MAC, then
/// the MLAG bonds. Two rows, `this` and `peer`.
pub fn clag(raw: &str) -> Vec<Value> {
    let mut ours: Option<(String, String)> = None;
    let mut peer: Option<(String, String)> = None;
    let mut peer_link = None;
    let mut peer_ip = None;
    let mut backup_ip = None;
    let mut system_mac = None;
    let mut alive = None;
    let mut bonds: Vec<String> = Vec::new();
    let mut in_bonds = false;
    for line in raw.lines() {
        let t = line.trim();
        if t.starts_with("The peer is") {
            alive = Some(t.to_string());
        }
        let id_role = |v: &str| {
            let w: Vec<&str> = v.split_whitespace().collect();
            (w.len() >= 3).then(|| (w[1].to_ascii_lowercase(), w[2].to_string()))
        };
        if let Some(v) = t.strip_prefix("Our Priority, ID, and Role:") {
            ours = id_role(v);
        } else if let Some(v) = t.strip_prefix("Peer Priority, ID, and Role:") {
            peer = id_role(v);
        } else if let Some(v) = t.strip_prefix("Peer Interface and IP:") {
            let w: Vec<&str> = v.split_whitespace().collect();
            peer_link = w.first().map(|s| s.to_string());
            peer_ip = w.get(1).map(|s| s.to_string());
        } else if let Some(v) = t.strip_prefix("Backup IP:") {
            backup_ip = v.split_whitespace().next().map(str::to_string);
        } else if let Some(v) = t.strip_prefix("System MAC:") {
            system_mac = Some(v.trim().to_ascii_lowercase());
        } else if t.starts_with("CLAG Interfaces") {
            in_bonds = true;
        } else if in_bonds && !is_rule(line) && !t.starts_with("Our Interface") && !t.is_empty() {
            if let Some(b) = t.split_whitespace().next() {
                bonds.push(b.to_string());
            }
        }
    }
    let mut out = Vec::new();
    for (which, pair) in [("this", ours), ("peer", peer)] {
        let Some((mac, role)) = pair else { continue };
        let mut row = json!({"member": which, "mac": mac, "role": role});
        if let Some(p) = &peer_link {
            row["peer_link"] = json!(p);
        }
        if let Some(ip) = backup_ip.as_ref().or(peer_ip.as_ref()) {
            row["peer_address"] = json!(ip);
        }
        if let Some(m) = &system_mac {
            row["system_mac"] = json!(m);
        }
        if let Some(a) = &alive {
            row["peer_state"] = json!(a);
        }
        if !bonds.is_empty() {
            row["bonds"] = json!(bonds.join(", "));
        }
        out.push(row);
    }
    out
}

/// `net show vrf`: `VRF  Table` — the name and its kernel table.
pub fn vrf(raw: &str) -> Vec<Value> {
    let lines: Vec<&str> = raw.lines().collect();
    let Some(h) = lines.iter().position(|l| l.trim_start().starts_with("VRF") && l.contains("Table")) else { return Vec::new() };
    lines[h + 1..]
        .iter()
        .filter(|l| !is_rule(l) && !l.trim().is_empty())
        .filter_map(|row| {
            let f: Vec<&str> = row.split_whitespace().collect();
            (f.len() >= 2).then(|| json!({"name": f[0], "table": f[1]}))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    //! Reconstructed from NVIDIA's documentation (D-058), invented values (D-027).
    use super::*;

    #[test]
    fn identity_comes_off_net_show_system() {
        let raw = "Hostname......... leaf01\nBuild............ Cumulus Linux 4.4.0\nUptime........... 5 days, 3:44:41.690000\n\nModel............ Mlnx X86 MSN2010\nMemory........... 8GB\nDisk............. 14.9GB\nVendor Name...... Mellanox\nPart Number...... MSN2010-CB2F\nBase MAC Address. 00:00:5E:00:53:01\nSerial Number.... MT0000EXAMPLE\nProduct Name..... MSN2010\n";
        assert_eq!(system(raw), vec![json!({"vendor": "NVIDIA", "hostname": "leaf01", "os_version": "4.4.0", "model": "MSN2010", "serial": "MT0000EXAMPLE", "base_mac": "00:00:5e:00:53:01", "uptime": "5 days, 3:44:41.690000"})]);
    }

    #[test]
    fn nvue_system_gives_hostname_and_build() {
        let raw = "          operational          applied  pending  description\n--------  -------------------  -------  -------  ------------------------------\nhostname  leaf01                                 Static hostname for the switch\nbuild     Cumulus Linux 5.5.0                    system build version\nuptime    6 days, 22:03:49                       system uptime\ntimezone  Etc/UTC                                system time zone\n";
        assert_eq!(nv_system(raw), vec![json!({"vendor": "NVIDIA", "hostname": "leaf01", "os_version": "5.5.0", "uptime": "6 days, 22:03:49"})]);
    }

    #[test]
    fn lldp_bonds_clag_and_vrf_tables() {
        let n = lldp("LocalPort  Speed  Mode       RemoteHost  RemotePort\n---------  -----  ---------  ----------  ----------\neth0       1G     Mgmt       oob-mgmt    swp10\nswp51      1G     Default    spine01     swp1\n");
        assert_eq!(n, vec![json!({"local_interface": "eth0", "neighbor_name": "oob-mgmt", "neighbor_interface": "swp10"}), json!({"local_interface": "swp51", "neighbor_name": "spine01", "neighbor_interface": "swp1"})]);
        let b = bonds("    Name     Speed   MTU   Mode     Summary\n--  -------  ------  ----  -------  ----------------------------------\nUP  bond01   2G      9216  802.3ad  Bond Members: swp1(UP), swp2(UP)\nUP  peerlink 20G     9216  802.3ad  Bond Members: swp49(UP), swp50(UP)\n");
        assert_eq!(b[0], json!({"name": "bond01", "protocol": "LACP", "members": "swp1, swp2", "state": "up"}));
        assert_eq!(b[1]["members"], "swp49, swp50");
        let c = clag("The peer is alive\n     Our Priority, ID, and Role: 32768 00:00:5e:00:53:5e primary\n    Peer Priority, ID, and Role: 32768 00:00:5E:00:53:5F secondary\n          Peer Interface and IP: peerlink.4094 fe80::200:5eff:fe00:535f (linklocal)\n                      Backup IP: 192.0.2.12 (active)\n                     System MAC: 00:00:5e:00:53:94\n\nCLAG Interfaces\nOur Interface      Peer Interface     CLAG Id   Conflicts              Proto-Down Reason\n----------------   ----------------   -------   --------------------   -----------------\n           bond01   bond01             1         -                      -\n           bond02   -                  2         -                      -\n");
        assert_eq!(c.len(), 2);
        assert_eq!(c[0], json!({"member": "this", "mac": "00:00:5e:00:53:5e", "role": "primary", "peer_link": "peerlink.4094", "peer_address": "192.0.2.12", "system_mac": "00:00:5e:00:53:94", "peer_state": "The peer is alive", "bonds": "bond01, bond02"}));
        assert_eq!((c[1]["member"].as_str(), c[1]["mac"].as_str(), c[1]["role"].as_str()), (Some("peer"), Some("00:00:5e:00:53:5f"), Some("secondary")));
        let v = vrf("VRF              Table\n---------------- -----\nmgmt             1001\nvrf-red          1002\n");
        assert_eq!(v, vec![json!({"name": "mgmt", "table": "1001"}), json!({"name": "vrf-red", "table": "1002"})]);
    }
}
