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
            ("model", &["model", "hardware", "hardware_model", "platform", "chassis", "product_name", "product", "chassis_id", "pid", "device_model", "board_type", "sc_model", "device_type"]),
            ("serial", &["serial", "serial_number", "serialnum", "sn", "chassis_sn", "proc_board_id", "serial_no", "chassis_serial", "system_serial"]),
            ("mgmt_ip", &["mgmt_ip", "management_ip", "ip_address", "ip"]),
            ("uptime", &["uptime", "up_time", "kern_uptm_days"]),
            ("base_mac", &["mac", "mac_address", "base_mac", "system_mac", "chassis_mac", "hw_mac_addr_start"]),
        ],
        "interface" => &[
            ("name", &["interface", "intf", "port", "name", "interface_name", "local_interface", "intf_name", "phys_intf", "ifname"]),
            ("admin", &["admin_state", "admin_status", "link_status", "status", "admin"]),
            ("oper", &["oper_status", "protocol", "line_protocol", "link", "link_state", "linkstate", "oper", "state", "operational"]),
            ("speed", &["speed", "bandwidth", "eth_speed", "eth_bw"]),
            ("duplex", &["duplex", "eth_duplex"]),
            ("mac", &["mac", "mac_address", "address", "hardware_address", "bia", "eth_hw_addr", "physical_address", "macaddress"]),
            ("descr", &["description", "descr", "desc", "name_alias", "alias", "interface_description"]),
            ("mtu", &["mtu", "eth_mtu"]),
            ("vlan", &["vlan", "vlan_id", "access_vlan", "native_vlan", "vlan_tag"]),
            ("mode", &["mode", "switchport_mode", "interface_mode", "admin_mode", "operational_mode", "switchport", "type"]),
            ("lag_parent", &["lag", "port_channel", "channel_group", "bundle", "aggregate", "member_of", "lag_parent"]),
        ],
        "ip_address" => &[
            ("interface", &["interface", "intf", "name", "port", "intf_name", "ifname", "vlan_name", "interface_alias"]),
            ("ip", &["ip", "ip_address", "ipaddr", "address", "ipv4", "primary_ip", "ip_addr", "prefix", "ip_address_prefix", "ipv6_address", "ipaddress", "ipv4_address"]),
            ("prefixlen", &["prefix_length", "prefixlen", "mask", "netmask", "subnet", "masklen", "prefix_len", "ipv4_netmask"]),
            ("vrf", &["vrf", "vrf_name", "routing_instance", "instance", "vpn_instance", "vrf_name_out", "vpn"]),
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
            ("interface", &["interface", "destination_port", "ports", "port", "interfaces", "intf", "port_name", "ifname", "dev"]),
            ("type", &["type", "entry_type", "mac_type", "kind", "state"]),
            ("age", &["age", "aging"]),
        ],
        "arp" => &[
            ("ip", &["ip", "ip_address", "address", "ipaddr", "ip_addr", "ip_addr_out", "dst", "destination", "neighbor", "ipaddress"]),
            ("mac", &["mac", "mac_address", "hardware_addr", "hw_address", "mac_addr", "hardware_address", "lladdr", "link_layer_address"]),
            ("interface", &["interface", "intf", "port", "intf_out", "port_id", "dev", "vmknic", "interface_alias", "name"]),
            ("age", &["age", "age_min", "age_sec", "time_stamp"]),
            ("vrf", &["vrf", "vrf_name", "vrf_name_out", "vr", "vpn"]),
        ],
        "vlan" => &[
            ("vlan_id", &["vlan_id", "vlan", "id", "vlanid", "vlanshowbr_vlanid"]),
            ("name", &["name", "vlan_name", "vlanshowbr_vlanname"]),
            ("state", &["status", "state", "vlanshowbr_vlanstate"]),
            ("ports", &["interfaces", "ports", "member_ports", "port", "untagged", "tagged", "vlanshowplist_ifidx"]),
        ],
        "lag" => &[
            ("name", &["bundle_name", "bundle_iface", "group", "po_name", "name", "aggregate", "lag", "lag_name", "lagnameshort", "port_channel", "po", "trunk", "trunk_group", "interface", "aggregate_name", "port_channel_name", "config_master"]),
            ("proto", &["protocol", "bundle_protocol", "mode", "proto", "type", "lagtype"]),
            ("members", &["member_interface", "member_intf", "interfaces", "members", "member", "ports", "port", "member_interfaces", "member_ports", "local_port", "portlist", "agg_mbr"]),
            ("state", &["bundle_status", "status", "state", "flags", "member_status"]),
        ],
        "stp" => &[
            ("instance", &["vlan_id", "vlan", "instance", "mst_id", "msti"]),
            ("root_bridge", &["root_mac", "root_bridge_mac", "root_id", "root_bridge", "root_address", "rootbridgeid"]),
            ("root_port", &["root_port", "rootport"]),
            ("bridge_prio", &["bridge_priority", "priority", "root_priority", "bridge_prio", "priorityhex"]),
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
            ("vrf", &["vrf", "vrf_name", "routing_instance", "table", "vrf_name_out", "table_name", "vr", "virtual_router"]),
            ("prefix", &["network", "prefix", "destination", "dest", "route", "network_prefix", "ipprefix", "ip_prefix", "ip_address", "dst", "destination_prefix", "ip_mask", "rt_destination"]),
            ("mask", &["mask", "prefixlen", "prefix_length", "netmask", "subnet", "masklen", "prefix_len"]),
            ("proto", &["protocol", "type", "source_proto", "route_source", "source", "clientname", "status", "protocol_name", "code"]),
            ("ad", &["distance", "admin_distance", "ad", "preference", "pref"]),
            ("metric", &["metric", "cost", "route_metric"]),
            ("next_hop", &["nexthop_ip", "next_hop", "nexthop", "gateway", "via", "next_hop_ip", "nh", "ipnexthop", "gw", "nexthopip", "nh_to"]),
            ("interface", &["nexthop_if", "interface", "outgoing_interface", "nexthop_interface", "out_interface", "exit_interface", "next_hop_interface", "ifname", "intf", "dev", "nexthopif", "vlan_name", "interface_alias", "nh_via"]),
            ("age", &["uptime", "age", "time"]),
        ],
        // LT-653: the forwarding table — the RIB's columns, a label, and the
        // adjacency kind (`attached`, `receive`, `drop`; Junos's `ucst`,
        // `locl`, `rjct`), which `fib_fixups` turns into a protocol or Null0.
        "fib" => &[
            ("vrf", &["vrf", "vrf_name", "routing_instance", "table", "vrf_name_out", "table_name", "vr", "virtual_router", "tab"]),
            ("prefix", &["network", "prefix", "destination", "dest", "route", "network_prefix", "ipprefix", "ip_prefix", "ip_address", "dst", "destination_prefix", "ip_mask", "rt_destination"]),
            ("mask", &["mask", "prefixlen", "prefix_length", "netmask", "subnet", "masklen", "prefix_len"]),
            ("proto", &["protocol", "proto", "source_proto", "route_source", "source", "protocol_name"]),
            ("ad", &["distance", "admin_distance", "ad", "preference", "pref"]),
            ("metric", &["metric", "cost", "route_metric"]),
            ("next_hop", &["nexthop_ip", "next_hop", "nexthop", "gateway", "via", "next_hop_ip", "nh", "ipnexthop", "gw", "nexthopip", "nh_to", "gwy"]),
            ("interface", &["nexthop_if", "interface", "outgoing_interface", "nexthop_interface", "out_interface", "exit_interface", "next_hop_interface", "ifname", "intf", "dev", "nexthopif", "vlan_name", "interface_alias", "nh_via"]),
            ("label", &["label", "labels", "out_label", "outgoing_label", "local_label", "mpls_label"]),
            ("adjacency", &["adjacency", "adj", "rewrite", "nh_type", "nh_nh_type", "nexthop_type", "destination_type", "flags"]),
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
            ("name", &["name", "tunnel", "interface", "peer", "tunnel_name", "vni", "nve", "system_ip"]),
            ("kind", &["kind", "type"]),
            ("local_ip", &["local_ip", "local", "local_address", "source", "src"]),
            ("remote_ip", &["remote_ip", "remote", "peer_ip", "peer_address", "destination", "dst", "peer_ip_address", "public_ip"]),
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
        // LT-540: where a policy applies — ASA `access-group`.
        "fw_binding" => &[("policy", &["access_list", "policy", "acl"]), ("interface", &["interface", "intf"]), ("direction", &["direction", "dir"])],
        // LT-540: the address and service objects rules name.
        "fw_object" => &[
            ("name", &["name", "object_name"]),
            ("type", &["type"]),
            ("host", &["host"]),
            ("network", &["network", "subnet"]),
            ("mask", &["netmask", "prefix_length", "mask"]),
            ("range_start", &["start_ip", "range_start"]),
            ("range_end", &["end_ip", "range_end"]),
            ("member", &["net_object", "grp_object", "svc_obj_name", "grp_obj_name", "member"]),
            ("protocol", &["protocol", "svc_protocol", "grp_protocol"]),
            ("port_op", &["dst_operator", "port_operator"]),
            ("port_start", &["dst_port_start", "port_start"]),
            ("port_end", &["dst_port_end", "port_end"]),
            ("fqdn", &["fqdn"]),
        ],
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
            // LT-656: what the AP's own CDP/LLDP says of its switch — the
            // address and chassis find a switch whose hostname differs.
            ("nbr_ip", &["nbr_ip", "neighbor_ip", "neighbor_address", "nbr_address", "neighbor_mgmt_ip"]),
            ("nbr_chassis", &["nbr_chassis", "neighbor_chassis", "chassis_id", "neighbor_chassis_id", "neighbor_mac"]),
            ("nbr_platform", &["nbr_platform", "neighbor_platform", "platform"]),
            ("local_port", &["local_port", "local_interface", "ap_port", "ap_interface"]),
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
        // LT-580: FortiOS (and AOS-CX) lists are `[{"name": …, "q_origin_key": …}]`;
        // each such object stands for its name.
        Value::Array(a) => a.iter().map(|x| x.get("name").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| scalar(x))).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", "),
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
        linux_route_fixups(&mut out.columns, &out.extra);
    }
    if table == "fib" {
        route_fixups(&mut out.columns);
        fib_fixups(&mut out.columns);
        linux_route_fixups(&mut out.columns, &out.extra);
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

/// LT-653: a forwarding table says where a packet goes in its own words —
/// CEF's `attached`, `receive`, `drop`, `no route`; NX-OS's `Attached`,
/// `Receive`, `Drop`; Junos's `ucst`, `locl`, `rjct`, `dscd`; a kernel's
/// `unreachable`. Those become the RIB's vocabulary: a connected or local
/// prefix, a Null0 interface, or a next hop kept as it is.
fn fib_fixups(c: &mut BTreeMap<String, String>) {
    let mut proto = c.get("proto").cloned().unwrap_or_default();
    let mut null = false;
    let mut hops: Vec<String> = Vec::new();
    if let Some(nh) = c.get("next_hop").cloned() {
        for h in nh.split(',').map(str::trim).filter(|h| !h.is_empty()) {
            match h.to_ascii_lowercase().as_str() {
                "attached" | "connected" | "direct" => {
                    if proto.is_empty() {
                        proto = "connected".into();
                    }
                }
                "receive" | "local" | "locl" | "identity" => {
                    if proto.is_empty() {
                        proto = "local".into();
                    }
                }
                "drop" | "discard" | "no route" | "noroute" | "null" | "null0" | "rjct" | "dscd" | "blackhole" | "unreachable" | "broadcast" | "bcst" | "mcst" | "mdsc" => null = true,
                _ => hops.push(h.to_string()),
            }
        }
    }
    if let Some(adj) = c.get("adjacency").map(|a| a.to_ascii_lowercase()) {
        match adj.as_str() {
            "locl" | "receive" | "local" => {
                if proto.is_empty() {
                    proto = "local".into();
                }
            }
            "intf" | "attached" | "connected" => {
                if proto.is_empty() {
                    proto = "connected".into();
                }
            }
            "rjct" | "dscd" | "drop" | "discard" | "unreachable" => null = true,
            _ => {}
        }
    }
    let hops: Vec<String> = hops.into_iter().filter(|h| h.parse::<std::net::IpAddr>().map(|a| !a.is_unspecified()).unwrap_or(false) || h.contains('%')).collect();
    if hops.is_empty() {
        c.remove("next_hop");
    } else {
        c.insert("next_hop".into(), hops.join(", "));
    }
    if null && !c.contains_key("interface") {
        c.insert("interface".into(), "Null0".into());
    }
    if !proto.is_empty() {
        c.insert("proto".into(), proto);
    }
}

/// LT-653: iproute2's words. `scope: link` with no gateway is a connected
/// subnet, `type: local` the box's own address, `type: unreachable` /
/// `blackhole` / `prohibit` a drop — none of which the `protocol` column
/// (`kernel`, `boot`) says.
fn linux_route_fixups(c: &mut BTreeMap<String, String>, extra: &Map<String, Value>) {
    let word = |k: &str| extra.get(k).and_then(Value::as_str).map(|v| v.to_ascii_lowercase()).unwrap_or_default();
    let proto = c.get("proto").cloned().unwrap_or_default();
    let plain = proto.is_empty() || matches!(proto.as_str(), "kernel" | "boot" | "static" | "dhcp");
    match word("type").as_str() {
        "local" => {
            if plain {
                c.insert("proto".into(), "local".into());
            }
        }
        "unreachable" | "blackhole" | "prohibit" => {
            c.entry("interface".into()).or_insert_with(|| "Null0".into());
        }
        _ => {
            if word("scope") == "link" && !c.contains_key("next_hop") && plain {
                c.insert("proto".into(), "connected".into());
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

/// The rows a reply gives, from where the parser left them: a structured
/// reply (`json`, `xml`) arrives as one wrapped document and is unwrapped
/// here; everything else is rows already.
pub fn rows_of(parser: &str, outcome: &crate::run::CommandOutcome) -> Vec<Value> {
    match parser {
        "json" => outcome.rows.first().and_then(|r| r.get("json")).map(rows_from_json).unwrap_or_else(|| outcome.rows.clone()),
        "xml" => outcome.rows.first().and_then(|r| r.get("xml")).and_then(Value::as_str).and_then(|x| rows_from_xml(x).ok()).unwrap_or_else(|| outcome.rows.clone()),
        _ => outcome.rows.clone(),
    }
}

/// A row read inside a context. A VRF's routes carry its name. LT-547: a
/// FortiGate VDOM or an ASA security context is a routing domain of its own,
/// so its routing rows are kept apart as a VRF of that name too, and every
/// row remembers where it was read, so a live check asks inside the same one.
pub fn tag_context(kind: &str, name: &str, n: &mut Normalised) {
    let routed = n.table == "route" || n.table == "fib" || n.table == "arp" || n.table == "routing_neighbor" || n.table == "ip_address";
    if kind == "vrf" && !n.columns.contains_key("vrf") && routed {
        n.columns.insert("vrf".into(), name.to_string());
    }
    if kind != "vrf" && kind != "instance" {
        n.extra.insert("_context".into(), serde_json::json!(format!("{kind}:{name}")));
        if (kind == "vdom" || kind == "context") && !n.columns.contains_key("vrf") && routed {
            n.columns.insert("vrf".into(), name.to_string());
        }
    }
}

/// One step's rows as the collection stores them: normalised into every
/// table the step feeds, tagged with the context it ran in, and a
/// neighbour or routing row given the protocol its command names. The app
/// and the lab harness (LT-558) both store through this.
pub fn rows_for_step(step: &coreview_catalog::Step, rows: &[Value]) -> Vec<Normalised> {
    let mut out = Vec::new();
    for mut n in normalise_all(&step.feeds, rows) {
        if let Some((kind, name)) = &step.context {
            tag_context(kind, name, &mut n);
        }
        if n.table == "neighbor" && !n.columns.contains_key("proto") {
            let proto = if step.cmd.contains("cdp") { "cdp" } else if step.cmd.contains("lldp") { "lldp" } else { "api" };
            n.columns.insert("proto".into(), proto.into());
        }
        if (n.table == "routing_neighbor" || n.table == "fhrp") && !n.columns.contains_key("proto") {
            for p in ["ospf", "eigrp", "bgp", "isis", "rip", "standby", "hsrp", "vrrp", "glbp", "magp", "ldp", "omp"] {
                if step.cmd.contains(p) {
                    n.columns.insert("proto".into(), if p == "standby" { "hsrp".into() } else { p.into() });
                    break;
                }
            }
        }
        out.push(n);
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

/// LT-608: a field of a device's own JSON that holds a secret — by its name
/// (`psksecret`, `password`, `auth-password-l1`, `api-key`, …) or by its
/// value (FortiOS's `ENC …` blobs). The CLI's secrets are scrubbed by
/// `scrub`; these never reach a row at all.
fn is_secret_field(key: &str, value: &Value) -> bool {
    let k = canon(key);
    if matches!(k.as_str(), "api_key" | "private_key" | "key_string" | "ipsec_key") {
        return true;
    }
    if k.split('_').any(|part| matches!(part, "password" | "passwd" | "secret" | "psk" | "psksecret" | "presharedkey" | "passphrase" | "community" | "token")) {
        return true;
    }
    value.as_str().is_some_and(|v| v.starts_with("ENC "))
}

fn push_row(row: &Value, key: Option<&str>, out: &mut Vec<Value>) {
    let mut flat = Map::new();
    flatten_into(row, "", &mut flat, 0);
    for (k, v) in flat.iter_mut() {
        if is_secret_field(k, v) {
            *v = Value::String("<removed-by-coreview>".into());
        }
    }
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
    // LT-654: Junos's routing table nests twice — `route-table` per table,
    // `rt` per prefix, `rt-entry` per protocol — and the generic rule
    // flattened a whole table into one row.
    if root.descendants().any(|n| n.is_element() && n.tag_name().name() == "route-table") {
        return Ok(junos_route_rows(root));
    }
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

/// Junos `show route | display xml`: one row per active `rt-entry` (every
/// entry when none is marked active), the table's name on each, the
/// entry's leaves flattened without a prefix — `protocol_name`,
/// `preference`, `nh_to`, `nh_via` — so an ECMP entry's hops are a list.
fn junos_route_rows(root: roxmltree::Node) -> Vec<Value> {
    let mut rows = Vec::new();
    for table in root.descendants().filter(|n| n.is_element() && n.tag_name().name() == "route-table") {
        let name = table.children().find(|c| c.is_element() && c.tag_name().name() == "table-name").and_then(|c| c.text()).unwrap_or("").trim().to_string();
        // LT-653: `show route forwarding-table` has `rt-entry` straight under the
        // table, each carrying its own `rt-destination`; the RIB wraps them in `rt`.
        for e in table.children().filter(|c| c.is_element() && c.tag_name().name() == "rt-entry") {
            let mut m = Map::new();
            flatten_xml(e, "", &mut m, 0);
            m.insert("table_name".into(), Value::String(name.clone()));
            // What the entry does: a next-hop type that decides on its own
            // (local, reject, discard), else the destination type (interface,
            // user, permanent).
            let nh_type = m.get("nh_nh_type").and_then(Value::as_str).unwrap_or("").to_string();
            let dest_type = m.get("destination_type").and_then(Value::as_str).unwrap_or("").to_string();
            let adjacency = if matches!(nh_type.as_str(), "locl" | "rjct" | "dscd" | "bcst" | "mcst" | "mdsc") { nh_type } else { dest_type };
            m.insert("adjacency".into(), Value::String(adjacency));
            rows.push(Value::Object(m));
        }
        for rt in table.children().filter(|c| c.is_element() && c.tag_name().name() == "rt") {
            let dest = rt.children().find(|c| c.is_element() && c.tag_name().name() == "rt-destination").and_then(|c| c.text()).unwrap_or("").trim().to_string();
            let entries: Vec<roxmltree::Node> = rt.children().filter(|c| c.is_element() && c.tag_name().name() == "rt-entry").collect();
            let is_active = |e: &roxmltree::Node| e.children().any(|c| c.is_element() && (c.tag_name().name() == "current-active" || (c.tag_name().name() == "active-tag" && c.text().map(str::trim) == Some("*"))));
            let active: Vec<roxmltree::Node> = entries.iter().copied().filter(is_active).collect();
            for e in if active.is_empty() { entries } else { active } {
                let mut m = Map::new();
                flatten_xml(e, "", &mut m, 0);
                m.insert("rt_destination".into(), Value::String(dest.clone()));
                m.insert("table_name".into(), Value::String(name.clone()));
                rows.push(Value::Object(m));
            }
        }
    }
    rows
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
    /// LT-608: a FortiGate's REST replies carry `ENC …` blobs and
    /// passwords in fields no column maps, which `extra` would keep.
    #[test]
    fn secrets_in_api_json_never_reach_a_row() {
        let body = json!({"results": [
            {"name": "to-branch", "interface": "wan1", "psksecret": "ENC AAAAfakefakefake==", "remote-gw": "203.0.113.9", "ike-version": "2"},
            {"name": "wan2", "mode": "pppoe", "username": "isp-user", "password": "ENC BBBBfakefake==", "ip": "0.0.0.0 0.0.0.0"},
            {"name": "x", "ppk-secret": "plain-fixture-value", "q_origin_key": "x", "api-key": "fixture", "token": "fixture"},
        ]});
        let rows = rows_from_json(&body["results"]);
        let text = serde_json::to_string(&rows).unwrap();
        for leaked in ["ENC AAAA", "ENC BBBB", "plain-fixture-value", "\"api-key\":\"fixture\"", "\"token\":\"fixture\""] {
            assert!(!text.contains(leaked), "{leaked} in {text}");
        }
        assert_eq!(rows[0]["psksecret"], "<removed-by-coreview>");
        assert_eq!(rows[0]["remote-gw"], "203.0.113.9", "the rest is kept");
        assert_eq!(rows[1]["username"], "isp-user", "a username is not a secret");
        assert_eq!(rows[2]["q_origin_key"], "x", "`key` inside another word is not a secret");
    }

    use super::*;
    use serde_json::json;

    /// LT-552: an ASA `show nat` row, as ntc's template writes it (the
    /// fixture's second rule), must land in the NAT columns.
    #[test]
    fn a_list_of_named_objects_is_its_names() {
        let n = normalise("fw_policy", &json!({"policyid": 25, "name": "Default", "srcintf": [{"name": "internal", "q_origin_key": "internal"}, {"name": "Printers", "q_origin_key": "Printers"}], "srcaddr": [{"name": "Printers address", "q_origin_key": "Printers address"}]}));
        assert_eq!(n.columns.get("src_zones").map(String::as_str), Some("internal, Printers"));
        assert_eq!(n.columns.get("src_addr").map(String::as_str), Some("Printers address"));
    }

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

    /// LT-550: the JSON hosts answer with, from each tool's documentation
    /// (iproute2, esxcli `--formatter=json`, PowerShell `ConvertTo-Json`) —
    /// not captured (D-058).
    #[test]
    fn host_json_lands_in_the_tables() {
        let n = normalise("arp", &json!({"dst": "192.0.2.1", "dev": "eth0", "lladdr": "00:00:00:00:00:01", "state": ["REACHABLE"]}));
        assert_eq!((n.columns["ip"].as_str(), n.columns["mac"].as_str(), n.columns["interface"].as_str()), ("192.0.2.1", "00:00:00:00:00:01", "eth0"));
        let r = normalise("route", &json!({"dst": "default", "gateway": "192.0.2.1", "dev": "eth0", "protocol": "dhcp", "table": "main"}));
        assert_eq!((r.columns["prefix"].as_str(), r.columns["next_hop"].as_str(), r.columns["interface"].as_str(), r.columns["vrf"].as_str()), ("default", "192.0.2.1", "eth0", "main"));
        let f = normalise("mac_table", &json!({"mac": "00:00:00:00:00:02", "ifname": "tap100i0", "vlan": 10, "state": "reachable"}));
        assert_eq!(f.columns["interface"], "tap100i0");
        // ESXi
        let nic = normalise("interface", &json!({"Name": "vmnic0", "MACAddress": "00:00:00:00:00:03", "AdminStatus": "Up", "LinkStatus": "Up", "Speed": 1000, "Duplex": "Full", "MTU": 1500, "Description": "Fake NIC"}));
        assert_eq!((nic.columns["name"].as_str(), nic.columns["mac"].as_str(), nic.columns["mtu"].as_str()), ("vmnic0", "00:00:00:00:00:03", "1500"));
        let vmk = normalise("ip_address", &json!({"Name": "vmk0", "IPv4Address": "192.0.2.20", "IPv4Netmask": "255.255.255.0"}));
        assert_eq!((vmk.columns["interface"].as_str(), vmk.columns["ip"].as_str(), vmk.columns["prefixlen"].as_str()), ("vmk0", "192.0.2.20", "255.255.255.0"));
        let nb = normalise("arp", &json!({"Neighbor": "192.0.2.1", "MacAddress": "00:00:00:00:00:04", "Vmknic": "vmk0"}));
        assert_eq!((nb.columns["ip"].as_str(), nb.columns["interface"].as_str()), ("192.0.2.1", "vmk0"));
        // Windows
        let ad = normalise("interface", &json!({"Name": "Ethernet0", "MacAddress": "00-00-00-00-00-05", "Status": "Up", "InterfaceDescription": "Fake Adapter"}));
        assert_eq!((ad.columns["mac"].as_str(), ad.columns["descr"].as_str()), ("00-00-00-00-00-05", "Fake Adapter"));
        let ip = normalise("ip_address", &json!({"IPAddress": "192.0.2.30", "InterfaceAlias": "Ethernet0", "PrefixLength": 24, "AddressFamily": 2}));
        assert_eq!((ip.columns["ip"].as_str(), ip.columns["interface"].as_str(), ip.columns["prefixlen"].as_str()), ("192.0.2.30", "Ethernet0", "24"));
        let rt = normalise("route", &json!({"DestinationPrefix": "0.0.0.0/0", "NextHop": "192.0.2.1", "InterfaceAlias": "Ethernet0", "RouteMetric": 0}));
        assert_eq!((rt.columns["prefix"].as_str(), rt.columns["next_hop"].as_str(), rt.columns["interface"].as_str()), ("0.0.0.0/0", "192.0.2.1", "Ethernet0"));
        let ne = normalise("arp", &json!({"IPAddress": "192.0.2.1", "LinkLayerAddress": "00-00-00-00-00-06", "InterfaceAlias": "Ethernet0", "State": 2}));
        assert_eq!((ne.columns["ip"].as_str(), ne.columns["mac"].as_str()), ("192.0.2.1", "00-00-00-00-00-06"));
    }

    #[test]
    fn a_vdoms_routes_are_a_vrf_of_its_name_and_every_row_says_where_it_was_read() {
        let mut route = normalise("route", &json!({"network": "0.0.0.0/0", "nexthop_ip": "192.0.2.254"}));
        tag_context("vdom", "dmz", &mut route);
        assert_eq!(route.columns.get("vrf").map(String::as_str), Some("dmz"));
        assert_eq!(route.extra["_context"], "vdom:dmz");
        let mut zone = normalise("fw_zone", &json!({"name": "lan"}));
        tag_context("vdom", "dmz", &mut zone);
        assert!(!zone.columns.contains_key("vrf"));
        assert_eq!(zone.extra["_context"], "vdom:dmz");
        // A vsys is not a routing domain: PAN-OS routes by virtual router.
        let mut pan = normalise("route", &json!({"destination": "0.0.0.0/0"}));
        tag_context("vsys", "vsys2", &mut pan);
        assert!(!pan.columns.contains_key("vrf"));
        // A VRF's own name is kept where the row already has one.
        let mut vrf = normalise("route", &json!({"network": "0.0.0.0/0", "vrf": "BLUE"}));
        tag_context("vrf", "RED", &mut vrf);
        assert_eq!(vrf.columns.get("vrf").map(String::as_str), Some("BLUE"));
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

    /// LT-654: a Junos router's `show route | display xml` — two tables, a
    /// prefix with an active static and an inactive OSPF entry, ECMP next
    /// hops — reaches the `route` table one row per active entry, the table
    /// name as the VRF. It did not: `rt-destination` had no synonym and the
    /// repeated `route-table` swallowed every `rt` into one row.
    #[test]
    fn junos_route_xml_becomes_one_route_row_per_active_entry() {
        let xml = r#"<rpc-reply><route-information>
          <route-table><table-name>inet.0</table-name><destination-count>2</destination-count>
            <rt><rt-destination>10.0.0.0/24</rt-destination>
              <rt-entry><active-tag>*</active-tag><current-active/><protocol-name>Static</protocol-name><preference>5</preference><age seconds="100">00:01:40</age>
                <nh><selected-next-hop/><to>192.0.2.1</to><via>ge-0/0/0.0</via></nh><nh><to>192.0.2.5</to><via>ge-0/0/1.0</via></nh></rt-entry>
              <rt-entry><protocol-name>OSPF</protocol-name><preference>10</preference><metric>2</metric><nh><to>192.0.2.9</to><via>ge-0/0/2.0</via></nh></rt-entry>
            </rt>
            <rt><rt-destination>0.0.0.0/0</rt-destination><rt-entry><active-tag>*</active-tag><current-active/><protocol-name>Static</protocol-name><preference>5</preference><nh><to>192.0.2.254</to><via>ge-0/0/3.0</via></nh></rt-entry></rt>
          </route-table>
          <route-table><table-name>CUST-A.inet.0</table-name>
            <rt><rt-destination>172.16.0.0/16</rt-destination><rt-entry><active-tag>*</active-tag><current-active/><protocol-name>BGP</protocol-name><preference>170</preference><nh><to>192.0.2.17</to><via>ge-0/0/4.0</via></nh></rt-entry></rt>
          </route-table>
        </route-information></rpc-reply>"#;
        let rows = rows_from_xml(xml).unwrap();
        assert_eq!(rows.len(), 3, "{rows:?}");
        let r: Vec<Normalised> = rows.iter().map(|r| normalise("route", r)).collect();
        assert_eq!(r[0].columns["prefix"], "10.0.0.0/24");
        assert_eq!(r[0].columns["vrf"], "inet.0");
        assert_eq!(r[0].columns["proto"], "Static");
        assert_eq!(r[0].columns["ad"], "5");
        assert_eq!(r[0].columns["next_hop"], "192.0.2.1, 192.0.2.5");
        assert_eq!(r[0].columns["interface"], "ge-0/0/0.0, ge-0/0/1.0");
        assert_eq!(r[1].columns["prefix"], "0.0.0.0/0");
        assert_eq!(r[2].columns["vrf"], "CUST-A.inet.0");
        assert_eq!(r[2].columns["proto"], "BGP");
        assert_eq!(r[2].columns["next_hop"], "192.0.2.17");
    }

    /// LT-653: forwarding tables in their own words become the RIB's.
    #[test]
    fn a_forwarding_table_row_speaks_the_ribs_vocabulary() {
        // IOS `show ip cef`: attached, receive, drop, an ECMP pair, a plain next hop.
        let cef = |nh: &[&str], ifs: &[&str]| json!({"ip_address": "10.0.0.0", "prefix_length": "24", "nexthop": nh, "interface": ifs});
        let n = normalise("fib", &cef(&["attached"], &["GigabitEthernet0/1"]));
        assert_eq!((n.columns["proto"].as_str(), n.columns["interface"].as_str(), n.columns.get("next_hop")), ("connected", "GigabitEthernet0/1", None));
        let n = normalise("fib", &cef(&["receive"], &["GigabitEthernet0/1"]));
        assert_eq!(n.columns["proto"], "local");
        let n = normalise("fib", &cef(&["drop"], &[]));
        assert_eq!((n.columns["interface"].as_str(), n.columns.get("next_hop")), ("Null0", None));
        let n = normalise("fib", &cef(&["no route"], &[]));
        assert_eq!(n.columns["interface"], "Null0");
        let n = normalise("fib", &cef(&["192.0.2.1", "192.0.2.5"], &["GigabitEthernet0/1", "GigabitEthernet0/2"]));
        assert_eq!((n.columns["next_hop"].as_str(), n.columns["interface"].as_str(), n.columns["prefix"].as_str(), n.columns["mask"].as_str()), ("192.0.2.1, 192.0.2.5", "GigabitEthernet0/1, GigabitEthernet0/2", "10.0.0.0", "24"));
        // NX-OS `show forwarding ipv4 route`.
        let n = normalise("fib", &json!({"ip_address": "10.1.0.0", "prefix_length": "16", "nexthop": ["Attached"], "interface": ["Vlan10"]}));
        assert_eq!(n.columns["proto"], "connected");
        // Junos `show route forwarding-table`: the nh-type decides.
        let xml = r#"<rpc-reply><forwarding-table-information><route-table><table-name>default.inet</table-name><address-family>Internet</address-family>
          <rt-entry><rt-destination>default</rt-destination><destination-type>perm</destination-type><nh><nh-type>rjct</nh-type><nh-index>36</nh-index></nh></rt-entry>
          <rt-entry><rt-destination>10.0.0.0/24</rt-destination><destination-type>user</destination-type><nh><nh-type>ucst</nh-type><nh-index>581</nh-index><to>192.0.2.1</to><via>ge-0/0/0.0</via></nh></rt-entry>
          <rt-entry><rt-destination>192.0.2.0/30</rt-destination><destination-type>intf</destination-type><nh><nh-type>rslv</nh-type><nh-index>582</nh-index><via>ge-0/0/0.0</via></nh></rt-entry>
          <rt-entry><rt-destination>192.0.2.2/32</rt-destination><destination-type>intf</destination-type><nh><nh-type>locl</nh-type><nh-index>583</nh-index></nh></rt-entry>
        </route-table></forwarding-table-information></rpc-reply>"#;
        let rows = rows_from_xml(xml).unwrap();
        let r: Vec<Normalised> = rows.iter().map(|r| normalise("fib", r)).collect();
        assert_eq!(r.len(), 4, "{rows:?}");
        assert_eq!((r[0].columns["prefix"].as_str(), r[0].columns["interface"].as_str(), r[0].columns["vrf"].as_str()), ("default", "Null0", "default.inet"));
        assert_eq!((r[1].columns["prefix"].as_str(), r[1].columns["next_hop"].as_str(), r[1].columns["interface"].as_str()), ("10.0.0.0/24", "192.0.2.1", "ge-0/0/0.0"));
        assert_eq!((r[2].columns["proto"].as_str(), r[2].columns["interface"].as_str()), ("connected", "ge-0/0/0.0"));
        assert_eq!(r[3].columns["proto"], "local");
    }

    /// LT-653: a kernel's routes say what they are in iproute2's words.
    #[test]
    fn iproute2_rows_say_connected_local_and_drop() {
        for table in ["route", "fib"] {
            let n = normalise(table, &json!({"dst": "192.0.2.0/24", "dev": "eth0", "protocol": "kernel", "scope": "link", "prefsrc": "192.0.2.11"}));
            assert_eq!((n.columns["proto"].as_str(), n.columns["interface"].as_str(), n.columns.get("next_hop")), ("connected", "eth0", None), "{table}");
            let n = normalise(table, &json!({"type": "local", "dst": "192.0.2.11", "dev": "eth0", "table": "local", "protocol": "kernel", "scope": "host"}));
            assert_eq!(n.columns["proto"], "local");
            let n = normalise(table, &json!({"type": "blackhole", "dst": "10.0.0.0/8", "protocol": "static"}));
            assert_eq!(n.columns["interface"], "Null0");
            let n = normalise(table, &json!({"dst": "default", "gateway": "192.0.2.1", "dev": "eth0", "protocol": "dhcp", "metric": 100}));
            assert_eq!((n.columns["proto"].as_str(), n.columns["next_hop"].as_str()), ("dhcp", "192.0.2.1"));
        }
    }

    /// LT-658: the ASA's `show interface` and the AireOS controller's
    /// `show interface summary` carry addresses their catalogs never fed.
    #[test]
    fn an_asa_and_an_aireos_interface_row_give_an_address() {
        let asa = normalise("ip_address", &json!({"interface": "GigabitEthernet0/0", "interface_zone": "outside", "link_status": "up", "protocol_status": "up", "mac_address": "0000.0000.0a01", "mtu": "1500", "ip_address": "198.51.100.2", "netmask": "255.255.255.0"}));
        assert_eq!((asa.columns["interface"].as_str(), asa.columns["ip"].as_str(), asa.columns["prefixlen"].as_str()), ("GigabitEthernet0/0", "198.51.100.2", "255.255.255.0"));
        assert_eq!(asa.extra["interface_zone"], "outside");
        let wlc = normalise("ip_address", &json!({"int_count": "3", "name": "management", "port": "1", "vlan_id": "10", "ip_address": "192.0.2.5", "type": "Static", "ap_mgr": "Yes", "guest": "No"}));
        assert_eq!((wlc.columns["interface"].as_str(), wlc.columns["ip"].as_str()), ("management", "192.0.2.5"));
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
