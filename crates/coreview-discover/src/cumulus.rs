//! NVIDIA Cumulus Linux 4.x — the NVIDIA / Mellanox SN2010 the operator
//! runs.
//!
//! **Built from NVIDIA's Cumulus Linux 4.4 documentation and the references
//! the operator gave, not from a switch.** Neither reference carried
//! sample output, so every fixture below is reconstructed to the documented
//! layout, and the dialect reports unverified until a support capture
//! replaces them.
//!
//! Cumulus is Debian underneath and an SSH login lands in bash
//! (`cumulus@leaf01:mgmt:~$`). There is no `show version` — bash answers
//! `command not found`, which [`crate::cli::command_was_rejected`] now
//! treats as the refusal it is — so the platform is recognised from
//! `net show system`. The tables are read the way the platform itself
//! reads them:
//!
//! - `net show system` — dotted labels: `Hostname.........`,
//!   `Model............`, `Serial Number....`, `Build............`.
//! - `lldpctl` — lldpd's own layout, the one EdgeOS and VyOS print, read by
//!   [`crate::vyatta::parse_lldp_detail`]; it carries the management address
//!   the crawl needs to go on. NCLU's `net show lldp` table is the fallback
//!   and names the neighbour without one.
//! - `ip -4 -o addr show` — one address per line.
//! - `ip neigh show` — the ARP table, which the ordinary reader reads.
//! - `bridge fdb show` — the MAC table; the switch's own entries are dropped.
//! - `net show interface bonds` — each bond and its members.
//! - `net show route` — FRR's table, which the route reader already knows.

use crate::arp::normalise_mac;
use crate::etherchannel::PortChannel;
use crate::interfaces::Interface;
use crate::mac_table::MacEntry;
use crate::types::{DeviceClass, Neighbor, Protocol};

/// This platform has not met a device.
pub fn verified_against_hardware() -> bool {
    false
}

/// `Label............ value` — a run of dots between the two.
fn dotted<'a>(out: &'a str, label: &str) -> Option<&'a str> {
    out.lines().find_map(|l| {
        let t = l.trim();
        let rest = t.strip_prefix(label)?;
        let value = rest.trim_start_matches(['.', ' ', ':']).trim();
        (rest.starts_with('.') && !value.is_empty()).then_some(value)
    })
}

/// `Product Name..... MSN2010`, or the longer `Model............`.
pub fn model_of(system: &str) -> Option<String> {
    dotted(system, "Product Name").or_else(|| dotted(system, "Model")).map(|m| m.to_ascii_uppercase())
}

pub fn serials_of(system: &str) -> Vec<String> {
    dotted(system, "Serial Number").map(|s| vec![s.to_string()]).unwrap_or_default()
}

/// `ip -4 -o addr show`:
///
/// ```text
/// 1: lo    inet 127.0.0.1/8 scope host lo\       valid_lft forever preferred_lft forever
/// 1: lo    inet 10.0.0.11/32 scope global lo\       valid_lft forever preferred_lft forever
/// 2: eth0    inet 192.0.2.11/24 brd 192.0.2.255 scope global eth0\       valid_lft forever preferred_lft forever
/// 5: swp51    inet 10.1.1.1/31 scope global swp51\       valid_lft forever preferred_lft forever
/// ```
///
/// The loopback's own 127.0.0.1 is not an address anything reaches it on.
pub fn parse_ip_addr(out: &str) -> Vec<Interface> {
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            let at = f.iter().position(|w| *w == "inet")?;
            let name = f.get(1)?.trim_end_matches(':').split('@').next()?.to_string();
            let ip: std::net::Ipv4Addr = f.get(at + 1)?.split('/').next()?.parse().ok()?;
            (!ip.is_loopback()).then(|| Interface { name, address: Some(ip.to_string()), up: true })
        })
        .collect()
}

/// `bridge fdb show`:
///
/// ```text
/// 44:38:39:00:00:03 dev swp1 vlan 10 master bridge
/// 44:38:39:00:00:05 dev swp2 master bridge
/// 44:38:39:00:00:11 dev swp1 vlan 10 master bridge permanent
/// 33:33:00:00:00:01 dev bridge self permanent
/// ```
///
/// `permanent` is the switch's own address on that port and `self` the
/// bridge itself; neither is a device plugged in.
pub fn parse_bridge_fdb(out: &str) -> Vec<MacEntry> {
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.iter().any(|w| *w == "permanent" || *w == "self") {
                return None;
            }
            let mac = normalise_mac(f.first()?)?;
            let port = f.iter().position(|w| *w == "dev").and_then(|i| f.get(i + 1))?.to_string();
            let vlan = f.iter().position(|w| *w == "vlan").and_then(|i| f.get(i + 1)).map(|v| v.to_string());
            Some(MacEntry { mac, port, vlan })
        })
        .collect()
}

/// `net show interface bonds`:
///
/// ```text
///     Name     Speed   MTU   Mode     Summary
/// --  -------  ------  ----  -------  ----------------------------------
/// UP  bond01   2G      9216  802.3ad  Bond Members: swp1(UP), swp2(UP)
/// UP  peerlink 20G     9216  802.3ad  Bond Members: swp49(UP), swp50(UP)
/// ```
pub fn parse_bonds(out: &str) -> Vec<PortChannel> {
    out.lines()
        .filter_map(|l| {
            let (head, members) = l.split_once("Bond Members:")?;
            let f: Vec<&str> = head.split_whitespace().collect();
            let name = f.get(1)?.to_string();
            let lacp = f.iter().any(|w| *w == "802.3ad" || w.eq_ignore_ascii_case("lacp"));
            let members: Vec<String> = members.split(',').map(|m| m.trim().split('(').next().unwrap_or("").to_string()).filter(|m| !m.is_empty()).collect();
            (!members.is_empty()).then(|| PortChannel { name, protocol: if lacp { "LACP".into() } else { "-".into() }, members })
        })
        .collect()
}

/// NCLU's `net show lldp`, the fallback: a neighbour's name and port, with
/// no address to go on.
///
/// ```text
/// LocalPort  Speed  Mode       RemoteHost  RemotePort
/// ---------  -----  ---------  ----------  ----------
/// eth0       1G     Mgmt       oob-mgmt    swp10
/// swp51      1G     Default    spine01     swp1
/// ```
pub fn parse_net_show_lldp(out: &str) -> Vec<Neighbor> {
    let lines: Vec<&str> = out.lines().collect();
    let Some(at) = lines.iter().position(|l| l.contains("LocalPort") && l.contains("RemoteHost")) else {
        return Vec::new();
    };
    lines[at + 1..]
        .iter()
        .filter(|l| !l.trim().starts_with('-'))
        .filter_map(|row| {
            let f: Vec<&str> = row.split_whitespace().collect();
            if f.len() < 5 {
                return None;
            }
            let device_id = f[f.len() - 2].to_string();
            Some(Neighbor {
                serial: None,
                short_name: crate::cdp::short_name(&device_id),
                device_id,
                addresses: Vec::new(),
                local_interface: Some(f[0].to_string()),
                remote_interface: Some(f[f.len() - 1].to_string()),
                platform: None,
                capabilities: Vec::new(),
                version: None,
                class: DeviceClass::Unknown,
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

    // Reconstructed from NVIDIA's documentation, not captured.
    pub(crate) const SYSTEM: &str = "Hostname......... leaf01\nBuild............ Cumulus Linux 4.4.0\nUptime........... 5 days, 3:44:41.690000\n\nModel............ Mlnx X86 MSN2010\nMemory........... 8GB\nDisk............. 14.9GB\nVendor Name...... Mellanox\nPart Number...... MSN2010-CB2F\nBase MAC Address. 00:00:5E:00:53:01\nSerial Number.... MT0000EXAMPLE\nProduct Name..... MSN2010\n";

    #[test]
    fn identity_comes_off_net_show_system() {
        assert_eq!(crate::dialect::family_of(SYSTEM), crate::dialect::Family::Cumulus);
        assert_eq!(model_of(SYSTEM).as_deref(), Some("MSN2010"));
        assert_eq!(serials_of(SYSTEM), ["MT0000EXAMPLE"]);
        assert!(!verified_against_hardware());
    }

    #[test]
    fn addresses_macs_and_bonds_are_read() {
        let a = parse_ip_addr("1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever\n1: lo    inet 10.0.0.11/32 scope global lo\\       valid_lft forever\n2: eth0    inet 192.0.2.11/24 brd 192.0.2.255 scope global eth0\\       valid_lft forever\n5: swp51    inet 10.1.1.1/31 scope global swp51\\       valid_lft forever\n");
        assert_eq!(a.iter().map(|i| (i.name.as_str(), i.address.as_deref().unwrap())).collect::<Vec<_>>(), [("lo", "10.0.0.11"), ("eth0", "192.0.2.11"), ("swp51", "10.1.1.1")]);
        let m = parse_bridge_fdb("44:38:39:00:00:03 dev swp1 vlan 10 master bridge\n44:38:39:00:00:05 dev swp2 master bridge\n44:38:39:00:00:11 dev swp1 vlan 10 master bridge permanent\n33:33:00:00:00:01 dev bridge self permanent\n");
        assert_eq!(m.iter().map(|e| (e.mac.as_str(), e.port.as_str(), e.vlan.as_deref())).collect::<Vec<_>>(), [("443839000003", "swp1", Some("10")), ("443839000005", "swp2", None)]);
        let b = parse_bonds("    Name     Speed   MTU   Mode     Summary\n--  -------  ------  ----  -------  ----------------------------------\nUP  bond01   2G      9216  802.3ad  Bond Members: swp1(UP), swp2(UP)\n");
        assert_eq!(b.len(), 1);
        assert_eq!((b[0].name.as_str(), b[0].protocol.as_str(), b[0].members.clone()), ("bond01", "LACP", vec!["swp1".to_string(), "swp2".to_string()]));
        let n = parse_net_show_lldp("LocalPort  Speed  Mode       RemoteHost  RemotePort\n---------  -----  ---------  ----------  ----------\neth0       1G     Mgmt       oob-mgmt    swp10\nswp51      1G     Default    spine01     swp1\n");
        assert_eq!(n.iter().map(|x| (x.local_interface.as_deref().unwrap(), x.short_name.as_str(), x.remote_interface.as_deref().unwrap())).collect::<Vec<_>>(), [("eth0", "oob-mgmt", "swp10"), ("swp51", "spine01", "swp1")]);
    }

    #[test]
    fn a_bash_refusal_is_a_refusal_not_an_identity() {
        assert!(crate::cli::command_was_rejected("-bash: show: command not found").is_some());
        assert!(crate::cli::command_was_rejected("-bash: /system: No such file or directory").is_some());
        assert!(!crate::dialect::identifies("-bash: show: command not found"));
        assert!(crate::dialect::identifies(SYSTEM));
    }
}
