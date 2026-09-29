//! The SNMP fallback of a catalog collection (LT-549): for a device whose
//! SSH session could not be opened, the standard MIBs read into rows the
//! collection's own tables take — the system group and ENTITY-MIB (device),
//! LLDP-MIB and CDP-MIB (neighbours), BRIDGE-MIB and Q-BRIDGE-MIB (MAC
//! table), IP-MIB (ARP and interface addresses) and IP-FORWARD-MIB (routes).
//!
//! The identity, LLDP, bridge and ARP readers are LT-134's and LT-124's,
//! written against measured tables. **CDP-MIB, IP-FORWARD-MIB and IP-MIB's
//! address table are read from their MIB definitions** (D-058's rule for what
//! has not met a device): [`verified_against_hardware`] says `false` until
//! the operator's capture replaces the fixtures in the tests.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::{json, Value};

use crate::snmp::{SnmpAuth, SnmpError, Walked};
use crate::snmp_topology::Column;

pub fn verified_against_hardware() -> bool {
    false
}

const IF_NAME: &[u64] = &[1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 1];
/// `cdpCacheEntry` (CISCO-CDP-MIB); a column number is appended.
const CDP_CACHE_ENTRY: &[u64] = &[1, 3, 6, 1, 4, 1, 9, 9, 23, 1, 2, 1, 1];
/// `ipCidrRouteEntry` (IP-FORWARD-MIB).
const IP_CIDR_ROUTE_ENTRY: &[u64] = &[1, 3, 6, 1, 2, 1, 4, 24, 4, 1];
/// `ipAddrEntry` (IP-MIB).
const IP_ADDR_ENTRY: &[u64] = &[1, 3, 6, 1, 2, 1, 4, 20, 1];
const MAX_ROWS: usize = 16_384;

fn col(entry: &[u64], n: u64) -> Vec<u64> {
    let mut v = entry.to_vec();
    v.push(n);
    v
}

fn text(v: &Walked) -> Option<String> {
    match v {
        Walked::Octets(b) => {
            let s = String::from_utf8_lossy(b).trim_matches(char::from(0)).trim().to_string();
            (!s.is_empty()).then_some(s)
        }
        Walked::Int(n) => Some(n.to_string()),
        Walked::Ip(a) => Some(std::net::Ipv4Addr::from(*a).to_string()),
        Walked::Other => None,
    }
}

fn int(v: &Walked) -> Option<i64> {
    match v {
        Walked::Int(n) => Some(*n),
        _ => None,
    }
}

fn by_index(c: &Column) -> BTreeMap<String, &Walked> {
    c.iter().map(|(i, v)| (i.clone(), v)).collect()
}

fn if_names(c: &Column) -> BTreeMap<String, String> {
    c.iter().filter_map(|(i, v)| text(v).map(|t| (i.clone(), t))).collect()
}

/// The CDP-MIB cache columns a neighbour is built from.
#[derive(Debug, Default, Clone)]
pub struct CdpColumns {
    pub address: Column,
    pub device_id: Column,
    pub device_port: Column,
    pub platform: Column,
}

/// One row per CDP neighbour. The index is `ifIndex.deviceIndex`; the local
/// port is the ifIndex's `ifName`. An address is kept only when it is four
/// bytes, the IPv4 form the MIB's `cdpCacheAddressType` 1 gives.
pub fn cdp_rows(c: &CdpColumns, ifs: &BTreeMap<String, String>) -> Vec<Value> {
    let addr = by_index(&c.address);
    let port = by_index(&c.device_port);
    let platform = by_index(&c.platform);
    c.device_id
        .iter()
        .filter_map(|(index, v)| {
            let name = text(v)?;
            let if_index = index.split('.').next().unwrap_or("");
            let local = ifs.get(if_index).cloned().unwrap_or_else(|| format!("ifIndex {if_index}"));
            let ip = addr.get(index).and_then(|a| match a {
                Walked::Octets(b) if b.len() == 4 => Some(std::net::Ipv4Addr::new(b[0], b[1], b[2], b[3]).to_string()),
                _ => None,
            });
            Some(json!({"local_interface": local, "neighbor_name": name, "neighbor_interface": port.get(index).and_then(|p| text(p)), "mgmt_address": ip, "platform": platform.get(index).and_then(|p| text(p)), "proto": "cdp"}))
        })
        .collect()
}

/// The IP-FORWARD-MIB `ipCidrRouteTable` columns routes are built from.
#[derive(Debug, Default, Clone)]
pub struct RouteColumns {
    pub if_index: Column,
    pub route_type: Column,
    pub proto: Column,
    pub metric: Column,
}

/// `ipCidrRouteProto` as the words the route table uses.
fn proto_word(n: i64, route_type: Option<i64>) -> &'static str {
    match n {
        2 if route_type == Some(3) => "connected",
        2 => "local",
        3 => "static",
        8 => "rip",
        9 => "isis",
        13 => "ospf",
        14 => "bgp",
        16 => "eigrp",
        _ => "other",
    }
}

/// One row per route. The index is `dest.mask.tos.nextHop`, thirteen parts.
/// A route of type `reject` (2) is kept with the interface `Null0`, so the
/// path builder drops traffic there as the device would.
pub fn route_rows(c: &RouteColumns, ifs: &BTreeMap<String, String>) -> Vec<Value> {
    let ty = by_index(&c.route_type);
    let proto = by_index(&c.proto);
    let metric = by_index(&c.metric);
    c.if_index
        .iter()
        .filter_map(|(index, v)| {
            let p: Vec<&str> = index.split('.').collect();
            if p.len() != 13 {
                return None;
            }
            let dest = p[0..4].join(".");
            let mask = p[4..8].join(".");
            let nh = p[9..13].join(".");
            let t = ty.get(index).and_then(|x| int(x));
            let if_index = int(v).unwrap_or(0).to_string();
            let iface = if t == Some(2) { Some("Null0".to_string()) } else { ifs.get(&if_index).cloned() };
            let next_hop = (nh != "0.0.0.0" && t != Some(3)).then_some(nh);
            Some(json!({"network": dest, "mask": mask, "protocol": proto_word(proto.get(index).and_then(|x| int(x)).unwrap_or(1), t), "next_hop": next_hop, "interface": iface, "metric": metric.get(index).and_then(|m| int(m)).map(|m| m.to_string())}))
        })
        .collect()
}

/// One row per address from IP-MIB's `ipAddrTable` (index = the address).
pub fn address_rows(if_index: &Column, netmask: &Column, ifs: &BTreeMap<String, String>) -> Vec<Value> {
    let masks = by_index(netmask);
    if_index
        .iter()
        .filter_map(|(index, v)| {
            if index.split('.').count() != 4 {
                return None;
            }
            let iface = ifs.get(&int(v)?.to_string()).cloned();
            let mask = masks.get(index).and_then(|m| match m {
                Walked::Ip(a) => Some(std::net::Ipv4Addr::from(*a).to_string()),
                _ => None,
            });
            Some(json!({"interface": iface, "ip_address": index, "netmask": mask}))
        })
        .collect()
}

/// One table of the fallback: what it was read from, which tables it feeds,
/// its rows. `status` is `ok`, or `unsupported` when the device returned
/// nothing for it.
#[derive(Debug, Clone)]
pub struct SnmpTable {
    pub id: &'static str,
    pub mib: &'static str,
    pub feeds: &'static [&'static str],
    pub rows: Vec<Value>,
}

/// Everything the fallback reads from one device, best effort per table.
/// Fails only when the device does not answer at all, or the credential is
/// wrong — the same errors the identity read gives.
pub async fn read_for_collection(host: &str, port: u16, auth: &SnmpAuth, timeout: Duration) -> Result<Vec<SnmpTable>, SnmpError> {
    let identity = crate::snmp::identify(host, port, auth, timeout).await?;
    let mut out = vec![SnmpTable {
        id: "snmp_system",
        mib: "SNMPv2-MIB system, ENTITY-MIB",
        feeds: &["device"],
        rows: vec![json!({"hostname": identity.name, "version": identity.description, "serial": identity.serials, "model": identity.models.first()})],
    }];
    let topo = crate::snmp_topology::read_topology_on(host, port, auth, timeout).await?;
    out.push(SnmpTable {
        id: "snmp_lldp",
        mib: "LLDP-MIB",
        feeds: &["neighbor"],
        rows: topo
            .neighbors
            .iter()
            .map(|n| json!({"local_interface": n.local_interface, "neighbor_name": n.short_name, "neighbor_interface": n.remote_interface, "mgmt_address": n.addresses.first().map(|a| a.ip.clone()), "chassis_id": n.chassis_id, "platform": n.platform, "capabilities": n.capabilities.join(", "), "proto": "lldp"}))
            .collect(),
    });
    out.push(SnmpTable {
        id: "snmp_bridge",
        mib: "BRIDGE-MIB, Q-BRIDGE-MIB",
        feeds: &["mac_table"],
        rows: topo.mac_entries.iter().map(|m| json!({"mac_address": m.mac, "interface": m.port, "vlan": m.vlan, "type": "DYNAMIC"})).collect(),
    });
    let mut session = Box::pin(crate::snmp::open_session(host, port, auth, timeout)).await?;
    let ifs = if_names(&crate::snmp::walk_limited(&mut session, IF_NAME, timeout, MAX_ROWS).await);
    let cdp = CdpColumns {
        address: crate::snmp::walk_limited(&mut session, &col(CDP_CACHE_ENTRY, 4), timeout, MAX_ROWS).await,
        device_id: crate::snmp::walk_limited(&mut session, &col(CDP_CACHE_ENTRY, 6), timeout, MAX_ROWS).await,
        device_port: crate::snmp::walk_limited(&mut session, &col(CDP_CACHE_ENTRY, 7), timeout, MAX_ROWS).await,
        platform: crate::snmp::walk_limited(&mut session, &col(CDP_CACHE_ENTRY, 8), timeout, MAX_ROWS).await,
    };
    out.push(SnmpTable { id: "snmp_cdp", mib: "CISCO-CDP-MIB", feeds: &["neighbor"], rows: cdp_rows(&cdp, &ifs) });
    let routes = RouteColumns {
        if_index: crate::snmp::walk_limited(&mut session, &col(IP_CIDR_ROUTE_ENTRY, 5), timeout, MAX_ROWS).await,
        route_type: crate::snmp::walk_limited(&mut session, &col(IP_CIDR_ROUTE_ENTRY, 6), timeout, MAX_ROWS).await,
        proto: crate::snmp::walk_limited(&mut session, &col(IP_CIDR_ROUTE_ENTRY, 7), timeout, MAX_ROWS).await,
        metric: crate::snmp::walk_limited(&mut session, &col(IP_CIDR_ROUTE_ENTRY, 11), timeout, MAX_ROWS).await,
    };
    out.push(SnmpTable { id: "snmp_routes", mib: "IP-FORWARD-MIB ipCidrRouteTable", feeds: &["route"], rows: route_rows(&routes, &ifs) });
    let addr_if = crate::snmp::walk_limited(&mut session, &col(IP_ADDR_ENTRY, 2), timeout, MAX_ROWS).await;
    let addr_mask = crate::snmp::walk_limited(&mut session, &col(IP_ADDR_ENTRY, 3), timeout, MAX_ROWS).await;
    out.push(SnmpTable { id: "snmp_addresses", mib: "IP-MIB ipAddrTable", feeds: &["ip_address"], rows: address_rows(&addr_if, &addr_mask, &ifs) });
    drop(session);
    let arp = crate::snmp::arp_table(host, port, auth, timeout).await.unwrap_or_default();
    out.push(SnmpTable { id: "snmp_arp", mib: "IP-MIB ipNetToMediaTable", feeds: &["arp"], rows: arp.iter().map(|a| json!({"ip_address": a.ip.to_string(), "mac_address": a.mac})).collect() });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // From the MIBs' definitions, not a capture (D-058).
    fn o(s: &str) -> Walked {
        Walked::Octets(s.as_bytes().to_vec())
    }

    fn ifs() -> BTreeMap<String, String> {
        [("10101".to_string(), "Gi1/0/1".to_string()), ("10102".to_string(), "Gi1/0/2".to_string()), ("5".to_string(), "Vlan10".to_string())].into()
    }

    #[test]
    fn cdp_cache_rows_name_the_local_port_and_the_neighbour() {
        let c = CdpColumns {
            address: vec![("10101.3".into(), Walked::Octets(vec![192, 0, 2, 2]))],
            device_id: vec![("10101.3".into(), o("SW2.lab.example.net")), ("10102.4".into(), o("PHONE-1"))],
            device_port: vec![("10101.3".into(), o("GigabitEthernet1/0/2"))],
            platform: vec![("10101.3".into(), o("cisco WS-C2960X-24TS-L"))],
        };
        let rows = cdp_rows(&c, &ifs());
        assert_eq!(rows[0], json!({"local_interface": "Gi1/0/1", "neighbor_name": "SW2.lab.example.net", "neighbor_interface": "GigabitEthernet1/0/2", "mgmt_address": "192.0.2.2", "platform": "cisco WS-C2960X-24TS-L", "proto": "cdp"}));
        assert_eq!(rows[1]["mgmt_address"], Value::Null);
    }

    #[test]
    fn cidr_routes_from_their_index_with_connected_static_and_reject() {
        let c = RouteColumns {
            if_index: vec![
                ("192.0.2.0.255.255.255.0.0.0.0.0.0".into(), Walked::Int(5)),
                ("0.0.0.0.0.0.0.0.0.192.0.2.254".into(), Walked::Int(5)),
                ("203.0.113.0.255.255.255.0.0.198.51.100.9".into(), Walked::Int(10101)),
                ("198.51.100.128.255.255.255.128.0.0.0.0.0".into(), Walked::Int(0)),
                ("bad.index".into(), Walked::Int(1)),
            ],
            route_type: vec![("192.0.2.0.255.255.255.0.0.0.0.0.0".into(), Walked::Int(3)), ("0.0.0.0.0.0.0.0.0.192.0.2.254".into(), Walked::Int(4)), ("203.0.113.0.255.255.255.0.0.198.51.100.9".into(), Walked::Int(4)), ("198.51.100.128.255.255.255.128.0.0.0.0.0".into(), Walked::Int(2))],
            proto: vec![("192.0.2.0.255.255.255.0.0.0.0.0.0".into(), Walked::Int(2)), ("0.0.0.0.0.0.0.0.0.192.0.2.254".into(), Walked::Int(3)), ("203.0.113.0.255.255.255.0.0.198.51.100.9".into(), Walked::Int(13)), ("198.51.100.128.255.255.255.128.0.0.0.0.0".into(), Walked::Int(3))],
            metric: vec![("203.0.113.0.255.255.255.0.0.198.51.100.9".into(), Walked::Int(20))],
        };
        let rows = route_rows(&c, &ifs());
        assert_eq!(rows.len(), 4, "the malformed index is skipped");
        assert_eq!((rows[0]["network"].as_str(), rows[0]["protocol"].as_str(), rows[0]["interface"].as_str()), (Some("192.0.2.0"), Some("connected"), Some("Vlan10")));
        assert_eq!(rows[0]["next_hop"], Value::Null);
        assert_eq!((rows[1]["network"].as_str(), rows[1]["mask"].as_str(), rows[1]["next_hop"].as_str(), rows[1]["protocol"].as_str()), (Some("0.0.0.0"), Some("0.0.0.0"), Some("192.0.2.254"), Some("static")));
        assert_eq!((rows[2]["protocol"].as_str(), rows[2]["interface"].as_str(), rows[2]["metric"].as_str()), (Some("ospf"), Some("Gi1/0/1"), Some("20")));
        assert_eq!(rows[3]["interface"], "Null0", "a reject route drops, as the device would");
    }

    #[test]
    fn addresses_carry_their_interface_and_mask() {
        let rows = address_rows(&[("192.0.2.1".to_string(), Walked::Int(5))].to_vec(), &[("192.0.2.1".to_string(), Walked::Ip([255, 255, 255, 0]))].to_vec(), &ifs());
        assert_eq!(rows, vec![json!({"interface": "Vlan10", "ip_address": "192.0.2.1", "netmask": "255.255.255.0"})]);
    }
}
