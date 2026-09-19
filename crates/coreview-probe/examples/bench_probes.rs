//! Validation throughput, measured (LT-270).
//!
//! Runs the real probe engine with many TCP checks against a listener on
//! loopback, each set to fire every second, for a fixed time, and reports how
//! many results arrived, how many that is per second, and how far apart one
//! check's results really were — the scheduling a long validation window
//! depends on.
//!
//!     cargo run --release -p coreview-probe --example bench_probes -- [probes] [seconds] [max concurrency]
//!
//! Measured, not asserted.

use std::collections::HashMap;
use std::time::Duration;

use coreview_probe::engine::{Engine, EngineEvent};
use coreview_probe::types::{ProbeConfig, ProbeKind};

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let probes: usize = args.next().and_then(|a| a.parse().ok()).unwrap_or(500);
    let seconds: u64 = args.next().and_then(|a| a.parse().ok()).unwrap_or(20);
    let concurrency: usize = args.next().and_then(|a| a.parse().ok()).unwrap_or(64);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            drop(stream);
        }
    });

    let (engine, mut events) = Engine::new(concurrency);
    let configs: Vec<ProbeConfig> = (0..probes)
        .map(|i| {
            let mut c = ProbeConfig::defaults(&format!("p{i}"), "bench", &format!("n{i}"), "127.0.0.1");
            c.kind = ProbeKind::Tcp;
            c.tcp_port = Some(u32::from(port));
            c.interval_seconds = 1;
            c.timeout_ms = 1000;
            c
        })
        .collect();
    engine.start("bench".into(), "bench".into(), configs).await.expect("start");

    let mut seen: HashMap<String, Vec<i64>> = HashMap::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break,
            e = events.recv() => match e {
                Some(EngineEvent::Sample { result, .. }) => seen.entry(result.probe_id.clone()).or_default().push(result.timestamp_ms),
                Some(_) => {}
                None => break,
            }
        }
    }
    engine.stop().await;

    let total: usize = seen.values().map(Vec::len).sum();
    let mut gaps: Vec<i64> = seen.values().flat_map(|t| t.windows(2).map(|w| w[1] - w[0]).collect::<Vec<_>>()).collect();
    gaps.sort_unstable();
    let pct = |p: f64| gaps.get(((gaps.len() as f64 - 1.0) * p).round() as usize).copied().unwrap_or(0);
    println!("{probes} TCP checks every 1 s for {seconds} s, at most {concurrency} at once");
    println!("results            {total}");
    println!("results per second {:.1} (the schedule asks for {probes})", total as f64 / seconds as f64);
    println!("checks that ran    {} of {probes}", seen.len());
    println!("gap between results, ms: p50 {}  p95 {}  p99 {}  max {}", pct(0.5), pct(0.95), pct(0.99), gaps.last().copied().unwrap_or(0));
}
