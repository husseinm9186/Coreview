//! Who made a device, from the first three bytes of its MAC.
//!
//! A network has things on it that answer no discovery protocol and have no
//! name worth showing — a chassis id of `7456.3c00.0001` on a switch port
//! tells an operator nothing. The IEEE registry turns that into "Ubiquiti",
//! which is enough to know what you are looking at.
//!
//! Deliberately only the manufacturer. A vendor does not tell you what a
//! device *is*: Hewlett Packard makes printers and servers and switches, and
//! guessing between them would put wrong glyphs on a diagram with no way for
//! the operator to know it had been guessed.
//!
//! The table is bundled rather than fetched. Everything about this app works
//! without a network it did not ask for.

use crate::oui_data::{OUI, OUI_28, OUI_36, VENDORS};

/// The organisation that registered a MAC's prefix.
///
/// **Longest prefix first.** IEEE sells address space in three sizes, and the
/// smaller two are carved out of blocks it keeps in its own name. Ask the
/// 24-bit table about a MAC from one of those and the honest answer is "IEEE
/// Registration Authority", which is not a manufacturer and tells an operator
/// nothing — a Proxmox host on the operator's own network reported exactly
/// that until the 36- and 28-bit registries were consulted ahead of it.
pub fn vendor(mac: &str) -> Option<&'static str> {
    let hex: String = mac
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if hex.len() < 6 {
        return None;
    }
    if hex.len() >= 9 {
        if let Ok(prefix) = u64::from_str_radix(&hex[..9], 16) {
            if let Ok(at) = OUI_36.binary_search_by_key(&prefix, |(p, _)| *p) {
                return VENDORS.get(OUI_36[at].1 as usize).copied();
            }
        }
    }
    if hex.len() >= 7 {
        if let Ok(prefix) = u32::from_str_radix(&hex[..7], 16) {
            if let Ok(at) = OUI_28.binary_search_by_key(&prefix, |(p, _)| *p) {
                return VENDORS.get(OUI_28[at].1 as usize).copied();
            }
        }
    }
    let prefix = u32::from_str_radix(&hex[..6], 16).ok()?;
    let at = OUI.binary_search_by_key(&prefix, |(p, _)| *p).ok()?;
    VENDORS.get(OUI[at].1 as usize).copied()
}

/// A label for something that has no name of its own.
///
/// "Fortinet device" beats "e81c.ba00.0002" on a diagram, and beats inventing
/// a name that implies more is known than is.
pub fn describe(mac: &str) -> Option<String> {
    vendor(mac).map(|v| format!("{v} device"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_makers_on_a_real_network() {
        // Every one of these is from the ARP table of the switch this was
        // built against.
        assert_eq!(vendor("cc7f.7500.0003"), Some("Cisco Systems"));
        assert_eq!(vendor("74ac.b900.0005"), Some("Ubiquiti"));
        assert_eq!(vendor("e81c.ba00.0002"), Some("Fortinet"));
        assert_eq!(vendor("b827.eb5f.3ae6"), Some("Raspberry Pi Foundation"));
    }

    #[test]
    fn reads_a_mac_however_it_is_written() {
        let want = Some("Fortinet");
        assert_eq!(vendor("e81c.ba00.0002"), want);
        assert_eq!(vendor("E8:1C:BA:00:00:02"), want);
        assert_eq!(vendor("e8-1c-ba-00-00-02"), want);
        // The prefix alone is enough.
        assert_eq!(vendor("e81cba"), want);
    }

    #[test]
    fn says_nothing_rather_than_guessing() {
        // A locally administered address is registered to nobody.
        assert_eq!(vendor("0201.0203.0405"), None);
        assert_eq!(vendor("LABDESKTOP01"), None);
        assert_eq!(vendor(""), None);
        assert_eq!(vendor("ab"), None);
    }

    #[test]
    fn describes_something_with_no_name() {
        assert_eq!(describe("74ac.b900.0005").as_deref(), Some("Ubiquiti device"));
        assert_eq!(describe("0201.0203.0405"), None);
    }

    #[test]
    fn the_table_is_sorted_and_large_enough_to_be_the_real_registry() {
        // Binary search on an unsorted table returns wrong answers silently.
        assert!(OUI.windows(2).all(|w| w[0].0 < w[1].0), "the table must be sorted");
        assert!(OUI.len() > 30_000, "only {} entries — is this the whole registry?", OUI.len());
        // Every index has to point at a name, or a lookup silently returns
        // None for a prefix that is in the registry.
        assert!(
            OUI.iter().all(|(_, i)| (*i as usize) < VENDORS.len()),
            "an index points past the end of VENDORS"
        );
    }
}
