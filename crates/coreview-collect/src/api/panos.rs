//! PAN-OS XML API: `GET /api/?type=op&cmd=<xml>&key=<key>`. The operator
//! gives an API key, or a username and password that `type=keygen` turns
//! into one for the run; the key is kept in memory for the run only.
//! `cmd_xml` turns a CLI command into the element tree the API wants,
//! the way pan-python does: every word an element, a quoted word the text
//! of the one before it.

use std::time::Instant;

use super::{ApiClient, ApiError, ApiOutcome};
use crate::tables::rows_from_xml;

/// `show routing route` → `<show><routing><route></route></routing></show>`;
/// `show interface all` → `<show><interface><all></all></interface></show>`;
/// `test routing fib-lookup virtual-router "default" ip "192.0.2.1"` → text inside the preceding elements.
pub fn cmd_xml(command: &str) -> String {
    let mut out = String::new();
    let mut open: Vec<String> = Vec::new();
    let mut words = command.split_whitespace().peekable();
    while let Some(w) = words.next() {
        if let Some(text) = w.strip_prefix('"').and_then(|t| t.strip_suffix('"')) {
            out.push_str(&escape(text));
            continue;
        }
        let tag = w.to_string();
        out.push('<');
        out.push_str(&tag);
        out.push('>');
        open.push(tag);
        // A following quoted word closes this element after its text; otherwise nest.
        if let Some(next) = words.peek() {
            if next.starts_with('"') {
                let text = words.next().unwrap().trim_matches('"');
                out.push_str(&escape(text));
                let t = open.pop().unwrap();
                out.push_str(&format!("</{t}>"));
            }
        }
    }
    while let Some(t) = open.pop() {
        out.push_str(&format!("</{t}>"));
    }
    out
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub async fn keygen(client: &ApiClient, user: &str, password: &str) -> Result<String, ApiError> {
    let resp = client
        .client
        .get(client.url("/api/"))
        .query(&[("type", "keygen"), ("user", user), ("password", password)])
        .send().await.map_err(|e| super::transport(e, &client.pin))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| ApiError::Body(e.to_string()))?;
    if status >= 400 {
        return Err(ApiError::Auth(format!("HTTP {status}")));
    }
    let doc = roxmltree::Document::parse(&text).map_err(|e| ApiError::Body(e.to_string()))?;
    doc.descendants()
        .find(|n| n.has_tag_name("key"))
        .and_then(|n| n.text())
        .map(str::to_string)
        .ok_or_else(|| ApiError::Auth("no key in the keygen answer".into()))
}

pub async fn op(client: &ApiClient, key: &str, command: &str, vsys: Option<&str>) -> Result<ApiOutcome, ApiError> {
    let started = Instant::now();
    let cmd = cmd_xml(command);
    let mut query = vec![("type", "op".to_string()), ("cmd", cmd), ("key", key.to_string())];
    if let Some(v) = vsys {
        query.push(("vsys", v.to_string()));
    }
    let resp = client.client.get(client.url("/api/")).query(&query).send().await.map_err(|e| super::transport(e, &client.pin))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| ApiError::Body(e.to_string()))?;
    let ms = started.elapsed().as_millis() as u64;
    if status == 401 || status == 403 {
        return Err(ApiError::Auth(format!("HTTP {status}")));
    }
    if text.contains("status=\"error\"") || text.contains("status='error'") {
        return Ok(ApiOutcome { status: "unsupported".into(), raw: text, duration_ms: ms, error: Some("the API answered an error".into()), ..Default::default() });
    }
    if status >= 400 {
        return Err(ApiError::Status(status, text.chars().take(200).collect()));
    }
    let rows = rows_from_xml(&text).map_err(ApiError::Body)?;
    Ok(ApiOutcome { status: "ok".into(), rows, raw: text, duration_ms: ms, error: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_become_nested_elements_and_quoted_words_text() {
        assert_eq!(cmd_xml("show system info"), "<show><system><info></info></system></show>");
        assert_eq!(cmd_xml("show interface all"), "<show><interface><all></all></interface></show>");
        assert_eq!(
            cmd_xml(r#"test routing fib-lookup virtual-router "default" ip "192.0.2.1""#),
            "<test><routing><fib-lookup><virtual-router>default</virtual-router><ip>192.0.2.1</ip></fib-lookup></routing></test>"
        );
        assert_eq!(cmd_xml(r#"show vlan "a<b""#), "<show><vlan>a&lt;b</vlan></show>");
    }
}
