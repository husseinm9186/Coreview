//! Small networks with the path each must give, written out by hand
//! (LT-531–LT-534). Rows are what `collection_db::read_table` returns: the
//! spec's columns and the command they came from. Invented names and
//! documentation or private addresses only (D-027).

use std::collections::BTreeMap;

use coreview_path::compare::{self, Outcome};
use coreview_path::firewall::Verdict;
use coreview_path::walk::{Decision, DownLink, Ending, Path, Request};
use coreview_topology::{DeviceIn, Row};

fn row(command: &str, cols: &[(&str, &str)]) -> Row {
    Row { command: command.into(), columns: cols.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), extra: Default::default() }
}

fn device(name: &str, host: &str, os: &str, role: &str, serial: &str, tables: Vec<(&str, Vec<Row>)>) -> DeviceIn {
    let mut t: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    t.entry("device".into()).or_default().push(row("show_version", &[("hostname", name), ("serial", serial)]));
    for (n, rows) in tables {
        t.entry(n.to_string()).or_default().extend(rows);
    }
    DeviceIn { device_id: name.to_ascii_lowercase(), host: host.into(), os: Some(os.into()), role: Some(role.into()), prompt: format!("{name}#"), version_text: String::new(), tables: t }
}

fn addr(iface: &str, ip: &str, len: &str) -> Row {
    row("show_ip_interface_brief", &[("interface", iface), ("ip", ip), ("prefixlen", len)])
}

fn route(prefix: &str, len: &str, proto: &str, nh: &str, iface: &str) -> Row {
    let mut cols = vec![("prefix", prefix), ("mask", len), ("proto", proto)];
    if !nh.is_empty() {
        cols.push(("next_hop", nh));
    }
    if !iface.is_empty() {
        cols.push(("interface", iface));
    }
    row("show_ip_route", &cols)
}

fn arp(ip: &str, mac: &str, iface: &str) -> Row {
    row("show_ip_arp", &[("ip", ip), ("mac", mac), ("interface", iface)])
}

fn mac(vlan: &str, m: &str, port: &str) -> Row {
    row("show_mac_address_table", &[("vlan", vlan), ("mac", m), ("interface", port), ("type", "DYNAMIC")])
}

fn cdp(local: &str, name: &str, port: &str) -> Row {
    row("show_cdp_neighbors_detail", &[("local_if", local), ("rem_sysname", name), ("rem_port_id", port), ("proto", "cdp")])
}

fn req(from: &str, to: &str) -> Request {
    Request { from: from.into(), to: to.into(), ..Default::default() }
}

fn routers(p: &Path) -> Vec<String> {
    compare::routers(p)
}

fn run(devices: &[DeviceIn], r: &Request) -> Outcome {
    coreview_path::trace_run(devices, r)
}

// ------------------------------------------------------------ a routed core

/// ACC1 is the gateway for 192.0.2.0/24 and has two equal-cost OSPF routes
/// to 203.0.113.0/24, through CORE1 and CORE2, both reaching DC1.
fn routed_core() -> Vec<DeviceIn> {
    let acc1 = device(
        "ACC1",
        "192.0.2.1",
        "cisco_ios",
        "l3_switch",
        "FAKEACC0001",
        vec![
            ("ip_address", vec![addr("Vlan10", "192.0.2.1", "24"), addr("Gi1/0/49", "198.51.100.1", "30"), addr("Gi1/0/50", "198.51.100.5", "30")]),
            (
                "route",
                vec![
                    route("192.0.2.0", "24", "C", "", "Vlan10"),
                    route("198.51.100.0", "30", "C", "", "Gi1/0/49"),
                    route("198.51.100.4", "30", "C", "", "Gi1/0/50"),
                    route("203.0.113.0", "24", "O", "198.51.100.2", "Gi1/0/49"),
                    route("203.0.113.0", "24", "O", "198.51.100.6", "Gi1/0/50"),
                ],
            ),
            ("arp", vec![arp("192.0.2.50", "0000.0000.5001", "Vlan10"), arp("198.51.100.2", "0000.0000.c101", "Gi1/0/49"), arp("198.51.100.6", "0000.0000.c201", "Gi1/0/50")]),
            ("mac_table", vec![mac("10", "0000.0000.5001", "Gi1/0/5")]),
            ("neighbor", vec![cdp("Gi1/0/49", "CORE1", "Gi1/1"), cdp("Gi1/0/50", "CORE2", "Gi1/1")]),
        ],
    );
    let core = |name: &str, serial: &str, up: &str, up_peer: &str, down: &str, down_net: &str, dc_peer: &str, mac_up: &str| {
        device(
            name,
            up,
            "cisco_ios",
            "router",
            serial,
            vec![
                ("interface", vec![row("show_interfaces", &[("name", "Gi1/1"), ("mac", mac_up)])]),
                ("ip_address", vec![addr("Gi1/1", up, "30"), addr("Gi1/2", down, "30")]),
                (
                    "route",
                    vec![
                        route(&net_of(up), "30", "C", "", "Gi1/1"),
                        route(down_net, "30", "C", "", "Gi1/2"),
                        route("203.0.113.0", "24", "O", dc_peer, "Gi1/2"),
                        route("192.0.2.0", "24", "O", up_peer, "Gi1/1"),
                    ],
                ),
                ("neighbor", vec![cdp("Gi1/1", "ACC1", if name == "CORE1" { "Gi1/0/49" } else { "Gi1/0/50" }), cdp("Gi1/2", "DC1", if name == "CORE1" { "Gi0/1" } else { "Gi0/2" })]),
            ],
        )
    };
    let core1 = core("CORE1", "FAKECOR0001", "198.51.100.2", "198.51.100.1", "198.51.100.9", "198.51.100.8", "198.51.100.10", "0000.0000.c101");
    let core2 = core("CORE2", "FAKECOR0002", "198.51.100.6", "198.51.100.5", "198.51.100.13", "198.51.100.12", "198.51.100.14", "0000.0000.c201");
    let dc1 = device(
        "DC1",
        "198.51.100.10",
        "cisco_nxos",
        "l3_switch",
        "FAKEDC00001",
        vec![
            ("ip_address", vec![addr("Vlan20", "203.0.113.1", "24"), addr("Eth1/1", "198.51.100.10", "30"), addr("Eth1/2", "198.51.100.14", "30")]),
            (
                "route",
                vec![
                    route("203.0.113.0", "24", "direct", "", "Vlan20"),
                    route("198.51.100.8", "30", "direct", "", "Eth1/1"),
                    route("198.51.100.12", "30", "direct", "", "Eth1/2"),
                    route("192.0.2.0", "24", "ospf-1", "198.51.100.9", "Eth1/1"),
                    route("192.0.2.0", "24", "ospf-1", "198.51.100.13", "Eth1/2"),
                ],
            ),
            ("arp", vec![arp("203.0.113.50", "0000.0000.5002", "Vlan20")]),
            ("mac_table", vec![mac("20", "0000.0000.5002", "Eth1/10")]),
        ],
    );
    vec![acc1, core1, core2, dc1]
}

fn net_of(ip: &str) -> String {
    let a: std::net::Ipv4Addr = ip.parse().unwrap();
    std::net::Ipv4Addr::from(u32::from(a) & 0xffff_fffc).to_string()
}

#[test]
fn equal_cost_routes_are_two_paths_that_both_arrive() {
    let out = run(&routed_core(), &req("192.0.2.50", "203.0.113.50"));
    let f = &out.forward;
    assert_eq!(f.paths.len(), 2, "{f:#?}");
    let mut seen: Vec<Vec<String>> = f.paths.iter().map(routers).collect();
    seen.sort();
    assert_eq!(seen, vec![vec!["ACC1", "CORE1", "DC1"], vec!["ACC1", "CORE2", "DC1"]]);
    for p in &f.paths {
        let first = &p.hops[0];
        assert_eq!(first.decision, Decision::Lpm);
        assert_eq!(first.ecmp, 2);
        assert_eq!(first.in_interface.as_deref(), Some("Vlan10"));
        assert_eq!(first.matched.as_ref().unwrap().prefix, "203.0.113.0/24");
        let last = p.hops.last().unwrap();
        assert_eq!(last.decision, Decision::Connected);
        match &p.ending {
            Ending::Delivered { device: None, endpoint: Some(place) } => {
                assert_eq!(place.switch, "DC1");
                assert_eq!(place.port, "Eth1/10");
            }
            other => panic!("{other:?}"),
        }
    }
    // The source placed where its MAC is learned, and the gateway named.
    let s = f.source.as_ref().unwrap();
    assert_eq!(s.starts, vec!["ACC1"]);
    let ep = s.endpoint.as_ref().unwrap();
    assert_eq!((ep.switch.as_str(), ep.port.as_str()), ("ACC1", "Gi1/0/5"));
}

#[test]
fn the_way_back_is_traced_and_found_symmetric() {
    let out = run(&routed_core(), &req("192.0.2.50", "203.0.113.50"));
    let back = out.reverse.as_ref().unwrap();
    assert_eq!(back.paths.len(), 2);
    assert!(back.paths.iter().all(|p| routers(p).first().map(String::as_str) == Some("DC1") && routers(p).last().map(String::as_str) == Some("ACC1")));
    let a = out.asymmetry.unwrap();
    assert!(a.symmetric, "{a:?}");
}

#[test]
fn a_traceroute_that_follows_one_leg_matches_it() {
    let mut r = req("192.0.2.50", "203.0.113.50");
    r.traceroute = Some(vec![Some("198.51.100.6".into()), Some("198.51.100.14".into()), Some("203.0.113.50".into())]);
    let v = run(&routed_core(), &r).verify.unwrap();
    assert_eq!(v.match_percent, 100, "{v:#?}");
    assert_eq!(v.rows[0].traceroute_device.as_deref(), Some("CORE2"));
    // A traceroute through a device the model never uses disagrees there.
    let mut r2 = req("192.0.2.50", "203.0.113.50");
    r2.traceroute = Some(vec![Some("198.51.100.2".into()), None, Some("203.0.113.50".into())]);
    let v2 = run(&routed_core(), &r2).verify.unwrap();
    assert_eq!(v2.match_percent, 66);
    assert!(!v2.rows[1].agrees);
}

#[test]
fn a_device_marked_down_leaves_the_other_leg_and_says_it_approximates() {
    let mut r = req("192.0.2.50", "203.0.113.50");
    r.down_devices = vec!["CORE1".into()];
    let f = run(&routed_core(), &r).forward;
    assert_eq!(f.paths.len(), 1);
    assert_eq!(routers(&f.paths[0]), vec!["ACC1", "CORE2", "DC1"]);
    assert_eq!(f.paths[0].hops[0].ecmp, 0);
    assert!(f.warnings.iter().any(|w| w.contains("approximates")), "{:?}", f.warnings);
    // Both cores down: nothing left to route by, said as such.
    r.down_devices = vec!["CORE1".into(), "CORE2".into()];
    let f = run(&routed_core(), &r).forward;
    assert!(matches!(&f.paths[0].ending, Ending::Dropped { at, reason } if at == "ACC1" && reason.contains("marked down")), "{:?}", f.paths[0].ending);
    // A link marked down, likewise.
    let mut r = req("192.0.2.50", "203.0.113.50");
    r.down_links = vec![DownLink { device: "ACC1".into(), interface: "GigabitEthernet1/0/50".into() }];
    let f = run(&routed_core(), &r).forward;
    assert_eq!(f.paths.len(), 1);
    assert_eq!(routers(&f.paths[0]), vec!["ACC1", "CORE1", "DC1"]);
}

#[test]
fn a_device_with_no_routing_table_stops_the_walk_with_the_reason() {
    let mut net = routed_core();
    net[1].tables.remove("route"); // CORE1 collected without its routing table
    let f = run(&net, &req("192.0.2.50", "203.0.113.50")).forward;
    let via_core1 = f.paths.iter().find(|p| routers(p).contains(&"CORE1".to_string())).unwrap();
    assert!(matches!(&via_core1.ending, Ending::Insufficient { at: Some(at), reason } if at == "CORE1" && reason.contains("No routing table")), "{:?}", via_core1.ending);
}

#[test]
fn a_destination_nobody_routes_is_dropped_where_the_table_ends() {
    let f = run(&routed_core(), &req("192.0.2.50", "192.0.2.200")).forward;
    // 192.0.2.200 is on ACC1's own subnet: delivered there, with no ARP entry said.
    assert!(matches!(f.paths[0].ending, Ending::Delivered { device: None, endpoint: None }));
    assert!(f.paths[0].hops[0].notes.iter().any(|n| n.contains("no ARP entry")));
    let f = run(&routed_core(), &req("CORE1", "10.9.9.9")).forward;
    assert!(matches!(&f.paths[0].ending, Ending::Dropped { at, .. } if at == "CORE1"), "{:?}", f.paths[0].ending);
    let f = run(&routed_core(), &req("172.16.0.1", "203.0.113.50")).forward;
    assert!(matches!(&f.paths[0].ending, Ending::Insufficient { reason, .. } if reason.contains("attached")));
}

// ------------------------------------------------------ an HSRP gateway pair

fn hsrp_pair() -> Vec<DeviceIn> {
    let dist = |name: &str, serial: &str, ip: &str, state: &str, up: &str, up_peer: &str| {
        device(
            name,
            ip,
            "cisco_ios",
            "l3_switch",
            serial,
            vec![
                ("ip_address", vec![addr("Vlan30", ip, "25"), addr("Gi1/0/1", up, "30")]),
                ("route", vec![route("192.0.2.128", "25", "C", "", "Vlan30"), route(&net_of(up), "30", "C", "", "Gi1/0/1"), route("0.0.0.0", "0", "S", up_peer, "")]),
                ("fhrp", vec![row("show_standby_brief", &[("proto", "hsrp"), ("group", "30"), ("interface", "Vlan30"), ("vip", "192.0.2.129"), ("state", state)])]),
                ("arp", vec![arp("192.0.2.140", "0000.0000.1401", "Vlan30")]),
                ("mac_table", vec![mac("30", "0000.0000.1401", "Gi1/0/12")]),
            ],
        )
    };
    let d1 = dist("DIST1", "FAKEDIS0001", "192.0.2.130", "Standby", "198.51.100.17", "198.51.100.18");
    let d2 = dist("DIST2", "FAKEDIS0002", "192.0.2.131", "Active", "198.51.100.21", "198.51.100.22");
    let r1 = device(
        "R1",
        "198.51.100.18",
        "cisco_ios",
        "router",
        "FAKER100001",
        vec![
            ("ip_address", vec![addr("Gi0/0", "198.51.100.18", "30"), addr("Gi0/1", "198.51.100.22", "30"), addr("Gi0/2", "192.0.2.132", "25")]),
            ("route", vec![route("198.51.100.16", "30", "C", "", "Gi0/0"), route("198.51.100.20", "30", "C", "", "Gi0/1"), route("192.0.2.128", "25", "C", "", "Gi0/2"), route("10.20.0.0", "16", "S", "192.0.2.129", "")]),
        ],
    );
    vec![d1, d2, r1]
}

#[test]
fn an_endpoint_behind_hsrp_starts_at_the_active_router() {
    let f = run(&hsrp_pair(), &req("192.0.2.140", "203.0.113.9")).forward;
    let s = f.source.unwrap();
    assert_eq!(s.starts, vec!["DIST2"], "{}", s.how);
    assert!(s.how.contains("active FHRP"));
    let first = &f.paths[0].hops[0];
    assert_eq!(first.device, "DIST2");
    assert_eq!(first.decision, Decision::Default);
}

#[test]
fn a_next_hop_that_is_an_hsrp_address_goes_to_its_active_router() {
    let f = run(&hsrp_pair(), &req("R1", "10.20.1.1")).forward;
    assert_eq!(routers(&f.paths[0])[..2], ["R1".to_string(), "DIST2".to_string()]);
    assert!(f.paths[0].hops[0].notes.iter().any(|n| n.contains("active FHRP")));
}

// ---------------------------------------------------- a recursive BGP route

#[test]
fn a_bgp_next_hop_is_resolved_through_the_igp_to_the_router_it_really_leaves_by() {
    let edge1 = device(
        "EDGE1",
        "198.51.100.33",
        "cisco_ios",
        "router",
        "FAKEEDG0001",
        vec![
            ("ip_address", vec![addr("Gi0/0", "198.51.100.33", "30"), addr("Gi0/1", "10.30.0.1", "24")]),
            (
                "route",
                vec![
                    route("198.51.100.32", "30", "C", "", "Gi0/0"),
                    route("10.30.0.0", "24", "C", "", "Gi0/1"),
                    route("10.255.0.2", "32", "O", "198.51.100.34", "Gi0/0"),
                    route("203.0.113.0", "24", "B", "10.255.0.2", ""),
                ],
            ),
        ],
    );
    let edge2 = device(
        "EDGE2",
        "198.51.100.34",
        "cisco_ios",
        "router",
        "FAKEEDG0002",
        vec![
            ("ip_address", vec![addr("Gi0/0", "198.51.100.34", "30"), addr("Loopback0", "10.255.0.2", "32"), addr("Gi0/2", "203.0.113.254", "24")]),
            ("route", vec![route("198.51.100.32", "30", "C", "", "Gi0/0"), route("203.0.113.0", "24", "C", "", "Gi0/2")]),
        ],
    );
    let f = run(&[edge1, edge2], &req("10.30.0.10", "203.0.113.77")).forward;
    let h = &f.paths[0].hops[0];
    assert_eq!(h.matched.as_ref().unwrap().kind, "bgp");
    assert_eq!(h.matched.as_ref().unwrap().next_hop.as_deref(), Some("10.255.0.2"));
    assert_eq!(h.via.len(), 1);
    assert_eq!(h.via[0].prefix, "10.255.0.2/32");
    assert_eq!(h.next_hop.as_deref(), Some("198.51.100.34"));
    assert_eq!(h.out_interface.as_deref(), Some("Gi0/0"));
    assert_eq!(routers(&f.paths[0]), vec!["EDGE1", "EDGE2"]);
}

// --------------------------------------------------------------- FortiGate

fn fortigate(policies: Vec<Row>) -> Vec<DeviceIn> {
    vec![device(
        "FGT1",
        "10.1.1.1",
        "fortios",
        "firewall",
        "FAKEFGT0001",
        vec![
            ("ip_address", vec![addr("port1", "203.0.113.1", "24"), addr("port2", "10.1.1.1", "24")]),
            ("route", vec![route("203.0.113.0", "24", "connected", "", "port1"), route("10.1.1.0", "24", "connected", "", "port2")]),
            ("arp", vec![arp("10.1.1.10", "0000.0000.1010", "port2")]),
            ("nat_rule", vec![row("show_firewall_vip", &[("seq", "VIP-WEB"), ("type", "vip"), ("orig_dst", "203.0.113.10"), ("trans_dst", "10.1.1.10")])]),
            ("fw_policy", policies),
        ],
    )]
}

fn forti_policies() -> Vec<Row> {
    vec![
        row("show_firewall_policy", &[("seq", "1"), ("name", "web-in"), ("src_zones", "port1"), ("dst_zones", "port2"), ("src_addr", "all"), ("dst_addr", "VIP-WEB"), ("services", "HTTPS"), ("action", "accept"), ("enabled", "enable")]),
        row("show_firewall_policy", &[("seq", "2"), ("name", "old-rule"), ("src_zones", "port1"), ("dst_zones", "port2"), ("src_addr", "all"), ("dst_addr", "all"), ("services", "ALL"), ("action", "accept"), ("enabled", "disable")]),
        row("show_firewall_policy", &[("seq", "3"), ("name", "block-rest"), ("src_zones", "any"), ("dst_zones", "any"), ("src_addr", "all"), ("dst_addr", "all"), ("services", "ALL"), ("action", "deny")]),
    ]
}

#[test]
fn a_fortigate_translates_the_vip_then_its_policy_allows_https() {
    let mut r = req("203.0.113.99", "203.0.113.10");
    r.protocol = Some("tcp".into());
    r.port = Some(443);
    let f = run(&fortigate(forti_policies()), &r).forward;
    let p = &f.paths[0];
    let h = &p.hops[0];
    assert_eq!(h.nat.len(), 1);
    assert_eq!((h.nat[0].field.as_str(), h.nat[0].was.as_str(), h.nat[0].now.as_str()), ("destination", "203.0.113.10", "10.1.1.10"));
    let fw = h.firewall.as_ref().unwrap();
    assert_eq!(fw.verdict, Verdict::Allow);
    assert_eq!(fw.policy.as_deref(), Some("web-in (1)"));
    assert_eq!((fw.zone_in.as_deref(), fw.zone_out.as_deref()), (Some("port1"), Some("port2")));
    assert!(matches!(p.ending, Ending::Delivered { .. }));
}

/// A stateful firewall passes the reply to a flow it allowed; asking its
/// policy again, as if the reply were a new connection, would call it denied.
#[test]
fn the_way_back_through_a_firewall_that_allowed_the_flow_is_passed_by_its_session() {
    let mut r = req("203.0.113.99", "203.0.113.10");
    r.protocol = Some("tcp".into());
    r.port = Some(443);
    let out = run(&fortigate(forti_policies()), &r);
    let back = out.reverse.unwrap();
    assert_eq!(back.from, "10.1.1.10", "the way back starts at the translated destination");
    let h = &back.paths[0].hops[0];
    let fw = h.firewall.as_ref().unwrap();
    assert_eq!(fw.verdict, Verdict::Allow, "{}", fw.reason);
    assert!(fw.reason.contains("session"));
    assert!(h.nat.is_empty(), "NAT is not applied a second time");
    assert!(matches!(back.paths[0].ending, Ending::Delivered { .. }), "{:?}", back.paths[0].ending);
}

#[test]
fn a_fortigate_denies_ssh_by_the_rule_after_the_disabled_one() {
    let mut r = req("203.0.113.99", "203.0.113.10");
    r.protocol = Some("tcp".into());
    r.port = Some(22);
    let f = run(&fortigate(forti_policies()), &r).forward;
    let p = &f.paths[0];
    assert!(matches!(&p.ending, Ending::Denied { at, policy: Some(pol) } if at == "FGT1" && pol == "block-rest (3)"), "{:?}", p.ending);
}

#[test]
fn without_a_port_the_verdict_is_undetermined_and_says_why() {
    let f = run(&fortigate(forti_policies()), &req("203.0.113.99", "203.0.113.10")).forward;
    let fw = f.paths[0].hops[0].firewall.as_ref().unwrap();
    assert_eq!(fw.verdict, Verdict::Undetermined);
    assert!(fw.reason.contains("port was not given"), "{}", fw.reason);
    assert!(f.warnings.iter().any(|w| w.starts_with("FGT1:")));
}

#[test]
fn an_address_object_the_tables_do_not_define_is_never_a_guessed_allow() {
    let policies = vec![row("show_firewall_policy", &[("seq", "1"), ("name", "to-web"), ("src_zones", "port1"), ("dst_zones", "port2"), ("src_addr", "PARTNERS"), ("dst_addr", "all"), ("services", "ALL"), ("action", "accept")])];
    let f = run(&fortigate(policies), &req("203.0.113.99", "203.0.113.10")).forward;
    let fw = f.paths[0].hops[0].firewall.as_ref().unwrap();
    assert_eq!(fw.verdict, Verdict::Undetermined);
    assert!(fw.reason.contains("PARTNERS"));
}

#[test]
fn nothing_matching_on_a_fortigate_is_its_implicit_deny() {
    let policies = vec![row("show_firewall_policy", &[("seq", "1"), ("src_zones", "port2"), ("dst_zones", "port1"), ("src_addr", "all"), ("dst_addr", "all"), ("services", "ALL"), ("action", "accept")])];
    let f = run(&fortigate(policies), &req("203.0.113.99", "203.0.113.10")).forward;
    assert!(matches!(&f.paths[0].ending, Ending::Denied { policy: Some(p), .. } if p.contains("implicit deny")));
}

// ------------------------------------------------------------------ PAN-OS

fn pan() -> Vec<DeviceIn> {
    vec![device(
        "PA1",
        "10.2.2.1",
        "panos",
        "firewall",
        "FAKEPAN0001",
        vec![
            ("ip_address", vec![addr("ethernet1/1", "198.51.100.65", "26"), addr("ethernet1/2", "10.2.2.1", "24")]),
            ("route", vec![route("198.51.100.64", "26", "C", "", "ethernet1/1"), route("10.2.2.0", "24", "C", "", "ethernet1/2")]),
            ("fw_zone", vec![row("show_zone", &[("name", "untrust"), ("interfaces", "ethernet1/1")]), row("show_zone", &[("name", "trust"), ("interfaces", "ethernet1/2")])]),
            (
                "nat_rule",
                vec![
                    row("show_running_nat_policy", &[("seq", "dnat-app"), ("type", "destination"), ("in_zone_if", "untrust"), ("out_zone_if", "untrust"), ("orig_dst", "198.51.100.80"), ("trans_dst", "10.2.2.20")]),
                    row("show_running_nat_policy", &[("seq", "snat-out"), ("type", "source"), ("in_zone_if", "trust"), ("out_zone_if", "untrust"), ("orig_src", "10.2.2.0/24"), ("trans_src", "interface")]),
                ],
            ),
            (
                "fw_policy",
                vec![
                    row("show_running_security_policy", &[("name", "allow-app"), ("src_zones", "untrust"), ("dst_zones", "trust"), ("src_addr", "any"), ("dst_addr", "198.51.100.80"), ("services", "tcp/8443"), ("action", "allow"), ("enabled", "yes")]),
                    row("show_running_security_policy", &[("name", "allow-out"), ("src_zones", "trust"), ("dst_zones", "untrust"), ("src_addr", "any"), ("dst_addr", "any"), ("services", "any"), ("action", "allow")]),
                ],
            ),
            ("arp", vec![arp("10.2.2.20", "0000.0000.2020", "ethernet1/2"), arp("198.51.100.77", "0000.0000.7777", "ethernet1/1")]),
        ],
    )]
}

#[test]
fn pan_os_matches_policy_on_the_original_address_and_the_translated_zone() {
    let mut r = req("198.51.100.99", "198.51.100.80");
    r.protocol = Some("tcp".into());
    r.port = Some(8443);
    let f = run(&pan(), &r).forward;
    let h = &f.paths[0].hops[0];
    assert_eq!(h.nat[0].now, "10.2.2.20");
    assert_eq!(h.out_interface.as_deref(), Some("ethernet1/2"));
    let fw = h.firewall.as_ref().unwrap();
    assert_eq!((fw.zone_in.as_deref(), fw.zone_out.as_deref()), (Some("untrust"), Some("trust")));
    assert_eq!(fw.verdict, Verdict::Allow);
    assert_eq!(fw.policy.as_deref(), Some("allow-app"));
    assert!(matches!(f.paths[0].ending, Ending::Delivered { .. }));
}

#[test]
fn pan_os_source_nat_to_the_interface_address() {
    let f = run(&pan(), &req("10.2.2.30", "198.51.100.77")).forward;
    let h = &f.paths[0].hops[0];
    let snat = h.nat.iter().find(|n| n.field == "source").unwrap();
    assert_eq!((snat.was.as_str(), snat.now.as_str()), ("10.2.2.30", "198.51.100.65"));
    assert_eq!(h.firewall.as_ref().unwrap().policy.as_deref(), Some("allow-out"));
}

#[test]
fn pan_os_between_zones_with_no_rule_is_the_interzone_default() {
    let mut r = req("198.51.100.99", "10.2.2.20");
    r.protocol = Some("udp".into());
    r.port = Some(53);
    let f = run(&pan(), &r).forward;
    assert!(matches!(&f.paths[0].ending, Ending::Denied { policy: Some(p), .. } if p == "interzone-default"), "{:?}", f.paths[0].ending);
}

// --------------------------------------------------------------------- ASA

/// ASA translates before it routes, and its access policy (8.3 on) sees the
/// real address. A static rule is written the source way round
/// (`real → mapped`) and is also the destination rule for the mapped address.
fn asa() -> Vec<DeviceIn> {
    vec![device(
        "ASA1",
        "10.9.9.1",
        "cisco_asa",
        "firewall",
        "FAKEASA0001",
        vec![
            ("ip_address", vec![addr("outside", "203.0.113.2", "24"), addr("inside", "10.9.9.1", "24")]),
            ("route", vec![route("203.0.113.0", "24", "C", "", "outside"), route("10.9.9.0", "24", "C", "", "inside")]),
            ("arp", vec![arp("10.9.9.20", "0000.0000.0920", "inside")]),
            ("nat_rule", vec![row("show_nat", &[("seq", "1"), ("type", "static"), ("in_zone_if", "inside"), ("out_zone_if", "outside"), ("orig_src", "10.9.9.20"), ("trans_src", "203.0.113.20")])]),
            (
                "fw_policy",
                // Bound inbound on `outside`, as `access-group outside_in in interface outside` says.
                vec![row("show_access_list", &[("seq", "10"), ("name", "outside_in"), ("src_zones", "outside"), ("src_addr", "any"), ("dst_addr", "host 10.9.9.20"), ("services", "tcp/443"), ("action", "permit")])],
            ),
        ],
    )]
}

#[test]
fn an_asa_translates_first_and_permits_on_the_real_address() {
    let mut r = req("203.0.113.99", "203.0.113.20");
    r.protocol = Some("tcp".into());
    r.port = Some(443);
    let f = run(&asa(), &r).forward;
    let h = &f.paths[0].hops[0];
    assert_eq!((h.nat[0].was.as_str(), h.nat[0].now.as_str()), ("203.0.113.20", "10.9.9.20"), "{h:#?}");
    assert_eq!(h.out_interface.as_deref(), Some("inside"), "routed on the translated address");
    let fw = h.firewall.as_ref().unwrap();
    assert_eq!(fw.verdict, Verdict::Allow, "{}", fw.reason);
    assert_eq!(fw.policy.as_deref(), Some("outside_in (10)"));
    assert!(matches!(f.paths[0].ending, Ending::Delivered { .. }));
    // Another port: nothing permits it, and the ASA's implicit deny says so.
    r.port = Some(22);
    let f = run(&asa(), &r).forward;
    assert!(matches!(&f.paths[0].ending, Ending::Denied { at, policy: Some(p) } if at == "ASA1" && p == "implicit deny"), "{:?}", f.paths[0].ending);
    // The way out: no rule is bound inbound on `inside`, so the ASA's
    // implicit deny — the security levels that would allow it were not collected.
    let f = run(&asa(), &req("10.9.9.20", "203.0.113.99")).forward;
    assert!(matches!(&f.paths[0].ending, Ending::Denied { .. }), "{:?}", f.paths[0].ending);
}

/// Without the binding, an access list is not assumed to apply either way.
#[test]
fn an_asa_rule_with_no_interface_binding_is_undetermined() {
    let mut net = asa();
    for r in net[0].tables.get_mut("fw_policy").unwrap() {
        r.columns.remove("src_zones");
    }
    let mut r = req("203.0.113.99", "203.0.113.20");
    r.protocol = Some("tcp".into());
    r.port = Some(443);
    let fw = run(&net, &r).forward.paths[0].hops[0].firewall.clone().unwrap();
    assert_eq!(fw.verdict, Verdict::Undetermined);
    assert!(fw.reason.contains("bound"), "{}", fw.reason);
}

/// The same static rule translates the source on the way out, once a rule allows it.
#[test]
fn an_asa_static_rule_translates_the_source_on_the_way_out() {
    let mut net = asa();
    net[0].tables.get_mut("fw_policy").unwrap().push(row("show_access_list", &[("seq", "10"), ("name", "inside_in"), ("src_zones", "inside"), ("src_addr", "10.9.9.0/24"), ("dst_addr", "any"), ("services", "ip"), ("action", "permit")]));
    let f = run(&net, &req("10.9.9.20", "203.0.113.99")).forward;
    let h = &f.paths[0].hops[0];
    assert_eq!(h.firewall.as_ref().unwrap().policy.as_deref(), Some("inside_in (10)"));
    let snat = h.nat.iter().find(|n| n.field == "source");
    assert_eq!(snat.map(|n| n.now.as_str()), Some("203.0.113.20"), "{h:#?}");
}

// -------------------------------------------------------------- policy route

fn pbr_router() -> Vec<DeviceIn> {
    vec![device(
        "R2",
        "10.3.3.1",
        "cisco_ios",
        "router",
        "FAKER200001",
        vec![
            ("ip_address", vec![addr("Gi0/1", "10.3.3.1", "24"), addr("Gi0/2", "10.4.4.1", "24"), addr("Gi0/0", "198.51.100.97", "29")]),
            ("route", vec![route("10.3.3.0", "24", "C", "", "Gi0/1"), route("10.4.4.0", "24", "C", "", "Gi0/2"), route("198.51.100.96", "29", "C", "", "Gi0/0"), route("0.0.0.0", "0", "S*", "198.51.100.98", "")]),
            ("policy_route", vec![row("show_route_map", &[("seq", "GUEST 10"), ("in_if", "Gi0/1"), ("src", "10.3.3.0/24"), ("action_nh", "198.51.100.100")])]),
        ],
    )]
}

#[test]
fn a_policy_route_wins_over_the_table_for_the_traffic_it_matches() {
    let f = run(&pbr_router(), &req("10.3.3.10", "203.0.113.9")).forward;
    let h = &f.paths[0].hops[0];
    assert_eq!(h.decision, Decision::Pbr);
    assert_eq!(h.next_hop.as_deref(), Some("198.51.100.100"));
    assert_eq!(h.out_interface.as_deref(), Some("Gi0/0"));
    assert!(matches!(&f.paths[0].ending, Ending::Unmanaged { next_hop, .. } if next_hop == "198.51.100.100"));
    // From the other subnet, the policy does not match: the default route.
    let f = run(&pbr_router(), &req("10.4.4.10", "203.0.113.9")).forward;
    let h = &f.paths[0].hops[0];
    assert_eq!(h.decision, Decision::Default);
    assert_eq!(h.next_hop.as_deref(), Some("198.51.100.98"));
}

// -------------------------------------------------------- an asymmetric return

#[test]
fn a_return_through_other_routers_is_asymmetric_and_a_one_way_firewall_is_named() {
    let r = |name: &str, serial: &str, os: &str, role: &str, addrs: Vec<Row>, routes: Vec<Row>, extra: Vec<(&str, Vec<Row>)>| {
        let mut t = vec![("ip_address", addrs), ("route", routes)];
        t.extend(extra);
        device(name, "", os, role, serial, t)
    };
    let a = r(
        "RA",
        "FAKERA00001",
        "cisco_ios",
        "router",
        vec![addr("Gi0/0", "192.0.2.1", "24"), addr("Gi0/1", "10.0.1.1", "30"), addr("Gi0/2", "10.0.4.2", "30")],
        vec![route("192.0.2.0", "24", "C", "", "Gi0/0"), route("10.0.1.0", "30", "C", "", "Gi0/1"), route("10.0.4.0", "30", "C", "", "Gi0/2"), route("203.0.113.0", "24", "S", "10.0.1.2", "")],
        vec![],
    );
    let b = r(
        "FWB",
        "FAKEFWB0001",
        "fortios",
        "firewall",
        vec![addr("port1", "10.0.1.2", "30"), addr("port2", "10.0.2.1", "30")],
        vec![route("10.0.1.0", "30", "connected", "", "port1"), route("10.0.2.0", "30", "connected", "", "port2"), route("203.0.113.0", "24", "static", "10.0.2.2", "")],
        vec![("fw_policy", vec![row("show_firewall_policy", &[("seq", "1"), ("src_zones", "port1"), ("dst_zones", "port2"), ("src_addr", "all"), ("dst_addr", "all"), ("services", "ALL"), ("action", "accept")])])],
    );
    let c = r(
        "RC",
        "FAKERC00001",
        "cisco_ios",
        "router",
        vec![addr("Gi0/1", "10.0.2.2", "30"), addr("Gi0/0", "203.0.113.1", "24"), addr("Gi0/2", "10.0.3.1", "30")],
        vec![route("10.0.2.0", "30", "C", "", "Gi0/1"), route("203.0.113.0", "24", "C", "", "Gi0/0"), route("10.0.3.0", "30", "C", "", "Gi0/2"), route("192.0.2.0", "24", "S", "10.0.3.2", "")],
        vec![("arp", vec![arp("203.0.113.5", "0000.0000.0305", "Gi0/0")])],
    );
    let d = r(
        "RD",
        "FAKERD00001",
        "cisco_ios",
        "router",
        vec![addr("Gi0/0", "10.0.3.2", "30"), addr("Gi0/1", "10.0.4.1", "30")],
        vec![route("10.0.3.0", "30", "C", "", "Gi0/0"), route("10.0.4.0", "30", "C", "", "Gi0/1"), route("192.0.2.0", "24", "S", "10.0.4.2", "")],
        vec![],
    );
    let net = vec![a, b, c, d];
    let mut rq = req("192.0.2.10", "203.0.113.5");
    rq.protocol = Some("tcp".into());
    rq.port = Some(443);
    let out = run(&net, &rq);
    assert_eq!(routers(&out.forward.paths[0]), vec!["RA", "FWB", "RC"]);
    let back = out.reverse.as_ref().unwrap();
    assert_eq!(routers(&back.paths[0]), vec!["RC", "RD", "RA"], "{:?}", back.paths[0]);
    let a = out.asymmetry.unwrap();
    assert!(!a.symmetric);
    assert_eq!(a.only_forward, vec!["FWB"]);
    assert_eq!(a.only_reverse, vec!["RD"]);
    assert!(a.notes.iter().any(|n| n.starts_with("FWB filters the way there")), "{:?}", a.notes);
    // RD is no firewall, so nothing on the way back is asked about a session.
    assert!(back.paths[0].hops.iter().all(|h| h.firewall.is_none()));
}

// --------------------------------------------- switches between two routers

#[test]
fn the_switches_between_a_router_and_the_host_and_a_blocked_port_warned() {
    let r3 = device(
        "R3",
        "10.5.5.1",
        "cisco_ios",
        "l3_switch",
        "FAKER300001",
        vec![
            ("ip_address", vec![addr("Vlan40", "10.5.5.1", "24")]),
            ("route", vec![route("10.5.5.0", "24", "C", "", "Vlan40")]),
            ("arp", vec![arp("10.5.5.50", "0000.0000.5050", "Vlan40")]),
            ("mac_table", vec![mac("40", "0000.0000.5050", "Gi0/2")]),
            ("neighbor", vec![cdp("Gi0/2", "SW1", "Gi1/0/48")]),
        ],
    );
    let sw1 = device(
        "SW1",
        "10.5.5.2",
        "cisco_ios",
        "switch",
        "FAKESW10001",
        vec![
            ("mac_table", vec![mac("40", "0000.0000.5050", "Gi1/0/47")]),
            ("neighbor", vec![cdp("Gi1/0/48", "R3", "Gi0/2"), cdp("Gi1/0/47", "SW2", "Gi0/1")]),
            ("stp", vec![row("show_spanning_tree", &[("instance", "VLAN0040"), ("interface", "Gi1/0/47"), ("role", "Altn"), ("state", "BLK")])]),
        ],
    );
    let sw2 = device(
        "SW2",
        "10.5.5.3",
        "cisco_ios",
        "switch",
        "FAKESW20001",
        vec![("mac_table", vec![mac("40", "0000.0000.5050", "Gi0/10")]), ("neighbor", vec![cdp("Gi0/1", "SW1", "Gi1/0/47")])],
    );
    let f = run(&[r3, sw1, sw2], &req("R3", "10.5.5.50")).forward;
    let h = &f.paths[0].hops[0];
    let steps: Vec<(String, Option<String>, Option<String>, bool)> = h.l2.iter().map(|s| (s.device.clone(), s.in_port.clone(), s.out_port.clone(), s.blocked)).collect();
    assert_eq!(
        steps,
        vec![
            ("R3".into(), None, Some("Gi0/2".into()), false),
            ("SW1".into(), Some("GigabitEthernet1/0/48".into()), Some("Gi1/0/47".into()), true),
            ("SW2".into(), Some("GigabitEthernet0/1".into()), Some("Gi0/10".into()), false),
        ]
    );
    match &f.paths[0].ending {
        Ending::Delivered { endpoint: Some(p), .. } => assert_eq!((p.switch.as_str(), p.port.as_str(), p.vlan.as_deref()), ("SW2", "Gi0/10", Some("40"))),
        other => panic!("{other:?}"),
    }
    assert!(f.warnings.iter().any(|w| w.contains("STP has SW1 Gi1/0/47 blocked")), "{:?}", f.warnings);
}

#[test]
fn a_next_hop_nobody_collected_is_an_unmanaged_hop_with_its_mac() {
    let r = device(
        "R4",
        "10.6.6.1",
        "cisco_ios",
        "router",
        "FAKER400001",
        vec![
            ("ip_address", vec![addr("Gi0/0", "198.51.100.113", "30"), addr("Gi0/1", "10.6.6.1", "24")]),
            ("route", vec![route("198.51.100.112", "30", "C", "", "Gi0/0"), route("10.6.6.0", "24", "C", "", "Gi0/1"), route("0.0.0.0", "0", "S", "198.51.100.114", "")]),
            ("arp", vec![arp("198.51.100.114", "0000.0000.0114", "Gi0/0")]),
        ],
    );
    let f = run(&[r], &req("10.6.6.9", "203.0.113.200")).forward;
    assert!(matches!(&f.paths[0].ending, Ending::Unmanaged { at, next_hop, mac: Some(m), .. } if at == "R4" && next_hop == "198.51.100.114" && m == "000000000114"), "{:?}", f.paths[0].ending);
}

#[test]
fn routes_that_point_at_each_other_are_a_loop() {
    let mk = |name: &str, serial: &str, me: &str, peer: &str| {
        device(name, me, "cisco_ios", "router", serial, vec![("ip_address", vec![addr("Gi0/0", me, "30")]), ("route", vec![route("198.51.100.120", "30", "C", "", "Gi0/0"), route("203.0.113.0", "24", "S", peer, "")])])
    };
    let net = vec![mk("LA", "FAKELA00001", "198.51.100.121", "198.51.100.122"), mk("LB", "FAKELB00001", "198.51.100.122", "198.51.100.121")];
    let f = run(&net, &req("LA", "203.0.113.1")).forward;
    assert!(matches!(&f.paths[0].ending, Ending::Loop { at } if at == "LA"), "{:?}", f.paths[0].ending);
    assert_eq!(routers(&f.paths[0]), vec!["LA", "LB"]);
}

#[test]
fn a_tunnel_is_an_overlay_hop_with_its_underlay() {
    let hub = device(
        "HUB",
        "198.51.100.129",
        "cisco_ios",
        "router",
        "FAKEHUB0001",
        vec![
            ("ip_address", vec![addr("Gi0/0", "198.51.100.129", "30"), addr("Tunnel1", "172.16.1.1", "30"), addr("Gi0/1", "10.7.7.1", "24")]),
            ("route", vec![route("198.51.100.128", "30", "C", "", "Gi0/0"), route("10.7.7.0", "24", "C", "", "Gi0/1"), route("172.16.1.0", "30", "C", "", "Tunnel1"), route("10.8.8.0", "24", "S", "", "Tunnel1"), route("198.51.100.136", "30", "S", "198.51.100.130", "")]),
            ("tunnel", vec![row("show_interface_tunnel", &[("name", "Tunnel1"), ("kind", "gre"), ("local_ip", "198.51.100.129"), ("remote_ip", "198.51.100.137")])]),
        ],
    );
    let isp = device(
        "ISP1",
        "198.51.100.130",
        "cisco_ios",
        "router",
        "FAKEISP0001",
        vec![("ip_address", vec![addr("Gi0/0", "198.51.100.130", "30"), addr("Gi0/1", "198.51.100.138", "30")]), ("route", vec![route("198.51.100.128", "30", "C", "", "Gi0/0"), route("198.51.100.136", "30", "C", "", "Gi0/1")])],
    );
    let spoke = device(
        "SPOKE",
        "198.51.100.137",
        "cisco_ios",
        "router",
        "FAKESPK0001",
        vec![
            ("ip_address", vec![addr("Gi0/0", "198.51.100.137", "30"), addr("Tunnel1", "172.16.1.2", "30"), addr("Gi0/1", "10.8.8.1", "24")]),
            ("route", vec![route("198.51.100.136", "30", "C", "", "Gi0/0"), route("10.8.8.0", "24", "C", "", "Gi0/1"), route("172.16.1.0", "30", "C", "", "Tunnel1")]),
            ("tunnel", vec![row("show_interface_tunnel", &[("name", "Tunnel1"), ("kind", "gre"), ("local_ip", "198.51.100.137"), ("remote_ip", "198.51.100.129")])]),
            ("arp", vec![arp("10.8.8.20", "0000.0000.0820", "Gi0/1")]),
        ],
    );
    let f = run(&[hub, isp, spoke], &req("10.7.7.5", "10.8.8.20")).forward;
    let h = &f.paths[0].hops[0];
    let o = h.overlay.as_ref().unwrap();
    assert_eq!((o.tunnel.as_str(), o.remote.as_str()), ("Tunnel1", "198.51.100.137"));
    assert_eq!(o.underlay, vec!["HUB", "ISP1", "SPOKE"]);
    assert_eq!(routers(&f.paths[0]), vec!["HUB", "SPOKE"]);
    assert_eq!(f.paths[0].hops[1].in_interface.as_deref(), Some("Tunnel1"));
    assert!(matches!(f.paths[0].ending, Ending::Delivered { .. }));
}

/// LT-536: the page reads this file in `src/lib/collectedPath.test.ts`, so
/// the page's types are held to what the builder really writes. Rewritten
/// with `UPDATE_PATH_FIXTURE=1`; otherwise a drift fails here.
#[test]
fn the_pages_fixture_is_what_the_builder_writes() {
    let mut r = req("192.0.2.50", "203.0.113.50");
    r.protocol = Some("tcp".into());
    r.port = Some(443);
    r.traceroute = Some(vec![Some("198.51.100.2".into()), Some("198.51.100.10".into()), Some("203.0.113.50".into())]);
    let out = run(&routed_core(), &r);
    let json = format!("{}\n", serde_json::to_string_pretty(&out).unwrap());
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/path-outcome.json");
    if std::env::var("UPDATE_PATH_FIXTURE").is_ok() {
        std::fs::write(&path, &json).unwrap();
    }
    // A firewall verdict and a NAT rewrite, in a fixture of their own.
    let fwd = run(&fortigate(forti_policies()), &Request { protocol: Some("tcp".into()), port: Some(443), ..req("203.0.113.99", "203.0.113.10") });
    let json2 = format!("{}\n", serde_json::to_string_pretty(&fwd).unwrap());
    let path2 = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/path-outcome-firewall.json");
    if std::env::var("UPDATE_PATH_FIXTURE").is_ok() {
        std::fs::write(&path2, &json2).unwrap();
    }
    assert_eq!(std::fs::read_to_string(&path).unwrap(), json, "rerun with UPDATE_PATH_FIXTURE=1 and check the page's types");
    assert_eq!(std::fs::read_to_string(&path2).unwrap(), json2, "rerun with UPDATE_PATH_FIXTURE=1 and check the page's types");
}

// ------------------------------------------------------- VRFs and L3VPN

fn vrf_row(name: &str, imports: &str, exports: &str, interfaces: &str) -> Row {
    row("show_vrf_detail", &[("name", name), ("rt_import", imports), ("rt_export", exports), ("interfaces", interfaces)])
}

fn vroute(vrf: &str, prefix: &str, len: &str, proto: &str, nh: &str, iface: &str) -> Row {
    let mut cols = vec![("vrf", vrf), ("prefix", prefix), ("mask", len), ("proto", proto)];
    if !nh.is_empty() {
        cols.push(("next_hop", nh));
    }
    if !iface.is_empty() {
        cols.push(("interface", iface));
    }
    row("show_ip_route_vrf", &cols)
}

/// LT-544: VRF A's route to a service names a next hop only reachable in
/// VRF SHARED; A imports what SHARED exports, so it is resolved there.
#[test]
fn a_next_hop_in_another_vrf_is_followed_by_its_route_target() {
    let r = device(
        "RV1",
        "192.0.2.201",
        "cisco_ios",
        "router",
        "FAKERV10001",
        vec![
            ("vrf", vec![vrf_row("A", "65000:1, 65000:99", "65000:1", "Gi0/1"), vrf_row("SHARED", "65000:99", "65000:99", "Gi0/3")]),
            ("ip_address", vec![row("x", &[("interface", "Gi0/1"), ("ip", "10.1.1.1"), ("prefixlen", "24")]), row("x", &[("interface", "Gi0/3"), ("ip", "10.6.0.2"), ("prefixlen", "24")])]),
            (
                "route",
                vec![
                    vroute("A", "10.1.1.0", "24", "C", "", "Gi0/1"),
                    vroute("A", "10.5.0.0", "16", "S", "10.6.0.1", ""),
                    vroute("SHARED", "10.6.0.0", "24", "C", "", "Gi0/3"),
                ],
            ),
            ("arp", vec![row("show_ip_arp_vrf", &[("vrf", "SHARED"), ("ip", "10.6.0.1"), ("mac", "0000.0000.0601"), ("interface", "Gi0/3")])]),
        ],
    );
    let svc = device(
        "SVC",
        "10.6.0.1",
        "cisco_ios",
        "router",
        "FAKESVC0001",
        vec![
            ("ip_address", vec![row("x", &[("interface", "Gi0/0"), ("ip", "10.6.0.1"), ("prefixlen", "24")]), row("x", &[("interface", "Gi0/1"), ("ip", "10.5.0.1"), ("prefixlen", "16")])]),
            ("route", vec![route("10.6.0.0", "24", "C", "", "Gi0/0"), route("10.5.0.0", "16", "C", "", "Gi0/1")]),
        ],
    );
    let f = run(&[r, svc], &Request { from: "10.1.1.50".into(), to: "10.5.0.9".into(), vrf: Some("A".into()), ..Default::default() }).forward;
    let p = &f.paths[0];
    assert_eq!(routers(p), vec!["RV1", "SVC"], "{p:#?}");
    let h = &p.hops[0];
    assert_eq!((h.vrf.as_str(), h.out_interface.as_deref(), h.next_hop.as_deref()), ("A", Some("Gi0/3"), Some("10.6.0.1")));
    assert!(h.notes.iter().any(|n| n.contains("from VRF SHARED by route-target 65000:99")), "{:?}", h.notes);
    assert!(matches!(p.ending, Ending::Delivered { .. }));
    // Without the import, nothing is assumed.
    let no_leak = vec![device("RV1", "192.0.2.201", "cisco_ios", "router", "FAKERV10001", vec![
        ("vrf", vec![vrf_row("A", "65000:1", "65000:1", "Gi0/1"), vrf_row("SHARED", "65000:99", "65000:99", "Gi0/3")]),
        ("route", vec![vroute("A", "10.1.1.0", "24", "C", "", "Gi0/1"), vroute("A", "10.5.0.0", "16", "S", "10.6.0.1", ""), vroute("SHARED", "10.6.0.0", "24", "C", "", "Gi0/3")]),
    ])];
    let f = run(&no_leak, &Request { from: "10.1.1.50".into(), to: "10.5.0.9".into(), vrf: Some("A".into()), ..Default::default() }).forward;
    assert!(matches!(&f.paths[0].ending, Ending::Insufficient { at: Some(at), .. } if at == "RV1"), "{:?}", f.paths[0].ending);
}

/// LT-545: a customer VRF across an MPLS core. PE1's VPN route names PE2's
/// loopback in the global table; the underlay crosses P1; at PE2 the walk
/// goes on in the VRF that exports what PE1's imports.
#[test]
fn a_vpn_route_crosses_the_core_to_the_remote_pe_and_its_vrf() {
    let pe1 = device(
        "PE1",
        "10.255.0.1",
        "cisco_ios",
        "router",
        "FAKEPE10001",
        vec![
            ("vrf", vec![vrf_row("CUST", "65000:10", "65000:10", "Gi0/1")]),
            ("ip_address", vec![row("x", &[("interface", "Loopback0"), ("ip", "10.255.0.1"), ("prefixlen", "32")]), row("x", &[("interface", "Gi0/0"), ("ip", "192.0.2.1"), ("prefixlen", "30")]), row("x", &[("interface", "Gi0/1"), ("ip", "10.1.0.1"), ("prefixlen", "16")])]),
            (
                "route",
                vec![
                    route("192.0.2.0", "30", "C", "", "Gi0/0"),
                    route("10.255.0.2", "32", "O", "192.0.2.2", "Gi0/0"),
                    vroute("CUST", "10.1.0.0", "16", "C", "", "Gi0/1"),
                    vroute("CUST", "10.2.0.0", "16", "B", "10.255.0.2", ""),
                ],
            ),
        ],
    );
    let p1 = device(
        "P1",
        "192.0.2.2",
        "cisco_ios",
        "router",
        "FAKEP100001",
        vec![
            ("ip_address", vec![row("x", &[("interface", "Gi0/0"), ("ip", "192.0.2.2"), ("prefixlen", "30")]), row("x", &[("interface", "Gi0/1"), ("ip", "192.0.2.5"), ("prefixlen", "30")])]),
            ("route", vec![route("192.0.2.0", "30", "C", "", "Gi0/0"), route("192.0.2.4", "30", "C", "", "Gi0/1"), route("10.255.0.2", "32", "O", "192.0.2.6", "Gi0/1")]),
        ],
    );
    let pe2 = device(
        "PE2",
        "10.255.0.2",
        "cisco_ios",
        "router",
        "FAKEPE20001",
        vec![
            ("vrf", vec![vrf_row("CUSTOMER-B", "65000:10", "65000:10", "Gi0/2")]),
            ("ip_address", vec![row("x", &[("interface", "Loopback0"), ("ip", "10.255.0.2"), ("prefixlen", "32")]), row("x", &[("interface", "Gi0/1"), ("ip", "192.0.2.6"), ("prefixlen", "30")]), row("x", &[("interface", "Gi0/2"), ("ip", "10.2.0.1"), ("prefixlen", "16")])]),
            ("route", vec![route("192.0.2.4", "30", "C", "", "Gi0/1"), route("10.255.0.2", "32", "C", "", "Loopback0"), vroute("CUSTOMER-B", "10.2.0.0", "16", "C", "", "Gi0/2")]),
            ("arp", vec![row("show_ip_arp_vrf", &[("vrf", "CUSTOMER-B"), ("ip", "10.2.0.20"), ("mac", "0000.0000.0220"), ("interface", "Gi0/2")])]),
        ],
    );
    let f = run(&[pe1, p1, pe2], &Request { from: "10.1.0.10".into(), to: "10.2.0.20".into(), vrf: Some("CUST".into()), ..Default::default() }).forward;
    let p = &f.paths[0];
    assert_eq!(routers(p), vec!["PE1", "PE2"], "{p:#?}");
    let o = p.hops[0].overlay.as_ref().expect("the VPN hop");
    assert_eq!((o.tunnel.as_str(), o.remote.as_str()), ("MPLS L3VPN", "10.255.0.2"));
    assert_eq!(o.underlay, vec!["PE1", "P1", "PE2"]);
    assert_eq!(p.hops[1].vrf, "CUSTOMER-B", "the remote VRF found by route-target, whatever its name");
    assert!(matches!(p.ending, Ending::Delivered { .. }));
}

// ------------------------------------------- management addresses (LT-570)

/// The lab's shape: a FortiGate is the LAN's gateway; two switches carry the
/// LAN and each has a management address in it. One has a default route to
/// the FortiGate, the other only its connected subnet. The endpoint's MAC
/// is learned on an edge port of the second.
#[test]
fn a_switch_with_only_a_management_address_in_the_subnet_is_not_its_gateway() {
    let devices = vec![
        device(
            "FGT1",
            "192.0.2.1",
            "fortios",
            "firewall",
            "FAKEFGT0002",
            vec![
                ("ip_address", vec![addr("internal", "192.0.2.1", "24"), addr("wan2", "203.0.113.2", "24"), addr("vlan20", "198.51.100.1", "24")]),
                ("route", vec![route("0.0.0.0", "0", "S", "203.0.113.1", "wan2"), route("192.0.2.0", "24", "C", "", "internal"), route("203.0.113.0", "24", "C", "", "wan2"), route("198.51.100.0", "24", "C", "", "vlan20")]),
                ("arp", vec![arp("192.0.2.50", "0000.0000.0050", "internal")]),
            ],
        ),
        device(
            "SW1",
            "192.0.2.7",
            "cisco_ios",
            "switch",
            "FAKESW0007",
            vec![
                ("ip_address", vec![addr("Vlan1", "192.0.2.7", "24")]),
                // IOS lists IPv6 multicast as a local route to Null0 whether or not IPv6 is in use.
                ("route", vec![route("0.0.0.0", "0", "S", "192.0.2.1", ""), route("192.0.2.0", "24", "C", "", "Vlan1"), route("FF00::", "8", "L", "", "Null0")]),
            ],
        ),
        device(
            "FSW1",
            "192.0.2.203",
            "fortiswitch",
            "switch",
            "FAKEFSW0203",
            vec![
                ("ip_address", vec![addr("internal", "192.0.2.203", "24")]),
                ("route", vec![route("192.0.2.0", "24", "C", "", "internal")]),
                ("mac_table", vec![mac("1", "0000.0000.0050", "port13")]),
            ],
        ),
    ];
    let f = run(&devices, &req("192.0.2.50", "198.51.100.9")).forward;
    assert_eq!(f.source.as_ref().map(|s| s.starts.clone()), Some(vec!["FGT1".to_string()]), "{:?}", f.source);
    assert_eq!(routers(&f.paths[0]), vec!["FGT1"], "{:?}", f.paths);
}
