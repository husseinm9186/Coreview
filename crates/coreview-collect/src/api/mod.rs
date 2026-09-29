//! The API collectors, in Rust from day one (D-060): FortiOS REST, PAN-OS
//! XML API, AOS-CX REST. GET only — or the vendor's read-only equivalent —
//! to the host the operator named, over TLS, with the certificate pinned
//! the way an SSH host key is: the first sight is recorded, every later
//! one must match, and a change is refused before a token is sent again.
//! Meraki stays in `coreview-meraki` (D-056, D-057).

pub mod aoscx;
pub mod fortios;
pub mod panos;
mod pin;

pub use pin::{CertPin, PinPolicy};

use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("{0}")]
    Tls(String),
    #[error("the certificate changed: it was {was}, it is now {now}; refusing to send the token")]
    PinMismatch { was: String, now: String },
    #[error("HTTP {0}: {1}")]
    Status(u16, String),
    #[error("{0}")]
    Transport(String),
    #[error("{0}")]
    Body(String),
    #[error("not signed in: {0}")]
    Auth(String),
}

/// One API answer: the rows, the raw body kept for the diagnostic folder.
#[derive(Debug, Clone, Default)]
pub struct ApiOutcome {
    pub status: String,
    pub rows: Vec<Value>,
    pub raw: String,
    pub duration_ms: u64,
    pub error: Option<String>,
}

/// The shared client: a reqwest client over rustls with the pin verifier.
pub struct ApiClient {
    pub host: String,
    pub client: reqwest::Client,
    pub pin: std::sync::Arc<CertPin>,
}

impl ApiClient {
    pub fn new(host: &str, policy: PinPolicy, timeout_s: u64) -> Result<ApiClient, ApiError> {
        let pin = std::sync::Arc::new(CertPin::new(policy));
        let config = pin::client_config(pin.clone());
        let client = reqwest::Client::builder()
            .use_preconfigured_tls(config)
            .timeout(std::time::Duration::from_secs(timeout_s))
            .redirect(reqwest::redirect::Policy::none())
            .cookie_store(true)
            .user_agent("Coreview")
            .build()
            .map_err(|e| ApiError::Transport(e.to_string()))?;
        Ok(ApiClient { host: host.to_string(), client, pin })
    }

    pub fn url(&self, path: &str) -> String {
        format!("https://{}{}", self.host, path)
    }

    /// The certificate fingerprint seen on this connection, once anything was sent.
    pub fn seen(&self) -> Option<String> {
        self.pin.seen()
    }
}

/// `rows` out of a JSON body: the `results` list when there is one (FortiOS),
/// or whatever `tables::rows_from_json` makes of it.
pub fn rows_from_api_json(body: &Value) -> Vec<Value> {
    if let Some(results) = body.get("results") {
        return crate::tables::rows_from_json(results);
    }
    crate::tables::rows_from_json(body)
}
