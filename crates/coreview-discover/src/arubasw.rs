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

    /// The `nth` cell whose heading is `heading`, counting from zero (LT-395).
    ///
    /// `show trunks` heads two columns `Type`: the port's media, then the
    /// bundle's protocol. By name alone the second is unreachable.
    pub fn cell_nth(&self, row: &str, heading: &str, nth: usize) -> String {
        let Some(i) = self
            .headings
            .iter()
            .enumerate()
            .filter(|(_, h)| *h == heading)
            .nth(nth)
            .map(|(i, _)| i)
        else {
            return String::new();
        };
        let (a, b) = self.spans[i];
        slice(row, a, b, i + 1 == self.spans.len()).trim().to_string()
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

/// Whether `show version` came from ArubaOS-Switch (LT-395).
///
/// Its `show version` never says "Aruba" — it is an image stamp, a firmware
/// string and a boot ROM — which is why every platform arm keyed on the word
/// "aruba" missed a 2930M and asked it Cisco's questions instead. The image
/// stamp and the boot ROM line together are the platform's own signature.
pub fn is_arubaos_switch(version: &str) -> bool {
    let v = version.to_ascii_lowercase();
    v.contains("image stamp") && v.contains("boot rom version")
}

/// `show trunks`: each bundle, its protocol, and its member ports.
///
/// A port in a trunk is written `1/45`; the bundle is `Trk45`. The second
/// `Type` column is the protocol — `Trunk` for a static bundle, `LACP` for a
/// negotiated one — and a static one is recorded as `-`, which is how the
/// Cisco side records "on".
pub fn parse_trunks(out: &str) -> Vec<crate::etherchannel::PortChannel> {
    let Some((table, rows)) = Table::find(out) else {
        return Vec::new();
    };
    if !table.has("Group") {
        return Vec::new();
    }
    let mut bundles: Vec<crate::etherchannel::PortChannel> = Vec::new();
    for row in rows {
        let port = table.cell(row, "Port");
        let group = table.cell(row, "Group");
        if port.is_empty() || group.is_empty() {
            continue;
        }
        let kind = table.cell_nth(row, "Type", 1);
        let protocol = if kind.eq_ignore_ascii_case("lacp") { "LACP" } else { "-" }.to_string();
        match bundles.iter_mut().find(|b| b.name == group) {
            Some(b) => b.members.push(port),
            None => bundles.push(crate::etherchannel::PortChannel {
                name: group,
                protocol,
                members: vec![port],
            }),
        }
    }
    bundles
}

/// `show ip`: the switch's own addresses, one per VLAN that has one.
///
/// A VLAN with no address is not an interface worth probing, and a row that
/// says `DHCP/Bootp` with nothing after it is a VLAN still waiting for a lease.
pub fn parse_show_ip(out: &str) -> Vec<crate::interfaces::Interface> {
    let Some((table, rows)) = Table::find(out) else {
        return Vec::new();
    };
    if !table.has("IP Address") {
        return Vec::new();
    }
    rows.iter()
        .filter_map(|row| {
            let name = table.cell(row, "VLAN");
            let address = table.cell(row, "IP Address");
            if name.is_empty() || address.parse::<std::net::Ipv4Addr>().is_err() {
                return None;
            }
            // Nothing in this table says whether the VLAN is up; an address
            // the switch holds is one it answers on, which is what `up`
            // decides — whether the address is worth probing.
            Some(crate::interfaces::Interface { name, address: Some(address), up: true })
        })
        .collect()
}

/// `show ip`'s `Default Gateway` line: the way out, on a switch that does not
/// route and so has no default route to read one from.
pub fn default_gateway(out: &str) -> Option<String> {
    out.lines().find_map(|l| {
        let (key, value) = l.split_once(':')?;
        if key.trim().eq_ignore_ascii_case("default gateway") {
            let v = value.trim();
            v.parse::<std::net::Ipv4Addr>().ok().map(|_| v.to_string())
        } else {
            None
        }
    })
}

/// `show interfaces brief`: every port, and whether it is up.
///
/// Written in the words the rest of the app already reads — `connected`,
/// `notconnect`, `disabled` — rather than this platform's `Up` and `Down`, so
/// nothing downstream has to know which vendor it came from. A port in a
/// bundle is written `1/45-Trk45`; the port is `1/45`.
pub fn parse_interfaces_brief(out: &str) -> Vec<crate::vlans::PortStatus> {
    let Some((table, rows)) = Table::find(out) else {
        return Vec::new();
    };
    if !table.has("Enabled") || !table.has("Status") {
        return Vec::new();
    }
    rows.iter()
        .filter_map(|row| {
            let raw = table.cell(row, "Port");
            let port = raw.split('-').next().unwrap_or("").trim().to_string();
            if port.is_empty() {
                return None;
            }
            let enabled = table.cell(row, "Enabled");
            let up = table.cell(row, "Status");
            let status = if enabled.eq_ignore_ascii_case("no") {
                "disabled"
            } else if up.eq_ignore_ascii_case("up") {
                "connected"
            } else {
                "notconnect"
            };
            // `1000FDx`: a speed, then full or half duplex.
            let mode = table.cell_nth(row, "Mode", 0);
            let (speed, duplex) = match mode.find(|c: char| !c.is_ascii_digit()) {
                Some(at) if at > 0 => {
                    let d = &mode[at..];
                    let duplex = if d.starts_with("FD") { "full" } else if d.starts_with("HD") { "half" } else { "" };
                    (mode[..at].to_string(), duplex.to_string())
                }
                _ => (mode.clone(), String::new()),
            };
            Some(crate::vlans::PortStatus {
                port,
                description: String::new(),
                status: status.to_string(),
                vlan: String::new(),
                duplex,
                speed,
                media: table.cell(row, "Type"),
            })
        })
        .collect()
}

/// `show stacking detail`: the members of a backplane stack, with serials.
///
/// A block of `Key : value` lines per member, each starting `Member ID`. The
/// summary table `show stacking` prints has no serials, and the serial is the
/// number a support contract and an RMA are keyed on — so the detail is what
/// is asked for.
pub fn parse_stacking_detail(out: &str) -> Option<crate::stacking::StackInfo> {
    // `Member ID` alone is too common a phrase to claim a text on; the stack's
    // own header is not.
    if !out.contains("Stack ID") && !out.contains("Stack Status") {
        return None;
    }
    let mut members: Vec<crate::stacking::StackMember> = Vec::new();
    for line in out.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim().to_string();
        let set = |v: &str| (!v.is_empty()).then(|| v.to_string());
        if key == "member id" {
            members.push(crate::stacking::StackMember {
                id: value,
                role: None,
                state: None,
                model: None,
                serial: None,
                mac: None,
                priority: None,
            });
            continue;
        }
        let Some(m) = members.last_mut() else { continue };
        match key.as_str() {
            "mac address" => m.mac = set(&value),
            "model" => m.model = set(&value),
            "priority" => m.priority = set(&value),
            "status" => m.role = set(&value),
            "serial number" => m.serial = set(&value),
            _ => {}
        }
    }
    (!members.is_empty()).then(|| crate::stacking::StackInfo::backplane(members))
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
    // ---------------------------------------------------------------- LT-395
    // Shapes from a production 2930M-48G-PoE+ stack, every value invented.

    const VERSION: &str = "\
Image stamp:    /ws/swbuildm/rel_example/code/build/bom(swbuildm_rel_example)
                Jan  1 2026 00:00:00
                WC.16.10.0009
                4096
Boot Image:     Primary
Boot ROM Version:    WC.17.02.0006
Active Boot ROM:     Primary
";

    const TRUNKS: &str = "

  Port   | Name                             Type       | Group Type    
  ------ + -------------------------------- ---------- + ----- --------
  1/45   | LabPhones                        100/1000T  | Trk45 Trunk   
  1/48   | Uplink-Lab                       100/1000T  | Trk1  LACP    
  2/45   |                                  100/1000T  | Trk45 Trunk   
  2/48   | Uplink-Lab                       100/1000T  | Trk1  LACP    
 
";

    const SHOW_IP: &str = "
 Internet (IP) Service

  IP Routing : Disabled

  Default Gateway : 192.0.2.254    
  Default TTL     : 64   

                       |                                            Proxy ARP 
  VLAN                 | IP Config  IP Address      Subnet Mask     Std  Local
  -------------------- + ---------- --------------- --------------- ----------
  DEFAULT_VLAN         | DHCP/Bootp
  LabVoice             | Disabled 
  LabUsers             | Manual     192.0.2.1       255.255.255.0    No    No
  LabData              | DHCP/Bootp 198.51.100.10   255.255.255.0    No    No
 
";

    const PORTS: &str = "
 Status and Counters - Port Status

                          | Intrusion                           MDI  Flow Bcast
  Port         Type       | Alert     Enabled Status Mode       Mode Ctrl Limit
  ------------ ---------- + --------- ------- ------ ---------- ---- ---- -----
  1/1          100/1000T  | No        Yes     Down   1000FDx    NA   off  0    
  1/3          100/1000T  | No        Yes     Up     1000FDx    MDIX off  0    
  1/10         100/1000T  | No        Yes     Up     100FDx     MDIX off  0    
  1/12         100/1000T  | No        No      Down   1000FDx    NA   off  0    
  1/45-Trk45   100/1000T  | No        Yes     Down   1000FDx    NA   off  0    
  2/48-Trk1    100/1000T  | No        Yes     Up     1000FDx    MDIX off  0    
 
";

    const STACK: &str = "
Stack ID         : 0500aabb-cc000000
MAC Address      : aabbcc-000007
Stack Topology   : Ring
Stack Status     : Active
Software Version : WC.16.10.0009

Name             : LAB-STACK-1
Contact          : 
Location         : 


Member ID        : 1 
Mac Address      : aabbcc-000000    
Type             : JL322A
Model            : Aruba JL322A 2930M-48G-PoE+ Switch                          
Priority         : 255
Status           : Commander      
Serial Number    : LAB0000001                                                   
Stack Ports - 
#1 : Active, Peer member 2              


Member ID        : 2 
Mac Address      : aabbcc-000100    
Model            : Aruba JL322A 2930M-48G-PoE+ Switch                          
Priority         : 254
Status           : Standby        
Serial Number    : LAB0000002                                                   
";

    #[test]
    fn the_platform_is_recognised_though_it_never_says_aruba() {
        assert!(is_arubaos_switch(VERSION));
        assert!(!is_arubaos_switch("Cisco IOS Software, C2960CX Software, Version 15.2(7)E"));
        assert_eq!(crate::stacking::commands_for(VERSION), &["show stacking detail"]);
    }

    #[test]
    fn trunks_are_bundles_with_their_members_and_protocol() {
        // Two columns are both headed `Type`: the second is the protocol.
        let found = parse_trunks(TRUNKS);
        assert_eq!(found.len(), 2, "{found:#?}");
        let static_ = found.iter().find(|b| b.name == "Trk45").expect("Trk45");
        assert_eq!(static_.members, vec!["1/45", "2/45"], "a member with no name still counts");
        assert_eq!(static_.protocol, "-", "a static bundle reads as Cisco's `on`");
        let lacp = found.iter().find(|b| b.name == "Trk1").expect("Trk1");
        assert_eq!(lacp.protocol, "LACP");
        assert_eq!(lacp.members, vec!["1/48", "2/48"]);
    }

    #[test]
    fn the_switch_s_own_addresses_come_from_show_ip() {
        let found = parse_show_ip(SHOW_IP);
        let names: Vec<_> = found.iter().map(|i| (i.name.as_str(), i.address.as_deref())).collect();
        // A VLAN with no address, and one still waiting on DHCP, are not
        // addresses to probe.
        assert_eq!(names, vec![("LabUsers", Some("192.0.2.1")), ("LabData", Some("198.51.100.10"))]);
        assert_eq!(default_gateway(SHOW_IP).as_deref(), Some("192.0.2.254"));
        assert_eq!(default_gateway("  Default Gateway :   \n"), None);
    }

    #[test]
    fn ports_are_read_in_the_words_the_rest_of_the_app_uses() {
        let found = parse_interfaces_brief(PORTS);
        assert_eq!(found.len(), 6);
        let by = |p: &str| found.iter().find(|x| x.port == p).unwrap_or_else(|| panic!("{p} missing"));
        assert_eq!(by("1/3").status, "connected");
        assert_eq!(by("1/1").status, "notconnect");
        assert_eq!(by("1/12").status, "disabled", "switched off beats down");
        assert_eq!((by("1/10").speed.as_str(), by("1/10").duplex.as_str()), ("100", "full"));
        // `1/45-Trk45` is port 1/45, in a bundle.
        assert_eq!(by("1/45").status, "notconnect");
        assert_eq!(by("2/48").status, "connected");
        assert_eq!(by("1/3").media, "100/1000T");
    }

    #[test]
    fn a_stack_is_its_members_with_their_serials() {
        let stack = parse_stacking_detail(STACK).expect("a stack");
        assert_eq!(stack.kind, crate::stacking::StackKind::ArubaStack);
        assert!(!stack.unverified, "met real hardware — the only family that has");
        assert!(stack.kind.draws_as_one_node(), "a backplane stack is one switch");
        assert_eq!(stack.members.len(), 2);
        let (a, b) = (&stack.members[0], &stack.members[1]);
        assert_eq!((a.id.as_str(), a.role.as_deref(), a.serial.as_deref()), ("1", Some("Commander"), Some("LAB0000001")));
        assert_eq!((b.id.as_str(), b.role.as_deref(), b.serial.as_deref()), ("2", Some("Standby"), Some("LAB0000002")));
        assert_eq!(a.mac.as_deref(), Some("aabbcc-000000"));
        assert_eq!(a.priority.as_deref(), Some("255"));
        // And the dispatcher the crawl uses finds it too.
        assert!(crate::stacking::parse_any(STACK).is_some());
    }

    #[test]
    fn a_standalone_switch_or_another_platform_is_not_a_stack() {
        assert!(parse_stacking_detail(" Stacking is disabled.\n").is_none());
        assert!(parse_stacking_detail("Member ID  Status   Serial No    Model\n0 (FPC 0)  Prsnt  AB12  ex2300\n").is_none());
        assert!(parse_trunks(PORTS).is_empty());
        assert!(parse_show_ip(TRUNKS).is_empty());
        assert!(parse_interfaces_brief(SHOW_IP).is_empty());
    }
}
