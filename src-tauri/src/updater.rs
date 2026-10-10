//! Checking GitHub for a newer Coreview, and installing one.
//!
//! Nothing here runs unless asked. The page sends `check_for_update` when
//! the **Check for updates** button in Settings is pressed, or at start when
//! **Check automatically when Coreview starts** is on — and that setting is
//! off until somebody switches it on. A check is one GET of `latest.json`
//! from the repository's GitHub Releases; it carries this machine's address
//! and the updater's User-Agent, and nothing about the operator, the
//! projects or the estate. An update is downloaded from the same release and
//! refused unless its minisign signature verifies against the public key
//! compiled into this build (`plugins.updater.pubkey` in tauri.conf.json),
//! so a tampered download is never installed.
//!
//! The plugin's own JavaScript API is not used: the page's messages pass the
//! isolation frame, whose table knows these two argument-less commands and
//! refuses `plugin:updater|…` like every other plugin call.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

type CmdResult<T> = Result<T, String>;

/// The release a check found, kept for the install that may follow so the
/// manifest is not fetched twice and what the page showed is what is
/// installed.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

/// What a check found.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// The version running now.
    pub current: String,
    /// The newer release, when there is one.
    pub available: Option<Available>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    pub version: String,
    /// The release's notes, as the manifest carried them.
    pub notes: Option<String>,
    /// When it was published, as an ISO date and time.
    pub date: Option<String>,
}

/// Progress of a download, for the page's bar.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// How long a check or a download may wait on the network before it is
/// called off. A machine on a customer's network often has no route out,
/// and the button should say so rather than hang.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);

/// Asks GitHub whether a newer release exists. Sends exactly one request.
#[tauri::command(async)]
pub async fn check_for_update(app: AppHandle, pending: State<'_, Pending>) -> CmdResult<UpdateCheck> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let updater = app.updater_builder().timeout(NETWORK_TIMEOUT).build().map_err(explain)?;
    let found = updater.check().await.map_err(explain)?;
    let available = found.as_ref().map(|u| Available {
        version: u.version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
        // As the manifest wrote it (RFC 3339), rather than re-spelt.
        date: u.raw_json["pub_date"].as_str().map(str::to_string),
    });
    *pending.0.lock().map_err(|_| "the update's state was poisoned")? = found;
    Ok(UpdateCheck { current, available })
}

/// Downloads the release the last check found, verifies its signature,
/// runs the installer and restarts. On Windows the installer itself closes
/// the app; elsewhere the app relaunches once the bundle is replaced.
#[tauri::command(async)]
pub async fn install_update(app: AppHandle, pending: State<'_, Pending>) -> CmdResult<()> {
    let update = pending
        .0
        .lock()
        .map_err(|_| "the update's state was poisoned")?
        .clone()
        .ok_or("Check for updates first; there is nothing waiting to be installed.")?;
    let window = app.clone();
    let mut downloaded = 0u64;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = window.emit("coreview://update", Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(explain)?;
    // Windows never gets here: the installer took over and exited the
    // process. macOS and Linux have the new files in place and need the
    // new process.
    app.restart();
}

/// The plugin's errors, in words a person at the button can act on.
pub fn explain(e: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Reqwest(err) => format!("Could not reach github.com: {err}"),
        E::Network(why) => format!("Could not reach github.com: {why}"),
        E::ReleaseNotFound => "GitHub has no release manifest to read yet, so there is nothing to compare against.".into(),
        E::TargetNotFound(target) => format!("The newest release has no build for this platform ({target})."),
        E::TargetsNotFound(targets) => format!("The newest release has no build for this platform ({}).", targets.join(", ")),
        E::Minisign(_) | E::SignatureUtf8(_) => {
            "The download's signature does not match Coreview's key, so it was not installed.".into()
        }
        E::Io(err) => format!("The update could not be written to disk: {err}"),
        E::AuthenticationFailed => "The installer was not allowed to run; it needs an administrator's approval.".into(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_updater::Error as E;

    #[test]
    fn a_network_failure_names_the_host_it_could_not_reach() {
        assert_eq!(explain(E::Network("connection refused".into())), "Could not reach github.com: connection refused");
    }

    #[test]
    fn no_manifest_yet_is_said_as_nothing_to_compare_against() {
        assert!(explain(E::ReleaseNotFound).contains("nothing to compare against"));
    }

    #[test]
    fn a_missing_platform_build_names_the_platform() {
        assert_eq!(
            explain(E::TargetNotFound("linux-x86_64".into())),
            "The newest release has no build for this platform (linux-x86_64)."
        );
        assert!(explain(E::TargetsNotFound(vec!["darwin-aarch64".into(), "darwin-universal".into()]))
            .contains("darwin-aarch64, darwin-universal"));
    }

    #[test]
    fn a_bad_signature_says_the_download_was_not_installed() {
        assert!(explain(E::SignatureUtf8("not base64".into())).contains("was not installed"));
    }

    #[test]
    fn what_a_check_found_serialises_for_the_page() {
        let found = UpdateCheck {
            current: "2.9.0".into(),
            available: Some(Available { version: "2.9.1".into(), notes: Some("Fixes.".into()), date: None }),
        };
        let json = serde_json::to_value(&found).unwrap();
        assert_eq!(json["current"], "2.9.0");
        assert_eq!(json["available"]["version"], "2.9.1");
        assert_eq!(json["available"]["notes"], "Fixes.");
        assert!(json["available"]["date"].is_null());
        let none = UpdateCheck { current: "2.9.0".into(), available: None };
        assert!(serde_json::to_value(&none).unwrap()["available"].is_null());
    }

    /// Every TLS client in the app — the HTTPS probe, the Meraki client,
    /// the API collectors, and the updater's own — builds on rustls, which
    /// picks its crypto provider from crate features when exactly one is
    /// enabled and panics at first use when two are. The updater plugin's
    /// default features turn on `ring` beside the workspace's aws-lc-rs,
    /// which is how that happened once; this fails if it happens again.
    #[test]
    fn the_app_has_exactly_one_tls_crypto_provider() {
        let built = std::panic::catch_unwind(rustls::ClientConfig::builder);
        assert!(built.is_ok(), "rustls could not pick a process-level crypto provider");
        let provider = rustls::crypto::CryptoProvider::get_default().expect("a default provider is installed");
        assert_eq!(provider.key_provider.fips(), rustls::crypto::aws_lc_rs::default_provider().key_provider.fips());
    }

    /// The build's own configuration: one endpoint, on GitHub, over TLS,
    /// reading the manifest the release job writes; a public key that is a
    /// minisign key; and no updater artifacts unless the CI overlay asks,
    /// so a build without the signing secret still bundles.
    #[test]
    fn the_configuration_points_at_this_repositorys_releases_over_tls() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
        let updater = &conf["plugins"]["updater"];
        let endpoints = updater["endpoints"].as_array().expect("endpoints");
        assert_eq!(endpoints.len(), 1, "one place to ask, and only one");
        let endpoint = endpoints[0].as_str().unwrap();
        assert_eq!(endpoint, "https://github.com/husseinm9186/Coreview/releases/latest/download/latest.json");
        assert!(updater["dangerousInsecureTransportProtocol"].is_null());
        assert!(updater["dangerousAcceptInvalidCerts"].is_null());
        let pubkey = updater["pubkey"].as_str().expect("pubkey");
        let decoded = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.decode(pubkey).expect("the public key is base64")
        };
        let text = String::from_utf8(decoded).expect("a minisign public key is text");
        assert!(text.starts_with("untrusted comment: minisign public key"), "{text}");
        assert!(conf["bundle"]["createUpdaterArtifacts"].is_null());
        let overlay: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.updater.conf.json")).expect("the overlay parses");
        assert_eq!(overlay["bundle"]["createUpdaterArtifacts"], true);
        assert_eq!(overlay.as_object().unwrap().len(), 2, "the overlay changes nothing but the bundle flag");
    }
}
