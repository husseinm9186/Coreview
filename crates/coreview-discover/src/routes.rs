//! The routing table, IPv4 and IPv6 (LT-200).
//!
//! LT-131 asked a device one question — where does unknown traffic go — and
//! that is still the cheap answer used for direction. This is the whole table,
//! for what the default route cannot say: which subnets a device is on, which
//! it reaches through which neighbour, and so which layer-3 hops sit between
//! the devices on a diagram.
//!
//! **Written against captured output** (not D-026): `show ip route` and
//! `show ipv6 route` from a WS-C2960CX on IOS 15.2(7)E, 2026-09-16 — a static
//! default, a connected and a local route, the "variably subnetted" header, and
//! IPv6's two-line entries. Dynamic protocols' lines (`O`, `D`, `B`) use the
//! same shape as the captured static line with an age and an interface after
//! the next hop; the lab switch runs none, so those extra fields are read
//! generously and the tests say which lines were captured and which were not.

use std::net::IpAddr;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    /// `4` or `6`.
    pub family: u8,
    /// The prefix, `192.0.2.0/24` or `2001:db8::/32`.
    pub prefix: String,
    /// The platform's route code as printed: `S*`, `C`, `O IA`.
    pub code: String,
    /// What put it there, in words: `static`, `connected`, `ospf`.
    pub protocol: String,
    /// Where it goes. Empty for a connected route.
    pub next_hops: Vec<String>,
    /// The interface, where the line named one.
    pub interface: Option<String>,
    /// Administrative distance and metric, from `[1/0]`.
    pub distance: Option<u32>,
    pub metric: Option<u32>,
}

impl Route {
    pub fn is_default(&self) -> bool {
        self.prefix == "0.0.0.0/0" || self.prefix == "::/0"
    }
}

/// The commands worth asking for the table, per platform.
pub fn commands_for(platform_hint: &str) -> &'static [&'static str] {
    let p = platform_hint.to_ascii_lowercase();
    if p.contains("forti") {
        // FortiOS prints a different table; there is no capture of it yet, so
        // nothing is asked rather than parsed wrongly.
        &[]
    } else {
        &["show ip route", "show ipv6 route"]
    }
}

fn protocol_of(code: &str) -> &'static str {
    let first = code.split_whitespace().next().unwrap_or("").trim_end_matches(['*', '+', '%', 'p']);
    match first {
        "C" => "connected",
        "L" => "local",
        "S" => "static",
        "R" => "rip",
        "M" => "mobile",
        "B" => "bgp",
        "D" | "EX" => "eigrp",
        "O" | "OI" | "OE1" | "OE2" | "ON1" | "ON2" => "ospf",
        "i" | "I" => "isis",
        "U" => "per-user-static",
        "o" => "odr",
        "P" => "periodic",
        "H" => "nhrp",
        "l" => "lisp",
        "a" => "application",
        "ND" | "NDp" => "nd",
        _ => "other",
    }
}

/// Second words IOS puts after a route code: `O IA`, `O E2`, `D EX`, `i L1`.
const SUBCODES: &[&str] = &["IA", "E1", "E2", "N1", "N2", "EX", "L1", "L2", "ia", "su"];

fn distance_metric(field: &str) -> (Option<u32>, Option<u32>) {
    let inner = field.trim_start_matches('[').trim_end_matches([']', ',']);
    let mut parts = inner.split('/');
    (
        parts.next().and_then(|v| v.parse().ok()),
        parts.next().and_then(|v| v.parse().ok()),
    )
}

/// Reads "via X, [age,] Interface" and "is directly connected, Interface".
fn read_path(words: &[&str], route: &mut Route) {
    let mut i = 0;
    while i < words.len() {
        let w = words[i].trim_end_matches(',');
        if w == "via" {
            if let Some(next) = words.get(i + 1) {
                let hop = next.trim_end_matches(',');
                if hop.parse::<IpAddr>().is_ok() {
                    if !route.next_hops.iter().any(|h| h == hop) {
                        route.next_hops.push(hop.to_string());
                    }
                } else if route.interface.is_none() && !hop.is_empty() {
                    // IPv6: "via Vlan1, directly connected" or "via Null0, receive".
                    route.interface = Some(hop.to_string());
                }
                i += 2;
                continue;
            }
        }
        if w == "connected" {
            if let Some(iface) = words.get(i + 1) {
                route.interface = Some(iface.trim_end_matches(',').to_string());
            }
            break;
        }
        i += 1;
    }
    // "via 10.0.0.2, 00:01:02, GigabitEthernet0/1": the last word names the
    // interface when it is neither an address nor an age.
    if route.interface.is_none() && !route.next_hops.is_empty() {
        if let Some(last) = words.last().map(|w| w.trim_end_matches(',')) {
            let is_age = last.contains(':') && last.chars().all(|c| c.is_ascii_digit() || c == ':')
                || last.chars().next().is_some_and(|c| c.is_ascii_digit()) && last.chars().any(|c| c.is_ascii_alphabetic()) && last.len() <= 8;
            if !is_age && last.parse::<IpAddr>().is_err() && last != "via" && !last.starts_with('[') {
                route.interface = Some(last.to_string());
            }
        }
    }
}

/// Parses `show ip route` or `show ipv6 route`, whichever it is given.
///
/// Never fails: a platform that rejects the command gives an error line, which
/// has no route in it.
pub fn parse_routes(output: &str) -> Vec<Route> {
    let mut routes: Vec<Route> = Vec::new();
    let mut in_codes = false;
    for raw in output.lines() {
        let line = raw.trim_end();
        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            in_codes = false;
            continue;
        }
        if trimmed.starts_with("Codes:") {
            in_codes = true;
            continue;
        }
        // The legend wraps over indented lines. IPv4 ends it with a blank
        // line; IPv6 goes straight on to the first route, which is not
        // indented.
        if in_codes && line.starts_with(' ') {
            continue;
        }
        in_codes = false;
        if trimmed.starts_with("Gateway of last resort") || trimmed.starts_with("IPv6 Routing Table") {
            continue;
        }
        let words: Vec<&str> = trimmed.split_whitespace().collect();

        // A continuation: another path for the route above ("[110/2] via …")
        // or IPv6's second line ("via Vlan1, directly connected").
        let indented = line.starts_with(' ');
        if indented && (words[0].starts_with('[') || words[0] == "via") {
            if let Some(last) = routes.last_mut() {
                let start = if words[0].starts_with('[') { 1 } else { 0 };
                if start == 1 && last.distance.is_none() {
                    let (d, m) = distance_metric(words[0]);
                    last.distance = d;
                    last.metric = m;
                }
                read_path(&words[start..], last);
            }
            continue;
        }

        // "192.0.2.0/24 is variably subnetted, 2 subnets, 2 masks" and the
        // classful "10.0.0.0/8 is subnetted, 3 subnets": headers, not routes.
        if words.contains(&"subnetted,") {
            continue;
        }

        // A route line: code, optional sub-code, prefix, then the path.
        let mut i = 0;
        let mut code = words[0].to_string();
        if !code.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
            continue;
        }
        i += 1;
        if let Some(sub) = words.get(i) {
            if SUBCODES.contains(sub) {
                code = format!("{code} {sub}");
                i += 1;
            }
        }
        let Some(prefix_word) = words.get(i) else { continue };
        let Some((network, length)) = prefix_word.split_once('/') else { continue };
        let Ok(addr) = network.parse::<IpAddr>() else { continue };
        let Ok(bits) = length.parse::<u8>() else { continue };
        i += 1;
        let mut route = Route {
            family: if addr.is_ipv4() { 4 } else { 6 },
            prefix: format!("{addr}/{bits}"),
            protocol: protocol_of(&code).to_string(),
            code,
            next_hops: Vec::new(),
            interface: None,
            distance: None,
            metric: None,
        };
        if let Some(dm) = words.get(i).filter(|w| w.starts_with('[')) {
            let (d, m) = distance_metric(dm);
            route.distance = d;
            route.metric = m;
            i += 1;
        }
        read_path(&words[i..], &mut route);
        routes.push(route);
    }
    routes
}

/// The subnets a device is directly on, from its connected routes.
pub fn connected_prefixes(routes: &[Route]) -> Vec<String> {
    routes
        .iter()
        .filter(|r| r.protocol == "connected")
        .map(|r| r.prefix.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from a WS-C2960CX (IOS 15.2(7)E) on 2026-09-16 with
    /// `show ip route`; the addresses are the lab's, renumbered (LT-277).
    const IOS_V4: &str = "\
Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP
       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area
       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2
       E1 - OSPF external type 1, E2 - OSPF external type 2
       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2
       ia - IS-IS inter area, * - candidate default, U - per-user static route
       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP
       a - application route
       + - replicated route, % - next hop override, p - overrides from PfR

Gateway of last resort is 192.168.77.1 to network 0.0.0.0

S*    0.0.0.0/0 [1/0] via 192.168.77.1
      192.168.77.0/24 is variably subnetted, 2 subnets, 2 masks
C        192.168.77.0/24 is directly connected, Vlan1
L        192.168.77.7/32 is directly connected, Vlan1
";

    /// Captured from the same switch, same day, with `show ipv6 route`.
    const IOS_V6: &str = "\
IPv6 Routing Table - default - 1 entries
Codes: C - Connected, L - Local, S - Static, U - Per-user Static route
       R - RIP, D - EIGRP, EX - EIGRP external, O - OSPF Intra
       OI - OSPF Inter, OE1 - OSPF ext 1, OE2 - OSPF ext 2, ON1 - OSPF NSSA ext 1
       ON2 - OSPF NSSA ext 2
L   FF00::/8 [0/0]
     via Null0, receive
";

    #[test]
    fn reads_the_captured_ipv4_table() {
        let routes = parse_routes(IOS_V4);
        assert_eq!(routes.len(), 3, "{routes:#?}");
        assert_eq!(routes[0].prefix, "0.0.0.0/0");
        assert!(routes[0].is_default());
        assert_eq!(routes[0].code, "S*");
        assert_eq!(routes[0].protocol, "static");
        assert_eq!(routes[0].next_hops, vec!["192.168.77.1"]);
        assert_eq!((routes[0].distance, routes[0].metric), (Some(1), Some(0)));
        assert_eq!(routes[1].protocol, "connected");
        assert_eq!(routes[1].interface.as_deref(), Some("Vlan1"));
        assert!(routes[1].next_hops.is_empty());
        assert_eq!(routes[2].prefix, "192.168.77.7/32");
        assert_eq!(routes[2].protocol, "local");
        assert_eq!(connected_prefixes(&routes), vec!["192.168.77.0/24"]);
    }

    #[test]
    fn reads_the_captured_ipv6_table() {
        let routes = parse_routes(IOS_V6);
        assert_eq!(routes.len(), 1, "{routes:#?}");
        assert_eq!(routes[0].family, 6);
        assert_eq!(routes[0].prefix, "ff00::/8");
        assert_eq!(routes[0].protocol, "local");
        assert_eq!(routes[0].interface.as_deref(), Some("Null0"));
    }

    /// Not captured — the lab switch runs no dynamic routing. The same line
    /// shape with the fields IOS adds for a learned route: a sub-code, an age
    /// and an interface, and a second equal-cost path on its own line.
    #[test]
    fn reads_a_learned_route_with_two_paths() {
        let text = "\
O IA     198.51.100.0/24 [110/3] via 192.0.2.2, 00:04:10, GigabitEthernet0/1
                         [110/3] via 192.0.2.6, 00:04:10, GigabitEthernet0/2
";
        let routes = parse_routes(text);
        assert_eq!(routes.len(), 1, "{routes:#?}");
        assert_eq!(routes[0].code, "O IA");
        assert_eq!(routes[0].protocol, "ospf");
        assert_eq!(routes[0].next_hops, vec!["192.0.2.2", "192.0.2.6"]);
        assert_eq!(routes[0].interface.as_deref(), Some("GigabitEthernet0/1"));
        assert_eq!(routes[0].metric, Some(3));
    }

    #[test]
    fn a_rejected_command_is_no_routes() {
        assert!(parse_routes("% Invalid input detected at '^' marker.").is_empty());
        assert!(parse_routes("").is_empty());
    }
}
