//! FortiOS REST: `GET /api/v2/monitor/...` and `/api/v2/cmdb/...` with a
//! bearer token, `?vdom=<name>` for a VDOM. The token is an API user with a
//! read-only profile; the operator makes it, Coreview never can.

use std::time::Instant;

use serde_json::Value;

use super::{rows_from_api_json, ApiClient, ApiError, ApiOutcome};

pub async fn get(client: &ApiClient, token: &str, path: &str, vdom: Option<&str>) -> Result<ApiOutcome, ApiError> {
    let started = Instant::now();
    let mut url = client.url(path);
    if let Some(v) = vdom {
        url.push_str(if url.contains('?') { "&" } else { "?" });
        url.push_str("vdom=");
        url.push_str(v);
    }
    let resp = client.client.get(&url).bearer_auth(token).header("Accept", "application/json").send().await.map_err(|e| ApiError::Transport(e.to_string()))?;
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
    Ok(ApiOutcome { status: "ok".into(), rows: rows_from_api_json(&body), raw: text, duration_ms: ms, error: None })
}

/// The VDOMs, from `/api/v2/cmdb/system/vdom` in the global scope.
pub async fn vdoms(client: &ApiClient, token: &str) -> Result<Vec<String>, ApiError> {
    let out = get(client, token, "/api/v2/cmdb/system/vdom", None).await?;
    Ok(out.rows.iter().filter_map(|r| r.get("name").and_then(Value::as_str)).map(str::to_string).collect())
}
