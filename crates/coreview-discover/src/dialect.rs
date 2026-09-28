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
use crate::interfaces::Interface;
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
    /// LT-468: Palo Alto Networks PAN-OS.
    PanOs,
    /// LT-469: the ASA command line, on an ASA or a Firepower running it.
    CiscoAsa,
    /// LT-470: Check Point Gaia's clish.
    Gaia,
    /// LT-471: HPE and H3C Comware.
    Comware,
    /// LT-472: Huawei VRP.
    HuaweiVrp,
    /// LT-473: MikroTik RouterOS.
    RouterOs,
    /// LT-474: the Vyatta lineage — Ubiquiti EdgeOS and VyOS.
    Vyatta,
    /// LT-475: a Cisco AireOS wireless controller. A 9800 runs IOS-XE.
    AireOs,
    /// LT-476: an Aruba Mobility controller or Instant cluster.
    ArubaController,
    /// Nothing recognised: the Cisco commands are tried, because they are the
    /// ones most other vendors imitate, and a refusal is reported as one.
    Generic,
}

/// The version spellings tried in order until one answers (LT-465). A
/// platform that rejects the first costs one rejected command per spelling
/// before its own; FortiOS is recognised from its rejection and stops at once.
pub const VERSION_COMMANDS: &[&str] = &[
    "show version",
    "display version",
    "show system info",
    "show sysinfo",
    "/system resource print",
];

/// What a platform says about itself, read the platform's way (LT-466).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    /// The model, upper-cased for the classifier; `None` where the version
    /// text carries none and the ordinary reader should try.
    pub model: Option<String>,
    /// Chassis serials, in order; empty where the ordinary reader should try.
    pub serials: Vec<String>,
}

/// Whether an answer to one of [`VERSION_COMMANDS`] is the one to keep: the
/// device answered rather than refused, or its refusal alone names the family.
pub fn identifies(output: &str) -> bool {
    !output.trim().is_empty()
        && (crate::cli::command_was_rejected(output).is_none() || family_of(output) != Family::Generic)
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
    /// LT-465: the ways of reading the interfaces and their addresses.
    fn interface_readings(&self) -> &'static [Reading<Interface>];
    /// LT-479: where policy routing is applied, read with the routing table
    /// so a trace can say it was not evaluated.
    fn policy_route_readings(&self) -> &'static [Reading<crate::policyroutes::PolicyRoute>];
    /// LT-475: the access points a controller manages, as neighbours it
    /// reported. Empty on anything that is not a controller.
    fn ap_readings(&self) -> &'static [Reading<Neighbor>];
    /// LT-466: commands asked after the version because the identity is not
    /// all in it — Junos's `show chassis hardware`. Their answers are handed
    /// to [`Dialect::identity`] in this order.
    fn identity_commands(&self) -> &'static [&'static str];
    /// LT-466: the model and serials, read the platform's way from the
    /// version text and the answers to `identity_commands`. A default
    /// `Identity` means the ordinary readers decide.
    fn identity(&self, version: &str, extra: &[String]) -> Identity;
    /// LT-465: the command that turns paging off on this platform, sent once
    /// the platform is known. `connect` has already tried `terminal length
    /// 0` and, if that was refused, `no page`; those two are not sent again.
    fn paging_off(&self) -> Option<&'static str>;
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
// LT-466: Junos, from its documentation (D-058). No CDP on this platform.
static NO_NEIGHBOURS: &[Reading<Neighbor>] = &[];
static LLDP_JUNOS: &[Reading<Neighbor>] = &[Reading { command: "show lldp neighbors", parse: crate::junos::parse_lldp_neighbors }];
static ARP_JUNOS: &[&str] = &["show arp no-resolve"];
static MAC_JUNOS: &[Reading<MacEntry>] = &[Reading { command: "show ethernet-switching table", parse: crate::junos::parse_switching_table }];
static PORT_CHANNELS_JUNOS: &[Reading<PortChannel>] = &[Reading { command: "show lacp interfaces", parse: crate::junos::parse_lacp_interfaces }];
static INTERFACES_JUNOS: &[Reading<Interface>] = &[Reading { command: "show interfaces terse", parse: crate::junos::parse_interfaces_terse }];
// LT-467: Arista, from its documentation (D-058). EOS has no CDP; its LLDP
// detail is a block per interface; its bundles print in the table Dell's
// reader already reads.
static LLDP_ARISTA: &[Reading<Neighbor>] = &[Reading { command: "show lldp neighbors detail", parse: crate::arista::parse_lldp_detail }];
static PORT_CHANNELS_ARISTA: &[Reading<PortChannel>] = &[Reading { command: "show port-channel summary", parse: crate::dell::parse_port_channel_summary }];
// LT-468: PAN-OS, from its documentation (D-058).
static LLDP_PANOS: &[Reading<Neighbor>] = &[Reading { command: "show lldp neighbors all", parse: crate::panos::parse_lldp_neighbors }];
static ARP_PANOS: &[&str] = &["show arp all"];
static INTERFACES_PANOS: &[Reading<Interface>] = &[Reading { command: "show interface all", parse: crate::panos::parse_interface_all }];
// LT-469: the ASA, from its documentation (D-058).
static ARP_ASA: &[&str] = &["show arp"];
static INTERFACES_ASA: &[Reading<Interface>] = &[Reading { command: "show interface ip brief", parse: crate::interfaces::parse_ip_interface_brief }];
// LT-470: Gaia. LT-471: Comware. LT-472: Huawei. LT-473: RouterOS.
// LT-474: the Vyatta lineage. LT-475/476: controllers. All D-058.
static ARP_GAIA: &[&str] = &["show arp dynamic all"];
static INTERFACES_GAIA: &[Reading<Interface>] = &[Reading { command: "show interfaces all", parse: crate::gaia::parse_interfaces_all }];
static LLDP_COMWARE: &[Reading<Neighbor>] = &[Reading { command: "display lldp neighbor-information list", parse: crate::comware::parse_lldp_neighbor_list }];
static ARP_DISPLAY: &[&str] = &["display arp"];
static MAC_COMWARE: &[Reading<MacEntry>] = &[Reading { command: "display mac-address", parse: crate::comware::parse_mac_address }];
static PORT_CHANNELS_COMWARE: &[Reading<PortChannel>] = &[Reading { command: "display link-aggregation verbose", parse: crate::comware::parse_link_aggregation }];
static INTERFACES_COMWARE: &[Reading<Interface>] = &[Reading { command: "display ip interface brief", parse: crate::comware::parse_ip_interface_brief }];
static LLDP_HUAWEI: &[Reading<Neighbor>] = &[Reading { command: "display lldp neighbor brief", parse: crate::huawei::parse_lldp_neighbor_brief }];
static PORT_CHANNELS_HUAWEI: &[Reading<PortChannel>] = &[Reading { command: "display eth-trunk", parse: crate::huawei::parse_eth_trunk }];
static INTERFACES_HUAWEI: &[Reading<Interface>] = &[Reading { command: "display ip interface brief", parse: crate::huawei::parse_ip_interface_brief }];
static LLDP_ROUTEROS: &[Reading<Neighbor>] = &[Reading { command: "/ip neighbor print detail without-paging", parse: crate::routeros::parse_neighbors }];
static ARP_ROUTEROS: &[&str] = &["/ip arp print without-paging"];
static MAC_ROUTEROS: &[Reading<MacEntry>] = &[Reading { command: "/interface bridge host print without-paging", parse: crate::routeros::parse_bridge_hosts }];
static INTERFACES_ROUTEROS: &[Reading<Interface>] = &[Reading { command: "/ip address print without-paging", parse: crate::routeros::parse_ip_address }];
static LLDP_VYATTA: &[Reading<Neighbor>] = &[Reading { command: "show lldp neighbors detail", parse: crate::vyatta::parse_lldp_detail }];
static INTERFACES_VYATTA: &[Reading<Interface>] = &[Reading { command: "show interfaces", parse: crate::vyatta::parse_interfaces }];
static APS_CISCO: &[Reading<Neighbor>] = &[Reading { command: "show ap summary", parse: crate::wlc::parse_ap_table }];
static APS_ARUBA: &[Reading<Neighbor>] = &[
    Reading { command: "show ap database", parse: crate::wlc::parse_ap_table },
    Reading { command: "show aps", parse: crate::wlc::parse_ap_table },
];
// LT-479: policy routing, where the platform lists it.
static POLICY_IOS: &[Reading<crate::policyroutes::PolicyRoute>] = &[Reading { command: "show ip policy", parse: crate::policyroutes::parse_ip_policy }];
static POLICY_FORTIOS: &[Reading<crate::policyroutes::PolicyRoute>] = &[Reading { command: "show router policy", parse: crate::policyroutes::parse_fortios_policy }];
static NO_POLICY: &[Reading<crate::policyroutes::PolicyRoute>] = &[];
static NO_MACS: &[Reading<MacEntry>] = &[];
static NO_PORT_CHANNELS: &[Reading<PortChannel>] = &[];
static INTERFACES_BRIEF: &[Reading<Interface>] =
    &[Reading { command: "show ip interface brief", parse: crate::interfaces::parse_ip_interface_brief }];
static NO_INTERFACES: &[Reading<Interface>] = &[];
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
    /// LT-465. `None` where nothing is sent: FortiOS pages nothing this reads,
    /// and RouterOS is asked `without-paging` per command.
    paging_off: Option<&'static str>,
    interfaces: &'static [Reading<Interface>],
}

/// A dialect as read off one banner: the family's command lists, and the
/// two identity predicates the crawler applied to that banner.
struct Chosen {
    known: &'static Known,
    dell: Option<DellOs>,
    aruba_switch: bool,
    /// LT-475: a Catalyst 9800 is IOS-XE with an AP table.
    wlc_9800: bool,
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
        use Family::*;
        match self.known.family {
            Junos | AristaEos | PanOs | CiscoAsa | Gaia | Comware | HuaweiVrp | RouterOs | Vyatta | AireOs | ArubaController => NO_NEIGHBOURS,
            _ => CDP,
        }
    }
    fn lldp_readings(&self) -> &'static [Reading<Neighbor>] {
        use Family::*;
        match self.known.family {
            Junos => LLDP_JUNOS,
            AristaEos => LLDP_ARISTA,
            PanOs => LLDP_PANOS,
            Comware => LLDP_COMWARE,
            HuaweiVrp => LLDP_HUAWEI,
            RouterOs => LLDP_ROUTEROS,
            Vyatta => LLDP_VYATTA,
            CiscoAsa | Gaia | AireOs | ArubaController => NO_NEIGHBOURS,
            _ if self.dell.is_some() => LLDP_DELL,
            _ => LLDP,
        }
    }
    fn arp_commands(&self) -> &'static [&'static str] {
        use Family::*;
        match self.known.family {
            Junos => ARP_JUNOS,
            PanOs => ARP_PANOS,
            CiscoAsa | Vyatta => ARP_ASA,
            Gaia => ARP_GAIA,
            Comware | HuaweiVrp => ARP_DISPLAY,
            RouterOs => ARP_ROUTEROS,
            AireOs | ArubaController => &[],
            _ => ARP,
        }
    }
    fn mac_table_readings(&self) -> &'static [Reading<MacEntry>] {
        use Family::*;
        match (self.known.family, self.dell) {
            (Junos, _) => MAC_JUNOS,
            (Comware | HuaweiVrp, _) => MAC_COMWARE,
            (RouterOs, _) => MAC_ROUTEROS,
            (PanOs | CiscoAsa | Gaia | Vyatta | AireOs | ArubaController, _) => NO_MACS,
            (_, Some(DellOs::Os9)) => MAC_DELL_OS9,
            (_, Some(_)) => MAC_DELL,
            _ => MAC,
        }
    }
    fn port_channel_readings(&self) -> &'static [Reading<PortChannel>] {
        use Family::*;
        match self.known.family {
            Junos => PORT_CHANNELS_JUNOS,
            AristaEos => PORT_CHANNELS_ARISTA,
            Comware => PORT_CHANNELS_COMWARE,
            HuaweiVrp => PORT_CHANNELS_HUAWEI,
            PanOs | CiscoAsa | Gaia | RouterOs | Vyatta | AireOs | ArubaController => NO_PORT_CHANNELS,
            _ if self.aruba_switch => PORT_CHANNELS_ARUBA,
            _ if self.dell.is_some() => PORT_CHANNELS_DELL,
            _ => PORT_CHANNELS,
        }
    }
    fn policy_route_readings(&self) -> &'static [Reading<crate::policyroutes::PolicyRoute>] {
        match self.known.family {
            Family::CiscoIos | Family::CiscoNxOs | Family::Generic => POLICY_IOS,
            Family::FortiOs => POLICY_FORTIOS,
            _ => NO_POLICY,
        }
    }
    fn ap_readings(&self) -> &'static [Reading<Neighbor>] {
        match self.known.family {
            Family::AireOs => APS_CISCO,
            Family::CiscoIos if self.wlc_9800 => APS_CISCO,
            Family::ArubaController => APS_ARUBA,
            _ => NO_NEIGHBOURS,
        }
    }
    fn identity_commands(&self) -> &'static [&'static str] {
        use Family::*;
        match self.known.family {
            Junos => &["show chassis hardware"],
            // LT-490: captured from a CX 6200F — the model and serial are
            // here and not in `show version`.
            ArubaOsCx => &["show system"],
            Gaia => &["show asset all"],
            Comware => &["display device manuinfo"],
            HuaweiVrp => &["display esn"],
            RouterOs => &["/system routerboard print"],
            AireOs | ArubaController => &["show inventory"],
            _ => &[],
        }
    }
    fn identity(&self, version: &str, extra: &[String]) -> Identity {
        use Family::*;
        let first = extra.first().map(String::as_str).unwrap_or("");
        match self.known.family {
            Junos => Identity { model: crate::junos::model_of(version), serials: crate::junos::serials_of(first) },
            ArubaOsCx => Identity { model: crate::arubacx::model_of(first), serials: crate::arubacx::serials_of(first) },
            AristaEos => Identity { model: crate::arista::model_of(version), serials: Vec::new() },
            PanOs => Identity { model: crate::panos::model_of(version), serials: crate::panos::serials_of(version) },
            CiscoAsa => Identity { model: crate::asa::model_of(version), serials: Vec::new() },
            Gaia => Identity { model: crate::gaia::model_of(first), serials: crate::gaia::serials_of(first) },
            Comware => Identity { model: crate::comware::model_of(version), serials: crate::comware::serials_of(first) },
            HuaweiVrp => Identity { model: crate::huawei::model_of(version), serials: crate::huawei::serials_of(first) },
            RouterOs => Identity { model: crate::routeros::model_of(first, version), serials: crate::routeros::serials_of(first) },
            Vyatta => Identity { model: crate::vyatta::model_of(version), serials: Vec::new() },
            AireOs => {
                let (model, serials) = crate::wlc::inventory_identity(first);
                Identity { model, serials }
            }
            ArubaController => Identity { model: crate::wlc::aruba_model_of(version), serials: crate::wlc::aruba_serials_of(first) },
            _ => Identity::default(),
        }
    }
    fn interface_readings(&self) -> &'static [Reading<Interface>] {
        self.known.interfaces
    }
    fn paging_off(&self) -> Option<&'static str> {
        self.known.paging_off
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
    Known { family: Family::CiscoNxOs, name: "Cisco NX-OS", hint: "nx-os", verified: true, paging_off: Some("terminal length 0"), interfaces: INTERFACES_BRIEF },
    Known { family: Family::CiscoIos, name: "Cisco IOS / IOS-XE", hint: "cisco ios", verified: true, paging_off: Some("terminal length 0"), interfaces: INTERFACES_BRIEF },
    Known { family: Family::AristaEos, name: "Arista EOS", hint: "arista", verified: false, paging_off: Some("terminal length 0"), interfaces: INTERFACES_BRIEF },
    Known { family: Family::Junos, name: "Junos", hint: "junos", verified: false, paging_off: Some("set cli screen-length 0"), interfaces: INTERFACES_JUNOS },
    Known { family: Family::FortiOs, name: "FortiOS", hint: "fortios", verified: true, paging_off: None, interfaces: INTERFACES_BRIEF },
    Known { family: Family::ArubaOsSwitch, name: "ArubaOS-Switch", hint: "arubaos-switch", verified: true, paging_off: Some("no page"), interfaces: INTERFACES_BRIEF },
    Known { family: Family::ArubaOsCx, name: "ArubaOS-CX", hint: "arubaos-cx", verified: false, paging_off: Some("no page"), interfaces: INTERFACES_BRIEF },
    Known { family: Family::Dell, name: "Dell OS10 / OS9 / OS6", hint: "dell", verified: false, paging_off: Some("terminal length 0"), interfaces: INTERFACES_BRIEF },
    // D-058: built from documentation, each says so until it has met a device.
    Known { family: Family::PanOs, name: "Palo Alto PAN-OS", hint: "pan-os", verified: false, paging_off: Some("set cli pager off"), interfaces: INTERFACES_PANOS },
    Known { family: Family::CiscoAsa, name: "Cisco ASA", hint: "cisco asa", verified: false, paging_off: Some("terminal pager 0"), interfaces: INTERFACES_ASA },
    Known { family: Family::Gaia, name: "Check Point Gaia", hint: "gaia", verified: false, paging_off: Some("set clienv rows 0"), interfaces: INTERFACES_GAIA },
    Known { family: Family::Comware, name: "HPE Comware", hint: "comware", verified: false, paging_off: Some("screen-length disable"), interfaces: INTERFACES_COMWARE },
    Known { family: Family::HuaweiVrp, name: "Huawei VRP", hint: "huawei", verified: false, paging_off: Some("screen-length 0 temporary"), interfaces: INTERFACES_HUAWEI },
    Known { family: Family::RouterOs, name: "MikroTik RouterOS", hint: "routeros", verified: false, paging_off: None, interfaces: INTERFACES_ROUTEROS },
    Known { family: Family::Vyatta, name: "Vyatta (EdgeOS, VyOS)", hint: "vyatta", verified: false, paging_off: Some("terminal length 0"), interfaces: INTERFACES_VYATTA },
    Known { family: Family::AireOs, name: "Cisco AireOS", hint: "aireos", verified: false, paging_off: Some("config paging disable"), interfaces: NO_INTERFACES },
    Known { family: Family::ArubaController, name: "Aruba Mobility / Instant", hint: "aruba controller", verified: false, paging_off: Some("no paging"), interfaces: INTERFACES_BRIEF },
    Known { family: Family::Generic, name: "unrecognised (Cisco commands tried)", hint: "", verified: true, paging_off: Some("terminal length 0"), interfaces: INTERFACES_BRIEF },
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
    // LT-476: `ArubaOS (MODEL: Aruba7005), Version 8.10` / "Aruba Operating
    // System Software" — a controller or an Instant AP, never a switch.
    } else if v.contains("aruba operating system") || v.contains("arubaos (model") {
        Family::ArubaController
    } else if v.contains("dell") || v.contains("os10") || v.contains("powerswitch") {
        Family::Dell
    // D-058 families, each from its own version banner, before the Cisco
    // catch-all because two of them say "Cisco" too.
    } else if v.contains("adaptive security appliance") {
        Family::CiscoAsa
    } else if v.contains("cisco controller") || v.contains("aireos") {
        Family::AireOs
    } else if v.contains("pan-os") || v.contains("palo alto") || (v.contains("sw-version:") && v.contains("model:")) {
        Family::PanOs
    } else if v.contains("check point") || v.contains("gaia") {
        Family::Gaia
    } else if v.contains("comware") || v.contains("h3c") {
        Family::Comware
    } else if v.contains("huawei") || v.contains("versatile routing platform") {
        Family::HuaweiVrp
    } else if v.contains("routeros") || v.contains("mikrotik") || v.contains("board-name:") {
        Family::RouterOs
    } else if v.contains("vyos") || v.contains("vyatta") || v.contains("edgeos") || v.contains("edgerouter") || v.contains("ubiquiti") {
        Family::Vyatta
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
        wlc_9800: family == Family::CiscoIos && version.to_ascii_lowercase().contains("c9800"),
    })
}

/// Every dialect, for a listing.
pub fn all() -> impl Iterator<Item = Box<dyn Dialect>> {
    DIALECTS.iter().map(|known| {
        Box::new(Chosen {
            known,
            dell: (known.family == Family::Dell).then_some(DellOs::Os10),
            aruba_switch: known.family == Family::ArubaOsSwitch,
            wlc_9800: false,
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
            if !matches!(d.family(), Family::CiscoIos | Family::CiscoNxOs | Family::FortiOs | Family::ArubaOsSwitch | Family::ArubaOsCx | Family::Dell | Family::Generic) {
                // LT-466–476: their own sequences, asserted below.
                continue;
            }
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
        // LT-466: a Junos is asked its own questions and no Cisco ones.
        let j = dialect_for("JUNOS 21.4R3-S1.5");
        assert!(j.cdp_readings().is_empty(), "Junos has no CDP");
        assert_eq!(commands(j.lldp_readings()), ["show lldp neighbors"]);
        assert_eq!(j.arp_commands(), ["show arp no-resolve"]);
        assert_eq!(commands(j.mac_table_readings()), ["show ethernet-switching table"]);
        assert_eq!(commands(j.port_channel_readings()), ["show lacp interfaces"]);
        assert_eq!(commands(j.interface_readings()), ["show interfaces terse"]);
        assert_eq!(j.paging_off(), Some("set cli screen-length 0"));
        assert_eq!(j.identity_commands(), ["show chassis hardware"]);
        // LT-467–469: the same, per family.
        let a = dialect_for("Arista DCS-7050SX3-48YC8");
        assert!(a.cdp_readings().is_empty());
        assert_eq!(commands(a.lldp_readings()), ["show lldp neighbors detail"]);
        assert_eq!(commands(a.port_channel_readings()), ["show port-channel summary"]);
        assert_eq!(a.identity("Arista DCS-7050SX3-48YC8\n", &[]).model.as_deref(), Some("DCS-7050SX3-48YC8"));
        let pa = dialect_for("model: PA-220\nsw-version: 10.1.6");
        assert_eq!(commands(pa.lldp_readings()), ["show lldp neighbors all"]);
        assert_eq!(pa.arp_commands(), ["show arp all"]);
        assert!(pa.mac_table_readings().is_empty() && pa.cdp_readings().is_empty() && pa.port_channel_readings().is_empty());
        assert_eq!(commands(pa.interface_readings()), ["show interface all"]);
        assert_eq!(pa.route_commands(), ["show routing route"]);
        let asa = dialect_for("Cisco Adaptive Security Appliance Software Version 9.16(4)");
        assert!(asa.lldp_readings().is_empty() && asa.cdp_readings().is_empty());
        assert_eq!(asa.arp_commands(), ["show arp"]);
        assert_eq!(commands(asa.interface_readings()), ["show interface ip brief"]);
        assert_eq!(asa.route_commands(), ["show route"]);
        assert_eq!(asa.default_route_commands(), ["show route"]);
        assert!(asa.stack_commands().is_empty());
        // LT-470–476, each asked only its own questions.
        let g = dialect_for("Product version Check Point Gaia R81.10");
        assert_eq!((commands(g.interface_readings()), g.arp_commands(), g.identity_commands(), g.route_commands()), (vec!["show interfaces all"], &["show arp dynamic all"][..], &["show asset all"][..], &["show route"][..]));
        assert!(g.lldp_readings().is_empty() && g.cdp_readings().is_empty() && g.mac_table_readings().is_empty());
        let c = dialect_for("HPE Comware Software, Version 7.1.070");
        assert_eq!((commands(c.lldp_readings()), commands(c.mac_table_readings()), commands(c.port_channel_readings()), c.route_commands(), c.paging_off()), (vec!["display lldp neighbor-information list"], vec!["display mac-address"], vec!["display link-aggregation verbose"], &["display ip routing-table"][..], Some("screen-length disable")));
        let h = dialect_for("Huawei Versatile Routing Platform Software");
        assert_eq!((commands(h.lldp_readings()), commands(h.port_channel_readings()), h.identity_commands(), h.paging_off()), (vec!["display lldp neighbor brief"], vec!["display eth-trunk"], &["display esn"][..], Some("screen-length 0 temporary")));
        let m = dialect_for("  board-name: RB5009UG+S+\n  platform: MikroTik");
        assert_eq!((commands(m.lldp_readings()), m.arp_commands(), commands(m.mac_table_readings()), commands(m.interface_readings()), m.route_commands(), m.paging_off()), (vec!["/ip neighbor print detail without-paging"], &["/ip arp print without-paging"][..], vec!["/interface bridge host print without-paging"], vec!["/ip address print without-paging"], &["/ip route print without-paging"][..], None));
        let v = dialect_for("Version:      v2.0.9\nCopyright:    2012-2023 Ubiquiti Networks, Inc.");
        assert_eq!((commands(v.lldp_readings()), v.arp_commands(), commands(v.interface_readings()), v.route_commands()), (vec!["show lldp neighbors detail"], &["show arp"][..], vec!["show interfaces"], &["show ip route", "show ipv6 route"][..]));
        assert!(v.stack_commands().is_empty() && v.mac_table_readings().is_empty());
        let w = dialect_for("Product Name..... Cisco Controller");
        assert_eq!((commands(w.ap_readings()), w.identity_commands(), w.paging_off()), (vec!["show ap summary"], &["show inventory"][..], Some("config paging disable")));
        assert!(w.route_commands().is_empty() && w.lldp_readings().is_empty() && w.arp_commands().is_empty());
        let nine = dialect_for("Cisco IOS XE Software, Version 17.9.4a\ncisco C9800-40-K9 (1RU) processor");
        assert_eq!((nine.family(), commands(nine.ap_readings())), (Family::CiscoIos, vec!["show ap summary"]));
        assert!(dialect_for("Cisco IOS XE Software, Version 17.9.4a\ncisco C9300-48P").ap_readings().is_empty(), "only a 9800 has an AP table");
        let ar = dialect_for("ArubaOS (MODEL: Aruba7005), Version 8.10.0.9");
        assert_eq!((commands(ar.ap_readings()), ar.paging_off()), (vec!["show ap database", "show aps"], Some("no paging")));
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
        assert_eq!(
            unverified,
            [
                "Arista EOS",
                "Junos",
                "ArubaOS-CX",
                "Dell OS10 / OS9 / OS6",
                // D-058, LT-465: from documentation, every one of them.
                "Palo Alto PAN-OS",
                "Cisco ASA",
                "Check Point Gaia",
                "HPE Comware",
                "Huawei VRP",
                "MikroTik RouterOS",
                "Vyatta (EdgeOS, VyOS)",
                "Cisco AireOS",
                "Aruba Mobility / Instant",
            ]
        );
    }

    /// LT-465: each new family off the banner its own version command
    /// prints — reconstructed from the vendors' documentation (D-058) — and
    /// the two that say "Cisco" are told apart from IOS.
    #[test]
    fn the_documentation_built_families_are_read_off_their_banners() {
        let cases = [
            ("Cisco Adaptive Security Appliance Software Version 9.16(4)\nHardware:   ASA5516", Family::CiscoAsa),
            ("Product Name..................................... Cisco Controller\nProduct Version.................................. 8.10.185.0", Family::AireOs),
            ("hostname: fw-1\nmodel: PA-220\nsw-version: 10.1.6", Family::PanOs),
            ("Product version Check Point Gaia R81.10\nOS build 335", Family::Gaia),
            ("HPE Comware Software, Version 7.1.070, Release 6710", Family::Comware),
            ("Huawei Versatile Routing Platform Software\nVRP (R) software, Version 8.180", Family::HuaweiVrp),
            ("  uptime: 1w2d\n  version: 7.14.3 (stable)\n  board-name: RB5009UG+S+\n  platform: MikroTik", Family::RouterOs),
            ("Version:      v2.0.9-hotfix.7\nCopyright:    2012-2023 Ubiquiti Networks, Inc.\nHW model:     EdgeRouter X 5-Port", Family::Vyatta),
            ("Version:          VyOS 1.4.0", Family::Vyatta),
            ("Aruba Operating System Software.\nArubaOS (MODEL: Aruba7005), Version 8.10.0.9", Family::ArubaController),
            ("Cisco IOS XE Software, Version 17.9.4a", Family::CiscoIos),
        ];
        for (banner, family) in cases {
            assert_eq!(family_of(banner), family, "{banner}");
        }
        // What each is told once known, and that the two already tried at
        // login are never sent twice.
        assert_eq!(dialect_for("HPE Comware Software").paging_off(), Some("screen-length disable"));
        assert_eq!(dialect_for("Cisco IOS Software").paging_off(), Some("terminal length 0"));
        assert_eq!(dialect_for("platform: MikroTik").paging_off(), None);
        assert!(dialect_for("Cisco IOS Software").interface_readings().iter().any(|r| r.command == "show ip interface brief"));
        assert!(dialect_for("Product Name..... Cisco Controller").interface_readings().is_empty(), "nothing is asked until a parser exists");
        // The version spellings, and what counts as an answer.
        assert_eq!(VERSION_COMMANDS[0], "show version");
        assert!(identifies("Cisco IOS Software, Version 15.2"));
        assert!(!identifies("% Invalid input detected at '^' marker."), "a Cisco refusal is not an identity");
        assert!(identifies("Unknown action 0"), "FortiOS is known from its refusal alone");
        assert!(!identifies("   "));
    }
}
