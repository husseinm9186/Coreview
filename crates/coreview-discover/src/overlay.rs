//! VXLAN and EVPN: VTEPs, VNIs and where a segment is stretched to (LT-347).
//!
//! **These parsers were written from vendor documentation, not from captured
//! device output.** That inverts this project's standing rule (`CLAUDE.md`),
//! deliberately and at the operator's instruction — the exception D-026 made
//! for stacking, extended by **D-051**. He has no VXLAN fabric to hand and
//! asked for this to be built so that he can test it when he does.
//!
//! Every parser here is a **hypothesis** until it has met hardware.
//! `verified_against_hardware` says which have;
//! `examples/probe_overlay.rs` prints what a device actually answered beside
//! what the parser made of it, which is how a hypothesis becomes a fact.
//!
//! # What this is for
//!
//! The path engine (LT-346/LT-348) already models an overlay properly: an
//! address inside a VNI that a remote VTEP carries is **one bridged hop across
//! a tunnel**, and the underlay carrying it is traced separately so the spines
//! stay visible. What it has never had is anything to fill `vtep` in from.
//! This fills it.
//!
//! Three things are needed and no more:
//!
//! 1. **This device's VTEP address** — the source of the tunnel.
//! 2. **Which VNIs it carries, and the VLAN each maps to.**
//! 3. **Which remote VTEPs share those VNIs** — the far ends.
//!
//! EVPN type-2 (a MAC/IP in a segment) and type-5 (a prefix) are read where
//! the device prints them, because they say *which* addresses are behind a
//! remote VTEP rather than only that the VNI is shared.

use crate::arp::normalise_mac;

/// Which command set a fabric answers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayDialect {
    /// Cisco NX-OS: `show nve vni`, `show nve peers`, `show bgp l2vpn evpn`.
    NxOs,
    /// Arista EOS: `show vxlan vni`, `show vxlan vtep`.
    Arista,
    /// Junos: `show ethernet-switching vxlan-tunnel-end-point remote`.
    Junos,
}

impl OverlayDialect {
    /// Whether any parser for this dialect has been run against real hardware.
    ///
    /// **The honest field.** Flip a value only after seeing it work on a
    /// device, and name the device in the commit — not because the tests pass,
    /// because the tests are built from the same documentation the parser is.
    pub fn verified_against_hardware(&self) -> bool {
        match self {
            // A Nexus leaf and a Nexus spine in a live VXLAN/EVPN fabric,
            // 2026-09-20, answered `show nve vni`, `show nve peers`,
            // `show nve interface nve1 detail` and `show bgp l2vpn evpn`.
            // Three of the four parsers were wrong before they did.
            OverlayDialect::NxOs => true,
            // Still hypotheses: nothing has answered these.
            OverlayDialect::Arista | OverlayDialect::Junos => false,
        }
    }

    /// The commands worth asking, in order, for this dialect.
    pub fn commands(&self) -> &'static [&'static str] {
        match self {
            OverlayDialect::NxOs => &["show nve vni", "show nve peers", "show bgp l2vpn evpn"],
            OverlayDialect::Arista => &["show vxlan vni", "show vxlan vtep", "show bgp evpn"],
            OverlayDialect::Junos => &[
                "show ethernet-switching vxlan-tunnel-end-point remote",
                "show route table bgp.evpn.0",
            ],
        }
    }
}

/// The command that names the interface a VTEP sources tunnels from.
///
/// The VTEP address is a property the device states — `source-interface
/// loopback1` — rather than something to be guessed from the loopbacks it
/// happens to have.
pub const SOURCE_COMMAND: &str = "show nve interface nve1 detail";

/// Which dialect a device's version banner says it speaks.
pub fn dialect_for(version: &str) -> OverlayDialect {
    let v = version.to_ascii_lowercase();
    if v.contains("junos") {
        OverlayDialect::Junos
    } else if v.contains("arista") || v.contains(" eos") {
        OverlayDialect::Arista
    } else {
        OverlayDialect::NxOs
    }
}

/// The VTEP's source address.
///
/// **Shape, from the vendor guides** (D-051):
///
/// ```text
/// NX-OS — `show nve interface nve1 detail`
/// Interface: nve1, State: Up, encapsulation: VXLAN
///  Source-Interface: loopback1 (primary: 10.255.0.1, secondary: 0.0.0.0)
/// ```
///
/// The *primary* is the address; the secondary is the anycast address a vPC
/// pair shares and is not this device on its own.
pub fn parse_source_interface(out: &str) -> Option<String> {
    for line in out.lines() {
        let t = line.trim();
        if !t.to_ascii_lowercase().contains("source-interface") {
            continue;
        }
        // `(primary: 10.255.0.1, secondary: 0.0.0.0)`
        if let Some(at) = t.to_ascii_lowercase().find("primary:") {
            let rest = &t[at + "primary:".len()..];
            let candidate = rest
                .trim_start()
                .split(|c: char| c == ',' || c == ')' || c.is_whitespace())
                .find(|p| !p.is_empty());
            if let Some(ip) = candidate.filter(|ip| is_ipv4(ip) && *ip != "0.0.0.0") {
                return Some(ip.to_string());
            }
        }
        // Anything else on the line that is an address.
        if let Some(ip) = t.split_whitespace().find(|f| is_ipv4(f) && **f != *"0.0.0.0") {
            return Some(ip.trim_matches(|c: char| !c.is_ascii_digit() && c != '.').to_string());
        }
    }
    None
}

/// One segment this device carries.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub vni: u32,
    /// The VLAN it maps to locally, where the device said.
    pub vlan: Option<u32>,
    /// `L2` or `L3` — a bridged segment or a routed one.
    pub kind: Option<String>,
    /// The VRF a routed segment carries, from `L3 [CORP]`.
    ///
    /// This is the join between the two halves of the overlay: a tenant route
    /// whose next hop crosses `segid: 50000` is in whichever VRF the L3 VNI
    /// 50000 belongs to. Without it that number is just a number.
    pub vrf: Option<String>,
}

/// What this device is, as a tunnel endpoint.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overlay {
    /// The source address other VTEPs tunnel to.
    pub vtep: Option<String>,
    pub segments: Vec<Segment>,
    /// Far-end VTEPs, and which VNIs each carries where that was printed.
    pub peers: Vec<Peer>,
    /// Addresses learned behind a remote VTEP, from EVPN.
    pub learned: Vec<EvpnRoute>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub address: String,
    /// `Up`, `Down` — as printed.
    pub state: Option<String>,
    pub vnis: Vec<u32>,
}

/// One EVPN route. Type 2 is a host; type 5 is a prefix.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvpnRoute {
    pub route_type: u8,
    pub vni: Option<u32>,
    /// Twelve lowercase hex digits, for a type 2.
    pub mac: Option<String>,
    /// The host address on a type 2, or the prefix on a type 5.
    pub address: Option<String>,
    /// The VTEP it is behind.
    pub next_hop: Option<String>,
}

/// The VNIs a device carries.
///
/// **Shape, from the vendor guides** (D-051):
///
/// ```text
/// NX-OS — `show nve vni` (captured from a Nexus leaf, 2026-09-20)
/// Interface VNI      Multicast-group   State Mode Type [BD/VRF]      Flags
/// --------- -------- ----------------- ----- ---- ------------------ -----
/// nve1      10100    UnicastBGP        Up    CP   L2 [100]
/// nve1      50000    n/a               Up    CP   L3 [CORP]
///
/// A legend of flag codes is printed above the heading, a row of dashes below
/// it, and a pager may glue `--More--` to the front of a row. None of the
/// three carries a standalone number, so none of them becomes a segment.
///
/// Arista — `show vxlan vni`
/// VNI to VLAN Mapping for Vxlan1
/// VNI         VLAN       Source       Interface
/// 10100       100        static       Vxlan1
/// ```
pub fn parse_vni_table(out: &str) -> Vec<Segment> {
    let mut found = Vec::new();
    for line in out.lines() {
        let t = strip_more(line).trim();
        if t.is_empty() || t.to_ascii_lowercase().starts_with("interface vni") {
            continue;
        }
        // `...skipping 1 line` is the pager talking, and the 1 in it would
        // otherwise be read as VNI 1.
        if t.starts_with("...") || t.contains("skipping") {
            continue;
        }
        let fields: Vec<&str> = t.split_whitespace().collect();
        // The VNI is the first standalone number of five digits or so. Taking
        // "the second column" breaks the moment a platform adds one.
        let Some(vni) = fields.iter().find_map(|f| f.parse::<u32>().ok().filter(|v| *v > 0)) else {
            continue;
        };
        // `L2 [100]` on NX-OS; a bare VLAN column on Arista.
        let kind = fields
            .iter()
            .find(|f| f.eq_ignore_ascii_case("L2") || f.eq_ignore_ascii_case("L3"))
            .map(|f| f.to_ascii_uppercase());
        let vlan = bracketed_number(t).or_else(|| {
            // Arista: VNI then VLAN, both plain numbers.
            fields
                .iter()
                .filter_map(|f| f.parse::<u32>().ok())
                .nth(1)
                .filter(|v| *v > 0 && *v < 4096)
        });
        let vrf = kind
            .as_deref()
            .filter(|k| *k == "L3")
            .and_then(|_| bracketed(t))
            .filter(|v| v.parse::<u32>().is_err());
        found.push(Segment { vni, vlan, kind, vrf });
    }
    found
}

/// Removes a `--More--` a pager glued to the front of a row.
fn strip_more(line: &str) -> &str {
    let mut rest = line;
    while let Some(after) = rest.trim_start().strip_prefix("--More--") {
        rest = after;
    }
    rest
}

/// `L3 [CORP]` → `CORP`.
fn bracketed(line: &str) -> Option<String> {
    let start = line.find('[')?;
    let end = line[start..].find(']')? + start;
    Some(line[start + 1..end].trim().to_string())
}

/// `L2 [100]` → 100. `[CORP]` is a VRF name, not a VLAN, and yields nothing.
fn bracketed_number(line: &str) -> Option<u32> {
    let start = line.find('[')?;
    let end = line[start..].find(']')? + start;
    line[start + 1..end].trim().parse::<u32>().ok()
}

/// The far-end VTEPs.
///
/// **Shape, from the vendor guides** (D-051):
///
/// ```text
/// NX-OS — `show nve peers`
/// Interface Peer-IP          State LearnType Uptime   Router-Mac
/// nve1      10.255.0.4       Up    CP        01:02:03 5254.0012.3456
///
/// Arista — `show vxlan vtep`
/// Remote VTEPS for Vxlan1:
/// 10.255.0.4
/// ```
pub fn parse_peers(out: &str) -> Vec<Peer> {
    let mut found = Vec::new();
    // Junos prints this device's own VTEP (`SVTEP-IP`) above the remote ones
    // (`RVTEP-IP`), so reading every address on the page would list the
    // device as a peer of itself (LT-352).
    let remote_only = out.contains("RVTEP-IP");
    let mut reached_remote = false;
    for line in out.lines() {
        if remote_only {
            if line.contains("RVTEP-IP") {
                reached_remote = true;
                continue;
            }
            if !reached_remote {
                continue;
            }
        }
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let lower = t.to_ascii_lowercase();
        if lower.starts_with("interface") || lower.starts_with("remote vteps") || lower.starts_with("total") {
            continue;
        }
        let fields: Vec<&str> = t.split_whitespace().collect();
        let Some(address) = fields.iter().find(|f| is_ipv4(f)) else { continue };
        let state = fields
            .iter()
            .find(|f| f.eq_ignore_ascii_case("Up") || f.eq_ignore_ascii_case("Down"))
            .map(|f| {
                let mut c = f.chars();
                match c.next() {
                    Some(first) => first.to_ascii_uppercase().to_string() + &c.as_str().to_ascii_lowercase(),
                    None => String::new(),
                }
            });
        found.push(Peer { address: address.to_string(), state, vnis: Vec::new() });
    }
    found
}

fn is_ipv4(token: &str) -> bool {
    token.parse::<std::net::Ipv4Addr>().is_ok()
}

/// EVPN routes, which say *what* is behind each remote VTEP.
///
/// **Shape, from the vendor guides** (D-051). NX-OS and EOS both print the
/// route distinguisher and then an indented prefix line:
///
/// ```text
///    Network            Next Hop            Metric     LocPrf     Weight Path
/// Route Distinguisher: 65000:10100
/// *>i[2]:[0]:[0]:[48]:[5254.0012.3456]:[32]:[10.100.0.20]/272
///                       10.255.0.4                        100          0 i
/// *>i[5]:[0]:[0]:[24]:[10.40.50.0]:[0.0.0.0]/224
///                       10.255.0.4                        100          0 i
/// ```
///
/// The bracketed form is the whole point: `[2]` is a host in a segment and
/// `[5]` is a prefix, and drawing one as the other is the mistake this exists
/// to avoid.
pub fn parse_evpn(out: &str) -> Vec<EvpnRoute> {
    // Three platforms, three ways of writing the same route (LT-352). NX-OS
    // brackets every field, Arista names the route type in words, and Junos
    // writes the whole NLRI as one colon-separated string. Told apart by
    // shape rather than by asking the caller what the platform was.
    if out.contains("mac-ip") || out.contains("ip-prefix") || out.contains("RD: ") {
        return parse_evpn_arista(out);
    }
    if out.contains(" destinations, ") && out.contains(" routes (") {
        return parse_evpn_junos(out);
    }
    let mut found: Vec<EvpnRoute> = Vec::new();
    let mut pending: Option<EvpnRoute> = None;

    for line in out.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }

        // A next-hop continuation for the route above.
        if let Some(mut route) = pending.take() {
            if !t.starts_with('*') && !t.starts_with('[') {
                route.next_hop = t.split_whitespace().find(|f| is_ipv4(f)).map(str::to_string);
                found.push(route);
                continue;
            }
            // No continuation after all — keep what was read.
            found.push(route);
        }

        let Some(open) = t.find('[') else { continue };
        let body = &t[open..];
        let parts = bracket_parts(body);
        let Some(route_type) = parts.first().and_then(|p| p.parse::<u8>().ok()) else { continue };
        if route_type != 2 && route_type != 5 {
            continue;
        }

        let mac = parts.iter().find_map(|p| normalise_mac(p));
        // The last bracketed address is the host on a type 2 and the prefix on
        // a type 5; the `/272` or `/224` at the end is the NLRI length and is
        // not a mask anyone wants to see.
        let addresses: Vec<&String> = parts.iter().filter(|p| is_ipv4(p)).collect();
        let address = match route_type {
            5 => {
                // The mask is the field immediately before the prefix —
                // `[24]:[10.40.50.0]`. Taking "the first number under 33"
                // finds the route type itself, which produced a confident
                // `10.40.50.0/5`.
                let at = parts.iter().position(|p| is_ipv4(p));
                let mask = at
                    .and_then(|i| i.checked_sub(1))
                    .and_then(|i| parts.get(i))
                    .and_then(|p| p.parse::<u32>().ok())
                    .filter(|n| *n <= 32)
                    .unwrap_or(32);
                addresses.first().map(|a| format!("{a}/{mask}"))
            }
            // A MAC-only type 2 is written `…:[0]:[0.0.0.0]/216` — the
            // length is 0 and the address is the placeholder that means
            // "none". Reporting 0.0.0.0 as where a host lives is worse than
            // reporting nothing, because it looks like an answer.
            _ => addresses.last().map(|a| a.to_string()).filter(|a| a != "0.0.0.0"),
        };
        // Some platforms print the VNI in the route distinguisher above; where
        // it is on the line, take it.
        let vni = parts.iter().filter_map(|p| p.parse::<u32>().ok()).find(|n| *n > 4096);
        pending = Some(EvpnRoute { route_type, vni, mac, address, next_hop: None });
    }
    if let Some(route) = pending {
        found.push(route);
    }
    found
}

/// Arista's EVPN table, which names the route type in words (LT-352).
///
/// **Built from Arista's `show bgp evpn` documentation** (D-051), unverified.
///
/// ```text
///           Network                Next Hop        Metric  LocPref Weight Path
///  * >      RD: 65000:10100 mac-ip 5254.0012.3456 192.0.2.20
///                                  198.51.100.4    -       100     0      i
///  * >      RD: 65000:50000 ip-prefix 192.0.2.0/24
///                                  198.51.100.5    -       100     0      i
/// ```
///
/// `mac-ip` is a type 2 and `ip-prefix` a type 5; `imet` is type 3 and says
/// nothing about where a host is, so it is skipped the same way NX-OS's
/// `[3]` is.
pub fn parse_evpn_arista(out: &str) -> Vec<EvpnRoute> {
    let mut found: Vec<EvpnRoute> = Vec::new();
    let mut pending: Option<EvpnRoute> = None;

    for line in out.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        // The next hop for the route above sits on its own line.
        if !t.contains("RD:") {
            if let Some(mut route) = pending.take() {
                route.next_hop = t.split_whitespace().find(|f| is_ipv4(f)).map(str::to_string);
                found.push(route);
            }
            continue;
        }
        if let Some(route) = pending.take() {
            found.push(route);
        }

        let fields: Vec<&str> = t.split_whitespace().collect();
        let Some(at) = fields.iter().position(|f| *f == "RD:") else { continue };
        // The VNI is the right half of the route distinguisher where Arista
        // put one there; it is a convention, not a guarantee, so a value that
        // is not a number yields nothing rather than a wrong number.
        let vni = fields
            .get(at + 1)
            .and_then(|rd| rd.split_once(':'))
            .and_then(|(_, right)| right.parse::<u32>().ok());
        let kind = fields.get(at + 2).copied().unwrap_or("");
        let rest = &fields[(at + 3).min(fields.len())..];
        let route = match kind {
            "mac-ip" => EvpnRoute {
                route_type: 2,
                vni,
                mac: rest.first().and_then(|m| normalise_mac(m)),
                address: rest.iter().find(|f| is_ipv4(f)).map(|a| a.to_string()),
                next_hop: None,
            },
            "ip-prefix" => EvpnRoute {
                route_type: 5,
                vni,
                mac: None,
                address: rest.first().map(|p| p.to_string()),
                next_hop: None,
            },
            // imet, ethernet-segment and the rest place no address anywhere.
            _ => continue,
        };
        pending = Some(route);
    }
    if let Some(route) = pending {
        found.push(route);
    }
    found
}

/// Junos's EVPN table, where the whole NLRI is one string (LT-352).
///
/// **Built from Juniper's `show route table bgp.evpn.0` documentation**
/// (D-051), unverified.
///
/// ```text
/// bgp.evpn.0: 24 destinations, 24 routes (24 active, 0 holddown, 0 hidden)
///
/// 2:198.51.100.4:1::0::52:54:00:12:34:56/304 MAC/IP
///                    *[BGP/170] 00:10:00, localpref 100, from 198.51.100.4
///                     > to 192.0.2.2 via ge-0/0/0.0
/// 5:198.51.100.5:1::0::192.0.2.0::24/248
///                    *[BGP/170] 00:10:00, localpref 100, from 198.51.100.5
/// ```
///
/// The leading number is the route type, and `from <address>` is the VTEP the
/// route came from — which is the thing the path engine needs. `to … via …`
/// is the underlay hop and is **not** the VTEP, so it is deliberately not
/// read as one.
pub fn parse_evpn_junos(out: &str) -> Vec<EvpnRoute> {
    let mut found: Vec<EvpnRoute> = Vec::new();
    let mut pending: Option<EvpnRoute> = None;

    for line in out.lines() {
        let t = line.trim();
        if t.is_empty() || t.contains(" destinations, ") || t.starts_with('+') {
            continue;
        }
        // `from 198.51.100.4` on the route's own attribute line names the
        // VTEP that advertised it.
        if t.starts_with('*') || t.starts_with('[') || t.contains("localpref") {
            if let Some(route) = pending.as_mut() {
                if route.next_hop.is_none() {
                    route.next_hop = t
                        .split_whitespace()
                        .skip_while(|f| *f != "from")
                        .nth(1)
                        .map(|a| a.trim_end_matches(','))
                        .filter(|a| is_ipv4(a))
                        .map(str::to_string);
                }
            }
            continue;
        }
        if t.starts_with("to ") || t.starts_with("> ") || t.starts_with("via ") || t.starts_with("AS path:") {
            continue;
        }

        // An NLRI: `<type>:<rd>:<...>/<length>`.
        let nlri = t.split_whitespace().next().unwrap_or("");
        let Some((head, _)) = nlri.split_once('/') else { continue };
        let Some(route_type) = head.split(':').next().and_then(|n| n.parse::<u8>().ok()) else {
            continue;
        };
        if route_type != 2 && route_type != 5 {
            continue;
        }
        if let Some(route) = pending.take() {
            found.push(route);
        }
        // The fields after the `::` separators. A type 2 carries a MAC and
        // possibly a host address; a type 5 a prefix and its length.
        let parts: Vec<&str> = head.split("::").collect();
        let (mac, address) = match route_type {
            2 => {
                let tail = parts.last().copied().unwrap_or("");
                let mac = normalise_mac(tail).or_else(|| {
                    tail.rsplit_once("::").and_then(|(_, m)| normalise_mac(m))
                });
                // A MAC-and-IP route appends the address after the MAC.
                let address = head.split(':').find(|f| is_ipv4(f) && *f != "0.0.0.0");
                (mac, address.map(str::to_string))
            }
            _ => {
                // `…::192.0.2.0::24/248` — prefix then length.
                let network = parts.iter().rev().nth(1).copied().unwrap_or("");
                let length = parts.last().copied().unwrap_or("");
                let address = match (is_ipv4(network), length.parse::<u32>().ok()) {
                    (true, Some(bits)) if bits <= 32 => Some(format!("{network}/{bits}")),
                    (true, _) => Some(network.to_string()),
                    _ => None,
                };
                (None, address)
            }
        };
        pending = Some(EvpnRoute { route_type, vni: None, mac, address, next_hop: None });
    }
    if let Some(route) = pending {
        found.push(route);
    }
    found
}

/// `[2]:[0]:[48]:[5254.0012.3456]:[32]:[10.100.0.20]/272` → the pieces.
fn bracket_parts(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(open) = rest.find('[') {
        let Some(close) = rest[open..].find(']') else { break };
        out.push(rest[open + 1..open + close].trim().to_string());
        rest = &rest[open + close + 1..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **The shape a Nexus leaf printed** on 2026-09-20, retyped: invented
    /// VNIs, VLANs and VRF names, documentation addresses (D-027). The
    /// operator's capture never left his machine and nothing in it is
    /// reproduced — what is kept is the layout, which is the part the parser
    /// has to survive: a legend above the heading, a row of dashes below it,
    /// `UnicastBGP` where the guide shows `n/a`, a pager glued to the front
    /// of a row, and a routed VNI whose bracket holds a VRF.
    const NVE_VNI: &str = r#"
Codes: CP - Control Plane        DP - Data Plane
       UC - Unconfigured         SA - Suppress ARP
       MS-IR - Multisite Ingress Replication

Interface VNI      Multicast-group   State Mode Type [BD/VRF]      Flags
--------- -------- ----------------- ----- ---- ------------------ -----
nve1      10100    UnicastBGP        Up    CP   L2 [100]
--More--nve1      10200    UnicastBGP        Up    CP   L2 [200]
nve1      50000    n/a               Up    CP   L3 [CORP]
"#;

    /// The shape a Nexus leaf printed, retyped the same way. A peer that has
    /// not advertised a router MAC prints `n/a` there.
    const NVE_PEERS: &str = r#"
Interface Peer-IP                                 State LearnType Uptime   Router-Mac
--------- --------------------------------------  ----- --------- -------- ----------
nve1      198.51.100.4                            Up    CP        1y29w    5254.0012.3456
nve1      198.51.100.5                            Up    CP        1y29w    n/a
"#;

    /// The shape a Nexus leaf printed, retyped. Two things here are not in
    /// the guide and both were wrong until a device showed them: a type 2
    /// that carries only a MAC writes its address as `[0]:[0.0.0.0]`, and a
    /// type 5 written without the `[0.0.0.0]` tail still has its mask in the
    /// field before the prefix.
    const EVPN: &str = r#"
   Network            Next Hop            Metric     LocPrf     Weight Path
Route Distinguisher: 65000:10100
*>i[2]:[0]:[0]:[48]:[5254.0012.3456]:[32]:[192.0.2.20]/272
                      198.51.100.4          2000        100          0 65000 i
*>i[2]:[0]:[0]:[48]:[5254.0012.7890]:[0]:[0.0.0.0]/216
                      198.51.100.4          2000        100          0 65000 i
* i[5]:[0]:[0]:[24]:[192.0.2.0]/224
                      198.51.100.5             1        100          0 65000 ?
"#;

    #[test]
    fn reads_the_vnis_and_the_vlan_each_maps_to() {
        let s = parse_vni_table(NVE_VNI);
        assert_eq!(s.len(), 3, "{s:?}");
        assert_eq!(
            s[0],
            Segment { vni: 10100, vlan: Some(100), kind: Some("L2".into()), vrf: None }
        );
        // The legend above the heading and the row of dashes below it are not
        // segments, and neither is the row a pager stuck `--More--` on to.
        assert_eq!(s[1].vni, 10200);
    }

    #[test]
    fn a_routed_segment_has_no_vlan_because_a_vrf_name_is_not_one() {
        // `L3 [CORP]` — the bracket holds a VRF, and reading it as a VLAN
        // would put a nonsense number on a diagram.
        let s = parse_vni_table(NVE_VNI);
        let l3 = s.iter().find(|x| x.vni == 50000).unwrap();
        assert_eq!(l3.vlan, None);
        assert_eq!(l3.kind.as_deref(), Some("L3"));
        // It is not nothing, though: it is the VRF, and it is what joins a
        // tenant route's `segid` back to a table with a name.
        assert_eq!(l3.vrf.as_deref(), Some("CORP"));
    }

    #[test]
    fn reads_the_remote_vteps_and_their_state() {
        let p = parse_peers(NVE_PEERS);
        assert_eq!(p.len(), 2, "{p:?}");
        assert_eq!(p[0].address, "198.51.100.4");
        assert_eq!(p[0].state.as_deref(), Some("Up"));
    }

    #[test]
    fn the_heading_is_not_a_peer() {
        assert!(parse_peers("Interface Peer-IP          State LearnType Uptime").is_empty());
        assert!(parse_peers("").is_empty());
    }

    #[test]
    fn tells_a_host_route_from_a_prefix_route() {
        // Type 2 is a MAC and an address in a segment; type 5 is a prefix.
        // Drawing one as the other is the mistake this exists to avoid.
        let r = parse_evpn(EVPN);
        assert_eq!(r.len(), 3, "{r:?}");
        assert_eq!(r[0].route_type, 2);
        assert_eq!(r[0].mac.as_deref(), Some("525400123456"));
        assert_eq!(r[0].address.as_deref(), Some("192.0.2.20"));
        assert_eq!(r[2].route_type, 5);
        assert_eq!(r[2].address.as_deref(), Some("192.0.2.0/24"));
        assert_eq!(r[2].mac, None);
    }

    #[test]
    fn a_mac_only_host_has_no_address_rather_than_the_placeholder_one() {
        // `[0]:[0.0.0.0]` is the device saying it knows the MAC and not the
        // address. Repeating 0.0.0.0 back looks like an answer.
        let r = parse_evpn(EVPN);
        assert_eq!(r[1].mac.as_deref(), Some("525400127890"));
        assert_eq!(r[1].address, None);
    }

    #[test]
    fn takes_the_next_hop_from_the_continuation_line() {
        // The VTEP an address is behind is on the *next* line, which is what a
        // line-at-a-time parser gets wrong.
        let r = parse_evpn(EVPN);
        assert_eq!(r[0].next_hop.as_deref(), Some("198.51.100.4"));
        assert_eq!(r[2].next_hop.as_deref(), Some("198.51.100.5"));
    }

    #[test]
    fn ignores_route_types_that_say_nothing_about_where_a_host_is() {
        // Type 3 is inclusive multicast and type 4 is an ethernet segment;
        // neither places an address behind a VTEP.
        let other = "*>i[3]:[0]:[32]:[198.51.100.4]/88\n                      198.51.100.4\n";
        assert!(parse_evpn(other).is_empty());
    }

    #[test]
    fn a_device_that_does_not_speak_vxlan_yields_nothing() {
        assert!(parse_vni_table("% Invalid command at '^' marker.").is_empty());
        assert!(parse_evpn("% Invalid input detected").is_empty());
        assert!(parse_peers("").is_empty());
    }

    #[test]
    fn only_the_dialect_a_fabric_answered_claims_hardware() {
        // NX-OS has met a device: a Nexus leaf and a Nexus spine in a live
        // VXLAN/EVPN fabric, 2026-09-20, and three of these parsers were
        // wrong until they did. The other two are still hypotheses.
        assert!(OverlayDialect::NxOs.verified_against_hardware());
        for d in [OverlayDialect::Arista, OverlayDialect::Junos] {
            assert!(!d.verified_against_hardware(), "{d:?} claims hardware it has not met");
        }
    }

    /// **From Arista's documentation, not captured** (D-051).
    const ARISTA_VNI: &str = "\
VNI to VLAN Mapping for Vxlan1\n\
VNI         VLAN       Source       Interface       802.1Q Tag\n\
----------- ---------- ------------ --------------- ----------\n\
10100       100        static       Vxlan1          100\n\
10200       200        static       Vxlan1          200\n";

    const ARISTA_VTEP: &str = "\
Remote VTEPS for Vxlan1:\n\
\n\
198.51.100.4\n\
198.51.100.5\n\
\n\
Total number of remote VTEPS:  2\n";

    const ARISTA_EVPN: &str = "\
BGP routing table information for VRF default\n\
          Network                Next Hop        Metric  LocPref Weight Path\n\
 * >      RD: 65000:10100 mac-ip 5254.0012.3456 192.0.2.20\n\
                                 198.51.100.4    -       100     0      i\n\
 * >      RD: 65000:10100 mac-ip 5254.0012.7890\n\
                                 198.51.100.4    -       100     0      i\n\
 * >      RD: 65000:50000 ip-prefix 192.0.2.0/24\n\
                                 198.51.100.5    -       100     0      i\n\
 * >      RD: 65000:10100 imet 198.51.100.4\n\
                                 198.51.100.4    -       100     0      i\n";

    #[test]
    fn arista_maps_vnis_to_vlans_in_plain_columns() {
        let s = parse_vni_table(ARISTA_VNI);
        assert_eq!(s.len(), 2, "{s:?}");
        assert_eq!(s[0].vni, 10100);
        assert_eq!(s[0].vlan, Some(100));
    }

    #[test]
    fn arista_lists_its_remote_vteps_as_bare_addresses() {
        let p = parse_peers(ARISTA_VTEP);
        assert_eq!(p.iter().map(|x| x.address.as_str()).collect::<Vec<_>>(), ["198.51.100.4", "198.51.100.5"]);
    }

    #[test]
    fn arista_names_the_route_type_in_words() {
        let r = parse_evpn(ARISTA_EVPN);
        // imet is type 3 and says nothing about where a host is.
        assert_eq!(r.len(), 3, "{r:?}");
        assert_eq!(r[0].route_type, 2);
        assert_eq!(r[0].mac.as_deref(), Some("525400123456"));
        assert_eq!(r[0].address.as_deref(), Some("192.0.2.20"));
        assert_eq!(r[0].next_hop.as_deref(), Some("198.51.100.4"));
        assert_eq!(r[0].vni, Some(10100));
        // A MAC with no address, the same case NX-OS writes as [0.0.0.0].
        assert_eq!(r[1].address, None);
        assert_eq!(r[2].route_type, 5);
        assert_eq!(r[2].address.as_deref(), Some("192.0.2.0/24"));
    }

    /// **From Juniper's documentation, not captured** (D-051).
    const JUNOS_VTEP: &str = "\
Logical System Name       Id  SVTEP-IP         IFL   L3-Idx  SVTEP-Mode\n\
<default>                 0   198.51.100.1     lo0.0    0\n\
 RVTEP-IP         L2-RTT           IFL-Name  NH-Id  RVTEP-Mode\n\
 198.51.100.4     default-switch   vtep.32770  1234  RNVE\n\
 198.51.100.5     default-switch   vtep.32771  1235  RNVE\n";

    const JUNOS_EVPN: &str = "\
bgp.evpn.0: 3 destinations, 3 routes (3 active, 0 holddown, 0 hidden)\n\
+ = Active Route, - = Last Active, * = Both\n\
\n\
2:198.51.100.4:1::0::52:54:00:12:34:56/304 MAC/IP\n\
                   *[BGP/170] 00:10:00, localpref 100, from 198.51.100.4\n\
                      AS path: I, validation-state: unverified\n\
                    > to 192.0.2.2 via ge-0/0/0.0\n\
5:198.51.100.5:1::0::192.0.2.0::24/248\n\
                   *[BGP/170] 00:10:00, localpref 100, from 198.51.100.5\n\
                    > to 192.0.2.6 via ge-0/0/1.0\n";

    #[test]
    fn a_junos_device_is_not_a_peer_of_itself() {
        // SVTEP-IP is this device. Reading every address on the page would
        // list it as its own far end.
        let p = parse_peers(JUNOS_VTEP);
        assert_eq!(p.iter().map(|x| x.address.as_str()).collect::<Vec<_>>(), ["198.51.100.4", "198.51.100.5"]);
    }

    #[test]
    fn junos_writes_the_whole_nlri_as_one_string() {
        let r = parse_evpn(JUNOS_EVPN);
        assert_eq!(r.len(), 2, "{r:?}");
        assert_eq!(r[0].route_type, 2);
        assert_eq!(r[0].mac.as_deref(), Some("525400123456"));
        assert_eq!(r[1].route_type, 5);
        assert_eq!(r[1].address.as_deref(), Some("192.0.2.0/24"));
    }

    #[test]
    fn the_vtep_a_junos_route_came_from_is_from_not_the_underlay_hop() {
        // `to 192.0.2.2 via ge-0/0/0.0` is how the packet reaches the VTEP,
        // not the VTEP. Reading it as one draws the tunnel to the wrong end.
        let r = parse_evpn(JUNOS_EVPN);
        assert_eq!(r[0].next_hop.as_deref(), Some("198.51.100.4"));
        assert_eq!(r[1].next_hop.as_deref(), Some("198.51.100.5"));
    }
}
