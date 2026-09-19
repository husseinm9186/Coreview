//! What a device's TLS certificate says about it (LT-124).
//!
//! A managed switch or firewall that will not answer NetBIOS, mDNS or LLMNR
//! often still serves a web interface, and the certificate it presents names
//! it. What it names varies by vendor, and that difference is the point of
//! this module rather than a detail:
//!
//! * A Cisco self-signed certificate carries the device's **hostname** as its
//!   common name and its **chassis serial** in a `serialNumber` attribute.
//! * A Fortinet factory certificate carries the **serial** as its common name,
//!   with `Fortinet` as the organisation and the product family
//!   (`FortiSwitch`) as the unit.
//!
//! So a common name is not assumed to be a hostname: `host_name` refuses one
//! that reads as a serial, and `device_serial` returns it instead.
//!
//! The reader is deliberately small — the subject's CN, O, OU and serialNumber
//! and the subjectAltName DNS names — and returns `None` for anything it cannot
//! walk rather than guessing. Nothing is validated: the certificate is read for
//! what it claims, not trusted for anything.
//!
//! Tested against certificates generated in those two shapes with invented
//! identities (D-027), in `fixtures/cert-*.der`:
//!
//! ```text
//! openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
//!   -subj "/CN=LAB-EDGE-SW.example.test/serialNumber=FOC0000TEST+unstructuredName=LAB-EDGE-SW.example.test" \
//!   -addext "subjectAltName=DNS:LAB-EDGE-SW.example.test"
//! openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
//!   -subj "/C=US/ST=California/L=Sunnyvale/O=Fortinet/OU=FortiSwitch/CN=S000TESTSERIAL00/emailAddress=support@example.test"
//! ```

/// What a certificate says, field by field. Every field is optional because
/// every one of them is, in practice.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CertIdentity {
    pub common_name: Option<String>,
    pub organisation: Option<String>,
    pub unit: Option<String>,
    /// The subject's `serialNumber` attribute — the device's serial where a
    /// vendor puts it there. Not the certificate's own serial number.
    pub serial_number: Option<String>,
    /// subjectAltName DNS entries, in order.
    pub dns_names: Vec<String>,
}

impl CertIdentity {
    /// A name worth showing as the host's: the common name when it reads as a
    /// hostname, else the first DNS name that does. A serial, an address and
    /// `localhost` are not hostnames.
    pub fn host_name(&self) -> Option<&str> {
        let usable = |s: &&str| {
            let s = s.trim();
            !s.is_empty()
                && !s.eq_ignore_ascii_case("localhost")
                && s.parse::<std::net::IpAddr>().is_err()
                && !looks_like_serial(s)
                && self.serial_number.as_deref() != Some(s)
        };
        self.common_name
            .as_deref()
            .filter(usable)
            .or_else(|| self.dns_names.iter().map(String::as_str).find(usable))
    }

    /// The device serial the certificate carries: the `serialNumber`
    /// attribute, else a common name that reads as a vendor serial.
    pub fn device_serial(&self) -> Option<&str> {
        self.serial_number
            .as_deref()
            .or_else(|| self.common_name.as_deref().filter(|cn| looks_like_serial(cn)))
    }
}

/// Whether a string reads as a vendor serial rather than a hostname: one
/// token, no dots, 8 to 20 upper-case letters and digits, with at least four
/// digits and two letters. `S000TESTSERIAL00` does; `SWITCH01`, which has two
/// digits, and anything with a dot or a hyphen do not.
pub fn looks_like_serial(s: &str) -> bool {
    let s = s.trim();
    let digits = s.bytes().filter(u8::is_ascii_digit).count();
    let letters = s.bytes().filter(u8::is_ascii_uppercase).count();
    (8..=20).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_uppercase())
        && digits >= 4
        && letters >= 2
}

/// Reads what a DER-encoded X.509 certificate says about its subject.
pub fn read_certificate(der: &[u8]) -> Option<CertIdentity> {
    let (0x30, cert, _) = tlv(der)? else { return None };
    let (0x30, tbs, _) = tlv(cert)? else { return None };
    let fields = children(tbs)?;

    // tbsCertificate: [0] version (optional), serial, signature algorithm,
    // issuer, validity, subject, subject public key, then optional unique ids
    // and [3] extensions.
    let offset = usize::from(fields.first()?.0 == 0xA0);
    let &(subject_tag, subject) = fields.get(offset + 4)?;
    if subject_tag != 0x30 {
        return None;
    }

    let mut id = CertIdentity::default();
    for (set_tag, rdn) in children(subject)? {
        if set_tag != 0x31 {
            return None;
        }
        // A set can hold several attributes — Cisco puts serialNumber and
        // unstructuredName in one.
        for (seq_tag, attribute) in children(rdn)? {
            if seq_tag != 0x30 {
                continue;
            }
            let parts = children(attribute)?;
            let (Some(&(0x06, oid)), Some(&(value_tag, value))) = (parts.first(), parts.get(1)) else {
                continue;
            };
            let Some(text) = der_string(value_tag, value) else { continue };
            let slot = match oid {
                [0x55, 0x04, 0x03] => &mut id.common_name,
                [0x55, 0x04, 0x05] => &mut id.serial_number,
                [0x55, 0x04, 0x0A] => &mut id.organisation,
                [0x55, 0x04, 0x0B] => &mut id.unit,
                _ => continue,
            };
            // The first of each wins; a second CN is rare and never better.
            slot.get_or_insert(text);
        }
    }

    if let Some(&(_, wrapped)) = fields.iter().skip(offset + 6).find(|(tag, _)| *tag == 0xA3) {
        if let Some(&(0x30, extensions)) = children(wrapped)?.first() {
            for (_, extension) in children(extensions)? {
                let parts = children(extension)?;
                let Some(&(0x06, [0x55, 0x1D, 0x11])) = parts.first() else { continue };
                let Some(&(_, value)) = parts.iter().rev().find(|(tag, _)| *tag == 0x04) else {
                    continue;
                };
                if let Some((0x30, names, _)) = tlv(value) {
                    for (tag, name) in children(names)? {
                        // [2] IMPLICIT IA5String: dNSName.
                        if tag == 0x82 {
                            if let Some(text) = der_string(0x16, name) {
                                id.dns_names.push(text);
                            }
                        }
                    }
                }
            }
        }
    }
    Some(id)
}

/// One DER element: its tag, its contents, and whatever follows it. `None`
/// for anything truncated or with an implausible length, never a panic.
fn tlv(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = input.split_first()?;
    let (&first, rest) = rest.split_first()?;
    let (len, rest) = if first & 0x80 == 0 {
        (usize::from(first), rest)
    } else {
        let n = usize::from(first & 0x7F);
        if n == 0 || n > 4 || rest.len() < n {
            return None;
        }
        let len = rest[..n].iter().fold(0usize, |acc, b| (acc << 8) | usize::from(*b));
        (len, &rest[n..])
    };
    if rest.len() < len {
        return None;
    }
    Some((tag, &rest[..len], &rest[len..]))
}

/// Every element inside a constructed one.
fn children(mut value: &[u8]) -> Option<Vec<(u8, &[u8])>> {
    let mut out = Vec::new();
    while !value.is_empty() {
        let (tag, contents, rest) = tlv(value)?;
        out.push((tag, contents));
        value = rest;
    }
    Some(out)
}

/// The directory-string types a subject actually uses, as text.
fn der_string(tag: u8, value: &[u8]) -> Option<String> {
    let text = match tag {
        // UTF8String, PrintableString, IA5String.
        0x0C | 0x13 | 0x16 => String::from_utf8(value.to_vec()).ok()?,
        // T61String: treated as Latin-1, which is what it holds in practice.
        0x14 => value.iter().map(|&b| char::from(b)).collect(),
        // BMPString: UTF-16, big-endian.
        0x1E => {
            // Paired by stepping rather than chunking: `is_multiple_of` and
            // `as_chunks`, which clippy prefers, need a newer compiler than
            // the rest of the workspace asks for.
            if value.len() & 1 == 1 {
                return None;
            }
            let units: Vec<u16> = value
                .iter()
                .step_by(2)
                .zip(value.iter().skip(1).step_by(2))
                .map(|(&high, &low)| u16::from_be_bytes([high, low]))
                .collect();
            String::from_utf16(&units).ok()?
        }
        _ => return None,
    };
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CISCO_STYLE: &[u8] = include_bytes!("../fixtures/cert-cisco-style.der");
    const FORTI_STYLE: &[u8] = include_bytes!("../fixtures/cert-forti-style.der");

    #[test]
    fn a_cisco_style_certificate_gives_a_hostname_and_the_chassis_serial() {
        let id = read_certificate(CISCO_STYLE).expect("reads");
        assert_eq!(id.common_name.as_deref(), Some("LAB-EDGE-SW.example.test"));
        assert_eq!(id.serial_number.as_deref(), Some("FOC0000TEST"));
        assert_eq!(id.dns_names, vec!["LAB-EDGE-SW.example.test".to_string()]);
        assert_eq!(id.host_name(), Some("LAB-EDGE-SW.example.test"));
        assert_eq!(id.device_serial(), Some("FOC0000TEST"));
    }

    #[test]
    fn a_fortinet_style_certificate_gives_the_serial_and_the_product_family_but_no_hostname() {
        let id = read_certificate(FORTI_STYLE).expect("reads");
        assert_eq!(id.common_name.as_deref(), Some("S000TESTSERIAL00"));
        assert_eq!(id.organisation.as_deref(), Some("Fortinet"));
        assert_eq!(id.unit.as_deref(), Some("FortiSwitch"));
        assert_eq!(id.host_name(), None, "a serial is not a hostname");
        assert_eq!(id.device_serial(), Some("S000TESTSERIAL00"));
    }

    #[test]
    fn a_truncated_or_garbage_certificate_is_refused_without_panicking() {
        for cut in 0..CISCO_STYLE.len() {
            let _ = read_certificate(&CISCO_STYLE[..cut]);
        }
        assert_eq!(read_certificate(&[]), None);
        assert_eq!(read_certificate(&[0x30, 0x84, 0xFF, 0xFF, 0xFF, 0xFF]), None);
        assert_eq!(read_certificate(b"not a certificate at all"), None);
    }

    #[test]
    fn serials_are_told_apart_from_hostnames() {
        // Invented, in the two shapes vendors use (D-027): a Fortinet-style
        // serial and a Cisco-style one.
        assert!(looks_like_serial("S000TESTSERIAL00"));
        assert!(looks_like_serial("FOC0000TEST"));
        assert!(!looks_like_serial("SWITCH01"), "two digits is a name");
        assert!(!looks_like_serial("core-sw.example.test"));
        assert!(!looks_like_serial("LAB-EDGE-SW"));
        assert!(!looks_like_serial("abc0000test"), "lower case is not a vendor serial");
    }

    #[test]
    fn an_address_or_localhost_is_not_offered_as_a_name() {
        let by_ip = CertIdentity { common_name: Some("192.0.2.1".into()), ..Default::default() };
        assert_eq!(by_ip.host_name(), None);
        let local = CertIdentity {
            common_name: Some("localhost".into()),
            dns_names: vec!["edge.example.test".into()],
            ..Default::default()
        };
        assert_eq!(local.host_name(), Some("edge.example.test"), "falls back to a DNS name");
    }

    #[test]
    fn a_bmp_string_decodes() {
        assert_eq!(der_string(0x1E, &[0x00, b'S', 0x00, b'W']).as_deref(), Some("SW"));
        assert_eq!(der_string(0x1E, &[0x00]), None);
    }
}
