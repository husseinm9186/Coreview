//! Cisco FMC REST: an FTD's access policy, read from the FMC that
//! manages it. **Built from Cisco's FMC REST API documentation, not from a
//! capture**; unverified until the operator's FMC answers it.
//!
//! One login — `POST /api/fmc_platform/v1/auth/generatetoken` with HTTP
//! Basic, the documented way to get a token, which answers with the token
//! and the domain in headers — and GETs after it, nothing else:
//!
//! - the device records, to find the FTD the collection reached (by its
//!   address or its name);
//! - the policy assignments, to find the access policy on that device;
//! - that policy (its default action) and its rules, expanded;
//! - the device's physical interfaces, for the zone each is in;
//! - the network and port objects and groups the rules name.
//!
//! What comes back is rows in the collection's own shapes: each enabled rule
//! a `fw_policy` row in rule order (a MONITOR rule logs and does not decide,
//! so it is left out), the default action last; each interface in a zone a
//! `fw_zone` row naming both its interface name and its `nameif`; each object
//! an `fw_object` row. A value the documentation does not promise is left
//! out rather than guessed.

use std::time::Instant;

use serde_json::{json, Value};

use super::{ApiClient, ApiError, ApiOutcome};

pub fn verified_against_hardware() -> bool {
    false
}

/// A signed-in session: the token and the domain the FMC named.
#[derive(Debug, Clone)]
pub struct Session {
    pub token: String,
    pub domain: String,
}

pub async fn login(client: &ApiClient, username: &str, password: &str) -> Result<Session, ApiError> {
    let resp = client
        .client
        .post(client.url("/api/fmc_platform/v1/auth/generatetoken"))
        .basic_auth(username, Some(password))
        .send().await.map_err(|e| super::transport(e, &client.pin))?;
    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err(ApiError::Auth(format!("HTTP {status}")));
    }
    if status >= 400 {
        return Err(ApiError::Status(status, "the token request was refused".into()));
    }
    let header = |name: &str| resp.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let token = header("X-auth-access-token").ok_or_else(|| ApiError::Auth("the FMC gave no access token".into()))?;
    let domain = header("DOMAIN_UUID").ok_or_else(|| ApiError::Auth("the FMC named no domain".into()))?;
    Ok(Session { token, domain })
}

/// Every item of a listing, following `paging.next` (at most 50 pages).
async fn items(client: &ApiClient, s: &Session, path: &str) -> Result<(Vec<Value>, String), ApiError> {
    let mut url = client.url(&format!("/api/fmc_config/v1/domain/{}{path}", s.domain));
    url.push_str(if url.contains('?') { "&" } else { "?" });
    url.push_str("expanded=true&limit=1000");
    let mut out = Vec::new();
    let mut raw = String::new();
    for _ in 0..50 {
        let body = get_json(client, s, &url).await?;
        raw.push_str(&body.to_string());
        raw.push('\n');
        if let Some(list) = body.get("items").and_then(Value::as_array) {
            out.extend(list.iter().cloned());
        }
        match body.pointer("/paging/next/0").and_then(Value::as_str) {
            // Only a page of the same FMC is followed.
            Some(next) if next.starts_with(&client.url("/")) => url = next.to_string(),
            _ => break,
        }
    }
    Ok((out, raw))
}

async fn get_json(client: &ApiClient, s: &Session, url: &str) -> Result<Value, ApiError> {
    let resp = client.client.get(url).header("X-auth-access-token", &s.token).header("Accept", "application/json").send().await.map_err(|e| super::transport(e, &client.pin))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| ApiError::Body(e.to_string()))?;
    if status == 401 || status == 403 {
        return Err(ApiError::Auth(format!("HTTP {status}")));
    }
    if status >= 400 {
        return Err(ApiError::Status(status, text.chars().take(200).collect()));
    }
    serde_json::from_str(&text).map_err(|e| ApiError::Body(e.to_string()))
}

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| match x {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    })
}

fn proto_name(p: &str) -> String {
    match p.trim().to_ascii_uppercase().as_str() {
        "6" | "TCP" => "tcp".into(),
        "17" | "UDP" => "udp".into(),
        "1" | "ICMP" => "icmp".into(),
        other => other.to_ascii_lowercase(),
    }
}

/// `443` → `tcp/443`, `1000-2000` → `tcp/1000-2000`.
fn port_item(protocol: &str, port: Option<String>) -> String {
    match port {
        Some(p) if !p.is_empty() => format!("{}/{}", proto_name(protocol), p),
        _ => proto_name(protocol),
    }
}

/// A rule's `sourceNetworks` (or the like) as one list: object names and literal values.
fn network_list(rule: &Value, key: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(objs) = rule.pointer(&format!("/{key}/objects")).and_then(Value::as_array) {
        out.extend(objs.iter().filter_map(|o| s(o, "name")));
    }
    if let Some(lits) = rule.pointer(&format!("/{key}/literals")).and_then(Value::as_array) {
        out.extend(lits.iter().filter_map(|l| s(l, "value")));
    }
    out
}

fn port_list(rule: &Value, key: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(objs) = rule.pointer(&format!("/{key}/objects")).and_then(Value::as_array) {
        out.extend(objs.iter().filter_map(|o| s(o, "name")));
    }
    if let Some(lits) = rule.pointer(&format!("/{key}/literals")).and_then(Value::as_array) {
        out.extend(lits.iter().filter_map(|l| s(l, "protocol").map(|p| port_item(&p, s(l, "port")))));
    }
    out
}

fn zone_list(rule: &Value, key: &str) -> Vec<String> {
    rule.pointer(&format!("/{key}/objects")).and_then(Value::as_array).map(|a| a.iter().filter_map(|o| s(o, "name")).collect()).unwrap_or_default()
}

fn verdict_word(action: &str) -> Option<&'static str> {
    match action.trim().to_ascii_uppercase().as_str() {
        "ALLOW" | "TRUST" => Some("allow"),
        "BLOCK" | "BLOCK_RESET" | "BLOCK_INTERACTIVE" | "BLOCK_RESET_INTERACTIVE" => Some("deny"),
        // MONITOR logs and lets evaluation go on: it decides nothing.
        _ => None,
    }
}

/// A policy's rules as `fw_policy` rows, then its default action.
pub fn policy_rows(rules: &[Value], default_action: Option<&str>) -> Vec<Value> {
    let mut out = Vec::new();
    let mut last = 0u64;
    for (i, r) in rules.iter().enumerate() {
        let index = r.pointer("/metadata/ruleIndex").and_then(Value::as_u64).unwrap_or(i as u64 + 1);
        last = last.max(index);
        let Some(action) = s(r, "action").as_deref().and_then(verdict_word) else { continue };
        let enabled = r.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        let mut services = port_list(r, "destinationPorts");
        if services.is_empty() {
            services.push("any".into());
        }
        out.push(json!({
            "name": s(r, "name").unwrap_or_default(),
            "seq": index.to_string(),
            "src_zones": zone_list(r, "sourceZones").join(", "),
            "dst_zones": zone_list(r, "destinationZones").join(", "),
            "source": network_list(r, "sourceNetworks").join(", "),
            "destination": network_list(r, "destinationNetworks").join(", "),
            "service": services.join(", "),
            "action": action,
            "enabled": if enabled { "yes" } else { "no" },
        }));
    }
    if let Some(d) = default_action {
        // Anything but a block lets traffic through (trust, or an intrusion policy).
        let action = if verdict_word(d) == Some("deny") { "deny" } else { "allow" };
        out.push(json!({"name": "default action", "seq": (last + 1).to_string(), "source": "any", "destination": "any", "service": "any", "action": action, "enabled": "yes"}));
    }
    out
}

/// Each interface in a security zone, as a zone row naming both its
/// interface name and its `nameif` (the name routes and NAT use).
pub fn zone_rows(interfaces: &[Value]) -> Vec<Value> {
    interfaces
        .iter()
        .filter_map(|i| {
            let zone = i.pointer("/securityZone/name").and_then(Value::as_str)?;
            let mut names: Vec<String> = Vec::new();
            names.extend(s(i, "name"));
            names.extend(s(i, "ifname"));
            (!names.is_empty()).then(|| json!({"name": zone, "interfaces": names.join(", ")}))
        })
        .collect()
}

/// Network and port objects and groups as `fw_object` rows.
pub fn object_rows(addresses: &[Value], net_groups: &[Value], ports: &[Value], port_groups: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for o in addresses {
        if let (Some(name), Some(value)) = (s(o, "name"), s(o, "value")) {
            out.push(json!({"name": name, "host": value}));
        }
    }
    for g in net_groups {
        let Some(name) = s(g, "name") else { continue };
        for m in g.get("objects").and_then(Value::as_array).into_iter().flatten() {
            if let Some(child) = s(m, "name") {
                out.push(json!({"name": name, "member": child}));
            }
        }
        for l in g.get("literals").and_then(Value::as_array).into_iter().flatten() {
            if let Some(value) = s(l, "value") {
                out.push(json!({"name": name, "host": value}));
            }
        }
    }
    for p in ports {
        let (Some(name), Some(protocol)) = (s(p, "name"), s(p, "protocol")) else { continue };
        let row = match s(p, "port") {
            Some(port) => match port.split_once('-') {
                Some((a, z)) => json!({"name": name, "protocol": proto_name(&protocol), "port_op": "range", "port_start": a.trim(), "port_end": z.trim()}),
                None => json!({"name": name, "protocol": proto_name(&protocol), "port_op": "eq", "port_start": port.trim()}),
            },
            None => json!({"name": name, "protocol": proto_name(&protocol)}),
        };
        out.push(row);
    }
    for g in port_groups {
        let Some(name) = s(g, "name") else { continue };
        for m in g.get("objects").and_then(Value::as_array).into_iter().flatten() {
            if let Some(child) = s(m, "name") {
                out.push(json!({"name": name, "member": child}));
            }
        }
    }
    out
}

/// What one FTD's policy came to: the three listings as outcomes, one per
/// table, in the order the collection records them.
#[derive(Debug, Default)]
pub struct DevicePolicy {
    /// The FMC's name for the device it matched.
    pub device: String,
    pub policy: Option<String>,
    pub rules: ApiOutcome,
    pub zones: ApiOutcome,
    pub objects: ApiOutcome,
}

/// Read the access policy of the FTD whose address or name is one of `names`.
pub async fn device_policy(client: &ApiClient, s_: &Session, names: &[String]) -> Result<Option<DevicePolicy>, ApiError> {
    let started = Instant::now();
    let (devices, _) = items(client, s_, "/devices/devicerecords").await?;
    let want: Vec<String> = names.iter().map(|n| n.trim().to_ascii_lowercase()).filter(|n| !n.is_empty()).collect();
    let found = devices.iter().find(|d| ["hostName", "name"].iter().any(|k| s(d, k).map(|v| want.contains(&v.trim().to_ascii_lowercase())).unwrap_or(false)));
    let Some(device) = found else { return Ok(None) };
    let device_id = s(device, "id").unwrap_or_default();
    let mut out = DevicePolicy { device: s(device, "name").unwrap_or_default(), ..Default::default() };
    let (assignments, _) = items(client, s_, "/assignment/policyassignments").await?;
    let policy = assignments.iter().find(|a| {
        a.pointer("/policy/type").and_then(Value::as_str) == Some("AccessPolicy") && a.get("targets").and_then(Value::as_array).map(|t| t.iter().any(|x| s(x, "id").as_deref() == Some(device_id.as_str()))).unwrap_or(false)
    });
    if let Some(p) = policy {
        let id = p.pointer("/policy/id").and_then(Value::as_str).unwrap_or("").to_string();
        out.policy = p.pointer("/policy/name").and_then(Value::as_str).map(str::to_string);
        let head = get_json(client, s_, &client.url(&format!("/api/fmc_config/v1/domain/{}/policy/accesspolicies/{id}", s_.domain))).await?;
        let default_action = head.pointer("/defaultAction/action").and_then(Value::as_str).map(str::to_string);
        let (rules, raw) = items(client, s_, &format!("/policy/accesspolicies/{id}/accessrules")).await?;
        out.rules = ApiOutcome { status: "ok".into(), rows: policy_rows(&rules, default_action.as_deref()), raw, duration_ms: started.elapsed().as_millis() as u64, error: None };
    } else {
        out.rules = ApiOutcome { status: "unsupported".into(), error: Some("no access policy is assigned to this device in the FMC".into()), ..Default::default() };
    }
    let (ifaces, raw) = items(client, s_, &format!("/devices/devicerecords/{device_id}/physicalinterfaces")).await?;
    out.zones = ApiOutcome { status: "ok".into(), rows: zone_rows(&ifaces), raw, duration_ms: started.elapsed().as_millis() as u64, error: None };
    let (addresses, r1) = items(client, s_, "/object/networkaddresses").await?;
    let (groups, r2) = items(client, s_, "/object/networkgroups").await?;
    let (ports, r3) = items(client, s_, "/object/protocolportobjects").await?;
    let (port_groups, r4) = items(client, s_, "/object/portobjectgroups").await?;
    out.objects = ApiOutcome { status: "ok".into(), rows: object_rows(&addresses, &groups, &ports, &port_groups), raw: [r1, r2, r3, r4].concat(), duration_ms: started.elapsed().as_millis() as u64, error: None };
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shapes from Cisco's FMC REST API documentation, not a capture.
    fn rule(name: &str, index: u64, action: &str) -> Value {
        json!({
            "name": name, "action": action, "enabled": true, "metadata": {"ruleIndex": index},
            "sourceZones": {"objects": [{"name": "OUTSIDE", "type": "SecurityZone"}]},
            "destinationZones": {"objects": [{"name": "INSIDE", "type": "SecurityZone"}]},
            "destinationNetworks": {"objects": [{"name": "WEB-SERVERS", "type": "NetworkGroup"}], "literals": [{"type": "Host", "value": "10.9.9.21"}]},
            "destinationPorts": {"objects": [{"name": "HTTPS", "type": "ProtocolPortObject"}], "literals": [{"type": "PortLiteral", "port": "8443", "protocol": "6"}]},
        })
    }

    #[test]
    fn rules_become_policy_rows_in_order_with_the_default_action_last() {
        let rows = policy_rows(&[rule("web-in", 1, "ALLOW"), rule("watch", 2, "MONITOR"), rule("drop-rest", 3, "BLOCK")], Some("BLOCK"));
        assert_eq!(rows.len(), 3, "a monitor rule decides nothing");
        assert_eq!(rows[0]["src_zones"], "OUTSIDE");
        assert_eq!(rows[0]["destination"], "WEB-SERVERS, 10.9.9.21");
        assert_eq!(rows[0]["service"], "HTTPS, tcp/8443");
        assert_eq!(rows[0]["action"], "allow");
        assert_eq!(rows[1]["action"], "deny");
        assert_eq!((rows[2]["name"].as_str(), rows[2]["seq"].as_str(), rows[2]["action"].as_str()), (Some("default action"), Some("4"), Some("deny")));
    }

    #[test]
    fn interfaces_zones_and_objects() {
        let z = zone_rows(&[json!({"name": "GigabitEthernet0/0", "ifname": "outside", "securityZone": {"name": "OUTSIDE"}}), json!({"name": "GigabitEthernet0/2", "ifname": "spare"})]);
        assert_eq!(z, vec![json!({"name": "OUTSIDE", "interfaces": "GigabitEthernet0/0, outside"})]);
        let o = object_rows(
            &[json!({"name": "WEB-01", "value": "10.9.9.20", "type": "Host"})],
            &[json!({"name": "WEB-SERVERS", "objects": [{"name": "WEB-01"}], "literals": [{"type": "Network", "value": "10.9.10.0/24"}]})],
            &[json!({"name": "HTTPS", "protocol": "TCP", "port": "443"}), json!({"name": "HIGH", "protocol": "UDP", "port": "5000-5010"})],
            &[],
        );
        assert_eq!(o[0], json!({"name": "WEB-01", "host": "10.9.9.20"}));
        assert_eq!(o[1], json!({"name": "WEB-SERVERS", "member": "WEB-01"}));
        assert_eq!(o[2], json!({"name": "WEB-SERVERS", "host": "10.9.10.0/24"}));
        assert_eq!(o[3], json!({"name": "HTTPS", "protocol": "tcp", "port_op": "eq", "port_start": "443"}));
        assert_eq!(o[4]["port_op"], "range");
    }
}
