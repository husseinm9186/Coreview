//! Deciding what kind of device something is.
//!
//! Three signals, in decreasing order of trust:
//!
//! 1. The platform string. `AIR-CAP2702I` is an access point and nothing else.
//!    This is the strongest signal when it matches, and it is how the Python
//!    crawler decided what to skip.
//! 2. Advertised capabilities. CDP and LLDP both carry these, and a device
//!    that claims Router or Switch usually is one. Weaker than the platform
//!    because a wireless controller claims Switch, and an access point in
//!    bridge mode claims Trans-Bridge.
//! 3. The version or system description, as a last resort for platforms whose
//!    model string says nothing useful.
//!
//! Getting this wrong is not fatal — it changes an icon and whether a device
//! passes a filter — but getting it wrong *consistently* makes the filter
//! useless, so each rule below is anchored to a real product family.

use crate::types::DeviceClass;

/// Classifies a device from whatever the neighbour protocol advertised.
///
/// `capabilities` are the raw words: CDP's "Router Switch IGMP", or LLDP's
/// "Bridge Router" / "W" / "Station Only" depending on how the platform
/// renders them.
pub fn classify(platform: Option<&str>, capabilities: &[String], version: Option<&str>) -> DeviceClass {
    let platform_up = platform.unwrap_or("").to_ascii_uppercase();
    let version_up = version.unwrap_or("").to_ascii_uppercase();

    if let Some(c) = from_platform(&platform_up) {
        return c;
    }
    if let Some(c) = from_capabilities(capabilities) {
        return c;
    }
    if let Some(c) = from_platform(&version_up) {
        return c;
    }
    DeviceClass::Unknown
}

/// Model-string rules, most specific first. Order matters: `AIR-CT5520` is a
/// wireless controller, but it also starts with `AIR-`, so controllers are
/// tested before access points.
fn from_platform(s: &str) -> Option<DeviceClass> {
    if s.is_empty() {
        return None;
    }

    // Wireless controllers, before the AIR- access point rule below.
    // LT-476: Aruba's controllers by their model numbers.
    const WLC: [&str; 10] = ["AIR-CT", "C9800", "AIRCT", "WLC", "VWLC", "WISM", "ARUBA70", "ARUBA72", "ARUBA90", "ARUBA92"];
    if WLC.iter().any(|p| s.contains(p)) {
        return Some(DeviceClass::WirelessController);
    }

    // Access points. The non-Cisco names are here because a real network has
    // them and CDP reports their platform verbatim: a FortiAP advertises
    // "Capabilities: Switch Host", so without the model rule it classifies as a
    // switch and the crawler tries to log into an access point.
    const AP: [&str; 11] = [
        "AIR-", "AIR ", "C9105", "C9115", "C9120", "C9130",
        "FORTIAP", "UAP-", "MERAKI MR", "IAP-", "AP-U",
    ];
    if AP.iter().any(|p| s.contains(p)) {
        return Some(DeviceClass::AccessPoint);
    }

    // Firewalls. FPR is Firepower; ASA covers the 5500 series.
    // LT-466: Juniper's SRX; LT-470: a Check Point gateway names itself by
    // its appliance number and the word.
    const FW: [&str; 10] = ["ASA", "FPR", "FIREPOWER", "PALO ALTO", "PA-", "FORTIGATE", "SONICWALL", "SRX", "CHECK POINT", "CHECKPOINT"];
    if FW.iter().any(|p| s.contains(p)) {
        return Some(DeviceClass::Firewall);
    }

    // Phones. SEP is the MAC-derived device ID Cisco phones use.
    const PHONE: [&str; 5] = ["IP PHONE", "CP-", "SEP", "TELEPRESENCE", "DX80"];
    if PHONE.iter().any(|p| s.contains(p)) {
        return Some(DeviceClass::Phone);
    }

    // Cameras.
    const CAMERA: [&str; 3] = ["CIVS-", "IPCAMERA", "AXIS"];
    if CAMERA.iter().any(|p| s.contains(p)) {
        return Some(DeviceClass::Camera);
    }

    const PRINTER: [&str; 4] = ["JETDIRECT", "LASERJET", "PRINTER", "KYOCERA"];
    if PRINTER.iter().any(|p| s.contains(p)) {
        return Some(DeviceClass::Printer);
    }

    // Routers. ISR/ASR/CSR are router families; "CISCO29" style covers the
    // older bare-numeric platform strings.
    const ROUTER: [&str; 8] = ["ISR", "ASR", "CSR", "C8000", "C8200", "C8300", "CISCO19", "CISCO29"];
    if ROUTER.iter().any(|p| s.contains(p)) {
        return Some(DeviceClass::Router);
    }

    // Switches. Catalyst, Nexus, and the WS- Catalyst prefix.
    const SWITCH: [&str; 27] = [
        "WS-C", "C9200", "C9300", "C9400", "C9500", "N9K", "N5K", "N7K",
        // Seen on a real network: Fortinet and Ubiquiti switches, which
        // advertise a bare Bridge capability and would otherwise be Unknown.
        "FORTISWITCH", "UBNT-US", "USW-",
        // Older Catalyst families, which name themselves by number rather than
        // with a WS- prefix in a version banner. A real C2960CX classified as
        // Unknown without these.
        "C2960", "C3560", "C3650", "C3750", "C3850", "C1000", "CBS350",
        // LT-466: Juniper's switches, by their model prefixes (D-058).
        "EX2300", "EX3400", "EX4", "EX9", "QFX",
        // LT-467: Arista's, and its virtual one.
        "DCS-", "CCS-", "VEOS",
        // LT-490: an Aruba CX product name ends in HPE's abbreviation —
        // "JL727A 6200F 48G CL4 4SFP+370W Swch", from the operator's 6200F.
        " SWCH",
    ];
    if SWITCH.iter().any(|p| s.contains(p)) {
        return Some(DeviceClass::Switch);
    }
    // LT-407: Dell, campus and data centre. Written as whole model prefixes
    // rather than "starts with S or Z", because an estate full of PowerEdge
    // would otherwise fill the diagram with switches: `R740` is a server.
    const DELL: [&str; 10] = [
        // Data centre: S-series leaves, Z-series spines, the MX blade fabric.
        "S4048", "S4128", "S4148", "S5212", "S5248", "S5232", "Z9100", "Z9432",
        "MX9116", "MX5108",
    ];
    if DELL.iter().any(|p| s.contains(p)) {
        return Some(DeviceClass::Switch);
    }
    // Campus: the N-series and the PowerConnect it replaced. `N` and three
    // digits, so a hostname like "N1" cannot match.
    if s.contains("POWERCONNECT")
        || s.contains("FORCE10")
        || (s.starts_with('N') && s.len() > 4 && s[1..5].chars().all(|c| c.is_ascii_digit()))
    {
        return Some(DeviceClass::Switch);
    }

    // "Nexus" and "Catalyst" spelled out, as NX-OS version strings do.
    if s.contains("NEXUS") || s.contains("CATALYST") {
        return Some(DeviceClass::Switch);
    }
    // LT-403: a model that says what it is. Every rule above is a family
    // prefix, and an estate has families nobody here has heard of — the
    // operator's `Aruba JL322A 2930M-48G-PoE+ Switch` matched none of them and
    // was drawn as a generic box. Last, so everything specific still wins: a
    // FortiAP saying "Switch" is an access point, and stays one.
    //
    // A whole word, so "switchboard" is not a switch.
    if s.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| w == "SWITCH") {
        return Some(DeviceClass::Switch);
    }

    None
}

/// Capability rules. CDP words are spelled out; LLDP is either spelled out or
/// reduced to single letters (`R` router, `B` bridge, `W` WLAN AP, `T`
/// telephone, `S` station), depending on the platform.
fn from_capabilities(caps: &[String]) -> Option<DeviceClass> {
    let has = |want: &str| caps.iter().any(|c| c.eq_ignore_ascii_case(want));

    // Checked before Bridge/Switch: an access point advertises both.
    if has("Phone") || has("Telephone") || has("T") {
        return Some(DeviceClass::Phone);
    }
    if has("WLAN Access Point") || has("WLAN-Access-Point") || has("W") {
        return Some(DeviceClass::AccessPoint);
    }
    // Bridging before routing, deliberately. A device that does both is a
    // layer-3 switch far more often than it is a router — every Nexus and
    // every Aruba CX advertises Bridge and Router together — and drawing a
    // rack of leaf switches as routers is misleading. A real router advertises
    // routing without bridging.
    if has("Switch") || has("Bridge") || has("B") {
        return Some(DeviceClass::Switch);
    }
    if has("Router") || has("R") {
        return Some(DeviceClass::Router);
    }
    // A device that only bridges is an access point or a media converter far
    // more often than it is a switch.
    if has("Trans-Bridge") {
        return Some(DeviceClass::AccessPoint);
    }
    // "Station Only" is LLDP for "I am an endpoint".
    if has("Station Only") || has("Station") || has("S") {
        return Some(DeviceClass::Endpoint);
    }
    if has("Host") {
        return Some(DeviceClass::Endpoint);
    }
    None
}

/// What the maker of a network card implies about the device it is in
/// (LT-370).
///
/// **The last resort, and deliberately the weakest signal.** A crawl that logs
/// in learns the platform, the capabilities and the banner. A device it merely
/// *saw* — a MAC on a switch port, an ARP entry, a DHCP lease, a swept host —
/// arrives with a vendor name from the OUI registry and nothing else, and was
/// therefore drawn as `Unknown`. On a real estate that is most of the picture.
///
/// **An OUI names the maker, not the kind**, and that is the whole difficulty.
/// The rule here is to map only where the maker genuinely implies the kind:
///
/// * Apple builds no access switches, so an Apple card on a port is an
///   endpoint and saying so is safe.
/// * **Hewlett Packard builds printers *and* switches**, so it says nothing,
///   and must keep saying nothing however tempting the printer guess is.
/// * A hypervisor's OUI — VMware, Proxmox, Xen, KVM — is a virtual machine,
///   which is a server.
///
/// Everything unmatched returns `None`, which leaves the device Unknown. That
/// is the honest answer and the same refusal D-050 makes elsewhere: a wrong
/// class is worse than an absent one, because a wrong one is believed.
pub fn class_from_vendor(vendor: &str) -> Option<DeviceClass> {
    let v = vendor.to_ascii_uppercase();
    let has = |needles: &[&str]| needles.iter().any(|n| v.contains(n));

    // Hypervisors: the card belongs to a virtual machine.
    if has(&["VMWARE", "PROXMOX", "XENSOURCE", "QEMU", "PARALLELS", "NUTANIX", "ORACLE VIRTUALBOX", "VIRTUALBOX"]) {
        return Some(DeviceClass::Server);
    }
    // Cameras. Each of these makes cameras and essentially nothing else that
    // turns up on an access port.
    if has(&["AXIS COMMUNICATION", "HIKVISION", "DAHUA", "VIVOTEK", "MOBOTIX", "ARLO", "WYZE"]) {
        return Some(DeviceClass::Camera);
    }
    // Printers. Note the absence of Hewlett Packard, Canon and Epson, which
    // all make other things that appear on networks.
    if has(&["LEXMARK", "KYOCERA", "ZEBRA TECHNOLOGIES", "BROTHER INDUSTRIES", "RICOH", "SATO CORPORATION"]) {
        return Some(DeviceClass::Printer);
    }
    // Desk phones.
    if has(&["POLYCOM", "YEALINK", "GRANDSTREAM", "SNOM", "AVAYA", "MITEL"]) {
        return Some(DeviceClass::Phone);
    }
    // Personal computers, phones, consoles and the vast middle of the internet
    // of things. None of these makes infrastructure.
    if has(&[
        "APPLE", "SAMSUNG", "GOOGLE", "AMAZON", "MICROSOFT", "SONY", "LG ELECTRONICS",
        "NINTENDO", "ROKU", "SONOS", "RING", "NEST LABS", "ESPRESSIF", "RASPBERRY PI",
        "TUYA", "SHENZHEN BILIAN", "AZUREWAVE", "LITEON", "LITE-ON", "MURATA",
        "TEXAS INSTRUMENTS", "GIGA-BYTE", "ASUSTEK", "MSI", "HUAWEI DEVICE",
        "XIAOMI", "ONEPLUS", "MOTOROLA MOBILITY", "FITBIT", "GARMIN", "BOSE",
    ]) {
        return Some(DeviceClass::Endpoint);
    }
    // Everything else — including every maker that builds more than one kind
    // of thing — stays unknown on purpose.
    None
}

#[cfg(test)]
mod tests {

    /// LT-370: the last-resort classifier, and the makers it must refuse.
    #[test]
    fn a_hypervisor_oui_is_a_server() {
        for v in ["VMware, Inc.", "Proxmox Server Solutions GmbH", "XenSource, Inc."] {
            assert_eq!(class_from_vendor(v), Some(DeviceClass::Server), "{v}");
        }
    }

    #[test]
    fn makers_of_one_kind_of_thing_name_that_kind() {
        assert_eq!(class_from_vendor("AXIS COMMUNICATIONS AB"), Some(DeviceClass::Camera));
        assert_eq!(class_from_vendor("Lexmark International"), Some(DeviceClass::Printer));
        assert_eq!(class_from_vendor("Polycom"), Some(DeviceClass::Phone));
        assert_eq!(class_from_vendor("Apple, Inc."), Some(DeviceClass::Endpoint));
        assert_eq!(class_from_vendor("Raspberry Pi Foundation"), Some(DeviceClass::Endpoint));
    }

    /// The point of the whole exercise: a maker that builds more than one kind
    /// of thing must stay silent. Guessing "printer" from Hewlett Packard puts
    /// a printer glyph on somebody's core switch.
    #[test]
    fn a_maker_of_several_kinds_of_thing_says_nothing() {
        for v in [
            "Hewlett Packard", "Hewlett Packard Enterprise", "Cisco Systems, Inc",
            "Canon Inc.", "Seiko Epson Corporation", "Ubiquiti Inc", "Netgear",
            "Fortinet, Inc.", "Juniper Networks", "Dell Inc.", "Intel Corporate",
        ] {
            assert_eq!(class_from_vendor(v), None, "{v} must stay unknown");
        }
    }

    #[test]
    fn an_unknown_or_empty_maker_is_not_a_guess() {
        assert_eq!(class_from_vendor(""), None);
        assert_eq!(class_from_vendor("unknown maker"), None);
        assert_eq!(class_from_vendor("Some Company Nobody Has Heard Of"), None);
    }

    #[test]
    fn matching_ignores_case_and_punctuation_around_the_name() {
        assert_eq!(class_from_vendor("apple, inc."), Some(DeviceClass::Endpoint));
        assert_eq!(class_from_vendor("VMWARE, INC."), Some(DeviceClass::Server));
    }

    use super::*;

    fn caps(words: &str) -> Vec<String> {
        words.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn a_catalyst_is_a_switch() {
        assert_eq!(
            classify(Some("WS-C2960-24TT-L"), &caps("Switch IGMP"), None),
            DeviceClass::Switch
        );
        assert_eq!(
            classify(Some("C9300-48P"), &caps("Router Switch"), None),
            DeviceClass::Switch
        );
    }

    #[test]
    fn a_nexus_is_a_switch_even_though_it_claims_router() {
        // N9Ks advertise Router and Switch. The platform is the stronger
        // signal, and drawing every leaf switch as a router is misleading.
        assert_eq!(
            classify(Some("N9K-C93180YC-EX"), &caps("Router Switch IGMP"), None),
            DeviceClass::Switch
        );
    }

    #[test]
    fn an_isr_is_a_router() {
        assert_eq!(
            classify(Some("ISR4331/K9"), &caps("Router Source-Route-Bridge"), None),
            DeviceClass::Router
        );
    }

    #[test]
    fn an_access_point_is_not_a_switch() {
        // This is the case the Python crawler special-cased, and the one that
        // matters most: APs are numerous and crawling into them is pointless.
        assert_eq!(
            classify(Some("AIR-CAP2702I-E-K9"), &caps("Trans-Bridge"), None),
            DeviceClass::AccessPoint
        );
        assert_eq!(
            classify(Some("AIR-AP3802I-B-K9"), &caps("Trans-Bridge Source-Route-Bridge"), None),
            DeviceClass::AccessPoint
        );
    }

    #[test]
    fn non_cisco_access_points_are_not_switches() {
        // From a real network: a FortiAP advertises "Capabilities: Switch Host"
        // over CDP, so without the model rule the capability guess wins and the
        // crawler tries to log into an access point.
        assert_eq!(
            classify(Some("FortiAP-U431F"), &caps("Switch Host"), None),
            DeviceClass::AccessPoint
        );
        assert_eq!(classify(Some("UAP-AC-PRO"), &caps("Bridge"), None), DeviceClass::AccessPoint);
    }

    #[test]
    fn non_cisco_switches_are_recognised_by_model() {
        // A Ubiquiti switch seen over LLDP advertises only "B".
        assert_eq!(classify(Some("UBNT-USL8L"), &caps("B"), None), DeviceClass::Switch);
        assert_eq!(classify(Some("FortiSwitch-124F"), &caps(""), None), DeviceClass::Switch);
    }

    #[test]
    fn a_wireless_controller_is_not_an_access_point() {
        // AIR-CT5520 starts with AIR-, so ordering decides this one.
        assert_eq!(
            classify(Some("AIR-CT5520-K9"), &caps("Switch"), None),
            DeviceClass::WirelessController
        );
        assert_eq!(
            classify(Some("C9800-40-K9"), &caps("Router Switch"), None),
            DeviceClass::WirelessController
        );
    }

    #[test]
    fn a_phone_is_a_phone_by_platform_or_capability() {
        assert_eq!(
            classify(Some("Cisco IP Phone 8845"), &caps("Host Phone"), None),
            DeviceClass::Phone
        );
        // LLDP-MED from a third-party handset: no useful platform string.
        assert_eq!(classify(None, &caps("Telephone Bridge"), None), DeviceClass::Phone);
    }

    #[test]
    fn firewalls_are_recognised_across_vendors() {
        assert_eq!(classify(Some("ASA5525"), &caps(""), None), DeviceClass::Firewall);
        assert_eq!(classify(Some("FPR-2110"), &caps(""), None), DeviceClass::Firewall);
        assert_eq!(classify(Some("PA-3220"), &caps("Router"), None), DeviceClass::Firewall);
    }

    #[test]
    fn a_device_that_bridges_and_routes_is_a_switch() {
        // Every layer-3 switch advertises both. Calling them routers turns a
        // rack of leaves into a rack of routers on the diagram.
        assert_eq!(classify(None, &caps("Bridge Router"), None), DeviceClass::Switch);
        assert_eq!(classify(None, &caps("B R"), None), DeviceClass::Switch);
        // Routing without bridging is a router.
        assert_eq!(classify(None, &caps("Router"), None), DeviceClass::Router);
        assert_eq!(
            classify(None, &caps("Router Source-Route-Bridge"), None),
            DeviceClass::Router
        );
    }

    #[test]
    fn lldp_single_letter_capabilities_are_understood() {
        // Several platforms render LLDP capabilities as letters.
        assert_eq!(classify(None, &caps("R"), None), DeviceClass::Router);
        assert_eq!(classify(None, &caps("B"), None), DeviceClass::Switch);
        assert_eq!(classify(None, &caps("W"), None), DeviceClass::AccessPoint);
        assert_eq!(classify(None, &caps("T"), None), DeviceClass::Phone);
    }

    #[test]
    fn a_workstation_is_an_endpoint() {
        assert_eq!(classify(None, &caps("Station Only"), None), DeviceClass::Endpoint);
        assert_eq!(classify(None, &caps("Host"), None), DeviceClass::Endpoint);
    }

    #[test]
    fn the_version_string_is_a_last_resort() {
        // Some platforms advertise no model at all.
        assert_eq!(
            classify(None, &[], Some("Cisco Nexus Operating System (NX-OS) Software")),
            DeviceClass::Switch
        );
    }

    #[test]
    fn nothing_useful_yields_unknown_rather_than_a_guess() {
        // A wrong class is worse than an honest one: it makes a filter lie.
        assert_eq!(classify(None, &[], None), DeviceClass::Unknown);
        assert_eq!(classify(Some(""), &caps("IGMP"), None), DeviceClass::Unknown);
    }
    /// LT-403. The operator's 2930M reported
    /// `Aruba JL322A 2930M-48G-PoE+ Switch` and was drawn as a generic
    /// device, because every switch rule was a model *prefix* and none of
    /// them was his.
    #[test]
    fn a_model_that_says_switch_is_a_switch() {
        for model in [
            "Aruba JL322A 2930M-48G-PoE+ Switch",
            "Aruba JL693A 2930F-24G-PoE+ Switch",
            "HP 5406Rzl2 Switch",
        ] {
            assert_eq!(classify(Some(model), &[], None), DeviceClass::Switch, "{model}");
        }
    }

    #[test]
    fn the_word_switch_does_not_outrank_what_a_thing_actually_is() {
        // A FortiAP advertises "Switch" among its capabilities, and plenty of
        // gear has the word in a description. The specific rules run first and
        // must keep winning.
        assert_eq!(classify(Some("FortiAP-231F Switch"), &[], None), DeviceClass::AccessPoint);
        assert_eq!(classify(Some("AIR-CT5520 switch"), &[], None), DeviceClass::WirelessController);
        assert_eq!(classify(Some("PA-440 switch"), &[], None), DeviceClass::Firewall);
        // And a word on its own is not a model.
        assert_eq!(classify(Some("switchboard"), &[], None), DeviceClass::Unknown);
    }
    /// LT-407. Dell's campus and data-centre lines, which named themselves by
    /// model and matched nothing: an S5248F-ON is a leaf switch and a Z9432F
    /// is a spine, and both drew as generic boxes.
    #[test]
    fn dell_switches_are_switches_campus_and_data_centre_alike() {
        for model in [
            // Data centre: S-series leaves, Z-series spines, MX blade fabric.
            "S4048-ON", "S4148F-ON", "S5248F-ON", "S5232F-ON", "Z9100-ON", "Z9432F-ON",
            "MX9116n Fabric Switching Engine", "MX5108n Ethernet Switch",
            // Campus: N-series and the PowerConnect it replaced.
            "N3048EP-ON", "N2048", "N1148T-ON", "PowerConnect 5548",
            // Force10, which is where the S-series came from.
            "Force10 S4810",
        ] {
            assert_eq!(classify(Some(model), &[], None), DeviceClass::Switch, "{model}");
        }
    }

    #[test]
    fn a_dell_server_is_not_a_dell_switch() {
        // The same estate is full of PowerEdge, and "R740" must not become a
        // switch because it starts with a letter and a number.
        assert_ne!(classify(Some("PowerEdge R740"), &[], None), DeviceClass::Switch);
        assert_ne!(classify(Some("iDRAC9"), &[], None), DeviceClass::Switch);
    }
}
