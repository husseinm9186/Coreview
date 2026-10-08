//! ArubaOS-CX: identity from `show system`, and the switch's own
//! spellings of the LLDP and MAC tables.
//!
//! **Captured, not reconstructed.** The fixtures below are real
//! output from an Aruba CX 6200F on AOS-CX ML.10.18, 2026-09-28, with the
//! chassis serial and base MAC replaced by invented values. What
//! they earned is the identity half: `show version` names the software and
//! nothing else, and `show system` names the product, the serial and the
//! host. The neighbour, ARP, MAC and bundle commands this dialect sends have
//! **not** been seen from a CX device, which is why the dialect as a whole
//! still reports unverified.

fn labelled<'a>(out: &'a str, label: &str) -> Option<&'a str> {
    out.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k.trim().eq_ignore_ascii_case(label) && !v.trim().is_empty()).then(|| v.trim())
    })
}

/// `Product Name : JL727A 6200F 48G CL4 4SFP+370W Swch`, upper-cased for
/// the classifier — the part number, the family and what it is.
use crate::mac_table::MacEntry;
use crate::types::{DeviceAddress, Neighbor, Protocol};

pub fn model_of(system: &str) -> Option<String> {
    labelled(system, "Product Name").map(|m| m.to_ascii_uppercase())
}

/// `Chassis Serial Nbr : …`.
pub fn serials_of(system: &str) -> Vec<String> {
    labelled(system, "Chassis Serial Nbr").map(|s| vec![s.to_string()]).unwrap_or_default()
}

/// `show lldp neighbor-info detail`: a block per port between
/// dashed rules, `Key : value` lines. Two releases name the neighbour
/// `Neighbor Chassis-Name` or `Neighbor System-Name`; both are read.
/// Written against ntc-templates' captures of real AOS-CX output (the
/// lab 6200 is not reachable from the build machine); a crawl of a real
/// CX is what earns this `verified`.
pub fn parse_lldp_neighbor_info_detail(out: &str) -> Vec<Neighbor> {
    let mut found = Vec::new();
    for block in out.split('\n').collect::<Vec<_>>().split(|l| l.trim_start().starts_with("-----")) {
        let field = |name: &str| -> Option<String> {
            block.iter().find_map(|l| {
                let (k, v) = l.split_once(':')?;
                (k.trim() == name).then(|| v.trim().to_string()).filter(|v| !v.is_empty())
            })
        };
        let Some(local) = field("Port") else { continue };
        let name = field("Neighbor Chassis-Name").or_else(|| field("Neighbor System-Name")).unwrap_or_default();
        let chassis = field("Neighbor Chassis-ID").unwrap_or_default();
        if name.is_empty() && chassis.is_empty() {
            continue;
        }
        let descr = field("Neighbor Chassis-Description").or_else(|| field("Neighbor System-Description"));
        let caps: Vec<String> = field("Chassis Capabilities Enabled").unwrap_or_default().split(',').map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).collect();
        let port_desc = field("Neighbor Port-Desc").unwrap_or_default();
        let port_id = field("Neighbor Port-ID").unwrap_or_default();
        let mut n = crate::arubasw::neighbour_from(&chassis, &name, &local, if port_desc.is_empty() { &port_id } else { &port_desc }, descr.clone(), &caps, Protocol::Lldp);
        if let Some(ip) = field("Neighbor Management-Address").filter(|a| a.parse::<std::net::IpAddr>().is_ok()) {
            n.addresses = vec![DeviceAddress { ip, interface: None, is_management: true }];
        }
        n.version = descr;
        found.push(n);
    }
    found
}

/// `show mac-address-table`: `MAC Address  VLAN  Type  Port` under
/// a dashed rule. Dynamic and port-access entries are devices; a static
/// entry is the switch's own.
pub fn parse_mac_address_table(out: &str) -> Vec<MacEntry> {
    let mut found = Vec::new();
    let mut in_table = false;
    for line in out.lines() {
        if line.trim_start().starts_with("-----") {
            in_table = true;
            continue;
        }
        if !in_table {
            continue;
        }
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 4 {
            continue;
        }
        let Some(mac) = crate::arp::normalise_mac(f[0]) else { continue };
        let kind = f[2].to_ascii_lowercase();
        if kind.contains("static") {
            continue;
        }
        found.push(MacEntry { mac, port: f[3].to_string(), vlan: Some(f[1].to_string()) });
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ntc-templates' capture of an AOS-CX `show lldp neighbor-info detail`,
    /// cut to two ports, in the release that writes `Chassis-Name`; and one
    /// port of the release that writes `System-Name`.
    const LLDP: &str = "LLDP Neighbor Information 
=========================
Total Neighbor Entries          : 2
--------------------------------------------------------------------------------
Port                           : 1/1/1
Neighbor Entries               : 1
Neighbor Chassis-Name          : ap-9999-335-fe
Neighbor Chassis-Description   : ArubaOS (MODEL: 335), Version Aruba AP
Neighbor Chassis-ID            : 70:3a:0e:cd:41:fe
Neighbor Management-Address    : 10.252.99.12
Chassis Capabilities Available : Bridge, WLAN
Chassis Capabilities Enabled   : WLAN
Neighbor Port-ID               : 70:3a:0e:cd:41:fe
Neighbor Port-Desc             : eth0
Neighbor Port VLAN ID          : 
TTL                            : 120
Neighbor Mac-Phy details
Neighbor Auto-neg Supported    : true
--------------------------------------------------------------------------------
Port                           : 1/1/49
Neighbor Entries               : 1
Neighbor System-Name           : core-sw
Neighbor System-Description    : HPE Aruba Networking JL727A 6200F
Neighbor Chassis-ID            : 00:00:5e:00:53:01
Neighbor Management-Address    : 10.252.99.1
Chassis Capabilities Available : Bridge, Router
Chassis Capabilities Enabled   : Bridge, Router
Neighbor Port-ID               : 1/1/49
Neighbor Port-Desc             : 1/1/49
TTL                            : 120
--------------------------------------------------------------------------------
";

    #[test]
    fn lldp_neighbours_in_both_layouts() {
        let n = parse_lldp_neighbor_info_detail(LLDP);
        assert_eq!(n.len(), 2, "{n:#?}");
        assert_eq!((n[0].short_name.as_str(), n[0].local_interface.as_deref(), n[0].remote_interface.as_deref()), ("ap-9999-335-fe", Some("1/1/1"), Some("eth0")));
        assert_eq!(n[0].addresses[0].ip, "10.252.99.12");
        assert_eq!(n[0].chassis_id.as_deref(), Some("703a0ecd41fe"));
        assert_eq!((n[1].short_name.as_str(), n[1].remote_interface.as_deref()), ("core-sw", Some("1/1/49")));
        assert_eq!(n[1].class, crate::types::DeviceClass::Router, "Bridge, Router enabled");
    }

    #[test]
    fn mac_table_keeps_learned_entries() {
        let out = "MAC age-time            : 300 seconds
Number of MAC addresses : 4

MAC Address          VLAN     Type                      Port
--------------------------------------------------------------
88:3a:30:a3:86:80    1        dynamic                   lag100
80:5e:0c:76:ed:bb    2015     port-access-security      1/1/30
00:00:5e:00:53:ff    1        static                    1/1/1
";
        let m = parse_mac_address_table(out);
        assert_eq!(m.len(), 2, "{m:?}");
        assert_eq!((m[0].mac.as_str(), m[0].port.as_str(), m[0].vlan.as_deref()), ("883a30a38680", "lag100", Some("1")));
        assert_eq!(m[1].port, "1/1/30");
    }

    /// A real 6200F's `show version`, verbatim.
    pub(crate) const VERSION: &str = "-----------------------------------------------------------------------------\nAOS-CX\n(c) Copyright 2017-2026 Hewlett Packard Enterprise Development LP\n-----------------------------------------------------------------------------\nVersion      : ML.10.18.1002                                                 \nBuild Date   : 2026-08-27 04:58:32 UTC                                       \nBuild ID     : AOS-CX:ML.10.18.1002:0ea5714e629d:202608270437                \nBuild SHA    : 0ea5714e629d97e799de623c2350c9cd41fb03f4                      \nHot Patches  :                                                               \nActive Image : primary                       \n \nService OS Version : ML.01.19.0001                 \nBIOS Version       : FL.01.0004                    \n";

    /// The same switch's `show system`, with the serial and base MAC invented.
    pub(crate) const SYSTEM: &str = "Hostname               : 6200                          \nSystem Description     : ML.10.18.1002                 \nSystem Contact         :                               \nSystem Location        :                               \n \nVendor                 : HPE ANW                       \nProduct Name           : JL727A 6200F 48G CL4 4SFP+370W Swch  \nChassis Serial Nbr     : XX00EXAMPLE                   \nBase MAC Address       : 00005e-005301                 \nAOS-CX Version         : ML.10.18.1002                 \n \nTime Zone              : UTC                           \n \nUp Time                : 1 week, 5 days, 14 hours, 15 minutes                        \nCPU Util (%)           : 24                            \nCPU Util (% avg 1 min) : 8                             \nCPU Util (% avg 5 min) : 10                            \nMemory Usage (%)       : 17\n";

    #[test]
    fn a_cx_6200_names_its_model_and_serial_and_is_a_switch() {
        assert_eq!(crate::dialect::family_of(VERSION), crate::dialect::Family::ArubaOsCx);
        assert_eq!(model_of(SYSTEM).as_deref(), Some("JL727A 6200F 48G CL4 4SFP+370W SWCH"));
        assert_eq!(serials_of(SYSTEM), ["XX00EXAMPLE"]);
        // An empty label is not a value: `System Contact :` is blank.
        assert_eq!(labelled(SYSTEM, "System Contact"), None);
        // Through the dialect, the way a crawl asks.
        let d = crate::dialect::dialect_for(VERSION);
        assert_eq!(d.identity_commands(), ["show system"]);
        let id = d.identity(VERSION, &[SYSTEM.to_string()]);
        assert_eq!((id.model.as_deref(), id.serials.as_slice()), (Some("JL727A 6200F 48G CL4 4SFP+370W SWCH"), &["XX00EXAMPLE".to_string()][..]));
        assert_eq!(crate::classify::classify(id.model.as_deref(), &[], None), crate::types::DeviceClass::Switch);
        // `show version` alone names nothing, which was the gap.
        assert_eq!(crate::crawl::serials_in_version(VERSION), Vec::<String>::new());
    }
}

// ---------------------------------------------------------------- 

/// `show ip route all-vrfs` (and `show ip route`, `show ipv6 route
/// all-vrfs`): a prefix line `10.0.0.0/24, vrf default`, then a `via` line
/// per next hop — an address or an interface — with `[distance/metric]`
/// and the protocol. Each route with its VRF. The layout of ntc-templates'
/// capture of real AOS-CX output, which the collector's template reads
pub fn parse_routes_by_vrf(out: &str) -> Vec<(String, crate::routes::Route)> {
    let mut found: Vec<(String, crate::routes::Route)> = Vec::new();
    for line in out.lines() {
        let t = line.trim();
        if let Some((prefix, rest)) = t.split_once(", vrf ") {
            if prefix.contains('/') && !prefix.contains(' ') {
                found.push((
                    rest.trim().to_string(),
                    crate::routes::Route { family: if prefix.contains(':') { 6 } else { 4 }, prefix: prefix.to_string(), code: String::new(), protocol: String::new(), next_hops: Vec::new(), interface: None, distance: None, metric: None, next_hop_vrf: None, segment_id: None },
                ));
                continue;
            }
        }
        let Some(rest) = t.strip_prefix("via") else { continue };
        let Some((_, r)) = found.last_mut() else { continue };
        let parts: Vec<&str> = rest.split(',').map(str::trim).filter(|p| !p.is_empty()).collect();
        let Some(hop) = parts.first() else { continue };
        if hop.parse::<std::net::IpAddr>().is_ok() {
            r.next_hops.push(hop.to_string());
        } else if r.interface.is_none() {
            r.interface = Some(hop.to_string());
        }
        for p in &parts[1..] {
            if let Some(inner) = p.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
                let mut dm = inner.split('/');
                r.distance = dm.next().and_then(|d| d.trim().parse().ok());
                r.metric = dm.next().and_then(|m| m.trim().parse().ok());
            } else if r.protocol.is_empty() {
                r.protocol = p.to_ascii_lowercase();
                r.code = p.to_string();
            }
        }
    }
    found
}

/// Whether a reply is AOS-CX's route listing.
pub fn is_route_listing(out: &str) -> bool {
    out.contains("denotes [distance/metric]") || out.lines().any(|l| l.contains(", vrf ") && l.trim().split(',').next().is_some_and(|p| p.contains('/')))
}

/// One block of `show interface`: an `Interface x is up` or `Aggregate
/// lagN is up` header and its indented lines.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Port {
    pub name: String,
    pub up: bool,
    pub admin_up: bool,
    pub description: String,
    pub addresses: Vec<String>,
    /// A LAG's members.
    pub members: Vec<String>,
    /// `access`, `native-untagged`, `native-tagged`.
    pub vlan_mode: Option<String>,
    pub access_vlan: Option<u16>,
    pub native_vlan: Option<u16>,
    /// `all`, or a list as printed.
    pub allowed: Option<String>,
    pub speed: Option<String>,
}

/// `show interface` — the collector's verified reading of a CX switch's
/// ports (ntc-templates' captures). Addresses, LAG members and each port's
/// VLANs are all in it.
pub fn parse_show_interface(out: &str) -> Vec<Port> {
    let mut ports: Vec<Port> = Vec::new();
    for line in out.lines() {
        let t = line.trim();
        let header = t.strip_prefix("Interface ").or_else(|| t.strip_prefix("Aggregate "));
        if let Some(h) = header.filter(|_| !line.starts_with(' ')) {
            if let Some((name, state)) = h.split_once(" is ") {
                ports.push(Port { name: name.trim().to_string(), up: state.trim().starts_with("up"), ..Port::default() });
                continue;
            }
        }
        let Some(p) = ports.last_mut() else { continue };
        let value = |label: &str| -> Option<String> {
            let rest = t.strip_prefix(label)?;
            let v = rest.trim_start().trim_start_matches(':').trim();
            (!v.is_empty()).then(|| v.to_string())
        };
        if t.starts_with("Admin state is") {
            p.admin_up = t.ends_with("up");
        } else if let Some(v) = value("Description") {
            p.description = v;
        } else if let Some(v) = t.strip_prefix("IPv4 address ") {
            if let Some(a) = v.split_whitespace().next() {
                p.addresses.push(a.to_string());
            }
        } else if let Some(v) = value("Aggregated-interfaces") {
            p.members = v.split_whitespace().map(str::to_string).collect();
        } else if let Some(v) = value("VLAN Mode") {
            p.vlan_mode = Some(v);
        } else if let Some(v) = value("Access VLAN") {
            p.access_vlan = v.split_whitespace().next().and_then(|x| x.parse().ok());
        } else if let Some(v) = value("Native VLAN") {
            p.native_vlan = v.split_whitespace().next().and_then(|x| x.parse().ok());
        } else if let Some(v) = value("Allowed VLAN List") {
            p.allowed = Some(v);
        } else if let Some(v) = value("Speed") {
            p.speed = Some(v);
        }
    }
    ports
}

/// The addresses `show interface` names, as the crawl's interface table.
pub fn parse_interfaces(out: &str) -> Vec<crate::interfaces::Interface> {
    parse_show_interface(out)
        .into_iter()
        .flat_map(|p| {
            p.addresses.into_iter().filter_map(move |a| {
                let ip = a.split('/').next()?.to_string();
                ip.parse::<std::net::Ipv4Addr>().ok().map(|_| crate::interfaces::Interface { name: p.name.clone(), address: Some(ip), up: p.up })
            })
        })
        .collect()
}

/// The LAGs `show interface` names, with their members.
pub fn parse_lags(out: &str) -> Vec<crate::etherchannel::PortChannel> {
    parse_show_interface(out)
        .into_iter()
        .filter(|p| !p.members.is_empty())
        .map(|p| crate::etherchannel::PortChannel { name: p.name, protocol: "LACP".into(), members: p.members })
        .collect()
}

/// Each port's VLANs from `show interface`: an access port's VLAN, a
/// trunk's native VLAN and its allowed list.
pub fn port_vlans(ports: &[Port]) -> Vec<crate::vlans::PortVlans> {
    ports
        .iter()
        .filter_map(|p| {
            let mode = p.vlan_mode.as_deref()?;
            Some(if mode == "access" {
                crate::vlans::PortVlans { port: p.name.clone(), mode: "access".into(), vlan: p.access_vlan, trunk_vlans: Vec::new() }
            } else {
                let trunk = p.allowed.as_deref().filter(|a| *a != "all").map(crate::vlans::expand_vlan_list).unwrap_or_default();
                crate::vlans::PortVlans { port: p.name.clone(), mode: "trunk".into(), vlan: p.native_vlan, trunk_vlans: trunk }
            })
        })
        .collect()
}

/// The ports' status as the classic crawler's port table.
pub fn port_status(ports: &[Port]) -> Vec<crate::vlans::PortStatus> {
    ports
        .iter()
        .filter(|p| !p.name.starts_with("vlan") && !p.name.starts_with("loopback"))
        .map(|p| crate::vlans::PortStatus {
            port: p.name.clone(),
            description: p.description.clone(),
            status: if !p.admin_up { "disabled".into() } else if p.up { "connected".into() } else { "notconnect".into() },
            vlan: match p.vlan_mode.as_deref() {
                Some("access") => p.access_vlan.map(|v| v.to_string()).unwrap_or_default(),
                Some(_) => "trunk".into(),
                None => "routed".into(),
            },
            duplex: String::new(),
            speed: p.speed.clone().unwrap_or_default(),
            media: String::new(),
        })
        .collect()
}

/// `show vlan`: `VLAN  Name  Status  Reason  Type  Interfaces`, the
/// interface list wrapping onto lines of its own.
pub fn parse_vlans(out: &str) -> Vec<crate::vlans::Vlan> {
    let lines: Vec<&str> = out.lines().collect();
    let Some(h) = lines.iter().position(|l| l.trim_start().starts_with("VLAN") && l.contains("Name") && l.contains("Status")) else { return Vec::new() };
    let at = lines[h].find("Interfaces");
    let mut vlans: Vec<crate::vlans::Vlan> = Vec::new();
    for l in &lines[h + 1..] {
        if l.trim().is_empty() || l.trim().chars().all(|c| c == '-') {
            continue;
        }
        let ports_text = at.and_then(|a| l.get(a..)).unwrap_or("").trim();
        let w: Vec<&str> = l.split_whitespace().collect();
        if let Some(id) = w.first().and_then(|x| x.parse::<u16>().ok()).filter(|_| !l.starts_with(' ')) {
            vlans.push(crate::vlans::Vlan { id, name: w.get(1).unwrap_or(&"").to_string(), status: w.get(2).unwrap_or(&"").to_string(), ports: Vec::new() });
        }
        if let Some(v) = vlans.last_mut() {
            v.ports.extend(ports_text.split(',').map(str::trim).filter(|p| !p.is_empty()).map(str::to_string));
        }
    }
    vlans
}

/// What the collector reads off a CX switch and the classic
/// crawler did not — its routing table in every VRF, its default route,
/// its addresses, its LAGs and its VLANs — tested on ntc-templates'
/// captures of real AOS-CX output, the same the collector's templates are.
#[cfg(test)]
mod learned_from_the_collector {
    macro_rules! ntc {
        ($f:literal) => {
            include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../resources/templates/tests/aruba_aoscx/", $f))
        };
    }

    #[test]
    fn the_routing_table_and_the_default_route_are_read() {
        let raw = ntc!("show_ip_route_all-vrfs/show_ip_route_all-vrfs.raw");
        let routes = crate::routes::parse_routes(raw);
        let default = routes.iter().find(|r| r.prefix == "0.0.0.0/0").expect("the default route");
        assert_eq!(default.next_hops, ["172.25.0.189", "172.25.0.185"]);
        assert_eq!((default.protocol.as_str(), default.distance, default.metric), ("bgp", Some(20), Some(0)));
        let connected = routes.iter().find(|r| r.prefix == "10.252.22.128/26").unwrap();
        assert_eq!((connected.protocol.as_str(), connected.interface.as_deref(), connected.next_hops.len()), ("connected", Some("vlan3564"), 0));
        assert_eq!(crate::defaultroute::parse_default_route(raw).map(|h| h.to_string()).as_deref(), Some("172.25.0.189"));
        assert!(super::parse_routes_by_vrf(raw).iter().all(|(vrf, _)| vrf == "default"));
    }

    #[test]
    fn addresses_lags_and_vlans_come_off_show_interface_and_show_vlan() {
        let raw = ntc!("show_interface/show_interface2.raw");
        let i = super::parse_interfaces(raw);
        assert!(i.iter().any(|x| x.name == "vlan3072" && x.address.as_deref() == Some("10.1.2.1")), "{i:?}");
        let lags = super::parse_lags(raw);
        assert_eq!(lags.iter().map(|l| (l.name.as_str(), l.members.clone())).collect::<Vec<_>>(), [("lag1", vec!["1/1/51".to_string(), "1/1/52".to_string()])]);
        let ports = super::parse_show_interface(raw);
        let pv = super::port_vlans(&ports);
        assert!(pv.iter().any(|p| p.port == "lag1" && p.mode == "trunk" && p.vlan == Some(666)), "{pv:?}");
        assert!(pv.iter().any(|p| p.mode == "access" && p.vlan.is_some()));
        let st = super::port_status(&ports);
        assert_eq!(st.iter().find(|p| p.port == "1/1/1").map(|p| (p.status.as_str(), p.description.as_str())), Some(("connected", "PORT-ACCESS")));
        let secondary = super::parse_interfaces(ntc!("show_interface/show_interface4.raw"));
        assert!(secondary.iter().any(|x| x.address.as_deref() == Some("172.25.2.1")), "a secondary address is an address too");
        let v = super::parse_vlans(ntc!("show_vlan/show_vlan.raw"));
        assert_eq!((v[0].id, v[0].name.as_str(), v[0].ports.clone()), (1, "DEFAULT_VLAN_1", vec!["1/1/34-1/1/52".to_string()]));
        assert_eq!(v[1].ports, ["1/1/2-1/1/4", "1/1/6-1/1/8", "1/1/17-1/1/19", "1/1/47-1/1/52"]);
    }
}
