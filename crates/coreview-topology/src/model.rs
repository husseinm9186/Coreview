//! What the builder reads and what it writes.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

/// One row of one discovery table, as `collection_db::read_table` returns
/// it: the spec's columns, the command that produced it, and the rest.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Row {
    pub command: String,
    pub columns: BTreeMap<String, String>,
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Row {
    pub fn get(&self, column: &str) -> Option<&str> {
        self.columns.get(column).map(String::as_str).filter(|s| !s.trim().is_empty())
    }
    /// A column's value split into items: a joined list (`a, b`) or a
    /// JSON array kept in `extra`.
    pub fn list(&self, column: &str) -> Vec<String> {
        self.get(column).map(|s| s.split([',', ' ']).map(str::trim).filter(|x| !x.is_empty()).map(str::to_string).collect()).unwrap_or_default()
    }
}

/// One device a collection reached, with its rows by table.
#[derive(Debug, Clone, Default)]
pub struct DeviceIn {
    pub device_id: String,
    /// The address the collection reached it on.
    pub host: String,
    pub os: Option<String>,
    pub role: Option<String>,
    pub prompt: String,
    pub version_text: String,
    pub tables: BTreeMap<String, Vec<Row>>,
}

impl DeviceIn {
    pub fn rows(&self, table: &str) -> &[Row] {
        self.tables.get(table).map(Vec::as_slice).unwrap_or(&[])
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    /// Logged into by the collection.
    Collected,
    /// Named by a neighbour's CDP/LLDP but not collected.
    Neighbor,
    /// A port with many MACs and no neighbour: something unmanaged is there.
    UnknownSwitch,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Member {
    pub id: String,
    pub role: Option<String>,
    pub model: Option<String>,
    pub serial: Option<String>,
    pub mac: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Node {
    pub id: String,
    pub name: String,
    pub kind: NodeKind,
    pub os: Option<String>,
    pub role: Option<String>,
    pub model: Option<String>,
    pub version: Option<String>,
    pub serials: BTreeSet<String>,
    pub macs: BTreeSet<String>,
    /// (ip, interface, prefix length, is management)
    pub addresses: Vec<(String, Option<String>, Option<u8>, bool)>,
    /// The address it was reached on, or advertised.
    pub mgmt_ip: Option<String>,
    /// Stack, VSS/SVL, VSF or virtual chassis: several boxes, one node.
    pub stack_kind: Option<String>,
    pub members: Vec<Member>,
    /// vPC, MLAG or VSX: two nodes that are one pair; the other one's id.
    pub pair: Option<(String, String)>,
    /// Which collected devices this node is (two collections of one box merge).
    pub device_ids: Vec<String>,
    pub platform: Option<String>,
    pub capabilities: Vec<String>,
    /// Its routing table, for the crawl view (Path-Trace reads the newest run).
    pub routes: Vec<NodeRoute>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NodeRoute {
    pub vrf: Option<String>,
    pub prefix: String,
    pub proto: String,
    pub next_hops: Vec<String>,
    pub interface: Option<String>,
    pub ad: Option<u32>,
    pub metric: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum LinkKind {
    Cdp,
    Lldp,
    /// A vendor's own statement: FortiLink, Meraki's topology.
    Api,
    /// A device's MAC learned on a switch port that has no neighbour on it.
    InferredMac,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Evidence {
    /// The collected device whose table said so.
    pub device: String,
    /// The command whose rows it was.
    pub command: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct End {
    pub node: String,
    /// The port in its long form, when anyone said which.
    pub port: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Bundle {
    pub a_name: Option<String>,
    pub b_name: Option<String>,
    /// (a port, b port) for each member cable.
    pub members: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Link {
    pub a: End,
    pub b: End,
    pub kind: LinkKind,
    /// 1.0 both ends said so · 0.7 one end · 0.6 MAC evidence · 0.4 shared subnet only.
    pub confidence: f32,
    /// Both ends reported the adjacency.
    pub both_directions: bool,
    pub bundle: Option<Bundle>,
    pub evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct L3Adjacency {
    pub a: String,
    pub a_if: Option<String>,
    pub b: String,
    pub b_if: Option<String>,
    pub vrf: Option<String>,
    pub subnet: String,
    /// Routing protocols that confirm it (a neighbour in the subnet).
    pub confirmed_by: Vec<String>,
    /// 0.4 on the shared subnet alone, 1.0 when a routing neighbour confirms it.
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Overlay {
    pub a: String,
    pub b: Option<String>,
    pub kind: String,
    pub name: Option<String>,
    pub local_ip: Option<String>,
    pub remote_ip: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Finding {
    pub kind: String,
    pub note: String,
    pub nodes: Vec<String>,
}

/// An endpoint on an access port: one MAC, no neighbour.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Endpoint {
    pub switch: String,
    pub port: String,
    pub mac: String,
    pub ip: Option<String>,
    pub vlan: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub links: Vec<Link>,
    pub l3: Vec<L3Adjacency>,
    pub overlays: Vec<Overlay>,
    pub endpoints: Vec<Endpoint>,
    pub findings: Vec<Finding>,
}

impl Graph {
    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.iter().find(|n| n.id == id)
    }
}
