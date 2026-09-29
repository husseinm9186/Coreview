//! AOS-CX REST v10.x: a login for a session cookie, GETs, a logout. The
//! catalog writes paths as `/rest/v10.xx/...`; `xx` is filled from the
//! version the switch accepts (`v10.13` first, then older).

use std::time::Instant;

use serde_json::Value;

use super::{ApiClient, ApiError, ApiOutcome};
use crate::tables::rows_from_json;

pub const VERSIONS: &[&str] = &["v10.13", "v10.12", "v10.11", "v10.10", "v10.09", "v10.08", "v10.04"];

/// Sign in; returns the API version that accepted the login.
pub async fn login(client: &ApiClient, username: &str, password: &str) -> Result<String, ApiError> {
    let mut last = String::new();
    for v in VERSIONS {
        let resp = client
            .client
            .post(client.url(&format!("/rest/{v}/login")))
            .query(&[("username", username), ("password", password)])
            .send()
            .await
            .map_err(|e| ApiError::Transport(e.to_string()))?;
        let status = resp.status().as_u16();
        if status == 200 {
            return Ok((*v).to_string());
        }
        last = format!("HTTP {status} at /rest/{v}/login");
        if status == 401 || status == 403 {
            return Err(ApiError::Auth(last));
        }
    }
    Err(ApiError::Auth(last))
}

pub async fn logout(client: &ApiClient, version: &str) {
    let _ = client.client.post(client.url(&format!("/rest/{version}/logout"))).send().await;
}

pub async fn get(client: &ApiClient, version: &str, path: &str) -> Result<ApiOutcome, ApiError> {
    let started = Instant::now();
    let path = path.replace("v10.xx", version);
    let mut url = client.url(&path);
    if !url.contains("depth=") {
        url.push_str(if url.contains('?') { "&" } else { "?" });
        url.push_str("depth=2");
    }
    let resp = client.client.get(&url).header("Accept", "application/json").send().await.map_err(|e| ApiError::Transport(e.to_string()))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| ApiError::Body(e.to_string()))?;
    let ms = started.elapsed().as_millis() as u64;
    if status == 401 || status == 403 {
        return Err(ApiError::Auth(format!("HTTP {status}")));
    }
    if status == 404 {
        return Ok(ApiOutcome { status: "unsupported".into(), raw: text, duration_ms: ms, error: Some("HTTP 404".into()), ..Default::default() });
    }
    if status >= 400 {
        return Err(ApiError::Status(status, text.chars().take(200).collect()));
    }
    let body: Value = serde_json::from_str(&text).map_err(|e| ApiError::Body(e.to_string()))?;
    Ok(ApiOutcome { status: "ok".into(), rows: rows_from_json(&body), raw: text, duration_ms: ms, error: None })
}
