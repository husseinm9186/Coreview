//! Check Point Gaia identity (LT-470), through clish.
//!
//! **Built from Check Point's documentation and posted sessions, not from a
//! gateway (D-058).** Fixtures reconstructed; [`verified_against_hardware`]
//! says `false` until one is a capture.
//!
//! - `show version all` — `Product version Check Point Gaia R81.10`, the
//!   banner the family is read from.
//! - `show asset all` — `Model: Check Point 5600`, `Serial Number: …`, read
//!   by the ordinary serial reader.
//! - `show interfaces all` — a block per interface: `state on`,
//!   `link-state link up`, `ipv4-address a.b.c.d/len`.
//! - `show route` — Cisco-shaped enough for the ordinary route reader:
//!   `S  0.0.0.0/0  via 203.0.113.1, eth0, cost 0, age 1234`.
//! - `show arp dynamic all` — read by the ordinary ARP reader.
//!
//! No CDP, no LLDP in clish, no MAC table. Paging is `set clienv rows 0`.

use crate::interfaces::Interface;

/// D-058: this platform has not met a device.
pub fn verified_against_hardware() -> bool {
    false
}

/// `Serial Number: 1234567890` in `show asset all` — digits only on an
/// appliance, which the ordinary serial reader would not take for one.
pub fn serials_of(asset: &str) -> Vec<String> {
    asset
        .lines()
        .filter_map(|l| {
            let (k, v) = l.trim().split_once(':')?;
            (k.trim().eq_ignore_ascii_case("serial number") && !v.trim().is_empty()).then(|| v.trim().to_string())
        })
        .collect()
}

/// `Model: Check Point 5600` in `show asset all`.
pub fn model_of(asset: &str) -> Option<String> {
    asset.lines().find_map(|l| {
        let (k, v) = l.trim().split_once(':')?;
        (k.trim().eq_ignore_ascii_case("model") && !v.trim().is_empty()).then(|| v.trim().to_ascii_uppercase())
    })
}

/// `show interfaces all`.
///
/// ```text
/// Interface eth0
///         state on
///         mac-addr 00:1c:7f:aa:bb:cc
///         type ethernet
///         link-state link up
///         mtu 1500
///         ipv4-address 203.0.113.2/24
///         ipv6-address Not Configured
/// Interface eth1
///         state on
///         link-state link up
///         ipv4-address 10.0.0.1/24
/// Interface eth2
///         state off
///         link-state link down
///         ipv4-address Not Configured
/// ```
pub fn parse_interfaces_all(out: &str) -> Vec<Interface> {
    let mut found: Vec<Interface> = Vec::new();
    let mut current: Option<(String, bool, bool, Option<String>)> = None;
    let flush = |current: &mut Option<(String, bool, bool, Option<String>)>, found: &mut Vec<Interface>| {
        if let Some((name, state, link, Some(address))) = current.take() {
            found.push(Interface { name, address: Some(address), up: state && link });
        }
    };
    for line in out.lines() {
        let t = line.trim();
        if let Some(name) = t.strip_prefix("Interface ") {
            flush(&mut current, &mut found);
            current = Some((name.trim().to_string(), false, false, None));
            continue;
        }
        let Some(cur) = current.as_mut() else { continue };
        if let Some(v) = t.strip_prefix("state ") {
            cur.1 = v.trim() == "on";
        } else if let Some(v) = t.strip_prefix("link-state ") {
            cur.2 = v.trim().ends_with("up");
        } else if let Some(v) = t.strip_prefix("ipv4-address ") {
            let a = v.trim().split('/').next().unwrap_or("");
            if a.parse::<std::net::Ipv4Addr>().is_ok() {
                cur.3 = Some(a.to_string());
            }
        }
    }
    flush(&mut current, &mut found);
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reconstructed from Check Point's documentation (D-058), not captured.
    const VERSION: &str = "Product version Check Point Gaia R81.10\nOS build 335\nOS kernel version 3.10.0-957.21.3cpx86_64\nOS edition 64-bit\n";
    const ASSET: &str = "Platform: 5600 Appliance\nModel: Check Point 5600\nSerial Number: 1234567890\nCPU Model: Intel(R) Xeon(R) CPU\nCPU Frequency: 2100.000 Mhz\n";
    const INTERFACES: &str = "Interface eth0\n        state on\n        mac-addr 00:1c:7f:aa:bb:cc\n        type ethernet\n        link-state link up\n        mtu 1500\n        ipv4-address 203.0.113.2/24\n        ipv6-address Not Configured\nInterface eth1\n        state on\n        link-state link up\n        ipv4-address 10.0.0.1/24\nInterface eth2\n        state off\n        link-state link down\n        ipv4-address Not Configured\nInterface lo\n        state on\n        link-state link up\n        ipv4-address 127.0.0.1/8\n";
    const ROUTE: &str = "Codes: C - Connected, S - Static, R - RIP, B - BGP (D - Default),\n       O - OSPF IntraArea (IA - InterArea, E - External, N - NSSA)\n       A - Aggregate, K - Kernel Remnant, H - Hidden, P - Suppressed,\n       U - Unreachable, i - Inactive\n\nS       0.0.0.0/0           via 203.0.113.1, eth0, cost 0, age 123456\nC       10.0.0.0/24         is directly connected, eth1\nC       203.0.113.0/24      is directly connected, eth0\nS       192.168.50.0/24     via 10.0.0.9, eth1, cost 0, age 1234\n";
    const ARP: &str = "10.0.0.10           00:50:56:aa:bb:cc   eth1\n203.0.113.1         00:1c:73:aa:bb:cc   eth0\n";

    #[test]
    fn identity_comes_off_the_banner_and_the_asset_table() {
        assert_eq!(crate::dialect::family_of(VERSION), crate::dialect::Family::Gaia);
        assert_eq!(model_of(ASSET).as_deref(), Some("CHECK POINT 5600"));
        assert_eq!(serials_of(ASSET), ["1234567890"]);
        assert_eq!(crate::classify::classify(model_of(ASSET).as_deref(), &[], None), crate::types::DeviceClass::Firewall);
        assert!(!verified_against_hardware());
    }

    #[test]
    fn interfaces_come_off_their_blocks_and_a_down_one_is_down() {
        let got = parse_interfaces_all(INTERFACES);
        let rows: Vec<(&str, &str, bool)> = got.iter().map(|i| (i.name.as_str(), i.address.as_deref().unwrap(), i.up)).collect();
        assert_eq!(rows, [("eth0", "203.0.113.2", true), ("eth1", "10.0.0.1", true), ("lo", "127.0.0.1", true)]);
    }

    #[test]
    fn the_route_and_arp_tables_read_with_the_ordinary_readers() {
        let got = crate::routes::parse_routes(ROUTE);
        let rows: Vec<(&str, &str, Vec<String>)> = got.iter().map(|r| (r.prefix.as_str(), r.protocol.as_str(), r.next_hops.clone())).collect();
        assert!(rows.contains(&("0.0.0.0/0", "static", vec!["203.0.113.1".to_string()])), "{rows:?}");
        assert!(rows.contains(&("10.0.0.0/24", "connected", vec![])), "{rows:?}");
        assert_eq!(crate::defaultroute::parse_default_route(ROUTE).map(|a| a.to_string()).as_deref(), Some("203.0.113.1"));
        let arp = crate::arp::parse_arp_table(ARP);
        assert_eq!(arp.get("005056aabbcc").map(String::as_str), Some("10.0.0.10"));
    }
}
