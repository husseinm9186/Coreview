//! A firewall on the path (LT-532): NAT and policy, in each vendor's order.
//!
//! - **FortiOS**: VIP (destination NAT) → route → policy → source NAT.
//! - **PAN-OS**: route on the pre-NAT destination (which decides the
//!   destination zone NAT is matched in) → NAT → policy (pre-NAT addresses,
//!   post-NAT zone) → route again on the translated destination.
//! - **ASA/FTD**: NAT before the route; the access policy sees real addresses.
//! - **Anything else with policy rows**: route → policy → source NAT.
//!
//! Matching is three-valued. A rule that names an address or service object
//! the tables do not resolve is neither a match nor a miss: the verdict is
//! then undetermined, naming the object (D-050) — never a guessed allow.

use std::net::Ipv4Addr;

use coreview_topology::ifname::key;
use serde::Serialize;

use crate::model::{Box_, FwPolicy, NatRule, Net4};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Forti,
    Pan,
    Asa,
    Other,
}

pub fn kind(b: &Box_) -> Option<Kind> {
    match b.os.as_deref() {
        Some("fortios") => Some(Kind::Forti),
        Some("panos") => Some(Kind::Pan),
        Some("cisco_asa") | Some("cisco_ftd") => Some(Kind::Asa),
        _ if !b.fw.is_empty() || b.role.as_deref() == Some("firewall") => Some(Kind::Other),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Tri {
    Yes,
    No,
    Unknown(String),
}

impl Tri {
    /// Both must hold: a miss anywhere is a miss; otherwise the first unknown.
    pub fn and(self, other: Tri) -> Tri {
        match (self, other) {
            (Tri::No, _) | (_, Tri::No) => Tri::No,
            (Tri::Unknown(a), _) => Tri::Unknown(a),
            (_, Tri::Unknown(b)) => Tri::Unknown(b),
            _ => Tri::Yes,
        }
    }
}

fn is_any(s: &str) -> bool {
    matches!(s.trim().to_ascii_lowercase().as_str(), "any" | "all" | "any4" | "0.0.0.0/0" | "0.0.0.0 0.0.0.0" | "*" | "any-ipv4")
}

/// One address item: `any`, an address, a prefix (`/24` or a mask), `host
/// a.b.c.d`, a range `a-b`. `None` when it is a name the tables do not define.
fn addr_item(item: &str, ip: Ipv4Addr) -> Option<bool> {
    let t = item.trim();
    if is_any(t) {
        return Some(true);
    }
    let t = t.strip_prefix("host ").unwrap_or(t).trim();
    if let Some((a, z)) = t.split_once('-') {
        if let (Ok(a), Ok(z)) = (a.trim().parse::<Ipv4Addr>(), z.trim().parse::<Ipv4Addr>()) {
            let v = u32::from(ip);
            return Some(u32::from(a) <= v && v <= u32::from(z));
        }
    }
    Net4::parse(t).map(|n| n.contains(ip))
}

/// A rule's address list against an address. `names` are objects known to
/// stand for this address here — a FortiOS VIP applied on arrival is written
/// by its name in the policy that allows it.
pub fn addr_match(list: &[String], ip: Ipv4Addr, names: &[String]) -> Tri {
    if list.is_empty() {
        return Tri::Yes;
    }
    let mut unknown = None;
    for item in list {
        if names.iter().any(|n| n.eq_ignore_ascii_case(item.trim())) {
            return Tri::Yes;
        }
        match addr_item(item, ip) {
            Some(true) => return Tri::Yes,
            Some(false) => {}
            None => {
                unknown.get_or_insert_with(|| item.trim().to_string());
            }
        }
    }
    match unknown {
        Some(name) => Tri::Unknown(format!("the address object \"{name}\" is not in the collected tables")),
        None => Tri::No,
    }
}

/// Services a vendor predefines, by the name its policies use (FortiOS,
/// PAN-OS and ASA defaults — the vendor's definitions, not a guess).
fn predefined(name: &str) -> Option<&'static [(u8, u16, u16)]> {
    const TCP: u8 = 6;
    const UDP: u8 = 17;
    const ICMP: u8 = 1;
    Some(match name.to_ascii_lowercase().as_str() {
        "all_tcp" => &[(TCP, 1, 65535)],
        "all_udp" => &[(UDP, 1, 65535)],
        "all_icmp" | "ping" | "icmp" | "echo" => &[(ICMP, 0, 0)],
        "http" | "www" | "service-http" => &[(TCP, 80, 80), (TCP, 8080, 8080)],
        "https" | "service-https" => &[(TCP, 443, 443)],
        "ssh" => &[(TCP, 22, 22)],
        "telnet" => &[(TCP, 23, 23)],
        "dns" | "domain" => &[(TCP, 53, 53), (UDP, 53, 53)],
        "ntp" => &[(UDP, 123, 123), (TCP, 123, 123)],
        "smtp" => &[(TCP, 25, 25)],
        "smtps" => &[(TCP, 465, 465)],
        "imap" => &[(TCP, 143, 143)],
        "imaps" => &[(TCP, 993, 993)],
        "pop3" => &[(TCP, 110, 110)],
        "pop3s" => &[(TCP, 995, 995)],
        "ftp" => &[(TCP, 21, 21)],
        "rdp" => &[(TCP, 3389, 3389)],
        "snmp" => &[(UDP, 161, 162)],
        "syslog" => &[(UDP, 514, 514)],
        "ldap" => &[(TCP, 389, 389)],
        "kerberos" => &[(TCP, 88, 88), (UDP, 88, 88)],
        "smb" | "samba" => &[(TCP, 139, 139), (TCP, 445, 445)],
        "mysql" => &[(TCP, 3306, 3306)],
        "ms-sql" => &[(TCP, 1433, 1434)],
        _ => return None,
    })
}

/// A protocol name or number.
pub fn proto_number(p: &str) -> Option<u8> {
    match p.trim().to_ascii_lowercase().as_str() {
        "tcp" => Some(6),
        "udp" => Some(17),
        "icmp" => Some(1),
        n => n.parse().ok(),
    }
}

/// `tcp/443`, `tcp_443`, `TCP-443`, `udp:53`, `tcp/1000-2000`, `443`.
fn port_form(s: &str) -> Option<(Option<u8>, u16, u16)> {
    let t = s.trim().to_ascii_lowercase();
    let (proto, rest) = match t.find(['/', '_', ':', '-']) {
        Some(i) if t[..i].chars().all(|c| c.is_ascii_alphabetic()) && !t[..i].is_empty() => (proto_number(&t[..i]), &t[i + 1..]),
        _ => (None, t.as_str()),
    };
    let (a, z) = match rest.split_once('-') {
        Some((a, z)) => (a.trim().parse().ok()?, z.trim().parse().ok()?),
        None => {
            let p: u16 = rest.trim().parse().ok()?;
            (p, p)
        }
    };
    Some((proto, a, z))
}

pub fn svc_match(list: &[String], proto: Option<u8>, port: Option<u16>) -> Tri {
    if list.is_empty() {
        return Tri::Yes;
    }
    let mut unknown = None;
    for item in list {
        let t = item.trim();
        if is_any(t) || t.eq_ignore_ascii_case("ip") || t.eq_ignore_ascii_case("ALL") {
            return Tri::Yes;
        }
        let ranges: Vec<(Option<u8>, u16, u16)> = match predefined(t) {
            Some(r) => r.iter().map(|(p, a, z)| (Some(*p), *a, *z)).collect(),
            None => match port_form(t) {
                Some(r) => vec![r],
                None => {
                    if let (Some(p), Some(want)) = (proto_number(t), proto) {
                        // A bare protocol: `tcp`, `udp`, `icmp`.
                        if t.chars().all(|c| c.is_ascii_alphabetic()) {
                            if p == want {
                                return Tri::Yes;
                            }
                            continue;
                        }
                    }
                    unknown.get_or_insert_with(|| format!("the service \"{t}\" is not in the collected tables"));
                    continue;
                }
            },
        };
        for (p, a, z) in ranges {
            match (proto, port) {
                (Some(want), _) if p.is_some() && p != Some(want) => {}
                (_, _) if p == Some(1) => {
                    if proto == Some(1) {
                        return Tri::Yes;
                    }
                    if proto.is_none() {
                        unknown.get_or_insert_with(|| format!("the flow's protocol was not given, and the rule allows only {t}"));
                    }
                }
                (_, Some(port)) if a <= port && port <= z => {
                    if proto.is_some() || p.is_none() {
                        return Tri::Yes;
                    }
                    unknown.get_or_insert_with(|| format!("the flow's protocol was not given, and the rule allows only {t}"));
                }
                (_, Some(_)) => {}
                (_, None) => {
                    unknown.get_or_insert_with(|| format!("the flow's port was not given, and the rule allows only {t}"));
                }
            }
        }
    }
    match unknown {
        Some(u) => Tri::Unknown(u),
        None => Tri::No,
    }
}

fn zone_match(list: &[String], candidates: &[String]) -> Tri {
    if list.is_empty() || list.iter().any(|z| is_any(z)) {
        return Tri::Yes;
    }
    let want: Vec<String> = candidates.iter().map(|c| key(c)).collect();
    if list.iter().any(|z| want.contains(&key(z))) {
        Tri::Yes
    } else {
        Tri::No
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Allow,
    Deny,
    Undetermined,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FwVerdict {
    pub zone_in: Option<String>,
    pub zone_out: Option<String>,
    /// The policy that decided, as the device names it.
    pub policy: Option<String>,
    pub action: Option<String>,
    pub verdict: Verdict,
    /// In one sentence, why.
    pub reason: String,
}

fn allows(action: &str) -> bool {
    matches!(action.trim().to_ascii_lowercase().as_str(), "allow" | "accept" | "permit" | "pass" | "trust")
}

/// The flow a policy is asked about.
pub struct Flow<'a> {
    pub zones_in: &'a [String],
    pub zones_out: &'a [String],
    pub src: Ipv4Addr,
    pub dst: Ipv4Addr,
    pub proto: Option<u8>,
    pub port: Option<u16>,
    /// Objects that stand for the destination here (an applied VIP).
    pub dst_names: &'a [String],
}

fn first_named_zone(b: &Box_, zones: &[String]) -> Option<String> {
    // The zone the device defines, else the interface itself.
    zones.iter().find(|z| b.zones.contains_key(*z)).or_else(|| zones.last()).cloned()
}

/// The first enabled policy that matches decides; none that matches is the
/// vendor's default.
pub fn verdict(b: &Box_, k: Kind, flow: &Flow) -> FwVerdict {
    let zone_in = first_named_zone(b, flow.zones_in);
    let zone_out = first_named_zone(b, flow.zones_out);
    let mut out = FwVerdict { zone_in: zone_in.clone(), zone_out: zone_out.clone(), policy: None, action: None, verdict: Verdict::Undetermined, reason: String::new() };
    if !b.has_table("fw_policy") {
        out.reason = format!("No firewall policy was collected from {}, so what it does with this flow is not known.", b.name);
        return out;
    }
    for p in b.fw.iter().filter(|p| p.enabled) {
        // An ASA access list applies where `access-group` binds it. A rule
        // with no interface recorded could apply to either direction.
        let bound = if k == Kind::Asa && p.src_zones.is_empty() && p.dst_zones.is_empty() {
            Tri::Unknown(format!("the interface {} is bound to was not collected", p.label()))
        } else {
            Tri::Yes
        };
        let m = bound
            .and(zone_match(&p.src_zones, flow.zones_in))
            .and(zone_match(&p.dst_zones, flow.zones_out))
            .and(addr_match(&p.src_addr, flow.src, &[]))
            .and(addr_match(&p.dst_addr, flow.dst, flow.dst_names))
            .and(svc_match(&p.services, flow.proto, flow.port));
        match m {
            Tri::No => continue,
            Tri::Yes => return decided(out, p),
            Tri::Unknown(why) => {
                out.policy = Some(p.label());
                out.action = Some(p.action.clone());
                out.reason = format!("{} would decide if it matches, and whether it does is not known: {why}.", p.label());
                return out;
            }
        }
    }
    // Nothing matched: the vendor's default.
    let (verdict, policy, reason) = match k {
        Kind::Pan if zone_in.is_some() && zone_in == zone_out => (Verdict::Allow, "intrazone-default", "No rule matched; PAN-OS allows traffic within one zone by default."),
        Kind::Pan => (Verdict::Deny, "interzone-default", "No rule matched; PAN-OS denies traffic between zones by default."),
        Kind::Forti => (Verdict::Deny, "implicit deny (policy 0)", "No policy matched; FortiOS denies what no policy allows."),
        _ => (Verdict::Deny, "implicit deny", "No rule matched; what no rule allows is denied."),
    };
    out.verdict = verdict;
    out.policy = Some(policy.into());
    out.reason = reason.into();
    out
}

fn decided(mut out: FwVerdict, p: &FwPolicy) -> FwVerdict {
    out.policy = Some(p.label());
    out.action = Some(p.action.clone());
    out.verdict = if allows(&p.action) { Verdict::Allow } else { Verdict::Deny };
    out.reason = format!("{} is the first enabled rule that matches, and it says {}.", p.label(), if p.action.is_empty() { "nothing" } else { &p.action });
    out
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rewrite {
    pub rule: String,
    pub kind: String,
    /// `source` or `destination`.
    pub field: String,
    pub was: String,
    pub now: String,
}

fn nat_kind_is_dst(r: &NatRule) -> bool {
    let k = &r.kind;
    k.contains("vip") || k.contains("dnat") || k.contains("destination") || k.contains("port-forward") || (r.trans_dst.is_some() && r.orig_dst.is_some())
}

fn nat_kind_is_src(r: &NatRule) -> bool {
    let k = &r.kind;
    k.contains("snat") || k.contains("source") || k.contains("dynamic") || k.contains("hide") || k.contains("masquerade") || k.contains("pat") || (r.trans_src.is_some() && r.orig_src.is_some())
}

/// One address a translation writes: a single address (or a one-address range).
fn single(s: &str) -> Option<Ipv4Addr> {
    let t = s.trim();
    if let Some((a, z)) = t.split_once('-') {
        let (a, z) = (a.trim().parse::<Ipv4Addr>().ok()?, z.trim().parse::<Ipv4Addr>().ok()?);
        return (a == z).then_some(a);
    }
    let n = Net4::parse(t)?;
    (n.len == 32).then(|| Ipv4Addr::from(n.addr))
}

fn zone_ok(field: &Option<String>, zones: &[String]) -> Tri {
    match field {
        None => Tri::Yes,
        Some(z) => zone_match(&z.split([',', ';']).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect::<Vec<_>>(), zones),
    }
}

fn list(s: &Option<String>) -> Vec<String> {
    s.as_deref().map(|v| v.split([',', ';']).map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()).unwrap_or_default()
}

/// Destination NAT on arrival. `Err` is a rule that may apply and cannot be
/// decided, for the hop's notes.
pub fn dnat(b: &Box_, zones_in: &[String], zones_out: Option<&[String]>, src: Ipv4Addr, dst: Ipv4Addr, proto: Option<u8>, port: Option<u16>) -> Result<Option<Rewrite>, String> {
    for r in &b.nat {
        // A static rule written the source way round (ASA `static (inside,outside) real mapped`)
        // is also the destination rule for traffic to the mapped address.
        let reverse_static = r.kind.contains("static") && r.orig_dst.is_none() && r.trans_dst.is_none();
        let (orig, trans) = if reverse_static {
            (r.trans_src.clone(), r.orig_src.clone())
        } else if nat_kind_is_dst(r) {
            (r.orig_dst.clone(), r.trans_dst.clone())
        } else {
            continue;
        };
        let (Some(orig), Some(trans)) = (orig, trans) else { continue };
        let mut m = addr_match(std::slice::from_ref(&orig), dst, &[]);
        if !reverse_static {
            m = m.and(zone_ok(&r.in_zone_if, zones_in)).and(addr_match(&list(&r.orig_src), src, &[])).and(svc_match(&list(&r.service), proto, port));
            if let Some(z) = zones_out {
                m = m.and(zone_ok(&r.out_zone_if, z));
            }
        }
        match m {
            Tri::No => continue,
            Tri::Unknown(why) => return Err(format!("NAT rule {} may translate the destination: {why}.", rule_name(r))),
            Tri::Yes => {
                let Some(now) = single(&trans) else {
                    return Err(format!("NAT rule {} translates the destination to {trans}, more than one address; which one this flow gets is the device's choice.", rule_name(r)));
                };
                return Ok(Some(Rewrite { rule: rule_name(r), kind: r.kind.clone(), field: "destination".into(), was: dst.to_string(), now: now.to_string() }));
            }
        }
    }
    Ok(None)
}

/// Source NAT on the way out. `egress_ip` is the address of the interface
/// it leaves by, which "interface" translation uses.
pub fn snat(b: &Box_, flow: &Flow, egress_ip: Option<Ipv4Addr>) -> Result<Option<Rewrite>, String> {
    let Flow { zones_in, zones_out, src, dst, proto, port, .. } = *flow;
    for r in &b.nat {
        if !nat_kind_is_src(r) || (r.kind.contains("static") && r.orig_dst.is_some()) {
            continue;
        }
        let Some(orig) = r.orig_src.clone() else { continue };
        let m = addr_match(&[orig], src, &[])
            .and(zone_ok(&r.in_zone_if, zones_in))
            .and(zone_ok(&r.out_zone_if, zones_out))
            .and(addr_match(&list(&r.orig_dst), dst, &[]))
            .and(svc_match(&list(&r.service), proto, port));
        match m {
            Tri::No => continue,
            Tri::Unknown(why) => return Err(format!("NAT rule {} may translate the source: {why}.", rule_name(r))),
            Tri::Yes => {
                let t = r.trans_src.clone().unwrap_or_default();
                let tl = t.trim().to_ascii_lowercase();
                let now = if tl.is_empty() || tl.contains("interface") || tl == "masquerade" || tl == "egress" {
                    match egress_ip {
                        Some(a) => a,
                        None => return Err(format!("NAT rule {} translates the source to the outgoing interface's address, which was not collected.", rule_name(r))),
                    }
                } else {
                    match single(&t) {
                        Some(a) => a,
                        None => return Err(format!("NAT rule {} translates the source to {t}, which the tables do not resolve to one address.", rule_name(r))),
                    }
                };
                return Ok(Some(Rewrite { rule: rule_name(r), kind: r.kind.clone(), field: "source".into(), was: src.to_string(), now: now.to_string() }));
            }
        }
    }
    Ok(None)
}

fn rule_name(r: &NatRule) -> String {
    if r.seq.is_empty() {
        "(unnamed)".into()
    } else {
        r.seq.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(s: &str) -> Ipv4Addr {
        s.parse().unwrap()
    }

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn addresses_in_every_form_and_an_unknown_object_is_unknown() {
        assert_eq!(addr_match(&v(&["all"]), a("192.0.2.1"), &[]), Tri::Yes);
        assert_eq!(addr_match(&v(&["192.0.2.0/24"]), a("192.0.2.1"), &[]), Tri::Yes);
        assert_eq!(addr_match(&v(&["192.0.2.0 255.255.255.0"]), a("192.0.2.1"), &[]), Tri::Yes);
        assert_eq!(addr_match(&v(&["host 192.0.2.1"]), a("192.0.2.1"), &[]), Tri::Yes);
        assert_eq!(addr_match(&v(&["192.0.2.1-192.0.2.9"]), a("192.0.2.5"), &[]), Tri::Yes);
        assert_eq!(addr_match(&v(&["198.51.100.0/24"]), a("192.0.2.1"), &[]), Tri::No);
        assert!(matches!(addr_match(&v(&["WEB-SERVERS"]), a("192.0.2.1"), &[]), Tri::Unknown(_)));
        assert_eq!(addr_match(&v(&["VIP-WEB"]), a("192.0.2.1"), &v(&["vip-web"])), Tri::Yes);
        // A definite match beats an unknown object in the same list.
        assert_eq!(addr_match(&v(&["WEB-SERVERS", "192.0.2.0/24"]), a("192.0.2.1"), &[]), Tri::Yes);
    }

    #[test]
    fn services_by_vendor_name_by_port_and_without_a_port() {
        assert_eq!(svc_match(&v(&["HTTPS"]), Some(6), Some(443)), Tri::Yes);
        assert_eq!(svc_match(&v(&["HTTPS"]), Some(6), Some(22)), Tri::No);
        assert_eq!(svc_match(&v(&["tcp/8443"]), Some(6), Some(8443)), Tri::Yes);
        assert_eq!(svc_match(&v(&["udp/53"]), Some(6), Some(53)), Tri::No);
        assert_eq!(svc_match(&v(&["ALL"]), None, None), Tri::Yes);
        assert_eq!(svc_match(&v(&["PING"]), Some(1), None), Tri::Yes);
        assert!(matches!(svc_match(&v(&["HTTPS"]), None, None), Tri::Unknown(_)));
        assert!(matches!(svc_match(&v(&["APP-CUSTOM"]), Some(6), Some(443)), Tri::Unknown(_)));
    }
}
