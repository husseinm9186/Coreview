//! Cumulus Linux 5 through NVUE: the collector's rows from
//! [`coreview_discover::nvue`], the one parser both engines read with.
//! Every reader takes NVUE's `-o json` and the table the operator captured
//! alike; a reply that reads to nothing is what sends the catalog's
//! `fallback` (the other form) instead.

use coreview_discover::nvue;
use coreview_discover::types::Protocol;
use serde_json::{json, Map, Value};

fn put(m: &mut Map<String, Value>, k: &str, v: Option<String>) {
    if let Some(v) = v.filter(|v| !v.is_empty()) {
        m.insert(k.into(), json!(v));
    }
}

/// `nv show system`, `nv show platform`, `nv show system version`: one
/// device row from whichever this reply is.
pub fn identity(raw: &str) -> Vec<Value> {
    let id = nvue::identity(&[raw]);
    let mut m = Map::new();
    put(&mut m, "hostname", id.hostname);
    put(&mut m, "os_version", id.release);
    put(&mut m, "build", id.build_id);
    put(&mut m, "model", id.model);
    put(&mut m, "serial", id.serial);
    put(&mut m, "base_mac", id.base_mac);
    put(&mut m, "manufacturer", id.manufacturer);
    put(&mut m, "part_number", id.part_number);
    put(&mut m, "asic", id.asic);
    put(&mut m, "port_layout", id.port_layout);
    put(&mut m, "uptime", id.uptime);
    put(&mut m, "product", id.product);
    if m.is_empty() {
        return Vec::new();
    }
    m.insert("vendor".into(), json!("NVIDIA"));
    vec![Value::Object(m)]
}

/// `nv show interface`: a row per address (an interface with none, one
/// row of its own), VRR's virtual addresses marked `kind: vrr`. A JSON
/// reply that names no address anywhere is a shape this does not know —
/// every switch has its management address — and reads to nothing, so the
/// table is asked instead.
pub fn interfaces(raw: &str) -> Vec<Value> {
    let ports = nvue::ports(raw);
    if nvue::json_of(raw).is_some() && !ports.iter().any(|p| !p.addresses.is_empty()) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for p in ports.iter().filter(|p| !p.is_vrr()) {
        let base = || {
            let mut m = Map::new();
            m.insert("interface".into(), json!(p.name));
            m.insert("admin_status".into(), json!(if p.admin_up { "up" } else { "down" }));
            m.insert("oper_status".into(), json!(if p.oper_up { "up" } else { "down" }));
            m.insert("port_type".into(), json!(p.kind));
            put(&mut m, "speed", p.speed.clone());
            put(&mut m, "mtu", p.mtu.map(|x| x.to_string()));
            put(&mut m, "mac", p.mac.clone());
            put(&mut m, "vrf", p.vrf.clone().or_else(|| (p.kind == "eth").then(|| "mgmt".to_string())));
            put(&mut m, "lag", ports.iter().find(|b| b.members.contains(&p.name)).map(|b| b.name.clone()));
            m
        };
        let addresses: Vec<(&String, &str)> = p.addresses.iter().map(|a| (a, "primary")).chain(p.virtual_addresses.iter().map(|a| (a, "vrr"))).collect();
        if addresses.is_empty() {
            out.push(Value::Object(base()));
        }
        for (cidr, kind) in addresses {
            let (ip, len) = cidr.split_once('/').unwrap_or((cidr.as_str(), ""));
            let mut m = base();
            m.insert("ip_address".into(), json!(ip));
            put(&mut m, "prefix_length", Some(len.to_string()));
            m.insert("kind".into(), json!(kind));
            out.push(Value::Object(m));
        }
    }
    out
}

/// LLDP (and CDP heard by lldpd) from NVUE's LLDP view, either form.
pub fn lldp(raw: &str) -> Vec<Value> {
    nvue::neighbours(raw)
        .into_iter()
        .map(|n| {
            let mut m = Map::new();
            put(&mut m, "local_interface", n.local_interface.clone());
            m.insert("neighbor_name".into(), json!(n.device_id));
            put(&mut m, "chassis_id", n.chassis_id.clone());
            put(&mut m, "neighbor_interface", n.remote_interface.clone());
            put(&mut m, "management_ip", n.address().map(str::to_string));
            put(&mut m, "platform", n.platform.clone().or_else(|| n.version.clone()));
            put(&mut m, "system_description", n.version.clone());
            put(&mut m, "serial", n.serial.clone());
            if !n.capabilities.is_empty() {
                m.insert("capabilities".into(), json!(n.capabilities.join(", ")));
            }
            m.insert("protocol".into(), json!(if n.discovered_by == Protocol::Cdp { "cdp" } else { "lldp" }));
            Value::Object(m)
        })
        .collect()
}

/// Bonds and their members, from `nv show interface -o json` or `nv show
/// interface bond-members`.
pub fn bonds(raw: &str) -> Vec<Value> {
    let bonds = if nvue::json_of(raw).is_some() { nvue::parse_bonds(raw) } else { nvue::parse_bond_members(raw) };
    bonds.into_iter().map(|b| json!({"name": b.name, "protocol": b.protocol, "members": b.members.join(", ")})).collect()
}

/// `nv show bridge domain br_default vlan`.
pub fn vlans(raw: &str) -> Vec<Value> {
    nvue::vlans(raw)
        .into_iter()
        .map(|(id, vni)| {
            let mut m = Map::new();
            m.insert("vlan_id".into(), json!(id.to_string()));
            m.insert("name".into(), json!(format!("vlan{id}")));
            put(&mut m, "vni", vni.map(|v| v.to_string()));
            Value::Object(m)
        })
        .collect()
}

/// `nv show bridge domain br_default port` (JSON) or `… port vlan`: each
/// port's mode, its untagged VLAN, and the VLANs it carries tagged.
pub fn port_vlans(raw: &str) -> Vec<Value> {
    nvue::port_vlans(raw)
        .into_iter()
        .map(|p| {
            let mut m = Map::new();
            m.insert("interface".into(), json!(p.port));
            m.insert("switchport_mode".into(), json!(p.mode));
            put(&mut m, "native_vlan", p.vlan.map(|v| v.to_string()));
            if !p.trunk_vlans.is_empty() {
                m.insert("trunking_vlans".into(), json!(p.trunk_vlans.iter().map(u16::to_string).collect::<Vec<_>>().join(",")));
            }
            Value::Object(m)
        })
        .collect()
}

/// `nv show bridge domain br_default stp`: a row per port with the
/// bridge's root beside it.
pub fn stp(raw: &str) -> Vec<Value> {
    let Some(t) = nvue::spanning_tree(raw, "") else { return Vec::new() };
    t.ports
        .iter()
        .map(|p| {
            let mut m = Map::new();
            m.insert("instance".into(), json!(t.instance));
            put(&mut m, "root_mac", t.root_bridge.clone());
            put(&mut m, "bridge_priority", t.root_priority.map(|x| x.to_string()));
            put(&mut m, "root_port", t.root_port.clone());
            put(&mut m, "mode", t.protocol.clone());
            m.insert("is_root".into(), json!(t.is_root));
            m.insert("interface".into(), json!(p.port));
            m.insert("role".into(), json!(p.role));
            m.insert("port_state".into(), json!(p.state));
            put(&mut m, "cost", p.cost.map(|c| c.to_string()));
            Value::Object(m)
        })
        .collect()
}

/// `nv show vrf`.
pub fn vrfs(raw: &str) -> Vec<Value> {
    nvue::vrfs(raw).into_iter().map(|(name, table)| json!({"name": name, "table": table.map(|t| t.to_string())})).collect()
}

/// `nv show vrf <vrf> router rib ipv4|ipv6 route`.
pub fn rib(raw: &str) -> Vec<Value> {
    let family = if raw.contains("::/") || raw.contains("fe80::") { 6 } else { 4 };
    nvue::rib(raw, family)
        .into_iter()
        .map(|r| {
            let mut m = Map::new();
            m.insert("prefix".into(), json!(r.prefix));
            m.insert("protocol".into(), json!(r.protocol));
            put(&mut m, "distance", r.distance.map(|d| d.to_string()));
            put(&mut m, "metric", r.metric.map(|d| d.to_string()));
            if !r.next_hops.is_empty() {
                m.insert("next_hop".into(), json!(r.next_hops.join(", ")));
            }
            put(&mut m, "interface", r.interface);
            Value::Object(m)
        })
        .collect()
}

/// OSPF neighbours: NVUE's JSON, or FRR's `show ip ospf neighbor detail`.
pub fn ospf_neighbors(raw: &str) -> Vec<Value> {
    nvue::ospf_neighbors(raw)
        .into_iter()
        .map(|n| {
            let mut m = Map::new();
            m.insert("protocol".into(), json!("ospf"));
            m.insert("neighbor_id".into(), json!(n.router_id));
            put(&mut m, "address", n.address);
            put(&mut m, "interface", n.interface);
            m.insert("state".into(), json!(n.state));
            put(&mut m, "area", n.area);
            put(&mut m, "role", n.role);
            put(&mut m, "local_ip", n.local_ip);
            Value::Object(m)
        })
        .collect()
}

/// `nv show mlag`: the pair, as an `ha_pair` row.
pub fn mlag(raw: &str) -> Vec<Value> {
    let Some(m) = nvue::mlag(raw) else { return Vec::new() };
    let mut r = Map::new();
    r.insert("kind".into(), json!("mlag"));
    put(&mut r, "role", m.local_role);
    put(&mut r, "peer", m.peer_ip);
    put(&mut r, "peer_role", m.peer_role);
    put(&mut r, "peer_link", m.peer_interface);
    put(&mut r, "peer_alive", m.peer_alive);
    put(&mut r, "mac", m.system_mac);
    put(&mut r, "backup_ip", m.backup_ip);
    vec![Value::Object(r)]
}

/// `nv show nve vxlan`: the VTEP, when VXLAN is on; nothing when it is off.
pub fn vxlan(raw: &str) -> Vec<Value> {
    nvue::vxlan(raw).map(|source| vec![json!({"name": "vxlan", "kind": "vxlan", "local_ip": source, "state": "up"})]).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    macro_rules! capture {
        ($f:literal) => {
            include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../coreview-discover/fixtures/cumulus5/", $f))
        };
    }

    fn col<'a>(rows: &'a [Value], k: &str) -> Vec<&'a str> {
        rows.iter().filter_map(|r| r.get(k).and_then(Value::as_str)).collect()
    }

    #[test]
    fn every_reader_reads_the_operators_captures() {
        let p = identity(capture!("nv_show_platform.txt"));
        assert_eq!((p[0]["model"].as_str(), p[0]["serial"].as_str(), p[0]["vendor"].as_str()), (Some("MSN2010"), Some("MT0000EXMP"), Some("NVIDIA")));
        assert_eq!(identity(capture!("nv_show_system_version.txt"))[0]["os_version"], "5.18.0");
        let i = interfaces(capture!("nv_show_interface.txt"));
        assert!(i.iter().any(|r| r["interface"] == "eth0" && r["ip_address"] == "198.51.100.12" && r["prefix_length"] == "24" && r["vrf"] == "mgmt"));
        assert!(i.iter().any(|r| r["interface"] == "vlan110" && r["ip_address"] == "10.66.110.1" && r["kind"] == "vrr"));
        assert!(!col(&i, "interface").contains(&"vlan110-v0"), "the macvlan is not a port");
        assert!(i.iter().any(|r| r["interface"] == "swp5" && r["oper_status"] == "down"));
        let n = lldp(capture!("lldpcli_show_neighbors_details.txt"));
        assert!(n.iter().any(|r| r["neighbor_name"] == "cx-1" && r["management_ip"] == "198.51.100.4" && r["neighbor_interface"] == "1/1/50" && r["protocol"] == "lldp"));
        assert!(n.iter().any(|r| r["neighbor_name"] == "wlc-a1" && r["protocol"] == "cdp"));
        let v = vlans(capture!("nv_show_bridge_domain_vlan.txt"));
        assert_eq!(v.len(), 23);
        let pv = port_vlans(capture!("nv_show_bridge_domain_port_vlan.txt"));
        let bond1 = pv.iter().find(|r| r["interface"] == "bond1").unwrap();
        assert_eq!((bond1["switchport_mode"].as_str(), bond1["native_vlan"].as_str()), (Some("trunk"), Some("1")));
        assert!(bond1["trunking_vlans"].as_str().unwrap().starts_with("2,3,4,5,20,30,100"));
        let s = stp(capture!("nv_show_bridge_domain_stp.txt"));
        assert!(s.iter().any(|r| r["interface"] == "swp10" && r["port_state"] == "BLK" && r["root_mac"] == "02:00:00:00:01:01"));
        assert_eq!(vrfs(capture!("nv_show_vrf.txt")).len(), 2);
        let r4 = rib(capture!("nv_show_rib_ipv4_route.txt"));
        assert!(r4.iter().any(|r| r["prefix"] == "0.0.0.0/0" && r["protocol"] == "ospf" && r["distance"] == "110"));
        let o = ospf_neighbors(capture!("vtysh_show_ip_ospf_neighbor_detail.txt"));
        assert_eq!(col(&o, "neighbor_id"), ["10.254.254.254", "10.254.254.1"]);
        assert!(vxlan(capture!("nv_show_nve_vxlan.txt")).is_empty());
        assert!(rib(capture!("nv_show_bgp_l2vpn_evpn_route.txt")).is_empty());
    }

    #[test]
    fn json_the_collectors_tables_know_and_json_they_do_not() {
        let j = r#"{"eth0": {"type": "eth", "link": {"oper-status": "up"}, "ip": {"address": {"198.51.100.12/24": {}}, "vrf": "mgmt"}}, "bond1": {"type": "bond", "bond": {"member": {"swp49": {}}}}}"#;
        let i = interfaces(j);
        assert!(i.iter().any(|r| r["interface"] == "eth0" && r["ip_address"] == "198.51.100.12"));
        assert!(i.iter().any(|r| r["interface"] == "bond1"));
        assert_eq!(bonds(j)[0]["members"], "swp49");
        // An object with no address anywhere is not the shape this knows: nothing, so the table is asked.
        assert!(interfaces(r#"{"eth0": {"type": "eth"}}"#).is_empty());
        let m = mlag(r#"{"local-role": "secondary", "peer-ip": "fe80::1", "peer-interface": "peerlink.4094", "mac-address": "02:00:00:00:01:01"}"#);
        assert_eq!((m[0]["kind"].as_str(), m[0]["role"].as_str(), m[0]["peer_link"].as_str()), (Some("mlag"), Some("secondary"), Some("peerlink.4094")));
        assert_eq!(vxlan(r#"{"enable": "on", "source": {"address": "10.0.0.11"}}"#)[0]["local_ip"], "10.0.0.11");
    }
}
