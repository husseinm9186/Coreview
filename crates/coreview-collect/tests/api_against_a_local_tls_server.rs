//! The API collectors against a local TLS server with
//! two throwaway certificates (made here, never committed). The server
//! answers as an FMC and a FortiGate would, in the shapes of their vendors'
//! API documentation — not captured from the lab. Invented names and
//! documentation addresses; obviously fake secrets.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use base64::Engine as _;
use coreview_collect::api::{run_device, run_fmc, ApiLogin, PinPolicy};
use coreview_collect::tables::normalise_all;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TOKEN: &str = "fake-token-not-a-secret";
const DOMAIN: &str = "d-fake-domain";

fn login() -> ApiLogin {
    ApiLogin { username: "reader".into(), secret: "not-a-real-password".into(), port: None }
}

struct Server {
    port: u16,
    /// Requests that carried a credential (Basic or bearer).
    credentialed: Arc<AtomicUsize>,
}

fn answer(method: &str, path: &str, headers: &BTreeMap<String, String>, port: u16) -> (u16, Vec<(String, String)>, String) {
    let basic = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode("reader:not-a-real-password"));
    let base = format!("/api/fmc_config/v1/domain/{DOMAIN}");
    let items = |v: Value| json!({"items": v, "paging": {"offset": 0, "limit": 1000, "count": 1, "pages": 1}}).to_string();
    if method == "POST" && path == "/api/fmc_platform/v1/auth/generatetoken" {
        return if headers.get("authorization") == Some(&basic) {
            (204, vec![("X-auth-access-token".into(), TOKEN.into()), ("DOMAIN_UUID".into(), DOMAIN.into())], String::new())
        } else {
            (401, vec![], String::new())
        };
    }
    if let Some(rest) = path.strip_prefix(&base) {
        if headers.get("x-auth-access-token").map(String::as_str) != Some(TOKEN) {
            return (401, vec![], String::new());
        }
        let (p, q) = rest.split_once('?').unwrap_or((rest, ""));
        return (
            200,
            vec![],
            match p {
                "/devices/devicerecords" => items(json!([{"id": "dev-9", "name": "OTHER-FTD", "hostName": "198.51.100.9"}, {"id": "dev-1", "name": "FTD1", "hostName": "192.0.2.60"}])),
                "/assignment/policyassignments" => items(json!([{"policy": {"type": "AccessPolicy", "id": "pol-1", "name": "EDGE-POLICY"}, "targets": [{"id": "dev-1", "type": "Device", "name": "FTD1"}]}])),
                "/policy/accesspolicies/pol-1" => json!({"id": "pol-1", "defaultAction": {"action": "BLOCK"}}).to_string(),
                // Two pages, so paging is followed.
                "/policy/accesspolicies/pol-1/accessrules" if !q.contains("offset=1") => json!({
                    "items": [{"name": "web-in", "action": "ALLOW", "enabled": true, "metadata": {"ruleIndex": 1},
                        "sourceZones": {"objects": [{"name": "OUTSIDE"}]}, "destinationZones": {"objects": [{"name": "INSIDE"}]},
                        "destinationNetworks": {"objects": [{"name": "WEB-01"}]}, "destinationPorts": {"objects": [{"name": "HTTPS"}]}}],
                    "paging": {"offset": 0, "limit": 1, "count": 2, "pages": 2, "next": [format!("https://127.0.0.1:{port}{base}/policy/accesspolicies/pol-1/accessrules?expanded=true&limit=1&offset=1")]}
                }).to_string(),
                "/policy/accesspolicies/pol-1/accessrules" => items(json!([{"name": "ssh-admin", "action": "BLOCK", "enabled": true, "metadata": {"ruleIndex": 2},
                    "destinationPorts": {"literals": [{"type": "PortLiteral", "port": "22", "protocol": "6"}]}}])),
                "/devices/devicerecords/dev-1/physicalinterfaces" => items(json!([
                    {"name": "GigabitEthernet0/0", "ifname": "outside", "securityZone": {"name": "OUTSIDE"}},
                    {"name": "GigabitEthernet0/1", "ifname": "inside", "securityZone": {"name": "INSIDE"}}])),
                "/object/networkaddresses" => items(json!([{"name": "WEB-01", "value": "10.9.9.20", "type": "Host"}])),
                "/object/networkgroups" => items(json!([])),
                "/object/protocolportobjects" => items(json!([{"name": "HTTPS", "protocol": "TCP", "port": "443"}])),
                "/object/portobjectgroups" => items(json!([])),
                _ => return (404, vec![], String::new()),
            },
        );
    }
    // FortiOS REST, with a bearer token.
    if path.starts_with("/api/v2/") {
        if headers.get("authorization").map(String::as_str) != Some(&format!("Bearer {}", "not-a-real-password")) {
            return (401, vec![], String::new());
        }
        let p = path.split('?').next().unwrap_or(path);
        return match p {
            "/api/v2/cmdb/system/zone" => (200, vec![], json!({"results": [{"name": "lan", "interface": [{"interface-name": "port2"}]}]}).to_string()),
            // FortiOS answers 424 or 500 for a feature that is off.
            "/api/v2/cmdb/firewall/vip" => (500, vec![], json!({"error": -3}).to_string()),
            "/api/v2/monitor/router/ipv4" => (200, vec![], json!({"results": [{"ip_version": 4, "type": "static", "ip_mask": "0.0.0.0/0", "gateway": "203.0.113.1", "interface": "wan1"}]}).to_string()),
            _ => (404, vec![], String::new()),
        };
    }
    (404, vec![], String::new())
}

async fn start(cert_seed: &str) -> Server {
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = rcgen::CertificateParams::new(vec![format!("{cert_seed}.invalid")]).unwrap().self_signed(&key).unwrap();
    let der = rustls_pki_types::CertificateDer::from(cert.der().to_vec());
    let key_der = rustls_pki_types::PrivateKeyDer::try_from(key.serialize_der()).unwrap();
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider).with_safe_default_protocol_versions().unwrap().with_no_client_auth().with_single_cert(vec![der], key_der).unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let credentialed = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&credentialed);
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            let counter = Arc::clone(&counter);
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(tcp).await else { return };
                let mut buf = Vec::new();
                loop {
                    let mut chunk = [0u8; 4096];
                    let n = match tls.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => n,
                    };
                    buf.extend_from_slice(&chunk[..n]);
                    while let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..end]).to_string();
                        buf.drain(..end + 4);
                        let mut lines = head.lines();
                        let first = lines.next().unwrap_or("");
                        let mut parts = first.split_whitespace();
                        let (method, path) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
                        let headers: BTreeMap<String, String> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
                        if headers.contains_key("authorization") || headers.contains_key("x-auth-access-token") {
                            counter.fetch_add(1, Ordering::SeqCst);
                        }
                        let (status, extra, body) = answer(&method, &path, &headers, port);
                        let mut out = format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\nContent-Type: application/json\r\n", body.len());
                        for (k, v) in extra {
                            out.push_str(&format!("{k}: {v}\r\n"));
                        }
                        out.push_str("\r\n");
                        out.push_str(&body);
                        if tls.write_all(out.as_bytes()).await.is_err() {
                            return;
                        }
                    }
                }
            });
        }
    });
    Server { port, credentialed }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ftds_policy_is_read_from_its_fmc_and_a_changed_certificate_is_refused_before_the_password() {
    let a = start("fmc-a").await;
    let host = format!("127.0.0.1:{}", a.port);
    let names = vec!["192.0.2.60".to_string(), "ftd1".to_string()];
    // First contact: trusted, and the fingerprint recorded.
    let run = run_fmc(&host, &login(), PinPolicy::TrustOnFirstUse, &names).await;
    assert_eq!(run.failure, None, "{:?}", run.log);
    let fp = run.fingerprint.clone().expect("the certificate seen");
    assert_eq!(fp.len(), 64);
    assert!(run.log[0].contains("FTD1 matched, access policy EDGE-POLICY"), "{:?}", run.log);
    let by = |id: &str| run.results.iter().find(|r| r.id == id).unwrap();
    let rules = &by("fmc_access_rules").outcome.rows;
    assert_eq!(rules.len(), 3, "both pages and the default action: {rules:?}");
    assert_eq!(rules[0]["name"], "web-in");
    assert_eq!(rules[1]["service"], "tcp/22");
    assert_eq!((rules[2]["name"].as_str(), rules[2]["action"].as_str()), (Some("default action"), Some("deny")));
    // The rows land in the tables the way a collection writes them.
    let policy = normalise_all(&["fw_policy".to_string()], rules);
    assert_eq!(policy[0].columns.get("src_zones").map(String::as_str), Some("OUTSIDE"));
    assert_eq!(policy[0].columns.get("dst_addr").map(String::as_str), Some("WEB-01"));
    assert_eq!(policy[0].columns.get("services").map(String::as_str), Some("HTTPS"));
    let zones = normalise_all(&["fw_zone".to_string()], &by("fmc_interfaces").outcome.rows);
    assert_eq!(zones[0].columns.get("interfaces").map(String::as_str), Some("GigabitEthernet0/0, outside"));
    let objects = normalise_all(&["fw_object".to_string()], &by("fmc_objects").outcome.rows);
    assert!(objects.iter().any(|o| o.columns.get("name").map(String::as_str) == Some("HTTPS") && o.columns.get("port_start").map(String::as_str) == Some("443")));

    // Pinned to what was seen: accepted again.
    let again = run_fmc(&host, &login(), PinPolicy::Pinned(fp.clone()), &names).await;
    assert_eq!(again.failure, None, "{:?}", again.log);

    // Another certificate at an address pinned to the first: refused, and no credential sent.
    let b = start("fmc-b").await;
    let other = format!("127.0.0.1:{}", b.port);
    let refused = run_fmc(&other, &login(), PinPolicy::Pinned(fp.clone()), &names).await;
    assert_eq!(refused.failure.as_deref(), Some("tls_pin"), "{:?}", refused.log);
    assert!(refused.log.iter().any(|l| l.contains("certificate changed") && l.contains(&fp)), "{:?}", refused.log);
    assert_eq!(b.credentialed.load(Ordering::SeqCst), 0, "a credential reached a server whose certificate changed");

    // A device the FMC does not manage is said, not guessed.
    let missing = run_fmc(&host, &login(), PinPolicy::Pinned(fp), &["192.0.2.99".to_string()]).await;
    assert_eq!(missing.failure.as_deref(), Some("not_found"));
    // A wrong password is an auth failure, not a transport one.
    let wrong = run_fmc(&host, &ApiLogin { username: "reader".into(), secret: "wrong-password-fixture".into(), port: None }, PinPolicy::TrustOnFirstUse, &names).await;
    assert_eq!(wrong.failure.as_deref(), Some("auth"), "{:?}", wrong.log);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fortigates_catalog_api_commands_run_over_rest_with_its_token() {
    let s = start("fortigate").await;
    let catalogs = coreview_catalog::load_dir(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/catalog")).unwrap();
    let fortios = catalogs.iter().find(|c| c.os == "fortios").unwrap();
    let token = ApiLogin { username: String::new(), secret: "not-a-real-password".into(), port: None };
    let run = run_device(fortios, &format!("127.0.0.1:{}", s.port), &token, PinPolicy::TrustOnFirstUse).await;
    assert_eq!(run.failure, None, "{:?}", run.log);
    assert!(run.fingerprint.is_some());
    let zone = run.results.iter().find(|r| r.cmd == "/api/v2/cmdb/system/zone").expect("the zone command was sent");
    assert_eq!(zone.outcome.status, "ok");
    assert_eq!(zone.outcome.rows[0]["name"], "lan");
    // Paths the device does not answer are recorded as such, not fatal.
    assert!(run.results.iter().any(|r| r.outcome.status == "unsupported"));
    // One endpoint's 500 is that endpoint's row; the ones after it are still asked.
    let vip = run.results.iter().find(|r| r.cmd == "/api/v2/cmdb/firewall/vip").expect("the vip endpoint was sent");
    assert_eq!(vip.outcome.status, "error", "{:?}", vip.outcome.error);
    let routes = run.results.iter().find(|r| r.cmd == "/api/v2/monitor/router/ipv4").expect("an endpoint after the failing one was still asked");
    assert_eq!(routes.outcome.status, "ok");
}

/// As a collection runs it: an FTD reached over SSH, then its
/// FMC asked, the answers appended to the device's run as steps with their
/// tables, and the certificate returned to be remembered — then refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_collected_ftd_gets_its_fmc_policy_as_steps_and_its_certificate_remembered() {
    use coreview_collect::api::{collect_for, pin_id};
    use coreview_collect::run::{DeviceRun, Quiet};
    let s = start("fmc-c").await;
    let fmc = format!("127.0.0.1:{}", s.port);
    let catalogs = coreview_catalog::load_dir(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/catalog")).unwrap();
    let ftd = || DeviceRun { host: "192.0.2.60".into(), os: Some("cisco_asa".into()), version_text: "Cisco Firepower Threat Defense for VMware v7.4".into(), prompt: "FTD1#".into(), ..Default::default() };
    let mut run = ftd();
    let first = collect_for(&mut run, &catalogs, &login(), Some(&fmc), |_, _| None, &Quiet).await.expect("a first sight to remember");
    assert_eq!((first.host.as_str(), first.port), (pin_id(&fmc).0.as_str(), s.port));
    assert!(first.host.starts_with("tls:"));
    let steps: Vec<(&str, &str)> = run.results.iter().map(|r| (r.step.id.as_str(), r.step.feeds[0].as_str())).collect();
    assert_eq!(steps, vec![("fmc_access_rules", "fw_policy"), ("fmc_interfaces", "fw_zone"), ("fmc_objects", "fw_object")]);
    assert!(run.log.iter().any(|l| l.contains("seen for the first time")), "{:?}", run.log);
    // Remembered: accepted, nothing new to remember.
    let fp = first.fingerprint.clone();
    let mut again = ftd();
    assert_eq!(collect_for(&mut again, &catalogs, &login(), Some(&fmc), |_, _| Some(fp.clone()), &Quiet).await, None);
    assert_eq!(again.results.len(), 3);
    // Another certificate behind a remembered one: nothing sent, nothing added, said in the log.
    let b = start("fmc-d").await;
    let mut refused = ftd();
    let other = format!("127.0.0.1:{}", b.port);
    assert_eq!(collect_for(&mut refused, &catalogs, &login(), Some(&other), |_, _| Some(fp.clone()), &Quiet).await, None);
    assert!(refused.results.is_empty());
    assert!(refused.log.iter().any(|l| l.contains("the certificate changed; nothing was sent")), "{:?}", refused.log);
    assert_eq!(b.credentialed.load(Ordering::SeqCst), 0);
    // An FTD with no FMC named says so; an IOS switch has no API side at all.
    let mut lone = ftd();
    assert_eq!(collect_for(&mut lone, &catalogs, &login(), None, |_, _| None, &Quiet).await, None);
    assert!(lone.log.iter().any(|l| l.contains("no FMC was named")));
    let mut ios = DeviceRun { host: "192.0.2.1".into(), os: Some("cisco_ios".into()), ..Default::default() };
    assert_eq!(collect_for(&mut ios, &catalogs, &login(), Some(&fmc), |_, _| None, &Quiet).await, None);
    assert!(ios.results.is_empty());
}

/// A FortiGate collected over SSH whose admin HTTPS is not on 443 —
/// the lab's is on 13443. The saved login names the port, and the REST side
/// is reached there and pinned against it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fortigate_whose_api_is_not_on_443_is_reached_on_the_port_its_login_names() {
    use coreview_collect::api::collect_for;
    use coreview_collect::run::{DeviceRun, Quiet};
    let s = start("fortigate-port").await;
    let catalogs = coreview_catalog::load_dir(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/catalog")).unwrap();
    let mut run = DeviceRun { host: "127.0.0.1".into(), os: Some("fortios".into()), ..Default::default() };
    let token = ApiLogin { username: "api-user".into(), secret: "not-a-real-password".into(), port: Some(s.port) };
    let first = collect_for(&mut run, &catalogs, &token, None, |_, _| None, &Quiet).await.expect("reached, and a first sight to remember");
    assert_eq!((first.host.as_str(), first.port), ("tls:127.0.0.1", s.port));
    assert!(run.results.iter().any(|r| r.step.cmd == "/api/v2/cmdb/system/zone" && r.outcome.status == "ok"), "{:?}", run.log);
}
