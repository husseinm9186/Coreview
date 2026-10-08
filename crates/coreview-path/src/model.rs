//! A device's forwarding state, read from its rows: the addresses it owns,
//! its routing table merged per (VRF, prefix) with every next hop, ARP, the
//! MAC table, FHRP groups, STP-blocked ports, zones, policy routes, NAT rules,
//! firewall policies and tunnels. Nothing here is inferred beyond what a row
//! says; a table the collection did not fill is recorded as missing, so the
//! walk can say "not collected" rather than "no route".

use std::collections::{BTreeMap, BTreeSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use coreview_topology::identity::name_key;
use coreview_topology::ifname::{key, mac};
use coreview_topology::{DeviceIn, Graph, LinkKind, NodeKind, Row};

/// A prefix, IPv4 or IPv6, its bits held in a `u128`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Prefix {
    pub v6: bool,
    pub addr: u128,
    pub len: u8,
}

fn bits(ip: IpAddr) -> (bool, u128) {
    match ip {
        IpAddr::V4(a) => (false, u128::from(u32::from(a))),
        IpAddr::V6(a) => (true, u128::from(a)),
    }
}

fn width(v6: bool) -> u8 {
    if v6 {
        128
    } else {
        32
    }
}

/// The mask of a prefix length in its family's width.
pub fn mask(len: u8, v6: bool) -> u128 {
    let w = width(v6);
    let len = len.min(w);
    let all = if v6 { u128::MAX } else { u128::from(u32::MAX) };
    if len == 0 {
        0
    } else {
        (all << (w - len)) & all
    }
}

impl Prefix {
    pub fn new(ip: IpAddr, len: u8) -> Prefix {
        let (v6, b) = bits(ip);
        let len = len.min(width(v6));
        Prefix { v6, addr: b & mask(len, v6), len }
    }

    /// `192.0.2.0/24`, `192.0.2.0/255.255.255.0`, `192.0.2.0 255.255.255.0`,
    /// `2001:db8::/32`, or a bare address as a host prefix.
    pub fn parse(s: &str) -> Option<Prefix> {
        let s = s.trim();
        let (ip, len) = match s.split_once(['/', ' ']) {
            Some((a, l)) => (a.trim(), Some(l.trim())),
            None => (s, None),
        };
        let ip: IpAddr = ip.parse().ok()?;
        let w = width(ip.is_ipv6());
        let len = match len {
            None => w,
            Some(l) => l.parse::<u8>().ok().filter(|l| *l <= w).or_else(|| if ip.is_ipv4() { mask_len(l) } else { None })?,
        };
        Some(Prefix::new(ip, len))
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        let (v6, b) = bits(ip);
        v6 == self.v6 && b & mask(self.len, v6) == self.addr
    }

    pub fn is_default(&self) -> bool {
        self.len == 0
    }

    /// One address, not a subnet: a /32 or a /128.
    pub fn is_host(&self) -> bool {
        self.len == width(self.v6)
    }

    /// The prefix's first address.
    pub fn ip(&self) -> IpAddr {
        if self.v6 {
            IpAddr::V6(Ipv6Addr::from(self.addr))
        } else {
            IpAddr::V4(Ipv4Addr::from(self.addr as u32))
        }
    }
}

impl std::fmt::Display for Prefix {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.ip(), self.len)
    }
}

/// An IPv6 link-local address (`fe80::/10`) — or an IPv4 one (`169.254/16`).
pub fn link_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V6(a) => (a.segments()[0] & 0xffc0) == 0xfe80,
        IpAddr::V4(a) => a.is_link_local(),
    }
}

/// A dotted IPv4 mask as a prefix length.
pub fn mask_len(m: &str) -> Option<u8> {
    let m: Ipv4Addr = m.trim().parse().ok()?;
    let bits = u32::from(m);
    (bits.leading_ones() + bits.trailing_zeros() == 32).then(|| bits.leading_ones() as u8)
}

/// Whether two addresses are of one family and `a <= x <= z`.
pub fn in_range(x: IpAddr, a: IpAddr, z: IpAddr) -> bool {
    let ((fx, bx), (fa, ba), (fz, bz)) = (bits(x), bits(a), bits(z));
    fx == fa && fa == fz && ba <= bx && bx <= bz
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
    pub ip: IpAddr,
    pub len: Option<u8>,
    pub iface: Option<String>,
    pub vrf: String,
}

impl Addr {
    pub fn subnet(&self) -> Option<Prefix> {
        let w = if self.ip.is_ipv6() { 128 } else { 32 };
        self.len.filter(|l| *l < w).map(|l| Prefix::new(self.ip, l))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct NextHop {
    pub ip: Option<IpAddr>,
    pub iface: Option<String>,
    /// NX-OS's `203.0.113.4%default`: the next hop is resolved in that table.
    pub vrf: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RouteEntry {
    pub vrf: String,
    pub net: Prefix,
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
    pub ip: IpAddr,
    pub mac: String,
    pub iface: Option<String>,
    pub vrf: String,
}

#[derive(Debug, Clone)]
pub struct MacEntry {
    pub vlan: Option<String>,
    pub mac: String,
    pub iface: String,
    /// A MAC learned over VXLAN — the far VTEP's address, as NX-OS
    /// prints `nve1(192.0.2.12)` or Onyx's reader keeps `remote_ip`.
    pub vtep: Option<IpAddr>,
}

#[derive(Debug, Clone)]
pub struct Fhrp {
    pub proto: String,
    pub group: Option<String>,
    pub iface: Option<String>,
    pub vip: IpAddr,
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
    pub next_hop: Option<IpAddr>,
    pub out_if: Option<String>,
    pub vrf: Option<String>,
    /// The table the policy sends the packet to be looked up in
    /// (Junos `then routing-instance`, IOS `set vrf`).
    pub action_vrf: Option<String>,
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
    /// Read from an FMC rather than the device.
    pub from_fmc: bool,
    /// FortiOS `set nat enable` — the source leaves as the egress
    /// interface's address, or as `pool`'s when an IP pool is named.
    pub nat: bool,
    pub pool: Option<String>,
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
    pub local_ip: Option<IpAddr>,
    pub remote_ip: Option<IpAddr>,
    /// The device says it is down.
    pub down: bool,
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
    /// The forwarding table, where one was collected — what the
    /// device actually forwards by. Walked in preference to `routes`.
    pub fib: Vec<RouteEntry>,
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
    /// Every interface the box lists, by port key, address or not —
    /// a FortiOS policy names interfaces, and a VLAN interface carries none.
    pub ifaces: BTreeSet<String>,
    /// Interfaces the device reports down, by port key — a route
    /// out one carries nothing.
    pub down_ifaces: BTreeSet<String>,
    /// VLAN → the ports in it, from the `vlan` table and access
    /// ports' `interface.vlan`, so the VLAN a frame enters on a port is
    /// known where no SVI names it.
    pub vlan_ports: BTreeMap<String, BTreeSet<String>>,
    /// Which discovery tables had rows for it.
    pub has: BTreeSet<String>,
    /// Where each policy applies (ASA `access-group`).
    pub bindings: Vec<Binding>,
    /// A zone's security level (ASA `nameif`), 0–100.
    pub security: BTreeMap<String, u8>,
    /// Each VRF's route-targets, (imported, exported).
    pub vrf_rts: BTreeMap<String, (BTreeSet<String>, BTreeSet<String>)>,
    /// Where the firewall policy came from, when not the device's
    /// own CLI — `fmc` for an FTD whose rules its FMC gave.
    pub policy_from: Option<String>,
    /// Object and group names → what they stand for, each item a
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
    /// The other VRFs this one imports from, and the route-target
    /// that joins them — a VRF whose exports meet this one's imports.
    pub fn leaks_into(&self, vrf: &str) -> Vec<(String, String)> {
        let Some((imports, _)) = self.vrf_rts.get(vrf) else { return Vec::new() };
        let mut out = Vec::new();
        for (other, (_, exports)) in &self.vrf_rts {
            if other == vrf {
                continue;
            }
            if let Some(rt) = exports.iter().find(|x| imports.contains(*x)) {
                out.push((other.clone(), rt.clone()));
            }
        }
        out
    }

    pub fn owns(&self, ip: IpAddr) -> bool {
        self.addrs.iter().any(|a| a.ip == ip)
    }

    pub fn addr_of(&self, ip: IpAddr) -> Option<&Addr> {
        self.addrs.iter().find(|a| a.ip == ip)
    }

    /// The interface address on the subnet holding `ip`.
    pub fn addr_on_subnet(&self, ip: IpAddr) -> Option<&Addr> {
        self.addrs.iter().filter(|a| a.subnet().map(|n| n.contains(ip)).unwrap_or(false)).max_by_key(|a| a.len)
    }

    /// An address of this box on an interface, for a source address.
    pub fn address_on(&self, iface: &str) -> Option<IpAddr> {
        let k = key(iface);
        self.addrs.iter().find(|a| a.iface.as_deref().map(key).as_deref() == Some(k.as_str())).map(|a| a.ip)
    }

    pub fn arp_for(&self, ip: IpAddr) -> Option<&ArpEntry> {
        self.arp.iter().find(|a| a.ip == ip)
    }

    /// Where the MAC table learned a MAC, in the VLAN when one is known.
    pub fn port_for(&self, m: &str, vlan: Option<&str>) -> Option<&MacEntry> {
        let in_vlan = self.macs.iter().find(|e| e.mac == m && vlan.map(|v| e.vlan.as_deref().map(|x| x == v).unwrap_or(true)).unwrap_or(true));
        in_vlan.or_else(|| self.macs.iter().find(|e| e.mac == m))
    }

    /// The one VLAN a port is in — an access port; a trunk, in
    /// several, answers nothing.
    pub fn vlan_of_port(&self, port: &str) -> Option<String> {
        let k = key(port);
        let mut found = self.vlan_ports.iter().filter(|(_, ports)| ports.contains(&k)).map(|(v, _)| v.clone());
        let first = found.next()?;
        found.next().is_none().then_some(first)
    }

    /// Whether the VLAN table says a port is not in a VLAN it
    /// claims to be in (a known VLAN, a port outside it).
    pub fn port_outside_vlan(&self, port: &str, vlan: &str) -> bool {
        self.vlan_ports.get(vlan).map(|ports| !ports.contains(&key(port))).unwrap_or(false)
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

    /// The table the device forwards by — its forwarding table
    /// when one was collected, else its RIB.
    pub fn forwarding(&self) -> &Vec<RouteEntry> {
        if self.fib.is_empty() {
            &self.routes
        } else {
            &self.fib
        }
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
    pub by_ip: BTreeMap<IpAddr, usize>,
    /// The same, per VRF — two PEs carrying the same customer space
    /// are told apart by the table the next hop is looked up in.
    pub by_ip_vrf: BTreeMap<(String, IpAddr), usize>,
    pub by_mac: BTreeMap<String, usize>,
    pub by_node: BTreeMap<String, usize>,
    /// Names of neighbours nobody collected, by their advertised address.
    pub strangers: BTreeMap<IpAddr, String>,
    pub node_names: BTreeMap<String, String>,
}

fn ip(s: &str) -> Option<IpAddr> {
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

/// A FortiOS rule on internet-service entries in place of addresses
/// (`internet-service-src enable` and its `…-name`, `…-group`, `…-custom`
/// lists) — each entry as `isdb:<name>`, which the firewall decides.
fn internet_service(r: &Row, field: &str) -> Option<Vec<String>> {
    let on = r.extra.get(field).and_then(|v| v.as_str()).is_some_and(|v| v.eq_ignore_ascii_case("enable"));
    if !on {
        return None;
    }
    let mut out = Vec::new();
    for suffix in ["name", "group", "custom", "custom_group", "fortiguard"] {
        for v in r.extra.get(&format!("{field}_{suffix}")).and_then(|v| v.as_array()).into_iter().flatten() {
            if let Some(n) = v.get("name").and_then(|n| n.as_str()).or_else(|| v.as_str()) {
                out.push(format!("isdb:{n}"));
            }
        }
    }
    Some(if out.is_empty() { vec!["isdb:(unnamed)".into()] } else { out })
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
/// An NVE / VXLAN interface, behind which a MAC is at another VTEP.
pub fn is_vtep_iface(p: &str) -> bool {
    let l = p.trim().to_ascii_lowercase();
    l.starts_with("nve") || l.starts_with("vxlan") || l.starts_with("vtep") || l.starts_with("vx")
}

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
            // A link-local address is on every router's every link; it names
            // no device and is resolved on the link it is on.
            for a in b.addrs.iter().filter(|a| !link_local(a.ip)) {
                net.by_ip.entry(a.ip).or_insert(idx);
                net.by_ip_vrf.entry((a.vrf.clone(), a.ip)).or_insert(idx);
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

    /// The box holding `ip` in `vrf` — in that table first, then the
    /// global one (a next hop may leave the VRF), then anywhere.
    pub fn box_at(&self, vrf: &str, ip: IpAddr) -> Option<usize> {
        self.by_ip_vrf
            .get(&(vrf.to_string(), ip))
            .or_else(|| self.by_ip_vrf.get(&("default".to_string(), ip)))
            .or_else(|| self.by_ip.get(&ip))
            .copied()
    }

    pub fn find_box(&self, name_or_ip: &str) -> Option<usize> {
        let t = name_or_ip.trim();
        if let Some(a) = ip(t).filter(|_| t.parse::<IpAddr>().is_ok()) {
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
        let rts = b.vrf_rts.entry(vrf_name(Some(&name))).or_default();
        rts.0.extend(r.list("rt_import"));
        rts.1.extend(r.list("rt_export"));
    }
    for r in d.rows("vlan") {
        if let (Some(v), ports) = (r.get("vlan_id"), r.list("ports")) {
            let set = b.vlan_ports.entry(v.trim().to_string()).or_default();
            set.extend(ports.iter().map(|p| key(p)));
        }
    }
    for r in d.rows("interface") {
        if let (Some(n), Some(v)) = (r.get("name"), r.get("vlan")) {
            if r.get("mode").map(|m| m.to_ascii_lowercase().contains("access")).unwrap_or(false) && v.trim().chars().all(|c| c.is_ascii_digit()) && !v.trim().is_empty() {
                b.vlan_ports.entry(v.trim().to_string()).or_default().insert(key(n));
            }
        }
        if let Some(n) = r.get("name") {
            b.ifaces.insert(key(n));
            if r.get("oper").map(is_down).unwrap_or(false) || r.get("admin").map(is_down).unwrap_or(false) {
                b.down_ifaces.insert(key(n));
            }
        }
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
        .forwarding()
        .iter()
        .filter(|r| r.net.is_host() && proto_word(&r.proto) == "local")
        .filter_map(|r| {
            let ip = r.net.ip();
            let iface = r.next_hops.iter().find_map(|h| h.iface.clone());
            let len = b.forwarding().iter().filter(|c| c.vrf == r.vrf && proto_word(&c.proto) == "connected" && !c.net.is_host() && c.net.contains(ip)).map(|c| c.net.len).max();
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
        let remote = r.extra.get("remote_ip").and_then(serde_json::Value::as_str).and_then(ip);
        for p in p.split([',', ' ']).map(str::trim).filter(|p| real_port(p)) {
            // `nve1(192.0.2.12)`: the VTEP in the port's parentheses.
            let (iface, vtep) = match p.split_once('(') {
                Some((i, rest)) if is_vtep_iface(i) => (i.to_string(), rest.trim_end_matches(')').parse().ok()),
                _ => (p.to_string(), if is_vtep_iface(p) { remote } else { None }),
            };
            b.macs.push(MacEntry { vlan: r.get("vlan").map(vlan_word).filter(|v| !v.is_empty()), mac: m.clone(), iface, vtep });
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
            action_vrf: opt(r, "action_vrf"),
            command: r.command.clone(),
        });
    }
    for r in d.rows("nat_rule") {
        // An ASA rule marked `inactive` translates nothing.
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
            src_addr: internet_service(r, "internet_service_src").unwrap_or_else(|| items(r, "src_addr")),
            dst_addr: internet_service(r, "internet_service").unwrap_or_else(|| items(r, "dst_addr")),
            services: items(r, "services"),
            action: opt(r, "action").unwrap_or_default(),
            enabled: enabled(r.get("enabled")),
            from_fmc: r.command.starts_with("fmc_"),
            // Absent means no NAT: `enabled` reads absent as on, which is right for a policy and wrong here.
            nat: opt(r, "nat").map(|v| enabled(Some(&v))).unwrap_or(false),
            pool: opt(r, "pool").filter(|p| !p.trim().is_empty() && p.trim() != "-"),
        });
    }
    // An FTD's rules from its FMC are the policy; the access list
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
        let down = r.get("state").map(is_down).unwrap_or(false);
        b.tunnels.push(Tunnel { name, kind: opt(r, "kind"), local_ip: r.get("local_ip").and_then(ip), remote_ip: r.get("remote_ip").and_then(ip), down });
    }
}

/// An interface or tunnel state word that means it carries nothing:
/// IOS `down` / `administratively down` / `notconnect`,
/// Junos `down`, NX-OS `err-disabled`, FortiOS `down`, PAN-OS `down`.
pub fn is_down(state: &str) -> bool {
    let s = state.trim().to_ascii_lowercase();
    let s = s.replace(['-', '_'], " ");
    matches!(s.as_str(), "down" | "dn" | "administratively down" | "admin down" | "adm down" | "notconnect" | "not connect" | "notconnected" | "not connected" | "disabled" | "err disabled" | "errdisabled" | "lower layer down" | "inactive" | "shutdown" | "sfp not inserted" | "xcvr absent" | "notpresent" | "not present" | "link down" | "nolink")
        || s.starts_with("admin")
        || s.starts_with("err disabled")
}

/// Route rows merged per (VRF, prefix, protocol): a template writes one row
/// per next hop, and equal-cost next hops are one route with several.
fn read_routes(d: &DeviceIn, b: &mut Box_) {
    let mut routes = std::mem::take(&mut b.routes);
    read_route_table(d, "route", &mut routes);
    b.routes = routes;
    let mut fib = std::mem::take(&mut b.fib);
    read_route_table(d, "fib", &mut fib);
    b.fib = fib;
}

fn read_route_table(d: &DeviceIn, table: &str, into: &mut Vec<RouteEntry>) {
    for r in d.rows(table) {
        let Some(p) = r.get("prefix") else { continue };
        // Iproute2 and esxcli write the default route as `default`.
        let v6 = r.get("next_hop").map(|h| h.contains(':')).unwrap_or(false);
        let p = if p.eq_ignore_ascii_case("default") { if v6 { "::/0" } else { "0.0.0.0/0" } } else { p };
        let (net, len) = coreview_topology::identity::split_prefix(p, r.get("mask"));
        let Some(net_ip) = ip(&net) else { continue };
        let Some(len) = len.or_else(|| net_ip.is_unspecified().then_some(0)) else { continue };
        let vrf = vrf_name(r.get("vrf"));
        let net = Prefix::new(net_ip, len);
        let proto = r.get("proto").unwrap_or("").to_string();
        let hops_raw = r.list("next_hop");
        // IOS's template keeps a next hop's own table apart: `NEXTHOP_VRF`.
        let row_nh_vrf = r.extra.get("nexthop_vrf").and_then(|v| v.as_str()).map(str::trim).filter(|v| !v.is_empty()).map(|v| vrf_name(Some(v)));
        let ifaces = r.list("interface");
        let mut next_hops = Vec::new();
        for (i, h) in hops_raw.iter().enumerate() {
            // An unspecified next hop (`0.0.0.0`, `::` — Windows' on-link) is no next hop.
            let Some(a) = ip(h).filter(|a| !a.is_unspecified()) else { continue };
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
        match into.iter_mut().find(|x| x.vrf == vrf && x.net == net && x.proto == proto) {
            Some(existing) => {
                for h in next_hops {
                    if !existing.next_hops.contains(&h) {
                        existing.next_hops.push(h);
                    }
                }
            }
            None => into.push(RouteEntry { vrf, net, proto, ad: num("ad"), metric: num("metric"), next_hops, command: if table == "fib" { format!("fib:{}", r.command) } else { r.command.clone() } }),
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

/// Object and group definitions, by name. A service object is told
/// apart by the command that listed it.
fn read_objects(d: &DeviceIn, b: &mut Box_) {
    for r in d.rows("fw_object") {
        let Some(name) = opt(r, "name") else { continue };
        // A FortiOS group lists its members in one row.
        let members = items(r, "member");
        if members.len() > 1 {
            b.objects.entry(name).or_default().extend(members);
            continue;
        }
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
        assert_eq!(Prefix::parse("192.0.2.0/24").unwrap().to_string(), "192.0.2.0/24");
        assert_eq!(Prefix::parse("192.0.2.9/255.255.255.0").unwrap().to_string(), "192.0.2.0/24");
        assert_eq!(Prefix::parse("192.0.2.9 255.255.255.0").unwrap().to_string(), "192.0.2.0/24");
        assert_eq!(Prefix::parse("192.0.2.9").unwrap().to_string(), "192.0.2.9/32");
        // IPv6, and never across families.
        let v6 = Prefix::parse("2001:db8:1::/48").unwrap();
        assert_eq!(v6.to_string(), "2001:db8:1::/48");
        assert!(v6.contains("2001:db8:1:2::10".parse().unwrap()));
        assert!(!v6.contains("2001:db8:2::10".parse().unwrap()));
        assert!(Prefix::parse("::/0").unwrap().contains("2001:db8::1".parse().unwrap()));
        assert!(!Prefix::parse("0.0.0.0/0").unwrap().contains("2001:db8::1".parse().unwrap()));
        assert!(!Prefix::parse("::/0").unwrap().contains("192.0.2.1".parse().unwrap()));
        assert!(Prefix::parse("2001:db8::1").unwrap().is_host());
        assert!(Prefix::parse("0.0.0.0/0").unwrap().contains("203.0.113.1".parse().unwrap()));
        assert!(!Prefix::parse("192.0.2.0/25").unwrap().contains("192.0.2.200".parse().unwrap()));
        assert_eq!(Prefix::parse("not an address"), None);
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

    /// `default`, and Windows' on-link `0.0.0.0` next hop.
    #[test]
    fn a_default_written_as_a_word_and_an_unspecified_next_hop() {
        let row = |cols: &[(&str, &str)]| Row { command: "x".into(), columns: cols.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), extra: Default::default() };
        let d = DeviceIn { device_id: "h".into(), tables: [("route".to_string(), vec![row(&[("prefix", "default"), ("next_hop", "192.0.2.1"), ("interface", "eth0")]), row(&[("prefix", "192.0.2.0/24"), ("next_hop", "0.0.0.0"), ("interface", "Ethernet0")])])].into(), ..Default::default() };
        let mut b = Box_::default();
        read_routes(&d, &mut b);
        assert_eq!(b.routes[0].net.to_string(), "0.0.0.0/0");
        assert_eq!(b.routes[1].next_hops, vec![NextHop { ip: None, iface: Some("Ethernet0".into()), vrf: None }]);
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

    #[test]
    fn a_next_hop_is_resolved_in_its_own_vrf_first() {
        // PE-A and PE-B both hold 10.1.1.1 — one in VRF CUST-A, the
        // other in CUST-B. The table the lookup happens in picks the box.
        let mut net = Net::default();
        net.boxes.push(Box_ { name: "PE-A".into(), ..Default::default() });
        net.boxes.push(Box_ { name: "PE-B".into(), ..Default::default() });
        let ip: IpAddr = "10.1.1.1".parse().unwrap();
        net.by_ip.insert(ip, 0);
        net.by_ip_vrf.insert(("CUST-A".into(), ip), 0);
        net.by_ip_vrf.insert(("CUST-B".into(), ip), 1);
        assert_eq!(net.box_at("CUST-A", ip), Some(0));
        assert_eq!(net.box_at("CUST-B", ip), Some(1));
        // A VRF nobody holds it in falls back to the global table, then anywhere.
        assert_eq!(net.box_at("CUST-C", ip), Some(0));
    }
}
