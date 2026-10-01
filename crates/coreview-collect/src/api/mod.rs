//! The API collectors, in Rust from day one (D-060): FortiOS REST, PAN-OS
//! XML API, AOS-CX REST. GET only — or the vendor's read-only equivalent —
//! to the host the operator named, over TLS, with the certificate pinned
//! the way an SSH host key is: the first sight is recorded, every later
//! one must match, and a change is refused before a token is sent again.
//! Meraki stays in `coreview-meraki` (D-056, D-057).

pub mod aoscx;
pub mod fmc;
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


// ------------------------------------------------------------ one device

/// The login an API collector uses: a username and password, or a token
/// alone (FortiOS) with the username blank.
#[derive(Clone)]
pub struct ApiLogin {
    pub username: String,
    pub secret: String,
    /// LT-578: the HTTPS port, where it is not 443 — a FortiGate's
    /// `admin-sport` is often moved when SSL-VPN holds 443.
    pub port: Option<u16>,
}

/// LT-578: where a device's own REST API is, as the client and the pin want it.
pub fn api_host_for(host: &str, port: Option<u16>) -> String {
    match port {
        Some(p) if p != 443 && !host.contains(':') => format!("{host}:{p}"),
        _ => host.to_string(),
    }
}

impl std::fmt::Debug for ApiLogin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiLogin").field("username", &self.username).finish_non_exhaustive()
    }
}

/// One catalog command answered over the API.
#[derive(Debug, Clone)]
pub struct ApiResult {
    pub id: String,
    pub cmd: String,
    pub feeds: Vec<String>,
    pub outcome: ApiOutcome,
}

/// What an API collection of one device came to (LT-518).
#[derive(Debug, Default)]
pub struct ApiRun {
    pub host: String,
    /// The certificate's SHA-256, as presented.
    pub fingerprint: Option<String>,
    pub results: Vec<ApiResult>,
    /// Why it stopped: `tls_pin` (the certificate changed), `auth`, `transport`, `not_found`, `unsupported`.
    pub failure: Option<String>,
    pub log: Vec<String>,
}

/// An error with everything it wraps, so a certificate refusal deep inside
/// the TLS stack is visible in the sentence.
fn chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut out = e.to_string();
    let mut cur = e.source();
    while let Some(s) = cur {
        let t = s.to_string();
        if !out.contains(&t) {
            out.push_str(": ");
            out.push_str(&t);
        }
        cur = s.source();
    }
    out
}

impl ApiRun {
    fn fail(&mut self, e: ApiError) {
        let text = e.to_string();
        self.failure = Some(match e {
            ApiError::Auth(_) => "auth",
            ApiError::PinMismatch { .. } => "tls_pin",
            _ if text.contains("certificate changed") => "tls_pin",
            _ => "transport",
        }.to_string());
        self.log.push(text);
    }
}

/// Send a request, turning a refused certificate into the error that says so.
pub(crate) fn transport(e: reqwest::Error, pin: &CertPin) -> ApiError {
    let text = chain(&e);
    if let (Some(pos), PinPolicy::Pinned(was)) = (text.find("presented "), &pin.policy_ref()) {
        let now = text[pos + "presented ".len()..].split([' ', ':', ')']).next().unwrap_or("").to_string();
        return ApiError::PinMismatch { was: was.clone(), now };
    }
    ApiError::Transport(text)
}

/// The catalog's `parser: api` commands whose path needs nothing the
/// collection does not know.
fn api_commands(catalog: &coreview_catalog::Catalog) -> Vec<&coreview_catalog::Command> {
    // LT-636: one request per endpoint — a `show` command's REST alternate
    // and the API-only entry for the same path are the same request.
    let mut seen = std::collections::BTreeSet::new();
    catalog.commands.iter().filter(|c| c.parser == "api" && c.api.as_deref().map(|p| !p.contains('{')).unwrap_or(false)).filter(|c| seen.insert(c.api.clone().unwrap_or_default())).collect()
}

/// FortiOS REST or AOS-CX REST on the device itself (LT-518). The
/// certificate is checked before the token or password is sent: a pinned
/// fingerprint that does not match stops here.
pub async fn run_device(catalog: &coreview_catalog::Catalog, host: &str, login: &ApiLogin, pin: PinPolicy) -> ApiRun {
    let mut run = ApiRun { host: host.to_string(), ..Default::default() };
    let client = match ApiClient::new(host, pin, 30) {
        Ok(c) => c,
        Err(e) => {
            run.fail(e);
            return run;
        }
    };
    let commands = api_commands(catalog);
    if commands.is_empty() {
        run.failure = Some("unsupported".into());
        run.log.push(format!("the {} catalog names no API command", catalog.os));
        return run;
    }
    match catalog.os.as_str() {
        "fortios" => {
            for c in commands {
                let path = c.api.clone().unwrap_or_default();
                // LT-584: the FQDN list names the objects; each is asked by name for its addresses.
                let got = if path.ends_with("/monitor/firewall/address-fqdns") {
                    fqdn_addresses(&client, &login.secret, &path).await
                } else {
                    fortios::get(&client, &login.secret, &path, None).await
                };
                match got {
                    Ok(o) => run.results.push(ApiResult { id: c.id.clone(), cmd: path, feeds: c.feeds.clone(), outcome: o }),
                    // A refused token or a changed certificate stops the phase;
                    // LT-610: anything else is that endpoint's own error, and
                    // the endpoints after it are still asked.
                    Err(e @ (ApiError::Auth(_) | ApiError::PinMismatch { .. } | ApiError::Tls(_))) => {
                        run.fail(e);
                        break;
                    }
                    Err(e) => {
                        run.log.push(format!("{path}: {e}"));
                        run.results.push(ApiResult { id: c.id.clone(), cmd: path, feeds: c.feeds.clone(), outcome: ApiOutcome { status: "error".into(), error: Some(e.to_string()), ..Default::default() } });
                    }
                }
            }
        }
        "aoscx" => match aoscx::login(&client, &login.username, &login.secret).await {
            Ok(version) => {
                for c in commands {
                    let path = c.api.clone().unwrap_or_default();
                    match aoscx::get(&client, &version, &path).await {
                        Ok(o) => run.results.push(ApiResult { id: c.id.clone(), cmd: path.replace("v10.xx", &version), feeds: c.feeds.clone(), outcome: o }),
                        Err(e) => {
                            run.fail(e);
                            break;
                        }
                    }
                }
                aoscx::logout(&client, &version).await;
            }
            Err(e) => run.fail(e),
        },
        other => {
            run.failure = Some("unsupported".into());
            run.log.push(format!("no API collector for {other} yet"));
        }
    }
    run.fingerprint = client.seen();
    run
}

/// An FTD's access policy from the FMC that manages it (LT-541), matched by
/// any of `names` (the address the collection reached it on, its hostname).
pub async fn run_fmc(fmc_host: &str, login: &ApiLogin, pin: PinPolicy, names: &[String]) -> ApiRun {
    let mut run = ApiRun { host: fmc_host.to_string(), ..Default::default() };
    let client = match ApiClient::new(fmc_host, pin, 60) {
        Ok(c) => c,
        Err(e) => {
            run.fail(e);
            return run;
        }
    };
    match fmc::login(&client, &login.username, &login.secret).await {
        Ok(session) => match fmc::device_policy(&client, &session, names).await {
            Ok(Some(p)) => {
                run.log.push(format!("FMC {fmc_host}: {} matched, access policy {}", p.device, p.policy.clone().unwrap_or_else(|| "none".into())));
                run.results.push(ApiResult { id: "fmc_access_rules".into(), cmd: "FMC access policy rules".into(), feeds: vec!["fw_policy".into()], outcome: p.rules });
                run.results.push(ApiResult { id: "fmc_interfaces".into(), cmd: "FMC device interfaces".into(), feeds: vec!["fw_zone".into()], outcome: p.zones });
                run.results.push(ApiResult { id: "fmc_objects".into(), cmd: "FMC network and port objects".into(), feeds: vec!["fw_object".into()], outcome: p.objects });
            }
            Ok(None) => {
                run.failure = Some("not_found".into());
                run.log.push(format!("FMC {fmc_host} manages no device named {}", names.join(" or ")));
            }
            Err(e) => run.fail(e),
        },
        Err(e) => run.fail(e),
    }
    run.fingerprint = client.seen();
    run
}


// ---------------------------------------------------------- in a collection

/// What the API phase of one device asks the caller to remember: the pin
/// identity (`tls:<host>`, port) and the fingerprint seen for the first time.
#[derive(Debug, Clone, PartialEq)]
pub struct FirstSight {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
}

/// The identity a REST certificate is pinned against, kept apart from SSH
/// host keys by the prefix.
pub fn pin_id(host: &str) -> (String, u16) {
    match host.rsplit_once(':').and_then(|(h, p)| p.parse::<u16>().ok().map(|p| (h.to_string(), p))) {
        Some((h, p)) if !h.contains(':') => (format!("tls:{h}"), p),
        _ => (format!("tls:{host}"), 443),
    }
}

/// LT-584: every FQDN address's addresses, one GET per object.
async fn fqdn_addresses(client: &ApiClient, token: &str, path: &str) -> Result<ApiOutcome, ApiError> {
    let list = fortios::get(client, token, path, None).await?;
    if list.status != "ok" {
        return Ok(list);
    }
    let body: serde_json::Value = serde_json::from_str(&list.raw).unwrap_or_default();
    let mut out = ApiOutcome { status: "ok".into(), raw: list.raw.clone(), duration_ms: list.duration_ms, ..Default::default() };
    for name in fortios::fqdn_names(&body) {
        // LT-610: one object's error is noted; the others are still asked.
        let one = match fortios::get(client, token, &format!("{path}?mkey={}", fortios::query_value(&name)), None).await {
            Ok(one) => one,
            Err(e @ (ApiError::Auth(_) | ApiError::PinMismatch { .. } | ApiError::Tls(_))) => return Err(e),
            Err(e) => {
                out.error = Some(format!("{}{name}: {e}", out.error.as_deref().map(|x| format!("{x}; ")).unwrap_or_default()));
                continue;
            }
        };
        out.duration_ms += one.duration_ms;
        out.rows.extend(one.rows);
        out.raw.push('\n');
        out.raw.push_str(&one.raw);
    }
    Ok(out)
}

/// LT-518 / LT-541: after a device's SSH collection, its REST side — the
/// device's own API (FortiOS, AOS-CX), or for an FTD the FMC that manages
/// it — appended to the run as steps, so its rows are stored like any
/// other. `known` is what the caller's store remembers for the host's pin
/// identity (`pin_id`); a different certificate stops the call before the
/// login is sent. Returns a first sight for the caller to remember.
pub async fn collect_for(run: &mut crate::run::DeviceRun, catalogs: &[coreview_catalog::Catalog], login: &ApiLogin, fmc_host: Option<&str>, known: impl Fn(&str, u16) -> Option<String>, sink: &dyn crate::run::RunSink) -> Option<FirstSight> {
    let os = run.os.clone()?;
    let catalog = catalogs.iter().find(|c| c.os == os)?;
    let is_ftd = os == "cisco_asa" && run.version_text.contains("Firepower Threat Defense");
    let target: Option<String> = if is_ftd {
        fmc_host.map(str::to_string)
    } else if matches!(os.as_str(), "fortios" | "aoscx") {
        Some(api_host_for(&run.host, login.port))
    } else {
        None
    };
    let Some(api_host) = target else {
        if is_ftd {
            run.log.push("an FTD: its policy is read from its FMC, and no FMC was named".into());
        }
        return None;
    };
    let (pin_host, pin_port) = pin_id(&api_host);
    let remembered = known(&pin_host, pin_port);
    let policy = remembered.clone().map(PinPolicy::Pinned).unwrap_or(PinPolicy::TrustOnFirstUse);
    let api = if is_ftd {
        let name = run.prompt.trim().trim_end_matches(['#', '>', ' ']).to_string();
        let names: Vec<String> = [run.host.clone(), name].into_iter().filter(|n| !n.is_empty()).collect();
        run_fmc(&api_host, login, policy, &names).await
    } else {
        run_device(catalog, &api_host, login, policy).await
    };
    run.log.extend(api.log.iter().map(|l| format!("API {api_host}: {l}")));
    let mut first = None;
    match (&api.failure, &api.fingerprint, &remembered) {
        (Some(f), _, _) if f == "tls_pin" => run.log.push(format!("API {api_host}: the certificate changed; nothing was sent. If the device was replaced, forget its key in Settings and collect again.")),
        (_, Some(fp), None) => {
            run.log.push(format!("API {api_host}: certificate SHA-256 {fp} seen for the first time and now remembered"));
            first = Some(FirstSight { host: pin_host, port: pin_port, fingerprint: fp.clone() });
        }
        (_, Some(fp), Some(_)) => run.log.push(format!("API {api_host}: certificate SHA-256 {fp}, as remembered")),
        _ => {}
    }
    for r in api.results {
        let step = coreview_catalog::Step {
            id: r.id,
            cmd: r.cmd,
            gate: "api".into(),
            because: vec![],
            parser: "api".into(),
            feeds: r.feeds,
            weight: coreview_catalog::Weight::Light,
            timeout: 60,
            verified: coreview_catalog::Verified::Docs,
            context: None,
            scope: None,
        };
        let outcome = crate::run::CommandOutcome { status: r.outcome.status, rows: r.outcome.rows, raw: r.outcome.raw, duration_ms: r.outcome.duration_ms, error: r.outcome.error, shadow: None, engine: Some("api".into()) };
        let sr = crate::run::StepResult { step, outcome };
        sink.event(crate::run::RunEvent::Step(&sr));
        run.results.push(sr);
    }
    first
}
