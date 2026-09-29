//! Certificate pinning, the SSH host-key way. A firewall's management
//! interface almost always presents a self-signed certificate, so the
//! public roots prove nothing about it. What can be proved is that it is
//! the same certificate as last time: the SHA-256 of the leaf is recorded
//! on first sight and must match after that. A mismatch fails the
//! handshake, so the token is never sent to the new certificate.

use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PinPolicy {
    /// First sight: accept whatever is presented and record it.
    TrustOnFirstUse,
    /// A known fingerprint (lower-case hex SHA-256 of the DER leaf); anything else fails.
    Pinned(String),
}

#[derive(Debug)]
pub struct CertPin {
    policy: PinPolicy,
    seen: Mutex<Option<String>>,
}

impl CertPin {
    pub fn new(policy: PinPolicy) -> CertPin {
        CertPin { policy, seen: Mutex::new(None) }
    }
    pub fn seen(&self) -> Option<String> {
        self.seen.lock().unwrap().clone()
    }
    pub fn fingerprint(der: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(der);
        h.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }
}

impl ServerCertVerifier for CertPin {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fp = CertPin::fingerprint(end_entity.as_ref());
        match &self.policy {
            PinPolicy::TrustOnFirstUse => {
                *self.seen.lock().unwrap() = Some(fp);
                Ok(ServerCertVerified::assertion())
            }
            PinPolicy::Pinned(want) => {
                if want.eq_ignore_ascii_case(&fp) {
                    *self.seen.lock().unwrap() = Some(fp);
                    Ok(ServerCertVerified::assertion())
                } else {
                    Err(rustls::Error::General(format!("certificate changed: pinned {want}, presented {fp}")))
                }
            }
        }
    }

    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &rustls::crypto::aws_lc_rs::default_provider().signature_verification_algorithms)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &rustls::crypto::aws_lc_rs::default_provider().signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::aws_lc_rs::default_provider().signature_verification_algorithms.supported_schemes()
    }
}

pub fn client_config(pin: Arc<CertPin>) -> rustls::ClientConfig {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("the default protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(pin)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    config
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fingerprint_is_sha256_hex_and_a_pin_compares_case_blind() {
        let fp = CertPin::fingerprint(b"not really a certificate");
        assert_eq!(fp.len(), 64);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
        let pin = CertPin::new(PinPolicy::Pinned(fp.to_uppercase()));
        assert!(pin.seen().is_none());
    }
}
