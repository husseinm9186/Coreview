//! FortiOS REST: `GET /api/v2/monitor/...` and `/api/v2/cmdb/...` with a
//! bearer token, `?vdom=<name>` for a VDOM. The token is an API user with a
//! read-only profile; the operator makes it, Coreview never can.

use std::time::Instant;

use serde_json::Value;

use super::{ApiClient, ApiError, ApiOutcome};

pub async fn get(client: &ApiClient, token: &str, path: &str, vdom: Option<&str>) -> Result<ApiOutcome, ApiError> {
    let started = Instant::now();
    let mut url = client.url(path);
    if let Some(v) = vdom {
        url.push_str(if url.contains('?') { "&" } else { "?" });
        url.push_str("vdom=");
        url.push_str(v);
    }
    let resp = client.client.get(&url).bearer_auth(token).header("Accept", "application/json").send().await.map_err(|e| super::transport(e, &client.pin))?;
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
    Ok(ApiOutcome { status: "ok".into(), rows: rows_for(path, &body), raw: text, duration_ms: ms, error: None })
}

/// The VDOMs, from `/api/v2/cmdb/system/vdom` in the global scope.
pub async fn vdoms(client: &ApiClient, token: &str) -> Result<Vec<String>, ApiError> {
    let out = get(client, token, "/api/v2/cmdb/system/vdom", None).await?;
    Ok(out.rows.iter().filter_map(|r| r.get("name").and_then(Value::as_str)).map(str::to_string).collect())
}

/// One FortiOS REST reply as rows, the way a collection stores it: the
/// generic reading, and the endpoints whose rows mean something else.
pub fn rows_for(path: &str, body: &Value) -> Vec<Value> {
    let rows = super::rows_from_api_json(body);
    if path.ends_with("/switch-controller/managed-switch/status") {
        return managed_switches_as_neighbours(&rows);
    }
    if path.contains("/monitor/firewall/address-fqdns") {
        return fqdn_rows(body);
    }
    if path.ends_with("/cmdb/firewall/address") {
        return rows.into_iter().zip(body.get("results").and_then(Value::as_array).cloned().unwrap_or_default()).map(|(row, src)| mac_object(row, &src)).collect();
    }
    if path.ends_with("/cmdb/system/sdwan") {
        return sdwan_zones(body.get("results").unwrap_or(body));
    }
    rows
}

/// LT-585: a MAC address object (`type: mac`, `macaddr: [{"macaddr": …}]`,
/// an entry being a MAC or a `from-to` range) as `mac:` items, which the
/// firewall decides against the MAC its ARP has for the source.
fn mac_object(mut row: Value, src: &Value) -> Value {
    if src.get("type").and_then(Value::as_str) != Some("mac") {
        return row;
    }
    let items: Vec<String> = src.get("macaddr").and_then(Value::as_array).into_iter().flatten().filter_map(|m| m.get("macaddr").and_then(Value::as_str)).map(|m| format!("mac:{}", m.trim().to_ascii_lowercase())).collect();
    if let Some(o) = row.as_object_mut() {
        o.remove("macaddr");
        o.insert("member".into(), Value::from(items.join(", ")));
    }
    row
}

/// LT-584: an FQDN address's addresses as the FortiGate resolved them —
/// `results: [{"name": …, "fqdn": …, "addrs": ["a.b.c.d", …]}]`, one object
/// row per address. The list without `mkey` carries only a count, and gives
/// nothing here.
pub fn fqdn_rows(body: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for r in body.get("results").and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = r.get("name").and_then(Value::as_str) else { continue };
        for a in r.get("addrs").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            out.push(serde_json::json!({"name": name, "type": "fqdn", "host": a, "fqdn": r.get("fqdn").cloned().unwrap_or(Value::Null)}));
        }
    }
    out
}

/// The names of the FQDN addresses, from the list form.
pub fn fqdn_names(body: &Value) -> Vec<String> {
    body.get("results").and_then(Value::as_array).into_iter().flatten().filter_map(|r| r.get("name").and_then(Value::as_str)).map(str::to_string).collect()
}

/// A query value, percent-encoded: an object's name may hold spaces.
pub fn query_value(v: &str) -> String {
    v.bytes().map(|b| if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// LT-582: `/cmdb/system/sdwan` as zones — each SD-WAN zone with the member
/// interfaces it holds, as a policy naming the zone means them. The lab's
/// FortiGate answered `members: [{"interface": "wan2", "zone": "virtual-wan-link"}, …]`.
pub fn sdwan_zones(sdwan: &Value) -> Vec<Value> {
    let mut zones: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
    for z in sdwan.get("zone").and_then(Value::as_array).into_iter().flatten() {
        if let Some(n) = z.get("name").and_then(Value::as_str) {
            zones.entry(n.to_string()).or_default();
        }
    }
    for m in sdwan.get("members").and_then(Value::as_array).into_iter().flatten() {
        let (Some(i), Some(z)) = (m.get("interface").and_then(Value::as_str), m.get("zone").and_then(Value::as_str)) else { continue };
        zones.entry(z.to_string()).or_default().push(i.to_string());
    }
    zones.into_iter().filter(|(_, i)| !i.is_empty()).map(|(name, interfaces)| serde_json::json!({"name": name, "interfaces": interfaces.join(", ")})).collect()
}

/// LT-579: `/monitor/switch-controller/managed-switch/status` lists other
/// boxes. A switch connected over FortiLink is a neighbour on the
/// FortiGate's FortiLink interface; one authorised but not connected is
/// nothing on the wire. Field names as the lab's FortiGate 60F (7.6.7)
/// answered; the `Connected` status word is FortiOS's documented one — the
/// lab's switch was `Idle`.
pub fn managed_switches_as_neighbours(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .filter(|r| r.get("status").and_then(Value::as_str).is_some_and(|s| s.eq_ignore_ascii_case("connected")))
        .filter_map(|r| {
            let id = r.get("switch-id").or_else(|| r.get("serial")).and_then(Value::as_str)?;
            let mut out = serde_json::Map::new();
            out.insert("neighbor_name".into(), Value::from(id));
            if let Some(i) = r.get("fgt_peer_intf_name").and_then(Value::as_str).filter(|i| !i.is_empty()) {
                out.insert("local_interface".into(), Value::from(i));
            }
            out.insert("proto".into(), Value::from("fortilink"));
            Some(Value::Object(out))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_fqdn_address_is_what_the_fortigate_resolved_it_to() {
        // The lab's two forms, invented names and documentation addresses.
        let list = json!({"results": [{"name": "Vendor Portal", "fqdn": "portal.example.net", "addrs_count": 2, "wildcard": false}], "status": "success"});
        assert_eq!(fqdn_names(&list), vec!["Vendor Portal"]);
        assert!(fqdn_rows(&list).is_empty(), "the list carries only a count");
        let one = json!({"results": [{"name": "Vendor Portal", "fqdn": "portal.example.net", "addrs": ["203.0.113.80", "203.0.113.81"], "wildcard": false}], "status": "success"});
        let rows = fqdn_rows(&one);
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[1]["name"].as_str(), rows[1]["host"].as_str()), (Some("Vendor Portal"), Some("203.0.113.81")));
        assert_eq!(query_value("Vendor Portal"), "Vendor%20Portal");
    }

    #[test]
    fn a_managed_switch_is_a_neighbour_only_while_connected_and_never_the_fortigate() {
        // The lab's shape, invented serials: one authorised and idle, one connected.
        let rows = vec![
            json!({"status": "Idle", "switch-id": "FSWFAKE0000001", "serial": "FSWFAKE0000001", "fgt_peer_intf_name": "Fortilink", "state": "Authorized", "ports": []}),
            json!({"status": "Connected", "switch-id": "FSWFAKE0000002", "serial": "FSWFAKE0000002", "fgt_peer_intf_name": "Fortilink", "state": "Authorized", "ports": []}),
        ];
        assert_eq!(managed_switches_as_neighbours(&rows), vec![json!({"neighbor_name": "FSWFAKE0000002", "local_interface": "Fortilink", "proto": "fortilink"})]);
    }

    /// The bug as the app met it: the rows go where the catalog says, and a
    /// managed switch's serial must reach no table that identifies the
    /// FortiGate itself.
    #[test]
    fn a_managed_switch_is_stored_as_a_neighbour_not_as_the_fortigates_identity() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/catalog");
        let catalogs = coreview_catalog::load_dir(&dir).unwrap();
        let c = catalogs.iter().find(|c| c.os == "fortios").unwrap().commands.iter().find(|c| c.api.as_deref() == Some("/api/v2/monitor/switch-controller/managed-switch/status")).unwrap();
        let step = coreview_catalog::Step { id: c.id.clone(), cmd: c.cmd.clone(), gate: c.gate.clone(), because: vec![], parser: "api".into(), feeds: c.feeds.clone(), weight: c.weight(), timeout: c.timeout(), verified: c.verified, context: None, scope: None };
        let rows = managed_switches_as_neighbours(&[json!({"status": "Connected", "switch-id": "FSWFAKE0000002", "fgt_peer_intf_name": "Fortilink"})]);
        let stored = crate::tables::rows_for_step(&step, &rows);
        assert!(stored.iter().all(|n| n.table != "device" && n.table != "ha_pair"), "{stored:?}");
        let n = stored.iter().find(|n| n.table == "neighbor").expect("a neighbour row");
        assert_eq!((n.columns.get("rem_sysname").map(String::as_str), n.columns.get("local_if").map(String::as_str)), (Some("FSWFAKE0000002"), Some("Fortilink")));
    }
}
