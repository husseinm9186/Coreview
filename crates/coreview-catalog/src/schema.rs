//! The shape of one catalog, as `resources/catalog/schema.json` describes it.
//! Unknown keys on a command or probe are an error, so a typo in a YAML
//! fails `cargo test` rather than silently doing nothing.

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Catalog {
    pub vendor: String,
    pub os: String,
    pub name: String,
    #[serde(default)]
    pub ntc_platform: Option<String>,
    pub phase: u8,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub structured_output: Option<String>,
    /// LT-521: `rust` once this OS's TextFSM parsing has been flipped to the
    /// Rust engine (zero shadow mismatches); absent means the sidecar parses.
    #[serde(default)]
    pub parser_engine: Option<String>,
    #[serde(default)]
    pub fingerprint: Option<Fingerprint>,
    pub session: Session,
    #[serde(default)]
    pub role_hint: Vec<RoleHint>,
    #[serde(default)]
    pub role_defaults: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub caps_probe: Vec<Probe>,
    #[serde(default)]
    pub commands: Vec<Command>,
    #[serde(default)]
    pub live_path: Vec<Command>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Fingerprint {
    pub probe: String,
    pub match_regex: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RoleHint {
    #[serde(rename = "match")]
    pub match_regex: String,
    pub role: String,
}

/// Prompt, privilege and paging behaviour. Only the fields the plan needs
/// are typed; the rest (`paging`, `contexts`, `banner`, …) is kept as YAML
/// for the sidecar, which reads it whole.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Session {
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub prompt_pattern: Option<String>,
    #[serde(default)]
    pub privilege_levels: BTreeMap<String, Privilege>,
    #[serde(default)]
    pub default_privilege: Option<String>,
    #[serde(default)]
    pub failed_when_contains: Vec<String>,
    #[serde(default)]
    pub on_open: Vec<String>,
    #[serde(default)]
    pub contexts: Option<Contexts>,
    #[serde(flatten)]
    pub rest: BTreeMap<String, serde_yaml_ng::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Privilege {
    pub pattern: String,
    #[serde(default)]
    pub escalate: Option<String>,
    #[serde(default)]
    pub escalate_auth: bool,
    #[serde(default)]
    pub escalate_prompt: Option<String>,
    #[serde(default)]
    pub previous: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

/// VDOM / vsys / ASA context switching: how to see whether the device has
/// them, how to list them, and the literal steps in and out.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Contexts {
    pub kind: String,
    pub detect: ContextProbe,
    #[serde(default)]
    pub list: Option<ContextProbe>,
    #[serde(default)]
    pub enter_global: Vec<String>,
    pub enter: Vec<String>,
    pub leave: Vec<String>,
    #[serde(default)]
    pub abort: Vec<String>,
    #[serde(default)]
    pub reprompt: bool,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ContextProbe {
    pub cmd: String,
    #[serde(rename = "match")]
    pub match_regex: String,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Probe {
    pub id: String,
    pub cmd: String,
    #[serde(default)]
    pub gate: Option<String>,
    /// flag → multiline regex over the probe's output
    #[serde(default)]
    pub flags: BTreeMap<String, String>,
    #[serde(default)]
    pub parser: Option<String>,
    pub timeout: u32,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub id: String,
    pub cmd: String,
    pub gate: String,
    #[serde(default)]
    pub foreach: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
    pub parser: String,
    #[serde(default)]
    pub also: Vec<String>,
    #[serde(default)]
    pub shadow: Option<String>,
    #[serde(default)]
    pub api: Option<String>,
    pub feeds: Vec<String>,
    #[serde(default)]
    pub weight: Option<Weight>,
    #[serde(default)]
    pub timeout: Option<u32>,
    pub verified: Verified,
    #[serde(default)]
    pub evidence: Option<String>,
    #[serde(default)]
    pub coreview_reader: bool,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub phase: Option<u8>,
}

impl Command {
    pub fn parser(&self) -> Result<Parser, String> {
        self.parser.parse()
    }
    pub fn weight(&self) -> Weight {
        self.weight.unwrap_or(Weight::Light)
    }
    pub fn timeout(&self) -> u32 {
        self.timeout.unwrap_or(match self.weight() {
            Weight::Light => 30,
            Weight::Heavy => 120,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Weight {
    Light,
    Heavy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verified {
    Lab,
    Docs,
    Unverified,
}

/// How a command's answer is read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parser {
    /// An ntc-templates template by basename, under `resources/templates/ntc/`.
    TextFsm(String),
    /// The platform's own JSON (`| json`, eAPI, REST, `ip -j`).
    Json,
    /// The platform's own XML (`| display xml`, the PAN-OS XML API).
    Xml,
    /// Capability flags from line prefixes; no rows.
    Regex,
    /// Kept scrubbed, never parsed into rows.
    Raw,
    /// Answered by the API collector in Rust, never sent over SSH.
    Api,
    /// Sent and kept; nothing reads it yet (`verified: unverified`).
    None,
    /// A pyATS/genie parser, if one is ever needed (D-060: only for a named gap).
    Genie(String),
    /// One of Coreview's own readers in Rust (`coreview-collect/src/readers`),
    /// for output no template reads (LT-540). The sidecar is sent `none`.
    Reader(String),
}

impl FromStr for Parser {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(match s {
            "json" => Parser::Json,
            "xml" => Parser::Xml,
            "regex" => Parser::Regex,
            "raw" => Parser::Raw,
            "api" => Parser::Api,
            "none" => Parser::None,
            other => {
                if let Some(t) = other.strip_prefix("textfsm:") {
                    Parser::TextFsm(t.to_string())
                } else if let Some(g) = other.strip_prefix("genie:") {
                    Parser::Genie(g.to_string())
                } else if let Some(r) = other.strip_prefix("reader:") {
                    Parser::Reader(r.to_string())
                } else {
                    return Err(format!("{other:?} is not a parser (textfsm:<name> | json | xml | regex | raw | api | none | genie:<name> | reader:<name>)"));
                }
            }
        })
    }
}

impl fmt::Display for Parser {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Parser::TextFsm(t) => write!(f, "textfsm:{t}"),
            Parser::Json => f.write_str("json"),
            Parser::Xml => f.write_str("xml"),
            Parser::Regex => f.write_str("regex"),
            Parser::Raw => f.write_str("raw"),
            Parser::Api => f.write_str("api"),
            Parser::None => f.write_str("none"),
            Parser::Genie(g) => write!(f, "genie:{g}"),
            Parser::Reader(r) => write!(f, "reader:{r}"),
        }
    }
}

/// The tables the spec defines; a command may feed no other.
pub const TABLES: &[&str] = &[
    "device", "interface", "ip_address", "neighbor", "mac_table", "arp", "vlan", "lag", "stp", "vrf", "route", "routing_neighbor", "fhrp",
    "policy_route", "nat_rule", "fw_zone", "fw_policy", "fw_binding", "fw_object", "tunnel", "ha_pair", "ap", "endpoint", "link", "l3_adjacency", "raw_config", "path_probe",
];

/// The capability flags the spec defines, plus the few the catalogs needed.
pub const FLAGS: &[&str] = &[
    "switching", "routing", "vrf", "ospf", "eigrp", "bgp", "isis", "rip", "fhrp", "pbr", "nat", "ipsec", "gre", "dmvpn", "sdwan", "mpls",
    "vxlan_evpn", "stack", "vss_svl", "vpc_mlag_vsx", "vpc", "ha", "fex", "cdp", "lldp", "wlc", "vdom", "vsys", "multi_context",
    "structured_output", "fortilink", "advanced_routing", "l2vpn", "fw_zone", "proxmox",
];
