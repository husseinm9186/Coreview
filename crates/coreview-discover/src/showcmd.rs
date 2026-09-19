//! Show commands, run against a device and filed like a backup (LT-149).
//!
//! A backup takes two captures a device will always give, running and startup
//! configuration. A change review wants more: routes, neighbours, interface
//! counters, the log — whatever the person reviewing it needs to see, which is
//! a list they write, not one this file can know.
//!
//! **This is a tool for reading, and it is going to strangers.** Coreview is
//! given away to engineers (D-027), and a field that sends whatever is typed
//! into it is one pasted `reload` away from an outage. So every command is
//! checked before anything is sent: it must be a `show`, `display` or `get`,
//! or one of the session-only paging commands below. A `show` piped into
//! `redirect`, `tee`, `append` or `save`, or sent to a file with `>`, writes to
//! the device's own storage and is refused too.
//!
//! Nothing here is specific to any network. The paging commands are each
//! vendor's own documented command; there are no built-in command lists.

/// How to stop a device paging before the commands run.
///
/// Every SSH session already sends `terminal length 0` when it connects and
/// answers a `--More--` prompt when one appears anyway, so **Auto** needs
/// nothing extra and is right for most Cisco, Dell and Arista kit. The rest are
/// for platforms that ignore that command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Paging {
    Auto,
    CiscoIos,
    CiscoAsa,
    PaloAlto,
    FortiOs,
    ArubaHp,
    Juniper,
    HuaweiH3c,
    None,
}

impl Paging {
    pub fn parse(word: &str) -> Option<Self> {
        Some(match word.trim() {
            "auto" | "" => Paging::Auto,
            "cisco-ios" => Paging::CiscoIos,
            "cisco-asa" => Paging::CiscoAsa,
            "palo-alto" => Paging::PaloAlto,
            "forti-os" => Paging::FortiOs,
            "aruba-hp" => Paging::ArubaHp,
            "juniper" => Paging::Juniper,
            "huawei-h3c" => Paging::HuaweiH3c,
            "none" => Paging::None,
            _ => return None,
        })
    }

    /// What to send before the first command.
    ///
    /// Every one of these lasts for this session only. FortiOS is deliberately
    /// empty: its only way to stop paging, `config system console` /
    /// `set output standard`, is a saved configuration change, and a reading
    /// tool must not make one. Its `--More--` prompts are answered as they
    /// arrive instead.
    pub fn setup_commands(&self) -> &'static [&'static str] {
        match self {
            Paging::Auto | Paging::FortiOs | Paging::None => &[],
            Paging::CiscoIos => &["terminal length 0"],
            Paging::CiscoAsa => &["terminal pager 0"],
            Paging::PaloAlto => &["set cli pager off"],
            Paging::ArubaHp => &["no page"],
            Paging::Juniper => &["set cli screen-length 0"],
            Paging::HuaweiH3c => &["screen-length 0 temporary"],
        }
    }
}

/// Commands that change nothing but this session's paging, and so are allowed
/// in a list alongside the show commands — someone who types
/// `terminal length 0` at the top of their list should not be refused.
const SESSION_COMMANDS: &[&str] = &[
    "terminal length 0",
    "terminal pager 0",
    "terminal width 0",
    "terminal width 511",
    "set cli pager off",
    "no page",
    "set cli screen-length 0",
    "screen-length 0 temporary",
];

/// Pipe modifiers that write output somewhere on the device.
const WRITING_PIPES: &[&str] = &["redirect", "tee", "append", "save", "copy", "write"];

/// Whether a command only reads. `Err` says why not, in words a person can act
/// on.
pub fn check_read_only(command: &str) -> Result<(), String> {
    if command.contains('\n') || command.contains('\r') {
        return Err("one command per line".into());
    }
    let normal = command.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    if normal.is_empty() {
        return Err("empty".into());
    }
    if SESSION_COMMANDS.contains(&normal.as_str()) {
        return Ok(());
    }

    let mut segments = normal.split('|');
    let head = segments.next().unwrap_or("").trim();
    let verb = head.split(' ').next().unwrap_or("");
    let reads = is_prefix_of(verb, "show", 2) || is_prefix_of(verb, "display", 3) || verb == "get";
    if !reads {
        return Err(format!(
            "only show, display and get commands are run — `{verb}` could change the device"
        ));
    }
    for segment in segments {
        let modifier = segment.trim().split(' ').next().unwrap_or("");
        if WRITING_PIPES.contains(&modifier) {
            return Err(format!("`| {modifier}` writes to the device's own storage"));
        }
    }
    // NX-OS and Junos send output to a file with `>`. Refusing it outright also
    // refuses a `>` inside an include pattern, which is the safe side to err on.
    if normal.contains('>') {
        return Err("`>` sends output to a file on the device".into());
    }
    Ok(())
}

/// `sh`, `sho` and `show` are all `show`; `dis` and `display` are `display`.
fn is_prefix_of(word: &str, full: &str, min: usize) -> bool {
    word.len() >= min && full.starts_with(word)
}

/// Every command that fails the read-only check, with the reason.
pub fn refused(commands: &[String]) -> Vec<(String, String)> {
    commands
        .iter()
        .filter(|c| !c.trim().is_empty())
        .filter_map(|c| check_read_only(c).err().map(|why| (c.trim().to_string(), why)))
        .collect()
}

/// The commands one device gets: the global list, then its own, trimmed, with
/// blanks and repeats removed and the order kept.
pub fn plan_for(global: &[String], device: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in global.iter().chain(device) {
        let c = c.trim();
        if !c.is_empty() && !out.iter().any(|o| o == c) {
            out.push(c.to_string());
        }
    }
    out
}

/// One command's output as it goes into the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    pub command: String,
    pub output: String,
    /// The device answered with a rejection. The answer is kept — it is still
    /// evidence of what that device does not support — and marked.
    pub rejected: bool,
}

const RULE: &str =
    "==============================================================================";

/// Written after a command the device refused, and read back by `sections`.
const REJECTED_MARK: &str = "    [not accepted by this device]";

/// Reads a capture written by `render` back into its sections (LT-152), so
/// two runs can be compared command by command rather than as one file whose
/// header and clock lines always differ.
///
/// A heading is a rule, one line, and a rule. The closing rule of one heading
/// is never taken as the opening rule of another, and a file with no headings
/// yields nothing — the caller compares it whole.
pub fn sections(text: &str) -> Vec<Section> {
    let lines: Vec<&str> = text.lines().collect();
    let mut heads = Vec::new();
    let mut i = 0;
    while i + 2 < lines.len() {
        if lines[i] == RULE && lines[i + 2] == RULE {
            heads.push(i);
            i += 3;
        } else {
            i += 1;
        }
    }
    heads
        .iter()
        .enumerate()
        .map(|(n, &h)| {
            let raw = lines[h + 1];
            let (command, rejected) = match raw.strip_suffix(REJECTED_MARK) {
                Some(c) => (c.trim_end().to_string(), true),
                None => (raw.to_string(), false),
            };
            let end = heads.get(n + 1).copied().unwrap_or(lines.len());
            let start = (h + 3).min(end);
            let body = lines[start..end].join("\n").trim_end().to_string();
            let output = if body == "(no output)" { String::new() } else { body };
            Section { command, output, rejected }
        })
        .collect()
}

/// The whole capture file: who and when, then every command under its heading.
pub fn render(device: &str, address: &str, stamp: &str, sections: &[Section]) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Show commands — {device} ({address})\n"));
    out.push_str(&format!("# Captured {stamp}, {} command(s)\n", sections.len()));
    let rejected = sections.iter().filter(|s| s.rejected).count();
    if rejected > 0 {
        out.push_str(&format!("# {rejected} not accepted by this device — marked below\n"));
    }
    for s in sections {
        out.push('\n');
        out.push_str(RULE);
        out.push('\n');
        out.push_str(&s.command);
        if s.rejected {
            out.push_str(REJECTED_MARK);
        }
        out.push('\n');
        out.push_str(RULE);
        out.push('\n');
        let body = s.output.trim_end();
        if body.is_empty() {
            out.push_str("(no output)\n");
        } else {
            out.push_str(body);
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmds(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reading_commands_are_allowed_in_every_vendors_spelling() {
        for ok in [
            "show version",
            "sh ip int brief",
            "sho run",
            "show running-config | include hostname",
            "show ip route | section static",
            "display current-configuration",
            "dis version",
            "get system status",
            "show logging | begin Log Buffer",
        ] {
            assert!(check_read_only(ok).is_ok(), "{ok} was refused: {:?}", check_read_only(ok));
        }
    }

    /// The whole point of the guard. Each of these changes a device, and this
    /// tool is given to strangers who will paste things.
    #[test]
    fn anything_that_changes_a_device_is_refused() {
        for bad in [
            "reload",
            "configure terminal",
            "conf t",
            "write memory",
            "copy running-config startup-config",
            "delete flash:config.text",
            "clear counters",
            "execute reboot",
            "diagnose sys kill 11 1",
            "request system reboot",
            "debug all",
        ] {
            assert!(check_read_only(bad).is_err(), "{bad} was allowed");
        }
    }

    /// A show command can still write to the device's own storage.
    #[test]
    fn a_show_that_writes_a_file_is_refused() {
        for bad in [
            "show running-config | redirect flash:x.txt",
            "show running-config | tee flash:x.txt",
            "show logging | append bootflash:log.txt",
            "show configuration | save /var/tmp/x",
            "show running-config > bootflash:x.txt",
        ] {
            assert!(check_read_only(bad).is_err(), "{bad} was allowed");
        }
    }

    #[test]
    fn session_paging_commands_are_allowed_in_the_list() {
        for ok in ["terminal length 0", "Terminal  Length 0", "terminal pager 0", "no page"] {
            assert!(check_read_only(ok).is_ok(), "{ok} was refused");
        }
    }

    #[test]
    fn two_commands_on_one_line_are_refused() {
        assert!(check_read_only("show version\nreload").is_err());
        assert!(check_read_only("show version\rreload").is_err());
    }

    #[test]
    fn refused_lists_each_bad_command_with_its_reason() {
        let got = refused(&cmds(&["show version", "reload", "", "show run | tee flash:a"]));
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].0, "reload");
        assert!(got[1].1.contains("tee"));
    }

    #[test]
    fn a_device_gets_the_global_list_then_its_own_without_repeats() {
        let plan = plan_for(
            &cmds(&["show version", " show clock ", ""]),
            &cmds(&["show clock", "show interfaces status"]),
        );
        assert_eq!(plan, cmds(&["show version", "show clock", "show interfaces status"]));
    }

    #[test]
    fn every_paging_choice_parses_and_only_sends_session_commands() {
        for word in [
            "auto", "cisco-ios", "cisco-asa", "palo-alto", "forti-os", "aruba-hp", "juniper",
            "huawei-h3c", "none",
        ] {
            let p = Paging::parse(word).unwrap_or_else(|| panic!("{word} did not parse"));
            for c in p.setup_commands() {
                assert!(check_read_only(c).is_ok(), "{word} sends {c}, which is not session-only");
            }
        }
        assert_eq!(Paging::parse("nonsense"), None);
    }

    /// FortiOS has no session-only pager command, and the tool must not make a
    /// saved configuration change to get one.
    #[test]
    fn fortios_paging_makes_no_configuration_change() {
        assert!(Paging::FortiOs.setup_commands().is_empty());
    }

    #[test]
    fn the_file_puts_every_command_under_its_own_heading_in_order() {
        let text = render(
            "SW-A",
            "192.0.2.10",
            "20260101-120000",
            &[
                Section { command: "show version".into(), output: "Version 1.0\n".into(), rejected: false },
                Section { command: "show bogus".into(), output: "% Invalid input".into(), rejected: true },
                Section { command: "show clock".into(), output: "".into(), rejected: false },
            ],
        );
        let v = text.find("show version").unwrap();
        let b = text.find("show bogus").unwrap();
        let c = text.find("show clock").unwrap();
        assert!(v < b && b < c, "sections out of order");
        assert!(text.contains("Version 1.0"));
        assert!(text.contains("[not accepted by this device]"));
        assert!(text.contains("1 not accepted by this device"));
        assert!(text.contains("(no output)"));
        assert!(text.starts_with("# Show commands — SW-A (192.0.2.10)"));
    }

    /// LT-152 compares runs command by command, so what `render` writes must
    /// come back out exactly — including a refusal and an empty output.
    #[test]
    fn a_rendered_file_reads_back_into_the_same_sections() {
        let written = vec![
            Section { command: "show version".into(), output: "Version 1.0\nuptime 3 days".into(), rejected: false },
            Section { command: "show bogus".into(), output: "% Invalid input".into(), rejected: true },
            Section { command: "show clock".into(), output: String::new(), rejected: false },
        ];
        let text = format!(
            "# Ran in user mode — a note that comes first\n{}",
            render("SW-A", "192.0.2.10", "20260101-120000", &written)
        );
        assert_eq!(sections(&text), written);
    }

    #[test]
    fn a_file_with_no_headings_has_no_sections() {
        assert!(sections("hostname SW1\n!\nend\n").is_empty());
        assert!(sections("").is_empty());
        // A heading at the very end, with no body at all, still reads.
        let bare = format!("{RULE}\nshow clock\n{RULE}");
        assert_eq!(sections(&bare), vec![Section { command: "show clock".into(), output: String::new(), rejected: false }]);
    }
}
