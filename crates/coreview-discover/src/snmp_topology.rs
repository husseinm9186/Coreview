//! What a device reached only over SNMP says about its links and ports
//! (LT-134).
//!
//! A device the crawl could not log into but could identify over SNMP used to
//! be drawn as a box with no links. The standard MIBs carry both halves of what
//! the SSH path reads from the CLI: LLDP-MIB its neighbours, and BRIDGE-MIB /
//! Q-BRIDGE-MIB the MAC addresses learned on its ports.
//!
//! **Written against measured tables, not the MIB alone** (structure only was
//! recorded, in the roadmap). What the lab devices actually returned decides
//! every rule here:
//!
//! * The management-address index is `…remIndex.subtype.len.a.b.c.d` on a
//!   Cisco and `…remIndex.subtype.a.b.c.d` — **no length byte** — on a
//!   FortiSwitch. Both are read. IPv6 is ignored, as the CLI parser ignores it,
//!   because the subnet filter is IPv4.
//! * A Cisco neighbour came back with an **empty system name**, so a neighbour
//!   is named by its chassis id when it has no name.
//! * Remote port ids are MACs as often as names, so a port id is rendered by
//!   its subtype, and a readable port description is preferred for the label.
//! * On a Cisco the forwarding table's port numbers are **bridge ports** and
//!   must go through `dot1dBasePortIfIndex`. A UniFi switch has no such table
//!   and its port numbers are interface indexes. Without the map, a port number
//!   is taken as an interface index only when **every** one of them is a known
//!   interface; otherwise nothing is guessed.
//! * A FortiSwitch's `dot1dTpFdbPort` is not the standard table — its index is
//!   a one-part counter, not a MAC — so any row whose index is not a MAC is
//!   refused rather than trusted by the table's name.
//! * Over SNMP a Cisco's forwarding table covers VLAN 1 only; other VLANs live
//!   in per-VLAN contexts this does not open.

use std::collections::{BTreeSet, HashMap};
use std::net::Ipv4Addr;
use std::time::Duration;

use crate::crawl::AttachedDevice;
use crate::mac_table::MacEntry;
use crate::snmp::{SnmpAuth, SnmpError, Walked};
use crate::types::{DeviceAddress, Neighbor, Protocol};

/// `lldpRemEntry`; a column number is appended.
const LLDP_REM_ENTRY: &[u64] = &[1, 0, 8802, 1, 1, 2, 1, 4, 1, 1];
const LLDP_REM_MAN_ADDR_IF_SUBTYPE: &[u64] = &[1, 0, 8802, 1, 1, 2, 1, 4, 2, 1, 3];
const LLDP_LOC_PORT_ID_SUBTYPE: &[u64] = &[1, 0, 8802, 1, 1, 2, 1, 3, 7, 1, 2];
const LLDP_LOC_PORT_ID: &[u64] = &[1, 0, 8802, 1, 1, 2, 1, 3, 7, 1, 3];
const IF_NAME: &[u64] = &[1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 1];
const DOT1D_BASE_PORT_IF_INDEX: &[u64] = &[1, 3, 6, 1, 2, 1, 17, 1, 4, 1, 2];
const DOT1D_TP_FDB_PORT: &[u64] = &[1, 3, 6, 1, 2, 1, 17, 4, 3, 1, 2];
const DOT1D_TP_FDB_STATUS: &[u64] = &[1, 3, 6, 1, 2, 1, 17, 4, 3, 1, 3];
const DOT1Q_TP_FDB_PORT: &[u64] = &[1, 3, 6, 1, 2, 1, 17, 7, 1, 2, 2, 1, 2];
const DOT1Q_TP_FDB_STATUS: &[u64] = &[1, 3, 6, 1, 2, 1, 17, 7, 1, 2, 2, 1, 3];

/// Forwarding and neighbour tables can be large on a core switch.
const MAX_ROWS: usize = 16_384;

/// `dot1dTpFdbStatus` / `dot1qTpFdbStatus` for an address learned from traffic.
/// The others — `self`, `mgmt`, `invalid` — are not devices plugged in.
const FDB_STATUS_LEARNED: i64 = 3;

/// LLDP chassis and port id subtypes this renders specially.
const CHASSIS_MAC: i64 = 4;
const CHASSIS_NETWORK_ADDRESS: i64 = 5;
const PORT_MAC: i64 = 3;
const PORT_NETWORK_ADDRESS: i64 = 4;

/// One walked column: `(index after the column, value)`.
pub type Column = Vec<(String, Walked)>;

/// The LLDP-MIB columns a neighbour is built from.
#[derive(Debug, Default, Clone)]
pub struct LldpColumns {
    pub chassis_subtype: Column,
    pub chassis_id: Column,
    pub port_subtype: Column,
    pub port_id: Column,
    pub port_desc: Column,
    pub sys_name: Column,
    pub sys_desc: Column,
    pub caps_enabled: Column,
    pub man_addr: Column,
    pub loc_port_subtype: Column,
    pub loc_port_id: Column,
}

/// The bridge columns attached devices are built from.
#[derive(Debug, Default, Clone)]
pub struct BridgeColumns {
    pub if_name: Column,
    pub base_port_if_index: Column,
    pub fdb_port: Column,
    pub fdb_status: Column,
    pub qfdb_port: Column,
    pub qfdb_status: Column,
}

/// What a device reached over SNMP said about its links and ports.
#[derive(Debug, Default, Clone)]
pub struct SnmpTopology {
    pub neighbors: Vec<Neighbor>,
    pub mac_entries: Vec<MacEntry>,
}

/// Reads a device's LLDP and bridge tables over one session, with a credential
/// already known to work. Best effort per table: a table a device does not
/// implement comes back empty and costs nothing else.
pub async fn read_topology(host: &str, auth: &SnmpAuth, timeout: Duration) -> Result<SnmpTopology, SnmpError> {
    let mut session = Box::pin(crate::snmp::open_session(host, 161, auth, timeout)).await?;
    let rem = |n: u64| {
        let mut oid = LLDP_REM_ENTRY.to_vec();
        oid.push(n);
        oid
    };
    let mut lldp = LldpColumns::default();
    for (slot, oid) in [
        (&mut lldp.chassis_subtype, rem(4)),
        (&mut lldp.chassis_id, rem(5)),
        (&mut lldp.port_subtype, rem(6)),
        (&mut lldp.port_id, rem(7)),
        (&mut lldp.port_desc, rem(8)),
        (&mut lldp.sys_name, rem(9)),
        (&mut lldp.sys_desc, rem(10)),
        (&mut lldp.caps_enabled, rem(12)),
        (&mut lldp.man_addr, LLDP_REM_MAN_ADDR_IF_SUBTYPE.to_vec()),
        (&mut lldp.loc_port_subtype, LLDP_LOC_PORT_ID_SUBTYPE.to_vec()),
        (&mut lldp.loc_port_id, LLDP_LOC_PORT_ID.to_vec()),
    ] {
        *slot = crate::snmp::walk_limited(&mut session, &oid, timeout, MAX_ROWS).await;
    }
    let mut bridge = BridgeColumns::default();
    for (slot, oid) in [
        (&mut bridge.if_name, IF_NAME),
        (&mut bridge.base_port_if_index, DOT1D_BASE_PORT_IF_INDEX),
        (&mut bridge.fdb_port, DOT1D_TP_FDB_PORT),
        (&mut bridge.fdb_status, DOT1D_TP_FDB_STATUS),
        (&mut bridge.qfdb_port, DOT1Q_TP_FDB_PORT),
        (&mut bridge.qfdb_status, DOT1Q_TP_FDB_STATUS),
    ] {
        *slot = crate::snmp::walk_limited(&mut session, oid, timeout, MAX_ROWS).await;
    }
    Ok(SnmpTopology { neighbors: lldp_neighbors(&lldp), mac_entries: fdb_entries(&bridge) })
}

fn ints(col: &Column) -> HashMap<&str, i64> {
    col.iter()
        .filter_map(|(i, v)| match v {
            Walked::Int(n) => Some((i.as_str(), *n)),
            _ => None,
        })
        .collect()
}

fn octets(col: &Column) -> HashMap<&str, &[u8]> {
    col.iter()
        .filter_map(|(i, v)| match v {
            Walked::Octets(b) => Some((i.as_str(), b.as_slice())),
            _ => None,
        })
        .collect()
}

/// Printable text, trimmed; `None` for anything binary or empty.
fn text(bytes: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(bytes).ok()?.trim();
    (!s.is_empty() && s.chars().all(|c| !c.is_control())).then(|| s.to_string())
}

fn mac_colons(bytes: &[u8]) -> Option<String> {
    (bytes.len() == 6).then(|| bytes.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":"))
}

/// An LLDP network address: an IANA family byte (1 = IPv4), then the address.
fn network_address(bytes: &[u8]) -> Option<String> {
    match bytes {
        [1, a, b, c, d] => Some(Ipv4Addr::new(*a, *b, *c, *d).to_string()),
        _ => None,
    }
}

/// A chassis or port id, rendered by its subtype.
fn render_id(subtype: Option<i64>, bytes: &[u8], mac_subtype: i64, network_subtype: i64) -> Option<String> {
    match subtype {
        Some(s) if s == mac_subtype => mac_colons(bytes),
        Some(s) if s == network_subtype => network_address(bytes),
        _ => text(bytes).or_else(|| mac_colons(bytes)),
    }
}

/// LLDP's system-capabilities bitmap as the words the CLI shows, which is what
/// `classify` reads. Bit 0 is the most significant bit of the first octet.
fn capability_words(bits: &[u8]) -> Vec<String> {
    let b = bits.first().copied().unwrap_or(0);
    [
        (0x80, "Other"),
        (0x40, "Repeater"),
        (0x20, "Bridge"),
        (0x10, "WLAN Access Point"),
        (0x08, "Router"),
        (0x04, "Telephone"),
        (0x02, "DOCSIS Cable Device"),
        (0x01, "Station Only"),
    ]
    .iter()
    .filter(|(mask, _)| b & mask != 0)
    .map(|(_, word)| word.to_string())
    .collect()
}

/// A management-address row's neighbour key (`timeMark.localPort.remIndex`)
/// and IPv4 address, with or without the length byte before the address.
fn management_address(index: &str) -> Option<(String, Ipv4Addr)> {
    let parts: Vec<u32> = index.split('.').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    if parts.len() < 8 || parts[3] != 1 {
        return None;
    }
    let address = match &parts[4..] {
        [a, b, c, d] => [*a, *b, *c, *d],
        [4, a, b, c, d] => [*a, *b, *c, *d],
        _ => return None,
    };
    let o: Vec<u8> = address.iter().map(|x| u8::try_from(*x).ok()).collect::<Option<_>>()?;
    Some((format!("{}.{}.{}", parts[0], parts[1], parts[2]), Ipv4Addr::new(o[0], o[1], o[2], o[3])))
}

/// Every LLDP neighbour, built the way `lldp::parse_lldp_detail` builds one
/// from the CLI, so the two paths produce the same kind of record.
pub fn lldp_neighbors(cols: &LldpColumns) -> Vec<Neighbor> {
    let chassis_subtype = ints(&cols.chassis_subtype);
    let chassis_id = octets(&cols.chassis_id);
    let port_subtype = ints(&cols.port_subtype);
    let port_id = octets(&cols.port_id);
    let port_desc = octets(&cols.port_desc);
    let sys_name = octets(&cols.sys_name);
    let sys_desc = octets(&cols.sys_desc);
    let caps = octets(&cols.caps_enabled);
    let loc_subtype = ints(&cols.loc_port_subtype);
    let loc_id = octets(&cols.loc_port_id);

    let mut addresses: HashMap<String, Vec<DeviceAddress>> = HashMap::new();
    for (index, _) in &cols.man_addr {
        if let Some((key, ip)) = management_address(index) {
            let list = addresses.entry(key).or_default();
            if !list.iter().any(|a| a.ip == ip.to_string()) {
                list.push(DeviceAddress::management(ip.to_string()));
            }
        }
    }

    // A neighbour is a `timeMark.localPort.remIndex` key present in either
    // the chassis or the name column.
    let keys: BTreeSet<&str> = chassis_id
        .keys()
        .chain(sys_name.keys())
        .copied()
        .filter(|k| k.split('.').count() == 3)
        .collect();

    let mut out = Vec::new();
    for key in keys {
        let chassis = chassis_id
            .get(key)
            .and_then(|b| render_id(chassis_subtype.get(key).copied(), b, CHASSIS_MAC, CHASSIS_NETWORK_ADDRESS));
        // An empty system name is common; the chassis id names it instead.
        let Some(device_id) = sys_name.get(key).and_then(|b| text(b)).or_else(|| chassis.clone()) else {
            continue;
        };
        let local_port = key.split('.').nth(1).unwrap_or("");
        let local_interface = loc_id
            .get(local_port)
            .and_then(|b| render_id(loc_subtype.get(local_port).copied(), b, PORT_MAC, PORT_NETWORK_ADDRESS));
        let remote_port = port_id
            .get(key)
            .and_then(|b| render_id(port_subtype.get(key).copied(), b, PORT_MAC, PORT_NETWORK_ADDRESS));
        let description = sys_desc.get(key).and_then(|b| text(b)).map(|d| d.lines().next().unwrap_or("").trim().to_string());
        let capabilities = caps.get(key).map(|b| capability_words(b)).unwrap_or_default();
        let platform = crate::lldp::platform_from_description(description.as_deref());
        let class = crate::classify::classify(platform.as_deref(), &capabilities, description.as_deref());
        let vendor = match chassis_subtype.get(key) {
            Some(&CHASSIS_MAC) => chassis.as_deref().and_then(crate::oui::vendor).map(str::to_string),
            _ => None,
        };
        out.push(Neighbor {
            serial: None,
            short_name: crate::cdp::short_name(&device_id),
            device_id,
            addresses: addresses.remove(key).unwrap_or_default(),
            local_interface,
            // As the CLI parser does: a readable port description beats a port
            // id that is often a MAC.
            remote_interface: port_desc.get(key).and_then(|b| text(b)).or(remote_port),
            platform,
            capabilities,
            version: description,
            class,
            discovered_by: Protocol::Lldp,
            vendor,
            chassis_id: chassis,
        });
    }
    out
}

/// A six-octet MAC from index parts, as twelve lowercase hex digits. `None`
/// for anything that is not exactly a unicast MAC.
fn mac_from_parts(parts: &[&str]) -> Option<String> {
    if parts.len() != 6 {
        return None;
    }
    let bytes: Vec<u8> = parts.iter().map(|p| p.parse::<u8>().ok()).collect::<Option<_>>()?;
    // The low bit of the first octet marks a multicast or broadcast address,
    // which is not a device plugged into a port.
    if bytes[0] & 1 == 1 || bytes.iter().all(|b| *b == 0) {
        return None;
    }
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Learned MAC addresses and the ports they were learned on.
pub fn fdb_entries(cols: &BridgeColumns) -> Vec<MacEntry> {
    let names: HashMap<i64, String> = cols
        .if_name
        .iter()
        .filter_map(|(i, v)| match v {
            Walked::Octets(b) => Some((i.parse().ok()?, text(b)?)),
            _ => None,
        })
        .collect();
    let base: HashMap<i64, i64> = cols
        .base_port_if_index
        .iter()
        .filter_map(|(i, v)| match v {
            Walked::Int(n) => Some((i.parse().ok()?, *n)),
            _ => None,
        })
        .collect();
    let fdb_status = ints(&cols.fdb_status);
    let qfdb_status = ints(&cols.qfdb_status);

    // (mac, bridge port, vlan) from both tables, refusing any row whose index
    // is not the table's MAC shape.
    let mut raw: Vec<(String, i64, Option<String>)> = Vec::new();
    for (index, value) in &cols.qfdb_port {
        let Walked::Int(port) = value else { continue };
        let parts: Vec<&str> = index.split('.').collect();
        if parts.len() != 7 || qfdb_status.get(index.as_str()).is_some_and(|s| *s != FDB_STATUS_LEARNED) {
            continue;
        }
        if let Some(mac) = mac_from_parts(&parts[1..]) {
            raw.push((mac, *port, Some(parts[0].to_string())));
        }
    }
    for (index, value) in &cols.fdb_port {
        let Walked::Int(port) = value else { continue };
        let parts: Vec<&str> = index.split('.').collect();
        if fdb_status.get(index.as_str()).is_some_and(|s| *s != FDB_STATUS_LEARNED) {
            continue;
        }
        if let Some(mac) = mac_from_parts(&parts) {
            raw.push((mac, *port, None));
        }
    }

    let ports: BTreeSet<i64> = raw.iter().map(|(_, p, _)| *p).filter(|p| *p != 0).collect();
    // No bridge-port map: a port number is an interface index only when every
    // one of them names a known interface. Otherwise nothing is guessed.
    let identity = base.is_empty() && !ports.is_empty() && ports.iter().all(|p| names.contains_key(p));
    let if_index = |port: i64| if base.is_empty() { identity.then_some(port) } else { base.get(&port).copied() };

    let mut out: Vec<MacEntry> = Vec::new();
    for (mac, port, vlan) in raw {
        if port == 0 {
            continue;
        }
        let Some(name) = if_index(port).and_then(|i| names.get(&i)) else { continue };
        // The VLAN-aware row came first and carries the VLAN; a plain row for
        // the same MAC on the same port adds nothing.
        if out.iter().any(|e| e.mac == mac && &e.port == name) {
            continue;
        }
        out.push(MacEntry { mac, port: name.clone(), vlan });
    }
    out
}

/// Attached devices from learned MACs, the way the SSH path builds them: ports
/// that lead to an LLDP neighbour are links, not attachments, and a port's
/// population says whether it is one device or another switch.
pub fn attached_devices(neighbors: &[Neighbor], entries: &[MacEntry], arp: &HashMap<String, String>) -> Vec<AttachedDevice> {
    let uplinks: Vec<&str> = neighbors.iter().filter_map(|n| n.local_interface.as_deref()).collect();
    let population = crate::mac_table::count_by_port(entries);
    entries
        .iter()
        .filter(|e| !uplinks.iter().any(|u| crate::crawl::same_interface(u, &e.port)))
        .map(|e| AttachedDevice {
            address: arp.get(&e.mac).cloned(),
            vendor: crate::oui::vendor(&e.mac).map(str::to_string),
            port_population: population.get(&e.port).copied().unwrap_or(1),
            mac: e.mac.clone(),
            port: e.port.clone(),
            hostname: None,
            class: None,
            vlan: e.vlan.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::DeviceClass;

    // Invented names, RFC 5737 addresses and made-up MACs (D-027), in the
    // shapes the lab devices returned.
    fn int(index: &str, n: i64) -> (String, Walked) {
        (index.to_string(), Walked::Int(n))
    }
    fn oct(index: &str, b: &[u8]) -> (String, Walked) {
        (index.to_string(), Walked::Octets(b.to_vec()))
    }
    const MAC_A: [u8; 6] = [0x00, 0x0c, 0x29, 0x00, 0x00, 0x01];
    const MAC_B: [u8; 6] = [0x00, 0x0c, 0x29, 0x00, 0x00, 0x02];

    /// Cisco-shaped: one neighbour named, one with an empty name, MAC and
    /// interface-name port ids, a management address with the length byte and
    /// an IPv6 one.
    fn cisco_lldp() -> LldpColumns {
        LldpColumns {
            chassis_subtype: vec![int("100.3.1", 4), int("100.5.2", 4)],
            chassis_id: vec![oct("100.3.1", &MAC_A), oct("100.5.2", &MAC_B)],
            port_subtype: vec![int("100.3.1", 5), int("100.5.2", 3)],
            port_id: vec![oct("100.3.1", b"Gi1/0/1"), oct("100.5.2", &MAC_B)],
            port_desc: vec![oct("100.5.2", b"uplink to core")],
            sys_name: vec![oct("100.3.1", b"LAB-DIST-1.example.test"), oct("100.5.2", b"")],
            sys_desc: vec![oct("100.3.1", b"Cisco IOS Software, C9300 Software\nmore")],
            caps_enabled: vec![oct("100.3.1", &[0x28, 0x00]), oct("100.5.2", &[0x30, 0x00])],
            man_addr: vec![
                int("100.3.1.1.4.192.0.2.10", 2),
                int("100.5.2.2.16.32.1.13.184.0.0.0.0.0.0.0.0.0.0.0.1", 2),
            ],
            loc_port_subtype: vec![int("3", 5), int("5", 5)],
            loc_port_id: vec![oct("3", b"Gi1/0/24"), oct("5", b"Gi1/0/12")],
        }
    }

    #[test]
    fn a_neighbour_is_named_linked_classified_and_addressed() {
        let n = lldp_neighbors(&cisco_lldp());
        let dist = n.iter().find(|x| x.device_id == "LAB-DIST-1.example.test").expect("named neighbour");
        assert_eq!(dist.short_name, "LAB-DIST-1");
        assert_eq!(dist.local_interface.as_deref(), Some("Gi1/0/24"));
        assert_eq!(dist.remote_interface.as_deref(), Some("Gi1/0/1"));
        assert_eq!(dist.class, DeviceClass::Switch, "bridge + router is a layer-3 switch");
        assert_eq!(dist.addresses, vec![DeviceAddress::management("192.0.2.10")]);
        assert_eq!(dist.discovered_by, Protocol::Lldp);
        assert_eq!(dist.chassis_id.as_deref(), Some("00:0c:29:00:00:01"));
        assert!(dist.vendor.is_some(), "a MAC chassis id names its maker");
    }

    #[test]
    fn an_empty_name_falls_back_to_the_chassis_id_and_a_mac_port_to_its_description() {
        let n = lldp_neighbors(&cisco_lldp());
        let ap = n.iter().find(|x| x.device_id == "00:0c:29:00:00:02").expect("named by chassis id");
        assert_eq!(ap.remote_interface.as_deref(), Some("uplink to core"));
        assert_eq!(ap.class, DeviceClass::AccessPoint, "bridge + WLAN AP");
        assert!(ap.addresses.is_empty(), "an IPv6 management address is not used");
    }

    #[test]
    fn a_management_address_without_its_length_byte_is_read_too() {
        let forti = LldpColumns {
            chassis_subtype: vec![int("136365976.24.1", 4)],
            chassis_id: vec![oct("136365976.24.1", &MAC_A)],
            port_subtype: vec![int("136365976.24.1", 5)],
            port_id: vec![oct("136365976.24.1", b"port9")],
            sys_name: vec![oct("136365976.24.1", b"LAB-SW-2")],
            man_addr: vec![int("136365976.24.1.1.192.0.2.20", 2)],
            loc_port_subtype: vec![int("24", 5)],
            loc_port_id: vec![oct("24", b"port24")],
            ..Default::default()
        };
        let n = lldp_neighbors(&forti);
        assert_eq!(n.len(), 1);
        assert_eq!(n[0].addresses, vec![DeviceAddress::management("192.0.2.20")]);
        assert_eq!(n[0].local_interface.as_deref(), Some("port24"));
    }

    #[test]
    fn capability_bits_become_the_words_the_classifier_reads() {
        assert_eq!(capability_words(&[0x28, 0]), vec!["Bridge", "Router"]);
        assert_eq!(capability_words(&[0x30, 0]), vec!["Bridge", "WLAN Access Point"]);
        assert_eq!(capability_words(&[0x01]), vec!["Station Only"]);
        assert!(capability_words(&[]).is_empty());
    }

    #[test]
    fn management_address_shapes() {
        assert_eq!(management_address("1.2.3.1.4.192.0.2.1").map(|(_, ip)| ip), Some(Ipv4Addr::new(192, 0, 2, 1)));
        assert_eq!(management_address("1.2.3.1.192.0.2.1").map(|(k, _)| k).as_deref(), Some("1.2.3"));
        assert_eq!(management_address("1.2.3.1.4.300.0.2.1"), None);
        assert_eq!(management_address("1.2.3.2.16.1.2.3.4.5.6.7.8.9.10.11.12.13.14.15.16"), None);
    }

    fn if_names(pairs: &[(&str, &str)]) -> Column {
        pairs.iter().map(|(i, n)| oct(i, n.as_bytes())).collect()
    }

    #[test]
    fn a_cisco_style_table_goes_through_the_bridge_port_map() {
        let cols = BridgeColumns {
            if_name: if_names(&[("10101", "Gi1/0/1"), ("10102", "Gi1/0/2")]),
            base_port_if_index: vec![int("1", 10101), int("2", 10102)],
            fdb_port: vec![
                int("0.12.41.0.0.1", 1),
                int("0.12.41.0.0.2", 2),
                int("0.12.41.0.0.3", 2), // the switch's own address
                int("1.0.94.0.0.1", 1),  // multicast
                int("0.12.41.0.0.4", 0), // port 0: not a port
            ],
            fdb_status: vec![int("0.12.41.0.0.1", 3), int("0.12.41.0.0.2", 3), int("0.12.41.0.0.3", 4)],
            ..Default::default()
        };
        let got = fdb_entries(&cols);
        assert_eq!(got, vec![
            MacEntry { mac: "000c29000001".into(), port: "Gi1/0/1".into(), vlan: None },
            MacEntry { mac: "000c29000002".into(), port: "Gi1/0/2".into(), vlan: None },
        ]);
    }

    #[test]
    fn without_a_map_port_numbers_are_interfaces_only_when_all_of_them_are() {
        let unifi = BridgeColumns {
            if_name: if_names(&[("1", "eth0"), ("2", "eth1")]),
            fdb_port: vec![int("0.12.41.0.0.1", 1)],
            qfdb_port: vec![int("1.0.12.41.0.0.1", 1), int("1.0.12.41.0.0.2", 2)],
            ..Default::default()
        };
        let got = fdb_entries(&unifi);
        assert_eq!(got, vec![
            MacEntry { mac: "000c29000001".into(), port: "eth0".into(), vlan: Some("1".into()) },
            MacEntry { mac: "000c29000002".into(), port: "eth1".into(), vlan: Some("1".into()) },
        ], "the VLAN-aware row wins and the plain duplicate adds nothing");

        let unknown = BridgeColumns {
            if_name: if_names(&[("1", "eth0")]),
            fdb_port: vec![int("0.12.41.0.0.1", 1), int("0.12.41.0.0.2", 7)],
            ..Default::default()
        };
        assert!(fdb_entries(&unknown).is_empty(), "port 7 is no interface, so none are guessed");
    }

    #[test]
    fn a_forwarding_table_whose_index_is_not_a_mac_is_refused() {
        // FortiSwitch-shaped: a one-part counter where the MAC should be.
        let forti = BridgeColumns {
            if_name: if_names(&[("1", "port1")]),
            base_port_if_index: vec![int("1", 1)],
            fdb_port: (1..=50).map(|i| int(&i.to_string(), 1)).collect(),
            ..Default::default()
        };
        assert!(fdb_entries(&forti).is_empty());
    }

    #[test]
    fn attached_devices_skip_uplinks_and_count_each_port() {
        let neighbors = lldp_neighbors(&cisco_lldp()); // uplinks Gi1/0/24 and Gi1/0/12
        let entries = vec![
            MacEntry { mac: "000c29000001".into(), port: "Gi1/0/3".into(), vlan: None },
            MacEntry { mac: "000c29000002".into(), port: "Gi1/0/24".into(), vlan: None },
            MacEntry { mac: "000c29000005".into(), port: "Gi1/0/4".into(), vlan: Some("10".into()) },
            MacEntry { mac: "000c29000006".into(), port: "Gi1/0/4".into(), vlan: Some("10".into()) },
        ];
        let arp = HashMap::from([("000c29000001".to_string(), "192.0.2.50".to_string())]);
        let got = attached_devices(&neighbors, &entries, &arp);
        assert_eq!(got.len(), 3, "the MAC behind the uplink is not attached here");
        let one = got.iter().find(|a| a.port == "Gi1/0/3").unwrap();
        assert_eq!((one.address.as_deref(), one.port_population), (Some("192.0.2.50"), 1));
        assert!(got.iter().filter(|a| a.port == "Gi1/0/4").all(|a| a.port_population == 2));
    }
}
