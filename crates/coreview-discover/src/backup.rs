//! Where a configuration backup goes, and what it is called.
//!
//! Backups live in a folder the user picks, outside the project file and
//! outside anything export touches. That separation is deliberate: a running
//! configuration contains SNMP communities, hashed local passwords, keys and
//! ACLs, and a `.coreview` project someone emails a colleague must not carry
//! any of it.
//!
//! The security-relevant part of this module is naming. A backup path is built
//! from a device name, and device names come off the network — CDP and LLDP
//! report whatever the device calls itself. A device named
//! `../../../etc/cron.d/x` must not be able to steer a write out of the backup
//! folder, so every component is sanitised here rather than trusted, and the
//! result is checked to still be inside the root.

use std::path::{Component, Path, PathBuf};

/// Longest a single path component may be. Most filesystems stop at 255 bytes;
/// leaving room for the timestamp suffix keeps the whole name legal.
const MAX_COMPONENT: usize = 96;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BackupPathError {
    #[error("no backup folder has been chosen yet")]
    NoRoot,
    #[error("the device has no name or address to file the backup under")]
    NoName,
    #[error("that name does not produce a path inside the backup folder")]
    Escapes,
    #[error("{0}")]
    BadPattern(String),
}

/// The filename every capture had before patterns existed (LT-151), and still
/// the default: sortable, and it says what it is.
pub const DEFAULT_PATTERN: &str = "{stamp}-{kind}";

/// Every token a filename pattern may use.
pub const PATTERN_TOKENS: &[&str] = &["{stamp}", "{kind}", "{device}", "{address}", "{site}", "{date}"];

/// Longest a rendered filename may be before `.txt`. `capture_path` sanitises
/// the name the browser hands back with `safe_component`, which stops at
/// `MAX_COMPONENT`; a longer name would come back cut short and name a
/// different file.
const MAX_STEM: usize = MAX_COMPONENT - 4;

/// Longest any one device-supplied token may be, so a long hostname cannot
/// push the stamp or kind off the end of the name.
const MAX_TOKEN: usize = 32;

/// Whether a filename pattern can be used. `Err` says why, in words a person
/// can act on.
///
/// `{stamp}` and `{kind}` are required, not style: without the stamp a second
/// run overwrites the first, and without the kind the running and startup
/// configurations of one run overwrite each other. Both are also what the
/// browser sorts and matches captures by.
pub fn check_pattern(pattern: &str) -> Result<(), String> {
    let p = pattern.trim();
    if p.is_empty() {
        return Err("the file name pattern is empty".into());
    }
    for required in ["{stamp}", "{kind}"] {
        if !p.contains(required) {
            return Err(format!(
                "the file name pattern needs {required} — without it one capture would overwrite another"
            ));
        }
    }
    // Anything in braces must be a known token, so a typo such as `{sit}`
    // is caught here instead of becoming literal text in every filename.
    let mut rest = p;
    while let Some(open) = rest.find('{') {
        let after = &rest[open..];
        let Some(close) = after.find('}') else {
            return Err("the file name pattern has a `{` with no closing `}`".into());
        };
        let token = &after[..=close];
        if !PATTERN_TOKENS.contains(&token) {
            return Err(format!(
                "{token} is not a file name token; use {}",
                PATTERN_TOKENS.join(", ")
            ));
        }
        rest = &after[close + 1..];
    }
    if rest.contains('}') {
        return Err("the file name pattern has a `}` with no opening `{`".into());
    }
    Ok(())
}

/// A device-supplied value cut down to something that fits in a filename.
fn token_value(raw: &str, cap: usize) -> String {
    safe_component(raw)
        .map(|s| s.chars().take(cap).collect::<String>())
        .map(|s| s.trim_matches(|c| c == '-' || c == '.').to_string())
        .unwrap_or_default()
}

/// `20260828-101530` as `2026-08-28`, or empty when it is not a stamp.
fn date_of(stamp: &str) -> String {
    let b = stamp.as_bytes();
    if b.len() >= 8 && b[..8].iter().all(u8::is_ascii_digit) {
        format!("{}-{}-{}", &stamp[0..4], &stamp[4..6], &stamp[6..8])
    } else {
        String::new()
    }
}

/// The filename one capture gets from a pattern, `.txt` included.
///
/// Every token is sanitised on its own and the whole name again, so nothing a
/// device calls itself and nothing typed into the pattern can put a separator
/// in the name — the result is always one component inside the device's own
/// folder. The stamp and kind are checked to have survived.
pub fn render_filename(
    pattern: &str,
    name: &str,
    address: &str,
    site: &str,
    stamp: &str,
    kind: BackupKind,
) -> Result<String, BackupPathError> {
    check_pattern(pattern).map_err(BackupPathError::BadPattern)?;
    let stamp = safe_component(stamp).ok_or(BackupPathError::NoName)?;
    let pattern = pattern.trim();
    let render = |cap: usize| {
        let device = {
            let d = token_value(name, cap);
            if d.is_empty() { token_value(address, cap) } else { d }
        };
        let text = pattern
            .replace("{stamp}", &stamp)
            .replace("{kind}", kind.slug())
            .replace("{device}", &device)
            .replace("{address}", &token_value(address, cap))
            .replace("{site}", &token_value(site, cap))
            .replace("{date}", &date_of(&stamp));
        // Without `safe_component`'s own cut-off, so a name that is still too
        // long is refused below rather than silently losing its end.
        sanitise_unbounded(&text)
    };
    // What a device calls itself is shortened until the name fits, so a long
    // hostname still gets its backup. Only the pattern's own text can leave it
    // too long. At most MAX_TOKEN small renders, and only for long names.
    let mut cap = MAX_TOKEN;
    let mut stem = render(cap);
    while stem.len() > MAX_STEM && cap > 0 {
        cap -= 1;
        stem = render(cap);
    }
    if stem.len() > MAX_STEM {
        return Err(BackupPathError::BadPattern(format!(
            "the file name pattern makes names longer than {MAX_STEM} characters"
        )));
    }
    if !stem.contains(&stamp) || !stem.contains(kind.slug()) {
        return Err(BackupPathError::BadPattern(
            "the file name pattern lost the stamp or kind once cleaned up".into(),
        ));
    }
    Ok(format!("{stem}.txt"))
}

/// `safe_component`'s rule without its length limit.
fn sanitise_unbounded(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_dash = false;
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
            out.push(ch);
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches(|c| c == '-' || c == '.').to_string()
}

/// The `20260828-101530` stamp inside a filename, wherever the pattern put it.
/// Captures are ordered by this, so a pattern that starts with the site still
/// lists newest first.
pub fn stamp_in(filename: &str) -> Option<&str> {
    let b = filename.as_bytes();
    (0..b.len().saturating_sub(14)).find_map(|i| {
        let w = &b[i..i + 15];
        let shaped = w[..8].iter().all(u8::is_ascii_digit)
            && w[8] == b'-'
            && w[9..].iter().all(u8::is_ascii_digit);
        let bounded = (i == 0 || !b[i - 1].is_ascii_digit())
            // `map_or`, not `is_none_or`: the crate's MSRV is 1.77.
            && b.get(i + 15).map_or(true, |c| !c.is_ascii_digit());
        (shaped && bounded).then(|| &filename[i..i + 15])
    })
}

/// Reduces arbitrary text to one safe path component.
///
/// Keeps letters, digits, dot, dash and underscore; everything else becomes a
/// dash. Leading dots are dropped, so `..` and `.hidden` cannot survive, and
/// the result is truncated and trimmed. Returns `None` when nothing usable is
/// left, which the caller must treat as "use the address instead" rather than
/// inventing a name.
pub fn safe_component(raw: &str) -> Option<String> {
    let mut out = String::with_capacity(raw.len().min(MAX_COMPONENT));
    let mut last_dash = false;
    for ch in raw.trim().chars() {
        let keep = ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_';
        if keep {
            out.push(ch);
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= MAX_COMPONENT {
            break;
        }
    }
    // A component that is only dots is `.` or `..`, both of which move around
    // the tree rather than naming anything.
    let trimmed = out.trim_matches(|c| c == '-' || c == '.').to_string();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed)
}

/// Timestamp used in backup filenames: `20260828-101530`.
///
/// Sortable as text, so a directory listing is in chronological order without
/// anything having to parse it. Takes the parts rather than reading the clock
/// so the caller decides the timezone and tests are deterministic.
pub fn stamp(year: i32, month: u32, day: u32, hour: u32, minute: u32, second: u32) -> String {
    format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}")
}

/// Where one device's backups live: `<root>/<device>/`.
///
/// `name` is the device name and `address` the fallback, used when the name
/// sanitises away to nothing — which happens with names that are entirely
/// punctuation, and with a hostile name that was all path separators.
pub fn device_dir(root: &Path, name: &str, address: &str) -> Result<PathBuf, BackupPathError> {
    if root.as_os_str().is_empty() {
        return Err(BackupPathError::NoRoot);
    }
    let component = safe_component(name)
        .or_else(|| safe_component(address))
        .ok_or(BackupPathError::NoName)?;

    let dir = root.join(&component);
    // Belt and braces. `safe_component` should make this impossible, but the
    // cost of being wrong is a write outside the backup folder.
    if !is_inside(root, &dir) {
        return Err(BackupPathError::Escapes);
    }
    Ok(dir)
}

/// Full path for one backup: `<root>/<device>/<stamp>-running-config.txt`.
pub fn backup_path(
    root: &Path,
    name: &str,
    address: &str,
    stamp: &str,
    kind: BackupKind,
) -> Result<PathBuf, BackupPathError> {
    backup_path_named(root, name, address, "", stamp, kind, None)
}

/// Full path for one backup with a filename pattern (LT-151). The folder is
/// still `<root>/<device>/` whatever the pattern says: the pattern names the
/// file, never where it goes.
pub fn backup_path_named(
    root: &Path,
    name: &str,
    address: &str,
    site: &str,
    stamp: &str,
    kind: BackupKind,
    pattern: Option<&str>,
) -> Result<PathBuf, BackupPathError> {
    let dir = device_dir(root, name, address)?;
    let pattern = pattern.map(str::trim).filter(|p| !p.is_empty()).unwrap_or(DEFAULT_PATTERN);
    let file = render_filename(pattern, name, address, site, stamp, kind)?;
    let path = dir.join(file);
    if !is_inside(root, &path) {
        return Err(BackupPathError::Escapes);
    }
    Ok(path)
}

/// Which configuration was captured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackupKind {
    Running,
    Startup,
    /// A list of show commands the operator wrote, filed as one file (LT-149).
    ShowCommands,
}

impl BackupKind {
    pub fn slug(&self) -> &'static str {
        match self {
            BackupKind::Running => "running-config",
            BackupKind::Startup => "startup-config",
            BackupKind::ShowCommands => "show-commands",
        }
    }

    /// The command that produces it. Kept beside the kind so the two cannot
    /// drift apart. `None` for show commands, which are a list the operator
    /// writes rather than one command this file knows.
    pub fn command(&self) -> Option<&'static str> {
        match self {
            BackupKind::Running => Some("show running-config"),
            BackupKind::Startup => Some("show startup-config"),
            BackupKind::ShowCommands => None,
        }
    }
}

/// Whether `path` is `root` or sits underneath it, comparing component by
/// component so `/backups-elsewhere` is not treated as inside `/backups`.
///
/// Purely lexical, and deliberately so: it must give the same answer whether
/// or not the path exists yet, since backups are written into folders that are
/// created on demand.
pub fn is_inside(root: &Path, path: &Path) -> bool {
    let normal = |p: &Path| -> Option<Vec<String>> {
        let mut parts = Vec::new();
        for c in p.components() {
            match c {
                Component::Normal(s) => parts.push(s.to_string_lossy().to_string()),
                Component::CurDir => {}
                // A parent component means the path climbs, and a lexical
                // check cannot safely decide where it lands.
                Component::ParentDir => return None,
                Component::RootDir => parts.push("/".into()),
                Component::Prefix(p) => parts.push(p.as_os_str().to_string_lossy().to_string()),
            }
        }
        Some(parts)
    };
    let (Some(r), Some(p)) = (normal(root), normal(path)) else {
        return false;
    };
    p.len() >= r.len() && r.iter().zip(p.iter()).all(|(a, b)| a == b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        PathBuf::from("/home/user/backups")
    }

    #[test]
    fn an_ordinary_device_gets_an_ordinary_path() {
        let p = backup_path(&root(), "CORE-SW-01", "10.1.1.1", "20260828-101530", BackupKind::Running).unwrap();
        assert_eq!(
            p,
            PathBuf::from("/home/user/backups/CORE-SW-01/20260828-101530-running-config.txt")
        );
    }

    #[test]
    fn a_hostile_device_name_cannot_escape_the_backup_folder() {
        // Device names come off the network. This is the whole reason this
        // module exists rather than the paths being built inline.
        for hostile in [
            "../../../etc/cron.d/x",
            "..",
            "../..",
            "/etc/passwd",
            "..\\..\\windows\\system32",
            "....//....//etc",
        ] {
            let p = backup_path(&root(), hostile, "10.1.1.1", "20260828-101530", BackupKind::Running)
                .expect("should fall back to a safe name, not fail");
            assert!(
                is_inside(&root(), &p),
                "{hostile:?} produced {p:?}, which is outside the backup folder"
            );
            assert!(!p.to_string_lossy().contains(".."), "{hostile:?} left a parent reference in {p:?}");
        }
    }

    #[test]
    fn a_name_that_sanitises_to_nothing_falls_back_to_the_address() {
        // "../.." is all separators and dots; there is no name left.
        let p = backup_path(&root(), "../..", "10.1.1.9", "20260828-101530", BackupKind::Running).unwrap();
        assert_eq!(
            p,
            PathBuf::from("/home/user/backups/10.1.1.9/20260828-101530-running-config.txt")
        );
    }

    #[test]
    fn a_device_with_neither_name_nor_address_is_refused() {
        // Inventing a name would file a backup somewhere nobody can find it.
        let err = backup_path(&root(), "", "", "20260828-101530", BackupKind::Running).unwrap_err();
        assert_eq!(err, BackupPathError::NoName);
    }

    #[test]
    fn no_backup_folder_chosen_is_its_own_error() {
        // Distinct from a bad name, because the UI response differs: one asks
        // the user to pick a folder, the other is a device problem.
        let err = backup_path(Path::new(""), "SW1", "10.1.1.1", "20260828-101530", BackupKind::Running)
            .unwrap_err();
        assert_eq!(err, BackupPathError::NoRoot);
    }

    #[test]
    fn spaces_and_punctuation_become_dashes_without_doubling_up() {
        assert_eq!(safe_component("Core Switch #1").unwrap(), "Core-Switch-1");
        assert_eq!(safe_component("a///b").unwrap(), "a-b");
        assert_eq!(safe_component("  padded  ").unwrap(), "padded");
    }

    #[test]
    fn an_fqdn_survives_intact() {
        // Dots are legal in a filename and an FQDN is a perfectly good folder
        // name; only leading dots are a problem.
        assert_eq!(safe_component("sw1.lab.example.com").unwrap(), "sw1.lab.example.com");
    }

    #[test]
    fn leading_dots_are_stripped_so_nothing_becomes_hidden_or_relative() {
        assert_eq!(safe_component(".hidden").unwrap(), "hidden");
        assert_eq!(safe_component("."), None);
        assert_eq!(safe_component(".."), None);
        assert_eq!(safe_component("..."), None);
    }

    #[test]
    fn a_very_long_name_is_truncated_to_a_legal_component() {
        let long = "A".repeat(500);
        let c = safe_component(&long).unwrap();
        assert!(c.len() <= MAX_COMPONENT, "component was {} bytes", c.len());
    }

    #[test]
    fn is_inside_is_not_fooled_by_a_shared_prefix() {
        // "/home/user/backups-elsewhere" starts with the root as a *string*
        // but is not inside it.
        assert!(is_inside(&root(), Path::new("/home/user/backups/sw1/x.txt")));
        assert!(is_inside(&root(), &root()));
        assert!(!is_inside(&root(), Path::new("/home/user/backups-elsewhere/x.txt")));
        assert!(!is_inside(&root(), Path::new("/home/user")));
        assert!(!is_inside(&root(), Path::new("/etc/passwd")));
    }

    #[test]
    fn is_inside_refuses_to_judge_a_path_that_climbs() {
        // A lexical check cannot say where "root/../.." lands, so it says no.
        assert!(!is_inside(&root(), Path::new("/home/user/backups/../../etc")));
    }

    #[test]
    fn timestamps_sort_chronologically_as_text() {
        let a = stamp(2026, 8, 28, 9, 5, 3);
        let b = stamp(2026, 8, 28, 10, 15, 30);
        let c = stamp(2026, 12, 1, 0, 0, 0);
        assert_eq!(a, "20260828-090503");
        assert!(a < b && b < c, "a directory listing should be in time order");
    }

    #[test]
    fn each_kind_carries_its_own_command_and_suffix() {
        assert_eq!(BackupKind::Running.command(), Some("show running-config"));
        assert_eq!(BackupKind::Startup.command(), Some("show startup-config"));
        assert_eq!(BackupKind::ShowCommands.command(), None);
        assert_eq!(BackupKind::ShowCommands.slug(), "show-commands");
        let r = backup_path(&root(), "SW1", "", "20260828-101530", BackupKind::Startup).unwrap();
        assert!(r.to_string_lossy().ends_with("startup-config.txt"));
    }

    #[test]
    fn windows_style_roots_stay_inside_themselves() {
        let win = Path::new(r"C:\Users\me\backups");
        let p = win.join("SW1").join("x.txt");
        assert!(is_inside(win, &p));
        assert!(!is_inside(win, Path::new(r"C:\Users\me\other\x.txt")));
    }

    // ------------------------------------------------------ patterns (LT-151)

    #[test]
    fn the_default_pattern_names_files_exactly_as_before() {
        let old = backup_path(&root(), "SW1", "192.0.2.1", "20260828-101530", BackupKind::Startup).unwrap();
        let named = backup_path_named(
            &root(), "SW1", "192.0.2.1", "LAB", "20260828-101530", BackupKind::Startup, Some(DEFAULT_PATTERN),
        )
        .unwrap();
        assert_eq!(old, root().join("SW1").join("20260828-101530-startup-config.txt"));
        assert_eq!(old, named);
        // A blank pattern is the default, not an error.
        let blank = backup_path_named(
            &root(), "SW1", "192.0.2.1", "", "20260828-101530", BackupKind::Startup, Some("  "),
        )
        .unwrap();
        assert_eq!(old, blank);
    }

    #[test]
    fn a_pattern_fills_every_token_from_the_device() {
        let f = render_filename(
            "{site}_{device}_{date}_{address}_{stamp}_{kind}",
            "EDGE-01", "192.0.2.7", "Lab Two", "20260828-101530", BackupKind::Running,
        )
        .unwrap();
        assert_eq!(f, "Lab-Two_EDGE-01_2026-08-28_192.0.2.7_20260828-101530_running-config.txt");
    }

    #[test]
    fn a_pattern_can_never_leave_the_device_folder() {
        for (pattern, name, site) in [
            ("../../{stamp}-{kind}", "SW1", ""),
            ("{site}/{stamp}-{kind}", "SW1", "../../etc"),
            (r"..\..\{device}-{stamp}-{kind}", r"..\..\evil", "x"),
            ("{device}-{stamp}-{kind}", "../../../../tmp/x", "/"),
        ] {
            let p = backup_path_named(&root(), name, "192.0.2.1", site, "20260828-101530", BackupKind::Running, Some(pattern))
                .unwrap();
            assert!(is_inside(&root(), &p), "{pattern} escaped: {}", p.display());
            // One folder for the device, one file in it — nothing deeper.
            assert_eq!(p.strip_prefix(root()).unwrap().components().count(), 2, "{}", p.display());
        }
    }

    #[test]
    fn a_pattern_without_the_stamp_or_kind_is_refused() {
        assert!(check_pattern("{device}-{kind}").unwrap_err().contains("{stamp}"));
        assert!(check_pattern("{device}-{stamp}").unwrap_err().contains("{kind}"));
        assert!(check_pattern("").is_err());
        assert!(check_pattern("{stamp}-{kind}").is_ok());
    }

    #[test]
    fn an_unknown_or_broken_token_is_refused_instead_of_written_literally() {
        assert!(check_pattern("{sit}-{stamp}-{kind}").unwrap_err().contains("{sit}"));
        assert!(check_pattern("{stamp}-{kind}-{").is_err());
        assert!(check_pattern("{stamp}-{kind}}").is_err());
    }

    #[test]
    fn a_long_device_name_cannot_push_the_stamp_off_the_end() {
        let long = "A".repeat(300);
        let f = render_filename("{device}-{site}-{stamp}-{kind}", &long, "", &long, "20260828-101530", BackupKind::Running)
            .unwrap();
        assert!(f.ends_with("-20260828-101530-running-config.txt"), "{f}");
        assert!(f.len() <= MAX_COMPONENT, "{}", f.len());
        // And what the browser hands back sanitises to the same name.
        assert_eq!(safe_component(&f).as_deref(), Some(f.as_str()));
    }

    #[test]
    fn a_pattern_padded_past_the_limit_is_refused_rather_than_cut() {
        let pattern = format!("{}-{{stamp}}-{{kind}}", "x".repeat(90));
        let err = render_filename(&pattern, "SW1", "", "", "20260828-101530", BackupKind::Running).unwrap_err();
        assert!(matches!(err, BackupPathError::BadPattern(_)));
    }

    #[test]
    fn the_stamp_is_found_wherever_the_pattern_put_it() {
        assert_eq!(stamp_in("20260828-101530-running-config.txt"), Some("20260828-101530"));
        assert_eq!(stamp_in("LAB_SW1_20260828-101530_show-commands.txt"), Some("20260828-101530"));
        assert_eq!(stamp_in("no-stamp-here.txt"), None);
        assert_eq!(stamp_in("120260828-101530.txt"), None);
    }
}
