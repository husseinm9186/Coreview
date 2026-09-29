//! The catalog-driven collector (D-060 Phase 1, LT-514).
//!
//! For one device: open a session through the sidecar, find out what it is
//! (`fingerprint`), what it can do (`capabilities`), build the plan
//! (`coreview-catalog`), run it light-first with every command optional
//! (`run`), scrub what must never be kept (`scrub`), and normalise the rows
//! into the discovery tables (`tables`). Vendors with an API are read by
//! `api` in Rust, never through the sidecar. Nothing here touches SQLite
//! or Tauri: `src-tauri` persists what this returns.

pub mod api;
pub mod capabilities;
pub mod fingerprint;
pub mod live;
pub mod readers;
pub mod run;
pub mod scrub;
pub mod sidecar;
pub mod tables;

pub use run::{collect_device, CommandOutcome, DeviceRun, RunOptions, RunSink, Target};
pub use sidecar::{Auth, Sidecar, SidecarError, SidecarLocation};
