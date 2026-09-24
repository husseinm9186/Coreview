//! The health check's grading model (LT-406).
//!
//! Ported from `meraki_healthcheck.py`, and the port is deliberate about which
//! part it takes. The interesting part of that script is not the API calls; it
//! is that **an evaluator never decides urgency**. It raises a stable
//! [`Code`] for what it found, and a [`Profile`] decides whether that is an
//! action or an advisory. The observation text is identical either way — only
//! the grading moves. Nothing is hidden; it is ranked for the reader.
//!
//! A 30-person church does not need the same bar as a CMMC enclave, and
//! reporting it as if it does buries the two things that genuinely are broken.
//!
//! **What this module does not do:** talk to anything. It is fed the JSON a
//! network answered with and produces findings, so every rule in here is
//! testable without a key, a network, or a Meraki. That is the whole reason it
//! is a separate module from [`crate::api`].

use serde::{Deserialize, Serialize};

/// What an evaluator found. Stable strings: they are the contract between the
/// evaluators and the profiles, and they appear in saved reports.
///
/// The Python keeps three lists and concatenates them. Here they are one enum
/// with a [`Code::group`], which makes "unknown code" unrepresentable rather
/// than a runtime `ValueError` — the failure its `Flags.add` raises by hand.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    // ── Faults: something is broken or down right now. Urgent almost anywhere.
    #[serde(rename = "device.appliance_offline")]
    DeviceApplianceOffline,
    #[serde(rename = "device.ap_offline")]
    DeviceApOffline,
    #[serde(rename = "device.switch_offline")]
    DeviceSwitchOffline,
    #[serde(rename = "uplink.down")]
    UplinkDown,
    #[serde(rename = "uplink.degraded")]
    UplinkDegraded,
    #[serde(rename = "vpn.peer_unreachable")]
    VpnPeerUnreachable,
    #[serde(rename = "port.errors")]
    PortErrors,
    #[serde(rename = "port.half_duplex")]
    PortHalfDuplex,
    #[serde(rename = "port.blocked")]
    PortBlocked,
    #[serde(rename = "switch.uplink_down")]
    SwitchUplinkDown,
    #[serde(rename = "switch.stack_member_down")]
    SwitchStackMemberDown,
    #[serde(rename = "poe.dark_port")]
    PoeDarkPort,
    #[serde(rename = "topology.broken_link")]
    TopologyBrokenLink,
    #[serde(rename = "events.reboot_failover")]
    EventsRebootFailover,
    #[serde(rename = "licence.status_not_ok")]
    LicenceStatusNotOk,
    #[serde(rename = "licence.expiring")]
    LicenceExpiring,

    // ── Posture: security weaker than the benchmark.
    #[serde(rename = "amp.disabled")]
    AmpDisabled,
    #[serde(rename = "ids.disabled")]
    IdsDisabled,
    #[serde(rename = "ids.not_prevention")]
    IdsNotPrevention,
    #[serde(rename = "ids.ruleset_not_security")]
    IdsRulesetNotSecurity,
    #[serde(rename = "threats.unblocked")]
    ThreatsUnblocked,
    #[serde(rename = "fw.any_any")]
    FwAnyAny,
    #[serde(rename = "cf.no_categories")]
    CfNoCategories,

    // ── Operations: monitoring, backups, visibility, resilience.
    #[serde(rename = "alerts.missing")]
    AlertsMissing,
    #[serde(rename = "alerts.no_recipients")]
    AlertsNoRecipients,
    #[serde(rename = "backup.missing")]
    BackupMissing,
    #[serde(rename = "traffic_analysis.disabled")]
    TrafficAnalysisDisabled,
    #[serde(rename = "firmware.update_available")]
    FirmwareUpdateAvailable,
    #[serde(rename = "stp.rstp_disabled")]
    StpRstpDisabled,
    #[serde(rename = "stp.noisy")]
    StpNoisy,
    #[serde(rename = "events.power")]
    EventsPower,
    #[serde(rename = "dot1x.denied")]
    Dot1xDenied,
    #[serde(rename = "wifi.conn_failures")]
    WifiConnFailures,
    #[serde(rename = "wifi.high_channel_util")]
    WifiHighChannelUtil,
    #[serde(rename = "wifi.rf_interference")]
    WifiRfInterference,
    #[serde(rename = "wifi.client_repeat_failures")]
    WifiClientRepeatFailures,
    #[serde(rename = "wifi.weak_signal")]
    WifiWeakSignal,
}

/// Which list a code belongs to. What the profiles are built out of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Group {
    /// Something is broken or down right now.
    Fault,
    /// Security posture weaker than the benchmark.
    Posture,
    /// Operational hygiene — monitoring, backups, visibility, resilience.
    Operations,
}

impl Code {
    pub fn group(self) -> Group {
        use Code::*;
        match self {
            DeviceApplianceOffline | DeviceApOffline | DeviceSwitchOffline | UplinkDown
            | UplinkDegraded | VpnPeerUnreachable | PortErrors | PortHalfDuplex | PortBlocked
            | SwitchUplinkDown | SwitchStackMemberDown | PoeDarkPort | TopologyBrokenLink
            | EventsRebootFailover | LicenceStatusNotOk | LicenceExpiring => Group::Fault,

            AmpDisabled | IdsDisabled | IdsNotPrevention | IdsRulesetNotSecurity
            | ThreatsUnblocked | FwAnyAny | CfNoCategories => Group::Posture,

            AlertsMissing | AlertsNoRecipients | BackupMissing | TrafficAnalysisDisabled
            | FirmwareUpdateAvailable | StpRstpDisabled | StpNoisy | EventsPower | Dot1xDenied
            | WifiConnFailures | WifiHighChannelUtil | WifiRfInterference
            | WifiClientRepeatFailures | WifiWeakSignal => Group::Operations,
        }
    }

    /// Every code there is. The Python's `ALL_FINDING_CODES`.
    pub fn all() -> &'static [Code] {
        use Code::*;
        &[
            DeviceApplianceOffline, DeviceApOffline, DeviceSwitchOffline, UplinkDown,
            UplinkDegraded, VpnPeerUnreachable, PortErrors, PortHalfDuplex, PortBlocked,
            SwitchUplinkDown, SwitchStackMemberDown, PoeDarkPort, TopologyBrokenLink,
            EventsRebootFailover, LicenceStatusNotOk, LicenceExpiring,
            AmpDisabled, IdsDisabled, IdsNotPrevention, IdsRulesetNotSecurity, ThreatsUnblocked,
            FwAnyAny, CfNoCategories,
            AlertsMissing, AlertsNoRecipients, BackupMissing, TrafficAnalysisDisabled,
            FirmwareUpdateAvailable, StpRstpDisabled, StpNoisy, EventsPower, Dot1xDenied,
            WifiConnFailures, WifiHighChannelUtil, WifiRfInterference, WifiClientRepeatFailures,
            WifiWeakSignal,
        ]
    }

    /// The code as it is written down — in a saved report, and in his script.
    ///
    /// Spelled out rather than derived from serde at runtime: going through
    /// `to_value` would allocate a `String` per call and need leaking to hand
    /// back a `&'static str`. `the_two_spellings_of_a_code_agree` is what stops
    /// this list and the serde names drifting apart.
    pub fn as_str(self) -> &'static str {
        match self {
            Code::DeviceApplianceOffline => "device.appliance_offline",
            Code::DeviceApOffline => "device.ap_offline",
            Code::DeviceSwitchOffline => "device.switch_offline",
            Code::UplinkDown => "uplink.down",
            Code::UplinkDegraded => "uplink.degraded",
            Code::VpnPeerUnreachable => "vpn.peer_unreachable",
            Code::PortErrors => "port.errors",
            Code::PortHalfDuplex => "port.half_duplex",
            Code::PortBlocked => "port.blocked",
            Code::SwitchUplinkDown => "switch.uplink_down",
            Code::SwitchStackMemberDown => "switch.stack_member_down",
            Code::PoeDarkPort => "poe.dark_port",
            Code::TopologyBrokenLink => "topology.broken_link",
            Code::EventsRebootFailover => "events.reboot_failover",
            Code::LicenceStatusNotOk => "licence.status_not_ok",
            Code::LicenceExpiring => "licence.expiring",
            Code::AmpDisabled => "amp.disabled",
            Code::IdsDisabled => "ids.disabled",
            Code::IdsNotPrevention => "ids.not_prevention",
            Code::IdsRulesetNotSecurity => "ids.ruleset_not_security",
            Code::ThreatsUnblocked => "threats.unblocked",
            Code::FwAnyAny => "fw.any_any",
            Code::CfNoCategories => "cf.no_categories",
            Code::AlertsMissing => "alerts.missing",
            Code::AlertsNoRecipients => "alerts.no_recipients",
            Code::BackupMissing => "backup.missing",
            Code::TrafficAnalysisDisabled => "traffic_analysis.disabled",
            Code::FirmwareUpdateAvailable => "firmware.update_available",
            Code::StpRstpDisabled => "stp.rstp_disabled",
            Code::StpNoisy => "stp.noisy",
            Code::EventsPower => "events.power",
            Code::Dot1xDenied => "dot1x.denied",
            Code::WifiConnFailures => "wifi.conn_failures",
            Code::WifiHighChannelUtil => "wifi.high_channel_util",
            Code::WifiRfInterference => "wifi.rf_interference",
            Code::WifiClientRepeatFailures => "wifi.client_repeat_failures",
            Code::WifiWeakSignal => "wifi.weak_signal",
        }
    }
}

/// How urgent a finding is, once a profile has graded it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// Needs attention; appears in the action items table.
    Action,
    /// Reported with its evidence, but not an action item.
    Advisory,
}

/// A check's verdict.
///
/// `Manual` is reserved for the genuine case: the API returned nothing for
/// this item, usually because the key lacks a scope or the endpoint does not
/// apply. It is a statement about what could be read — **not a task handed
/// back to the reader**. The Python learned that the hard way and renamed it
/// from "Manual review", which read as homework.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Attention,
    Advisory,
    Manual,
    Pass,
    Na,
}

impl Status {
    /// The words a person reads. Written once, here, because the Python's had
    /// already drifted: "Manual review" survived a rename in six places.
    pub fn label(self) -> &'static str {
        match self {
            Status::Pass => "OK",
            Status::Attention => "Needs attention",
            Status::Advisory => "Advisory",
            Status::Manual => "Not reported",
            Status::Na => "Not applicable",
        }
    }

    /// The order verdicts are counted and shown in, everywhere.
    pub fn order() -> &'static [Status] {
        &[Status::Attention, Status::Advisory, Status::Manual, Status::Pass, Status::Na]
    }
}

/// What the API did not return for a check, said as a fact about the reading
/// rather than a chore for the reader.
pub const MANUAL_HINT: &str =
    "Not returned by the API for this network — the dashboard page named above shows it.";

/// The numbers a profile judges against.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thresholds {
    pub latency_ms: f64,
    pub loss_pct: f64,
    pub chan_util_pct: f64,
    pub non_wifi_pct: f64,
    pub wifi_fail_pct: f64,
    pub client_fail_count: f64,
    pub licence_days: f64,
    pub stp_event_count: f64,
}

/// The same facts, graded for the environment they live in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub label: String,
    pub summary: String,
    pub thresholds: Thresholds,
    /// The grade for any code not in `actions`.
    pub default_severity: Severity,
    pub actions: Vec<Code>,
}

impl Profile {
    /// How this profile grades one finding.
    pub fn severity(&self, code: Code) -> Severity {
        if self.actions.contains(&code) {
            Severity::Action
        } else {
            self.default_severity
        }
    }
}

fn codes_in(group: Group) -> Vec<Code> {
    Code::all().iter().copied().filter(|c| c.group() == group).collect()
}

/// The four profiles, exactly as his script grades them.
pub fn profiles() -> Vec<Profile> {
    let faults = codes_in(Group::Fault);

    // Real-world small business. Only genuine breakage is an action; posture
    // and hygiene are advisories so the report reads as a short to-do list
    // rather than a wall of red.
    let smb = Profile {
        id: "smb".into(),
        label: "Small business".into(),
        summary: "Only faults that affect service count as actions. Hardening and monitoring \
                  gaps are listed as advisories — worth doing, not urgent."
            .into(),
        thresholds: Thresholds {
            latency_ms: 250.0, loss_pct: 3.0, chan_util_pct: 65.0, non_wifi_pct: 30.0,
            wifi_fail_pct: 15.0, client_fail_count: 5.0, licence_days: 30.0, stp_event_count: 20.0,
        },
        default_severity: Severity::Advisory,
        actions: faults.clone(),
    };

    // Schools, colleges, local government. Content filtering is typically a
    // funding condition, and these sites are rarely staffed around the clock,
    // so alerting and backups matter more than at an SMB.
    let mut education_actions = faults.clone();
    education_actions.extend([
        Code::CfNoCategories, Code::AmpDisabled, Code::IdsDisabled, Code::AlertsMissing,
        Code::AlertsNoRecipients, Code::BackupMissing, Code::FirmwareUpdateAvailable,
    ]);
    let education = Profile {
        id: "education".into(),
        label: "Education / public sector".into(),
        summary: "Adds web filtering, malware protection, alerting and configuration backup \
                  to the action list."
            .into(),
        thresholds: Thresholds {
            latency_ms: 200.0, loss_pct: 2.0, chan_util_pct: 60.0, non_wifi_pct: 25.0,
            wifi_fail_pct: 10.0, client_fail_count: 4.0, licence_days: 45.0, stp_event_count: 15.0,
        },
        default_severity: Severity::Advisory,
        actions: education_actions,
    };

    // Clinics and hospitals. Patient data and always-on clinical systems push
    // active threat prevention, segmentation and resilience up to actions.
    let mut healthcare_actions = faults;
    healthcare_actions.extend([
        Code::CfNoCategories, Code::AmpDisabled, Code::IdsDisabled, Code::IdsNotPrevention,
        Code::ThreatsUnblocked, Code::FwAnyAny, Code::AlertsMissing, Code::AlertsNoRecipients,
        Code::BackupMissing, Code::FirmwareUpdateAvailable, Code::TrafficAnalysisDisabled,
        Code::StpRstpDisabled, Code::EventsPower, Code::WifiConnFailures,
    ]);
    let healthcare = Profile {
        id: "healthcare".into(),
        label: "Healthcare".into(),
        summary: "Adds active threat blocking, tighter firewall rules, traffic visibility and \
                  network resilience to the action list."
            .into(),
        thresholds: Thresholds {
            latency_ms: 150.0, loss_pct: 1.0, chan_util_pct: 50.0, non_wifi_pct: 20.0,
            wifi_fail_pct: 7.0, client_fail_count: 3.0, licence_days: 60.0, stp_event_count: 10.0,
        },
        default_severity: Severity::Advisory,
        actions: healthcare_actions,
    };

    // Controlled environments: anything with an assessor. Every deviation is a
    // finding, because that is how it will be assessed.
    let regulated = Profile {
        id: "regulated".into(),
        label: "High security".into(),
        summary: "Every gap counts as an action. Nothing is treated as optional.".into(),
        thresholds: Thresholds {
            latency_ms: 120.0, loss_pct: 1.0, chan_util_pct: 45.0, non_wifi_pct: 20.0,
            wifi_fail_pct: 5.0, client_fail_count: 3.0, licence_days: 90.0, stp_event_count: 8.0,
        },
        default_severity: Severity::Action,
        actions: Code::all().to_vec(),
    };

    vec![smb, education, healthcare, regulated]
}

/// The profile used when none is chosen.
pub const DEFAULT_PROFILE: &str = "smb";

/// A profile by id, falling back to the default rather than failing — the same
/// forgiveness `resolve_profile` shows a mistyped flag.
pub fn profile(id: &str) -> Profile {
    let all = profiles();
    let wanted = id.trim().to_ascii_lowercase();
    all.iter()
        .find(|p| p.id == wanted)
        .cloned()
        .unwrap_or_else(|| all.iter().find(|p| p.id == DEFAULT_PROFILE).cloned().expect("the default profile exists"))
}

/// One finding, graded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub code: Code,
    pub severity: Severity,
}

/// What an evaluator found; the profile decides how bad that is.
///
/// The Python's `Flags`. Raising the same code twice is not two findings.
#[derive(Debug, Clone)]
pub struct Flags<'a> {
    profile: &'a Profile,
    raised: Vec<Finding>,
}

impl<'a> Flags<'a> {
    pub fn new(profile: &'a Profile) -> Flags<'a> {
        Flags { profile, raised: Vec::new() }
    }

    pub fn add(&mut self, code: Code) {
        if self.raised.iter().any(|f| f.code == code) {
            return;
        }
        let severity = self.profile.severity(code);
        self.raised.push(Finding { code, severity });
    }

    pub fn any(&self) -> bool {
        !self.raised.is_empty()
    }

    pub fn findings(&self) -> &[Finding] {
        &self.raised
    }

    /// The verdict these findings add up to.
    pub fn status(&self) -> Status {
        if self.raised.iter().any(|f| f.severity == Severity::Action) {
            Status::Attention
        } else if self.raised.is_empty() {
            Status::Pass
        } else {
            Status::Advisory
        }
    }

    pub fn into_findings(self) -> Vec<Finding> {
        self.raised
    }
}

/// A table under a check: what was actually seen, so a verdict can be argued
/// with rather than taken on trust.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub label: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

/// One check's result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Eval {
    pub status: Status,
    pub summary: String,
    #[serde(default)]
    pub observations: Vec<String>,
    #[serde(default)]
    pub details: Vec<Detail>,
    /// What to do about it, as numbered steps.
    ///
    /// One sentence of advice is a verdict with a suggestion attached; a
    /// numbered list is something an engineer can work through on site. "Re-seat
    /// both ends of the patch lead, clear the counters, then watch for an hour"
    /// is the difference, and it is the whole reason his report is useful and a
    /// list of verdicts is not.
    #[serde(default)]
    pub steps: Vec<String>,
    #[serde(default)]
    pub findings: Vec<Finding>,
}

impl Eval {
    pub fn pass(summary: impl Into<String>) -> Eval {
        Eval { status: Status::Pass, summary: summary.into(), observations: Vec::new(), details: Vec::new(), steps: Vec::new(), findings: Vec::new() }
    }

    /// The API returned nothing for this item.
    pub fn manual(summary: impl Into<String>) -> Eval {
        Eval { status: Status::Manual, summary: summary.into(), observations: Vec::new(), details: Vec::new(), steps: vec![MANUAL_HINT.into()], findings: Vec::new() }
    }

    /// The check does not apply to this network.
    pub fn na(summary: impl Into<String>) -> Eval {
        Eval { status: Status::Na, summary: summary.into(), observations: Vec::new(), details: Vec::new(), steps: Vec::new(), findings: Vec::new() }
    }

    /// Graded from what an evaluator raised.
    pub fn graded(flags: Flags<'_>, summary: impl Into<String>) -> Eval {
        Eval {
            status: flags.status(),
            summary: summary.into(),
            observations: Vec::new(),
            details: Vec::new(),
            steps: Vec::new(),
            findings: flags.into_findings(),
        }
    }

    pub fn saying(mut self, observation: impl Into<String>) -> Eval {
        self.observations.push(observation.into());
        self
    }

    pub fn showing(mut self, detail: Detail) -> Eval {
        self.details.push(detail);
        self
    }

    /// The numbered steps for putting it right.
    pub fn to_do(mut self, steps: &[&str]) -> Eval {
        self.steps = steps.iter().map(|s| s.to_string()).collect();
        self
    }
}

/// Which part of the estate a check belongs to.
///
/// His document is three checklists, not one flat list, and a reader looks for
/// "the switch findings" as a group. The section is part of the item's
/// identity, not decoration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Section {
    Firewall,
    Wireless,
    Switching,
}

impl Section {
    pub fn title(self) -> &'static str {
        match self {
            Section::Firewall => "Firewall (MX) Health Check",
            Section::Wireless => "Wireless Health Check",
            Section::Switching => "Switch Health Check",
        }
    }

    pub fn all() -> &'static [Section] {
        &[Section::Firewall, Section::Wireless, Section::Switching]
    }
}

/// One check in the report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub id: String,
    pub section: Section,
    pub num: String,
    pub title: String,
    /// Where in the Meraki dashboard this is visible.
    pub navigation: String,
    /// What this item covers, in the words of the checklist it comes from.
    ///
    /// Printed **before** the verdict. A reader who can see what was assessed
    /// can tell the difference between "this was checked and is fine" and
    /// "this was never looked at", which a verdict alone cannot say.
    pub checklist: Vec<String>,
    #[serde(flatten)]
    pub eval: Eval,
}

/// A whole report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub taken_at: String,
    pub organization: String,
    pub network: String,
    pub profile: Profile,
    pub checks: Vec<CheckResult>,
    /// What data the report is built from, and over what window.
    pub data_windows: String,
}

/// What the report was built from, said once so a reader knows what "now"
/// means for each number.
pub const DATA_WINDOWS: &str =
    "settings as they are now; clients, wireless health and port counters over 24 hours; \
     security events and application traffic over 7 days; the most recent event log entries.";

impl Report {
    /// How many checks landed on each verdict, in [`Status::order`].
    pub fn tally(&self) -> Vec<(Status, usize)> {
        Status::order()
            .iter()
            .map(|&s| (s, self.checks.iter().filter(|c| c.eval.status == s).count()))
            .collect()
    }

    /// Every finding graded as an action, with the check it came from. The
    /// action items table.
    pub fn action_items(&self) -> Vec<(&CheckResult, &Finding)> {
        self.checks
            .iter()
            .flat_map(|c| c.eval.findings.iter().filter(|f| f.severity == Severity::Action).map(move |f| (c, f)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_belongs_to_exactly_one_group() {
        // The Python keeps three lists and concatenates them, so a code in two
        // of them would grade twice and a code in none would grade as the
        // default silently. Here the compiler settles it — this checks the
        // lists agree with the enum.
        let all = Code::all();
        assert_eq!(all.len(), 37, "a code was added to the enum and not to all()");
        let mut sorted = all.to_vec();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), all.len(), "a code is listed twice in all()");
        assert_eq!(all.iter().filter(|c| c.group() == Group::Fault).count(), 16);
        assert_eq!(all.iter().filter(|c| c.group() == Group::Posture).count(), 7);
        assert_eq!(all.iter().filter(|c| c.group() == Group::Operations).count(), 14);
    }

    #[test]
    fn the_two_spellings_of_a_code_agree() {
        // `as_str` is written out by hand and serde renames are written out
        // again above it. One of them drifting would put a code in a saved
        // report under a name nothing else knows.
        for &code in Code::all() {
            let via_serde = serde_json::to_value(code).expect("serialises");
            assert_eq!(
                via_serde.as_str(),
                Some(code.as_str()),
                "as_str and the serde name disagree for {code:?}",
            );
        }
    }

    #[test]
    fn a_code_is_written_the_way_his_script_writes_it() {
        // These strings end up in saved reports and are the contract with the
        // script that inspired them.
        assert_eq!(Code::IdsNotPrevention.as_str(), "ids.not_prevention");
        assert_eq!(Code::WifiHighChannelUtil.as_str(), "wifi.high_channel_util");
        assert_eq!(Code::LicenceExpiring.as_str(), "licence.expiring");
    }

    #[test]
    fn the_same_finding_is_graded_differently_for_a_church_and_an_enclave() {
        // The reason the whole profile mechanism exists.
        let smb = profile("smb");
        let regulated = profile("regulated");
        assert_eq!(smb.severity(Code::IdsDisabled), Severity::Advisory);
        assert_eq!(regulated.severity(Code::IdsDisabled), Severity::Action);
        // A fault is urgent everywhere.
        assert_eq!(smb.severity(Code::UplinkDown), Severity::Action);
        assert_eq!(regulated.severity(Code::UplinkDown), Severity::Action);
    }

    #[test]
    fn education_and_healthcare_add_what_their_sector_is_judged_on() {
        let education = profile("education");
        // A funding condition, so an action here and not at an SMB.
        assert_eq!(education.severity(Code::CfNoCategories), Severity::Action);
        assert_eq!(profile("smb").severity(Code::CfNoCategories), Severity::Advisory);
        // But education does not demand active prevention; healthcare does.
        assert_eq!(education.severity(Code::IdsNotPrevention), Severity::Advisory);
        assert_eq!(profile("healthcare").severity(Code::IdsNotPrevention), Severity::Action);
    }

    #[test]
    fn an_unknown_profile_falls_back_rather_than_failing() {
        assert_eq!(profile("").id, DEFAULT_PROFILE);
        assert_eq!(profile("nonsense").id, DEFAULT_PROFILE);
        // And it is forgiving about how it was typed.
        assert_eq!(profile("  Healthcare ").id, "healthcare");
    }

    #[test]
    fn the_thresholds_tighten_as_the_bar_rises() {
        let (smb, edu, hc, reg) = (profile("smb"), profile("education"), profile("healthcare"), profile("regulated"));
        let latency: Vec<f64> = [&smb, &edu, &hc, &reg].iter().map(|p| p.thresholds.latency_ms).collect();
        assert_eq!(latency, vec![250.0, 200.0, 150.0, 120.0]);
        // And the licence warning gets earlier, not later.
        assert!(reg.thresholds.licence_days > smb.thresholds.licence_days);
    }

    #[test]
    fn raising_the_same_code_twice_is_one_finding() {
        let p = profile("smb");
        let mut flags = Flags::new(&p);
        flags.add(Code::UplinkDown);
        flags.add(Code::UplinkDown);
        assert_eq!(flags.findings().len(), 1);
        assert_eq!(flags.status(), Status::Attention);
    }

    #[test]
    fn an_advisory_alone_is_not_attention() {
        let p = profile("smb");
        let mut flags = Flags::new(&p);
        assert_eq!(flags.status(), Status::Pass, "nothing raised is a pass");
        flags.add(Code::IdsDisabled);
        assert_eq!(flags.status(), Status::Advisory, "an advisory does not become an action");
        flags.add(Code::UplinkDown);
        assert_eq!(flags.status(), Status::Attention, "one action decides it");
    }

    #[test]
    fn not_reported_is_a_statement_about_the_reading_not_a_chore() {
        let e = Eval::manual("Content filtering could not be read.");
        assert_eq!(e.status, Status::Manual);
        assert_eq!(e.status.label(), "Not reported");
        assert_eq!(e.steps, vec![MANUAL_HINT.to_string()]);
        assert!(e.findings.is_empty(), "nothing was found, so nothing is graded");
    }

    fn report_with(checks: Vec<CheckResult>) -> Report {
        Report {
            taken_at: "2026-09-23T00:00:00Z".into(),
            organization: "Example".into(),
            network: "Site".into(),
            profile: profile("smb"),
            checks,
            data_windows: DATA_WINDOWS.into(),
        }
    }

    fn check(id: &str, eval: Eval) -> CheckResult {
        CheckResult {
            id: id.into(),
            section: Section::Firewall,
            num: "1".into(),
            title: id.into(),
            navigation: "Dashboard".into(),
            checklist: Vec::new(),
            eval,
        }
    }

    #[test]
    fn a_report_counts_its_verdicts_and_lists_only_the_actions() {
        let p = profile("smb");
        let mut attention = Flags::new(&p);
        attention.add(Code::UplinkDown);
        let mut advisory = Flags::new(&p);
        advisory.add(Code::IdsDisabled);

        let report = report_with(vec![
            check("a", Eval::graded(attention, "An uplink is down.")),
            check("b", Eval::graded(advisory, "IDS is off.")),
            check("c", Eval::pass("Nothing wrong here.")),
            check("d", Eval::manual("Not returned.")),
        ]);

        assert_eq!(
            report.tally(),
            vec![(Status::Attention, 1), (Status::Advisory, 1), (Status::Manual, 1), (Status::Pass, 1), (Status::Na, 0)],
        );
        // The advisory is reported, but it is not an action item.
        let actions = report.action_items();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].1.code, Code::UplinkDown);
    }

    #[test]
    fn the_same_network_read_under_two_profiles_differs_only_in_grading() {
        // Nothing is hidden; it is ranked. The observation is identical.
        let summary = "IDS is in detection mode.";
        let smb = profile("smb");
        let reg = profile("regulated");

        let mut a = Flags::new(&smb);
        a.add(Code::IdsNotPrevention);
        let mut b = Flags::new(&reg);
        b.add(Code::IdsNotPrevention);

        let under_smb = Eval::graded(a, summary);
        let under_regulated = Eval::graded(b, summary);

        assert_eq!(under_smb.summary, under_regulated.summary, "the finding text must not move");
        assert_eq!(under_smb.status, Status::Advisory);
        assert_eq!(under_regulated.status, Status::Attention);
    }
}
