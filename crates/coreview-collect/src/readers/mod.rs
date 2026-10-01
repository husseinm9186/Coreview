//! Coreview's own readers (LT-540): output no ntc template reads, read in
//! Rust. A catalog names one as `parser: reader:<name>`; the sidecar is sent
//! `none` and the reply is read here, by `run::settle`, the same way for a
//! live collection and an offline import.

pub mod asa;
pub mod cisco;
pub mod cumulus;
pub mod fortinet;
pub mod frr;
pub mod hosts;
pub mod onyx;
pub mod sonic;
pub(crate) mod text;

use serde_json::Value;

/// Read one reply with the named reader.
pub fn read(name: &str, raw: &str) -> Result<Vec<Value>, String> {
    match name {
        "asa_access_list" => Ok(asa::access_list(raw)),
        "asa_access_group" => Ok(asa::access_group(raw)),
        "asa_nameif" => Ok(asa::nameif(raw)),
        "linux_ip_addr" => Ok(hosts::ip_addr(raw)),
        "linux_lldp" => Ok(hosts::lldp(raw)),
        "fortios_system_status" => Ok(fortinet::system_status(raw)),
        "fortios_routing_table" => Ok(fortinet::routing_table(raw)),
        "fortiswitch_lldp_summary" => Ok(fortinet::lldp_neighbors_summary(raw)),
        "fortiswitch_mac_list" => Ok(fortinet::mac_address_list(raw)),
        "fortiswitch_interfaces" => Ok(fortinet::interface_physical(raw)),
        "fortios_interfaces" => Ok(fortinet::system_interface(raw)),
        "fortios_ha_status" => Ok(fortinet::ha_status(raw)),
        "fortios_wtp_status" => Ok(fortinet::wtp_status(raw)),
        // LT-651: NVIDIA Onyx, from its manual (D-058).
        "onyx_version" => Ok(onyx::version(raw)),
        "onyx_inventory" => Ok(onyx::inventory(raw)),
        "onyx_system_type" => Ok(onyx::system_type(raw)),
        "onyx_hosts" => Ok(onyx::hosts(raw)),
        "onyx_interfaces_status" => Ok(onyx::interfaces_status(raw)),
        "onyx_interface_blocks" => Ok(onyx::interface_blocks(raw)),
        "onyx_switchport" => Ok(onyx::switchport(raw)),
        "onyx_vlan" => Ok(onyx::vlan(raw)),
        "onyx_mac_table" => Ok(onyx::mac_table(raw)),
        "onyx_lldp_remote" => Ok(onyx::lldp_remote(raw)),
        "onyx_lldp_interface_remote" => Ok(onyx::lldp_interface_remote(raw)),
        "onyx_ip_interface_brief" => Ok(onyx::ip_interface_brief(raw)),
        "onyx_ip_route" => Ok(onyx::ip_route(raw)),
        "onyx_ip_arp" => Ok(onyx::ip_arp(raw)),
        "onyx_vrf" => Ok(onyx::vrf(raw)),
        "onyx_ospf_neighbors" => Ok(onyx::ospf_neighbors(raw)),
        "onyx_bgp_summary" => Ok(onyx::bgp_summary(raw)),
        "onyx_port_channel_summary" => Ok(onyx::port_channel_summary(raw)),
        "onyx_mlag" => Ok(onyx::mlag(raw)),
        "onyx_mlag_vip" => Ok(onyx::mlag_vip(raw)),
        "onyx_vrrp" => Ok(onyx::vrrp(raw)),
        "onyx_magp" => Ok(onyx::magp(raw)),
        "onyx_nve" => Ok(onyx::nve(raw)),
        "onyx_nve_peers" => Ok(onyx::nve_peers(raw)),
        "onyx_spanning_tree" => Ok(onyx::spanning_tree(raw)),
        // LT-652: FRR, Cumulus NCLU and SONiC, from their documentation (D-058).
        "frr_ip_route" => Ok(frr::ip_route(raw)),
        "frr_bgp_summary" => Ok(frr::bgp_summary(raw)),
        "frr_ospf_neighbor" => Ok(frr::ospf_neighbor(raw)),
        "cumulus_system" => Ok(cumulus::system(raw)),
        "cumulus_lldp" => Ok(cumulus::lldp(raw)),
        "cumulus_bonds" => Ok(cumulus::bonds(raw)),
        "cumulus_clag" => Ok(cumulus::clag(raw)),
        "cumulus_vrf" => Ok(cumulus::vrf(raw)),
        "sonic_version" => Ok(sonic::version(raw)),
        "sonic_ip_interfaces" => Ok(sonic::ip_interfaces(raw)),
        "sonic_arp" => Ok(sonic::arp(raw)),
        "sonic_mac" => Ok(sonic::mac(raw)),
        "sonic_portchannel" => Ok(sonic::portchannel(raw)),
        "sonic_lldp_table" => Ok(sonic::lldp_table(raw)),
        "sonic_interfaces_status" => Ok(sonic::interfaces_status(raw)),
        "sonic_vrf" => Ok(sonic::vrf(raw)),
        // LT-653: forwarding tables.
        "iosxr_cef" => Ok(cisco::iosxr_cef(raw)),
        "asa_asp_routing" => Ok(cisco::asa_asp_routing(raw)),
        "fortios_kernel_routes" => Ok(fortinet::kernel_routes(raw)),
        "fortios_interface_vrfs" => Ok(fortinet::interface_vrfs(raw)),
        other => Err(format!("no Coreview reader is called {other:?}")),
    }
}

/// Whether a reader of that name exists, for the catalog's own checks.
pub fn exists(name: &str) -> bool {
    matches!(name, "asa_access_list" | "asa_access_group" | "asa_nameif" | "linux_ip_addr" | "linux_lldp" | "fortios_system_status" | "fortios_routing_table" | "fortiswitch_lldp_summary" | "fortiswitch_mac_list" | "fortiswitch_interfaces" | "fortios_interfaces" | "fortios_ha_status" | "fortios_wtp_status") || matches!(name, "iosxr_cef" | "asa_asp_routing" | "fortios_kernel_routes" | "fortios_interface_vrfs") || (name.starts_with("onyx_") || name.starts_with("frr_") || name.starts_with("cumulus_") || name.starts_with("sonic_")) && read(name, "").is_ok()
}

#[cfg(test)]
mod tests {
    /// Every `reader:` a catalog names exists.
    #[test]
    fn every_reader_the_catalogs_name_exists() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/catalog");
        let catalogs = coreview_catalog::load_dir(&dir).unwrap();
        let mut seen = 0;
        for c in &catalogs {
            for cmd in c.commands.iter().chain(&c.live_path) {
                if let Some(name) = cmd.parser.strip_prefix("reader:") {
                    assert!(super::exists(name), "{} {}: no reader {name}", c.os, cmd.id);
                    seen += 1;
                }
            }
        }
        assert!(seen >= 3);
    }
}
