//! Compare two backup runs in a folder, the way the Backups tab does (LT-152).
//!
//! Reads only. Lists the runs it finds, then compares the two given — or the
//! newest two when none are — device by device and command by command.
//!
//! ```text
//! CV_BACKUP_DIR=/tmp/captures cargo run -p coreview-discover --example compare_runs
//! CV_BACKUP_DIR=/tmp/captures CV_BEFORE=20260828-090000 CV_AFTER=20260828-110000 \
//!   cargo run -p coreview-discover --example compare_runs
//! ```

use coreview_discover::capture::DiffLine;
use coreview_discover::compare::{compare_runs, list_runs};

fn main() {
    let root = std::path::PathBuf::from(std::env::var("CV_BACKUP_DIR").expect("set CV_BACKUP_DIR"));
    let runs = list_runs(&root);
    for r in &runs {
        println!("run {} — {} device(s), {:?}", r.stamp, r.devices, r.kinds);
    }
    let pick = |var: &str, i: usize| {
        std::env::var(var).ok().or_else(|| runs.get(i).map(|r| r.stamp.clone())).unwrap_or_else(|| {
            eprintln!("need two runs, found {}", runs.len());
            std::process::exit(2)
        })
    };
    let (before, after) = (pick("CV_BEFORE", 1), pick("CV_AFTER", 0));
    println!("\nbefore {before}  after {after}");

    match compare_runs(&root, &before, &after) {
        Err(why) => {
            eprintln!("refused: {why}");
            std::process::exit(1);
        }
        Ok(devices) => {
            for d in devices {
                println!("\n{} · {:?} — {} of {} part(s) differ", d.device, d.kind, d.changed, d.parts.len());
                for p in d.parts {
                    println!("  {:?} {}  +{} -{}{}", p.status, p.name, p.added, p.removed,
                        if p.approximate { " (compared as sets)" } else { "" });
                    for l in p.lines.iter().take(6) {
                        match l {
                            DiffLine::Added(s) => println!("    + {s}"),
                            DiffLine::Removed(s) => println!("    - {s}"),
                            DiffLine::Same(_) => {}
                        }
                    }
                }
            }
        }
    }
}
