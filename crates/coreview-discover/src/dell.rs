//! Dell switches: SmartFabric OS10, OS9/Force10, and the N-series.
//!
//! Three families answer to the name Dell and none of them answers quite like
//! a Cisco:
//!
//! - **OS10** — the PowerSwitch line, campus and data centre: S4048-ON,
//!   S5248F-ON, Z9100-ON, the MX blade switches. Nearly Cisco-shaped, and the
//!   "nearly" is where a parser goes wrong: its `show lldp neighbors` is a
//!   four-column table rather than Cisco's paragraph per neighbour, and its
//!   port names are `ethernet1/1/5`.
//! - **OS9 / Force10 (FTOS)** — S4810, S4048, Z9500, the MXL blades.
//!   `show mac-address-table` with hyphens where Cisco has a space.
//! - **The N-series and PowerConnect** — FASTPATH underneath, which is why
//!   [`crate::stacking::parse_fastpath_stack`] already reads their `show
//!   switch`.
//!
//! **Written from vendor documentation, not from a device**. No Dell
//! switch was available to capture from, so the support is built from the
//! vendor references listed below. So every
//! parser here reports [`verified_against_hardware`] as false and every
//! fixture below is invented — the *shapes* are Dell's, the values are not.
//!
//! References, all Dell's own documentation:
//! - `show lldp neighbors`, SmartFabric OS10 User Guide 10.5.0
//! - `show mac address-table`, SmartFabric OS10 User Guide 10.5.0/10.5.2
//! - `show vlan`, SmartFabric OS10 User Guide 10.5.3
//! - `show port-channel summary`, SmartFabric OS10 User Guide 10.5.1/10.5.3
//! - `show mac-address-table`, Dell EMC OS9 C9010 CLI Reference 9.14

use crate::arp::normalise_mac;
use crate::cdp::short_name;
use crate::types::{DeviceClass, Neighbor, Protocol};

/// Which Dell this is, from `show version`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DellOs {
    /// SmartFabric OS10.
    Os10,
    /// OS9, and the Force10 FTOS it grew out of.
    Os9,
    /// The N-series and PowerConnect: FASTPATH.
    NSeries,
}

/// Whether any parser in this module has met a real Dell switch.
///
/// **False.** the rule: documentation is allowed to be the source, and the
/// result says so until a device answers. Nothing
/// downstream may present what is in here as a fact observed on hardware.
pub fn verified_against_hardware() -> bool {
    false
}

/// Which Dell family answered, if it is a Dell at all.
pub fn detect(version: &str) -> Option<DellOs> {
    let v = version.to_ascii_lowercase();
    if !v.contains("dell") && !v.contains("force10") && !v.contains("powerconnect") {
        return None;
    }
    if v.contains("os10") || v.contains("smartfabric") {
        Some(DellOs::Os10)
    } else if v.contains("force10") || v.contains("real time operating system") || v.contains(" os9") {
        Some(DellOs::Os9)
    } else if v.contains("powerconnect") || v.contains("n-series") || v.contains("fastpath") {
        Some(DellOs::NSeries)
    } else {
        // "Dell EMC Networking N3048EP-ON" and friends: a Dell that named no
        // operating system is the campus line often enough to be the guess,
        // and every command below is a `show` either way.
        Some(DellOs::NSeries)
    }
}

/// The model, out of `show version`.
///
/// Not a nicety: the ordinary reader looks for Cisco's `Model number` line and
/// a Dell has none, so the model fell through to the first line of the banner —
/// "Dell EMC Networking OS10 Enterprise" — and an S5248F-ON drew as a generic
/// box because nothing classifiable ever reached the classifier.
///
/// All three families label it, and each labels it differently:
/// OS10 and OS9 say `System Type`, FASTPATH says `Machine Model`, and an
/// N-series that says neither still names itself in `System Description`.
pub fn model_of(version: &str) -> Option<String> {
    let labelled = |label: &str| {
        version.lines().find_map(|line| {
            let (head, value) = line.split_once(':')?;
            head.trim().eq_ignore_ascii_case(label).then(|| value.trim().to_string())
        })
    };
    // FASTPATH pads its labels with dots rather than ending them with a colon:
    // `Machine Model.................. N3048EP-ON`.
    let dotted = |label: &str| {
        version.lines().find_map(|line| {
            let t = line.trim();
            let rest = t.strip_prefix(label)?;
            let value = rest.trim_start_matches('.').trim();
            (!value.is_empty()).then(|| value.to_string())
        })
    };

    labelled("System Type")
        .or_else(|| dotted("Machine Model"))
        .or_else(|| labelled("Machine Model"))
        // "Dell EMC Networking N3048EP-ON" — the model is the last word.
        .or_else(|| {
            let description = labelled("System Description")?;
            description.split_whitespace().last().map(str::to_string)
        })
        .filter(|m| !m.is_empty())
}

/// The columns of a table whose header names them and whose ruler is one run
/// of dashes rather than one run per column.
///
/// OS10 writes `------------...` across the whole width, so the Aruba reader —
/// which takes its columns from the gaps in the ruler — has nothing to work
/// with. The header is what carries the layout here: each column starts where
/// its name starts.
fn columns_from_header(header: &str, names: &[&str]) -> Option<Vec<(usize, usize)>> {
    let mut starts = Vec::new();
    for name in names {
        starts.push(header.find(name)?);
    }
    // Named in the order they appear, or this is not the table we think it is.
    if starts.windows(2).any(|w| w[0] >= w[1]) {
        return None;
    }
    Some(
        starts
            .iter()
            .enumerate()
            .map(|(i, &start)| (start, starts.get(i + 1).copied().unwrap_or(usize::MAX)))
            .collect(),
    )
}

fn cell(line: &str, (start, end): (usize, usize)) -> String {
    let chars: Vec<char> = line.chars().collect();
    if start >= chars.len() {
        return String::new();
    }
    chars[start..end.min(chars.len())].iter().collect::<String>().trim().to_string()
}

/// `show lldp neighbors` on OS10.
///
/// ```text
/// Loc PortID          Rem Host Name   Rem Port Id            Rem Chassis Id
/// ----------------------------------------------------------------------
/// ethernet1/1/2       Not Advertised  fortyGigE 0/56         aa:bb:cc:dd:ee:ff
/// ```
///
/// Two things to be careful of, both from the documented output: a remote port
/// id may contain a space (`fortyGigE 0/56`), so the row cannot be split on
/// whitespace; and a neighbour that advertises no name says so in words, which
/// is not a name.
pub fn parse_lldp_neighbors(out: &str) -> Vec<Neighbor> {
    const NAMES: [&str; 4] = ["Loc PortID", "Rem Host Name", "Rem Port Id", "Rem Chassis Id"];
    let lines: Vec<&str> = out.lines().collect();
    let Some(at) = lines.iter().position(|l| NAMES.iter().all(|n| l.contains(n))) else {
        return Vec::new();
    };
    let Some(columns) = columns_from_header(lines[at], &NAMES) else {
        return Vec::new();
    };

    lines[at + 1..]
        .iter()
        .filter(|l| !l.trim().is_empty() && !l.trim().starts_with('-'))
        .filter_map(|row| {
            let local = cell(row, columns[0]);
            let name = cell(row, columns[1]);
            let remote_port = cell(row, columns[2]);
            let chassis = cell(row, columns[3]);
            if local.is_empty() || (name.is_empty() && chassis.is_empty()) {
                return None;
            }
            // "Not Advertised" is the switch saying the neighbour gave no
            // name. Treating it as one would put a device called "Not
            // Advertised" on the diagram, once per port.
            let named = (!name.is_empty() && !name.eq_ignore_ascii_case("not advertised")).then_some(name);
            let device_id = named.unwrap_or_else(|| chassis.clone());
            let mac = normalise_mac(&chassis);
            Some(Neighbor {
                serial: None,
                short_name: short_name(&device_id),
                device_id,
                addresses: Vec::new(),
                local_interface: Some(local),
                remote_interface: (!remote_port.is_empty()
                    && !remote_port.eq_ignore_ascii_case("not advertised"))
                .then_some(remote_port),
                platform: None,
                capabilities: Vec::new(),
                version: None,
                class: DeviceClass::Unknown,
                discovered_by: Protocol::Lldp,
                vendor: mac.as_deref().and_then(crate::oui::vendor).map(str::to_string),
                chassis_id: mac,
            })
        })
        .collect()
}

/// `show mac address-table` on OS10, and `show mac-address-table` on OS9.
///
/// ```text
/// VlanId  Mac Address         Type       Interface
/// 10      aa:bb:cc:dd:ee:01   dynamic    port-channel120
/// ```
///
/// The column order is Cisco's, which is why the ordinary reader gets most of
/// the way. What it does not get is OS9's spelling of the command, or a row
/// whose interface is `port-channel120` rather than `Po120`.
pub fn parse_mac_address_table(out: &str) -> Vec<crate::mac_table::MacEntry> {
    out.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 4 {
                return None;
            }
            // vlan, mac, type, interface — and only what was learned, not the
            // switch's own static entries.
            let vlan = fields[0];
            if !vlan.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let mac = normalise_mac(fields[1])?;
            if !fields[2].eq_ignore_ascii_case("dynamic") {
                return None;
            }
            Some(crate::mac_table::MacEntry {
                mac,
                port: fields[3].to_string(),
                vlan: Some(vlan.to_string()),
            })
        })
        .collect()
}

/// `show vlan` on OS10.
///
/// ```text
/// Codes: * - Default VLAN, M - Management VLAN, R - Remote Port Mirroring VLANs
/// Q: A - Access (Untagged),  T - Tagged
///     NUM    Status    Description                     Q Ports
///     1      Active                                    A Eth1/1/2-1/1/32
///     10     Active    Voice                           T Eth1/1/1
/// ```
///
/// A row may carry a code before the number — `* 1` for the default VLAN — and
/// the description may be empty, which is why this is read by position from
/// the header rather than by counting words.
pub fn parse_vlans(out: &str) -> Vec<crate::vlans::Vlan> {
    const NAMES: [&str; 5] = ["NUM", "Status", "Description", "Q", "Ports"];
    let lines: Vec<&str> = out.lines().collect();
    let Some(at) = lines.iter().position(|l| NAMES.iter().all(|n| l.contains(n))) else {
        return Vec::new();
    };
    let Some(columns) = columns_from_header(lines[at], &NAMES) else {
        return Vec::new();
    };

    let mut out: Vec<crate::vlans::Vlan> = Vec::new();
    for row in &lines[at + 1..] {
        // The code markers sit to the left of the number, inside its cell.
        let num = cell(row, columns[0]);
        let ports = split_ports(&cell(row, columns[4]));
        match num.trim_start_matches(['*', 'M', 'R', ' ']).trim().parse::<u16>() {
            Ok(id) => out.push(crate::vlans::Vlan {
                id,
                name: cell(row, columns[2]),
                status: cell(row, columns[1]),
                ports,
            }),
            // A port list too long for one line wraps, and the wrapped part
            // belongs to the VLAN above — the same rule the Cisco reader
            // follows. A row with no number and no ports is a rule or a blank.
            Err(_) => {
                if let Some(last) = out.last_mut() {
                    last.ports.extend(ports);
                }
            }
        }
    }
    out
}

/// The ports of one VLAN, as printed.
///
/// A range stays a range: `Eth1/1/1-1/1/6` is one entry, because expanding it
/// would be inventing port names, and the Cisco reader keeps its own ranges
/// whole for the same reason.
fn split_ports(text: &str) -> Vec<String> {
    text.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect()
}

/// `show port-channel summary` on OS10.
///
/// ```text
/// Group Port-Channel      Type   Protocol  Member Ports
/// 22    port-channel22 (U) Eth   STATIC    1/1/2(P) 1/1/3(P)
/// 23    port-channel23 (D) Eth   DYNAMIC   1/1/4(I)
/// ```
///
/// `DYNAMIC` is LACP and `STATIC` is what Cisco calls "on". The flag after each
/// member says whether it is up and active; it is stripped rather than judged,
/// because a suspended member is still a cable and the diagram draws cables —
/// the same rule the Cisco reader follows.
pub fn parse_port_channel_summary(out: &str) -> Vec<crate::etherchannel::PortChannel> {
    out.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            // A group number, then a name that says what it is.
            if fields.len() < 3 || !fields[0].chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let name = fields[1].trim_end_matches(['(', ')']);
            if !name.to_ascii_lowercase().starts_with("port-channel") {
                return None;
            }
            let protocol = if fields.iter().any(|f| f.eq_ignore_ascii_case("DYNAMIC")) {
                "LACP"
            } else {
                "-"
            };
            let members: Vec<String> = fields
                .iter()
                .skip(2)
                .filter(|f| f.contains('/'))
                .map(|f| f.split('(').next().unwrap_or(f).to_string())
                .collect();
            Some(crate::etherchannel::PortChannel {
                name: name.to_string(),
                protocol: protocol.to_string(),
                members,
            })
        })
        .collect()
}

/// The commands worth asking this family, cheapest first.
pub fn commands_for(os: DellOs) -> &'static [&'static str] {
    match os {
        DellOs::Os10 => &["show lldp neighbors", "show mac address-table", "show vlan", "show port-channel summary"],
        // OS9 spells the MAC table with hyphens and has no `show vlan` table
        // of this shape; the LLDP reader is shared.
        DellOs::Os9 => &["show lldp neighbors", "show mac-address-table", "show port-channel summary"],
        // FASTPATH. `show switch` is already asked for stacking.
        DellOs::NSeries => &["show mac address-table", "show vlan"],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Dell's shapes, invented values.
    const LLDP: &str = "\
Loc PortID          Rem Host Name   Rem Port Id            Rem Chassis Id
-------------------------------------------------------------------------
ethernet1/1/2       LAB-CORE-1      fortyGigE 0/56         aa:bb:cc:00:11:22
ethernet1/1/20:1    Not Advertised  GigabitEthernet 1/0    aa:bb:cc:00:11:33
ethernet1/1/21      LAB-AP-9        Not Advertised         aa:bb:cc:00:11:44
";

    const MACS: &str = "\
VlanId  Mac Address         Type       Interface
1       aa:bb:cc:00:11:22   static     port-channel1000
10      aa:bb:cc:00:11:33   dynamic    port-channel120
11      aa:bb:cc:00:11:44   dynamic    ethernet1/1/6
12      aa:bb:cc:00:11:55   sticky     ethernet1/1/7
";

    const VLANS: &str = "\
Codes: * - Default VLAN, M - Management VLAN, R - Remote Port Mirroring VLANs
Q: A - Access (Untagged),  T - Tagged
    NUM    Status    Description                     Q Ports
*   1      Active                                    A Eth1/1/2-1/1/32,
                                                       1/1/40-1/1/48
    10     Active    LabVoice                        T Eth1/1/1
    20     Inactive  LabData                         A Eth1/1/1
";

    const BUNDLES: &str = "\
Flags: D - Down
       I - member up but inactive
       P - member up and active
       U - Up (port-channel)
--------------------------------------------------------------------------------
Group Port-Channel      Type   Protocol  Member Ports
--------------------------------------------------------------------------------
22    port-channel22 (U) Eth   STATIC    1/1/2(D) 1/1/3(P)
23    port-channel23 (D) Eth   DYNAMIC   1/1/4(I)
";

    #[test]
    fn which_dell_it_is_comes_from_the_version() {
        assert_eq!(detect("Dell EMC Networking OS10 Enterprise 10.5.3"), Some(DellOs::Os10));
        assert_eq!(detect("Dell SmartFabric OS10, Version 10.5.4"), Some(DellOs::Os10));
        assert_eq!(detect("Dell Real Time Operating System Software, Dell Force10"), Some(DellOs::Os9));
        assert_eq!(detect("Dell EMC Networking N3048EP-ON, 6.7.1.20"), Some(DellOs::NSeries));
        assert_eq!(detect("Dell PowerConnect 5548, 4.1.0.19"), Some(DellOs::NSeries));
        // Not a Dell at all.
        assert_eq!(detect("Cisco IOS Software, C2960CX Software, Version 15.2(7)E"), None);
        assert_eq!(detect(""), None);
    }

    #[test]
    fn nothing_here_claims_to_have_met_a_dell() {
        assert!(!verified_against_hardware(), "documentation, until a device answers");
    }

    #[test]
    fn lldp_neighbours_survive_a_port_name_with_a_space_in_it() {
        let found = parse_lldp_neighbors(LLDP);
        assert_eq!(found.len(), 3, "{found:#?}");
        assert_eq!(found[0].device_id, "LAB-CORE-1");
        assert_eq!(found[0].local_interface.as_deref(), Some("ethernet1/1/2"));
        // The whole reason this is read by column: splitting on whitespace
        // would make this two fields and shift every column after it.
        assert_eq!(found[0].remote_interface.as_deref(), Some("fortyGigE 0/56"));
        assert_eq!(found[0].chassis_id.as_deref(), Some("aabbcc001122"));
    }

    #[test]
    fn a_neighbour_that_advertised_no_name_is_not_called_not_advertised() {
        let found = parse_lldp_neighbors(LLDP);
        // It falls back to the chassis id, which at least identifies it.
        assert_eq!(found[1].device_id, "aa:bb:cc:00:11:33");
        assert_eq!(found[1].local_interface.as_deref(), Some("ethernet1/1/20:1"));
        // And a port nobody advertised is no port, rather than those words.
        assert_eq!(found[2].remote_interface, None);
        assert_eq!(found[2].device_id, "LAB-AP-9");
    }

    #[test]
    fn the_mac_table_keeps_only_what_was_learned() {
        let found = parse_mac_address_table(MACS);
        assert_eq!(found.len(), 2, "static and sticky are not devices on a port: {found:#?}");
        assert_eq!(found[0].mac, "aabbcc001133");
        assert_eq!(found[0].port, "port-channel120");
        assert_eq!(found[0].vlan.as_deref(), Some("10"));
        assert_eq!(found[1].port, "ethernet1/1/6");
    }

    #[test]
    fn the_model_is_found_wherever_each_family_puts_it() {
        // OS10 and OS9 label it `System Type`. Without this the model was the
        // banner's first line, which classifies as nothing.
        assert_eq!(
            model_of("Dell EMC Networking OS10 Enterprise\nOS Version: 10.5.4.2\nSystem Type: S5248F-ON\n")
                .as_deref(),
            Some("S5248F-ON"),
        );
        assert_eq!(
            model_of("Dell Force10 Real Time Operating System Software\nSystem Type: S4810\n").as_deref(),
            Some("S4810"),
        );
        // FASTPATH pads its labels with dots instead of ending them.
        assert_eq!(
            model_of("Machine Model.................. N3048EP-ON\nSerial Number.................. ABC0000\n")
                .as_deref(),
            Some("N3048EP-ON"),
        );
        // And one that labels neither still names itself.
        assert_eq!(
            model_of("System Description: Dell EMC Networking N2048\n").as_deref(),
            Some("N2048"),
        );
        assert_eq!(model_of("Cisco IOS Software, C2960X Software\n"), None);
    }

    #[test]
    fn vlans_are_read_past_the_code_markers() {
        let found = parse_vlans(VLANS);
        assert_eq!(found.len(), 3, "{found:#?}");
        // `* 1` is the default VLAN; the marker is not part of the number.
        assert_eq!(found[0].id, 1);
        assert_eq!(found[0].name, "", "it has no description, and none is not a name");
        assert_eq!(found[0].status, "Active");
        assert_eq!((found[1].id, found[1].name.as_str()), (10, "LabVoice"));
        assert_eq!(found[2].status, "Inactive");
        // A port list too long for one line wraps, and the second line is not
        // a VLAN of its own — it is the rest of VLAN 1's ports.
        assert_eq!(found[0].ports, vec!["Eth1/1/2-1/1/32", "1/1/40-1/1/48"]);
        assert_eq!(found[1].ports, vec!["Eth1/1/1"]);
    }

    #[test]
    fn bundles_carry_their_members_and_say_which_are_lacp() {
        let found = parse_port_channel_summary(BUNDLES);
        assert_eq!(found.len(), 2, "{found:#?}");
        assert_eq!(found[0].name, "port-channel22");
        assert_eq!(found[0].protocol, "-", "STATIC is what Cisco calls `on`");
        // A member that is down is still a cable.
        assert_eq!(found[0].members, vec!["1/1/2", "1/1/3"]);
        assert_eq!(found[1].protocol, "LACP");
        assert_eq!(found[1].members, vec!["1/1/4"]);
    }

    #[test]
    fn another_vendor_s_output_is_not_read_as_a_dell_s() {
        // Every one of these must find nothing rather than invent something:
        // a platform string can be wrong, and a parser that claims a table it
        // does not understand is worse than one that declines.
        let cisco_lldp = "Device ID: SW2\nLocal Intf: Gi0/1\nPort id: Gi0/2\n";
        let cisco_macs = "Vlan    Mac Address       Type        Ports\n----    -----------       --------    -----\n  10    0011.2233.4455    DYNAMIC     Gi0/1\n";
        assert!(parse_lldp_neighbors(cisco_lldp).is_empty());
        assert!(parse_vlans(cisco_lldp).is_empty());
        assert!(parse_port_channel_summary(cisco_lldp).is_empty());
        // The MAC table is the exception, and it is worth being precise about:
        // Cisco's column order is the same, so this reader takes that table
        // *correctly* rather than misreading it. Being a superset costs
        // nothing — it is only reached when Cisco's own reader found nothing —
        // and claiming it finds nothing here would be the false statement.
        let from_cisco = parse_mac_address_table(cisco_macs);
        assert_eq!(from_cisco.len(), 1);
        assert_eq!(from_cisco[0].mac, "001122334455");
        assert_eq!(from_cisco[0].port, "Gi0/1");
        for text in ["", "\n\n", "% Invalid input detected at '^' marker."] {
            assert!(parse_lldp_neighbors(text).is_empty());
            assert!(parse_mac_address_table(text).is_empty());
            assert!(parse_vlans(text).is_empty());
            assert!(parse_port_channel_summary(text).is_empty());
        }
    }
}
