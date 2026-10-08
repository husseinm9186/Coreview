//! What a device can do: the role hint from the version text, the role's
//! default flags, then every `caps_probe` answer run through its flag
//! regexes. The probe wins over the hint — a switch that answers `show ip
//! protocols` with OSPF is routing whatever its model number says.

use coreview_catalog::{Catalog, Facts};
use fancy_regex::Regex;

/// The role the model regexes suggest, or `unknown`.
pub fn role_hint(catalog: &Catalog, version_text: &str) -> String {
    for hint in &catalog.role_hint {
        if Regex::new(&format!("(?m){}", hint.match_regex)).map(|r| r.is_match(version_text).unwrap_or(false)).unwrap_or(false) {
            return hint.role.clone();
        }
    }
    "unknown".to_string()
}

/// Start from the role and its defaults, before any probe has answered.
pub fn initial_facts(catalog: &Catalog, version_text: &str, role_override: Option<&str>) -> Facts {
    let role = role_override.map(str::to_string).unwrap_or_else(|| role_hint(catalog, version_text));
    let mut facts = Facts::default().role(&role);
    if let Some(defaults) = catalog.role_defaults.get(&role) {
        for f in defaults {
            facts.caps.insert(f.clone());
        }
    }
    if catalog.structured_output.is_some() {
        facts.caps.insert("structured_output".into());
    }
    facts
}

/// Apply one probe's answer: every flag whose regex matches is set.
/// Returns the flags this answer set, for the run log.
pub fn apply_probe(catalog: &Catalog, probe_id: &str, answer: &str, facts: &mut Facts) -> Vec<String> {
    let mut set = Vec::new();
    let Some(probe) = catalog.caps_probe.iter().find(|p| p.id == probe_id) else { return set };
    for (flag, re) in &probe.flags {
        let matched = Regex::new(&format!("(?m){re}")).map(|r| r.is_match(answer).unwrap_or(false)).unwrap_or(false);
        if matched && facts.caps.insert(flag.clone()) {
            set.push(flag.clone());
        }
    }
    set
}

#[cfg(test)]
mod tests {
    /// A real 6200 on 10.18 names no model in `show
    /// version`; it is a switch, and gets a switch's default flags.
    #[test]
    fn an_aos_cx_banner_without_a_model_is_a_switch() {
        let catalogs = coreview_catalog::load_dir(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/catalog")).unwrap();
        let cx = catalogs.iter().find(|c| c.os == "aoscx").unwrap();
        let banner = "AOS-CX\n(c) Copyright 2017-2026 Hewlett Packard Enterprise Development LP\nVersion      : ML.10.18.1002\n";
        assert_eq!(role_hint(cx, banner), "switch");
        assert!(initial_facts(cx, banner, None).caps.contains("switching"));
    }

    use super::*;
    use coreview_catalog::load_dir;

    fn catalog(os: &str) -> Catalog {
        load_dir(std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../resources/catalog"))).unwrap().into_iter().find(|c| c.os == os).unwrap()
    }

    #[test]
    fn a_catalyst_is_a_switch_and_a_router_answer_makes_it_route() {
        let c = catalog("cisco_ios");
        let mut facts = initial_facts(&c, "Cisco IOS Software, C2960X Software\ncisco WS-C2960X-24TS-L (APM86XXX) processor", None);
        assert_eq!(facts.role.as_deref(), Some("switch"));
        assert!(facts.caps.contains("switching") && facts.caps.contains("cdp"));
        assert!(!facts.caps.contains("ospf"));
        let set = apply_probe(&c, "show_ip_protocols", "Routing Protocol is \"ospf 1\"\n  Outgoing update filter list", &mut facts);
        assert_eq!(set, vec!["ospf", "routing"]);
        assert!(facts.caps.contains("routing"));
    }

    #[test]
    fn the_nexus_feature_table_sets_flags_by_line() {
        let c = catalog("cisco_nxos");
        let mut facts = initial_facts(&c, "cisco Nexus9000 C93180YC-EX chassis", None);
        let answer = "Feature Name          Instance  State\n--------------------  --------  --------\nbgp                   1         enabled\nhsrp_engine           1         enabled\nlacp                  1         enabled\nospf                  1         disabled\nvpc                   1         enabled\nnv overlay            1         enabled\n";
        let set = apply_probe(&c, "show_feature", answer, &mut facts);
        for f in ["bgp", "fhrp", "vpc", "vpc_mlag_vsx", "vxlan_evpn", "routing"] {
            assert!(set.contains(&f.to_string()), "{f} in {set:?}");
        }
        assert!(!facts.caps.contains("ospf"));
    }

    #[test]
    fn a_fortigate_with_vdoms_and_the_operator_override() {
        let c = catalog("fortios");
        let mut facts = initial_facts(&c, "Version: FortiGate-60F v7.2.8", Some("router"));
        assert_eq!(facts.role.as_deref(), Some("router"));
        let set = apply_probe(&c, "get_system_status", "Virtual domain configuration: multiple\nCurrent HA mode: a-p, primary", &mut facts);
        assert_eq!(set, vec!["ha", "vdom"]);
    }
}
