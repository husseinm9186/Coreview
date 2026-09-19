//! Run a real sweep against a real subnet and print what came back.
//!
//! The counterpart to `icmp_once`: the harnesses and unit tests prove the
//! parsers, and this proves the whole thing against a live network, which is
//! the only place a name lookup or an ARP read can actually be judged.
//!
//! ```text
//! cargo run -p coreview-probe --example sweep_subnet -- 192.168.77.0/24
//! ```

use coreview_probe::sweep::{parse_sweepable_cidr, sweep, SweepEvent, SweepOptions};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() {
    let arg = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: sweep_subnet <cidr>  (for example 192.168.77.0/24)");
        std::process::exit(2);
    });
    let cidr = match parse_sweepable_cidr(&arg) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };

    let (tx, mut rx) = mpsc::channel(256);
    let started = std::time::Instant::now();
    let printer = tokio::spawn(async move {
        let mut found = 0;
        while let Some(event) = rx.recv().await {
            match event {
                SweepEvent::Started { total } => println!("sweeping {total} addresses\n"),
                SweepEvent::Alive(hit) => {
                    found += 1;
                    let name = hit.hostname.as_deref().unwrap_or("—");
                    let source = match hit.name_source {
                        Some(s) => format!("{s:?}"),
                        None => "—".into(),
                    };
                    let ports: Vec<String> = hit
                        .ports
                        .iter()
                        .map(|p| format!("{}/{}", p.port, p.service))
                        .collect();
                    println!(
                        "{:<16} {:<26} {:<11} {:<18} {:<24} {:<36} {:<18} {}",
                        hit.ip,
                        name,
                        source,
                        hit.mac.as_deref().unwrap_or("—"),
                        hit.vendor.as_deref().unwrap_or("—"),
                        if ports.is_empty() { "—".to_string() } else { ports.join(" ") },
                        // LT-124: what the host's certificate said.
                        hit.serial.as_deref().unwrap_or("—"),
                        hit.product.as_deref().unwrap_or("—"),
                    );
                    if hit.web_server.is_some() || hit.web_title.is_some() {
                        println!(
                            "{:<16} web: server {:?}, title {:?}",
                            "",
                            hit.web_server.as_deref().unwrap_or("—"),
                            hit.web_title.as_deref().unwrap_or("—"),
                        );
                    }
                }
                SweepEvent::Finished { alive, scanned, .. } => {
                    println!("\n{alive} alive of {scanned} scanned, {found} printed");
                }
                SweepEvent::Progress { .. } => {}
            }
        }
    });

    println!(
        "{:<16} {:<26} {:<8} {:<18} {:<24} PORTS",
        "ADDRESS", "NAME", "SOURCE", "MAC", "MANUFACTURER"
    );
    sweep(cidr, SweepOptions::default(), tx, CancellationToken::new()).await;
    let _ = printer.await;
    println!("took {:.1}s", started.elapsed().as_secs_f64());
}
