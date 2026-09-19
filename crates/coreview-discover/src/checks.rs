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
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub device: String,
    pub check_id: String,
    pub verdict: Verdict,
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
pub fn run_checks(root: &Path, stamp: &str, checks: &[Check]) -> Result<Vec<CheckResult>, String> {
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
                line,
                evidence,
                why,
            };
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
        Check { id: "c".into(), name: String::new(), command: command.into(), expect, pattern: pattern.into(), ignore_case: false }
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
        let got = run_checks(&root, STAMP, &checks).unwrap();
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
        assert!(run_checks(&root, "../../etc", &c).is_err());
        assert!(run_checks(&root, STAMP, &[]).unwrap_err().contains("add a check"));
        let bad = vec![check(Expect::Matches, "show version", "(")];
        assert!(run_checks(&root, STAMP, &bad).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
