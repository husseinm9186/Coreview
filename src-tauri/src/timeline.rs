//! What changed across every kept crawl, device by device (LT-435).
//!
//! LT-227 compares two runs the operator picks. This walks every run a
//! project has kept, oldest first, and writes down each change to each
//! device as it happened — appeared, disappeared, a new class or platform or
//! version or serial, an address gained or lost, a neighbour gained or lost,
//! an uptime that went backwards (a restart) — with the run it happened in
//! and, where the newer run carries evidence (LT-438), which source said so.
//!
//! Pure over the runs' JSON, so it is tested with invented runs and never
//! needs a database. The command in `commands.rs` reads the runs and hands
//! them here.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

/// One change to one device in one run.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEntry {
    pub run_id: String,
    pub taken_at: i64,
    /// The device's name, or its address where it has none.
    pub device: String,
    /// `appeared`, `disappeared`, `class`, `platform`, `version`, `serial`,
    /// `address`, `neighbour`, `restarted`.
    pub field: String,
    pub was: Option<String>,
    pub now: Option<String>,
    /// Which reading said so, from the newer run's evidence; `reachedBy`
    /// where the run carries none.
    pub source: Option<String>,
}

/// A run as the timeline needs it.
pub struct Run<'a> {
    pub id: &'a str,
    pub taken_at: i64,
    pub devices: &'a [Value],
}

/// The fields of one device that the timeline watches, read out of its JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Watched {
    name: String,
    class: Option<String>,
    platform: Option<String>,
    version: Option<String>,
    serial: Option<String>,
    addresses: BTreeSet<String>,
    neighbours: BTreeSet<String>,
    uptime: Option<u64>,
    reached_by: Option<String>,
    evidence: BTreeMap<String, String>,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// The identity a device is followed by across runs: its hostname, lower
/// case, or its address where it has no name — the same rule `identity`
/// uses on the page.
fn key_of(v: &Value) -> Option<String> {
    let name = text(v, "hostname").map(|h| h.to_ascii_lowercase());
    name.or_else(|| text(v, "address"))
}

fn watched(v: &Value) -> Watched {
    let addresses = v
        .get("addresses")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| text(x, "ip")).collect())
        .unwrap_or_default();
    let neighbours = v
        .get("neighbors")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|n| {
                    let who = text(n, "shortName").or_else(|| text(n, "deviceId"))?;
                    let local = text(n, "localInterface").unwrap_or_default();
                    Some(if local.is_empty() { who } else { format!("{who} on {local}") })
                })
                .collect()
        })
        .unwrap_or_default();
    let evidence = v
        .get("evidence")
        .and_then(Value::as_object)
        .map(|m| m.iter().filter_map(|(k, e)| text(e, "source").map(|s| (k.clone(), s))).collect())
        .unwrap_or_default();
    Watched {
        name: text(v, "hostname").or_else(|| text(v, "address")).unwrap_or_default(),
        class: text(v, "class"),
        platform: text(v, "platform"),
        version: text(v, "version"),
        serial: text(v, "serial"),
        addresses,
        neighbours,
        uptime: v.get("uptimeSeconds").and_then(Value::as_u64),
        reached_by: text(v, "reachedBy"),
        evidence,
    }
}

/// Every change across the runs, oldest run first, devices in name order
/// within a run. `only` narrows it to one device by name or address.
pub fn timeline(runs: &[Run<'_>], only: Option<&str>) -> Vec<TimelineEntry> {
    let wanted = only.map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty());
    let mut out = Vec::new();
    let mut previous: BTreeMap<String, Watched> = BTreeMap::new();
    let mut first = true;
    for run in runs {
        let mut current: BTreeMap<String, Watched> = BTreeMap::new();
        for d in run.devices {
            if let Some(k) = key_of(d) {
                current.insert(k, watched(d));
            }
        }
        let entry = |device: &Watched, field: &str, was: Option<String>, now: Option<String>| TimelineEntry {
            run_id: run.id.to_string(),
            taken_at: run.taken_at,
            device: device.name.clone(),
            field: field.to_string(),
            was,
            now,
            source: device.evidence.get(field).cloned().or_else(|| device.reached_by.clone()),
        };
        if !first {
            for (k, gone) in &previous {
                if !current.contains_key(k) {
                    out.push(entry(gone, "disappeared", Some(gone.name.clone()), None));
                }
            }
        }
        for (k, now) in &current {
            let Some(was) = previous.get(k) else {
                // The first run seeds the timeline; nothing "appeared" in it.
                if !first {
                    out.push(entry(now, "appeared", None, Some(now.name.clone())));
                }
                continue;
            };
            for (field, a, b) in [
                ("class", &was.class, &now.class),
                ("platform", &was.platform, &now.platform),
                ("version", &was.version, &now.version),
                ("serial", &was.serial, &now.serial),
            ] {
                if a != b && b.is_some() {
                    out.push(entry(now, field, a.clone(), b.clone()));
                }
            }
            for gone in was.addresses.difference(&now.addresses) {
                out.push(entry(now, "address", Some(gone.clone()), None));
            }
            for new in now.addresses.difference(&was.addresses) {
                out.push(entry(now, "address", None, Some(new.clone())));
            }
            for gone in was.neighbours.difference(&now.neighbours) {
                out.push(entry(now, "neighbour", Some(gone.clone()), None));
            }
            for new in now.neighbours.difference(&was.neighbours) {
                out.push(entry(now, "neighbour", None, Some(new.clone())));
            }
            if let (Some(a), Some(b)) = (was.uptime, now.uptime) {
                // Less uptime in a later run means it restarted in between.
                if b < a {
                    out.push(entry(now, "restarted", Some(format!("{a}s")), Some(format!("{b}s"))));
                }
            }
        }
        previous = current;
        first = false;
    }
    if let Some(w) = wanted {
        out.retain(|e| e.device.to_ascii_lowercase() == w);
    }
    out
}

/// LT-435's landing line: the newest run's changes, counted by field.
pub fn since_last(entries: &[TimelineEntry], newest_run: &str) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for e in entries.iter().filter(|e| e.run_id == newest_run) {
        *counts.entry(e.field.clone()).or_insert(0) += 1;
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Invented devices on documentation addresses (D-027).
    fn dev(name: &str, address: &str, over: Value) -> Value {
        let mut d = json!({
            "hostname": name, "address": address, "class": "switch", "platform": "WS-C2960X",
            "version": "15.2(7)E4", "serial": null,
            "addresses": [{"ip": address}], "neighbors": [], "uptimeSeconds": 1000, "reachedBy": "ssh",
        });
        if let (Some(base), Some(extra)) = (d.as_object_mut(), over.as_object()) {
            for (k, v) in extra {
                base.insert(k.clone(), v.clone());
            }
        }
        d
    }

    #[test]
    fn changes_are_written_against_the_run_they_happened_in_with_their_source() {
        let r1 = vec![
            dev("CORE", "192.0.2.1", json!({"neighbors": [{"shortName": "ACCESS-1", "localInterface": "Gi1/0/1"}]})),
            dev("ACCESS-1", "192.0.2.11", json!({})),
        ];
        let r2 = vec![
            dev("CORE", "192.0.2.1", json!({
                "version": "15.2(7)E8", "uptimeSeconds": 40,
                "neighbors": [{"shortName": "ACCESS-2", "localInterface": "Gi1/0/1"}],
                "evidence": {"version": {"source": "ssh:show version"}, "uptime": {"source": "snmp:sysUpTime"}},
            })),
            dev("ACCESS-2", "192.0.2.12", json!({"reachedBy": "reported"})),
        ];
        let runs = [
            Run { id: "run-1", taken_at: 100, devices: &r1 },
            Run { id: "run-2", taken_at: 200, devices: &r2 },
        ];
        let got = timeline(&runs, None);
        type Brief = (String, String, Option<String>, Option<String>, Option<String>);
        let brief: Vec<Brief> =
            got.iter().map(|e| (e.device.clone(), e.field.clone(), e.was.clone(), e.now.clone(), e.source.clone())).collect();
        assert_eq!(
            brief,
            vec![
                ("ACCESS-1".into(), "disappeared".into(), Some("ACCESS-1".into()), None, Some("ssh".into())),
                ("ACCESS-2".into(), "appeared".into(), None, Some("ACCESS-2".into()), Some("reported".into())),
                ("CORE".into(), "version".into(), Some("15.2(7)E4".into()), Some("15.2(7)E8".into()), Some("ssh:show version".into())),
                ("CORE".into(), "neighbour".into(), Some("ACCESS-1 on Gi1/0/1".into()), None, Some("ssh".into())),
                ("CORE".into(), "neighbour".into(), None, Some("ACCESS-2 on Gi1/0/1".into()), Some("ssh".into())),
                ("CORE".into(), "restarted".into(), Some("1000s".into()), Some("40s".into()), Some("ssh".into())),
            ]
        );
        assert!(got.iter().all(|e| e.run_id == "run-2" && e.taken_at == 200), "every change is in the second run");
        // The first run seeds the timeline and says nothing appeared.
        assert!(timeline(&runs[..1], None).is_empty());
        // Narrowed to one device, by name however it is cased.
        assert_eq!(timeline(&runs, Some("core")).len(), 4);
        let counts = since_last(&got, "run-2");
        assert_eq!(counts.get("neighbour"), Some(&2));
        assert_eq!(counts.get("appeared"), Some(&1));
    }

    #[test]
    fn a_field_that_went_unread_is_not_a_change() {
        // A device reached over SNMP the second time reports no version; that
        // is a gap in the reading, not a downgrade.
        let r1 = vec![dev("CORE", "192.0.2.1", json!({}))];
        let r2 = vec![dev("CORE", "192.0.2.1", json!({"version": null, "platform": null, "reachedBy": "snmp"}))];
        let runs = [Run { id: "a", taken_at: 1, devices: &r1 }, Run { id: "b", taken_at: 2, devices: &r2 }];
        assert!(timeline(&runs, None).is_empty());
    }

    #[test]
    fn a_device_with_no_name_is_followed_by_its_address() {
        let r1 = vec![json!({"hostname": "", "address": "192.0.2.9", "class": "unknown", "addresses": [{"ip": "192.0.2.9"}]})];
        let r2 = vec![json!({"hostname": "", "address": "192.0.2.9", "class": "printer", "addresses": [{"ip": "192.0.2.9"}]})];
        let runs = [Run { id: "a", taken_at: 1, devices: &r1 }, Run { id: "b", taken_at: 2, devices: &r2 }];
        let got = timeline(&runs, None);
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].device.as_str(), got[0].field.as_str()), ("192.0.2.9", "class"));
    }
}
