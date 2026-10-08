//! The routing table, IPv4 and IPv6.
//!
//! Asked a device one question — where does unknown traffic go — and
//! that is still the cheap answer used for direction. This is the whole table,
//! for what the default route cannot say: which subnets a device is on, which
//! it reaches through which neighbour, and so which layer-3 hops sit between
//! the devices on a diagram.
//!
//! **Written against captured output**: `show ip route` and
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
    /// The table the *next hop* is resolved in, where the device said so.
    ///
    /// NX-OS writes `*via 203.0.113.4%default` for a route in a tenant VRF
    /// whose next hop is a VTEP address in the underlay table. Resolving that
    /// next hop in the tenant's own table finds nothing, which is how an
    /// overlay path silently becomes "no route".
    pub next_hop_vrf: Option<String>,
    /// The VXLAN segment this route is carried over, from
    /// `segid: 50000 tunnelid: 0x… encap: VXLAN`.
    ///
    /// Its presence is the device saying, in its own routing table, that this
    /// prefix is reached across the overlay — which is the evidence the path
    /// engine needs to draw a tunnel hop rather than a wire.
    pub segment_id: Option<u32>,
}

impl Route {
    pub fn is_default(&self) -> bool {
        self.prefix == "0.0.0.0/0" || self.prefix == "::/0"
    }
}

/// The commands worth asking for the table, per platform.
pub fn commands_for(platform_hint: &str) -> &'static [&'static str] {
    let p = platform_hint.to_ascii_lowercase();
    if p.contains("pan-os") {
        // Every virtual router's table, read by shape.
        &["show routing route"]
    } else if p.contains("cumulus") {
        // Read by the Cumulus details reader, which asks NVUE's RIB,
        // the kernel's table, and NCLU's in turn (`crawl::read_cumulus_details`).
        &[]
    } else if p.contains("comware") || p.contains("huawei") {
        &["display ip routing-table"]
    } else if p.contains("routeros") {
        &["/ip route print without-paging"]
    } else if p.contains("forti") {
        // The table the collector read on a real FortiGate
        // and FortiSwitch on 7.6 — the IOS shape under `Routing
        // table for VRF=0`, or FRR's on a FortiSwitch — which this parser
        // reads too.
        &["get router info routing-table all"]
    } else if ["aireos", "aruba controller"].iter().any(|h| p.contains(h)) {
        // The documentation-built families whose table parsers have not been written.
        &[]
    } else if p.contains("cisco asa") || p.contains("gaia") {
        // ASA and Gaia spell it `show route`, in a table this parser reads.
        &["show route"]
    } else if p.contains("arubaos-cx") {
        // AOS-CX's own listing, every VRF at once; read by the
        // CX details reader, which splits the VRFs out.
        &[]
    } else {
        &["show ip route", "show ipv6 route"]
    }
}

fn protocol_of(code: &str) -> &'static str {
    // Quagga and FRR — EdgeOS and VyOS — write the selected route as
    // `S>*`, so `>` is a marker too.
    let first = code.split_whitespace().next().unwrap_or("").trim_end_matches(['*', '+', '%', 'p', '>']);
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
        "ND" | "NDp" | "NDr" => "nd",
        // IPv6 writes the device's own address on an interface as
        // `LC`, local connected — seen on a real IOS table where every
        // loopback came back as `other`. `RL` is the redistributed form of
        // the same thing.
        "LC" | "RL" => "local",
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
    // "via 10.0.0.2, 00:01:02, GigabitEthernet0/1": the interface is the
    // word after the next hop that is neither an address nor an age nor a
    // bracket. FortiOS 7.6 writes it straight after the hop and a
    // `[1/0]` last (`via 203.0.113.1, wan2, [1/0]`), FRR an age last
    // (`via 192.0.2.1, internal, 02:53:12`) — the collector read both on a
    // lab FortiGate and FortiSwitch, and the last-word rule read
    // neither.
    if route.interface.is_none() && !route.next_hops.is_empty() {
        let after = words.iter().rposition(|w| w.trim_end_matches(',') == "via").map(|v| v + 2).unwrap_or(words.len());
        for w in words.iter().skip(after).map(|w| w.trim_end_matches(',')) {
            let is_age = w.contains(':') && w.chars().all(|c| c.is_ascii_digit() || c == ':')
                || w.chars().next().is_some_and(|c| c.is_ascii_digit()) && w.chars().any(|c| c.is_ascii_alphabetic()) && w.len() <= 8;
            if !is_age && !w.is_empty() && w.parse::<IpAddr>().is_err() && w != "via" && !w.starts_with('[') {
                route.interface = Some(w.to_string());
                break;
            }
        }
    }
}

/// Parses `show ip route` or `show ipv6 route`, whichever it is given.
///
/// Never fails: a platform that rejects the command gives an error line, which
/// has no route in it.
pub fn parse_routes(output: &str) -> Vec<Route> {
    // NX-OS prints a different table entirely, not a variation on this one —
    // the prefix is on its own line and the paths are indented under it. Told
    // apart by shape rather than by asking the caller what the platform was,
    // the same way the FortiSwitch MAC table is.
    // PAN-OS, told apart by shape the same way; Comware
    // and Huawei's table, and RouterOS's listing, likewise.
    if crate::panos::is_route_table(output) {
        return crate::panos::parse_routes(output);
    }
    if crate::comware::is_routing_table(output) {
        return crate::comware::parse_routing_table(output);
    }
    if crate::routeros::is_route_table(output) {
        return crate::routeros::parse_routes(output);
    }
    // AOS-CX's listing, which the collector has read since
    // And this did not. The default VRF's; the others are a VRF's.
    if crate::arubacx::is_route_listing(output) {
        return crate::arubacx::parse_routes_by_vrf(output).into_iter().filter(|(vrf, _)| vrf == "default").map(|(_, r)| r).collect();
    }
    // An ASA prints `network mask`; rewritten to `network/len` so the
    // reader below sees the table it knows. IOS output passes through unchanged.
    let rewritten = crate::asa::cidr_prefixes(output);
    let output = rewritten.as_str();
    if output.contains("ubest/mbest:") || output.contains("IP Route Table for VRF") {
        return parse_nxos_routes(output);
    }
    // Junos prints a table header, then a prefix and its paths on separate
    // lines with a different vocabulary again.
    if output.contains(" destinations, ") && output.contains(" routes (") {
        return parse_junos_routes(output);
    }
    let mut routes: Vec<Route> = Vec::new();
    // The mask from the `is subnetted` header above the current block, where
    // there is one.
    let mut classful_bits: Option<u8> = None;
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
        // FortiOS heads each VDOM's table `Routing table for VRF=0`. The
        // rest of its table is the IOS shape, which is why this is a line to
        // skip rather than a parser of its own.
        if trimmed.starts_with("Routing table for VRF") {
            continue;
        }
        let words: Vec<&str> = trimmed.split_whitespace().collect();

        // A continuation: another path for the route above ("[110/2] via …")
        // or IPv6's second line ("via Vlan1, directly connected").
        let indented = line.starts_with(' ');
        // FRR writes an equal-cost route's next leg as `  *   via …`.
        let frr_leg = words[0] == "*" && words.get(1) == Some(&"via");
        if indented && (words[0].starts_with('[') || words[0] == "via" || frr_leg) {
            if let Some(last) = routes.last_mut() {
                let start = if words[0].starts_with('[') || frr_leg { 1 } else { 0 };
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
        //
        // The classful one is not only a header, it is *where the mask
        // lives*. Under `is subnetted` every row is written bare —
        // `O E2  172.20.1.0 [110/20] via …` — and the length belongs to this
        // line. Remembering it is the difference between reading a real table
        // and reading a seventh of one. `variably subnetted` is the opposite:
        // each row carries its own mask, so nothing is inherited and the
        // remembered value is cleared rather than left to leak into it.
        if words.contains(&"subnetted,") {
            classful_bits = if words.contains(&"variably") {
                None
            } else {
                words
                    .first()
                    .and_then(|w| w.split_once('/'))
                    .and_then(|(_, len)| len.parse::<u8>().ok())
            };
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
        // A bare address takes the mask from the `is subnetted` header above
        // it; anything else carries its own.
        let (network, bits) = match prefix_word.split_once('/') {
            Some((network, length)) => {
                let Ok(bits) = length.parse::<u8>() else { continue };
                (network, bits)
            }
            None => match classful_bits {
                Some(bits) => (*prefix_word, bits),
                None => continue,
            },
        };
        let Ok(addr) = network.parse::<IpAddr>() else { continue };
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
            next_hop_vrf: None,
            segment_id: None,
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

/// Cisco NX-OS's routing table, which is not a dialect of the IOS one.
///
/// **Written against captured output**: `show ip route vrf default`,
/// `show ip route vrf <tenant>` and `show ip route vrf all` from a Nexus leaf
/// and a Nexus spine in a live VXLAN/EVPN fabric, 2026-09-20. The capture
/// stayed on the capturing machine; what is reproduced here is the
/// shape.
///
/// ```text
/// IP Route Table for VRF "default"
/// '*' denotes best ucast next-hop
///
/// 10.0.1.10/31, ubest/mbest: 1/0
///     *via 192.0.2.68, Eth1/39, [110/42], 1y29w, ospf-FABRIC, intra
/// 192.0.2.68/31, ubest/mbest: 1/0, attached
///     *via 10.0.1.69, Eth1/39, [0/0], 12w0d, direct
/// 198.51.100.0/24, ubest/mbest: 1/0
///     *via 203.0.113.4%default, [200/2000], 41w0d, bgp-65000, internal,
///          tag 65000, segid: 50000 tunnelid: 0x… encap: VXLAN
/// ```
///
/// Three things here exist nowhere in the IOS table and all three matter:
/// the prefix and its paths are on separate lines, `%default` says the next
/// hop lives in a *different* table from the route, and `segid … encap: VXLAN`
/// says the path crosses the overlay.
pub fn parse_nxos_routes(output: &str) -> Vec<Route> {
    let mut routes: Vec<Route> = Vec::new();
    for raw in output.lines() {
        let line = strip_more(raw.trim_end());
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('\'') || trimmed.starts_with("IP Route Table") {
            continue;
        }

        // A path under the prefix above.
        let path = trimmed
            .strip_prefix("**via ")
            .or_else(|| trimmed.strip_prefix("*via "))
            .or_else(|| trimmed.strip_prefix("via "));
        if let Some(path) = path {
            if let Some(route) = routes.last_mut() {
                read_nxos_path(path, trimmed, route);
            }
            continue;
        }

        // A prefix line: `192.0.2.68/31, ubest/mbest: 1/0, attached`.
        let Some((prefix_word, rest)) = trimmed.split_once(',') else { continue };
        if !rest.contains("ubest") {
            continue;
        }
        let Some((network, length)) = prefix_word.trim().split_once('/') else { continue };
        let Ok(addr) = network.parse::<IpAddr>() else { continue };
        let Ok(bits) = length.parse::<u8>() else { continue };
        routes.push(Route {
            family: if addr.is_ipv4() { 4 } else { 6 },
            prefix: format!("{addr}/{bits}"),
            // Filled in from the path line: NX-OS names the protocol there,
            // not in a code column.
            code: String::new(),
            protocol: String::new(),
            next_hops: Vec::new(),
            interface: None,
            distance: None,
            metric: None,
            next_hop_vrf: None,
            segment_id: None,
        });
    }
    routes.retain(|r| !r.next_hops.is_empty() || r.interface.is_some() || !r.protocol.is_empty());
    routes
}

/// One `*via …` line, added to the route it belongs to.
///
/// The fields are positional and the device is consistent about them, so they
/// are read by position: address, then an interface *unless* the next field is
/// the `[distance/metric]` bracket, then the age, then what put the route
/// there. Guessing an interface by "starts with a letter and has a digit in
/// it" claims `bgp-65000` and `type-1`, which is why this does not.
fn read_nxos_path(path: &str, whole: &str, route: &mut Route) {
    let fields: Vec<&str> = path.split(',').map(str::trim).collect();
    let Some(first) = fields.first() else { return };

    // `203.0.113.4%default` — the next hop, and the table it is resolved in.
    let (hop, vrf) = match first.split_once('%') {
        Some((hop, vrf)) => (hop, Some(vrf.to_string())),
        None => (*first, None),
    };
    if hop.parse::<IpAddr>().is_ok() {
        if !route.next_hops.iter().any(|h| h == hop) {
            route.next_hops.push(hop.to_string());
        }
        if route.next_hop_vrf.is_none() {
            route.next_hop_vrf = vrf;
        }
    } else if route.interface.is_none() && !hop.is_empty() {
        // A connected route on some platforms prints the interface here.
        route.interface = Some(hop.to_string());
    }

    let mut i = 1;
    if let Some(next) = fields.get(i) {
        if !next.starts_with('[') {
            if route.interface.is_none() {
                route.interface = Some(next.to_string());
            }
            i += 1;
        }
    }
    if let Some(bracket) = fields.get(i).filter(|f| f.starts_with('[')) {
        let (d, m) = distance_metric(bracket);
        if route.distance.is_none() {
            route.distance = d;
            route.metric = m;
        }
        i += 1;
    }
    // The age, then the source.
    i += 1;
    if let Some(source) = fields.get(i) {
        if route.code.is_empty() && !source.is_empty() {
            route.code = source.to_string();
            route.protocol = nxos_protocol(source).to_string();
        }
    }

    // `segid: 50000 tunnelid: 0xcb007104 encap: VXLAN`, which can be on this
    // field or a later one, so the whole line is searched.
    if route.segment_id.is_none() {
        if let Some(at) = whole.find("segid:") {
            route.segment_id = whole[at + "segid:".len()..]
                .split_whitespace()
                .next()
                .and_then(|n| n.parse::<u32>().ok());
        }
    }
}

/// `ospf-FABRIC` → `ospf`; `direct` → `connected`.
///
/// NX-OS appends the process or AS to the protocol, so the name has to be
/// taken from in front of the hyphen — and `direct` is what it calls a
/// connected route, which every other part of this crate spells `connected`.
fn nxos_protocol(source: &str) -> &'static str {
    match source.split('-').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "direct" | "connected" => "connected",
        "local" => "local",
        "static" => "static",
        "ospf" | "ospfv3" => "ospf",
        "bgp" => "bgp",
        "eigrp" => "eigrp",
        "rip" => "rip",
        "isis" => "isis",
        "am" => "am",
        "hmm" => "hmm",
        "broadcast" => "broadcast",
        "discard" | "null" => "discard",
        _ => "other",
    }
}

/// Removes a `--More--` that a pager glued to the front of a line.
///
/// The app's own sessions ask for a 200-column terminal and send
/// `terminal length 0`, so it does not normally see one. An operator's own
/// capture, pasted in from an 80-column window, is full of them — and a
/// prefix line that begins `--More--10.0.1.28/31` is a route that silently
/// goes missing.
fn strip_more(line: &str) -> &str {
    let mut rest = line;
    while let Some(after) = rest.trim_start().strip_prefix("--More--") {
        rest = after;
    }
    rest
}

/// Junos's routing table, which shares nothing with the other two.
///
/// **Built from Juniper's `show route` documentation, not from captured
/// output**. Unverified until a device has answered it.
///
/// ```text
/// CORP.inet.0: 12 destinations, 12 routes (12 active, 0 holddown, 0 hidden)
/// + = Active Route, - = Last Active, * = Both
///
/// 192.0.2.0/24       *[OSPF/10] 1d 02:11:33, metric 2
///                     > to 198.51.100.1 via ge-0/0/0.0
///                       to 198.51.100.5 via ge-0/0/1.0
/// 203.0.113.0/24     *[Direct/0] 3w1d
///                     > via ge-0/0/1.0
/// ```
///
/// `[Protocol/preference]` is Junos's way of writing the code and the
/// administrative distance together, `metric N` is where the metric lives
/// when there is one, and `> to X via Y` is a next hop — the `>` marking the
/// one being used, and a second `to` line under the same prefix being ECMP.
pub fn parse_junos_routes(output: &str) -> Vec<Route> {
    let mut routes: Vec<Route> = Vec::new();
    for raw in output.lines() {
        let line = raw.trim_end();
        let t = line.trim();
        if t.is_empty() || t.starts_with('+') || t.contains(" destinations, ") {
            continue;
        }

        // A next hop for the route above: `> to 198.51.100.1 via ge-0/0/0.0`,
        // `> via ge-0/0/1.0`, or the same without the `>` for a path that is
        // not the one in use.
        let hop = t.strip_prefix("> ").unwrap_or(t);
        if hop.starts_with("to ") || hop.starts_with("via ") {
            if let Some(route) = routes.last_mut() {
                read_junos_hop(hop, route);
            }
            continue;
        }
        // Junos's own annotations under a route, none of which is a path.
        if hop.starts_with("AS path:") || hop.starts_with("Validation") || hop.starts_with("validation") {
            continue;
        }

        // A prefix line, or another route for the prefix above:
        // `192.0.2.0/24       *[OSPF/10] 1d 02:11:33, metric 2`
        let Some(open) = t.find('[') else { continue };
        let Some(close) = t[open..].find(']') else { continue };
        let inside = &t[open + 1..open + close];
        let (protocol, preference) = match inside.split_once('/') {
            Some((p, d)) => (p.trim(), d.trim().parse::<u32>().ok()),
            None => (inside.trim(), None),
        };
        let head = t[..open].trim().trim_end_matches(['*', '+', '-']).trim();
        // No prefix in front of the bracket means another path for the route
        // above, which Junos writes with the prefix column left blank.
        let prefix = if head.is_empty() {
            match routes.last() {
                Some(last) => last.prefix.clone(),
                None => continue,
            }
        } else {
            let Some((network, length)) = head.split_once('/') else { continue };
            let Ok(addr) = network.parse::<IpAddr>() else { continue };
            let Ok(bits) = length.parse::<u8>() else { continue };
            format!("{addr}/{bits}")
        };
        let family = if prefix.contains(':') { 6 } else { 4 };
        // `, metric 2` — the only place a Junos metric appears.
        let metric = t
            .split([',', ' '])
            .skip_while(|f| !f.eq_ignore_ascii_case("metric"))
            .nth(1)
            .and_then(|m| m.trim().parse::<u32>().ok());
        routes.push(Route {
            family,
            prefix,
            protocol: junos_protocol(protocol).to_string(),
            code: protocol.to_string(),
            next_hops: Vec::new(),
            interface: None,
            distance: preference,
            metric,
            next_hop_vrf: None,
            segment_id: None,
        });
    }
    routes.retain(|r| !r.next_hops.is_empty() || r.interface.is_some() || !r.protocol.is_empty());
    routes
}

/// `to 198.51.100.1 via ge-0/0/0.0`, or `via ge-0/0/1.0` for a connected one.
fn read_junos_hop(hop: &str, route: &mut Route) {
    let fields: Vec<&str> = hop.split_whitespace().collect();
    let mut i = 0;
    while i < fields.len() {
        match fields[i] {
            "to" => {
                if let Some(address) = fields.get(i + 1) {
                    let address = address.trim_end_matches(',');
                    if address.parse::<IpAddr>().is_ok()
                        && !route.next_hops.iter().any(|h| h == address)
                    {
                        route.next_hops.push(address.to_string());
                    }
                }
                i += 2;
            }
            "via" => {
                if let Some(iface) = fields.get(i + 1) {
                    if route.interface.is_none() {
                        route.interface = Some(iface.trim_end_matches(',').to_string());
                    }
                }
                i += 2;
            }
            _ => i += 1,
        }
    }
}

/// `OSPF` → `ospf`; `Direct` is what Junos calls a connected route.
fn junos_protocol(code: &str) -> &'static str {
    match code.to_ascii_lowercase().as_str() {
        "direct" => "connected",
        "local" => "local",
        "static" => "static",
        "ospf" | "ospf3" => "ospf",
        "bgp" => "bgp",
        "isis" => "isis",
        "rip" | "ripng" => "rip",
        "access" | "access-internal" => "access",
        "aggregate" => "aggregate",
        "evpn" => "evpn",
        _ => "other",
    }
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
    /// `show ip route`; the addresses are the lab's, renumbered.
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

    /// From a 267-route table in the lab of which this parser read 17.
    /// Where several subnets of one classful network share a mask, IOS puts
    /// the mask on a header line and leaves every row beneath it bare.
    #[test]
    fn a_classful_subnetted_block_keeps_its_mask() {
        let out = "\
Gateway of last resort is not set

      172.16.0.0/16 is variably subnetted, 2 subnets, 2 masks
C        172.16.1.0/24 is directly connected, Ethernet0/0
O        172.16.255.45/32 [110/31] via 172.16.13.2, 00:00:52, Ethernet0/2
      172.20.0.0/24 is subnetted, 3 subnets
O E2     172.20.0.0 [110/20] via 172.16.13.2, 00:00:52, Ethernet0/2
                    [110/20] via 172.16.12.2, 00:00:52, Ethernet0/1
O E2     172.20.1.0 [110/20] via 172.16.13.2, 00:00:52, Ethernet0/2
O E2     172.20.2.0 [110/20] via 172.16.13.2, 00:00:52, Ethernet0/2
";
        let r = parse_routes(out);
        let prefixes: Vec<&str> = r.iter().map(|x| x.prefix.as_str()).collect();
        assert_eq!(
            prefixes,
            vec![
                "172.16.1.0/24",
                "172.16.255.45/32",
                "172.20.0.0/24",
                "172.20.1.0/24",
                "172.20.2.0/24"
            ],
            "{prefixes:?}"
        );
        // The mask came from the header, and the row's own path is still read.
        let first = r.iter().find(|x| x.prefix == "172.20.0.0/24").expect("the first bare row");
        assert_eq!(first.protocol, "ospf");
        assert_eq!(first.next_hops, vec!["172.16.13.2", "172.16.12.2"]);
    }

    /// From the lab on 2026-09-20: an IOS IPv6 table where the
    /// router's own loopback is written `LC`. Every such row was reported as
    /// protocol `other`, which is the word the parser reaches for when it did
    /// not recognise the code at all.
    #[test]
    fn the_ipv6_local_connected_code_is_not_a_mystery() {
        let out = "\
IPv6 Routing Table - default - 3 entries
LC  2001:DB8:255::41/128 [0/0]
     via Loopback0, receive
O   2001:DB8:255::42/128 [110/10]
     via FE80::A8BB:CCFF:FE00:2010, Ethernet0/1
";
        let r = parse_routes(out);
        assert_eq!(r.len(), 2, "{r:?}");
        assert_eq!(r[0].protocol, "local", "{:?}", r[0]);
        assert_eq!(r[1].protocol, "ospf");
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

    /// **The shape a Nexus leaf printed** on 2026-09-20 for
    /// `show ip route vrf <tenant>`, retyped with documentation addresses and
    /// an invented VRF name. Not a variation on the IOS table: the
    /// prefix is on its own line, the paths are indented under it, and the
    /// protocol is named on the path rather than coded in the first column.
    const NXOS_V4: &str = "\
IP Route Table for VRF \"CORP\"\n\
'*' denotes best ucast next-hop\n\
'[x/y]' denotes [preference/metric]\n\
'%<string>' in via output denotes VRF <string>\n\
\n\
0.0.0.0/0, ubest/mbest: 2/0\n\
    *via 192.0.2.68, Eth1/39, [110/144], 10w6d, ospf-CORP, type-1, tag 2\n\
    *via 192.0.2.72, Eth1/40, [110/144], 10w6d, ospf-CORP, type-1, tag 2\n\
192.0.2.68/31, ubest/mbest: 1/0, attached\n\
    *via 192.0.2.69, Eth1/39, [0/0], 12w0d, direct\n\
--More--192.0.2.69/32, ubest/mbest: 1/0, attached\n\
    *via 192.0.2.69, Eth1/39, [0/0], 12w0d, local\n\
198.51.100.52/32, ubest/mbest: 1/0\n\
    *via 203.0.113.4%default, [200/2000], 41w0d, bgp-65000, internal, tag 65000, segid: 50000 tunnelid: 0xcb007104 encap: VXLAN\n";

    #[test]
    fn reads_the_nexus_table_where_the_prefix_is_on_its_own_line() {
        let r = parse_nxos_routes(NXOS_V4);
        assert_eq!(r.len(), 4, "{r:?}");
        assert_eq!(r[0].prefix, "0.0.0.0/0");
        assert!(r[0].is_default());
        assert_eq!(r[0].protocol, "ospf");
        assert_eq!(r[0].code, "ospf-CORP");
        assert_eq!(r[0].distance, Some(110));
        assert_eq!(r[0].metric, Some(144));
    }

    #[test]
    fn the_nexus_table_is_recognised_without_being_told_the_platform() {
        // `parse_routes` is what every caller already uses; a Nexus answering
        // it read as zero routes until this.
        assert_eq!(parse_routes(NXOS_V4).len(), 4);
    }

    #[test]
    fn both_paths_of_an_equal_cost_pair_are_kept() {
        // Two `*via` lines under one prefix are ECMP, and dropping one of
        // them is how the path engine stops seeing a second way round.
        let r = parse_nxos_routes(NXOS_V4);
        assert_eq!(r[0].next_hops, ["192.0.2.68", "192.0.2.72"]);
    }

    #[test]
    fn direct_is_what_the_nexus_calls_connected() {
        let r = parse_nxos_routes(NXOS_V4);
        let attached = r.iter().find(|x| x.prefix == "192.0.2.68/31").unwrap();
        assert_eq!(attached.protocol, "connected");
        assert_eq!(attached.interface.as_deref(), Some("Eth1/39"));
        assert_eq!(connected_prefixes(&r), ["192.0.2.68/31"]);
    }

    #[test]
    fn a_row_the_pager_stuck_more_on_to_is_still_a_route() {
        let r = parse_nxos_routes(NXOS_V4);
        assert!(r.iter().any(|x| x.prefix == "192.0.2.69/32"), "{r:?}");
    }

    #[test]
    fn an_overlay_route_says_which_table_its_next_hop_lives_in() {
        // The whole point of reading this table at all. `%default` means the
        // VTEP address is in the underlay, not in this tenant's table —
        // resolving it here finds nothing — and `segid` says the path crosses
        // VNI 50000, which `show nve vni` maps back to a VRF.
        let r = parse_nxos_routes(NXOS_V4);
        let overlay = r.iter().find(|x| x.prefix == "198.51.100.52/32").unwrap();
        assert_eq!(overlay.next_hops, ["203.0.113.4"]);
        assert_eq!(overlay.next_hop_vrf.as_deref(), Some("default"));
        assert_eq!(overlay.segment_id, Some(50000));
        assert_eq!(overlay.protocol, "bgp");
        assert_eq!(overlay.interface, None);
    }

    #[test]
    fn an_ios_table_is_still_read_the_ios_way() {
        // The Nexus branch is picked by shape, so the captured IOS output
        // must not fall into it.
        assert!(!IOS_V4.contains("ubest"));
        assert!(!parse_routes(IOS_V4).is_empty());
    }

    /// **From Juniper's `show route` documentation, not captured**.
    const JUNOS: &str = "\
CORP.inet.0: 4 destinations, 5 routes (4 active, 0 holddown, 0 hidden)\n\
+ = Active Route, - = Last Active, * = Both\n\
\n\
0.0.0.0/0          *[Static/5] 3w1d\n\
                    > to 192.0.2.1 via ge-0/0/0.0\n\
192.0.2.0/30       *[Direct/0] 3w1d\n\
                    > via ge-0/0/0.0\n\
203.0.113.0/24     *[OSPF/10] 1d 02:11:33, metric 2\n\
                    > to 192.0.2.2 via ge-0/0/0.0\n\
                      to 192.0.2.6 via ge-0/0/1.0\n\
198.51.100.0/24    *[BGP/170] 00:10:00, localpref 100, from 192.0.2.2\n\
                      AS path: 65000 I, validation-state: unverified\n\
                    > to 192.0.2.2 via ge-0/0/0.0\n";

    #[test]
    fn reads_the_junos_table_where_the_paths_are_under_the_prefix() {
        let r = parse_junos_routes(JUNOS);
        assert_eq!(r.len(), 4, "{r:?}");
        assert_eq!(r[0].prefix, "0.0.0.0/0");
        assert_eq!(r[0].protocol, "static");
        assert_eq!(r[0].distance, Some(5));
        assert_eq!(r[0].next_hops, ["192.0.2.1"]);
        assert_eq!(r[0].interface.as_deref(), Some("ge-0/0/0.0"));
    }

    #[test]
    fn junos_calls_a_connected_route_direct() {
        let r = parse_junos_routes(JUNOS);
        let direct = r.iter().find(|x| x.prefix == "192.0.2.0/30").unwrap();
        assert_eq!(direct.protocol, "connected");
        assert!(direct.next_hops.is_empty(), "a connected route goes nowhere");
        assert_eq!(direct.interface.as_deref(), Some("ge-0/0/0.0"));
    }

    #[test]
    fn junos_ecmp_is_two_to_lines_under_one_prefix() {
        let r = parse_junos_routes(JUNOS);
        let ospf = r.iter().find(|x| x.prefix == "203.0.113.0/24").unwrap();
        assert_eq!(ospf.next_hops, ["192.0.2.2", "192.0.2.6"]);
        assert_eq!(ospf.metric, Some(2));
        assert_eq!(ospf.distance, Some(10));
    }

    #[test]
    fn a_junos_annotation_is_not_a_next_hop() {
        // "AS path: 65000 I" has a number in it and is not a route.
        let r = parse_junos_routes(JUNOS);
        let bgp = r.iter().find(|x| x.prefix == "198.51.100.0/24").unwrap();
        assert_eq!(bgp.next_hops, ["192.0.2.2"]);
    }

    #[test]
    fn the_junos_table_is_recognised_without_being_told_the_platform() {
        assert_eq!(parse_routes(JUNOS).len(), 4);
    }

    /// **From Fortinet's documentation, not captured**. The rows are
    /// the IOS shape; only the per-VDOM header is new.
    const FORTIOS: &str = "\
Routing table for VRF=0\n\
Codes: K - kernel, C - connected, S - static, B - BGP, O - OSPF\n\
\n\
S*      0.0.0.0/0 [10/0] via 192.0.2.1, port1\n\
C       192.0.2.0/24 is directly connected, port1\n\
O       203.0.113.0/24 [110/20] via 192.0.2.2, port1, 00:10:00\n";

    #[test]
    fn the_fortios_table_is_the_ios_one_under_a_different_header() {
        let r = parse_routes(FORTIOS);
        assert_eq!(r.len(), 3, "{r:?}");
        assert!(r[0].is_default());
        assert_eq!(r[0].next_hops, ["192.0.2.1"]);
        assert_eq!(r[1].protocol, "connected");
        assert_eq!(r[2].distance, Some(110));
        // The VDOM header is not a route.
        assert!(!r.iter().any(|x| x.prefix.contains("VRF")));
    }
}
