//! A vendor is one place to look (LT-451).
//!
//! Which command reads a routing table, a stack, a default route, a VRF
//! listing or an overlay used to be decided in as many places as there are
//! tables — `routes::commands_for`, `stacking::commands_for`,
//! `defaultroute::commands_for`, `vrftables::dialect_for`,
//! `overlay::dialect_for` — each with its own reading of the version banner.
//! LT-391 is what that costs: Cisco syntax sent to an ArubaOS-Switch because
//! one of them had no arm for it. This is the one place: the banner is read
//! once into a [`Dialect`], and the crawler asks it for every command.
//!
//! **Additive, not a rewrite.** Each dialect delegates to the parsers and
//! command lists that already exist and are already tested against captured
//! output, so no fixture changes and no parser moves. What changes is that
//! adding a vendor is one `impl` here, and that `verified_against_hardware`
//! is asked of the dialect rather than of each parser separately — a test
//! below lists every dialect that has not met a device (D-026, D-051).
//!
//! **The identity half (LT-461).** The neighbour tables, the ARP and MAC
//! tables and the port channels are asked the same way: a [`Reading`] is a
//! command and the parser that reads its answer, a dialect lists them in
//! the order to try, and `crawl::visit` keeps the first that yields
//! anything. The lists are exactly the sequences the crawler used to work
//! out inline — Cisco first, the ArubaOS-Switch spelling when that answered
//! nothing, Dell's after that — so nothing a device is asked has changed;
//! what changed is that the sequence is written down per platform and
//! checked by the equivalence test below. Trimming a sequence for a
//! platform that is known — not asking a Dell the Aruba question — is a
//! later change, and one that wants a device to try it on (D-026).
//!
//! **Two predicates, kept as they were.** The Dell readings key on
//! `dell::detect` and the ArubaOS-Switch ones on `arubasw::is_arubaos_switch`,
//! the two tests the crawler already applied, rather than on [`family_of`].
//! They agree on every banner captured so far; they are kept separate
//! because a Force10 banner that never says "Dell" is a Dell to `detect` and
//! nothing in particular to `family_of`, and folding the two would change
//! which route commands that switch is sent. That is the seam left.
//!
//! **What is still in the crawler.** The FortiOS branch — `get system …`,
//! the switch-controller tables — and ArubaOS-Switch's own `show ip` and
//! `show system` are asked in `crawl::visit` by platform, as before.

use crate::dell::DellOs;
use crate::etherchannel::PortChannel;
use crate::mac_table::MacEntry;
use crate::overlay::OverlayDialect;
use crate::types::Neighbor;
use crate::vrftables::VrfDialect;

/// One way of asking a table: the command, and the parser that reads what
/// comes back. A dialect lists them in the order to try.
pub struct Reading<T: 'static> {
    pub command: &'static str,
    pub parse: fn(&str) -> Vec<T>,
}

/// The families the crawler tells apart from a version banner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Family {
    CiscoIos,
    CiscoNxOs,
    AristaEos,
    Junos,
    FortiOs,
    ArubaOsSwitch,
    ArubaOsCx,
    Dell,
    /// Nothing recognised: the Cisco commands are tried, because they are the
    /// ones most other vendors imitate, and a refusal is reported as one.
    Generic,
}

/// Everything the crawler needs to ask a platform, in one place.
pub trait Dialect: Send + Sync {
    fn family(&self) -> Family;
    /// A short name for a log line and the roadmap.
    fn name(&self) -> &'static str;
    /// The commands that read the routing tables, IPv4 then IPv6.
    fn route_commands(&self) -> &'static [&'static str];
    /// The commands that read a stack or virtual chassis.
    fn stack_commands(&self) -> &'static [&'static str];
    /// The commands that read the default route.
    fn default_route_commands(&self) -> &'static [&'static str];
    /// How per-VRF tables are listed and read.
    fn vrf(&self) -> VrfDialect;
    /// How VXLAN/EVPN is read.
    fn overlay(&self) -> OverlayDialect;
    /// The ways of reading the CDP neighbours, tried until one yields any.
    fn cdp_readings(&self) -> &'static [Reading<Neighbor>];
    /// The ways of reading the LLDP neighbours, the same way.
    fn lldp_readings(&self) -> &'static [Reading<Neighbor>];
    /// The commands that read the ARP table, tried until one yields any;
    /// one parser reads every spelling of it.
    fn arp_commands(&self) -> &'static [&'static str];
    /// The ways of reading the MAC address table.
    fn mac_table_readings(&self) -> &'static [Reading<MacEntry>];
    /// The ways of reading the port channels.
    fn port_channel_readings(&self) -> &'static [Reading<PortChannel>];
    /// Whether every part of this dialect has met a device of its family.
    /// A dialect built from documentation says so until it has (D-026).
    fn verified_against_hardware(&self) -> bool;
}

// The sequences, as the crawler asked them before LT-461, one static per
// distinct sequence so a dialect hands back a slice and nothing allocates.
static CDP: &[Reading<Neighbor>] = &[
    Reading { command: "show cdp neighbors detail", parse: crate::cdp::parse_cdp_detail },
    // LT-391: ArubaOS-Switch answers the Cisco form with a table the Cisco
    // parser reads as nothing; asked only then, so a Cisco with no
    // neighbours pays one rejected command and a working estate nothing.
    Reading { command: "show cdp neighbors", parse: crate::arubasw::parse_cdp_neighbors },
];
static LLDP: &[Reading<Neighbor>] = &[
    Reading { command: "show lldp neighbors detail", parse: crate::lldp::parse_lldp_detail },
    Reading { command: "show lldp info remote-device", parse: crate::arubasw::parse_lldp_remote_devices },
];
// LT-407: OS10 answers `show lldp neighbors` with a four-column table.
static LLDP_DELL: &[Reading<Neighbor>] = &[
    Reading { command: "show lldp neighbors detail", parse: crate::lldp::parse_lldp_detail },
    Reading { command: "show lldp info remote-device", parse: crate::arubasw::parse_lldp_remote_devices },
    Reading { command: "show lldp neighbors", parse: crate::dell::parse_lldp_neighbors },
];
// LT-391: ArubaOS-Switch spells it `show arp`. By result rather than by
// platform on purpose: a device that answered the first with nothing has
// cost one more command, and a platform string that is wrong costs nothing.
static ARP: &[&str] = &["show ip arp", "show arp"];
static MAC: &[Reading<MacEntry>] = &[
    Reading { command: "show mac address-table", parse: crate::mac_table::parse_mac_table },
    Reading { command: "show mac-address", parse: crate::arubasw::parse_mac_address_table },
];
// LT-407: OS9 spells the table with hyphens; OS10 and the N-series spell it
// as Cisco does but write their ports as `ethernet1/1/6`, so the same
// command is read again by Dell's parser.
static MAC_DELL_OS9: &[Reading<MacEntry>] = &[
    Reading { command: "show mac address-table", parse: crate::mac_table::parse_mac_table },
    Reading { command: "show mac-address", parse: crate::arubasw::parse_mac_address_table },
    Reading { command: "show mac-address-table", parse: crate::dell::parse_mac_address_table },
];
static MAC_DELL: &[Reading<MacEntry>] = &[
    Reading { command: "show mac address-table", parse: crate::mac_table::parse_mac_table },
    Reading { command: "show mac-address", parse: crate::arubasw::parse_mac_address_table },
    Reading { command: "show mac address-table", parse: crate::dell::parse_mac_address_table },
];
// LT-009: FortiOS rejects the command harmlessly and the parser reads an
// empty answer as no bundles.
static PORT_CHANNELS: &[Reading<PortChannel>] =
    &[Reading { command: "show etherchannel summary", parse: crate::etherchannel::parse_etherchannel_summary }];
// LT-395: by platform rather than by result, because a Cisco with no
// bundles is common and should not pay a rejected command for it.
static PORT_CHANNELS_ARUBA: &[Reading<PortChannel>] = &[
    Reading { command: "show etherchannel summary", parse: crate::etherchannel::parse_etherchannel_summary },
    Reading { command: "show trunks", parse: crate::arubasw::parse_trunks },
];
static PORT_CHANNELS_DELL: &[Reading<PortChannel>] = &[
    Reading { command: "show etherchannel summary", parse: crate::etherchannel::parse_etherchannel_summary },
    Reading { command: "show port-channel summary", parse: crate::dell::parse_port_channel_summary },
];

/// One implementation per family, all delegating to what exists. The hint
/// each one hands the command lists is the word those lists already key on.
struct Known {
    family: Family,
    name: &'static str,
    hint: &'static str,
    verified: bool,
}

/// A dialect as read off one banner: the family's command lists, and the
/// two identity predicates the crawler applied to that banner.
struct Chosen {
    known: &'static Known,
    dell: Option<DellOs>,
    aruba_switch: bool,
}

impl Dialect for Chosen {
    fn family(&self) -> Family {
        self.known.family
    }
    fn name(&self) -> &'static str {
        self.known.name
    }
    fn route_commands(&self) -> &'static [&'static str] {
        crate::routes::commands_for(self.known.hint)
    }
    fn stack_commands(&self) -> &'static [&'static str] {
        crate::stacking::commands_for(self.known.hint)
    }
    fn default_route_commands(&self) -> &'static [&'static str] {
        crate::defaultroute::commands_for(self.known.hint)
    }
    fn vrf(&self) -> VrfDialect {
        crate::vrftables::dialect_for(self.known.hint)
    }
    fn overlay(&self) -> OverlayDialect {
        crate::overlay::dialect_for(self.known.hint)
    }
    fn cdp_readings(&self) -> &'static [Reading<Neighbor>] {
        CDP
    }
    fn lldp_readings(&self) -> &'static [Reading<Neighbor>] {
        if self.dell.is_some() {
            LLDP_DELL
        } else {
            LLDP
        }
    }
    fn arp_commands(&self) -> &'static [&'static str] {
        ARP
    }
    fn mac_table_readings(&self) -> &'static [Reading<MacEntry>] {
        match self.dell {
            Some(DellOs::Os9) => MAC_DELL_OS9,
            Some(_) => MAC_DELL,
            None => MAC,
        }
    }
    fn port_channel_readings(&self) -> &'static [Reading<PortChannel>] {
        if self.aruba_switch {
            PORT_CHANNELS_ARUBA
        } else if self.dell.is_some() {
            PORT_CHANNELS_DELL
        } else {
            PORT_CHANNELS
        }
    }
    fn verified_against_hardware(&self) -> bool {
        self.known.verified
    }
}

/// Verified means every parser this dialect routes to has met a device of
/// this family and the roadmap names it. IOS (LT-010's C2960CX, the IOL
/// lab), NX-OS (LT-350's fabric) and FortiOS (the bench FortiGate and
/// FortiSwitch) have; the rest were built from guides (D-026, D-051, LT-407)
/// and say so.
static DIALECTS: &[Known] = &[
    Known { family: Family::CiscoNxOs, name: "Cisco NX-OS", hint: "nx-os", verified: true },
    Known { family: Family::CiscoIos, name: "Cisco IOS / IOS-XE", hint: "cisco ios", verified: true },
    Known { family: Family::AristaEos, name: "Arista EOS", hint: "arista", verified: false },
    Known { family: Family::Junos, name: "Junos", hint: "junos", verified: false },
    Known { family: Family::FortiOs, name: "FortiOS", hint: "fortios", verified: true },
    Known { family: Family::ArubaOsSwitch, name: "ArubaOS-Switch", hint: "arubaos-switch", verified: true },
    Known { family: Family::ArubaOsCx, name: "ArubaOS-CX", hint: "arubaos-cx", verified: false },
    Known { family: Family::Dell, name: "Dell OS10 / OS9 / OS6", hint: "dell", verified: false },
    Known { family: Family::Generic, name: "unrecognised (Cisco commands tried)", hint: "", verified: true },
];

/// Reads the family off a version banner, the way the parsers already do
/// between them, in one place.
pub fn family_of(version: &str) -> Family {
    let v = version.to_ascii_lowercase();
    if v.contains("nx-os") || v.contains("nexus") {
        Family::CiscoNxOs
    } else if v.contains("arista") || v.contains("veos") {
        Family::AristaEos
    } else if v.contains("junos") || v.contains("juniper") {
        Family::Junos
    } else if crate::fortios::rejected_command(version) || v.contains("fortios") || v.contains("fortigate") || v.contains("fortiswitch") {
        Family::FortiOs
    } else if crate::arubasw::is_arubaos_switch(version) {
        Family::ArubaOsSwitch
    } else if v.contains("arubaos-cx") || v.contains("aruba cx") || v.contains("aos-cx") {
        Family::ArubaOsCx
    } else if v.contains("dell") || v.contains("os10") || v.contains("powerswitch") {
        Family::Dell
    } else if v.contains("cisco") || v.contains("ios") {
        Family::CiscoIos
    } else {
        Family::Generic
    }
}

/// The dialect for a version banner.
pub fn dialect_for(version: &str) -> Box<dyn Dialect> {
    let family = family_of(version);
    let known = DIALECTS.iter().find(|d| d.family == family).unwrap_or(&DIALECTS[DIALECTS.len() - 1]);
    Box::new(Chosen {
        known,
        dell: crate::dell::detect(version),
        aruba_switch: crate::arubasw::is_arubaos_switch(version),
    })
}

/// Every dialect, for a listing.
pub fn all() -> impl Iterator<Item = Box<dyn Dialect>> {
    DIALECTS.iter().map(|known| {
        Box::new(Chosen {
            known,
            dell: (known.family == Family::Dell).then_some(DellOs::Os10),
            aruba_switch: known.family == Family::ArubaOsSwitch,
        }) as Box<dyn Dialect>
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_banner_picks_one_family_and_the_generic_one_catches_the_rest() {
        assert_eq!(family_of("Cisco Nexus Operating System (NX-OS) Software"), Family::CiscoNxOs);
        assert_eq!(family_of("Cisco IOS Software, C2960X Software"), Family::CiscoIos);
        assert_eq!(family_of("Arista vEOS"), Family::AristaEos);
        assert_eq!(family_of("JUNOS 21.4R3"), Family::Junos);
        assert_eq!(family_of("Something nobody has met"), Family::Generic);
        assert_eq!(dialect_for("JUNOS 21.4R3").name(), "Junos");
        assert_eq!(dialect_for("???").name(), "unrecognised (Cisco commands tried)");
    }

    /// The whole point: for a real banner, what the dialect hands back is
    /// exactly what the crawler used to work out from that banner, table by
    /// table, so nothing a device answers changes. FortiOS reads no routes
    /// on purpose (D-050) and the assertion is equality, not non-emptiness.
    #[test]
    fn a_banner_answers_the_same_commands_it_always_did() {
        let banners = [
            "Cisco Nexus Operating System (NX-OS) Software, nxos.9.3.3.bin",
            "Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E4",
            "Cisco IOS XE Software, Version 16.12.05",
            "Arista vEOS, Software image version: 4.28.0F",
            "JUNOS 21.4R3-S1.5",
            "Version: FortiGate-60F v7.6.7,build3510,250101 (GA)",
            "Dell EMC Networking OS10 Enterprise, Version 10.5.4",
            "Something nobody has met",
        ];
        for banner in banners {
            let d = dialect_for(banner);
            assert_eq!(d.route_commands(), crate::routes::commands_for(banner), "routes for {banner}");
            assert_eq!(d.stack_commands(), crate::stacking::commands_for(banner), "stack for {banner}");
            assert_eq!(d.default_route_commands(), crate::defaultroute::commands_for(banner), "default route for {banner}");
            assert_eq!(d.vrf(), crate::vrftables::dialect_for(banner), "vrf for {banner}");
            assert_eq!(d.overlay(), crate::overlay::dialect_for(banner), "overlay for {banner}");
        }
    }

    fn commands<T>(readings: &[Reading<T>]) -> Vec<&'static str> {
        readings.iter().map(|r| r.command).collect()
    }

    /// LT-461, the same bar for the identity half: for every banner, the
    /// sequence the dialect hands back is the one `crawl::visit` used to
    /// build inline from `dell::detect` and `arubasw::is_arubaos_switch`,
    /// and each command is read by the parser that always read it.
    #[test]
    fn a_banner_is_asked_for_its_tables_the_way_it_always_was() {
        let banners = [
            "Cisco Nexus Operating System (NX-OS) Software, nxos.9.3.3.bin",
            "Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E4",
            "Arista vEOS, Software image version: 4.28.0F",
            "JUNOS 21.4R3-S1.5",
            "Version: FortiGate-60F v7.6.7,build3510,250101 (GA)",
            "Image stamp: /ws/swbuildm/rel_x/code/build/ Boot ROM Version: WC.16.01.0006",
            "Dell EMC Networking OS10 Enterprise, Version 10.5.4",
            "Dell EMC Networking OS9, Real Time Operating System Software",
            "Force10 Networks Real Time Operating System Software",
            "Dell EMC Networking N3048EP-ON",
            "Something nobody has met",
        ];
        for banner in banners {
            let d = dialect_for(banner);
            let dell = crate::dell::detect(banner);
            let aruba = crate::arubasw::is_arubaos_switch(banner);
            assert_eq!(commands(d.cdp_readings()), ["show cdp neighbors detail", "show cdp neighbors"], "cdp for {banner}");
            let mut lldp = vec!["show lldp neighbors detail", "show lldp info remote-device"];
            if dell.is_some() {
                lldp.push("show lldp neighbors");
            }
            assert_eq!(commands(d.lldp_readings()), lldp, "lldp for {banner}");
            assert_eq!(d.arp_commands(), ["show ip arp", "show arp"], "arp for {banner}");
            let mut mac = vec!["show mac address-table", "show mac-address"];
            match dell {
                Some(DellOs::Os9) => mac.push("show mac-address-table"),
                Some(_) => mac.push("show mac address-table"),
                None => {}
            }
            assert_eq!(commands(d.mac_table_readings()), mac, "mac table for {banner}");
            let mut bundles = vec!["show etherchannel summary"];
            if aruba {
                bundles.push("show trunks");
            } else if dell.is_some() {
                bundles.push("show port-channel summary");
            }
            assert_eq!(commands(d.port_channel_readings()), bundles, "port channels for {banner}");
        }
        // The predicates are exercised, not just agreed with.
        assert!(crate::arubasw::is_arubaos_switch(banners[5]));
        assert_eq!(crate::dell::detect(banners[7]), Some(DellOs::Os9));
        assert_eq!(crate::dell::detect(banners[8]), Some(DellOs::Os9));
        assert_eq!(crate::dell::detect(banners[9]), Some(DellOs::NSeries));
        assert_eq!(family_of(banners[8]), Family::Generic, "the seam the module doc names");
    }

    /// Each command is read by the parser that read it before: the Cisco
    /// spelling by the Cisco parser, the Aruba by Aruba's, Dell's by Dell's.
    #[test]
    fn each_reading_keeps_its_parser() {
        let d = dialect_for("Dell EMC Networking OS10 Enterprise, Version 10.5.4");
        let parsers: Vec<usize> = d.mac_table_readings().iter().map(|r| r.parse as *const () as usize).collect();
        assert_eq!(
            parsers,
            [
                crate::mac_table::parse_mac_table as *const () as usize,
                crate::arubasw::parse_mac_address_table as *const () as usize,
                crate::dell::parse_mac_address_table as *const () as usize
            ]
        );
        let lldp: Vec<usize> = d.lldp_readings().iter().map(|r| r.parse as *const () as usize).collect();
        assert_eq!(lldp[2], crate::dell::parse_lldp_neighbors as *const () as usize);
        let cdp: Vec<usize> = d.cdp_readings().iter().map(|r| r.parse as *const () as usize).collect();
        assert_eq!(cdp, [crate::cdp::parse_cdp_detail as *const () as usize, crate::arubasw::parse_cdp_neighbors as *const () as usize]);
        let a = dialect_for("Image stamp: x Boot ROM Version: y");
        assert_eq!(a.port_channel_readings()[1].parse as usize, crate::arubasw::parse_trunks as *const () as usize);
    }

    /// D-026 / D-051, held in one place: the dialects that have not met a
    /// device are these, by name, and a new one has to be added here on
    /// purpose rather than claimed by omission.
    #[test]
    fn the_unverified_dialects_are_named() {
        let unverified: Vec<&str> = all().filter(|d| !d.verified_against_hardware()).map(|d| d.name()).collect();
        assert_eq!(unverified, ["Arista EOS", "Junos", "ArubaOS-CX", "Dell OS10 / OS9 / OS6"]);
    }
}
