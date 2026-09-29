//! Small networks with the graph each must give, written out by hand
//! (LT-527). Rows are what `collection_db::read_table` returns — the spec's
//! columns and the command they came from. Invented names and documentation
//! addresses only (D-027).

use std::collections::BTreeMap;

use coreview_topology::*;

fn row(command: &str, cols: &[(&str, &str)]) -> Row {
    Row { command: command.into(), columns: cols.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), extra: Default::default() }
}

fn device(id: &str, host: &str, os: &str, role: &str, tables: Vec<(&str, Vec<Row>)>) -> DeviceIn {
    let mut t: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    for (name, rows) in tables {
        t.entry(name.to_string()).or_default().extend(rows);
    }
    DeviceIn { device_id: id.into(), host: host.into(), os: Some(os.into()), role: Some(role.into()), prompt: format!("{}#", id.to_uppercase()), version_text: String::new(), tables: t }
}

fn cdp(local: &str, name: &str, port: &str, ip: &str) -> Row {
    row("show_cdp_neighbors_detail", &[("local_if", local), ("rem_sysname", name), ("rem_port_id", port), ("rem_mgmt_ip", ip), ("rem_platform", "cisco WS-C2960X-24TS-L"), ("proto", "cdp")])
}

/// Two Catalysts cabled twice: one plain link seen from both ends, and a
/// two-member LACP bundle both ends list. SW2 was collected on two addresses.
fn two_switches() -> Vec<DeviceIn> {
    let sw1 = device(
        "sw1",
        "192.0.2.1",
        "cisco_ios",
        "switch",
        vec![
            ("device", vec![row("show_version", &[("hostname", "SW1"), ("serial", "FAKE0000001"), ("model", "WS-C2960X-48TS-L")])]),
            ("interface", vec![row("show_interfaces", &[("name", "Vlan10"), ("mac", "0000.0000.0101")])]),
            ("ip_address", vec![row("show_ip_interface_brief", &[("interface", "Vlan10"), ("ip", "192.0.2.1"), ("prefixlen", "24")])]),
            (
                "neighbor",
                vec![cdp("GigabitEthernet1/0/1", "SW2.lab.example.net", "GigabitEthernet1/0/2", "192.0.2.2"), cdp("Gi1/0/23", "SW2.lab.example.net", "Gi1/0/23", "192.0.2.2"), cdp("Gi1/0/24", "SW2.lab.example.net", "Gi1/0/24", "192.0.2.2")],
            ),
            ("lag", vec![row("show_etherchannel_summary", &[("name", "Po1"), ("proto", "LACP"), ("members", "Gi1/0/23(P), Gi1/0/24(P)")])]),
            (
                "ha_pair",
                vec![
                    row("show_switch", &[("member", "1"), ("role", "active"), ("model", "WS-C2960X-48TS-L"), ("serial", "FAKE0000001"), ("mac", "0000.0000.0100")]),
                    row("show_switch", &[("member", "2"), ("role", "standby"), ("model", "WS-C2960X-48TS-L"), ("serial", "FAKE0000011"), ("mac", "0000.0000.0110")]),
                ],
            ),
            (
                "mac_table",
                vec![
                    row("show_mac_address_table", &[("vlan", "10"), ("mac", "0000.0000.0901"), ("interface", "Gi1/0/7"), ("type", "DYNAMIC")]),
                    // The ASA's MAC, learned in transit over the bundle: not where it lives.
                    row("show_mac_address_table", &[("vlan", "10"), ("mac", "0000.0000.0301"), ("interface", "Po1"), ("type", "DYNAMIC")]),
                    row("show_mac_address_table", &[("vlan", "1"), ("mac", "0000.0000.0101"), ("interface", "CPU"), ("type", "STATIC")]),
                ],
            ),
            ("arp", vec![row("show_ip_arp", &[("ip", "192.0.2.77"), ("mac", "0000.0000.0901"), ("interface", "Vlan10")])]),
            ("routing_neighbor", vec![row("show_ip_ospf_neighbor", &[("neighbor_id", "198.51.100.2"), ("neighbor_ip", "198.51.100.2"), ("state", "FULL/DR"), ("proto", "ospf")])]),
        ],
    );
    let sw2_rows = |id: &str, host: &str| {
        device(
            id,
            host,
            "cisco_ios",
            "switch",
            vec![
                ("device", vec![row("show_version", &[("hostname", "SW2"), ("serial", "FAKE0000002")])]),
                ("interface", vec![row("show_interfaces", &[("name", "Vlan10"), ("mac", "0000.0000.0201")])]),
                ("ip_address", vec![row("show_ip_interface_brief", &[("interface", "Vlan10"), ("ip", "192.0.2.2"), ("prefixlen", "24")]), row("show_ip_interface_brief", &[("interface", "Gi1/0/48"), ("ip", "198.51.100.2"), ("prefixlen", "30")])]),
                ("neighbor", vec![cdp("Gi1/0/2", "SW1", "Gi1/0/1", "192.0.2.1"), cdp("Gi1/0/23", "SW1", "Gi1/0/23", "192.0.2.1"), cdp("Gi1/0/24", "SW1", "Gi1/0/24", "192.0.2.1"), row("show_lldp_neighbors_detail", &[("local_if", "Gi1/0/30"), ("rem_sysname", "AP-FLOOR2"), ("rem_chassis_id", "0000.0000.0a01"), ("rem_port_id", "eth0"), ("rem_caps", "B, W"), ("proto", "lldp")])]),
                ("lag", vec![row("show_etherchannel_summary", &[("name", "Po1"), ("members", "Gi1/0/23(P) Gi1/0/24(P)")])]),
                (
                    "mac_table",
                    vec![
                        row("show_mac_address_table", &[("vlan", "10"), ("mac", "0000.0000.0301"), ("interface", "Gi1/0/5"), ("type", "DYNAMIC")]),
                        row("show_mac_address_table", &[("vlan", "20"), ("mac", "0000.0000.0801"), ("interface", "Gi1/0/10"), ("type", "DYNAMIC")]),
                        row("show_mac_address_table", &[("vlan", "20"), ("mac", "0000.0000.0802"), ("interface", "Gi1/0/10"), ("type", "DYNAMIC")]),
                        row("show_mac_address_table", &[("vlan", "20"), ("mac", "0000.0000.0803"), ("interface", "Gi1/0/10"), ("type", "DYNAMIC")]),
                        row("show_mac_address_table", &[("vlan", "20"), ("mac", "0000.0000.0804"), ("interface", "Gi1/0/10"), ("type", "DYNAMIC")]),
                    ],
                ),
            ],
        )
    };
    let asa = device(
        "fw1",
        "192.0.2.254",
        "cisco_asa",
        "firewall",
        vec![
            ("device", vec![row("show_version", &[("hostname", "FW1"), ("serial", "FAKE0000003")])]),
            ("interface", vec![row("show_interface", &[("name", "GigabitEthernet0/1"), ("mac", "0000.0000.0301")])]),
            ("ip_address", vec![row("show_interface_ip_brief", &[("interface", "inside"), ("ip", "192.0.2.254"), ("prefixlen", "255.255.255.0")])]),
        ],
    );
    vec![sw1, sw2_rows("sw2", "192.0.2.2"), sw2_rows("sw2-again", "198.51.100.2"), asa]
}

fn node_named<'a>(g: &'a Graph, name: &str) -> &'a Node {
    g.nodes.iter().find(|n| n.name == name).unwrap_or_else(|| panic!("no node {name}: {:?}", g.nodes.iter().map(|n| &n.name).collect::<Vec<_>>()))
}

#[test]
fn one_box_reached_on_two_addresses_is_one_node() {
    let g = build(&two_switches());
    let sw2: Vec<&Node> = g.nodes.iter().filter(|n| n.name == "SW2").collect();
    assert_eq!(sw2.len(), 1, "SW2 twice");
    assert_eq!(sw2[0].device_ids, vec!["sw2", "sw2-again"]);
    assert_eq!(g.nodes.iter().filter(|n| n.kind == NodeKind::Collected).count(), 3);
}

#[test]
fn a_cable_claimed_from_both_ends_is_one_link_at_full_confidence_with_both_rows() {
    let g = build(&two_switches());
    let (sw1, sw2) = (node_named(&g, "SW1").id.clone(), node_named(&g, "SW2").id.clone());
    let plain: Vec<&Link> = g.links.iter().filter(|l| l.bundle.is_none() && [&l.a.node, &l.b.node].contains(&&sw1) && [&l.a.node, &l.b.node].contains(&&sw2)).collect();
    assert_eq!(plain.len(), 1, "{plain:?}");
    let l = plain[0];
    assert!(l.both_directions);
    assert_eq!(l.confidence, 1.0);
    // Two collections of SW2 each said so, and SW1 said so: three rows.
    assert!(l.evidence.len() >= 2, "{:?}", l.evidence);
    let ports: Vec<Option<String>> = vec![l.a.port.clone(), l.b.port.clone()];
    assert!(ports.contains(&Some("GigabitEthernet1/0/1".into())) && ports.contains(&Some("GigabitEthernet1/0/2".into())), "{ports:?}");
}

#[test]
fn a_bundle_listed_at_both_ends_is_one_logical_link_with_its_members() {
    let g = build(&two_switches());
    let bundles: Vec<&Link> = g.links.iter().filter(|l| l.bundle.is_some()).collect();
    assert_eq!(bundles.len(), 1, "{bundles:?}");
    let b = bundles[0].bundle.as_ref().unwrap();
    assert_eq!(b.members.len(), 2);
    assert_eq!(b.a_name.as_deref(), Some("Port-channel1"));
    assert_eq!(b.b_name.as_deref(), Some("Port-channel1"));
    assert!(bundles[0].both_directions && bundles[0].confidence == 1.0);
    assert!(!g.findings.iter().any(|f| f.kind.starts_with("bundle")), "{:?}", g.findings);
}

#[test]
fn a_stack_is_one_node_with_its_members() {
    let g = build(&two_switches());
    let sw1 = node_named(&g, "SW1");
    assert_eq!(sw1.stack_kind.as_deref(), Some("stack"));
    assert_eq!(sw1.members.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["1", "2"]);
    assert!(sw1.serials.contains("FAKE0000011"), "the second member's serial identifies the stack too");
}

#[test]
fn a_device_without_lldp_is_placed_where_its_mac_is_learned_not_where_it_transits() {
    let g = build(&two_switches());
    let (sw2, fw) = (node_named(&g, "SW2").id.clone(), node_named(&g, "FW1").id.clone());
    let inferred: Vec<&Link> = g.links.iter().filter(|l| l.kind == LinkKind::InferredMac && l.b.node == fw).collect();
    assert_eq!(inferred.len(), 1, "{inferred:?}");
    let l = inferred[0];
    assert_eq!(l.a.node, sw2, "placed on SW2 (one MAC on the port), not on SW1's bundle");
    assert_eq!(l.a.port.as_deref(), Some("GigabitEthernet1/0/5"));
    assert_eq!(l.confidence, 0.6);
    assert!(l.evidence[0].note.contains("0000") && l.evidence[0].note.contains("no CDP/LLDP"), "{:?}", l.evidence);
}

#[test]
fn a_crowd_is_an_unknown_switch_and_a_lone_stranger_an_endpoint_with_its_address() {
    let g = build(&two_switches());
    let unknown: Vec<&Node> = g.nodes.iter().filter(|n| n.kind == NodeKind::UnknownSwitch).collect();
    assert_eq!(unknown.len(), 1);
    assert!(unknown[0].name.contains("GigabitEthernet1/0/10"), "{}", unknown[0].name);
    let e = g.endpoints.iter().find(|e| e.mac == "000000000901").expect("the endpoint on SW1 Gi1/0/7");
    assert_eq!(e.port, "GigabitEthernet1/0/7", "the graph keeps the long form; the view shortens it");
    assert_eq!(e.ip.as_deref(), Some("192.0.2.77"));
    assert_eq!(g.endpoints.iter().filter(|e| e.port.ends_with("1/0/10")).count(), 4, "the crowd is kept for the page to hang off the unknown switch");
}

#[test]
fn a_neighbour_nobody_collected_is_a_placeholder_seen_from_one_end() {
    let g = build(&two_switches());
    let ap = node_named(&g, "AP-FLOOR2");
    assert_eq!(ap.kind, NodeKind::Neighbor);
    let l = g.links.iter().find(|l| l.b.node == ap.id || l.a.node == ap.id).unwrap();
    assert_eq!(l.confidence, 0.7);
    assert!(!l.both_directions);
    assert_eq!(l.kind, LinkKind::Lldp);
}

#[test]
fn shared_subnets_are_layer_three_and_a_routing_neighbour_confirms_one() {
    let g = build(&two_switches());
    let (sw1, sw2, fw) = (node_named(&g, "SW1").id.clone(), node_named(&g, "SW2").id.clone(), node_named(&g, "FW1").id.clone());
    let vlan10: Vec<&L3Adjacency> = g.l3.iter().filter(|a| a.subnet == "192.0.2.0/24").collect();
    assert_eq!(vlan10.len(), 3, "three routers on a small subnet: every pair — {vlan10:?}");
    let sw1_sw2 = vlan10.iter().find(|a| [&a.a, &a.b].contains(&&sw1) && [&a.a, &a.b].contains(&&sw2)).unwrap();
    assert_eq!(sw1_sw2.confirmed_by, vec!["ospf"]);
    assert_eq!(sw1_sw2.confidence, 1.0);
    let sw1_fw = vlan10.iter().find(|a| [&a.a, &a.b].contains(&&sw1) && [&a.a, &a.b].contains(&&fw)).unwrap();
    assert_eq!(sw1_fw.confidence, 0.4, "the subnet alone");
}

#[test]
fn a_bundle_whose_members_reach_two_boxes_is_a_finding() {
    let mut devs = two_switches();
    // One member of SW1's Po1 now lands on a third switch.
    let sw1 = &mut devs[0];
    let n = sw1.tables.get_mut("neighbor").unwrap();
    n[2] = cdp("Gi1/0/24", "SW3", "Gi1/0/1", "192.0.2.3");
    let g = build(&devs);
    assert!(g.findings.iter().any(|f| f.kind == "bundle_spans_devices" && f.note.contains("Port-channel1")), "{:?}", g.findings);
}

#[test]
fn the_crawl_view_is_what_the_review_screen_reads() {
    let g = build(&two_switches());
    let v = crawl_view::view(&g);
    assert_eq!(v.devices.len(), 3);
    let sw1 = v.devices.iter().find(|d| d.hostname == "SW1").unwrap();
    // Bundle members each as a neighbour, the bundle in port_channels — how the page folds a LAG.
    assert_eq!(sw1.port_channels.len(), 1);
    assert_eq!(sw1.port_channels[0].name, "Po1");
    assert_eq!(sw1.port_channels[0].members, vec!["Gi1/0/23", "Gi1/0/24"]);
    assert_eq!(sw1.neighbors.iter().filter(|n| n.short_name == "SW2").count(), 3);
    assert!(sw1.stack.as_ref().map(|s| s.members.len() == 2).unwrap_or(false));
    // The endpoint on Gi1/0/7 is attached, with its address.
    assert!(sw1.attached.iter().any(|a| a.port == "Gi1/0/7" && a.address.as_deref() == Some("192.0.2.77")));
    let sw2 = v.devices.iter().find(|d| d.hostname == "SW2").unwrap();
    // The firewall placed by MAC is attached on SW2 Gi1/0/5 under its own name.
    assert!(sw2.attached.iter().any(|a| a.port == "Gi1/0/5" && a.hostname.as_deref() == Some("FW1")), "{:?}", sw2.attached);
    // The crowd on Gi1/0/10: four attached entries with a population of four.
    assert_eq!(sw2.attached.iter().filter(|a| a.port == "Gi1/0/10" && a.port_population == 4).count(), 4);
    assert_eq!(v.not_visited.iter().map(|n| n.short_name.as_str()).collect::<Vec<_>>(), vec!["AP-FLOOR2"]);
    // Serialises in the crawl's own camelCase shape.
    let json = serde_json::to_value(sw1).unwrap();
    assert!(json.get("portChannels").is_some() && json.get("probeTarget").is_some() && json.get("reachedBy").is_some());
}

#[test]
fn the_review_toggles_shape_what_the_page_gets() {
    use crawl_view::{view_with, ViewOptions};
    let g = build(&two_switches());
    let sw = |v: &crawl_view::CrawlView, name: &str| v.devices.iter().find(|d| d.hostname == name).unwrap().clone();
    let open = view_with(&g, &ViewOptions { collapse_bundles: false, ..Default::default() });
    assert!(sw(&open, "SW1").port_channels.is_empty(), "bundles not folded");
    let unstacked = view_with(&g, &ViewOptions { collapse_stacks: false, ..Default::default() });
    assert!(sw(&unstacked, "SW1").stack.is_none());
    let seen_only = view_with(&g, &ViewOptions { min_confidence: 1.0, ..Default::default() });
    assert!(sw(&seen_only, "SW2").neighbors.iter().all(|n| n.short_name != "AP-FLOOR2"), "the one-ended link is below 1.0");
    assert!(sw(&seen_only, "SW2").attached.is_empty(), "nothing placed by MAC at 1.0");
    let no_placeholders = view_with(&g, &ViewOptions { placeholders: false, ..Default::default() });
    assert!(no_placeholders.not_visited.is_empty());
    assert!(sw(&no_placeholders, "SW2").attached.iter().all(|a| a.port != "Gi1/0/10"), "the crowd goes with the placeholders");
    let vlan20 = view_with(&g, &ViewOptions { vlan: Some("20".into()), ..Default::default() });
    assert!(sw(&vlan20, "SW1").attached.iter().all(|a| a.vlan.as_deref() == Some("20")));
}

