//! Following neighbours (LT-576, D-062): "Discover devices" on the
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
            if hop + 1 > self.limits.max_hops {
                self.not_followed.push((n.clone(), format!("more than {} hop(s) from a seed", self.limits.max_hops)));
            } else if !self.limits.subnets.is_empty() && !self.limits.subnets.iter().any(|net| inside(ip, *net)) {
                let nets: Vec<String> = self.limits.subnets.iter().map(|(a, l)| format!("{a}/{l}")).collect();
                self.not_followed.push((n.clone(), format!("outside {}", nets.join(", "))));
            } else {
                self.queue.push_back((n.clone(), hop + 1));
            }
        }
    }
}

/// A collected device's own addresses and the addresses of what it points
/// at, read from its rows the way the run stores them.
pub fn addresses_of_run(run: &DeviceRun) -> (Vec<String>, Vec<String>) {
    let mut rows = Vec::new();
    for r in &run.results {
        if r.outcome.status == "ok" {
            rows.extend(rows_for_step(&r.step, &rows_of(&r.step.parser, &r.outcome)));
        }
    }
    let (mut own, next) = addresses_from_rows(&rows);
    if !own.contains(&run.host) {
        own.push(run.host.clone());
    }
    (own, next)
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
    let mut own = BTreeSet::new();
    let mut next = BTreeSet::new();
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
                next.extend(named);
            }
            "route" => next.extend(n.columns.get("next_hop").into_iter().flat_map(|v| addresses_in(v)).map(str::to_string)),
            _ => {}
        }
    }
    for a in &own {
        next.remove(a);
    }
    (own.into_iter().collect(), next.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits(hops: u32, devices: usize, subnet: Option<&str>) -> Limits {
        Limits { max_hops: hops, max_devices: devices, subnets: subnet.map(|s| parse_subnet(s).unwrap()).into_iter().collect() }
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
        let mut f = Frontier::new(&["192.0.2.1".into()], limits(3, 2, None));
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
}
