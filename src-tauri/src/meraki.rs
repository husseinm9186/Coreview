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
    project_id: String,
) -> CmdResult<BackupWritten> {
    if network_ids.is_empty() {
        return Err("Choose at least one network to back up.".into());
    }
    // LT-413: this project's folder.
    let root = {
        let conn = state.db.lock().map_err(db_err)?;
        crate::db::project_settings(&conn, &project_id).map_err(db_err)?.get("backupFolder").cloned()
    }
    .ok_or("Choose a backup folder for this project before backing anything up.")?;
    let root = std::path::PathBuf::from(root);

    // LT-460: a job like a crawl — listed, counted, and stopped from the
    // jobs header. The three Meraki commands share one slot.
    let ticket = state.jobs.start(crate::jobs::Kind::Meraki)?;
    let token = ticket.token();
    let progress = ticket.progress();
    progress.set("Listing networks", 0, None);
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

    // Stop drops the request in flight; nothing half-written reaches disk,
    // because the file is written only after every network has answered.
    let taken = tokio::select! {
        taken = client.backup(&organization, &chosen, |i, n, name| progress.set(format!("Backing up {name}"), i as u64, Some(n as u64))) => {
            taken.map_err(|e| e.to_string())?
        }
        _ = token.cancelled() => return Err("The Meraki backup was stopped before anything was written.".into()),
    };
    progress.set("Writing", chosen.len() as u64, Some(chosen.len() as u64));
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
    project_id: String,
) -> CmdResult<health::Report> {
    let root = {
        let conn = state.db.lock().map_err(db_err)?;
        crate::db::project_settings(&conn, &project_id).map_err(db_err)?.get("backupFolder").cloned()
    };

    let ticket = state.jobs.start(crate::jobs::Kind::Meraki)?;
    let token = ticket.token();
    let progress = ticket.progress();
    progress.set("Listing networks", 0, None);
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

    let mut collected: collect::Collected = tokio::select! {
        collected = client.collect(&organization, &network, |phase| progress.set(format!("Reading {phase}"), 0, None)) => collected,
        _ = token.cancelled() => return Err("The Meraki health check was stopped.".into()),
    };
    collected.has_backup = has_backup(root.as_deref().map(std::path::Path::new), &organization.name, &network.id);

    let profile = health::profile(profile.as_deref().unwrap_or(health::DEFAULT_PROFILE));
    Ok(checks::run(&collected, &profile))
}

/// Reads a Meraki estate onto the diagram (LT-411).
///
/// "we need to discover the meraki the same way we are discovering any other
/// networks" — so what comes back is a [`CrawlResult`], the same type a crawl
/// returns, and it goes through the same reconcile and review path. Nothing
/// downstream needs to know the devices came from an API rather than a
/// command line.
///
/// Every device is `ReachedBy::Reported`, and that is the honest word for it:
/// **nothing here was logged into.** A Meraki has no command line to log into.
/// Presenting these as reached would claim a verification that did not happen.
#[tauri::command]
pub async fn meraki_discover(
    state: State<'_, AppState>,
    credential_id: String,
    organization_id: String,
    network_ids: Vec<String>,
) -> CmdResult<Discovered> {
    let ticket = state.jobs.start(crate::jobs::Kind::Meraki)?;
    let token = ticket.token();
    let progress = ticket.progress();
    progress.set("Listing networks", 0, None);
    let client = client_for(&state, &credential_id, "meraki discovery")?;
    let organization = client
        .organizations()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|o| o.id == organization_id)
        .ok_or("That organisation is not one this key can see.")?;

    let all = client.networks(&organization_id).await.map_err(|e| e.to_string())?;
    let chosen: Vec<Network> = if network_ids.is_empty() {
        all
    } else {
        all.into_iter().filter(|n| network_ids.contains(&n.id)).collect()
    };
    if chosen.is_empty() {
        return Err("None of the chosen networks are in that organisation.".into());
    }

    let found = tokio::select! {
        found = client.discover(&organization, &chosen, |i, n, name| progress.set(format!("Reading {name}"), i as u64, Some(n as u64))) => found,
        _ = token.cancelled() => return Err("The Meraki discovery was stopped.".into()),
    };
    Ok(as_crawl_result(found))
}

/// What a Meraki discovery hands the page.
///
/// `devices` is exactly what the crawl's review path already consumes, so the
/// diagram merge is shared rather than re-implemented. `notes` says what could
/// not be read, because a thin estate and an unreadable one look identical
/// otherwise.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovered {
    pub devices: Vec<coreview_discover::crawl::CrawledDevice>,
    pub links: usize,
    pub notes: Vec<String>,
}

/// Maps what the Dashboard said into the shape a crawl produces.
///
/// Split out so it can be tested without a key: the mapping is where a
/// discovery would quietly go wrong, not the HTTP.
fn as_crawl_result(found: coreview_meraki::discover::Found) -> Discovered {
    use coreview_discover::crawl::{CrawledDevice, DeviceDetails, ReachedBy};
    use coreview_discover::types::{DeviceAddress, DeviceClass, Neighbor, Protocol};

    let class_of = |kind: &str| match kind {
        "appliance" => DeviceClass::Firewall,
        "switch" => DeviceClass::Switch,
        "wireless" => DeviceClass::AccessPoint,
        "camera" => DeviceClass::Camera,
        _ => DeviceClass::Unknown,
    };

    // Serial to name, so a link can be drawn between the names on the diagram
    // rather than between serials nobody recognises.
    let name_of = |serial: &str| {
        found
            .devices
            .iter()
            .find(|d| d.serial == serial)
            .map(|d| d.name.clone())
            .unwrap_or_else(|| serial.to_string())
    };

    let devices = found
        .devices
        .iter()
        .map(|d| {
            let addresses: Vec<DeviceAddress> = d
                .address
                .iter()
                .map(|ip| DeviceAddress { ip: ip.clone(), interface: None, is_management: true })
                .collect();
            // Its own end of every link the estate reported.
            let neighbors: Vec<Neighbor> = found
                .links
                .iter()
                .filter_map(|l| {
                    let (mine, theirs, my_port, their_port) = if l.from_serial == d.serial {
                        (&l.from_serial, &l.to_serial, &l.from_port, &l.to_port)
                    } else if l.to_serial == d.serial {
                        (&l.to_serial, &l.from_serial, &l.to_port, &l.from_port)
                    } else {
                        return None;
                    };
                    let _ = mine;
                    let device_id = name_of(theirs);
                    Some(Neighbor {
                        short_name: device_id.clone(),
                        device_id,
                        serial: Some(theirs.clone()),
                        addresses: Vec::new(),
                        local_interface: my_port.clone(),
                        remote_interface: their_port.clone(),
                        platform: None,
                        capabilities: Vec::new(),
                        version: None,
                        class: DeviceClass::Unknown,
                        // The estate's own layer-two topology is built from
                        // LLDP and CDP, and saying so is more honest than
                        // inventing a protocol name for it.
                        discovered_by: Protocol::Lldp,
                        vendor: None,
                        chassis_id: None,
                    })
                })
                .collect();

            CrawledDevice {
                hostname: d.name.clone(),
                address: d.address.clone().unwrap_or_default(),
                probe_target: d.address.clone().unwrap_or_default(),
                addresses,
                class: class_of(&d.kind),
                platform: d.model.clone(),
                serial: Some(d.serial.clone()),
                version: d.firmware.clone(),
                neighbors,
                hops: 0,
                // Never logged into, because there is nothing to log into.
                reached_by: ReachedBy::Reported,
                attached: Vec::new(),
                port_channels: Vec::new(),
                default_next_hop: None,
                stack: None,
                details: DeviceDetails::default(),
                dns_name: None,
                // LT-438: the Dashboard's word for every one of these.
                evidence: coreview_discover::types::EvidenceMap::from([
                    ("hostname".to_string(), coreview_discover::types::Evidence::now("meraki:dashboard")),
                    ("class".to_string(), coreview_discover::types::Evidence::now("meraki:dashboard").saying(&d.kind)),
                    ("platform".to_string(), coreview_discover::types::Evidence::now("meraki:dashboard")),
                    ("addresses".to_string(), coreview_discover::types::Evidence::now("meraki:dashboard")),
                    ("serial".to_string(), coreview_discover::types::Evidence::now("meraki:dashboard")),
                ]),
            }
        })
        .collect();

    Discovered { devices, links: found.links.len(), notes: found.notes.clone() }
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

    /// LT-411: the mapping is where a discovery quietly goes wrong — a device
    /// that arrives with no class draws as a grey box, and a link whose ends
    /// do not match a device draws as nothing at all.
    #[test]
    fn an_estate_becomes_devices_and_links_the_diagram_can_use() {
        use coreview_discover::types::DeviceClass;
        use coreview_meraki::discover::{Found, FoundDevice, FoundLink};

        let device = |serial: &str, name: &str, kind: &str, ip: Option<&str>| FoundDevice {
            name: name.into(),
            serial: serial.into(),
            model: Some("MS120-8".into()),
            mac: None,
            address: ip.map(str::to_string),
            kind: kind.into(),
            status: Some("online".into()),
            firmware: Some("MS 15.21".into()),
            network: "Site".into(),
            notes: None,
        };
        let found = Found {
            devices: vec![
                device("Q1", "Core switch", "switch", Some("192.0.2.10")),
                device("Q2", "Front desk AP", "wireless", None),
                device("Q3", "Gateway", "appliance", Some("192.0.2.1")),
            ],
            links: vec![FoundLink {
                from_serial: "Q1".into(),
                to_serial: "Q2".into(),
                from_port: Some("12".into()),
                to_port: Some("wired0".into()),
            }],
            notes: vec!["one network's topology could not be read".into()],
        };

        let out = as_crawl_result(found);
        assert_eq!(out.devices.len(), 3);
        assert_eq!(out.links, 1);
        assert_eq!(out.notes.len(), 1, "what could not be read travels with it");

        // Each kind draws as the right thing rather than a grey box.
        let class = |name: &str| out.devices.iter().find(|d| d.hostname == name).expect(name).class;
        assert_eq!(class("Core switch"), DeviceClass::Switch);
        assert_eq!(class("Front desk AP"), DeviceClass::AccessPoint);
        assert_eq!(class("Gateway"), DeviceClass::Firewall);

        // Nothing was logged into, and it says so.
        assert!(out.devices.iter().all(|d| matches!(d.reached_by, coreview_discover::crawl::ReachedBy::Reported)));

        // The link appears from both ends, named by hostname rather than by a
        // serial nobody recognises, with each end's own port.
        let core = out.devices.iter().find(|d| d.hostname == "Core switch").expect("core");
        assert_eq!(core.neighbors.len(), 1);
        assert_eq!(core.neighbors[0].device_id, "Front desk AP");
        assert_eq!(core.neighbors[0].local_interface.as_deref(), Some("12"));
        assert_eq!(core.neighbors[0].remote_interface.as_deref(), Some("wired0"));

        let ap = out.devices.iter().find(|d| d.hostname == "Front desk AP").expect("ap");
        assert_eq!(ap.neighbors.len(), 1, "a cable is seen from both ends");
        assert_eq!(ap.neighbors[0].device_id, "Core switch");
        assert_eq!(ap.neighbors[0].local_interface.as_deref(), Some("wired0"), "its own port, not the switch's");

        // A device the dashboard gave no address is still a device.
        assert_eq!(ap.address, "");
        assert!(ap.addresses.is_empty());
        assert_eq!(ap.serial.as_deref(), Some("Q2"));

        // And the gateway is on nothing, because nothing reported a link to it.
        let gw = out.devices.iter().find(|d| d.hostname == "Gateway").expect("gw");
        assert!(gw.neighbors.is_empty(), "a link nobody reported is not invented");
    }

    #[test]
    fn the_profiles_the_page_offers_come_from_one_place() {
        let from_command = meraki_profiles();
        assert_eq!(from_command.len(), 4);
        assert_eq!(from_command, health::profiles(), "the command must not build its own list");
    }
}
