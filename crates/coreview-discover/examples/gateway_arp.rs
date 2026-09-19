//! Reads a device's ARP table over SNMP (LT-124) — the optional step the ping
//! sweep offers for hosts behind a router, through the same function.
//!
//! Reads only. Prints how many entries came back; the entries themselves only
//! when `CV_SHOW_ENTRIES` is set, because they identify a real network.
//!
//! ```text
//! CV_HOST=192.0.2.1 CV_COMMUNITY=public \
//!   cargo run -p coreview-discover --example gateway_arp
//! CV_HOST=192.0.2.1 CV_V3_USER=netops CV_V3_AUTH=sha CV_V3_AUTH_PASS=... \
//!   CV_V3_PRIV=aes CV_V3_PRIV_PASS=... \
//!   cargo run -p coreview-discover --example gateway_arp
//! ```

use std::time::Duration;

use coreview_discover::snmp::{arp_table, AuthKind, PrivKind, SnmpAuth};

/// Runs `run` the way the desktop app runs a command: spawned as a task on a
/// multi-threaded tokio runtime, so its future lives on the heap and only
/// polling uses a worker thread's stack. `CV_STACK_KB` sets that stack — a
/// Tauri command's worker has tokio's default 2 MiB — so a stack problem is
/// judged under the app's conditions rather than a stricter artificial one.
fn main() {
    let stack_kb: usize = std::env::var("CV_STACK_KB").ok().and_then(|v| v.parse().ok()).unwrap_or(2048);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .thread_stack_size(stack_kb * 1024)
        .enable_all()
        .build()
        .expect("runtime");
    runtime
        .block_on(async { tokio::spawn(run()).await })
        .expect("the run task panicked");
}

async fn run() {
    let host = std::env::var("CV_HOST").expect("set CV_HOST");
    let auth = if let Ok(username) = std::env::var("CV_V3_USER") {
        SnmpAuth::V3 {
            username,
            auth_protocol: AuthKind::parse(&std::env::var("CV_V3_AUTH").unwrap_or_else(|_| "sha".into()))
                .expect("bad CV_V3_AUTH"),
            auth_password: std::env::var("CV_V3_AUTH_PASS").expect("set CV_V3_AUTH_PASS"),
            privacy: std::env::var("CV_V3_PRIV").ok().map(|p| PrivKind::parse(&p).expect("bad CV_V3_PRIV")),
            privacy_password: std::env::var("CV_V3_PRIV_PASS").unwrap_or_default(),
        }
    } else {
        SnmpAuth::V2c {
            community: std::env::var("CV_COMMUNITY").expect("set CV_COMMUNITY or CV_V3_USER"),
        }
    };

    match arp_table(&host, 161, &auth, Duration::from_secs(4)).await {
        Err(e) => {
            eprintln!("failed: {e}");
            std::process::exit(1);
        }
        Ok(entries) => {
            println!("{} ARP entries from {host}", entries.len());
            if std::env::var("CV_SHOW_ENTRIES").is_ok() {
                for e in &entries {
                    println!("  {:<16} {}", e.ip, e.mac);
                }
            }
        }
    }
}
