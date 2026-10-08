//! One HTTP GET, over TLS, with no HTTP crate.
//!
//! Q-008 asks what "no HTTP client in the Rust core" forbids, and reads the
//! rule as: no general-purpose client that could be pointed anywhere, and no
//! `reqwest`/`hyper` in the tree. This is the narrow thing that rule leaves
//! room for — a request builder that can only issue a GET, to one named host,
//! over the same rustls stack `coreview-probe` already uses for reading a
//! certificate.
//!
//! **It has no other method.** Not "does not currently send POST": there is no
//! code here that could. A read-only integration is one that cannot
//! change a customer's configuration however it is called.

use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Where a request goes: scheme, host, port, and everything after the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Url {
    pub tls: bool,
    pub host: String,
    pub port: u16,
    /// Path and query together, as they go on the request line.
    pub target: String,
}

impl Url {
    /// Splits a URL by hand. A whole URL crate is not worth carrying for the
    /// two shapes this ever sees: the base, and whatever `Link: rel=next`
    /// hands back.
    pub fn parse(raw: &str) -> Option<Url> {
        let (scheme, rest) = raw.split_once("://")?;
        let tls = match scheme {
            "https" => true,
            "http" => false,
            _ => return None,
        };
        let (authority, path) = match rest.find('/') {
            Some(at) => (&rest[..at], &rest[at..]),
            None => (rest, "/"),
        };
        if authority.is_empty() {
            return None;
        }
        // No user info: `https://user@host/` is not a shape this talks to, and
        // accepting it is how a host gets mistaken for a password.
        if authority.contains('@') {
            return None;
        }
        let (host, port) = match authority.rsplit_once(':') {
            Some((h, p)) => (h, p.parse().ok()?),
            None => (authority, if tls { 443 } else { 80 }),
        };
        Some(Url {
            tls,
            host: host.to_string(),
            port,
            target: path.to_string(),
        })
    }

    pub fn is_loopback(&self) -> bool {
        self.host == "localhost"
            || self
                .host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    }
}

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

fn tls_config() -> Arc<rustls::ClientConfig> {
    // Built once: setting up a root store per request is the slow part of a
    // TLS handshake done badly.
    static CONFIG: std::sync::OnceLock<Arc<rustls::ClientConfig>> = std::sync::OnceLock::new();
    Arc::clone(CONFIG.get_or_init(|| {
        let roots = rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        )
    }))
}

/// Issues one GET and reads the whole answer.
///
/// `headers` are added verbatim; the API key is one of them, and never appears
/// in the URL, where it would end up in any log that records one.
pub async fn get(url: &Url, headers: &[(&str, &str)], timeout: Duration) -> io::Result<Response> {
    let mut request = format!("GET {} HTTP/1.1\r\nHost: {}\r\n", url.target, url.host);
    for (k, v) in headers {
        request.push_str(&format!("{k}: {v}\r\n"));
    }
    // Read to the end of the stream rather than juggling a connection pool:
    // this client makes a handful of calls when somebody presses a button.
    request.push_str("Connection: close\r\n\r\n");

    let connect = TcpStream::connect((url.host.as_str(), url.port));
    let stream = tokio::time::timeout(timeout, connect)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "timed out connecting"))??;
    stream.set_nodelay(true).ok();

    let raw = if url.tls {
        let name = rustls_pki_types::ServerName::try_from(url.host.clone())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "not a server name"))?;
        let connector = tokio_rustls::TlsConnector::from(tls_config());
        let mut tls = tokio::time::timeout(timeout, connector.connect(name, stream))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "timed out in the handshake"))??;
        tls.write_all(request.as_bytes()).await?;
        tls.flush().await?;
        read_all(&mut tls, timeout).await?
    } else {
        // Plain HTTP exists for the tests, which stand up a server on
        // loopback. `Client` refuses a non-loopback plain URL.
        let mut plain = stream;
        plain.write_all(request.as_bytes()).await?;
        plain.flush().await?;
        read_all(&mut plain, timeout).await?
    };

    parse(&raw)
}

async fn read_all<S>(stream: &mut S, timeout: Duration) -> io::Result<Vec<u8>>
where
    S: tokio::io::AsyncRead + Unpin,
{
    let mut out = Vec::new();
    tokio::time::timeout(timeout, stream.read_to_end(&mut out))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "timed out reading the answer"))??;
    Ok(out)
}

fn parse(raw: &[u8]) -> io::Result<Response> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "no end of headers"))?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let mut lines = head.lines();
    let status_line = lines
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "no status line"))?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "no status code"))?;

    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    let find = |name: &str| {
        headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    };

    let rest = &raw[split + 4..];
    let body = if find("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked")) {
        dechunk(rest)?
    } else if let Some(len) = find("content-length").and_then(|v| v.trim().parse::<usize>().ok()) {
        rest[..len.min(rest.len())].to_vec()
    } else {
        rest.to_vec()
    };

    Ok(Response { status, headers, body })
}

/// Chunked transfer encoding, which is what a large page comes back as.
fn dechunk(mut rest: &[u8]) -> io::Result<Vec<u8>> {
    let bad = || io::Error::new(io::ErrorKind::InvalidData, "malformed chunked body");
    let mut out = Vec::new();
    loop {
        let eol = rest.windows(2).position(|w| w == b"\r\n").ok_or_else(bad)?;
        let line = String::from_utf8_lossy(&rest[..eol]);
        // A chunk size may carry extensions after a `;`.
        let size_text = line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| bad())?;
        rest = &rest[eol + 2..];
        if size == 0 {
            return Ok(out);
        }
        if rest.len() < size {
            return Err(bad());
        }
        out.extend_from_slice(&rest[..size]);
        rest = rest.get(size + 2..).unwrap_or(&[]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Says this integration is read-only **by construction** — not
    /// "does not currently send a POST". That is a claim about the source, so
    /// it is checked against the source.
    ///
    /// If a write is ever genuinely wanted, this test is the conversation: it
    /// fails, and whoever wants it has to change a decision rather than add a
    /// line.
    #[test]
    fn this_module_can_issue_no_method_but_get() {
        // The real code only: not this test, and not the prose above it, both
        // of which name the verbs in order to forbid them.
        let source = include_str!("http.rs");
        let code: String = source
            .split("#[cfg(test)]")
            .next()
            .expect("the code before the tests")
            .lines()
            .map(str::trim_start)
            .filter(|l| !l.starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");

        assert_eq!(code.matches("GET {}").count(), 1, "the request line moved or multiplied");
        for verb in ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] {
            assert!(
                !code.contains(verb),
                "{verb} appears in the HTTP module's code; Says this cannot write",
            );
        }
    }

    #[test]
    fn a_url_comes_apart_the_way_a_request_needs_it() {
        let u = Url::parse("https://api.meraki.com/api/v1/organizations").expect("parsed");
        assert!(u.tls && u.port == 443 && u.host == "api.meraki.com");
        assert_eq!(u.target, "/api/v1/organizations");
        // A `Link: rel=next` carries the query, which has to survive.
        let p = Url::parse("https://api.meraki.com/api/v1/x?perPage=1000&startingAfter=abc").expect("parsed");
        assert_eq!(p.target, "/api/v1/x?perPage=1000&startingAfter=abc");
        let local = Url::parse("http://127.0.0.1:8080/x").expect("parsed");
        assert!(!local.tls && local.port == 8080 && local.is_loopback());
        assert!(Url::parse("https://localhost/x").expect("parsed").is_loopback());
        assert!(!Url::parse("https://api.meraki.com/x").expect("parsed").is_loopback());
        // Not shapes this talks to, and a host mistaken for a credential is
        // worse than a refusal.
        assert!(Url::parse("ftp://host/x").is_none());
        assert!(Url::parse("https://user:pass@host/x").is_none());
        assert!(Url::parse("not a url").is_none());
    }

    #[test]
    fn a_chunked_answer_is_put_back_together() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        let r = parse(raw).expect("parsed");
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"hello world");
    }

    #[test]
    fn a_counted_answer_stops_where_it_says_it_does() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n[]trailing rubbish";
        assert_eq!(parse(raw).expect("parsed").body, b"[]");
    }

    #[test]
    fn headers_are_found_whatever_case_they_arrived_in() {
        let raw = b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 2\r\nlink: <https://x/2>; rel=next\r\n\r\n";
        let r = parse(raw).expect("parsed");
        assert_eq!(r.status, 429);
        assert_eq!(r.header("retry-after"), Some("2"));
        assert_eq!(r.header("LINK"), Some("<https://x/2>; rel=next"));
        assert_eq!(r.header("nothing"), None);
    }
}
