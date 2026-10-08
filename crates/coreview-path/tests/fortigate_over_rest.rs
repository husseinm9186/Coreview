//! On the lab's FortiGate, end to end: its REST replies in the shapes
//! a FortiGate 60F on FortiOS 7.6.7 answered (a lab),
//! stored through the FortiOS catalog's own feeds the way a collection
//! stores them, and walked. Invented names and documentation addresses;
//! the layout of every body is the lab's.
//!
//! What it holds, each found on the lab: lists of
//! `{"name": …}` read as names, addresses and groups as objects rather than
//! policies, the SD-WAN zone a policy names holding the interface the route
//! leaves by, and a rule matching internet-service sources — public ranges
//! FortiGuard publishes — never matching a private address.

use std::collections::BTreeMap;

use coreview_path::firewall::Verdict;
use coreview_path::walk::Request;
use coreview_topology::{DeviceIn, Row};
use serde_json::{json, Value};

fn catalog_step(api: &str) -> coreview_catalog::Step {
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/catalog");
    let catalogs = coreview_catalog::load_dir(&dir).unwrap();
    let c = catalogs.iter().find(|c| c.os == "fortios").unwrap().commands.iter().find(|c| c.api.as_deref() == Some(api)).unwrap_or_else(|| panic!("no FortiOS command reads {api}"));
    coreview_catalog::Step { id: c.id.clone(), cmd: c.cmd.clone(), gate: c.gate.clone(), because: vec![], parser: "api".into(), feeds: c.feeds.clone(), weight: c.weight(), timeout: c.timeout(), verified: c.verified, context: None, scope: None }
}

/// One REST reply stored as a collection stores it.
fn store(tables: &mut BTreeMap<String, Vec<Row>>, api: &str, body: Value) {
    let step = catalog_step(api);
    let rows = coreview_collect::api::fortios::rows_for(api, &body);
    for n in coreview_collect::tables::rows_for_step(&step, &rows) {
        tables.entry(n.table.clone()).or_default().push(Row { command: step.id.clone(), columns: n.columns, extra: n.extra });
    }
}

fn row(command: &str, cols: &[(&str, &str)]) -> Row {
    Row { command: command.into(), columns: cols.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), extra: Default::default() }
}

fn names(list: &[&str]) -> Value {
    Value::Array(list.iter().map(|n| json!({"name": n, "q_origin_key": n})).collect())
}

// One FortiOS policy as its REST reply writes it, every field named.
#[allow(clippy::too_many_arguments)]
fn policy(id: u32, name: &str, src_if: &[&str], dst_if: &[&str], src: &[&str], dst: &[&str], svc: &[&str], action: &str) -> Value {
    json!({"policyid": id, "q_origin_key": id, "name": name, "status": "enable", "srcintf": names(src_if), "dstintf": names(dst_if), "action": action,
           "srcaddr": names(src), "dstaddr": names(dst), "internet-service": "disable", "internet-service-name": [], "internet-service-src": "disable", "internet-service-src-name": [],
           "service": names(svc), "schedule": "always", "nat": "enable"})
}

fn fortigate() -> DeviceIn {
    let mut t: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    t.insert("device".into(), vec![row("get_system_status", &[("hostname", "LAB-FGT"), ("serial", "FGTFAKE0000001")])]);
    t.insert("ip_address".into(), vec![
        row("get_system_interface", &[("interface", "internal"), ("ip", "192.0.2.1"), ("prefixlen", "255.255.255.0")]),
        row("get_system_interface", &[("interface", "wan2"), ("ip", "203.0.113.2"), ("prefixlen", "255.255.255.0")]),
    ]);
    // Every interface, as `get system interface` lists them — the policies name
    // two that carry no address here.
    t.insert("interface".into(), ["internal", "wan2", "netMGMT", "Printers", "internal5"].iter().map(|i| row("get_system_interface", &[("name", i)])).collect());
    t.insert("route".into(), vec![
        row("get_router_info_routing_table_all", &[("prefix", "0.0.0.0/0"), ("proto", "S"), ("next_hop", "203.0.113.1"), ("interface", "wan2")]),
        row("get_router_info_routing_table_all", &[("prefix", "192.0.2.0/24"), ("proto", "C"), ("interface", "internal")]),
        row("get_router_info_routing_table_all", &[("prefix", "203.0.113.0/24"), ("proto", "C"), ("interface", "wan2")]),
    ]);
    t.insert("arp".into(), vec![
        row("get_system_arp", &[("ip", "192.0.2.132"), ("mac", "00:00:00:00:01:32"), ("interface", "internal")]),
        row("get_system_arp", &[("ip", "192.0.2.133"), ("mac", "00:00:00:00:01:33"), ("interface", "internal")]),
    ]);
    let mut isdb = policy(7, "Out_Deny_ISDB", &["internal"], &["virtual-wan-link"], &[], &["all"], &["ALL"], "deny");
    isdb["internet-service-src"] = json!("enable");
    isdb["internet-service-src-name"] = names(&["Botnet-C&C.Server", "Tor-Exit.Node"]);
    store(&mut t, "/api/v2/cmdb/firewall/policy", json!({"http_method": "GET", "results": [
        policy(39, "Lan-Mgmt", &["internal"], &["netMGMT"], &["internal"], &["netMGMT address"], &["ALL"], "accept"),
        policy(5, "block-youtube", &["any"], &["virtual-wan-link"], &["all"], &["all"], &["QUIC"], "deny"),
        policy(37, "Partners", &["internal"], &["virtual-wan-link"], &["internal"], &["Partner-Net", "Partner-Group"], &["ALL"], "accept"),
        isdb,
        policy(22, "Kids", &["internal"], &["virtual-wan-link"], &["Kid-Phone"], &["all"], &["HTTPS"], "deny"),
        policy(18, "Vendor-Out", &["internal"], &["virtual-wan-link"], &["internal"], &["Vendor_Portal"], &["ALL"], "accept"),
        policy(25, "Default", &["internal", "Printers"], &["virtual-wan-link"], &["internal", "Printers address"], &["all"], &["ALL"], "accept"),
    ], "status": "success"}));
    store(&mut t, "/api/v2/cmdb/firewall/address", json!({"results": [
        {"name": "internal", "type": "interface-subnet", "subnet": "192.0.2.0 255.255.255.0", "interface": "internal"},
        {"name": "Printers address", "type": "interface-subnet", "subnet": "198.51.100.0 255.255.255.0"},
        {"name": "Partner-Net", "type": "ipmask", "subnet": "198.51.100.64 255.255.255.192"},
        {"name": "Partner-Range", "type": "iprange", "start-ip": "198.51.100.200", "end-ip": "198.51.100.210"},
        {"name": "-Geo", "type": "geography", "country": "US"},
        {"name": "Vendor_Portal", "type": "fqdn", "fqdn": "portal.example.net"},
        // The lab's MAC object shape.
        {"name": "Kid-Phone", "type": "mac", "macaddr": [{"macaddr": "00:00:00:00:01:33", "q_origin_key": "00:00:00:00:01:33"}]},
    ]}));
    // What the FortiGate resolved it to, asked by name.
    store(&mut t, "/api/v2/monitor/firewall/address-fqdns", json!({"results": [{"name": "Vendor_Portal", "fqdn": "portal.example.net", "addrs": ["198.51.100.150"], "wildcard": false}]}));
    store(&mut t, "/api/v2/cmdb/firewall/addrgrp", json!({"results": [{"name": "Partner-Group", "member": names(&["Partner-Range"])}]}));
    store(&mut t, "/api/v2/cmdb/system/sdwan", json!({"results": {"status": "enable", "zone": [{"name": "virtual-wan-link"}],
        "members": [{"seq-num": 2, "interface": "wan2", "zone": "virtual-wan-link"}, {"seq-num": 3, "interface": "internal5", "zone": "virtual-wan-link"}]}}));
    DeviceIn { device_id: "fgt".into(), host: "192.0.2.1".into(), os: Some("fortios".into()), role: Some("firewall".into()), prompt: "LAB-FGT # ".into(), version_text: String::new(), tables: t }
}

fn verdict(to: &str, protocol: &str, port: u16) -> (Verdict, Option<String>) {
    verdict_from("192.0.2.132", to, protocol, port)
}

fn verdict_from(from: &str, to: &str, protocol: &str, port: u16) -> (Verdict, Option<String>) {
    let r = Request { from: from.into(), to: to.into(), protocol: Some(protocol.into()), port: Some(port), ..Default::default() };
    let out = coreview_path::trace_run(&[fortigate()], &r);
    let fw = out.forward.paths[0].hops[0].firewall.clone().unwrap_or_else(|| panic!("no firewall decision: {:?}", out.forward));
    (fw.verdict, fw.policy)
}

#[test]
fn quic_is_denied_by_the_rule_above_the_default() {
    assert_eq!(verdict("8.8.8.8", "udp", 443), (Verdict::Deny, Some("block-youtube (5)".into())));
}

#[test]
fn https_to_the_internet_is_allowed_and_a_partner_range_goes_by_its_own_rule() {
    assert_eq!(verdict("8.8.8.8", "tcp", 443), (Verdict::Allow, Some("Default (25)".into())));
    assert_eq!(verdict("198.51.100.205", "tcp", 443), (Verdict::Allow, Some("Partners (37)".into())));
}

#[test]
fn an_fqdn_address_is_decided_by_what_the_fortigate_resolved_it_to() {
    assert_eq!(verdict("198.51.100.150", "tcp", 443), (Verdict::Allow, Some("Vendor-Out (18)".into())));
}

#[test]
fn a_mac_address_rule_is_decided_by_the_mac_the_firewall_has_for_the_source() {
    // 192.0.2.133 is the kid's phone by its MAC; 192.0.2.132 is not.
    assert_eq!(verdict_from("192.0.2.133", "8.8.8.8", "tcp", 443), (Verdict::Deny, Some("Kids (22)".into())));
    assert_eq!(verdict_from("192.0.2.132", "8.8.8.8", "tcp", 443), (Verdict::Allow, Some("Default (25)".into())));
}
