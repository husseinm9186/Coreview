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
            // A Nexus leaf with six VRFs answered `show vrf` and
            // `show ip route vrf <name>` on 2026-09-20, and read nothing at
            // all until this was fixed for it. **NX-OS only** — the same
            // arm covers IOS-XE, whose `show vrf` is a different table with
            // different columns and has still not been seen.
            VrfDialect::Cisco => true,
            VrfDialect::FortiOs | VrfDialect::Junos | VrfDialect::Arista => false,
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

    /// One command that reads **every** VRF's table, where the platform has
    /// one (LT-351).
    ///
    /// A Nexus with six VRFs is six round trips the slow way and one this
    /// way, and the operator's own capture is what showed the shape: the
    /// device prints a `IP Route Table for VRF "<name>"` header and then that
    /// VRF's routes, over and over, **including the empty ones** — which is
    /// worth having, because a VRF that exists and holds nothing is a
    /// different answer from a VRF nobody collected.
    ///
    /// `None` where a platform has no such command: a FortiOS VDOM is entered
    /// rather than named, so its tables are read one VDOM at a time.
    pub fn all_command(&self) -> Option<&'static str> {
        match self {
            VrfDialect::Cisco | VrfDialect::Arista => Some("show ip route vrf all"),
            // Junos prints every instance's table without being asked twice.
            VrfDialect::Junos => Some("show route"),
            VrfDialect::FortiOs => None,
        }
    }

    /// Whether a VRF's table can be read by naming it on one command
    /// (LT-352).
    ///
    /// **False for FortiOS, and that is not a gap in the parser.** A VDOM is
    /// *entered* — `config vdom`, `edit CORP`, then the command, then `end` —
    /// so there is no single line that reads one VDOM's table from outside
    /// it. The crawl lists the VDOMs and leaves their tables uncollected,
    /// which the path engine reports as "no table held for that VRF" rather
    /// than as an empty one. Answering an empty table for a VDOM full of
    /// routes would be the worse kind of wrong (D-050).
    pub fn reads_tables_by_name(&self) -> bool {
        !matches!(self, VrfDialect::FortiOs)
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
/// Cisco IOS-XE / Arista EOS — `show vrf`
///   Name                             Default RD          Protocols   Interfaces
///   CORP                             65000:100           ipv4        Gi0/1.100
///                                                                    Gi0/2.100
///   MGMT                             <not set>           ipv4        Gi0/0
///
/// Cisco NX-OS — `show vrf` (captured, 2026-09-20). A different table with a
/// different heading and no RD or interface columns at all, which is why
/// "Name plus RD or Interfaces" read nothing on a Nexus:
///   VRF-Name                           VRF-ID State   Reason
///   CORP                                    6 Up      --
///   default                                 1 Up      --
///   management                              2 Up      --
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
    // FortiOS does not print a table: a VDOM is a configuration block, and
    // its name is the only thing in the listing worth having (LT-352).
    if dialect == VrfDialect::FortiOs {
        return parse_vdom_list(out);
    }
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
            && (lower.contains("vrf-name")
                // Arista heads the same table `Vrf  RD  Protocols  State
                // Interfaces` — no "Name" column at all, which is the second
                // platform in a row that heading rule read as no VRFs.
                || (lower.starts_with("vrf") && lower.contains("protocols"))
                || (lower.contains("name") && (lower.contains("rd") || lower.contains("interfaces")))
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

/// The VDOMs a FortiGate has (LT-352).
///
/// **Built from Fortinet's documentation, not from captured output** (D-051).
/// A VDOM is the FortiOS answer to a VRF — a separate routing table, its own
/// interfaces, its own policy — and it is listed as configuration rather than
/// as a table:
///
/// ```text
/// == [ root ]
/// name: root
/// == [ CORP ]
/// name: CORP
/// ```
///
/// `show system vdom` writes the same thing as `edit "CORP"`, and both are
/// read, because which command an account may run varies.
pub fn parse_vdom_list(out: &str) -> Vec<Vrf> {
    let mut found: Vec<Vrf> = Vec::new();
    let mut add = |name: &str| {
        let name = name.trim().trim_matches('"').trim();
        if name.is_empty() || is_global(name) || found.iter().any(|v: &Vrf| v.name == name) {
            return;
        }
        found.push(Vrf { name: name.to_string(), route_distinguisher: None, interfaces: Vec::new() });
    };
    for line in out.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("== [") {
            if let Some(end) = rest.find(']') {
                add(&rest[..end]);
            }
        } else if let Some(rest) = t.strip_prefix("edit ") {
            add(rest);
        }
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
    // Arista's Protocols and State columns are `ipv4,ipv6` and `v4:routing`,
    // which start with a letter and contain a digit and are not ports. No
    // interface name has a comma or a colon in it (LT-352).
    if t.contains(',') || t.contains(':') {
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

/// Every VRF's table out of one answer (LT-351).
///
/// **Captured shape**, from a Nexus leaf answering `show ip route vrf all`:
///
/// ```text
/// IP Route Table for VRF "default"
/// '*' denotes best ucast next-hop
///
/// 192.0.2.0/31, ubest/mbest: 1/0
///     *via 192.0.2.2, Eth1/54, [110/42], 1y29w, ospf-FABRIC, intra
///
/// IP Route Table for VRF "CORP"
/// '*' denotes best ucast next-hop
///
/// ```
///
/// The last block there is a VRF that exists and holds no routes, and it
/// comes back as an **empty entry rather than a missing one** — "that VRF has
/// no route to this address" and "nobody collected that VRF" are different
/// answers and the path engine gives different ones (D-050).
///
/// IOS-XE writes `Routing Table: VRF <name>` and Arista `VRF: <name>` for the
/// same thing; both are recognised, neither has been seen on hardware.
pub fn parse_vrf_tables(out: &str) -> std::collections::BTreeMap<String, Vec<Route>> {
    let mut tables: std::collections::BTreeMap<String, Vec<Route>> = Default::default();
    let mut current: Option<String> = None;
    let mut body = String::new();

    let flush = |tables: &mut std::collections::BTreeMap<String, Vec<Route>>,
                 name: &Option<String>,
                 body: &str| {
        if let Some(name) = name {
            tables.insert(name.clone(), parse_routes(body));
        }
    };

    for line in out.lines() {
        if let Some(name) = table_header(line) {
            flush(&mut tables, &current, &body);
            current = Some(name);
            body.clear();
            continue;
        }
        if current.is_some() {
            body.push_str(line);
            body.push('\n');
        }
    }
    flush(&mut tables, &current, &body);
    tables
}

/// `IP Route Table for VRF "CORP"` → `CORP`, whichever way the platform
/// writes it.
fn table_header(line: &str) -> Option<String> {
    let t = line.trim();
    let rest = t
        .strip_prefix("IP Route Table for VRF")
        .or_else(|| t.strip_prefix("IPv6 Route Table for VRF"))
        .or_else(|| t.strip_prefix("Routing Table: VRF"))
        .or_else(|| t.strip_prefix("VRF:"))?;
    let name = rest.trim().trim_matches('"').trim();
    if name.is_empty() {
        return None;
    }
    Some(name.to_string())
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
    fn only_the_dialect_a_device_answered_claims_hardware() {
        // A Nexus leaf with six VRFs, 2026-09-20. The rest are hypotheses.
        assert!(VrfDialect::Cisco.verified_against_hardware());
        for d in [VrfDialect::FortiOs, VrfDialect::Junos, VrfDialect::Arista] {
            assert!(!d.verified_against_hardware(), "{d:?} claims hardware it has not met");
        }
    }

    /// **The shape a Nexus leaf printed** on 2026-09-20, retyped with
    /// invented VRF names (D-027). Nothing like the IOS-XE table above: a
    /// different heading, and no route distinguisher or interface columns at
    /// all. "Name, plus RD or Interfaces" was the heading rule, so a Nexus
    /// read as zero VRFs and every VRF question the path engine could have
    /// answered was refused.
    const NXOS: &str = r#"
VRF-Name                           VRF-ID State   Reason
CORP                                    4 Up      --
GUEST                                   5 Up      --
default                                 1 Up      --
egress-loadbalance-resolution-          3 Up      --
management                              2 Up      --
"#;

    #[test]
    fn reads_the_nexus_table_that_has_no_rd_column() {
        let v = parse_vrf_list(NXOS, VrfDialect::Cisco);
        assert_eq!(
            v.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(),
            ["CORP", "GUEST", "egress-loadbalance-resolution-", "management"]
        );
        assert_eq!(v[0].route_distinguisher, None);
        assert!(v[0].interfaces.is_empty());
    }

    #[test]
    fn a_name_the_device_truncated_is_kept_as_the_device_wrote_it() {
        // NX-OS cuts a VRF name at thirty characters in this table. Guessing
        // the rest would put a name on a diagram that no command will match.
        let v = parse_vrf_list(NXOS, VrfDialect::Cisco);
        assert!(v.iter().any(|x| x.name == "egress-loadbalance-resolution-"));
    }

    /// **From Arista's `show vrf` documentation, not captured** (D-051). A
    /// third heading in a row with no "Name" column.
    const ARISTA: &str = "\
   Vrf          RD            Protocols      State                  Interfaces\n\
   ------------ ------------- -------------- ---------------------- ----------\n\
   CORP         65000:100     ipv4,ipv6      v4:routing, v6:routing Ethernet1\n\
   GUEST        65000:200     ipv4           v4:routing             Vlan200\n";

    #[test]
    fn reads_the_arista_table_that_heads_its_first_column_vrf() {
        let v = parse_vrf_list(ARISTA, VrfDialect::Arista);
        assert_eq!(v.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["CORP", "GUEST"]);
        assert_eq!(v[0].route_distinguisher.as_deref(), Some("65000:100"));
        assert_eq!(v[0].interfaces, ["Ethernet1"]);
    }

    /// **From Fortinet's documentation, not captured** (D-051).
    const VDOMS: &str = "\
== [ root ]\n\
name: root\n\
== [ CORP ]\n\
name: CORP\n\
== [ GUEST ]\n\
name: GUEST\n";

    #[test]
    fn a_vdom_listing_is_configuration_rather_than_a_table() {
        let v = parse_vrf_list(VDOMS, VrfDialect::FortiOs);
        // `root` is FortiOS's global table and is left out the same way
        // `default` is on a Nexus.
        assert_eq!(v.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["CORP", "GUEST"]);
    }

    #[test]
    fn the_other_spelling_of_a_vdom_listing_reads_the_same() {
        let v = parse_vrf_list("config vdom\n    edit \"CORP\"\n    next\n    edit \"root\"\nend\n", VrfDialect::FortiOs);
        assert_eq!(v.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["CORP"]);
    }

    /// **The shape a Nexus printed** for `show ip route vrf all` on
    /// 2026-09-20, retyped (D-027). One command, every table, the empty ones
    /// included.
    const ALL: &str = "\
IP Route Table for VRF \"default\"\n\
'*' denotes best ucast next-hop\n\
\n\
192.0.2.0/31, ubest/mbest: 1/0\n\
    *via 192.0.2.2, Eth1/54, [110/42], 1y29w, ospf-FABRIC, intra\n\
\n\
IP Route Table for VRF \"management\"\n\
'*' denotes best ucast next-hop\n\
\n\
0.0.0.0/0, ubest/mbest: 1/0\n\
    *via 198.51.100.1, [1/0], 3w1d, static\n\
\n\
IP Route Table for VRF \"CORP\"\n\
'*' denotes best ucast next-hop\n\
\n\
203.0.113.0/24, ubest/mbest: 1/0, attached\n\
    *via 203.0.113.1, Vlan113, [0/0], 1y29w, direct\n\
\n\
IP Route Table for VRF \"GUEST\"\n\
'*' denotes best ucast next-hop\n\
\n";

    #[test]
    fn one_command_reads_every_vrfs_table() {
        let tables = parse_vrf_tables(ALL);
        assert_eq!(
            tables.keys().map(String::as_str).collect::<Vec<_>>(),
            ["CORP", "GUEST", "default", "management"]
        );
        assert_eq!(tables["CORP"].len(), 1);
        assert_eq!(tables["CORP"][0].protocol, "connected");
    }

    #[test]
    fn a_vrf_that_holds_nothing_comes_back_empty_rather_than_missing() {
        // "that VRF has no route to this" and "nobody collected that VRF"
        // are different answers, and the path engine gives different ones.
        let tables = parse_vrf_tables(ALL);
        assert_eq!(tables.get("GUEST").map(Vec::len), Some(0));
        assert_eq!(tables.get("NOSUCH"), None);
    }

    #[test]
    fn a_management_vrf_route_with_no_interface_still_reads() {
        let tables = parse_vrf_tables(ALL);
        let mgmt = &tables["management"][0];
        assert!(mgmt.is_default());
        assert_eq!(mgmt.protocol, "static");
        assert_eq!(mgmt.next_hops, ["198.51.100.1"]);
        assert_eq!(mgmt.interface, None);
    }

    #[test]
    fn nothing_at_all_is_no_tables_rather_than_one_called_nothing() {
        assert!(parse_vrf_tables("").is_empty());
        assert!(parse_vrf_tables("% Invalid input detected at '^' marker.").is_empty());
    }
}
