//! Which catalog a device belongs to: a generic session, each catalog's
//! fingerprint probe in turn, the first `match_regex` that matches wins.
//! Order matters — `show version` is answered by many platforms, so the
//! probes are tried grouped by command and every catalog with that probe
//! is checked against the one answer.

use coreview_catalog::Catalog;
use regex::Regex;

/// A recognised device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identified {
    pub os: String,
    /// The probe that answered, and its answer — the version text, kept for the role hint.
    pub probe: String,
    pub answer: String,
}

/// The distinct fingerprint probes across the catalogs, in the order they
/// should be tried: the commands most platforms answer first.
pub fn probes(catalogs: &[Catalog]) -> Vec<String> {
    let preferred = ["show version", "get system status", "show system info", "show sysinfo", "display version", "show system", "/system resource print"];
    let mut out: Vec<String> = Vec::new();
    for p in preferred {
        if catalogs.iter().any(|c| c.fingerprint.as_ref().map(|f| f.probe == p).unwrap_or(false)) {
            out.push(p.to_string());
        }
    }
    for c in catalogs {
        if let Some(f) = &c.fingerprint {
            if !out.contains(&f.probe) {
                out.push(f.probe.clone());
            }
        }
    }
    out
}

/// Match one probe's answer against every catalog that uses that probe.
/// Phase-1 catalogs are preferred over stubs when both match.
pub fn identify(catalogs: &[Catalog], probe: &str, answer: &str) -> Option<Identified> {
    let mut hits: Vec<&Catalog> = catalogs
        .iter()
        .filter(|c| c.fingerprint.as_ref().map(|f| f.probe == probe).unwrap_or(false))
        .filter(|c| {
            let re = c.fingerprint.as_ref().map(|f| f.match_regex.clone()).unwrap_or_default();
            Regex::new(&format!("(?m){re}")).map(|r| r.is_match(answer)).unwrap_or(false)
        })
        .collect();
    hits.sort_by_key(|c| c.phase);
    hits.first().map(|c| Identified { os: c.os.clone(), probe: probe.to_string(), answer: answer.to_string() })
}

/// Does an answer look like a refusal rather than a version? A device that
/// does not know `show version` says so; that is not a fingerprint.
pub fn is_refusal(answer: &str) -> bool {
    let a = answer.trim();
    a.is_empty()
        || a.starts_with('%')
        || a.contains("Invalid input")
        || a.contains("Unknown command")
        || a.contains("Unrecognized command")
        || a.contains("command not found")
        || a.contains("Unknown action")
        || a.contains("syntax error")
        || a.contains("Invalid syntax")
        || a.contains("bad command name")
        || a.contains("Incorrect Usage")
}

#[cfg(test)]
mod tests {
    use super::*;
    use coreview_catalog::load_dir;

    fn catalogs() -> Vec<Catalog> {
        load_dir(std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../resources/catalog"))).unwrap()
    }

    #[test]
    fn show_version_answers_are_told_apart() {
        let c = catalogs();
        assert_eq!(identify(&c, "show version", "Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E").unwrap().os, "cisco_ios");
        assert_eq!(identify(&c, "show version", "Cisco IOS XE Software, Version 17.09.04a").unwrap().os, "cisco_ios");
        assert_eq!(identify(&c, "show version", "Cisco Nexus Operating System (NX-OS) Software").unwrap().os, "cisco_nxos");
        assert_eq!(identify(&c, "show version", "Cisco IOS XR Software, Version 7.5.2").unwrap().os, "cisco_iosxr");
        assert_eq!(identify(&c, "show version", "Arista DCS-7050SX3-48YC8-F\nHardware version").unwrap().os, "arista_eos");
        assert_eq!(identify(&c, "show version", "Hostname: r1\nModel: mx204\nJunos: 21.4R3").unwrap().os, "juniper_junos");
        assert_eq!(identify(&c, "show version", "ArubaOS-CX\n(c) Copyright").unwrap().os, "aoscx");
        assert_eq!(identify(&c, "show version", "Cisco Adaptive Security Appliance Software Version 9.16(4)").unwrap().os, "cisco_asa");
        assert!(identify(&c, "show version", "% Invalid input detected at '^' marker.").is_none());
    }

    #[test]
    fn the_other_probes() {
        let c = catalogs();
        assert_eq!(identify(&c, "get system status", "Version: FortiGate-60F v7.2.8,build1639,240208 (GA.M)").unwrap().os, "fortios");
        // LT-565: a FortiSwitch is its own OS, not a FortiGate.
        assert_eq!(identify(&c, "get system status", "Version: FortiSwitch-124E v7.2.5").unwrap().os, "fortiswitch");
        assert_eq!(identify(&c, "show system info", "hostname: fw1\nmodel: PA-440\nsw-version: 10.2.4").unwrap().os, "panos");
        assert_eq!(identify(&c, "show sysinfo", "Product Name..................................... Cisco Controller").unwrap().os, "cisco_wlc_aireos");
        assert_eq!(identify(&c, "show system", " Status and Counters - General System Information\n\n  Software revision  : WC.16.11.0012").unwrap().os, "aoss");
    }

    /// LT-550: the hosts, each by its own probe; a switch's `show version`
    /// is tried first, and a host's probe never claims a network device.
    #[test]
    fn hosts_esxi_and_windows_are_recognised_by_their_probes() {
        let c = catalogs();
        let p = probes(&c);
        let at = |x: &str| p.iter().position(|q| q == x).unwrap_or_else(|| panic!("{x} not probed: {p:?}"));
        assert!(at("show version") < at("ip -j link"));
        assert_eq!(identify(&c, "ip -j link", r#"[{"ifindex":1,"ifname":"lo"}]"#).map(|i| i.os), Some("hosts".into()));
        assert_eq!(identify(&c, "esxcli --formatter=json system version get", r#"{"Build":"Releasebuild-0","Product":"VMware ESXi","Version":"8.0.2"}"#).map(|i| i.os), Some("esxi".into()));
        assert_eq!(identify(&c, "Get-NetAdapter | ConvertTo-Json", r#"[{"Name":"Ethernet0","InterfaceDescription":"Fake Adapter"}]"#).map(|i| i.os), Some("windows".into()));
        assert_eq!(identify(&c, "ip -j link", "% Invalid input detected at '^' marker."), None);
    }

    #[test]
    fn probes_are_tried_common_first() {
        let p = probes(&catalogs());
        assert_eq!(p[0], "show version");
        assert!(p.contains(&"get system status".to_string()));
        assert!(is_refusal("% Invalid input detected"));
        assert!(!is_refusal("Cisco IOS Software"));
    }
}
