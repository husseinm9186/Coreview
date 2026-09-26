//! Huawei VRP identity and tables (LT-472).
//!
//! **Built from Huawei's documentation and posted sessions, not from a device
//! (D-058).** Fixtures reconstructed; [`verified_against_hardware`] says
//! `false` until one is a capture.
//!
//! - `display version` — `Huawei Versatile Routing Platform Software`, then
//!   `HUAWEI S5720-28X-SI-AC Routing Switch uptime is …`: the model is the
//!   word after `HUAWEI`.
//! - `display esn` — `ESN of slot 0: 2102…`, the serial.
//! - `display ip interface brief` — Interface, IP Address/Mask, Physical,
//!   Protocol.
//! - `display lldp neighbor brief` — Local Intf, Neighbor Dev, Neighbor
//!   Intf, Exptime.
//! - `display arp` — read by the ordinary ARP reader.
//! - `display mac-address` — read by Comware's MAC reader; the columns agree.
//! - `display ip routing-table` — read by Comware's table reader, by shape.
//! - `display eth-trunk` — each `Eth-TrunkN` and its `ActorPortName` rows.
//!
//! Paging is `screen-length 0 temporary`; the prompt is `<host>` or `[host]`.

use crate::cdp::short_name;
use crate::etherchannel::PortChannel;
use crate::interfaces::Interface;
use crate::types::{DeviceClass, Neighbor, Protocol};

/// D-058: this platform has not met a device.
pub fn verified_against_hardware() -> bool {
    false
}

/// `HUAWEI S5720-28X-SI-AC Routing Switch uptime is 12 weeks`: the word
/// after `HUAWEI`.
pub fn model_of(version: &str) -> Option<String> {
    version.lines().find_map(|l| {
        let t = l.trim();
        if !t.contains(" uptime is ") {
            return None;
        }
        let rest = t.strip_prefix("HUAWEI ").or_else(|| t.strip_prefix("Huawei "))?;
        let model = rest.split_whitespace().next()?;
        (!model.is_empty()).then(|| model.to_ascii_uppercase())
    })
}

/// `ESN of slot 0: 210235448310G1000123` — or a bare `ESN: …` — each once.
pub fn serials_of(esn: &str) -> Vec<String> {
    let mut out = Vec::new();
    for l in esn.lines() {
        let t = l.trim();
        if !t.starts_with("ESN") {
            continue;
        }
        if let Some((_, v)) = t.split_once(':') {
            let v = v.trim().to_string();
            if !v.is_empty() && !out.contains(&v) {
                out.push(v);
            }
        }
    }
    out
}

/// `display ip interface brief`.
///
/// ```text
/// *down: administratively down
/// ^down: standby
/// (l): loopback
/// (s): spoofing
/// The number of interface that is UP in Physical is 3
/// ...
/// Interface                         IP Address/Mask      Physical   Protocol
/// GigabitEthernet0/0/1              10.0.0.1/24          up         up
/// Vlanif10                          10.0.10.1/24         up         up
/// Vlanif20                          unassigned           down       down
/// ```
pub fn parse_ip_interface_brief(out: &str) -> Vec<Interface> {
    let mut found = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 4 || f[0] == "Interface" {
            continue;
        }
        let address = f[1].split('/').next().unwrap_or("");
        if address.parse::<std::net::Ipv4Addr>().is_err() {
            continue;
        }
        let up = f[2].eq_ignore_ascii_case("up") && f[3].eq_ignore_ascii_case("up");
        found.push(Interface { name: f[0].to_string(), address: Some(address.to_string()), up });
    }
    found
}

/// `display lldp neighbor brief`.
///
/// ```text
/// Local Intf    Neighbor Dev         Neighbor Intf     Exptime
/// GE0/0/1       leaf1                Ethernet3         98
/// GE0/0/24      core-2               GE1/0/24          101
/// ```
pub fn parse_lldp_neighbor_brief(out: &str) -> Vec<Neighbor> {
    let lines: Vec<&str> = out.lines().collect();
    let Some(at) = lines.iter().position(|l| l.contains("Local Intf") && l.contains("Neighbor Dev")) else {
        return Vec::new();
    };
    lines[at + 1..]
        .iter()
        .filter_map(|row| {
            let f: Vec<&str> = row.split_whitespace().collect();
            if f.len() < 3 {
                return None;
            }
            let device_id = f[1].to_string();
            Some(Neighbor {
                serial: None,
                short_name: short_name(&device_id),
                device_id,
                addresses: Vec::new(),
                local_interface: Some(f[0].to_string()),
                remote_interface: Some(f[2].to_string()),
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

/// `display eth-trunk`.
///
/// ```text
/// Eth-Trunk1's state information is:
/// WorkingMode: LACP
/// Preempt Delay: Disabled
/// ...
/// Local:
/// LAG ID: 1                   WorkingMode: LACP
/// ...
/// ActorPortName          Status   PortType PortPri PortNo PortKey PortState Weight
/// GigabitEthernet0/0/1   Selected 1GE      32768   2      305     10111100  1
/// GigabitEthernet0/0/2   Selected 1GE      32768   3      305     10111100  1
///
/// Partner:
/// ActorPortName          SysPri   SystemID        PortPri PortNo PortKey PortState
/// GigabitEthernet0/0/1   32768    001c-73aa-bbcc  32768   1      305     10111100
/// ```
///
/// The members are the rows after `ActorPortName` under `Local:` (or, on a
/// manual trunk, under `PortName`); the `Partner:` rows repeat them.
pub fn parse_eth_trunk(out: &str) -> Vec<PortChannel> {
    let mut channels: Vec<PortChannel> = Vec::new();
    let mut in_members = false;
    let mut in_partner = false;
    for line in out.lines() {
        let t = line.trim();
        if let Some(name) = t.strip_suffix("'s state information is:") {
            channels.push(PortChannel { name: name.trim().to_string(), protocol: "-".into(), members: Vec::new() });
            in_members = false;
            in_partner = false;
        } else if let Some(mode) = t.strip_prefix("WorkingMode:") {
            if let Some(c) = channels.last_mut() {
                if c.protocol == "-" {
                    c.protocol = if mode.trim().eq_ignore_ascii_case("lacp") { "LACP".into() } else { "-".into() };
                }
            }
        } else if t.starts_with("Partner:") {
            in_partner = true;
            in_members = false;
        } else if t.starts_with("Local:") {
            in_partner = false;
        } else if t.starts_with("ActorPortName") || t.starts_with("PortName") {
            in_members = !in_partner;
        } else if t.is_empty() {
            in_members = false;
        } else if in_members {
            let f: Vec<&str> = t.split_whitespace().collect();
            if f.len() >= 2 && f[0].chars().any(|c| c.is_ascii_digit()) {
                if let Some(c) = channels.last_mut() {
                    if !c.members.contains(&f[0].to_string()) {
                        c.members.push(f[0].to_string());
                    }
                }
            }
        }
    }
    channels.retain(|c| !c.members.is_empty());
    channels
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reconstructed from Huawei's documentation (D-058), not captured.
    const VERSION: &str = "Huawei Versatile Routing Platform Software\nVRP (R) software, Version 5.170 (S5720 V200R019C10SPC500)\nCopyright (C) 2000-2020 HUAWEI TECH CO., LTD\nHUAWEI S5720-28X-SI-AC Routing Switch uptime is 12 weeks, 3 days, 4 hours, 5 minutes\n";
    const ESN: &str = "ESN of slot 0: 210235448310G1000123\n";
    const BRIEF: &str = "*down: administratively down\n^down: standby\n(l): loopback\n(s): spoofing\nThe number of interface that is UP in Physical is 3\nThe number of interface that is DOWN in Physical is 1\n\nInterface                         IP Address/Mask      Physical   Protocol\nGigabitEthernet0/0/1              10.0.0.1/24          up         up\nVlanif10                          10.0.10.1/24         up         up\nVlanif20                          unassigned           down       down\n";
    const LLDP: &str = "Local Intf    Neighbor Dev         Neighbor Intf     Exptime\nGE0/0/1       leaf1                Ethernet3         98\nGE0/0/24      core-2               GE1/0/24          101\n";
    const MACS: &str = "MAC Address    VLAN/VSI/BD   Learned-From        Type\n0050-56aa-bbcc 10/-/-        GE0/0/3             dynamic\n";
    const TRUNK: &str = "Eth-Trunk1's state information is:\nWorkingMode: LACP\nPreempt Delay: Disabled\nHash arithmetic: According to SIP-XOR-DIP\nSystem Priority: 32768      System ID: 0000-5e00-0101\nLeast Active-linknumber: 1  Max Active-linknumber: 8\nOperate status: up          Number Of Up Port In Trunk: 2\n--------------------------------------------------------------------------------\nActorPortName          Status   PortType PortPri PortNo PortKey PortState Weight\nGigabitEthernet0/0/1   Selected 1GE      32768   2      305     10111100  1\nGigabitEthernet0/0/2   Selected 1GE      32768   3      305     10111100  1\n\nPartner:\n--------------------------------------------------------------------------------\nActorPortName          SysPri   SystemID        PortPri PortNo PortKey PortState\nGigabitEthernet0/0/1   32768    001c-73aa-bbcc  32768   1      305     10111100\nGigabitEthernet0/0/2   32768    001c-73aa-bbcc  32768   2      305     10111100\n";

    #[test]
    fn identity_comes_off_the_uptime_line_and_the_esn() {
        assert_eq!(crate::dialect::family_of(VERSION), crate::dialect::Family::HuaweiVrp);
        assert_eq!(model_of(VERSION).as_deref(), Some("S5720-28X-SI-AC"));
        assert_eq!(serials_of(ESN), ["210235448310G1000123"]);
        assert!(!verified_against_hardware());
    }

    #[test]
    fn the_tables_are_read() {
        let brief = parse_ip_interface_brief(BRIEF);
        assert_eq!(brief.iter().map(|i| (i.name.as_str(), i.address.as_deref().unwrap(), i.up)).collect::<Vec<_>>(), [("GigabitEthernet0/0/1", "10.0.0.1", true), ("Vlanif10", "10.0.10.1", true)]);
        let lldp = parse_lldp_neighbor_brief(LLDP);
        assert_eq!(lldp.iter().map(|n| (n.short_name.as_str(), n.local_interface.as_deref().unwrap(), n.remote_interface.as_deref().unwrap())).collect::<Vec<_>>(), [("leaf1", "GE0/0/1", "Ethernet3"), ("core-2", "GE0/0/24", "GE1/0/24")]);
        let macs = crate::comware::parse_mac_address(MACS);
        assert_eq!(macs.iter().map(|m| (m.mac.as_str(), m.port.as_str(), m.vlan.as_deref())).collect::<Vec<_>>(), [("005056aabbcc", "GE0/0/3", Some("10"))]);
        let trunk = parse_eth_trunk(TRUNK);
        assert_eq!(trunk.len(), 1);
        assert_eq!((trunk[0].name.as_str(), trunk[0].protocol.as_str(), trunk[0].members.clone()), ("Eth-Trunk1", "LACP", vec!["GigabitEthernet0/0/1".to_string(), "GigabitEthernet0/0/2".to_string()]));
    }
}
