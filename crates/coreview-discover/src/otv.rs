//! OTV: the layer-2 extension between data centres on a Nexus 7000 (LT-480).
//!
//! An OTV edge device stretches VLANs across an IP core to the edges in the
//! other sites. A destination on an extended VLAN is not routed to; its MAC
//! is looked up in the OTV route table, which names the edge that owns it.
//! That table is what lets the path engine cross the extension to the right
//! site rather than guess (D-050).
//!
//! **Built from Cisco's documentation and posted sessions, not from a
//! device (D-058).** Fixtures reconstructed; [`verified_against_hardware`]
//! says `false` until one is a capture.
//!
//! - `show otv` — each overlay: name, extended VLANs, join interface.
//! - `show otv adjacency` — the far edges, by hostname and address.
//! - `show otv route` — VLAN, MAC and which edge (or local port) owns it.

/// D-058: this platform has not met a device.
pub fn verified_against_hardware() -> bool {
    false
}

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Otv {
    pub overlays: Vec<Overlay>,
    pub adjacencies: Vec<Adjacency>,
    pub routes: Vec<OtvRoute>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overlay {
    pub name: String,
    /// Every VLAN the overlay extends, expanded from `100-110,200`.
    pub extended_vlans: Vec<u16>,
    pub join_interface: Option<String>,
    pub join_address: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Adjacency {
    pub overlay: String,
    pub hostname: String,
    pub address: Option<String>,
    pub state: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OtvRoute {
    pub vlan: u16,
    /// Twelve lowercase hex digits.
    pub mac: String,
    /// `overlay` for a MAC behind another edge, `site` for one on this site.
    pub owner: String,
    /// The far edge's hostname, or the local port.
    pub next_hop: String,
}

/// `100-110,200` as every VLAN in it.
fn expand_vlans(spec: &str) -> Vec<u16> {
    let mut out = Vec::new();
    for part in spec.split(',') {
        let part = part.trim();
        if let Some((a, b)) = part.split_once('-') {
            if let (Ok(a), Ok(b)) = (a.trim().parse::<u16>(), b.trim().parse::<u16>()) {
                if a <= b && b - a < 4096 {
                    out.extend(a..=b);
                }
            }
        } else if let Ok(v) = part.parse::<u16>() {
            out.push(v);
        }
    }
    out
}

/// `show otv`.
///
/// ```text
/// OTV Overlay Information
/// Site Identifier 0000.0000.0001
/// Overlay interface Overlay1
///  VPN name            : Overlay1
///  VPN state           : UP
///  Extended vlans      : 100-110 (Total:11)
///  Control group       : 239.1.1.1
///  Data group range(s) : 232.1.1.0/28
///  Join interface(s)   : Eth2/1 (10.1.1.1)
///  Site vlan           : 1 (up)
/// ```
pub fn parse_show_otv(out: &str) -> Vec<Overlay> {
    let mut overlays: Vec<Overlay> = Vec::new();
    for line in out.lines() {
        let t = line.trim();
        if let Some(name) = t.strip_prefix("Overlay interface ") {
            overlays.push(Overlay { name: name.trim().to_string(), extended_vlans: Vec::new(), join_interface: None, join_address: None });
            continue;
        }
        let Some(cur) = overlays.last_mut() else { continue };
        let Some((k, v)) = t.split_once(':') else { continue };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
        if k == "extended vlans" {
            cur.extended_vlans = expand_vlans(v.split('(').next().unwrap_or(""));
        } else if k.starts_with("join interface") {
            let mut words = v.split_whitespace();
            cur.join_interface = words.next().map(str::to_string);
            cur.join_address = words.next().map(|w| w.trim_matches(['(', ')']).to_string()).filter(|a| a.parse::<std::net::Ipv4Addr>().is_ok());
        }
    }
    overlays
}

/// `show otv adjacency`.
///
/// ```text
/// Overlay Adjacency database
/// Overlay-Interface Overlay1  :
/// Hostname                         System-ID      Dest Addr       Up Time   State
/// dc2-otv-edge-1                   0026.980c.5b42 10.1.1.2        3d04h     UP
/// ```
pub fn parse_adjacency(out: &str) -> Vec<Adjacency> {
    let mut found = Vec::new();
    let mut overlay = String::new();
    for line in out.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("Overlay-Interface ") {
            overlay = rest.split_whitespace().next().unwrap_or("").to_string();
            continue;
        }
        let f: Vec<&str> = t.split_whitespace().collect();
        if f.len() < 3 || f[0] == "Hostname" || overlay.is_empty() {
            continue;
        }
        if crate::arp::normalise_mac(f[1]).is_none() {
            continue;
        }
        found.push(Adjacency {
            overlay: overlay.clone(),
            hostname: f[0].to_string(),
            address: f.get(2).filter(|a| a.parse::<std::net::Ipv4Addr>().is_ok()).map(|a| a.to_string()),
            state: f.last().filter(|_| f.len() >= 5).map(|s| s.to_string()),
        });
    }
    found
}

/// `show otv route`.
///
/// ```text
/// OTV Unicast MAC Routing Table For Overlay1
/// VLAN MAC-Address     Metric  Uptime    Owner      Next-hop(s)
/// ---- --------------  ------  --------  ---------  -----------
///  100 0050.56aa.bbcc  42      3d04h     overlay    dc2-otv-edge-1
///  100 0000.5e00.5301  1       3d04h     site       Ethernet2/2
/// ```
pub fn parse_route(out: &str) -> Vec<OtvRoute> {
    let mut found = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 6 {
            continue;
        }
        let (Ok(vlan), Some(mac)) = (f[0].parse::<u16>(), crate::arp::normalise_mac(f[1])) else { continue };
        found.push(OtvRoute { vlan, mac, owner: f[4].to_ascii_lowercase(), next_hop: f[5].to_string() });
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reconstructed from Cisco's documentation (D-058), not captured.
    const SHOW: &str = "OTV Overlay Information\nSite Identifier 0000.0000.0001\n\nOverlay interface Overlay1\n\n VPN name            : Overlay1\n VPN state           : UP\n Extended vlans      : 100-110 (Total:11)\n Control group       : 239.1.1.1\n Data group range(s) : 232.1.1.0/28\n Join interface(s)   : Eth2/1 (10.1.1.1)\n Site vlan           : 1 (up)\n AED-Capable         : Yes\n Capability          : Multicast-Reachable\n";
    const ADJ: &str = "Overlay Adjacency database\n\nOverlay-Interface Overlay1  :\nHostname                         System-ID      Dest Addr       Up Time   State\ndc2-otv-edge-1                   0026.980c.5b42 10.1.1.2        3d04h     UP\n";
    const ROUTE: &str = "OTV Unicast MAC Routing Table For Overlay1\n\nVLAN MAC-Address     Metric  Uptime    Owner      Next-hop(s)\n---- --------------  ------  --------  ---------  -----------\n 100 0050.56aa.bbcc  42      3d04h     overlay    dc2-otv-edge-1\n 100 0000.5e00.5301  1       3d04h     site       Ethernet2/2\n";

    #[test]
    fn the_three_tables_are_read() {
        let o = parse_show_otv(SHOW);
        assert_eq!(o.len(), 1);
        assert_eq!((o[0].name.as_str(), o[0].extended_vlans.len(), o[0].extended_vlans[0], o[0].join_interface.as_deref(), o[0].join_address.as_deref()), ("Overlay1", 11, 100, Some("Eth2/1"), Some("10.1.1.1")));
        let a = parse_adjacency(ADJ);
        assert_eq!(a, [Adjacency { overlay: "Overlay1".into(), hostname: "dc2-otv-edge-1".into(), address: Some("10.1.1.2".into()), state: Some("UP".into()) }]);
        let r = parse_route(ROUTE);
        assert_eq!(r, [
            OtvRoute { vlan: 100, mac: "005056aabbcc".into(), owner: "overlay".into(), next_hop: "dc2-otv-edge-1".into() },
            OtvRoute { vlan: 100, mac: "00005e005301".into(), owner: "site".into(), next_hop: "Ethernet2/2".into() },
        ]);
        assert_eq!(expand_vlans("100-102,200"), [100, 101, 102, 200]);
        assert!(!verified_against_hardware());
    }
}
