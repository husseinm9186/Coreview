//! Wireless controllers: the access points they manage.
//!
//! An access point is reached through its controller, not logged into. A
//! controller's AP table names each AP, its model and its address, and that
//! is what this reads: each AP becomes a neighbour the controller
//! *reported*, classified as an access point. The cable from the AP to its
//! switch port is drawn from the switch's own CDP or LLDP table, which every
//! AP that speaks either already appears in; the controller's own CDP
//! table is not read yet.
//!
//! **Built from Cisco's and Aruba's documentation and posted sessions, not
//! from a controller.** Fixtures reconstructed;
//! [`verified_against_hardware`] says `false` until one is a capture.
//!
//! One reader for four tables, because they are one shape — a header row
//! naming the columns, a row of dashes, then a row per AP:
//!
//! - AireOS `show ap summary` — `AP Name`, `AP Model`, `IP Address`.
//! - Catalyst 9800 `show ap summary` — the same headings, wider.
//! - ArubaOS 8 `show ap database` — `Name`, `AP Type`, `IP Address`.
//! - Aruba Instant `show aps` — `Name`, `Type`, `IP Address`.
//!
//! Identity: AireOS `show sysinfo` names the product and `show inventory`
//! the PID and serial; a 9800 is IOS-XE and reads as one; an Aruba
//! controller's `show version` prints `ArubaOS (MODEL: Aruba7005)` and
//! `show inventory` its serial.

use crate::types::{DeviceAddress, DeviceClass, Neighbor, Protocol};

/// This platform has not met a device.
pub fn verified_against_hardware() -> bool {
    false
}

/// `PID: AIR-CT3504-K9,  VID: V02,  SN: FCH1234ABCD` in `show inventory`,
/// the first such line: the chassis.
pub fn inventory_identity(inventory: &str) -> (Option<String>, Vec<String>) {
    for line in inventory.lines() {
        let t = line.trim();
        if !t.starts_with("PID:") {
            continue;
        }
        let mut model = None;
        let mut serial = None;
        for part in t.split(',') {
            if let Some((k, v)) = part.trim().split_once(':') {
                match k.trim() {
                    "PID" => model = Some(v.trim().to_ascii_uppercase()).filter(|m| !m.is_empty()),
                    "SN" => serial = Some(v.trim().to_string()).filter(|s| !s.is_empty()),
                    _ => {}
                }
            }
        }
        return (model, serial.into_iter().collect());
    }
    (None, Vec::new())
}

/// `ArubaOS (MODEL: Aruba7005), Version 8.10.0.9`: the model in brackets.
pub fn aruba_model_of(version: &str) -> Option<String> {
    let at = version.find("(MODEL:")?;
    let rest = &version[at + "(MODEL:".len()..];
    let model = rest.split(')').next()?.trim();
    (!model.is_empty()).then(|| model.to_ascii_uppercase())
}

/// Where each heading starts in a header row: a character preceded by two
/// spaces, or the first. `AP Name` and `IP Address` keep their one space.
fn heading_starts(header: &str) -> Vec<usize> {
    let b = header.as_bytes();
    (0..b.len())
        .filter(|&i| !b[i].is_ascii_whitespace() && (i == 0 || (b[i - 1] == b' ' && (i == 1 || b[i - 2] == b' '))))
        .collect()
}

/// `Serial#: CV0001234` or `Serial Number: …` in an Aruba controller's
/// `show inventory`, each once.
pub fn aruba_serials_of(inventory: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in inventory.lines() {
        let t = line.trim();
        for label in ["Serial#:", "Serial Number:", "System Serial#:"] {
            if let Some(at) = t.find(label) {
                let v = t[at + label.len()..].split_whitespace().next().unwrap_or("").to_string();
                if !v.is_empty() && !out.contains(&v) {
                    out.push(v);
                }
                break;
            }
        }
    }
    out
}

fn cell(row: &str, start: usize, end: Option<usize>) -> String {
    let chars: Vec<char> = row.chars().collect();
    let end = end.unwrap_or(chars.len()).min(chars.len());
    if start >= end {
        return String::new();
    }
    chars[start..end].iter().collect::<String>().trim().to_string()
}

/// The access points in a controller's table, as neighbours the controller
/// reported. The headings are found by name, so the four layouts read alike.
pub fn parse_ap_table(out: &str) -> Vec<Neighbor> {
    let lines: Vec<&str> = out.lines().collect();
    let Some(at) = lines.iter().position(|l| (l.contains("AP Name") || l.trim_start().starts_with("Name")) && l.contains("IP Address")) else {
        return Vec::new();
    };
    let header = lines[at];
    let name_col = header.find("AP Name").or_else(|| header.find("Name"));
    let model_col = header.find("AP Model").or_else(|| header.find("AP Type")).or_else(|| header.find("Type"));
    let ip_col = header.find("IP Address");
    let (Some(name_col), Some(ip_col)) = (name_col, ip_col) else { return Vec::new() };
    let starts = heading_starts(header);
    let end_of = |start: usize| starts.iter().find(|s| **s > start).copied();
    lines[at + 1..]
        .iter()
        .filter(|l| !l.trim().is_empty() && !l.trim().starts_with('-'))
        .filter_map(|row| {
            let name = cell(row, name_col, end_of(name_col));
            let ip = cell(row, ip_col, end_of(ip_col));
            let model = model_col.map(|c| cell(row, c, end_of(c))).filter(|m| !m.is_empty() && m != "-");
            if name.is_empty() || name.starts_with('-') {
                return None;
            }
            let addresses = ip
                .split_whitespace()
                .next()
                .filter(|a| a.parse::<std::net::Ipv4Addr>().is_ok())
                .map(|a| vec![DeviceAddress { ip: a.to_string(), interface: None, is_management: true }])
                .unwrap_or_default();
            Some(Neighbor {
                serial: None,
                short_name: name.clone(),
                device_id: name,
                addresses,
                local_interface: None,
                remote_interface: None,
                platform: model.clone().map(|m| m.to_ascii_uppercase()),
                capabilities: Vec::new(),
                version: None,
                class: DeviceClass::AccessPoint,
                discovered_by: Protocol::Controller,
                vendor: None,
                chassis_id: None,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reconstructed from Cisco's and Aruba's documentation, not captured.
    const AIREOS: &str = "Number of APs.................................... 2\nGlobal AP User Name.............................. admin\nGlobal AP Dot1x User Name........................ Not Configured\n\nAP Name             Slots  AP Model              Ethernet MAC       Location          Country  IP Address       Clients   DSE Location\n------------------  -----  --------------------  -----------------  ----------------  -------  ---------------  --------  ------------\nAP-LOBBY            2      AIR-AP2802I-E-K9      00:aa:bb:cc:dd:01  Lobby             GB       10.0.20.11       3         [0 ,0 ,0 ]\nAP-FLOOR2-EAST      2      AIR-AP1852I-E-K9      00:aa:bb:cc:dd:02  Floor 2 east      GB       10.0.20.12       0         [0 ,0 ,0 ]\n";
    const C9800: &str = "Number of APs: 1\n\nAP Name                            Slots    AP Model              Ethernet MAC    Radio MAC       Location                          Country     IP Address                                 State\n---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------\nAP-LOBBY                           2        C9120AXI-E            00aa.bbcc.dd01  00aa.bbcc.dd10  default location                  GB          10.0.20.11                                 Registered\n";
    const ARUBAOS: &str = "AP Database\n-----------\nName         Group    AP Type  IP Address   Status         Flags  Switch IP    Standby IP\n----         -----    -------  ----------   ------         -----  ---------    ----------\nAP-LOBBY     default  315      10.0.20.11   Up 12d:3h:4m          10.0.0.6     0.0.0.0\nAP-FLOOR2    default  535      10.0.20.12   Up 1d:0h:1m           10.0.0.6     0.0.0.0\n";
    const INSTANT: &str = "AP List\n-------\nName      IP Address   Mode    Spectrum  Clients  Type  IPv6 Address  Mesh Role  Zone  Serial #\n----      ----------   ----    --------  -------  ----  ------------  ---------  ----  --------\nAP-LOBBY  10.0.20.11   access  disable   3        315   --            N/A        --    CN0123456\n";
    const INVENTORY: &str = "Burned-in MAC Address............................ 00:AA:BB:CC:DD:00\nMaximum number of APs supported.................. 150\nNAME: \"Chassis\"    , DESCR: \"Cisco 3504 Wireless Controller\"\nPID: AIR-CT3504-K9,  VID: V02,  SN: FCH1234ABCD\n";
    const ARUBA_VERSION: &str = "Aruba Operating System Software.\nArubaOS (MODEL: Aruba7005), Version 8.10.0.9\nWebsite: http://www.arubanetworks.com\n";

    #[test]
    fn identity_comes_off_the_inventory_and_the_aruba_banner() {
        let (model, serials) = inventory_identity(INVENTORY);
        assert_eq!(model.as_deref(), Some("AIR-CT3504-K9"));
        assert_eq!(serials, ["FCH1234ABCD"]);
        assert_eq!(crate::classify::classify(model.as_deref(), &[], None), DeviceClass::WirelessController);
        assert_eq!(aruba_model_of(ARUBA_VERSION).as_deref(), Some("ARUBA7005"));
        assert_eq!(aruba_serials_of("Supervisor Card\nSystem Serial#: CV0001234\nSC Serial#: CV0001234 (Date:09/26/26)\n"), ["CV0001234"]);
        assert_eq!(crate::dialect::family_of(ARUBA_VERSION), crate::dialect::Family::ArubaController);
        assert!(!verified_against_hardware());
    }

    #[test]
    fn every_layout_yields_its_access_points() {
        let aireos = parse_ap_table(AIREOS);
        assert_eq!(aireos.iter().map(|n| (n.short_name.as_str(), n.platform.as_deref().unwrap(), n.addresses[0].ip.as_str())).collect::<Vec<_>>(), [("AP-LOBBY", "AIR-AP2802I-E-K9", "10.0.20.11"), ("AP-FLOOR2-EAST", "AIR-AP1852I-E-K9", "10.0.20.12")]);
        assert!(aireos.iter().all(|n| n.class == DeviceClass::AccessPoint && n.discovered_by == Protocol::Controller));
        let c9800 = parse_ap_table(C9800);
        assert_eq!(c9800.iter().map(|n| (n.short_name.as_str(), n.platform.as_deref().unwrap(), n.addresses[0].ip.as_str())).collect::<Vec<_>>(), [("AP-LOBBY", "C9120AXI-E", "10.0.20.11")]);
        let arubaos = parse_ap_table(ARUBAOS);
        assert_eq!(arubaos.iter().map(|n| (n.short_name.as_str(), n.platform.as_deref().unwrap(), n.addresses[0].ip.as_str())).collect::<Vec<_>>(), [("AP-LOBBY", "315", "10.0.20.11"), ("AP-FLOOR2", "535", "10.0.20.12")]);
        let instant = parse_ap_table(INSTANT);
        assert_eq!(instant.iter().map(|n| (n.short_name.as_str(), n.platform.as_deref().unwrap(), n.addresses[0].ip.as_str())).collect::<Vec<_>>(), [("AP-LOBBY", "315", "10.0.20.11")]);
        assert!(parse_ap_table("Incorrect usage.  Use the '?' or <TAB> key to list commands.").is_empty());
    }
}
