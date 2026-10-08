//! Which VRFs a device has, and each one's routing table.
//!
//! **These parsers were written from vendor documentation, not from captured
//! device output.** That is a deliberate exception to the project's rule that
//! parsers are written against real captures, the same one made for
//! stacking, so that multi-VRF support exists before such a device is on
//! hand to test it.
//!
//! So every parser here is a **hypothesis** until it has met hardware.
//! `verified_against_hardware` says which have, and
//! `examples/probe_overlay.rs` is how that gets earned.
//!
//! # Why this exists at all
//!
//! A VRF is a separate routing table on the same box. Two tenants can hold the
//! same prefix and mean different networks, and traffic in one cannot reach the
//! other. Coreview's path engine enforces that isolation — it answers
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
    /// IOS and IOS-XE: `show vrf`, then `show ip route vrf <name>`, and
    /// `show ip route vrf *` for the whole set.
    Cisco,
    /// NX-OS. The same `show vrf` and per-VRF command as IOS, but **not** the
    /// same command for every table at once: a Nexus answers
    /// `show ip route vrf all` and rejects `*`, while IOS does the exact
    /// opposite. Both were asked, on hardware, before this split.
    NxOs,
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
    /// **The honest field**, the same one stacking carries. Allowed
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
            // A Nexus 9000v answered every command here in the lab on
            // 2026-09-20, and a real Nexus leaf with six VRFs before it.
            VrfDialect::NxOs => true,
            // IOS 15.7 answered `show vrf`, `show ip route vrf <name>` and
            // `show ip route vrf *` in the lab on 2026-09-20 — and found two
            // bugs doing it. **IOS-XE 16.12.05 answered the
            // same three the same day**, on a CSR1000v with two VRFs: the
            // `show vrf` table is indeed identical, `vrf *` prints
            // `Routing Table: TENANT_A` with no `VRF` before the name, and
            // `vrf all` is refused there exactly as it is on IOS. Both halves
            // of this arm have now met hardware.
            VrfDialect::Cisco => true,
            VrfDialect::FortiOs | VrfDialect::Junos | VrfDialect::Arista => false,
        }
    }

    /// The command that lists the VRFs.
    pub fn list_command(&self) -> &'static str {
        match self {
            VrfDialect::Cisco | VrfDialect::NxOs | VrfDialect::Arista => "show vrf",
            VrfDialect::FortiOs => "get system vdom-property",
            VrfDialect::Junos => "show route instance",
        }
    }

    /// One command that reads **every** VRF's table, where the platform has
    /// one.
    ///
    /// A Nexus with six VRFs is six round trips the slow way and one this
    /// way, and a real capture is what showed the shape: the
    /// device prints a `IP Route Table for VRF "<name>"` header and then that
    /// VRF's routes, over and over, **including the empty ones** — which is
    /// worth having, because a VRF that exists and holds nothing is a
    /// different answer from a VRF nobody collected.
    ///
    /// `None` where a platform has no such command: a FortiOS VDOM is entered
    /// rather than named, so its tables are read one VDOM at a time.
    pub fn all_command(&self) -> Option<&'static str> {
        match self {
            // Settled by asking both platforms rather than by
            // reading. A Nexus prints every table for `vrf all` and answers
            // `No IP Route Table for VRF "*"` to the other spelling; IOS
            // prints every table for `vrf *` and answers
            // `% IP routing table vrf all does not exist` to this one. There
            // is no single command that serves both, which is why they are
            // separate dialects at all.
            VrfDialect::NxOs => Some("show ip route vrf all"),
            VrfDialect::Cisco | VrfDialect::Arista => Some("show ip route vrf *"),
            // Junos prints every instance's table without being asked twice.
            VrfDialect::Junos => Some("show route"),
            VrfDialect::FortiOs => None,
        }
    }

    /// Whether a VRF's table can be read by naming it on one command.
    ///
    /// **False for FortiOS, and that is not a gap in the parser.** A VDOM is
    /// *entered* — `config vdom`, `edit CORP`, then the command, then `end` —
    /// so there is no single line that reads one VDOM's table from outside
    /// it. The crawl lists the VDOMs and leaves their tables uncollected,
    /// which the path engine reports as "no table held for that VRF" rather
    /// than as an empty one. Answering an empty table for a VDOM full of
    /// routes would be the worse kind of wrong.
    pub fn reads_tables_by_name(&self) -> bool {
        !matches!(self, VrfDialect::FortiOs)
    }

    /// The command that reads one VRF's table.
    pub fn table_command(&self, vrf: &str) -> String {
        match self {
            VrfDialect::Cisco | VrfDialect::NxOs | VrfDialect::Arista => {
                format!("show ip route vrf {vrf}")
            }
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
    } else if v.contains("nx-os") || v.contains("nexus") {
        VrfDialect::NxOs
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
/// **Shape, from the vendor guides**:
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
    // its name is the only thing in the listing worth having.
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
        // documentation-built parser is prone to.
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

        // A capture someone pasted carries the prompt the device
        // printed after the table, and `PE1#` alone on a line was coming back
        // as a VRF — which would have the crawl ask for
        // `show ip route vrf PE1#`. A prompt is one token that ends the way a
        // prompt ends; no VRF name may contain either character.
        if looks_like_prompt(raw) {
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

/// The VDOMs a FortiGate has.
///
/// **Built from Fortinet's documentation, not from captured output**.
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
    // interface name has a comma or a colon in it.
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

/// Every VRF's table out of one answer.
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
/// answers and the path engine gives different ones.
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
/// A device prompt rather than a row of a table: one token on the line, ending
/// the way a prompt ends — `PE1#`, `switch>`, `LEAF1(config)#`.
fn looks_like_prompt(line: &str) -> bool {
    let mut tokens = line.split_whitespace();
    let Some(only) = tokens.next() else { return false };
    tokens.next().is_none() && (only.ends_with('#') || only.ends_with('>'))
}

fn table_header(line: &str) -> Option<String> {
    let t = line.trim();
    let rest = t
        .strip_prefix("IP Route Table for VRF")
        .or_else(|| t.strip_prefix("IPv6 Route Table for VRF"))
        // IOS writes `Routing Table: CORP` — the name, with no `VRF`
        // between the colon and it. This was built from a documented shape
        // that had the word there, so on a real IOS router every per-VRF
        // table in `show ip route vrf *` was invisible. Strip the colon
        // first and the optional `VRF` after it, so both spellings read.
        .or_else(|| t.strip_prefix("Routing Table:"))
        .or_else(|| t.strip_prefix("VRF:"))?;
    let rest = rest.trim();
    let rest = rest.strip_prefix("VRF ").unwrap_or(rest);
    let name = rest.trim().trim_matches('"').trim();
    if name.is_empty() {
        return None;
    }
    Some(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// From asking both platforms in the lab on 2026-09-20 rather
    /// than from reading. Neither spelling works on both.
    #[test]
    fn each_cisco_platform_gets_the_command_it_actually_answers() {
        // `% IP routing table vrf all does not exist` on IOS 15.7.
        assert_eq!(VrfDialect::Cisco.all_command(), Some("show ip route vrf *"));
        // `No IP Route Table for VRF "*"` on a Nexus 9000v.
        assert_eq!(VrfDialect::NxOs.all_command(), Some("show ip route vrf all"));
        // Everything else about the two is the same.
        assert_eq!(VrfDialect::NxOs.list_command(), VrfDialect::Cisco.list_command());
        assert_eq!(
            VrfDialect::NxOs.table_command("CORP"),
            VrfDialect::Cisco.table_command("CORP")
        );
    }

    #[test]
    fn a_nexus_banner_is_not_read_as_ios() {
        assert_eq!(
            dialect_for("Cisco Nexus Operating System (NX-OS) Software"),
            VrfDialect::NxOs
        );
        assert_eq!(
            dialect_for("Cisco IOS Software, Linux Software (I86BI_LINUXL3-ADVENTERPRISEK9-M)"),
            VrfDialect::Cisco
        );
        // The banner test must not swallow the others.
        assert_eq!(dialect_for("Arista Networks EOS version 4.31"), VrfDialect::Arista);
        assert_eq!(dialect_for("FortiGate-60F v7.6.7"), VrfDialect::FortiOs);
    }

    /// A real per-VRF table from IOS 15.7, in the lab, 2026-09-20.
    /// **IOS writes the name with no `VRF` before it** — `Routing Table: CORP`
    /// — and the documented shape this was built from said otherwise, so every
    /// VRF table in the output was invisible. The global table comes first,
    /// with no header of its own.
    const IOS_VRF_STAR: &str = r#"
Gateway of last resort is not set

      172.16.0.0/16 is variably subnetted, 6 subnets, 3 masks
C        172.16.1.0/24 is directly connected, Ethernet0/0
L        172.16.1.11/32 is directly connected, Ethernet0/0
S        172.16.255.12/32 [1/0] via 172.16.10.2

Routing Table: CORP
Gateway of last resort is not set

      172.16.0.0/16 is variably subnetted, 2 subnets, 2 masks
C        172.16.100.0/24 is directly connected, Loopback100
L        172.16.100.11/32 is directly connected, Loopback100

Routing Table: GUEST
Gateway of last resort is not set

      172.16.0.0/16 is variably subnetted, 2 subnets, 2 masks
C        172.16.200.0/24 is directly connected, Loopback200
"#;

    #[test]
    fn a_real_ios_per_vrf_table_is_read() {
        let tables = parse_vrf_tables(IOS_VRF_STAR);
        assert!(tables.contains_key("CORP"), "no CORP table: {:?}", tables.keys().collect::<Vec<_>>());
        assert!(tables.contains_key("GUEST"), "no GUEST table");
        let corp = &tables["CORP"];
        assert_eq!(corp.len(), 2, "{corp:?}");
        assert!(corp.iter().any(|r| r.prefix == "172.16.100.0/24"));
        // The rows above the first header belong to the global table, not to
        // the first VRF that happens to follow them.
        assert!(
            !corp.iter().any(|r| r.prefix == "172.16.1.0/24"),
            "a global route was filed under the first VRF: {corp:?}"
        );
    }

    /// The NX-OS heading still works — it was captured from a real Nexus and
    /// must not be traded away for the IOS one.
    #[test]
    fn the_nexus_heading_still_reads() {
        let out = "IP Route Table for VRF \"CORP\"\n\
172.16.100.0/24, ubest/mbest: 1/0\n    *via 172.16.10.2, [1/0], 00:01:00, static\n";
        let tables = parse_vrf_tables(out);
        assert!(tables.contains_key("CORP"), "{:?}", tables.keys().collect::<Vec<_>>());
    }

    /// `show vrf` on IOS 15.7 in the lab, with the prompt the device
    /// printed after it. A pasted capture always carries its prompts, and
    /// `PE1#` was being returned as a third VRF — which would have the crawl
    /// ask for `show ip route vrf PE1#`.
    #[test]
    fn the_prompt_after_a_capture_is_not_a_vrf() {
        let out = "\
  Name                             Default RD            Protocols   Interfaces
  CORP                             65000:100             ipv4        Lo100
  GUEST                            65000:200             ipv4        Lo200
PE1#
";
        let v = parse_vrf_list(out, VrfDialect::Cisco);
        let names: Vec<&str> = v.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, vec!["CORP", "GUEST"], "{names:?}");
    }

    /// **Documentation-shaped, not captured**. From Cisco's IOS-XE and
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
    /// invented VRF names. Nothing like the IOS-XE table above: a
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

    /// **From Arista's `show vrf` documentation, not captured**. A
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

    /// **From Fortinet's documentation, not captured**.
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
    /// 2026-09-20, retyped. One command, every table, the empty ones
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
