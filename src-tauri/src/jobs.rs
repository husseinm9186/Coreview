//! What is running right now, and the refusal to start it twice (LT-428).
//!
//! A crawl, a backup and a sweep each used to be a `Mutex<Option<
//! CancellationToken>>` on `AppState`, and starting a second one *replaced*
//! the token and cancelled the first — silently, from the operator's side.
//! Nothing here queues or reports progress yet; that is the registry LT-432
//! builds on top of this. What this does is the smallest honest thing: one
//! job of a kind at a time, a refusal that says so, and a slot that empties
//! itself when the job ends rather than when somebody remembers to clear it.
//!
//! **Stop, then Start, still works.** Cancelling is cooperative — the task
//! winds down after its in-flight visits — so a slot whose token is already
//! cancelled does not count as running. That keeps the one sequence people
//! actually press, Stop followed by Start, from being refused for the seconds
//! it takes the old task to notice.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Crawl,
    Backup,
    Sweep,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Crawl => "A crawl",
            Kind::Backup => "A backup",
            Kind::Sweep => "A sweep",
        }
    }
}

struct Running {
    id: u64,
    token: CancellationToken,
    started: Instant,
}

/// The slots, one per kind. Shared by `Arc` so a ticket can find its way
/// back from inside a spawned task.
#[derive(Default)]
pub struct Jobs {
    slots: Mutex<HashMap<Kind, Running>>,
    next_id: Mutex<u64>,
}

/// Proof that a job of its kind was started. Dropping it — at the end of the
/// task, however the task ends — empties the slot, unless something newer
/// has taken it in the meantime.
pub struct Ticket {
    jobs: Arc<Jobs>,
    kind: Kind,
    id: u64,
    token: CancellationToken,
}

impl Ticket {
    /// The token the job watches for Stop.
    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if let Ok(mut slots) = self.jobs.slots.lock() {
            if slots.get(&self.kind).is_some_and(|r| r.id == self.id) {
                slots.remove(&self.kind);
            }
        }
    }
}

impl Jobs {
    /// Claims the slot for `kind`, or says who has it.
    pub fn start(self: &Arc<Self>, kind: Kind) -> Result<Ticket, String> {
        let mut slots = self.slots.lock().map_err(|e| e.to_string())?;
        if let Some(running) = slots.get(&kind) {
            if !running.token.is_cancelled() {
                let secs = running.started.elapsed().as_secs();
                let since = if secs < 60 { format!("{secs}s ago") } else { format!("{} min ago", secs / 60) };
                return Err(format!("{} is already running (started {since}). Stop it first.", kind.name()));
            }
        }
        let id = {
            let mut n = self.next_id.lock().map_err(|e| e.to_string())?;
            *n += 1;
            *n
        };
        let token = CancellationToken::new();
        slots.insert(kind, Running { id, token: token.clone(), started: Instant::now() });
        Ok(Ticket { jobs: Arc::clone(self), kind, id, token })
    }

    /// Asks the running job of `kind` to stop. Harmless when there is none,
    /// so the interface can press Stop without first asking.
    pub fn cancel(&self, kind: Kind) {
        if let Ok(slots) = self.slots.lock() {
            if let Some(running) = slots.get(&kind) {
                running.token.cancel();
            }
        }
    }

    /// Whether a job of `kind` is running and has not been told to stop.
    #[cfg(test)]
    pub fn is_running(&self, kind: Kind) -> bool {
        self.slots
            .lock()
            .map(|s| s.get(&kind).is_some_and(|r| !r.token.is_cancelled()))
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_start_of_the_same_kind_is_refused_and_the_first_keeps_running() {
        let jobs = Arc::new(Jobs::default());
        let first = jobs.start(Kind::Crawl).unwrap();
        let refused = match jobs.start(Kind::Crawl) {
            Ok(_) => panic!("a second crawl must be refused"),
            Err(e) => e,
        };
        assert!(refused.starts_with("A crawl is already running"), "{refused}");
        assert!(refused.contains("Stop it first"), "{refused}");
        assert!(!first.token().is_cancelled(), "the first was not cancelled underneath the operator");
        // A different kind is a different slot.
        assert!(jobs.start(Kind::Backup).is_ok());
    }

    #[test]
    fn the_slot_empties_when_the_job_ends() {
        let jobs = Arc::new(Jobs::default());
        let ticket = jobs.start(Kind::Sweep).unwrap();
        assert!(jobs.is_running(Kind::Sweep));
        drop(ticket);
        assert!(!jobs.is_running(Kind::Sweep));
        assert!(jobs.start(Kind::Sweep).is_ok());
    }

    #[test]
    fn stop_then_start_is_not_refused_while_the_old_job_winds_down() {
        let jobs = Arc::new(Jobs::default());
        let old = jobs.start(Kind::Crawl).unwrap();
        jobs.cancel(Kind::Crawl);
        assert!(old.token().is_cancelled());
        // The old task has not returned yet, and Start is pressed.
        let new = jobs.start(Kind::Crawl).unwrap();
        assert!(!new.token().is_cancelled());
        // When the old task finally ends, it must not take the new slot with it.
        drop(old);
        assert!(jobs.is_running(Kind::Crawl));
        drop(new);
        assert!(!jobs.is_running(Kind::Crawl));
    }

    #[test]
    fn cancelling_nothing_is_harmless() {
        let jobs = Jobs::default();
        jobs.cancel(Kind::Backup);
        assert!(!jobs.is_running(Kind::Backup));
    }
}
