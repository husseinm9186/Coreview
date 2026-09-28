//! SONiC — community SONiC and Enterprise SONiC by Broadcom (LT-493).
//!
//! **Built from the SONiC command reference and the cheat sheet the
//! operator linked, not from a switch (D-058).** The cheat sheet names the
//! commands and carries no output, so every fixture below is reconstructed
//! to the documented layout, and the dialect reports unverified until a
//! support capture (LT-481) replaces them.
//!
//! An SSH login lands in bash (`admin@sonic:~$`). Enterprise SONiC also has
//! `sonic-cli`, a Cisco-style shell; the crawl does not enter it, because
//! SONiC's own `show` commands answer from bash on both editions, and that
//! is the one shell both share. Paging is off by `PAGER=cat` for the
//! utilities and `VTYSH_PAGER=cat` for FRR.
//!
//! - `show version` — `SONiC Software Version:`, `Platform:`, `HwSKU:`,
//!   `Serial Number:`.
//! - `show lldp neighbors` — lldpd's layout, read by
//!   [`crate::vyatta::parse_lldp_detail`], because it carries the management
//!   address; `show lldp table` is the fallback without one.
//! - `show ip interfaces`, `show arp`, `show mac`,
//!   `show interfaces portchannel`, and `show ip route` (FRR's layout).

use crate::arp::normalise_mac;
use crate::etherchannel::PortChannel;
use crate::interfaces::Interface;
use crate::mac_table::MacEntry;
use crate::types::{DeviceClass, Neighbor, Protocol};

/// D-058: this platform has not met a device.
pub fn verified_against_hardware() -> bool {
    false
}

fn labelled<'a>(out: &'a str, label: &str) -> Option<&'a str> {
    out.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k.trim().eq_ignore_ascii_case(label) && !v.trim().is_empty()).then(|| v.trim())
    })
}

/// The hardware SKU names the switch (`DellEMC-S5248f-P-25G-DPB`,
/// `Mellanox-SN2700`); the platform string is the fallback.
pub fn model_of(version: &str) -> Option<String> {
    labelled(version, "HwSKU").or_else(|| labelled(version, "Platform")).map(|m| m.to_ascii_uppercase())
}

pub fn serials_of(version: &str) -> Vec<String> {
    labelled(version, "Serial Number").map(|s| vec![s.to_string()]).unwrap_or_default()
}

/// `show ip interfaces`:
///
/// ```text
/// Interface        Master    IPv4 address/mask    Admin/Oper    BGP Neighbor    Neighbor IP
/// ---------------  --------  -------------------  ------------  --------------  -------------
/// Ethernet0                  10.0.0.0/31          up/up         SPINE01         10.0.0.1
/// Loopback0                  10.1.0.1/32          up/up         N/A             N/A
/// Vlan100          Vrf-red   10.100.0.1/24        up/down       N/A             N/A
/// eth0                       192.0.2.21/24        up/up         N/A             N/A
/// ```
///
/// The Master column is often empty, so the address is found by its shape
/// and the state is the word after it.
pub fn parse_ip_interfaces(out: &str) -> Vec<Interface> {
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            let at = f.iter().position(|w| w.contains('/') && w.split('/').next().is_some_and(|a| a.parse::<std::net::Ipv4Addr>().is_ok()))?;
            if at == 0 {
                return None;
            }
            let ip = f[at].split('/').next()?.to_string();
            let up = f.get(at + 1).is_some_and(|s| *s == "up/up");
            Some(Interface { name: f[0].to_string(), address: Some(ip), up })
        })
        .collect()
}

/// `show mac`:
///
/// ```text
///   No.    Vlan  MacAddress         Port        Type
/// -----  ------  -----------------  ----------  -------
///     1    1000  52:54:00:12:34:56  Ethernet0   Dynamic
///     2    1000  52:54:00:12:34:57  Ethernet4   Static
/// Total number of entries 2
/// ```
pub fn parse_mac(out: &str) -> Vec<MacEntry> {
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            let at = f.iter().position(|w| w.contains(':') && normalise_mac(w).is_some())?;
            if at == 0 {
                return None;
            }
            Some(MacEntry { mac: normalise_mac(f[at])?, port: f.get(at + 1)?.to_string(), vlan: Some(f[at - 1].to_string()) })
        })
        .collect()
}

/// `show interfaces portchannel`:
///
/// ```text
/// Flags: A - active, I - inactive, Up - up, Dw - Down, N/A - not available,
///        S - selected, D - deselected, * - not synced
///   No.  Team Dev         Protocol     Ports
/// -----  ---------------  -----------  ---------------------------
///  0001  PortChannel0001  LACP(A)(Up)  Ethernet112(S) Ethernet108(D)
/// ```
pub fn parse_portchannels(out: &str) -> Vec<PortChannel> {
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            let at = f.iter().position(|w| w.starts_with("PortChannel"))?;
            let protocol = f.get(at + 1)?;
            let members: Vec<String> = f[at + 2..].iter().map(|m| m.split('(').next().unwrap_or("").to_string()).filter(|m| !m.is_empty()).collect();
            (!members.is_empty()).then(|| PortChannel {
                name: f[at].to_string(),
                protocol: if protocol.starts_with("LACP") { "LACP".into() } else { "-".into() },
                members,
            })
        })
        .collect()
}

/// `show lldp table`, the fallback: names and ports, no address.
///
/// ```text
/// Capability codes: (R) Router, (B) Bridge, (O) Other
/// LocalPort    RemoteDevice    RemotePortID    Capability    RemotePortDescr
/// -----------  --------------  --------------  ------------  -----------------
/// Ethernet0    spine01         Ethernet0       BR            Ethernet0
/// --------------------------------------------------
/// Total entries displayed:  1
/// ```
pub fn parse_lldp_table(out: &str) -> Vec<Neighbor> {
    let lines: Vec<&str> = out.lines().collect();
    let Some(at) = lines.iter().position(|l| l.contains("LocalPort") && l.contains("RemoteDevice")) else {
        return Vec::new();
    };
    lines[at + 1..]
        .iter()
        .filter(|l| !l.trim().starts_with('-') && !l.trim().starts_with("Total"))
        .filter_map(|row| {
            let f: Vec<&str> = row.split_whitespace().collect();
            if f.len() < 3 {
                return None;
            }
            let caps: Vec<String> = f.get(3).map(|c| c.chars().map(|x| x.to_string()).collect()).unwrap_or_default();
            let class = if caps.iter().any(|c| c == "B") {
                DeviceClass::Switch
            } else if caps.iter().any(|c| c == "R") {
                DeviceClass::Router
            } else {
                DeviceClass::Unknown
            };
            Some(Neighbor {
                serial: None,
                short_name: crate::cdp::short_name(f[1]),
                device_id: f[1].to_string(),
                addresses: Vec::new(),
                local_interface: Some(f[0].to_string()),
                remote_interface: Some(f[2].to_string()),
                platform: None,
                capabilities: caps,
                version: None,
                class,
                discovered_by: Protocol::Lldp,
                vendor: None,
                chassis_id: None,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reconstructed from the SONiC command reference (D-058), not captured.
    pub(crate) const VERSION: &str = "\nSONiC Software Version: SONiC.4.1.0-Enterprise_Base\nProduct: Enterprise SONiC Distribution by Broadcom\nDistribution: Debian 10.13\nKernel: 4.19.0-12-2-amd64\nBuild commit: 0a1b2c3d\nBuild date: Mon Jan  1 00:00:00 UTC 2024\nBuilt by: builder@example\n\nPlatform: x86_64-dellemc_s5248f_c3538-r0\nHwSKU: DellEMC-S5248f-P-25G-DPB\nASIC: broadcom\nASIC Count: 1\nSerial Number: XX00EXAMPLE\nUptime: 12:00:00 up 5 days,  3:44,  1 user,  load average: 0.50, 0.40, 0.30\n";

    #[test]
    fn identity_comes_off_show_version_and_a_dell_sku_is_still_sonic() {
        assert_eq!(crate::dialect::family_of(VERSION), crate::dialect::Family::Sonic, "DellEMC in the SKU must not make it the Dell dialect");
        assert_eq!(model_of(VERSION).as_deref(), Some("DELLEMC-S5248F-P-25G-DPB"));
        assert_eq!(serials_of(VERSION), ["XX00EXAMPLE"]);
        assert!(!verified_against_hardware());
    }

    #[test]
    fn the_tables_are_read() {
        let i = parse_ip_interfaces("Interface        Master    IPv4 address/mask    Admin/Oper    BGP Neighbor    Neighbor IP\n---------------  --------  -------------------  ------------  --------------  -------------\nEthernet0                  10.0.0.0/31          up/up         SPINE01         10.0.0.1\nLoopback0                  10.1.0.1/32          up/up         N/A             N/A\nVlan100          Vrf-red   10.100.0.1/24        up/down       N/A             N/A\neth0                       192.0.2.21/24        up/up         N/A             N/A\n");
        assert_eq!(i.iter().map(|x| (x.name.as_str(), x.address.as_deref().unwrap(), x.up)).collect::<Vec<_>>(), [("Ethernet0", "10.0.0.0", true), ("Loopback0", "10.1.0.1", true), ("Vlan100", "10.100.0.1", false), ("eth0", "192.0.2.21", true)]);
        let m = parse_mac("  No.    Vlan  MacAddress         Port        Type\n-----  ------  -----------------  ----------  -------\n    1    1000  52:54:00:12:34:56  Ethernet0   Dynamic\nTotal number of entries 1\n");
        assert_eq!(m.iter().map(|e| (e.mac.as_str(), e.port.as_str(), e.vlan.as_deref())).collect::<Vec<_>>(), [("525400123456", "Ethernet0", Some("1000"))]);
        let p = parse_portchannels("Flags: A - active, I - inactive, Up - up, Dw - Down, N/A - not available,\n       S - selected, D - deselected, * - not synced\n  No.  Team Dev         Protocol     Ports\n-----  ---------------  -----------  ---------------------------\n 0001  PortChannel0001  LACP(A)(Up)  Ethernet112(S) Ethernet108(D)\n");
        assert_eq!(p.len(), 1);
        assert_eq!((p[0].name.as_str(), p[0].protocol.as_str(), p[0].members.clone()), ("PortChannel0001", "LACP", vec!["Ethernet112".to_string(), "Ethernet108".to_string()]));
        let t = parse_lldp_table("Capability codes: (R) Router, (B) Bridge, (O) Other\nLocalPort    RemoteDevice    RemotePortID    Capability    RemotePortDescr\n-----------  --------------  --------------  ------------  -----------------\nEthernet0    spine01         Ethernet0       BR            Ethernet0\n--------------------------------------------------\nTotal entries displayed:  1\n");
        assert_eq!(t.iter().map(|n| (n.local_interface.as_deref().unwrap(), n.short_name.as_str(), n.class)).collect::<Vec<_>>(), [("Ethernet0", "spine01", DeviceClass::Switch)]);
        let arp = crate::arp::parse_arp_table("Address        MacAddress         Iface        Vlan\n-------------  -----------------  -----------  ------\n10.0.0.1       52:54:00:12:34:56  Ethernet0    -\nTotal number of entries 1\n");
        assert_eq!(arp.get("525400123456").map(String::as_str), Some("10.0.0.1"));
    }

    /// FRR prints an equal-cost route's second leg on its own line under the
    /// first, starting `*` and `via`; both legs are one route with two next
    /// hops — the ECMP the trace (LT-346) follows.
    #[test]
    fn frr_ecmp_legs_are_one_route_with_two_next_hops() {
        let table = "Codes: K - kernel route, C - connected, S - static, R - RIP,\n       O - OSPF, I - IS-IS, B - BGP, E - EIGRP, N - NHRP,\n       > - selected route, * - FIB route, q - queued, r - rejected, b - backup\n\nB>* 10.2.2.0/24 [20/0] via 10.0.0.1, Ethernet0, weight 1, 00:01:00\n  *                    via 10.0.0.5, Ethernet4, weight 1, 00:01:00\nC>* 10.0.0.0/31 is directly connected, Ethernet0, 00:10:00\n";
        let got = crate::routes::parse_routes(table);
        let r = got.iter().find(|r| r.prefix == "10.2.2.0/24").expect("the BGP route");
        assert_eq!(r.protocol, "bgp");
        assert_eq!(r.next_hops, ["10.0.0.1", "10.0.0.5"]);
    }
}
