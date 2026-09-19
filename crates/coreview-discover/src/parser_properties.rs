//! Properties every parser keeps, whatever a device sends (LT-267).
//!
//! The example tests beside each parser pin what it reads from captured
//! output. These say what must hold for *any* output: a parser never panics —
//! on arbitrary text, and on a real-shaped sample cut short, with lines
//! dropped, doubled or garbage inserted, the way a slow SSH read or a paging
//! prompt mangles output — and what it returns stays within what the text
//! could have said. A crawl reads whatever arrives; one malformed line must
//! cost that line, not the crawl.
//!
//! Samples are invented, in the shapes the captured tests use.

use proptest::prelude::*;

use crate::{arp, cdp, counters, defaultroute, etherchannel, fortios, interfaces, lldp, mac_table, pathcheck, routes, seeds, stacking, stp, uptime, vlans, walkfile};

const CDP: &str = "\
-------------------------
Device ID: DIST-SW1.example.test
Entry address(es):
  IP address: 192.0.2.2
Platform: cisco WS-C3850-24T,  Capabilities: Switch IGMP
Interface: GigabitEthernet1/0/1,  Port ID (outgoing port): GigabitEthernet1/0/24
Holdtime : 137 sec

Version :
Cisco IOS Software, Version 16.12.4

-------------------------
Device ID: AP-FLOOR2
Entry address(es):
  IP address: 192.0.2.55
Platform: cisco AIR-AP2802I-E-K9,  Capabilities: Trans-Bridge
Interface: GigabitEthernet1/0/5,  Port ID (outgoing port): GigabitEthernet0
Holdtime : 155 sec

Total cdp entries displayed : 2
";

const LLDP: &str = "\
------------------------------------------------
Local Intf: Gi1/0/12
Chassis id: 0000.5e00.5301
Port id: 0000.5e00.5302
Port Description: 1/1/1
System Name: EDGE-SW2

System Description:
ArubaOS-CX GL_10.09.1010

Time remaining: 97 seconds
System Capabilities: B,R
Enabled Capabilities: B
Management Addresses:
    IP: 192.0.2.40

Total entries displayed: 1
";

const ROUTES: &str = "\
Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP
       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area
Gateway of last resort is 192.0.2.1 to network 0.0.0.0

S*    0.0.0.0/0 [1/0] via 192.0.2.1
      192.0.2.0/24 is variably subnetted, 2 subnets, 2 masks
C        192.0.2.0/24 is directly connected, Vlan1
L        192.0.2.7/32 is directly connected, Vlan1
O        198.51.100.0/24 [110/2] via 192.0.2.3, 00:10:11, Vlan1
";

const STP: &str = "\
VLAN0001
  Spanning tree enabled protocol rstp
  Root ID    Priority    32768
             Address     0000.5e00.5301
             Cost        4
             Port        1 (GigabitEthernet0/1)
             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec

  Bridge ID  Priority    32769  (priority 32768 sys-id-ext 1)
             Address     0000.5e00.5380
             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec

Interface           Role Sts Cost      Prio.Nbr Type
------------------- ---- --- --------- -------- --------------------------------
Gi0/1               Root FWD 4         128.1    P2p
Gi0/2               Altn BLK 4         128.2    P2p
";

const VLAN_BRIEF: &str = "\
VLAN Name                             Status    Ports
---- -------------------------------- --------- -------------------------------
1    default                          active    Gi0/2, Gi0/3
10   STAFF                            active
20   PRINTERS                         active    Gi0/4
1002 fddi-default                     act/unsup
";

const TRUNKS: &str = "\
Port        Mode             Encapsulation  Status        Native vlan
Gi0/1       on               802.1q         trunking      1

Port        Vlans allowed on trunk
Gi0/1       1-4094

Port        Vlans allowed and active in management domain
Gi0/1       1,10,14-16,20
";

const STATUS: &str = "\
Port      Name               Status       Vlan       Duplex  Speed Type
Gi0/1                        connected    trunk      a-full   1000 10/100/1000BaseTX
Gi0/2     desk 12            notconnect   10           auto   auto 10/100/1000BaseTX
";

const COUNTERS: &str = "\
GigabitEthernet0/1 is up, line protocol is up (connected)
  Hardware is Gigabit Ethernet, address is 0000.5e00.5381 (bia 0000.5e00.5381)
  Full-duplex, 1000Mb/s, media type is 10/100/1000BaseTX
  Input queue: 0/75/0/0 (size/max/drops/flushes); Total output drops: 12
     0 input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored
     0 output errors, 0 collisions, 2 interface resets
";

const MAC_TABLE: &str = "\
          Mac Address Table
-------------------------------------------

Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
 All    0100.0ccc.cccc    STATIC      CPU
   1    0000.5e00.5301    DYNAMIC     Gi0/9
  10    0000.5e00.5302    DYNAMIC     Gi0/7
";

const ARP: &str = "\
Protocol  Address          Age (min)  Hardware Addr   Type   Interface
Internet  192.0.2.1               0   0000.5e00.5301  ARPA   Vlan1
Internet  192.0.2.7               -   0000.5e00.5307  ARPA   Vlan1
";

const INTERFACES: &str = "\
Interface              IP-Address      OK? Method Status                Protocol
GigabitEthernet0/0     192.0.2.1       YES NVRAM  up                    up
Loopback0              198.51.100.1    YES NVRAM  up                    up
Vlan999                unassigned      YES NVRAM  administratively down down
";

const PING: &str = "Type escape sequence to abort.\nSending 3, 100-byte ICMP Echos to 192.0.2.1, timeout is 1 seconds:\n!!!\nSuccess rate is 100 percent (3/3), round-trip min/avg/max = 1/1/3 ms\n";

const ETHERCHANNEL: &str = "\
Number of channel-groups in use: 1
Number of aggregators:           1

Group  Port-channel  Protocol    Ports
------+-------------+-----------+-----------------------------------------------
1      Po1(SU)         LACP        Gi1/0/11(P)     Gi1/0/12(P)
";

const FORTI_STATUS: &str = "\
Version: FortiSwitch-224E v7.6.1,build1047,241217 (GA)
Serial-Number: S000TESTSERIAL00
Hostname: ACCESS-FSW1
";

const WALK: &str = "\
SNMPv2-MIB::sysDescr.0 = STRING: Cisco IOS Software, Version 15.2(7)E
Technical Support: http://www.cisco.com/techsupport
SNMPv2-MIB::sysName.0 = STRING: ACCESS-SW7.example.test
IP-MIB::ipAdEntAddr.192.0.2.7 = IpAddress: 192.0.2.7
LLDP-MIB::lldpRemChassisIdSubtype.0.1.94 = INTEGER: macAddress(4)
LLDP-MIB::lldpRemChassisId.0.1.94 = Hex-STRING: 00 00 5E 00 53 A8
LLDP-MIB::lldpRemSysName.0.1.94 = STRING: EDGE-SW2
LLDP-MIB::lldpLocPortId.1 = STRING: \"Gi0/1\"
";

/// Every parser that reads command text, by name, run for its side effects:
/// each must return without panicking.
fn run_all(text: &str) {
    let _ = arp::parse_arp_table(text);
    let _ = cdp::parse_cdp_detail(text);
    let _ = lldp::parse_lldp_detail(text);
    let _ = mac_table::parse_mac_table(text);
    let _ = routes::parse_routes(text);
    let _ = stp::parse_spanning_tree(text);
    let _ = counters::parse_interface_counters(text);
    let _ = etherchannel::parse_etherchannel_summary(text);
    let _ = interfaces::parse_ip_interface_brief(text);
    let _ = pathcheck::parse_ios_ping(text);
    let _ = seeds::parse_seeds(text);
    let _ = defaultroute::parse_default_route(text);
    let _ = uptime::parse_uptime(text);
    let _ = fortios::parse_system_status(text);
    let _ = fortios::parse_system_interface(text);
    let _ = fortios::parse_lldp_summary(text);
    let _ = fortios::parse_device_store(text);
    let _ = fortios::parse_wtp_status(text);
    let _ = fortios::parse_managed_switches(text);
    let _ = fortios::parse_dhcp_leases(text);
    let _ = vlans::expand_vlan_list(text);
    let _ = vlans::parse_vlan_brief(text);
    let _ = vlans::parse_trunks(text);
    let _ = vlans::parse_interface_status(text);
    let _ = stacking::parse_any(text);
    let _ = walkfile::read_walk(text, None);
    let _ = walkfile::read_walk(text, Some("192.0.2.1"));
}

const SAMPLES: &[&str] = &[CDP, LLDP, ROUTES, STP, VLAN_BRIEF, TRUNKS, STATUS, COUNTERS, MAC_TABLE, ARP, INTERFACES, PING, ETHERCHANNEL, FORTI_STATUS, WALK];

/// A sample mangled the ways a live session mangles output.
#[derive(Debug, Clone)]
enum Mangle {
    Truncate(usize),
    DropLine(usize),
    DoubleLine(usize),
    Insert(usize, String),
    Splice(usize, usize),
}

fn mangle(sample: &str, how: &Mangle) -> String {
    let mut lines: Vec<String> = sample.lines().map(str::to_string).collect();
    let at = |i: usize, n: usize| if n == 0 { 0 } else { i % n };
    match how {
        Mangle::Truncate(i) => {
            let chars: Vec<char> = sample.chars().collect();
            return chars[..at(*i, chars.len() + 1).min(chars.len())].iter().collect();
        }
        Mangle::DropLine(i) => {
            if !lines.is_empty() {
                let k = at(*i, lines.len());
                lines.remove(k);
            }
        }
        Mangle::DoubleLine(i) => {
            if !lines.is_empty() {
                let k = at(*i, lines.len());
                let l = lines[k].clone();
                lines.insert(k, l);
            }
        }
        Mangle::Insert(i, junk) => {
            let k = at(*i, lines.len() + 1);
            lines.insert(k, junk.clone());
        }
        Mangle::Splice(i, j) => {
            // Half of one line joined to half of another: a paging prompt
            // swallowed mid-line.
            if lines.len() >= 2 {
                let (a, b) = (at(*i, lines.len()), at(*j, lines.len()));
                let left: String = lines[a].chars().take(lines[a].chars().count() / 2).collect();
                let right: String = lines[b].chars().skip(lines[b].chars().count() / 2).collect();
                lines[a] = format!("{left}{right}");
            }
        }
    }
    lines.join("\n")
}

fn any_mangle() -> impl Strategy<Value = Mangle> {
    prop_oneof![
        any::<usize>().prop_map(Mangle::Truncate),
        any::<usize>().prop_map(Mangle::DropLine),
        any::<usize>().prop_map(Mangle::DoubleLine),
        (any::<usize>(), ".{0,120}").prop_map(|(i, s)| Mangle::Insert(i, s)),
        (any::<usize>(), any::<usize>()).prop_map(|(i, j)| Mangle::Splice(i, j)),
    ]
}

#[test]
fn every_sample_is_read_by_its_parser() {
    // The mangling below only means something if the samples are read at all.
    assert_eq!(cdp::parse_cdp_detail(CDP).len(), 2);
    assert_eq!(lldp::parse_lldp_detail(LLDP).len(), 1);
    assert!(!routes::parse_routes(ROUTES).is_empty());
    assert!(!stp::parse_spanning_tree(STP).is_empty());
    assert_eq!(vlans::parse_vlan_brief(VLAN_BRIEF).len(), 4);
    assert!(!vlans::parse_trunks(TRUNKS).is_empty());
    assert_eq!(vlans::parse_interface_status(STATUS).len(), 2);
    assert_eq!(counters::parse_interface_counters(COUNTERS).len(), 1);
    assert!(!mac_table::parse_mac_table(MAC_TABLE).is_empty());
    assert_eq!(arp::parse_arp_table(ARP).len(), 2);
    assert!(!interfaces::parse_ip_interface_brief(INTERFACES).is_empty());
    assert!(pathcheck::parse_ios_ping(PING).is_some());
    assert_eq!(etherchannel::parse_etherchannel_summary(ETHERCHANNEL).len(), 1);
    assert!(fortios::parse_system_status(FORTI_STATUS).hostname.is_some());
    assert!(walkfile::read_walk(WALK, None).device.is_some());
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 512, ..ProptestConfig::default() })]

    #[test]
    fn no_parser_panics_on_arbitrary_text(text in "(?s).{0,600}") {
        run_all(&text);
    }

    #[test]
    fn no_parser_panics_on_text_made_of_their_own_words(
        words in prop::collection::vec(prop::sample::select(vec![
            "Device ID:", "Interface:", "Port ID (outgoing port):", "Local Intf:", "Chassis id:", "System Name:",
            "VLAN0001", "Root ID", "Bridge ID", "is directly connected,", "via", "[110/2]", "/24", "Gi0/1", "Po1(SU)",
            "Success rate is", "percent", "(3/3)", "= STRING:", "Hex-STRING:", "INTEGER:", "::", ".0.1.94", "\n",
            "-", "—", "1-4094", ",", "trunk", "connected", "0000.5e00.5301", "192.0.2.1", "uptime is", "weeks,", "edit \"",
            "config ports", "next", "end", "WTP:", "wtp-id           :", "Record #1:", "'mac' = '", "Hostname:", "  ",
        ]), 0..80)
    ) {
        run_all(&words.concat());
    }

    #[test]
    fn a_mangled_sample_is_still_read_without_a_panic(which in 0usize..SAMPLES.len(), how in any_mangle(), again in any_mangle()) {
        let text = mangle(&mangle(SAMPLES[which], &how), &again);
        run_all(&text);
    }

    /// A VLAN list names only VLANs that can exist, whatever it was given.
    #[test]
    fn a_vlan_list_is_only_real_vlans(text in "[0-9,\\- ]{0,60}") {
        for v in vlans::expand_vlan_list(&text) {
            prop_assert!((1..=4094).contains(&v));
        }
    }

    /// What a neighbour table yields always has a name to put on a diagram.
    #[test]
    fn a_neighbour_is_always_named(which in 0usize..2, how in any_mangle()) {
        let text = mangle([CDP, LLDP][which], &how);
        for n in cdp::parse_cdp_detail(&text).into_iter().chain(lldp::parse_lldp_detail(&text)) {
            prop_assert!(!n.device_id.trim().is_empty() || !n.short_name.trim().is_empty(), "{n:?}");
        }
    }

    /// A ping summary never claims more replies than it sent.
    #[test]
    fn a_ping_summary_is_consistent(sent in 0u32..50, received in 0u32..60) {
        let text = format!("Sending {sent}, 100-byte ICMP Echos to 192.0.2.1, timeout is 1 seconds:\nSuccess rate is 0 percent ({received}/{sent})\n");
        if let Some(p) = pathcheck::parse_ios_ping(&text) {
            prop_assert!(p.received <= p.sent, "{p:?}");
        }
    }

    /// A walk never reports more rows than it had lines.
    #[test]
    fn a_walk_counts_no_more_rows_than_lines(how in any_mangle()) {
        let text = mangle(WALK, &how);
        let r = walkfile::read_walk(&text, None);
        prop_assert!(r.rows + r.unknown_rows <= text.lines().count());
    }
}
