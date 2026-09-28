//! ArubaOS-CX identity: the model and serial live in `show system` (LT-490).
//!
//! **Captured, not reconstructed.** The fixtures below are the operator's
//! own output from an Aruba CX 6200F on AOS-CX ML.10.18, 2026-09-28, with the
//! chassis serial and base MAC replaced by invented values (D-027). What
//! they earned is the identity half: `show version` names the software and
//! nothing else, and `show system` names the product, the serial and the
//! host. The neighbour, ARP, MAC and bundle commands this dialect sends have
//! **not** been seen from a CX device, which is why the dialect as a whole
//! still reports unverified.

fn labelled<'a>(out: &'a str, label: &str) -> Option<&'a str> {
    out.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k.trim().eq_ignore_ascii_case(label) && !v.trim().is_empty()).then(|| v.trim())
    })
}

/// `Product Name : JL727A 6200F 48G CL4 4SFP+370W Swch`, upper-cased for
/// the classifier — the part number, the family and what it is.
pub fn model_of(system: &str) -> Option<String> {
    labelled(system, "Product Name").map(|m| m.to_ascii_uppercase())
}

/// `Chassis Serial Nbr : …`.
pub fn serials_of(system: &str) -> Vec<String> {
    labelled(system, "Chassis Serial Nbr").map(|s| vec![s.to_string()]).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The operator's `show version`, verbatim.
    pub(crate) const VERSION: &str = "-----------------------------------------------------------------------------\nAOS-CX\n(c) Copyright 2017-2026 Hewlett Packard Enterprise Development LP\n-----------------------------------------------------------------------------\nVersion      : ML.10.18.1002                                                 \nBuild Date   : 2026-08-27 04:58:32 UTC                                       \nBuild ID     : AOS-CX:ML.10.18.1002:0ea5714e629d:202608270437                \nBuild SHA    : 0ea5714e629d97e799de623c2350c9cd41fb03f4                      \nHot Patches  :                                                               \nActive Image : primary                       \n \nService OS Version : ML.01.19.0001                 \nBIOS Version       : FL.01.0004                    \n";

    /// The operator's `show system`, with the serial and base MAC invented.
    pub(crate) const SYSTEM: &str = "Hostname               : 6200                          \nSystem Description     : ML.10.18.1002                 \nSystem Contact         :                               \nSystem Location        :                               \n \nVendor                 : HPE ANW                       \nProduct Name           : JL727A 6200F 48G CL4 4SFP+370W Swch  \nChassis Serial Nbr     : XX00EXAMPLE                   \nBase MAC Address       : 00005e-005301                 \nAOS-CX Version         : ML.10.18.1002                 \n \nTime Zone              : UTC                           \n \nUp Time                : 1 week, 5 days, 14 hours, 15 minutes                        \nCPU Util (%)           : 24                            \nCPU Util (% avg 1 min) : 8                             \nCPU Util (% avg 5 min) : 10                            \nMemory Usage (%)       : 17\n";

    #[test]
    fn a_cx_6200_names_its_model_and_serial_and_is_a_switch() {
        assert_eq!(crate::dialect::family_of(VERSION), crate::dialect::Family::ArubaOsCx);
        assert_eq!(model_of(SYSTEM).as_deref(), Some("JL727A 6200F 48G CL4 4SFP+370W SWCH"));
        assert_eq!(serials_of(SYSTEM), ["XX00EXAMPLE"]);
        // An empty label is not a value: `System Contact :` is blank.
        assert_eq!(labelled(SYSTEM, "System Contact"), None);
        // Through the dialect, the way a crawl asks.
        let d = crate::dialect::dialect_for(VERSION);
        assert_eq!(d.identity_commands(), ["show system"]);
        let id = d.identity(VERSION, &[SYSTEM.to_string()]);
        assert_eq!((id.model.as_deref(), id.serials.as_slice()), (Some("JL727A 6200F 48G CL4 4SFP+370W SWCH"), &["XX00EXAMPLE".to_string()][..]));
        assert_eq!(crate::classify::classify(id.model.as_deref(), &[], None), crate::types::DeviceClass::Switch);
        // `show version` alone names nothing, which was the gap.
        assert_eq!(crate::crawl::serials_in_version(VERSION), Vec::<String>::new());
    }
}
