//! Interface names, one spelling per port (the spec's "interface
//! normalization lib with tests"). A switch writes `Gi1/0/1` in one table and
//! `GigabitEthernet1/0/1` in the next, and its neighbour writes either; NX-OS
//! says `Eth1/1`, EOS `Et1`, Junos `ge-0/0/0.0` for the logical unit of
//! `ge-0/0/0`. Two names are the same port when their [`key`]s are equal.
//! LLDP's port id may be a name, a MAC or an ifIndex; [`PortId`] says which.

/// Cisco-style abbreviations → the long form, longest prefix first.
const LONG: &[(&str, &str)] = &[
    ("hundredgigabitethernet", "HundredGigE"),
    ("hundredgige", "HundredGigE"),
    ("fourhundredgige", "FourHundredGigE"),
    ("fortygigabitethernet", "FortyGigabitEthernet"),
    ("twentyfivegige", "TwentyFiveGigE"),
    ("twentyfivegigabitethernet", "TwentyFiveGigE"),
    ("tengigabitethernet", "TenGigabitEthernet"),
    ("twogigabitethernet", "TwoGigabitEthernet"),
    ("fivegigabitethernet", "FiveGigabitEthernet"),
    ("gigabitethernet", "GigabitEthernet"),
    ("fastethernet", "FastEthernet"),
    ("ethernet", "Ethernet"),
    ("port-channel", "Port-channel"),
    ("portchannel", "Port-channel"),
    ("bundle-ether", "Bundle-Ether"),
    ("management", "Management"),
    ("loopback", "Loopback"),
    ("tunnel", "Tunnel"),
    ("vlan", "Vlan"),
    ("mgmt", "mgmt"),
    ("hu", "HundredGigE"),
    ("fo", "FortyGigabitEthernet"),
    ("twe", "TwentyFiveGigE"),
    ("tw", "TwoGigabitEthernet"),
    ("te", "TenGigabitEthernet"),
    ("gi", "GigabitEthernet"),
    ("ge", "GigabitEthernet"),
    ("fa", "FastEthernet"),
    ("eth", "Ethernet"),
    ("et", "Ethernet"),
    ("po", "Port-channel"),
    ("be", "Bundle-Ether"),
    ("lo", "Loopback"),
    ("tu", "Tunnel"),
    ("vl", "Vlan"),
    ("ma", "Management"),
];

/// Junos, FortiOS, PAN-OS, AOS-CX, AOS-S and Linux names are already their
/// own long form: a prefix and a number, left alone.
fn is_native(lower: &str) -> bool {
    const NATIVE: &[&str] = &[
        "ge-", "xe-", "et-", "fe-", "ae", "irb", "em", "fxp", "me", "vme", "port", "x", "wan", "lan", "internal", "dmz", "ethernet1/", "ethernet2/",
        "swp", "bond", "br", "eno", "enp", "ens", "wlan", "lag", "trk",
    ];
    // `ge-0/0/0` is Junos, but `ge0/0` is not — Junos always has the dash.
    NATIVE.iter().any(|p| lower.starts_with(p) && (p.ends_with('-') || p.ends_with('/') || lower[p.len()..].chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)))
        || lower.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
        || (lower.len() <= 4 && lower.starts_with(|c: char| c.is_ascii_alphabetic()) && lower[1..].chars().all(|c| c.is_ascii_digit()) && lower.len() > 1)
}

/// The long form a vendor writes in its configuration.
pub fn canonical(name: &str) -> String {
    let t = name.trim();
    if t.is_empty() {
        return String::new();
    }
    let lower = t.to_ascii_lowercase();
    // PAN-OS `ethernet1/1` and NX-OS `Ethernet1/1` are the same shape and the
    // same form; only the case differs.
    if is_native(&lower) && !lower.starts_with("ethernet") {
        return t.to_string();
    }
    for (short, long) in LONG {
        if let Some(rest) = lower.strip_prefix(short) {
            let rest_orig = &t[short.len()..];
            if rest.is_empty() || rest.starts_with(|c: char| c.is_ascii_digit() || c == ' ' || c == '/' || c == '.') {
                return format!("{long}{}", rest_orig.trim_start());
            }
        }
    }
    t.to_string()
}

/// Equal for two spellings of one port. Junos's `.0` unit folds onto the
/// physical port, because LLDP speaks of the port and the ARP table of the
/// unit.
pub fn key(name: &str) -> String {
    let c = canonical(name).to_ascii_lowercase().replace(' ', "");
    if c.starts_with(['g', 'x', 'e', 'f']) && c.contains('-') && c.ends_with(".0") {
        c[..c.len() - 2].to_string()
    } else {
        c
    }
}

/// What an LLDP port id turned out to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortId {
    Name(String),
    Mac(String),
    IfIndex(u32),
    Empty,
}

pub fn port_id(raw: &str) -> PortId {
    let t = raw.trim();
    if t.is_empty() {
        return PortId::Empty;
    }
    if let Some(m) = mac(t) {
        return PortId::Mac(m);
    }
    if t.len() <= 6 && t.chars().all(|c| c.is_ascii_digit()) {
        // A bare number is an ifIndex — except where it is the port itself,
        // which AOS-S and FortiSwitch do (`24`, `1`); the caller tries both.
        return PortId::IfIndex(t.parse().unwrap_or(0));
    }
    PortId::Name(t.to_string())
}

/// A MAC in any of the usual spellings, as twelve lower-case hex digits.
pub fn mac(raw: &str) -> Option<String> {
    let hex: String = raw.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let seps = raw.chars().filter(|c| matches!(c, ':' | '-' | '.' | ' ')).count();
    let only_mac_chars = raw.trim().chars().all(|c| c.is_ascii_hexdigit() || matches!(c, ':' | '-' | '.' | ' '));
    if hex.len() == 12 && only_mac_chars && (seps > 0 || raw.trim().len() == 12) {
        let hex = hex.to_ascii_lowercase();
        // An unslaved bond or a GRE tap reports all zeros; neither
        // it nor broadcast identifies a box.
        if hex == "000000000000" || hex == "ffffffffffff" {
            return None;
        }
        Some(hex)
    } else {
        None
    }
}

/// The short form for a label: `GigabitEthernet1/0/1` → `Gi1/0/1`.
pub fn short(name: &str) -> String {
    let c = canonical(name);
    const SHORT: &[(&str, &str)] = &[
        ("HundredGigE", "Hu"),
        ("FortyGigabitEthernet", "Fo"),
        ("TwentyFiveGigE", "Twe"),
        ("TwoGigabitEthernet", "Tw"),
        ("TenGigabitEthernet", "Te"),
        ("GigabitEthernet", "Gi"),
        ("FastEthernet", "Fa"),
        ("Port-channel", "Po"),
        ("Bundle-Ether", "BE"),
        ("Ethernet", "Eth"),
        ("Loopback", "Lo"),
        ("Tunnel", "Tu"),
    ];
    for (long, s) in SHORT {
        if let Some(rest) = c.strip_prefix(long) {
            return format!("{s}{rest}");
        }
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pair_the_spec_names_is_the_same_port_both_ways() {
        for (a, b) in [
            ("Gi1/0/1", "GigabitEthernet1/0/1"),
            ("gi1/0/1", "GigabitEthernet1/0/1"),
            ("Te1/1/1", "TenGigabitEthernet1/1/1"),
            ("Fa0/1", "FastEthernet0/1"),
            ("Po1", "Port-channel1"),
            ("Eth1/1", "Ethernet1/1"),
            ("Et1", "Ethernet1"),
            ("Twe1/0/1", "TwentyFiveGigE1/0/1"),
            ("Hu1/0/49", "HundredGigE1/0/49"),
            ("Vl10", "Vlan10"),
            ("Lo0", "Loopback0"),
            ("ge-0/0/0", "ge-0/0/0.0"),
            ("ethernet1/1", "ethernet1/1"),
            ("port1", "port1"),
            ("x1", "x1"),
            ("1/1/1", "1/1/1"),
            ("A1", "A1"),
            ("swp1", "swp1"),
        ] {
            assert_eq!(key(a), key(b), "{a} vs {b}");
            assert_eq!(key(b), key(a), "{b} vs {a}");
        }
    }

    #[test]
    fn different_ports_stay_different() {
        assert_ne!(key("Gi1/0/1"), key("Gi1/0/10"));
        assert_ne!(key("Gi1/0/1"), key("Te1/0/1"));
        assert_ne!(key("Eth1/1"), key("Eth1/10"));
        assert_ne!(key("ge-0/0/0"), key("xe-0/0/0"));
        assert_ne!(key("port1"), key("port10"));
        assert_ne!(key("ge-0/0/0.0"), key("ge-0/0/0.100"));
    }

    #[test]
    fn a_port_id_is_a_name_a_mac_or_an_ifindex() {
        assert_eq!(port_id("Gi1/0/1"), PortId::Name("Gi1/0/1".into()));
        assert_eq!(port_id("0000.0000.0001"), PortId::Mac("000000000001".into()));
        assert_eq!(port_id("00:00:00:00:00:01"), PortId::Mac("000000000001".into()));
        assert_eq!(port_id("00-00-00-00-00-01"), PortId::Mac("000000000001".into()));
        assert_eq!(port_id("523"), PortId::IfIndex(523));
        assert_eq!(port_id(" "), PortId::Empty);
        // A name that happens to be hex-ish is not a MAC.
        assert_eq!(port_id("Eth1/1"), PortId::Name("Eth1/1".into()));
        assert_eq!(mac("deadbeef"), None);
    }

    #[test]
    fn labels_shorten() {
        assert_eq!(short("GigabitEthernet1/0/1"), "Gi1/0/1");
        assert_eq!(short("Gi1/0/1"), "Gi1/0/1");
        assert_eq!(short("Ethernet1/1"), "Eth1/1");
        assert_eq!(short("ge-0/0/0"), "ge-0/0/0");
    }
}
