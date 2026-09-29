//! LT-531 end to end: two routers' raw `show ip route` and `show ip arp`,
//! in IOS's own format, read by the vendored ntc-templates through the Rust
//! engine, normalised into table rows the way a collection stores them, and
//! walked. The template writes one row per next hop with the prefix filled
//! down, and its protocol and OSPF type apart; this is the test that the
//! model reads that shape. Invented names, documentation addresses (D-027).

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
