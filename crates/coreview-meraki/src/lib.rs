//! The Cisco Meraki Dashboard API, read-only (LT-404, D-056).
//!
//! Meraki MR, MS and MX have no command line. A crawl can never log into one,
//! so everything Coreview can know about a Meraki estate comes from this API
//! or from what a neighbouring switch happens to say about it.
//!
//! **Read-only by construction.** Every call here is a GET, and [`http`] has
//! no other method — not "does not currently send a POST", but no code that
//! could. That is what makes D-056's promise checkable rather than a claim:
//! this cannot change a customer's configuration however it is called.
//!
//! **One named host.** `api.meraki.com`, or a loopback address for the tests.
//! A client that could be pointed anywhere is a general-purpose HTTP client,
//! which is the thing Q-008 rules out.
//!
//! **Built from a working program, not from documentation.** The endpoints,
//! the field names and the paging come from the operator's own scripts, which
//! he has run against the live API. What has *not* happened is Coreview's own
//! client getting an answer from Meraki: there is no key on the machine this
//! was written on. [`Client::verified_against_api`] says so, and says it until
//! somebody changes it after watching it work.

pub mod api;
mod http;

use std::sync::Mutex;
use std::time::{Duration, Instant};

pub use api::{Device, Network, Organization};
pub use http::{Response, Url};

/// Where the real thing lives.
pub const BASE: &str = "https://api.meraki.com/api/v1";

/// Just under the documented five requests per second, per organisation. The
/// operator's script uses the same figure for the same reason: the limit is
/// per organisation and a burst that trips it costs more time than it saves.
const MIN_GAP: Duration = Duration::from_millis(220);

const TIMEOUT: Duration = Duration::from_secs(60);
const RETRIES: u32 = 4;
/// Enough for any organisation this is pointed at, and a stop either way: a
/// paging loop that cannot end is worse than an incomplete answer.
const MAX_PAGES: usize = 50;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("the Meraki API refused the key — check it is a current, read-only key")]
    Unauthorised,
    #[error("the Meraki API said: {message}")]
    Api { status: u16, message: String },
    #[error("could not reach api.meraki.com: {0}")]
    Network(String),
    #[error("the Meraki API sent something this does not understand: {0}")]
    Decode(String),
    #[error("{0}")]
    Refused(String),
}

pub type Result<T> = std::result::Result<T, Error>;

pub struct Client {
    key: String,
    base: String,
    min_gap: Duration,
    /// When the last request went out, so the next one can wait its turn.
    last: Mutex<Option<Instant>>,
}

impl Client {
    /// A client for the real API.
    pub fn new(key: impl Into<String>) -> Client {
        Client {
            key: key.into(),
            base: BASE.to_string(),
            min_gap: MIN_GAP,
            last: Mutex::new(None),
        }
    }

    /// A client pointed at a test server.
    ///
    /// Loopback only. Not because a test could not use a public address, but
    /// because this is the one door in the wall D-056 puts around the host
    /// this talks to, and a door that opens anywhere is not a wall.
    pub fn for_testing(base: &str, key: impl Into<String>) -> Result<Client> {
        let url = Url::parse(base).ok_or_else(|| Error::Refused(format!("not a URL: {base}")))?;
        if !url.is_loopback() {
            return Err(Error::Refused(
                "a test client may only talk to loopback; the real API is api.meraki.com".into(),
            ));
        }
        Ok(Client {
            key: key.into(),
            base: base.trim_end_matches('/').to_string(),
            min_gap: Duration::from_millis(1),
            last: Mutex::new(None),
        })
    }

    /// Whether this client has ever had an answer from the real API.
    ///
    /// False, and honestly so (D-051's rule): it is written from a program
    /// that works, which is evidence about *Meraki*, not about this code.
    pub fn verified_against_api(&self) -> bool {
        false
    }

    /// Waits its turn, so a run of calls stays under the rate limit.
    async fn gate(&self) {
        let wait = {
            let mut last = self.last.lock().expect("rate gate");
            let now = Instant::now();
            let wait = last
                .map(|t| self.min_gap.saturating_sub(now.duration_since(t)))
                .unwrap_or_default();
            *last = Some(now + wait);
            wait
        };
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }

    async fn fetch(&self, url: &Url) -> Result<Response> {
        let headers = [
            ("X-Cisco-Meraki-API-Key", self.key.as_str()),
            ("Accept", "application/json"),
            ("User-Agent", concat!("Coreview/", env!("CARGO_PKG_VERSION"))),
        ];
        let mut attempt = 0;
        loop {
            self.gate().await;
            let answer = http::get(url, &headers, TIMEOUT).await;
            let response = match answer {
                Ok(r) => r,
                Err(e) if attempt < RETRIES => {
                    attempt += 1;
                    tokio::time::sleep(self.min_gap * attempt).await;
                    let _ = e;
                    continue;
                }
                Err(e) => return Err(Error::Network(e.to_string())),
            };
            // 429 is the rate limit and says how long to wait; a 5xx is worth
            // one more try. Everything else is an answer, including a refusal.
            if (response.status == 429 || response.status >= 500) && attempt < RETRIES {
                attempt += 1;
                let after = response
                    .header("retry-after")
                    .and_then(|v| v.trim().parse::<u64>().ok())
                    .map(Duration::from_secs)
                    .unwrap_or(self.min_gap * attempt);
                tokio::time::sleep(after).await;
                continue;
            }
            return Ok(response);
        }
    }

    fn url(&self, path: &str, query: &[(&str, String)]) -> Result<Url> {
        let mut raw = format!("{}{path}", self.base);
        if !query.is_empty() {
            let q: Vec<String> = query.iter().map(|(k, v)| format!("{k}={v}")).collect();
            raw.push('?');
            raw.push_str(&q.join("&"));
        }
        Url::parse(&raw).ok_or_else(|| Error::Refused(format!("not a URL: {raw}")))
    }

    fn check(response: &Response) -> Result<()> {
        if response.status < 400 {
            return Ok(());
        }
        if response.status == 401 || response.status == 403 {
            return Err(Error::Unauthorised);
        }
        // Meraki answers an error as `{"errors": ["..."]}`; saying what it
        // said beats "HTTP 400".
        let said = serde_json::from_slice::<serde_json::Value>(&response.body)
            .ok()
            .and_then(|v| {
                v.get("errors")
                    .and_then(|e| e.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str())
                            .collect::<Vec<_>>()
                            .join("; ")
                    })
                    .filter(|s| !s.is_empty())
                    .or_else(|| v.get("message").and_then(|m| m.as_str()).map(str::to_string))
            })
            .unwrap_or_else(|| format!("HTTP {}", response.status));
        Err(Error::Api { status: response.status, message: said })
    }

    /// One call, decoded.
    pub async fn get<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<T> {
        let response = self.fetch(&self.url(path, query)?).await?;
        Self::check(&response)?;
        serde_json::from_slice(&response.body).map_err(|e| Error::Decode(e.to_string()))
    }

    /// Every page of a list, following `Link: rel=next`.
    pub async fn get_paged<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Vec<T>> {
        let mut url = self.url(path, query)?;
        let mut out = Vec::new();
        for _ in 0..MAX_PAGES {
            let response = self.fetch(&url).await?;
            // A page that is not there ends the walk rather than failing it:
            // an endpoint that does not apply to a network answers 404, and
            // that is an answer, not a fault.
            if response.status == 404 {
                break;
            }
            Self::check(&response)?;
            let batch: Vec<T> =
                serde_json::from_slice(&response.body).map_err(|e| Error::Decode(e.to_string()))?;
            out.extend(batch);
            match next_page(response.header("link")) {
                Some(next) => {
                    url = Url::parse(&next).ok_or_else(|| Error::Decode(format!("bad next page: {next}")))?
                }
                None => break,
            }
        }
        Ok(out)
    }

    /// A call that is allowed to come back with nothing.
    ///
    /// Half these endpoints do not apply to half the networks — a network with
    /// no appliance has no firewall rules — and a run that stopped at the
    /// first of those would never finish. What it could not read is reported
    /// rather than guessed at.
    pub async fn optional<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Option<T> {
        self.get(path, query).await.ok()
    }
}

/// The `next` URL out of a `Link` header, if there is one.
fn next_page(link: Option<&str>) -> Option<String> {
    for part in link?.split(',') {
        let (target, rel) = part.split_once(';')?;
        if !rel.to_ascii_lowercase().contains("rel=next") {
            continue;
        }
        let trimmed = target.trim().trim_start_matches('<').trim_end_matches('>');
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_next_page_is_found_among_the_others() {
        let header = "<https://api.meraki.com/api/v1/x?startingAfter=1>; rel=first, \
                      <https://api.meraki.com/api/v1/x?startingAfter=9>; rel=next";
        assert_eq!(
            next_page(Some(header)).as_deref(),
            Some("https://api.meraki.com/api/v1/x?startingAfter=9"),
        );
        // The last page says prev and nothing else.
        assert_eq!(next_page(Some("<https://x>; rel=prev")), None);
        assert_eq!(next_page(None), None);
    }

    #[test]
    fn a_test_client_can_only_talk_to_loopback() {
        assert!(Client::for_testing("http://127.0.0.1:9/api", "k").is_ok());
        assert!(Client::for_testing("http://localhost:9/api", "k").is_ok());
        // The one door in the wall D-056 puts around the host this talks to.
        match Client::for_testing("https://api.example.com", "k") {
            Err(Error::Refused(why)) => assert!(why.contains("loopback"), "{why}"),
            Err(other) => panic!("refused for the wrong reason: {other}"),
            Ok(_) => panic!("a client was built for a host that is not Meraki"),
        }
    }

    #[test]
    fn nothing_here_claims_to_have_met_the_api() {
        assert!(!Client::new("k").verified_against_api());
    }
}
