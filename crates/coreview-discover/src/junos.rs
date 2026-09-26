//! Junos identity: what a Juniper EX, QFX, SRX or MX says about itself and
//! what is plugged into it (LT-466).
//!
//! **Built from Juniper's documentation and from sessions people have posted,
//! not from a device on the bench (D-058).** Every fixture below is
//! reconstructed to the documented layout, and [`verified_against_hardware`]
//! answers `false` until a capture from a real device has replaced one. The
//! routing, VRF and overlay readers for this platform are in `routes`,
//! `vrftables` and `overlay` (LT-352) and stand under the same rule.
//!
//! What is read, and from which command:
//!
//! - `show version` — `Hostname:`, `Model:`, `Junos:`.
//! - `show chassis hardware` — the chassis line, whose second column is the
//!   serial. On a Virtual Chassis every member's chassis line is listed and
//!   every serial is kept, in order.
//! - `show interfaces terse` — logical units with an `inet` address; a unit
//!   is up when both Admin and Link say `up`.
//! - `show lldp neighbors` — the five-column table; Junos has no CDP.
//! - `show ethernet-switching table` — the learned MACs per logical
//!   interface, with the VLAN name.
//! - `show lacp interfaces` — each `Aggregated interface: aeN` block and the
//!   `Actor` rows beneath it, which name the members once each.

use crate::arp::normalise_mac;
use crate::cdp::short_name;
use crate::etherchannel::PortChannel;
use crate::interfaces::Interface;
use crate::mac_table::MacEntry;
use crate::types::{DeviceClass, Neighbor, Protocol};

/// D-058: this platform has not met a device.
pub fn verified_against_hardware() -> bool {
    false
}

/// The value after a `Label:` line, trimmed.
fn labelled<'a>(out: &'a str, label: &str) -> Option<&'a str> {
    out.lines().find_map(|l| {
        let t = l.trim();
        let (k, v) = t.split_once(':')?;
        k.trim().eq_ignore_ascii_case(label).then(|| v.trim()).filter(|v| !v.is_empty())
    })
}

/// `Model: ex4300-48t`, upper-cased the way the classifier's lists are.
pub fn model_of(version: &str) -> Option<String> {
    labelled(version, "Model").map(|m| m.to_ascii_uppercase())
}

/// `Hostname: core-ex1`.
pub fn hostname_of(version: &str) -> Option<String> {
    labelled(version, "Hostname").map(str::to_string)
}

/// Every chassis serial in `show chassis hardware`, in the order listed.
///
/// ```text
/// Hardware inventory:
/// Item             Version  Part number  Serial number     Description
/// Chassis                                PE3717190123      EX4300-48T
/// FPC 0            REV 12   650-044932   PE3717190123      EX4300-48T
/// ```
pub fn serials_of(chassis_hardware: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in chassis_hardware.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // `Chassis <serial> <description>` on a single chassis; on a Virtual
        // Chassis the item is `Chassis` on the first member and the members
        // follow as `FPC n` lines, whose serials repeat the chassis ones.
        if fields.first() == Some(&"Chassis") && fields.len() >= 3 {
            let serial = fields[1].to_string();
            if !out.contains(&serial) {
                out.push(serial);
            }
        }
    }
    out
}

/// `show interfaces terse`: the logical units carrying an `inet` address.
///
/// ```text
/// Interface               Admin Link Proto    Local                 Remote
/// ge-0/0/0                up    up
/// ge-0/0/0.0              up    up   inet     10.1.1.1/24
/// irb.100                 up    up   inet     192.168.100.1/24
/// lo0.0                   up    up   inet     10.255.0.1          --> 0/0
/// ```
pub fn parse_interfaces_terse(out: &str) -> Vec<Interface> {
    let mut found = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 5 || f[3] != "inet" {
            continue;
        }
        let up = f[1].eq_ignore_ascii_case("up") && f[2].eq_ignore_ascii_case("up");
        let address = f[4].split('/').next().unwrap_or("").to_string();
        if address.parse::<std::net::Ipv4Addr>().is_err() {
            continue;
        }
        found.push(Interface { name: f[0].to_string(), address: Some(address), up });
    }
    found
}

/// `show lldp neighbors`, the table.
///
/// ```text
/// Local Interface    Parent Interface    Chassis Id          Port info          System Name
/// ge-0/0/1           -                   00:1c:73:aa:bb:cc   Ethernet1          leaf1
/// ge-0/0/2           ae0                 2c:6b:f5:00:11:22   xe-0/0/3           core-qfx.example.test
/// ```
///
/// `Port info` is the neighbour's port description when it advertised one and
/// its port id when not; either is the far interface as far as a cable is
/// concerned. A row with no system name is named by its chassis id.
pub fn parse_lldp_neighbors(out: &str) -> Vec<Neighbor> {
    let lines: Vec<&str> = out.lines().collect();
    let Some(at) = lines.iter().position(|l| l.contains("Local Interface") && l.contains("Chassis Id")) else {
        return Vec::new();
    };
    lines[at + 1..]
        .iter()
        .filter_map(|row| {
            let f: Vec<&str> = row.split_whitespace().collect();
            if f.len() < 4 {
                return None;
            }
            let local = f[0].to_string();
            let chassis = f[2].to_string();
            let remote_port = f[3].to_string();
            let name = f.get(4).map(|s| s.to_string()).filter(|s| !s.is_empty() && s != "-");
            let device_id = name.unwrap_or_else(|| chassis.clone());
            let mac = normalise_mac(&chassis);
            Some(Neighbor {
                serial: None,
                short_name: short_name(&device_id),
                device_id,
                addresses: Vec::new(),
                local_interface: Some(local),
                remote_interface: (remote_port != "-").then_some(remote_port),
                platform: None,
                capabilities: Vec::new(),
                version: None,
                class: DeviceClass::Unknown,
                discovered_by: Protocol::Lldp,
                vendor: mac.as_deref().and_then(crate::oui::vendor).map(str::to_string),
                chassis_id: mac,
            })
        })
        .collect()
}

/// `show ethernet-switching table`.
///
/// ```text
/// MAC flags (S - static MAC, D - dynamic MAC, L - locally learned, P - Persistent static
///            SE - statistics enabled, NM - non configured MAC, R - remote PE MAC, O - ovsdb MAC)
///
/// Ethernet switching table : 3 entries, 3 learned
/// Routing instance : default-switch
///    Vlan                MAC                 MAC         Age    Logical                NH        RTR
///    name                address             flags              interface              Index     ID
///    v100                00:50:56:aa:bb:cc   D             -   ge-0/0/3.0             0         0
///    v100                00:1c:73:aa:bb:cc   D             -   ae0.0                  0         0
/// ```
///
/// The MAC is the first field that reads as one, the VLAN the field before
/// it, and the logical interface the first field after it that is not a flag
/// or an age.
pub fn parse_switching_table(out: &str) -> Vec<MacEntry> {
    let mut found = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        let Some(at) = f.iter().position(|w| normalise_mac(w).is_some() && w.contains(':')) else {
            continue;
        };
        if at == 0 {
            continue;
        }
        let Some(mac) = normalise_mac(f[at]) else { continue };
        let port = f[at + 1..]
            .iter()
            .find(|w| w.contains('/') || w.starts_with("ae") || w.starts_with("irb") || w.starts_with("et-") || w.starts_with("xe-") || w.starts_with("ge-"))
            .map(|w| w.trim_end_matches(".0").to_string());
        let Some(port) = port else { continue };
        found.push(MacEntry { mac, port, vlan: Some(f[at - 1].to_string()) });
    }
    found
}

/// `show lacp interfaces`: each bundle and its members.
///
/// ```text
/// Aggregated interface: ae0
///     LACP state:       Role   Exp   Def  Dist  Col  Syn  Aggr  Timeout  Activity
///       ge-0/0/10       Actor    No    No   Yes  Yes  Yes   Yes     Fast    Active
///       ge-0/0/10     Partner    No    No   Yes  Yes  Yes   Yes     Fast    Active
///       ge-0/0/11       Actor    No    No   Yes  Yes  Yes   Yes     Fast    Active
///       ge-0/0/11     Partner    No    No   Yes  Yes  Yes   Yes     Fast    Active
///     LACP protocol:        Receive State  Transmit State          Mux State
///       ge-0/0/10                  Current   Fast periodic         Collecting distributing
/// ```
///
/// The `Actor` rows name the members once each; the `Partner` rows and the
/// protocol block repeat them and are skipped.
pub fn parse_lacp_interfaces(out: &str) -> Vec<PortChannel> {
    let mut out_channels: Vec<PortChannel> = Vec::new();
    for line in out.lines() {
        let t = line.trim();
        if let Some(name) = t.strip_prefix("Aggregated interface:") {
            out_channels.push(PortChannel { name: name.trim().to_string(), protocol: "LACP".into(), members: Vec::new() });
            continue;
        }
        let f: Vec<&str> = t.split_whitespace().collect();
        if f.len() >= 2 && f[1] == "Actor" {
            if let Some(current) = out_channels.last_mut() {
                let member = f[0].to_string();
                if !current.members.contains(&member) {
                    current.members.push(member);
                }
            }
        }
    }
    out_channels.retain(|c| !c.members.is_empty());
    out_channels
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reconstructed from Juniper's documentation (D-058), not captured.
    const VERSION: &str = "Hostname: core-ex1\nModel: ex4300-48t\nJunos: 21.4R3-S1.5\nJUNOS OS Kernel 64-bit  [20230317.7a3b6a9_builder_stable_12_224]\n";
    const HARDWARE: &str = "Hardware inventory:\nItem             Version  Part number  Serial number     Description\nChassis                                PE3717190123      EX4300-48T\nPseudo CB 0\nRouting Engine 0          BUILTIN      BUILTIN           EX4300-48T\nFPC 0            REV 12   650-044932   PE3717190123      EX4300-48T\n";
    const TERSE: &str = "Interface               Admin Link Proto    Local                 Remote\nge-0/0/0                up    up\nge-0/0/0.0              up    up   inet     10.1.1.1/24\nge-0/0/1                up    down\nge-0/0/1.0              up    down inet     10.1.2.1/24\nirb.100                 up    up   inet     192.168.100.1/24\nlo0.0                   up    up   inet     10.255.0.1          --> 0/0\n";
    const LLDP: &str = "Local Interface    Parent Interface    Chassis Id          Port info          System Name\nge-0/0/1           -                   00:1c:73:aa:bb:cc   Ethernet1          leaf1\nge-0/0/2           ae0                 2c:6b:f5:00:11:22   xe-0/0/3           core-qfx.example.test\nge-0/0/7           -                   00:50:56:00:00:07   -                  \n";
    const SWITCHING: &str = "MAC flags (S - static MAC, D - dynamic MAC, L - locally learned)\n\nEthernet switching table : 2 entries, 2 learned\nRouting instance : default-switch\n   Vlan                MAC                 MAC         Age    Logical                NH        RTR\n   name                address             flags              interface              Index     ID\n   v100                00:50:56:aa:bb:cc   D             -   ge-0/0/3.0             0         0\n   v100                00:1c:73:aa:bb:cc   D             -   ae0.0                  0         0\n";
    const LACP: &str = "Aggregated interface: ae0\n    LACP state:       Role   Exp   Def  Dist  Col  Syn  Aggr  Timeout  Activity\n      ge-0/0/10       Actor    No    No   Yes  Yes  Yes   Yes     Fast    Active\n      ge-0/0/10     Partner    No    No   Yes  Yes  Yes   Yes     Fast    Active\n      ge-0/0/11       Actor    No    No   Yes  Yes  Yes   Yes     Fast    Active\n      ge-0/0/11     Partner    No    No   Yes  Yes  Yes   Yes     Fast    Active\n    LACP protocol:        Receive State  Transmit State          Mux State\n      ge-0/0/10                  Current   Fast periodic         Collecting distributing\n";

    #[test]
    fn identity_comes_off_show_version_and_show_chassis_hardware() {
        assert_eq!(model_of(VERSION).as_deref(), Some("EX4300-48T"));
        assert_eq!(hostname_of(VERSION).as_deref(), Some("core-ex1"));
        assert_eq!(serials_of(HARDWARE), ["PE3717190123"]);
        assert_eq!(crate::classify::classify(model_of(VERSION).as_deref(), &[], None), DeviceClass::Switch);
        assert_eq!(crate::classify::classify(Some("SRX345"), &[], None), DeviceClass::Firewall);
        assert!(!verified_against_hardware(), "D-058: says so until it has met a device");
    }

    #[test]
    fn addresses_come_off_the_inet_units_and_a_down_link_is_down() {
        let got = parse_interfaces_terse(TERSE);
        let names: Vec<(&str, &str, bool)> = got.iter().map(|i| (i.name.as_str(), i.address.as_deref().unwrap(), i.up)).collect();
        assert_eq!(names, [("ge-0/0/0.0", "10.1.1.1", true), ("ge-0/0/1.0", "10.1.2.1", false), ("irb.100", "192.168.100.1", true), ("lo0.0", "10.255.0.1", true)]);
    }

    #[test]
    fn neighbours_come_off_the_lldp_table_and_a_nameless_one_is_its_chassis() {
        let got = parse_lldp_neighbors(LLDP);
        assert_eq!(got.len(), 3);
        assert_eq!((got[0].short_name.as_str(), got[0].local_interface.as_deref(), got[0].remote_interface.as_deref()), ("leaf1", Some("ge-0/0/1"), Some("Ethernet1")));
        assert_eq!(got[1].short_name, "core-qfx");
        assert_eq!(got[1].chassis_id.as_deref(), Some("2c6bf5001122"));
        assert_eq!(got[2].device_id, "00:50:56:00:00:07");
        assert_eq!(got[2].remote_interface, None);
        assert!(got.iter().all(|n| n.discovered_by == Protocol::Lldp));
        assert!(parse_lldp_neighbors("                 ^\nunknown command.\n").is_empty());
    }

    #[test]
    fn the_switching_table_and_the_lacp_members_are_read() {
        let macs = parse_switching_table(SWITCHING);
        assert_eq!(macs.len(), 2);
        assert_eq!((macs[0].mac.as_str(), macs[0].port.as_str(), macs[0].vlan.as_deref()), ("005056aabbcc", "ge-0/0/3", Some("v100")));
        assert_eq!(macs[1].port, "ae0");
        let lacp = parse_lacp_interfaces(LACP);
        assert_eq!(lacp.len(), 1);
        assert_eq!((lacp[0].name.as_str(), lacp[0].protocol.as_str()), ("ae0", "LACP"));
        assert_eq!(lacp[0].members, ["ge-0/0/10", "ge-0/0/11"]);
    }
}
