//! Checks that say pass or fail against captured output (LT-153).
//!
//! A change checklist asks questions of the output: is this route present, is
//! this neighbour up, has this error appeared. Today a person reads the file.
//! A **check** is one command, an expectation and a pattern, and running it
//! over a backup run's show-command captures turns each device's output into
//! pass or fail — with the line that decided it, because "fail" alone sends
//! someone back to the file anyway.
//!
//! Read-only: checks look at captures already on disk and never connect to a
//! device. The checks are the operator's own and **none ship built in** (D-027).
//!
//! *Contains* and *does not contain* look for the text exactly as written.
//! *Matches* takes a regular expression, compiled by the `regex` crate with a
//! size limit — matching is linear in the output, so a pattern someone pastes
//! cannot hang on a long `show`. Every pattern is matched line-anchored:
//! `^` and `$` are the start and end of a line.

use std::path::Path;

use regex::{Regex, RegexBuilder};

use crate::backup::BackupKind;
use crate::compare::{captures_in, device_dirs, valid_stamp};
use crate::showcmd::sections;

/// Longest pattern accepted. A checklist line, not a program.
const MAX_PATTERN: usize = 1_000;
/// Compiled-size ceiling for one pattern, so `x{1000}{1000}` is refused
/// rather than built.
const REGEX_SIZE: usize = 1 << 20;
/// Longest evidence line returned; a wrapped `show run` line can be long.
const MAX_EVIDENCE: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Expect {
    Contains,
    NotContains,
    Matches,
    NotMatches,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Check {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// The command whose output is examined, matched against the capture's
    /// headings with case and spacing ignored.
    pub command: String,
    pub expect: Expect,
    pub pattern: String,
    #[serde(default)]
    pub ignore_case: bool,
    /// LT-434: the stanza the check applies to, as the start of its heading
    /// line — `interface`, `router bgp`, `line vty`. Empty means the whole
    /// output. With a block named, the check runs once per stanza: *contains*
    /// fails on the first stanza without the pattern, *does not contain*
    /// fails on the first stanza with it.
    #[serde(default)]
    pub block: String,
    /// LT-434: how much a failure matters. Carried onto the result so a
    /// matrix can be read by severity.
    #[serde(default)]
    pub severity: Severity,
    /// LT-434: which device roles the check is for, as the page names them.
    /// Empty means every device; otherwise a device whose role is not listed
    /// gets *not applicable*, never a fail.
    #[serde(default)]
    pub roles: Vec<String>,
}

/// LT-434: how much a failed check matters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Info,
    #[default]
    Warning,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    Pass,
    Fail,
    /// The device's capture in this run does not include the command.
    NotCaptured,
    /// The command was sent and the device refused it.
    Rejected,
    /// LT-434: the check is for other roles than this device's, or names a
    /// block the output has none of. Neither is an answer about the device.
    NotApplicable,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub device: String,
    pub check_id: String,
    pub verdict: Verdict,
    /// LT-434: the check's severity, repeated here so a result stands alone.
    pub severity: Severity,
    /// LT-434: the stanza that decided it, by its heading line, when the
    /// check names a block.
    pub block: Option<String>,
    /// Line number within that command's output, from 1.
    pub line: Option<usize>,
    /// The line that decided it: the match for a pass on *contains*, the
    /// offending line for a fail on *does not contain*.
    pub evidence: Option<String>,
    pub why: String,
}

fn label(check: &Check) -> String {
    let name = check.name.trim();
    if name.is_empty() { check.command.trim().to_string() } else { name.to_string() }
}

fn normal_command(c: &str) -> String {
    c.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase()
}

fn clip(line: &str) -> String {
    let t = line.trim_end_matches('\r');
    if t.chars().count() > MAX_EVIDENCE {
        format!("{}…", t.chars().take(MAX_EVIDENCE).collect::<String>())
    } else {
        t.to_string()
    }
}

/// A check made ready to run. `Err` names the check and says what is wrong.
pub fn compile(check: &Check) -> Result<Regex, String> {
    let who = label(check);
    if check.command.trim().is_empty() {
        return Err(format!("check `{who}` has no command"));
    }
    if check.pattern.is_empty() {
        return Err(format!("check `{who}` has nothing to look for"));
    }
    if check.pattern.len() > MAX_PATTERN {
        return Err(format!("check `{who}`: the pattern is longer than {MAX_PATTERN} characters"));
    }
    let source = match check.expect {
        Expect::Contains | Expect::NotContains => regex::escape(&check.pattern),
        Expect::Matches | Expect::NotMatches => check.pattern.clone(),
    };
    RegexBuilder::new(&source)
        .case_insensitive(check.ignore_case)
        .multi_line(true)
        .size_limit(REGEX_SIZE)
        .build()
        .map_err(|e| {
            // The library's message repeats the pattern with a caret under
            // it, over several lines; the panel shows one line, so keep the
            // last, which says what is wrong.
            let text = e.to_string();
            let reason = text
                .lines()
                .rev()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .map(|l| l.trim_start_matches("error: ").to_string())
                .unwrap_or(text);
            format!("check `{who}`: the pattern is not a valid regular expression — {reason}")
        })
}

/// LT-434: the stanzas of a command's output whose heading starts with
/// `block`, each as (heading line number from 1, heading, body including
/// the heading). A stanza is a line with no leading whitespace and every
/// indented line that follows it — which is how every CLI this reads lays
/// its configuration out.
pub fn stanzas<'a>(output: &'a str, block: &str) -> Vec<(usize, &'a str, String)> {
    let want = normal_command(block);
    let lines: Vec<&str> = output.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let heading = !line.is_empty() && !line.starts_with([' ', '\t']);
        if heading && normal_command(line).starts_with(&want) {
            let mut body = vec![line];
            let mut j = i + 1;
            while j < lines.len() && (lines[j].starts_with([' ', '\t']) || lines[j].is_empty()) {
                body.push(lines[j]);
                j += 1;
            }
            out.push((i + 1, line, body.join("\n")));
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// LT-434: one check against every stanza of its block. The first stanza
/// that decides the verdict is named; a pass says how many were read.
pub fn evaluate_blocks(check: &Check, re: &Regex, output: &str) -> (Verdict, Option<usize>, Option<String>, Option<String>, String) {
    let found = stanzas(output, &check.block);
    if found.is_empty() {
        return (
            Verdict::NotApplicable,
            None,
            None,
            None,
            format!("no `{}` block in this output", check.block.trim()),
        );
    }
    let wanted = matches!(check.expect, Expect::Contains | Expect::Matches);
    for (at, heading, body) in &found {
        let (verdict, line, evidence, why) = evaluate(check, re, body);
        if verdict == Verdict::Fail {
            // The line within the stanza, as a line of the whole output.
            let line = line.map(|l| at + l - 1).or(Some(*at));
            let evidence = evidence.or_else(|| Some(clip(heading)));
            return (Verdict::Fail, line, evidence, Some(heading.to_string()), format!("{why} in `{}`", clip(heading)));
        }
    }
    let n = found.len();
    let what = if wanted { "has" } else { "is free of" };
    (
        Verdict::Pass,
        None,
        None,
        None,
        format!("every `{}` block ({n}) {what} {}", check.block.trim(), describe(check)),
    )
}

fn describe(check: &Check) -> String {
    match check.expect {
        Expect::Contains | Expect::NotContains => format!("`{}`", check.pattern),
        Expect::Matches | Expect::NotMatches => format!("/{}/", check.pattern),
    }
}

/// One check against one command's output.
pub fn evaluate(check: &Check, re: &Regex, output: &str) -> (Verdict, Option<usize>, Option<String>, String) {
    let hit = re.find(output).map(|m| {
        let start = output[..m.start()].rfind('\n').map_or(0, |i| i + 1);
        let end = output[m.end()..].find('\n').map_or(output.len(), |i| m.end() + i);
        let line = output[..m.start()].matches('\n').count() + 1;
        (line, clip(&output[start..end.max(start)]))
    });
    let what = match check.expect {
        Expect::Contains | Expect::NotContains => format!("`{}`", check.pattern),
        Expect::Matches | Expect::NotMatches => format!("/{}/", check.pattern),
    };
    let wanted = matches!(check.expect, Expect::Contains | Expect::Matches);
    match (wanted, hit) {
        (true, Some((n, l))) => (Verdict::Pass, Some(n), Some(l), format!("found {what}")),
        (true, None) => (Verdict::Fail, None, None, format!("no line has {what}")),
        (false, None) => (Verdict::Pass, None, None, format!("no line has {what}")),
        (false, Some((n, l))) => (Verdict::Fail, Some(n), Some(l), format!("found {what}")),
    }
}

/// Every check against every device's show-command capture in one run.
///
/// Devices without a show-command capture in that run are left out — there
/// is nothing to check. A device whose capture lacks the command is reported
/// as *not captured* rather than failed: that is a gap in the collection, not
/// an answer from the network, and the two must not be confused.
///
/// LT-434: `roles` says what each device is, by its folder name, so a check
/// written for routers is *not applicable* to a switch rather than failed.
pub fn run_checks(
    root: &Path,
    stamp: &str,
    checks: &[Check],
    roles: &std::collections::HashMap<String, String>,
) -> Result<Vec<CheckResult>, String> {
    valid_stamp(stamp)?;
    if checks.is_empty() {
        return Err("add a check first".into());
    }
    // Every check compiles before any file is read, so one bad pattern is
    // reported by name instead of half a result table.
    let compiled = checks
        .iter()
        .map(|c| compile(c).map(|re| (c, re)))
        .collect::<Result<Vec<_>, _>>()?;

    let mut out = Vec::new();
    for (device, dir) in device_dirs(root) {
        let Some((_, _, path)) = captures_in(&dir)
            .into_iter()
            .find(|(s, k, _)| s == stamp && *k == BackupKind::ShowCommands)
        else {
            continue;
        };
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("could not read {}: {e}", path.display()))?;
        let found = sections(&text);
        for (check, re) in &compiled {
            let want = normal_command(&check.command);
            let base = |verdict, line, evidence, why| CheckResult {
                device: device.clone(),
                check_id: check.id.clone(),
                verdict,
                severity: check.severity,
                block: None,
                line,
                evidence,
                why,
            };
            // LT-434: a check for other roles is not an answer about this device.
            if !check.roles.is_empty() {
                let role = roles.get(&device).map(String::as_str).unwrap_or("");
                if !check.roles.iter().any(|r| r.eq_ignore_ascii_case(role)) {
                    let named = if role.is_empty() { "a device with no role".to_string() } else { format!("a {role}") };
                    out.push(base(
                        Verdict::NotApplicable,
                        None,
                        None,
                        format!("for {} only, and this is {named}", check.roles.join(", ")),
                    ));
                    continue;
                }
            }
            out.push(match found.iter().find(|s| normal_command(&s.command) == want) {
                None => base(
                    Verdict::NotCaptured,
                    None,
                    None,
                    format!("`{}` is not in this device's capture", check.command.trim()),
                ),
                Some(s) if s.rejected => base(
                    Verdict::Rejected,
                    None,
                    s.output.lines().next().map(clip),
                    "the device did not accept this command".into(),
                ),
                Some(s) if !check.block.trim().is_empty() => {
                    let (verdict, line, evidence, block, why) = evaluate_blocks(check, re, &s.output);
                    CheckResult { block, ..base(verdict, line, evidence, why) }
                }
                Some(s) => {
                    let (verdict, line, evidence, why) = evaluate(check, re, &s.output);
                    base(verdict, line, evidence, why)
                }
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{write_capture, write_show_capture};
    use crate::showcmd::{render, Section};
    use std::path::PathBuf;

    // Invented output, RFC 5737 addresses (D-027).
    const ROUTES: &str = "Codes: C - connected, S - static\n\nS*    0.0.0.0/0 [1/0] via 192.0.2.254\nC     192.0.2.0/24 is directly connected, Vlan10";
    const LOG: &str = "*Mar  1 00:01:02: %SYS-5-CONFIG_I: Configured from console\n*Mar  1 00:02:03: %LINK-3-UPDOWN: Interface Gi0/1, changed state to down";

    fn check(expect: Expect, command: &str, pattern: &str) -> Check {
        Check {
            id: "c".into(),
            name: String::new(),
            command: command.into(),
            expect,
            pattern: pattern.into(),
            ignore_case: false,
            block: String::new(),
            severity: Severity::Warning,
            roles: Vec::new(),
        }
    }

    // Invented configuration, the shape every CLI this reads lays out (D-027).
    const CONFIG: &str = "hostname SW1\n!\ninterface GigabitEthernet0/1\n switchport mode access\n spanning-tree bpduguard enable\n!\ninterface GigabitEthernet0/2\n switchport mode access\n!\ninterface Vlan1\n no ip address\n shutdown\n!\nline vty 0 4\n transport input ssh\n!\nend";

    /// LT-434: a block check runs once per stanza and names the first one
    /// that decides it, as a line of the whole output.
    #[test]
    fn a_block_check_names_the_stanza_that_fails_and_counts_the_ones_that_pass() {
        let mut c = check(Expect::Contains, "show running-config", "bpduguard enable");
        c.block = "interface Gigabit".into();
        let re = compile(&c).unwrap();
        let (v, line, evidence, block, why) = evaluate_blocks(&c, &re, CONFIG);
        assert_eq!(v, Verdict::Fail);
        assert_eq!(block.as_deref(), Some("interface GigabitEthernet0/2"));
        assert_eq!(line, Some(7), "the heading of the stanza that lacks it, as a line of the output");
        assert!(why.contains("GigabitEthernet0/2"), "{why}");
        assert!(evidence.is_some());

        c.block = "line vty".into();
        c.pattern = "transport input ssh".into();
        let re = compile(&c).unwrap();
        let (v, _, _, block, why) = evaluate_blocks(&c, &re, CONFIG);
        assert_eq!((v, block), (Verdict::Pass, None));
        assert!(why.contains("(1)"), "{why}");

        // Does-not-contain fails on the first stanza that has it, at its line.
        let mut n = check(Expect::NotContains, "show running-config", "shutdown");
        n.block = "interface".into();
        let re = compile(&n).unwrap();
        let (v, line, evidence, block, _) = evaluate_blocks(&n, &re, CONFIG);
        assert_eq!((v, block.as_deref()), (Verdict::Fail, Some("interface Vlan1")));
        assert_eq!(line, Some(12), "the `shutdown` line, counted through the whole output");
        assert_eq!(evidence.as_deref(), Some(" shutdown"));

        // A block the output has none of is not an answer.
        let mut o = check(Expect::Contains, "show running-config", "x");
        o.block = "router bgp".into();
        let re = compile(&o).unwrap();
        assert_eq!(evaluate_blocks(&o, &re, CONFIG).0, Verdict::NotApplicable);
    }

    /// LT-434: the stanza splitter reads indentation, not punctuation, and a
    /// blank line does not end a stanza.
    #[test]
    fn stanzas_are_headings_with_their_indented_lines() {
        let found = stanzas(CONFIG, "interface");
        assert_eq!(found.iter().map(|(_, h, _)| *h).collect::<Vec<_>>(), ["interface GigabitEthernet0/1", "interface GigabitEthernet0/2", "interface Vlan1"]);
        assert_eq!(found[0].0, 3);
        assert!(found[0].2.contains("bpduguard"));
        assert!(!found[0].2.contains("Vlan1"));
        assert!(stanzas(CONFIG, "INTERFACE  vlan").len() == 1, "case and spacing are ignored");
    }

    fn run(c: &Check, output: &str) -> (Verdict, Option<usize>, Option<String>, String) {
        evaluate(c, &compile(c).unwrap(), output)
    }

    #[test]
    fn contains_passes_and_quotes_the_line_that_decided_it() {
        let (v, line, evidence, _) = run(&check(Expect::Contains, "show ip route", "0.0.0.0/0"), ROUTES);
        assert_eq!(v, Verdict::Pass);
        assert_eq!(line, Some(3));
        assert_eq!(evidence.as_deref(), Some("S*    0.0.0.0/0 [1/0] via 192.0.2.254"));
    }

    #[test]
    fn contains_is_literal_so_dots_and_brackets_mean_themselves() {
        // As a regex `0.0.0.0/0` would also match `010203040/0`.
        assert_eq!(run(&check(Expect::Contains, "x", "0.0.0.0/0"), "010203040/0").0, Verdict::Fail);
        assert_eq!(run(&check(Expect::Contains, "x", "[1/0]"), ROUTES).0, Verdict::Pass);
    }

    #[test]
    fn does_not_contain_fails_on_the_offending_line() {
        let (v, line, evidence, why) = run(&check(Expect::NotContains, "show logging", "UPDOWN"), LOG);
        assert_eq!(v, Verdict::Fail);
        assert_eq!(line, Some(2));
        assert!(evidence.unwrap().contains("Gi0/1, changed state to down"));
        assert!(why.contains("found"));
        assert_eq!(run(&check(Expect::NotContains, "show logging", "TRACEBACK"), LOG).0, Verdict::Pass);
    }

    #[test]
    fn case_is_respected_unless_told_otherwise() {
        let mut c = check(Expect::Contains, "show logging", "updown");
        assert_eq!(run(&c, LOG).0, Verdict::Fail);
        c.ignore_case = true;
        assert_eq!(run(&c, LOG).0, Verdict::Pass);
    }

    #[test]
    fn matches_anchors_to_lines() {
        assert_eq!(run(&check(Expect::Matches, "show ip route", r"^C\s+192\.0\.2\.0/24"), ROUTES).0, Verdict::Pass);
        assert_eq!(run(&check(Expect::Matches, "show ip route", r"^0\.0\.0\.0"), ROUTES).0, Verdict::Fail);
        let (v, line, _, _) = run(&check(Expect::NotMatches, "show ip route", r"via 192\.0\.2\.\d+$"), ROUTES);
        assert_eq!((v, line), (Verdict::Fail, Some(3)));
    }

    #[test]
    fn a_bad_pattern_is_refused_by_name_before_anything_runs() {
        let mut c = check(Expect::Matches, "show ip route", "(unclosed");
        c.name = "Default route".into();
        let err = compile(&c).unwrap_err();
        assert!(err.contains("`Default route`"), "{err}");
        // One line, ending in what is wrong — not the library's caret diagram.
        assert!(!err.contains('\n'), "{err}");
        assert!(err.ends_with("unclosed group"), "{err}");
        assert!(compile(&check(Expect::Contains, "show ip route", "")).unwrap_err().contains("nothing to look for"));
        assert!(compile(&check(Expect::Contains, "  ", "x")).unwrap_err().contains("no command"));
        assert!(compile(&check(Expect::Matches, "x", &"a".repeat(1001))).is_err());
        // Enormous once compiled, though short to type.
        assert!(compile(&check(Expect::Matches, "x", r"\w{1000}{1000}")).is_err());
    }

    fn temp_root(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coreview-checks-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const STAMP: &str = "20260828-110000";

    fn show(root: &Path, device: &str, parts: &[(&str, &str, bool)]) {
        let secs: Vec<Section> = parts
            .iter()
            .map(|(c, o, r)| Section { command: c.to_string(), output: o.to_string(), rejected: *r })
            .collect();
        write_show_capture(root, device, "", "", None, STAMP, &render(device, "", STAMP, &secs)).unwrap();
    }

    #[test]
    fn a_run_is_checked_on_every_device_with_show_commands() {
        let root = temp_root("run");
        show(&root, "SW-A", &[("show ip route", ROUTES, false), ("show logging", LOG, false)]);
        show(&root, "SW-B", &[("show ip route", "C 198.51.100.0/24", false), ("show bogus", "% Invalid input", true)]);
        // A device with only a configuration in this run has nothing to check.
        write_capture(&root, "SW-C", "", STAMP, BackupKind::Running, "version 15.2\n!\nhostname SW-C\n!\nend").unwrap();

        let checks = vec![
            Check { id: "route".into(), ..check(Expect::Contains, "SHOW  ip route", "0.0.0.0/0") },
            Check { id: "log".into(), ..check(Expect::NotContains, "show logging", "UPDOWN") },
            Check { id: "bogus".into(), ..check(Expect::Contains, "show bogus", "x") },
        ];
        let got = run_checks(&root, STAMP, &checks, &Default::default()).unwrap();
        let find = |d: &str, id: &str| got.iter().find(|r| r.device == d && r.check_id == id).unwrap();

        assert_eq!(got.len(), 6, "two devices, three checks — SW-C left out");
        assert_eq!(find("SW-A", "route").verdict, Verdict::Pass, "command matched with case and spacing ignored");
        assert_eq!(find("SW-B", "route").verdict, Verdict::Fail);
        assert_eq!(find("SW-A", "log").verdict, Verdict::Fail);
        assert_eq!(find("SW-B", "log").verdict, Verdict::NotCaptured);
        assert_eq!(find("SW-B", "bogus").verdict, Verdict::Rejected);
        assert_eq!(find("SW-A", "bogus").verdict, Verdict::NotCaptured);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_run_that_is_not_a_stamp_or_no_checks_is_refused() {
        let root = temp_root("refuse");
        let c = vec![check(Expect::Contains, "show version", "x")];
        assert!(run_checks(&root, "../../etc", &c, &Default::default()).is_err());
        assert!(run_checks(&root, STAMP, &[], &Default::default()).unwrap_err().contains("add a check"));
        let bad = vec![check(Expect::Matches, "show version", "(")];
        assert!(run_checks(&root, STAMP, &bad, &Default::default()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
