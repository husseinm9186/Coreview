//! Cisco forwarding tables no ntc template reads: IOS-XR's
//! `show cef ipv4` and the ASA's `show asp table routing`.
//!
//! **Built from Cisco's command references** — the layouts are the
//! documentation's, `verified: docs` until a capture.

use serde_json::{json, Value};

use super::text::{cells, starts};

/// IOS-XR `show cef [vrf <name>] ipv4`: `Prefix  Next Hop  Interface`, an
/// equal-cost route's further hops on their own lines with the prefix
/// column empty; `attached`, `receive`, `broadcast` and `drop` in the Next
/// Hop column.
pub fn iosxr_cef(raw: &str) -> Vec<Value> {
    let lines: Vec<&str> = raw.lines().collect();
    let Some(h) = lines.iter().position(|l| l.starts_with("Prefix") && l.contains("Next Hop")) else { return Vec::new() };
    let Some(st) = starts(lines[h], &["Prefix", "Next Hop", "Interface"]) else { return Vec::new() };
    let mut out: Vec<Value> = Vec::new();
    for line in &lines[h + 1..] {
        let t = line.trim();
        if t.is_empty() || t.starts_with('-') || t.contains('#') {
            continue;
        }
        let c = cells(line, &st);
        if c[0].is_empty() {
            // A further next hop of the prefix above.
            if let Some(last) = out.last_mut() {
                if !c[1].is_empty() {
                    let nh = last["next_hop"].as_str().unwrap_or("").to_string();
                    last["next_hop"] = json!(if nh.is_empty() { c[1].clone() } else { format!("{nh}, {}", c[1]) });
                }
                if !c[2].is_empty() {
                    let i = last["interface"].as_str().unwrap_or("").to_string();
                    last["interface"] = json!(if i.is_empty() { c[2].clone() } else { format!("{i}, {}", c[2]) });
                }
            }
            continue;
        }
        if !c[0].contains('/') {
            continue;
        }
        let mut row = json!({"prefix": c[0], "next_hop": c[1]});
        if !c[2].is_empty() {
            row["interface"] = json!(c[2]);
        }
        out.push(row);
    }
    out
}

/// ASA `show asp table routing`: the `in` rows are what the data path
/// forwards by — `in  10.0.0.0  255.255.255.0  inside`, `in  0.0.0.0
/// 0.0.0.0  via 192.0.2.1, outside`, and `identity` for the box's own
/// addresses. The `out` rows repeat them for the return and are left out.
pub fn asa_asp_routing(raw: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let w: Vec<&str> = line.split_whitespace().collect();
        if w.len() < 4 || w[0] != "in" {
            continue;
        }
        let (prefix, mask) = (w[1], w[2]);
        if prefix.parse::<std::net::Ipv4Addr>().is_err() {
            continue;
        }
        let rest = w[3..].join(" ");
        let mut row = json!({"prefix": prefix, "mask": mask});
        if let Some(r) = rest.strip_prefix("via ") {
            let (nh, iface) = r.split_once(',').unwrap_or((r, ""));
            row["next_hop"] = json!(nh.trim());
            if !iface.trim().is_empty() {
                row["interface"] = json!(iface.trim());
            }
        } else if rest == "identity" {
            row["next_hop"] = json!("identity");
        } else {
            row["next_hop"] = json!("attached");
            row["interface"] = json!(rest);
        }
        out.push(row);
    }
    out
}

#[cfg(test)]
mod tests {
    //! Layouts from the command references, invented addresses.
    use super::*;

    #[test]
    fn xr_cef_with_ecmp_attached_and_receive() {
        let raw = "Prefix              Next Hop            Interface\n------------------- ------------------- ------------------\n0.0.0.0/0           192.0.2.1           GigabitEthernet0/0/0/0\n0.0.0.0/32          broadcast\n192.0.2.0/30        attached            GigabitEthernet0/0/0/0\n192.0.2.2/32        receive             GigabitEthernet0/0/0/0\n10.1.0.0/24         192.0.2.1           GigabitEthernet0/0/0/0\n                    192.0.2.5           GigabitEthernet0/0/0/1\n224.0.0.0/4         0.0.0.0/32\n";
        let rows = iosxr_cef(raw);
        assert_eq!(rows.len(), 6, "{rows:#?}");
        assert_eq!(rows[0], json!({"prefix": "0.0.0.0/0", "next_hop": "192.0.2.1", "interface": "GigabitEthernet0/0/0/0"}));
        assert_eq!(rows[1], json!({"prefix": "0.0.0.0/32", "next_hop": "broadcast"}));
        assert_eq!(rows[2]["next_hop"], "attached");
        assert_eq!(rows[4], json!({"prefix": "10.1.0.0/24", "next_hop": "192.0.2.1, 192.0.2.5", "interface": "GigabitEthernet0/0/0/0, GigabitEthernet0/0/0/1"}));
    }

    #[test]
    fn asa_asp_routing_keeps_the_in_rows() {
        let raw = "in   255.255.255.255 255.255.255.255 identity\nin   192.0.2.1       255.255.255.255 identity\nin   192.0.2.0       255.255.255.0   inside\nin   0.0.0.0         0.0.0.0         via 198.51.100.1, outside\nout  255.255.255.255 255.255.255.255 inside\nout  192.0.2.0       255.255.255.0   inside\nout  0.0.0.0         0.0.0.0         via 198.51.100.1, outside\n";
        let rows = asa_asp_routing(raw);
        assert_eq!(rows.len(), 4, "{rows:#?}");
        assert_eq!(rows[1], json!({"prefix": "192.0.2.1", "mask": "255.255.255.255", "next_hop": "identity"}));
        assert_eq!(rows[2], json!({"prefix": "192.0.2.0", "mask": "255.255.255.0", "next_hop": "attached", "interface": "inside"}));
        assert_eq!(rows[3], json!({"prefix": "0.0.0.0", "mask": "0.0.0.0", "next_hop": "198.51.100.1", "interface": "outside"}));
    }
}
