//! What a host calls itself, when DNS has no answer for it (LT-121).
//!
//! LT-109 named hosts by reverse DNS, which is correct and is what `ping -a`
//! does — and on a lab subnet with no PTR records it is a column of dashes.
//! Measured on the operator's own 192.168.77.0/24: one name out of thirteen,
//! and that one came from a hosts file. The other scanners do better because
//! they do not ask the *resolver*, they ask the *host*, over two protocols
//! that a machine answers about itself:
//!
//! - **NetBIOS name service** (UDP 137), a node status request. Windows and
//!   Samba answer with the list of names they have registered.
//! - **mDNS** (UDP 5353), a reverse PTR query sent unicast. Apple devices,
//!   printers, anything running Avahi, and a surprising amount of network
//!   gear answer with their `.local` name.
//! - **LLMNR** (UDP 5355), the same reverse PTR query sent to the multicast
//!   group. This is the one Windows answers with its real hostname, case and
//!   all, and it is not optional that it goes to the group: sent unicast to
//!   a host's own port 5355, nothing on the operator's network answered at
//!   all — including the Windows host that answers the multicast form
//!   immediately. Both were measured on 2026-09-12 before a line was written.
//!
//! Both parsers were written against responses captured from the operator's
//! own network, committed under `fixtures/`. On that subnet NetBIOS found one
//! host and mDNS found three, two of which — an access point called
//! `LAB-OFFICE-AP-0001` and `LABAP431F0002` — have no PTR record of any kind
//! and were dashes before this.
//!
//! **None of the three is routed**, and that is fine: mDNS and LLMNR are
//! link-local by design and NetBIOS name service rarely crosses a subnet
//! boundary. A sweep of a remote range still gets DNS and gets no worse than
//! it was.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use tokio::net::UdpSocket;
use tokio::time::timeout;

/// Big enough for any node status response. The captured one is 193 bytes;
/// the protocol's own ceiling is a 576-byte datagram.
const MAX_REPLY: usize = 1024;

/// What a node status request got back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NbstatReply {
    /// The machine's own name — the first unique (non-group) entry.
    pub name: Option<String>,
    /// The adapter address the host reports, when it reports one. Samba
    /// sends all zeroes here, so this is a bonus rather than a source.
    pub mac: Option<String>,
}

/// Asks a host what it is called over NetBIOS.
pub async fn netbios_name(ip: Ipv4Addr, timeout_ms: u64) -> Option<NbstatReply> {
    let reply = ask(SocketAddr::from((ip, 137)), &nbstat_query(), timeout_ms).await?;
    let parsed = parse_nbstat(&reply)?;
    if parsed.name.is_none() && parsed.mac.is_none() {
        return None;
    }
    Some(parsed)
}

/// Asks a host what it is called over mDNS, as a reverse lookup.
pub async fn mdns_name(ip: Ipv4Addr, timeout_ms: u64) -> Option<String> {
    let reply = ask(SocketAddr::from((ip, 5353)), &mdns_reverse_query(ip), timeout_ms).await?;
    parse_mdns_ptr(&reply)
}

/// One datagram out, one back, within the timeout.
///
/// `connect` rather than `send_to` so the kernel drops anything that did not
/// come from the host being asked — a sweep is exactly the situation where
/// several of these are in flight at once.
async fn ask(to: SocketAddr, query: &[u8], timeout_ms: u64) -> Option<Vec<u8>> {
    let work = async {
        let sock = UdpSocket::bind(SocketAddr::from(([0, 0, 0, 0], 0))).await.ok()?;
        sock.connect(to).await.ok()?;
        sock.send(query).await.ok()?;
        let mut buf = vec![0u8; MAX_REPLY];
        let n = sock.recv(&mut buf).await.ok()?;
        buf.truncate(n);
        Some(buf)
    };
    timeout(Duration::from_millis(timeout_ms), work).await.ok().flatten()
}

// ------------------------------------------------------------------ NetBIOS

/// A node status request for the wildcard name `*`.
///
/// The name on the wire is 16 bytes — here `*` and fifteen nulls — with each
/// byte split into two nibbles and each nibble written as a letter from `A`.
/// So `*` (0x2A) becomes `CK`, and the whole thing is the 32 characters
/// `CKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, which is what the captured exchange
/// shows going out and coming back.
fn nbstat_query() -> Vec<u8> {
    let mut q = Vec::with_capacity(50);
    q.extend_from_slice(&[0x13, 0x37]); // transaction id, echoed back
    q.extend_from_slice(&[0x00, 0x00]); // flags: a plain query
    q.extend_from_slice(&[0x00, 0x01]); // one question
    q.extend_from_slice(&[0x00; 6]); // no answer, authority or additional
    let mut name = [0u8; 16];
    name[0] = b'*';
    q.push(32);
    for byte in name {
        q.push(b'A' + (byte >> 4));
        q.push(b'A' + (byte & 0x0F));
    }
    q.push(0x00); // end of the name
    q.extend_from_slice(&[0x00, 0x21]); // NBSTAT
    q.extend_from_slice(&[0x00, 0x01]); // class IN
    q
}

/// Reads a node status response.
///
/// The record's payload is a count followed by 18-byte entries — 15 bytes of
/// space-padded name, a one-byte suffix saying which service it is, and two
/// bytes of flags — and then the adapter's own address.
///
/// **The group bit is what matters.** Flags bit 15 marks a *group* name,
/// which on the captured reply is `WORKGROUP`: the domain, registered by
/// every machine on it. Taking the first entry rather than the first unique
/// one would label whole subnets `WORKGROUP`.
pub fn parse_nbstat(reply: &[u8]) -> Option<NbstatReply> {
    if reply.len() < 12 {
        return None;
    }
    let answers = u16::from_be_bytes([reply[6], reply[7]]);
    if answers == 0 {
        return None;
    }
    let mut at = skip_name(reply, 12)?;
    // type, class, ttl
    at = at.checked_add(8)?;
    let rdlength = u16::from_be_bytes([*reply.get(at)?, *reply.get(at + 1)?]) as usize;
    at += 2;
    let rdata = reply.get(at..at.checked_add(rdlength)?)?;
    let count = *rdata.first()? as usize;

    let mut name = None;
    for i in 0..count {
        let start = 1 + i * 18;
        let entry = match rdata.get(start..start + 18) {
            Some(e) => e,
            None => break,
        };
        let flags = u16::from_be_bytes([entry[16], entry[17]]);
        if flags & 0x8000 != 0 {
            continue; // a group: the workgroup or domain, not this machine
        }
        let label = String::from_utf8_lossy(&entry[..15]);
        let label = label.trim_matches(|c: char| c.is_whitespace() || c == '\0');
        if label.is_empty() || name.is_some() {
            continue;
        }
        name = Some(label.to_string());
    }

    let mac_at = 1 + count * 18;
    let mac = rdata
        .get(mac_at..mac_at + 6)
        .filter(|m| m.iter().any(|b| *b != 0))
        .map(|m| m.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":"));

    Some(NbstatReply { name, mac })
}

// --------------------------------------------------------------------- mDNS

/// A reverse PTR query for `<d.c.b.a>.in-addr.arpa`, sent unicast.
///
/// Transaction id zero: mDNS responders do not key on it, and a legacy
/// unicast query is expected to carry it as zero.
fn mdns_reverse_query(ip: Ipv4Addr) -> Vec<u8> {
    reverse_ptr_query(ip, 0x0000)
}

/// A reverse PTR query for `<d.c.b.a>.in-addr.arpa`.
///
/// mDNS and LLMNR ask the identical question and differ only in where it is
/// sent and what transaction id is conventional, so the packet is built once.
fn reverse_ptr_query(ip: Ipv4Addr, transaction_id: u16) -> Vec<u8> {
    let o = ip.octets();
    let mut q = Vec::with_capacity(40);
    q.extend_from_slice(&transaction_id.to_be_bytes());
    q.extend_from_slice(&[0x00, 0x00]); // flags: a plain query
    q.extend_from_slice(&[0x00, 0x01]); // one question
    q.extend_from_slice(&[0x00; 6]);
    for label in [
        o[3].to_string(),
        o[2].to_string(),
        o[1].to_string(),
        o[0].to_string(),
        "in-addr".to_string(),
        "arpa".to_string(),
    ] {
        q.push(label.len() as u8);
        q.extend_from_slice(label.as_bytes());
    }
    q.push(0x00);
    q.extend_from_slice(&[0x00, 0x0C]); // PTR
    q.extend_from_slice(&[0x00, 0x01]); // class IN
    q
}

/// Pulls the name out of the first PTR answer.
pub fn parse_mdns_ptr(reply: &[u8]) -> Option<String> {
    if reply.len() < 12 {
        return None;
    }
    let questions = u16::from_be_bytes([reply[4], reply[5]]);
    let answers = u16::from_be_bytes([reply[6], reply[7]]);
    if answers == 0 {
        return None;
    }
    let mut at = 12;
    for _ in 0..questions {
        at = skip_name(reply, at)?.checked_add(4)?; // + type and class
    }
    for _ in 0..answers {
        at = skip_name(reply, at)?;
        let rtype = u16::from_be_bytes([*reply.get(at)?, *reply.get(at + 1)?]);
        at = at.checked_add(8)?; // type, class, ttl
        let rdlength = u16::from_be_bytes([*reply.get(at)?, *reply.get(at + 1)?]) as usize;
        at += 2;
        if rtype == 0x000C {
            let (name, _) = read_name(reply, at)?;
            let name = name.trim_end_matches('.');
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
        at = at.checked_add(rdlength)?;
    }
    None
}

// -------------------------------------------------------------------- LLMNR

/// The group every LLMNR responder listens on. A query sent to a host's own
/// address instead gets nothing — measured, see the module docs.
const LLMNR_GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 252);
const LLMNR_PORT: u16 = 5355;

/// Asks the segment who owns an address, and takes the answer only from the
/// host that owns it.
///
/// **The source check is the whole safety of this.** The question goes to a
/// multicast group, so any machine on the segment can reply, and a reply is
/// just a name someone typed into their own computer. Only a datagram whose
/// source is the address being asked about is believed — otherwise any host
/// could name any other, and a sweep would cheerfully print it.
pub async fn llmnr_name(ip: Ipv4Addr, timeout_ms: u64) -> Option<String> {
    let work = async {
        let sock = UdpSocket::bind(SocketAddr::from(([0, 0, 0, 0], 0))).await.ok()?;
        // Link-local, and no further: this is a question about this segment.
        sock.set_multicast_ttl_v4(1).ok()?;
        let query = reverse_ptr_query(ip, 0x4A2C);
        sock.send_to(&query, SocketAddr::from((LLMNR_GROUP, LLMNR_PORT))).await.ok()?;
        let mut buf = vec![0u8; MAX_REPLY];
        loop {
            let (n, from) = sock.recv_from(&mut buf).await.ok()?;
            if from.ip() != IpAddr::V4(ip) {
                continue; // somebody else answering for somebody else
            }
            return parse_mdns_ptr(&buf[..n]);
        }
    };
    timeout(Duration::from_millis(timeout_ms), work).await.ok().flatten()
}

// ---------------------------------------------------------- name encoding

/// Reads a dotted name, following compression pointers, and reports where the
/// *field* ends — which for a compressed name is just past the pointer, not
/// wherever the pointer led.
///
/// The jump budget is what stops a malformed or hostile reply from spinning
/// here: a pointer that leads to itself is legal to write and impossible to
/// follow, and a sweep asks strangers for this data.
fn read_name(bytes: &[u8], start: usize) -> Option<(String, usize)> {
    let mut labels: Vec<String> = Vec::new();
    let mut at = start;
    let mut end_of_field = None;
    let mut jumps = 0;
    loop {
        let len = *bytes.get(at)?;
        if len & 0xC0 == 0xC0 {
            let ptr = (((len & 0x3F) as usize) << 8) | *bytes.get(at + 1)? as usize;
            if end_of_field.is_none() {
                end_of_field = Some(at + 2);
            }
            jumps += 1;
            if jumps > 16 || ptr >= bytes.len() {
                return None;
            }
            at = ptr;
            continue;
        }
        at += 1;
        if len == 0 {
            break;
        }
        let label = bytes.get(at..at.checked_add(len as usize)?)?;
        labels.push(String::from_utf8_lossy(label).into_owned());
        at += len as usize;
    }
    Some((labels.join("."), end_of_field.unwrap_or(at)))
}

fn skip_name(bytes: &[u8], start: usize) -> Option<usize> {
    read_name(bytes, start).map(|(_, end)| end)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exchange this was written against: a real node status response
    /// from the QNAP NAS on the operator's network, captured 2026-09-12.
    /// Advanced IP Scanner shows that host as `NAS000001`, and so must this.
    #[test]
    fn reads_a_real_netbios_reply() {
        let reply = include_bytes!("../fixtures/nbstat-qnap-nas.bin");
        let got = parse_nbstat(reply).expect("parsed");
        assert_eq!(got.name.as_deref(), Some("NAS000001"));
        // Samba reports all-zero for its adapter address, so there is nothing
        // to take from it — and an all-zero MAC must not be offered as one.
        assert_eq!(got.mac, None);
    }

    /// The same host answers mDNS as well, and must give the same name.
    #[test]
    fn reads_a_real_mdns_reply() {
        let reply = include_bytes!("../fixtures/mdns-ptr-qnap-nas.bin");
        assert_eq!(parse_mdns_ptr(reply).as_deref(), Some("NAS000001.local"));
    }

    /// The case this whole module exists for: a host with no PTR record and
    /// no NetBIOS, which the sweep showed as a dash. It is an access point,
    /// and it says so.
    #[test]
    fn names_a_host_that_reverse_dns_cannot() {
        let reply = include_bytes!("../fixtures/mdns-ptr-access-point.bin");
        assert_eq!(parse_mdns_ptr(reply).as_deref(), Some("LAB-OFFICE-AP-0001.local"));
    }

    /// The Windows host on the operator's network, answering the multicast
    /// form on 2026-09-12. NetBIOS calls the same machine `LABDESKTOP01`;
    /// LLMNR keeps the capitals it was actually given, which is why it is
    /// preferred over NetBIOS when both answer.
    #[test]
    fn reads_a_real_llmnr_reply() {
        let reply = include_bytes!("../fixtures/llmnr-ptr-windows-host.bin");
        assert_eq!(parse_mdns_ptr(reply).as_deref(), Some("LabDesktop01"));
    }

    /// mDNS and LLMNR ask the same question, so the packet must be identical
    /// but for the transaction id — the difference is only where it is sent.
    #[test]
    fn the_llmnr_and_mdns_queries_ask_the_same_thing() {
        let ip: Ipv4Addr = "192.168.77.129".parse().unwrap();
        let mdns = mdns_reverse_query(ip);
        let llmnr = reverse_ptr_query(ip, 0x4A2C);
        assert_eq!(mdns[2..], llmnr[2..]);
        assert_eq!(&llmnr[..2], &[0x4A, 0x2C]);
    }

    /// The query has to be exactly what went out in the captured exchange,
    /// or the reply the parser was written against is not one it will see.
    #[test]
    fn the_netbios_query_is_the_one_that_was_answered() {
        let q = nbstat_query();
        assert_eq!(q.len(), 50);
        assert_eq!(&q[12..13], &[32]);
        assert_eq!(&q[13..45], b"CKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        assert_eq!(&q[46..50], &[0x00, 0x21, 0x00, 0x01]);
    }

    #[test]
    fn the_mdns_query_asks_for_the_address_in_reverse() {
        let q = mdns_reverse_query("192.168.77.23".parse().unwrap());
        let body = &q[12..];
        let mut name = Vec::new();
        let mut at = 0;
        while body[at] != 0 {
            let n = body[at] as usize;
            name.push(String::from_utf8_lossy(&body[at + 1..at + 1 + n]).into_owned());
            at += 1 + n;
        }
        assert_eq!(name.join("."), "23.77.168.192.in-addr.arpa");
        assert_eq!(&body[at + 1..at + 5], &[0x00, 0x0C, 0x00, 0x01]);
    }

    /// A reply from a stranger is not to be trusted into a loop.
    #[test]
    fn a_pointer_that_leads_to_itself_does_not_spin() {
        // Header, then a name field at offset 12 pointing at offset 12.
        let mut reply = vec![0u8; 12];
        reply[6..8].copy_from_slice(&[0x00, 0x01]);
        reply.extend_from_slice(&[0xC0, 0x0C]);
        assert_eq!(read_name(&reply, 12), None);
        assert_eq!(parse_mdns_ptr(&reply), None);
        assert_eq!(parse_nbstat(&reply), None);
    }

    /// Truncated, empty and answer-less replies are all "no name", never a
    /// panic: these arrive from whatever happens to be on the network.
    #[test]
    fn a_short_or_empty_reply_is_no_name() {
        assert_eq!(parse_nbstat(&[]), None);
        assert_eq!(parse_mdns_ptr(&[]), None);
        assert_eq!(parse_nbstat(&[0u8; 11]), None);
        assert_eq!(parse_mdns_ptr(&[0u8; 11]), None);
        // Well-formed header claiming an answer that is not there.
        let mut header = vec![0u8; 12];
        header[6..8].copy_from_slice(&[0x00, 0x01]);
        assert_eq!(parse_nbstat(&header), None);
        assert_eq!(parse_mdns_ptr(&header), None);
        // A real reply cut off mid-record.
        let real = include_bytes!("../fixtures/nbstat-qnap-nas.bin");
        for cut in [13usize, 40, 60, 100] {
            let _ = parse_nbstat(&real[..cut]);
        }
    }

    /// A group name is the workgroup, not the machine. The captured reply
    /// carries `WORKGROUP` twice, and neither is the answer.
    #[test]
    fn the_workgroup_is_not_the_machine_name() {
        let reply = include_bytes!("../fixtures/nbstat-qnap-nas.bin");
        let got = parse_nbstat(reply).expect("parsed");
        assert_ne!(got.name.as_deref(), Some("WORKGROUP"));
    }
}
