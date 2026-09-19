//! Which way is out (LT-131).
//!
//! The operator asked for traffic direction on the diagram and suggested CEF
//! or the forwarding table, with "if its too much and laggy then we can skip
//! it". A full forwarding table *is* too much: it is large, slow to pull, and
//! almost every line of it is irrelevant to a picture of the network.
//!
//! The question a diagram actually asks is narrower — *which neighbour does
//! this device send unknown traffic to* — and that is one line: the default
//! route. Resolve that next hop to a device the crawl already reached and
//! every link between them has a direction; chain those and the result is the
//! path an operator draws by hand, host to access to distribution to core to
//! firewall to the ISP.
//!
//! **Written against captured output**, per the standing rule in `CLAUDE.md`
//! and unlike the stacking parsers (D-026). Both Cisco forms below came from
//! `LAB-CORE-SW1`, a WS-C2960CX running 15.2(7)E, on 2026-09-12.

use std::net::Ipv4Addr;

/// The commands worth asking, cheapest first.
///
/// `show ip route 0.0.0.0` is the precise question and is answered even when
/// the routing table is enormous. The piped form is the fallback for
/// platforms that will not take an address argument.
pub fn commands_for(platform_hint: &str) -> &'static [&'static str] {
    let p = platform_hint.to_ascii_lowercase();
    if p.contains("forti") {
        &["get router info routing-table details 0.0.0.0", "get router info routing-table all"]
    } else if p.contains("aruba") || p.contains("aos-cx") {
        &["show ip route 0.0.0.0/0", "show ip route"]
    } else if p.contains("junos") || p.contains("juniper") {
        &["show route 0.0.0.0/0"]
    } else {
        &["show ip route 0.0.0.0", "show ip route | include 0.0.0.0"]
    }
}

/// The next hop a device sends unknown traffic to, if it has one.
///
/// Reads every shape seen so far and takes the first address that is a
/// plausible next hop. Deliberately forgiving about the surrounding words,
/// because the words differ per platform and the address does not.
///
/// **What it must not do** is return the *destination*. Every one of these
/// outputs contains `0.0.0.0` as the thing being routed, and a parser that
/// grabbed the first address on the line would report that a switch sends its
/// traffic to 0.0.0.0 — which would point every arrow on the diagram at
/// nothing. That is why `0.0.0.0` and its mask are excluded explicitly.
pub fn parse_default_route(output: &str) -> Option<Ipv4Addr> {
    for line in output.lines() {
        let l = line.trim();
        let low = l.to_ascii_lowercase();

        // IOS: "Gateway of last resort is 192.168.77.1 to network 0.0.0.0"
        if let Some(rest) = low.strip_prefix("gateway of last resort is ") {
            if rest.starts_with("not set") {
                continue;
            }
            if let Some(ip) = first_usable_address(rest) {
                return Some(ip);
            }
        }

        // IOS: "S*    0.0.0.0/0 [1/0] via 192.168.77.1"
        // FortiOS: "S*   0.0.0.0/0 [10/0] via 192.168.77.1, wan1"
        // AOS-CX and others word it the same way.
        if let Some(at) = low.find(" via ") {
            if let Some(ip) = first_usable_address(&l[at + 5..]) {
                return Some(ip);
            }
        }

        // IOS: the descriptor block under `show ip route 0.0.0.0`, where the
        // chosen path is starred:
        //   Routing Descriptor Blocks:
        //   * 192.168.77.1
        if let Some(rest) = l.strip_prefix('*') {
            if let Some(ip) = first_usable_address(rest) {
                return Some(ip);
            }
        }
    }
    None
}

/// The first address in a fragment that could be a next hop.
///
/// Excludes the unspecified address — which appears in every one of these
/// outputs as the *destination* — and anything that is not a host address.
fn first_usable_address(text: &str) -> Option<Ipv4Addr> {
    for token in text.split(|c: char| c.is_whitespace() || c == ',' || c == '[' || c == ']') {
        let cleaned = token.trim_matches(|c: char| !c.is_ascii_digit() && c != '.');
        // A prefix like 0.0.0.0/0 is a destination, never a next hop.
        if cleaned.contains('/') {
            continue;
        }
        let Ok(ip) = cleaned.parse::<Ipv4Addr>() else { continue };
        if ip.is_unspecified() || ip.is_broadcast() || ip.is_multicast() || ip.is_loopback() {
            continue;
        }
        return Some(ip);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from LAB-CORE-SW1 (WS-C2960CX, IOS 15.2(7)E) on 2026-09-12,
    /// byte for byte as `show ip route 0.0.0.0` printed it.
    #[test]
    fn reads_the_descriptor_block_form() {
        let real = "\
Routing entry for 0.0.0.0/0, supernet
  Known via \"static\", distance 1, metric 0, candidate default path
  Routing Descriptor Blocks:
  * 192.168.77.1
      Route metric is 0, traffic share count is 1
";
        assert_eq!(parse_default_route(real), Some(Ipv4Addr::new(192, 168, 77, 1)));
    }

    /// Also captured from the same switch, same day: the piped form.
    #[test]
    fn reads_the_gateway_of_last_resort_form() {
        let real = "\
Gateway of last resort is 192.168.77.1 to network 0.0.0.0
S*    0.0.0.0/0 [1/0] via 192.168.77.1
";
        assert_eq!(parse_default_route(real), Some(Ipv4Addr::new(192, 168, 77, 1)));
    }

    /// The failure that would point every arrow at nothing: `0.0.0.0` is on
    /// every one of these lines as the destination.
    #[test]
    fn never_reports_the_destination_as_the_next_hop() {
        for text in [
            "Gateway of last resort is 192.168.77.1 to network 0.0.0.0",
            "S*    0.0.0.0/0 [1/0] via 192.168.77.1",
            "Routing entry for 0.0.0.0/0, supernet",
        ] {
            let got = parse_default_route(text);
            assert_ne!(got, Some(Ipv4Addr::UNSPECIFIED), "took the destination from {text:?}");
        }
        // The bare destination line alone yields nothing, rather than 0.0.0.0.
        assert_eq!(parse_default_route("Routing entry for 0.0.0.0/0, supernet"), None);
    }

    /// A device with no way out says so, and must not be given one.
    #[test]
    fn no_default_route_is_no_next_hop() {
        assert_eq!(parse_default_route("Gateway of last resort is not set"), None);
        assert_eq!(parse_default_route(""), None);
        assert_eq!(parse_default_route("% Invalid input detected at '^' marker."), None);
        assert_eq!(parse_default_route("Codes: L - local, C - connected, S - static"), None);
    }

    /// The FortiOS and AOS-CX wording of the same line. Shaped, not captured —
    /// there are no credentials for the FortiGate in this session, so this is
    /// the `via` branch being exercised rather than a claim about FortiOS.
    #[test]
    fn reads_a_via_line_with_an_interface_after_it() {
        let text = "S*      0.0.0.0/0 [10/0] via 192.168.77.1, wan1\n";
        assert_eq!(parse_default_route(text), Some(Ipv4Addr::new(192, 168, 77, 1)));
    }

    /// Loopback and multicast are not somewhere traffic leaves by.
    #[test]
    fn ignores_addresses_that_cannot_be_a_next_hop() {
        assert_eq!(parse_default_route("S*  0.0.0.0/0 [1/0] via 127.0.0.1"), None);
        assert_eq!(parse_default_route("S*  0.0.0.0/0 [1/0] via 224.0.0.5"), None);
    }

    #[test]
    fn asks_each_platform_in_its_own_words() {
        assert!(commands_for("WS-C2960CX").contains(&"show ip route 0.0.0.0"));
        assert!(commands_for("FortiGate 60F").iter().any(|c| c.contains("get router info")));
        assert!(commands_for("Junos ex4300").contains(&"show route 0.0.0.0/0"));
        assert!(commands_for("Aruba AOS-CX").contains(&"show ip route 0.0.0.0/0"));
    }
}
