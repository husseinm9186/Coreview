//! ArubaOS-CX: identity from `show system` (LT-490), and the switch's own
//! spellings of the LLDP and MAC tables (LT-635).
//!
//! **Captured, not reconstructed.** The fixtures below are the operator's
//! own output from an Aruba CX 6200F on AOS-CX ML.10.18, 2026-09-28, with the
//! chassis serial and base MAC replaced by invented values (D-027). What
//! they earned is the identity half: `show version` names the software and
//! nothing else, and `show system` names the product, the serial and the
//! host. The neighbour, ARP, MAC and bundle commands this dialect sends have
//! **not** been seen from a CX device, which is why the dialect as a whole
//! still reports unverified.

fn labelled<'a>(out: &'a str, label: &str) -> Option<&'a str> {
    out.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k.trim().eq_ignore_ascii_case(label) && !v.trim().is_empty()).then(|| v.trim())
    })
}

/// `Product Name : JL727A 6200F 48G CL4 4SFP+370W Swch`, upper-cased for
/// the classifier — the part number, the family and what it is.
use crate::mac_table::MacEntry;
use crate::types::{DeviceAddress, Neighbor, Protocol};

pub fn model_of(system: &str) -> Option<String> {
    labelled(system, "Product Name").map(|m| m.to_ascii_uppercase())
}

/// `Chassis Serial Nbr : …`.
pub fn serials_of(system: &str) -> Vec<String> {
    labelled(system, "Chassis Serial Nbr").map(|s| vec![s.to_string()]).unwrap_or_default()
}

/// `show lldp neighbor-info detail` (LT-635): a block per port between
/// dashed rules, `Key : value` lines. Two releases name the neighbour
/// `Neighbor Chassis-Name` or `Neighbor System-Name`; both are read.
/// Written against ntc-templates' captures of real AOS-CX output (the
/// operator's 6200 is not reachable from the build machine); his next
/// crawl is what earns this `verified`.
pub fn parse_lldp_neighbor_info_detail(out: &str) -> Vec<Neighbor> {
    let mut found = Vec::new();
    for block in out.split('\n').collect::<Vec<_>>().split(|l| l.trim_start().starts_with("-----")) {
        let field = |name: &str| -> Option<String> {
            block.iter().find_map(|l| {
                let (k, v) = l.split_once(':')?;
                (k.trim() == name).then(|| v.trim().to_string()).filter(|v| !v.is_empty())
            })
        };
        let Some(local) = field("Port") else { continue };
        let name = field("Neighbor Chassis-Name").or_else(|| field("Neighbor System-Name")).unwrap_or_default();
        let chassis = field("Neighbor Chassis-ID").unwrap_or_default();
        if name.is_empty() && chassis.is_empty() {
            continue;
        }
        let descr = field("Neighbor Chassis-Description").or_else(|| field("Neighbor System-Description"));
        let caps: Vec<String> = field("Chassis Capabilities Enabled").unwrap_or_default().split(',').map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).collect();
        let port_desc = field("Neighbor Port-Desc").unwrap_or_default();
        let port_id = field("Neighbor Port-ID").unwrap_or_default();
        let mut n = crate::arubasw::neighbour_from(&chassis, &name, &local, if port_desc.is_empty() { &port_id } else { &port_desc }, descr.clone(), &caps, Protocol::Lldp);
        if let Some(ip) = field("Neighbor Management-Address").filter(|a| a.parse::<std::net::IpAddr>().is_ok()) {
            n.addresses = vec![DeviceAddress { ip, interface: None, is_management: true }];
        }
        n.version = descr;
        found.push(n);
    }
    found
}

/// `show mac-address-table` (LT-635): `MAC Address  VLAN  Type  Port` under
/// a dashed rule. Dynamic and port-access entries are devices; a static
/// entry is the switch's own.
pub fn parse_mac_address_table(out: &str) -> Vec<MacEntry> {
    let mut found = Vec::new();
    let mut in_table = false;
    for line in out.lines() {
        if line.trim_start().starts_with("-----") {
            in_table = true;
            continue;
        }
        if !in_table {
            continue;
        }
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 4 {
            continue;
        }
        let Some(mac) = crate::arp::normalise_mac(f[0]) else { continue };
        let kind = f[2].to_ascii_lowercase();
        if kind.contains("static") {
            continue;
        }
        found.push(MacEntry { mac, port: f[3].to_string(), vlan: Some(f[1].to_string()) });
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ntc-templates' capture of an AOS-CX `show lldp neighbor-info detail`,
    /// cut to two ports, in the release that writes `Chassis-Name`; and one
    /// port of the release that writes `System-Name`.
    const LLDP: &str = "LLDP Neighbor Information 
=========================
Total Neighbor Entries          : 2
--------------------------------------------------------------------------------
Port                           : 1/1/1
Neighbor Entries               : 1
Neighbor Chassis-Name          : ap-9999-335-fe
Neighbor Chassis-Description   : ArubaOS (MODEL: 335), Version Aruba AP
Neighbor Chassis-ID            : 70:3a:0e:cd:41:fe
Neighbor Management-Address    : 10.252.99.12
Chassis Capabilities Available : Bridge, WLAN
Chassis Capabilities Enabled   : WLAN
Neighbor Port-ID               : 70:3a:0e:cd:41:fe
Neighbor Port-Desc             : eth0
Neighbor Port VLAN ID          : 
TTL                            : 120
Neighbor Mac-Phy details
Neighbor Auto-neg Supported    : true
--------------------------------------------------------------------------------
Port                           : 1/1/49
Neighbor Entries               : 1
Neighbor System-Name           : core-sw
Neighbor System-Description    : HPE Aruba Networking JL727A 6200F
Neighbor Chassis-ID            : 00:00:5e:00:53:01
Neighbor Management-Address    : 10.252.99.1
Chassis Capabilities Available : Bridge, Router
Chassis Capabilities Enabled   : Bridge, Router
Neighbor Port-ID               : 1/1/49
Neighbor Port-Desc             : 1/1/49
TTL                            : 120
--------------------------------------------------------------------------------
";

    #[test]
    fn lldp_neighbours_in_both_layouts() {
        let n = parse_lldp_neighbor_info_detail(LLDP);
        assert_eq!(n.len(), 2, "{n:#?}");
        assert_eq!((n[0].short_name.as_str(), n[0].local_interface.as_deref(), n[0].remote_interface.as_deref()), ("ap-9999-335-fe", Some("1/1/1"), Some("eth0")));
        assert_eq!(n[0].addresses[0].ip, "10.252.99.12");
        assert_eq!(n[0].chassis_id.as_deref(), Some("703a0ecd41fe"));
        assert_eq!((n[1].short_name.as_str(), n[1].remote_interface.as_deref()), ("core-sw", Some("1/1/49")));
        assert_eq!(n[1].class, crate::types::DeviceClass::Router, "Bridge, Router enabled");
    }

    #[test]
    fn mac_table_keeps_learned_entries() {
        let out = "MAC age-time            : 300 seconds
Number of MAC addresses : 4

MAC Address          VLAN     Type                      Port
--------------------------------------------------------------
88:3a:30:a3:86:80    1        dynamic                   lag100
80:5e:0c:76:ed:bb    2015     port-access-security      1/1/30
00:00:5e:00:53:ff    1        static                    1/1/1
";
        let m = parse_mac_address_table(out);
        assert_eq!(m.len(), 2, "{m:?}");
        assert_eq!((m[0].mac.as_str(), m[0].port.as_str(), m[0].vlan.as_deref()), ("883a30a38680", "lag100", Some("1")));
        assert_eq!(m[1].port, "1/1/30");
    }

    /// The operator's `show version`, verbatim.
    pub(crate) const VERSION: &str = "-----------------------------------------------------------------------------\nAOS-CX\n(c) Copyright 2017-2026 Hewlett Packard Enterprise Development LP\n-----------------------------------------------------------------------------\nVersion      : ML.10.18.1002                                                 \nBuild Date   : 2026-08-27 04:58:32 UTC                                       \nBuild ID     : AOS-CX:ML.10.18.1002:0ea5714e629d:202608270437                \nBuild SHA    : 0ea5714e629d97e799de623c2350c9cd41fb03f4                      \nHot Patches  :                                                               \nActive Image : primary                       \n \nService OS Version : ML.01.19.0001                 \nBIOS Version       : FL.01.0004                    \n";

    /// The operator's `show system`, with the serial and base MAC invented.
    pub(crate) const SYSTEM: &str = "Hostname               : 6200                          \nSystem Description     : ML.10.18.1002                 \nSystem Contact         :                               \nSystem Location        :                               \n \nVendor                 : HPE ANW                       \nProduct Name           : JL727A 6200F 48G CL4 4SFP+370W Swch  \nChassis Serial Nbr     : XX00EXAMPLE                   \nBase MAC Address       : 00005e-005301                 \nAOS-CX Version         : ML.10.18.1002                 \n \nTime Zone              : UTC                           \n \nUp Time                : 1 week, 5 days, 14 hours, 15 minutes                        \nCPU Util (%)           : 24                            \nCPU Util (% avg 1 min) : 8                             \nCPU Util (% avg 5 min) : 10                            \nMemory Usage (%)       : 17\n";

    #[test]
    fn a_cx_6200_names_its_model_and_serial_and_is_a_switch() {
        assert_eq!(crate::dialect::family_of(VERSION), crate::dialect::Family::ArubaOsCx);
        assert_eq!(model_of(SYSTEM).as_deref(), Some("JL727A 6200F 48G CL4 4SFP+370W SWCH"));
        assert_eq!(serials_of(SYSTEM), ["XX00EXAMPLE"]);
        // An empty label is not a value: `System Contact :` is blank.
        assert_eq!(labelled(SYSTEM, "System Contact"), None);
        // Through the dialect, the way a crawl asks.
        let d = crate::dialect::dialect_for(VERSION);
        assert_eq!(d.identity_commands(), ["show system"]);
        let id = d.identity(VERSION, &[SYSTEM.to_string()]);
        assert_eq!((id.model.as_deref(), id.serials.as_slice()), (Some("JL727A 6200F 48G CL4 4SFP+370W SWCH"), &["XX00EXAMPLE".to_string()][..]));
        assert_eq!(crate::classify::classify(id.model.as_deref(), &[], None), crate::types::DeviceClass::Switch);
        // `show version` alone names nothing, which was the gap.
        assert_eq!(crate::crawl::serials_in_version(VERSION), Vec::<String>::new());
    }
}
