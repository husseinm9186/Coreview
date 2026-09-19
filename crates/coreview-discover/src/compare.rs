//! Before and after: compare two backup runs (LT-152).
//!
//! A maintenance window is judged by what the network said before against
//! what it says after. Every device in one backup run shares a stamp, so a run
//! already has an identity — `20260828-101530` — and "before" and "after" are
//! simply two runs. Nothing is stored to pair them; the operator picks.
//!
//! Configurations are compared whole. Show-command captures are compared
//! **command by command**, because the file as a whole always differs (its
//! header carries the stamp) and the question is never "did the file change"
//! but "did the routes change, did the neighbours change".
//!
//! Read-only. Nothing here writes, and a stamp that is not the shape of a stamp
//! is refused before any path is built from it.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use crate::backup::{stamp_in, BackupKind};
use crate::capture::{diff, DiffLine};
use crate::showcmd::{sections, Section};

const KINDS: [BackupKind; 3] = [BackupKind::Running, BackupKind::Startup, BackupKind::ShowCommands];

/// Most changed lines returned for one part. A window that rewrote a whole
/// routing table is summarised by its counts; the interface does not need ten
/// thousand lines to say so.
const MAX_LINES: usize = 400;

/// Above this many line pairs the line-by-line diff's table would be hundreds
/// of megabytes — a full `show ip route` against another — so the lines are
/// compared as sets instead, and the part says so.
const MAX_DIFF_CELLS: usize = 4_000_000;

/// One backup run, as the picker lists it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub stamp: String,
    pub devices: usize,
    pub kinds: Vec<BackupKind>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PartStatus {
    Same,
    Changed,
    OnlyBefore,
    OnlyAfter,
}

/// One command, or one whole configuration, in both runs.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartComparison {
    /// The command, or the kind's slug for a configuration.
    pub name: String,
    pub status: PartStatus,
    pub added: usize,
    pub removed: usize,
    /// Only the lines that differ, at most `MAX_LINES`.
    pub lines: Vec<DiffLine>,
    pub truncated: bool,
    /// Too long for a line-by-line diff; compared as sets of lines, so moved
    /// lines do not show and order is not considered.
    pub approximate: bool,
}

/// One device's capture of one kind, in both runs.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceComparison {
    pub device: String,
    pub kind: BackupKind,
    pub before: Option<String>,
    pub after: Option<String>,
    pub parts: Vec<PartComparison>,
    /// Parts that are not the same.
    pub changed: usize,
}

fn kind_of(filename: &str) -> Option<BackupKind> {
    KINDS.into_iter().find(|k| filename.contains(k.slug()))
}

/// A run's stamp, refused unless it is exactly the shape of one — so nothing
/// that reaches a lookup can be `../` or a filename. Shared with LT-153's checks.
pub(crate) fn valid_stamp(s: &str) -> Result<(), String> {
    if stamp_in(s) == Some(s) {
        Ok(())
    } else {
        Err(format!("`{s}` is not a backup run"))
    }
}

/// Every device folder under the root, by name.
pub(crate) fn device_dirs(root: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| (e.file_name().to_string_lossy().to_string(), e.path()))
        .collect();
    out.sort();
    out
}

/// Stamp, kind and path of every capture in one device folder.
pub(crate) fn captures_in(dir: &Path) -> Vec<(String, BackupKind, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "txt"))
        .filter_map(|p| {
            let f = p.file_name()?.to_string_lossy().to_string();
            let stamp = stamp_in(&f)?.to_string();
            let kind = kind_of(&f)?;
            Some((stamp, kind, p))
        })
        .collect()
}

/// Every run in the backup folder, newest first.
pub fn list_runs(root: &Path) -> Vec<RunSummary> {
    let mut runs: BTreeMap<String, (BTreeSet<String>, Vec<BackupKind>)> = BTreeMap::new();
    for (device, dir) in device_dirs(root) {
        for (stamp, kind, _) in captures_in(&dir) {
            let entry = runs.entry(stamp).or_default();
            entry.0.insert(device.clone());
            if !entry.1.contains(&kind) {
                entry.1.push(kind);
            }
        }
    }
    runs.into_iter()
        .rev()
        .map(|(stamp, (devices, mut kinds))| {
            kinds.sort_by_key(|k| KINDS.iter().position(|x| x == k));
            RunSummary { stamp, devices: devices.len(), kinds }
        })
        .collect()
}

/// Lines compared as multisets: what is in one and not the other, in the order
/// each appears. Linear, for inputs too long for `diff`.
fn set_diff(before: &str, after: &str) -> Vec<DiffLine> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for l in before.lines() {
        *counts.entry(l).or_default() += 1;
    }
    let mut added = Vec::new();
    for l in after.lines() {
        match counts.get_mut(l) {
            Some(n) if *n > 0 => *n -= 1,
            _ => added.push(DiffLine::Added(l.to_string())),
        }
    }
    let mut removed = Vec::new();
    for l in before.lines() {
        if let Some(n) = counts.get_mut(l) {
            if *n > 0 {
                *n -= 1;
                removed.push(DiffLine::Removed(l.to_string()));
            }
        }
    }
    removed.extend(added);
    removed
}

fn compare_text(name: String, before: &str, after: &str) -> PartComparison {
    let approximate = before.lines().count().saturating_mul(after.lines().count()) > MAX_DIFF_CELLS;
    let all = if approximate { set_diff(before, after) } else { diff(before, after) };
    let changes: Vec<DiffLine> = all.into_iter().filter(|l| !matches!(l, DiffLine::Same(_))).collect();
    let added = changes.iter().filter(|l| matches!(l, DiffLine::Added(_))).count();
    let removed = changes.len() - added;
    PartComparison {
        name,
        status: if changes.is_empty() { PartStatus::Same } else { PartStatus::Changed },
        added,
        removed,
        truncated: changes.len() > MAX_LINES,
        lines: changes.into_iter().take(MAX_LINES).collect(),
        approximate,
    }
}

fn only(name: String, status: PartStatus) -> PartComparison {
    PartComparison { name, status, added: 0, removed: 0, lines: Vec::new(), truncated: false, approximate: false }
}

fn compare_sections(before: &str, after: &str) -> Vec<PartComparison> {
    let (b, a) = (sections(before), sections(after));
    // A file with no headings was not written by `render`; compare it whole
    // rather than report nothing.
    if b.is_empty() && a.is_empty() {
        return vec![compare_text(BackupKind::ShowCommands.slug().to_string(), before, after)];
    }
    let mut names: Vec<&str> = b.iter().map(|s| s.command.as_str()).collect();
    for s in &a {
        if !names.contains(&s.command.as_str()) {
            names.push(&s.command);
        }
    }
    let find = |list: &[Section], name: &str| {
        list.iter().find(|s| s.command == name).map(|s| s.output.clone())
    };
    names
        .into_iter()
        .map(|name| match (find(&b, name), find(&a, name)) {
            (Some(x), Some(y)) => compare_text(name.to_string(), &x, &y),
            (Some(_), None) => only(name.to_string(), PartStatus::OnlyBefore),
            (None, _) => only(name.to_string(), PartStatus::OnlyAfter),
        })
        .collect()
}

/// Every device's captures in two runs, kind by kind, and command by command
/// for show commands. A device in only one run is listed as such rather than
/// left out — a switch that was backed up before a change and not after is
/// exactly what a window review needs to notice.
pub fn compare_runs(root: &Path, before: &str, after: &str) -> Result<Vec<DeviceComparison>, String> {
    valid_stamp(before)?;
    valid_stamp(after)?;
    if before == after {
        return Err("pick two different runs to compare".into());
    }
    let read = |p: &Option<PathBuf>| {
        p.as_ref()
            .map(|p| std::fs::read_to_string(p).map_err(|e| format!("could not read {}: {e}", p.display())))
            .transpose()
    };
    let file_name = |p: &Option<PathBuf>| {
        p.as_ref().and_then(|p| p.file_name()).map(|f| f.to_string_lossy().to_string())
    };

    let mut out = Vec::new();
    for (device, dir) in device_dirs(root) {
        let caps = captures_in(&dir);
        for kind in KINDS {
            let find = |stamp: &str| {
                caps.iter().find(|(s, k, _)| s == stamp && *k == kind).map(|(_, _, p)| p.clone())
            };
            let (b, a) = (find(before), find(after));
            let parts = match (read(&b)?, read(&a)?) {
                (Some(x), Some(y)) if kind == BackupKind::ShowCommands => compare_sections(&x, &y),
                (Some(x), Some(y)) => vec![compare_text(kind.slug().to_string(), &x, &y)],
                (Some(_), None) => vec![only(kind.slug().to_string(), PartStatus::OnlyBefore)],
                (None, Some(_)) => vec![only(kind.slug().to_string(), PartStatus::OnlyAfter)],
                (None, None) => continue,
            };
            let changed = parts.iter().filter(|p| p.status != PartStatus::Same).count();
            out.push(DeviceComparison {
                device: device.clone(),
                kind,
                before: file_name(&b),
                after: file_name(&a),
                parts,
                changed,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{write_capture, write_show_capture};
    use crate::showcmd::render;

    fn temp_root(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coreview-compare-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const B: &str = "20260828-090000";
    const A: &str = "20260828-110000";
    const CONFIG: &str = "version 15.2\n!\nhostname SW1\n!\ninterface Gi0/1\n!\nend";

    fn show(root: &Path, device: &str, stamp: &str, parts: &[(&str, &str)]) {
        let secs: Vec<Section> = parts
            .iter()
            .map(|(c, o)| Section { command: c.to_string(), output: o.to_string(), rejected: false })
            .collect();
        write_show_capture(root, device, "192.0.2.1", "", None, stamp, &render(device, "192.0.2.1", stamp, &secs))
            .unwrap();
    }

    #[test]
    fn runs_are_listed_newest_first_with_their_devices_and_kinds() {
        let root = temp_root("runs");
        write_capture(&root, "SW1", "", B, BackupKind::Running, CONFIG).unwrap();
        write_capture(&root, "SW2", "", B, BackupKind::Running, CONFIG).unwrap();
        show(&root, "SW1", A, &[("show clock", "10:00")]);
        write_capture(&root, "SW1", "", A, BackupKind::Startup, CONFIG).unwrap();

        let runs = list_runs(&root);
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0], RunSummary {
            stamp: A.into(),
            devices: 1,
            kinds: vec![BackupKind::Startup, BackupKind::ShowCommands],
        });
        assert_eq!(runs[1].devices, 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn show_commands_are_compared_command_by_command() {
        let root = temp_root("sections");
        show(&root, "SW1", B, &[
            ("show clock", "09:00"),
            ("show ip route", "S 0.0.0.0/0 via 192.0.2.254\nC 192.0.2.0/24"),
            ("show cdp neighbors", "SW2 Gi0/1"),
        ]);
        show(&root, "SW1", A, &[
            ("show clock", "11:00"),
            ("show ip route", "S 0.0.0.0/0 via 192.0.2.254\nC 192.0.2.0/24\nC 198.51.100.0/24"),
            ("show cdp neighbors", "SW2 Gi0/1"),
            ("show vlan brief", "1 default"),
        ]);

        let got = compare_runs(&root, B, A).unwrap();
        assert_eq!(got.len(), 1);
        let d = &got[0];
        assert_eq!((d.device.as_str(), d.kind), ("SW1", BackupKind::ShowCommands));
        let by = |n: &str| d.parts.iter().find(|p| p.name == n).unwrap();
        assert_eq!(by("show clock").status, PartStatus::Changed);
        let route = by("show ip route");
        assert_eq!((route.status, route.added, route.removed), (PartStatus::Changed, 1, 0));
        assert_eq!(route.lines, vec![DiffLine::Added("C 198.51.100.0/24".into())]);
        assert_eq!(by("show cdp neighbors").status, PartStatus::Same);
        assert_eq!(by("show vlan brief").status, PartStatus::OnlyAfter);
        assert_eq!(d.changed, 3);
        // The header's stamp differs between the files and is not a change.
        assert!(d.parts.iter().all(|p| !p.name.starts_with('#')));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn configurations_compare_whole_and_a_device_in_one_run_is_still_listed() {
        let root = temp_root("configs");
        write_capture(&root, "SW1", "", B, BackupKind::Running, CONFIG).unwrap();
        write_capture(&root, "SW1", "", A, BackupKind::Running, &CONFIG.replace("Gi0/1", "Gi0/2")).unwrap();
        write_capture(&root, "SW-GONE", "", B, BackupKind::Running, CONFIG).unwrap();
        write_capture(&root, "SW-NEW", "", A, BackupKind::Running, CONFIG).unwrap();

        let got = compare_runs(&root, B, A).unwrap();
        let find = |n: &str| got.iter().find(|d| d.device == n).unwrap();
        let sw1 = &find("SW1").parts[0];
        assert_eq!((sw1.status, sw1.added, sw1.removed), (PartStatus::Changed, 1, 1));
        assert_eq!(find("SW-GONE").parts[0].status, PartStatus::OnlyBefore);
        assert_eq!(find("SW-NEW").parts[0].status, PartStatus::OnlyAfter);
        assert_eq!(find("SW-NEW").before, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_run_that_is_not_a_stamp_is_refused_before_any_path_is_built() {
        let root = temp_root("refuse");
        for bad in ["../../etc", "20260828-090000/../x", "", "latest"] {
            assert!(compare_runs(&root, bad, A).is_err(), "{bad} accepted");
        }
        assert!(compare_runs(&root, A, A).unwrap_err().contains("two different"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_enormous_output_is_compared_as_sets_rather_than_exhausting_memory() {
        let before: String = (0..3000).map(|i| format!("route {i}\n")).collect();
        let after = before.replace("route 7\n", "") + "route new\n";
        let part = compare_text("show ip route".into(), &before, &after);
        assert!(part.approximate);
        assert_eq!((part.added, part.removed), (1, 1));
        assert_eq!(part.lines, vec![DiffLine::Removed("route 7".into()), DiffLine::Added("route new".into())]);
    }

    #[test]
    fn a_huge_change_is_counted_in_full_but_returned_in_part() {
        let after: String = (0..1000).map(|i| format!("line {i}\n")).collect();
        let part = compare_text("show log".into(), "", &after);
        assert_eq!(part.added, 1000);
        assert_eq!(part.lines.len(), MAX_LINES);
        assert!(part.truncated);
    }
}
