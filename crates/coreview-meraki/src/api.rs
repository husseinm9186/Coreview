//! What the Dashboard answers with, and the calls that ask (LT-404).
//!
//! The field names are from the operator's own scripts, which he has run
//! against the live API — evidence about Meraki, not documentation. Every
//! struct is deliberately partial and every optional field is `Option`: the
//! Dashboard adds fields between releases, and a client that refuses an answer
//! carrying one it has not heard of is a client that breaks on a Tuesday.

use serde::{Deserialize, Serialize};

use crate::{Client, Result};

/// An organisation — a customer, in the operator's words.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Organization {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub url: Option<String>,
}

/// A network inside an organisation. `product_types` is what decides which
/// questions are worth asking of it: a network with no appliance has no
/// firewall rules, and asking anyway is how a run fills with 404s.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub product_types: Vec<String>,
    #[serde(default)]
    pub organization_id: Option<String>,
    #[serde(default)]
    pub time_zone: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

impl Network {
    pub fn has(&self, product: &str) -> bool {
        self.product_types.iter().any(|p| p == product)
    }
}

/// One device in a network.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub serial: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub mac: Option<String>,
    #[serde(default)]
    pub lan_ip: Option<String>,
    #[serde(default)]
    pub network_id: Option<String>,
    #[serde(default)]
    pub firmware: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

impl Device {
    /// What a model number says the device is. The same mapping the operator's
    /// health check uses, because a report and a diagram disagreeing about
    /// what a box is would be worse than either being wrong alone.
    pub fn kind(&self) -> DeviceKind {
        let m = self.model.as_deref().unwrap_or("").to_ascii_uppercase();
        if m.starts_with("MX") || m.starts_with('Z') {
            DeviceKind::Appliance
        } else if m.starts_with("MS") {
            DeviceKind::Switch
        } else if m.starts_with("MR") || m.starts_with("CW") {
            DeviceKind::Wireless
        } else if m.starts_with("MV") {
            DeviceKind::Camera
        } else if m.starts_with("MG") {
            DeviceKind::Cellular
        } else if m.starts_with("MT") {
            DeviceKind::Sensor
        } else {
            DeviceKind::Other
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeviceKind {
    Appliance,
    Switch,
    Wireless,
    Camera,
    Cellular,
    Sensor,
    Other,
}

impl Client {
    /// The organisations this key can see — the customer list.
    pub async fn organizations(&self) -> Result<Vec<Organization>> {
        self.get("/organizations", &[]).await
    }

    /// The networks in one organisation. Paged: a managed-service key can see
    /// hundreds.
    pub async fn networks(&self, organization_id: &str) -> Result<Vec<Network>> {
        self.get_paged(
            &format!("/organizations/{organization_id}/networks"),
            &[("perPage", "1000".to_string())],
        )
        .await
    }

    /// Every device in one network.
    pub async fn devices(&self, network_id: &str) -> Result<Vec<Device>> {
        self.get(&format!("/networks/{network_id}/devices"), &[]).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_with_fields_we_have_never_heard_of_still_reads() {
        // The Dashboard adds fields between releases. Refusing an answer over
        // one is how a client breaks on a Tuesday for no reason.
        let raw = r#"[{"id":"L_1","name":"HQ","productTypes":["appliance","switch"],
                       "somethingAddedLater":{"deep":true},"tags":["lab"]}]"#;
        let nets: Vec<Network> = serde_json::from_str(raw).expect("decodes");
        assert_eq!(nets[0].name, "HQ");
        assert!(nets[0].has("switch") && !nets[0].has("wireless"));
        assert_eq!(nets[0].tags, vec!["lab"]);
    }

    #[test]
    fn a_thin_answer_reads_too() {
        // Half these fields are absent on half the devices.
        let d: Device = serde_json::from_str(r#"{"serial":"Q2XX-XXXX-XXXX"}"#).expect("decodes");
        assert_eq!(d.name, None);
        assert_eq!(d.kind(), DeviceKind::Other);
    }

    #[test]
    fn a_model_number_says_what_a_device_is() {
        let of = |model: &str| {
            serde_json::from_str::<Device>(&format!(r#"{{"serial":"S","model":"{model}"}}"#))
                .expect("decodes")
                .kind()
        };
        assert_eq!(of("MX68"), DeviceKind::Appliance);
        assert_eq!(of("Z3"), DeviceKind::Appliance);
        assert_eq!(of("MS225-48LP"), DeviceKind::Switch);
        assert_eq!(of("MR46"), DeviceKind::Wireless);
        assert_eq!(of("CW9164"), DeviceKind::Wireless, "the Wi-Fi 6E line is still an AP");
        assert_eq!(of("MV12"), DeviceKind::Camera);
        assert_eq!(of("MT10"), DeviceKind::Sensor);
        assert_eq!(of("MG21"), DeviceKind::Cellular);
    }
}
