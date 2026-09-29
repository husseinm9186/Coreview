//! A device's forwarding state, read from its rows: the addresses it owns,
//! its routing table merged per (VRF, prefix) with every next hop, ARP, the
//! MAC table, FHRP groups, STP-blocked ports, zones, policy routes, NAT rules,
//! firewall policies and tunnels. Nothing here is inferred beyond what a row
//! says; a table the collection did not fill is recorded as missing, so the
//! walk can say "not collected" rather than "no route" (D-050).

use std::collections::{BTreeMap, BTreeSet};
use std::net::Ipv4Addr;

use coreview_topology::identity::name_key;
use coreview_topology::ifname::{key, mac};
use coreview_topology::{DeviceIn, Graph, LinkKind, NodeKind, Row};

/// An IPv4 prefix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Net4 {
    pub addr: u32,
    pub len: u8,
}

impl Net4 {
    pub fn new(ip: Ipv4Addr, len: u8) -> Net4 {
        let len = len.min(32);
        Net4 { addr: u32::from(ip) & mask(len), len }
    }

    /// `192.0.2.0/24`, `192.0.2.0/255.255.255.0`, `192.0.2.0 255.255.255.0`,
    /// or a bare address as a /32.
    pub fn parse(s: &str) -> Option<Net4> {
        let s = s.trim();
        let (ip, len) = match s.split_once(['/', ' ']) {
            Some((a, l)) => (a.trim(), Some(l.trim())),
            None => (s, None),
        };
        let ip: Ipv4Addr = ip.parse().ok()?;
        let len = match len {
            None => 32,
            Some(l) => l.parse::<u8>().ok().filter(|l| *l <= 32).or_else(|| mask_len(l))?,
        };
        Some(Net4::new(ip, len))
    }

    pub fn contains(&self, ip: Ipv4Addr) -> bool {
        u32::from(ip) & mask(self.len) == self.addr
    }

    pub fn is_default(&self) -> bool {
        self.len == 0
    }
}

impl std::fmt::Display for Net4 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", Ipv4Addr::from(self.addr), self.len)
    }
}

pub fn mask(len: u8) -> u32 {
    if len == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(len.min(32)))
    }
}

pub fn mask_len(m: &str) -> Option<u8> {
    let m: Ipv4Addr = m.trim().parse().ok()?;
    let bits = u32::from(m);
    (bits.leading_ones() + bits.trailing_zeros() == 32).then(|| bits.leading_ones() as u8)
}

/// One VRF's name as the walk keys it: the global table under every
/// spelling vendors give it is `default`, and Junos's `.inet.0` is dropped.
pub fn vrf_name(v: Option<&str>) -> String {
    let v = v.map(str::trim).unwrap_or("");
    let v = v.strip_suffix(".inet.0").unwrap_or(v);
    match v.to_ascii_lowercase().as_str() {
        "" | "default" | "global" | "inet.0" | "master" | "main" | "-" | "n/a" => "default".into(),
        _ => v.to_string(),
    }
}

#[derive(Debug, Clone)]
pub struct Addr {
    pub ip: Ipv4Addr,
    pub len: Option<u8>,
    pub iface: Option<String>,
    pub vrf: String,
}

impl Addr {
    pub fn subnet(&self) -> Option<Net4> {
        self.len.filter(|l| *l < 32).map(|l| Net4::new(self.ip, l))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct NextHop {
    pub ip: Option<Ipv4Addr>,
    pub iface: Option<String>,
    /// NX-OS's `203.0.113.4%default`: the next hop is resolved in that table.
    pub vrf: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RouteEntry {
    pub vrf: String,
    pub net: Net4,
    /// The device's own word for it, as printed.
    pub proto: String,
    pub ad: Option<u32>,
    pub metric: Option<u32>,
    pub next_hops: Vec<NextHop>,
    /// The command whose rows it came from.
    pub command: String,
}

impl RouteEntry {
    /// Attached: the device's own subnet on an interface.
    pub fn is_connected(&self) -> bool {
        matches!(proto_word(&self.proto).as_str(), "connected" | "local")
    }
}

/// The routing protocol as one word, whatever the device printed.
pub fn proto_word(raw: &str) -> String {
    let t = raw.trim().trim_end_matches('*').trim();
    let first = t.split([' ', ',']).next().unwrap_or("");
    match first {
        "C" | "connected" | "Connected" | "direct" | "Direct" | "DIRECT" | "connect" => "connected",
        "L" | "local" | "Local" | "LOCAL" => "local",
        "S" | "static" | "Static" | "STATIC" | "S*" => "static",
        "O" | "IA" | "E1" | "E2" | "N1" | "N2" | "ospf" | "OSPF" | "o" | "O_INTRA" | "O_INTER" | "O_EXT_1" | "O_EXT_2" => "ospf",
        "B" | "bgp" | "BGP" | "b" | "iBGP" | "eBGP" | "ibgp" | "ebgp" => "bgp",
        "D" | "EX" | "eigrp" | "EIGRP" => "eigrp",
        "R" | "rip" | "RIP" => "rip",
        "i" | "L1" | "L2" | "isis" | "ISIS" | "IS-IS" | "ia" => "isis",
        other => return other.to_ascii_lowercase(),
    }
    .to_string()
}

#[derive(Debug, Clone)]
pub struct ArpEntry {
    pub ip: Ipv4Addr,
    pub mac: String,
    pub iface: Option<String>,
    pub vrf: String,
}

#[derive(Debug, Clone)]
pub struct MacEntry {
    pub vlan: Option<String>,
    pub mac: String,
    pub iface: String,
}

#[derive(Debug, Clone)]
pub struct Fhrp {
    pub proto: String,
    pub group: Option<String>,
    pub iface: Option<String>,
    pub vip: Ipv4Addr,
    pub state: String,
}

impl Fhrp {
    /// Forwarding for the group: HSRP Active, VRRP Master.
    pub fn active(&self) -> bool {
        let s = self.state.to_ascii_lowercase();
        s.contains("active") || s.contains("master")
    }
}

/// A policy route: matched on arrival, before the routing table.
#[derive(Debug, Clone, Default)]
pub struct PolicyRoute {
    pub seq: String,
    pub in_if: Option<String>,
    pub src: Option<String>,
    pub dst: Option<String>,
    pub proto: Option<String>,
    pub port: Option<String>,
    pub next_hop: Option<Ipv4Addr>,
    pub out_if: Option<String>,
    pub vrf: Option<String>,
    pub command: String,
}

#[derive(Debug, Clone, Default)]
pub struct NatRule {
    pub seq: String,
    pub kind: String,
    pub orig_src: Option<String>,
    pub orig_dst: Option<String>,
    pub trans_src: Option<String>,
    pub trans_dst: Option<String>,
    pub in_zone_if: Option<String>,
    pub out_zone_if: Option<String>,
    pub service: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct FwPolicy {
    pub seq: String,
    pub name: Option<String>,
    pub src_zones: Vec<String>,
    pub dst_zones: Vec<String>,
    pub src_addr: Vec<String>,
    pub dst_addr: Vec<String>,
    pub services: Vec<String>,
    pub action: String,
    pub enabled: bool,
    /// LT-541: read from an FMC rather than the device.
    pub from_fmc: bool,
}

impl FwPolicy {
    /// How the policy is named in a sentence: its name, else its number.
    pub fn label(&self) -> String {
        match (&self.name, self.seq.is_empty()) {
            (Some(n), true) => n.clone(),
            (Some(n), false) if n != &self.seq => format!("{n} ({})", self.seq),
            (Some(n), false) => n.clone(),
            (None, _) => format!("policy {}", self.seq),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Tunnel {
    pub name: String,
    pub kind: Option<String>,
    pub local_ip: Option<Ipv4Addr>,
    pub remote_ip: Option<Ipv4Addr>,
}

/// One collected box: every collection of it merged.
#[derive(Debug, Clone, Default)]
pub struct Box_ {
    pub node_id: String,
    pub name: String,
    pub os: Option<String>,
    pub role: Option<String>,
    pub host: String,
    pub addrs: Vec<Addr>,
    pub routes: Vec<RouteEntry>,
    pub arp: Vec<ArpEntry>,
    pub macs: Vec<MacEntry>,
    pub fhrp: Vec<Fhrp>,
    /// (STP instance or VLAN when the row said, port key) of blocked ports.
    pub stp_blocked: Vec<(Option<String>, String)>,
    /// zone name → port keys
    pub zones: BTreeMap<String, BTreeSet<String>>,
    pub pbr: Vec<PolicyRoute>,
    pub nat: Vec<NatRule>,
    pub fw: Vec<FwPolicy>,
    pub tunnels: Vec<Tunnel>,
    /// port key → interface MAC
    pub iface_mac: BTreeMap<String, String>,
    /// Which discovery tables had rows for it.
    pub has: BTreeSet<String>,
    /// LT-540: where each policy applies (ASA `access-group`).
    pub bindings: Vec<Binding>,
    /// LT-540: a zone's security level (ASA `nameif`), 0–100.
    pub security: BTreeMap<String, u8>,
    /// LT-541: where the firewall policy came from, when not the device's
    /// own CLI — `fmc` for an FTD whose rules its FMC gave.
    pub policy_from: Option<String>,
    /// LT-540: object and group names → what they stand for, each item a
    /// literal (`192.0.2.0/24`, `tcp/443`) or another object's name.
    pub objects: BTreeMap<String, Vec<String>>,
}

/// Where a policy applies: inbound or outbound on an interface, or globally.
#[derive(Debug, Clone, PartialEq)]
pub struct Binding {
    pub policy: String,
    pub interface: Option<String>,
    /// `in`, `out` or `global`.
    pub direction: String,
}

impl Box_ {
    pub fn owns(&self, ip: Ipv4Addr) -> bool {
        self.addrs.iter().any(|a| a.ip == ip)
    }

    pub fn addr_of(&self, ip: Ipv4Addr) -> Option<&Addr> {
        self.addrs.iter().find(|a| a.ip == ip)
    }

    /// The interface address on the subnet holding `ip`.
    pub fn addr_on_subnet(&self, ip: Ipv4Addr) -> Option<&Addr> {
        self.addrs.iter().filter(|a| a.subnet().map(|n| n.contains(ip)).unwrap_or(false)).max_by_key(|a| a.len)
    }

    /// An address of this box on an interface, for a source address.
    pub fn address_on(&self, iface: &str) -> Option<Ipv4Addr> {
        let k = key(iface);
        self.addrs.iter().find(|a| a.iface.as_deref().map(key).as_deref() == Some(k.as_str())).map(|a| a.ip)
    }

    pub fn arp_for(&self, ip: Ipv4Addr) -> Option<&ArpEntry> {
        self.arp.iter().find(|a| a.ip == ip)
    }

    /// Where the MAC table learned a MAC, in the VLAN when one is known.
    pub fn port_for(&self, m: &str, vlan: Option<&str>) -> Option<&MacEntry> {
        let in_vlan = self.macs.iter().find(|e| e.mac == m && vlan.map(|v| e.vlan.as_deref().map(|x| x == v).unwrap_or(true)).unwrap_or(true));
        in_vlan.or_else(|| self.macs.iter().find(|e| e.mac == m))
    }

    pub fn blocked(&self, port: &str, vlan: Option<&str>) -> bool {
        let k = key(port);
        self.stp_blocked.iter().any(|(inst, p)| p == &k && (inst.is_none() || vlan.is_none() || inst.as_deref() == vlan))
    }

    /// The zones an interface is in, and the interface's own name — FortiOS
    /// writes interfaces where other vendors write zones.
    pub fn zones_of(&self, iface: Option<&str>) -> Vec<String> {
        let Some(iface) = iface else { return Vec::new() };
        let k = key(iface);
        let mut out: Vec<String> = self.zones.iter().filter(|(_, ports)| ports.contains(&k)).map(|(z, _)| z.clone()).collect();
        out.push(iface.to_string());
        out
    }

    pub fn has_table(&self, t: &str) -> bool {
        self.has.contains(t)
    }

    pub fn is_tunnel_iface(&self, iface: &str) -> Option<&Tunnel> {
        let k = key(iface);
        self.tunnels.iter().find(|t| key(&t.name) == k)
    }
}

/// A link end, as the walk follows cables.
#[derive(Debug, Clone)]
pub struct Cable {
    pub a: String,
    /// (key, the name as the device writes it) of each port at this end.
    pub a_ports: Vec<(String, String)>,
    pub b: String,
    pub b_ports: Vec<(String, String)>,
    pub inferred: bool,
}

/// Everything a trace reads.
#[derive(Debug, Clone, Default)]
pub struct Net {
    pub boxes: Vec<Box_>,
    pub cables: Vec<Cable>,
    pub by_ip: BTreeMap<Ipv4Addr, usize>,
    pub by_mac: BTreeMap<String, usize>,
    pub by_node: BTreeMap<String, usize>,
    /// Names of neighbours nobody collected, by their advertised address.
    pub strangers: BTreeMap<Ipv4Addr, String>,
    pub node_names: BTreeMap<String, String>,
}

fn ip(s: &str) -> Option<Ipv4Addr> {
    s.trim().split(['/', '%']).next()?.trim().parse().ok()
}

fn opt(r: &Row, c: &str) -> Option<String> {
    r.get(c).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// A list column split on commas and semicolons (never on spaces: a mask
/// written `192.0.2.0 255.255.255.0` is one item).
pub fn items(r: &Row, c: &str) -> Vec<String> {
    let Some(v) = r.get(c) else { return Vec::new() };
    let v = v.trim().trim_matches(['[', ']']);
    v.split([',', ';', '\n']).map(|s| s.trim().trim_matches(['"', '\'']).to_string()).filter(|s| !s.is_empty()).collect()
}

/// An `enabled` column: absent means on.
fn enabled(v: Option<&str>) -> bool {
    let Some(v) = v else { return true };
    let v = v.trim().to_ascii_lowercase();
    !(v.starts_with("disabled") || matches!(v.as_str(), "no" | "false" | "disable" | "off" | "0" | "inactive"))
}

/// A VLAN as its number: `VLAN0040`, `vlan 40` and `40` are all `40`.
fn vlan_word(v: &str) -> String {
    let digits = v.trim().trim_start_matches(|c: char| !c.is_ascii_digit());
    let n = digits.trim_start_matches('0');
    if n.is_empty() && !digits.is_empty() {
        "0".into()
    } else {
        n.to_string()
    }
}

/// Is a MAC-table port a real port (not the CPU, a router, a drop entry)?
fn real_port(p: &str) -> bool {
    let l = p.trim().to_ascii_lowercase();
    !(l.is_empty() || l == "cpu" || l.starts_with("router") || l.starts_with("sup-") || l == "drop" || l == "self" || l.starts_with("vlan"))
}

impl Net {
    /// Build from one run's devices and the graph P2 made of them.
    pub fn build(devices: &[DeviceIn], graph: &Graph) -> Net {
        let mut net = Net::default();
        for n in &graph.nodes {
            net.node_names.insert(n.id.clone(), n.name.clone());
            if n.kind == NodeKind::Neighbor {
                if let Some(a) = n.mgmt_ip.as_deref().and_then(ip) {
                    net.strangers.entry(a).or_insert_with(|| n.name.clone());
                }
                for (a, _, _, _) in &n.addresses {
                    if let Some(a) = ip(a) {
                        net.strangers.entry(a).or_insert_with(|| n.name.clone());
                    }
                }
            }
        }
        for node in graph.nodes.iter().filter(|n| n.kind == NodeKind::Collected) {
            let mine: Vec<&DeviceIn> = devices.iter().filter(|d| node.device_ids.contains(&d.device_id)).collect();
            let mut b = Box_ { node_id: node.id.clone(), name: node.name.clone(), os: node.os.clone(), role: node.role.clone(), host: mine.first().map(|d| d.host.clone()).unwrap_or_default(), ..Default::default() };
            for d in &mine {
                read_device(d, &mut b);
            }
            let idx = net.boxes.len();
            for a in &b.addrs {
                net.by_ip.entry(a.ip).or_insert(idx);
            }
            if let Some(h) = ip(&b.host) {
                net.by_ip.entry(h).or_insert(idx);
            }
            for m in node.macs.iter().chain(node.members.iter().filter_map(|m| m.mac.as_ref())) {
                if let Some(m) = mac(m) {
                    net.by_mac.entry(m).or_insert(idx);
                }
            }
            for m in b.iface_mac.values() {
                net.by_mac.entry(m.clone()).or_insert(idx);
            }
            net.by_node.insert(node.id.clone(), idx);
            net.boxes.push(b);
        }
        for l in &graph.links {
            let (mut a_ports, mut b_ports) = (Vec::new(), Vec::new());
            let named = |p: &str| (key(p), p.to_string());
            if let Some(p) = &l.a.port {
                a_ports.push(named(p));
            }
            if let Some(p) = &l.b.port {
                b_ports.push(named(p));
            }
            if let Some(bundle) = &l.bundle {
                for (x, y) in &bundle.members {
                    a_ports.push(named(x));
                    b_ports.push(named(y));
                }
            }
            net.cables.push(Cable { a: l.a.node.clone(), a_ports, b: l.b.node.clone(), b_ports, inferred: l.kind == LinkKind::InferredMac });
        }
        net
    }

    pub fn find_box(&self, name_or_ip: &str) -> Option<usize> {
        let t = name_or_ip.trim();
        if let Some(a) = ip(t).filter(|_| t.parse::<Ipv4Addr>().is_ok()) {
            return self.by_ip.get(&a).copied();
        }
        let k = name_key(t);
        self.boxes.iter().position(|b| name_key(&b.name) == k)
    }

    /// What is on the far side of a box's port: (node id, its port key).
    pub fn across(&self, b: usize, port: &str) -> Option<(String, Option<String>)> {
        let me = &self.boxes[b].node_id;
        let k = key(port);
        for c in &self.cables {
            if &c.a == me {
                if let Some(i) = c.a_ports.iter().position(|(p, _)| p == &k) {
                    return Some((c.b.clone(), c.b_ports.get(i).or_else(|| c.b_ports.first()).map(|(_, n)| n.clone())));
                }
            }
            if &c.b == me {
                if let Some(i) = c.b_ports.iter().position(|(p, _)| p == &k) {
                    return Some((c.a.clone(), c.a_ports.get(i).or_else(|| c.a_ports.first()).map(|(_, n)| n.clone())));
                }
            }
        }
        None
    }
}

fn read_device(d: &DeviceIn, b: &mut Box_) {
    for (t, rows) in &d.tables {
        if !rows.is_empty() {
            b.has.insert(t.clone());
        }
    }
    // Interface → VRF, from the vrf table's interface lists.
    let mut iface_vrf: BTreeMap<String, String> = BTreeMap::new();
    for r in d.rows("vrf") {
        let Some(name) = opt(r, "name") else { continue };
        for i in r.list("interfaces") {
            iface_vrf.insert(key(&i), vrf_name(Some(&name)));
        }
    }
    for r in d.rows("interface") {
        if let (Some(n), Some(m)) = (r.get("name"), r.get("mac").and_then(mac)) {
            b.iface_mac.entry(key(n)).or_insert(m);
        }
    }
    for r in d.rows("ip_address") {
        let Some(raw) = r.get("ip") else { continue };
        let (addr, len) = coreview_topology::identity::split_prefix(raw, r.get("prefixlen"));
        let Some(a) = ip(&addr) else { continue };
        let iface = opt(r, "interface");
        let vrf = match r.get("vrf") {
            Some(v) => vrf_name(Some(v)),
            None => iface.as_deref().and_then(|i| iface_vrf.get(&key(i)).cloned()).unwrap_or_else(|| "default".into()),
        };
        if !b.addrs.iter().any(|x| x.ip == a && x.vrf == vrf) {
            b.addrs.push(Addr { ip: a, len, iface, vrf });
        }
    }
    read_routes(d, b);
    // A local /32 is the device saying the address is its own (IOS `L`,
    // NX-OS `local`), which is enough when the address table was not read.
    let owned: Vec<Addr> = b
        .routes
        .iter()
        .filter(|r| r.net.len == 32 && proto_word(&r.proto) == "local")
        .filter_map(|r| {
            let ip = Ipv4Addr::from(r.net.addr);
            let iface = r.next_hops.iter().find_map(|h| h.iface.clone());
            let len = b.routes.iter().filter(|c| c.vrf == r.vrf && proto_word(&c.proto) == "connected" && c.net.len < 32 && c.net.contains(ip)).map(|c| c.net.len).max();
            (!b.addrs.iter().any(|a| a.ip == ip && a.vrf == r.vrf)).then(|| Addr { ip, len, iface, vrf: r.vrf.clone() })
        })
        .collect();
    b.addrs.extend(owned);
    for r in d.rows("arp") {
        let (Some(a), Some(m)) = (r.get("ip").and_then(ip), r.get("mac").and_then(mac)) else { continue };
        b.arp.push(ArpEntry { ip: a, mac: m, iface: opt(r, "interface"), vrf: vrf_name(r.get("vrf")) });
    }
    for r in d.rows("mac_table") {
        let (Some(m), Some(p)) = (r.get("mac").and_then(mac), r.get("interface")) else { continue };
        for p in p.split([',', ' ']).map(str::trim).filter(|p| real_port(p)) {
            b.macs.push(MacEntry { vlan: r.get("vlan").map(vlan_word).filter(|v| !v.is_empty()), mac: m.clone(), iface: p.to_string() });
        }
    }
    for r in d.rows("fhrp") {
        let Some(vip) = r.get("vip").and_then(ip) else { continue };
        b.fhrp.push(Fhrp { proto: opt(r, "proto").unwrap_or_else(|| "fhrp".into()), group: opt(r, "group"), iface: opt(r, "interface"), vip, state: opt(r, "state").unwrap_or_default() });
    }
    for r in d.rows("stp") {
        let (Some(port), Some(state)) = (r.get("interface"), r.get("state")) else { continue };
        let s = state.to_ascii_lowercase();
        if s.starts_with("blk") || s.contains("block") || s.contains("discard") || s.starts_with("bkn") || s == "dis" {
            b.stp_blocked.push((r.get("instance").map(vlan_word).filter(|v| !v.is_empty()), key(port)));
        }
    }
    for r in d.rows("fw_zone") {
        let Some(z) = opt(r, "name") else { continue };
        if let Some(level) = r.extra.get("security").and_then(|v| v.as_str()).and_then(|v| v.trim().parse::<u8>().ok()) {
            b.security.insert(z.clone(), level);
        }
        let ports = b.zones.entry(z).or_default();
        for i in r.list("interfaces") {
            ports.insert(key(&i));
        }
    }
    for r in d.rows("fw_binding") {
        let (Some(policy), Some(direction)) = (opt(r, "policy"), opt(r, "direction")) else { continue };
        b.bindings.push(Binding { policy, interface: opt(r, "interface"), direction: direction.to_ascii_lowercase() });
    }
    read_objects(d, b);
    for r in d.rows("policy_route") {
        b.pbr.push(PolicyRoute {
            seq: opt(r, "seq").unwrap_or_default(),
            in_if: opt(r, "in_if"),
            src: opt(r, "src"),
            dst: opt(r, "dst"),
            proto: opt(r, "proto"),
            port: opt(r, "port"),
            next_hop: r.get("action_nh").and_then(ip),
            out_if: opt(r, "action_if"),
            vrf: opt(r, "vrf"),
            command: r.command.clone(),
        });
    }
    for r in d.rows("nat_rule") {
        // An ASA rule marked `inactive` translates nothing (LT-552).
        if r.extra.get("inactive").and_then(|v| v.as_str()).map(|v| !v.trim().is_empty()).unwrap_or(false) {
            continue;
        }
        b.nat.push(NatRule {
            seq: opt(r, "seq").unwrap_or_default(),
            kind: opt(r, "type").unwrap_or_default().to_ascii_lowercase(),
            orig_src: opt(r, "orig_src"),
            orig_dst: opt(r, "orig_dst"),
            trans_src: opt(r, "trans_src"),
            trans_dst: opt(r, "trans_dst"),
            in_zone_if: opt(r, "in_zone_if"),
            out_zone_if: opt(r, "out_zone_if"),
            service: opt(r, "service"),
        });
    }
    for r in d.rows("fw_policy") {
        b.fw.push(FwPolicy {
            seq: opt(r, "seq").unwrap_or_default(),
            name: opt(r, "name"),
            src_zones: items(r, "src_zones"),
            dst_zones: items(r, "dst_zones"),
            src_addr: items(r, "src_addr"),
            dst_addr: items(r, "dst_addr"),
            services: items(r, "services"),
            action: opt(r, "action").unwrap_or_default(),
            enabled: enabled(r.get("enabled")),
            from_fmc: r.command.starts_with("fmc_"),
        });
    }
    // LT-541: an FTD's rules from its FMC are the policy; the access list
    // its CLI shows (`CSM_FW_ACL_`) is the same policy compiled, and its
    // `access-group` binding says nothing the zones do not.
    if d.rows("fw_policy").iter().any(|r| r.command.starts_with("fmc_")) {
        b.policy_from = Some("fmc".into());
    }
    if b.policy_from.as_deref() == Some("fmc") {
        let fmc_rows: Vec<&Row> = d.rows("fw_policy").iter().filter(|r| r.command.starts_with("fmc_")).collect();
        if !fmc_rows.is_empty() {
            b.fw.retain(|p| p.from_fmc);
        }
        b.bindings.clear();
    }
    expand_policies(b);
    for r in d.rows("tunnel") {
        let Some(name) = opt(r, "name") else { continue };
        b.tunnels.push(Tunnel { name, kind: opt(r, "kind"), local_ip: r.get("local_ip").and_then(ip), remote_ip: r.get("remote_ip").and_then(ip) });
    }
}

/// Route rows merged per (VRF, prefix, protocol): a template writes one row
/// per next hop, and equal-cost next hops are one route with several.
fn read_routes(d: &DeviceIn, b: &mut Box_) {
    for r in d.rows("route") {
        let Some(p) = r.get("prefix") else { continue };
        let (net, len) = coreview_topology::identity::split_prefix(p, r.get("mask"));
        let Some(net_ip) = ip(&net) else { continue };
        let Some(len) = len.or_else(|| (net_ip == Ipv4Addr::UNSPECIFIED).then_some(0)) else { continue };
        let vrf = vrf_name(r.get("vrf"));
        let net = Net4::new(net_ip, len);
        let proto = r.get("proto").unwrap_or("").to_string();
        let hops_raw = r.list("next_hop");
        // IOS's template keeps a next hop's own table apart: `NEXTHOP_VRF`.
        let row_nh_vrf = r.extra.get("nexthop_vrf").and_then(|v| v.as_str()).map(str::trim).filter(|v| !v.is_empty()).map(|v| vrf_name(Some(v)));
        let ifaces = r.list("interface");
        let mut next_hops = Vec::new();
        for (i, h) in hops_raw.iter().enumerate() {
            let Some(a) = ip(h) else { continue };
            let nh_vrf = h.split_once('%').map(|(_, v)| vrf_name(Some(v))).or_else(|| row_nh_vrf.clone());
            let iface = ifaces.get(i).cloned().or_else(|| (ifaces.len() == 1).then(|| ifaces[0].clone()));
            next_hops.push(NextHop { ip: Some(a), iface, vrf: nh_vrf });
        }
        if next_hops.is_empty() {
            for i in &ifaces {
                next_hops.push(NextHop { ip: None, iface: Some(i.clone()), vrf: None });
            }
        }
        let num = |c: &str| r.get(c).and_then(|v| v.trim().parse::<u32>().ok());
        match b.routes.iter_mut().find(|x| x.vrf == vrf && x.net == net && x.proto == proto) {
            Some(existing) => {
                for h in next_hops {
                    if !existing.next_hops.contains(&h) {
                        existing.next_hops.push(h);
                    }
                }
            }
            None => b.routes.push(RouteEntry { vrf, net, proto, ad: num("ad"), metric: num("metric"), next_hops, command: r.command.clone() }),
        }
    }
}


/// One object row as the literal it stands for: a host, a prefix, a range,
/// a service in the `proto/port` form, or a member object's name.
fn object_item(r: &Row, service: bool) -> Option<String> {
    if let Some(m) = opt(r, "member") {
        return Some(m);
    }
    if service {
        let proto = opt(r, "protocol").unwrap_or_else(|| "ip".into()).to_ascii_lowercase();
        let (op, a, z) = (opt(r, "port_op"), opt(r, "port_start"), opt(r, "port_end"));
        return Some(match (op.as_deref(), a, z) {
            (Some("eq"), Some(a), _) | (None, Some(a), None) => format!("{proto}/{a}"),
            (Some("range"), Some(a), Some(z)) => format!("{proto}/{a}-{z}"),
            (Some("lt"), Some(a), _) => format!("{proto}/lt {a}"),
            (Some("gt"), Some(a), _) => format!("{proto}/gt {a}"),
            (None, None, None) => proto,
            (op, a, _) => format!("{proto} {} {}", op.unwrap_or(""), a.unwrap_or_default()),
        });
    }
    if let Some(h) = opt(r, "host") {
        return Some(h);
    }
    if let Some(n) = opt(r, "network") {
        return Some(match opt(r, "mask") {
            Some(m) if m.contains('.') => format!("{n} {m}"),
            Some(m) => format!("{n}/{m}"),
            None => n,
        });
    }
    if let (Some(a), Some(z)) = (opt(r, "range_start"), opt(r, "range_end")) {
        return Some(format!("{a}-{z}"));
    }
    None
}

/// Object and group definitions, by name (LT-540). A service object is told
/// apart by the command that listed it.
fn read_objects(d: &DeviceIn, b: &mut Box_) {
    for r in d.rows("fw_object") {
        let Some(name) = opt(r, "name") else { continue };
        let service = r.command.contains("service");
        if let Some(item) = object_item(r, service) {
            b.objects.entry(name).or_default().push(item);
        } else {
            b.objects.entry(name).or_default();
        }
    }
}

/// A list with every object name it can resolve replaced by what it stands
/// for; a name it cannot resolve is left as written, and decided downstream
/// as unknown.
fn expand(items: &[String], objects: &BTreeMap<String, Vec<String>>) -> Vec<String> {
    fn go(item: &str, objects: &BTreeMap<String, Vec<String>>, depth: usize, out: &mut Vec<String>) {
        match objects.get(item) {
            Some(members) if depth < 8 && !members.is_empty() => {
                for m in members {
                    go(m, objects, depth + 1, out);
                }
            }
            _ => {
                if !out.iter().any(|x| x == item) {
                    out.push(item.to_string());
                }
            }
        }
    }
    let mut out = Vec::new();
    for i in items {
        go(i, objects, 0, &mut out);
    }
    out
}

fn expand_policies(b: &mut Box_) {
    if b.objects.is_empty() {
        return;
    }
    let objects = b.objects.clone();
    for p in &mut b.fw {
        p.src_addr = expand(&p.src_addr, &objects);
        p.dst_addr = expand(&p.dst_addr, &objects);
        p.services = expand(&p.services, &objects);
    }
    for n in &mut b.nat {
        for f in [&mut n.orig_src, &mut n.orig_dst, &mut n.trans_src, &mut n.trans_dst] {
            if let Some(v) = f.clone() {
                let e = expand(std::slice::from_ref(&v), &objects);
                if e.len() == 1 {
                    *f = Some(e[0].clone());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_in_every_spelling() {
        assert_eq!(Net4::parse("192.0.2.0/24").unwrap().to_string(), "192.0.2.0/24");
        assert_eq!(Net4::parse("192.0.2.9/255.255.255.0").unwrap().to_string(), "192.0.2.0/24");
        assert_eq!(Net4::parse("192.0.2.9 255.255.255.0").unwrap().to_string(), "192.0.2.0/24");
        assert_eq!(Net4::parse("192.0.2.9").unwrap().to_string(), "192.0.2.9/32");
        assert!(Net4::parse("0.0.0.0/0").unwrap().contains("203.0.113.1".parse().unwrap()));
        assert!(!Net4::parse("192.0.2.0/25").unwrap().contains("192.0.2.200".parse().unwrap()));
        assert_eq!(Net4::parse("not an address"), None);
    }

    #[test]
    fn the_global_table_under_its_names() {
        for v in [None, Some(""), Some("default"), Some("global"), Some("inet.0"), Some("master")] {
            assert_eq!(vrf_name(v), "default");
        }
        assert_eq!(vrf_name(Some("BLUE.inet.0")), "BLUE");
        assert_eq!(vrf_name(Some("BLUE")), "BLUE");
    }

    #[test]
    fn protocol_words() {
        assert_eq!(proto_word("C"), "connected");
        assert_eq!(proto_word("O IA"), "ospf");
        assert_eq!(proto_word("B"), "bgp");
        assert_eq!(proto_word("S*"), "static");
        assert_eq!(proto_word("ospf-2"), "ospf-2");
        // NX-OS `am` is a host learned by ARP, not the device's own address.
        assert_eq!(proto_word("am"), "am");
        assert_eq!(proto_word("L"), "local");
    }

    #[test]
    fn vlans_as_numbers() {
        assert_eq!(vlan_word("VLAN0040"), "40");
        assert_eq!(vlan_word("40"), "40");
        assert_eq!(vlan_word("vlan 7"), "7");
        assert_eq!(vlan_word("0"), "0");
    }

    #[test]
    fn a_disabled_rule_is_off_and_an_absent_column_is_on() {
        assert!(enabled(None));
        assert!(enabled(Some("enable")));
        assert!(enabled(Some("yes")));
        assert!(!enabled(Some("disable")));
        assert!(!enabled(Some("no")));
        assert!(!enabled(Some("disabled: maybe")));
    }
}
