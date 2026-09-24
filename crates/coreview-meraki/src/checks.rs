//! The checks themselves (LT-406).
//!
//! Every evaluator takes what was collected and a profile, and returns an
//! [`Eval`]. **No evaluator decides urgency** — it raises a [`Code`] and the
//! profile grades it. That separation is the whole design, taken from his
//! script, and it is what lets the same network be read for a small business
//! and for a regulated environment without changing a word of the findings.
//!
//! **Three rules every evaluator here obeys:**
//!
//! 1. **Not read is not "none found".** Where the collection came back `None`,
//!    the verdict is [`Status::Manual`] — "Not reported" — never a pass. A
//!    report that grades an unread endpoint as healthy is worse than no
//!    report, because it will be believed.
//! 2. **Not applicable is its own answer.** A network with no appliance has no
//!    firewall rules, and that is [`Status::Na`], not a gap.
//! 3. **Every verdict shows its evidence.** A finding carries the rows it was
//!    drawn from, so a reader can disagree with it.

use serde_json::Value;

use crate::api::DeviceKind;
use crate::collect::Collected;
use crate::health::{CheckResult, Code, Detail, Eval, Flags, Profile, Report, DATA_WINDOWS};

/// A cell, with the same em dash his script uses for "nothing here".
fn s(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "—".into(),
        Some(Value::String(t)) if t.is_empty() => "—".into(),
        Some(Value::String(t)) => t.clone(),
        Some(other) => other.to_string(),
    }
}

fn field(v: &Value, name: &str) -> String {
    s(v.get(name))
}

fn num(v: &Value, name: &str) -> Option<f64> {
    v.get(name).and_then(|x| x.as_f64())
}

fn truthy(v: Option<&Value>, name: &str) -> Option<bool> {
    v?.get(name)?.as_bool()
}

fn plural(n: usize, one: &str) -> String {
    if n == 1 {
        format!("{n} {one}")
    } else {
        format!("{n} {one}s")
    }
}

fn array(v: Option<&Value>) -> Vec<&Value> {
    v.and_then(|x| x.as_array()).map(|a| a.iter().collect()).unwrap_or_default()
}

fn detail(label: &str, columns: &[&str], rows: Vec<Vec<String>>) -> Detail {
    Detail {
        label: label.into(),
        columns: columns.iter().map(|c| c.to_string()).collect(),
        rows,
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Faults
// ═══════════════════════════════════════════════════════════════════════════

/// Are the devices up?
fn device_status(c: &Collected, p: &Profile) -> Eval {
    if c.statuses.is_empty() {
        return Eval::manual("Device statuses were not returned for this organisation.");
    }
    let mut flags = Flags::new(p);
    let mut rows = Vec::new();
    for (kind, code, what) in [
        (DeviceKind::Appliance, Code::DeviceApplianceOffline, "appliance"),
        (DeviceKind::Wireless, Code::DeviceApOffline, "access point"),
        (DeviceKind::Switch, Code::DeviceSwitchOffline, "switch"),
    ] {
        let down = c.offline(kind);
        if !down.is_empty() {
            flags.add(code);
            for d in &down {
                rows.push(vec![
                    what.into(),
                    d.name.clone().unwrap_or_else(|| d.serial.clone()),
                    d.model.clone().unwrap_or_else(|| "—".into()),
                    c.status_of(&d.serial).unwrap_or("—").into(),
                ]);
            }
        }
    }

    let total = c.devices.len();
    let summary = if flags.any() {
        format!("{} of {} not online.", plural(rows.len(), "device"), total)
    } else {
        format!("All {} reporting online.", plural(total, "device"))
    };
    let mut eval = Eval::graded(flags, summary);
    if !rows.is_empty() {
        eval = eval.showing(detail("Devices not online", &["Kind", "Name", "Model", "Status"], rows));
        eval = eval.to_do("Check power and upstream connectivity for each device listed.");
    }
    eval
}

/// Are the WAN uplinks up, and are they healthy?
fn uplinks(c: &Collected, p: &Profile) -> Eval {
    let Some(statuses) = c.uplink_statuses.as_ref() else {
        return if c.network.as_ref().is_some_and(|n| n.has("appliance")) {
            Eval::manual("Uplink statuses were not returned.")
        } else {
            Eval::na("No appliance in this network.")
        };
    };

    let mine = c.for_this_network(statuses);
    if mine.is_empty() {
        return Eval::manual("No uplink status rows for this network.");
    }

    let mut flags = Flags::new(p);
    let mut rows = Vec::new();
    for row in &mine {
        for uplink in array(row.get("uplinks")) {
            let status = field(uplink, "status");
            let interface = field(uplink, "interface");
            if !status.eq_ignore_ascii_case("active") && !status.eq_ignore_ascii_case("ready") {
                flags.add(Code::UplinkDown);
            }
            rows.push(vec![interface, status, field(uplink, "ip"), field(uplink, "gateway")]);
        }
    }

    // Loss and latency, judged against the profile rather than a fixed bar.
    let mut degraded = Vec::new();
    for row in array(c.loss_and_latency.as_ref()) {
        let loss = num(row, "lossPercent").unwrap_or(0.0);
        let latency = num(row, "latencyMs").unwrap_or(0.0);
        if loss > p.thresholds.loss_pct || latency > p.thresholds.latency_ms {
            flags.add(Code::UplinkDegraded);
            degraded.push(vec![
                field(row, "serial"),
                field(row, "ip"),
                format!("{loss:.1}%"),
                format!("{latency:.0} ms"),
            ]);
        }
    }

    let summary = if flags.any() {
        "One or more uplinks are down or performing below this profile's bar.".to_string()
    } else {
        format!("{} reporting normally.", plural(rows.len(), "uplink"))
    };
    let mut eval = Eval::graded(flags, summary)
        .showing(detail("Uplinks", &["Interface", "Status", "Address", "Gateway"], rows));
    if !degraded.is_empty() {
        eval = eval
            .saying(format!(
                "Judged against {}: loss over {}%, latency over {} ms.",
                p.label, p.thresholds.loss_pct, p.thresholds.latency_ms
            ))
            .showing(detail("Below the bar", &["Serial", "Address", "Loss", "Latency"], degraded));
    }
    eval
}

/// Are the VPN peers reachable?
fn vpn(c: &Collected, p: &Profile) -> Eval {
    let Some(statuses) = c.vpn_statuses.as_ref() else {
        return if c.network.as_ref().is_some_and(|n| n.has("appliance")) {
            Eval::manual("VPN statuses were not returned.")
        } else {
            Eval::na("No appliance in this network.")
        };
    };
    let mine = c.for_this_network(statuses);
    if mine.is_empty() {
        return Eval::na("This network is not in a site-to-site VPN.");
    }

    let mut flags = Flags::new(p);
    let mut rows = Vec::new();
    for row in &mine {
        for peer in array(row.get("merakiVpnPeers")).into_iter().chain(array(row.get("thirdPartyVpnPeers"))) {
            let reachability = field(peer, "reachability");
            if !reachability.eq_ignore_ascii_case("reachable") {
                flags.add(Code::VpnPeerUnreachable);
            }
            rows.push(vec![field(peer, "networkName"), reachability]);
        }
    }

    let unreachable = rows.iter().filter(|r| !r[1].eq_ignore_ascii_case("reachable")).count();
    let summary = if unreachable > 0 {
        format!("{} not reachable.", plural(unreachable, "VPN peer"))
    } else {
        format!("All {} reachable.", plural(rows.len(), "VPN peer"))
    };
    Eval::graded(flags, summary).showing(detail("VPN peers", &["Peer", "Reachability"], rows))
}

/// Licensing — is it in order, and is it about to stop being?
fn licensing(c: &Collected, p: &Profile) -> Eval {
    let Some(overview) = c.licenses.as_ref() else {
        return Eval::manual("The licence overview was not returned.");
    };
    let mut flags = Flags::new(p);
    let status = field(overview, "status");
    if !status.is_empty() && !status.eq_ignore_ascii_case("OK") && status != "—" {
        flags.add(Code::LicenceStatusNotOk);
    }
    // The overview reports a date, not a count of days: "Nov 8, 2026 UTC".
    let expiry = overview.get("expirationDate").and_then(|v| v.as_str());
    let remaining = expiry.and_then(days_until_today);
    if let Some(days) = remaining {
        if (days as f64) < p.thresholds.licence_days {
            flags.add(Code::LicenceExpiring);
        }
    }

    let mut rows = vec![vec!["Status".into(), status.clone()]];
    if let Some(e) = expiry {
        rows.push(vec!["Expires".into(), e.to_string()]);
    }
    if let Some(days) = remaining {
        rows.push(vec!["Days remaining".into(), days.to_string()]);
    }

    let summary = match (flags.any(), remaining) {
        (false, _) => "Licensing is in order.".to_string(),
        (true, Some(days)) if days < 0 => format!("Licensing expired {} ago.", plural((-days) as usize, "day")),
        (true, Some(days)) => format!("Licensing reports \"{status}\" and expires in {}.", plural(days as usize, "day")),
        (true, None) => format!("Licensing reports \"{status}\"."),
    };
    let mut eval = Eval::graded(flags, summary).showing(detail("Licensing", &["Field", "Value"], rows));
    if remaining.is_some_and(|d| (d as f64) < p.thresholds.licence_days) {
        eval = eval.saying(format!(
            "This profile warns at {} days.",
            p.thresholds.licence_days
        ));
    }
    eval
}

// ═══════════════════════════════════════════════════════════════════════════
// Posture
// ═══════════════════════════════════════════════════════════════════════════

/// Days from today until a Meraki expiry date, negative once it has passed.
///
/// The overview writes it as `Nov 8, 2026 UTC`. Nothing else in the tree needs
/// a date parser, and carrying `chrono` for one field is not worth it — but
/// guessing is worse, so an unparseable date returns `None` and the check says
/// it could not tell rather than inventing a deadline.
fn days_until_today(text: &str) -> Option<i64> {
    let today = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64
        / 86_400;
    days_until(text, today)
}

/// Split out from [`days_until_today`] so the arithmetic can be tested against
/// a fixed "today" instead of the clock.
fn days_until(text: &str, today_days: i64) -> Option<i64> {
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let cleaned = text.replace(',', " ");
    let mut words = cleaned.split_whitespace();
    let month_word = words.next()?.to_ascii_lowercase();
    let month = MONTHS.iter().position(|m| month_word.starts_with(m))? as i64 + 1;
    let day: i64 = words.next()?.parse().ok()?;
    let year: i64 = words.next()?.parse().ok()?;
    if !(1..=31).contains(&day) || !(1970..=9999).contains(&year) {
        return None;
    }
    Some(days_from_civil(year, month, day) - today_days)
}

/// Days since the Unix epoch for a civil date. Howard Hinnant's algorithm,
/// the same one [`crate::now_iso8601`] runs backwards.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Threat protection: malware scanning and the intrusion engine.
fn threat_protection(c: &Collected, p: &Profile) -> Eval {
    if !c.network.as_ref().is_some_and(|n| n.has("appliance")) {
        return Eval::na("No appliance in this network.");
    }
    if c.malware.is_none() && c.intrusion.is_none() {
        return Eval::manual("Threat protection settings were not returned.");
    }

    let mut flags = Flags::new(p);
    let mut rows = Vec::new();

    match c.malware.as_ref().map(|m| field(m, "mode")) {
        Some(mode) => {
            if !mode.eq_ignore_ascii_case("enabled") {
                flags.add(Code::AmpDisabled);
            }
            rows.push(vec!["Malware protection (AMP)".into(), mode]);
        }
        None => rows.push(vec!["Malware protection (AMP)".into(), "not reported".into()]),
    }

    match c.intrusion.as_ref() {
        Some(i) => {
            let mode = field(i, "mode");
            if mode.eq_ignore_ascii_case("disabled") {
                flags.add(Code::IdsDisabled);
            } else if !mode.eq_ignore_ascii_case("prevention") {
                // Detection mode sees an attack and lets it through. That is a
                // finding everywhere; whether it is urgent is the profile's call.
                flags.add(Code::IdsNotPrevention);
            }
            let ruleset = field(i, "idsRulesets");
            if !mode.eq_ignore_ascii_case("disabled")
                && !ruleset.eq_ignore_ascii_case("security")
                && ruleset != "—"
            {
                flags.add(Code::IdsRulesetNotSecurity);
            }
            rows.push(vec!["Intrusion detection mode".into(), mode]);
            rows.push(vec!["Ruleset".into(), ruleset]);
        }
        None => rows.push(vec!["Intrusion detection".into(), "not reported".into()]),
    }

    let summary = if flags.any() {
        "Threat protection is weaker than this profile's benchmark.".to_string()
    } else {
        "Malware protection and intrusion prevention are both on.".to_string()
    };
    Eval::graded(flags, summary).showing(detail("Threat protection", &["Setting", "Value"], rows))
}

/// What the appliance actually saw, and whether it stopped it.
fn security_events(c: &Collected, p: &Profile) -> Eval {
    if !c.network.as_ref().is_some_and(|n| n.has("appliance")) {
        return Eval::na("No appliance in this network.");
    }
    let Some(events) = c.security_events.as_ref() else {
        return Eval::manual("Security events were not returned.");
    };

    let mut flags = Flags::new(p);
    // `blocked: false` is the interesting one: seen and allowed through.
    let unblocked: Vec<&Value> = events.iter().filter(|e| e.get("blocked").and_then(|b| b.as_bool()) == Some(false)).collect();
    if !unblocked.is_empty() {
        flags.add(Code::ThreatsUnblocked);
    }

    let rows: Vec<Vec<String>> = unblocked
        .iter()
        .take(10)
        .map(|e| {
            vec![
                field(e, "ts").replace('T', " ").chars().take(19).collect(),
                field(e, "eventType"),
                field(e, "message"),
                field(e, "clientName"),
            ]
        })
        .collect();

    let summary = if unblocked.is_empty() {
        format!("{} in the last 7 days, all blocked.", plural(events.len(), "security event"))
    } else {
        format!(
            "{} of {} were not blocked.",
            plural(unblocked.len(), "event"),
            events.len()
        )
    };
    let mut eval = Eval::graded(flags, summary);
    if !rows.is_empty() {
        eval = eval.showing(detail("Not blocked", &["When", "Type", "Message", "Client"], rows));
    }
    eval
}

/// Firewall rules: is there an any/any allow?
fn firewall(c: &Collected, p: &Profile) -> Eval {
    if !c.network.as_ref().is_some_and(|n| n.has("appliance")) {
        return Eval::na("No appliance in this network.");
    }
    let Some(l3) = c.l3_firewall_rules.as_ref() else {
        return Eval::manual("Firewall rules were not returned.");
    };

    let rules = array(l3.get("rules"));
    let mut flags = Flags::new(p);
    let mut rows = Vec::new();
    for rule in &rules {
        let policy = field(rule, "policy");
        let (src, dst) = (field(rule, "srcCidr"), field(rule, "destCidr"));
        let any_any = policy.eq_ignore_ascii_case("allow")
            && (src.eq_ignore_ascii_case("any") || src == "0.0.0.0/0")
            && (dst.eq_ignore_ascii_case("any") || dst == "0.0.0.0/0");
        if any_any {
            flags.add(Code::FwAnyAny);
            rows.push(vec![policy, src, dst, field(rule, "protocol"), field(rule, "comment")]);
        }
    }

    let summary = if rows.is_empty() {
        format!("{} configured, none allowing any to any.", plural(rules.len(), "L3 rule"))
    } else {
        format!("{} allow any source to any destination.", plural(rows.len(), "rule"))
    };
    let mut eval = Eval::graded(flags, summary);
    if !rows.is_empty() {
        eval = eval
            .showing(detail("Any-to-any allows", &["Policy", "Source", "Destination", "Protocol", "Comment"], rows))
            .to_do("Narrow these rules to the sources and destinations that need them.");
    }
    eval
}

/// Content filtering — is anything actually being filtered?
fn content_filtering(c: &Collected, p: &Profile) -> Eval {
    if !c.network.as_ref().is_some_and(|n| n.has("appliance")) {
        return Eval::na("No appliance in this network.");
    }
    let Some(cf) = c.content_filtering.as_ref() else {
        return Eval::manual("Content filtering was not returned.");
    };

    let blocked = array(cf.get("blockedUrlCategories"));
    let patterns = array(cf.get("blockedUrlPatterns"));
    let mut flags = Flags::new(p);
    if blocked.is_empty() {
        flags.add(Code::CfNoCategories);
    }

    let rows = vec![
        vec!["Blocked categories".into(), blocked.len().to_string()],
        vec!["Blocked URL patterns".into(), patterns.len().to_string()],
        vec!["Allowed URL patterns".into(), array(cf.get("allowedUrlPatterns")).len().to_string()],
    ];
    let summary = if blocked.is_empty() {
        "No URL categories are blocked.".to_string()
    } else {
        format!("{} blocked.", plural(blocked.len(), "URL category"))
    };
    Eval::graded(flags, summary).showing(detail("Content filtering", &["Setting", "Count"], rows))
}

// ═══════════════════════════════════════════════════════════════════════════
// Operations
// ═══════════════════════════════════════════════════════════════════════════

/// Alerting: is anyone told when something breaks?
fn alerting(c: &Collected, p: &Profile) -> Eval {
    let Some(settings) = c.alert_settings.as_ref() else {
        return Eval::manual("Alert settings were not returned.");
    };
    let mut flags = Flags::new(p);

    let alerts = array(settings.get("alerts"));
    let enabled: Vec<&&Value> = alerts.iter().filter(|a| truthy(Some(a), "enabled") == Some(true)).collect();
    if enabled.is_empty() {
        flags.add(Code::AlertsMissing);
    }

    // A default recipient list, or any alert carrying its own.
    let defaults = settings.get("defaultDestinations");
    let emails = array(defaults.and_then(|d| d.get("emails")));
    let snmp = truthy(defaults, "snmp") == Some(true);
    let webhooks = array(defaults.and_then(|d| d.get("httpServerIds")));
    let per_alert = alerts.iter().any(|a| !array(a.get("alertDestinations").and_then(|d| d.get("emails"))).is_empty());
    if emails.is_empty() && !snmp && webhooks.is_empty() && !per_alert {
        flags.add(Code::AlertsNoRecipients);
    }

    let rows = vec![
        vec!["Alerts enabled".into(), enabled.len().to_string()],
        vec!["Alerts available".into(), alerts.len().to_string()],
        vec!["Default email recipients".into(), emails.len().to_string()],
        vec!["SNMP destination".into(), if snmp { "yes".into() } else { "no".into() }],
        vec!["Webhook destinations".into(), webhooks.len().to_string()],
    ];
    let summary = if flags.any() {
        "Alerting would not reach anyone.".to_string()
    } else {
        format!("{} enabled, with somewhere to send them.", plural(enabled.len(), "alert"))
    };
    let mut eval = Eval::graded(flags, summary).showing(detail("Alerting", &["Setting", "Value"], rows));
    if flags_had(&eval, Code::AlertsNoRecipients) {
        eval = eval.to_do("Add at least one email recipient, SNMP trap destination or webhook.");
    }
    eval
}

/// Whether a finding was raised, for deciding what to suggest.
fn flags_had(eval: &Eval, code: Code) -> bool {
    eval.findings.iter().any(|f| f.code == code)
}

/// Firmware — is there an upgrade waiting?
fn firmware(c: &Collected, p: &Profile) -> Eval {
    let Some(f) = c.firmware.as_ref() else {
        return Eval::manual("Firmware status was not returned.");
    };
    let mut flags = Flags::new(p);
    let mut rows = Vec::new();

    for product in ["appliance", "wireless", "switch", "camera", "cellularGateway"] {
        let Some(p_obj) = f.get("products").and_then(|v| v.get(product)) else {
            continue;
        };
        let current = p_obj
            .get("currentVersion")
            .map(|v| field(v, "shortName"))
            .unwrap_or_else(|| "—".into());
        let available = array(p_obj.get("availableVersions"));
        // "Available" alone is not news — Meraki always lists some. What
        // matters is a version newer than the one running.
        let newer: Vec<&&Value> = available
            .iter()
            .filter(|v| field(v, "shortName") != current && field(v, "releaseType").eq_ignore_ascii_case("stable"))
            .collect();
        if !newer.is_empty() {
            flags.add(Code::FirmwareUpdateAvailable);
        }
        rows.push(vec![product.into(), current, newer.len().to_string()]);
    }

    if rows.is_empty() {
        return Eval::manual("No firmware information for this network's products.");
    }
    let summary = if flags.any() {
        "A newer stable firmware is available for at least one product.".to_string()
    } else {
        "Every product is on the newest stable firmware offered.".to_string()
    };
    Eval::graded(flags, summary).showing(detail("Firmware", &["Product", "Running", "Newer stable"], rows))
}

/// Traffic analysis — can anyone see what is on the network?
fn traffic_analysis(c: &Collected, p: &Profile) -> Eval {
    let Some(ta) = c.traffic_analysis.as_ref() else {
        return Eval::manual("Traffic analysis settings were not returned.");
    };
    let mode = field(ta, "mode");
    let mut flags = Flags::new(p);
    if mode.eq_ignore_ascii_case("disabled") {
        flags.add(Code::TrafficAnalysisDisabled);
    }
    let summary = match mode.as_str() {
        "disabled" => "Traffic analysis is off, so application visibility is unavailable.".to_string(),
        other => format!("Traffic analysis is set to \"{other}\"."),
    };
    Eval::graded(flags, summary).showing(detail("Traffic analysis", &["Setting", "Value"], vec![vec!["Mode".into(), mode]]))
}

/// Is there a configuration backup of this network?
///
/// **Not in his script, and the one check Coreview can make that a standalone
/// tool cannot** — it knows whether *it* has taken a backup of this network,
/// because LT-405 writes them. A health check that says "no backup" while a
/// backup sits on the same disk would be worse than not asking.
fn backup(c: &Collected, p: &Profile) -> Eval {
    let Some(has) = c.has_backup else {
        return Eval::manual("Coreview did not check for a saved backup of this network.");
    };
    let mut flags = Flags::new(p);
    if !has {
        flags.add(Code::BackupMissing);
    }
    let summary = if has {
        "Coreview holds a configuration backup of this network.".to_string()
    } else {
        "No configuration backup of this network has been taken.".to_string()
    };
    let mut eval = Eval::graded(flags, summary);
    if !has {
        eval = eval.to_do("Run the Meraki backup from Tools · Settings to keep a copy of this network's configuration.");
    }
    eval
}

/// Switch ports: errors, duplex, blocking, a down uplink, and PoE that never
/// came up.
fn switch_ports(c: &Collected, p: &Profile) -> Eval {
    if !c.network.as_ref().is_some_and(|n| n.has("switch")) {
        return Eval::na("No switches in this network.");
    }
    if c.port_statuses.is_empty() {
        return Eval::manual("Port statuses were not returned.");
    }

    let mut flags = Flags::new(p);
    let (mut errors, mut duplex, mut blocked, mut uplinks_down, mut dark) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());

    for (serial, statuses) in &c.port_statuses {
        // The configuration for the same switch, so a port's *intent* can be
        // compared with what it is doing. PoE is the case that needs both.
        let config = c.ports.iter().find(|(s, _)| s == serial).map(|(_, v)| v);
        let poe_enabled = |port_id: &str| -> Option<bool> {
            array(config)
                .into_iter()
                .find(|cfg| field(cfg, "portId") == port_id)
                .and_then(|cfg| cfg.get("poeEnabled").and_then(|v| v.as_bool()))
        };

        for port in array(Some(statuses)) {
            let id = field(port, "portId");
            let status = field(port, "status");
            let connected = status.eq_ignore_ascii_case("Connected");
            let is_uplink = truthy(Some(port), "isUplink") == Some(true);

            // Errors and warnings the switch itself raises.
            let problems = array(port.get("errors"));
            if !problems.is_empty() {
                flags.add(Code::PortErrors);
                errors.push(vec![
                    serial.clone(),
                    id.clone(),
                    problems.iter().map(|e| s(Some(e))).collect::<Vec<_>>().join(", "),
                ]);
            }

            // Half duplex on a switched port is a negotiation that went wrong.
            let dup = field(port, "duplex");
            if dup.eq_ignore_ascii_case("half") {
                flags.add(Code::PortHalfDuplex);
                duplex.push(vec![serial.clone(), id.clone(), dup, field(port, "speed")]);
            }

            // Spanning tree holding a port down.
            let stp_status = port.get("spanningTree").map(|st| field(st, "statuses")).unwrap_or_else(|| "—".into());
            if stp_status.to_ascii_lowercase().contains("blocking") {
                flags.add(Code::PortBlocked);
                blocked.push(vec![serial.clone(), id.clone(), stp_status]);
            }

            // A switch whose uplink is down is worse than a port that is.
            if is_uplink && !connected {
                flags.add(Code::SwitchUplinkDown);
                uplinks_down.push(vec![serial.clone(), id.clone(), status.clone()]);
            }

            // A port set up to power something, with something plugged into
            // it, drawing nothing: the "the access point will not come on"
            // symptom. Both halves are needed — a data port drawing 0 W is
            // simply a data port, and judging on the status alone would report
            // every one of them.
            if connected && !is_uplink && poe_enabled(&id) == Some(true) {
                let draw = port.get("powerUsageInWh").and_then(|v| v.as_f64());
                if draw == Some(0.0) {
                    flags.add(Code::PoeDarkPort);
                    dark.push(vec![serial.clone(), id.clone(), field(port, "clientCount")]);
                }
            }
        }
    }

    let counted: usize = c.port_statuses.iter().map(|(_, v)| array(Some(v)).len()).sum();
    let summary = if flags.any() {
        "Some ports are reporting errors, half duplex, blocking, a down uplink or no PoE draw.".to_string()
    } else {
        format!("{} across {} reporting normally.", plural(counted, "port"), plural(c.port_statuses.len(), "switch"))
    };

    let mut eval = Eval::graded(flags, summary);
    for (label, columns, rows) in [
        ("Ports reporting errors", vec!["Switch", "Port", "Errors"], errors),
        ("Half duplex", vec!["Switch", "Port", "Duplex", "Speed"], duplex),
        ("Blocked by spanning tree", vec!["Switch", "Port", "State"], blocked),
        ("Uplink ports not connected", vec!["Switch", "Port", "Status"], uplinks_down),
        ("PoE ports drawing nothing", vec!["Switch", "Port", "Clients"], dark),
    ] {
        if !rows.is_empty() {
            eval = eval.showing(detail(label, &columns, rows));
        }
    }
    eval
}

/// Stacks: is every member present?
fn stacks(c: &Collected, p: &Profile) -> Eval {
    if !c.network.as_ref().is_some_and(|n| n.has("switch")) {
        return Eval::na("No switches in this network.");
    }
    let Some(stacks) = c.stacks.as_ref() else {
        return Eval::manual("Switch stacks were not returned.");
    };
    let list = array(Some(stacks));
    if list.is_empty() {
        return Eval::na("No switch stacks in this network.");
    }

    let mut flags = Flags::new(p);
    let mut rows = Vec::new();
    for stack in &list {
        for serial in array(stack.get("serials")) {
            let serial = s(Some(serial));
            let status = c.status_of(&serial).unwrap_or("not reported");
            if !status.eq_ignore_ascii_case("online") {
                flags.add(Code::SwitchStackMemberDown);
            }
            rows.push(vec![field(stack, "name"), serial, status.into()]);
        }
    }

    let summary = if flags.any() {
        "A stack member is not online.".to_string()
    } else {
        format!("{}, every member online.", plural(list.len(), "stack"))
    };
    Eval::graded(flags, summary).showing(detail("Stack members", &["Stack", "Serial", "Status"], rows))
}

/// Spanning tree: is RSTP on, and is the topology settled?
fn spanning_tree(c: &Collected, p: &Profile) -> Eval {
    if !c.network.as_ref().is_some_and(|n| n.has("switch")) {
        return Eval::na("No switches in this network.");
    }
    let Some(stp) = c.stp.as_ref() else {
        return Eval::manual("Spanning tree settings were not returned.");
    };

    let mut flags = Flags::new(p);
    let rstp = truthy(Some(stp), "rstpEnabled");
    if rstp == Some(false) {
        flags.add(Code::StpRstpDisabled);
    }

    // A topology that keeps recalculating is a loop or a flapping link.
    let noisy = c
        .events_for("switch")
        .iter()
        .filter(|e| {
            let t = format!("{} {}", field(e, "type"), field(e, "description")).to_ascii_lowercase();
            t.contains("stp") || t.contains("spanning") || t.contains("root")
        })
        .count();
    if noisy as f64 > p.thresholds.stp_event_count {
        flags.add(Code::StpNoisy);
    }

    let rows = vec![
        vec!["RSTP".into(), match rstp { Some(true) => "enabled".into(), Some(false) => "disabled".into(), None => "not reported".into() }],
        vec!["Spanning tree events in the log".into(), noisy.to_string()],
    ];
    let summary = if flags.any() {
        "Spanning tree is either disabled or recalculating more than this profile allows.".to_string()
    } else {
        "RSTP is on and the topology is quiet.".to_string()
    };
    Eval::graded(flags, summary).showing(detail("Spanning tree", &["Setting", "Value"], rows))
}

/// Layer-two topology: any link the dashboard itself calls broken.
fn topology(c: &Collected, p: &Profile) -> Eval {
    let Some(t) = c.topology.as_ref() else {
        return Eval::manual("The link-layer topology was not returned.");
    };
    let links = array(t.get("links"));
    if links.is_empty() {
        return Eval::manual("The topology returned no links.");
    }

    let mut flags = Flags::new(p);
    let mut rows = Vec::new();
    for link in &links {
        // Meraki marks a link it can see but cannot confirm.
        let last_reported = field(link, "lastReportedAt");
        let ends = array(link.get("ends"));
        let broken = ends.iter().any(|e| {
            e.get("node")
                .map(|n| field(n, "derivedId").is_empty() || field(n, "type").eq_ignore_ascii_case("unknown"))
                .unwrap_or(false)
        });
        if broken {
            flags.add(Code::TopologyBrokenLink);
            rows.push(vec![
                ends.first().map(|e| field(e, "nodeId")).unwrap_or_else(|| "—".into()),
                ends.get(1).map(|e| field(e, "nodeId")).unwrap_or_else(|| "—".into()),
                last_reported,
            ]);
        }
    }

    let summary = if rows.is_empty() {
        format!("{} mapped, all resolving to known devices.", plural(links.len(), "link"))
    } else {
        format!("{} ending in a device the dashboard cannot identify.", plural(rows.len(), "link"))
    };
    let mut eval = Eval::graded(flags, summary);
    if !rows.is_empty() {
        eval = eval.showing(detail("Unresolved links", &["End", "End", "Last reported"], rows));
    }
    eval
}

/// What the event log says happened: reboots, failovers, power, 802.1X.
fn event_log(c: &Collected, p: &Profile) -> Eval {
    if c.events.is_empty() {
        return Eval::manual("The event log was not returned.");
    }
    let mut flags = Flags::new(p);
    let all: Vec<&Value> = c.events.iter().flat_map(|(_, e)| e.iter()).collect();

    let matching = |needles: &[&str]| -> Vec<&Value> {
        all.iter()
            .copied()
            .filter(|e| {
                let text = format!("{} {} {}", field(e, "type"), field(e, "description"), field(e, "category"))
                    .to_ascii_lowercase();
                needles.iter().any(|n| text.contains(n))
            })
            .collect()
    };

    let reboots = matching(&["reboot", "restart", "failover", "vrrp"]);
    if !reboots.is_empty() {
        flags.add(Code::EventsRebootFailover);
    }
    let power = matching(&["power", "psu", "ac_power", "poe overload"]);
    if !power.is_empty() {
        flags.add(Code::EventsPower);
    }
    let dot1x = matching(&["8021x", "802.1x", "dot1x", "radius"]);
    let denied: Vec<&&Value> = dot1x
        .iter()
        .filter(|e| {
            let text = format!("{} {}", field(e, "type"), field(e, "description")).to_ascii_lowercase();
            text.contains("deny") || text.contains("denied") || text.contains("fail")
        })
        .collect();
    if !denied.is_empty() {
        flags.add(Code::Dot1xDenied);
    }

    let rows = |list: &[&Value]| -> Vec<Vec<String>> {
        list.iter()
            .take(8)
            .map(|e| {
                vec![
                    field(e, "occurredAt").replace('T', " ").chars().take(19).collect(),
                    field(e, "type"),
                    field(e, "description"),
                    field(e, "deviceName"),
                ]
            })
            .collect()
    };

    let summary = if flags.any() {
        "The event log records reboots, power events or authentication failures.".to_string()
    } else {
        format!("{} read, nothing notable.", plural(all.len(), "event"))
    };
    let columns = ["When", "Type", "Description", "Device"];
    let mut eval = Eval::graded(flags, summary);
    for (label, list) in [("Reboots and failovers", &reboots), ("Power events", &power)] {
        if !list.is_empty() {
            eval = eval.showing(detail(label, &columns, rows(list)));
        }
    }
    if !denied.is_empty() {
        let d: Vec<&Value> = denied.iter().map(|e| **e).collect();
        eval = eval.showing(detail("802.1X denials", &columns, rows(&d)));
    }
    eval
}

/// Wireless health: are clients getting on, and staying on?
fn wireless_health(c: &Collected, p: &Profile) -> Eval {
    if !c.network.as_ref().is_some_and(|n| n.has("wireless")) {
        return Eval::na("No wireless in this network.");
    }
    let Some(stats) = c.connection_stats.as_ref() else {
        return Eval::manual("Wireless connection statistics were not returned.");
    };

    let assoc = num(stats, "assoc").unwrap_or(0.0);
    let auth = num(stats, "auth").unwrap_or(0.0);
    let dhcp = num(stats, "dhcp").unwrap_or(0.0);
    let dns = num(stats, "dns").unwrap_or(0.0);
    let success = num(stats, "success").unwrap_or(0.0);
    let failures = assoc + auth + dhcp + dns;
    let total = failures + success;

    let mut flags = Flags::new(p);
    let fail_pct = if total > 0.0 { failures / total * 100.0 } else { 0.0 };
    if total > 0.0 && fail_pct > p.thresholds.wifi_fail_pct {
        flags.add(Code::WifiConnFailures);
    }

    // One client failing repeatedly is a different problem from many clients
    // failing once, and the fix is different too.
    let repeat: Vec<&Value> = array(c.client_connection_stats.as_ref())
        .into_iter()
        .filter(|cl| {
            let f = num(cl, "assoc").unwrap_or(0.0)
                + num(cl, "auth").unwrap_or(0.0)
                + num(cl, "dhcp").unwrap_or(0.0)
                + num(cl, "dns").unwrap_or(0.0);
            f > p.thresholds.client_fail_count
        })
        .collect();
    if !repeat.is_empty() {
        flags.add(Code::WifiClientRepeatFailures);
    }

    let rows = vec![
        vec!["Successful connections".into(), format!("{success:.0}")],
        vec!["Association failures".into(), format!("{assoc:.0}")],
        vec!["Authentication failures".into(), format!("{auth:.0}")],
        vec!["DHCP failures".into(), format!("{dhcp:.0}")],
        vec!["DNS failures".into(), format!("{dns:.0}")],
        vec!["Failure rate".into(), format!("{fail_pct:.1}%")],
    ];
    let summary = if flags.any() {
        format!("{fail_pct:.1}% of connection attempts failed over 24 hours.")
    } else if total == 0.0 {
        "No wireless connection attempts were recorded in the last 24 hours.".to_string()
    } else {
        format!("{fail_pct:.1}% of connection attempts failed, within this profile's bar.")
    };

    let mut eval = Eval::graded(flags, summary)
        .saying(format!("This profile's bar is {}%.", p.thresholds.wifi_fail_pct))
        .showing(detail("Connections over 24 hours", &["Measure", "Value"], rows));
    if !repeat.is_empty() {
        let client_rows: Vec<Vec<String>> = repeat
            .iter()
            .take(10)
            .map(|cl| {
                vec![
                    field(cl, "mac"),
                    format!("{:.0}", num(cl, "assoc").unwrap_or(0.0)),
                    format!("{:.0}", num(cl, "auth").unwrap_or(0.0)),
                    format!("{:.0}", num(cl, "dhcp").unwrap_or(0.0)),
                    format!("{:.0}", num(cl, "dns").unwrap_or(0.0)),
                ]
            })
            .collect();
        eval = eval.showing(detail("Clients failing repeatedly", &["Client", "Assoc", "Auth", "DHCP", "DNS"], client_rows));
    }
    eval
}

/// The air itself: how busy, and how much of it is not Wi-Fi.
fn radio_environment(c: &Collected, p: &Profile) -> Eval {
    if !c.network.as_ref().is_some_and(|n| n.has("wireless")) {
        return Eval::na("No wireless in this network.");
    }
    let Some(util) = c.channel_utilization.as_ref() else {
        return Eval::manual("Channel utilisation was not returned.");
    };

    let mut flags = Flags::new(p);
    let mut rows = Vec::new();
    let mut worst_total: f64 = 0.0;
    let mut worst_non_wifi: f64 = 0.0;

    for ap in array(Some(util)) {
        for band in ["wifi0", "wifi1"] {
            for sample in array(ap.get(band)) {
                let total = num(sample, "utilization").unwrap_or(0.0);
                let non_wifi = num(sample, "nonWifi").unwrap_or(0.0);
                worst_total = worst_total.max(total);
                worst_non_wifi = worst_non_wifi.max(non_wifi);
            }
        }
        rows.push(vec![field(ap, "serial"), format!("{worst_total:.0}%"), format!("{worst_non_wifi:.0}%")]);
    }

    if worst_total > p.thresholds.chan_util_pct {
        flags.add(Code::WifiHighChannelUtil);
    }
    // Interference that is not Wi-Fi cannot be fixed by changing channel width
    // or adding APs, which is why it is its own finding.
    if worst_non_wifi > p.thresholds.non_wifi_pct {
        flags.add(Code::WifiRfInterference);
    }

    let summary = if flags.any() {
        format!("Channel utilisation peaks at {worst_total:.0}%, of which {worst_non_wifi:.0}% is not Wi-Fi.")
    } else {
        format!("Channel utilisation peaks at {worst_total:.0}%, within this profile's bar.")
    };
    Eval::graded(flags, summary)
        .saying(format!(
            "This profile's bars are {}% total and {}% non-Wi-Fi.",
            p.thresholds.chan_util_pct, p.thresholds.non_wifi_pct
        ))
        .showing(detail("Busiest sample per access point", &["Access point", "Peak", "Not Wi-Fi"], rows))
}

/// Signal: are clients actually in range of something?
fn signal(c: &Collected, p: &Profile) -> Eval {
    if !c.network.as_ref().is_some_and(|n| n.has("wireless")) {
        return Eval::na("No wireless in this network.");
    }
    let Some(history) = c.signal_quality.as_ref() else {
        return Eval::manual("Signal quality history was not returned.");
    };

    let samples = array(Some(history));
    if samples.is_empty() {
        return Eval::manual("Signal quality history returned no samples.");
    }

    let mut flags = Flags::new(p);
    let rssi: Vec<f64> = samples.iter().filter_map(|s| num(s, "rssi")).collect();
    let snr: Vec<f64> = samples.iter().filter_map(|s| num(s, "snr")).collect();
    let mean = |v: &[f64]| if v.is_empty() { None } else { Some(v.iter().sum::<f64>() / v.len() as f64) };

    // −67 dBm is the roaming target the checklist is written against.
    const ROAMING_TARGET_DBM: f64 = -67.0;
    if let Some(avg) = mean(&rssi) {
        if avg < ROAMING_TARGET_DBM {
            flags.add(Code::WifiWeakSignal);
        }
    }

    let rows = vec![
        vec!["Mean RSSI".into(), mean(&rssi).map(|v| format!("{v:.0} dBm")).unwrap_or_else(|| "—".into())],
        vec!["Mean SNR".into(), mean(&snr).map(|v| format!("{v:.0} dB")).unwrap_or_else(|| "—".into())],
        vec!["Samples".into(), samples.len().to_string()],
    ];
    let summary = match mean(&rssi) {
        Some(avg) if avg < ROAMING_TARGET_DBM => format!("Mean client signal is {avg:.0} dBm, below the −67 dBm roaming target."),
        Some(avg) => format!("Mean client signal is {avg:.0} dBm, at or above the −67 dBm roaming target."),
        None => "No RSSI was reported in the last 24 hours.".to_string(),
    };
    Eval::graded(flags, summary).showing(detail("Signal over 24 hours", &["Measure", "Value"], rows))
}

/// Every check, in the order they are reported.
type Evaluator = fn(&Collected, &Profile) -> Eval;

struct Definition {
    id: &'static str,
    num: &'static str,
    title: &'static str,
    navigation: &'static str,
    run: Evaluator,
}

const CHECKS: &[Definition] = &[
    Definition { id: "device-status", num: "1.1", title: "Device status", navigation: "Organization › Overview", run: device_status },
    Definition { id: "uplinks", num: "1.2", title: "WAN uplinks", navigation: "Security & SD-WAN › Appliance status", run: uplinks },
    Definition { id: "vpn", num: "1.3", title: "Site-to-site VPN", navigation: "Security & SD-WAN › VPN status", run: vpn },
    Definition { id: "licensing", num: "1.4", title: "Licensing", navigation: "Organization › License info", run: licensing },
    Definition { id: "threat-protection", num: "2.1", title: "Threat protection", navigation: "Security & SD-WAN › Threat protection", run: threat_protection },
    Definition { id: "security-events", num: "2.2", title: "Security events", navigation: "Security & SD-WAN › Security center", run: security_events },
    Definition { id: "firewall", num: "2.3", title: "Firewall rules", navigation: "Security & SD-WAN › Firewall", run: firewall },
    Definition { id: "content-filtering", num: "2.4", title: "Content filtering", navigation: "Security & SD-WAN › Content filtering", run: content_filtering },
    Definition { id: "alerting", num: "3.1", title: "Alerting", navigation: "Network-wide › Alerts", run: alerting },
    Definition { id: "firmware", num: "3.2", title: "Firmware", navigation: "Organization › Firmware upgrades", run: firmware },
    Definition { id: "traffic-analysis", num: "3.3", title: "Traffic analysis", navigation: "Network-wide › General", run: traffic_analysis },
    Definition { id: "backup", num: "3.4", title: "Configuration backup", navigation: "Coreview › Tools › Settings", run: backup },
    Definition { id: "switch-ports", num: "4.1", title: "Switch ports", navigation: "Switching › Switch ports", run: switch_ports },
    Definition { id: "stacks", num: "4.2", title: "Switch stacks", navigation: "Switching › Switch stacks", run: stacks },
    Definition { id: "spanning-tree", num: "4.3", title: "Spanning tree", navigation: "Switching › Switch settings", run: spanning_tree },
    Definition { id: "topology", num: "4.4", title: "Topology", navigation: "Network-wide › Topology", run: topology },
    Definition { id: "event-log", num: "4.5", title: "Event log", navigation: "Network-wide › Event log", run: event_log },
    Definition { id: "wireless-health", num: "5.1", title: "Wireless health", navigation: "Wireless › Wireless health", run: wireless_health },
    Definition { id: "radio-environment", num: "5.2", title: "Radio environment", navigation: "Wireless › RF spectrum", run: radio_environment },
    Definition { id: "signal", num: "5.3", title: "Client signal", navigation: "Wireless › Wireless health", run: signal },
];

/// Runs every check against what was collected.
pub fn run(collected: &Collected, profile: &Profile) -> Report {
    let checks = CHECKS
        .iter()
        .map(|d| CheckResult {
            id: d.id.into(),
            num: d.num.into(),
            title: d.title.into(),
            navigation: d.navigation.into(),
            eval: (d.run)(collected, profile),
        })
        .collect();

    Report {
        taken_at: crate::now_iso8601(),
        organization: collected.organization.as_ref().map(|o| o.name.clone()).unwrap_or_default(),
        network: collected.network.as_ref().map(|n| n.name.clone()).unwrap_or_default(),
        profile: profile.clone(),
        checks,
        data_windows: DATA_WINDOWS.into(),
    }
}

/// How many checks there are, for anything that wants to show progress.
pub fn count() -> usize {
    CHECKS.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::Network;
    use crate::health::{profile, Severity, Status};
    use serde_json::json;

    fn network(products: &[&str]) -> Network {
        Network {
            id: "N_1".into(),
            name: "Site".into(),
            product_types: products.iter().map(|p| p.to_string()).collect(),
            organization_id: None,
            time_zone: None,
            tags: Vec::new(),
        }
    }

    fn base(products: &[&str]) -> Collected {
        Collected { network: Some(network(products)), ..Collected::default() }
    }

    fn find<'a>(report: &'a Report, id: &str) -> &'a CheckResult {
        report.checks.iter().find(|c| c.id == id).expect("check exists")
    }

    #[test]
    fn every_check_runs_against_an_empty_network_without_panicking() {
        // A key that can see a network and nothing else is a real situation,
        // and it must produce a report rather than a crash.
        for id in ["smb", "education", "healthcare", "regulated"] {
            let report = run(&base(&[]), &profile(id));
            assert_eq!(report.checks.len(), count());
            // Nothing was read, so nothing may claim to have passed.
            assert!(
                report.checks.iter().all(|c| c.eval.status != Status::Pass),
                "a check passed on no data under {id}",
            );
        }
    }

    #[test]
    fn a_missing_endpoint_is_not_reported_as_healthy() {
        // The rule the whole module is written around.
        let c = base(&["appliance"]);
        let report = run(&c, &profile("regulated"));
        let cf = find(&report, "content-filtering");
        assert_eq!(cf.eval.status, Status::Manual, "unread must not be a pass or a finding");
        assert!(cf.eval.findings.is_empty());
        assert_eq!(cf.eval.status.label(), "Not reported");
    }

    #[test]
    fn a_product_the_network_does_not_have_is_not_applicable() {
        let report = run(&base(&["switch"]), &profile("smb"));
        assert_eq!(find(&report, "firewall").eval.status, Status::Na);
        assert_eq!(find(&report, "wireless-health").eval.status, Status::Na);
        // But the switch checks do apply, and have no data.
        assert_eq!(find(&report, "switch-ports").eval.status, Status::Manual);
    }

    #[test]
    fn an_offline_switch_is_found_and_named() {
        let mut c = base(&["switch"]);
        c.devices = vec![
            serde_json::from_value(json!({"serial": "Q1", "model": "MS120-8", "name": "Closet A"})).unwrap(),
            serde_json::from_value(json!({"serial": "Q2", "model": "MS120-8", "name": "Closet B"})).unwrap(),
        ];
        c.statuses = vec![json!({"serial": "Q1", "status": "online"}), json!({"serial": "Q2", "status": "offline"})];

        let report = run(&c, &profile("smb"));
        let status = find(&report, "device-status");
        assert_eq!(status.eval.status, Status::Attention, "a device down is an action everywhere");
        assert!(status.eval.findings.iter().any(|f| f.code == Code::DeviceSwitchOffline));
        // And it says which one, rather than a count.
        let rows = &status.eval.details[0].rows;
        assert_eq!(rows.len(), 1);
        assert!(rows[0].contains(&"Closet B".to_string()), "{rows:?}");
    }

    #[test]
    fn detection_mode_is_an_advisory_for_a_shop_and_an_action_for_a_clinic() {
        // The same network, read twice. This is the point of profiles.
        let mut c = base(&["appliance"]);
        c.intrusion = Some(json!({"mode": "detection", "idsRulesets": "balanced"}));
        c.malware = Some(json!({"mode": "enabled"}));

        let shop = run(&c, &profile("smb"));
        let clinic = run(&c, &profile("healthcare"));

        let (a, b) = (find(&shop, "threat-protection"), find(&clinic, "threat-protection"));
        assert_eq!(a.eval.summary, b.eval.summary, "the observation must not move");
        assert_eq!(a.eval.status, Status::Advisory);
        assert_eq!(b.eval.status, Status::Attention);
        assert!(a.eval.findings.iter().any(|f| f.code == Code::IdsNotPrevention && f.severity == Severity::Advisory));
        assert!(b.eval.findings.iter().any(|f| f.code == Code::IdsNotPrevention && f.severity == Severity::Action));
    }

    #[test]
    fn an_any_to_any_allow_is_found_however_it_is_spelled() {
        let mut c = base(&["appliance"]);
        c.l3_firewall_rules = Some(json!({"rules": [
            {"policy": "allow", "srcCidr": "Any", "destCidr": "0.0.0.0/0", "protocol": "any", "comment": "temporary"},
            {"policy": "deny",  "srcCidr": "any", "destCidr": "any", "protocol": "any", "comment": "default deny"},
            {"policy": "allow", "srcCidr": "192.0.2.0/24", "destCidr": "any", "protocol": "tcp", "comment": "fine"}
        ]}));
        let report = run(&c, &profile("smb"));
        let fw = find(&report, "firewall");
        assert!(fw.eval.findings.iter().any(|f| f.code == Code::FwAnyAny));
        // Only the one rule, and it is shown.
        assert_eq!(fw.eval.details[0].rows.len(), 1);
        assert!(fw.eval.details[0].rows[0].contains(&"temporary".to_string()));
    }

    #[test]
    fn a_tight_firewall_passes_rather_than_going_quiet() {
        let mut c = base(&["appliance"]);
        c.l3_firewall_rules = Some(json!({"rules": [
            {"policy": "deny", "srcCidr": "any", "destCidr": "any", "protocol": "any", "comment": "default"}
        ]}));
        let fw = find(&run(&c, &profile("regulated")), "firewall").eval.clone();
        assert_eq!(fw.status, Status::Pass);
        assert!(fw.summary.contains("none allowing any to any"), "{}", fw.summary);
    }

    #[test]
    fn alerting_that_reaches_nobody_is_found_even_when_alerts_are_on() {
        // Alerts enabled and no destination is the quiet failure: the
        // dashboard looks configured and nobody is ever told.
        let mut c = base(&["appliance"]);
        c.alert_settings = Some(json!({
            "defaultDestinations": {"emails": [], "snmp": false, "httpServerIds": []},
            "alerts": [{"type": "gatewayDown", "enabled": true, "alertDestinations": {"emails": []}}]
        }));
        let report = run(&c, &profile("smb"));
        let a = find(&report, "alerting");
        assert!(a.eval.findings.iter().any(|f| f.code == Code::AlertsNoRecipients));
        assert!(!a.eval.findings.iter().any(|f| f.code == Code::AlertsMissing), "alerts are enabled");
        assert!(a.eval.action.is_some(), "it should say what to do");
    }

    #[test]
    fn firmware_only_counts_a_version_newer_than_the_one_running() {
        // Meraki always lists available versions, including the running one.
        // Counting them all would report every network as out of date.
        let mut c = base(&["switch"]);
        c.firmware = Some(json!({"products": {"switch": {
            "currentVersion": {"shortName": "MS 15.21"},
            "availableVersions": [{"shortName": "MS 15.21", "releaseType": "stable"}]
        }}}));
        let up_to_date = find(&run(&c, &profile("smb")), "firmware").eval.clone();
        assert_eq!(up_to_date.status, Status::Pass, "{}", up_to_date.summary);

        c.firmware = Some(json!({"products": {"switch": {
            "currentVersion": {"shortName": "MS 15.21"},
            "availableVersions": [
                {"shortName": "MS 15.21", "releaseType": "stable"},
                {"shortName": "MS 16.4", "releaseType": "stable"},
                {"shortName": "MS 17.0", "releaseType": "beta"}
            ]
        }}}));
        let behind = find(&run(&c, &profile("smb")), "firmware").eval.clone();
        assert!(behind.findings.iter().any(|f| f.code == Code::FirmwareUpdateAvailable));
        // The beta does not count.
        assert_eq!(behind.details[0].rows[0][2], "1");
    }

    #[test]
    fn a_security_event_that_was_blocked_is_not_a_finding() {
        let mut c = base(&["appliance"]);
        c.security_events = Some(vec![
            json!({"ts": "2026-09-20T10:00:00Z", "eventType": "IDS Alert", "blocked": true, "message": "stopped"}),
        ]);
        let ok = find(&run(&c, &profile("regulated")), "security-events").eval.clone();
        assert_eq!(ok.status, Status::Pass, "{}", ok.summary);

        c.security_events = Some(vec![
            json!({"ts": "2026-09-20T10:00:00Z", "eventType": "IDS Alert", "blocked": true, "message": "stopped"}),
            json!({"ts": "2026-09-21T11:00:00Z", "eventType": "IDS Alert", "blocked": false, "message": "allowed", "clientName": "laptop"}),
        ]);
        let bad = find(&run(&c, &profile("smb")), "security-events").eval.clone();
        assert!(bad.findings.iter().any(|f| f.code == Code::ThreatsUnblocked));
        assert!(bad.summary.contains("1 event of 2"), "{}", bad.summary);
    }

    #[test]
    fn wireless_failures_are_judged_against_the_profile_not_a_fixed_number() {
        // 12% failures: fine for a small business, not for a clinic.
        let mut c = base(&["wireless"]);
        c.connection_stats = Some(json!({"assoc": 6, "auth": 3, "dhcp": 2, "dns": 1, "success": 88}));

        let shop = find(&run(&c, &profile("smb")), "wireless-health").eval.clone();
        let clinic = find(&run(&c, &profile("healthcare")), "wireless-health").eval.clone();
        assert_eq!(shop.status, Status::Pass, "12% is under the SMB bar of 15%: {}", shop.summary);
        assert_eq!(clinic.status, Status::Attention, "12% is over the healthcare bar of 7%");
        assert!(clinic.findings.iter().any(|f| f.code == Code::WifiConnFailures));
    }

    #[test]
    fn a_backup_coreview_already_holds_is_not_reported_as_missing() {
        // The check his script cannot make, because only Coreview knows.
        let mut c = base(&["appliance"]);
        c.has_backup = Some(true);
        assert_eq!(find(&run(&c, &profile("regulated")), "backup").eval.status, Status::Pass);

        c.has_backup = Some(false);
        let missing = find(&run(&c, &profile("regulated")), "backup").eval.clone();
        assert!(missing.findings.iter().any(|f| f.code == Code::BackupMissing));
        assert!(missing.action.is_some());

        // And when nobody looked, it says so rather than guessing either way.
        c.has_backup = None;
        assert_eq!(find(&run(&c, &profile("smb")), "backup").eval.status, Status::Manual);
    }

    #[test]
    fn a_licence_expiry_date_becomes_a_number_of_days() {
        // 2026-09-23, so the arithmetic can be checked against a fixed today.
        let today = days_from_civil(2026, 9, 23);
        assert_eq!(days_until("Nov 8, 2026 UTC", today), Some(46));
        assert_eq!(days_until("Sep 23, 2026 UTC", today), Some(0), "today is zero days away");
        assert_eq!(days_until("Aug 1, 2026", today), Some(-53), "an expired licence is negative");
        // A leap day is a real date and must not be rejected.
        assert_eq!(days_until("Feb 29, 2028 UTC", today), Some(days_from_civil(2028, 2, 29) - today));
        // And anything it cannot read is None, never a guess.
        for bad in ["", "soon", "Nov 2026", "Xyz 8, 2026", "Nov 99, 2026", "Nov 8, 99"] {
            assert_eq!(days_until(bad, today), None, "{bad:?} should not parse");
        }
    }

    #[test]
    fn a_licence_about_to_expire_is_found_earlier_under_a_stricter_profile() {
        let expires = |days: i64| {
            let today = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_secs() as i64
                / 86_400;
            // Build the date the parser expects, from a day offset.
            let target = today + days;
            let (mut y, mut m, mut d) = (1970i64, 1i64, 1i64);
            // Walk years then months then days: exact, and only a few steps.
            while days_from_civil(y + 1, 1, 1) <= target {
                y += 1;
            }
            while m < 12 && days_from_civil(y, m + 1, 1) <= target {
                m += 1;
            }
            d += target - days_from_civil(y, m, 1);
            const NAMES: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            format!("{} {d}, {y} UTC", NAMES[(m - 1) as usize])
        };

        let mut c = base(&["appliance"]);
        // 40 days out: past the SMB's 30-day bar, inside the regulated 90.
        c.licenses = Some(json!({"status": "OK", "expirationDate": expires(40)}));

        let smb = find(&run(&c, &profile("smb")), "licensing").eval.clone();
        let reg = find(&run(&c, &profile("regulated")), "licensing").eval.clone();
        assert_eq!(smb.status, Status::Pass, "40 days is fine at 30: {}", smb.summary);
        assert!(
            reg.findings.iter().any(|f| f.code == Code::LicenceExpiring),
            "40 days should warn at 90: {}",
            reg.summary,
        );
    }

    #[test]
    fn a_licence_status_that_is_not_ok_is_a_finding_on_its_own() {
        let mut c = base(&["appliance"]);
        c.licenses = Some(json!({"status": "License Problem"}));
        let e = find(&run(&c, &profile("smb")), "licensing").eval.clone();
        assert!(e.findings.iter().any(|f| f.code == Code::LicenceStatusNotOk));
        assert!(e.summary.contains("License Problem"), "{}", e.summary);
    }

    #[test]
    fn a_poe_port_drawing_nothing_is_found_and_a_data_port_is_not() {
        // "The access point will not come on." A PoE port with something
        // plugged in and no draw is the symptom; a data port at 0 W is just a
        // data port, and judging on the draw alone would report every one.
        let mut c = base(&["switch"]);
        c.ports = vec![(
            "Q1".into(),
            json!([
                {"portId": "1", "poeEnabled": true},
                {"portId": "2", "poeEnabled": false},
                {"portId": "3", "poeEnabled": true}
            ]),
        )];
        c.port_statuses = vec![(
            "Q1".into(),
            json!([
                {"portId": "1", "status": "Connected", "powerUsageInWh": 0.0, "clientCount": 1},
                {"portId": "2", "status": "Connected", "powerUsageInWh": 0.0, "clientCount": 1},
                {"portId": "3", "status": "Connected", "powerUsageInWh": 6.5, "clientCount": 1}
            ]),
        )];

        let e = find(&run(&c, &profile("smb")), "switch-ports").eval.clone();
        assert!(e.findings.iter().any(|f| f.code == Code::PoeDarkPort), "{}", e.summary);
        let dark = e.details.iter().find(|d| d.label == "PoE ports drawing nothing").expect("the table");
        assert_eq!(dark.rows.len(), 1, "only the PoE port with no draw: {:?}", dark.rows);
        assert_eq!(dark.rows[0][1], "1");
    }

    #[test]
    fn a_port_that_is_not_connected_is_not_a_dark_poe_port() {
        // An empty PoE port draws nothing because nothing is plugged into it.
        let mut c = base(&["switch"]);
        c.ports = vec![("Q1".into(), json!([{"portId": "1", "poeEnabled": true}]))];
        c.port_statuses = vec![(
            "Q1".into(),
            json!([{"portId": "1", "status": "Disconnected", "powerUsageInWh": 0.0}]),
        )];
        let e = find(&run(&c, &profile("regulated")), "switch-ports").eval.clone();
        assert!(!e.findings.iter().any(|f| f.code == Code::PoeDarkPort), "{}", e.summary);
    }

    #[test]
    fn every_finding_code_can_actually_be_raised() {
        // The defect this catches has now happened twice: `licence.expiring`
        // was unreachable behind an expression that always yielded None, and
        // `poe.dark_port` was a loop that computed a value and discarded it.
        // A code nothing can raise is a check the report silently never makes.
        let source = include_str!("checks.rs");
        let missing: Vec<&str> = Code::all()
            .iter()
            .filter(|c| {
                let variant = format!("{c:?}");
                !source.contains(&format!("Code::{variant})")) && !source.contains(&format!("Code::{variant},"))
            })
            .map(|c| c.as_str())
            .collect();
        assert!(missing.is_empty(), "codes nothing raises: {missing:?}");
    }

    #[test]
    fn a_stack_member_that_is_down_is_named() {
        let mut c = base(&["switch"]);
        c.stacks = Some(json!([{"name": "Core stack", "serials": ["Q1", "Q2"]}]));
        c.statuses = vec![json!({"serial": "Q1", "status": "online"}), json!({"serial": "Q2", "status": "offline"})];
        let s = find(&run(&c, &profile("smb")), "stacks").eval.clone();
        assert!(s.findings.iter().any(|f| f.code == Code::SwitchStackMemberDown));
        assert_eq!(s.details[0].rows.len(), 2, "both members are shown, not just the broken one");
    }

    #[test]
    fn the_report_carries_the_window_each_number_was_read_over() {
        // "No security events" over an hour and over a week are different
        // statements, and the report has to say which it is making.
        let report = run(&base(&[]), &profile("smb"));
        assert!(report.data_windows.contains("24 hours"));
        assert!(report.data_windows.contains("7 days"));
    }
}
