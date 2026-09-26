//! The file readers (LT-457): a Visio drawing, a draw.io drawing and an Nmap
//! report, read into devices and links.
//!
//! Pure parsing over bytes and text, with no Tauri in it, so the readers
//! build and test with plain `cargo test` the way `coreview-probe` does — and
//! so the property tests that LT-267 gave every parser can reach these too.
//! Each reader's own doc comment says what it was checked against (D-032).

pub mod drawio_import;
pub mod nmap_import;
pub mod visio_import;
