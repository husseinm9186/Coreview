//! A support capture: what a device answered, written down so a parser can be
//! corrected against it.
//!
//! Every dialect built from documentation is a hypothesis until a real device
//! has answered, and the operator's own kit is where those answers come from.
//! Keeps device output out of the debug log, and stays: this is a
//! different file, asked for by a tick on the crawl, holding **only the replies
//! to the crawl's identity commands** — never a configuration — after a
//! redaction pass, and written to a folder of its own.
//!
//! What the redaction knows: every secret the run was given (the SSH
//! password, the enable password, the fallback passwords, the SNMP
//! communities and passphrases), replaced wherever they occur; and any line
//! that names a password, secret, community, key or passphrase, whose value
//! is dropped whatever it is. A test below runs a known password through it
//! and asserts it never reaches the file.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// Where the replies go, and what must never be in them.
#[derive(Debug)]
pub struct SupportCapture {
    dir: PathBuf,
    secrets: Vec<String>,
    written: AtomicUsize,
    /// The first problem writing, kept so the summary can say it.
    problem: Mutex<Option<String>>,
}

/// What a crawl reports about its capture afterwards.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub folder: String,
    pub files: usize,
    pub problem: Option<String>,
}

impl SupportCapture {
    /// Creates the folder now, so a folder that cannot be made is reported
    /// before anybody waits for a file that never appears.
    pub fn open(dir: PathBuf, secrets: Vec<String>) -> Result<Self, String> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        Ok(Self {
            dir,
            secrets: secrets.into_iter().filter(|s| !s.is_empty()).collect(),
            written: AtomicUsize::new(0),
            problem: Mutex::new(None),
        })
    }

    /// Writes one reply as `<dir>/<host>/<n>-<command>.txt` and says where,
    /// relative to the folder, so the debug log can name it. A
    /// command that reads a configuration is skipped, whatever it answered.
    pub fn record(&self, host: &str, command: &str, output: &str) -> Option<String> {
        if is_configuration(command) {
            return None;
        }
        let n = self.written.fetch_add(1, Ordering::SeqCst) + 1;
        let folder = self.dir.join(component(host));
        let name = format!("{n:03}-{}.txt", component(command));
        let path = folder.join(&name);
        let body = format!(
            "# Coreview support capture\n# host: {host}\n# command: {command}\n# lines: {}\n\n{}\n",
            output.lines().count(),
            redact(output, &self.secrets)
        );
        let result = std::fs::create_dir_all(&folder).and_then(|()| std::fs::write(&path, body));
        if let Err(e) = result {
            if let Ok(mut p) = self.problem.lock() {
                p.get_or_insert_with(|| format!("could not write {}: {e}", path.display()));
            }
            return None;
        }
        Some(format!("{}/{name}", component(host)))
    }

    pub fn summary(&self) -> Summary {
        Summary {
            folder: self.dir.display().to_string(),
            files: self.written.load(Ordering::SeqCst),
            problem: self.problem.lock().ok().and_then(|p| p.clone()),
        }
    }
}

/// A command whose reply is a configuration, on any platform this reads:
/// Cisco's `show running-config`, FortiOS's `show full-configuration` and
/// its bare `show` inside a table, Junos's `show configuration`, MikroTik's
/// `export`, PAN-OS's `show config`.
pub fn is_configuration(command: &str) -> bool {
    let c = command.trim().to_ascii_lowercase();
    c.contains("config")
        || c == "show"
        || c.starts_with("show full")
        || c.starts_with("export")
        || c.starts_with("/export")
        || c.contains("running")
        || c.contains("startup")
}

/// A folder or file name from a host or a command: letters, digits, dots and
/// dashes, and nothing that could leave the folder.
fn component(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(80));
    let mut dash = false;
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' {
            out.push(ch);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
        if out.len() >= 80 {
            break;
        }
    }
    let out = out.trim_matches(['-', '.']).to_string();
    if out.is_empty() {
        "unnamed".into()
    } else {
        out
    }
}

const SENSITIVE: [&str; 7] = ["password", "passwd", "secret", "community", "passphrase", "auth-key", "authentication-key"];

/// The output with every known secret replaced, and the value of every line
/// that names one dropped.
pub fn redact(output: &str, secrets: &[String]) -> String {
    let mut out = String::with_capacity(output.len());
    for line in output.lines() {
        let mut l = line.to_string();
        for s in secrets {
            if !s.is_empty() {
                l = l.replace(s.as_str(), "[redacted]");
            }
        }
        let lower = l.to_ascii_lowercase();
        if SENSITIVE.iter().any(|w| lower.contains(w)) {
            // Keep the label so the line can still be recognised; drop the rest.
            let keep = l.find([':', '=', ' ']).map(|i| &l[..i]).unwrap_or(&l);
            l = format!("{keep} [value removed]");
        }
        out.push_str(&l);
        out.push('\n');
    }
    out
}

/// `<data dir>/diagnostics/crawl-<stamp>/replies`: one folder per
/// run, the debug log beside it.
pub fn folder_under(root: &Path, stamp: u64) -> PathBuf {
    diagnostic_folder(root, stamp).join("replies")
}

/// The run's diagnostic folder, which holds the debug log and the replies.
pub fn diagnostic_folder(root: &Path, stamp: u64) -> PathBuf {
    root.join("diagnostics").join(format!("crawl-{stamp}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_known_password_never_reaches_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let cap = SupportCapture::open(dir.path().join("sup"), vec!["not-a-real-password".into(), "not-a-real-community".into()]).unwrap();
        cap.record(
            "192.0.2.10",
            "show version",
            "Cisco IOS Software\nsnmp-server community not-a-real-community RO\nenable secret 5 $1$abcd\nline vty\n password not-a-real-password\nModel number : WS-C2960X\n",
        );
        assert_eq!(cap.record("192.0.2.10", "show ip arp", "x").as_deref(), Some("192.0.2.10/002-show-ip-arp.txt"));
        let files: Vec<PathBuf> = std::fs::read_dir(dir.path().join("sup").join("192.0.2.10")).unwrap().map(|e| e.unwrap().path()).collect();
        assert_eq!(files.len(), 2);
        let first = files.iter().find(|f| f.ends_with("001-show-version.txt")).expect("the version file");
        let text = std::fs::read_to_string(first).unwrap();
        assert!(!text.contains("not-a-real-password"));
        assert!(!text.contains("not-a-real-community"));
        assert!(!text.contains("$1$abcd"));
        assert!(text.contains("Model number : WS-C2960X"));
        assert!(text.contains("# command: show version"));
        assert_eq!(cap.summary(), Summary { folder: dir.path().join("sup").display().to_string(), files: 2, problem: None });
    }

    #[test]
    fn a_configuration_is_never_written_whatever_it_answered() {
        let dir = tempfile::tempdir().unwrap();
        let cap = SupportCapture::open(dir.path().join("sup"), vec![]).unwrap();
        for c in ["show running-config", "show startup-config", "show full-configuration", "show", "export", "/export", "show configuration", "show config running"] {
            cap.record("h", c, "hostname X\n");
            assert!(is_configuration(c), "{c}");
        }
        assert_eq!(cap.summary().files, 0);
        assert!(!dir.path().join("sup").join("h").exists());
        assert!(!is_configuration("show version"));
        assert!(!is_configuration("/ip route print without-paging"));
    }

    #[test]
    fn names_are_safe_and_a_write_that_fails_is_reported() {
        assert_eq!(component("/ip route print without-paging"), "ip-route-print-without-paging");
        assert_eq!(component("../../etc"), "etc");
        assert_eq!(component("show ip arp | include 10."), "show-ip-arp-include-10");
        // A file where the folder should be: the write fails and the summary says so.
        let dir = tempfile::tempdir().unwrap();
        let cap = SupportCapture::open(dir.path().join("sup"), vec![]).unwrap();
        std::fs::write(dir.path().join("sup").join("h"), "not a folder").unwrap();
        assert_eq!(cap.record("h", "show version", "x"), None, "a failed write names no file");
        let s = cap.summary();
        assert_eq!(s.files, 1);
        assert!(s.problem.unwrap().contains("could not write"));
    }
}
