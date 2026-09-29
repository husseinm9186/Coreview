//! The discovery catalog (LT-512, D-060).
//!
//! One YAML per OS under `resources/catalog/` says how a device of that OS
//! is recognised, how a session with it behaves, which cheap probes set
//! which capability flags, and which read-only commands are then worth
//! sending — each with the parser that reads its answer, the tables it
//! feeds, its weight, and how far it has been verified. This crate loads
//! those files, checks their shape, evaluates the gates, builds the
//! collection plan the operator sees before a run, and holds the read-only
//! allowlist that every command passes before it is sent.
//!
//! It is data and rules only: no SSH, no HTTP, no Tauri. The collector
//! (`coreview-collect`) and the sidecar consume what it produces.

pub mod allowlist;
pub mod gate;
pub mod load;
pub mod plan;
pub mod schema;

pub use allowlist::{verdict, Verdict};
pub use gate::{Facts, Gate};
pub use load::{load_dir, load_str, CatalogError};
pub use plan::{plan, Plan, Skipped, Step};
pub use schema::{Catalog, Command, Parser, Probe, Verified, Weight};
