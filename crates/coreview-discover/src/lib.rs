//! Device discovery and configuration backup.
//!
//! Deliberately free of any Tauri dependency, for the same reason
//! `coreview-probe` is: everything security-critical here — credential
//! handling, command construction, the parsers that decide what to connect to
//! next — is testable with plain `cargo test` and none of the GTK/WebKit stack.
//!
//! The shape of a discovery run is deliberately three separate steps rather
//! than one:
//!
//!   1. **Discover.** Sweep and crawl, collecting everything reachable.
//!   2. **Filter.** Choose what you actually want out of it, by subnet,
//!      device class, name or address.
//!   3. **Build.** Turn what survived into a topology.
//!
//! Keeping them apart is what makes discovery on a real network usable: the
//! first step finds four hundred phones whether you want them or not, and the
//! decision about what to draw should not be buried inside the crawl.

pub mod arp;
pub mod bindings;
pub mod backup;
pub mod capture;
pub mod cdp;
pub mod checks;
pub mod cli;
pub mod compare;
pub mod crawl;
pub mod defaultroute;
pub mod classify;
pub mod counters;
pub mod filter;
pub mod fortios;
pub mod hostkeys;
pub mod interfaces;
/// Who made a device, from its MAC. The table itself lives in
/// `coreview-probe`, because the ping sweep names its hits from it too
/// (LT-121) and this crate is the one that depends on that one.
pub use coreview_probe::oui;
pub mod snmp;
pub mod snmp_topology;
pub mod stacking;
pub mod showcmd;
pub mod ssh;
pub mod lldp;
pub mod etherchannel;
pub mod mac_table;
pub mod pathcheck;
pub mod ptr;
pub mod routes;
pub mod seeds;
pub mod stp;
pub mod uptime;
pub mod vlans;
pub mod walkfile;
#[cfg(test)]
mod parser_properties;
pub mod telnet;
pub mod types;
pub mod vault;

pub use backup::{backup_path, is_inside, safe_component, BackupKind, BackupPathError};
pub use capture::{count_changes, diff, list_captures, run_backups, BackupEvent, BackupOptions, BackupTarget, DiffLine};
pub use cli::{extract_output, find_prompt, looks_like_config, Prompt};
pub use crawl::{crawl, CrawlEvent, CrawlOptions, CrawlResult, CrawledDevice};
pub use interfaces::{addresses_from, parse_ip_interface_brief, Interface};
pub use hostkeys::{changed_key_message, HostKeyStore, HostKeyVerdict};
pub use snmp::{identify, AuthKind, PrivKind, SnmpAuth, SnmpIdentity};
pub use ssh::{Credentials, Device, Secret, SshError, SshOptions, SshProgress};
pub use cdp::{parse_cdp_detail, short_name};
pub use classify::classify;
pub use filter::{count_by_class, DiscoveryFilter};
pub use lldp::parse_lldp_detail;
pub use types::{AddressPreference, DeviceAddress, DeviceClass, Neighbor, Protocol};
pub use vault::{create, open, seal, unlock, SealedSecret, VaultError, VaultHeader, VaultKey};
