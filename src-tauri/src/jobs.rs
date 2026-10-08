//! What is running right now: the registry of long-running work.
//!
//! A crawl, a backup and a sweep each used to be a `Mutex<Option<
//! CancellationToken>>` on `AppState`, and starting a second one *replaced*
//! the token and cancelled the first — silently, from the operator's side.
//! Made that a refusal. Makes each running job a thing with an
//! id, a kind, a start time, a phase, a count of what is done out of what is
//! known, and a cancel — listed by `job_list`, stopped by `job_cancel`, and
//! reported on one event, `coreview://job`, whenever any of that changes. The
//! interface draws every job from the same snapshot rather than from three
//! panels each keeping their own idea of what is running.
//!
//! **Stop, then Start, still works.** Cancelling is cooperative — the task
//! winds down after its in-flight visits — so a slot whose token is already
//! cancelled does not count as running. That keeps the one sequence people
//! actually press, Stop followed by Start, from being refused for the seconds
//! it takes the old task to notice.
//!
//! **Tauri-free.** Reporting goes through a closure the app installs at
//! startup, so this can be tested with a `Vec` in place of the window.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Crawl,
    Backup,
    Sweep,
    /// A Meraki backup, health check or discovery — one slot for
    /// the three, because they share one key's rate limit.
    Meraki,
    /// The icon-library scan, which converts stencils through
    /// LibreOffice and can run for minutes on a big folder.
    IconScan,
    /// The catalog-driven collection through the sidecar.
    Collect,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Crawl => "A crawl",
            Kind::Backup => "A backup",
            Kind::Sweep => "A sweep",
            Kind::Meraki => "A Meraki collection",
            Kind::IconScan => "An icon-library scan",
            Kind::Collect => "A collection",
        }
    }
}

/// Where a job is in its life. `Stopping` is between Stop being pressed and
/// the task noticing; the two ended states say how it ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum JobState {
    Running,
    Stopping,
    Complete,
    Cancelled,
}

/// One job as the interface sees it. `total` is `None` where nothing knows
/// it — a crawl discovers its own size as it goes.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub id: u64,
    pub kind: Kind,
    pub state: JobState,
    pub phase: String,
    pub done: u64,
    pub total: Option<u64>,
    /// Wall-clock start, milliseconds since the epoch, for "started 2 min ago".
    pub started_ms: i64,
}

struct Running {
    id: u64,
    token: CancellationToken,
    started: Instant,
    started_ms: i64,
    phase: String,
    done: u64,
    total: Option<u64>,
}

impl Running {
    fn snapshot(&self, kind: Kind, state: JobState) -> JobSnapshot {
        JobSnapshot {
            id: self.id,
            kind,
            state,
            phase: self.phase.clone(),
            done: self.done,
            total: self.total,
            started_ms: self.started_ms,
        }
    }

    fn live_state(&self) -> JobState {
        if self.token.is_cancelled() {
            JobState::Stopping
        } else {
            JobState::Running
        }
    }
}

type Reporter = Box<dyn Fn(JobSnapshot) + Send + Sync>;

/// The slots, one per kind. Shared by `Arc` so a ticket can find its way
/// back from inside a spawned task.
#[derive(Default)]
pub struct Jobs {
    slots: Mutex<HashMap<Kind, Running>>,
    next_id: Mutex<u64>,
    reporter: Mutex<Option<Reporter>>,
}

/// Proof that a job of its kind was started. Dropping it — at the end of the
/// task, however the task ends — empties the slot, unless something newer
/// has taken it in the meantime, and reports how the job ended.
pub struct Ticket {
    jobs: Arc<Jobs>,
    kind: Kind,
    id: u64,
    token: CancellationToken,
}

/// A way to report progress from wherever the events are read, which is
/// usually a different task from the one holding the ticket. Cheap to clone;
/// harmless after the job has ended.
#[derive(Clone)]
pub struct Progress {
    jobs: Arc<Jobs>,
    kind: Kind,
    id: u64,
}

impl Ticket {
    /// The token the job watches for Stop.
    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }

    pub fn progress(&self) -> Progress {
        Progress { jobs: Arc::clone(&self.jobs), kind: self.kind, id: self.id }
    }
}

impl Progress {
    /// Where the job is now. `total` may be given once it is known.
    pub fn set(&self, phase: impl Into<String>, done: u64, total: Option<u64>) {
        let snapshot = {
            let Ok(mut slots) = self.jobs.slots.lock() else { return };
            let Some(running) = slots.get_mut(&self.kind).filter(|r| r.id == self.id) else { return };
            running.phase = phase.into();
            running.done = done;
            if total.is_some() {
                running.total = total;
            }
            running.snapshot(self.kind, running.live_state())
        };
        self.jobs.report(snapshot);
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let ended = {
            let Ok(mut slots) = self.jobs.slots.lock() else { return };
            if slots.get(&self.kind).is_some_and(|r| r.id == self.id) {
                slots.remove(&self.kind).map(|r| {
                    let how = if r.token.is_cancelled() { JobState::Cancelled } else { JobState::Complete };
                    r.snapshot(self.kind, how)
                })
            } else {
                None
            }
        };
        if let Some(snapshot) = ended {
            self.jobs.report(snapshot);
        }
    }
}

impl Jobs {
    /// Installs what hears every change. The app points this at the window;
    /// a test points it at a list.
    pub fn report_to(&self, reporter: impl Fn(JobSnapshot) + Send + Sync + 'static) {
        if let Ok(mut slot) = self.reporter.lock() {
            *slot = Some(Box::new(reporter));
        }
    }

    fn report(&self, snapshot: JobSnapshot) {
        if let Ok(slot) = self.reporter.lock() {
            if let Some(reporter) = slot.as_ref() {
                reporter(snapshot);
            }
        }
    }

    /// Claims the slot for `kind`, or says who has it.
    pub fn start(self: &Arc<Self>, kind: Kind) -> Result<Ticket, String> {
        let snapshot = {
            let mut slots = self.slots.lock().map_err(|e| e.to_string())?;
            if let Some(running) = slots.get(&kind) {
                if !running.token.is_cancelled() {
                    let secs = running.started.elapsed().as_secs();
                    let since = if secs < 60 { format!("{secs}s ago") } else { format!("{} min ago", secs / 60) };
                    return Err(format!(
                        "{} is already running (job {}, started {since}). Stop it first.",
                        kind.name(),
                        running.id
                    ));
                }
            }
            let id = {
                let mut n = self.next_id.lock().map_err(|e| e.to_string())?;
                *n += 1;
                *n
            };
            let token = CancellationToken::new();
            let running = Running {
                id,
                token: token.clone(),
                started: Instant::now(),
                started_ms: crate::db::now_ms(),
                phase: "Starting".into(),
                done: 0,
                total: None,
            };
            let snapshot = running.snapshot(kind, JobState::Running);
            slots.insert(kind, running);
            (snapshot, Ticket { jobs: Arc::clone(self), kind, id, token })
        };
        let (snapshot, ticket) = snapshot;
        self.report(snapshot);
        Ok(ticket)
    }

    /// Asks the running job of `kind` to stop. Harmless when there is none,
    /// so the interface can press Stop without first asking.
    pub fn cancel(&self, kind: Kind) {
        let snapshot = {
            let Ok(slots) = self.slots.lock() else { return };
            let Some(running) = slots.get(&kind) else { return };
            running.token.cancel();
            running.snapshot(kind, JobState::Stopping)
        };
        self.report(snapshot);
    }

    /// Asks the job with this id to stop, whatever kind it is. Says whether
    /// there was one.
    pub fn cancel_id(&self, id: u64) -> bool {
        let kind = self
            .slots
            .lock()
            .ok()
            .and_then(|s| s.iter().find(|(_, r)| r.id == id).map(|(k, _)| *k));
        match kind {
            Some(kind) => {
                self.cancel(kind);
                true
            }
            None => false,
        }
    }

    /// Every job running or stopping right now, oldest first.
    pub fn list(&self) -> Vec<JobSnapshot> {
        let Ok(slots) = self.slots.lock() else { return Vec::new() };
        let mut out: Vec<JobSnapshot> = slots.iter().map(|(k, r)| r.snapshot(*k, r.live_state())).collect();
        out.sort_by_key(|j| j.id);
        out
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

    fn recorded(jobs: &Jobs) -> Arc<Mutex<Vec<JobSnapshot>>> {
        let heard: Arc<Mutex<Vec<JobSnapshot>>> = Arc::default();
        let sink = Arc::clone(&heard);
        jobs.report_to(move |s| sink.lock().unwrap().push(s));
        heard
    }

    /// The two kinds the header did not show, in their own slots,
    /// named on the wire as the page spells them.
    #[test]
    fn a_meraki_collection_and_an_icon_scan_are_jobs_of_their_own() {
        let jobs = Arc::new(Jobs::default());
        let _meraki = jobs.start(Kind::Meraki).unwrap();
        let _scan = jobs.start(Kind::IconScan).unwrap();
        let refused = jobs.start(Kind::Meraki).err().unwrap();
        assert!(refused.starts_with("A Meraki collection is already running"), "{refused}");
        assert!(jobs.start(Kind::IconScan).err().unwrap().starts_with("An icon-library scan is already running"));
        let kinds: Vec<String> = jobs.list().iter().map(|j| serde_json::to_string(&j.kind).unwrap()).collect();
        assert_eq!(kinds, ["\"meraki\"", "\"icon-scan\""]);
    }

    #[test]
    fn a_second_start_of_the_same_kind_is_refused_and_the_first_keeps_running() {
        let jobs = Arc::new(Jobs::default());
        let first = jobs.start(Kind::Crawl).unwrap();
        let refused = match jobs.start(Kind::Crawl) {
            Ok(_) => panic!("a second crawl must be refused"),
            Err(e) => e,
        };
        assert!(refused.starts_with("A crawl is already running (job 1,"), "{refused}");
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
        assert!(!jobs.cancel_id(99));
    }

    /// Every change is heard, in order, with the id and the kind,
    /// and the last word says how the job ended.
    #[test]
    fn every_change_is_reported_and_the_list_shows_what_runs() {
        let jobs = Arc::new(Jobs::default());
        let heard = recorded(&jobs);
        let ticket = jobs.start(Kind::Sweep).unwrap();
        let progress = ticket.progress();
        progress.set("Sweeping 192.0.2.0/24", 10, Some(254));
        progress.set("Sweeping 192.0.2.0/24", 20, None);
        let listed = jobs.list();
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].id, listed[0].kind, listed[0].state, listed[0].done, listed[0].total), (1, Kind::Sweep, JobState::Running, 20, Some(254)));
        assert!(jobs.cancel_id(1));
        assert_eq!(jobs.list()[0].state, JobState::Stopping);
        drop(ticket);
        assert!(jobs.list().is_empty());

        let states: Vec<(JobState, u64, Option<u64>)> = heard.lock().unwrap().iter().map(|s| (s.state, s.done, s.total)).collect();
        assert_eq!(
            states,
            vec![
                (JobState::Running, 0, None),
                (JobState::Running, 10, Some(254)),
                (JobState::Running, 20, Some(254)),
                (JobState::Stopping, 20, Some(254)),
                (JobState::Cancelled, 20, Some(254)),
            ]
        );
        assert!(heard.lock().unwrap().iter().all(|s| s.id == 1 && s.kind == Kind::Sweep && s.started_ms > 0));
    }

    #[test]
    fn a_job_that_ends_on_its_own_is_reported_complete_and_a_stale_progress_is_ignored() {
        let jobs = Arc::new(Jobs::default());
        let heard = recorded(&jobs);
        let ticket = jobs.start(Kind::Backup).unwrap();
        let progress = ticket.progress();
        drop(ticket);
        assert_eq!(heard.lock().unwrap().last().map(|s| s.state), Some(JobState::Complete));
        let before = heard.lock().unwrap().len();
        // The task's pump may still hold a Progress after the ticket is gone.
        progress.set("late", 1, None);
        assert_eq!(heard.lock().unwrap().len(), before, "nothing was reported for a job that ended");
        // And it cannot touch a newer job of the same kind.
        let _newer = jobs.start(Kind::Backup).unwrap();
        progress.set("late", 5, None);
        assert_eq!(jobs.list()[0].done, 0);
    }
}
