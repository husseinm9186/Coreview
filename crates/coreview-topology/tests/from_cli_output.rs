//! End to end: two switches' raw `show cdp neighbors detail` and
//! `show etherchannel summary`, in IOS's own format, read by the vendored
//! ntc-templates through the Rust engine, normalised into table rows the way
//! a collection stores them, and built. Invented names, documentation
//! addresses.

use std::collections::BTreeMap;
use std::path::PathBuf;

use coreview_catalog::textfsm::Engine;
use coreview_collect::tables::normalise_all;
use coreview_topology::*;

fn engine() -> Engine {
    Engine::new(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/templates/ntc"))
}

fn rows(template: &str, command: &str, feeds: &[&str], raw: &str) -> Vec<(String, Row)> {
    let parsed: Vec<serde_json::Value> = engine().parse(template, &[], raw).unwrap().into_iter().map(serde_json::Value::Object).collect();
    assert!(!parsed.is_empty(), "{template} read nothing from its input");
    normalise_all(&feeds.iter().map(|s| s.to_string()).collect::<Vec<_>>(), &parsed)
        .into_iter()
        .map(|mut n| {
            if n.table == "neighbor" {
                n.columns.insert("proto".into(), "cdp".into());
            }
            (n.table.clone(), Row { command: command.into(), columns: n.columns, extra: n.extra })
        })
        .collect()
}

fn cdp(peer: &str, ip: &str, local: &str, remote: &str) -> String {
    format!(
        "-------------------------\nDevice ID: {peer}.lab.example.net\nEntry address(es): \n  IP address: {ip}\nPlatform: cisco WS-C2960X-24TS-L,  Capabilities: Switch IGMP \nInterface: {local},  Port ID (outgoing port): {remote}\nHoldtime : 150 sec\n\nVersion :\nCisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(4)E7, RELEASE SOFTWARE (fc2)\n\nadvertisement version: 2\nNative VLAN: 1\nDuplex: full\nManagement address(es): \n  IP address: {ip}\n\n"
    )
}

const ETHERCHANNEL: &str = "Flags:  D - down        P - bundled in port-channel
        I - stand-alone s - suspended
        H - Hot-standby (LACP only)
        R - Layer3      S - Layer2
        U - in use      N - not in use, no aggregation
        f - failed to allocate aggregator

        M - not in use, minimum links not met
        m - not in use, port not aggregated due to minimum links not met
        u - unsuitable for bundling
        w - waiting to be aggregated
        d - default port

        A - formed by Auto LAG


Number of channel-groups in use: 1
Number of aggregators:           1

Group  Port-channel  Protocol    Ports
------+-------------+-----------+-----------------------------------------------
1      Po1(SU)         LACP      Gi1/0/23(P) Gi1/0/24(P)
";

fn switch(id: &str, host: &str, name: &str, cdp_text: &str) -> DeviceIn {
    let mut tables: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    tables.entry("device".into()).or_default().push(Row { command: "show_version".into(), columns: [("hostname".to_string(), name.to_string())].into_iter().collect(), extra: Default::default() });
    for (t, r) in rows("cisco_ios_show_cdp_neighbors_detail", "show_cdp_neighbors_detail", &["neighbor"], cdp_text).into_iter().chain(rows("cisco_ios_show_etherchannel_summary", "show_etherchannel_summary", &["lag"], ETHERCHANNEL)) {
        tables.entry(t).or_default().push(r);
    }
    DeviceIn { device_id: id.into(), host: host.into(), os: Some("cisco_ios".into()), role: Some("switch".into()), prompt: format!("{name}#"), version_text: String::new(), tables }
}

#[test]
fn ios_output_through_the_real_templates_builds_one_cable_and_one_bundle() {
    let a_text = [cdp("SW-B", "192.0.2.2", "GigabitEthernet1/0/1", "GigabitEthernet1/0/2"), cdp("SW-B", "192.0.2.2", "GigabitEthernet1/0/23", "GigabitEthernet1/0/23"), cdp("SW-B", "192.0.2.2", "GigabitEthernet1/0/24", "GigabitEthernet1/0/24")].concat();
    let b_text = [cdp("SW-A", "192.0.2.1", "GigabitEthernet1/0/2", "GigabitEthernet1/0/1"), cdp("SW-A", "192.0.2.1", "GigabitEthernet1/0/23", "GigabitEthernet1/0/23"), cdp("SW-A", "192.0.2.1", "GigabitEthernet1/0/24", "GigabitEthernet1/0/24")].concat();
    let devices = vec![switch("a", "192.0.2.1", "SW-A", &a_text), switch("b", "192.0.2.2", "SW-B", &b_text)];
    assert_eq!(devices[0].rows("neighbor").len(), 3, "the CDP template read three neighbours");
    assert_eq!(devices[0].rows("neighbor")[0].get("rem_mgmt_ip"), Some("192.0.2.2"));
    assert_eq!(devices[0].rows("lag")[0].get("name"), Some("Po1"));
    let g = build(&devices);
    assert_eq!(g.nodes.len(), 2, "{:?}", g.nodes.iter().map(|n| &n.name).collect::<Vec<_>>());
    assert_eq!(g.links.len(), 2, "one cable and one bundle: {:#?}", g.links);
    let cable = g.links.iter().find(|l| l.bundle.is_none()).unwrap();
    assert!(cable.both_directions && cable.confidence == 1.0);
    let bundle = g.links.iter().find(|l| l.bundle.is_some()).unwrap();
    assert_eq!(bundle.bundle.as_ref().unwrap().members.len(), 2);
    assert!(bundle.both_directions);
    assert!(g.findings.is_empty(), "{:?}", g.findings);
}
