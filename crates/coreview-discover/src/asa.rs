//! Cisco ASA identity (LT-469): an ASA, or a Firepower running the ASA
//! command line.
//!
//! **Built from Cisco's documentation and posted sessions, not from a device
//! (D-058).** Fixtures reconstructed; [`verified_against_hardware`] says
//! `false` until one is a capture.
//!
//! An ASA is close to IOS and differs in three places this reads:
//!
//! - `show version` names the model on the `Hardware:` line and the serial on
//!   `Serial Number:`, which the ordinary serial reader already finds.
//! - `show interface ip brief` is IOS's `show ip interface brief` with the
//!   words swapped and the same columns.
//! - `show route` prints a prefix as `network mask` rather than `network/len`,
//!   so [`cidr_prefixes`] rewrites those lines before the ordinary route
//!   reader sees them. `show arp` prints `ifname address mac age`, which the
//!   ordinary ARP reader finds the address and MAC in.
//!
//! No CDP, no LLDP, no MAC table in routed mode. Paging is `terminal pager 0`.

/// D-058: this platform has not met a device.
pub fn verified_against_hardware() -> bool {
    false
}

/// `Hardware:   ASA5516, 8192 MB RAM, CPU Atom C2000 series 2416 MHz` — the
/// first word after the label.
pub fn model_of(version: &str) -> Option<String> {
    version.lines().find_map(|l| {
        let rest = l.trim().strip_prefix("Hardware:")?;
        let model = rest.trim().split([',', ' ']).next()?.trim();
        (!model.is_empty()).then(|| model.to_ascii_uppercase())
    })
}

/// A dotted-quad mask's prefix length, or `None` for a mask that is not one.
fn prefix_length(mask: &str) -> Option<u8> {
    let m: std::net::Ipv4Addr = mask.parse().ok()?;
    let bits = u32::from(m);
    let len = bits.leading_ones();
    (bits.trailing_zeros() + len == 32 || bits == 0).then_some(len as u8)
}

/// `S*  0.0.0.0 0.0.0.0 [1/0] via 203.0.113.1, outside` rewritten as
/// `S*  0.0.0.0/0 [1/0] via 203.0.113.1, outside`, line by line; a line with
/// no `network mask` pair is left as it was, so IOS output passes through.
pub fn cidr_prefixes(table: &str) -> String {
    let mut out = String::with_capacity(table.len());
    for line in table.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        let rewritten = (words.len() >= 3)
            .then(|| {
                let net: std::net::Ipv4Addr = words[1].parse().ok()?;
                let len = prefix_length(words[2])?;
                let mut rest = words[3..].join(" ");
                if !rest.is_empty() {
                    rest.insert(0, ' ');
                }
                Some(format!("{} {net}/{len}{rest}", words[0]))
            })
            .flatten();
        out.push_str(&rewritten.unwrap_or_else(|| line.to_string()));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reconstructed from Cisco's documentation (D-058), not captured.
    const VERSION: &str = "Cisco Adaptive Security Appliance Software Version 9.16(4)18\nSSP Operating System Version 2.10(1.179)\nDevice Manager Version 7.18(1)\n\nCompiled on Tue 14-Mar-23 10:12 GMT by builders\nSystem image file is \"disk0:/asa9-16-4-18-lfbff-k8.SPA\"\n\nfw-edge-1 up 12 days 3 hours\n\nHardware:   ASA5516, 8192 MB RAM, CPU Atom C2000 series 2416 MHz, 1 CPU (8 cores)\nInternal ATA Compact Flash, 8000MB\n\nSerial Number: JAD12345678\nConfiguration register is 0x1\n";
    const ROUTE: &str = "Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP\n       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area\n\nGateway of last resort is 203.0.113.1 to network 0.0.0.0\n\nS*       0.0.0.0 0.0.0.0 [1/0] via 203.0.113.1, outside\nC        10.0.0.0 255.255.255.0 is directly connected, inside\nL        10.0.0.1 255.255.255.255 is directly connected, inside\nS        192.168.50.0 255.255.255.0 [1/0] via 10.0.0.9, inside\n";
    const BRIEF: &str = "Interface                  IP-Address      OK? Method Status                Protocol\nGigabitEthernet1/1         203.0.113.2     YES CONFIG up                    up\nGigabitEthernet1/2         10.0.0.1        YES CONFIG up                    up\nManagement1/1              unassigned      YES unset  administratively down down\n";
    const ARP: &str = "\tinside 10.0.0.10 0050.56aa.bbcc 12\n\toutside 203.0.113.1 001c.73aa.bbcc 4055\n";

    #[test]
    fn identity_comes_off_the_hardware_and_serial_lines() {
        assert_eq!(model_of(VERSION).as_deref(), Some("ASA5516"));
        assert_eq!(crate::crawl::serials_in_version(VERSION), ["JAD12345678"]);
        assert_eq!(crate::classify::classify(model_of(VERSION).as_deref(), &[], None), crate::types::DeviceClass::Firewall);
        assert_eq!(crate::dialect::family_of(VERSION), crate::dialect::Family::CiscoAsa);
        assert!(!verified_against_hardware());
    }

    #[test]
    fn the_route_table_reads_once_its_masks_are_prefix_lengths() {
        assert_eq!(prefix_length("255.255.255.0"), Some(24));
        assert_eq!(prefix_length("0.0.0.0"), Some(0));
        assert_eq!(prefix_length("255.0.255.0"), None);
        let got = crate::routes::parse_routes(ROUTE);
        let rows: Vec<(&str, &str, Vec<String>)> = got.iter().map(|r| (r.prefix.as_str(), r.protocol.as_str(), r.next_hops.clone())).collect();
        assert!(rows.contains(&("0.0.0.0/0", "static", vec!["203.0.113.1".to_string()])), "{rows:?}");
        assert!(rows.contains(&("10.0.0.0/24", "connected", vec![])), "{rows:?}");
        assert!(rows.contains(&("192.168.50.0/24", "static", vec!["10.0.0.9".to_string()])), "{rows:?}");
        assert_eq!(crate::defaultroute::parse_default_route(ROUTE).map(|a| a.to_string()).as_deref(), Some("203.0.113.1"));
        // IOS output is untouched by the rewrite.
        let ios = "S*    0.0.0.0/0 [1/0] via 10.0.0.1\nC        10.0.0.0/24 is directly connected, Vlan1\n";
        assert_eq!(cidr_prefixes(ios), ios);
    }

    #[test]
    fn the_brief_and_arp_tables_read_with_the_ordinary_readers() {
        let brief = crate::interfaces::parse_ip_interface_brief(BRIEF);
        assert_eq!(brief.iter().filter(|i| i.up).map(|i| i.address.as_deref().unwrap()).collect::<Vec<_>>(), ["203.0.113.2", "10.0.0.1"]);
        let arp = crate::arp::parse_arp_table(ARP);
        assert_eq!(arp.get("005056aabbcc").map(String::as_str), Some("10.0.0.10"), "keyed by MAC, as the crawl reads it: {arp:?}");
    }
}
