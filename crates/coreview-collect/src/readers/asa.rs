//! ASA access lists and where they are applied (LT-540).
//!
//! **Built from Cisco's ASA command reference, not from a capture** (D-058):
//! `show running-config access-list` has no ntc template, and ntc's
//! `access-group` template matches only `… in interface …`, stopping with an
//! error on an `out` or `global` line. Each reader reports
//! [`verified_against_hardware`] `false` until the operator's support
//! capture replaces the fixtures in its tests.
//!
//! An access-list line becomes one rule: the list's name, its line number
//! (remarks count, as the ASA numbers them), the action, source, destination
//! and service in the forms the path builder reads (`192.0.2.0/24`, `any`,
//! an object's name, `tcp/443`, `tcp/1000-2000`), and `enabled: no` for an
//! `inactive` line. What the reader cannot express it keeps as written, so a
//! rule it only half-understood is undetermined downstream rather than wrong.

use serde_json::{json, Map, Value};

pub fn verified_against_hardware() -> bool {
    false
}

/// The ASA's own names for well-known ports (its command reference's
/// "TCP and UDP ports" literals).
fn port_number(name: &str) -> Option<u16> {
    if let Ok(n) = name.parse() {
        return Some(n);
    }
    Some(match name {
        "aol" => 5190,
        "bgp" => 179,
        "chargen" => 19,
        "citrix-ica" => 1494,
        "ctiqbe" => 2748,
        "daytime" => 13,
        "discard" => 9,
        "domain" => 53,
        "echo" => 7,
        "exec" => 512,
        "finger" => 79,
        "ftp" => 21,
        "ftp-data" => 20,
        "gopher" => 70,
        "h323" => 1720,
        "hostname" => 101,
        "http" | "www" => 80,
        "https" => 443,
        "ident" => 113,
        "imap4" => 143,
        "irc" => 194,
        "kerberos" => 750,
        "klogin" => 543,
        "kshell" => 544,
        "ldap" => 389,
        "ldaps" => 636,
        "login" => 513,
        "lotusnotes" => 1352,
        "lpd" => 515,
        "netbios-ssn" => 139,
        "nfs" => 2049,
        "nntp" => 119,
        "pop2" => 109,
        "pop3" => 110,
        "pptp" => 1723,
        "rsh" | "cmd" => 514,
        "rtsp" => 554,
        "sip" => 5060,
        "smtp" => 25,
        "sqlnet" => 1521,
        "ssh" => 22,
        "sunrpc" => 111,
        "tacacs" => 49,
        "talk" => 517,
        "telnet" => 23,
        "uucp" => 540,
        "whois" => 43,
        "biff" => 512,
        "bootpc" => 68,
        "bootps" => 67,
        "isakmp" => 500,
        "nameserver" => 42,
        "netbios-dgm" => 138,
        "netbios-ns" => 137,
        "ntp" => 123,
        "radius" => 1645,
        "radius-acct" => 1646,
        "rip" => 520,
        "snmp" => 161,
        "snmptrap" => 162,
        "syslog" => 514,
        "tftp" => 69,
        "vxlan" => 4789,
        "xdmcp" => 177,
        _ => return None,
    })
}

fn mask_len(m: &str) -> Option<u8> {
    let m: std::net::Ipv4Addr = m.parse().ok()?;
    let bits = u32::from(m);
    (bits.leading_ones() + bits.trailing_zeros() == 32).then(|| bits.leading_ones() as u8)
}

/// One address operand, consumed from the tokens: `any`, `any4`, `host A`,
/// `A MASK`, `object N`, `object-group N`, `interface IF`.
fn address(t: &[&str], i: &mut usize) -> Option<String> {
    let first = *t.get(*i)?;
    *i += 1;
    Some(match first {
        "any" | "any4" | "any6" => "any".to_string(),
        "host" => {
            let a = *t.get(*i)?;
            *i += 1;
            a.to_string()
        }
        "object" | "object-group" => {
            let n = *t.get(*i)?;
            *i += 1;
            n.to_string()
        }
        "interface" => {
            let n = *t.get(*i)?;
            *i += 1;
            format!("interface {n}")
        }
        a if a.parse::<std::net::Ipv4Addr>().is_ok() => match t.get(*i).and_then(|m| mask_len(m)) {
            Some(len) => {
                *i += 1;
                format!("{a}/{len}")
            }
            None => a.to_string(),
        },
        other => other.to_string(),
    })
}

/// A port operand after an address: `eq P`, `lt P`, `gt P`, `range A B`,
/// `neq P`. `None` when the next token is not one.
fn port(t: &[&str], i: &mut usize) -> Option<(String, Option<u16>, Option<u16>)> {
    let op = *t.get(*i)?;
    match op {
        "eq" | "lt" | "gt" | "neq" => {
            let p = *t.get(*i + 1)?;
            *i += 2;
            let n = port_number(p);
            Some(match op {
                "eq" => (format!("eq {p}"), n, n),
                "lt" => (format!("lt {p}"), Some(1), n.map(|n| n.saturating_sub(1))),
                "gt" => (format!("gt {p}"), n.map(|n| n.saturating_add(1)), Some(65535)),
                _ => (format!("neq {p}"), None, None),
            })
        }
        "range" => {
            let (a, z) = (*t.get(*i + 1)?, *t.get(*i + 2)?);
            *i += 3;
            Some((format!("range {a} {z}"), port_number(a), port_number(z)))
        }
        _ => None,
    }
}

/// `show running-config access-list`, one row per rule line.
pub fn access_list(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut line_of: std::collections::BTreeMap<String, u32> = Default::default();
    for text in raw.lines() {
        let tokens: Vec<&str> = text.split_whitespace().collect();
        if tokens.first() != Some(&"access-list") || tokens.len() < 3 {
            continue;
        }
        let acl = tokens[1].to_string();
        let n = line_of.entry(acl.clone()).or_insert(0);
        *n += 1;
        let line = *n;
        let mut i = 2;
        if tokens.get(i) == Some(&"line") {
            i += 2;
        }
        let kind = tokens.get(i).copied().unwrap_or("");
        if kind == "remark" {
            continue;
        }
        let mut row = Map::new();
        row.insert("name".into(), json!(acl));
        row.insert("line".into(), json!(line.to_string()));
        row.insert("text".into(), json!(text.trim()));
        let mut enabled = true;
        match kind {
            "standard" => {
                i += 1;
                let action = tokens.get(i).copied().unwrap_or("");
                i += 1;
                row.insert("action".into(), json!(action));
                row.insert("source".into(), json!("any"));
                if let Some(d) = address(&tokens, &mut i) {
                    row.insert("destination".into(), json!(d));
                }
                row.insert("service".into(), json!("ip"));
            }
            "extended" => {
                i += 1;
                let action = tokens.get(i).copied().unwrap_or("");
                i += 1;
                row.insert("action".into(), json!(action));
                // The protocol: a name or number, or a service object.
                let proto = match tokens.get(i).copied() {
                    Some("object") | Some("object-group") => {
                        i += 1;
                        let n = tokens.get(i).copied().unwrap_or("");
                        i += 1;
                        (n.to_string(), true)
                    }
                    Some(p) => {
                        i += 1;
                        (p.to_string(), false)
                    }
                    None => (String::new(), false),
                };
                let src = address(&tokens, &mut i);
                let src_port = port(&tokens, &mut i);
                let dst = address(&tokens, &mut i);
                let dst_port = port(&tokens, &mut i);
                // A service group after the destination: `object-group WEB-PORTS`.
                let mut dst_group = None;
                if tokens.get(i) == Some(&"object-group") {
                    dst_group = tokens.get(i + 1).map(|s| s.to_string());
                    i += 2;
                }
                for t in &tokens[i.min(tokens.len())..] {
                    if *t == "inactive" {
                        enabled = false;
                    }
                }
                if let Some(s) = src {
                    row.insert("source".into(), json!(s));
                }
                if let Some(d) = dst {
                    row.insert("destination".into(), json!(d));
                }
                let (p, is_object) = proto;
                let service = if is_object {
                    p
                } else if let Some(g) = dst_group {
                    g
                } else {
                    match (&dst_port, p.as_str()) {
                        (None, "ip") => "ip".into(),
                        (None, other) => other.to_string(),
                        (Some((_, Some(a), Some(z))), proto) if a == z => format!("{proto}/{a}"),
                        (Some((_, Some(a), Some(z))), proto) => format!("{proto}/{a}-{z}"),
                        // `neq`, or a port name the ASA list does not hold: kept as written.
                        (Some((written, _, _)), proto) => format!("{proto} {written}"),
                    }
                };
                let service = match src_port {
                    Some((written, _, _)) => format!("{service} source {written}"),
                    None => service,
                };
                row.insert("service".into(), json!(service));
            }
            // webtype, ethertype: not traffic the path builder follows.
            _ => continue,
        }
        row.insert("enabled".into(), json!(if enabled { "yes" } else { "no" }));
        out.push(Value::Object(row));
    }
    out
}

/// `show running-config access-group`: where each list applies.
pub fn access_group(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for text in raw.lines() {
        let t: Vec<&str> = text.split_whitespace().collect();
        if t.first() != Some(&"access-group") || t.len() < 3 {
            continue;
        }
        let acl = t[1];
        match t[2] {
            "global" => out.push(json!({"access_list": acl, "direction": "global"})),
            dir @ ("in" | "out") if t.get(3) == Some(&"interface") => {
                if let Some(iface) = t.get(4) {
                    out.push(json!({"access_list": acl, "direction": dir, "interface": iface}));
                }
            }
            _ => {}
        }
    }
    out
}

/// `show nameif`: each interface's name in the configuration and its
/// security level, as a zone of its own. ACLs, NAT and the routing table
/// speak of `outside` and `inside`; the address table of `GigabitEthernet0/0`.
/// The zone joins the two, and its security level decides what an interface
/// with no access list allows.
pub fn nameif(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for text in raw.lines() {
        let t: Vec<&str> = text.split_whitespace().collect();
        if t.len() != 3 || t[0] == "Interface" {
            continue;
        }
        let Ok(level) = t[2].parse::<u8>() else { continue };
        if level > 100 {
            continue;
        }
        out.push(json!({"name": t[1], "interfaces": format!("{}, {}", t[0], t[1]), "security": level.to_string()}));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reconstructed from Cisco's ASA command reference, not captured (D-058).
    const ACL: &str = "access-list outside_in remark web servers from anywhere
access-list outside_in extended permit tcp any host 10.9.9.20 eq https
access-list outside_in extended permit tcp any object-group WEB-SERVERS object-group WEB-PORTS
access-list outside_in extended permit udp any 10.9.9.0 255.255.255.0 range 5000 5010
access-list outside_in extended permit object SVC-APP any object APP-HOST
access-list outside_in extended deny ip any4 any4 log
access-list outside_in extended permit tcp any host 10.9.9.21 eq 8080 inactive
access-list inside_in extended permit ip 10.9.9.0 255.255.255.0 any
access-list inside_in extended permit tcp any eq 1024 any eq www
access-list SPLIT standard permit 10.9.9.0 255.255.255.0
";

    #[test]
    fn each_rule_line_becomes_a_rule_with_the_asa_line_number() {
        let rows = access_list(ACL);
        assert_eq!(rows.len(), 9);
        let r = &rows[0];
        assert_eq!((r["name"].as_str(), r["line"].as_str()), (Some("outside_in"), Some("2")), "a remark counts as a line");
        assert_eq!((r["action"].as_str(), r["source"].as_str(), r["destination"].as_str(), r["service"].as_str()), (Some("permit"), Some("any"), Some("10.9.9.20"), Some("tcp/443")));
        assert_eq!((rows[1]["destination"].as_str(), rows[1]["service"].as_str()), (Some("WEB-SERVERS"), Some("WEB-PORTS")));
        assert_eq!((rows[2]["destination"].as_str(), rows[2]["service"].as_str()), (Some("10.9.9.0/24"), Some("udp/5000-5010")));
        assert_eq!((rows[3]["service"].as_str(), rows[3]["destination"].as_str()), (Some("SVC-APP"), Some("APP-HOST")));
        assert_eq!((rows[4]["action"].as_str(), rows[4]["service"].as_str()), (Some("deny"), Some("ip")));
        assert_eq!(rows[5]["enabled"], "no", "an inactive line is off");
        assert_eq!(rows[6]["line"], "1", "each list is numbered on its own");
        assert_eq!(rows[7]["service"], "tcp/80 source eq 1024", "a source port is kept, not dropped");
        assert_eq!((rows[8]["destination"].as_str(), rows[8]["service"].as_str()), (Some("10.9.9.0/24"), Some("ip")));
    }

    #[test]
    fn access_groups_in_out_and_global() {
        let rows = access_group("access-group outside_in in interface outside\naccess-group inside_out out interface inside\naccess-group GLOBAL-ACL global\n");
        assert_eq!(rows, vec![
            json!({"access_list": "outside_in", "direction": "in", "interface": "outside"}),
            json!({"access_list": "inside_out", "direction": "out", "interface": "inside"}),
            json!({"access_list": "GLOBAL-ACL", "direction": "global"}),
        ]);
    }

    #[test]
    fn nameif_joins_the_interface_to_its_name_and_level() {
        // Reconstructed from Cisco's ASA command reference, not captured (D-058).
        let raw = "Interface                Name                     Security\nGigabitEthernet0/0       outside                    0\nGigabitEthernet0/1       inside                   100\n";
        assert_eq!(nameif(raw), vec![
            json!({"name": "outside", "interfaces": "GigabitEthernet0/0, outside", "security": "0"}),
            json!({"name": "inside", "interfaces": "GigabitEthernet0/1, inside", "security": "100"}),
        ]);
    }

    #[test]
    fn ports_by_the_asa_names() {
        assert_eq!(port_number("https"), Some(443));
        assert_eq!(port_number("domain"), Some(53));
        assert_eq!(port_number("8443"), Some(8443));
        assert_eq!(port_number("not-a-port"), None);
    }
}
