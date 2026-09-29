//! Rows into the discovery tables. A template's field names differ by
//! platform (`address` here, `ip_address` there, `ip-addr-out` in NX-OS's
//! JSON), so each table's columns carry the names that mean them, and
//! whatever a row holds beyond those is kept beside it as `extra` rather
//! than dropped. Structured answers are flattened first: NX-OS `TABLE_x /
//! ROW_x`, EOS objects keyed by name, Junos and PAN-OS XML.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Map, Value};

/// One row bound for one table.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Normalised {
    pub table: String,
    pub columns: BTreeMap<String, String>,
    pub extra: Map<String, Value>,
}

/// Each table's columns and the source names that mean them, in order of preference.
fn synonyms(table: &str) -> &'static [(&'static str, &'static [&'static str])] {
    match table {
        "device" => &[
            ("hostname", &["hostname", "host_name", "name", "sysname", "system_name", "device_name", "host"]),
            ("vendor", &["vendor", "manufacturer"]),
            ("os_version", &["version", "software_version", "sw_version", "os_version", "os", "software", "kickstart", "product_version", "sys_ver_str", "release"]),
            ("model", &["model", "hardware", "platform", "chassis", "product_name", "product", "chassis_id", "pid", "device_model", "board_type"]),
            ("serial", &["serial", "serial_number", "serialnum", "sn", "chassis_sn", "proc_board_id", "serial_no", "chassis_serial"]),
            ("mgmt_ip", &["mgmt_ip", "management_ip", "ip_address", "ip"]),
            ("uptime", &["uptime", "kern_uptm_days"]),
            ("base_mac", &["mac", "mac_address", "base_mac", "system_mac", "chassis_mac"]),
        ],
        "interface" => &[
            ("name", &["interface", "intf", "port", "name", "interface_name", "local_interface", "intf_name", "phys_intf", "ifname"]),
            ("admin", &["admin_state", "admin_status", "link_status", "status", "admin"]),
            ("oper", &["oper_status", "protocol", "line_protocol", "link", "link_state", "oper", "state", "operational"]),
            ("speed", &["speed", "bandwidth", "eth_speed", "eth_bw"]),
            ("duplex", &["duplex", "eth_duplex"]),
            ("mac", &["mac", "mac_address", "address", "hardware_address", "bia", "eth_hw_addr", "physical_address"]),
            ("descr", &["description", "descr", "desc", "name_alias", "alias"]),
            ("mtu", &["mtu", "eth_mtu"]),
            ("vlan", &["vlan", "vlan_id", "access_vlan", "native_vlan", "vlan_tag"]),
            ("mode", &["mode", "switchport_mode", "admin_mode", "operational_mode", "switchport", "type"]),
            ("lag_parent", &["lag", "port_channel", "channel_group", "bundle", "aggregate", "member_of", "lag_parent"]),
        ],
        "ip_address" => &[
            ("interface", &["interface", "intf", "name", "port", "intf_name", "ifname", "vlan_name"]),
            ("ip", &["ip", "ip_address", "ipaddr", "address", "ipv4", "primary_ip", "ip_addr", "prefix", "ip_address_prefix", "ipv6_address"]),
            ("prefixlen", &["prefix_length", "prefixlen", "mask", "netmask", "subnet", "masklen", "prefix_len"]),
            ("vrf", &["vrf", "vrf_name", "routing_instance", "instance", "vpn_instance", "vrf_name_out"]),
            ("kind", &["kind", "type", "address_type"]),
        ],
        "neighbor" => &[
            ("local_if", &["local_interface", "local_port", "local_intf", "interface", "port", "intf", "local_port_id", "local_intf_name", "l_port_id", "port_id_local"]),
            ("rem_sysname", &["neighbor", "neighbor_name", "device_id", "system_name", "neighbor_sysname", "chassis_id_name", "hostname", "remote_system_name", "destination_host", "sys_name", "neighbor_hostname", "remote_device", "name"]),
            ("rem_chassis_id", &["chassis_id", "neighbor_chassis_id", "remote_chassis_id", "device_mac", "chassis", "remote_chassis"]),
            ("rem_port_id", &["neighbor_interface", "neighbor_port_id", "remote_port", "port_id", "neighbor_port", "remote_interface", "remote_port_id", "neighbor_portid", "remote_intf", "port"]),
            ("rem_port_descr", &["neighbor_port_description", "port_description", "remote_port_description", "neighbor_description", "port_desc", "remote_port_desc"]),
            ("rem_mgmt_ip", &["management_ip", "mgmt_address", "neighbor_ip", "mgmt_ip", "management_address", "ip_address", "remote_ip", "mgmt_addr", "address", "ip"]),
            ("rem_platform", &["platform", "neighbor_platform", "system_description", "remote_platform", "model", "hardware", "sys_desc", "system_desc", "neighbor_model"]),
            ("rem_caps", &["capabilities", "neighbor_capabilities", "capability", "system_capabilities", "sys_capability", "capabilities_supported"]),
            ("proto", &["proto", "protocol"]),
        ],
        "mac_table" => &[
            ("vlan", &["vlan", "vlan_id", "vlanid", "vlan_name"]),
            ("mac", &["mac", "mac_address", "destination_address", "mac_addr", "address", "macaddr"]),
            ("interface", &["interface", "destination_port", "ports", "port", "interfaces", "intf", "port_name"]),
            ("type", &["type", "entry_type", "mac_type", "kind"]),
            ("age", &["age", "aging"]),
        ],
        "arp" => &[
            ("ip", &["ip", "ip_address", "address", "ipaddr", "ip_addr", "ip_addr_out"]),
            ("mac", &["mac", "mac_address", "hardware_addr", "hw_address", "mac_addr", "hardware_address"]),
            ("interface", &["interface", "intf", "port", "intf_out", "port_id"]),
            ("age", &["age", "age_min", "age_sec", "time_stamp"]),
            ("vrf", &["vrf", "vrf_name", "vrf_name_out"]),
        ],
        "vlan" => &[
            ("vlan_id", &["vlan_id", "vlan", "id", "vlanid", "vlanshowbr_vlanid"]),
            ("name", &["name", "vlan_name", "vlanshowbr_vlanname"]),
            ("state", &["status", "state", "vlanshowbr_vlanstate"]),
            ("ports", &["interfaces", "ports", "member_ports", "port", "untagged", "tagged", "vlanshowplist_ifidx"]),
        ],
        "lag" => &[
            ("name", &["bundle_name", "bundle_iface", "group", "po_name", "name", "aggregate", "lag", "lag_name", "port_channel", "po", "trunk", "trunk_group", "interface", "aggregate_name", "port_channel_name"]),
            ("proto", &["protocol", "bundle_protocol", "mode", "proto", "type"]),
            ("members", &["member_interface", "member_intf", "interfaces", "members", "member", "ports", "port", "member_interfaces", "member_ports", "local_port"]),
            ("state", &["bundle_status", "status", "state", "flags", "member_status"]),
        ],
        "stp" => &[
            ("instance", &["vlan_id", "vlan", "instance", "mst_id", "msti"]),
            ("root_bridge", &["root_mac", "root_bridge_mac", "root_id", "root_bridge", "root_address"]),
            ("root_port", &["root_port"]),
            ("bridge_prio", &["bridge_priority", "priority", "root_priority", "bridge_prio"]),
            ("interface", &["interface", "port", "intf"]),
            ("role", &["role", "port_role"]),
            ("state", &["status", "state", "port_state"]),
            ("cost", &["cost", "path_cost"]),
        ],
        "vrf" => &[
            ("name", &["name", "vrf", "vrf_name", "routing_instance", "instance", "vpn_instance", "vrf_name_out"]),
            ("rd", &["rd", "default_rd", "route_distinguisher", "vrf_rd"]),
            ("interfaces", &["interfaces", "interface", "intf", "ifaces"]),
            ("rt_import", &["import_rt", "rt_import", "import_targets"]),
            ("rt_export", &["export_rt", "rt_export", "export_targets"]),
        ],
        "route" => &[
            ("vrf", &["vrf", "vrf_name", "routing_instance", "table", "vrf_name_out"]),
            ("prefix", &["network", "prefix", "destination", "dest", "route", "network_prefix", "ipprefix", "ip_prefix", "ip_address"]),
            ("mask", &["mask", "prefixlen", "prefix_length", "netmask", "subnet", "masklen", "prefix_len"]),
            ("proto", &["protocol", "type", "source_proto", "route_source", "source", "clientname", "status"]),
            ("ad", &["distance", "admin_distance", "ad", "preference", "pref"]),
            ("metric", &["metric", "cost"]),
            ("next_hop", &["nexthop_ip", "next_hop", "nexthop", "gateway", "via", "next_hop_ip", "nh", "ipnexthop", "gw", "nexthopip"]),
            ("interface", &["nexthop_if", "interface", "outgoing_interface", "nexthop_interface", "out_interface", "exit_interface", "next_hop_interface", "ifname", "intf", "dev", "nexthopif", "vlan_name"]),
            ("age", &["uptime", "age", "time"]),
        ],
        "routing_neighbor" => &[
            ("proto", &["proto", "protocol"]),
            ("neighbor_id", &["neighbor_id", "router_id", "neighbor", "neighbor_address", "peer", "peer_id", "bgp_neigh", "remote_router_id", "system_id", "neighbor_system_id", "neighborid", "peer_address"]),
            ("neighbor_ip", &["address", "ip_address", "neighbor_ip", "neighbor_address", "ip", "neighboraddr", "remote_address", "peer_ip"]),
            ("local_if", &["interface", "intf", "local_interface", "port", "ifname"]),
            ("state", &["state", "status", "state_pfxrcd", "session_state", "adjacency_state", "neighbor_state", "prefix_received"]),
            ("area_or_as", &["area", "remote_as", "as", "neighbor_as", "peer_as", "circuit_id", "asn", "remote_asn"]),
            ("uptime", &["uptime", "up_down", "dead_time", "hold_time", "updown", "time"]),
        ],
        "fhrp" => &[
            ("proto", &["proto", "protocol"]),
            ("group", &["group", "vr_id", "vrrp_id", "grp", "virtual_router", "vrid", "group_id", "sh_group_num"]),
            ("interface", &["interface", "iface", "intf", "port", "sh_if_index"]),
            ("vip", &["virtual_ip", "vip", "virtual_address", "virtual_ip_address", "address", "ip", "sh_vip"]),
            ("prio", &["priority", "prio", "sh_prio"]),
            ("state", &["state", "status", "sh_group_state"]),
            ("peer_ip", &["standby_router", "active_router", "master_router", "peer", "standby_ip", "active_ip", "sh_standby_router_addr", "sh_active_router_addr"]),
        ],
        "tunnel" => &[
            ("name", &["name", "tunnel", "interface", "peer", "tunnel_name", "vni", "nve"]),
            ("kind", &["kind", "type"]),
            ("local_ip", &["local_ip", "local", "local_address", "source", "src"]),
            ("remote_ip", &["remote_ip", "remote", "peer_ip", "peer_address", "destination", "dst", "peer_ip_address"]),
            ("state", &["state", "status"]),
        ],
        // LT-552: the ASA template's names last. Cisco writes twice NAT as
        // `destination static <mapped> <real>`, and the template names that
        // pair by position, so its `destination_real` is the address the
        // packet arrives with — `orig_dst` here — and `destination_mapped`
        // the one it leaves with.
        "nat_rule" => &[
            ("seq", &["seq", "id", "index", "line", "line_number", "rule", "name"]),
            ("type", &["type", "kind", "nat_type", "source_type"]),
            ("orig_src", &["orig_src", "source", "src", "real_src", "original_source", "srcaddr", "source_real"]),
            ("orig_dst", &["orig_dst", "destination", "dst", "real_dst", "original_destination", "dstaddr", "extip", "destination_real"]),
            ("trans_src", &["trans_src", "translated_source", "mapped_src", "snat", "translated_src", "poolname", "source_mapped"]),
            ("trans_dst", &["trans_dst", "translated_destination", "mapped_dst", "dnat", "translated_dst", "mappedip", "destination_mapped"]),
            ("in_zone_if", &["in_zone_if", "from", "source_zone", "real_ifc", "srcintf", "from_zone", "source_interface"]),
            ("out_zone_if", &["out_zone_if", "to", "destination_zone", "mapped_ifc", "dstintf", "to_zone", "destination_interface"]),
            ("service", &["service", "port", "protocol", "proto"]),
        ],
        "fw_policy" => &[
            ("seq", &["seq", "id", "policyid", "index", "line", "rule_id"]),
            ("name", &["name", "rule_name", "policy_name"]),
            ("src_zones", &["src_zones", "from", "source_zone", "srcintf", "from_zone", "source_zones"]),
            ("dst_zones", &["dst_zones", "to", "destination_zone", "dstintf", "to_zone", "destination_zones"]),
            ("src_addr", &["src_addr", "source", "src", "srcaddr", "source_address"]),
            ("dst_addr", &["dst_addr", "destination", "dst", "dstaddr", "destination_address"]),
            ("services", &["services", "service", "application", "port"]),
            ("action", &["action", "verdict"]),
            ("enabled", &["enabled", "status", "disabled", "state"]),
        ],
        "fw_zone" => &[("name", &["name", "zone", "zone_name"]), ("interfaces", &["interfaces", "interface", "members", "intf"])],
        "policy_route" => &[
            ("seq", &["seq", "id", "sequence", "index", "line", "rule", "name"]),
            ("in_if", &["in_if", "interface", "input_device", "ingress", "from", "srcintf", "input"]),
            ("src", &["src", "source", "srcaddr", "source_address", "match_source"]),
            ("dst", &["dst", "destination", "dstaddr", "destination_address", "match_destination"]),
            ("proto", &["proto", "protocol"]),
            ("port", &["port", "dport", "destination_port", "service"]),
            ("action_nh", &["action_nh", "next_hop", "nexthop", "gateway", "set_ip_next_hop", "ip_next_hop", "gw"]),
            ("action_if", &["action_if", "output_device", "set_interface", "egress", "outdev", "output"]),
            ("vrf", &["vrf", "vrf_name"]),
        ],
        "ha_pair" => &[
            ("kind", &["kind", "type", "mode"]),
            ("member", &["member", "switch", "switch_id", "slot", "id", "unit", "module", "member_id", "vsx_role", "peer", "node"]),
            ("role", &["role", "state", "status", "priority", "current_state", "ha_role"]),
            ("mac", &["mac", "mac_address", "system_mac"]),
            ("model", &["model", "hardware", "type"]),
            ("serial", &["serial", "serial_number", "sn"]),
            ("peer_link", &["peer_link", "peer_link_status", "keepalive", "isl"]),
        ],
        "ap" => &[
            ("ap_name", &["ap_name", "name", "ap", "hostname"]),
            ("ap_ip", &["ap_ip", "ip", "ip_address", "address"]),
            ("ap_mac", &["ap_mac", "mac", "mac_address", "ethernet_mac", "radio_mac"]),
            ("model", &["model", "ap_model", "type"]),
            ("nbr_switch", &["nbr_switch", "neighbor", "neighbor_name", "device_id", "switch"]),
            ("nbr_port", &["nbr_port", "neighbor_port", "port", "interface", "neighbor_interface"]),
            ("state", &["state", "status", "operation_state"]),
        ],
        "endpoint" => &[
            ("mac", &["mac", "mac_address", "client_mac", "hardware_addr", "macaddr"]),
            ("ip", &["ip", "ip_address", "client_ip", "address"]),
            ("vlan", &["vlan", "vlan_id"]),
            ("switch", &["switch", "device", "ap_name"]),
            ("port", &["port", "interface", "intf"]),
            ("seen_via", &["seen_via", "source", "type"]),
        ],
        _ => &[],
    }
}

fn scalar(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(a) => a.iter().map(scalar).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", "),
        Value::Object(_) => v.to_string(),
    }
}

/// A key the way the synonyms are written: lower-case snake_case — `-`, `.`,
/// spaces and `/` become `_`, and a camelCase hump (`physicalAddress`) gets one.
fn canon(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    let mut prev_lower = false;
    for c in key.trim().chars() {
        if c.is_ascii_uppercase() {
            if prev_lower {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
            prev_lower = false;
        } else if matches!(c, '-' | '.' | ' ' | '/') {
            out.push('_');
            prev_lower = false;
        } else {
            out.push(c);
            prev_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
        }
    }
    out
}

/// A `disabled` flag said the other way round, for the `enabled` column.
fn flipped(v: &str) -> String {
    match v.trim().to_ascii_lowercase().as_str() {
        "yes" | "true" | "1" | "on" => "no".into(),
        "no" | "false" | "0" | "off" => "yes".into(),
        other => format!("disabled: {other}"),
    }
}

/// One parsed row into one table. Columns take the first synonym present
/// and non-empty; every other key is kept in `extra`.
pub fn normalise(table: &str, row: &Value) -> Normalised {
    let mut out = Normalised { table: table.to_string(), columns: BTreeMap::new(), extra: Map::new() };
    let Some(obj) = row.as_object() else {
        out.extra.insert("value".into(), row.clone());
        return out;
    };
    let canonical: BTreeMap<String, &Value> = obj.iter().map(|(k, v)| (canon(k), v)).collect();
    let mut used = std::collections::BTreeSet::new();
    for (column, names) in synonyms(table) {
        for name in *names {
            if let Some(v) = canonical.get(*name) {
                let s = scalar(v);
                if !s.is_empty() {
                    // LT-537: `disabled: yes` is a rule that is off.
                    let s = if *column == "enabled" && *name == "disabled" { flipped(&s) } else { s };
                    out.columns.insert((*column).to_string(), s);
                    used.insert((*name).to_string());
                    break;
                }
            }
        }
    }
    for (k, v) in &canonical {
        if !used.contains(k) {
            out.extra.insert(k.clone(), (*v).clone());
        }
    }
    if table == "route" {
        route_fixups(&mut out.columns);
    }
    out
}

/// LT-554: AOS-CX lists next hops and exit interfaces together (`via
/// 172.25.0.189` and `via vlan3564` are one field), its protocol once per
/// next hop, and distance with metric as `[20/0]`. Addresses go to
/// `next_hop`, names stay in `interface`, a repeated protocol is said once,
/// and the bracket pair fills `ad` and `metric`.
fn route_fixups(c: &mut BTreeMap<String, String>) {
    if !c.contains_key("next_hop") {
        if let Some(list) = c.get("interface").cloned() {
            let items: Vec<&str> = list.split(',').map(str::trim).filter(|x| !x.is_empty()).collect();
            let (hops, names): (Vec<&str>, Vec<&str>) = items.iter().partition(|x| x.parse::<std::net::IpAddr>().is_ok());
            if !hops.is_empty() {
                c.insert("next_hop".into(), hops.join(", "));
                if names.is_empty() {
                    c.remove("interface");
                } else {
                    c.insert("interface".into(), names.join(", "));
                }
            }
        }
    }
    if let Some(p) = c.get("proto").cloned() {
        let mut words: Vec<&str> = p.split(',').map(str::trim).filter(|x| !x.is_empty()).collect();
        words.dedup();
        if words.len() == 1 {
            c.insert("proto".into(), words[0].to_string());
        }
    }
    if !c.contains_key("ad") {
        if let Some(m) = c.get("metric").cloned() {
            let first = m.split(',').next().unwrap_or("").trim();
            if let Some((a, z)) = first.strip_prefix('[').and_then(|x| x.strip_suffix(']')).and_then(|x| x.split_once('/')) {
                c.insert("ad".into(), a.trim().to_string());
                c.insert("metric".into(), z.trim().to_string());
            }
        }
    }
}

/// Every row of one answer into every table the command feeds.
pub fn normalise_all(feeds: &[String], rows: &[Value]) -> Vec<Normalised> {
    let mut out = Vec::new();
    for table in feeds {
        if table == "raw_config" || table == "path_probe" {
            continue;
        }
        for row in rows {
            out.push(normalise(table, row));
        }
    }
    out
}

// ------------------------------------------------------------ structured

/// Rows out of a platform's own JSON. NX-OS wraps tables as
/// `TABLE_x: { ROW_x: [..] }` (or a single object); EOS answers an object
/// whose values are objects keyed by name; a plain list of objects is rows
/// already. The key an object was under becomes `name` when the row has none.
pub fn rows_from_json(value: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    collect_json(value, None, &mut out, 0);
    if out.is_empty() {
        if let Value::Object(o) = value {
            out.push(Value::Object(o.clone()));
        }
    }
    out
}

fn collect_json(value: &Value, key: Option<&str>, out: &mut Vec<Value>, depth: usize) {
    if depth > 8 {
        return;
    }
    match value {
        Value::Array(items) => {
            for item in items {
                if item.is_object() {
                    push_row(item, key, out);
                } else {
                    collect_json(item, key, out, depth + 1);
                }
            }
        }
        Value::Object(map) => {
            // NX-OS: descend TABLE_* → ROW_*.
            let tables: Vec<(&String, &Value)> = map.iter().filter(|(k, _)| k.starts_with("TABLE_")).collect();
            if !tables.is_empty() {
                for (_, t) in tables {
                    if let Value::Object(tm) = t {
                        for (rk, rv) in tm {
                            if rk.starts_with("ROW_") {
                                match rv {
                                    Value::Array(rows) => {
                                        for r in rows {
                                            push_row(r, None, out);
                                        }
                                    }
                                    other => push_row(other, None, out),
                                }
                            }
                        }
                    }
                }
                return;
            }
            // EOS and friends: `{ "interfaces": { "Ethernet1": {...}, ... } }` or `{ "Ethernet1": {...} }`.
            let all_objects = !map.is_empty() && map.values().all(Value::is_object);
            if all_objects && map.len() == 1 {
                let (k, v) = map.iter().next().unwrap();
                collect_json(v, Some(k), out, depth + 1);
                return;
            }
            if all_objects {
                for (k, v) in map {
                    push_row(v, Some(k), out);
                }
                return;
            }
            if let Some(list) = map.values().find(|v| v.is_array() && v.as_array().unwrap().iter().all(Value::is_object)) {
                collect_json(list, key, out, depth + 1);
            }
        }
        _ => {}
    }
}

fn push_row(row: &Value, key: Option<&str>, out: &mut Vec<Value>) {
    let mut flat = Map::new();
    flatten_into(row, "", &mut flat, 0);
    if let Some(k) = key {
        if !flat.contains_key("name") {
            flat.insert("name".into(), Value::String(k.to_string()));
        }
    }
    out.push(Value::Object(flat));
}

fn flatten_into(v: &Value, prefix: &str, out: &mut Map<String, Value>, depth: usize) {
    match v {
        Value::Object(m) if depth < 4 => {
            for (k, val) in m {
                let key = if prefix.is_empty() { k.clone() } else { format!("{prefix}_{k}") };
                // Nested TABLE_/ROW_ inside a row (NX-OS next hops) are kept as JSON, not exploded.
                if k.starts_with("TABLE_") {
                    out.insert(key, val.clone());
                } else {
                    flatten_into(val, &key, out, depth + 1);
                }
            }
        }
        other => {
            if !prefix.is_empty() {
                out.insert(prefix.to_string(), other.clone());
            }
        }
    }
}

/// Rows out of XML: the repeated element under the document's root (Junos
/// `<physical-interface>`, PAN-OS `<entry>`), each flattened leaf by tag.
/// When nothing repeats, the whole document is one row.
pub fn rows_from_xml(text: &str) -> Result<Vec<Value>, String> {
    let doc = roxmltree::Document::parse(text.trim()).map_err(|e| format!("xml: {e}"))?;
    let root = doc.root_element();
    let mut node = root;
    // Walk down single-child chains (rpc-reply → interface-information → ...).
    loop {
        let kids: Vec<roxmltree::Node> = node.children().filter(|n| n.is_element()).collect();
        if kids.len() == 1 && kids[0].children().any(|c| c.is_element()) {
            node = kids[0];
        } else {
            break;
        }
    }
    let kids: Vec<roxmltree::Node> = node.children().filter(|n| n.is_element()).collect();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for k in &kids {
        *counts.entry(k.tag_name().name().to_string()).or_default() += 1;
    }
    let repeated = counts.iter().filter(|(_, n)| **n > 1).map(|(k, _)| k.clone()).next();
    let mut rows = Vec::new();
    match repeated {
        Some(tag) => {
            for k in kids.iter().filter(|k| k.tag_name().name() == tag) {
                let mut m = Map::new();
                flatten_xml(*k, "", &mut m, 0);
                rows.push(Value::Object(m));
            }
        }
        None => {
            let mut m = Map::new();
            flatten_xml(node, "", &mut m, 0);
            rows.push(Value::Object(m));
        }
    }
    Ok(rows)
}

fn flatten_xml(node: roxmltree::Node, prefix: &str, out: &mut Map<String, Value>, depth: usize) {
    for attr in node.attributes() {
        if attr.name() == "name" {
            out.entry("name".to_string()).or_insert_with(|| Value::String(attr.value().to_string()));
        }
    }
    let kids: Vec<roxmltree::Node> = node.children().filter(|n| n.is_element()).collect();
    if kids.is_empty() {
        let text = node.text().unwrap_or("").trim().to_string();
        if !prefix.is_empty() {
            match out.get_mut(prefix) {
                Some(Value::Array(a)) => a.push(Value::String(text)),
                Some(existing) => {
                    let first = existing.clone();
                    *existing = Value::Array(vec![first, Value::String(text)]);
                }
                None => {
                    out.insert(prefix.to_string(), Value::String(text));
                }
            }
        }
        return;
    }
    if depth >= 5 {
        return;
    }
    for k in kids {
        let name = k.tag_name().name().replace('-', "_");
        let key = if prefix.is_empty() { name } else { format!("{prefix}_{name}") };
        flatten_xml(k, &key, out, depth + 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// LT-552: an ASA `show nat` row, as ntc's template writes it (the
    /// fixture's second rule), must land in the NAT columns.
    #[test]
    fn an_asa_nat_row_lands_in_the_nat_columns() {
        let n = normalise("nat_rule", &json!({"nat_section_number": "1", "line_number": "2", "source_interface": "any", "destination_interface": "outside", "source_type": "dynamic", "source_real": "test1", "source_mapped": "test2", "destination_real": "test3", "destination_mapped": "test4", "inactive": "inactive"}));
        assert_eq!(n.columns.get("orig_src").map(String::as_str), Some("test1"));
        assert_eq!(n.columns.get("trans_src").map(String::as_str), Some("test2"));
        // `destination static <mapped> <real>`: the template's first is what the packet arrives with.
        assert_eq!(n.columns.get("orig_dst").map(String::as_str), Some("test3"));
        assert_eq!(n.columns.get("trans_dst").map(String::as_str), Some("test4"));
        assert_eq!(n.columns.get("in_zone_if").map(String::as_str), Some("any"));
        assert_eq!(n.columns.get("out_zone_if").map(String::as_str), Some("outside"));
        assert_eq!(n.columns.get("type").map(String::as_str), Some("dynamic"));
        assert_eq!(n.columns.get("seq").map(String::as_str), Some("2"));
    }

    /// LT-553: `cisco_asa_show_route`'s own fixture row.
    #[test]
    fn an_asa_route_keeps_its_next_hop_and_interface() {
        let n = normalise("route", &json!({"protocol": "S", "type": "", "network": "10.54.6.0", "netmask": "255.255.255.0", "distance": "1", "metric": "0", "nexthopip": "10.0.5.12", "nexthopif": "outside", "uptime": ""}));
        assert_eq!(n.columns.get("next_hop").map(String::as_str), Some("10.0.5.12"));
        assert_eq!(n.columns.get("interface").map(String::as_str), Some("outside"));
    }

    /// LT-554: `aruba_aoscx_show_ip_route_all-vrfs`'s own fixture rows.
    #[test]
    fn an_aoscx_route_has_its_prefix_next_hops_protocol_and_distance() {
        let bgp = normalise("route", &json!({"interface": ["172.25.0.189", "172.25.0.185"], "ip_address": "0.0.0.0", "metric": ["[20/0]", "[20/0]"], "prefix_length": "0", "status": ["bgp", "bgp"], "vrf": "default"}));
        assert_eq!(bgp.columns.get("prefix").map(String::as_str), Some("0.0.0.0"));
        assert_eq!(bgp.columns.get("mask").map(String::as_str), Some("0"));
        assert_eq!(bgp.columns.get("next_hop").map(String::as_str), Some("172.25.0.189, 172.25.0.185"));
        assert_eq!(bgp.columns.get("interface"), None, "next hops are not interfaces");
        assert_eq!(bgp.columns.get("proto").map(String::as_str), Some("bgp"));
        assert_eq!((bgp.columns.get("ad").map(String::as_str), bgp.columns.get("metric").map(String::as_str)), (Some("20"), Some("0")));
        let connected = normalise("route", &json!({"interface": ["vlan3564"], "ip_address": "10.252.22.128", "metric": ["[0/0]"], "prefix_length": "26", "status": ["connected"], "vrf": "default"}));
        assert_eq!(connected.columns.get("interface").map(String::as_str), Some("vlan3564"));
        assert_eq!(connected.columns.get("next_hop"), None);
        assert_eq!(connected.columns.get("proto").map(String::as_str), Some("connected"));
    }

    /// LT-554: `aruba_aoscx_show_arp_all-vrfs` names the interface `port_id`.
    #[test]
    fn an_aoscx_arp_row_has_its_interface() {
        let n = normalise("arp", &json!({"ip_address": "192.0.2.1", "mac_address": "00:00:00:00:00:01", "port_id": "vlan10", "physical_port": "1/1/1", "state": "reachable", "vrf": "default"}));
        assert_eq!(n.columns.get("interface").map(String::as_str), Some("vlan10"));
    }

    /// LT-555: AOS-S names the interface `vlan_name`, a trunk member `local_port`.
    #[test]
    fn aoss_addresses_routes_and_trunks_keep_their_ports() {
        let ip = normalise("ip_address", &json!({"vlan_name": "DEFAULT_VLAN", "config": "Manual", "ip_address": "192.0.2.10", "subnet_mask": "255.255.255.0", "proxy": "No", "local": "No"}));
        assert_eq!(ip.columns.get("interface").map(String::as_str), Some("DEFAULT_VLAN"));
        let route = normalise("route", &json!({"destination": "192.0.2.0/24", "gateway": "DEFAULT_VLAN", "vlan_name": "1", "type": "connected", "subtype": "", "metric": "1", "distance": "0"}));
        assert_eq!(route.columns.get("interface").map(String::as_str), Some("1"));
        let trunk = normalise("lag", &json!({"local_port": "A1", "int_name": "", "int_type": "100/1000T", "trunk": "Trk1", "trunk_type": "LACP"}));
        assert_eq!(trunk.columns.get("members").map(String::as_str), Some("A1"));
        assert_eq!(trunk.columns.get("name").map(String::as_str), Some("Trk1"));
    }

    /// LT-537: PAN-OS says `disabled: yes` of a rule that is off. Stored as
    /// `enabled: yes`, the path builder would count a disabled rule.
    #[test]
    fn a_rule_that_says_disabled_is_stored_as_not_enabled() {
        let off = normalise("fw_policy", &json!({"name": "rule-a", "disabled": "yes", "action": "allow"}));
        assert_eq!(off.columns["enabled"], "no");
        let on = normalise("fw_policy", &json!({"name": "rule-b", "disabled": "no", "action": "allow"}));
        assert_eq!(on.columns["enabled"], "yes");
        let fortios = normalise("fw_policy", &json!({"policyid": "3", "status": "enable"}));
        assert_eq!(fortios.columns["enabled"], "enable");
    }

    #[test]
    fn an_ios_arp_row_lands_in_the_arp_table_with_its_extras_kept() {
        let n = normalise("arp", &json!({"protocol": "Internet", "ip_address": "192.0.2.1", "age": "0", "mac_address": "0000.0000.0001", "type": "ARPA", "interface": "Vlan10"}));
        assert_eq!(n.columns["ip"], "192.0.2.1");
        assert_eq!(n.columns["mac"], "0000.0000.0001");
        assert_eq!(n.columns["interface"], "Vlan10");
        assert_eq!(n.columns["age"], "0");
        assert_eq!(n.extra["protocol"], "Internet");
        assert_eq!(n.extra["type"], "ARPA");
    }

    #[test]
    fn a_route_with_list_next_hops_is_joined_and_a_neighbor_reads_lldp_names() {
        let r = normalise("route", &json!({"vrf": "", "protocol": "S", "network": "0.0.0.0", "mask": "0", "distance": "1", "metric": "0", "nexthop_ip": ["192.0.2.1", "192.0.2.2"], "nexthop_if": [], "uptime": "1w2d"}));
        assert_eq!(r.columns["next_hop"], "192.0.2.1, 192.0.2.2");
        assert_eq!(r.columns["prefix"], "0.0.0.0");
        assert!(!r.columns.contains_key("vrf"), "an empty value is not a column");
        let n = normalise("neighbor", &json!({"neighbor_name": "SW2", "local_interface": "Gi1/0/1", "neighbor_interface": "Gi1/0/24", "management_ip": "192.0.2.9", "platform": "cisco WS-C2960X", "capabilities": "Switch IGMP"}));
        assert_eq!(n.columns["rem_sysname"], "SW2");
        assert_eq!(n.columns["local_if"], "Gi1/0/1");
        assert_eq!(n.columns["rem_port_id"], "Gi1/0/24");
        assert_eq!(n.columns["rem_mgmt_ip"], "192.0.2.9");
    }

    #[test]
    fn nxos_json_tables_become_rows_with_underscored_keys() {
        let v = json!({"TABLE_vrf": {"ROW_vrf": [{"vrf-name-out": "default", "TABLE_adj": {"ROW_adj": [{"intf-out": "Vlan10", "ip-addr-out": "192.0.2.1", "time-stamp": "00:01:02", "mac": "0000.0000.0001"}]}}]}});
        // The outer table is the VRF; its nested adjacency table is kept whole.
        let rows = rows_from_json(&v);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["vrf-name-out"], "default");
        let inner = rows_from_json(&rows[0]["TABLE_adj"]);
        assert_eq!(inner.len(), 1);
        let n = normalise("arp", &inner[0]);
        assert_eq!(n.columns["ip"], "192.0.2.1");
        assert_eq!(n.columns["interface"], "Vlan10");
        assert_eq!(n.columns["mac"], "0000.0000.0001");
    }

    #[test]
    fn eos_json_objects_keyed_by_name_become_rows() {
        let v = json!({"interfaces": {"Ethernet1": {"lineProtocolStatus": "up", "interfaceStatus": "connected", "physicalAddress": "00:00:00:00:00:01", "mtu": 9214}, "Ethernet2": {"lineProtocolStatus": "down", "interfaceStatus": "notconnect", "physicalAddress": "00:00:00:00:00:02", "mtu": 9214}}});
        let rows = rows_from_json(&v);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["name"], "Ethernet1");
        let n = normalise("interface", &rows[0]);
        assert_eq!(n.columns["name"], "Ethernet1");
        assert_eq!(n.columns["mac"], "00:00:00:00:00:01");
        assert_eq!(n.columns["mtu"], "9214");
    }

    #[test]
    fn junos_xml_repeated_elements_become_rows() {
        let xml = r#"<rpc-reply><interface-information><physical-interface><name>ge-0/0/0</name><admin-status>up</admin-status><oper-status>up</oper-status><current-physical-address>00:00:00:00:00:01</current-physical-address></physical-interface><physical-interface><name>ge-0/0/1</name><admin-status>up</admin-status><oper-status>down</oper-status></physical-interface></interface-information></rpc-reply>"#;
        let rows = rows_from_xml(xml).unwrap();
        assert_eq!(rows.len(), 2);
        let n = normalise("interface", &rows[0]);
        assert_eq!(n.columns["name"], "ge-0/0/0");
        assert_eq!(n.columns["admin"], "up");
        assert_eq!(n.columns["oper"], "up");
        assert_eq!(n.extra["current_physical_address"], "00:00:00:00:00:01");
    }

    #[test]
    fn panos_xml_entries_carry_their_name_attribute() {
        let xml = r#"<response status="success"><result><entries><entry name="ethernet1/1"><zone>trust</zone><ip>192.0.2.1/24</ip></entry><entry name="ethernet1/2"><zone>untrust</zone><ip>198.51.100.1/24</ip></entry></entries></result></response>"#;
        let rows = rows_from_xml(xml).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["name"], "ethernet1/2");
        assert_eq!(rows[1]["zone"], "untrust");
    }

    #[test]
    fn every_feed_gets_every_row_and_the_raw_config_none() {
        let all = normalise_all(&["interface".into(), "ip_address".into(), "raw_config".into()], &[json!({"interface": "Vlan10", "ip_address": "192.0.2.1", "status": "up", "proto": "up"})]);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].table, "interface");
        assert_eq!(all[1].table, "ip_address");
        assert_eq!(all[1].columns["ip"], "192.0.2.1");
    }
}
