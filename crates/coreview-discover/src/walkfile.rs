//! A saved `snmpwalk` read back as a device (LT-246).
//!
//! Some estates cannot be crawled from the engineer's laptop — a jump host, a
//! change window, a network that allows SNMP only from the monitoring server —
//! but somebody can run `snmpwalk` there and hand over the text. This reads
//! that text into the same record an SNMP crawl builds, through the same
//! interpreters (`snmp_topology`, `crawl::device_from_snmp`), so a walked
//! device and a crawled one are indistinguishable on the diagram.
//!
//! **Written against net-snmp 5.9 output captured from the lab switch** in
//! the three forms people actually save — MIB names (`IF-MIB::ifName.10101`),
//! numeric (`-On`, `.1.3.6.1.2.1.31.1.1.1.1.10101`) and the no-MIB default
//! (`iso.3.6.1.2.1.…`). What that output taught, rule by rule:
//!
//! * **A value can run over several lines.** `sysDescr` on IOS is four lines;
//!   the continuation has no marker. A line belongs to the value above unless
//!   it starts a new `name = value` row.
//! * **Strings are quoted only without a MIB.** `STRING: "Gi0/1"` from a
//!   numeric walk, `STRING: GigabitEthernet0/1` with the MIB loaded, `""`
//!   with no type at all for an empty value, and `STRING: ` (trailing space)
//!   for an empty value that has a display hint.
//! * **A MAC with a MIB loaded is text with its leading zeros dropped** —
//!   `0:0:5e:f:53:81` — and without one it is `Hex-STRING: 74 AC …`.
//! * **Enumerations carry their number**: `INTEGER: up(1)`, `macAddress(4)`;
//!   bit strings their bytes then words: `BITS: 20 00 bridge(2)`.
//! * **With BRIDGE-MIB loaded the forwarding table's index is unrecoverable**:
//!   the MAC is printed as `'......'`. The rows still come in the same order
//!   in every column, and `dot1dTpFdbAddress` carries the MAC as a value, so
//!   rows are paired by position.
//! * **A saved walk often has net-snmp's own complaints in it** — `Cannot find
//!   module`, `MIB search path`, `No Such Object available` — when stderr was
//!   redirected too. They are not rows and not continuations.

use std::collections::{BTreeSet, HashMap};

use crate::crawl::CrawledDevice;
use crate::snmp::{decode_services, SnmpIdentity, Walked};
use crate::snmp_topology::{BridgeColumns, Column, LldpColumns, SnmpTopology};
use crate::types::{DeviceAddress, Neighbor, Protocol};

/// A walk file this large is not a walk of one device.
const MAX_BYTES: usize = 32 * 1024 * 1024;

/// What a walk file said, and what could not be used.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkReading {
    pub device: Option<CrawledDevice>,
    /// Rows understood.
    pub rows: usize,
    /// MIB names this does not translate, a few of them, so the person can
    /// walk again with `-On`.
    pub unknown_names: Vec<String>,
    pub unknown_rows: usize,
    pub problems: Vec<String>,
}

/// A value as net-snmp printed it, reduced to what the interpreters read.
#[derive(Debug, Clone, PartialEq)]
enum Value {
    Int(i64),
    Octets(Vec<u8>),
    Oid(String),
    Skip,
}

/// One row: the full numeric OID, or a column plus a position when the index
/// was printed in a form that cannot be turned back into numbers.
#[derive(Debug, Clone, PartialEq)]
struct Row {
    oid: Vec<u64>,
    /// Set when the index was quoted: the column's own OID is in `oid`.
    ordinal: Option<usize>,
    value: Value,
}

/// Symbolic column names, as net-snmp prints them, to their OIDs. Only what
/// the interpreters read: a name missing from here is counted, not guessed.
const NAMES: &[(&str, &str)] = &[
    ("SNMPv2-MIB::sysDescr", "1.3.6.1.2.1.1.1"),
    ("SNMPv2-MIB::sysObjectID", "1.3.6.1.2.1.1.2"),
    ("SNMPv2-MIB::sysUpTime", "1.3.6.1.2.1.1.3"),
    ("SNMPv2-MIB::sysContact", "1.3.6.1.2.1.1.4"),
    ("SNMPv2-MIB::sysName", "1.3.6.1.2.1.1.5"),
    ("SNMPv2-MIB::sysLocation", "1.3.6.1.2.1.1.6"),
    ("SNMPv2-MIB::sysServices", "1.3.6.1.2.1.1.7"),
    ("IF-MIB::ifIndex", "1.3.6.1.2.1.2.2.1.1"),
    ("IF-MIB::ifDescr", "1.3.6.1.2.1.2.2.1.2"),
    ("IF-MIB::ifType", "1.3.6.1.2.1.2.2.1.3"),
    ("IF-MIB::ifPhysAddress", "1.3.6.1.2.1.2.2.1.6"),
    ("IF-MIB::ifOperStatus", "1.3.6.1.2.1.2.2.1.8"),
    ("IF-MIB::ifName", "1.3.6.1.2.1.31.1.1.1.1"),
    ("IF-MIB::ifHighSpeed", "1.3.6.1.2.1.31.1.1.1.15"),
    ("IF-MIB::ifAlias", "1.3.6.1.2.1.31.1.1.1.18"),
    ("IP-MIB::ipAdEntAddr", "1.3.6.1.2.1.4.20.1.1"),
    ("IP-MIB::ipAdEntIfIndex", "1.3.6.1.2.1.4.20.1.2"),
    ("IP-MIB::ipAdEntNetMask", "1.3.6.1.2.1.4.20.1.3"),
    ("IP-MIB::ipNetToMediaPhysAddress", "1.3.6.1.2.1.4.22.1.2"),
    ("BRIDGE-MIB::dot1dBasePortIfIndex", "1.3.6.1.2.1.17.1.4.1.2"),
    ("BRIDGE-MIB::dot1dTpFdbAddress", "1.3.6.1.2.1.17.4.3.1.1"),
    ("BRIDGE-MIB::dot1dTpFdbPort", "1.3.6.1.2.1.17.4.3.1.2"),
    ("BRIDGE-MIB::dot1dTpFdbStatus", "1.3.6.1.2.1.17.4.3.1.3"),
    ("Q-BRIDGE-MIB::dot1qTpFdbPort", "1.3.6.1.2.1.17.7.1.2.2.1.2"),
    ("Q-BRIDGE-MIB::dot1qTpFdbStatus", "1.3.6.1.2.1.17.7.1.2.2.1.3"),
    ("LLDP-MIB::lldpRemChassisIdSubtype", "1.0.8802.1.1.2.1.4.1.1.4"),
    ("LLDP-MIB::lldpRemChassisId", "1.0.8802.1.1.2.1.4.1.1.5"),
    ("LLDP-MIB::lldpRemPortIdSubtype", "1.0.8802.1.1.2.1.4.1.1.6"),
    ("LLDP-MIB::lldpRemPortId", "1.0.8802.1.1.2.1.4.1.1.7"),
    ("LLDP-MIB::lldpRemPortDesc", "1.0.8802.1.1.2.1.4.1.1.8"),
    ("LLDP-MIB::lldpRemSysName", "1.0.8802.1.1.2.1.4.1.1.9"),
    ("LLDP-MIB::lldpRemSysDesc", "1.0.8802.1.1.2.1.4.1.1.10"),
    ("LLDP-MIB::lldpRemSysCapSupported", "1.0.8802.1.1.2.1.4.1.1.11"),
    ("LLDP-MIB::lldpRemSysCapEnabled", "1.0.8802.1.1.2.1.4.1.1.12"),
    ("LLDP-MIB::lldpRemManAddrIfSubtype", "1.0.8802.1.1.2.1.4.2.1.3"),
    ("LLDP-MIB::lldpLocPortIdSubtype", "1.0.8802.1.1.2.1.3.7.1.2"),
    ("LLDP-MIB::lldpLocPortId", "1.0.8802.1.1.2.1.3.7.1.3"),
    ("ENTITY-MIB::entPhysicalClass", "1.3.6.1.2.1.47.1.1.1.1.5"),
    ("ENTITY-MIB::entPhysicalSerialNum", "1.3.6.1.2.1.47.1.1.1.1.11"),
    ("ENTITY-MIB::entPhysicalModelName", "1.3.6.1.2.1.47.1.1.1.1.13"),
    ("CISCO-CDP-MIB::cdpCacheAddressType", "1.3.6.1.4.1.9.9.23.1.2.1.1.3"),
    ("CISCO-CDP-MIB::cdpCacheAddress", "1.3.6.1.4.1.9.9.23.1.2.1.1.4"),
    ("CISCO-CDP-MIB::cdpCacheVersion", "1.3.6.1.4.1.9.9.23.1.2.1.1.5"),
    ("CISCO-CDP-MIB::cdpCacheDeviceId", "1.3.6.1.4.1.9.9.23.1.2.1.1.6"),
    ("CISCO-CDP-MIB::cdpCacheDevicePort", "1.3.6.1.4.1.9.9.23.1.2.1.1.7"),
    ("CISCO-CDP-MIB::cdpCachePlatform", "1.3.6.1.4.1.9.9.23.1.2.1.1.8"),
    ("CISCO-CDP-MIB::cdpCacheCapabilities", "1.3.6.1.4.1.9.9.23.1.2.1.1.9"),
    // Module roots net-snmp falls back to when it knows the module but not
    // the column.
    ("SNMPv2-SMI::mib-2", "1.3.6.1.2.1"),
    ("SNMPv2-SMI::enterprises", "1.3.6.1.4.1"),
    ("SNMPv2-SMI::internet", "1.3.6.1"),
];

/// Lines net-snmp writes about itself, which a redirected stderr puts in the
/// file between rows.
const NOISE: &[&str] = &[
    "MIB search path:",
    "Cannot find module",
    "Did not find '",
    "Unlinked OID in",
    "Undefined identifier:",
    "Cannot adopt OID in",
    "Bad operator",
    "Expected",
    "Timeout: No Response",
    "End of MIB",
    "Warning:",
];

fn parse_numeric(s: &str) -> Option<Vec<u64>> {
    let s = s.strip_prefix('.').unwrap_or(s);
    if s.is_empty() {
        return Some(Vec::new());
    }
    s.split('.').map(|p| p.parse().ok()).collect()
}

/// A row name as numbers. `Err(true)` when the name is a MIB name this does
/// not know; `Err(false)` when it is not a row name at all.
fn parse_name(name: &str) -> Result<(Vec<u64>, bool), bool> {
    if name.is_empty() || name.contains(char::is_whitespace) && !name.contains('\'') {
        return Err(false);
    }
    if name.starts_with('.') || name.starts_with(|c: char| c.is_ascii_digit()) {
        return parse_numeric(name).filter(|o| o.len() >= 2).map(|o| (o, false)).ok_or(false);
    }
    if name == "iso" || name.starts_with("iso.") {
        let mut oid = vec![1];
        oid.extend(parse_numeric(&name[3..]).ok_or(false)?);
        return Ok((oid, false));
    }
    let Some((module, rest)) = name.split_once("::") else { return Err(false) };
    if module.is_empty() || !module.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(false);
    }
    let (column, index) = match rest.find('.') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let full = format!("{module}::{column}");
    let Some((_, base)) = NAMES.iter().find(|(n, _)| *n == full) else { return Err(true) };
    let mut oid = parse_numeric(base).ok_or(false)?;
    if index.contains('\'') || index.contains('"') {
        // The numeric parts before the quoted one, if any (a VLAN), are kept.
        let before = &index[..index.find(['\'', '"']).unwrap_or(0)];
        oid.extend(parse_numeric(before.trim_end_matches('.')).unwrap_or_default());
        return Ok((oid, true));
    }
    oid.extend(parse_numeric(index).ok_or(true)?);
    Ok((oid, false))
}

/// Splits `name = value` where the name is a row name.
fn row_start(line: &str) -> Option<(&str, &str)> {
    if line.starts_with(char::is_whitespace) {
        return None;
    }
    let mut from = 0;
    while let Some(at) = line[from..].find(" = ") {
        let name = &line[..from + at];
        if parse_name(name) != Err(false) {
            return Some((name, &line[from + at + 3..]));
        }
        from += at + 3;
    }
    // `sysName.0 = ` with nothing after it.
    line.strip_suffix(" =").filter(|n| parse_name(n) != Err(false)).map(|n| (n, ""))
}

fn hex_bytes(text: &str) -> Vec<u8> {
    text.split_whitespace().map_while(|t| u8::from_str_radix(t, 16).ok().filter(|_| t.len() == 2)).collect()
}

/// The number in `up(1)`, or the plain number.
fn integer(text: &str) -> Option<i64> {
    let t = text.trim();
    if let (Some(open), true) = (t.rfind('('), t.ends_with(')')) {
        return t[open + 1..t.len() - 1].parse().ok();
    }
    t.split_whitespace().next()?.parse().ok()
}

/// A quoted string's contents, with net-snmp's two escapes undone.
fn unquote(text: &str) -> Vec<u8> {
    let inner = text.strip_prefix('"').unwrap_or(text);
    let inner = inner.strip_suffix('"').unwrap_or(inner);
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(n) = chars.next() {
                out.push(n);
            }
        } else {
            out.push(c);
        }
    }
    out.into_bytes()
}

/// Whether a quoted value is still open at the end of what has been read.
fn quote_open(text: &str) -> bool {
    let Some(inner) = text.strip_prefix('"') else { return false };
    let mut escaped = false;
    for c in inner.chars() {
        match (escaped, c) {
            (true, _) => escaped = false,
            (false, '\\') => escaped = true,
            (false, '"') => return false,
            _ => {}
        }
    }
    true
}

fn value_of(text: &str) -> Value {
    let text = text.trim_end_matches(['\r', '\n']);
    if text == "\"\"" {
        return Value::Octets(Vec::new());
    }
    let Some((kind, rest)) = text.split_once(':') else {
        return Value::Skip;
    };
    let rest = rest.strip_prefix(' ').unwrap_or(rest);
    match kind {
        "INTEGER" | "Gauge32" | "Counter32" | "Counter64" | "Unsigned32" | "UInteger32" => {
            integer(rest).map_or(Value::Skip, Value::Int)
        }
        "Timeticks" => rest
            .strip_prefix('(')
            .and_then(|r| r.split(')').next())
            .and_then(|n| n.parse().ok())
            .map_or(Value::Skip, Value::Int),
        "STRING" => Value::Octets(if rest.starts_with('"') { unquote(rest) } else { rest.trim_end_matches(' ').as_bytes().to_vec() }),
        "Hex-STRING" | "BITS" => Value::Octets(hex_bytes(rest)),
        "IpAddress" => Value::Octets(rest.trim().split('.').filter_map(|p| p.parse::<u8>().ok()).collect()),
        "Network Address" => Value::Octets(rest.trim().split(':').filter_map(|p| u8::from_str_radix(p, 16).ok()).collect()),
        "OID" => Value::Oid(match parse_name(rest.trim()) {
            Ok((oid, false)) => oid.iter().map(u64::to_string).collect::<Vec<_>>().join("."),
            _ => rest.trim().to_string(),
        }),
        _ => Value::Skip,
    }
}

/// Every row in the file, in order, and the MIB names that were not known.
fn parse_rows(text: &str) -> (Vec<Row>, BTreeSet<String>, usize) {
    let mut rows: Vec<Row> = Vec::new();
    let mut unknown: BTreeSet<String> = BTreeSet::new();
    let mut unknown_rows = 0;
    // The row being read: its name and the text of its value so far.
    let mut open: Option<(Vec<u64>, bool, String)> = None;
    let mut ordinals: HashMap<Vec<u64>, usize> = HashMap::new();

    let mut finish = |open: &mut Option<(Vec<u64>, bool, String)>, rows: &mut Vec<Row>| {
        if let Some((oid, quoted, text)) = open.take() {
            let value = value_of(&text);
            if value == Value::Skip {
                return;
            }
            let ordinal = quoted.then(|| {
                let n = ordinals.entry(oid.clone()).or_insert(0);
                *n += 1;
                *n - 1
            });
            rows.push(Row { oid, ordinal, value });
        }
    };

    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if let Some((name, value)) = row_start(line) {
            finish(&mut open, &mut rows);
            match parse_name(name) {
                Ok((oid, quoted)) => open = Some((oid, quoted, value.to_string())),
                Err(_) => {
                    unknown_rows += 1;
                    let column = name.split('.').next().unwrap_or(name);
                    if unknown.len() < 12 {
                        unknown.insert(column.to_string());
                    }
                }
            }
            continue;
        }
        if NOISE.iter().any(|n| line.starts_with(n)) {
            continue;
        }
        // A continuation, of a value still being read.
        if let Some((_, _, text)) = open.as_mut() {
            let still_quoted = quote_open(text.split_once(": ").map_or("", |(_, r)| r));
            let hex = text.starts_with("Hex-STRING:");
            if still_quoted || text.starts_with("STRING:") && !text.starts_with("STRING: \"") || hex {
                text.push(if hex { ' ' } else { '\n' });
                text.push_str(line);
            }
        }
    }
    finish(&mut open, &mut rows);
    (rows, unknown, unknown_rows)
}

fn under<'a>(rows: &'a [Row], column: &'a [u64]) -> impl Iterator<Item = &'a Row> + 'a {
    rows.iter().filter(move |r| r.oid.len() >= column.len() && r.oid[..column.len()] == *column)
}

fn walked(v: &Value) -> Walked {
    match v {
        Value::Int(n) => Walked::Int(*n),
        Value::Octets(b) => Walked::Octets(b.clone()),
        _ => Walked::Other,
    }
}

/// One column as the interpreters take it: `(index, value)`.
fn column(rows: &[Row], base: &str) -> Column {
    let base = parse_numeric(base).unwrap_or_default();
    under(rows, &base)
        .filter(|r| r.ordinal.is_none())
        .map(|r| (r.oid[base.len()..].iter().map(u64::to_string).collect::<Vec<_>>().join("."), walked(&r.value)))
        .collect()
}

/// Six bytes of a MAC, from raw octets or from `0:c:e6:0:0:a0` text.
fn mac_bytes(v: &Value) -> Option<[u8; 6]> {
    let Value::Octets(b) = v else { return None };
    let from_text = std::str::from_utf8(b).ok().and_then(|text| {
        let parts: Vec<u8> = text.trim().split(':').map(|p| (!p.is_empty() && p.len() <= 2).then(|| u8::from_str_radix(p, 16).ok()).flatten()).collect::<Option<_>>()?;
        <[u8; 6]>::try_from(parts).ok()
    });
    from_text.or_else(|| <[u8; 6]>::try_from(b.as_slice()).ok())
}

fn mac_string(m: &[u8; 6]) -> String {
    m.iter().map(|b| format!("{b:02x}")).collect()
}

/// Rows in a MAC display hint — `ifPhysAddress`, the ARP table — carried as
/// raw bytes, the way the interpreters expect them from the wire.
fn as_mac_octets(mut col: Column, rows: &[Row], base: &str) -> Column {
    let base_oid = parse_numeric(base).unwrap_or_default();
    let values: Vec<&Row> = under(rows, &base_oid).filter(|r| r.ordinal.is_none()).collect();
    for ((_, v), r) in col.iter_mut().zip(values) {
        if let Some(m) = mac_bytes(&r.value) {
            *v = Walked::Octets(m.to_vec());
        }
    }
    col
}

/// The forwarding table, with a quoted index rebuilt from the address column
/// in the same position.
fn fdb_columns(rows: &[Row]) -> (Column, Column) {
    let address = parse_numeric("1.3.6.1.2.1.17.4.3.1.1").unwrap_or_default();
    let port = parse_numeric("1.3.6.1.2.1.17.4.3.1.2").unwrap_or_default();
    let status = parse_numeric("1.3.6.1.2.1.17.4.3.1.3").unwrap_or_default();
    let macs: Vec<Option<[u8; 6]>> = under(rows, &address).filter(|r| r.ordinal.is_some()).map(|r| mac_bytes(&r.value)).collect();
    let rebuild = |col: &[u64]| -> Column {
        let mut out = column(rows, &col.iter().map(u64::to_string).collect::<Vec<_>>().join("."));
        for r in under(rows, col).filter(|r| r.oid.len() == col.len()) {
            if let Some(Some(mac)) = r.ordinal.and_then(|i| macs.get(i)) {
                out.push((mac.iter().map(u8::to_string).collect::<Vec<_>>().join("."), walked(&r.value)));
            }
        }
        out
    };
    (rebuild(&port), rebuild(&status))
}

fn text_of(v: &Walked) -> Option<String> {
    match v {
        Walked::Octets(b) => {
            let s = String::from_utf8_lossy(b).trim().to_string();
            (!s.is_empty()).then_some(s)
        }
        _ => None,
    }
}

/// CDP capability bits as the CLI's words, which `classify` reads.
fn cdp_capabilities(bits: &[u8]) -> Vec<String> {
    let n = bits.iter().fold(0u32, |acc, b| (acc << 8) | u32::from(*b));
    [(0x01, "Router"), (0x02, "Trans-Bridge"), (0x04, "Source-Route-Bridge"), (0x08, "Switch"), (0x10, "Host"), (0x20, "IGMP"), (0x40, "Repeater"), (0x80, "Phone")]
        .iter()
        .filter(|(m, _)| n & m != 0)
        .map(|(_, w)| w.to_string())
        .collect()
}

/// CDP neighbours from `cdpCacheTable`, indexed `ifIndex.deviceIndex`.
fn cdp_neighbors(rows: &[Row], if_names: &HashMap<String, String>) -> Vec<Neighbor> {
    let col = |n: u32| column(rows, &format!("1.3.6.1.4.1.9.9.23.1.2.1.1.{n}"));
    let by_index = |c: Column| c.into_iter().collect::<HashMap<String, Walked>>();
    let (types, addrs, versions, ports, platforms, caps) = (by_index(col(3)), by_index(col(4)), by_index(col(5)), by_index(col(7)), by_index(col(8)), by_index(col(9)));
    let mut out = Vec::new();
    for (index, id) in col(6) {
        let Some(device_id) = text_of(&id) else { continue };
        let address = match (types.get(&index), addrs.get(&index)) {
            (Some(Walked::Int(1)) | None, Some(Walked::Octets(b))) if b.len() == 4 => Some(std::net::Ipv4Addr::new(b[0], b[1], b[2], b[3]).to_string()),
            _ => None,
        };
        let platform = platforms.get(&index).and_then(text_of);
        let capabilities = match caps.get(&index) {
            Some(Walked::Octets(b)) => cdp_capabilities(b),
            _ => Vec::new(),
        };
        let version = versions.get(&index).and_then(text_of).map(|v| v.lines().next().unwrap_or("").to_string());
        let class = crate::classify::classify(platform.as_deref(), &capabilities, version.as_deref());
        out.push(Neighbor {
            short_name: crate::cdp::short_name(&device_id),
            device_id,
            addresses: address.into_iter().map(|ip| DeviceAddress { ip, interface: None, is_management: true }).collect(),
            local_interface: index.split('.').next().and_then(|i| if_names.get(i)).cloned(),
            remote_interface: ports.get(&index).and_then(text_of),
            platform,
            capabilities,
            version,
            class,
            discovered_by: Protocol::Cdp,
            serial: None,
            chassis_id: None,
            vendor: None,
        });
    }
    out
}

/// Reads one device's walk. `address` is where it is managed from; without
/// one, its first non-loopback interface address is used.
pub fn read_walk(text: &str, address: Option<&str>) -> WalkReading {
    let mut problems = Vec::new();
    if text.len() > MAX_BYTES {
        return WalkReading { device: None, rows: 0, unknown_names: vec![], unknown_rows: 0, problems: vec!["This file is larger than a walk of one device.".into()] };
    }
    let (rows, unknown, unknown_rows) = parse_rows(text);
    let single = |oid: &str| {
        let want = parse_numeric(oid).unwrap_or_default();
        rows.iter().find(|r| r.oid == want).map(|r| &r.value)
    };
    let text_at = |oid: &str| match single(oid) {
        Some(Value::Octets(b)) => Some(String::from_utf8_lossy(b).trim().to_string()).filter(|s| !s.is_empty()),
        _ => None,
    };

    let mut identity = SnmpIdentity {
        name: text_at("1.3.6.1.2.1.1.5.0"),
        description: text_at("1.3.6.1.2.1.1.1.0"),
        location: text_at("1.3.6.1.2.1.1.6.0"),
        object_id: match single("1.3.6.1.2.1.1.2.0") {
            Some(Value::Oid(o)) => Some(o.clone()),
            _ => None,
        },
        uptime_ticks: match single("1.3.6.1.2.1.1.3.0") {
            Some(Value::Int(n)) => u64::try_from(*n).ok(),
            _ => None,
        },
        ..Default::default()
    };
    if let Some(Value::Int(n)) = single("1.3.6.1.2.1.1.7.0") {
        (identity.routes, identity.bridges) = decode_services(*n);
    }
    // ENTITY-MIB: the chassis rows' serials and models, in order.
    let chassis: Vec<String> = column(&rows, "1.3.6.1.2.1.47.1.1.1.1.5").into_iter().filter(|(_, v)| *v == Walked::Int(3)).map(|(i, _)| i).collect();
    let pick = |base: &str| -> Vec<String> {
        let col: HashMap<String, Walked> = column(&rows, base).into_iter().collect();
        chassis.iter().filter_map(|i| col.get(i).and_then(text_of)).collect()
    };
    identity.serials = pick("1.3.6.1.2.1.47.1.1.1.1.11");
    identity.models = pick("1.3.6.1.2.1.47.1.1.1.1.13");

    // Interface names by index: ifName, else ifDescr.
    let mut if_names: HashMap<String, String> = column(&rows, "1.3.6.1.2.1.2.2.1.2").iter().filter_map(|(i, v)| Some((i.clone(), text_of(v)?))).collect();
    let if_name = column(&rows, "1.3.6.1.2.1.31.1.1.1.1");
    for (i, v) in &if_name {
        if let Some(n) = text_of(v) {
            if_names.insert(i.clone(), n);
        }
    }

    // Its own addresses, with the interface each sits on.
    let if_of: HashMap<String, i64> = column(&rows, "1.3.6.1.2.1.4.20.1.2").into_iter().filter_map(|(i, v)| match v {
        Walked::Int(n) => Some((i, n)),
        _ => None,
    }).collect();
    let mut addresses: Vec<DeviceAddress> = column(&rows, "1.3.6.1.2.1.4.20.1.1")
        .into_iter()
        .filter(|(i, _)| !i.starts_with("127."))
        .map(|(i, _)| DeviceAddress { interface: if_of.get(&i).and_then(|n| if_names.get(&n.to_string())).cloned(), ip: i, is_management: false })
        .collect();
    let address = match address.map(str::trim).filter(|a| !a.is_empty()) {
        Some(a) => a.to_string(),
        None => match addresses.first() {
            Some(a) => a.ip.clone(),
            None => {
                problems.push("The walk has no interface addresses (IP-MIB::ipAdEntAddr), so say which address the device is managed on.".into());
                String::new()
            }
        },
    };
    for a in &mut addresses {
        a.is_management = a.ip == address;
    }

    let lldp = LldpColumns {
        chassis_subtype: column(&rows, "1.0.8802.1.1.2.1.4.1.1.4"),
        chassis_id: column(&rows, "1.0.8802.1.1.2.1.4.1.1.5"),
        port_subtype: column(&rows, "1.0.8802.1.1.2.1.4.1.1.6"),
        port_id: column(&rows, "1.0.8802.1.1.2.1.4.1.1.7"),
        port_desc: column(&rows, "1.0.8802.1.1.2.1.4.1.1.8"),
        sys_name: column(&rows, "1.0.8802.1.1.2.1.4.1.1.9"),
        sys_desc: column(&rows, "1.0.8802.1.1.2.1.4.1.1.10"),
        caps_enabled: column(&rows, "1.0.8802.1.1.2.1.4.1.1.12"),
        man_addr: column(&rows, "1.0.8802.1.1.2.1.4.2.1.3"),
        loc_port_subtype: column(&rows, "1.0.8802.1.1.2.1.3.7.1.2"),
        loc_port_id: column(&rows, "1.0.8802.1.1.2.1.3.7.1.3"),
    };
    let (fdb_port, fdb_status) = fdb_columns(&rows);
    let bridge = BridgeColumns {
        if_name,
        base_port_if_index: column(&rows, "1.3.6.1.2.1.17.1.4.1.2"),
        fdb_port,
        fdb_status,
        qfdb_port: column(&rows, "1.3.6.1.2.1.17.7.1.2.2.1.2"),
        qfdb_status: column(&rows, "1.3.6.1.2.1.17.7.1.2.2.1.3"),
    };
    let mut neighbors = crate::snmp_topology::lldp_neighbors(&lldp);
    for n in cdp_neighbors(&rows, &if_names) {
        // One neighbour heard over both protocols on the same port is one link.
        let same = |m: &Neighbor| m.local_interface == n.local_interface && m.short_name.eq_ignore_ascii_case(&n.short_name);
        if !neighbors.iter().any(same) {
            neighbors.push(n);
        }
    }
    let topology = SnmpTopology { neighbors, mac_entries: crate::snmp_topology::fdb_entries(&bridge) };

    let arp: HashMap<String, String> = as_mac_octets(column(&rows, "1.3.6.1.2.1.4.22.1.2"), &rows, "1.3.6.1.2.1.4.22.1.2")
        .into_iter()
        .filter_map(|(index, v)| {
            let Walked::Octets(b) = v else { return None };
            let mac: [u8; 6] = b.try_into().ok()?;
            let parts: Vec<&str> = index.split('.').collect();
            (parts.len() == 5 && mac != [0; 6]).then(|| (mac_string(&mac), parts[1..].join(".")))
        })
        .collect();

    identity.address = address.clone();
    let device = if address.is_empty() {
        None
    } else if identity.name.is_none() && identity.description.is_none() {
        problems.push("The walk has no system group (sysName, sysDescr): walk from 1.3.6.1.2.1.1 as well.".into());
        None
    } else {
        let mut d = crate::crawl::device_from_snmp(&address, 0, identity, topology, &arp, None);
        if let Some(d) = d.as_mut() {
            if !addresses.is_empty() {
                if !addresses.iter().any(|a| a.ip == address) {
                    addresses.insert(0, DeviceAddress { ip: address.clone(), interface: None, is_management: true });
                }
                d.addresses = addresses;
            }
        }
        if d.is_none() {
            problems.push("The walk does not name the device (sysName is empty).".into());
        }
        d
    };
    if rows.is_empty() {
        problems.push("Nothing in this file reads as snmpwalk output.".into());
    }
    WalkReading { device, rows: rows.len(), unknown_names: unknown.into_iter().collect(), unknown_rows, problems }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::DeviceClass;

    // Invented names and addresses, in the exact shape of a walk captured from
    // a Catalyst 2960CX with MIBs loaded — stderr included, as a redirect
    // leaves it.
    const SYMBOLIC: &str = "\
MIB search path: /usr/share/snmp/mibs
Cannot find module (IANA-ADDRESS-FAMILY-NUMBERS-MIB): At line 31 in /usr/share/snmp/mibs/LLDP-MIB.my
SNMPv2-MIB::sysDescr.0 = STRING: Cisco IOS Software, C2960CX Software (C2960CX-UNIVERSALK9-M), Version 15.2(7)E, RELEASE SOFTWARE (fc3)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 1986-2019 by Cisco Systems, Inc.
Compiled Sat 23-Mar-19 09:05 by prod_rel_team
SNMPv2-MIB::sysObjectID.0 = OID: SNMPv2-SMI::enterprises.9.1.2191
SNMPv2-MIB::sysUpTime.0 = Timeticks: (502821591) 58 days, 4:43:35.91
SNMPv2-MIB::sysContact.0 = STRING: noc@example.net
SNMPv2-MIB::sysName.0 = STRING: ACCESS-SW7.example.net
SNMPv2-MIB::sysLocation.0 = STRING: Room 101
SNMPv2-MIB::sysServices.0 = INTEGER: 6
IF-MIB::ifDescr.1 = STRING: Vlan1
IF-MIB::ifDescr.10101 = STRING: GigabitEthernet0/1
IF-MIB::ifDescr.10102 = STRING: GigabitEthernet0/2
IF-MIB::ifDescr.10108 = STRING: GigabitEthernet0/8
IF-MIB::ifPhysAddress.10101 = STRING: 0:0:5e:0:53:81
IF-MIB::ifOperStatus.10101 = INTEGER: up(1)
IF-MIB::ifOperStatus.10102 = INTEGER: down(2)
IF-MIB::ifName.1 = STRING: Vl1
IF-MIB::ifName.10101 = STRING: Gi0/1
IF-MIB::ifName.10102 = STRING: Gi0/2
IF-MIB::ifName.10108 = STRING: Gi0/8
IF-MIB::ifAlias.10101 = STRING:
IP-MIB::ipAdEntAddr.192.0.2.7 = IpAddress: 192.0.2.7
IP-MIB::ipAdEntIfIndex.192.0.2.7 = INTEGER: 1
IP-MIB::ipAdEntNetMask.192.0.2.7 = IpAddress: 255.255.255.0
LLDP-MIB::lldpRemChassisIdSubtype.0.1.94 = INTEGER: macAddress(4)
LLDP-MIB::lldpRemChassisIdSubtype.0.7.105 = INTEGER: local(7)
LLDP-MIB::lldpRemChassisId.0.1.94 = Hex-STRING: 00 00 5E 00 53 A8
LLDP-MIB::lldpRemChassisId.0.7.105 = STRING: \"DESK-PC\"
LLDP-MIB::lldpRemPortIdSubtype.0.1.94 = INTEGER: local(7)
LLDP-MIB::lldpRemPortIdSubtype.0.7.105 = INTEGER: macAddress(3)
LLDP-MIB::lldpRemPortId.0.1.94 = STRING: \"Port 4\"
LLDP-MIB::lldpRemPortId.0.7.105 = Hex-STRING: 00 00 5E 00 53 AE
LLDP-MIB::lldpRemPortDesc.0.1.94 = STRING: Port 4
LLDP-MIB::lldpRemPortDesc.0.7.105 = STRING:
LLDP-MIB::lldpRemSysName.0.1.94 = STRING: EDGE-SW2
LLDP-MIB::lldpRemSysName.0.7.105 = STRING:
LLDP-MIB::lldpRemSysDesc.0.1.94 = STRING: USW-Lite-8
LLDP-MIB::lldpRemSysCapEnabled.0.1.94 = BITS: 20 00 bridge(2)
LLDP-MIB::lldpRemSysCapEnabled.0.7.105 = BITS: 00 00
LLDP-MIB::lldpRemManAddrIfSubtype.0.1.94.1.4.192.0.2.112 = INTEGER: systemPortNumber(3)
LLDP-MIB::lldpRemManAddrIfSubtype.0.1.94.2.16.254.128.0.0.0.0.0.0.2.0.94.255.254.0.83.168 = INTEGER: systemPortNumber(3)
LLDP-MIB::lldpLocPortIdSubtype.1 = INTEGER: interfaceName(5)
LLDP-MIB::lldpLocPortId.1 = STRING: \"Gi0/1\"
LLDP-MIB::lldpLocPortId.7 = STRING: \"Gi0/7\"
CISCO-CDP-MIB::cdpCacheAddressType.10108.6 = INTEGER: ip(1)
CISCO-CDP-MIB::cdpCacheAddress.10108.6 = Hex-STRING: C0 00 02 72
CISCO-CDP-MIB::cdpCacheVersion.10108.6 = STRING: FortiAP-U431F v7.0,build0159,251209 (GA)
CISCO-CDP-MIB::cdpCacheDeviceId.10108.6 = STRING: LOBBY-AP1
CISCO-CDP-MIB::cdpCacheDevicePort.10108.6 = STRING: eth1
CISCO-CDP-MIB::cdpCachePlatform.10108.6 = STRING: FortiAP-U431F
CISCO-CDP-MIB::cdpCacheCapabilities.10108.6 = Hex-STRING: 00 00 00 18
ENTITY-MIB::entPhysicalClass.1001 = INTEGER: chassis(3)
ENTITY-MIB::entPhysicalClass.1003 = INTEGER: powerSupply(6)
ENTITY-MIB::entPhysicalSerialNum.1001 = STRING: FOC0000X0AA
ENTITY-MIB::entPhysicalSerialNum.1003 = STRING: LIT00000AAA
ENTITY-MIB::entPhysicalModelName.1001 = STRING: WS-C2960CX-8PC-L
BRIDGE-MIB::dot1dBasePortIfIndex.1 = INTEGER: 10101
BRIDGE-MIB::dot1dBasePortIfIndex.2 = INTEGER: 10102
BRIDGE-MIB::dot1dBasePortIfIndex.8 = INTEGER: 10108
BRIDGE-MIB::dot1dTpFdbAddress.'......' = STRING: 0:0:5e:0:53:a0
BRIDGE-MIB::dot1dTpFdbAddress.'..^.S.' = STRING: 0:0:5e:0:53:b1
BRIDGE-MIB::dot1dTpFdbPort.'......' = INTEGER: 8
BRIDGE-MIB::dot1dTpFdbPort.'..^.S.' = INTEGER: 2
BRIDGE-MIB::dot1dTpFdbStatus.'......' = INTEGER: learned(3)
BRIDGE-MIB::dot1dTpFdbStatus.'..^.S.' = INTEGER: learned(3)
Q-BRIDGE-MIB::dot1qTpFdbEntry = No Such Object available on this agent at this OID
IP-MIB::ipNetToMediaPhysAddress.1.192.0.2.51 = STRING: 0:0:5e:0:53:b1
";

    #[test]
    fn a_walk_with_mibs_loaded_is_the_device_an_snmp_crawl_would_draw() {
        let r = read_walk(SYMBOLIC, None);
        assert!(r.problems.is_empty(), "{:?}", r.problems);
        let d = r.device.expect("a device");
        assert_eq!(d.hostname, "ACCESS-SW7");
        assert_eq!(d.address, "192.0.2.7", "its own interface address, when none is given");
        assert_eq!(d.addresses[0].interface.as_deref(), Some("Vl1"));
        assert_eq!(d.platform.as_deref(), Some("WS-C2960CX-8PC-L"));
        assert_eq!(d.serial.as_deref(), Some("FOC0000X0AA"), "the chassis only, not the power supply");
        assert_eq!(d.class, DeviceClass::Switch);
        let v = d.version.unwrap();
        assert!(v.starts_with("Cisco IOS Software") && v.contains("Compiled Sat"), "four lines kept: {v}");
        assert!(!v.contains("MIB search path"));

        let lldp: Vec<_> = d.neighbors.iter().filter(|n| n.discovered_by == Protocol::Lldp).collect();
        assert_eq!(lldp.len(), 2);
        let edge = lldp.iter().find(|n| n.short_name == "EDGE-SW2").unwrap();
        assert_eq!(edge.local_interface.as_deref(), Some("Gi0/1"));
        assert_eq!(edge.address(), Some("192.0.2.112"));
        assert_eq!(edge.class, DeviceClass::Switch);
        let cdp = d.neighbors.iter().find(|n| n.discovered_by == Protocol::Cdp).unwrap();
        assert_eq!(cdp.short_name, "LOBBY-AP1");
        assert_eq!(cdp.address(), Some("192.0.2.114"));
        assert_eq!(cdp.local_interface.as_deref(), Some("Gi0/8"));
        assert_eq!(cdp.remote_interface.as_deref(), Some("eth1"));
        assert_eq!(cdp.capabilities, vec!["Switch", "Host"]);

        // The quoted forwarding-table index is rebuilt by position; Gi0/8
        // leads to a CDP neighbour, so only Gi0/2's host is attached.
        assert_eq!(d.attached.len(), 1, "{:?}", d.attached);
        assert_eq!(d.attached[0].port, "Gi0/2");
        assert_eq!(d.attached[0].address.as_deref(), Some("192.0.2.51"), "from the ARP table's text MAC");
        assert_eq!(r.unknown_rows, 1, "the Q-BRIDGE no-such-object row names a column this does not read");
    }

    // The same device walked with -On, and with no MIBs at all.
    const NUMERIC: &str = "\
.1.3.6.1.2.1.1.1.0 = STRING: Cisco IOS Software, C2960CX Software (C2960CX-UNIVERSALK9-M), Version 15.2(7)E, RELEASE SOFTWARE (fc3)
Technical Support: http://www.cisco.com/techsupport
.1.3.6.1.2.1.1.5.0 = STRING: ACCESS-SW7.example.net
.1.3.6.1.2.1.31.1.1.1.1.10101 = STRING: Gi0/1
.1.3.6.1.2.1.4.20.1.1.192.0.2.7 = IpAddress: 192.0.2.7
.1.0.8802.1.1.2.1.4.1.1.4.0.1.94 = INTEGER: 4
.1.0.8802.1.1.2.1.4.1.1.5.0.1.94 = Hex-STRING: 00 00 5E 00 53 A8
.1.0.8802.1.1.2.1.4.1.1.9.0.1.94 = STRING: EDGE-SW2
.1.0.8802.1.1.2.1.3.7.1.3.1 = STRING: Gi0/1
.1.3.6.1.2.1.17.1.4.1.2.1 = INTEGER: 10101
.1.3.6.1.2.1.17.4.3.1.2.0.0.94.0.83.160 = INTEGER: 1
.1.3.6.1.2.1.17.4.3.1.3.0.0.94.0.83.160 = INTEGER: 3
";
    const NO_MIBS: &str = "\
iso.3.6.1.2.1.1.1.0 = STRING: \"Cisco IOS Software, C2960CX Software (C2960CX-UNIVERSALK9-M), Version 15.2(7)E, RELEASE SOFTWARE (fc3)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 1986-2019 by Cisco Systems, Inc.
Compiled Sat 23-Mar-19 09:05 by prod_rel_team\"
iso.3.6.1.2.1.1.2.0 = OID: iso.3.6.1.4.1.9.1.2191
iso.3.6.1.2.1.1.5.0 = STRING: \"ACCESS-SW7.example.net\"
iso.3.6.1.2.1.2.2.1.2.10101 = STRING: \"GigabitEthernet0/1\"
iso.0.8802.1.1.2.1.4.1.1.9.0.7.105 = \"\"
iso.0.8802.1.1.2.1.4.1.1.4.0.1.94 = INTEGER: 4
iso.0.8802.1.1.2.1.4.1.1.5.0.1.94 = Hex-STRING: 00 00 5E 00 53 A8
iso.0.8802.1.1.2.1.4.1.1.9.0.1.94 = STRING: \"EDGE-SW2\"
iso.0.8802.1.1.2.1.3.7.1.3.1 = STRING: \"Gi0/1\"
";

    #[test]
    fn numeric_and_mibless_walks_read_the_same() {
        let n = read_walk(NUMERIC, None).device.unwrap();
        assert_eq!((n.hostname.as_str(), n.address.as_str()), ("ACCESS-SW7", "192.0.2.7"));
        assert_eq!(n.neighbors.len(), 1);
        assert_eq!(n.neighbors[0].local_interface.as_deref(), Some("Gi0/1"));
        assert_eq!(n.attached.len(), 0, "the one learned MAC is on the LLDP uplink");

        let m = read_walk(NO_MIBS, Some("192.0.2.7"));
        let d = m.device.unwrap();
        assert_eq!(d.hostname, "ACCESS-SW7");
        assert!(d.version.unwrap().ends_with("prod_rel_team"), "a quoted value runs to its closing quote");
        assert_eq!(d.neighbors.len(), 1);
        assert_eq!(d.neighbors[0].short_name, "EDGE-SW2");
    }

    #[test]
    fn what_cannot_be_used_is_said() {
        let r = read_walk("SNMPv2-MIB::sysName.0 = STRING: CORE-SW1\n", None);
        assert!(r.device.is_none());
        assert!(r.problems[0].contains("which address"), "{:?}", r.problems);
        assert!(read_walk("SNMPv2-MIB::sysName.0 = STRING: CORE-SW1\n", Some("192.0.2.1")).device.is_some());

        let r = read_walk("hello\nworld\n", Some("192.0.2.1"));
        assert!(r.problems.iter().any(|p| p.contains("Nothing in this file")));

        let r = read_walk("FOO-MIB::fooThing.1 = INTEGER: 3\nSNMPv2-MIB::sysName.0 = STRING: X\n", Some("192.0.2.1"));
        assert_eq!(r.unknown_names, vec!["FOO-MIB::fooThing"]);
    }

    #[test]
    fn values_are_read_the_way_net_snmp_prints_them() {
        assert_eq!(value_of("INTEGER: up(1)"), Value::Int(1));
        assert_eq!(value_of("Gauge32: 1000"), Value::Int(1000));
        assert_eq!(value_of("Timeticks: (733254300) 84 days, 20:49:03.00"), Value::Int(733_254_300));
        assert_eq!(value_of("STRING: \"a \\\"b\\\"\""), Value::Octets(b"a \"b\"".to_vec()));
        assert_eq!(value_of("STRING: "), Value::Octets(vec![]));
        assert_eq!(value_of("\"\""), Value::Octets(vec![]));
        assert_eq!(value_of("BITS: 20 00 bridge(2) "), Value::Octets(vec![0x20, 0]));
        assert_eq!(value_of("No Such Object available on this agent at this OID"), Value::Skip);
        assert_eq!(value_of("OID: SNMPv2-SMI::enterprises.9.1.2191"), Value::Oid("1.3.6.1.4.1.9.1.2191".into()));
        assert_eq!(mac_bytes(&Value::Octets(b"0:0:5e:f:53:81".to_vec())), Some([0x00, 0x00, 0x5e, 0x0f, 0x53, 0x81]));
        assert_eq!(parse_name("not a row"), Err(false));
    }
}
