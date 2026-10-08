//! The classic crawler reads what the collector was proven on.
//!
//! Each reply below is a layout the collector's readers met on the
//! lab hardware — a FortiGate 60F and FortiSwitch 224E on 7.6,
//! an SN2010 on Cumulus 5.18 — with
//! every value invented. Each is handed to both engines, and the
//! facts a diagram and a path are drawn from have to agree: who the device
//! is, its addresses, its neighbours, its MACs, its routes.

use coreview_discover as classic;
use serde_json::Value;

macro_rules! lab {
    ($f:literal) => {
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../coreview-discover/fixtures/", $f))
    };
}

fn read(reader: &str, raw: &str) -> Vec<Value> {
    coreview_collect::readers::read(reader, raw).unwrap()
}

#[test]
fn fortios_7_6_system_status() {
    for (raw, model) in [(lab!("fortios76/get_system_status_fortigate.txt"), "FortiGate-60F"), (lab!("fortios76/get_system_status_fortiswitch.txt"), "FortiSwitch-224E")] {
        let collector = &read("fortios_system_status", raw)[0];
        let c = classic::fortios::parse_system_status(raw);
        assert_eq!(c.model.as_deref(), Some(model));
        assert_eq!(c.model.as_deref(), collector["model"].as_str());
        assert_eq!(c.serial.as_deref(), collector["serial"].as_str());
        // The classic crawler keeps the whole banner line for the device's
        // version; the collector the number in it.
        assert!(c.version.as_deref().unwrap_or("").contains(collector["version"].as_str().unwrap()), "{:?}", c.version);
        assert_eq!(c.hostname.as_deref(), collector["hostname"].as_str());
    }
}

#[test]
fn fortigate_7_6_interfaces_and_their_addresses() {
    let raw = lab!("fortios76/get_system_interface_fortigate.txt");
    let rows = read("fortios_interfaces", raw);
    let collector: Vec<&str> = rows.iter().filter_map(|r| r["ip_address"].as_str()).collect();
    let c: Vec<String> = classic::fortios::parse_system_interface(raw).into_iter().map(|a| a.ip).collect();
    assert_eq!(collector, ["192.0.2.1", "198.51.100.1"]);
    assert_eq!(c, collector, "the classic crawler reads 7.6's one line per interface too");
}

#[test]
fn fortiswitch_7_6_neighbours_and_macs() {
    let summary = lab!("fortios76/get_switch_lldp_neighbors_summary.txt");
    let detail = lab!("fortios76/get_switch_lldp_neighbors_detail.txt");
    let collector: Vec<(String, String)> = read("fortiswitch_lldp_detail", detail).iter().map(|r| (r["local_interface"].as_str().unwrap().to_string(), r["management_ip"].as_str().unwrap_or("").to_string())).collect();
    let c = classic::fortios::merge_lldp(classic::fortios::parse_lldp_summary(summary), classic::fortios::parse_lldp_detail(detail));
    for (port, ip) in &collector {
        let n = c.iter().find(|n| n.local_interface.as_deref() == Some(port.as_str())).unwrap_or_else(|| panic!("the classic crawler has no neighbour on {port}: {c:?}"));
        assert_eq!(n.address(), Some(ip.as_str()), "{port}");
    }
    let macs = lab!("fortios76/diagnose_switch_mac_address_list.txt");
    let collector: Vec<(String, String)> = read("fortiswitch_mac_list", macs).iter().map(|r| (r["mac_address"].as_str().unwrap().replace(':', ""), r["interface"].as_str().unwrap().to_string())).collect();
    let c: Vec<(String, String)> = classic::mac_table::parse_mac_table(macs).into_iter().map(|e| (e.mac, e.port)).collect();
    assert_eq!(c, collector, "the switch's own static entry is left out by both");
}

#[test]
fn fortios_7_6_routing_tables() {
    for raw in [lab!("fortios76/get_router_info_routing_table_all_fortigate.txt"), lab!("fortios76/get_router_info_routing_table_all_fortiswitch.txt")] {
        let collector = read("fortios_routing_table", raw);
        let c = classic::routes::parse_routes(raw);
        for row in &collector {
            let prefix = row["network"].as_str().unwrap();
            let r = c.iter().find(|r| r.prefix == prefix).unwrap_or_else(|| panic!("the classic crawler has no {prefix}: {c:?}"));
            if let Some(hop) = row["nexthop_ip"].as_str() {
                assert!(r.next_hops.iter().any(|h| h == hop), "{prefix} via {hop}: {:?}", r.next_hops);
            }
            assert!(r.interface.is_some(), "{prefix} has its interface");
        }
        assert!(!classic::routes::commands_for("fortios").is_empty(), "the classic crawler asks a FortiGate for its table");
    }
    assert_eq!(classic::defaultroute::parse_default_route(lab!("fortios76/get_router_info_routing_table_all_fortigate.txt")).map(|h| h.to_string()).as_deref(), Some("203.0.113.1"));
}

#[test]
fn cumulus_5_through_one_parser() {
    let i = lab!("cumulus5/nv_show_interface.txt");
    let rows = read("nvue_interfaces", i);
    let collector: Vec<&str> = rows.iter().filter(|r| r["kind"] == "primary").filter_map(|r| r["ip_address"].as_str()).filter(|a| a.contains('.') && !a.starts_with("127.")).collect();
    let c: Vec<String> = classic::nvue::parse_interfaces(i).into_iter().filter_map(|x| x.address).collect();
    assert_eq!(c, collector);
    let l = lab!("cumulus5/lldpcli_show_neighbors_details.txt");
    assert_eq!(read("nvue_lldp", l).len(), classic::nvue::neighbours(l).len());
}
