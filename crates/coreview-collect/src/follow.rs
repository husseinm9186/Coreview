//! Following neighbours: "Discover devices" on the
//! catalog-driven collector. The seeds are collected first; every CDP/LLDP
//! neighbour a collected device names (by management address, or by its
//! chassis MAC in the same device's ARP) and every route's next hop is queued
//! one hop further, within the panel's hop, device and subnet limits. An
//! address a collected device already owns is never visited again — a
//! FortiGate reached on its LAN side is not collected a second time on its
//! DMZ address because a switch there names it.

use std::collections::{BTreeSet, VecDeque};
use std::net::IpAddr;

use crate::run::DeviceRun;
use crate::tables::{rows_for_step, rows_of};

/// How far a collection may follow.
#[derive(Debug, Clone, Default)]
pub struct Limits {
    /// Hops from a seed; a seed is hop 0.
    pub max_hops: u32,
    /// Devices collected in all, seeds included.
    pub max_devices: usize,
    /// Only neighbours inside one of these networks are followed (seeds
    /// always are); none means no limit.
    pub subnets: Vec<(IpAddr, u8)>,
    /// The kinds of device logged into, as the classic crawler's
    /// "Log in to" chips say; empty means the infrastructure kinds. A
    /// neighbour whose platform and capabilities classify as another kind
    /// is listed, not followed — before any connection is made to it.
    pub login_classes: Vec<coreview_discover::types::DeviceClass>,
}

/// `192.0.2.0/24` → the network and its length.
pub fn parse_subnet(text: &str) -> Result<(IpAddr, u8), String> {
    let (addr, len) = text.trim().split_once('/').ok_or_else(|| format!("{} is not a subnet (address/length)", text.trim()))?;
    let addr: IpAddr = addr.trim().parse().map_err(|_| format!("{} is not an address", addr.trim()))?;
    let len: u8 = len.trim().parse().map_err(|_| format!("{} is not a prefix length", len.trim()))?;
    if len > if addr.is_ipv4() { 32 } else { 128 } {
        return Err(format!("/{len} is too long for {addr}"));
    }
    Ok((addr, len))
}

fn inside(ip: IpAddr, (net, len): (IpAddr, u8)) -> bool {
    match (ip, net) {
        (IpAddr::V4(a), IpAddr::V4(n)) => {
            let mask = if len == 0 { 0 } else { u32::MAX << (32 - len as u32) };
            u32::from(a) & mask == u32::from(n) & mask
        }
        (IpAddr::V6(a), IpAddr::V6(n)) => {
            let mask = if len == 0 { 0 } else { u128::MAX << (128 - len as u32) };
            u128::from(a) & mask == u128::from(n) & mask
        }
        _ => false,
    }
}

/// RFC 1918, the shared range (100.64/10) and IPv6 unique-local: the
/// user's own estate, as far as an address can say.
fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => a.is_private() || (a.octets()[0] == 100 && (a.octets()[1] & 0xc0) == 64),
        IpAddr::V6(a) => (a.segments()[0] & 0xfe00) == 0xfc00,
    }
}

/// An address worth following: not unspecified, loopback, link-local or multicast.
fn followable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => !(a.is_unspecified() || a.is_loopback() || a.is_link_local() || a.is_multicast() || a.is_broadcast()),
        IpAddr::V6(a) => !(a.is_unspecified() || a.is_loopback() || a.is_multicast() || (a.segments()[0] & 0xffc0) == 0xfe80),
    }
}

/// The queue of devices still to collect, and everything already seen.
#[derive(Debug)]
pub struct Frontier {
    limits: Limits,
    queue: VecDeque<(String, u32)>,
    seen: BTreeSet<String>,
    taken: usize,
    /// Neighbours named but not followed, with the reason — for the review's
    /// "not visited" list.
    pub not_followed: Vec<(String, String)>,
}

impl Frontier {
    pub fn new(seeds: &[String], limits: Limits) -> Self {
        let mut f = Frontier { limits, queue: VecDeque::new(), seen: BTreeSet::new(), taken: 0, not_followed: Vec::new() };
        for s in seeds {
            if f.seen.insert(s.trim().to_string()) {
                f.queue.push_back((s.trim().to_string(), 0));
            }
        }
        f
    }

    /// The next device to collect and its hop, until the device limit.
    pub fn next_device(&mut self) -> Option<(String, u32)> {
        if self.limits.max_devices > 0 && self.taken >= self.limits.max_devices {
            while let Some((host, _)) = self.queue.pop_front() {
                self.not_followed.push((host, format!("the limit of {} devices was reached", self.limits.max_devices)));
            }
            return None;
        }
        let next = self.queue.pop_front()?;
        self.taken += 1;
        Some(next)
    }

    /// Addresses a ticked subnet's scan found, queued as seeds once
    /// the neighbours have run out; one already collected or queued is not
    /// queued again. Returns how many were new.
    pub fn add_scanned(&mut self, addresses: &[String]) -> usize {
        let mut added = 0;
        for a in addresses {
            if self.seen.insert(a.trim().to_string()) {
                self.queue.push_back((a.trim().to_string(), 0));
                added += 1;
            }
        }
        added
    }

    /// Devices queued and not yet collected.
    pub fn waiting(&self) -> usize {
        self.queue.len()
    }

    /// What one collected device, at `hop`, owns and names as neighbours.
    pub fn learn(&mut self, hop: u32, own: &[String], neighbours: &[String]) {
        for a in own {
            self.seen.insert(a.clone());
            self.queue.retain(|(h, _)| h != a);
        }
        for n in neighbours {
            if self.seen.contains(n) {
                continue;
            }
            self.seen.insert(n.clone());
            let Ok(ip) = n.parse::<IpAddr>() else { continue };
            if !followable(ip) {
                continue;
            }
            let named = self.limits.subnets.iter().any(|net| inside(ip, *net));
            if hop + 1 > self.limits.max_hops {
                self.not_followed.push((n.clone(), format!("more than {} hop(s) from a seed", self.limits.max_hops)));
            } else if !self.limits.subnets.is_empty() && !named && !is_private(ip) {
                // The subnet limit holds back a public address it did
                // not name; the estate's own private addresses are gated by
                // the "Log in to" kinds alone, wherever they sit.
                let nets: Vec<String> = self.limits.subnets.iter().map(|(a, l)| format!("{a}/{l}")).collect();
                self.not_followed.push((n.clone(), format!("outside {}", nets.join(", "))));
            } else if !is_private(ip) && !named {
                // An edge firewall's default route points at the
                // provider; the login must not be offered there unasked.
                self.not_followed.push((n.clone(), "outside the private ranges; a subnet limit naming it would allow it".into()));
            } else {
                self.queue.push_back((n.clone(), hop + 1));
            }
        }
    }

    /// Everything one collected device told the frontier (a
    /// neighbour with no address is listed, not dropped).
    pub fn learn_found(&mut self, hop: u32, found: &Found) {
        // A neighbour of a kind not ticked is listed, never reached.
        // One that said nothing of what it is (no platform, no capabilities)
        // is still tried: the fingerprint will say, and the classic crawler
        // never had the chance to ask.
        let mut next = Vec::new();
        for n in &found.next {
            match found.classes.get(n).filter(|c| **c != coreview_discover::types::DeviceClass::Unknown).and_then(|c| not_logged_into(&self.limits.login_classes, *c)) {
                Some(why) => {
                    if self.seen.insert(n.clone()) {
                        self.not_followed.push((n.clone(), why));
                    }
                }
                None => next.push(n.clone()),
            }
        }
        self.learn(hop, &found.own, &next);
        for name in &found.unreachable {
            if self.seen.insert(format!("name:{name}")) {
                self.not_followed.push((name.clone(), "no address to reach it on".into()));
            }
        }
    }
}

/// Whether a neighbour of this kind is logged into under `allowed`
/// (empty: the infrastructure kinds), and why not when it is not — the
/// classic crawler's rule, word for word.
pub fn not_logged_into(allowed: &[coreview_discover::types::DeviceClass], class: coreview_discover::types::DeviceClass) -> Option<String> {
    let allowed: Vec<coreview_discover::types::DeviceClass> = if allowed.is_empty() { coreview_discover::types::DeviceClass::INFRASTRUCTURE.to_vec() } else { allowed.to_vec() };
    if allowed.contains(&class) {
        None
    } else {
        Some(format!("{} is not a kind this run logs into", coreview_discover::filter::with_article(class)))
    }
}

/// What one collected device tells the frontier.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Found {
    /// Its own addresses, the one it was reached on included.
    pub own: Vec<String>,
    /// Addresses to go to next.
    pub next: Vec<String>,
    /// Neighbours named with no address to reach them on.
    pub unreachable: Vec<String>,
    /// What each next address advertised itself as, by its
    /// platform and capabilities, where a neighbour row said.
    pub classes: std::collections::BTreeMap<String, coreview_discover::types::DeviceClass>,
}

/// A collected device's own addresses and the addresses of what it points
/// at, read from its rows the way the run stores them.
pub fn found_of_run(run: &DeviceRun) -> Found {
    let mut rows = Vec::new();
    for r in &run.results {
        if r.outcome.status == "ok" {
            rows.extend(rows_for_step(&r.step, &rows_of(&r.step.parser, &r.outcome)));
        }
    }
    let mut found = found_in_rows(&rows);
    if !found.own.contains(&run.host) {
        found.own.push(run.host.clone());
    }
    found
}

/// `found_of_run` as (own, next).
pub fn addresses_of_run(run: &DeviceRun) -> (Vec<String>, Vec<String>) {
    let f = found_of_run(run);
    (f.own, f.next)
}

fn mac_key(m: &str) -> String {
    m.chars().filter(|c| c.is_ascii_hexdigit()).collect::<String>().to_ascii_lowercase()
}

fn addresses_in(v: &str) -> impl Iterator<Item = &str> {
    v.split([',', ' ']).map(|a| a.split('/').next().unwrap_or("").trim()).filter(|a| a.parse::<IpAddr>().is_ok())
}

/// From one device's rows: its own addresses, and where to go next —
/// each CDP/LLDP neighbour's management address, or, where the neighbour
/// advertises none (a FortiSwitch does not), the address this device's
/// ARP table has for the neighbour's chassis MAC; and every route's next
/// hop, which is how a firewall that sends no LLDP is reached, as the
/// older crawler reached it through the default route.
pub fn addresses_from_rows(rows: &[crate::tables::Normalised]) -> (Vec<String>, Vec<String>) {
    let f = found_in_rows(rows);
    (f.own, f.next)
}

/// `addresses_from_rows`, with the neighbours no address reaches.
pub fn found_in_rows(rows: &[crate::tables::Normalised]) -> Found {
    let mut own = BTreeSet::new();
    let mut next = BTreeSet::new();
    let mut unreachable = BTreeSet::new();
    let mut classes = std::collections::BTreeMap::new();
    let arp: std::collections::BTreeMap<String, String> = rows
        .iter()
        .filter(|n| n.table == "arp")
        .filter_map(|n| Some((mac_key(n.columns.get("mac")?), addresses_in(n.columns.get("ip")?).next()?.to_string())))
        .filter(|(m, _)| m.len() == 12)
        .collect();
    for n in rows {
        match n.table.as_str() {
            "ip_address" => own.extend(n.columns.get("ip").into_iter().flat_map(|v| addresses_in(v)).map(str::to_string)),
            "neighbor" => {
                let mut named: Vec<String> = n.columns.get("rem_mgmt_ip").into_iter().flat_map(|v| addresses_in(v)).map(str::to_string).collect();
                if named.is_empty() {
                    named.extend(n.columns.get("rem_chassis_id").and_then(|c| arp.get(&mac_key(c))).cloned());
                }
                if named.is_empty() {
                    unreachable.extend(n.columns.get("rem_sysname").map(|x| x.trim().to_string()).filter(|x| !x.is_empty()));
                }
                // What the neighbour says it is, from its platform and capabilities.
                let caps: Vec<String> = n.columns.get("rem_caps").map(|c| c.split([',', ' ', ';']).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect()).unwrap_or_default();
                let class = coreview_discover::classify::classify(n.columns.get("rem_platform").map(String::as_str), &caps, None);
                for a in &named {
                    classes.entry(a.clone()).or_insert(class);
                }
                next.extend(named);
            }
            "route" => next.extend(n.columns.get("next_hop").into_iter().flat_map(|v| addresses_in(v)).map(str::to_string)),
            _ => {}
        }
    }
    for a in &own {
        next.remove(a);
    }
    Found { own: own.into_iter().collect(), next: next.into_iter().collect(), unreachable: unreachable.into_iter().collect(), classes }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits(hops: u32, devices: usize, subnet: Option<&str>) -> Limits {
        Limits { max_hops: hops, max_devices: devices, subnets: subnet.map(|s| parse_subnet(s).unwrap()).into_iter().collect(), login_classes: Vec::new() }
    }

    /// A neighbour of a kind not ticked is listed, not followed.
    #[test]
    fn a_neighbour_of_a_kind_not_ticked_is_not_logged_into() {
        use coreview_discover::types::DeviceClass;
        let mut l = limits(2, 10, Some("192.0.2.0/24"));
        l.login_classes = vec![DeviceClass::Switch];
        let mut f = Frontier::new(&["192.0.2.7".into()], l);
        f.next_device();
        let mut found = Found { own: vec!["192.0.2.7".into()], next: vec!["192.0.2.8".into(), "192.0.2.9".into(), "192.0.2.10".into()], ..Default::default() };
        found.classes.insert("192.0.2.8".into(), DeviceClass::Switch);
        found.classes.insert("192.0.2.9".into(), DeviceClass::Phone);
        // 192.0.2.10 said nothing of what it is: still tried.
        found.classes.insert("192.0.2.10".into(), DeviceClass::Unknown);
        f.learn_found(0, &found);
        assert_eq!(f.next_device(), Some(("192.0.2.8".into(), 1)));
        assert_eq!(f.next_device(), Some(("192.0.2.10".into(), 1)));
        assert_eq!(f.next_device(), None);
        assert_eq!(f.not_followed, vec![("192.0.2.9".into(), "a phone is not a kind this run logs into".into())]);
        // No list at all: the infrastructure kinds, so a phone is still left alone and a router is not.
        assert!(not_logged_into(&[], DeviceClass::Phone).is_some());
        assert!(not_logged_into(&[], DeviceClass::Router).is_none());
    }

    /// A real SN2010, from its own LLDP detail. Every
    /// neighbour that names a management address is something to log in to,
    /// classed from what it says; the kinds ticked are queued, the others
    /// listed as not followed; the switch's own address is not queued.
    #[test]
    fn a_cumulus_switchs_neighbours_are_queued_by_the_kinds_ticked() {
        use coreview_discover::types::DeviceClass;
        let lldp = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../coreview-discover/fixtures/cumulus5/lldpcli_show_neighbors_details.txt"));
        let ifaces = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../coreview-discover/fixtures/cumulus5/nv_show_interface.txt"));
        let mut rows = crate::tables::normalise_all(&["neighbor".into()], &crate::readers::read("nvue_lldp", lldp).unwrap());
        rows.extend(crate::tables::normalise_all(&["ip_address".into()], &crate::readers::read("nvue_interfaces", ifaces).unwrap()));
        let found = found_in_rows(&rows);
        for (ip, class) in [("198.51.100.4", DeviceClass::Switch), ("198.51.100.23", DeviceClass::Switch), ("198.51.100.13", DeviceClass::Switch), ("10.77.0.7", DeviceClass::WirelessController), ("198.51.100.1", DeviceClass::Firewall)] {
            assert!(found.next.contains(&ip.to_string()), "{ip} not queued: {:?}", found.next);
            assert_eq!(found.classes.get(ip), Some(&class), "{ip}");
        }
        assert!(!found.next.contains(&"198.51.100.12".to_string()), "itself, heard back on its own cable");
        // The fixture's addresses are documentation ranges, which count as
        // public; a real estate's are private. The subnets say they are ours.
        let mut l = limits(2, 20, Some("198.51.100.0/24"));
        l.subnets.push(parse_subnet("10.0.0.0/8").unwrap());
        l.login_classes = vec![DeviceClass::Switch, DeviceClass::Router, DeviceClass::Firewall];
        let mut f = Frontier::new(&["198.51.100.12".into()], l);
        f.next_device();
        f.learn_found(0, &found);
        let mut queued = Vec::new();
        while let Some((a, _)) = f.next_device() {
            queued.push(a);
        }
        for ip in ["198.51.100.4", "198.51.100.23", "198.51.100.13", "198.51.100.1"] {
            assert!(queued.contains(&ip.to_string()), "{ip}: {queued:?}");
        }
        assert!(!queued.contains(&"10.77.0.7".to_string()), "a controller was not ticked");
        assert!(f.not_followed.iter().any(|(a, _)| a == "10.77.0.7"));
    }

    #[test]
    fn neighbours_are_followed_one_hop_at_a_time_within_the_limits() {
        let mut f = Frontier::new(&["192.0.2.7".into()], limits(1, 10, Some("192.0.2.0/24")));
        assert_eq!(f.next_device(), Some(("192.0.2.7".into(), 0)));
        f.learn(0, &["192.0.2.7".into()], &["192.0.2.203".into(), "198.51.100.1".into(), "192.0.2.7".into(), "169.254.1.1".into()]);
        assert_eq!(f.next_device(), Some(("192.0.2.203".into(), 1)));
        // At hop 1 with a limit of 1, what it names is not followed.
        f.learn(1, &["192.0.2.203".into()], &["192.0.2.50".into()]);
        assert_eq!(f.next_device(), None);
        assert_eq!(f.not_followed, vec![("198.51.100.1".into(), "outside 192.0.2.0/24".into()), ("192.0.2.50".into(), "more than 1 hop(s) from a seed".into())]);
    }

    #[test]
    fn a_device_is_not_collected_again_on_another_of_its_addresses() {
        // A switch names the firewall by its DMZ address; the firewall was
        // already collected on its LAN address and owns both.
        let mut f = Frontier::new(&["192.0.2.1".into(), "192.0.2.7".into()], limits(3, 10, None));
        f.next_device();
        f.learn(0, &["192.0.2.1".into(), "203.0.113.1".into()], &[]);
        f.next_device();
        f.learn(0, &["192.0.2.7".into()], &["203.0.113.1".into(), "192.0.2.1".into()]);
        assert_eq!(f.next_device(), None);
        assert!(f.not_followed.is_empty());
    }

    #[test]
    fn the_device_limit_stops_the_queue_and_says_why() {
        // Documentation addresses are public ones; the limit names them.
        let mut f = Frontier::new(&["192.0.2.1".into()], limits(3, 2, Some("192.0.2.0/24")));
        f.next_device();
        f.learn(0, &[], &["192.0.2.2".into(), "192.0.2.3".into()]);
        assert_eq!(f.next_device(), Some(("192.0.2.2".into(), 1)));
        assert_eq!(f.next_device(), None);
        assert_eq!(f.not_followed, vec![("192.0.2.3".into(), "the limit of 2 devices was reached".into())]);
    }

    #[test]
    fn a_subnet_is_address_and_length() {
        assert_eq!(parse_subnet("192.0.2.0/24").unwrap().1, 24);
        assert!(parse_subnet("192.0.2.0").is_err());
        assert!(parse_subnet("192.0.2.0/33").is_err());
        assert!(inside("192.0.2.200".parse().unwrap(), parse_subnet("192.0.2.0/24").unwrap()));
        assert!(!inside("192.0.3.1".parse().unwrap(), parse_subnet("192.0.2.0/24").unwrap()));
    }

    fn row(table: &str, cols: &[(&str, &str)]) -> crate::tables::Normalised {
        crate::tables::Normalised { table: table.into(), columns: cols.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), extra: Default::default() }
    }

    /// The lab's shape, invented values: a switch whose LLDP neighbour
    /// advertises no management address, whose ARP has that neighbour's
    /// chassis MAC, and whose default route points at a firewall that sends
    /// no LLDP at all.
    #[test]
    fn neighbours_without_an_address_are_found_by_arp_and_routers_by_next_hop() {
        let rows = vec![
            row("ip_address", &[("interface", "Vlan1"), ("ip", "192.0.2.7"), ("prefixlen", "24")]),
            row("neighbor", &[("local_if", "Gi0/1"), ("rem_sysname", "SW2"), ("rem_mgmt_ip", "192.0.2.112")]),
            row("neighbor", &[("local_if", "Gi0/9"), ("rem_sysname", "FSW1"), ("rem_chassis_id", "0000.0000.964b")]),
            row("neighbor", &[("local_if", "Gi0/7"), ("rem_sysname", "PC1"), ("rem_chassis_id", "0000.0000.0bad")]),
            row("arp", &[("ip", "192.0.2.203"), ("mac", "0000.0000.964b"), ("interface", "Vlan1")]),
            row("arp", &[("ip", "192.0.2.1"), ("mac", "0000.0000.0fe8"), ("interface", "Vlan1")]),
            row("route", &[("prefix", "0.0.0.0"), ("mask", "0"), ("proto", "S"), ("next_hop", "192.0.2.1")]),
            row("route", &[("prefix", "192.0.2.0"), ("mask", "24"), ("proto", "C"), ("interface", "Vlan1")]),
        ];
        let (own, next) = addresses_from_rows(&rows);
        assert_eq!(own, vec!["192.0.2.7"]);
        assert_eq!(next, vec!["192.0.2.1", "192.0.2.112", "192.0.2.203"]);
    }

    /// A next hop outside the private ranges — an edge firewall's
    /// default route is the provider's router — is followed only when a
    /// subnet limit the operator typed includes it.
    #[test]
    fn a_public_next_hop_is_not_followed_unless_a_subnet_limit_names_it() {
        let mut f = Frontier::new(&["192.0.2.1".into()], limits(3, 10, None));
        f.next_device();
        f.learn(0, &["192.0.2.1".into()], &["198.51.100.1".into(), "10.0.0.2".into()]);
        assert_eq!(f.next_device(), Some(("10.0.0.2".into(), 1)));
        assert_eq!(f.next_device(), None);
        assert_eq!(f.not_followed, vec![("198.51.100.1".into(), "outside the private ranges; a subnet limit naming it would allow it".into())]);
        let mut f = Frontier::new(&["192.0.2.1".into()], limits(3, 10, Some("198.51.100.0/24")));
        f.next_device();
        f.learn(0, &[], &["198.51.100.1".into()]);
        assert_eq!(f.next_device(), Some(("198.51.100.1".into(), 1)), "named by the operator, so followed");
    }

    /// A subnet limit no longer holds back the estate's own private
    /// addresses; it still holds back a public one it did not name.
    #[test]
    fn a_private_neighbour_outside_the_named_subnets_is_still_followed() {
        let mut f = Frontier::new(&["10.1.1.1".into()], limits(3, 10, Some("10.1.1.0/24")));
        f.next_device();
        f.learn(0, &["10.1.1.1".into()], &["10.200.0.2".into(), "172.20.0.1".into(), "198.51.100.9".into()]);
        assert_eq!(f.next_device(), Some(("10.200.0.2".into(), 1)));
        assert_eq!(f.next_device(), Some(("172.20.0.1".into(), 1)));
        assert_eq!(f.next_device(), None);
        assert_eq!(f.not_followed, vec![("198.51.100.9".into(), "outside 10.1.1.0/24".into())]);
    }

    /// What the scan found is queued after the neighbours, at hop 0,
    /// and what a neighbour already led to is not queued twice.
    #[test]
    fn what_a_scan_finds_is_queued_once_after_the_neighbours() {
        let mut f = Frontier::new(&["10.1.1.1".into()], limits(3, 10, None));
        f.next_device();
        f.learn(0, &["10.1.1.1".into()], &["10.1.1.2".into()]);
        assert_eq!(f.add_scanned(&["10.1.1.1".into(), "10.1.1.2".into(), "10.1.1.9".into()]), 1);
        assert_eq!(f.next_device(), Some(("10.1.1.2".into(), 1)));
        assert_eq!(f.next_device(), Some(("10.1.1.9".into(), 0)));
        assert_eq!(f.next_device(), None);
    }

    /// A neighbour with no address to reach it on is still listed.
    #[test]
    fn a_neighbour_with_no_address_is_listed_as_not_followed() {
        let rows = vec![
            row("neighbor", &[("local_if", "Gi0/7"), ("rem_sysname", "PC1"), ("rem_chassis_id", "0000.0000.0bad")]),
            row("neighbor", &[("local_if", "Gi0/8"), ("rem_sysname", "AP1"), ("rem_mgmt_ip", "10.0.0.23")]),
        ];
        let found = found_in_rows(&rows);
        assert_eq!(found.next, vec!["10.0.0.23"]);
        assert_eq!(found.unreachable, vec!["PC1"]);
        let mut f = Frontier::new(&["10.0.0.1".into()], limits(3, 10, None));
        f.next_device();
        f.learn_found(0, &found);
        assert_eq!(f.not_followed, vec![("PC1".into(), "no address to reach it on".into())]);
    }
}
