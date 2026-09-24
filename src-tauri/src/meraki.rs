//! The Meraki Dashboard API, from the app (LT-404, LT-405, LT-406; D-056).
//!
//! Meraki MR, MS and MX have no command line, so a crawl can never log into
//! one. This is the only way Coreview sees such an estate from the inside, and
//! D-056's five conditions are what make it allowed: the operator starts it,
//! it is his own account and his own data, it is read-only **by construction**
//! (`coreview-meraki` has no HTTP verb but GET), the key lives in the vault,
//! and it talks to one named host.
//!
//! **The key is an ordinary vault credential**, saved with `save_credential`
//! and kind `meraki`, sealed with everything else. No new storage, no new
//! export path, no new way to leak it — and `list_credential_use` records each
//! time it is opened, the same as an SSH login (LT-264).

use serde::{Deserialize, Serialize};
use tauri::State;

use coreview_meraki::api::{Network, Organization};
use coreview_meraki::{backup, checks, collect, health, Client};

use crate::vault_commands::{db_err, note_use};
use crate::AppState;

type CmdResult<T> = Result<T, String>;

/// The credential kind a Meraki key is saved under.
pub const KIND: &str = "meraki";

/// Opens the API key out of the vault.
///
/// Refuses a credential of any other kind: an SSH password sent to
/// `api.meraki.com` would be a password disclosed to a third party, and "the
/// caller passed the wrong id" is exactly how that would happen.
fn key_of(state: &AppState, credential_id: &str) -> CmdResult<String> {
    let stored = {
        let conn = state.db.lock().map_err(db_err)?;
        crate::db::credential(&conn, credential_id)
            .map_err(db_err)?
            .ok_or("That saved credential no longer exists.")?
    };
    if stored.kind != KIND {
        return Err("That credential is not a Meraki API key.".into());
    }
    let guard = state.vault_key.lock().map_err(db_err)?;
    let key = guard.as_ref().ok_or("The vault is locked.")?;
    crate::vault_commands::open_secret(key, &stored.secret)
}

fn client_for(state: &AppState, credential_id: &str, purpose: &str) -> CmdResult<Client> {
    let key = key_of(state, credential_id)?;
    note_use(state, credential_id, purpose, coreview_meraki::BASE);
    Ok(Client::new(key))
}

/// The organisations this key can see — the customer list.
#[tauri::command]
pub async fn meraki_organizations(
    state: State<'_, AppState>,
    credential_id: String,
) -> CmdResult<Vec<Organization>> {
    let client = client_for(&state, &credential_id, "meraki organisations")?;
    client.organizations().await.map_err(|e| e.to_string())
}

/// The networks in one organisation.
#[tauri::command]
pub async fn meraki_networks(
    state: State<'_, AppState>,
    credential_id: String,
    organization_id: String,
) -> CmdResult<Vec<Network>> {
    let client = client_for(&state, &credential_id, "meraki networks")?;
    client.networks(&organization_id).await.map_err(|e| e.to_string())
}

/// The grading profiles, from Rust rather than written out again in the page.
///
/// A second copy in TypeScript is a second thing to keep in step, and his own
/// script carries a comment about exactly that having drifted.
#[tauri::command]
pub fn meraki_profiles() -> Vec<health::Profile> {
    health::profiles()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupWritten {
    pub path: String,
    pub networks: usize,
    /// Sections read, and sections asked for.
    pub read: usize,
    pub asked: usize,
}

/// Where a Meraki backup is filed: beside the device backups, under the
/// organisation's name, stamped like everything else (LT-151).
fn backup_path(root: &std::path::Path, organization: &str, stamp: &str) -> CmdResult<std::path::PathBuf> {
    let folder = coreview_discover::backup::safe_component(&format!("Meraki {organization}"))
        .ok_or("That organisation name cannot be used as a folder name.")?;
    let file = coreview_discover::backup::safe_component(&format!("{stamp}.json"))
        .ok_or("That timestamp cannot be used as a file name.")?;
    let path = root.join(folder).join(file);
    if !coreview_discover::backup::is_inside(root, &path) {
        return Err("That path is outside the backup folder.".into());
    }
    Ok(path)
}

/// Backs up the chosen networks into the backup folder (LT-405).
#[tauri::command]
pub async fn meraki_backup(
    state: State<'_, AppState>,
    credential_id: String,
    organization_id: String,
    network_ids: Vec<String>,
    stamp: String,
) -> CmdResult<BackupWritten> {
    if network_ids.is_empty() {
        return Err("Choose at least one network to back up.".into());
    }
    let root = {
        let conn = state.db.lock().map_err(db_err)?;
        crate::db::all_settings(&conn).map_err(db_err)?.get("backupFolder").cloned()
    }
    .ok_or("Choose a backup folder before backing anything up.")?;
    let root = std::path::PathBuf::from(root);

    let client = client_for(&state, &credential_id, "meraki backup")?;
    let organizations = client.organizations().await.map_err(|e| e.to_string())?;
    let organization = organizations
        .into_iter()
        .find(|o| o.id == organization_id)
        .ok_or("That organisation is not one this key can see.")?;

    let all = client.networks(&organization_id).await.map_err(|e| e.to_string())?;
    let chosen: Vec<Network> = all.into_iter().filter(|n| network_ids.contains(&n.id)).collect();
    if chosen.is_empty() {
        return Err("None of the chosen networks are in that organisation.".into());
    }

    let taken = client.backup(&organization, &chosen, |_, _, _| {}).await.map_err(|e| e.to_string())?;
    let (read, asked) = taken
        .networks
        .iter()
        .fold((0, 0), |(r, a), n| {
            let (nr, na) = n.read_count();
            (r + nr, a + na)
        });

    let path = backup_path(&root, &organization.name, &stamp)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(&taken).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Could not write {}: {e}", path.display()))?;

    Ok(BackupWritten {
        path: path.display().to_string(),
        networks: taken.networks.len(),
        read,
        asked,
    })
}

/// Whether a Meraki backup of this network is already on disk.
///
/// The one check a standalone script cannot make, and the reason
/// `backup.missing` can be answered honestly instead of guessed.
fn has_backup(root: Option<&std::path::Path>, organization: &str, network: &str) -> Option<bool> {
    let root = root?;
    let folder = coreview_discover::backup::safe_component(&format!("Meraki {organization}"))?;
    let dir = root.join(folder);
    let entries = std::fs::read_dir(&dir).ok()?;
    for entry in entries.flatten() {
        let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
        let Ok(taken) = serde_json::from_str::<backup::Backup>(&text) else { continue };
        if taken.networks.iter().any(|n| n.network.id == network || n.network.name == network) {
            return Some(true);
        }
    }
    Some(false)
}

/// Runs the health check over one network (LT-406).
#[tauri::command]
pub async fn meraki_health_check(
    state: State<'_, AppState>,
    credential_id: String,
    organization_id: String,
    network_id: String,
    profile: Option<String>,
) -> CmdResult<health::Report> {
    let root = {
        let conn = state.db.lock().map_err(db_err)?;
        crate::db::all_settings(&conn).map_err(db_err)?.get("backupFolder").cloned()
    };

    let client = client_for(&state, &credential_id, "meraki health check")?;
    let organization = client
        .organizations()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|o| o.id == organization_id)
        .ok_or("That organisation is not one this key can see.")?;
    let network = client
        .networks(&organization_id)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|n| n.id == network_id)
        .ok_or("That network is not in that organisation.")?;

    let mut collected: collect::Collected = client.collect(&organization, &network, |_| {}).await;
    collected.has_backup = has_backup(root.as_deref().map(std::path::Path::new), &organization.name, &network.id);

    let profile = health::profile(profile.as_deref().unwrap_or(health::DEFAULT_PROFILE));
    Ok(checks::run(&collected, &profile))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_backup_is_filed_under_the_organisation_and_cannot_escape() {
        let root = std::path::Path::new("/backups");
        let path = backup_path(root, "Contoso Ltd", "2026-09-23T101500").expect("path");
        assert!(path.starts_with(root));
        // `safe_component` hyphenates, so the folder is what it makes of it —
        // asserted as it really is rather than as it reads in the source.
        assert!(path.to_string_lossy().contains("Meraki-Contoso-Ltd"), "{}", path.display());

        // An organisation name is a customer's own string and reaches here
        // from the API, not from a list Coreview wrote.
        // A refusal is a fine answer; landing outside the folder is not.
        for hostile in ["../../etc", "..", "/etc/passwd", "a/../../b"] {
            if let Ok(p) = backup_path(root, hostile, "2026-09-23T101500") {
                assert!(p.starts_with(root), "escaped with {hostile:?}: {}", p.display());
            }
        }
        // And the same for the stamp.
        if let Ok(p) = backup_path(root, "Contoso", "../../../evil") {
            assert!(p.starts_with(root), "escaped via the stamp: {}", p.display());
        }
    }

    #[test]
    fn nothing_is_claimed_about_a_backup_when_there_is_nowhere_to_look() {
        // No backup folder chosen: "unknown", which the check reports as
        // "Not reported" rather than raising `backup.missing`.
        assert_eq!(has_backup(None, "Contoso", "N_1"), None);
    }

    #[test]
    fn a_backup_on_disk_is_found_by_network_id_or_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let folder = root.join(
            coreview_discover::backup::safe_component("Meraki Contoso").expect("a usable folder name"),
        );
        std::fs::create_dir_all(&folder).expect("folder");

        let taken = backup::Backup {
            taken_at: "2026-09-23T00:00:00Z".into(),
            taken_by: "Coreview".into(),
            organization: Organization { id: "1".into(), name: "Contoso".into(), url: None },
            networks: vec![backup::NetworkBackup {
                network: Network {
                    id: "N_1".into(),
                    name: "HQ".into(),
                    product_types: vec!["appliance".into()],
                    organization_id: None,
                    time_zone: None,
                    tags: Vec::new(),
                },
                devices: backup::Section::read(Vec::new()),
                vlan_settings: backup::Section::missing("x"),
                vlans: backup::Section::missing("x"),
                l3_firewall_rules: backup::Section::missing("x"),
                ssids: backup::Section::missing("x"),
                switches: Vec::new(),
            }],
            api_key: None,
        };
        std::fs::write(
            folder.join("2026-09-23T000000.json"),
            serde_json::to_string(&taken).expect("json"),
        )
        .expect("write");

        assert_eq!(has_backup(Some(root), "Contoso", "N_1"), Some(true), "by id");
        assert_eq!(has_backup(Some(root), "Contoso", "HQ"), Some(true), "by name");
        assert_eq!(has_backup(Some(root), "Contoso", "N_2"), Some(false), "a network not in it");
        assert_eq!(has_backup(Some(root), "Someone Else", "N_1"), None, "no folder at all");
    }

    #[test]
    fn the_profiles_the_page_offers_come_from_one_place() {
        let from_command = meraki_profiles();
        assert_eq!(from_command.len(), 4);
        assert_eq!(from_command, health::profiles(), "the command must not build its own list");
    }
}
