//! A UDP service answers (LT-217).
//!
//! UDP has no handshake, so "is the port open" has only three honest answers:
//! a reply came back, which proves a service is there; the host said nothing is
//! listening (an ICMP port-unreachable, which the OS reports on a connected
//! socket as a refused connection); or nothing came back, which means the port
//! is open but the service ignored what was sent, or a firewall dropped it —
//! and the two cannot be told apart. A reply needs a request the service
//! understands, so the probe sends one: a DNS query, an NTP client request, or
//! bytes the operator gives in hex.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use tokio::net::UdpSocket;
use tokio::time::timeout;

use crate::types::{Outcome, ProbeResult};
use crate::validate::{parse_target, validate_port};

/// The bytes a payload setting stands for: `dns` (a query for the root's NS
/// records), `ntp` (an NTPv4 client request), or hex digits. Empty sends an
/// empty datagram, which some services answer.
pub fn payload_bytes(setting: Option<&str>) -> Result<Vec<u8>, String> {
    let text = setting.map(str::trim).unwrap_or("");
    match text.to_ascii_lowercase().as_str() {
        "" => Ok(Vec::new()),
        // ID 0xC0DE, RD, one question: `.` NS IN.
        "dns" => Ok(vec![0xC0, 0xDE, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1]),
        // LI 0, version 4, mode 3 (client); the rest may be zero.
        "ntp" => {
            let mut p = vec![0u8; 48];
            p[0] = 0x23;
            Ok(p)
        }
        hex => {
            let digits: String = hex.chars().filter(|c| !c.is_whitespace() && *c != ':').collect();
            if !digits.len().is_multiple_of(2) || digits.len() > 2_048 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(format!("{text} is not dns, ntp or an even number of hex digits"));
            }
            Ok((0..digits.len()).step_by(2).map(|i| u8::from_str_radix(&digits[i..i + 2], 16).unwrap_or(0)).collect())
        }
    }
}

/// Whether a receive error on a connected UDP socket means the host said
/// nothing listens on the port: `ConnectionRefused` on Linux and macOS,
/// `ConnectionReset` on Windows, for the same ICMP port-unreachable.
pub fn closed_port(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::ConnectionReset)
}

pub async fn probe_udp(
    probe_id: &str,
    raw_target: &str,
    port: u32,
    payload: Option<&str>,
    timeout_ms: u64,
    now_ms: i64,
) -> ProbeResult {
    let fail = |outcome, text: &str| ProbeResult::failed(probe_id, now_ms, outcome, text);
    let target = match parse_target(raw_target) {
        Ok(t) => t,
        Err(e) => return fail(Outcome::InvalidTarget, &e.to_string()),
    };
    let port = match validate_port(port) {
        Ok(p) => p,
        Err(e) => return fail(Outcome::InvalidTarget, &e.to_string()),
    };
    let bytes = match payload_bytes(payload) {
        Ok(b) => b,
        Err(e) => return fail(Outcome::InvalidTarget, &e),
    };
    let to: SocketAddr = match tokio::net::lookup_host((target.as_str(), port)).await.ok().and_then(|mut a| a.next()) {
        Some(a) => a,
        None => return fail(Outcome::DnsFailure, &format!("{} could not be resolved", target.as_str())),
    };
    let socket = match UdpSocket::bind(if to.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" }).await {
        Ok(s) => s,
        Err(e) => return fail(Outcome::OsError, &e.to_string()),
    };
    if let Err(e) = socket.connect(to).await {
        return fail(Outcome::OsError, &e.to_string());
    }
    let started = Instant::now();
    if let Err(e) = socket.send(&bytes).await {
        return fail(Outcome::OsError, &e.to_string());
    }
    let mut buf = [0u8; 2048];
    match timeout(Duration::from_millis(timeout_ms), socket.recv(&mut buf)).await {
        Ok(Ok(n)) => {
            let rtt = started.elapsed().as_secs_f64() * 1000.0;
            ProbeResult {
                probe_id: probe_id.to_string(),
                timestamp_ms: now_ms,
                outcome: Outcome::Success,
                rtt_ms: Some(rtt),
                resolved: vec![],
                summary: format!("UDP {port} answered with {n} bytes, {rtt:.0} ms"),
                error_message: None,
            }
        }
        // Linux reports the host's port-unreachable as a refused connection;
        // Windows reports the same ICMP message as a reset (WSAECONNRESET).
        Ok(Err(e)) if closed_port(&e) => fail(
            Outcome::Refused,
            &format!("Nothing is listening on UDP {port}: the host said the port is closed"),
        ),
        Ok(Err(e)) => fail(Outcome::OsError, &e.to_string()),
        Err(_) => fail(
            Outcome::NoAnswer,
            &format!("No reply on UDP {port}: the service ignored the request, or a firewall dropped it"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same closed port, as each platform reports it.
    #[test]
    fn a_closed_port_reads_the_same_on_every_platform() {
        use std::io::{Error, ErrorKind};
        assert!(closed_port(&Error::from(ErrorKind::ConnectionRefused)));
        assert!(closed_port(&Error::from(ErrorKind::ConnectionReset)));
        assert!(!closed_port(&Error::from(ErrorKind::TimedOut)));
    }

    #[test]
    fn payloads() {
        assert_eq!(payload_bytes(None).unwrap(), Vec::<u8>::new());
        assert_eq!(payload_bytes(Some("ntp")).unwrap().len(), 48);
        assert_eq!(payload_bytes(Some("DNS")).unwrap()[..2], [0xC0, 0xDE]);
        assert_eq!(payload_bytes(Some("de ad:be ef")).unwrap(), vec![0xDE, 0xAD, 0xBE, 0xEF]);
        assert!(payload_bytes(Some("abc")).is_err());
        assert!(payload_bytes(Some("zz")).is_err());
    }

    #[tokio::test]
    async fn a_service_that_replies_is_healthy() {
        let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = sock.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut buf = [0u8; 64];
            while let Ok((n, from)) = sock.recv_from(&mut buf).await {
                let _ = sock.send_to(&buf[..n], from).await;
            }
        });
        let r = probe_udp("p", "127.0.0.1", u32::from(port), Some("dns"), 1_000, 0).await;
        assert_eq!(r.outcome, Outcome::Success, "{}", r.summary);
        assert!(r.summary.contains("17 bytes"));
    }

    #[tokio::test]
    async fn a_closed_port_is_refused_and_a_silent_one_says_so() {
        // Bound then dropped: nothing listens there now.
        let closed = UdpSocket::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
        let r = probe_udp("p", "127.0.0.1", u32::from(closed), None, 1_000, 0).await;
        assert_eq!(r.outcome, Outcome::Refused, "{}", r.summary);

        let silent = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = silent.local_addr().unwrap().port();
        let r = probe_udp("p", "127.0.0.1", u32::from(port), Some("ntp"), 300, 0).await;
        assert_eq!(r.outcome, Outcome::NoAnswer, "{}", r.summary);
        drop(silent);
    }
}
