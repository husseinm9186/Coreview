//! Everything one network's health check needs, gathered in one pass.
//!
//! The endpoint list is the health-check script's `collect()`, call for call, including the
//! timespans — 24 hours for clients, wireless health and port counters, 7 days
//! for security events and application traffic. Those windows are part of the
//! answer, not a detail: "no security events" over an hour and over a week are
//! different statements.
//!
//! **Nothing here fails the run.** Half these endpoints do not apply to half
//! the networks, and a key may lack a scope. Each field is `Option`, and
//! `None` means *not read* — never *none found*. Every evaluator is written
//! against that distinction, because reporting "no threats blocked" for a
//! network whose security events could not be read is how a report lies.

use serde_json::Value;

use crate::api::{Device, DeviceKind, Network, Organization};
use crate::Client;

/// Per-device reads (switch ports, AP radios) per network.
///
/// The health-check script's cap, for the same reason: a 200-switch network would be
/// 600 extra calls at 220ms, which is twenty minutes, most of it after
/// whoever pressed the button has stopped watching.
pub const DEVICE_FANOUT_CAP: usize = 30;

const DAY: &str = "86400";
const WEEK: &str = "604800";

/// One network's raw answers, as read.
#[derive(Debug, Clone, Default)]
pub struct Collected {
    pub organization: Option<Organization>,
    pub network: Option<Network>,

    /// Devices, each merged with its organisation-wide status row.
    pub devices: Vec<Device>,
    /// `status` per serial, from `/organizations/{id}/devices/statuses`.
    pub statuses: Vec<Value>,
    pub clients: Option<Vec<Value>>,
    pub alert_settings: Option<Value>,
    pub firmware: Option<Value>,
    pub licenses: Option<Value>,
    pub traffic_analysis: Option<Value>,
    pub traffic: Option<Value>,
    pub topology: Option<Value>,

    // ── appliance
    pub uplink_statuses: Option<Vec<Value>>,
    pub loss_and_latency: Option<Value>,
    pub vpn_statuses: Option<Vec<Value>>,
    pub site_to_site_vpn: Option<Value>,
    pub third_party_vpn: Option<Value>,
    pub l3_firewall_rules: Option<Value>,
    pub l7_firewall_rules: Option<Value>,
    pub firewall_settings: Option<Value>,
    pub intrusion: Option<Value>,
    pub malware: Option<Value>,
    pub security_events: Option<Vec<Value>>,
    pub content_filtering: Option<Value>,
    pub vlans: Option<Value>,

    // ── wireless
    pub ssids: Option<Value>,
    pub connection_stats: Option<Value>,
    pub failed_connections: Option<Value>,
    pub latency_stats: Option<Value>,
    pub client_connection_stats: Option<Value>,
    pub signal_quality: Option<Value>,
    pub rf_profiles: Option<Value>,
    pub channel_utilization: Option<Value>,

    // ── switching
    pub stp: Option<Value>,
    pub stacks: Option<Value>,
    /// Per switch serial.
    pub ports: Vec<(String, Value)>,
    pub port_statuses: Vec<(String, Value)>,
    pub routing_interfaces: Vec<(String, Value)>,

    /// Event log, per product type.
    pub events: Vec<(String, Vec<Value>)>,

    /// What could not be read, in words, for the report's own footnotes.
    pub notes: Vec<String>,

    /// Whether Coreview has a Meraki configuration backup for this network.
    /// Filled in by the caller, because only the desktop side knows.
    pub has_backup: Option<bool>,
}

impl Collected {
    pub fn devices_of(&self, kind: DeviceKind) -> Vec<&Device> {
        self.devices.iter().filter(|d| d.kind() == kind).collect()
    }

    /// The status row for a serial, as the organisation reported it.
    pub fn status_of(&self, serial: &str) -> Option<&str> {
        self.statuses
            .iter()
            .find(|s| s.get("serial").and_then(|v| v.as_str()) == Some(serial))
            .and_then(|s| s.get("status"))
            .and_then(|v| v.as_str())
    }

    /// Devices of a kind that are not online. A device with no status at all
    /// is not counted as down — that is a gap in what was read, not a fault.
    pub fn offline(&self, kind: DeviceKind) -> Vec<&Device> {
        self.devices_of(kind)
            .into_iter()
            .filter(|d| self.status_of(&d.serial).is_some_and(|s| !s.eq_ignore_ascii_case("online")))
            .collect()
    }

    /// Only the rows belonging to this network, from an organisation-wide list.
    pub fn for_this_network<'a>(&self, rows: &'a [Value]) -> Vec<&'a Value> {
        let Some(id) = self.network.as_ref().map(|n| n.id.as_str()) else {
            return Vec::new();
        };
        rows.iter().filter(|r| r.get("networkId").and_then(|v| v.as_str()) == Some(id)).collect()
    }

    /// The event log for one product type.
    pub fn events_for(&self, product: &str) -> &[Value] {
        self.events.iter().find(|(p, _)| p == product).map(|(_, e)| e.as_slice()).unwrap_or(&[])
    }
}

impl Client {
    /// One optional read: an answer, or nothing and a note about why.
    async fn maybe(&self, path: &str, query: &[(&str, String)], notes: &mut Vec<String>, label: &str) -> Option<Value> {
        match self.get::<Value>(path, query).await {
            Ok(v) => Some(v),
            Err(e) => {
                notes.push(format!("{label} could not be read: {e}"));
                None
            }
        }
    }

    async fn maybe_paged(&self, path: &str, query: &[(&str, String)], notes: &mut Vec<String>, label: &str) -> Option<Vec<Value>> {
        match self.get_paged::<Value>(path, query).await {
            Ok(v) => Some(v),
            Err(e) => {
                notes.push(format!("{label} could not be read: {e}"));
                None
            }
        }
    }

    /// Gathers everything the checklist needs for one network. Read-only.
    ///
    /// `progress` is called with what is being read, because this makes on the
    /// order of forty calls at 220ms each and a button that does nothing
    /// visible for twenty seconds looks broken.
    pub async fn collect(
        &self,
        organization: &Organization,
        network: &Network,
        mut progress: impl FnMut(&str),
    ) -> Collected {
        let nid = &network.id;
        let oid = &organization.id;
        let (appliance, wireless, switch) =
            (network.has("appliance"), network.has("wireless"), network.has("switch"));
        let mut notes: Vec<String> = Vec::new();
        let day = || vec![("timespan", DAY.to_string())];
        let week = || vec![("timespan", WEEK.to_string())];
        let paged = |extra: Vec<(&'static str, String)>| {
            let mut q = vec![("perPage", "1000".to_string())];
            q.extend(extra);
            q
        };

        progress("devices");
        let devices_raw = self.maybe(&format!("/networks/{nid}/devices"), &[], &mut notes, "devices").await;
        let statuses = self
            .maybe_paged(&format!("/organizations/{oid}/devices/statuses"), &paged(vec![]), &mut notes, "device statuses")
            .await
            .unwrap_or_default();

        let devices: Vec<Device> = devices_raw
            .as_ref()
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        progress("clients");
        let clients = self
            .maybe_paged(&format!("/networks/{nid}/clients"), &paged(day()), &mut notes, "clients")
            .await;

        progress("settings");
        let alert_settings = self.maybe(&format!("/networks/{nid}/alerts/settings"), &[], &mut notes, "alert settings").await;
        let firmware = self.maybe(&format!("/networks/{nid}/firmwareUpgrades"), &[], &mut notes, "firmware").await;
        let licenses = self.maybe(&format!("/organizations/{oid}/licenses/overview"), &[], &mut notes, "licences").await;
        let traffic_analysis = self.maybe(&format!("/networks/{nid}/trafficAnalysis"), &[], &mut notes, "traffic analysis").await;
        let traffic = self.maybe(&format!("/networks/{nid}/traffic"), &week(), &mut notes, "traffic").await;
        let topology = self.maybe(&format!("/networks/{nid}/topology/linkLayer"), &[], &mut notes, "topology").await;

        let mut out = Collected {
            organization: Some(organization.clone()),
            network: Some(network.clone()),
            devices,
            statuses,
            clients,
            alert_settings,
            firmware,
            licenses,
            traffic_analysis,
            traffic,
            topology,
            ..Collected::default()
        };

        if appliance {
            progress("appliance");
            out.uplink_statuses = self
                .maybe_paged(&format!("/organizations/{oid}/appliance/uplink/statuses"), &paged(vec![]), &mut notes, "uplink statuses")
                .await;
            out.loss_and_latency = self
                .maybe(&format!("/organizations/{oid}/devices/uplinksLossAndLatency"), &[("timespan", "300".into())], &mut notes, "loss and latency")
                .await;
            out.vpn_statuses = self
                .maybe_paged(&format!("/organizations/{oid}/appliance/vpn/statuses"), &[("perPage", "300".into())], &mut notes, "VPN statuses")
                .await;
            out.site_to_site_vpn = self.maybe(&format!("/networks/{nid}/appliance/vpn/siteToSiteVpn"), &[], &mut notes, "site-to-site VPN").await;
            out.third_party_vpn = self.maybe(&format!("/organizations/{oid}/appliance/vpn/thirdPartyVPNPeers"), &[], &mut notes, "third-party VPN").await;
            out.l3_firewall_rules = self.maybe(&format!("/networks/{nid}/appliance/firewall/l3FirewallRules"), &[], &mut notes, "L3 firewall rules").await;
            out.l7_firewall_rules = self.maybe(&format!("/networks/{nid}/appliance/firewall/l7FirewallRules"), &[], &mut notes, "L7 firewall rules").await;
            out.firewall_settings = self.maybe(&format!("/networks/{nid}/appliance/firewall/settings"), &[], &mut notes, "firewall settings").await;
            out.intrusion = self.maybe(&format!("/networks/{nid}/appliance/security/intrusion"), &[], &mut notes, "intrusion settings").await;
            out.malware = self.maybe(&format!("/networks/{nid}/appliance/security/malware"), &[], &mut notes, "malware settings").await;
            out.security_events = self
                .maybe_paged(&format!("/networks/{nid}/appliance/security/events"), &paged(week()), &mut notes, "security events")
                .await;
            out.content_filtering = self.maybe(&format!("/networks/{nid}/appliance/contentFiltering"), &[], &mut notes, "content filtering").await;
            out.vlans = self.maybe(&format!("/networks/{nid}/appliance/vlans"), &[], &mut notes, "VLANs").await;
        }

        if wireless {
            progress("wireless");
            out.ssids = self.maybe(&format!("/networks/{nid}/wireless/ssids"), &[], &mut notes, "SSIDs").await;
            out.connection_stats = self.maybe(&format!("/networks/{nid}/wireless/connectionStats"), &day(), &mut notes, "connection stats").await;
            out.failed_connections = self.maybe(&format!("/networks/{nid}/wireless/failedConnections"), &day(), &mut notes, "failed connections").await;
            out.latency_stats = self.maybe(&format!("/networks/{nid}/wireless/latencyStats"), &day(), &mut notes, "latency stats").await;
            out.client_connection_stats = self
                .maybe(&format!("/networks/{nid}/wireless/clients/connectionStats"), &day(), &mut notes, "client connection stats")
                .await;
            // RSSI/SNR over time — what makes the −67 dBm roaming target
            // measurable rather than something the reader has to go and look at.
            out.signal_quality = self
                .maybe(
                    &format!("/networks/{nid}/wireless/signalQualityHistory"),
                    &[("timespan", DAY.into()), ("resolution", "3600".into())],
                    &mut notes,
                    "signal quality",
                )
                .await;
            out.rf_profiles = self.maybe(&format!("/networks/{nid}/wireless/rfProfiles"), &[], &mut notes, "RF profiles").await;
            out.channel_utilization = self
                .maybe(
                    &format!("/networks/{nid}/networkHealth/channelUtilization"),
                    &[("timespan", DAY.into()), ("resolution", "3600".into())],
                    &mut notes,
                    "channel utilisation",
                )
                .await;
        }

        if switch {
            progress("switching");
            out.stp = self.maybe(&format!("/networks/{nid}/switch/stp"), &[], &mut notes, "STP").await;
            out.stacks = self.maybe(&format!("/networks/{nid}/switch/stacks"), &[], &mut notes, "stacks").await;

            let switches: Vec<String> = out.devices_of(DeviceKind::Switch).iter().map(|d| d.serial.clone()).collect();
            let take = switches.len().min(DEVICE_FANOUT_CAP);
            if switches.len() > take {
                notes.push(format!("Port-level data was read for the first {take} of {} switches.", switches.len()));
            }
            for serial in switches.iter().take(take) {
                if let Some(v) = self.maybe(&format!("/devices/{serial}/switch/ports"), &[], &mut notes, "switch ports").await {
                    out.ports.push((serial.clone(), v));
                }
                if let Some(v) = self.maybe(&format!("/devices/{serial}/switch/ports/statuses"), &day(), &mut notes, "port statuses").await {
                    out.port_statuses.push((serial.clone(), v));
                }
                if let Some(v) = self.maybe(&format!("/devices/{serial}/switch/routing/interfaces"), &[], &mut notes, "routing interfaces").await {
                    out.routing_interfaces.push((serial.clone(), v));
                }
            }
        }

        progress("event log");
        for product in ["appliance", "wireless", "switch"] {
            if !network.has(product) {
                continue;
            }
            let mut q = vec![("perPage", "200".to_string())];
            // The API refuses `productType` on a single-product network.
            if network.product_types.len() > 1 {
                q.push(("productType", product.to_string()));
            }
            if let Some(v) = self.maybe(&format!("/networks/{nid}/events"), &q, &mut notes, &format!("{product} events")).await {
                if let Some(list) = v.get("events").and_then(|e| e.as_array()) {
                    out.events.push((product.to_string(), list.clone()));
                }
            }
        }

        out.notes = notes;
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn device(serial: &str, model: &str) -> Device {
        serde_json::from_value(json!({"serial": serial, "model": model})).expect("device")
    }

    fn collected() -> Collected {
        Collected {
            network: Some(Network {
                id: "N_1".into(),
                name: "Site".into(),
                product_types: vec!["appliance".into(), "switch".into()],
                organization_id: None,
                time_zone: None,
                tags: Vec::new(),
            }),
            devices: vec![device("Q1", "MX68"), device("Q2", "MS120-8"), device("Q3", "MR46")],
            statuses: vec![
                json!({"serial": "Q1", "status": "online"}),
                json!({"serial": "Q2", "status": "offline"}),
            ],
            ..Collected::default()
        }
    }

    #[test]
    fn a_device_with_no_status_is_not_counted_as_down() {
        // Q3 has no status row at all. That is a gap in what was read, and
        // calling it an outage would invent a fault.
        let c = collected();
        assert_eq!(c.offline(DeviceKind::Switch).len(), 1, "Q2 is offline");
        assert!(c.offline(DeviceKind::Wireless).is_empty(), "Q3 was never reported on");
        assert!(c.offline(DeviceKind::Appliance).is_empty(), "Q1 is online");
    }

    #[test]
    fn an_organisation_wide_list_is_narrowed_to_this_network() {
        let c = collected();
        let rows = vec![
            json!({"networkId": "N_1", "name": "ours"}),
            json!({"networkId": "N_2", "name": "someone else's"}),
            json!({"name": "no network at all"}),
        ];
        let mine = c.for_this_network(&rows);
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0]["name"], "ours");
    }

    #[test]
    fn devices_are_sorted_by_what_they_are() {
        let c = collected();
        assert_eq!(c.devices_of(DeviceKind::Appliance).len(), 1);
        assert_eq!(c.devices_of(DeviceKind::Switch).len(), 1);
        assert_eq!(c.devices_of(DeviceKind::Wireless).len(), 1);
        assert!(c.devices_of(DeviceKind::Camera).is_empty());
    }
}
