//! Which credential to try on which device (LT-199, LT-209).
//!
//! A crawl used to have one login, a second to fall back to, and a list of
//! SNMP credentials tried everywhere in the same order. An estate is rarely
//! that tidy: the core has its own account, the branch subnet another, the
//! FortiSwitches a third. Trying every credential everywhere is slow, and on an
//! account policy that locks after failures it does harm.
//!
//! So a credential can be *bound*: to one device, to a subnet, or to a vendor.
//! Before a device is dialled, the bindings that match it are tried first —
//! the device's own, then the narrowest subnet, then the vendor — and only then
//! the run's own credentials.
//!
//! **No secret crosses the interface.** The interface sends a binding as a
//! scope and a vault id; the Tauri side opens the vault and hands this module
//! credentials that never leave Rust.

use std::net::Ipv4Addr;

use coreview_probe::sweep::{parse_cidr, Cidr};

use crate::snmp::SnmpAuth;
use crate::ssh::Credentials;

/// What a binding applies to.
#[derive(Debug, Clone)]
pub enum Scope {
    /// One device, by address or by hostname (case-insensitive).
    Device(String),
    /// Every address in a subnet.
    Subnet(Cidr),
    /// Every device whose platform or vendor, as a neighbour reported it,
    /// contains this word (case-insensitive): `fortiswitch`, `aruba`.
    Vendor(String),
}

impl Scope {
    /// Reads the interface's words: `device`, `subnet` or `vendor`, and what to
    /// match. `None` for a scope it does not know or a subnet that does not
    /// parse — a binding nobody can match is dropped, not guessed at.
    pub fn parse(kind: &str, value: &str) -> Option<Scope> {
        let value = value.trim();
        if value.is_empty() {
            return None;
        }
        match kind {
            "device" => Some(Scope::Device(value.to_ascii_lowercase())),
            "subnet" => parse_cidr(value).ok().map(Scope::Subnet),
            "vendor" => Some(Scope::Vendor(value.to_ascii_lowercase())),
            _ => None,
        }
    }

    /// How specific a match is: a device beats a subnet, a longer prefix beats
    /// a shorter one, and any subnet beats a vendor.
    fn rank(&self) -> u32 {
        match self {
            Scope::Device(_) => 1_000,
            Scope::Subnet(c) => 100 + u32::from(c.prefix()),
            Scope::Vendor(_) => 10,
        }
    }
}

/// A credential for a scope. Holds one kind or the other.
#[derive(Debug, Clone)]
pub struct Binding {
    pub scope: Scope,
    pub ssh: Option<Credentials>,
    pub snmp: Option<SnmpAuth>,
}

/// What is known about a device before it is dialled.
#[derive(Debug, Default, Clone, Copy)]
pub struct Target<'a> {
    pub address: &'a str,
    /// The name a neighbour advertised it under.
    pub hostname: Option<&'a str>,
    /// A neighbour's platform string or the vendor from its MAC.
    pub platform: Option<&'a str>,
}

/// Whether `scope` covers `target`. Public so what a crawl offered each device
/// can be logged by the same rule that chose it (LT-264).
pub fn scope_matches(scope: &Scope, target: &Target<'_>) -> bool {
    matches(scope, target)
}

fn matches(scope: &Scope, target: &Target<'_>) -> bool {
    match scope {
        Scope::Device(name) => {
            target.address.eq_ignore_ascii_case(name)
                || target.hostname.is_some_and(|h| h.eq_ignore_ascii_case(name))
        }
        Scope::Subnet(cidr) => target.address.parse::<Ipv4Addr>().is_ok_and(|ip| cidr.contains(ip)),
        Scope::Vendor(word) => target.platform.is_some_and(|p| p.to_ascii_lowercase().contains(word.as_str())),
    }
}

/// The bindings that apply to a device, most specific first. Ties keep the
/// order the operator listed them in.
pub fn matching<'b>(bindings: &'b [Binding], target: &Target<'_>) -> Vec<&'b Binding> {
    let mut found: Vec<(usize, &Binding)> =
        bindings.iter().enumerate().filter(|(_, b)| matches(&b.scope, target)).collect();
    found.sort_by(|(ia, a), (ib, b)| b.scope.rank().cmp(&a.scope.rank()).then(ia.cmp(ib)));
    found.into_iter().map(|(_, b)| b).collect()
}

/// SSH logins to try on a device, in order: bound ones, then the run's own.
pub fn ssh_order<'a>(bindings: &'a [Binding], target: &Target<'_>, run: &'a [Credentials]) -> Vec<&'a Credentials> {
    let mut out: Vec<&Credentials> = matching(bindings, target).into_iter().filter_map(|b| b.ssh.as_ref()).collect();
    for c in run {
        if !out.iter().any(|o| o.username == c.username && o.password.expose() == c.password.expose()) {
            out.push(c);
        }
    }
    out
}

/// SNMP credentials to try on a device, in order: bound ones, then the run's.
pub fn snmp_order<'a>(bindings: &'a [Binding], target: &Target<'_>, run: &'a [SnmpAuth]) -> Vec<&'a SnmpAuth> {
    let mut out: Vec<&SnmpAuth> = matching(bindings, target).into_iter().filter_map(|b| b.snmp.as_ref()).collect();
    out.extend(run.iter());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::Secret;

    fn login(user: &str) -> Credentials {
        Credentials { username: user.into(), password: Secret::new("not-a-password"), enable_password: None }
    }
    fn bind(kind: &str, value: &str, user: &str) -> Binding {
        Binding { scope: Scope::parse(kind, value).unwrap(), ssh: Some(login(user)), snmp: None }
    }
    fn users(list: &[&Credentials]) -> Vec<String> {
        list.iter().map(|c| c.username.clone()).collect()
    }

    #[test]
    fn tries_the_most_specific_binding_first_then_the_run() {
        let bindings = vec![
            bind("vendor", "FortiSwitch", "forti"),
            bind("subnet", "192.0.2.0/24", "site"),
            bind("subnet", "192.0.2.128/25", "closet"),
            bind("device", "core-sw1", "core"),
        ];
        let run = vec![login("everyone")];
        let target = Target { address: "192.0.2.130", hostname: Some("CORE-SW1"), platform: Some("FortiSwitch-248E") };
        assert_eq!(users(&ssh_order(&bindings, &target, &run)), ["core", "closet", "site", "forti", "everyone"]);
    }

    #[test]
    fn a_binding_that_does_not_match_is_not_tried() {
        let bindings = vec![bind("subnet", "198.51.100.0/24", "other"), bind("vendor", "aruba", "aruba")];
        let run = vec![login("everyone")];
        let target = Target { address: "192.0.2.5", hostname: None, platform: Some("cisco WS-C2960CX") };
        assert_eq!(users(&ssh_order(&bindings, &target, &run)), ["everyone"]);
    }

    #[test]
    fn a_device_matches_by_address_as_well_as_name() {
        let bindings = vec![bind("device", "192.0.2.9", "by-address")];
        let target = Target { address: "192.0.2.9", ..Default::default() };
        assert_eq!(users(&ssh_order(&bindings, &target, &[])), ["by-address"]);
    }

    #[test]
    fn the_same_login_is_not_tried_twice() {
        let bindings = vec![bind("subnet", "192.0.2.0/24", "everyone")];
        let run = vec![login("everyone")];
        let target = Target { address: "192.0.2.5", ..Default::default() };
        assert_eq!(ssh_order(&bindings, &target, &run).len(), 1);
    }

    #[test]
    fn snmp_bindings_come_before_the_run_list() {
        let bindings = vec![Binding {
            scope: Scope::parse("subnet", "192.0.2.0/24").unwrap(),
            ssh: None,
            snmp: Some(SnmpAuth::V2c { community: "bound".into() }),
        }];
        let run = vec![SnmpAuth::V2c { community: "run".into() }];
        let target = Target { address: "192.0.2.5", ..Default::default() };
        let got: Vec<String> = snmp_order(&bindings, &target, &run)
            .iter()
            .map(|a| match a {
                SnmpAuth::V2c { community } => community.clone(),
                _ => String::new(),
            })
            .collect();
        assert_eq!(got, ["bound", "run"]);
    }

    #[test]
    fn unknown_or_malformed_scopes_are_dropped() {
        assert!(Scope::parse("building", "3").is_none());
        assert!(Scope::parse("subnet", "192.0.2.0").is_none());
        assert!(Scope::parse("device", "  ").is_none());
    }
}
