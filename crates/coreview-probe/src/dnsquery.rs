//! Asking one DNS server one question (LT-219).
//!
//! The `Dns` probe (LT-089) resolves a name the way this machine does, through
//! the operating system's resolver and whatever servers it happens to use. That
//! proves the name works *from here*; it cannot prove that a particular server
//! — the branch's own, the one a failover is meant to have updated — answers,
//! or what it answers with. This sends a query straight to a named server and
//! reads its reply: the response code, and the records of the type asked for.
//!
//! A plain RFC 1035 query over UDP, built and parsed here, so no resolver
//! library and no system configuration is involved.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::{Duration, Instant};

use tokio::net::UdpSocket;
use tokio::time::timeout;

use crate::types::{Outcome, ProbeResult};
use crate::validate::parse_target;

/// The record types a query probe asks for.
pub fn qtype(word: &str) -> Option<u16> {
    Some(match word.trim().to_ascii_uppercase().as_str() {
        "A" => 1,
        "NS" => 2,
        "CNAME" => 5,
        "SOA" => 6,
        "PTR" => 12,
        "MX" => 15,
        "TXT" => 16,
        "AAAA" => 28,
        "SRV" => 33,
        _ => return None,
    })
}

/// A query for `name` of `qtype`, recursion desired, with transaction `id`.
pub fn build_query(id: u16, name: &str, qtype: u16) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(32 + name.len());
    out.extend_from_slice(&id.to_be_bytes());
    out.extend_from_slice(&[0x01, 0x00]); // standard query, RD
    out.extend_from_slice(&[0, 1, 0, 0, 0, 0, 0, 0]); // one question
    for label in name.trim_end_matches('.').split('.') {
        if label.is_empty() || label.len() > 63 {
            return None;
        }
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
    out.extend_from_slice(&qtype.to_be_bytes());
    out.extend_from_slice(&[0, 1]); // class IN
    (out.len() <= 512).then_some(out)
}

/// What a server said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DnsReply {
    pub id: u16,
    /// 0 NOERROR, 2 SERVFAIL, 3 NXDOMAIN, 5 REFUSED.
    pub rcode: u8,
    pub truncated: bool,
    /// The answers of the type asked for, as text: addresses for A and AAAA,
    /// names for the rest where the record is a name.
    pub answers: Vec<String>,
}

fn read_name(msg: &[u8], mut at: usize, depth: u8) -> Option<(String, usize)> {
    if depth > 8 {
        return None;
    }
    let mut labels: Vec<String> = Vec::new();
    let mut end = None;
    loop {
        let len = *msg.get(at)? as usize;
        if len == 0 {
            end.get_or_insert(at + 1);
            break;
        }
        if len & 0xC0 == 0xC0 {
            let ptr = ((len & 0x3F) << 8) | *msg.get(at + 1)? as usize;
            end.get_or_insert(at + 2);
            let (rest, _) = read_name(msg, ptr, depth + 1)?;
            if !rest.is_empty() {
                labels.push(rest);
            }
            break;
        }
        let label = msg.get(at + 1..at + 1 + len)?;
        labels.push(String::from_utf8_lossy(label).into_owned());
        at += 1 + len;
    }
    Some((labels.join("."), end?))
}

/// Parses a reply, keeping answers of `want` type. `None` for anything that is
/// not a well-formed response.
pub fn parse_reply(msg: &[u8], want: u16) -> Option<DnsReply> {
    if msg.len() < 12 || msg[2] & 0x80 == 0 {
        return None;
    }
    let id = u16::from_be_bytes([msg[0], msg[1]]);
    let truncated = msg[2] & 0x02 != 0;
    let rcode = msg[3] & 0x0F;
    let qd = u16::from_be_bytes([msg[4], msg[5]]);
    let an = u16::from_be_bytes([msg[6], msg[7]]);
    let mut at = 12;
    for _ in 0..qd {
        let (_, next) = read_name(msg, at, 0)?;
        at = next + 4;
    }
    let mut answers = Vec::new();
    for _ in 0..an {
        let (_, next) = read_name(msg, at, 0)?;
        let rtype = u16::from_be_bytes([*msg.get(next)?, *msg.get(next + 1)?]);
        let rdlen = u16::from_be_bytes([*msg.get(next + 8)?, *msg.get(next + 9)?]) as usize;
        let rdata_at = next + 10;
        let rdata = msg.get(rdata_at..rdata_at + rdlen)?;
        if rtype == want {
            let text = match rtype {
                1 if rdlen == 4 => Some(Ipv4Addr::new(rdata[0], rdata[1], rdata[2], rdata[3]).to_string()),
                28 if rdlen == 16 => {
                    let mut b = [0u8; 16];
                    b.copy_from_slice(rdata);
                    Some(Ipv6Addr::from(b).to_string())
                }
                2 | 5 | 12 => read_name(msg, rdata_at, 0).map(|(n, _)| n),
                15 if rdlen > 2 => read_name(msg, rdata_at + 2, 0).map(|(n, _)| n),
                16 => Some(rdata.get(1..).map(|t| String::from_utf8_lossy(t).into_owned()).unwrap_or_default()),
                _ => Some(format!("{rdlen}-byte record")),
            };
            if let Some(t) = text {
                answers.push(t);
            }
        }
        at = rdata_at + rdlen;
    }
    Some(DnsReply { id, rcode, truncated, answers })
}

fn rcode_word(rcode: u8) -> &'static str {
    match rcode {
        0 => "NOERROR",
        1 => "FORMERR",
        2 => "SERVFAIL",
        3 => "NXDOMAIN",
        4 => "NOTIMP",
        5 => "REFUSED",
        _ => "an error",
    }
}

/// Asks `server` for `name`'s `record` records. Healthy on NOERROR with at
/// least one answer — and, with `expected` set, one of them equal to it.
pub async fn probe_dns_query(
    probe_id: &str,
    raw_name: &str,
    server: &str,
    record: &str,
    expected: Option<&str>,
    timeout_ms: u64,
    now_ms: i64,
) -> ProbeResult {
    let fail = |outcome, text: &str| ProbeResult::failed(probe_id, now_ms, outcome, text);
    let name = match parse_target(raw_name) {
        Ok(t) => t,
        Err(e) => return fail(Outcome::InvalidTarget, &e.to_string()),
    };
    let Ok(server_ip) = server.trim().parse::<IpAddr>() else {
        return fail(Outcome::InvalidTarget, &format!("{server} is not a DNS server address"));
    };
    let Some(want) = qtype(record) else {
        return fail(Outcome::InvalidTarget, &format!("{record} is not a record type this probe asks for"));
    };
    let id = (now_ms as u64 & 0xFFFF) as u16 ^ 0x5A5A;
    let Some(query) = build_query(id, &name.as_str(), want) else {
        return fail(Outcome::InvalidTarget, &format!("{} is not a name that can be asked for", name.as_str()));
    };
    let bind = if server_ip.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" };
    let socket = match UdpSocket::bind(bind).await {
        Ok(s) => s,
        Err(e) => return fail(Outcome::OsError, &e.to_string()),
    };
    let to = SocketAddr::new(server_ip, 53);
    let started = Instant::now();
    if let Err(e) = socket.connect(to).await.and(Ok(())) {
        return fail(Outcome::OsError, &e.to_string());
    }
    if let Err(e) = socket.send(&query).await {
        return fail(Outcome::OsError, &e.to_string());
    }
    let mut buf = [0u8; 4096];
    let deadline = Duration::from_millis(timeout_ms);
    let reply = loop {
        let left = deadline.saturating_sub(started.elapsed());
        match timeout(left, socket.recv(&mut buf)).await {
            Err(_) => return fail(Outcome::Timeout, &format!("{server_ip} did not answer the query in time")),
            Ok(Err(e)) if crate::udp::closed_port(&e) => {
                return fail(Outcome::Refused, &format!("{server_ip} is not answering DNS on port 53"))
            }
            Ok(Err(e)) => return fail(Outcome::OsError, &e.to_string()),
            // A stray datagram, or a reply to someone else's query: keep waiting.
            Ok(Ok(n)) => match parse_reply(&buf[..n], want) {
                Some(r) if r.id == id => break r,
                _ => continue,
            },
        }
    };
    let rtt = started.elapsed().as_secs_f64() * 1000.0;
    let record = record.trim().to_ascii_uppercase();
    if reply.rcode != 0 {
        return ProbeResult {
            rtt_ms: Some(rtt),
            ..fail(Outcome::DnsFailure, &format!("{server_ip} answered {} for {} {record}", rcode_word(reply.rcode), name.as_str()))
        };
    }
    if reply.answers.is_empty() {
        let why = if reply.truncated { " (the reply was truncated)" } else { "" };
        return ProbeResult {
            rtt_ms: Some(rtt),
            ..fail(Outcome::NoAnswer, &format!("{server_ip} has no {record} record for {}{why}", name.as_str()))
        };
    }
    let joined = reply.answers.join(", ");
    if let Some(want) = expected.map(str::trim).filter(|w| !w.is_empty()) {
        if !reply.answers.iter().any(|a| a.eq_ignore_ascii_case(want.trim_end_matches('.'))) {
            return ProbeResult {
                probe_id: probe_id.to_string(),
                timestamp_ms: now_ms,
                outcome: Outcome::AddressMismatch,
                rtt_ms: Some(rtt),
                summary: format!("{server_ip} says {joined}, expected {want}"),
                resolved: reply.answers.clone(),
                error_message: Some(format!("{server_ip} says {joined}, expected {want}")),
            };
        }
    }
    ProbeResult {
        probe_id: probe_id.to_string(),
        timestamp_ms: now_ms,
        outcome: Outcome::Success,
        rtt_ms: Some(rtt),
        summary: format!("{server_ip} says {joined} ({rtt:.0} ms)"),
        resolved: reply.answers,
        error_message: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A reply as a server writes one: the question echoed, then answers that
    /// point back at the question's name.
    fn reply(id: u16, rcode: u8, name: &str, qtype: u16, answers: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let q = build_query(id, name, qtype).unwrap();
        let mut out = q.clone();
        out[2] = 0x81;
        out[3] = 0x80 | rcode;
        out[6..8].copy_from_slice(&(answers.len() as u16).to_be_bytes());
        for (rtype, rdata) in answers {
            out.extend_from_slice(&[0xC0, 12]);
            out.extend_from_slice(&rtype.to_be_bytes());
            out.extend_from_slice(&[0, 1, 0, 0, 0x0E, 0x10]);
            out.extend_from_slice(&(rdata.len() as u16).to_be_bytes());
            out.extend_from_slice(rdata);
        }
        out
    }

    #[test]
    fn builds_a_standard_query() {
        let q = build_query(0x1234, "www.example.test", 1).unwrap();
        assert_eq!(&q[..4], &[0x12, 0x34, 0x01, 0x00]);
        assert_eq!(&q[12..17], &[3, b'w', b'w', b'w', 7]);
        assert_eq!(&q[q.len() - 4..], &[0, 1, 0, 1]);
        assert!(build_query(1, "a..b", 1).is_none());
    }

    #[test]
    fn reads_addresses_and_names_from_a_reply() {
        let r = reply(7, 0, "app.example.test", 1, &[(1, vec![192, 0, 2, 10]), (5, vec![0xC0, 12]), (1, vec![192, 0, 2, 11])]);
        let parsed = parse_reply(&r, 1).unwrap();
        assert_eq!(parsed.id, 7);
        assert_eq!(parsed.rcode, 0);
        assert_eq!(parsed.answers, vec!["192.0.2.10", "192.0.2.11"]);
        let v6 = reply(8, 0, "app.example.test", 28, &[(28, "2001:db8::1".parse::<Ipv6Addr>().unwrap().octets().to_vec())]);
        assert_eq!(parse_reply(&v6, 28).unwrap().answers, vec!["2001:db8::1"]);
        let cname = reply(9, 0, "www.example.test", 5, &[(5, vec![0xC0, 12])]);
        assert_eq!(parse_reply(&cname, 5).unwrap().answers, vec!["www.example.test"]);
    }

    #[test]
    fn rejects_a_query_and_truncated_nonsense() {
        assert!(parse_reply(&build_query(1, "a.test", 1).unwrap(), 1).is_none());
        let mut bad = reply(1, 0, "a.test", 1, &[(1, vec![192, 0, 2, 1])]);
        bad.truncate(bad.len() - 2);
        assert!(parse_reply(&bad, 1).is_none());
    }

    async fn fake_server(answer: impl Fn(&[u8]) -> Vec<u8> + Send + 'static) -> u16 {
        let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = sock.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut buf = [0u8; 512];
            while let Ok((n, from)) = sock.recv_from(&mut buf).await {
                let _ = sock.send_to(&answer(&buf[..n]), from).await;
            }
        });
        port
    }

    /// The probe dials port 53, which a test cannot bind; the socket-level
    /// behaviour is exercised against a fake server by address and port here.
    #[tokio::test]
    async fn a_fake_server_round_trip_parses() {
        let port = fake_server(|q| {
            let id = u16::from_be_bytes([q[0], q[1]]);
            reply(id, 3, "gone.example.test", 1, &[])
        })
        .await;
        let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        sock.connect(("127.0.0.1", port)).await.unwrap();
        sock.send(&build_query(42, "gone.example.test", 1).unwrap()).await.unwrap();
        let mut buf = [0u8; 512];
        let n = sock.recv(&mut buf).await.unwrap();
        let r = parse_reply(&buf[..n], 1).unwrap();
        assert_eq!((r.id, r.rcode, r.answers.len()), (42, 3, 0));
    }

    #[tokio::test]
    async fn a_bad_server_or_record_type_fails_closed() {
        let r = probe_dns_query("p", "app.example.test", "not-an-ip", "A", None, 500, 0).await;
        assert_eq!(r.outcome, Outcome::InvalidTarget);
        let r = probe_dns_query("p", "app.example.test", "192.0.2.53", "BOGUS", None, 500, 0).await;
        assert_eq!(r.outcome, Outcome::InvalidTarget);
    }
}
