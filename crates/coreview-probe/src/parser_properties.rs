//! Properties the probe engine's readers keep, whatever arrives (LT-267).
//!
//! Most of what this crate reads comes off the wire from hosts it has never
//! met — DNS, NetBIOS and mDNS replies, HTTP banners — or from the operating
//! system's own tools, whose output varies by version and locale. None of it
//! may panic a sweep, and what is read back must be something the input could
//! have said.

use std::net::Ipv4Addr;

use proptest::prelude::*;

use crate::{banner, dnsquery, icmp, names, neighbour, sweep, traceroute, udp, validate};

proptest! {
    #![proptest_config(ProptestConfig { cases: 1024, ..ProptestConfig::default() })]

    #[test]
    fn no_wire_reader_panics_on_arbitrary_bytes(bytes in prop::collection::vec(any::<u8>(), 0..600), want in any::<u16>()) {
        let _ = banner::parse_response(&bytes);
        let _ = dnsquery::parse_reply(&bytes, want);
        let _ = names::parse_nbstat(&bytes);
        let _ = names::parse_mdns_ptr(&bytes);
    }

    /// A real query, then damaged the way a reply is on a lossy link: cut short,
    /// or with bytes changed — which is exactly how a compression pointer comes
    /// to point at itself.
    #[test]
    fn a_damaged_dns_message_is_refused_not_a_panic(
        label in "[a-z]{1,20}", qtype in prop::sample::select(vec![1u16, 2, 5, 12, 15, 16, 28, 33]),
        cut in any::<usize>(), flips in prop::collection::vec((any::<usize>(), any::<u8>()), 0..6),
    ) {
        let mut msg = dnsquery::build_query(0xC0DE, &format!("{label}.example.test"), qtype).expect("a valid name");
        // Turn it into a reply with one answer pointing back at the question.
        msg[2] |= 0x80;
        msg[7] = 1;
        msg.extend_from_slice(&[0xC0, 0x0C, (qtype >> 8) as u8, qtype as u8, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 1]);
        for (at, byte) in &flips {
            let i = at % msg.len();
            msg[i] = *byte;
        }
        let msg = &msg[..cut % (msg.len() + 1)];
        let _ = dnsquery::parse_reply(msg, qtype);
    }

    #[test]
    fn no_tool_output_reader_panics(stdout in "(?s).{0,800}", stderr in "(?s).{0,200}", code in prop::option::of(any::<i32>())) {
        let _ = icmp::parse_ping_output(&stdout, &stderr, code);
        let _ = traceroute::parse_traceroute_output(&stdout);
        let _ = neighbour::parse_table(&stdout);
        let _ = sweep::parse_cidr(&stdout);
        let _ = validate::parse_target(&stdout);
        let _ = udp::payload_bytes(Some(&stdout));
    }

    /// A subnet read back is the subnet: its network is inside it, its
    /// broadcast is inside it, and naming it again gives the same subnet.
    #[test]
    fn a_subnet_is_what_it_says(a in any::<u8>(), b in any::<u8>(), c in any::<u8>(), d in any::<u8>(), prefix in 0u8..=40) {
        let text = format!("{a}.{b}.{c}.{d}/{prefix}");
        if let Ok(cidr) = sweep::parse_cidr(&text) {
            prop_assert!(prefix <= 32);
            prop_assert!(cidr.contains(cidr.network()) && cidr.contains(cidr.broadcast()));
            prop_assert!(cidr.contains(Ipv4Addr::new(a, b, c, d)));
            let again = sweep::parse_cidr(&format!("{}/{}", cidr.network(), cidr.prefix())).expect("its own name reads");
            prop_assert_eq!(again, cidr);
            prop_assert!(u64::from(cidr.host_count()) <= 1u64 << (32 - u32::from(cidr.prefix())));
        } else {
            prop_assert!(prefix > 32 || sweep::parse_cidr(&text).is_err());
        }
    }

    /// Whatever a target is typed as, what is aimed at has no spaces in it.
    #[test]
    fn a_target_that_is_accepted_is_one_word(raw in "(?s).{0,80}") {
        if let Ok(t) = validate::parse_target(&raw) {
            let s = t.as_str();
            prop_assert!(!s.is_empty() && !s.chars().any(char::is_whitespace), "{s:?}");
        }
    }

    /// Bytes written as hex are read back as the same bytes.
    #[test]
    fn hex_payloads_read_back(bytes in prop::collection::vec(any::<u8>(), 0..64)) {
        let hex: String = bytes.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" ");
        if bytes.is_empty() {
            prop_assert_eq!(udp::payload_bytes(Some(&hex)).unwrap(), Vec::<u8>::new());
        } else {
            prop_assert_eq!(udp::payload_bytes(Some(&hex)).unwrap(), bytes);
        }
    }

    /// A neighbour table never yields a MAC for an address it did not list.
    #[test]
    fn a_neighbour_table_only_names_what_it_lists(rows in prop::collection::vec((any::<[u8; 4]>(), any::<[u8; 6]>()), 0..12)) {
        let text: String = rows.iter().map(|(ip, mac)| {
            let mac = mac.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":");
            format!("{} 0x1 0x2 {mac} * eth0\n", Ipv4Addr::from(*ip))
        }).collect();
        let listed: Vec<Ipv4Addr> = rows.iter().map(|(ip, _)| Ipv4Addr::from(*ip)).collect();
        for ip in neighbour::parse_table(&text).keys() {
            prop_assert!(listed.contains(ip));
        }
    }
}
