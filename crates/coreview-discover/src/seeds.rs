//! Where a crawl starts (LT-207).
//!
//! One seed address was enough for a network with one core. An estate with
//! several sites, or a flat range nobody has a map of, needs several starting
//! points: a list of addresses, some hostnames, a CIDR range, or a CSV someone
//! exported from an asset register.
//!
//! A range is not dialled address by address. Logging into two hundred and
//! fifty empty addresses means two hundred and fifty SSH timeouts; instead each
//! address gets a short TCP connection attempt on the login port, many at once,
//! and only the ones that answer become seeds. A hostname is resolved once,
//! here, to the address the crawl dials.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use coreview_probe::sweep::parse_cidr;

/// The largest range accepted as a seed: a /20. A bigger one is a sweep's job.
pub const MAX_RANGE_HOSTS: u32 = 4094;
/// How long an address in a range has to accept a connection on the login port.
const PORT_CHECK: Duration = Duration::from_millis(800);
/// How many of those checks at once.
const PARALLEL: usize = 64;

/// A seed that could not be used, and why.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedSeed {
    pub seed: String,
    pub reason: String,
}

/// What one line of seeds turns into before anything is checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seed {
    Address(String),
    Range(coreview_probe::sweep::Cidr),
    Hostname(String),
}

/// Splits a seed list — commas, spaces, semicolons or new lines — and says what
/// each item is. Anything that is none of the three is skipped with a reason.
pub fn parse_seeds(text: &str) -> (Vec<Seed>, Vec<SkippedSeed>) {
    let mut seeds = Vec::new();
    let mut skipped = Vec::new();
    for raw in text.split(|c: char| c == ',' || c == ';' || c.is_whitespace()) {
        let item = raw.trim();
        if item.is_empty() {
            continue;
        }
        if item.contains('/') {
            match parse_cidr(item) {
                Ok(c) if c.host_count() <= MAX_RANGE_HOSTS => seeds.push(Seed::Range(c)),
                Ok(_) => skipped.push(SkippedSeed {
                    seed: item.into(),
                    reason: format!("larger than a /20 ({MAX_RANGE_HOSTS} addresses); sweep it first"),
                }),
                Err(e) => skipped.push(SkippedSeed { seed: item.into(), reason: e.to_string() }),
            }
        } else if item.parse::<IpAddr>().is_ok() {
            seeds.push(Seed::Address(item.into()));
        } else if is_hostname(item) {
            seeds.push(Seed::Hostname(item.into()));
        } else {
            skipped.push(SkippedSeed { seed: item.into(), reason: "not an address, a range or a hostname".into() });
        }
    }
    (seeds, skipped)
}

/// Letters, digits, hyphens and dots, labels of 1–63, 253 in all.
fn is_hostname(s: &str) -> bool {
    s.len() <= 253
        && s.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
        && s.chars().any(|c| c.is_ascii_alphabetic())
}

/// Turns seeds into addresses to dial, in the order given, each once.
///
/// `allowed` is the crawl's own subnet limit: a seed outside it is skipped, the
/// same as a neighbour outside it would be.
pub async fn resolve_seeds(
    seeds: &[Seed],
    port: u16,
    allowed: impl Fn(&str) -> bool,
) -> (Vec<String>, Vec<SkippedSeed>) {
    let mut out: Vec<String> = Vec::new();
    let mut skipped = Vec::new();
    let push = |addr: String, out: &mut Vec<String>| {
        if !out.contains(&addr) {
            out.push(addr);
        }
    };
    for seed in seeds {
        match seed {
            Seed::Address(a) => {
                if allowed(a) {
                    push(a.clone(), &mut out);
                } else {
                    skipped.push(SkippedSeed { seed: a.clone(), reason: "outside the subnets this crawl may enter".into() });
                }
            }
            Seed::Hostname(name) => match tokio::net::lookup_host((name.as_str(), port)).await {
                Ok(mut addrs) => match addrs.find(|a| a.is_ipv4()) {
                    Some(a) if allowed(&a.ip().to_string()) => push(a.ip().to_string(), &mut out),
                    Some(a) => skipped.push(SkippedSeed {
                        seed: name.clone(),
                        reason: format!("resolves to {}, outside the subnets this crawl may enter", a.ip()),
                    }),
                    None => skipped.push(SkippedSeed { seed: name.clone(), reason: "has no IPv4 address".into() }),
                },
                Err(_) => skipped.push(SkippedSeed { seed: name.clone(), reason: "does not resolve".into() }),
            },
            Seed::Range(cidr) => {
                let candidates: Vec<Ipv4Addr> = cidr.hosts().filter(|ip| allowed(&ip.to_string())).collect();
                let answering = listening(&candidates, port).await;
                if answering.is_empty() {
                    skipped.push(SkippedSeed {
                        seed: format!("{}/{}", cidr.network(), cidr.prefix()),
                        reason: format!("nothing in it accepted a connection on port {port}"),
                    });
                }
                for ip in answering {
                    push(ip.to_string(), &mut out);
                }
            }
        }
    }
    (out, skipped)
}

/// The addresses that accept a TCP connection on `port`, in the order given.
async fn listening(addresses: &[Ipv4Addr], port: u16) -> Vec<Ipv4Addr> {
    let mut found = Vec::new();
    for chunk in addresses.chunks(PARALLEL) {
        let mut set = tokio::task::JoinSet::new();
        for (i, ip) in chunk.iter().enumerate() {
            let target = SocketAddr::new(IpAddr::V4(*ip), port);
            set.spawn(async move {
                let open = matches!(
                    tokio::time::timeout(PORT_CHECK, tokio::net::TcpStream::connect(target)).await,
                    Ok(Ok(_))
                );
                (i, open)
            });
        }
        let mut open = vec![false; chunk.len()];
        while let Some(Ok((i, yes))) = set.join_next().await {
            open[i] = yes;
        }
        found.extend(chunk.iter().zip(open).filter(|(_, o)| *o).map(|(ip, _)| *ip));
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_addresses_ranges_and_names_from_any_separator() {
        let (seeds, skipped) = parse_seeds("192.0.2.1, core-sw1.example.test;198.51.100.0/30\n  bad_name!  10.0.0.0/8");
        assert_eq!(seeds.len(), 3);
        assert_eq!(seeds[0], Seed::Address("192.0.2.1".into()));
        assert_eq!(seeds[1], Seed::Hostname("core-sw1.example.test".into()));
        assert!(matches!(seeds[2], Seed::Range(_)));
        assert_eq!(skipped.len(), 2);
        assert!(skipped[0].reason.contains("not an address"));
        assert!(skipped[1].reason.contains("larger than a /20"));
    }

    #[tokio::test]
    async fn a_range_becomes_only_the_addresses_that_answer_on_the_login_port() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { while listener.accept().await.is_ok() {} });

        let (seeds, _) = parse_seeds("127.0.0.0/30");
        let (addrs, skipped) = resolve_seeds(&seeds, port, |_| true).await;
        // 127.0.0.1 is listening; 127.0.0.2 is loopback too but nothing is bound there.
        assert_eq!(addrs, vec!["127.0.0.1"]);
        assert!(skipped.is_empty());
    }

    #[tokio::test]
    async fn names_resolve_duplicates_collapse_and_the_subnet_limit_applies() {
        let (seeds, _) = parse_seeds("localhost 127.0.0.1 192.0.2.9 no-such-host.invalid");
        let (addrs, skipped) = resolve_seeds(&seeds, 22, |a| a.starts_with("127.")).await;
        assert_eq!(addrs, vec!["127.0.0.1"]);
        let reasons: Vec<&str> = skipped.iter().map(|s| s.reason.as_str()).collect();
        assert!(reasons.iter().any(|r| r.contains("outside the subnets")), "{reasons:?}");
        assert!(reasons.iter().any(|r| r.contains("does not resolve")), "{reasons:?}");
    }
}
