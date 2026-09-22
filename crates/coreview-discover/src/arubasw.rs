//! ArubaOS-Switch tables, which are drawn rather than printed (LT-391).
//!
//! A crawl used to send this platform a fixed, Cisco-shaped set of commands
//! and get almost nothing back. From the operator's own debug log, on a
//! production 2930M — a real answer is thousands of bytes, a rejection is
//! about three hundred:
//!
//! ```text
//! ran `show lldp neighbors detail`   343 bytes, 2 lines    <- rejected
//! ran `show ip interface brief`      340 bytes, 2 lines    <- rejected
//! ran `show mac address-table`       335 bytes, 2 lines    <- rejected
//! ran `show vlan brief`              295 bytes, 2 lines    <- rejected
//! ```
//!
//! So the switch was reachable, logged into, and answering — and Coreview was
//! asking it half its questions in a language it does not speak. No
//! neighbours, no MAC table, no VLANs: a device on the diagram with nothing
//! attached to it.
//!
//! **Every table here has the same shape**, which is the whole reason this is
//! one module and not five parsers. A heading, a ruler of dashes that gives
//! the column widths exactly, then fixed-width rows:
//!
//! ```text
//!   LocalPort | ChassisId          PortId             PortDescr SysName
//!   --------- + ------------------ ------------------ --------- ------------------
//!   1/5       | 198.51.100.32      aa bb cc 00 11 22  WAN PORT  LAB-PHONE-1
//! ```
//!
//! **The ruler is load-bearing.** Splitting those rows on whitespace loses,
//! because `aa bb cc 00 11 22` and `WAN PORT` both contain spaces and an empty
//! cell contains nothing at all — a row would come apart into a different
//! number of pieces depending on which phone answered. Read by column, every
//! row is unambiguous.
//!
//! Written from output captured on a live 2930M at the operator's instruction
//! and used for validation only (D-027): every fixture below is invented, with
//! RFC 5737 addresses and names that exist nowhere.

use crate::arp::normalise_mac;
use crate::cdp::short_name;
use crate::types::{DeviceAddress, DeviceClass, Neighbor, Protocol};

/// Where a fixed-width table's columns are, and what they are called.
#[derive(Debug, Clone)]
pub struct Table {
    headings: Vec<String>,
    /// Character ranges, from the ruler. The last one runs to the end of the
    /// line: a value in the final column can be longer than its dashes.
    spans: Vec<(usize, usize)>,
}

impl Table {
    /// The first table in `text`, with the rows under it.
    ///
    /// Rows stop at the first blank line, which is how every one of these
    /// commands ends its output.
    pub fn find(text: &str) -> Option<(Table, Vec<&str>)> {
        let lines: Vec<&str> = text.lines().collect();
        let at = lines.iter().position(|l| is_ruler(l))?;
        let spans = spans_of(lines[at]);
        let heading_line = if at > 0 { lines[at - 1] } else { "" };
        let headings = spans
            .iter()
            .map(|&(a, b)| slice(heading_line, a, b, false).trim().to_string())
            .collect();
        let rows = lines[at + 1..]
            .iter()
            .take_while(|l| !l.trim().is_empty())
            .copied()
            .collect();
        Some((Table { headings, spans }, rows))
    }

    /// One cell, by the heading above it. An unknown heading is empty rather
    /// than an error: a firmware that drops a column should cost that column,
    /// not the whole table.
    pub fn cell(&self, row: &str, heading: &str) -> String {
        let Some(i) = self.headings.iter().position(|h| h == heading) else {
            return String::new();
        };
        let (a, b) = self.spans[i];
        let last = i + 1 == self.spans.len();
        slice(row, a, b, last).trim().to_string()
    }

    pub fn has(&self, heading: &str) -> bool {
        self.headings.iter().any(|h| h == heading)
    }
}

fn slice(line: &str, a: usize, b: usize, to_end: bool) -> String {
    let chars: Vec<char> = line.chars().collect();
    let end = if to_end { chars.len() } else { b.min(chars.len()) };
    if a >= chars.len() {
        return String::new();
    }
    chars[a..end.max(a)].iter().collect()
}

/// A ruler: dashes, pluses and spaces, with at least two columns of dashes.
///
/// The `+` sits where a `|` divides the heading, and is skipped for free by
/// looking only at runs of dashes.
fn is_ruler(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty()
        && trimmed.chars().all(|c| c == '-' || c == '+' || c == ' ')
        && spans_of(line).len() >= 2
}

fn spans_of(ruler: &str) -> Vec<(usize, usize)> {
    let chars: Vec<char> = ruler.chars().collect();
    let mut spans = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '-' {
            let start = i;
            while i < chars.len() && chars[i] == '-' {
                i += 1;
            }
            // A single dash is punctuation in a name, not a column.
            if i - start >= 2 {
                spans.push((start, i));
            }
        } else {
            i += 1;
        }
    }
    spans
}

/// Whether this output came from an ArubaOS-Switch rather than a Cisco.
///
/// Used to decide which parser to hand a capture to when the platform string
/// is not to hand.
pub fn is_aruba_table(out: &str) -> bool {
    out.contains("LLDP Remote Devices Information")
        || out.contains("Status and Counters - Port Address Table")
        || out.contains("Status and Counters - VLAN Information")
        || out.contains("CDP neighbors information")
}

/// `show lldp info remote-device`.
///
/// One switch port can hold several rows — a phone with a workstation behind
/// it answers on both, and the phone answers twice, once for its own chassis
/// and once for its address.
pub fn parse_lldp_remote_devices(out: &str) -> Vec<Neighbor> {
    let Some((table, rows)) = Table::find(out) else {
        return Vec::new();
    };
    if !table.has("ChassisId") {
        return Vec::new();
    }
    rows.iter()
        .filter_map(|row| {
            let local = table.cell(row, "LocalPort");
            let chassis = table.cell(row, "ChassisId");
            if local.is_empty() || chassis.is_empty() {
                return None;
            }
            let sys_name = table.cell(row, "SysName");
            let port_id = table.cell(row, "PortId");
            let port_descr = table.cell(row, "PortDescr");
            Some(neighbour_from(
                &chassis,
                &sys_name,
                &local,
                // The readable port where there is one; `PortId` is often a
                // MAC, which is no use as a label.
                if port_descr.is_empty() { &port_id } else { &port_descr },
                None,
                &[],
                Protocol::Lldp,
            ))
        })
        .collect()
}

/// `show cdp neighbors` — this platform's own CDP table, which is not Cisco's.
///
/// Cisco's `show cdp neighbors detail` prints a paragraph per neighbour;
/// this prints the same fixed-width table as everything else, with the
/// platform truncated to fit its column.
pub fn parse_cdp_neighbors(out: &str) -> Vec<Neighbor> {
    let Some((table, rows)) = Table::find(out) else {
        return Vec::new();
    };
    if !table.has("Device ID") {
        return Vec::new();
    }
    rows.iter()
        .filter_map(|row| {
            let local = table.cell(row, "Port");
            let device_id = table.cell(row, "Device ID");
            if local.is_empty() || device_id.is_empty() {
                return None;
            }
            let platform = table.cell(row, "Platform");
            let capability = table.cell(row, "Capability");
            let caps: Vec<String> = capability
                .split_whitespace()
                .filter_map(|c| capability_word(c).map(str::to_string))
                .collect();
            Some(neighbour_from(
                &device_id,
                "",
                &local,
                "",
                // A platform truncated to fit its column is still worth
                // keeping — it names the model.
                (!platform.is_empty()).then(|| platform.clone()),
                &caps,
                Protocol::Cdp,
            ))
        })
        .collect()
}

/// The single letters this platform uses for CDP capabilities.
fn capability_word(letter: &str) -> Option<&'static str> {
    Some(match letter {
        "R" => "Router",
        "T" => "Trans-Bridge",
        "B" => "Source-Route-Bridge",
        "S" => "Switch",
        "H" => "Host",
        "I" => "IGMP",
        "r" => "Repeater",
        "P" => "Phone",
        _ => return None,
    })
}

/// Builds a neighbour from whichever of the two tables found it.
///
/// `id` is the chassis id or device id, and is any of three things: a MAC
/// written `aabbcc-001122` or `aa bb cc 00 11 22`, an address, or a name the
/// device gave itself. Each is worth something different, so each is put
/// where it belongs rather than all three into the label.
#[allow(clippy::too_many_arguments)]
fn neighbour_from(
    id: &str,
    sys_name: &str,
    local_interface: &str,
    remote_interface: &str,
    platform: Option<String>,
    capabilities: &[String],
    discovered_by: Protocol,
) -> Neighbor {
    let as_mac = normalise_mac(id).or_else(|| spaced_mac(id));
    let as_address: Option<std::net::Ipv4Addr> = id.parse().ok();

    // The name it calls itself, then the address, then the chassis — a MAC is
    // a label of last resort but it is better than an empty box.
    let device_id = if !sys_name.is_empty() {
        sys_name.to_string()
    } else {
        id.to_string()
    };

    let addresses = as_address
        .map(|ip| {
            vec![DeviceAddress {
                ip: ip.to_string(),
                interface: None,
                // What a phone or an access point advertises over LLDP *is*
                // its management address; there is no other kind in this
                // table.
                is_management: true,
            }]
        })
        .unwrap_or_default();

    let class = class_from(&capabilities.iter().map(String::as_str).collect::<Vec<_>>());

    Neighbor {
        serial: None,
        short_name: short_name(&device_id),
        device_id,
        addresses,
        local_interface: (!local_interface.is_empty()).then(|| local_interface.to_string()),
        remote_interface: (!remote_interface.is_empty()).then(|| remote_interface.to_string()),
        platform,
        capabilities: capabilities.to_vec(),
        version: None,
        class,
        discovered_by,
        vendor: as_mac.as_deref().and_then(crate::oui::vendor).map(str::to_string),
        chassis_id: as_mac,
    }
}

/// `aa bb cc 00 11 22`, which is how this platform writes a MAC in its CDP
/// table. `normalise_mac` requires a separator that is not a space, on purpose
/// — a hostname with spaces would otherwise pass — so this is checked apart.
fn spaced_mac(raw: &str) -> Option<String> {
    let parts: Vec<&str> = raw.split_whitespace().collect();
    if parts.len() != 6 || !parts.iter().all(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_hexdigit())) {
        return None;
    }
    Some(parts.concat().to_ascii_lowercase())
}

fn class_from(caps: &[&str]) -> DeviceClass {
    // Order matters: a layer-3 switch advertises both, and what it does for
    // the diagram is route.
    if caps.contains(&"Router") {
        DeviceClass::Router
    } else if caps.contains(&"Switch") {
        DeviceClass::Switch
    } else if caps.contains(&"Phone") || caps.contains(&"Host") {
        DeviceClass::Endpoint
    } else {
        DeviceClass::Unknown
    }
}

/// `show mac-address`.
pub fn parse_mac_address_table(out: &str) -> Vec<crate::mac_table::MacEntry> {
    let Some((table, rows)) = Table::find(out) else {
        return Vec::new();
    };
    if !table.has("MAC Address") {
        return Vec::new();
    }
    rows.iter()
        .filter_map(|row| {
            let mac = normalise_mac(&table.cell(row, "MAC Address"))?;
            let port = table.cell(row, "Port");
            if port.is_empty() {
                return None;
            }
            let vlan = table.cell(row, "VLAN");
            Some(crate::mac_table::MacEntry {
                mac,
                port,
                vlan: (!vlan.is_empty()).then_some(vlan),
            })
        })
        .collect()
}

/// `show vlans`.
pub fn parse_vlans(out: &str) -> Vec<crate::vlans::Vlan> {
    let Some((table, rows)) = Table::find(out) else {
        return Vec::new();
    };
    if !table.has("VLAN ID") {
        return Vec::new();
    }
    rows.iter()
        .filter_map(|row| {
            let id: u16 = table.cell(row, "VLAN ID").parse().ok()?;
            Some(crate::vlans::Vlan {
                id,
                name: table.cell(row, "Name"),
                status: table.cell(row, "Status"),
                // This table says nothing about ports; `show mac-address` and
                // the MAC table are where a port's VLAN comes from.
                ports: Vec::new(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Invented throughout (D-027): RFC 5737 addresses, names that exist
    // nowhere, and MACs from the documentation range. Only the *shape* is
    // taken from the hardware.
    const LLDP: &str = "\
 LLDP Remote Devices Information

  LocalPort | ChassisId          PortId             PortDescr SysName
  --------- + ------------------ ------------------ --------- ------------------
  1/3       | aabbcc-001122      1                  1         LAB-ACCESS-1
  1/5       | PHONE0011AABBCC    WAN PORT                     LABPHONE
  1/5       | 198.51.100.32      aa bb cc 00 11 33  WAN PORT  LAB-PHONE-A
  1/6       | ddeeff-445566      Port 1             Port 1    LAB-EDGE-9
  1/9       | LAB-DESK-7         aa bb cc 00 11 44

";

    const CDP: &str = "\
 CDP neighbors information

  Port   Device ID                     | Platform                     Capability
  ------ ----------------------------- + ---------------------------- -----------
  1/3    aa bb cc 00 11 22             | Example JX999A 1010M-48G-... S
  1/5    PHONE0011AABBCC               | LABPHONE                     H P
  1/6    78 45 58 ef 67 3c             | LAB-EDGE-9, 1.2.3.4...       R S
  1/9    LAB-DESK-7                    |

";

    const MACS: &str = "\
 Status and Counters - Port Address Table

  MAC Address       Port                            VLAN
  ----------------- ------------------------------- ----
  aabbcc-001122     Trk1                            10
  aabbcc-001133     1/3                             20
  ddeeff-445566     2/21                            207

";

    const VLANS: &str = "\
 Status and Counters - VLAN Information

  Maximum VLANs to support : 256
  Primary VLAN : DEFAULT_VLAN
  Management VLAN :

  VLAN ID Name                             | Status     Voice Jumbo
  ------- -------------------------------- + ---------- ----- -----
  1       DEFAULT_VLAN                     | Port-based No    No
  10      LabVoice                         | Port-based No    No
  207     LabData                          | Port-based No    No

";

    #[test]
    fn the_ruler_gives_the_columns_and_the_plus_is_not_one() {
        let ruler = "  --------- + ------------------ --------- ";
        assert_eq!(spans_of(ruler).len(), 3, "the + divides, it does not count");
        assert!(is_ruler(ruler));
        assert!(!is_ruler("  1/3       | aabbcc-001122"));
        assert!(!is_ruler(""));
        // One run of dashes is a line, not a table.
        assert!(!is_ruler("--------------------"));
    }

    #[test]
    fn a_cell_with_spaces_in_it_survives() {
        // The reason this is read by column and not by whitespace: two of
        // these five cells contain spaces and one is empty, so the row would
        // come apart into a different number of pieces every time.
        let (table, rows) = Table::find(LLDP).expect("a table");
        let phone = rows.iter().find(|r| r.contains("198.51.100.32")).expect("the row");
        assert_eq!(table.cell(phone, "LocalPort"), "1/5");
        assert_eq!(table.cell(phone, "ChassisId"), "198.51.100.32");
        assert_eq!(table.cell(phone, "PortId"), "aa bb cc 00 11 33");
        assert_eq!(table.cell(phone, "PortDescr"), "WAN PORT");
        assert_eq!(table.cell(phone, "SysName"), "LAB-PHONE-A");

        let bare = rows.iter().find(|r| r.contains("LAB-DESK-7")).expect("the row");
        assert_eq!(table.cell(bare, "PortDescr"), "", "an empty cell is empty");
        assert_eq!(table.cell(bare, "SysName"), "");
    }

    #[test]
    fn lldp_neighbours_are_read_off_the_table() {
        let found = parse_lldp_remote_devices(LLDP);
        assert_eq!(found.len(), 5, "one per row: {found:#?}");

        let switch = &found[0];
        assert_eq!(switch.device_id, "LAB-ACCESS-1", "the name it gave itself");
        assert_eq!(switch.local_interface.as_deref(), Some("1/3"));
        assert_eq!(switch.remote_interface.as_deref(), Some("1"));
        assert_eq!(switch.chassis_id.as_deref(), Some("aabbcc001122"));

        // A row whose chassis is an address: that address is the point of it.
        let phone = found.iter().find(|n| n.device_id == "LAB-PHONE-A").expect("the phone");
        assert_eq!(phone.addresses.len(), 1);
        assert_eq!(phone.addresses[0].ip, "198.51.100.32");
        assert_eq!(phone.remote_interface.as_deref(), Some("WAN PORT"));

        // A row with no SysName falls back to what it did advertise.
        let desk = found.iter().find(|n| n.device_id == "LAB-DESK-7").expect("the desk");
        assert_eq!(desk.local_interface.as_deref(), Some("1/9"));
        assert!(desk.addresses.is_empty());
    }

    #[test]
    fn cdp_neighbours_are_read_off_the_table_too() {
        let found = parse_cdp_neighbors(CDP);
        assert_eq!(found.len(), 4, "{found:#?}");

        // A MAC written with spaces, which `normalise_mac` refuses on purpose.
        let first = &found[0];
        assert_eq!(first.chassis_id.as_deref(), Some("aabbcc001122"));
        assert_eq!(first.local_interface.as_deref(), Some("1/3"));
        assert_eq!(first.class, DeviceClass::Switch, "S is a switch");
        assert!(first.platform.as_deref().unwrap().starts_with("Example JX999A"));

        let phone = &found[1];
        assert_eq!(phone.capabilities, vec!["Host", "Phone"]);

        let edge = &found[2];
        assert_eq!(edge.class, DeviceClass::Router, "R wins over S");
        assert_eq!(edge.vendor.as_deref(), Some("Ubiquiti"), "from the OUI");

        // No platform and no capability is still a neighbour on a port.
        let bare = &found[3];
        assert_eq!(bare.device_id, "LAB-DESK-7");
        assert!(bare.platform.is_none());
        assert_eq!(bare.class, DeviceClass::Unknown);
    }

    #[test]
    fn the_mac_table_is_read_including_a_trunk() {
        let found = parse_mac_address_table(MACS);
        assert_eq!(found.len(), 3);
        assert_eq!(found[0].mac, "aabbcc001122");
        assert_eq!(found[0].port, "Trk1", "a link aggregation, not a physical port");
        assert_eq!(found[0].vlan.as_deref(), Some("10"));
        assert_eq!(found[2].port, "2/21", "a port on the second stack member");
    }

    #[test]
    fn vlans_are_read_past_the_summary_above_them() {
        // Three lines of `Maximum VLANs to support`-style summary sit between
        // the heading and the table, and none of them is a ruler.
        let found = parse_vlans(VLANS);
        assert_eq!(found.len(), 3);
        assert_eq!(found[0].id, 1);
        assert_eq!(found[0].name, "DEFAULT_VLAN");
        assert_eq!(found[0].status, "Port-based");
        assert_eq!(found[2].id, 207);
        assert_eq!(found[2].name, "LabData");
    }

    #[test]
    fn a_cisco_answer_is_not_read_as_an_aruba_one() {
        // Every one of these parsers is reached from a platform arm, but a
        // platform string can be wrong, and reading a Cisco table by Aruba
        // column positions would invent neighbours rather than find none.
        let cisco = "Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID\n\
                     SW2              Gig 0/1           156        S I         WS-C2960  Gig 0/2\n";
        assert!(parse_lldp_remote_devices(cisco).is_empty());
        assert!(parse_cdp_neighbors(cisco).is_empty());
        assert!(parse_mac_address_table(cisco).is_empty());
        assert!(parse_vlans(cisco).is_empty());
        assert!(!is_aruba_table(cisco));
    }

    #[test]
    fn a_rejected_command_yields_nothing_rather_than_a_guess() {
        // What this platform says when it does not know a command. Roughly
        // three hundred bytes, no ruler, and nothing that can be read as a
        // table — which is what the debug log showed for six commands.
        let refused = " Invalid input: vlan\n";
        let help = " [ethernet] PORT-LIST  Show MAC addresses learned on the specified port.\n \
                     detail                Show details including age.\n";
        for text in [refused, help, "", "\n\n"] {
            assert!(parse_lldp_remote_devices(text).is_empty());
            assert!(parse_mac_address_table(text).is_empty());
            assert!(parse_vlans(text).is_empty());
        }
    }

    #[test]
    fn the_shape_is_recognised_without_being_told_the_platform() {
        assert!(is_aruba_table(LLDP));
        assert!(is_aruba_table(CDP));
        assert!(is_aruba_table(MACS));
        assert!(is_aruba_table(VLANS));
    }
}
