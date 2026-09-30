//! Coreview's own readers (LT-540): output no ntc template reads, read in
//! Rust. A catalog names one as `parser: reader:<name>`; the sidecar is sent
//! `none` and the reply is read here, by `run::settle`, the same way for a
//! live collection and an offline import.

pub mod asa;
pub mod fortinet;
pub mod hosts;

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
        other => Err(format!("no Coreview reader is called {other:?}")),
    }
}

/// Whether a reader of that name exists, for the catalog's own checks.
pub fn exists(name: &str) -> bool {
    matches!(name, "asa_access_list" | "asa_access_group" | "asa_nameif" | "linux_ip_addr" | "linux_lldp" | "fortios_system_status" | "fortios_routing_table" | "fortiswitch_lldp_summary" | "fortiswitch_mac_list" | "fortiswitch_interfaces" | "fortios_interfaces")
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
