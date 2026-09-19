//! How often the commands that send traffic may be started (LT-260).
//!
//! Every one of them reaches out to a network: a validation session, a crawl,
//! a sweep, a backup run, a one-off check, a ping from a device. A bug in the
//! page — or anything that got a script into it — that called one in a loop
//! would scan or log into an estate as fast as it could. So each kind of job
//! may start only so many times in a sliding minute, generously above what a
//! person or the app's own queues do: a backup queue starts one run per group,
//! a path check one test per hop. Past the limit the command is refused with
//! how long to wait, and nothing is sent.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Job {
    Validation,
    Crawl,
    Sweep,
    Backup,
    ProbeTest,
    Traceroute,
    DevicePing,
}

impl Job {
    /// Starts allowed per window, and what the job is called in a message.
    fn limit(self) -> (usize, &'static str) {
        match self {
            Job::Validation => (10, "Validation"),
            Job::Crawl => (6, "A crawl"),
            Job::Sweep => (10, "A sweep"),
            Job::Backup => (30, "A backup"),
            Job::ProbeTest => (120, "A test check"),
            Job::Traceroute => (20, "A traceroute"),
            Job::DevicePing => (30, "A ping from a device"),
        }
    }
}

const WINDOW: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct RateLimiter {
    starts: Mutex<HashMap<Job, VecDeque<Instant>>>,
}

impl RateLimiter {
    /// Counts a start of `job`, or refuses it with how long until one is free.
    pub fn allow(&self, job: Job) -> Result<(), String> {
        self.allow_at(job, Instant::now())
    }

    fn allow_at(&self, job: Job, now: Instant) -> Result<(), String> {
        let (max, name) = job.limit();
        let mut starts = self.starts.lock().map_err(|e| e.to_string())?;
        let recent = starts.entry(job).or_default();
        while recent.front().is_some_and(|t| now.duration_since(*t) >= WINDOW) {
            recent.pop_front();
        }
        if recent.len() >= max {
            let oldest = *recent.front().expect("full, so not empty");
            let wait = WINDOW.saturating_sub(now.duration_since(oldest)).as_secs().max(1);
            return Err(format!(
                "{name} was started {max} times in the last minute, which is more than a person does. Wait {wait} s and try again."
            ));
        }
        recent.push_back(now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_burst_is_refused_and_the_window_slides() {
        let limiter = RateLimiter::default();
        let t0 = Instant::now();
        for i in 0..6 {
            assert!(limiter.allow_at(Job::Crawl, t0 + Duration::from_secs(i)).is_ok(), "start {i}");
        }
        let refused = limiter.allow_at(Job::Crawl, t0 + Duration::from_secs(10)).unwrap_err();
        assert!(refused.contains("A crawl was started 6 times") && refused.contains("Wait 50 s"), "{refused}");
        // Another kind of job is counted on its own.
        assert!(limiter.allow_at(Job::Sweep, t0 + Duration::from_secs(10)).is_ok());
        // A minute after the first start, one is free again — and only one.
        assert!(limiter.allow_at(Job::Crawl, t0 + Duration::from_secs(60)).is_ok());
        assert!(limiter.allow_at(Job::Crawl, t0 + Duration::from_secs(60)).is_err());
    }

    #[test]
    fn a_refused_start_is_not_counted() {
        let limiter = RateLimiter::default();
        let t0 = Instant::now();
        for _ in 0..10 {
            limiter.allow_at(Job::Validation, t0).unwrap();
        }
        for s in 1..30 {
            assert!(limiter.allow_at(Job::Validation, t0 + Duration::from_secs(s)).is_err());
        }
        // Refusals did not push the window: at 60 s all ten slots are free.
        for _ in 0..10 {
            assert!(limiter.allow_at(Job::Validation, t0 + Duration::from_secs(60)).is_ok());
        }
    }
}
