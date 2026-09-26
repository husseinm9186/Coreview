//! Policy routing: where a route-map or a policy route can send a packet
//! somewhere the routing table would not (LT-479).
//!
//! The path engine (LT-346) reads routing tables. A policy route applied to
//! an interface is consulted before the table, so a trace through a device
//! that has one may be wrong without knowing it. This reads *that a policy
//! exists and where*, so the trace can say "not evaluated here" rather than
//! stay silent. It does not read the policy's match clauses; evaluating them
//! is not built and is not claimed.
//!
//! **Built from the vendors' documentation and posted sessions (D-058)**:
//! IOS and NX-OS `show ip policy` — an interface and its route map per row —
//! and FortiOS `show router policy`, whose `edit N` blocks name an
//! `input-device`. [`verified_against_hardware`] answers `false`.

/// One place policy routing is applied.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRoute {
    /// The ingress interface the policy is on, where the platform names one.
    pub interface: Option<String>,
    /// The route map's name on IOS, or the policy's sequence on FortiOS.
    pub name: String,
}

/// D-058: neither layout has met a device.
pub fn verified_against_hardware() -> bool {
    false
}

/// `show ip policy`.
///
/// ```text
/// Interface      Route map
/// Gi0/1          PBR-TO-WAN2
/// Vlan50         PBR-GUEST
/// ```
pub fn parse_ip_policy(out: &str) -> Vec<PolicyRoute> {
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() < 2 || f[0].eq_ignore_ascii_case("interface") || f[0].starts_with('%') {
                return None;
            }
            Some(PolicyRoute { interface: Some(f[0].to_string()), name: f[1..].join(" ") })
        })
        .collect()
}

/// FortiOS `show router policy`.
///
/// ```text
/// config router policy
///     edit 1
///         set input-device "port2"
///         set src "10.0.50.0/255.255.255.0"
///         set gateway 203.0.113.9
///         set output-device "wan2"
///     next
/// end
/// ```
pub fn parse_fortios_policy(out: &str) -> Vec<PolicyRoute> {
    let mut found: Vec<PolicyRoute> = Vec::new();
    for line in out.lines() {
        let t = line.trim();
        if let Some(n) = t.strip_prefix("edit ") {
            found.push(PolicyRoute { interface: None, name: format!("policy {}", n.trim()) });
        } else if let Some(dev) = t.strip_prefix("set input-device ") {
            if let Some(cur) = found.last_mut() {
                cur.interface = Some(dev.split_whitespace().next().unwrap_or("").trim_matches('"').to_string()).filter(|s| !s.is_empty());
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ios_names_an_interface_and_a_map_per_row() {
        let got = parse_ip_policy("Interface      Route map\nGi0/1          PBR-TO-WAN2\nVlan50         PBR-GUEST\n");
        assert_eq!(got, [PolicyRoute { interface: Some("Gi0/1".into()), name: "PBR-TO-WAN2".into() }, PolicyRoute { interface: Some("Vlan50".into()), name: "PBR-GUEST".into() }]);
        assert!(parse_ip_policy("% Invalid input detected at '^' marker.").is_empty());
        assert!(!verified_against_hardware());
    }

    #[test]
    fn fortios_names_a_policy_and_its_input_device() {
        let got = parse_fortios_policy("config router policy\n    edit 1\n        set input-device \"port2\"\n        set src \"10.0.50.0/255.255.255.0\"\n        set gateway 203.0.113.9\n        set output-device \"wan2\"\n    next\n    edit 2\n        set gateway 203.0.113.1\n    next\nend\n");
        assert_eq!(got, [PolicyRoute { interface: Some("port2".into()), name: "policy 1".into() }, PolicyRoute { interface: None, name: "policy 2".into() }]);
    }
}
