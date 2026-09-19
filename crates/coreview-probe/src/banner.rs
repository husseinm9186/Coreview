//! What a host's plain-HTTP web page says about the software behind it
//! (LT-124).
//!
//! Measured on the operator's network before this was written, and the
//! measurement set its scope: of six hosts serving HTTP, **none named
//! itself**. A Cisco switch answered `401` with `Server: cisco-IOS`, a Windows
//! host `Microsoft-IIS/10.0` over its default "IIS Windows" page, three
//! reverse proxies `Caddy` and a redirect to HTTPS, and a NAS a blank
//! `Server:` header and no title. So a banner is reported for what it is — the
//! web server software, and a page title when it is not a default page — and
//! it is **never used as a device name**.
//!
//! Every response observed was HTTP/1.1, with header names in mixed case
//! (`Content-type`), and one had a `Server` header present but blank. The
//! parser is tested against those shapes, rebuilt with no lab identities.

use std::net::Ipv4Addr;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::time::timeout;

/// Enough for the headers and the `<title>` of any page worth reading; a
/// banner is not a crawl of the site.
const MAX_RESPONSE_BYTES: usize = 16 * 1024;
/// Longest value kept. A server string or a title longer than this is noise
/// in a table cell.
const MAX_VALUE_CHARS: usize = 80;

/// Page titles that say which web server is installed, not what the device
/// is. Compared without regard to case.
const DEFAULT_TITLES: &[&str] = &[
    "IIS Windows",
    "IIS Windows Server",
    "Welcome to nginx!",
    "It works!",
    "Apache2 Ubuntu Default Page: It works",
    "Apache2 Debian Default Page: It works",
    "Test Page for the Apache HTTP Server",
    "Document Moved",
    "Object moved",
    "301 Moved Permanently",
    "302 Found",
    "400 Bad Request",
    "401 Unauthorized",
    "403 Forbidden",
    "404 Not Found",
    "Loading...",
    "Redirecting...",
];

/// What the web page said. At least one field is always present.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WebBanner {
    /// The `Server` header: `cisco-IOS`, `Microsoft-IIS/10.0`.
    pub server: Option<String>,
    /// The page's `<title>`, when it is not a default page.
    pub title: Option<String>,
}

/// Asks `ip:port` for `/` and reads what comes back, bounded in size and time.
pub async fn fetch_banner(ip: Ipv4Addr, port: u16, timeout_ms: u64) -> Option<WebBanner> {
    let deadline = Duration::from_millis(timeout_ms);
    let mut tcp = timeout(deadline, TcpStream::connect((ip, port))).await.ok()?.ok()?;
    let request = crate::http::request_line(&ip.to_string(), "/");
    timeout(deadline, tcp.write_all(request.as_bytes())).await.ok()?.ok()?;
    let raw = timeout(deadline, crate::http::read_capped(&mut tcp, MAX_RESPONSE_BYTES))
        .await
        .ok()?
        .ok()?;
    parse_response(&raw)
}

/// The banner in a raw HTTP response. `None` for anything that is not an
/// HTTP response, and for one that says nothing about its software.
pub fn parse_response(raw: &[u8]) -> Option<WebBanner> {
    let text = String::from_utf8_lossy(raw);
    if !text.starts_with("HTTP/1.") {
        return None;
    }
    let (head, body) = match text.find("\r\n\r\n").or_else(|| text.find("\n\n")) {
        Some(i) => (&text[..i], &text[i..]),
        None => (&text[..], ""),
    };

    let server = head
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("server"))
        .and_then(|(_, value)| clean(value));

    let title = page_title(body).filter(|t| !DEFAULT_TITLES.iter().any(|d| d.eq_ignore_ascii_case(t)));

    (server.is_some() || title.is_some()).then_some(WebBanner { server, title })
}

/// The first `<title>` in a page, entities decoded and whitespace collapsed.
fn page_title(body: &str) -> Option<String> {
    let lower = body.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let start = open + lower[open..].find('>')? + 1;
    let end = start + lower[start..].find("</title")?;
    let decoded = body[start..end]
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    clean(&decoded)
}

/// Trimmed, whitespace collapsed, control characters removed, capped.
/// `None` when nothing is left.
fn clean(value: &str) -> Option<String> {
    let collapsed = value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>();
    let capped: String = collapsed.chars().take(MAX_VALUE_CHARS).collect();
    let capped = capped.trim().to_string();
    (!capped.is_empty()).then_some(capped)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape a Cisco IOS switch answered with: 401, a Server header, no page.
    const IOS_401: &str = "HTTP/1.1 401 Unauthorized\r\nDate: Thu, 01 Jan 2026 00:00:00 GMT\r\n\
        Server: cisco-IOS\r\nConnection: close\r\nAccept-Ranges: none\r\n\
        WWW-Authenticate: Basic realm=\"level_15_access\"\r\n\r\n";

    /// The shape IIS answered with: its default page, whose title is not news.
    const IIS_DEFAULT: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nServer: Microsoft-IIS/10.0\r\n\
        Content-Length: 703\r\n\r\n<!DOCTYPE html>\n<html><head>\n<title>IIS Windows</title>\n</head></html>";

    /// The shape a NAS answered with: a blank Server header, mixed-case names,
    /// and no title.
    const NAS_BLANK: &str = "HTTP/1.1 200 OK\r\nDate: Thu, 01 Jan 2026 00:00:00 GMT\r\nServer:  \r\n\
        Content-type: text/html\r\nContent-length: 12\r\n\r\n<html></html>";

    #[test]
    fn a_cisco_style_401_gives_its_server_software() {
        let b = parse_response(IOS_401.as_bytes()).expect("a banner");
        assert_eq!(b.server.as_deref(), Some("cisco-IOS"));
        assert_eq!(b.title, None);
    }

    #[test]
    fn a_default_page_title_is_dropped_and_the_server_kept() {
        let b = parse_response(IIS_DEFAULT.as_bytes()).expect("a banner");
        assert_eq!(b.server.as_deref(), Some("Microsoft-IIS/10.0"));
        assert_eq!(b.title, None, "IIS Windows says which server, not which device");
    }

    #[test]
    fn a_blank_server_header_and_no_title_is_no_banner_at_all() {
        assert_eq!(parse_response(NAS_BLANK.as_bytes()), None);
    }

    #[test]
    fn a_real_page_title_is_kept_decoded_and_tidied() {
        let raw = "HTTP/1.1 200 OK\r\nSERVER: ExampleWeb/2.1\r\n\r\n\
            <html><head><TITLE lang=\"en\">\n  Lab Printer &amp; Scanner\n  Status </TITLE></head></html>";
        let b = parse_response(raw.as_bytes()).expect("a banner");
        assert_eq!(b.server.as_deref(), Some("ExampleWeb/2.1"), "header names are case-insensitive");
        assert_eq!(b.title.as_deref(), Some("Lab Printer & Scanner Status"));
    }

    #[test]
    fn anything_that_is_not_http_is_refused() {
        assert_eq!(parse_response(b"SSH-2.0-OpenSSH_9.6\r\n"), None);
        assert_eq!(parse_response(b""), None);
        assert_eq!(parse_response(&[0x16, 0x03, 0x01, 0x00, 0x2a]), None, "a TLS record on a plain port");
    }

    #[test]
    fn a_response_cut_off_mid_headers_still_gives_what_arrived_whole() {
        let cut = "HTTP/1.1 401 Unauthorized\r\nServer: cisco-IOS\r\nWWW-Auth";
        assert_eq!(parse_response(cut.as_bytes()).and_then(|b| b.server).as_deref(), Some("cisco-IOS"));
        // And a truncated title is not read as one.
        assert_eq!(parse_response(b"HTTP/1.1 200 OK\r\n\r\n<title>Half a tit"), None);
    }

    #[test]
    fn values_are_capped_and_control_characters_removed() {
        let long = format!("HTTP/1.1 200 OK\r\nServer: {}\u{7}\r\n\r\n", "x".repeat(300));
        let b = parse_response(long.as_bytes()).expect("a banner");
        assert_eq!(b.server.as_ref().map(|s| s.chars().count()), Some(MAX_VALUE_CHARS));
        assert!(!b.server.unwrap().contains('\u{7}'));
    }
}
