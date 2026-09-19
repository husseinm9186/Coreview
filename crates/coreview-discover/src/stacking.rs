//! Stacks, chassis pairs and virtual chassis (LT-139).
//!
//! # Read this before trusting anything here
//!
//! **These parsers were written from vendor documentation, not from captured
//! device output.** That inverts this project's standing rule (`CLAUDE.md`),
//! deliberately and on the operator's instruction — see **D-026**. Every
//! parser below therefore carries the command it expects and where its shape
//! came from, and every one of them is a *hypothesis* until it has met real
//! hardware. `verified_against_hardware` on each family says which have.
//!
//! # The distinction the diagram turns on
//!
//! These technologies are not interchangeable and must not draw the same way:
//!
//! - A **stack** (Cisco StackWise, Aruba VSF, Juniper Virtual Chassis, Dell
//!   and Netgear stacking) is *one* logical switch. One management address,
//!   one configuration, one node on a diagram — with the members recorded so
//!   each can still be identified and replaced. This is what LT-115 already
//!   does from the prompt.
//! - A **chassis pair** (Cisco StackWise Virtual and VSS, Aruba VSX) is *two*
//!   independent switches joined by an inter-switch link, presenting a common
//!   LAG downstream. The whole point is that a downstream link survives
//!   losing one of them, and drawing the pair as a single node hides exactly
//!   that. Two nodes, with the ISL between them.
//!
//! `StackKind::draws_as_one_node` is that distinction, and it is the only
//! thing the rest of the app needs to ask.

use serde::{Deserialize, Serialize};

/// Which technology is holding these boxes together.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StackKind {
    /// Cisco StackWise / StackWise-480 / StackWise-1T, and the plain
    /// `show switch` stack on IOS and IOS-XE.
    StackWise,
    /// Cisco StackWise Virtual — two chassis, one control plane, an SVL
    /// between them.
    StackWiseVirtual,
    /// Cisco Virtual Switching System, the 6500/4500 predecessor of the above.
    Vss,
    /// Aruba AOS-CX Virtual Switching Framework: one logical switch.
    Vsf,
    /// Aruba AOS-CX Virtual Switching Extension: two switches, an ISL, a
    /// shared downstream LAG. Not a stack.
    Vsx,
    /// Juniper EX Virtual Chassis.
    VirtualChassis,
    /// Dell N-Series, Netgear M4300, D-Link DGS-3130 and the other
    /// `show switch`-shaped stacks.
    VendorStack,
    /// FortiSwitches stacked behind a FortiGate.
    FortiLinkStack,
}

impl StackKind {
    /// Whether the members are one switch on a diagram, or several.
    ///
    /// The one question the rest of the app asks. A stack is one node; a
    /// chassis pair is two with a link, because the reason it exists is that
    /// either half can fail.
    pub fn draws_as_one_node(&self) -> bool {
        !matches!(
            self,
            StackKind::StackWiseVirtual
                | StackKind::Vss
                | StackKind::Vsx
                // FortiSwitch "stacking" is MCLAG with an inter-chassis link:
                // two switches presenting one LAG downstream, which is VSX's
                // shape and not a stack's.
                | StackKind::FortiLinkStack
        )
    }

    pub fn label(&self) -> &'static str {
        match self {
            StackKind::StackWise => "StackWise",
            StackKind::StackWiseVirtual => "StackWise Virtual",
            StackKind::Vss => "VSS",
            StackKind::Vsf => "VSF",
            StackKind::Vsx => "VSX",
            StackKind::VirtualChassis => "Virtual Chassis",
            StackKind::VendorStack => "Stack",
            StackKind::FortiLinkStack => "FortiLink stack",
        }
    }

    /// Whether any parser for this family has been run against real hardware.
    ///
    /// **The honest field.** D-026 allowed these to be written from
    /// documentation; this is how a reader tells a proven parser from a
    /// plausible one. Flip a value here only after seeing it work on a device,
    /// and say which device in the commit.
    pub fn verified_against_hardware(&self) -> bool {
        match self {
            // The one thing actually tested: a WS-C2960CX answers `show
            // switch` with "Invalid input", which is how a standalone switch
            // must read. Checked 2026-09-12 against LAB-CORE-SW1.
            StackKind::StackWise => false,
            _ => false,
        }
    }
}

/// One box inside a stack or pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackMember {
    /// The member or switch number the platform gives it.
    pub id: String,
    /// Master, standby, member — as the platform words it, lowercased.
    pub role: Option<String>,
    /// Ready, operational, up — again as worded.
    pub state: Option<String>,
    pub model: Option<String>,
    pub serial: Option<String>,
    /// The member's own MAC, where the platform reports one.
    pub mac: Option<String>,
    /// The priority used to elect the master, where reported.
    pub priority: Option<String>,
}

impl StackMember {
    fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            role: None,
            state: None,
            model: None,
            serial: None,
            mac: None,
            priority: None,
        }
    }
}

/// What a device said about being stacked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackInfo {
    pub kind: StackKind,
    pub members: Vec<StackMember>,
    /// For a chassis pair: the address or name of the other half, where the
    /// command gives one.
    pub peer: Option<String>,
    /// For a chassis pair: the interface carrying the inter-switch link —
    /// Cisco's SVL, Aruba's ISL.
    pub inter_switch_link: Option<String>,
    /// Whether the pair reports itself as healthy. `None` where the command
    /// does not say.
    pub peer_reachable: Option<bool>,
    /// True while no parser in this family has met real hardware. Carried on
    /// the result so the interface can say so rather than presenting a guess
    /// as a fact.
    pub unverified: bool,
}

impl StackInfo {
    fn new(kind: StackKind, members: Vec<StackMember>) -> Self {
        Self {
            unverified: !kind.verified_against_hardware(),
            kind,
            members,
            peer: None,
            inter_switch_link: None,
            peer_reachable: None,
        }
    }

    /// A stack of one is a standalone switch, not a stack.
    ///
    /// A 2960CX prints a one-row member table in `show version`, and a
    /// stackable switch on its own prints one row from `show switch`. Calling
    /// that a stack would put a "StackWise" badge on every standalone box in
    /// an estate.
    pub fn is_really_stacked(&self) -> bool {
        self.members.len() > 1 || !self.kind.draws_as_one_node()
    }
}

/// The commands worth trying on a device, per platform family.
///
/// Ordered cheapest-first and safe to run blind: every one is a `show`, and a
/// platform that does not know a command answers with a rejection this crate
/// already recognises.
pub fn commands_for(platform_hint: &str) -> &'static [&'static str] {
    let p = platform_hint.to_ascii_lowercase();
    if p.contains("aruba") || p.contains("aos-cx") || p.contains("hpe") || p.contains("hp ") {
        // `show vsf` is a table; `show vsf topology` is ASCII art. The table
        // first, because it is the one worth parsing.
        &["show vsf", "show vsx status"]
    } else if p.contains("junos") || p.contains("juniper") || p.contains("ex2") || p.contains("ex3")
    {
        &["show virtual-chassis"]
    } else if p.contains("forti") {
        &["diagnose switch-controller switch-info topology"]
    } else {
        // Cisco, Dell N-Series and Netgear M4300 all answer `show switch`
        // with *different* tables, which is why there is a parser each.
        // StackWise Virtual answers neither of the first two: it has its own
        // command, and omitting it is how a 9500 pair would go unnoticed.
        &["show switch", "show stackwise-virtual", "show switch virtual"]
    }
}

/// The wider set, for the `probe_stack` example rather than for a crawl.
///
/// A crawl pays a round trip per command on every device it reaches, so it
/// asks the fewest questions that can identify a family. Someone testing one
/// device by hand has no such budget and wants everything, including the
/// commands that only add detail.
pub fn probe_commands_for(platform_hint: &str) -> &'static [&'static str] {
    let p = platform_hint.to_ascii_lowercase();
    if p.contains("aruba") || p.contains("aos-cx") || p.contains("hpe") || p.contains("hp ") {
        &["show vsf", "show vsf topology", "show vsx status", "show vsx status config-sync"]
    } else if p.contains("junos") || p.contains("juniper") || p.contains("ex2") || p.contains("ex3")
    {
        &["show virtual-chassis", "show virtual-chassis status"]
    } else if p.contains("forti") {
        &[
            "diagnose switch-controller switch-info topology",
            "get switch-controller managed-switch",
        ]
    } else {
        &[
            "show switch",
            "show switch detail",
            "show stackwise-virtual",
            "show stackwise-virtual link",
            "show switch virtual",
            "show switch virtual link",
        ]
    }
}

/// Whether a platform rejected the command rather than answering it.
///
/// The one thing measured rather than read: a WS-C2960CX answers `show switch`
/// with `% Invalid input detected at '^' marker.`, and that has to read as
/// "this switch is not stackable", not as an error. Captured from
/// `LAB-CORE-SW1` on 2026-09-12.
pub fn command_rejected(output: &str) -> bool {
    let l = output.to_ascii_lowercase();
    [
        "invalid input detected",
        "% invalid",
        "unknown command",
        "syntax error",
        "command parse error",
        "unrecognized command",
        "% incomplete command",
    ]
    .iter()
    .any(|m| l.contains(m))
}

/// Whether a token is a hardware address in any of the three spellings.
fn looks_like_mac(token: &str) -> bool {
    let hex: String = token.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    hex.len() == 12 && token.contains(['.', ':', '-'])
}

// --------------------------------------------------------------- Cisco stack

/// `show switch` on IOS / IOS-XE.
///
/// **Built from documentation (D-026), not yet verified against a stack.**
/// Source: Catalyst 9000 stacking guide. The table is
///
/// ```text
/// Switch/Stack Mac Address : 0c75.bd1b.a900 - Local Mac Address
/// Mac persistency wait time: Indefinite
///                                              H/W   Current
/// Switch#   Role    Mac Address     Priority Version  State
/// -----------------------------------------------------------
/// *1       Active   0c75.bd1b.a900     15     V01     Ready
///  2       Standby  0c75.bd1b.8a80     14     V01     Ready
///  3       Member   0c75.bd1b.9b00     10     V01     Ready
/// ```
///
/// The leading `*` marks the switch the session is on, which is information
/// about the connection rather than about the stack, so it is stripped.
pub fn parse_show_switch(output: &str) -> Option<StackInfo> {
    if command_rejected(output) {
        return None;
    }
    let mut members = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim_start();
        let trimmed = trimmed.strip_prefix('*').unwrap_or(trimmed).trim();
        let mut fields = trimmed.split_whitespace();
        let Some(id) = fields.next() else { continue };
        // A member row starts with a bare switch number. Everything else in
        // this output — headings, the MAC line, the rules — does not.
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let rest: Vec<&str> = fields.collect();
        // **A full row or nothing.** `show switch` is not the only command
        // that starts a line with a switch number: `show stackwise-virtual`
        // prints `1  1  HundredGigE1/0/25`, and reading that as a member gave
        // role="1", state="hundredgige1/0/25" — a bogus StackWise stack, which
        // then drew a 9500 *chassis pair* as a single node. That is the worst
        // mistake this module could make, so a short row is not a member.
        if rest.len() < 5 {
            continue;
        }
        // Column two of a real stack table is a MAC. Dell and Netgear answer
        // `show switch` with an entirely different table whose second column
        // is a status word, and taking it would invent a stack out of it.
        if !looks_like_mac(rest[1]) {
            continue;
        }
        let mut member = StackMember::new(id);
        // IOS-XE says Active/Standby/Member; IOS 12.2 on a 3750 says
        // Master/Member. Both are kept as the platform worded them.
        member.role = rest.first().map(|r| r.to_ascii_lowercase());
        member.mac = Some(rest[1].to_string());
        member.priority = Some(rest[2].to_string());
        member.state = Some(rest[4..].join(" ").to_ascii_lowercase());
        members.push(member);
    }
    if members.is_empty() {
        return None;
    }
    Some(StackInfo::new(StackKind::StackWise, members))
}

/// `show switch virtual` on a StackWise Virtual or VSS pair.
///
/// **Built from documentation (D-026).** Source: the Catalyst 9000 StackWise
/// Virtual white paper.
///
/// ```text
/// Switch mode                  : Stackwise Virtual
/// Virtual switch domain number : 100
/// Local switch number          : 1
/// Local switch operational role: Virtual Switch Active
/// Peer switch number           : 2
/// Peer switch operational role : Virtual Switch Standby
/// ```
///
/// VSS words it `Switch mode : Virtual Switch` and numbers a domain the same
/// way, so both are read here and told apart by that line.
pub fn parse_show_switch_virtual(output: &str) -> Option<StackInfo> {
    if command_rejected(output) {
        return None;
    }
    let mut kind = None;
    let mut local = StackMember::new("");
    let mut peer = StackMember::new("");
    for line in output.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match key.as_str() {
            "switch mode" => {
                let v = value.to_ascii_lowercase();
                kind = if v.contains("stackwise") {
                    Some(StackKind::StackWiseVirtual)
                } else if v.contains("virtual switch") {
                    Some(StackKind::Vss)
                } else {
                    None
                };
            }
            "local switch number" => local.id = value.to_string(),
            "local switch operational role" => local.role = Some(value.to_ascii_lowercase()),
            "peer switch number" => peer.id = value.to_string(),
            "peer switch operational role" => peer.role = Some(value.to_ascii_lowercase()),
            _ => {}
        }
    }
    let kind = kind?;
    let mut members = Vec::new();
    if !local.id.is_empty() {
        members.push(local);
    }
    if !peer.id.is_empty() {
        members.push(peer.clone());
    }
    if members.is_empty() {
        return None;
    }
    let mut info = StackInfo::new(kind, members);
    info.peer = if peer.id.is_empty() { None } else { Some(peer.id) };
    Some(info)
}

/// `show stackwise-virtual` on a Catalyst 9500/9600/3850.
///
/// **This is a different command from `show switch virtual`,** which is the
/// VSS (4500/6500) form. Missing it meant StackWise Virtual was never
/// detected at all, and — worse — its table fell through to
/// `parse_show_switch`, which read it as a stack and so drew two chassis as
/// one node.
///
/// ```text
/// Stackwise Virtual Configuration:
/// --------------------------------
/// Stackwise Virtual : Enabled
/// Domain Number : 100
///
/// Switch  Stackwise Virtual Link  Ports
/// ------  ----------------------  ------
/// 1       1                       HundredGigE1/0/25
/// 2       1                       HundredGigE2/0/25
/// ```
pub fn parse_stackwise_virtual(output: &str) -> Option<StackInfo> {
    if command_rejected(output) {
        return None;
    }
    let low = output.to_ascii_lowercase();
    if !low.contains("stackwise virtual") && !low.contains("stackwise-virtual") {
        return None;
    }
    // "Stackwise Virtual : Disabled" is a switch that could pair and has not.
    if low.contains("stackwise virtual : disabled") {
        return None;
    }

    let mut members: Vec<StackMember> = Vec::new();
    let mut links: Vec<String> = Vec::new();
    for line in output.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('-') || t.contains(':') {
            continue;
        }
        let fields: Vec<&str> = t.split_whitespace().collect();
        // switch number, SVL number, port
        if fields.len() < 3 || !fields[0].chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        if !fields[1].chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let port = fields[2..].join(" ");
        if !members.iter().any(|m| m.id == fields[0]) {
            members.push(StackMember::new(fields[0]));
        }
        if !links.contains(&port) {
            links.push(port);
        }
    }
    if members.is_empty() {
        return None;
    }
    let mut info = StackInfo::new(StackKind::StackWiseVirtual, members);
    if !links.is_empty() {
        info.inter_switch_link = Some(links.join(", "));
    }
    Some(info)
}

/// `show switch` on Dell N-Series and Netgear M4300 (both FASTPATH).
///
/// A different table under the same command, which is why it needs its own
/// parser: the roles are two words and there is no MAC or priority column, so
/// the Cisco parser read `Sw` as a hardware address.
///
/// ```text
///       Management Standby  Preconfig  Plugged-in Switch  Code
/// SW    Status     Status   Model ID   Model ID   Status  Version
/// ----  ---------- -------- ---------- ---------- ------- --------
/// 1     Mgmt Sw              N2048      N2048      OK      6.5.1.1
/// 2     Stack Mbr  Oper Stby N2048P     N2048P     OK      6.5.1.1
/// ```
pub fn parse_fastpath_stack(output: &str) -> Option<StackInfo> {
    if command_rejected(output) {
        return None;
    }
    let low = output.to_ascii_lowercase();
    // The header is what tells this table apart from Cisco's.
    if !(low.contains("management status") || low.contains("preconfig")) {
        return None;
    }
    let mut members = Vec::new();
    for line in output.lines() {
        let t = line.trim();
        let fields: Vec<&str> = t.split_whitespace().collect();
        let Some(first) = fields.first() else { continue };
        if !first.chars().all(|c| c.is_ascii_digit()) || fields.len() < 3 {
            continue;
        }
        let mut m = StackMember::new(*first);
        // "Mgmt Sw", "Stack Mbr" — two words, so the role is whatever comes
        // before the first token that looks like a model or a status.
        let rest = &fields[1..];
        let role: Vec<&str> = rest.iter().take(2).copied().collect();
        m.role = Some(role.join(" ").to_ascii_lowercase());
        m.model = rest
            .iter()
            .find(|f| f.chars().any(|c| c.is_ascii_digit()) && f.chars().any(|c| c.is_alphabetic()))
            .map(|f| f.to_string());
        m.state = rest.last().map(|f| f.to_ascii_lowercase());
        members.push(m);
    }
    if members.is_empty() {
        return None;
    }
    Some(StackInfo::new(StackKind::VendorStack, members))
}

// ----------------------------------------------------------------- Aruba VSF

/// `show vsf topology` on AOS-CX.
///
/// **Built from the operator's own screenshot of a 6200 (D-026); the bytes
/// were not captured, so the spacing here is a best reading of the picture.**
///
/// ```text
///  Mstr        Stdby
/// +---+       +---+
/// | 1 |1==1|  2  |
/// +---+       +---+
/// ```
///
/// The tree drawing is decoration. What matters is which member numbers appear
/// and which is master, and those are the only things read.
pub fn parse_vsf(output: &str) -> Option<StackInfo> {
    if command_rejected(output) {
        return None;
    }
    let low = output.to_ascii_lowercase();
    if !low.contains("vsf") && !low.contains("conductor") && !low.contains("mbr") {
        return None;
    }
    let mut members: Vec<StackMember> = Vec::new();

    // Block form: "Member ID : 1" / "MAC Address : .." / "Type : .." / "Status : .."
    let mut current: Option<StackMember> = None;
    for line in output.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let k = key.trim().to_ascii_lowercase();
        let v = value.trim();
        match k.as_str() {
            "member id" => {
                if let Some(m) = current.take() {
                    members.push(m);
                }
                current = Some(StackMember::new(v));
            }
            "mac address" => {
                if let Some(m) = current.as_mut() {
                    m.mac = Some(v.to_string());
                }
            }
            "type" => {
                if let Some(m) = current.as_mut() {
                    m.model = Some(v.to_string());
                }
            }
            "status" => {
                if let Some(m) = current.as_mut() {
                    m.role = Some(v.to_ascii_lowercase());
                }
            }
            _ => {}
        }
    }
    if let Some(m) = current.take() {
        members.push(m);
    }

    // Table form: "1   08:97:34:b0:0e:00   JL666A   Conductor"
    if members.is_empty() {
        for line in output.lines() {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let Some(first) = fields.first() else { continue };
            if !first.chars().all(|c| c.is_ascii_digit()) || fields.len() < 2 {
                continue;
            }
            let mut m = StackMember::new(*first);
            // A member that is not present has no MAC, so the columns shift.
            let mut rest = fields[1..].iter();
            if let Some(maybe_mac) = fields.get(1) {
                if looks_like_mac(maybe_mac) {
                    m.mac = Some((*maybe_mac).to_string());
                    rest.next();
                }
            }
            let tail: Vec<&str> = rest.copied().collect();
            m.model = tail.first().map(|t| t.to_string());
            m.role = if tail.len() > 1 {
                Some(tail[1..].join(" ").to_ascii_lowercase())
            } else {
                None
            };
            members.push(m);
        }
    }
    if members.is_empty() {
        return None;
    }
    Some(StackInfo::new(StackKind::Vsf, members))
}

/// `show vsf topology` — the ASCII art, kept as a fallback for when the table
/// is unavailable.
///
/// **Modern AOS-CX calls the master a Conductor**, so a parser that insisted
/// on the word "master" returned nothing on current firmware.
pub fn parse_vsf_topology(output: &str) -> Option<StackInfo> {
    if command_rejected(output) {
        return None;
    }
    let lower = output.to_ascii_lowercase();
    if !lower.contains("mstr") && !lower.contains("master") && !lower.contains("cndtr")
        && !lower.contains("conductor")
    {
        return None;
    }
    // Member numbers are the bare digits inside the boxes.
    let mut ids: Vec<String> = Vec::new();
    for line in output.lines() {
        if !line.contains('|') {
            continue;
        }
        for cell in line.split('|') {
            let c = cell.trim();
            if !c.is_empty() && c.chars().all(|ch| ch.is_ascii_digit()) && !ids.contains(&c.to_string())
            {
                ids.push(c.to_string());
            }
        }
    }
    if ids.is_empty() {
        return None;
    }
    // The header names the roles left to right; the first is the master.
    let members = ids
        .into_iter()
        .enumerate()
        .map(|(i, id)| {
            let mut m = StackMember::new(id);
            m.role = Some(if i == 0 { "conductor".into() } else { "standby".into() });
            m
        })
        .collect();
    Some(StackInfo::new(StackKind::Vsf, members))
}

// ----------------------------------------------------------------- Aruba VSX

/// `show vsx status` on AOS-CX.
///
/// **Built from the operator's own screenshot of an 8360 (D-026).**
///
/// ```text
/// VSX Operational State
///   ISL channel                 : In-Sync
///   ISL mgmt channel            : operational
///   Config Sync Status          : In-Sync
///   NSO                         : no
///   Device Role                 : primary
///
/// Attribute          Local        Peer
/// ISL link           lag256       lag256
/// ISL version        1            1
/// System MAC         02:01:00:00:01:00  02:01:00:00:01:00
/// ```
///
/// **This is the one that must not draw as a stack.** A VSX pair is two
/// switches; `StackKind::Vsx.draws_as_one_node()` is false for that reason.
pub fn parse_vsx_status(output: &str) -> Option<StackInfo> {
    if command_rejected(output) {
        return None;
    }
    let lower = output.to_ascii_lowercase();
    if !lower.contains("vsx") {
        return None;
    }
    let mut role = None;
    let mut peer_role = None;
    let mut isl = None;
    let mut reachable = None;
    for line in output.lines() {
        let l = line.trim();
        let low = l.to_ascii_lowercase();
        // " : " rather than ':' — a System MAC row is full of colons and
        // would otherwise be read as a key of "system mac          0a".
        if let Some((key, value)) = l.split_once(" : ") {
            let k = key.trim().to_ascii_lowercase();
            let v = value.trim();
            if k == "device role" && !v.is_empty() {
                role = Some(v.to_ascii_lowercase());
            }
            if k.contains("isl channel") && !v.is_empty() {
                reachable = Some(v.to_ascii_lowercase().contains("in-sync"));
            }
            continue;
        }
        // The attribute table is columns, not `key : value` — which is why
        // `Device Role  primary  secondary` was never read: it has no colon,
        // so the branch above never saw it and both members came back with no
        // role at all.
        if low.starts_with("isl link") {
            isl = l.split_whitespace().nth(2).map(str::to_string);
        }
        if low.starts_with("device role") {
            let cols: Vec<&str> = l.split_whitespace().collect();
            // "Device" "Role" "primary" "secondary"
            role = cols.get(2).map(|c| c.to_ascii_lowercase());
            peer_role = cols.get(3).map(|c| c.to_ascii_lowercase());
        }
        if low.contains("peer_reachable") || low.contains("peer reachable") {
            reachable = Some(true);
        }
    }
    let mut local = StackMember::new("local");
    local.role = role.clone();
    let mut peer = StackMember::new("peer");
    // The table states the peer's role outright; inferring it is only the
    // fallback for the key/value form that does not.
    peer.role = peer_role.or_else(|| {
        role.map(|r| if r == "primary" { "secondary".into() } else { "primary".into() })
    });

    let mut info = StackInfo::new(StackKind::Vsx, vec![local, peer]);
    info.inter_switch_link = isl;
    info.peer_reachable = reachable;
    Some(info)
}

// ------------------------------------------------------ Juniper VirtualChassis

/// `show virtual-chassis` on Junos.
///
/// **Built from documentation (D-026).**
///
/// ```text
/// Member ID  Status   Serial No    Model        Mixed Role
/// 0 (FPC 0)  Prsnt    AB1234567890 ex4300-48t   NW   Master*
/// 1 (FPC 1)  Prsnt    AB1234567891 ex4300-48t   NW   Backup
/// ```
pub fn parse_virtual_chassis(output: &str) -> Option<StackInfo> {
    if command_rejected(output) {
        return None;
    }
    let mut members = Vec::new();
    for line in output.lines() {
        let t = line.trim();
        let fields: Vec<&str> = t.split_whitespace().collect();
        let Some(first) = fields.first() else { continue };
        if !first.chars().all(|c| c.is_ascii_digit()) || fields.len() < 4 {
            continue;
        }
        // "0 (FPC 0) Prsnt SERIAL model ... Role" — the bracketed FPC is
        // Junos saying the same number twice, so it is skipped.
        let rest: Vec<&str> = fields
            .iter()
            .skip(1)
            .skip_while(|f| f.starts_with('(') || f.ends_with(')') || **f == "FPC")
            .copied()
            .collect();
        if rest.is_empty() {
            continue;
        }
        let mut m = StackMember::new(*first);
        m.state = rest.first().map(|s| s.to_ascii_lowercase());
        m.serial = rest.get(1).map(|s| s.to_string());
        m.model = rest.get(2).map(|s| s.to_string());
        // The role is **not** the last column: the real order ends
        // `... Mstr prio | Role | Neighbor List`, so `last()` returned a
        // neighbour port like `vcp-255/1/0`. Matched by keyword instead.
        m.role = rest
            .iter()
            .map(|f| f.trim_end_matches('*').to_ascii_lowercase())
            .find(|f| matches!(f.as_str(), "master" | "backup" | "linecard"));
        members.push(m);
    }
    if members.is_empty() {
        return None;
    }
    Some(StackInfo::new(StackKind::VirtualChassis, members))
}

/// Tries every parser and returns whichever recognised the output.
///
/// Order matters only where two families could both claim a text, and they
/// cannot: each looks for something specific to itself first.
pub fn parse_any(output: &str) -> Option<StackInfo> {
    // Most specific first. `parse_show_switch` is last and now demands a MAC
    // in column two, because it is the one whose table shape other vendors
    // and other Cisco commands can accidentally resemble.
    parse_stackwise_virtual(output)
        .or_else(|| parse_show_switch_virtual(output))
        .or_else(|| parse_vsx_status(output))
        .or_else(|| parse_vsf(output))
        .or_else(|| parse_vsf_topology(output))
        .or_else(|| parse_virtual_chassis(output))
        .or_else(|| parse_fastpath_stack(output))
        .or_else(|| parse_show_switch(output))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Measured, not read: this is what the operator's WS-C2960CX actually
    /// answered on 2026-09-12. A switch that cannot stack must read as
    /// standalone rather than as a failure.
    #[test]
    fn a_switch_that_cannot_stack_says_so() {
        let real = "                 ^\n% Invalid input detected at '^' marker.\n";
        assert!(command_rejected(real));
        assert_eq!(parse_show_switch(real), None);
        assert_eq!(parse_any(real), None);
    }

    /// The distinction the whole module exists for.
    #[test]
    fn a_pair_is_two_nodes_and_a_stack_is_one() {
        assert!(StackKind::StackWise.draws_as_one_node());
        assert!(StackKind::Vsf.draws_as_one_node());
        assert!(StackKind::VirtualChassis.draws_as_one_node());
        assert!(StackKind::VendorStack.draws_as_one_node());
        // These are two switches that survive losing one another.
        assert!(!StackKind::Vsx.draws_as_one_node());
        assert!(!StackKind::StackWiseVirtual.draws_as_one_node());
        assert!(!StackKind::Vss.draws_as_one_node());
    }

    /// Documentation-shaped, per D-026 — not a capture.
    #[test]
    fn reads_a_cisco_stack_table() {
        let doc = "\
Switch/Stack Mac Address : 0c75.bd1b.a900 - Local Mac Address
Mac persistency wait time: Indefinite
                                             H/W   Current
Switch#   Role    Mac Address     Priority Version  State
-----------------------------------------------------------
*1       Active   0c75.bd1b.a900     15     V01     Ready
 2       Standby  0c75.bd1b.8a80     14     V01     Ready
 3       Member   0c75.bd1b.9b00     10     V01     Ready
";
        let s = parse_show_switch(doc).expect("parsed");
        assert_eq!(s.kind, StackKind::StackWise);
        assert_eq!(s.members.len(), 3);
        assert_eq!(s.members[0].id, "1");
        assert_eq!(s.members[0].role.as_deref(), Some("active"));
        assert_eq!(s.members[0].mac.as_deref(), Some("0c75.bd1b.a900"));
        assert_eq!(s.members[2].role.as_deref(), Some("member"));
        assert!(s.is_really_stacked());
        // Until it has met hardware it says so.
        assert!(s.unverified);
    }

    /// One member is a switch on its own, not a stack of one.
    #[test]
    fn a_stack_of_one_is_not_a_stack() {
        let doc = "\
Switch#   Role    Mac Address     Priority Version  State
-----------------------------------------------------------
*1       Active   0c75.bd1b.a900     15     V01     Ready
";
        let s = parse_show_switch(doc).expect("parsed");
        assert_eq!(s.members.len(), 1);
        assert!(!s.is_really_stacked());
    }

    #[test]
    fn reads_a_stackwise_virtual_pair() {
        let doc = "\
Switch mode                  : Stackwise Virtual
Virtual switch domain number : 100
Local switch number          : 1
Local switch operational role: Virtual Switch Active
Peer switch number           : 2
Peer switch operational role : Virtual Switch Standby
";
        let s = parse_show_switch_virtual(doc).expect("parsed");
        assert_eq!(s.kind, StackKind::StackWiseVirtual);
        assert_eq!(s.members.len(), 2);
        assert_eq!(s.peer.as_deref(), Some("2"));
        // Two chassis: it must not collapse to one node.
        assert!(!s.kind.draws_as_one_node());
        assert!(s.is_really_stacked());
    }

    #[test]
    fn tells_vss_apart_from_stackwise_virtual() {
        let doc = "\
Switch mode                  : Virtual Switch
Virtual switch domain number : 10
Local switch number          : 1
Local switch operational role: Virtual Switch Active
Peer switch number           : 2
Peer switch operational role : Virtual Switch Standby
";
        assert_eq!(parse_show_switch_virtual(doc).expect("parsed").kind, StackKind::Vss);
    }

    /// Shaped from the operator's 8360 screenshot (D-026).
    #[test]
    fn reads_an_aruba_vsx_pair() {
        let doc = "\
VSX Operational State
  ISL channel                 : In-Sync
  ISL mgmt channel            : operational
  Config Sync Status          : In-Sync
  Device Role                 : primary

Attribute          Local              Peer
ISL link           lag256             lag256
ISL version        1                  1
";
        let s = parse_vsx_status(doc).expect("parsed");
        assert_eq!(s.kind, StackKind::Vsx);
        assert_eq!(s.inter_switch_link.as_deref(), Some("lag256"));
        assert_eq!(s.peer_reachable, Some(true));
        assert_eq!(s.members[0].role.as_deref(), Some("primary"));
        assert_eq!(s.members[1].role.as_deref(), Some("secondary"));
        // The point of VSX.
        assert!(!s.kind.draws_as_one_node());
    }

    /// Shaped from the operator's 6200 screenshot (D-026).
    #[test]
    fn reads_an_aruba_vsf_topology() {
        let doc = "\
 Mstr        Stdby
+---+       +---+
| 1 |1==1|   2   |
+---+       +---+
";
        let s = parse_vsf_topology(doc).expect("parsed");
        assert_eq!(s.kind, StackKind::Vsf);
        assert_eq!(s.members.len(), 2);
        // Current AOS-CX words the master "Conductor", which is what the
        // topology art's first position means.
        assert_eq!(s.members[0].role.as_deref(), Some("conductor"));
        // VSF is one logical switch, unlike VSX.
        assert!(s.kind.draws_as_one_node());
    }

    #[test]
    fn reads_a_juniper_virtual_chassis() {
        let doc = "\
Member ID  Status   Serial No    Model        Mixed Role
0 (FPC 0)  Prsnt    AB1234567890 ex4300-48t   NW   Master*
1 (FPC 1)  Prsnt    AB1234567891 ex4300-48t   NW   Backup
";
        let s = parse_virtual_chassis(doc).expect("parsed");
        assert_eq!(s.kind, StackKind::VirtualChassis);
        assert_eq!(s.members.len(), 2);
        assert_eq!(s.members[0].serial.as_deref(), Some("AB1234567890"));
        assert_eq!(s.members[0].role.as_deref(), Some("master"));
        assert_eq!(s.members[1].role.as_deref(), Some("backup"));
    }

    /// The worst bug the verification pass found: a Catalyst 9500 chassis
    /// pair read as a StackWise *stack*, which `draws_as_one_node` would then
    /// collapse into a single node — hiding the redundancy the pair exists
    /// for. Its table starts each row with a switch number, exactly like
    /// `show switch`, which is how it slipped through.
    #[test]
    fn a_stackwise_virtual_pair_is_never_read_as_a_stack() {
        let real_shape = "\
Stackwise Virtual Configuration:
--------------------------------
Stackwise Virtual : Enabled
Domain Number : 100

Switch  Stackwise Virtual Link  Ports
------  ----------------------  ------
1       1                       HundredGigE1/0/25
2       1                       HundredGigE2/0/25
";
        // The Cisco stack parser must refuse it outright.
        assert_eq!(parse_show_switch(real_shape), None, "read an SVL table as a stack");

        let s = parse_any(real_shape).expect("recognised");
        assert_eq!(s.kind, StackKind::StackWiseVirtual);
        assert_eq!(s.members.len(), 2);
        assert!(!s.kind.draws_as_one_node(), "a chassis pair must not be one node");
        assert!(s.inter_switch_link.as_deref().unwrap_or("").contains("HundredGigE1/0/25"));
    }

    /// A switch that could pair and has not is not a pair.
    #[test]
    fn stackwise_virtual_disabled_is_not_a_pair() {
        assert_eq!(parse_stackwise_virtual("Stackwise Virtual : Disabled\n"), None);
    }

    /// IOS 12.2 on a 3750 says Master/Member where IOS-XE says
    /// Active/Standby/Member. Both are real and both must parse.
    #[test]
    fn reads_the_older_ios_role_words() {
        let doc = "\
Switch#   Role    Mac Address     Priority Version  State
-----------------------------------------------------------
*1       Master   74a2.e69a.0c00     15     3       Ready
 2       Member   74a2.e69a.1000     10     3       Ready
";
        let s = parse_show_switch(doc).expect("parsed");
        assert_eq!(s.members[0].role.as_deref(), Some("master"));
        assert_eq!(s.members[1].role.as_deref(), Some("member"));
    }

    /// Dell N-Series and Netgear M4300 answer `show switch` with a different
    /// table. The Cisco parser used to read "Sw" as a hardware address and
    /// invent a stack out of it.
    #[test]
    fn reads_a_fastpath_stack_and_cisco_does_not_claim_it() {
        let doc = "\
      Management Standby  Preconfig  Plugged-in Switch  Code
SW    Status     Status   Model ID   Model ID   Status  Version
----  ---------- -------- ---------- ---------- ------- --------
1     Mgmt Sw             N2048      N2048      OK      6.5.1.1
2     Stack Mbr  Oper Stby N2048P    N2048P     OK      6.5.1.1
";
        assert_eq!(parse_show_switch(doc), None, "Cisco parser claimed a Dell table");
        let s = parse_fastpath_stack(doc).expect("parsed");
        assert_eq!(s.kind, StackKind::VendorStack);
        assert_eq!(s.members.len(), 2);
        assert!(s.members[0].role.as_deref().unwrap_or("").contains("mgmt"));
        assert!(s.kind.draws_as_one_node());
    }

    /// Current AOS-CX calls the master a **Conductor**, and `show vsf` is a
    /// table rather than the ASCII art of `show vsf topology`.
    #[test]
    fn reads_the_vsf_table_and_its_conductor() {
        let doc = "\
Mbr MAC Address         Type    Status
--- ------------------- ------- -----------
1   08:97:34:b0:0e:00   JL666A  Conductor
2   08:97:34:b1:43:00   JL665A  Standby
3   08:97:34:b7:cc:00   SOE91A  Member
";
        let s = parse_vsf(doc).expect("parsed");
        assert_eq!(s.kind, StackKind::Vsf);
        assert_eq!(s.members.len(), 3);
        assert_eq!(s.members[0].role.as_deref(), Some("conductor"));
        assert_eq!(s.members[0].mac.as_deref(), Some("08:97:34:b0:0e:00"));
        assert_eq!(s.members[0].model.as_deref(), Some("JL666A"));
        assert!(s.kind.draws_as_one_node(), "VSF is one logical switch");
    }

    /// `Device Role  primary  secondary` is a table row with no colon, so the
    /// key/value branch never saw it and both members came back role-less.
    #[test]
    fn reads_the_vsx_device_role_from_the_attribute_table() {
        let doc = "\
VSX Operational State
---------------------
  ISL channel             : In-Sync
  Config Sync Status      : In-Sync
  NAE                     : peer_reachable

Attribute           Local               Peer
------------ -------- --------
ISL link            lag128              lag128
System MAC          0a:01:00:00:01:00   0a:01:00:00:01:00
Device Role         primary             secondary
";
        let s = parse_vsx_status(doc).expect("parsed");
        assert_eq!(s.members[0].role.as_deref(), Some("primary"));
        assert_eq!(s.members[1].role.as_deref(), Some("secondary"));
        assert_eq!(s.inter_switch_link.as_deref(), Some("lag128"));
        // A System MAC row is full of colons and must not be read as a key.
        assert!(!s.kind.draws_as_one_node());
    }

    /// The role is not the last column: the real table ends with a neighbour
    /// list, so `last()` returned a port name.
    #[test]
    fn finds_the_juniper_role_among_the_columns() {
        let doc = "\
Member ID  Status  Serial No     Model        Mixed Route VC    Mstr  Role     Neighbor List
0 (FPC 0)  Prsnt   PE3714500192  ex4300-48mp  Y     VC    Enab  129   Master*  1  vcp-255/1/0
1 (FPC 1)  Prsnt   PE3714500193  ex4300-48mp  Y     VC    Enab  0     Backup   0  vcp-255/1/1
";
        let s = parse_virtual_chassis(doc).expect("parsed");
        assert_eq!(s.members[0].role.as_deref(), Some("master"));
        assert_eq!(s.members[1].role.as_deref(), Some("backup"));
        assert_eq!(s.members[0].serial.as_deref(), Some("PE3714500192"));
    }

    /// FortiSwitch "stacking" is MCLAG — two switches with an inter-chassis
    /// link presenting one LAG downstream. That is VSX's shape, not a stack's.
    #[test]
    fn a_fortiswitch_pair_is_a_chassis_pair() {
        assert!(!StackKind::FortiLinkStack.draws_as_one_node());
    }

    /// Nothing here may panic or claim a match on something it did not
    /// recognise — these run against whatever a stranger's switch prints.
    #[test]
    fn unrecognised_output_is_not_a_stack() {
        for junk in [
            "",
            "\n\n",
            "Building configuration...",
            "% Permission denied",
            "some entirely unrelated output with numbers 1 2 3",
        ] {
            assert_eq!(parse_any(junk), None, "claimed a stack from {junk:?}");
        }
    }

    /// A platform gets the commands its own family answers, and the default
    /// is the `show switch` family that Cisco, Dell, Netgear and D-Link share.
    #[test]
    fn offers_the_right_commands_per_platform() {
        assert!(commands_for("Aruba JL728A 6200F").contains(&"show vsx status"));
        // `show vsf` rather than `show vsf topology`: the first is a table,
        // the second is ASCII art kept only as a fallback.
        assert!(commands_for("AOS-CX 10.15").contains(&"show vsf"));
        assert!(probe_commands_for("AOS-CX 10.15").contains(&"show vsf topology"));
        // StackWise Virtual has its own command; without it a 9500 pair is
        // invisible to a crawl.
        assert!(commands_for("Catalyst 9500").contains(&"show stackwise-virtual"));
        assert!(commands_for("Junos 21.4 ex4300").contains(&"show virtual-chassis"));
        assert!(commands_for("FortiSwitch-224E").iter().any(|c| c.contains("switch-controller")));
        assert!(commands_for("WS-C2960CX-8PC-L").contains(&"show switch"));
        assert!(commands_for("Dell N3048").contains(&"show switch"));
        // A chassis pair answers the virtual form and not the plain one, so a
        // crawl has to ask both or it would miss every VSS and StackWise
        // Virtual on the network.
        assert!(commands_for("Catalyst 9500").contains(&"show switch virtual"));
        // A crawl asks fewer questions than a hand probe: it pays for each
        // one on every device it reaches.
        for hint in ["WS-C2960CX", "Aruba 6200", "Junos ex4300", "FortiSwitch"] {
            assert!(
                commands_for(hint).len() <= probe_commands_for(hint).len(),
                "the crawl asks more than the probe for {hint}"
            );
        }
    }

    /// Nothing claims to be verified yet, and the flag is carried onto every
    /// result so the interface cannot present a guess as a fact.
    #[test]
    fn every_family_is_honest_about_being_untested() {
        for k in [
            StackKind::StackWise,
            StackKind::StackWiseVirtual,
            StackKind::Vss,
            StackKind::Vsf,
            StackKind::Vsx,
            StackKind::VirtualChassis,
            StackKind::VendorStack,
            StackKind::FortiLinkStack,
        ] {
            assert!(!k.verified_against_hardware(), "{k:?} claims hardware it has not met");
        }
    }
}
