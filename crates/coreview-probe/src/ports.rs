//! Which of the usual ports a host is listening on (LT-121).
//!
//! A TCP connect, nothing cleverer: the socket either completes the handshake
//! or it does not. No half-open scanning, no raw sockets, no privilege — the
//! difference matters, because a SYN scan needs root on every platform and
//! would turn an app anyone can run into one that has to be run as
//! administrator.
//!
//! **What a closed port costs versus a filtered one.** A closed port answers
//! RST immediately, so it costs a round trip. A *filtered* port — dropped by a
//! firewall — answers nothing at all and costs the whole timeout. The list is
//! therefore short and the timeout tight: the point is to say "this is a
//! switch with SSH and a web interface", not to inventory 65,535 ports.
//!
//! **Ports are opened under a shared permit.** A /24 at 64 hosts in flight,
//! each opening a dozen sockets, is eight hundred file descriptors — past the
//! default limit on most Linux machines, where the failure mode is unrelated
//! parts of the app failing to open files. The caller passes a semaphore and
//! the scan borrows from it.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use tokio::time::timeout;

/// The ports worth trying, and what to call them.
///
/// Chosen for what identifies a device on the kind of network this app is
/// pointed at — management interfaces, remote access, shares and printing —
/// rather than for breadth. SSH and Telnet say "managed network gear"; 445
/// and 3389 say "Windows"; 9100 says "printer"; 5900 says "there is a VNC
/// server somebody forgot about".
pub const COMMON_PORTS: &[(u16, &str)] = &[
    (21, "FTP"),
    (22, "SSH"),
    (23, "Telnet"),
    (53, "DNS"),
    (80, "HTTP"),
    (135, "MSRPC"),
    (139, "NetBIOS"),
    (443, "HTTPS"),
    (445, "SMB"),
    (515, "LPD"),
    (3306, "MySQL"),
    (3389, "RDP"),
    (5432, "PostgreSQL"),
    (5900, "VNC"),
    (8006, "Proxmox"),
    (8080, "HTTP-alt"),
    (8443, "HTTPS-alt"),
    (9100, "JetDirect"),
];

/// A port that completed a handshake.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPort {
    pub port: u16,
    /// What normally listens there. Not what *is* listening: nothing here
    /// reads a banner, so this is the registry's name for the number and is
    /// labelled that way in the interface.
    pub service: String,
}

/// The registered name for a port number, where this knows one.
pub fn service_for(port: u16) -> Option<&'static str> {
    COMMON_PORTS.iter().find(|(p, _)| *p == port).map(|(_, name)| *name)
}

/// Tries every port at once and reports those that answered, in order.
///
/// Every port is attempted concurrently, so the whole scan costs about one
/// timeout rather than one per port — with the permits as the only brake.
pub async fn scan(
    ip: Ipv4Addr,
    ports: &[(u16, &str)],
    timeout_ms: u64,
    permits: Arc<Semaphore>,
) -> Vec<OpenPort> {
    let mut tasks = Vec::with_capacity(ports.len());
    for (port, service) in ports {
        let (port, service) = (*port, service.to_string());
        let permits = Arc::clone(&permits);
        tasks.push(tokio::spawn(async move {
            let _permit = permits.acquire_owned().await.ok()?;
            if is_open(ip, port, timeout_ms).await {
                Some(OpenPort { port, service })
            } else {
                None
            }
        }));
    }
    let mut open = Vec::new();
    for task in tasks {
        if let Ok(Some(hit)) = task.await {
            open.push(hit);
        }
    }
    open.sort_by_key(|p| p.port);
    open
}

/// Whether a handshake completes inside the timeout.
///
/// The connection is dropped the moment it is established — this asks whether
/// something is listening and nothing more. It sends no bytes, so there is
/// nothing for the far end to log beyond a connection that opened and closed.
pub async fn is_open(ip: Ipv4Addr, port: u16, timeout_ms: u64) -> bool {
    let addr = SocketAddr::from((ip, port));
    matches!(timeout(Duration::from_millis(timeout_ms), TcpStream::connect(addr)).await, Ok(Ok(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_is_sorted_and_has_no_repeats() {
        let numbers: Vec<u16> = COMMON_PORTS.iter().map(|(p, _)| *p).collect();
        let mut sorted = numbers.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(numbers, sorted, "COMMON_PORTS must be sorted with no duplicates");
    }

    #[test]
    fn names_the_ports_an_engineer_would_recognise() {
        assert_eq!(service_for(22), Some("SSH"));
        assert_eq!(service_for(443), Some("HTTPS"));
        assert_eq!(service_for(9100), Some("JetDirect"));
        assert_eq!(service_for(1), None);
    }

    /// A listener on loopback is found; the port it is not on is not. Bound
    /// to port 0 so the OS picks one that is genuinely free — a fixed port
    /// would make this test fail on a machine that happens to be using it.
    #[tokio::test]
    async fn finds_a_real_listener_and_not_a_closed_port() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let open_port = listener.local_addr().expect("addr").port();
        let closed = {
            let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
            let p = probe.local_addr().expect("addr").port();
            drop(probe);
            p
        };
        let ip: Ipv4Addr = "127.0.0.1".parse().unwrap();
        assert!(is_open(ip, open_port, 1_000).await, "a bound port must be found");
        assert!(!is_open(ip, closed, 1_000).await, "a port nothing is bound to must not");
    }

    /// The scan reports what it found, sorted, and reports nothing for a host
    /// with nothing listening.
    #[tokio::test]
    async fn scans_a_list_and_returns_what_answered() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let open_port = listener.local_addr().expect("addr").port();
        let ip: Ipv4Addr = "127.0.0.1".parse().unwrap();
        let permits = Arc::new(Semaphore::new(8));

        let found = scan(ip, &[(open_port, "Test")], 1_000, Arc::clone(&permits)).await;
        assert_eq!(found, vec![OpenPort { port: open_port, service: "Test".into() }]);

        // Permits are returned, so a second scan is not starved by the first.
        assert_eq!(permits.available_permits(), 8);
    }
}
