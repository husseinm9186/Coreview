//! Fetching a device's certificate so it can be read (LT-124).
//!
//! Two ways, because the devices on a real network span two eras of TLS:
//!
//! * **rustls** first, for anything speaking TLS 1.2 or 1.3 — a current
//!   FortiSwitch presents its certificate over TLS 1.3, where it is encrypted
//!   and only a real handshake can read it.
//! * **The handshake in the clear** otherwise. rustls has never supported TLS
//!   1.0 or 1.1, and a Cisco access switch on the operator's network speaks
//!   nothing newer. In TLS 1.0 to 1.2 the server's Certificate message is sent
//!   unencrypted straight after its ServerHello, so a ClientHello is sent, the
//!   reply is read as far as the certificate, and the connection is dropped.
//!   Nothing is negotiated, completed or sent afterwards.
//!
//! Neither path trusts what it reads. The certificate is evidence of what a
//! device calls itself, not an identity to authenticate.
//!
//! The in-the-clear reader is tested against handshakes captured from local
//! OpenSSL servers presenting an invented certificate (`fixtures/tls-flight-*`,
//! D-027), and was checked by hand against the real switch before being
//! committed.

use std::net::Ipv4Addr;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::cert::{read_certificate, CertIdentity};

const RECORD_HANDSHAKE: u8 = 22;
const RECORD_ALERT: u8 = 21;
const HANDSHAKE_CERTIFICATE: u8 = 11;
const HANDSHAKE_SERVER_HELLO_DONE: u8 = 14;
/// Offered as the highest version. A TLS 1.0-only switch negotiates down to
/// 1.0; a TLS 1.3 server, seeing no supported_versions extension, answers as
/// 1.2 — in the clear either way.
const TLS_1_2: u16 = 0x0303;
/// A certificate flight is a few kilobytes. Anything past this is not one.
const MAX_FLIGHT: usize = 64 * 1024;

/// What the certificate on `ip:port` says, if the device presents one.
pub async fn certificate_identity(ip: Ipv4Addr, port: u16, timeout_ms: u64) -> Option<CertIdentity> {
    let der = match modern_certificate(ip, port, timeout_ms).await {
        Some(der) => der,
        None => legacy_certificate(ip, port, timeout_ms).await?,
    };
    read_certificate(&der)
}

/// The leaf certificate over a real TLS 1.2/1.3 handshake, verified by
/// nothing.
async fn modern_certificate(ip: Ipv4Addr, port: u16, timeout_ms: u64) -> Option<Vec<u8>> {
    let deadline = Duration::from_millis(timeout_ms);
    let tcp = timeout(deadline, TcpStream::connect((ip, port))).await.ok()?.ok()?;
    let name = rustls_pki_types::ServerName::IpAddress(std::net::IpAddr::V4(ip).into());
    let connector = tokio_rustls::TlsConnector::from(crate::http::tls_config(true));
    let stream = timeout(deadline, connector.connect(name, tcp)).await.ok()?.ok()?;
    let (_, connection) = stream.get_ref();
    connection.peer_certificates()?.first().map(|c| c.as_ref().to_vec())
}

/// The leaf certificate read from the server's first flight, in the clear.
async fn legacy_certificate(ip: Ipv4Addr, port: u16, timeout_ms: u64) -> Option<Vec<u8>> {
    let deadline = Duration::from_millis(timeout_ms);
    let mut tcp = timeout(deadline, TcpStream::connect((ip, port))).await.ok()?.ok()?;
    timeout(deadline, tcp.write_all(&client_hello(TLS_1_2, &hello_random()))).await.ok()?.ok()?;

    let mut flight = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = timeout(deadline, tcp.read(&mut buf)).await.ok()?.ok()?;
        if n == 0 {
            break;
        }
        flight.extend_from_slice(&buf[..n]);
        if let Some(der) = first_certificate_from_flight(&flight) {
            return Some(der);
        }
        if flight.len() > MAX_FLIGHT || flight_ended_without_certificate(&flight) {
            return None;
        }
    }
    first_certificate_from_flight(&flight)
}

/// A ClientHello offering RSA and ECDHE-RSA suites every era of device
/// accepts, with the extensions a TLS 1.2 server expects.
pub fn client_hello(max_version: u16, random: &[u8; 32]) -> Vec<u8> {
    // ECDHE-RSA-AES256-SHA, ECDHE-RSA-AES128-SHA, AES256-SHA, AES128-SHA,
    // DES-CBC3-SHA: old enough for a 2010 switch, and only ever used to read a
    // certificate that is sent before any of them takes effect.
    let suites: [u16; 5] = [0xC014, 0xC013, 0x0035, 0x002F, 0x000A];
    let mut exts = Vec::new();
    // supported_groups: secp256r1.
    exts.extend_from_slice(&[0x00, 0x0A, 0x00, 0x04, 0x00, 0x02, 0x00, 0x17]);
    // ec_point_formats: uncompressed.
    exts.extend_from_slice(&[0x00, 0x0B, 0x00, 0x02, 0x01, 0x00]);
    // signature_algorithms: rsa_pkcs1_sha256, rsa_pkcs1_sha1, ecdsa_secp256r1_sha256.
    exts.extend_from_slice(&[0x00, 0x0D, 0x00, 0x08, 0x00, 0x06, 0x04, 0x01, 0x02, 0x01, 0x04, 0x03]);

    let mut body = Vec::new();
    body.extend_from_slice(&max_version.to_be_bytes());
    body.extend_from_slice(random);
    body.push(0); // no session id
    body.extend_from_slice(&((suites.len() * 2) as u16).to_be_bytes());
    for s in suites {
        body.extend_from_slice(&s.to_be_bytes());
    }
    body.extend_from_slice(&[0x01, 0x00]); // null compression only
    body.extend_from_slice(&(exts.len() as u16).to_be_bytes());
    body.extend_from_slice(&exts);

    let mut handshake = vec![1u8]; // ClientHello
    handshake.extend_from_slice(&u24_bytes(body.len()));
    handshake.extend_from_slice(&body);

    let mut record = vec![RECORD_HANDSHAKE];
    // The record layer says 1.0 whatever is offered inside, which is what
    // keeps a strict old server from dropping the connection unread.
    record.extend_from_slice(&0x0301u16.to_be_bytes());
    record.extend_from_slice(&(handshake.len() as u16).to_be_bytes());
    record.extend_from_slice(&handshake);
    record
}

/// The first certificate in a server's handshake flight, once enough of the
/// flight has arrived to hold all of it. `None` until then, and for a flight
/// that holds none — never a partial certificate.
pub fn first_certificate_from_flight(flight: &[u8]) -> Option<Vec<u8>> {
    let handshake = handshake_bytes(flight)?;
    let mut messages = handshake.as_slice();
    while messages.len() >= 4 {
        let kind = messages[0];
        let len = u24(&messages[1..4]);
        let body = messages.get(4..4 + len)?;
        if kind == HANDSHAKE_CERTIFICATE {
            // certificate_list<0..2^24-1>, each ASN.1Cert<1..2^24-1>.
            let first = u24(body.get(3..6)?);
            return body.get(6..6 + first).map(<[u8]>::to_vec);
        }
        if kind == HANDSHAKE_SERVER_HELLO_DONE {
            return None;
        }
        messages = &messages[4 + len..];
    }
    None
}

/// The server has said it is done, or refused, without sending a certificate.
fn flight_ended_without_certificate(flight: &[u8]) -> bool {
    let Some(handshake) = handshake_bytes(flight) else { return true };
    let mut messages = handshake.as_slice();
    while messages.len() >= 4 {
        let (kind, len) = (messages[0], u24(&messages[1..4]));
        if kind == HANDSHAKE_SERVER_HELLO_DONE {
            return true;
        }
        let Some(rest) = messages.get(4 + len..) else { return false };
        messages = rest;
    }
    false
}

/// Every whole handshake record's payload, joined. `None` once the server
/// sends an alert — it has refused, and nothing after that is a certificate.
fn handshake_bytes(flight: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut rest = flight;
    while rest.len() >= 5 {
        let kind = rest[0];
        let len = usize::from(u16::from_be_bytes([rest[3], rest[4]]));
        let Some(payload) = rest.get(5..5 + len) else { break };
        match kind {
            RECORD_HANDSHAKE => out.extend_from_slice(payload),
            RECORD_ALERT => return None,
            _ => {}
        }
        rest = &rest[5 + len..];
    }
    Some(out)
}

fn u24(b: &[u8]) -> usize {
    (usize::from(b[0]) << 16) | (usize::from(b[1]) << 8) | usize::from(b[2])
}

fn u24_bytes(n: usize) -> [u8; 3] {
    [(n >> 16) as u8, (n >> 8) as u8, n as u8]
}

/// The ClientHello's random field. Unpredictability protects a session's
/// keys, and this handshake is abandoned before any are made, so it only has
/// to differ between connections: the clock, spread by a xorshift.
fn hello_random() -> [u8; 32] {
    let mut x = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E37_79B9_7F4A_7C15)
        | 1;
    let mut out = [0u8; 32];
    for chunk in out.chunks_mut(8) {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        chunk.copy_from_slice(&x.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const TLS10: &[u8] = include_bytes!("../fixtures/tls-flight-tls10.bin");
    const TLS12: &[u8] = include_bytes!("../fixtures/tls-flight-tls12.bin");

    #[test]
    fn the_certificate_is_read_from_a_tls_1_0_flight() {
        let der = first_certificate_from_flight(TLS10).expect("certificate in the flight");
        let id = read_certificate(&der).expect("readable");
        assert_eq!(id.host_name(), Some("LAB-EDGE-SW.example.test"));
        assert_eq!(id.device_serial(), Some("FOC0000TEST"));
    }

    #[test]
    fn and_from_a_tls_1_2_flight() {
        let der = first_certificate_from_flight(TLS12).expect("certificate in the flight");
        assert_eq!(read_certificate(&der).and_then(|id| id.common_name), Some("LAB-EDGE-SW.example.test".into()));
    }

    /// Data arrives in pieces. At no prefix may the reader return anything
    /// but nothing or the whole certificate.
    #[test]
    fn a_flight_arriving_in_pieces_never_yields_a_partial_certificate() {
        let whole = first_certificate_from_flight(TLS10).unwrap();
        for cut in 0..TLS10.len() {
            if let Some(got) = first_certificate_from_flight(&TLS10[..cut]) {
                assert_eq!(got, whole, "a partial certificate at byte {cut}");
            }
        }
    }

    #[test]
    fn an_alert_or_a_flight_with_no_certificate_ends_the_read() {
        let alert = [RECORD_ALERT, 0x03, 0x01, 0x00, 0x02, 0x02, 0x28];
        assert_eq!(first_certificate_from_flight(&alert), None);
        assert!(flight_ended_without_certificate(&alert));
        // ServerHelloDone alone.
        let done = [RECORD_HANDSHAKE, 0x03, 0x01, 0x00, 0x04, HANDSHAKE_SERVER_HELLO_DONE, 0, 0, 0];
        assert_eq!(first_certificate_from_flight(&done), None);
        assert!(flight_ended_without_certificate(&done));
        assert_eq!(first_certificate_from_flight(b"HTTP/1.1 400 Bad Request\r\n"), None);
    }

    #[test]
    fn the_client_hello_is_one_well_formed_record() {
        let hello = client_hello(TLS_1_2, &[7u8; 32]);
        assert_eq!(hello[0], RECORD_HANDSHAKE);
        assert_eq!(usize::from(u16::from_be_bytes([hello[3], hello[4]])), hello.len() - 5);
        assert_eq!(hello[5], 1, "a ClientHello");
        assert_eq!(u24(&hello[6..9]), hello.len() - 9);
        assert_eq!(&hello[9..11], &[0x03, 0x03], "offers up to TLS 1.2");
        assert!(hello.windows(2).any(|w| w == [0xC0, 0x14]), "offers the suite old Cisco kit picks");
    }

    #[test]
    fn two_hellos_do_not_share_a_random() {
        let a = hello_random();
        std::thread::sleep(std::time::Duration::from_millis(2));
        assert_ne!(a, hello_random());
    }

    /// A flight captured from real equipment, read if one is supplied and
    /// skipped everywhere else — real captures identify real devices and are
    /// never committed (D-027). Prints whether fields were found, not what.
    #[test]
    fn a_real_captured_flight_reads_when_one_is_supplied() {
        let Ok(path) = std::env::var("COREVIEW_TLS_FLIGHT") else { return };
        let flight = std::fs::read(path).expect("readable capture");
        let der = first_certificate_from_flight(&flight).expect("a certificate in the real flight");
        let id = read_certificate(&der).expect("the real certificate reads");
        println!(
            "real flight: host name {}, device serial {}, dns names {}",
            id.host_name().is_some(),
            id.device_serial().is_some(),
            id.dns_names.len()
        );
        assert!(id.common_name.is_some());
    }
}
