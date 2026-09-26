//! Arista EOS identity (LT-467).
//!
//! EOS answers most of Cisco's spellings, which is why an Arista half worked
//! before it had a dialect. What it does not share is the first line of
//! `show version` — `Arista DCS-7050SX3-48YC8`, the model with no label —
//! and the LLDP detail layout, which is a block per interface rather than
//! Cisco's block per neighbour.
//!
//! **Built from Arista's documentation and posted sessions, not from a device
//! (D-058).** The fixtures below are reconstructed to the documented layout
//! and [`verified_against_hardware`] says `false` until one is a capture.

use crate::arp::normalise_mac;
use crate::cdp::short_name;
use crate::types::{DeviceAddress, DeviceClass, Neighbor, Protocol};

/// D-058: this platform has not met a device.
pub fn verified_against_hardware() -> bool {
    false
}

/// `Arista DCS-7050SX3-48YC8` on the first line: the word after `Arista`.
pub fn model_of(version: &str) -> Option<String> {
    let first = version.lines().map(str::trim).find(|l| !l.is_empty())?;
    let rest = first.strip_prefix("Arista ")?;
    let model = rest.split_whitespace().next()?;
    (!model.is_empty()).then(|| model.to_ascii_uppercase())
}

/// `show lldp neighbors detail`, EOS's layout.
///
/// ```text
/// Interface Ethernet1 detected 1 LLDP neighbors:
///
///   Neighbor "001c.73aa.bbcc"/"Ethernet2", age 12 seconds
///   Discovered 0:01:23 ago; Last changed 0:01:23 ago
///   - Chassis ID type: MAC address (4)
///     Chassis ID     : 001c.73aa.bbcc
///   - Port ID type: Interface name (5)
///     Port ID        : "Ethernet2"
///   - Time To Live: 120 seconds
///   - Port Description: "to leaf2"
///   - System Name: "leaf2"
///   - System Description: "Arista Networks EOS version 4.28.0F running on an Arista vEOS"
///   - System Capabilities : Bridge, Router
///     Enabled Capabilities: Bridge, Router
///   - Management Address Subtype: IPv4
///     Management Address        : 10.0.0.2
/// ```
///
/// An interface with several neighbours repeats the `Neighbor` line for each,
/// so a new neighbour starts at every `Neighbor "` line under the interface.
pub fn parse_lldp_detail(out: &str) -> Vec<Neighbor> {
    let mut found: Vec<Neighbor> = Vec::new();
    let mut local: Option<String> = None;
    let value = |line: &str, label: &str| -> Option<String> {
        let t = line.trim().trim_start_matches("- ").trim();
        let (k, v) = t.split_once(':')?;
        k.trim().eq_ignore_ascii_case(label).then(|| v.trim().trim_matches('"').to_string()).filter(|v| !v.is_empty())
    };
    for line in out.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("Interface ") {
            if rest.contains(" detected ") {
                local = rest.split_whitespace().next().map(str::to_string);
            }
            continue;
        }
        if t.starts_with("Neighbor \"") {
            found.push(Neighbor {
                serial: None,
                short_name: String::new(),
                device_id: String::new(),
                addresses: Vec::new(),
                local_interface: local.clone(),
                remote_interface: None,
                platform: None,
                capabilities: Vec::new(),
                version: None,
                class: DeviceClass::Unknown,
                discovered_by: Protocol::Lldp,
                vendor: None,
                chassis_id: None,
            });
            continue;
        }
        let Some(n) = found.last_mut() else { continue };
        if let Some(v) = value(t, "Chassis ID") {
            n.chassis_id = normalise_mac(&v);
            n.vendor = n.chassis_id.as_deref().and_then(crate::oui::vendor).map(str::to_string);
            if n.device_id.is_empty() {
                n.device_id = v;
            }
        } else if let Some(v) = value(t, "Port ID") {
            n.remote_interface = Some(v);
        } else if let Some(v) = value(t, "System Name") {
            n.device_id = v;
        } else if let Some(v) = value(t, "System Description") {
            n.version = Some(v);
        } else if let Some(v) = value(t, "Enabled Capabilities") {
            n.capabilities = v.split(',').map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).collect();
        } else if let Some(v) = value(t, "Management Address") {
            if v.parse::<std::net::IpAddr>().is_ok() {
                n.addresses.push(DeviceAddress { ip: v, interface: None, is_management: true });
            }
        }
    }
    for n in &mut found {
        n.short_name = short_name(&n.device_id);
        n.class = crate::classify::classify(None, &n.capabilities, n.version.as_deref());
    }
    found.retain(|n| !n.device_id.is_empty());
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reconstructed from Arista's documentation (D-058), not captured.
    const VERSION: &str = "Arista DCS-7050SX3-48YC8\nHardware version: 11.00\nSerial number: JPE12345678\nHardware MAC address: 2cdd.e900.0001\nSystem MAC address: 2cdd.e900.0001\n\nSoftware image version: 4.28.0F\nArchitecture: i686\n";
    const LLDP: &str = "Last table change time   : 0:01:23 ago\nNumber of table inserts  : 2\n\nInterface Ethernet1 detected 1 LLDP neighbors:\n\n  Neighbor \"001c.73aa.bbcc\"/\"Ethernet2\", age 12 seconds\n  Discovered 0:01:23 ago; Last changed 0:01:23 ago\n  - Chassis ID type: MAC address (4)\n    Chassis ID     : 001c.73aa.bbcc\n  - Port ID type: Interface name (5)\n    Port ID        : \"Ethernet2\"\n  - Time To Live: 120 seconds\n  - Port Description: \"to leaf2\"\n  - System Name: \"leaf2\"\n  - System Description: \"Arista Networks EOS version 4.28.0F running on an Arista vEOS\"\n  - System Capabilities : Bridge, Router\n    Enabled Capabilities: Bridge, Router\n  - Management Address Subtype: IPv4\n    Management Address        : 10.0.0.2\n    Interface Number Subtype  : ifIndex (2)\n    Interface Number          : 1\n\nInterface Ethernet2 detected 1 LLDP neighbors:\n\n  Neighbor \"0050.5600.0007\"/\"eth0\", age 3 seconds\n  - Chassis ID type: MAC address (4)\n    Chassis ID     : 0050.5600.0007\n  - Port ID type: Interface name (5)\n    Port ID        : \"eth0\"\n";

    #[test]
    fn the_model_is_the_word_after_arista_and_the_serial_is_labelled() {
        assert_eq!(model_of(VERSION).as_deref(), Some("DCS-7050SX3-48YC8"));
        assert_eq!(crate::crawl::serials_in_version(VERSION), ["JPE12345678"]);
        assert_eq!(crate::classify::classify(model_of(VERSION).as_deref(), &[], None), DeviceClass::Switch);
        assert!(!verified_against_hardware());
    }

    #[test]
    fn a_block_per_interface_yields_a_neighbour_each() {
        let got = parse_lldp_detail(LLDP);
        assert_eq!(got.len(), 2);
        let n = &got[0];
        assert_eq!((n.short_name.as_str(), n.local_interface.as_deref(), n.remote_interface.as_deref()), ("leaf2", Some("Ethernet1"), Some("Ethernet2")));
        assert_eq!(n.addresses.iter().map(|a| a.ip.as_str()).collect::<Vec<_>>(), ["10.0.0.2"]);
        assert_eq!(n.capabilities, ["Bridge", "Router"]);
        assert_eq!(n.chassis_id.as_deref(), Some("001c73aabbcc"));
        assert_eq!(got[1].device_id, "0050.5600.0007", "nameless, so its chassis id");
        assert_eq!(got[1].local_interface.as_deref(), Some("Ethernet2"));
        assert!(parse_lldp_detail("% Invalid input").is_empty());
    }
}
