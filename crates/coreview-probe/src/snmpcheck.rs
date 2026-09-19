//! The SNMP uptime probe (LT-220): does the device answer SNMP, how long has
//! it been up, and has it restarted since the last check.
//!
//! This crate has no SNMP code and no credentials of its own — both live
//! elsewhere, on purpose. The app registers a reader at start-up that opens the
//! saved credential the probe names (by vault id) and returns the device's
//! `sysUpTime`; this module schedules it like any other probe and turns
//! uptime going backwards into `Restarted`.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};

use crate::types::{Outcome, ProbeConfig, ProbeResult};

/// Reads a device's uptime in hundredths of a second, or says why it could not.
pub type UptimeReader =
    Box<dyn Fn(ProbeConfig) -> Pin<Box<dyn Future<Output = Result<u64, String>> + Send>> + Send + Sync>;

static READER: OnceLock<UptimeReader> = OnceLock::new();
/// The last uptime each probe saw, to notice a restart.
static LAST: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

/// Registers the reader. Only the first registration counts.
pub fn register(reader: UptimeReader) {
    let _ = READER.set(reader);
}

/// `8 weeks, 2 days` style, briefly: `58d 2h`.
pub fn describe(ticks: u64) -> String {
    let s = ticks / 100;
    let (d, h, m) = (s / 86_400, (s % 86_400) / 3_600, (s % 3_600) / 60);
    if d > 0 {
        format!("{d}d {h}h")
    } else if h > 0 {
        format!("{h}h {m}m")
    } else {
        format!("{m}m")
    }
}

/// What a reading means, given the one before it.
pub fn judge(probe_id: &str, now_ms: i64, rtt_ms: f64, ticks: u64, previous: Option<u64>) -> ProbeResult {
    let restarted = previous.is_some_and(|p| ticks < p);
    ProbeResult {
        probe_id: probe_id.to_string(),
        timestamp_ms: now_ms,
        outcome: if restarted { Outcome::Restarted } else { Outcome::Success },
        rtt_ms: Some(rtt_ms),
        resolved: vec![],
        summary: if restarted {
            format!("Restarted: up {} (was {})", describe(ticks), describe(previous.unwrap_or_default()))
        } else {
            format!("Up {}", describe(ticks))
        },
        error_message: restarted.then(|| format!("{probe_id}: uptime went back to {}", describe(ticks))),
    }
}

pub async fn run(cfg: &ProbeConfig, now_ms: i64) -> ProbeResult {
    let Some(reader) = READER.get() else {
        return ProbeResult::failed(&cfg.id, now_ms, Outcome::OsError, "SNMP checks are not available in this build");
    };
    if cfg.snmp_credential_id.as_deref().unwrap_or("").is_empty() {
        return ProbeResult::failed(&cfg.id, now_ms, Outcome::InvalidTarget, "Choose a saved SNMP credential for this check");
    }
    let started = std::time::Instant::now();
    match reader(cfg.clone()).await {
        Err(why) => ProbeResult::failed(&cfg.id, now_ms, Outcome::NoAnswer, &why),
        Ok(ticks) => {
            let last = LAST.get_or_init(|| Mutex::new(HashMap::new()));
            let previous = last.lock().ok().and_then(|mut m| m.insert(cfg.id.clone(), ticks));
            judge(&cfg.id, now_ms, started.elapsed().as_secs_f64() * 1000.0, ticks, previous)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notices_a_restart_and_nothing_else() {
        let first = judge("p", 0, 3.0, 500_000, None);
        assert_eq!(first.outcome, Outcome::Success);
        assert_eq!(first.summary, "Up 1h 23m");
        assert_eq!(judge("p", 0, 3.0, 600_000, Some(500_000)).outcome, Outcome::Success);
        let back = judge("p", 0, 3.0, 12_000, Some(501_918_000));
        assert_eq!(back.outcome, Outcome::Restarted);
        assert_eq!(back.summary, "Restarted: up 2m (was 58d 2h)");
        assert!(back.outcome.is_success(), "a restarted device still answered");
    }
}
