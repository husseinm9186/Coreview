//! An estate read from the Dashboard, in the shape a crawl produces (LT-411).
//!
//! "we need to discover the meraki the same way we are discovering any other
//! networks" — so this is a *discovery*, not another screen. What it produces
//! is devices and links, and they land on the diagram through the same review
//! and reconcile path a crawl's results do.
//!
//! **It cannot be the crawler, and this is why.** MR, MS and MX have no
//! command line. There is nothing to log into, no `show` to parse, and no
//! neighbour discovery to read — every fact here comes from the Dashboard
//! instead. What is *the same* is the shape: a device with a name, a model, a
//! class, addresses and a serial, and links that something actually reported.
//!
//! **Links come from the estate's own topology**, not from inference. Meraki
//! answers `/networks/{id}/topology/linkLayer` with the links it has observed;
//! a link this cannot see is left undrawn rather than guessed at (D-050).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api::{Device, DeviceKind, Network, Organization};
use crate::Client;

/// One device on the estate, as the Dashboard describes it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoundDevice {
    /// What it is called in the dashboard, or its serial where it has no name.
    pub name: String,
    pub serial: String,
    pub model: Option<String>,
    pub mac: Option<String>,
    /// Its LAN address, where the dashboard reports one.
    pub address: Option<String>,
    /// `appliance`, `switch`, `wireless`, `camera`, `cellular`, `sensor`.
    pub kind: String,
    /// Whether the organisation reports it online.
    pub status: Option<String>,
    pub firmware: Option<String>,
    /// The network it belongs to, so several networks can be read at once.
    pub network: String,
    pub notes: Option<String>,
}

/// A cable the estate itself reports.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoundLink {
    /// The serial at each end, where the node resolves to a device.
    pub from_serial: String,
    pub to_serial: String,
    pub from_port: Option<String>,
    pub to_port: Option<String>,
}

/// What one read of an estate found.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub devices: Vec<FoundDevice>,
    pub links: Vec<FoundLink>,
    /// What could not be read, in words, so a thin result is explained rather
    /// than mistaken for a small estate.
    pub notes: Vec<String>,
}

fn kind_word(kind: DeviceKind) -> &'static str {
    match kind {
        DeviceKind::Appliance => "appliance",
        DeviceKind::Switch => "switch",
        DeviceKind::Wireless => "wireless",
        DeviceKind::Camera => "camera",
        DeviceKind::Cellular => "cellular",
        DeviceKind::Sensor => "sensor",
        DeviceKind::Other => "other",
    }
}

/// The devices of one network, as found devices.
pub fn devices_of(network: &Network, devices: &[Device], status_of: impl Fn(&str) -> Option<String>) -> Vec<FoundDevice> {
    devices
        .iter()
        .map(|d| FoundDevice {
            // A device with no name is still a device; its serial is the only
            // thing it is certain to have, and drawing it as "" would lose it.
            name: d.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| d.serial.clone()),
            serial: d.serial.clone(),
            model: d.model.clone(),
            mac: d.mac.clone(),
            address: d.lan_ip.clone().filter(|a| !a.trim().is_empty()),
            kind: kind_word(d.kind()).to_string(),
            status: status_of(&d.serial),
            firmware: d.firmware.clone(),
            network: network.name.clone(),
            notes: d.notes.clone().filter(|n| !n.trim().is_empty()),
        })
        .collect()
}

/// The links of one network's layer-two topology.
///
/// Meraki describes a link as two `ends`, each with a `node` and a `device`.
/// A node that resolves to no device is a client or something unmanaged: real,
/// but not a device this draws, so the link is dropped rather than drawn to a
/// stub.
pub fn links_of(topology: &Value) -> Vec<FoundLink> {
    let Some(links) = topology.get("links").and_then(|l| l.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for link in links {
        let Some(ends) = link.get("ends").and_then(|e| e.as_array()) else { continue };
        if ends.len() < 2 {
            continue;
        }
        let serial_of = |end: &Value| -> Option<String> {
            end.get("device")
                .and_then(|d| d.get("serial"))
                .and_then(|s| s.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let port_of = |end: &Value| -> Option<String> {
            end.get("discovered")
                .and_then(|d| d.get("lldp").or_else(|| d.get("cdp")))
                .and_then(|p| p.get("portId").or_else(|| p.get("portDescription")))
                .and_then(|p| p.as_str())
                .map(str::to_string)
        };
        let (Some(a), Some(b)) = (serial_of(&ends[0]), serial_of(&ends[1])) else { continue };
        if a == b {
            continue;
        }
        out.push(FoundLink {
            from_serial: a,
            to_serial: b,
            from_port: port_of(&ends[0]),
            to_port: port_of(&ends[1]),
        });
    }
    // The same cable is reported from both ends; one link is one line.
    out.sort_by(|x, y| {
        let key = |l: &FoundLink| {
            let (a, b) = (l.from_serial.clone(), l.to_serial.clone());
            if a <= b { (a, b) } else { (b, a) }
        };
        key(x).cmp(&key(y))
    });
    out.dedup_by(|x, y| {
        let key = |l: &FoundLink| {
            let (a, b) = (l.from_serial.clone(), l.to_serial.clone());
            if a <= b { (a, b) } else { (b, a) }
        };
        key(x) == key(y)
    });
    out
}

impl Client {
    /// Reads one organisation's networks into devices and links.
    ///
    /// One read of the operator's own estate, started by hand. Not a crawl of
    /// Meraki's cloud, and D-056 stands unchanged.
    pub async fn discover(
        &self,
        organization: &Organization,
        networks: &[Network],
        mut progress: impl FnMut(usize, usize, &str),
    ) -> Found {
        let mut found = Found::default();

        // Statuses are organisation-wide and cost one paged read for the lot,
        // rather than one per network.
        let statuses: Vec<Value> = self
            .get_paged(
                &format!("/organizations/{}/devices/statuses", organization.id),
                &[("perPage", "1000".to_string())],
            )
            .await
            .unwrap_or_else(|e| {
                found.notes.push(format!("Device statuses could not be read: {e}"));
                Vec::new()
            });
        let status_of = |serial: &str| -> Option<String> {
            statuses
                .iter()
                .find(|s| s.get("serial").and_then(|v| v.as_str()) == Some(serial))
                .and_then(|s| s.get("status"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        };

        for (i, network) in networks.iter().enumerate() {
            progress(i, networks.len(), &network.name);

            match self.devices(&network.id).await {
                Ok(devices) => found.devices.extend(devices_of(network, &devices, status_of)),
                Err(e) => found.notes.push(format!("{}: devices could not be read: {e}", network.name)),
            }

            match self.get::<Value>(&format!("/networks/{}/topology/linkLayer", network.id), &[]).await {
                Ok(topology) => found.links.extend(links_of(&topology)),
                Err(e) => found
                    .notes
                    .push(format!("{}: the topology could not be read, so its links are not drawn: {e}", network.name)),
            }
        }

        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn network() -> Network {
        Network {
            id: "N_1".into(),
            name: "Site".into(),
            product_types: vec!["switch".into()],
            organization_id: None,
            time_zone: None,
            tags: Vec::new(),
        }
    }

    #[test]
    fn a_device_with_no_name_keeps_its_serial_rather_than_becoming_blank() {
        let devices: Vec<Device> = serde_json::from_value(json!([
            {"serial": "Q1", "model": "MS120-8", "name": "Closet A", "lanIp": "192.0.2.10"},
            {"serial": "Q2", "model": "MR46", "name": "   "},
            {"serial": "Q3", "model": "MX68"}
        ]))
        .expect("devices");
        let found = devices_of(&network(), &devices, |s| (s == "Q1").then(|| "online".to_string()));

        assert_eq!(found[0].name, "Closet A");
        assert_eq!(found[0].kind, "switch");
        assert_eq!(found[0].address.as_deref(), Some("192.0.2.10"));
        assert_eq!(found[0].status.as_deref(), Some("online"));
        // A name of spaces is not a name.
        assert_eq!(found[1].name, "Q2");
        assert_eq!(found[1].kind, "wireless");
        assert_eq!(found[2].name, "Q3");
        assert_eq!(found[2].kind, "appliance");
        // And a device nothing reported on has no status, rather than a guess.
        assert_eq!(found[1].status, None);
    }

    #[test]
    fn a_link_is_drawn_once_even_though_both_ends_report_it() {
        let topology = json!({"links": [
            {"ends": [
                {"device": {"serial": "Q1"}, "discovered": {"lldp": {"portId": "1"}}},
                {"device": {"serial": "Q2"}, "discovered": {"lldp": {"portId": "24"}}}
            ]},
            {"ends": [
                {"device": {"serial": "Q2"}, "discovered": {"lldp": {"portId": "24"}}},
                {"device": {"serial": "Q1"}, "discovered": {"lldp": {"portId": "1"}}}
            ]}
        ]});
        let links = links_of(&topology);
        assert_eq!(links.len(), 1, "one cable is one line: {links:#?}");
        assert_eq!(links[0].from_port.as_deref(), Some("1"));
    }

    #[test]
    fn a_link_to_something_that_is_not_a_device_is_not_drawn() {
        // A client, or anything unmanaged: real, but not a device this draws,
        // and a line to a stub is worse than no line.
        let topology = json!({"links": [
            {"ends": [{"device": {"serial": "Q1"}}, {"node": {"type": "client"}}]},
            {"ends": [{"device": {"serial": "Q1"}}, {"device": {"serial": ""}}]},
            {"ends": [{"device": {"serial": "Q1"}}, {"device": {"serial": "Q1"}}]}
        ]});
        assert!(links_of(&topology).is_empty());
    }

    #[test]
    fn a_topology_that_was_not_returned_is_no_links_rather_than_a_panic() {
        assert!(links_of(&json!({})).is_empty());
        assert!(links_of(&json!({"links": null})).is_empty());
        assert!(links_of(&json!([])).is_empty());
    }
}
