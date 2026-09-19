//! Traceroute via a controlled invocation of the platform's own traceroute
//! binary (LT-090) — the same pattern `icmp.rs` uses for ping, rather than
//! a raw ICMP/UDP socket, which needs elevated privileges on Linux. An
//! on-demand diagnostic, not a recurring probe: there is no pass/fail
//! signal here, just the current path, which is what a failover drill
//! needs when something is not reaching the backup site and the question
//! is where it is actually going.
//!
//! Security note, as in `icmp.rs`: the target is parsed by
//! `validate::parse_target` first, and the binary is invoked with an
//! argument vector — no shell, no string concatenation.

use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::validate::{parse_target, Target};

/// One reply within a hop. `traceroute` sends three probes per hop by
/// default; a lost one (`*`) is `rtt_ms: None`, not a failed hop — the hop
/// itself may still have gotten through on another probe.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TracerouteProbe {
    /// The replying router, as `traceroute` printed it — a hostname plus
    /// address, a bare address, or absent entirely for a lost probe.
    /// `None` here does not necessarily mean "not this router": on an
    /// ECMP path a hop's three probes can come back from three different
    /// routers, and `traceroute` only prints a new one when it changes
    /// from the previous probe, which is exactly the shape this preserves.
    pub host: Option<String>,
    pub rtt_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TracerouteHop {
    pub hop: u32,
    pub probes: Vec<TracerouteProbe>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TracerouteResult {
    pub target: String,
    pub hops: Vec<TracerouteHop>,
    /// Whether the command ran to its own end, or was cut short by the wall
    /// clock (LT-129). False does not mean the hops are wrong — they are as
    /// real as any others — only that the path below the last one is unknown
    /// because there was no time left to ask.
    #[serde(default = "yes")]
    pub complete: bool,
}

fn yes() -> bool {
    true
}

const MAX_HOPS: u32 = 30;

/// Build the argument vector. Pure, so the exact flags are covered by
/// tests on every platform, the way `ping_args` already is.
pub fn traceroute_args(target: &Target, wait_secs: u32) -> Vec<String> {
    let t = target.as_str();
    if cfg!(windows) {
        // tracert.exe: -h max hops, -w per-probe wait in milliseconds.
        vec!["-h".into(), MAX_HOPS.to_string(), "-w".into(), (wait_secs * 1000).to_string(), t]
    } else {
        // Linux/macOS traceroute: -m max hops, -w per-probe wait in seconds.
        vec!["-m".into(), MAX_HOPS.to_string(), "-w".into(), wait_secs.to_string(), t]
    }
}

/// An RTT token's value, handling both a plain number (`23.859`) and the
/// sub-millisecond form every one of these tools writes as `<1` rather than
/// `0.xxx` — the same convention (and the same `0.5` stand-in for "some
/// amount under a millisecond") `icmp.rs` already uses for `ping`'s
/// `time<1ms`. `None` when the token is not a number at all, so the caller
/// can fall through to treating it as a hostname.
fn rtt_value(token: &str) -> Option<f64> {
    if let Some(rest) = token.strip_prefix('<') {
        rest.parse::<f64>().ok().map(|v| 0.5_f64.min(v))
    } else {
        token.parse::<f64>().ok()
    }
}

/// Parse one line's worth of probe tokens (everything after the leading hop
/// number) into that hop's probes.
///
/// Written against real `traceroute` output, not documentation: a hop's
/// three probes do not each repeat the responding router when it has not
/// changed, but *do* print a new host inline the moment an ECMP path
/// switches which router answers — both captured in
/// `preserves_a_mid_hop_router_change` and `preserves_a_mid_hop_router_change_numeric`.
///
/// `tracert.exe` was not available to capture directly (Windows was only
/// reachable through CI), so its handling here is inferred from a real CI
/// failure rather than a real capture: a loopback hop — always
/// sub-millisecond — came back with every probe's `rtt_ms` unset, which is
/// what `<1` being unparseable as a bare float, and so misread as a
/// hostname, produces. `rtt_value` above fixes that half. The other half is
/// the backfill below: `tracert.exe`'s classic layout prints RTTs before
/// the router name on a hop line, the reverse of `traceroute`'s, so a
/// probe can be pushed before any host token has been seen at all.
fn parse_hop_body(body: &str) -> Vec<TracerouteProbe> {
    let tokens: Vec<&str> = body.split_whitespace().collect();
    let mut probes = Vec::new();
    let mut current_host: Option<String> = None;
    let mut i = 0usize;
    while i < tokens.len() {
        let t = tokens[i];
        if t == "*" {
            probes.push(TracerouteProbe { host: current_host.clone(), rtt_ms: None });
            i += 1;
            continue;
        }
        if let Some(rtt) = rtt_value(t) {
            // A bare number is an RTT only when "ms" follows; otherwise
            // (not seen in practice, but cheap to guard) treat it as a host
            // token instead of misreading it as a probe.
            if tokens.get(i + 1) == Some(&"ms") {
                probes.push(TracerouteProbe { host: current_host.clone(), rtt_ms: Some(rtt) });
                i += 2;
                continue;
            }
        }
        // A new router: a hostname optionally followed by "(a.b.c.d)", or a
        // bare address with no reverse name (the `-n` / unresolvable case).
        let mut host = t.to_string();
        i += 1;
        if let Some(next) = tokens.get(i) {
            if next.starts_with('(') && next.ends_with(')') {
                host.push(' ');
                host.push_str(next);
                i += 1;
            }
        }
        current_host = Some(host);
    }
    // A hop whose only router name arrived after some probes were already
    // pushed (tracert.exe's RTTs-then-router layout) leaves those probes
    // with no host — back-fill them from whatever host the line did settle
    // on. A no-op for traceroute's own host-before-RTTs lines, where every
    // probe already got one inline.
    if let Some(host) = &current_host {
        for p in probes.iter_mut() {
            if p.host.is_none() {
                p.host = Some(host.clone());
            }
        }
    }
    probes
}

/// Parse a full `traceroute`/`tracert` run. The first line (`traceroute
/// to ... hops max ...` / `Tracing route to ...`) is header, not a hop, and
/// is skipped by requiring the line to start with a hop number.
pub fn parse_traceroute_output(stdout: &str) -> Vec<TracerouteHop> {
    let mut hops = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim_start();
        let mut split = trimmed.splitn(2, char::is_whitespace);
        let Some(first) = split.next() else { continue };
        let Ok(hop) = first.parse::<u32>() else { continue };
        let body = split.next().unwrap_or("").trim_start();
        hops.push(TracerouteHop { hop, probes: parse_hop_body(body) });
    }
    hops
}

/// Run a traceroute and parse it. `timeout_ms` bounds the *whole* run, the
/// same wall-clock-plus-kill-and-reap pattern `ping_once` uses, since a
/// worst-case 30-hop path with every probe lost would otherwise be free to
/// run for minutes.
pub async fn run_traceroute(raw_target: &str, timeout_ms: u64) -> Result<TracerouteResult, String> {
    let target = parse_target(raw_target).map_err(|e| e.to_string())?;
    let wait_secs = 2u32;
    let program = if cfg!(windows) { "tracert.exe" } else { "traceroute" };
    let mut cmd = Command::new(program);
    cmd.args(traceroute_args(&target, wait_secs))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let run = run_bounded(cmd, Duration::from_millis(timeout_ms))
        .await
        .map_err(|e| format!("could not run {program}: {e}"))?;

    result_from(&target.as_str(), &run, program)
}

/// Turns a finished or cut-short run into a result, or into the reason there
/// is none.
///
/// Pure, so the rule can be tested without a traceroute binary and without
/// waiting on a real network — which is the only way the cut-short case gets
/// covered at all, since provoking it for real means a two-minute path to a
/// host that refuses to answer.
///
/// **Hops beat the timeout.** A run that was killed having found nine hops
/// answered the question; reporting only "did not finish within the timeout"
/// and dropping them, which is what LT-129 was, does not. The deadline is
/// only worth reporting when there is nothing else to report.
fn result_from(target: &str, run: &BoundedRun, program: &str) -> Result<TracerouteResult, String> {
    let hops = parse_traceroute_output(&run.stdout);
    if !hops.is_empty() {
        return Ok(TracerouteResult { target: target.to_string(), hops, complete: run.complete });
    }
    if !run.complete {
        return Err("traceroute did not finish within the timeout".to_string());
    }
    let detail = if !run.stderr.trim().is_empty() { run.stderr.trim() } else { run.stdout.trim() };
    if detail.is_empty() {
        Err(format!("{program} produced no output"))
    } else {
        Err(detail.to_string())
    }
}

/// What a bounded run produced.
pub struct BoundedRun {
    pub stdout: String,
    pub stderr: String,
    /// Whether the child exited on its own rather than being killed.
    pub complete: bool,
}

/// Runs a command under a wall clock, **keeping whatever it printed before
/// the clock ran out** (LT-129).
///
/// The bug this exists for: stdout used to be read only after the child had
/// exited, so a traceroute killed at the deadline threw away every hop it had
/// already found. A traceroute to `aws.com` prints nine real hops and then
/// spends two minutes discovering that AWS will not answer — and the nine
/// hops are the part the operator wanted.
///
/// So the pipes are drained by their own tasks from the moment the child
/// starts. Killing the child closes them, those tasks end, and what they have
/// collected is returned.
async fn run_bounded(mut cmd: Command, wall: Duration) -> std::io::Result<BoundedRun> {
    use std::sync::{Arc, Mutex};

    let mut child = cmd.spawn()?;

    // Accumulated as it arrives, into something readable from here, rather
    // than returned by the reader task when it ends. Killing a child does not
    // reliably close the pipe — anything it spawned inherits the handle and
    // can hold it open — so waiting for end-of-file to collect the output
    // would reintroduce exactly the hang this is meant to bound. That is not
    // hypothetical: the first version of this fix took the full thirty
    // seconds against a shell that had forked `sleep`.
    let drain = |pipe: Option<tokio::process::ChildStdout>| {
        let sink = Arc::new(Mutex::new(String::new()));
        let into = Arc::clone(&sink);
        tokio::spawn(async move {
            let Some(mut pipe) = pipe else { return };
            let mut buf = [0u8; 4096];
            while let Ok(n) = pipe.read(&mut buf).await {
                if n == 0 {
                    return;
                }
                if let Ok(mut held) = into.lock() {
                    held.push_str(&String::from_utf8_lossy(&buf[..n]));
                }
            }
        });
        sink
    };

    let out = drain(child.stdout.take());
    let err_pipe = child.stderr.take();
    let err = Arc::new(Mutex::new(String::new()));
    let err_into = Arc::clone(&err);
    tokio::spawn(async move {
        let Some(mut pipe) = err_pipe else { return };
        let mut buf = [0u8; 4096];
        while let Ok(n) = pipe.read(&mut buf).await {
            if n == 0 {
                return;
            }
            if let Ok(mut held) = err_into.lock() {
                held.push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        }
    });

    let complete = match timeout(wall, child.wait()).await {
        Ok(Ok(_)) => true,
        _ => {
            let _ = child.kill().await;
            false
        }
    };

    // A short grace period for whatever was in flight when the child stopped,
    // then take what there is either way.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let taken = |sink: &Arc<Mutex<String>>| {
        sink.lock().map(|held| held.clone()).unwrap_or_default()
    };

    Ok(BoundedRun { stdout: taken(&out), stderr: taken(&err), complete })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arg_vector_sends_a_target_once_and_bounds_the_run() {
        let t = parse_target("10.10.10.1").unwrap();
        let args = traceroute_args(&t, 2);
        assert_eq!(args.last().unwrap(), "10.10.10.1");
        assert_eq!(args.iter().filter(|a| a.contains("10.10.10.1")).count(), 1);
    }

    /// Reconstructed, not captured: no Windows machine was available in
    /// this environment, only a CI failure against the real thing —
    /// `run_traceroute("127.0.0.1", ...)` on `windows-latest` came back
    /// with hops but not one probe carrying an RTT, which is exactly what
    /// an unparsed `<1` falling through to "must be a hostname" produces.
    /// The line below is `tracert.exe`'s well-documented classic layout;
    /// replace this with a real capture if one ever turns up.
    #[test]
    fn windows_sub_millisecond_loopback_hop_is_parsed() {
        let out = "Tracing route to 127.0.0.1 over a maximum of 30 hops\n\n\
  1     <1 ms    <1 ms    <1 ms  127.0.0.1\n";
        let hops = parse_traceroute_output(out);
        assert_eq!(hops.len(), 1);
        let probes = &hops[0].probes;
        assert_eq!(probes.len(), 3);
        for p in probes {
            assert_eq!(p.rtt_ms, Some(0.5), "{p:?}");
            assert_eq!(p.host.as_deref(), Some("127.0.0.1"), "{p:?}");
        }
    }

    /// Real output, `traceroute 127.0.0.1` on this machine.
    #[test]
    fn a_single_hop_loopback_run_is_parsed() {
        let out = "traceroute to 127.0.0.1 (127.0.0.1), 30 hops max, 60 byte packets\n\
 1  localhost (127.0.0.1)  0.022 ms  0.004 ms  0.004 ms\n";
        let hops = parse_traceroute_output(out);
        assert_eq!(hops.len(), 1);
        assert_eq!(hops[0].hop, 1);
        assert_eq!(hops[0].probes.len(), 3);
        for p in &hops[0].probes {
            assert_eq!(p.host.as_deref(), Some("localhost (127.0.0.1)"));
        }
        assert_eq!(hops[0].probes[0].rtt_ms, Some(0.022));
        assert_eq!(hops[0].probes[2].rtt_ms, Some(0.004));
    }

    /// Real output, `traceroute -m 5 192.0.2.1` (RFC 5737 documentation
    /// range, which must never answer — the same target the ICMP live
    /// tests already use for "unreachable").
    #[test]
    fn every_probe_lost_is_three_nones_not_a_missing_hop() {
        let out = "traceroute to 192.0.2.1 (192.0.2.1), 5 hops max, 60 byte packets\n\
 1  _gateway (192.168.77.1)  0.611 ms  0.596 ms  0.555 ms\n\
 2  * * *\n\
 3  * * *\n";
        let hops = parse_traceroute_output(out);
        assert_eq!(hops.len(), 3);
        assert_eq!(hops[1].hop, 2);
        assert_eq!(hops[1].probes.len(), 3);
        assert!(hops[1].probes.iter().all(|p| p.host.is_none() && p.rtt_ms.is_none()));
    }

    /// Real output, `traceroute 1.1.1.1` — a middle hop (an ECMP path)
    /// answers from two *different* routers across its three probes. The
    /// third probe's RTT reuses the second probe's router without
    /// reprinting the name; a naive "one host per hop" parser would drop
    /// this entirely or attach the wrong host to the third probe.
    #[test]
    fn preserves_a_mid_hop_router_change() {
        let line = " 4  lag-19.hcr01snaxtx40.netops.charter.com (24.27.13.136)  23.859 ms  23.836 ms lag-18.hcr02snaxtx40.netops.charter.com (24.27.13.144)  23.813 ms\n";
        let hops = parse_traceroute_output(line);
        assert_eq!(hops.len(), 1);
        let probes = &hops[0].probes;
        assert_eq!(probes.len(), 3);
        assert_eq!(
            probes[0].host.as_deref(),
            Some("lag-19.hcr01snaxtx40.netops.charter.com (24.27.13.136)")
        );
        assert_eq!(probes[0].rtt_ms, Some(23.859));
        assert_eq!(probes[1].host, probes[0].host, "second probe repeats the same router");
        assert_eq!(probes[1].rtt_ms, Some(23.836));
        assert_eq!(
            probes[2].host.as_deref(),
            Some("lag-18.hcr02snaxtx40.netops.charter.com (24.27.13.144)"),
            "third probe switched routers on this ECMP path"
        );
        assert_eq!(probes[2].rtt_ms, Some(23.813));
    }

    /// The same ECMP-switch quirk, captured again with `-n` (no reverse
    /// DNS) — bare addresses only, still has to attach the right address
    /// to the right probe.
    #[test]
    fn preserves_a_mid_hop_router_change_numeric() {
        let line = " 4  24.27.13.144  17.470 ms 24.27.13.136  16.175 ms  15.767 ms\n";
        let hops = parse_traceroute_output(line);
        let probes = &hops[0].probes;
        assert_eq!(probes.len(), 3);
        assert_eq!(probes[0].host.as_deref(), Some("24.27.13.144"));
        assert_eq!(probes[1].host.as_deref(), Some("24.27.13.136"));
        assert_eq!(probes[2].host, probes[1].host);
    }

    /// Real output, `traceroute 8.8.8.8` — two consecutive hops lost in
    /// the middle of an otherwise-answering path.
    #[test]
    fn a_gap_in_the_middle_of_a_reachable_path_is_still_three_stars() {
        let out = " 7  lag-23.rcr01hstqtx02.netops.charter.com (24.175.32.156)  24.829 ms  24.358 ms  24.319 ms\n\
 8  * * *\n\
 9  * * *\n\
10  dns.google (8.8.8.8)  30.375 ms  30.015 ms  28.488 ms\n";
        let hops = parse_traceroute_output(out);
        assert_eq!(hops.len(), 4);
        assert_eq!(hops[1].hop, 8);
        assert!(hops[1].probes.iter().all(|p| p.rtt_ms.is_none()));
        assert_eq!(hops[2].hop, 9);
        assert_eq!(hops[3].hop, 10);
        assert_eq!(hops[3].probes[0].host.as_deref(), Some("dns.google (8.8.8.8)"));
    }

    /// LT-129, the regression this was raised for. A run killed at the
    /// deadline must come back with what it printed, not with nothing.
    ///
    /// Unix-only because it needs a shell that prints and then hangs; the
    /// behaviour under test is platform-independent, and the platform that
    /// actually suffers from it is Windows, where `tracert` is sequential and
    /// a dead path cannot finish inside any sane budget.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_run_cut_short_keeps_what_it_already_printed() {
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg("printf ' 1  a (10.0.0.1)  1.0 ms  1.0 ms  1.0 ms\n 2  * * *\n'; sleep 30")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd.kill_on_drop(true);

        let started = std::time::Instant::now();
        let run = run_bounded(cmd, Duration::from_millis(700)).await.expect("spawn");

        assert!(!run.complete, "a killed child did not finish on its own");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the wall clock did not bound the run: {:?}",
            started.elapsed()
        );
        // The whole point: the output survived the kill.
        let hops = parse_traceroute_output(&run.stdout);
        assert_eq!(hops.len(), 2, "lost the output of a killed child: {:?}", run.stdout);
        assert_eq!(hops[0].probes[0].host.as_deref(), Some("a (10.0.0.1)"));
    }

    /// The nine-hop `aws.com` case from the report, as the decision it turns
    /// into: cut short, but with hops, so it is a result and not an error.
    #[test]
    fn a_partial_path_is_a_result_not_an_error() {
        let cut_short = BoundedRun {
            stdout: " 1  _gateway (192.168.77.1)  0.572 ms  0.523 ms  0.526 ms\n\
 2  syn-070-121-192-001.res.spectrum.com (70.121.192.1)  16.395 ms  16.391 ms  16.330 ms\n\
 3  * * *\n"
                .into(),
            stderr: String::new(),
            complete: false,
        };
        let r = result_from("aws.com", &cut_short, "traceroute").expect("hops beat the deadline");
        assert_eq!(r.target, "aws.com");
        assert_eq!(r.hops.len(), 3);
        assert!(!r.complete, "it must still say the path was cut short");
        assert_eq!(r.hops[0].probes[0].host.as_deref(), Some("_gateway (192.168.77.1)"));
    }

    /// Cut short with nothing to show is the one case where the deadline is
    /// the story.
    #[test]
    fn cut_short_with_no_hops_still_reports_the_timeout() {
        let nothing =
            BoundedRun { stdout: String::new(), stderr: String::new(), complete: false };
        let err = result_from("aws.com", &nothing, "traceroute").expect_err("no hops");
        assert!(err.contains("did not finish"), "{err}");
    }

    /// A run that finished on its own says so, so the panel does not warn
    /// about a path that is perfectly complete.
    #[test]
    fn a_finished_run_is_marked_complete() {
        let done = BoundedRun {
            stdout: " 1  dns.google (8.8.8.8)  1.0 ms  1.0 ms  1.0 ms\n".into(),
            stderr: String::new(),
            complete: true,
        };
        let r = result_from("8.8.8.8", &done, "traceroute").expect("hops");
        assert!(r.complete);
    }

    /// An error from the command itself is still surfaced verbatim rather
    /// than being flattened into a timeout.
    #[test]
    fn a_real_failure_keeps_its_own_message() {
        let failed = BoundedRun {
            stdout: String::new(),
            stderr: "traceroute: unknown host nope.invalid".into(),
            complete: true,
        };
        let err = result_from("nope.invalid", &failed, "traceroute").expect_err("no hops");
        assert!(err.contains("unknown host"), "{err}");
    }

    async fn traceroute_available() -> bool {
        let program = if cfg!(windows) { "tracert.exe" } else { "traceroute" };
        Command::new(program)
            .arg(if cfg!(windows) { "-?" } else { "--version" })
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok()
    }

    #[tokio::test]
    async fn a_real_loopback_run_succeeds() {
        if !traceroute_available().await {
            eprintln!("skipping: no traceroute/tracert binary on this machine");
            return;
        }
        let result = run_traceroute("127.0.0.1", 10_000).await.expect("run_traceroute");
        assert!(!result.hops.is_empty());
        assert!(result.hops[0].probes.iter().any(|p| p.rtt_ms.is_some()));
    }

    #[tokio::test]
    async fn an_unroutable_target_is_reported_rather_than_hanging() {
        if !traceroute_available().await {
            eprintln!("skipping: traceroute not on this machine");
            return;
        }
        // A short overall budget against a target with no route: this must
        // come back (either as an error or as all-stars hops) well inside
        // the timeout, never hang for the caller.
        let result = run_traceroute("192.0.2.1", 8_000).await;
        match result {
            Ok(r) => assert!(r.hops.iter().any(|h| h.probes.iter().all(|p| p.rtt_ms.is_none()))),
            Err(e) => assert!(!e.is_empty()),
        }
    }
}
