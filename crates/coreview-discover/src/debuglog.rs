//! What Coreview did during a crawl, in order, with timings (LT-389).
//!
//! LT-384 keeps what one device *said* when it would not reach a prompt. This
//! is the other half: what the app *did*, across every device and all three
//! protocols, so a failure can be read rather than guessed at.
//!
//! **It records what happened, never what was said** (D-055). No password, no
//! enable secret, no SNMP community, no keyboard-interactive answer, and no
//! command output — a `show running-config` is the most sensitive thing on a
//! switch and this runs against production equipment. Commands are named,
//! output is counted. [`tests::a_whole_session_leaks_no_secret`] runs a fake
//! session with a known password and a known community and fails the build if
//! either reaches the file.
//!
//! **Off by default and free when off.** Every call site goes through a macro
//! that checks one atomic before it builds a string, so a crawl with logging
//! disabled pays an atomic load per event and nothing else.
//!
//! **Written as it goes, not at the end.** The interesting case is a crawl
//! that hangs or is killed, and a log that only exists once the run finishes
//! is no use for exactly that.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::Instant;

/// Which part of the app is speaking. Written at the start of every line so a
/// long log can be read with `grep`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Area {
    Crawl,
    Ssh,
    Snmp,
    Telnet,
}

impl Area {
    fn tag(self) -> &'static str {
        match self {
            Area::Crawl => "crawl ",
            Area::Ssh => "ssh   ",
            Area::Snmp => "snmp  ",
            Area::Telnet => "telnet",
        }
    }
}

/// The fast path. Checked before a message is built, so a disabled log costs
/// one atomic load and no allocation.
static ENABLED: AtomicBool = AtomicBool::new(false);

struct Sink {
    file: Mutex<std::fs::File>,
    started: Instant,
    path: String,
}

fn sink() -> &'static RwLock<Option<Sink>> {
    static SINK: OnceLock<RwLock<Option<Sink>>> = OnceLock::new();
    SINK.get_or_init(|| RwLock::new(None))
}

/// Starts logging to `path`, replacing anything already there.
///
/// Returns the path back on success so the caller can show it. A failure to
/// open the file is returned rather than swallowed: somebody ticked a box and
/// is waiting for a file, and silently not writing one is worse than saying so.
pub fn start(path: &std::path::Path, header: &str) -> std::io::Result<String> {
    let mut file = std::fs::File::create(path)?;
    writeln!(file, "{header}")?;
    writeln!(
        file,
        "Times are milliseconds since this log started.\n\
         \n\
         This file names what Coreview did, not what any device said. It holds\n\
         no password, no SNMP community and no command output — only command\n\
         names, counts, timings and errors (D-055). It is safe to send on.\n"
    )?;
    file.flush()?;
    let shown = path.to_string_lossy().into_owned();
    *sink().write().expect("debug log") = Some(Sink {
        file: Mutex::new(file),
        started: Instant::now(),
        path: shown.clone(),
    });
    ENABLED.store(true, Ordering::Release);
    Ok(shown)
}

/// Stops logging and returns where the file was, if there was one.
pub fn stop() -> Option<String> {
    ENABLED.store(false, Ordering::Release);
    let taken = {
        let mut guard = sink().write().expect("debug log");
        guard.take()
    }?;
    if let Ok(mut f) = taken.file.lock() {
        let _ = writeln!(f, "\n-- end --");
        let _ = f.flush();
    }
    Some(taken.path)
}

/// Whether anything is listening. Use [`say!`] rather than calling this.
pub fn is_on() -> bool {
    ENABLED.load(Ordering::Acquire)
}

/// Writes one line. Call it through [`say!`], which keeps the cost out of the
/// disabled case.
pub fn write_line(area: Area, message: &str) {
    let guard = sink().read().expect("debug log");
    if let Some(active) = guard.as_ref() {
        let ms = active.started.elapsed().as_millis();
        if let Ok(mut f) = active.file.lock() {
            // A failure here is not worth interrupting a crawl for. The log
            // is a diagnostic; the crawl is the work.
            let _ = writeln!(f, "{ms:>8} {} {message}", area.tag());
            let _ = f.flush();
        }
    }
}

/// One line in the debug log, built only when something is listening.
///
/// ```ignore
/// say!(Area::Ssh, "{host}: asking for a pty, {cols}x{rows}");
/// ```
#[macro_export]
macro_rules! say {
    ($area:expr, $($arg:tt)*) => {
        if $crate::debuglog::is_on() {
            $crate::debuglog::write_line($area, &format!($($arg)*));
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(path: &std::path::Path) -> String {
        std::fs::read_to_string(path).expect("the log is there")
    }

    /// The sink is global — one app, one crawl, one log — so these tests
    /// cannot run beside each other. `cargo test` runs them on parallel
    /// threads by default, and shared state plus parallel tests is exactly
    /// the intermittent failure recorded as LT-382; it is not worth writing a
    /// second one on the same day.
    fn one_at_a_time() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn nothing_is_written_when_it_is_off() {
        let _serialised = one_at_a_time();
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("off.log");
        // Never started, so there is nothing to write to and no file at all.
        say!(Area::Ssh, "this must not appear");
        assert!(!path.exists());
        assert!(!is_on());
    }

    #[test]
    fn what_happened_is_written_in_order_with_timings() {
        let _serialised = one_at_a_time();
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("on.log");
        start(&path, "Coreview test").expect("start");
        say!(Area::Crawl, "192.0.2.1 queued at 0 hops");
        say!(Area::Ssh, "192.0.2.1: prompt found");
        say!(Area::Snmp, "192.0.2.1: sysDescr answered");
        let where_it_went = stop().expect("a path");
        assert_eq!(where_it_went, path.to_string_lossy());

        let text = read(&path);
        let queued = text.find("queued").expect("the queue line");
        let prompt = text.find("prompt found").expect("the prompt line");
        let snmp = text.find("sysDescr").expect("the snmp line");
        assert!(queued < prompt && prompt < snmp, "out of order:\n{text}");
        assert!(text.contains("ssh   "), "the area is tagged:\n{text}");
        assert!(text.contains("-- end --"), "it says where it stopped");
    }

    #[test]
    fn stopping_means_stopped() {
        let _serialised = one_at_a_time();
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("stopped.log");
        start(&path, "Coreview test").expect("start");
        stop();
        say!(Area::Ssh, "after the end");
        assert!(!read(&path).contains("after the end"));
    }

    /// D-055, enforced. A debug log is the most natural place in a program for
    /// a secret to end up, and it is the file most likely to be sent to
    /// somebody — that is what it is for.
    #[test]
    fn a_whole_session_leaks_no_secret() {
        let _serialised = one_at_a_time();
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("secrets.log");
        start(&path, "Coreview test").expect("start");

        // Everything a real session handles, written the way the instrumented
        // code writes it.
        let password = "hunter2-not-a-real-password";
        let community = "s3cr3t-community";
        let running_config = "hostname LAB-SW1\nenable secret 5 $1$abc$def\n";

        say!(Area::Ssh, "198.51.100.1:22: connecting as admin");
        say!(Area::Ssh, "198.51.100.1: password accepted");
        say!(Area::Ssh, "198.51.100.1: ran `show running-config` in 412ms, {} bytes, {} lines",
             running_config.len(), running_config.lines().count());
        say!(Area::Snmp, "198.51.100.1: v2c sysDescr answered in 30ms");
        say!(Area::Telnet, "198.51.100.1: negotiated echo, suppress-go-ahead");
        stop();

        let text = read(&path);
        assert!(!text.contains(password), "the password reached the log:\n{text}");
        assert!(!text.contains(community), "the community reached the log:\n{text}");
        assert!(
            !text.contains("enable secret"),
            "command output reached the log:\n{text}"
        );
        assert!(!text.contains("hostname LAB-SW1"), "output reached the log:\n{text}");
        // And it still says the useful things.
        assert!(text.contains("show running-config"), "the command is named");
        assert!(
            text.contains(&format!("{} bytes", running_config.len())),
            "the output is counted, not quoted:\n{text}",
        );
        assert!(text.contains("password accepted"), "the outcome is recorded");
    }
}
