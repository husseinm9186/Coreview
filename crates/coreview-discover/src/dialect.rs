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
//! **What is not here yet.** The identity half of a visit — the version
//! banner, the neighbours, the MAC and ARP tables, the platform-specific
//! branches for FortiOS and ArubaOS-Switch in `crawl::visit` — still lives in
//! the crawler. It is the next thing to move, and it is not claimed.

use crate::overlay::OverlayDialect;
use crate::vrftables::VrfDialect;

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
    /// Whether every part of this dialect has met a device of its family.
    /// A dialect built from documentation says so until it has (D-026).
    fn verified_against_hardware(&self) -> bool;
}

/// One implementation per family, all delegating to what exists. The hint
/// each one hands the command lists is the word those lists already key on.
struct Known {
    family: Family,
    name: &'static str,
    hint: &'static str,
    verified: bool,
}

impl Dialect for Known {
    fn family(&self) -> Family {
        self.family
    }
    fn name(&self) -> &'static str {
        self.name
    }
    fn route_commands(&self) -> &'static [&'static str] {
        crate::routes::commands_for(self.hint)
    }
    fn stack_commands(&self) -> &'static [&'static str] {
        crate::stacking::commands_for(self.hint)
    }
    fn default_route_commands(&self) -> &'static [&'static str] {
        crate::defaultroute::commands_for(self.hint)
    }
    fn vrf(&self) -> VrfDialect {
        crate::vrftables::dialect_for(self.hint)
    }
    fn overlay(&self) -> OverlayDialect {
        crate::overlay::dialect_for(self.hint)
    }
    fn verified_against_hardware(&self) -> bool {
        self.verified
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
pub fn dialect_for(version: &str) -> &'static dyn Dialect {
    let family = family_of(version);
    DIALECTS.iter().find(|d| d.family == family).unwrap_or(&DIALECTS[DIALECTS.len() - 1])
}

/// Every dialect, for a listing.
pub fn all() -> impl Iterator<Item = &'static dyn Dialect> {
    DIALECTS.iter().map(|d| d as &dyn Dialect)
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

    /// D-026 / D-051, held in one place: the dialects that have not met a
    /// device are these, by name, and a new one has to be added here on
    /// purpose rather than claimed by omission.
    #[test]
    fn the_unverified_dialects_are_named() {
        let unverified: Vec<&str> = all().filter(|d| !d.verified_against_hardware()).map(|d| d.name()).collect();
        assert_eq!(unverified, ["Arista EOS", "Junos", "ArubaOS-CX", "Dell OS10 / OS9 / OS6"]);
    }
}
