//! Which VRFs a device has, and each one's routing table (LT-347).
//!
//! **These parsers were written from vendor documentation, not from captured
//! device output.** That inverts this project's standing rule (`CLAUDE.md`),
//! deliberately and at the operator's instruction — the same exception D-026
//! made for stacking, extended by **D-051**. He has no multi-VRF device to
//! hand and asked for it to be built so that he can test it when he does.
//!
//! So every parser here is a **hypothesis** until it has met hardware.
//! `verified_against_hardware` says which have, and
//! `examples/probe_overlay.rs` is how that gets earned.
//!
//! # Why this exists at all
//!
//! A VRF is a separate routing table on the same box. Two tenants can hold the
//! same prefix and mean different networks, and traffic in one cannot reach the
//! other. Coreview's path engine (LT-346) enforces that isolation — it answers
//! a VRF from that VRF's table or refuses — but until now nothing filled those
//! tables in, so every VRF question was refused. This fills them.
//!
//! The global table is collected by `routes.rs` and is untouched by this.

use crate::routes::{parse_routes, Route};

/// Which command set a device answers to.
///
/// Not a guess about the vendor: the caller already knows the platform from
/// `get system status` or the prompt, and the wrong command set is answered
/// with a parse error rather than silence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VrfDialect {
    /// IOS, IOS-XE, NX-OS: `show vrf`, then `show ip route vrf <name>`.
    Cisco,
    /// FortiOS with VDOMs: `get router info routing-table all` inside a VDOM.
    FortiOs,
    /// Junos: `show route instance`, then `show route table <name>.inet.0`.
    Junos,
    /// Arista EOS: `show vrf`, then `show ip route vrf <name>`.
    Arista,
}

impl VrfDialect {
    /// Whether any parser for this dialect has been run against real hardware.
    ///
    /// **The honest field**, the same one stacking carries. D-051 allowed
    /// these to be written from documentation; this is how a reader tells a
    /// proven parser from a plausible one. Flip a value only after seeing it
    /// work on a device, and name the device in the commit.
    pub fn verified_against_hardware(&self) -> bool {
        match self {
            // Nothing yet. The lab has a 2960CX with no VRFs, a FortiGate with
            // one VDOM and a FortiSwitch, so none of these has been answered
            // by a device that actually has more than one table.
            VrfDialect::Cisco | VrfDialect::FortiOs | VrfDialect::Junos | VrfDialect::Arista => false,
        }
    }

    /// The command that lists the VRFs.
    pub fn list_command(&self) -> &'static str {
        match self {
            VrfDialect::Cisco | VrfDialect::Arista => "show vrf",
            VrfDialect::FortiOs => "get system vdom-property",
            VrfDialect::Junos => "show route instance",
        }
    }

    /// The command that reads one VRF's table.
    pub fn table_command(&self, vrf: &str) -> String {
        match self {
            VrfDialect::Cisco | VrfDialect::Arista => format!("show ip route vrf {vrf}"),
            // A VDOM is entered rather than named on the command; the caller
            // does that, and then asks for the whole table.
            VrfDialect::FortiOs => "get router info routing-table all".to_string(),
            VrfDialect::Junos => format!("show route table {vrf}.inet.0"),
        }
    }
}

/// Which dialect a device's version banner says it speaks.
///
/// The banner is what every other platform decision here is made from, so this
/// makes the same one rather than inventing a second way to tell platforms
/// apart.
pub fn dialect_for(version: &str) -> VrfDialect {
    let v = version.to_ascii_lowercase();
    if v.contains("fortigate") || v.contains("fortiswitch") || v.contains("fortios") {
        VrfDialect::FortiOs
    } else if v.contains("junos") {
        VrfDialect::Junos
    } else if v.contains("arista") || v.contains(" eos") {
        VrfDialect::Arista
    } else {
        VrfDialect::Cisco
    }
}

/// One VRF, and what it is called.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vrf {
    /// As the device writes it.
    pub name: String,
    /// The route distinguisher, where the device printed one.
    pub route_distinguisher: Option<String>,
    /// Interfaces assigned to it, where the listing gave them.
    pub interfaces: Vec<String>,
}

/// Names that are the global table wearing a different hat.
///
/// Asking for "the VRF called default" and getting the global table back is
/// correct; treating it as a *separate* table would make the path engine
/// refuse a question it can answer.
pub fn is_global(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "" | "default" | "global" | "master" | "inet.0" | "root"
    )
}

/// Reads the VRF list.
///
/// **Shape, from the vendor guides** (D-051):
///
/// ```text
/// Cisco IOS-XE / NX-OS / Arista EOS — `show vrf`
///   Name                             Default RD          Protocols   Interfaces
///   CORP                             65000:100           ipv4        Gi0/1.100
///                                                                    Gi0/2.100
///   MGMT                             <not set>           ipv4        Gi0/0
///
/// Junos — `show route instance`
///   Instance             Type         Primary RIB     Active/holddown/hidden
///   CORP                 vrf          CORP.inet.0     12/0/0
/// ```
///
/// A continuation line — more interfaces for the VRF above — starts with
/// whitespace and has no name in the first column, which is how a
/// multi-interface VRF loses its interfaces to a naive line-per-row parser.
pub fn parse_vrf_list(out: &str, dialect: VrfDialect) -> Vec<Vrf> {
    let mut found: Vec<Vrf> = Vec::new();
    let mut started = false;
    // How far the rows themselves are indented. `show vrf` indents every data
    // row by a couple of spaces, so "starts with whitespace" is not what marks
    // a continuation — being indented *further than the row above* is.
    let mut row_indent: Option<usize> = None;

    for line in out.lines() {
        let raw = line.trim_end();
        if raw.trim().is_empty() {
            continue;
        }
        let lower = raw.to_ascii_lowercase();

        // The heading, whichever dialect printed it.
        if !started
            && ((lower.contains("name") && (lower.contains("rd") || lower.contains("interfaces")))
                || (lower.contains("instance") && lower.contains("type")))
        {
            started = true;
            continue;
        }
        if lower.starts_with("---") || lower.starts_with("===") {
            continue;
        }
        // Nothing is a row until the heading has been seen. A device that does
        // not know the command answers "% Invalid input detected", and reading
        // that as a VRF called `%` is exactly the silent nonsense a
        // documentation-built parser is prone to (D-051).
        if !started {
            continue;
        }

        let indent = raw.len() - raw.trim_start().len();
        // A continuation: indented past the rows, and the row above owns it.
        if row_indent.is_some_and(|base| indent > base) {
            if let Some(last) = found.last_mut() {
                for token in raw.split_whitespace() {
                    if looks_like_interface(token) {
                        last.interfaces.push(token.to_string());
                    }
                }
            }
            continue;
        }

        let mut fields = raw.split_whitespace();
        let Some(name) = fields.next() else { continue };
        row_indent = Some(indent);
        if is_global(name) {
            continue;
        }
        // Junos prints the instance type in the second column; anything that
        // is not a VRF is not a VRF.
        if dialect == VrfDialect::Junos {
            let kind = fields.next().unwrap_or("");
            if !kind.eq_ignore_ascii_case("vrf") && !kind.eq_ignore_ascii_case("virtual-router") {
                continue;
            }
        }
        let rest: Vec<&str> = fields.collect();
        let rd = rest
            .iter()
            .find(|t| looks_like_rd(t))
            .map(|t| t.to_string());
        let interfaces = rest
            .iter()
            .filter(|t| looks_like_interface(t))
            .map(|t| t.to_string())
            .collect();
        found.push(Vrf { name: name.to_string(), route_distinguisher: rd, interfaces });
    }
    found
}

/// `65000:100` or `10.255.0.1:100` — a route distinguisher, not a metric.
fn looks_like_rd(token: &str) -> bool {
    let Some((left, right)) = token.split_once(':') else { return false };
    !left.is_empty()
        && !right.is_empty()
        && right.chars().all(|c| c.is_ascii_digit())
        && left.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// A port name rather than a protocol word or a count.
fn looks_like_interface(token: &str) -> bool {
    let t = token.trim();
    if t.len() < 3 || looks_like_rd(t) {
        return false;
    }
    // Starts with a letter and contains a digit: `Gi0/1.100`, `Eth1/4`,
    // `Vlan100`, `port3`. Excludes `ipv4`, `up`, `<not`, `12/0/0`.
    let first = t.chars().next().unwrap_or(' ');
    first.is_ascii_alphabetic()
        && t.chars().any(|c| c.is_ascii_digit())
        && !t.eq_ignore_ascii_case("ipv4")
        && !t.eq_ignore_ascii_case("ipv6")
}

/// One VRF's routing table.
///
/// The table itself is the ordinary routing-table format — the same one
/// `routes.rs` already parses against real captured output — so this reuses
/// that parser rather than writing a second one. Only the *listing* of VRFs
/// and the commands are new, which keeps the documentation-built surface as
/// small as it can be.
pub fn parse_vrf_table(out: &str) -> Vec<Route> {
    parse_routes(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **Documentation-shaped, not captured** (D-051). From Cisco's IOS-XE and
    /// Arista EOS command references for `show vrf`.
    const CISCO: &str = r#"
  Name                             Default RD          Protocols   Interfaces
  CORP                             65000:100           ipv4        Gi0/1.100
                                                                   Gi0/2.100
  MGMT                             <not set>           ipv4        Gi0/0
"#;

    /// **Documentation-shaped, not captured.** From Juniper's `show route
    /// instance` reference.
    const JUNOS: &str = r#"
Instance             Type         Primary RIB       Active/holddown/hidden
master               forwarding   inet.0            22/0/0
CORP                 vrf          CORP.inet.0       12/0/0
GUEST                vrf          GUEST.inet.0      3/0/0
"#;

    #[test]
    fn reads_the_vrfs_and_leaves_the_global_table_out() {
        let v = parse_vrf_list(CISCO, VrfDialect::Cisco);
        assert_eq!(v.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["CORP", "MGMT"]);
    }

    #[test]
    fn keeps_the_interfaces_that_are_on_a_continuation_line() {
        // A VRF with several interfaces prints them one per line under the
        // first, with nothing in the name column. A line-per-row parser loses
        // every one but the first.
        let v = parse_vrf_list(CISCO, VrfDialect::Cisco);
        let corp = v.iter().find(|x| x.name == "CORP").unwrap();
        assert_eq!(corp.interfaces, ["Gi0/1.100", "Gi0/2.100"]);
        assert_eq!(corp.route_distinguisher.as_deref(), Some("65000:100"));
    }

    #[test]
    fn a_vrf_with_no_route_distinguisher_still_reads() {
        let v = parse_vrf_list(CISCO, VrfDialect::Cisco);
        let mgmt = v.iter().find(|x| x.name == "MGMT").unwrap();
        assert_eq!(mgmt.route_distinguisher, None);
        assert_eq!(mgmt.interfaces, ["Gi0/0"]);
    }

    #[test]
    fn junos_keeps_the_vrfs_and_drops_everything_else() {
        // `master` is the global table and `forwarding` is not a VRF at all.
        let v = parse_vrf_list(JUNOS, VrfDialect::Junos);
        assert_eq!(v.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["CORP", "GUEST"]);
    }

    #[test]
    fn the_global_table_is_recognised_by_every_name_it_goes_by() {
        for name in ["default", "Global", "master", "root", "", "  "] {
            assert!(is_global(name), "{name:?}");
        }
        assert!(!is_global("CORP"));
    }

    #[test]
    fn nothing_at_all_is_no_vrfs_rather_than_a_panic() {
        assert!(parse_vrf_list("", VrfDialect::Cisco).is_empty());
        assert!(parse_vrf_list("% Invalid input detected at '^' marker.", VrfDialect::Cisco).is_empty());
    }

    #[test]
    fn the_commands_name_the_vrf_the_way_each_platform_wants() {
        assert_eq!(VrfDialect::Cisco.table_command("CORP"), "show ip route vrf CORP");
        assert_eq!(VrfDialect::Junos.table_command("CORP"), "show route table CORP.inet.0");
        // FortiOS enters the VDOM instead of naming it on the command.
        assert_eq!(VrfDialect::FortiOs.table_command("CORP"), "get router info routing-table all");
    }

    #[test]
    fn every_dialect_is_still_a_hypothesis() {
        // This is the honest field. When one of these has answered on real
        // hardware, flip it there and name the device in the commit — not
        // here, and not because the tests pass.
        for d in [VrfDialect::Cisco, VrfDialect::FortiOs, VrfDialect::Junos, VrfDialect::Arista] {
            assert!(!d.verified_against_hardware(), "{d:?} claims hardware it has not met");
        }
    }
}
