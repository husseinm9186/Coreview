//! The configuration backup (LT-405).
//!
//! What `meraki-backup.py` collects, endpoint for endpoint: per network, the
//! network itself, its VLAN settings and VLANs, the L3 firewall rules, the
//! SSIDs, and for each MS switch its ports and its routing interfaces.
//!
//! **Read-only, like everything in this crate.** A backup that could restore
//! would need PUT, and [`crate::http`] has no PUT to offer it.
//!
//! **Every part is optional and says so.** A network with no appliance has no
//! VLANs and answers 404; a key without wireless scope is refused on SSIDs.
//! Neither is a failure of the backup — but neither is it the same as "there
//! are none", and a backup that silently wrote an empty list for both would be
//! a backup nobody can trust. Each section records whether it was read, and
//! what was said when it was not (D-050: calculated from evidence, or not
//! calculated).

use serde::{Deserialize, Serialize};

use crate::api::{Device, Network, Organization};
use crate::{Client, Result};

/// One section of a backup: what came back, or why nothing did.
///
/// This is the whole difference between "this network has no firewall rules"
/// and "nobody asked, or the key was refused". They are different facts and a
/// restore plan built on the wrong one is wrong.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Section<T> {
    /// What was read, when it could be.
    pub value: Option<T>,
    /// Why it could not be, in the API's own words.
    pub unavailable: Option<String>,
}

impl<T> Section<T> {
    pub fn read(value: T) -> Section<T> {
        Section { value: Some(value), unavailable: None }
    }

    pub fn missing(why: impl Into<String>) -> Section<T> {
        Section { value: None, unavailable: Some(why.into()) }
    }

    pub fn was_read(&self) -> bool {
        self.value.is_some()
    }
}

/// One MS switch, with the per-device configuration the script collects.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SwitchBackup {
    pub serial: String,
    pub name: Option<String>,
    pub model: Option<String>,
    pub ports: Section<serde_json::Value>,
    pub routing_interfaces: Section<serde_json::Value>,
}

/// Everything held for one network.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkBackup {
    pub network: Network,
    pub devices: Section<Vec<Device>>,
    pub vlan_settings: Section<serde_json::Value>,
    pub vlans: Section<serde_json::Value>,
    pub l3_firewall_rules: Section<serde_json::Value>,
    pub ssids: Section<serde_json::Value>,
    pub switches: Vec<SwitchBackup>,
}

impl NetworkBackup {
    /// How many sections came back with something, and how many were asked
    /// for. What the summary line on screen is built from.
    pub fn read_count(&self) -> (usize, usize) {
        let mut read = 0;
        let mut asked = 0;
        for was in [
            self.devices.was_read(),
            self.vlan_settings.was_read(),
            self.vlans.was_read(),
            self.l3_firewall_rules.was_read(),
            self.ssids.was_read(),
        ] {
            asked += 1;
            read += usize::from(was);
        }
        for s in &self.switches {
            asked += 2;
            read += usize::from(s.ports.was_read()) + usize::from(s.routing_interfaces.was_read());
        }
        (read, asked)
    }
}

/// A whole run: one organisation, the networks chosen from it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    /// When it was taken, ISO 8601 UTC.
    pub taken_at: String,
    /// The version of Coreview that took it.
    pub taken_by: String,
    pub organization: Organization,
    pub networks: Vec<NetworkBackup>,
    /// Never present, and here so that it is obvious it is never present.
    /// A backup file is a thing people email; the key is not in it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

/// A device fan-out cap, the script's own: 30 per network.
///
/// A 200-switch network would otherwise be 400 extra calls at 220ms each —
/// fifteen minutes for one network, most of it after the person gave up.
pub const DEVICE_FANOUT_CAP: usize = 30;

/// Whether a model is an MS switch, the only device kind with per-device
/// configuration worth backing up.
fn is_switch(device: &Device) -> bool {
    device.kind() == crate::api::DeviceKind::Switch
}

impl Client {
    /// Backs up one network.
    ///
    /// Nothing here fails the run: every section is asked for separately and
    /// records its own answer. A network is worth backing up even when half
    /// of it does not apply.
    pub async fn backup_network(&self, network: &Network) -> NetworkBackup {
        let id = &network.id;

        let devices = match self.devices(id).await {
            Ok(d) => Section::read(d),
            Err(e) => Section::missing(e.to_string()),
        };

        // An appliance network has VLANs; one without answers 404, which is an
        // answer about this network, not a fault.
        let vlan_settings = self
            .section(&format!("/networks/{id}/appliance/vlans/settings"), network.has("appliance"), "no appliance in this network")
            .await;
        let vlans = self
            .section(&format!("/networks/{id}/appliance/vlans"), network.has("appliance"), "no appliance in this network")
            .await;
        let l3_firewall_rules = self
            .section(
                &format!("/networks/{id}/appliance/firewall/l3FirewallRules"),
                network.has("appliance"),
                "no appliance in this network",
            )
            .await;
        let ssids = self
            .section(&format!("/networks/{id}/wireless/ssids"), network.has("wireless"), "no wireless in this network")
            .await;

        let mut switches = Vec::new();
        if let Some(list) = devices.value.as_ref() {
            for device in list.iter().filter(|d| is_switch(d)).take(DEVICE_FANOUT_CAP) {
                let serial = &device.serial;
                switches.push(SwitchBackup {
                    serial: serial.clone(),
                    name: device.name.clone(),
                    model: device.model.clone(),
                    ports: self.section(&format!("/devices/{serial}/switch/ports"), true, "").await,
                    routing_interfaces: self
                        .section(&format!("/devices/{serial}/switch/routing/interfaces"), true, "")
                        .await,
                });
            }
        }

        NetworkBackup { network: network.clone(), devices, vlan_settings, vlans, l3_firewall_rules, ssids, switches }
    }

    /// One section, asked for only when the network could have it.
    ///
    /// `applicable` is not an optimisation. Asking a wireless-free network for
    /// its SSIDs earns a 404, and a backup full of 404s reads as broken when
    /// it is merely complete.
    async fn section(&self, path: &str, applicable: bool, why_not: &str) -> Section<serde_json::Value> {
        if !applicable {
            return Section::missing(why_not);
        }
        match self.get::<serde_json::Value>(path, &[]).await {
            Ok(v) => Section::read(v),
            Err(e) => Section::missing(e.to_string()),
        }
    }

    /// Backs up every named network in one organisation.
    pub async fn backup(
        &self,
        organization: &Organization,
        networks: &[Network],
        mut progress: impl FnMut(usize, usize, &str),
    ) -> Result<Backup> {
        let mut out = Vec::with_capacity(networks.len());
        for (i, network) in networks.iter().enumerate() {
            progress(i, networks.len(), &network.name);
            out.push(self.backup_network(network).await);
        }
        Ok(Backup {
            taken_at: crate::now_iso8601(),
            taken_by: concat!("Coreview ", env!("CARGO_PKG_VERSION")).to_string(),
            organization: organization.clone(),
            networks: out,
            api_key: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn network(id: &str, products: &[&str]) -> Network {
        Network {
            id: id.into(),
            name: "Site".into(),
            product_types: products.iter().map(|p| p.to_string()).collect(),
            organization_id: None,
            time_zone: None,
            tags: Vec::new(),
        }
    }

    #[test]
    fn a_section_that_could_not_be_read_says_so_rather_than_looking_empty() {
        let read: Section<Vec<u8>> = Section::read(vec![1, 2]);
        assert!(read.was_read());
        assert_eq!(read.unavailable, None);

        // The distinction the whole type exists for.
        let none: Section<Vec<u8>> = Section::missing("no appliance in this network");
        assert!(!none.was_read());
        assert_eq!(none.value, None);
        assert_eq!(none.unavailable.as_deref(), Some("no appliance in this network"));
    }

    #[test]
    fn the_summary_counts_what_was_read_against_what_was_asked() {
        let backup = NetworkBackup {
            network: network("N_1", &["appliance"]),
            devices: Section::read(Vec::new()),
            vlan_settings: Section::read(serde_json::json!({})),
            vlans: Section::read(serde_json::json!([])),
            l3_firewall_rules: Section::missing("refused"),
            ssids: Section::missing("no wireless in this network"),
            switches: vec![SwitchBackup {
                serial: "Q2XX-XXXX-XXXX".into(),
                name: None,
                model: Some("MS120-8".into()),
                ports: Section::read(serde_json::json!([])),
                routing_interfaces: Section::missing("refused"),
            }],
        };
        // Five network sections plus two per switch.
        assert_eq!(backup.read_count(), (4, 7));
    }

    #[test]
    fn a_backup_file_never_carries_the_key() {
        let backup = Backup {
            taken_at: "2026-09-23T00:00:00Z".into(),
            taken_by: "Coreview".into(),
            organization: Organization { id: "1".into(), name: "Example".into(), url: None },
            networks: Vec::new(),
            api_key: None,
        };
        let json = serde_json::to_string(&backup).expect("serialises");
        assert!(!json.contains("apiKey"), "the field must not even appear: {json}");
    }
}
