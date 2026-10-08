//! The Vyatta lineage — Ubiquiti EdgeOS and VyOS.
//!
//! **Built from Ubiquiti's and VyOS's documentation and posted sessions, not
//! from a router.** Fixtures reconstructed; [`verified_against_hardware`]
//! says `false` until one is a capture.
//!
//! One dialect for the two, because they are one lineage and answer the same
//! commands:
//!
//! - `show version` — `Version: v2.0.9` / `HW model: EdgeRouter X 5-Port` on
//!   EdgeOS, `Version: VyOS 1.4.0` on VyOS. The serial is not printed by
//!   either and is left unread.
//! - `show interfaces` — Interface, IP Address, S/L, Description; an
//!   interface with several addresses continues on indented lines.
//! - `show lldp neighbors detail` — lldpd's layout: `Interface: eth0, via:
//!   LLDP`, then `ChassisID:`, `SysName:`, `MgmtIP:`, `PortID:` under it.
//! - `show arp` — Linux's `arp` table, read by the ordinary ARP reader.
//! - `show ip route` — Quagga's, which the ordinary route reader reads
//!   once `>` is treated as a marker (`S>*`, `C>*`).
//!
//! No MAC table on a router. Paging is `terminal length 0`; the prompt is
//! `user@host:~$`.

use crate::arp::normalise_mac;
use crate::cdp::short_name;
use crate::interfaces::Interface;
use crate::types::{DeviceAddress, DeviceClass, Neighbor, Protocol};

/// This platform has not met a device.
pub fn verified_against_hardware() -> bool {
    false
}

/// `HW model:     EdgeRouter X 5-Port` on EdgeOS; VyOS names no hardware and
/// is called by its version line, `VYOS 1.4.0`, so it classifies as a router.
pub fn model_of(version: &str) -> Option<String> {
    let labelled = |label: &str| {
        version.lines().find_map(|l| {
            let (k, v) = l.trim().split_once(':')?;
            (k.trim().eq_ignore_ascii_case(label) && !v.trim().is_empty()).then(|| v.trim().to_ascii_uppercase())
        })
    };
    labelled("HW model").or_else(|| labelled("Version").filter(|v| v.starts_with("VYOS")))
}

/// `show interfaces`.
///
/// ```text
/// Codes: S - State, L - Link, u - Up, D - Down, A - Admin Down
/// Interface    IP Address                        S/L  Description
/// ---------    ----------                        ---  -----------
/// eth0         203.0.113.2/24                    u/u  WAN
/// eth1         10.0.0.1/24                       u/u  LAN
///              10.0.1.1/24
/// eth2         -                                 u/D
/// lo           127.0.0.1/8                       u/u
///              ::1/128
/// ```
pub fn parse_interfaces(out: &str) -> Vec<Interface> {
    let mut found = Vec::new();
    let mut current: Option<(String, bool)> = None;
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.is_empty() || f[0] == "Interface" || f[0].starts_with('-') || f[0] == "Codes:" {
            continue;
        }
        let indented = line.starts_with(' ');
        let (name, address, state) = if indented {
            let Some((name, up)) = current.clone() else { continue };
            (name, f[0], up)
        } else {
            if f.len() < 3 {
                continue;
            }
            let up = f[2] == "u/u";
            current = Some((f[0].to_string(), up));
            (f[0].to_string(), f[1], up)
        };
        let ip = address.split('/').next().unwrap_or("");
        if ip.parse::<std::net::Ipv4Addr>().is_ok() {
            found.push(Interface { name, address: Some(ip.to_string()), up: state });
        }
    }
    found
}

/// `show lldp neighbors detail`, as lldpd prints it.
///
/// ```text
/// -------------------------------------------------------------------------------
/// LLDP neighbors:
/// -------------------------------------------------------------------------------
/// Interface:    eth1, via: LLDP, RID: 1, Time: 0 day, 00:01:23
///   Chassis:
///     ChassisID:    mac 00:1c:73:aa:bb:cc
///     SysName:      leaf1
///     SysDescr:     Arista Networks EOS version 4.28.0F
///     MgmtIP:       10.0.0.2
///     Capability:   Bridge, on
///     Capability:   Router, on
///   Port:
///     PortID:       ifname Ethernet3
///     PortDescr:    to-edge
/// -------------------------------------------------------------------------------
/// ```
pub fn parse_lldp_detail(out: &str) -> Vec<Neighbor> {
    let mut found: Vec<Neighbor> = Vec::new();
    // The port's description, kept until the entry is done, for a
    // neighbour whose port id is only a MAC (a real gateway).
    let mut descr: Vec<Option<String>> = Vec::new();
    let value = |line: &str, label: &str| -> Option<String> {
        let (k, v) = line.trim().split_once(':')?;
        k.trim().eq_ignore_ascii_case(label).then(|| v.trim().to_string()).filter(|v| !v.is_empty())
    };
    for line in out.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("Interface:") {
            let mut parts = rest.split(',');
            let local = parts.next().map(|s| s.trim().to_string());
            // Lldpd hears CDP as well, and says which it heard.
            let via = parts.find_map(|p| p.trim().strip_prefix("via:").map(str::trim)).unwrap_or("LLDP");
            found.push(Neighbor {
                serial: None,
                short_name: String::new(),
                device_id: String::new(),
                addresses: Vec::new(),
                local_interface: local,
                remote_interface: None,
                platform: None,
                capabilities: Vec::new(),
                version: None,
                class: DeviceClass::Unknown,
                discovered_by: if via.starts_with("CDP") { Protocol::Cdp } else { Protocol::Lldp },
                vendor: None,
                chassis_id: None,
            });
            descr.push(None);
            continue;
        }
        let Some(n) = found.last_mut() else { continue };
        if let Some(v) = value(t, "ChassisID") {
            let id = v.split_whitespace().last().unwrap_or("").to_string();
            n.chassis_id = normalise_mac(&id);
            n.vendor = n.chassis_id.as_deref().and_then(crate::oui::vendor).map(str::to_string);
            if n.device_id.is_empty() {
                n.device_id = id;
            }
        } else if let Some(v) = value(t, "SysName") {
            n.device_id = v;
        } else if let Some(v) = value(t, "SysDescr") {
            n.version = Some(v);
        } else if let Some(v) = value(t, "MgmtIP") {
            // A link-local address is nowhere a crawl can go; an
            // IPv4 one goes first.
            match v.parse::<std::net::IpAddr>() {
                Ok(std::net::IpAddr::V6(v6)) if (v6.segments()[0] & 0xffc0) == 0xfe80 => {}
                Ok(ip) => {
                    let a = DeviceAddress { ip: v, interface: None, is_management: true };
                    if ip.is_ipv4() {
                        let at = n.addresses.iter().position(|x| x.ip.contains(':')).unwrap_or(n.addresses.len());
                        n.addresses.insert(at, a);
                    } else {
                        n.addresses.push(a);
                    }
                }
                Err(_) => {}
            }
        } else if let Some(v) = value(t, "Capability") {
            if let Some((cap, state)) = v.split_once(',') {
                if state.trim() == "on" {
                    n.capabilities.push(cap.trim().to_string());
                }
            }
        } else if let Some(v) = value(t, "PortID") {
            n.remote_interface = Some(v.split_whitespace().last().unwrap_or("").to_string());
        } else if let Some(v) = value(t, "PortDescr") {
            if let Some(d) = descr.last_mut() {
                *d = Some(v);
            }
        // LLDP-MED's inventory names the model and the serial.
        } else if let Some(v) = value(t, "Model") {
            n.platform = Some(v);
        } else if let Some(v) = value(t, "Serial Number") {
            n.serial = Some(v);
        }
    }
    for (n, d) in found.iter_mut().zip(descr) {
        if n.remote_interface.as_deref().and_then(normalise_mac).is_some() {
            if let Some(d) = d {
                n.remote_interface = Some(d);
            }
        }
        n.short_name = short_name(&n.device_id);
        n.class = crate::classify::classify(n.platform.as_deref(), &n.capabilities, n.version.as_deref());
    }
    found.retain(|n| !n.device_id.is_empty());
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reconstructed from Ubiquiti's and VyOS's documentation, not captured.
    const EDGEOS: &str = "Version:      v2.0.9-hotfix.7\nBuild ID:     5544695\nBuild on:     10/06/23 09:45\nCopyright:    2012-2023 Ubiquiti Networks, Inc.\nHW model:     EdgeRouter X 5-Port\nHW S/N:       ABCDEF012345\nUptime:       12:03:04 up 12 days\n";
    const VYOS: &str = "Version:          VyOS 1.4.0\nRelease train:    sagitta\n\nBuilt by:         Sentrium S.L.\nBuilt on:         Sat 01 Jun 2024 12:00 UTC\nBuild UUID:       00000000-0000-0000-0000-000000000000\n\nArchitecture:     x86_64\nBoot via:         installed image\nSystem type:      KVM guest\n\nHardware vendor:  QEMU\nHardware model:   Standard PC (Q35 + ICH9, 2009)\n";
    const INTERFACES: &str = "Codes: S - State, L - Link, u - Up, D - Down, A - Admin Down\nInterface    IP Address                        S/L  Description\n---------    ----------                        ---  -----------\neth0         203.0.113.2/24                    u/u  WAN\neth1         10.0.0.1/24                       u/u  LAN\n             10.0.1.1/24\neth2         -                                 u/D\nlo           127.0.0.1/8                       u/u\n             ::1/128\n";
    const LLDP: &str = "-------------------------------------------------------------------------------\nLLDP neighbors:\n-------------------------------------------------------------------------------\nInterface:    eth1, via: LLDP, RID: 1, Time: 0 day, 00:01:23\n  Chassis:\n    ChassisID:    mac 00:1c:73:aa:bb:cc\n    SysName:      leaf1\n    SysDescr:     Arista Networks EOS version 4.28.0F\n    MgmtIP:       10.0.0.2\n    Capability:   Bridge, on\n    Capability:   Router, on\n  Port:\n    PortID:       ifname Ethernet3\n    PortDescr:    to-edge\n-------------------------------------------------------------------------------\n";
    const ROUTE: &str = "Codes: K - kernel route, C - connected, S - static, R - RIP,\n       O - OSPF, I - IS-IS, B - BGP, > - selected route, * - FIB route\n\nS>* 0.0.0.0/0 [1/0] via 203.0.113.1, eth0\nC>* 10.0.0.0/24 is directly connected, eth1\nC>* 203.0.113.0/24 is directly connected, eth0\nO>* 192.168.50.0/24 [110/20] via 10.0.0.9, eth1, 00:12:34\n";
    const ARP: &str = "Address                  HWtype  HWaddress           Flags Mask            Iface\n10.0.0.10                ether   00:50:56:aa:bb:cc   C                     eth1\n203.0.113.1              ether   00:1c:73:aa:bb:cc   C                     eth0\n";

    #[test]
    fn both_banners_name_the_family_and_the_model_where_there_is_one() {
        assert_eq!(crate::dialect::family_of(EDGEOS), crate::dialect::Family::Vyatta);
        assert_eq!(crate::dialect::family_of(VYOS), crate::dialect::Family::Vyatta);
        assert_eq!(model_of(EDGEOS).as_deref(), Some("EDGEROUTER X 5-PORT"));
        assert_eq!(model_of(VYOS).as_deref(), Some("VYOS 1.4.0"));
        assert!(!verified_against_hardware());
    }

    #[test]
    fn interfaces_and_neighbours_are_read() {
        let i = parse_interfaces(INTERFACES);
        assert_eq!(i.iter().map(|i| (i.name.as_str(), i.address.as_deref().unwrap(), i.up)).collect::<Vec<_>>(), [("eth0", "203.0.113.2", true), ("eth1", "10.0.0.1", true), ("eth1", "10.0.1.1", true), ("lo", "127.0.0.1", true)]);
        let n = parse_lldp_detail(LLDP);
        assert_eq!(n.len(), 1);
        assert_eq!((n[0].short_name.as_str(), n[0].local_interface.as_deref(), n[0].remote_interface.as_deref()), ("leaf1", Some("eth1"), Some("Ethernet3")));
        assert_eq!(n[0].addresses[0].ip, "10.0.0.2");
        assert_eq!(n[0].capabilities, ["Bridge", "Router"]);
        assert_eq!(n[0].chassis_id.as_deref(), Some("001c73aabbcc"));
    }

    #[test]
    fn the_quagga_route_table_and_the_linux_arp_table_read_with_the_ordinary_readers() {
        let got = crate::routes::parse_routes(ROUTE);
        let rows: Vec<(&str, &str, Vec<String>)> = got.iter().map(|r| (r.prefix.as_str(), r.protocol.as_str(), r.next_hops.clone())).collect();
        assert!(rows.contains(&("0.0.0.0/0", "static", vec!["203.0.113.1".to_string()])), "{rows:?}");
        assert!(rows.contains(&("10.0.0.0/24", "connected", vec![])), "{rows:?}");
        assert!(rows.contains(&("192.168.50.0/24", "ospf", vec!["10.0.0.9".to_string()])), "{rows:?}");
        assert_eq!(crate::defaultroute::parse_default_route(ROUTE).map(|a| a.to_string()).as_deref(), Some("203.0.113.1"));
        let arp = crate::arp::parse_arp_table(ARP);
        assert_eq!(arp.get("005056aabbcc").map(String::as_str), Some("10.0.0.10"));
    }
}
