//! Run checks against one backup run's show-command captures (LT-153).
//!
//! Reads only. `CV_CHECKS` holds one check per line as
//! `command => expectation => text`, where the expectation is `contains`,
//! `not-contains`, `matches` or `not-matches`. `CV_RUN` picks the run; the
//! newest one with show commands is used otherwise.
//!
//! ```text
//! CV_BACKUP_DIR=/tmp/captures \
//! CV_CHECKS=$'show clock => matches => ^\\d+:\\d+\nshow version => not-contains => Traceback' \
//!   cargo run -p coreview-discover --example run_checks
//! ```

use coreview_discover::backup::BackupKind;
use coreview_discover::checks::{run_checks, Check, Expect};
use coreview_discover::compare::list_runs;

fn main() {
    let root = std::path::PathBuf::from(std::env::var("CV_BACKUP_DIR").expect("set CV_BACKUP_DIR"));
    let run = std::env::var("CV_RUN").ok().unwrap_or_else(|| {
        list_runs(&root)
            .into_iter()
            .find(|r| r.kinds.contains(&BackupKind::ShowCommands))
            .map(|r| r.stamp)
            .unwrap_or_else(|| {
                eprintln!("no run with show commands in that folder");
                std::process::exit(2)
            })
    });

    let checks: Vec<Check> = std::env::var("CV_CHECKS")
        .expect("set CV_CHECKS")
        .lines()
        .filter(|l| !l.trim().is_empty())
        .enumerate()
        .map(|(i, l)| {
            let parts: Vec<&str> = l.splitn(3, " => ").collect();
            let [command, expect, pattern] = parts[..] else {
                eprintln!("line {}: expected `command => expectation => text`", i + 1);
                std::process::exit(2)
            };
            let expect = match expect.trim() {
                "contains" => Expect::Contains,
                "not-contains" => Expect::NotContains,
                "matches" => Expect::Matches,
                "not-matches" => Expect::NotMatches,
                other => {
                    eprintln!("line {}: unknown expectation `{other}`", i + 1);
                    std::process::exit(2)
                }
            };
            Check {
                id: format!("check-{}", i + 1),
                name: String::new(),
                command: command.trim().to_string(),
                expect,
                pattern: pattern.to_string(),
                ignore_case: false,
            }
        })
        .collect();

    println!("run {run}");
    match run_checks(&root, &run, &checks) {
        Err(why) => {
            eprintln!("refused: {why}");
            std::process::exit(1)
        }
        Ok(results) => {
            for r in results {
                let check = checks.iter().find(|c| c.id == r.check_id).map(|c| c.command.as_str()).unwrap_or("");
                println!("{:?}  {}  {check}  — {}", r.verdict, r.device, r.why);
                if let Some(e) = r.evidence {
                    println!("      line {}: {e}", r.line.map(|n| n.to_string()).unwrap_or_default());
                }
            }
        }
    }
}
