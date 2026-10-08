//! NVIDIA Cumulus Linux 5.x through NVUE (`nv show …`) — the operator's
//! SN2010s.
//!
//! **Two forms of every reply, both read.** Every `nv show` command takes
//! `-o json` and answers with NVUE's object model; without it, the same
//! data as a table. The tables here were written against the operator's own
//! captures from an SN2010 on Cumulus Linux 5.18 (`fixtures/cumulus5/`,
//! reduced to invented names and documentation addresses). The JSON
//! shapes are NVIDIA's published NVUE OpenAPI schema (the 5.14 one at
//! `docs.nvidia.com/…/cumulus-linux-514/api/openapi.json`) — built from
//! documentation, since no JSON reply has been captured yet; a
//! reply that is not JSON is read as the table, so a release whose JSON
//! differs still reads.
//!
//! Both engines read through this module: the classic crawler's Cumulus
//! dialect directly, and the collector's `nvue_*` readers by turning these
//! records into rows. One parser, so the two cannot disagree.
//!
//! What `sudo` alone shows (FRR's `vtysh`, `lldpcli`) is not asked: the
//! read-only guard refuses `sudo`, and a password typed to it is a second
//! secret nobody gave Coreview. OSPF is read through NVUE; neighbours
//! through NVUE's LLDP views. FRR's own `show ip ospf neighbor detail`
//! layout is read too ([`ospf_neighbors`]), for a device that lets a
//! login run `vtysh` itself.

use serde_json::Value;

use crate::arp::normalise_mac;
use crate::etherchannel::PortChannel;
use crate::interfaces::Interface;
use crate::routes::Route;
use crate::stp::{StpInstance, StpPort};
use crate::types::{DeviceAddress, DeviceClass, Neighbor, Protocol};
use crate::vlans::{PortVlans, Vlan};

/// The tables met a real SN2010; the JSON has met only its schema.
pub fn verified_against_hardware() -> bool {
    false
}

/// Sent to recognise a Cumulus 5 switch: NVUE's `product-name` (5.10 and
/// later) or `build` (before) says `Cumulus Linux`.
pub const SYSTEM: &str = "nv show system";

// ------------------------------------------------------------- the forms

/// The reply as JSON, when it is: from the first line that opens an object
/// or a list to the last that closes one, so a warning before it or a
/// prompt after it does not spoil it.
pub fn json_of(raw: &str) -> Option<Value> {
    let lines: Vec<&str> = raw.lines().collect();
    let start = lines.iter().position(|l| {
        let t = l.trim_start();
        t.starts_with('{') || t.starts_with('[')
    })?;
    let end = lines.iter().rposition(|l| {
        let t = l.trim_end();
        t.ends_with('}') || t.ends_with(']')
    })?;
    if end < start {
        return None;
    }
    serde_json::from_str(&lines[start..=end].join("\n")).ok()
}

/// NVUE's own refusal: `Error: The requested item does not exist.` for
/// something not configured (the operator's BGP EVPN table), bash's for a
/// command that is not there, NVUE's usage text for one it does not know.
pub fn refused(raw: &str) -> bool {
    raw.lines().any(|l| {
        let t = l.trim();
        t.starts_with("Error:") || t.contains("command not found") || t.starts_with("Usage: nv") || t.contains("Invalid Command")
    })
}

/// A JSON value as text: strings as they are, numbers printed, an object
/// whose single key is the value (NVUE writes `"state": {"up": {}}`) as
/// that key.
fn text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Object(o) if o.len() == 1 => o.keys().next().cloned(),
        _ => None,
    }
}

fn at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(v, |v, k| v.get(*k))
}

fn text_at(v: &Value, path: &[&str]) -> Option<String> {
    at(v, path).and_then(text)
}

/// NVUE's switches: `"enable": "on"`, an empty object for a flag that is
/// set, `yes`, `true`.
fn is_on(v: Option<&Value>) -> bool {
    match v {
        Some(Value::String(s)) => matches!(s.as_str(), "on" | "yes" | "true" | "enabled" | "up"),
        Some(Value::Bool(b)) => *b,
        Some(Value::Object(_)) => true,
        _ => false,
    }
}

/// A table header's columns and where each starts.
type Columns = Vec<(String, usize)>;
/// A field by its path, whichever form the reply came in.
type Lookup = Box<dyn Fn(&[&str]) -> Option<String>>;
/// A field by its key, whichever form the reply came in.
type KeyLookup = Box<dyn Fn(&str) -> Option<String>>;

/// The columns of a table header, each with where it starts: the header is
/// split where two or more spaces fall, so `Admin Status` is one column.
fn columns(header: &str) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    let bytes = header.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b' ' {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && !(bytes[i] == b' ' && bytes.get(i + 1).map_or(true, |b| *b == b' ')) {
            i += 1;
        }
        out.push((header[start..i].trim().to_string(), start));
    }
    out
}

/// A row cut at the header's columns.
fn cells(line: &str, cols: &[(String, usize)]) -> Vec<String> {
    cols.iter()
        .enumerate()
        .map(|(k, (_, start))| {
            let end = cols.get(k + 1).map(|c| c.1).unwrap_or(usize::MAX);
            let a = (*start).min(line.len());
            let b = end.min(line.len());
            line.get(a..b).unwrap_or("").trim().to_string()
        })
        .collect()
}

fn is_rule(line: &str) -> bool {
    let t = line.trim();
    !t.is_empty() && t.chars().all(|c| c == '-' || c == ' ')
}

/// A table under its header and dashed rule: the header's columns and the
/// rows cut to them. `None` when no header names `first`.
fn table(raw: &str, first: &str) -> Option<(Columns, Vec<Vec<String>>)> {
    let lines: Vec<&str> = raw.lines().collect();
    let h = lines.iter().position(|l| l.split_whitespace().next() == Some(first) && lines.iter().any(|x| is_rule(x)))?;
    let cols = columns(lines[h]);
    let rows = lines[h + 1..].iter().filter(|l| !is_rule(l) && !l.trim().is_empty()).map(|l| cells(l, &cols)).collect();
    Some((cols, rows))
}

/// NVUE's two-column `operational  applied` view: `key  value`, nested
/// keys indented under a key with no value. Keys are the leaves' own names.
fn pairs(raw: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = raw.lines().collect();
    let Some(h) = lines.iter().position(|l| l.contains("operational")) else { return Vec::new() };
    let x = lines[h].find("operational").unwrap_or(0);
    let y = lines[h].find("applied").filter(|y| *y > x);
    lines[h + 1..]
        .iter()
        .filter(|l| !is_rule(l))
        .filter_map(|l| {
            let key = l.get(..x.min(l.len()))?.trim();
            let value = match y {
                Some(y) => l.get(x..y.min(l.len())).unwrap_or(""),
                None => l.get(x..).unwrap_or(""),
            }
            .trim();
            (!key.is_empty() && !value.is_empty() && !key.contains(' ')).then(|| (key.to_string(), value.to_string()))
        })
        .collect()
}

fn pair(p: &[(String, String)], key: &str) -> Option<String> {
    p.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
}

// --------------------------------------------------------------- identity

/// What the switch says about itself, from `nv show system`, `nv show
/// system version` and `nv show platform` together.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    pub hostname: Option<String>,
    /// `Cumulus Linux`, from `product-name`.
    pub product: Option<String>,
    /// `5.18.0`: `product-release`, else what follows `Cumulus Linux` in `build`.
    pub release: Option<String>,
    pub build_id: Option<String>,
    /// `MSN2010`: `system-type` (5.18) or the platform's `product-name`.
    pub model: Option<String>,
    pub serial: Option<String>,
    pub base_mac: Option<String>,
    pub manufacturer: Option<String>,
    pub part_number: Option<String>,
    pub asic: Option<String>,
    pub port_layout: Option<String>,
    pub uptime: Option<String>,
}

/// Every answer to the identity commands, merged: whichever form each came
/// in, whichever release named the fields which way.
pub fn identity(replies: &[&str]) -> Identity {
    let mut id = Identity::default();
    let put = |slot: &mut Option<String>, v: Option<String>| {
        if slot.is_none() {
            *slot = v.filter(|s| !s.is_empty() && s != "N/A");
        }
    };
    for raw in replies {
        if refused(raw) {
            continue;
        }
        let get: Lookup = match json_of(raw) {
            Some(j) => Box::new(move |path: &[&str]| text_at(&j, path)),
            None => {
                let p = pairs(raw);
                Box::new(move |path: &[&str]| pair(&p, path[path.len() - 1]))
            }
        };
        let build = get(&["build"]);
        let platform = get(&["system-type"]).is_some() || get(&["serial-number"]).is_some() || get(&["asic-model"]).is_some();
        put(&mut id.hostname, get(&["hostname"]));
        put(&mut id.uptime, get(&["uptime"]));
        put(&mut id.release, get(&["product-release"]).or_else(|| build.as_deref().map(|b| b.trim_start_matches("Cumulus Linux").trim().to_string())));
        put(&mut id.build_id, get(&["image", "build-id"]).or_else(|| get(&["image"])));
        if platform {
            // The platform's `product-name` is the hardware; the system's is the OS.
            put(&mut id.model, get(&["system-type"]).or_else(|| get(&["product-name"])));
        } else {
            put(&mut id.product, get(&["product-name"]).or_else(|| build.filter(|b| b.contains("Cumulus")).map(|_| "Cumulus Linux".to_string())));
        }
        put(&mut id.serial, get(&["serial-number"]));
        put(&mut id.base_mac, get(&["system-mac"]).map(|m| m.to_ascii_lowercase()));
        put(&mut id.manufacturer, get(&["manufacturer"]));
        put(&mut id.part_number, get(&["part-number"]));
        put(&mut id.asic, get(&["asic-model"]));
        put(&mut id.port_layout, get(&["port-layout"]));
    }
    id
}

/// Whether `nv show system` came from a Cumulus switch.
pub fn is_cumulus(system: &str) -> bool {
    !refused(system) && system.contains("Cumulus Linux")
}

// ------------------------------------------------------------- interfaces

/// One row of `nv show interface`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Port {
    pub name: String,
    /// `swp`, `bond`, `svi`, `eth`, `loopback`, `sub`, `bridge`, `vrf`, `peerlink`.
    pub kind: String,
    pub admin_up: bool,
    pub oper_up: bool,
    pub speed: Option<String>,
    pub mtu: Option<u32>,
    pub mac: Option<String>,
    /// Addresses with their prefix length, `10.0.0.1/24`.
    pub addresses: Vec<String>,
    /// VRR's virtual addresses on this interface — shared with the MLAG
    /// peer, the gateway the hosts behind it use.
    pub virtual_addresses: Vec<String>,
    /// What LLDP names at the far end, from the table's own columns.
    pub remote_host: Option<String>,
    pub remote_port: Option<String>,
    /// A bond's members.
    pub members: Vec<String>,
    pub vrf: Option<String>,
}

impl Port {
    /// VRR's virtual interface, `vlan110-v0`: the macvlan the virtual
    /// address lives on, not a port of the switch's own.
    pub fn is_vrr(&self) -> bool {
        self.name.rsplit_once("-v").map(|(_, n)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())).unwrap_or(false)
    }
}

/// `nv show interface`, as JSON or as the table.
pub fn ports(raw: &str) -> Vec<Port> {
    if refused(raw) {
        return Vec::new();
    }
    match json_of(raw) {
        Some(j) => ports_json(&j),
        None => ports_text(raw),
    }
}

fn ports_json(j: &Value) -> Vec<Port> {
    let Some(map) = j.as_object() else { return Vec::new() };
    let mut out: Vec<Port> = map
        .iter()
        .filter(|(_, v)| v.is_object())
        .map(|(name, v)| {
            let link = v.get("link").cloned().unwrap_or(Value::Null);
            let oper = text_at(&link, &["oper-status"]).or_else(|| text_at(&link, &["state"]));
            let admin = text_at(&link, &["admin-status"]);
            let keys = |path: &[&str]| -> Vec<String> { at(v, path).and_then(Value::as_object).map(|o| o.keys().cloned().collect()).unwrap_or_default() };
            let neighbour = at(v, &["lldp", "neighbor"]).and_then(Value::as_object).and_then(|o| o.values().next());
            Port {
                name: name.clone(),
                kind: text_at(v, &["type"]).unwrap_or_default(),
                oper_up: oper.as_deref() == Some("up"),
                admin_up: admin.as_deref().map(|a| a == "up").unwrap_or(oper.as_deref() == Some("up")),
                speed: text_at(&link, &["speed"]),
                mtu: text_at(&link, &["mtu"]).and_then(|m| m.parse().ok()),
                mac: text_at(&link, &["mac"]).or_else(|| text_at(&link, &["mac-address"])).map(|m| m.to_ascii_lowercase()),
                addresses: keys(&["ip", "address"]),
                virtual_addresses: keys(&["ip", "vrr", "address"]),
                remote_host: neighbour.and_then(|n| text_at(n, &["chassis", "system-name"])),
                remote_port: neighbour.and_then(|n| text_at(n, &["port", "name"])),
                members: keys(&["bond", "member"]),
                vrf: text_at(v, &["ip", "vrf"]),
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn ports_text(raw: &str) -> Vec<Port> {
    let Some((cols, rows)) = table(raw, "Interface") else { return Vec::new() };
    let col = |name: &str| cols.iter().position(|(n, _)| n == name);
    let (name, admin, oper, speed, mtu, kind, host, port, summary) =
        (col("Interface"), col("Admin Status"), col("Oper Status"), col("Speed"), col("MTU"), col("Type"), col("Remote Host"), col("Remote Port"), col("Summary"));
    let get = |r: &Vec<String>, c: Option<usize>| c.and_then(|c| r.get(c)).filter(|s| !s.is_empty()).cloned();
    let mut out: Vec<Port> = Vec::new();
    for r in &rows {
        if let Some(n) = get(r, name) {
            out.push(Port {
                name: n,
                kind: get(r, kind).unwrap_or_default(),
                admin_up: get(r, admin).as_deref() == Some("up"),
                oper_up: get(r, oper).as_deref() == Some("up"),
                speed: get(r, speed),
                mtu: get(r, mtu).and_then(|m| m.parse().ok()),
                remote_host: get(r, host),
                remote_port: get(r, port),
                ..Port::default()
            });
        }
        let Some(p) = out.last_mut() else { continue };
        if let Some(s) = get(r, summary) {
            if let Some((label, value)) = s.split_once(':') {
                if label.trim().ends_with("Address") && label.contains("IP") {
                    p.addresses.push(value.trim().to_string());
                }
            }
        }
    }
    // A VRR macvlan's address is its parent's virtual address.
    let vrr: Vec<(String, Vec<String>)> = out.iter().filter(|p| p.is_vrr()).map(|p| (p.name.rsplit_once("-v").map(|x| x.0).unwrap_or("").to_string(), p.addresses.clone())).collect();
    for (parent, addrs) in vrr {
        if let Some(p) = out.iter_mut().find(|p| p.name == parent) {
            p.virtual_addresses.extend(addrs.into_iter().filter(|a| !a.starts_with("fe80")));
        }
    }
    out
}

fn is_host_scope(cidr: &str) -> bool {
    let ip = cidr.split('/').next().unwrap_or("");
    ip.parse::<std::net::IpAddr>().map(|ip| ip.is_loopback() || matches!(ip, std::net::IpAddr::V6(v6) if (v6.segments()[0] & 0xffc0) == 0xfe80)).unwrap_or(true)
}

/// The switch's own IPv4 addresses, for the crawl: not loopback's 127/8,
/// not link-local, and not VRR's shared virtual address — that one is the
/// MLAG pair's, not this box's.
pub fn interfaces(ports: &[Port]) -> Vec<Interface> {
    ports
        .iter()
        .filter(|p| !p.is_vrr() && p.kind != "vrf")
        .flat_map(|p| {
            p.addresses.iter().filter(|a| !is_host_scope(a)).filter_map(move |a| {
                let ip = a.split('/').next()?;
                ip.parse::<std::net::Ipv4Addr>().ok().map(|_| Interface { name: p.name.clone(), address: Some(ip.to_string()), up: p.oper_up })
            })
        })
        .collect()
}

/// Bonds and their members: from the JSON, or `nv show interface
/// bond-members` (`Interface  Parent  Admin Status …`, NVIDIA's documented
/// layout). The peer link is a bond like any other.
pub fn bonds(ports: &[Port], bond_members: &str) -> Vec<PortChannel> {
    let mut out: Vec<PortChannel> = ports
        .iter()
        .filter(|p| p.kind == "bond" || p.kind == "peerlink")
        .map(|p| PortChannel { name: p.name.clone(), protocol: "LACP".into(), members: p.members.clone() })
        .collect();
    if let Some((cols, rows)) = table(bond_members, "Interface") {
        let (ci, cp) = (cols.iter().position(|c| c.0 == "Interface"), cols.iter().position(|c| c.0 == "Parent"));
        if let (Some(ci), Some(cp)) = (ci, cp) {
            for r in rows {
                let (Some(m), Some(parent)) = (r.get(ci).filter(|s| !s.is_empty()), r.get(cp).filter(|s| !s.is_empty())) else { continue };
                match out.iter_mut().find(|b| &b.name == parent) {
                    Some(b) if !b.members.contains(m) => b.members.push(m.clone()),
                    Some(_) => {}
                    None => out.push(PortChannel { name: parent.clone(), protocol: "LACP".into(), members: vec![m.clone()] }),
                }
            }
        }
    }
    out.retain(|b| !b.members.is_empty());
    out
}

/// Ports as the classic crawler's port table: up or down, the speed.
pub fn port_status(ports: &[Port]) -> Vec<crate::vlans::PortStatus> {
    ports
        .iter()
        .filter(|p| p.kind == "swp" || p.kind == "bond" || p.kind == "peerlink" || p.kind == "eth")
        .map(|p| crate::vlans::PortStatus {
            port: p.name.clone(),
            description: String::new(),
            status: if !p.admin_up { "disabled".into() } else if p.oper_up { "connected".into() } else { "notconnect".into() },
            vlan: String::new(),
            duplex: String::new(),
            speed: p.speed.clone().unwrap_or_default(),
            media: String::new(),
        })
        .collect()
}

// --------------------------------------------------------------- neighbours

fn blank_neighbour(local: Option<String>, proto: Protocol) -> Neighbor {
    Neighbor {
        serial: None,
        short_name: String::new(),
        device_id: String::new(),
        addresses: Vec::new(),
        local_interface: local,
        remote_interface: None,
        platform: None,
        capabilities: Vec::new(),
        version: None,
        class: DeviceClass::Unknown,
        discovered_by: proto,
        vendor: None,
        chassis_id: None,
    }
}

/// LLDP (and the CDP lldpd also hears) from any of NVUE's forms: the JSON
/// of `nv show interface lldp-detail -o json` or `nv show interface -o
/// json` (each interface's `lldp.neighbor`), lldpd's own detail layout
/// that `nv show interface lldp-detail` prints, or — with no address to go
/// on — the Remote Host and Remote Port columns of `nv show interface`.
pub fn neighbours(raw: &str) -> Vec<Neighbor> {
    if refused(raw) {
        return Vec::new();
    }
    if let Some(j) = json_of(raw) {
        return neighbours_json(&j);
    }
    if raw.contains("ChassisID:") || raw.contains("SysName:") {
        return crate::vyatta::parse_lldp_detail(raw);
    }
    ports_text(raw)
        .into_iter()
        .filter_map(|p| {
            let host = p.remote_host?;
            let mut n = blank_neighbour(Some(p.name), Protocol::Lldp);
            n.short_name = crate::cdp::short_name(&host);
            n.device_id = host;
            n.remote_interface = p.remote_port;
            Some(n)
        })
        .collect()
}

/// Every address under a key naming management (`management-address-ipv4`,
/// `management-address`, `mgmt-ip`), however it is held.
fn management_addresses(v: &Value, under: bool, out: &mut Vec<std::net::IpAddr>) {
    match v {
        Value::String(s) if under => out.extend(s.split(['/', ' ']).next().and_then(|a| a.parse::<std::net::IpAddr>().ok())),
        Value::Array(items) => items.iter().for_each(|i| management_addresses(i, under, out)),
        Value::Object(o) => {
            for (k, child) in o {
                let named = under || k.contains("management") || k.contains("mgmt");
                if named {
                    if let Ok(ip) = k.split('/').next().unwrap_or("").parse::<std::net::IpAddr>() {
                        out.push(ip);
                    }
                }
                management_addresses(child, named, out);
            }
        }
        _ => {}
    }
}

fn neighbours_json(j: &Value) -> Vec<Neighbor> {
    let Some(map) = j.as_object() else { return Vec::new() };
    let mut out = Vec::new();
    for (ifname, v) in map {
        let Some(ns) = at(v, &["lldp", "neighbor"]).or_else(|| v.get("neighbor")).and_then(Value::as_object) else { continue };
        for (id, n) in ns {
            let mut x = blank_neighbour(Some(ifname.clone()), Protocol::Lldp);
            let chassis = n.get("chassis").cloned().unwrap_or(Value::Null);
            x.device_id = text_at(&chassis, &["system-name"]).or_else(|| text_at(&chassis, &["chassis-id"])).unwrap_or_else(|| id.clone());
            x.chassis_id = text_at(&chassis, &["chassis-id"]).and_then(|c| normalise_mac(c.split_whitespace().last().unwrap_or("")));
            x.vendor = x.chassis_id.as_deref().and_then(crate::oui::vendor).map(str::to_string);
            // Wherever the neighbour's object keeps it — a string, a
            // list, an object keyed by the address, one per family — under a
            // key that says management. IPv4 first.
            let mut found = Vec::new();
            management_addresses(n, false, &mut found);
            found.sort_by_key(|ip: &std::net::IpAddr| ip.is_ipv6());
            for ip in found {
                let ip = ip.to_string();
                if !is_host_scope(&ip) && !x.addresses.iter().any(|a| a.ip == ip) {
                    x.addresses.push(DeviceAddress { ip, interface: None, is_management: true });
                }
            }
            x.version = text_at(&chassis, &["system-description"]).map(|d| d.lines().next().unwrap_or("").trim().to_string());
            if let Some(caps) = chassis.get("capability").and_then(Value::as_object) {
                for (k, v) in caps {
                    if is_on(Some(v)) {
                        let word = k.trim_start_matches("is-");
                        let mut c = word.chars();
                        x.capabilities.push(c.next().map(|f| f.to_ascii_uppercase().to_string() + c.as_str()).unwrap_or_default());
                    }
                }
            }
            let port = text_at(n, &["port", "name"]);
            let descr = text_at(n, &["port", "description"]);
            // A port id that is a MAC says less than its description does.
            x.remote_interface = match (port, descr) {
                (Some(p), Some(d)) if normalise_mac(&p).is_some() => Some(d),
                (p, d) => p.or(d),
            };
            x.platform = text_at(n, &["lldp-med", "inventory", "model"]);
            x.serial = text_at(n, &["lldp-med", "inventory", "serial-number"]);
            x.short_name = crate::cdp::short_name(&x.device_id);
            x.class = crate::classify::classify(x.platform.as_deref(), &x.capabilities, x.version.as_deref());
            out.push(x);
        }
    }
    // Neighbours with names and not one address among them is a
    // shape this does not know — a real switch answered so — and
    // the table, which names `MgmtIP`, is asked instead.
    if out.iter().any(|n| !n.device_id.is_empty() && n.chassis_id.as_deref() != Some(n.device_id.as_str())) && out.iter().all(|n| n.addresses.is_empty()) {
        return Vec::new();
    }
    out
}

// ------------------------------------------------------------ bridge, STP

/// The VLANs the bridge carries, with the VNI each maps to where VXLAN is
/// on. `nv show bridge domain br_default vlan`.
pub fn vlans(raw: &str) -> Vec<(u16, Option<u32>)> {
    if refused(raw) {
        return Vec::new();
    }
    if let Some(j) = json_of(raw) {
        let Some(map) = j.as_object() else { return Vec::new() };
        return map
            .iter()
            .filter_map(|(k, v)| Some((k.parse().ok()?, at(v, &["vni"]).and_then(Value::as_object).and_then(|o| o.keys().next()).and_then(|n| n.parse().ok()))))
            .collect();
    }
    let Some((cols, rows)) = table(raw, "Vlan") else { return Vec::new() };
    let vni = cols.iter().position(|c| c.0 == "VNI");
    rows.iter().filter_map(|r| Some((r.first()?.parse().ok()?, vni.and_then(|c| r.get(c)).and_then(|v| v.parse().ok())))).collect()
}

/// Which VLANs each port carries, tagged or not: `nv show bridge domain
/// br_default port vlan` — a port's name on its first row only, ranges
/// like `2-5`.
pub fn port_vlans(raw: &str) -> Vec<PortVlans> {
    if refused(raw) {
        return Vec::new();
    }
    // (port, vlan range, tagged)
    let mut entries: Vec<(String, String, bool)> = Vec::new();
    if let Some(j) = json_of(raw) {
        let Some(map) = j.as_object() else { return Vec::new() };
        for (port, v) in map {
            if let Some(vl) = v.get("vlan").and_then(Value::as_object) {
                for (vid, s) in vl {
                    entries.push((port.clone(), vid.clone(), text_at(s, &["tag-state"]).as_deref() != Some("untagged")));
                }
            }
        }
    } else if let Some((_, rows)) = table(raw, "port") {
        let mut port = String::new();
        for r in rows {
            if let Some(p) = r.first().filter(|p| !p.is_empty()) {
                port = p.clone();
            }
            let (Some(vid), Some(tag)) = (r.get(1), r.get(2)) else { continue };
            if !port.is_empty() && !vid.is_empty() {
                entries.push((port.clone(), vid.clone(), tag != "untagged"));
            }
        }
    }
    let mut out: Vec<PortVlans> = Vec::new();
    for (port, range, tagged) in entries {
        let ids = crate::vlans::expand_vlan_list(&range);
        let pv = match out.iter_mut().position(|p| p.port == port) {
            Some(i) => &mut out[i],
            None => {
                out.push(PortVlans { port: port.clone(), mode: "access".into(), vlan: None, trunk_vlans: Vec::new() });
                out.last_mut().expect("just pushed")
            }
        };
        if tagged {
            pv.mode = "trunk".into();
            pv.trunk_vlans.extend(ids);
        } else {
            pv.vlan = ids.first().copied();
        }
    }
    for p in &mut out {
        p.trunk_vlans.sort_unstable();
        p.trunk_vlans.dedup();
    }
    out
}

/// The VLAN list in the classic crawler's shape, each with its access
/// ports — a trunk's native VLAN is not an access port's.
pub fn vlan_list(ids: &[(u16, Option<u32>)], ports: &[PortVlans]) -> Vec<Vlan> {
    ids.iter()
        .map(|(id, _)| Vlan {
            id: *id,
            name: format!("vlan{id}"),
            status: "active".into(),
            ports: ports.iter().filter(|p| p.mode == "access" && p.vlan == Some(*id)).map(|p| p.port.clone()).collect(),
        })
        .collect()
}

/// `key : value` pairs on one line, however many: STP's two-column blocks.
fn colon_pairs(line: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let parts: Vec<&str> = line.split(" : ").collect();
    // "a : 1    b : 2" splits to ["a", "1    b", "2"].
    for k in 0..parts.len().saturating_sub(1) {
        let key = parts[k].split("  ").filter(|s| !s.trim().is_empty()).last().unwrap_or("").trim();
        let value = parts[k + 1].trim().split("  ").next().unwrap_or("").trim();
        if !key.is_empty() {
            out.push((key.to_string(), value.to_string()));
        }
    }
    out
}

/// One bridge's spanning tree, from `nv show bridge domain br_default stp`
/// (the bridge, its root, and each port's role and state) and `… stp port`
/// (each port's edge and MLAG flags), as the classic crawler's instance.
pub fn spanning_tree(stp: &str, stp_port: &str) -> Option<StpInstance> {
    if refused(stp) {
        return None;
    }
    let mut inst = StpInstance { instance: "br_default".into(), vlan: None, protocol: None, root_bridge: None, root_priority: None, is_root: false, root_port: None, bridge_address: None, ports: Vec::new() };
    if let Some(j) = json_of(stp) {
        inst.protocol = text_at(&j, &["mode"]);
        // RSTP: one tree, written as VLAN 1's in `vlan`, or per VLAN under PVRST.
        let tree = at(&j, &["vlan"]).and_then(Value::as_object).and_then(|o| o.values().next()).cloned().unwrap_or(Value::Null);
        inst.bridge_address = text_at(&tree, &["bridge-id"]).map(|b| b.rsplit('.').next().unwrap_or(&b).to_ascii_lowercase());
        inst.root_bridge = text_at(&tree, &["designated-root"]).map(|b| b.rsplit('.').next().unwrap_or(&b).to_ascii_lowercase());
        inst.root_port = text_at(&tree, &["root-port"]).filter(|p| p != "-");
        inst.root_priority = text_at(&j, &["priority"]).and_then(|p| p.parse().ok());
        if let Some(info) = at(&tree, &["port-info"]).and_then(Value::as_object) {
            for (port, p) in info {
                inst.ports.push(StpPort { port: port.clone(), role: role(&text_at(p, &["role"]).unwrap_or_default()), state: state(&text_at(p, &["state"]).unwrap_or_default()), cost: text_at(p, &["port-path-cost"]).and_then(|c| c.parse().ok()) });
            }
        }
    } else {
        let mut port: Option<StpPort> = None;
        let mut block = "";
        for line in stp.lines() {
            let t = line.trim();
            if let Some(name) = t.strip_prefix("Interface info:").or_else(|| t.strip_prefix("Interface Info:")) {
                inst.ports.extend(port.take());
                port = Some(StpPort { port: name.trim().to_string(), role: String::new(), state: String::new(), cost: None });
                continue;
            }
            if t.starts_with("Bridge ID") {
                block = "bridge";
            } else if t.starts_with("Designated Root ID") {
                block = "root";
            } else if !t.starts_with("priority") && !t.starts_with("mode") && t.contains(':') && !line.starts_with(' ') {
                block = "";
            }
            for (k, v) in colon_pairs(t) {
                match (k.as_str(), &mut port) {
                    ("role", Some(p)) => p.role = role(&v),
                    ("state", Some(p)) => p.state = state(&v),
                    ("port-path-cost", Some(p)) => p.cost = v.parse().ok(),
                    ("mode", None) => inst.protocol = Some(v),
                    ("mac-address", None) if block == "bridge" => inst.bridge_address = Some(v.to_ascii_lowercase()),
                    ("mac-address", None) if block == "root" => inst.root_bridge = Some(v.to_ascii_lowercase()),
                    ("priority", None) if block == "root" => inst.root_priority = v.parse().ok(),
                    ("root-port", None) => inst.root_port = Some(v).filter(|p| p != "-"),
                    _ => {}
                }
            }
        }
        inst.ports.extend(port);
    }
    inst.is_root = inst.root_bridge.is_some() && inst.root_bridge == inst.bridge_address;
    // `stp port` adds nothing the diagram draws but says which ports are
    // edge ports; a port it names that `stp` did not is listed as disabled.
    for name in stp_ports(stp_port).into_iter().map(|p| p.0) {
        if !inst.ports.iter().any(|p| p.port == name) {
            inst.ports.push(StpPort { port: name, role: "Disa".into(), state: "DIS".into(), cost: None });
        }
    }
    Some(inst)
}

/// `nv show bridge domain br_default stp port`: per port, `(name, enabled,
/// edge, clag-role, clag-isl)`.
pub fn stp_ports(raw: &str) -> Vec<(String, bool, bool, Option<String>, bool)> {
    if refused(raw) {
        return Vec::new();
    }
    let mut out: Vec<(String, bool, bool, Option<String>, bool)> = Vec::new();
    if let Some(j) = json_of(raw) {
        for (name, p) in j.as_object().into_iter().flatten() {
            out.push((name.clone(), is_on(p.get("enabled")), is_on(p.get("oper-edge-port")), text_at(p, &["clag-role"]), is_on(p.get("clag-isl"))));
        }
        return out;
    }
    for line in raw.lines() {
        let t = line.trim();
        if let Some(name) = t.strip_prefix("Interface Info:").or_else(|| t.strip_prefix("Interface info:")) {
            out.push((name.trim().to_string(), false, false, None, false));
            continue;
        }
        let Some(p) = out.last_mut() else { continue };
        for (k, v) in colon_pairs(t) {
            match k.as_str() {
                "enabled" => p.1 = v == "yes",
                "oper-edge-port" => p.2 = v == "yes",
                "clag-role" => p.3 = Some(v).filter(|v| v != "unknown"),
                "clag-isl" => p.4 = v == "yes",
                _ => {}
            }
        }
    }
    out
}

/// NVUE's roles and states in the four-letter words the classic crawler's
/// spanning-tree reader prints, so one blocked-port test reads both.
fn role(r: &str) -> String {
    match r.to_ascii_lowercase().as_str() {
        "root" => "Root",
        "designated" => "Desg",
        "alternate" => "Altn",
        "backup" => "Back",
        "disabled" => "Disa",
        "master" => "Mstr",
        _ => r,
    }
    .to_string()
}

fn state(s: &str) -> String {
    match s.to_ascii_lowercase().as_str() {
        "forwarding" => "FWD",
        "discarding" | "blocking" => "BLK",
        "learning" => "LRN",
        "listening" => "LIS",
        "disabled" => "DIS",
        _ => s,
    }
    .to_string()
}

// ------------------------------------------------------------ routing

/// `nv show vrf`: each VRF and its kernel table.
pub fn vrfs(raw: &str) -> Vec<(String, Option<u32>)> {
    if refused(raw) {
        return Vec::new();
    }
    if let Some(j) = json_of(raw) {
        return j.as_object().into_iter().flatten().map(|(name, v)| (name.clone(), text_at(v, &["table"]).and_then(|t| t.parse().ok()))).collect();
    }
    let Some((_, rows)) = table(raw, "Name") else { return Vec::new() };
    rows.into_iter().filter_map(|r| Some((r.first().filter(|n| !n.is_empty())?.clone(), r.get(1).and_then(|t| t.parse().ok())))).collect()
}

/// The RIB: `nv show vrf <vrf> router rib ipv4|ipv6 route`. The JSON names
/// each route's next hops; the table does not — it has the prefix, the
/// protocol, distance, metric and flags, and only the selected entry of
/// each prefix is kept. A connected route's interface is not in it either,
/// so the kernel's own table (`ip -j route show table all`) is what says
/// where a prefix leaves.
pub fn rib(raw: &str, family: u8) -> Vec<Route> {
    if refused(raw) {
        return Vec::new();
    }
    let mut out = Vec::new();
    if let Some(j) = json_of(raw) {
        let routes = j.get("route").unwrap_or(&j);
        for (prefix, r) in routes.as_object().into_iter().flatten() {
            let entries: Vec<&Value> = r.get("route-entry").and_then(Value::as_object).map(|o| o.values().collect()).unwrap_or_default();
            let chosen = entries.iter().find(|e| at(e, &["flags", "selected"]).is_some()).or(entries.first());
            let Some(e) = chosen else { continue };
            let mut next_hops = Vec::new();
            let mut interface = None;
            for (key, via) in e.get("via-entry").and_then(Value::as_object).into_iter().flatten() {
                let addr = text_at(via, &["via"]).unwrap_or_else(|| key.clone());
                if addr.parse::<std::net::IpAddr>().is_ok() {
                    next_hops.push(addr);
                }
                interface = interface.or_else(|| text_at(via, &["interface"]));
            }
            let protocol = text_at(e, &["protocol"]).unwrap_or_default();
            out.push(Route {
                family,
                prefix: prefix.clone(),
                code: protocol.clone(),
                protocol: if protocol == "kernel" { "static".into() } else { protocol },
                next_hops,
                interface,
                distance: text_at(e, &["distance"]).and_then(|d| d.parse().ok()),
                metric: text_at(e, &["metric"]).and_then(|d| d.parse().ok()),
                next_hop_vrf: None,
                segment_id: None,
            });
        }
        return out;
    }
    let Some((cols, rows)) = table(raw, "Route") else { return out };
    let col = |n: &str| cols.iter().position(|c| c.0 == n);
    let (cr, cp, cd, cm, cf) = (col("Route"), col("Protocol"), col("Distance"), col("Metric"), col("Flags"));
    let mut prefix = String::new();
    for r in rows {
        let get = |c: Option<usize>| c.and_then(|c| r.get(c)).cloned().unwrap_or_default();
        let p = get(cr);
        if !p.is_empty() {
            prefix = p;
        }
        // `*` is the selected entry; one per prefix.
        if prefix.is_empty() || !get(cf).contains('*') || out.iter().any(|x: &Route| x.prefix == prefix) {
            continue;
        }
        let protocol = get(cp);
        out.push(Route {
            family,
            prefix: prefix.clone(),
            code: protocol.clone(),
            protocol,
            next_hops: Vec::new(),
            interface: None,
            distance: get(cd).parse().ok(),
            metric: get(cm).parse().ok(),
            next_hop_vrf: None,
            segment_id: None,
        });
    }
    out
}

/// One OSPF adjacency.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OspfNeighbour {
    pub router_id: String,
    pub address: Option<String>,
    pub interface: Option<String>,
    pub local_ip: Option<String>,
    /// `full`, `2-way`, …, lower-case.
    pub state: String,
    /// `DR`, `Backup`, `DROther`.
    pub role: Option<String>,
    pub area: Option<String>,
}

/// OSPF neighbours from NVUE's `nv show vrf <vrf> router ospf neighbor -o
/// json` (schema), or FRR's `show ip ospf neighbor detail` (the operator's
/// capture): ` Neighbor 10.0.0.1, interface address 10.1.1.1` / `In the
/// area 0.0.0.0 via interface vlan250 local interface IP 10.1.1.3` /
/// `Neighbor priority is 1, State is Full/DROther, Role is DROther`.
pub fn ospf_neighbors(raw: &str) -> Vec<OspfNeighbour> {
    if refused(raw) {
        return Vec::new();
    }
    let mut out = Vec::new();
    if let Some(j) = json_of(raw) {
        for (rid, n) in j.as_object().into_iter().flatten() {
            for (ifname, i) in n.get("interface").and_then(Value::as_object).into_iter().flatten() {
                for (local, l) in i.get("local-ip").and_then(Value::as_object).into_iter().flatten() {
                    out.push(OspfNeighbour {
                        router_id: rid.clone(),
                        address: text_at(l, &["neighbor-ip"]),
                        interface: Some(ifname.clone()),
                        local_ip: Some(local.clone()),
                        state: text_at(l, &["state"]).unwrap_or_default().to_ascii_lowercase(),
                        role: text_at(l, &["role"]),
                        area: text_at(l, &["area-id"]),
                    });
                }
            }
        }
        return out;
    }
    let word_after = |t: &str, label: &str| -> Option<String> { t.split(label).nth(1).map(|r| r.trim().split([',', ' ']).next().unwrap_or("").to_string()).filter(|s| !s.is_empty()) };
    for line in raw.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("Neighbor ").filter(|r| r.contains("interface address")) {
            out.push(OspfNeighbour { router_id: rest.split(',').next().unwrap_or("").trim().to_string(), address: word_after(t, "interface address"), ..OspfNeighbour::default() });
            continue;
        }
        let Some(n) = out.last_mut() else { continue };
        if t.starts_with("In the area") {
            n.area = word_after(t, "In the area");
            n.interface = word_after(t, "via interface");
            n.local_ip = word_after(t, "local interface IP");
        } else if t.starts_with("Neighbor priority") {
            let state = word_after(t, "State is").unwrap_or_default();
            n.state = state.split('/').next().unwrap_or("").to_ascii_lowercase();
            n.role = word_after(t, "Role is");
        }
    }
    out
}

/// FRR's `show ip ospf`: the router id.
pub fn ospf_router_id(raw: &str) -> Option<String> {
    raw.lines().find_map(|l| l.split("Router ID:").nth(1)).map(|r| r.trim().to_string()).filter(|r| !r.is_empty())
}

// -------------------------------------------------------- MLAG and overlay

/// The MLAG pair, from `nv show mlag -o json` (schema).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Mlag {
    pub local_role: Option<String>,
    pub peer_role: Option<String>,
    pub peer_ip: Option<String>,
    pub peer_interface: Option<String>,
    pub peer_alive: Option<String>,
    pub system_mac: Option<String>,
    pub backup_ip: Option<String>,
}

pub fn mlag(raw: &str) -> Option<Mlag> {
    if refused(raw) {
        return None;
    }
    let get: KeyLookup = match json_of(raw) {
        Some(j) => Box::new(move |k: &str| text_at(&j, &[k])),
        None => {
            let p = pairs(raw);
            Box::new(move |k: &str| pair(&p, k))
        }
    };
    let m = Mlag {
        local_role: get("local-role"),
        peer_role: get("peer-role"),
        peer_ip: get("peer-ip"),
        peer_interface: get("peer-interface"),
        peer_alive: get("peer-alive"),
        system_mac: get("mac-address").filter(|m| m != "auto").map(|m| m.to_ascii_lowercase()),
        backup_ip: get("backup-active").and(get("backup-ip")),
    };
    (m.local_role.is_some() || m.peer_ip.is_some()).then_some(m)
}

/// MLAG as it shows in `stp port` when `nv show mlag` was not answered:
/// this switch's role and the ISL — the peer link.
pub fn mlag_from_stp(stp_port: &str) -> Option<Mlag> {
    let ports = stp_ports(stp_port);
    let role = ports.iter().find_map(|p| p.3.clone())?;
    let isl = ports.iter().find(|p| p.4).map(|p| p.0.clone());
    Some(Mlag { local_role: Some(role), peer_interface: isl, ..Mlag::default() })
}

/// VXLAN: on, and from which source address. `nv show nve vxlan` — the
/// operator's says `state  disabled`.
pub fn vxlan(raw: &str) -> Option<String> {
    if refused(raw) {
        return None;
    }
    match json_of(raw) {
        Some(j) => is_on(j.get("enable")).then(|| text_at(&j, &["source", "address"]).unwrap_or_default()),
        None => {
            let p = pairs(raw);
            let on = pair(&p, "state").or_else(|| pair(&p, "enable")).map(|s| matches!(s.as_str(), "enabled" | "on" | "up")).unwrap_or(false);
            on.then(|| pair(&p, "address").unwrap_or_default())
        }
    }
}

/// EVPN: on or off. `nv show evpn`.
pub fn evpn_on(raw: &str) -> bool {
    if refused(raw) {
        return false;
    }
    match json_of(raw) {
        Some(j) => is_on(j.get("enable")),
        None => pairs(raw).iter().any(|(k, v)| (k == "state" || k == "enable") && matches!(v.as_str(), "enabled" | "on")),
    }
}

/// The overlay the classic crawler draws: the VTEP, and each VLAN's VNI.
pub fn overlay(vtep: Option<String>, vlans: &[(u16, Option<u32>)]) -> Option<crate::overlay::Overlay> {
    let vtep = vtep?;
    Some(crate::overlay::Overlay {
        vtep: Some(vtep).filter(|v| !v.is_empty()),
        segments: vlans.iter().filter_map(|(vlan, vni)| vni.map(|vni| crate::overlay::Segment { vni, vlan: Some(u32::from(*vlan)), kind: Some("L2".into()), vrf: None })).collect(),
        peers: Vec::new(),
        learned: Vec::new(),
    })
}

// ------------------------------------------------- the classic crawler's

/// `nv show interface` straight to the classic crawler's addresses.
pub fn parse_interfaces(raw: &str) -> Vec<Interface> {
    interfaces(&ports(raw))
}

/// `nv show interface -o json` straight to its bonds.
pub fn parse_bonds(raw: &str) -> Vec<PortChannel> {
    bonds(&ports(raw), "")
}

/// `nv show interface bond-members` straight to its bonds.
pub fn parse_bond_members(raw: &str) -> Vec<PortChannel> {
    if refused(raw) {
        return Vec::new();
    }
    bonds(&[], raw)
}

/// The bridge domains: `nv show bridge domain` (`br_default` on the
/// captured switch and on every Cumulus 5 by default).
pub fn bridge_domains(raw: &str) -> Vec<String> {
    if refused(raw) {
        return Vec::new();
    }
    if let Some(j) = json_of(raw) {
        return j.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    }
    table(raw, "Domain").map(|(_, rows)| rows.into_iter().filter_map(|r| r.into_iter().next().filter(|d| !d.is_empty())).collect()).unwrap_or_default()
}

/// The kernel's table, `ip route show` (iproute2's own layout, which every
/// Linux prints): `default via 10.0.0.1 dev swp1 proto ospf metric 20`,
/// `10.1.1.0/24 dev vlan10 proto kernel scope link src 10.1.1.3`, and a
/// multipath route's `nexthop via …` lines under it. What FRR selected is
/// what is here, with its next hops — the part NVUE's RIB table leaves out.
pub fn linux_routes(raw: &str) -> Vec<Route> {
    if refused(raw) {
        return Vec::new();
    }
    let mut out: Vec<Route> = Vec::new();
    for line in raw.lines() {
        let w: Vec<&str> = line.split_whitespace().collect();
        let Some(first) = w.first() else { continue };
        let after = |key: &str| w.iter().position(|x| *x == key).and_then(|i| w.get(i + 1)).map(|s| s.to_string());
        if *first == "nexthop" {
            if let Some(r) = out.last_mut() {
                r.next_hops.extend(after("via"));
                if r.interface.is_none() {
                    r.interface = after("dev");
                }
            }
            continue;
        }
        if line.starts_with(char::is_whitespace) || matches!(*first, "broadcast" | "local" | "unreachable" | "blackhole" | "prohibit" | "anycast" | "multicast") {
            continue;
        }
        let prefix = if *first == "default" {
            if line.contains(':') { "::/0".to_string() } else { "0.0.0.0/0".to_string() }
        } else if first.contains('/') {
            first.to_string()
        } else if first.parse::<std::net::IpAddr>().is_ok() {
            format!("{first}/{}", if first.contains(':') { 128 } else { 32 })
        } else {
            continue;
        };
        let proto = after("proto").unwrap_or_else(|| "static".into());
        let protocol = match proto.as_str() {
            "kernel" => "connected".to_string(),
            "boot" | "static" => "static".to_string(),
            "zebra" => "other".to_string(),
            p => p.to_string(),
        };
        out.push(Route {
            family: if prefix.contains(':') { 6 } else { 4 },
            prefix,
            code: proto,
            protocol,
            next_hops: after("via").into_iter().collect(),
            interface: after("dev"),
            distance: None,
            metric: after("metric").and_then(|m| m.parse().ok()),
            next_hop_vrf: None,
            segment_id: None,
        });
    }
    out
}

/// The default route's next hop, from NVUE's JSON for the one route
/// (`nv show vrf default router rib ipv4 route 0.0.0.0/0 -o json`) or for
/// the table, or from the kernel's `default via …`.
pub fn default_next_hop(raw: &str) -> Option<std::net::Ipv4Addr> {
    let routes = match json_of(raw) {
        Some(j) if j.get("route-entry").is_some() => rib(&serde_json::json!({ "0.0.0.0/0": j }).to_string(), 4),
        Some(_) => rib(raw, 4),
        None => linux_routes(raw),
    };
    routes.into_iter().find(|r| r.prefix == "0.0.0.0/0").and_then(|r| r.next_hops.into_iter().find_map(|h| h.parse().ok()))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A real SN2010 on Cumulus 5.18, 2026-10-06, reduced to
    /// invented names and documentation addresses.
    macro_rules! capture {
        ($f:literal) => {
            include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/cumulus5/", $f))
        };
    }
    pub(crate) const VERSION: &str = capture!("nv_show_system_version.txt");
    pub(crate) const PLATFORM: &str = capture!("nv_show_platform.txt");
    pub(crate) const INTERFACE: &str = capture!("nv_show_interface.txt");
    pub(crate) const LLDP_DETAIL: &str = capture!("lldpcli_show_neighbors_details.txt");
    pub(crate) const VRF: &str = capture!("nv_show_vrf.txt");
    pub(crate) const RIB4: &str = capture!("nv_show_rib_ipv4_route.txt");
    pub(crate) const RIB6: &str = capture!("nv_show_rib_ipv6_route.txt");
    pub(crate) const OSPF: &str = capture!("vtysh_show_ip_ospf.txt");
    pub(crate) const OSPF_NEIGHBOR: &str = capture!("vtysh_show_ip_ospf_neighbor_detail.txt");
    pub(crate) const BRIDGE_VLAN: &str = capture!("nv_show_bridge_domain_vlan.txt");
    pub(crate) const PORT_VLAN: &str = capture!("nv_show_bridge_domain_port_vlan.txt");
    pub(crate) const STP: &str = capture!("nv_show_bridge_domain_stp.txt");
    pub(crate) const STP_PORT: &str = capture!("nv_show_bridge_domain_stp_port.txt");
    pub(crate) const VXLAN: &str = capture!("nv_show_nve_vxlan.txt");
    pub(crate) const EVPN: &str = capture!("nv_show_evpn.txt");
    pub(crate) const EVPN_ROUTE: &str = capture!("nv_show_bgp_l2vpn_evpn_route.txt");

    /// `nv show system` was not in the captures; this is NVIDIA's documented
    /// layout for 5.10 and later, with the operator's hostname.
    pub(crate) const SYSTEM_TEXT: &str = "                   operational          applied\n-----------------  -------------------  -----------------\nuptime             5:07:49\nhostname           leaf-b02             leaf-b02\nfqdn               leaf-b02\nproduct-name       Cumulus Linux\ndate-time\n  local-time       2026-10-06 21:23:16\n  timezone         Etc/UTC              Etc/UTC\n";

    #[test]
    fn identity_from_the_three_identity_replies() {
        let id = identity(&[SYSTEM_TEXT, PLATFORM, VERSION]);
        assert_eq!(id.hostname.as_deref(), Some("leaf-b02"));
        assert_eq!(id.product.as_deref(), Some("Cumulus Linux"));
        assert_eq!(id.release.as_deref(), Some("5.18.0"));
        assert_eq!(id.build_id.as_deref(), Some("5.18.0.0045"));
        assert_eq!(id.model.as_deref(), Some("MSN2010"));
        assert_eq!(id.serial.as_deref(), Some("MT0000EXMP"));
        assert_eq!(id.base_mac.as_deref(), Some("1c:34:da:00:28:3f"));
        assert_eq!(id.manufacturer.as_deref(), Some("Mellanox"));
        assert_eq!(id.asic.as_deref(), Some("Spectrum"));
        assert!(is_cumulus(SYSTEM_TEXT));
        assert!(!is_cumulus("-bash: nv: command not found"));
    }

    #[test]
    fn identity_from_json_in_nvidias_object_model() {
        // NVUE's `-o json` for the same three, shaped by the published schema.
        let system = r#"{"hostname": "leaf-b02", "product-name": "Cumulus Linux", "uptime": 18469}"#;
        let platform = r#"{"system-mac": "1c:34:da:00:28:3f", "manufacturer": "Mellanox", "product-name": "MSN2010", "serial-number": "MT0000EXMP", "asic-model": "Spectrum"}"#;
        let version = r#"{"onie": "2018.08-5.2.0006-115200", "product-release": "5.18.0", "image": {"build-id": "5.18.0.0045"}}"#;
        let id = identity(&[system, platform, version]);
        assert_eq!((id.hostname.as_deref(), id.model.as_deref(), id.serial.as_deref(), id.release.as_deref()), (Some("leaf-b02"), Some("MSN2010"), Some("MT0000EXMP"), Some("5.18.0")));
        // An older release's `build` line.
        assert_eq!(identity(&["           operational\n----------  ------------------\nhostname    leaf01\nbuild       Cumulus Linux 5.5.0\n"]).release.as_deref(), Some("5.5.0"));
    }

    #[test]
    fn the_interface_table_with_its_addresses_vrr_and_neighbours() {
        let p = ports(INTERFACE);
        let get = |n: &str| p.iter().find(|x| x.name == n).unwrap_or_else(|| panic!("{n}"));
        assert_eq!(p.len(), 54);
        let eth0 = get("eth0");
        assert_eq!((eth0.kind.as_str(), eth0.oper_up, eth0.speed.as_deref(), eth0.mtu), ("eth", true, Some("1G"), Some(1500)));
        assert_eq!(eth0.addresses[0], "198.51.100.12/24");
        assert_eq!(eth0.addresses.len(), 3);
        assert_eq!((get("swp1").remote_host.as_deref(), get("swp1").remote_port.as_deref()), (Some("cx-1"), Some("1/1/50")));
        assert!(!get("swp5").oper_up && get("swp5").admin_up);
        let v110 = get("vlan110");
        assert_eq!(v110.addresses, ["10.66.110.3/24", "fe80::1e34:daff:fe00:283f/64"]);
        assert_eq!(v110.virtual_addresses, ["10.66.110.1/24"]);
        assert!(get("vlan110-v0").is_vrr() && !get("vlan110").is_vrr() && !get("peerlink.4094").is_vrr());
        let own = interfaces(&p);
        assert!(own.iter().any(|i| i.name == "eth0" && i.address.as_deref() == Some("198.51.100.12")));
        assert!(own.iter().any(|i| i.name == "vlan250" && i.address.as_deref() == Some("10.66.250.3")));
        // Not loopback's, not the management VRF's, not VRR's shared address.
        assert!(!own.iter().any(|i| i.address.as_deref().is_some_and(|a| a.starts_with("127.") || a == "10.66.110.1")));
        let bonds = bonds(&p, "");
        assert!(bonds.is_empty(), "the table does not name members");
        let n = neighbours(INTERFACE);
        assert_eq!(n.iter().map(|n| (n.local_interface.as_deref().unwrap(), n.short_name.as_str())).collect::<Vec<_>>()[..3], [("eth0", "leaf-b02"), ("swp1", "cx-1"), ("swp3", "leaf-b02")]);
    }

    #[test]
    fn interfaces_and_bonds_from_json() {
        let j = r#"{
          "bond1": {"type": "bond", "link": {"oper-status": "up", "admin-status": "up", "speed": "10G", "mtu": 9216}, "bond": {"member": {"swp49": {}, "swp50": {}}}},
          "eth0": {"type": "eth", "link": {"state": {"up": {}}, "mtu": 1500}, "ip": {"address": {"198.51.100.12/24": {}}, "vrf": "mgmt"},
                   "lldp": {"neighbor": {"cx-1": {"chassis": {"system-name": "cx-1"}, "port": {"name": "1/1/50"}}}}},
          "vlan110": {"type": "svi", "link": {"oper-status": "up"}, "ip": {"address": {"10.66.110.3/24": {}}, "vrr": {"address": {"10.66.110.1/24": {}}, "state": {"up": {}}}}}
        }"#;
        let p = ports(j);
        assert_eq!(p.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["bond1", "eth0", "vlan110"]);
        assert!(p[1].oper_up && p[1].admin_up);
        assert_eq!((p[1].remote_host.as_deref(), p[1].vrf.as_deref()), (Some("cx-1"), Some("mgmt")));
        assert_eq!(p[2].virtual_addresses, ["10.66.110.1/24"]);
        let b = bonds(&p, "Interface  Parent  Admin Status  Oper Status  Speed  MTU \n---------  ------  ------------  -----------  -----  ----\nswp51      peerlink  up          up           100G   9216\n");
        assert_eq!(b[0].members, ["swp49", "swp50"]);
        assert_eq!(b.len(), 2, "a parent the interface list did not name a bond is still read");
        assert_eq!((b[1].name.as_str(), b[1].members.clone()), ("peerlink", vec!["swp51".to_string()]));
    }

    #[test]
    fn neighbours_from_lldpds_detail_with_cdp_and_the_management_addresses() {
        let n = neighbours(LLDP_DETAIL);
        let by = |local: &str, proto: Protocol| n.iter().find(|x| x.local_interface.as_deref() == Some(local) && x.discovered_by == proto).unwrap_or_else(|| panic!("{local}"));
        let cx = by("swp1", Protocol::Lldp);
        assert_eq!((cx.device_id.as_str(), cx.remote_interface.as_deref(), cx.address()), ("cx-1", Some("1/1/50"), Some("198.51.100.4")));
        assert_eq!(cx.version.as_deref(), Some("HPE ANW JL727A  ML.10.18.1002"));
        assert_eq!(cx.class, DeviceClass::Switch);
        // lldpd hears CDP too, and says so.
        let old = by("swp9", Protocol::Cdp);
        assert_eq!((old.short_name.as_str(), old.remote_interface.as_deref(), old.address()), ("access-a1", Some("GigabitEthernet0/1"), Some("198.51.100.23")));
        let old_lldp = by("swp9", Protocol::Lldp);
        assert_eq!(old_lldp.platform.as_deref(), Some("WS-C3560-24PS"));
        assert_eq!(by("swp12", Protocol::Cdp).address(), Some("10.77.0.7"));
        // A port id that is a MAC is the description instead.
        let gw = by("swp16", Protocol::Lldp);
        assert_eq!((gw.short_name.as_str(), gw.remote_interface.as_deref(), gw.address()), ("edge-gw-a01", Some("eth9"), Some("198.51.100.1")));
        assert!(!gw.addresses.iter().any(|a| a.ip.starts_with("fe80")), "a link-local address is nowhere to connect");
        let peer = by("swp21", Protocol::Lldp);
        assert_eq!((peer.short_name.as_str(), peer.address()), ("leaf-b01", Some("198.51.100.13")));
        assert_eq!(by("swp20", Protocol::Lldp).chassis_id.as_deref(), Some("b496910000f1"));
    }

    #[test]
    fn neighbours_from_json() {
        let j = r#"{"swp1": {"lldp": {"neighbor": {"cx-1": {"chassis": {"chassis-id": "88:3a:30:00:00:c0", "system-name": "cx-1", "management-address-ipv4": "198.51.100.4", "management-address-ipv6": "fe80::1", "system-description": "HPE ANW JL727A ML.10.18.1002", "capability": {"is-bridge": "on", "is-router": "on"}}, "port": {"name": "1/1/50"}}}}},
                     "swp16": {"neighbor": {"x": {"chassis": {"system-name": "edge-gw-a01"}, "port": {"name": "60:22:32:00:00:46", "description": "eth9"}, "lldp-med": {"inventory": {"model": "UDM-SE", "serial-number": "EXAMPLE1"}}}}}}"#;
        let n = neighbours(j);
        assert_eq!(n.len(), 2);
        assert_eq!((n[0].address(), n[0].capabilities.clone(), n[0].class), (Some("198.51.100.4"), vec!["Bridge".to_string(), "Router".to_string()], DeviceClass::Switch));
        assert_eq!(n[0].addresses.len(), 1);
        assert_eq!((n[1].remote_interface.as_deref(), n[1].platform.as_deref(), n[1].serial.as_deref()), (Some("eth9"), Some("UDM-SE"), Some("EXAMPLE1")));
    }

    /// A real switch answered the JSON with names,
    /// descriptions and models and no address the reader found. However
    /// NVUE nests it — a list, an object keyed by the address, a
    /// `management-address` object per family — it is found; and a reply
    /// whose neighbours carry none at all is not taken as the answer.
    #[test]
    fn a_management_address_is_found_in_any_shape_and_none_at_all_asks_the_table() {
        for chassis in [
            r#"{"system-name": "cx-1", "management-address-ipv4": ["198.51.100.4"]}"#,
            r#"{"system-name": "cx-1", "management-address-ipv4": {"198.51.100.4": {}, "198.51.100.5": {}}}"#,
            r#"{"system-name": "cx-1", "management-address": {"ipv4": "198.51.100.4", "ipv6": "fe80::1"}}"#,
            r#"{"system-name": "cx-1", "mgmt-ip": "198.51.100.4"}"#,
        ] {
            let j = format!(r#"{{"swp1": {{"lldp": {{"neighbor": {{"cx-1": {{"chassis": {chassis}, "port": {{"name": "1/1/50"}}}}}}}}}}}}"#);
            let n = neighbours(&j);
            assert_eq!(n.len(), 1, "{chassis}");
            assert_eq!(n[0].address(), Some("198.51.100.4"), "{chassis}");
        }
        let none = r#"{"swp1": {"lldp": {"neighbor": {"cx-1": {"chassis": {"system-name": "cx-1", "system-description": "HPE ANW JL727A  ML.10.18.1002"}, "lldp-med": {"inventory": {"model": "JL727A"}}}}}}}"#;
        assert!(neighbours(none).is_empty(), "no address anywhere: the table is asked");
        // A neighbour that has no address of its own beside one that has is still read.
        let mixed = r#"{"swp1": {"lldp": {"neighbor": {"a": {"chassis": {"system-name": "a", "management-address-ipv4": "198.51.100.4"}}}}}, "swp20": {"lldp": {"neighbor": {"b": {"chassis": {"chassis-id": "b4:96:91:00:00:f1"}}}}}}"#;
        assert_eq!(neighbours(mixed).len(), 2);
    }

    #[test]
    fn vlans_ports_and_spanning_tree() {
        let v = vlans(BRIDGE_VLAN);
        assert_eq!(v.len(), 23);
        assert_eq!((v[0], v[22]), ((1, None), (250, None)));
        let pv = port_vlans(PORT_VLAN);
        let bond1 = pv.iter().find(|p| p.port == "bond1").unwrap();
        assert_eq!((bond1.mode.as_str(), bond1.vlan), ("trunk", Some(1)));
        assert_eq!(bond1.trunk_vlans[..6], [2, 3, 4, 5, 20, 30]);
        assert_eq!(bond1.trunk_vlans.len(), 22);
        let edge = pv.iter().find(|p| p.port == "brport-if30").unwrap();
        assert_eq!((edge.mode.as_str(), edge.vlan, edge.trunk_vlans.len()), ("access", Some(1), 0));
        assert_eq!(pv.len(), 22);
        let list = vlan_list(&v, &pv);
        assert_eq!(list[0].ports, ["brport-if30"]);
        let t = spanning_tree(STP, STP_PORT).unwrap();
        assert_eq!(t.protocol.as_deref(), Some("rstp"));
        assert_eq!((t.bridge_address.as_deref(), t.root_bridge.as_deref(), t.root_priority, t.root_port.as_deref()), (Some("02:00:00:00:01:01"), Some("02:00:00:00:01:01"), Some(8192), None));
        assert!(t.is_root);
        let swp10 = t.ports.iter().find(|p| p.port == "swp10").unwrap();
        assert_eq!((swp10.role.as_str(), swp10.state.as_str(), swp10.cost), ("Disa", "BLK", Some(2000)));
        let peer = t.ports.iter().find(|p| p.port == "peerlink").unwrap();
        assert_eq!((peer.role.as_str(), peer.state.as_str(), peer.cost), ("Desg", "FWD", Some(200)));
        assert_eq!(t.ports.len(), 22);
        let sp = stp_ports(STP_PORT);
        assert_eq!(sp.iter().find(|p| p.0 == "peerlink").map(|p| (p.1, p.2, p.3.clone(), p.4)), Some((true, true, Some("secondary".into()), true)));
        let m = mlag_from_stp(STP_PORT).unwrap();
        assert_eq!((m.local_role.as_deref(), m.peer_interface.as_deref()), (Some("secondary"), Some("peerlink")));
    }

    #[test]
    fn vrfs_the_rib_and_ospf() {
        assert_eq!(vrfs(VRF), [("default".to_string(), Some(254)), ("mgmt".to_string(), Some(1001))]);
        let r = rib(RIB4, 4);
        assert_eq!(r[0].prefix, "0.0.0.0/0");
        assert_eq!((r[0].protocol.as_str(), r[0].distance, r[0].metric), ("ospf", Some(110), Some(10)));
        // One selected entry per prefix: the connected /24, not its OSPF twin.
        let v110 = r.iter().filter(|x| x.prefix == "10.66.110.0/24").collect::<Vec<_>>();
        assert_eq!(v110.len(), 1);
        assert_eq!((v110[0].protocol.as_str(), v110[0].metric), ("connected", Some(0)));
        assert_eq!(r.iter().find(|x| x.prefix == "10.66.110.3/32").map(|x| x.protocol.as_str()), Some("local"));
        assert_eq!(r.len(), 39);
        let r6 = rib(RIB6, 6);
        assert_eq!(r6.len(), 1);
        assert_eq!(r6[0].prefix, "fe80::/64");
        assert_eq!(ospf_router_id(OSPF).as_deref(), Some("10.254.254.2"));
        let n = ospf_neighbors(OSPF_NEIGHBOR);
        assert_eq!(n.len(), 2);
        assert_eq!(n[0], OspfNeighbour { router_id: "10.254.254.254".into(), address: Some("10.66.250.1".into()), interface: Some("vlan250".into()), local_ip: Some("10.66.250.3".into()), state: "full".into(), role: Some("DROther".into()), area: Some("0.0.0.0".into()) });
        assert_eq!((n[1].router_id.as_str(), n[1].role.as_deref()), ("10.254.254.1", Some("Backup")));
    }

    #[test]
    fn the_rib_and_ospf_from_json() {
        let j = r#"{"route": {"0.0.0.0/0": {"route-entry": {"1": {"protocol": "ospf", "distance": 110, "metric": 10, "flags": {"selected": {}, "installed": {}}, "via-entry": {"10.66.250.1": {"type": "ip-address", "interface": "vlan250"}}}}},
                     "10.66.110.0/24": {"route-entry": {"1": {"protocol": "ospf", "distance": 110, "metric": 1}, "2": {"protocol": "connected", "distance": 0, "metric": 0, "flags": {"selected": {}}, "via-entry": {"vlan110": {"type": "interface", "interface": "vlan110"}}}}}}}"#;
        let r = rib(j, 4);
        assert_eq!((r[0].prefix.as_str(), r[0].next_hops.clone(), r[0].interface.as_deref()), ("0.0.0.0/0", vec!["10.66.250.1".to_string()], Some("vlan250")));
        assert_eq!((r[1].protocol.as_str(), r[1].next_hops.len(), r[1].interface.as_deref()), ("connected", 0, Some("vlan110")));
        let o = r#"{"10.254.254.254": {"interface": {"vlan250": {"local-ip": {"10.66.250.3": {"neighbor-ip": "10.66.250.1", "state": "full", "role": "DROther", "area-id": "0.0.0.0", "priority": 1}}}}}}"#;
        let n = ospf_neighbors(o);
        assert_eq!(n[0], OspfNeighbour { router_id: "10.254.254.254".into(), address: Some("10.66.250.1".into()), interface: Some("vlan250".into()), local_ip: Some("10.66.250.3".into()), state: "full".into(), role: Some("DROther".into()), area: Some("0.0.0.0".into()) });
        let m = mlag(r#"{"enable": "on", "local-role": "secondary", "peer-role": "primary", "peer-ip": "fe80::1", "peer-interface": "peerlink.4094", "peer-alive": "True", "mac-address": "02:00:00:00:01:01", "backup-active": "True", "backup-ip": "198.51.100.13"}"#).unwrap();
        assert_eq!((m.local_role.as_deref(), m.peer_interface.as_deref(), m.system_mac.as_deref(), m.backup_ip.as_deref()), (Some("secondary"), Some("peerlink.4094"), Some("02:00:00:00:01:01"), Some("198.51.100.13")));
    }

    /// iproute2's layout, from its documentation with the operator's
    /// addresses: what the kernel forwards by, next hops included.
    #[test]
    fn the_kernels_table_and_the_default_route() {
        let ip = "default nhid 221 via 10.66.250.1 dev vlan250 proto ospf metric 20 \n10.66.110.0/24 dev vlan110 proto kernel scope link src 10.66.110.3 \n10.99.0.0/16 nhid 230 proto ospf metric 20 \n\tnexthop via 10.66.250.1 dev vlan250 weight 1 \n\tnexthop via 10.66.250.2 dev vlan250 weight 1 \nbroadcast 10.66.110.255 dev vlan110 proto kernel scope link src 10.66.110.3 \n";
        let r = linux_routes(ip);
        assert_eq!(r.len(), 3);
        assert_eq!((r[0].prefix.as_str(), r[0].protocol.as_str(), r[0].next_hops.clone(), r[0].interface.as_deref(), r[0].metric), ("0.0.0.0/0", "ospf", vec!["10.66.250.1".to_string()], Some("vlan250"), Some(20)));
        assert_eq!((r[1].protocol.as_str(), r[1].next_hops.len(), r[1].interface.as_deref()), ("connected", 0, Some("vlan110")));
        assert_eq!(r[2].next_hops, ["10.66.250.1", "10.66.250.2"]);
        assert_eq!(default_next_hop(ip).map(|h| h.to_string()).as_deref(), Some("10.66.250.1"));
        let one = r#"{"route-entry": {"1": {"protocol": "ospf", "distance": 110, "metric": 10, "flags": {"selected": {}}, "via-entry": {"10.66.250.1": {"interface": "vlan250", "type": "ip-address"}}}}}"#;
        assert_eq!(default_next_hop(one).map(|h| h.to_string()).as_deref(), Some("10.66.250.1"));
        assert_eq!(default_next_hop(RIB4), None, "the table names no next hop");
        assert_eq!(bridge_domains(capture!("nv_show_bridge_domain.txt")), ["br_default"]);
        assert_eq!(parse_bond_members("Interface  Parent  Admin Status  Oper Status  Speed  MTU \n---------  ------  ------------  -----------  -----  ----\nswp1       bond1   up            up           1G     9216\nswp2       bond1   up            up           1G     9216\n")[0].members, ["swp1", "swp2"]);
    }

    #[test]
    fn vxlan_and_evpn_off_are_none_and_a_missing_table_is_a_refusal() {
        assert_eq!(vxlan(VXLAN), None);
        assert!(!evpn_on(EVPN));
        assert!(refused(EVPN_ROUTE));
        assert!(rib(EVPN_ROUTE, 4).is_empty());
        assert_eq!(vxlan(r#"{"enable": "on", "source": {"address": "10.0.0.11"}}"#).as_deref(), Some("10.0.0.11"));
        assert!(evpn_on(r#"{"enable": "on"}"#));
        let o = overlay(Some("10.0.0.11".into()), &[(10, Some(10010)), (20, None)]).unwrap();
        assert_eq!((o.vtep.as_deref(), o.segments.len(), o.segments[0].vni, o.segments[0].vlan), (Some("10.0.0.11"), 1, 10010, Some(10)));
        assert!(overlay(None, &[]).is_none());
    }
}
