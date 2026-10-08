//! End to end: two routers' raw `show ip route` and `show ip arp`,
//! in IOS's own format, read by the vendored ntc-templates through the Rust
//! engine, normalised into table rows the way a collection stores them, and
//! walked. The template writes one row per next hop with the prefix filled
//! down, and its protocol and OSPF type apart; this is the test that the
//! model reads that shape. Invented names, documentation addresses.

use std::collections::BTreeMap;
use std::path::PathBuf;

use coreview_catalog::textfsm::Engine;
use coreview_collect::tables::normalise_all;
use coreview_path::walk::{Ending, Request};
use coreview_topology::{DeviceIn, Row};

fn engine() -> Engine {
    Engine::new(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/templates/ntc"))
}

fn rows(template: &str, command: &str, table: &str, raw: &str) -> Vec<Row> {
    let parsed: Vec<serde_json::Value> = engine().parse(template, &[], raw).unwrap().into_iter().map(serde_json::Value::Object).collect();
    assert!(!parsed.is_empty(), "{template} read nothing from its input");
    normalise_all(&[table.to_string()], &parsed).into_iter().map(|n| Row { command: command.into(), columns: n.columns, extra: n.extra }).collect()
}

fn device(name: &str, host: &str, route: &str, arp: &str) -> DeviceIn {
    let mut t: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    t.insert("device".into(), vec![Row { command: "show_version".into(), columns: [("hostname".to_string(), name.to_string()), ("serial".to_string(), format!("FAKE{name}00"))].into(), extra: Default::default() }]);
    t.insert("route".into(), rows("cisco_ios_show_ip_route", "show_ip_route", "route", route));
    t.insert("arp".into(), rows("cisco_ios_show_ip_arp", "show_ip_arp", "arp", arp));
    DeviceIn { device_id: name.to_ascii_lowercase(), host: host.into(), os: Some("cisco_ios".into()), role: Some("router".into()), prompt: format!("{name}#"), version_text: String::new(), tables: t }
}

const CODES: &str = "Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP
       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area
       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2
       E1 - OSPF external type 1, E2 - OSPF external type 2
       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2
       ia - IS-IS inter area, * - candidate default, U - per-user static route
       o - ODR, P - periodic downloaded static route
";

fn acc1() -> DeviceIn {
    let route = format!(
        "{CODES}
Gateway of last resort is not set

     192.0.2.0/24 is variably subnetted, 2 subnets, 2 masks
C       192.0.2.0/24 is directly connected, Vlan10
L       192.0.2.1/32 is directly connected, Vlan10
     198.51.100.0/24 is variably subnetted, 4 subnets, 2 masks
C       198.51.100.0/30 is directly connected, GigabitEthernet1/0/49
L       198.51.100.1/32 is directly connected, GigabitEthernet1/0/49
C       198.51.100.4/30 is directly connected, GigabitEthernet1/0/50
L       198.51.100.5/32 is directly connected, GigabitEthernet1/0/50
     203.0.113.0/24 is subnetted, 1 subnets
O IA    203.0.113.0 [110/3] via 198.51.100.2, 00:10:11, GigabitEthernet1/0/49
                    [110/3] via 198.51.100.6, 00:10:11, GigabitEthernet1/0/50
"
    );
    let arp = "Protocol  Address          Age (min)  Hardware Addr   Type   Interface
Internet  192.0.2.50              3   0000.0000.5001  ARPA   Vlan10
Internet  198.51.100.2            1   0000.0000.c101  ARPA   GigabitEthernet1/0/49
Internet  198.51.100.6            1   0000.0000.c201  ARPA   GigabitEthernet1/0/50
";
    device("ACC1", "192.0.2.1", &route, arp)
}

fn core1() -> DeviceIn {
    let route = format!(
        "{CODES}
Gateway of last resort is not set

     198.51.100.0/24 is variably subnetted, 2 subnets, 2 masks
C       198.51.100.0/30 is directly connected, GigabitEthernet1/1
L       198.51.100.2/32 is directly connected, GigabitEthernet1/1
     203.0.113.0/24 is variably subnetted, 2 subnets, 2 masks
C       203.0.113.0/24 is directly connected, GigabitEthernet1/2
L       203.0.113.1/32 is directly connected, GigabitEthernet1/2
     192.0.2.0/24 is subnetted, 1 subnets
O       192.0.2.0 [110/2] via 198.51.100.1, 00:10:11, GigabitEthernet1/1
"
    );
    let arp = "Protocol  Address          Age (min)  Hardware Addr   Type   Interface
Internet  203.0.113.50            2   0000.0000.5002  ARPA   GigabitEthernet1/2
";
    device("CORE1", "198.51.100.2", &route, arp)
}

#[test]
fn ios_route_rows_walk_as_two_equal_cost_legs() {
    let devices = vec![acc1(), core1()];
    let out = coreview_path::trace_run(&devices, &Request { from: "192.0.2.50".into(), to: "203.0.113.50".into(), ..Default::default() });
    let f = &out.forward;
    assert_eq!(f.source.as_ref().unwrap().starts, vec!["ACC1"]);
    assert_eq!(f.paths.len(), 2, "{f:#?}");
    for p in &f.paths {
        let h = &p.hops[0];
        let m = h.matched.as_ref().unwrap();
        assert_eq!(m.prefix, "203.0.113.0/24");
        assert_eq!(m.kind, "ospf");
        assert_eq!((m.distance, m.metric), (Some(110), Some(3)));
        assert_eq!(h.ecmp, 2);
    }
    // One leg reaches CORE1 and the host on its attached subnet; the other
    // leaves for CORE2, which nobody collected — said, with its MAC.
    let via_core1 = f.paths.iter().find(|p| p.hops.len() == 2).expect("a leg through CORE1");
    assert_eq!(via_core1.hops[1].device, "CORE1");
    assert_eq!(via_core1.hops[1].next_hop_mac.as_deref(), Some("000000005002"));
    assert!(matches!(via_core1.ending, Ending::Delivered { .. }));
    let other = f.paths.iter().find(|p| p.hops.len() == 1).unwrap();
    assert!(matches!(&other.ending, Ending::Unmanaged { next_hop, mac: Some(m), .. } if next_hop == "198.51.100.6" && m == "00000000c201"), "{:?}", other.ending);
    // CORE1's own address is local to it: a trace to it ends there.
    let out = coreview_path::trace_run(&devices, &Request { from: "ACC1".into(), to: "203.0.113.1".into(), ..Default::default() });
    assert!(out.forward.paths.iter().any(|p| matches!(&p.ending, Ending::Delivered { device: Some(d), .. } if d == "CORE1")));
}

// ------------------------------------------------------------------- ASA

/// Rows from one ASA command through whatever the catalog names for it: an
/// ntc template or a Coreview reader.
fn asa_rows(command: &str, parser: &str, table: &str, raw: &str) -> Vec<Row> {
    let parsed: Vec<serde_json::Value> = match parser.strip_prefix("reader:") {
        Some(name) => coreview_collect::readers::read(name, raw).unwrap(),
        None => engine().parse(parser.trim_start_matches("textfsm:"), &[], raw).unwrap().into_iter().map(serde_json::Value::Object).collect(),
    };
    assert!(!parsed.is_empty(), "{parser} read nothing from its input");
    normalise_all(&[table.to_string()], &parsed).into_iter().map(|n| Row { command: command.into(), columns: n.columns, extra: n.extra }).collect()
}

/// End to end. Reconstructed from Cisco's ASA command reference and
/// the layout of ntc's own ASA fixtures, not captured from the lab:
/// the access list and access group through Coreview's readers, the objects
/// and NAT through ntc's templates, then traced.
fn asa() -> Vec<DeviceIn> {
    let route = "Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP
       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area 
       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2
       E1 - OSPF external type 1, E2 - OSPF external type 2, V - VPN
       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2
       ia - IS-IS inter area, * - candidate default, U - per-user static route
       o - ODR, P - periodic downloaded static route, + - replicated route
Gateway of last resort is not set

C        10.9.9.0 255.255.255.0 is directly connected, inside
L        10.9.9.1 255.255.255.255 is directly connected, inside
C        203.0.113.0 255.255.255.0 is directly connected, outside
L        203.0.113.2 255.255.255.255 is directly connected, outside
";
    let nameif = "Interface                Name                     Security
GigabitEthernet0/0       outside                    0
GigabitEthernet0/1       inside                   100
";
    let acl = "access-list outside_in remark published servers
access-list outside_in extended permit tcp any object WEB-01 object-group WEB-PORTS
access-list outside_in extended deny ip any any
";
    let group = "access-group outside_in in interface outside\n";
    let objects = "object network WEB-01
 host 10.9.9.20
object network INSIDE-NET
 subnet 10.9.9.0 255.255.255.0
";
    let services = "object-group service WEB-PORTS tcp
 port-object eq https
 port-object eq 8443
";
    let nat = "Auto NAT Policies (Section 2)
1 (inside) to (outside) source static WEB-01 203.0.113.20
    translate_hits = 0, untranslate_hits = 0
2 (inside) to (outside) source dynamic INSIDE-NET interface
    translate_hits = 0, untranslate_hits = 0
";
    let mut t: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    t.insert("device".into(), vec![Row { command: "show_version".into(), columns: [("hostname".to_string(), "ASA1".to_string()), ("serial".to_string(), "FAKEASA0002".to_string())].into(), extra: Default::default() }]);
    t.insert("route".into(), asa_rows("show_route", "textfsm:cisco_asa_show_route", "route", route));
    t.insert("fw_zone".into(), asa_rows("show_nameif", "reader:asa_nameif", "fw_zone", nameif));
    t.insert("fw_policy".into(), asa_rows("show_running_config_access_list", "reader:asa_access_list", "fw_policy", acl));
    t.insert("fw_binding".into(), asa_rows("show_running_config_access_group", "reader:asa_access_group", "fw_binding", group));
    let mut objs = asa_rows("show_running_config_object_network", "textfsm:cisco_asa_show_running-config_object_network", "fw_object", objects);
    objs.extend(asa_rows("show_running_config_object_group_service", "textfsm:cisco_asa_show_running-config_object-group_service", "fw_object", services));
    t.insert("fw_object".into(), objs);
    t.insert("nat_rule".into(), asa_rows("show_nat", "textfsm:cisco_asa_show_nat", "nat_rule", nat));
    vec![DeviceIn { device_id: "asa1".into(), host: "203.0.113.2".into(), os: Some("cisco_asa".into()), role: Some("firewall".into()), prompt: "ASA1#".into(), version_text: String::new(), tables: t }]
}

fn tcp(from: &str, to: &str, port: u16) -> Request {
    Request { from: from.into(), to: to.into(), protocol: Some("tcp".into()), port: Some(port), ..Default::default() }
}

#[test]
fn an_asa_from_its_own_output_translates_binds_and_decides() {
    use coreview_path::firewall::Verdict;
    let devices = asa();
    // In from outside to the published server: the static NAT, then the list bound inbound on outside.
    let f = coreview_path::trace_run(&devices, &tcp("203.0.113.99", "203.0.113.20", 443)).forward;
    let h = &f.paths[0].hops[0];
    assert_eq!(h.in_interface.as_deref(), Some("outside"));
    assert_eq!(h.nat.first().map(|n| (n.was.as_str(), n.now.as_str())), Some(("203.0.113.20", "10.9.9.20")), "{h:#?}");
    assert_eq!(h.out_interface.as_deref(), Some("inside"));
    let fw = h.firewall.as_ref().unwrap();
    assert_eq!((fw.verdict, fw.policy.as_deref()), (Verdict::Allow, Some("outside_in (2)")), "{}", fw.reason);
    assert!(matches!(f.paths[0].ending, Ending::Delivered { .. }));
    // The service group's second port, resolved from its object.
    let fw = coreview_path::trace_run(&devices, &tcp("203.0.113.99", "203.0.113.20", 8443)).forward.paths[0].hops[0].firewall.clone().unwrap();
    assert_eq!(fw.verdict, Verdict::Allow, "{}", fw.reason);
    // Another port: the list's own deny line.
    let f = coreview_path::trace_run(&devices, &tcp("203.0.113.99", "203.0.113.20", 22)).forward;
    assert!(matches!(&f.paths[0].ending, Ending::Denied { policy: Some(p), .. } if p == "outside_in (3)"), "{:?}", f.paths[0].ending);
    // Out from inside: no list bound there, so the security levels decide (100 over 0), and the dynamic rule hides it behind the interface.
    let f = coreview_path::trace_run(&devices, &tcp("10.9.9.30", "203.0.113.99", 443)).forward;
    let h = &f.paths[0].hops[0];
    let fw = h.firewall.as_ref().unwrap();
    assert_eq!((fw.verdict, fw.policy.as_deref()), (Verdict::Allow, Some("security level")), "{}", fw.reason);
    assert_eq!(h.nat.iter().find(|n| n.field == "source").map(|n| n.now.as_str()), Some("203.0.113.2"), "{h:#?}");
    // The published server going out keeps its static address.
    let h = coreview_path::trace_run(&devices, &tcp("10.9.9.20", "203.0.113.99", 443)).forward.paths[0].hops[0].clone();
    assert_eq!(h.nat.iter().find(|n| n.field == "source").map(|n| n.now.as_str()), Some("203.0.113.20"), "{h:#?}");
}

/// An FTD whose FMC gave its rules. Its CLI also shows the same
/// policy compiled into `CSM_FW_ACL_`, bound globally; the FMC's rules are
/// the ones read, by zone, in rule order, ending in the default action.
/// FMC shapes from Cisco's API documentation, not captured.
#[test]
fn an_ftd_is_decided_by_its_fmc_rules_not_its_compiled_list() {
    use coreview_collect::api::fmc;
    use coreview_path::firewall::Verdict;
    use serde_json::json;
    let mut devices = asa();
    let t = &mut devices[0].tables;
    // What the FTD's own CLI says: the compiled list, bound globally.
    t.insert("fw_policy".into(), asa_rows("show_running_config_access_list", "reader:asa_access_list", "fw_policy", "access-list CSM_FW_ACL_ advanced permit ip any any rule-id 268434432\naccess-list CSM_FW_ACL_ extended permit ip any any\n"));
    t.insert("fw_binding".into(), asa_rows("show_running_config_access_group", "reader:asa_access_group", "fw_binding", "access-group CSM_FW_ACL_ global\n"));
    // What its FMC says.
    let rule = |name: &str, index: u64, action: &str, port: &str| json!({"name": name, "action": action, "enabled": true, "metadata": {"ruleIndex": index},
        "sourceZones": {"objects": [{"name": "OUTSIDE"}]}, "destinationZones": {"objects": [{"name": "INSIDE"}]},
        "destinationNetworks": {"objects": [{"name": "WEB-01"}]}, "destinationPorts": {"literals": [{"type": "PortLiteral", "port": port, "protocol": "6"}]}});
    let fmc_rows = |id: &str, table: &str, rows: Vec<serde_json::Value>| -> Vec<Row> {
        normalise_all(&[table.to_string()], &rows).into_iter().map(|n| Row { command: id.into(), columns: n.columns, extra: n.extra }).collect()
    };
    let mut policy = t.remove("fw_policy").unwrap();
    policy.extend(fmc_rows("fmc_access_rules", "fw_policy", fmc::policy_rows(&[rule("web-in", 1, "ALLOW", "443")], Some("BLOCK"))));
    t.insert("fw_policy".into(), policy);
    t.get_mut("fw_zone").unwrap().extend(fmc_rows("fmc_interfaces", "fw_zone", fmc::zone_rows(&[
        json!({"name": "GigabitEthernet0/0", "ifname": "outside", "securityZone": {"name": "OUTSIDE"}}),
        json!({"name": "GigabitEthernet0/1", "ifname": "inside", "securityZone": {"name": "INSIDE"}}),
    ])));
    let f = coreview_path::trace_run(&devices, &tcp("203.0.113.99", "203.0.113.20", 443)).forward;
    let fw = f.paths[0].hops[0].firewall.clone().unwrap();
    assert_eq!((fw.verdict, fw.policy.as_deref()), (Verdict::Allow, Some("web-in (1)")), "{}", fw.reason);
    // The compiled list would have allowed anything; the FMC's default action blocks port 22.
    let f = coreview_path::trace_run(&devices, &tcp("203.0.113.99", "203.0.113.20", 22)).forward;
    assert!(matches!(&f.paths[0].ending, Ending::Denied { policy: Some(p), .. } if p == "default action (2)"), "{:?}", f.paths[0].ending);
}

// ------------------------------------------------------------------ IPv6

const V6_CODES: &str = "Codes: C - Connected, L - Local, S - Static, U - Per-user Static route
       B - BGP, R - RIP, H - NHRP, D - EIGRP, EX - EIGRP external
       O - OSPF Intra, OI - OSPF Inter, OE1 - OSPF ext 1, OE2 - OSPF ext 2
";

fn v6_router(name: &str, route: &str, nd: &str, extra: Vec<(&str, Vec<Row>)>) -> DeviceIn {
    let mut t: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    t.insert("device".into(), vec![Row { command: "show_version".into(), columns: [("hostname".to_string(), name.to_string()), ("serial".to_string(), format!("FAKE{name}"))].into(), extra: Default::default() }]);
    t.insert("route".into(), rows("cisco_ios_show_ipv6_route", "show_ipv6_route", "route", &format!("IPv6 Routing Table - default - 5 entries\n{V6_CODES}{route}")));
    if !nd.is_empty() {
        t.insert("arp".into(), rows("cisco_ios_show_ipv6_neighbors", "show_ipv6_neighbors", "arp", &format!("IPv6 Address                              Age Link-layer Addr State Interface\n{nd}")));
    }
    for (k, v) in extra {
        t.entry(k.into()).or_default().extend(v);
    }
    DeviceIn { device_id: name.to_ascii_lowercase(), host: String::new(), os: Some("cisco_ios".into()), role: Some("router".into()), prompt: format!("{name}#"), version_text: String::new(), tables: t }
}

fn hand(command: &str, cols: &[(&str, &str)]) -> Row {
    Row { command: command.into(), columns: cols.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), extra: Default::default() }
}

/// Reconstructed in IOS's own layout (the vendored fixture's), not
/// captured; documentation prefixes (2001:db8::/32).
fn v6_pair(with_nd: bool) -> Vec<DeviceIn> {
    let a_routes = "C   2001:DB8:A::/64 [0/0]
     via GigabitEthernet0/0, directly connected
L   2001:DB8:A::1/128 [0/0]
     via GigabitEthernet0/0, receive
C   2001:DB8:FF::/64 [0/0]
     via GigabitEthernet0/1, directly connected
L   2001:DB8:FF::1/128 [0/0]
     via GigabitEthernet0/1, receive
S   2001:DB8:B::/64 [1/0]
     via FE80::2, GigabitEthernet0/1
";
    let b_routes = "C   2001:DB8:FF::/64 [0/0]
     via GigabitEthernet0/0, directly connected
L   2001:DB8:FF::2/128 [0/0]
     via GigabitEthernet0/0, receive
C   2001:DB8:B::/64 [0/0]
     via GigabitEthernet0/1, directly connected
L   2001:DB8:B::1/128 [0/0]
     via GigabitEthernet0/1, receive
";
    let a_nd = if with_nd { "FE80::2                                     0 0000.0000.b601  REACH Gi0/1\n" } else { "" };
    let cable = |local: &str, name: &str, port: &str| hand("show_cdp_neighbors_detail", &[("local_if", local), ("rem_sysname", name), ("rem_port_id", port), ("proto", "cdp")]);
    let a_extra = if with_nd { vec![] } else { vec![("neighbor", vec![cable("GigabitEthernet0/1", "R6B", "GigabitEthernet0/0")])] };
    let b_extra = vec![
        ("interface", vec![hand("show_interfaces", &[("name", "GigabitEthernet0/0"), ("mac", "0000.0000.b601")])]),
        ("neighbor", if with_nd { vec![] } else { vec![cable("GigabitEthernet0/0", "R6A", "GigabitEthernet0/1")] }),
    ];
    vec![
        v6_router("R6A", a_routes, a_nd, a_extra),
        v6_router("R6B", b_routes, "2001:DB8:B::10                              0 0000.0000.b610  REACH Gi0/1\n", b_extra),
    ]
}

#[test]
fn an_ipv6_path_through_a_link_local_next_hop_by_the_neighbour_table_or_the_cable() {
    for with_nd in [true, false] {
        let out = coreview_path::trace_run(&v6_pair(with_nd), &Request { from: "2001:db8:a::10".into(), to: "2001:db8:b::10".into(), ..Default::default() });
        let f = &out.forward;
        assert_eq!(f.source.as_ref().unwrap().starts, vec!["R6A"], "{f:#?}");
        let p = &f.paths[0];
        assert_eq!(p.hops.iter().map(|h| h.device.as_str()).collect::<Vec<_>>(), vec!["R6A", "R6B"], "{p:#?}");
        let h = &p.hops[0];
        assert_eq!(h.matched.as_ref().unwrap().prefix, "2001:db8:b::/64");
        assert_eq!(h.next_hop.as_deref(), Some("fe80::2"));
        assert_eq!(h.out_interface.as_deref(), Some("GigabitEthernet0/1"));
        let how = if with_nd { "neighbour table" } else { "cabled to GigabitEthernet0/1" };
        assert!(h.notes.iter().any(|n| n.contains(how)), "{:?}", h.notes);
        assert_eq!(p.hops[1].next_hop_mac.as_deref(), Some("00000000b610"));
        assert!(matches!(p.ending, Ending::Delivered { .. }));
    }
    // An IPv6 destination no table holds is dropped where the table ends, not guessed.
    let f = coreview_path::trace_run(&v6_pair(true), &Request { from: "R6A".into(), to: "2001:db8:c::1".into(), ..Default::default() }).forward;
    assert!(matches!(&f.paths[0].ending, Ending::Dropped { at, .. } if at == "R6A"), "{:?}", f.paths[0].ending);
}
