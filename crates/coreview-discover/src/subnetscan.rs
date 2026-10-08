//! The box beside a subnet — scan all of it.
//!
//! Neighbours (CDP, LLDP, next hops) are the crawl's first way of finding the
//! next device, and they lead to the devices that are cabled to something
//! already reached. A ticked subnet adds the second way: every address in it
//! that accepts a connection on the login port is something to log in to,
//! whether or not a neighbour named it. What it is — switch, router, firewall,
//! controller — is learned the way any device's is, by logging in and asking.
//!
//! The sweep is a TCP connect to the login port, nothing more: no ping (a
//! router that drops ICMP still takes SSH), no other ports, and nothing sent
//! once the connection is made — it is closed at once. It runs from this
//! computer, so a subnet this computer cannot route to answers nothing; the
//! devices there are still reached through their neighbours when hopping is on,
//! which the run's log says.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use coreview_probe::sweep::{parse_cidr, Cidr};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

/// The largest subnet one box may sweep: a /16. A bigger one is refused when
/// the run starts, with this number in the message, rather than quietly cut.
pub const MAX_SCAN_HOSTS: u32 = 65_536;

/// Connections in flight at once. Each is one SYN and, when answered, one
/// immediate close; a /24 takes about a second and a /16 under a few minutes.
pub const SCAN_CONCURRENCY: usize = 256;

/// How long one address may take to accept.
pub const SCAN_TIMEOUT: Duration = Duration::from_millis(1_500);

/// Parse the ticked subnets, refusing one too large to sweep.
pub fn parse_scan_subnets(texts: &[String]) -> Result<Vec<Cidr>, String> {
    let mut out: Vec<Cidr> = Vec::new();
    for text in texts.iter().map(|t| t.trim()).filter(|t| !t.is_empty()) {
        let c = parse_cidr(text).map_err(|e| format!("{text}: {e}"))?;
        if c.host_count() > MAX_SCAN_HOSTS {
            return Err(format!("{text} holds {} addresses; a scanned subnet may hold at most {MAX_SCAN_HOSTS} (a /16). Split it, or untick its scan box to use it only as a limit.", c.host_count()));
        }
        if !out.iter().any(|o| o.network() == c.network() && o.prefix() == c.prefix()) {
            out.push(c);
        }
    }
    Ok(out)
}

/// What one subnet's sweep found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubnetScan {
    pub subnet: String,
    pub tried: u32,
    /// The addresses that accepted, in address order.
    pub answered: Vec<String>,
}

/// Sweep each subnet for the login port. Cancelling stops new connections at
/// once; what answered by then is returned.
pub async fn sweep_login_port(subnets: &[Cidr], port: u16, timeout: Duration, cancel: &CancellationToken) -> Vec<SubnetScan> {
    let mut out = Vec::new();
    for cidr in subnets {
        let permits = Arc::new(Semaphore::new(SCAN_CONCURRENCY));
        let mut tasks = tokio::task::JoinSet::new();
        let mut tried = 0u32;
        for ip in cidr.hosts() {
            if cancel.is_cancelled() {
                break;
            }
            let Ok(permit) = Arc::clone(&permits).acquire_owned().await else { break };
            tried += 1;
            let cancel = cancel.clone();
            tasks.spawn(async move {
                let _permit = permit;
                tokio::select! {
                    _ = cancel.cancelled() => None,
                    r = accepts(ip, port, timeout) => r.then_some(ip),
                }
            });
        }
        let mut answered: Vec<Ipv4Addr> = Vec::new();
        while let Some(j) = tasks.join_next().await {
            if let Ok(Some(ip)) = j {
                answered.push(ip);
            }
        }
        answered.sort();
        out.push(SubnetScan { subnet: format!("{}/{}", cidr.network(), cidr.prefix()), tried, answered: answered.into_iter().map(|a| a.to_string()).collect() });
        if cancel.is_cancelled() {
            break;
        }
    }
    out
}

async fn accepts(ip: Ipv4Addr, port: u16, timeout: Duration) -> bool {
    matches!(tokio::time::timeout(timeout, tokio::net::TcpStream::connect(SocketAddr::new(IpAddr::V4(ip), port))).await, Ok(Ok(_)))
}

/// The run log's line for one subnet's sweep.
pub fn describe(scan: &SubnetScan, port: u16) -> String {
    match scan.answered.len() {
        0 => format!("scan of {}: none of {} addresses accepted a connection on port {port} from this computer — devices there are reached only through their neighbours", scan.subnet, scan.tried),
        1 => format!("scan of {}: 1 of {} addresses accepted a connection on port {port}", scan.subnet, scan.tried),
        n => format!("scan of {}: {n} of {} addresses accepted a connection on port {port}", scan.subnet, scan.tried),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_subnet_larger_than_a_slash_16_is_refused_and_says_why() {
        assert!(parse_scan_subnets(&["10.0.0.0/16".into()]).is_ok());
        let e = parse_scan_subnets(&["10.0.0.0/15".into()]).unwrap_err();
        assert!(e.contains("at most 65536"), "{e}");
        assert!(parse_scan_subnets(&["not a subnet".into()]).is_err());
    }

    #[test]
    fn the_same_subnet_ticked_twice_is_swept_once() {
        let got = parse_scan_subnets(&["192.0.2.0/24".into(), " 192.0.2.7/24 ".into(), String::new()]).unwrap();
        assert_eq!(got.len(), 1);
    }

    /// Only what accepts on the login port is returned: two listeners on
    /// 127.0.0.0/29 are found, the rest of the subnet is not.
    #[tokio::test]
    async fn only_addresses_that_accept_on_the_login_port_are_found() {
        let a = tokio::net::TcpListener::bind("127.0.0.2:0").await.unwrap();
        let port = a.local_addr().unwrap().port();
        let Ok(b) = tokio::net::TcpListener::bind(("127.0.0.5", port)).await else { return };
        let subnets = parse_scan_subnets(&["127.0.0.0/29".into()]).unwrap();
        let got = sweep_login_port(&subnets, port, Duration::from_millis(500), &CancellationToken::new()).await;
        drop((a, b));
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].answered, ["127.0.0.2", "127.0.0.5"]);
        assert_eq!(got[0].tried, 6);
        assert!(describe(&got[0], port).contains("2 of 6"));
    }
}
