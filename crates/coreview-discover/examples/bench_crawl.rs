//! Crawl throughput, measured (LT-270).
//!
//! Starts a fake network of SSH switches on loopback — 127.1.0.x, every one a
//! real SSH server — wired as a binary tree over CDP (switch *n* advertises
//! 2*n* and 2*n*+1), so a crawl can fan out. Each command takes a set time to
//! answer, standing in for a real device. Then it crawls the whole tree at
//! several concurrencies and prints devices per second.
//!
//!     cargo run --release -p coreview-discover --example bench_crawl -- [devices] [ms per command]
//!
//! Measured, not asserted: the numbers belong in the roadmap entry with the
//! machine they came from.

use std::sync::Arc;
use std::time::{Duration, Instant};

use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId};
use tokio_util::sync::CancellationToken;

use coreview_discover::crawl::{crawl_from, CrawlOptions};
use coreview_discover::filter::DiscoveryFilter;
use coreview_discover::hostkeys::HostKeyStore;
use coreview_discover::ssh::{Credentials, Secret, SshOptions};
use coreview_probe::sweep::parse_cidr;

#[derive(Clone)]
struct Fake {
    n: usize,
    total: usize,
    delay: Duration,
}

fn address(n: usize) -> String {
    format!("127.1.{}.{}", n / 250, n % 250 + 1)
}

impl server::Handler for Fake {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if password == "not-a-real-password" { Auth::Accept } else { Auth::Reject { proceed_with_methods: None, partial_success: false } })
    }

    async fn channel_open_session(&mut self, _c: Channel<Msg>, reply: server::ChannelOpenHandle, _s: &mut Session) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn pty_request(&mut self, _c: ChannelId, _t: &str, _a: u32, _b: u32, _d: u32, _e: u32, _m: &[(russh::Pty, u32)], _s: &mut Session) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        session.data(channel, format!("\r\nSW{}#", self.n).into_bytes())?;
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        let command = String::from_utf8_lossy(data).trim().to_string();
        tokio::time::sleep(self.delay).await;
        let body = match command.as_str() {
            "show cdp neighbors detail" => [2 * self.n, 2 * self.n + 1]
                .into_iter()
                .filter(|c| *c <= self.total)
                .map(|c| {
                    format!(
                        "-------------------------\r\nDevice ID: SW{c}\r\nEntry address(es):\r\n  IP address: {}\r\nPlatform: cisco WS-C2960X-24TS-L,  Capabilities: Switch IGMP\r\nInterface: GigabitEthernet1/0/{c},  Port ID (outgoing port): GigabitEthernet1/0/1\r\nHoldtime : 137 sec\r\n\r\n",
                        address(c)
                    )
                })
                .collect::<String>(),
            "show version" => format!("Cisco IOS Software, Version 15.2(4)E7\r\nModel number            : WS-C2960X-24TS-L\r\nSW{} uptime is 3 weeks\r\n", self.n),
            "terminal length 0" | "enable" => String::new(),
            _ => "% Invalid input detected at '^' marker.\r\n".into(),
        };
        session.data(channel, format!("{command}\r\n{body}SW{}#", self.n).into_bytes())?;
        Ok(())
    }
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let total: usize = args.next().and_then(|a| a.parse().ok()).unwrap_or(63);
    let delay = Duration::from_millis(args.next().and_then(|a| a.parse().ok()).unwrap_or(50));

    let port = {
        let l = tokio::net::TcpListener::bind("127.1.0.1:0").await.expect("loopback");
        l.local_addr().unwrap().port()
    };
    let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let config = Arc::new(server::Config { inactivity_timeout: Some(Duration::from_secs(60)), auth_rejection_time: Duration::from_millis(1), keys: vec![key], ..Default::default() });
    for n in 1..=total {
        let listener = tokio::net::TcpListener::bind((address(n).as_str(), port)).await.expect("bind");
        let (config, fake) = (Arc::clone(&config), Fake { n, total, delay });
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (config, fake) = (Arc::clone(&config), fake.clone());
                tokio::spawn(async move {
                    let _ = server::run_stream(config, stream, fake).await;
                });
            }
        });
    }

    println!("{total} fake switches, {} ms per command", delay.as_millis());
    println!("{:>12} {:>10} {:>10} {:>14}", "concurrency", "devices", "seconds", "devices / s");
    for concurrency in [1usize, 4, 16, 32] {
        let options = CrawlOptions {
            filter: DiscoveryFilter { subnets: vec![parse_cidr("127.1.0.0/16").unwrap()], ..Default::default() },
            ssh: SshOptions { port, connect_timeout: Duration::from_secs(5), auth_timeout: Duration::from_secs(10), command_timeout: Duration::from_secs(10) },
            max_hops: 64,
            max_devices: total + 10,
            concurrency,
            details: coreview_discover::crawl::DetailOptions { routes: false, spanning_tree: false, vlans: false },
            ..Default::default()
        };
        let creds = Credentials { username: "bench".into(), password: Secret::new("not-a-real-password"), enable_password: None };
        let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
        let (tx, mut rx) = tokio::sync::mpsc::channel(4096);
        tokio::spawn(async move { while rx.recv().await.is_some() {} });
        let started = Instant::now();
        let result = crawl_from(&[address(1)], creds, options, store, tx, CancellationToken::new()).await;
        let secs = started.elapsed().as_secs_f64();
        println!("{:>12} {:>10} {:>10.2} {:>14.1}", concurrency, result.devices.len(), secs, result.devices.len() as f64 / secs);
    }
}
