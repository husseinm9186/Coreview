//! Schema 6 (LT-515): the discovery tables the catalog-driven collector
//! fills. Every row carries `run_id`, `device_id` and `collected_at`; the
//! typed tables carry the spec's columns as TEXT plus `extra`, the JSON of
//! whatever the parser returned beyond them. Raw replies are not in here:
//! they go, redacted, to the run's diagnostic folder when the operator
//! asked for one, and `command_log.raw_ref` points at the file (D-055).

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// The typed tables and their columns — the same names `coreview_collect::tables` emits.
pub const TABLES: &[(&str, &[&str])] = &[
    ("device", &["hostname", "vendor", "os_version", "model", "serial", "mgmt_ip", "uptime", "base_mac"]),
    ("interface", &["name", "admin", "oper", "speed", "duplex", "mac", "descr", "mtu", "vlan", "mode", "lag_parent"]),
    ("ip_address", &["interface", "ip", "prefixlen", "vrf", "kind"]),
    ("neighbor", &["local_if", "proto", "rem_sysname", "rem_chassis_id", "rem_port_id", "rem_port_descr", "rem_mgmt_ip", "rem_platform", "rem_caps"]),
    ("mac_table", &["vlan", "mac", "interface", "type", "age"]),
    ("arp", &["vrf", "ip", "mac", "interface", "age"]),
    ("vlan", &["vlan_id", "name", "state", "ports"]),
    ("lag", &["name", "proto", "members", "state"]),
    ("stp", &["instance", "root_bridge", "root_port", "bridge_prio", "interface", "role", "state", "cost"]),
    ("vrf", &["name", "rd", "rt_import", "rt_export", "interfaces"]),
    ("route", &["vrf", "prefix", "mask", "proto", "ad", "metric", "next_hop", "interface", "age"]),
    // LT-653: the forwarding table, the RIB's columns plus a label and the adjacency kind.
    ("fib", &["vrf", "prefix", "mask", "proto", "ad", "metric", "next_hop", "interface", "label", "adjacency"]),
    ("routing_neighbor", &["vrf", "proto", "neighbor_id", "neighbor_ip", "local_if", "state", "area_or_as", "uptime"]),
    ("fhrp", &["proto", "group", "interface", "vip", "prio", "state", "peer_ip"]),
    ("policy_route", &["vrf", "seq", "in_if", "src", "dst", "proto", "port", "action_nh", "action_if"]),
    ("nat_rule", &["seq", "type", "orig_src", "orig_dst", "trans_src", "trans_dst", "in_zone_if", "out_zone_if", "service"]),
    ("fw_zone", &["name", "interfaces"]),
    ("fw_policy", &["seq", "name", "src_zones", "dst_zones", "src_addr", "dst_addr", "services", "action", "enabled"]),
    // LT-540: where a policy applies, and the objects rules name.
    ("fw_binding", &["policy", "interface", "direction"]),
    ("fw_object", &["name", "type", "host", "network", "mask", "range_start", "range_end", "member", "protocol", "port_op", "port_start", "port_end", "fqdn"]),
    ("tunnel", &["name", "kind", "local_ip", "remote_ip", "state"]),
    ("ha_pair", &["kind", "member", "role", "mac", "model", "serial", "peer_link"]),
    // LT-656: nbr_ip, nbr_chassis, nbr_platform and local_port, which the
    // builder read and nothing stored.
    ("ap", &["ap_name", "ap_ip", "ap_mac", "model", "nbr_switch", "nbr_port", "state", "nbr_ip", "nbr_chassis", "nbr_platform", "local_port"]),
    ("endpoint", &["mac", "ip", "vlan", "switch", "port", "seen_via"]),
];

/// The migration: the run, device and command log tables, and one typed
/// table per entry of `TABLES`. `IF NOT EXISTS` throughout, so a database
/// that already has them is left alone.
pub fn discovery_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS collection_runs (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            seed TEXT NOT NULL,
            started_ms INTEGER NOT NULL,
            finished_ms INTEGER,
            status TEXT NOT NULL,
            plan_only INTEGER NOT NULL DEFAULT 0,
            diagnostic_dir TEXT,
            source TEXT NOT NULL DEFAULT 'live'
        );
        CREATE INDEX IF NOT EXISTS collection_runs_project ON collection_runs (project_id, started_ms);

        CREATE TABLE IF NOT EXISTS collection_devices (
            run_id TEXT NOT NULL REFERENCES collection_runs (id) ON DELETE CASCADE,
            device_id TEXT NOT NULL,
            host TEXT NOT NULL,
            os TEXT,
            role TEXT,
            caps TEXT NOT NULL DEFAULT '[]',
            version_text TEXT NOT NULL DEFAULT '',
            prompt TEXT NOT NULL DEFAULT '',
            context_kind TEXT,
            contexts TEXT NOT NULL DEFAULT '[]',
            failure TEXT,
            log TEXT NOT NULL DEFAULT '[]',
            plan TEXT,
            collected_at INTEGER NOT NULL,
            PRIMARY KEY (run_id, device_id)
        );

        CREATE TABLE IF NOT EXISTS command_log (
            run_id TEXT NOT NULL REFERENCES collection_runs (id) ON DELETE CASCADE,
            device_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            step_id TEXT NOT NULL,
            cmd TEXT NOT NULL,
            kind TEXT NOT NULL,
            context_kind TEXT,
            context_name TEXT,
            gate TEXT NOT NULL DEFAULT '',
            parser TEXT NOT NULL DEFAULT '',
            feeds TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            rows INTEGER NOT NULL DEFAULT 0,
            raw_ref TEXT,
            error TEXT,
            verified TEXT,
            collected_at INTEGER NOT NULL,
            PRIMARY KEY (run_id, device_id, seq)
        );
        "#,
    )?;
    for (table, columns) in TABLES {
        let cols: Vec<String> = columns.iter().map(|c| format!("\"{c}\" TEXT")).collect();
        conn.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS d_{table} (
                run_id TEXT NOT NULL REFERENCES collection_runs (id) ON DELETE CASCADE,
                device_id TEXT NOT NULL,
                command_id TEXT NOT NULL,
                {},
                extra TEXT NOT NULL DEFAULT '{{}}',
                collected_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS d_{table}_run ON d_{table} (run_id, device_id);",
            cols.join(",\n                ")
        ))?;
    }
    Ok(())
}

/// A column added to a typed table after a database was made (LT-656):
/// `CREATE TABLE IF NOT EXISTS` leaves an existing table as it was, so each
/// of `TABLES`' columns is checked for and added.
pub fn typed_columns(conn: &Connection) -> rusqlite::Result<()> {
    for (table, columns) in TABLES {
        let have: Vec<String> = conn.prepare(&format!("PRAGMA table_info(d_{table})"))?.query_map([], |r| r.get::<_, String>(1))?.filter_map(|r| r.ok()).collect();
        for col in *columns {
            if !have.iter().any(|c| c == col) {
                conn.execute(&format!("ALTER TABLE d_{table} ADD COLUMN \"{col}\" TEXT"), [])?;
            }
        }
    }
    Ok(())
}

/// Schema 7 (LT-521): the shadow verdict per command — `match`, `mismatch`
/// or `error`, what differed first, and which parser produced the rows.
pub fn shadow_columns(conn: &Connection) -> rusqlite::Result<()> {
    let have: Vec<String> = conn.prepare("PRAGMA table_info(command_log)")?.query_map([], |r| r.get::<_, String>(1))?.filter_map(|r| r.ok()).collect();
    for col in ["shadow", "shadow_detail", "engine"] {
        if !have.iter().any(|c| c == col) {
            conn.execute(&format!("ALTER TABLE command_log ADD COLUMN {col} TEXT"), [])?;
        }
    }
    Ok(())
}

/// Per (os, command): how many replies both parsers read, and how many
/// they disagreed on — the numbers each OS's flip to Rust is decided by.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShadowLine {
    pub os: String,
    pub cmd: String,
    pub parser: String,
    pub compared: i64,
    pub mismatches: i64,
    pub errors: i64,
    pub last_detail: Option<String>,
}

/// Across every run of a project, or every project when `project_id` is `None`.
pub fn shadow_report(conn: &Connection, project_id: Option<&str>) -> rusqlite::Result<Vec<ShadowLine>> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(d.os, '?'), l.cmd, l.parser,
                COUNT(*),
                SUM(CASE WHEN l.shadow = 'mismatch' THEN 1 ELSE 0 END),
                SUM(CASE WHEN l.shadow = 'error' THEN 1 ELSE 0 END),
                MAX(CASE WHEN l.shadow IN ('mismatch', 'error') THEN l.shadow_detail END)
         FROM command_log l
         JOIN collection_devices d ON d.run_id = l.run_id AND d.device_id = l.device_id
         JOIN collection_runs r ON r.id = l.run_id
         WHERE l.shadow IS NOT NULL AND (?1 IS NULL OR r.project_id = ?1)
         GROUP BY d.os, l.cmd, l.parser
         ORDER BY d.os, l.cmd",
    )?;
    let rows = stmt.query_map(params![project_id], |r| {
        Ok(ShadowLine { os: r.get(0)?, cmd: r.get(1)?, parser: r.get(2)?, compared: r.get(3)?, mismatches: r.get(4)?, errors: r.get(5)?, last_detail: r.get(6)? })
    })?;
    rows.collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub id: String,
    pub project_id: String,
    pub seed: String,
    pub started_ms: i64,
    pub finished_ms: Option<i64>,
    pub status: String,
    pub plan_only: bool,
    pub diagnostic_dir: Option<String>,
    pub source: String,
    pub devices: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSummary {
    pub device_id: String,
    pub host: String,
    pub os: Option<String>,
    pub role: Option<String>,
    pub caps: Vec<String>,
    pub version_text: String,
    pub prompt: String,
    pub context_kind: Option<String>,
    pub contexts: Vec<String>,
    pub failure: Option<String>,
    pub log: Vec<String>,
    pub plan: Option<serde_json::Value>,
    pub collected_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub device_id: String,
    pub seq: i64,
    pub step_id: String,
    pub cmd: String,
    pub kind: String,
    pub context_kind: Option<String>,
    pub context_name: Option<String>,
    pub gate: String,
    pub parser: String,
    pub feeds: Vec<String>,
    pub status: String,
    pub duration_ms: i64,
    pub rows: i64,
    pub raw_ref: Option<String>,
    pub error: Option<String>,
    pub verified: Option<String>,
    #[serde(default)]
    pub shadow: Option<String>,
    #[serde(default)]
    pub shadow_detail: Option<String>,
    #[serde(default)]
    pub engine: Option<String>,
}

pub fn open_run(conn: &Connection, id: &str, project_id: &str, seed: &str, plan_only: bool, diagnostic_dir: Option<&str>, source: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO collection_runs (id, project_id, seed, started_ms, status, plan_only, diagnostic_dir, source) VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?6, ?7)",
        params![id, project_id, seed, crate::db::now_ms(), plan_only as i64, diagnostic_dir, source],
    )?;
    Ok(())
}

pub fn finish_run(conn: &Connection, id: &str, status: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE collection_runs SET status = ?2, finished_ms = ?3 WHERE id = ?1", params![id, status, crate::db::now_ms()])?;
    Ok(())
}

pub fn list_runs(conn: &Connection, project_id: &str) -> rusqlite::Result<Vec<RunSummary>> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.project_id, r.seed, r.started_ms, r.finished_ms, r.status, r.plan_only, r.diagnostic_dir, r.source,
                (SELECT COUNT(*) FROM collection_devices d WHERE d.run_id = r.id)
         FROM collection_runs r WHERE r.project_id = ?1 ORDER BY r.started_ms DESC",
    )?;
    let rows = stmt.query_map(params![project_id], |r| {
        Ok(RunSummary {
            id: r.get(0)?,
            project_id: r.get(1)?,
            seed: r.get(2)?,
            started_ms: r.get(3)?,
            finished_ms: r.get(4)?,
            status: r.get(5)?,
            plan_only: r.get::<_, i64>(6)? != 0,
            diagnostic_dir: r.get(7)?,
            source: r.get(8)?,
            devices: r.get(9)?,
        })
    })?;
    rows.collect()
}

pub fn run_project(conn: &Connection, run_id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT project_id FROM collection_runs WHERE id = ?1", params![run_id], |r| r.get(0)).optional()
}

/// One device's outcome, written whole when its run ends (a run that dies
/// mid-device loses that device only).
#[allow(clippy::too_many_arguments)] // one row, one call
pub fn write_device(
    conn: &Connection,
    run_id: &str,
    device_id: &str,
    host: &str,
    os: Option<&str>,
    role: Option<&str>,
    caps: &[String],
    version_text: &str,
    prompt: &str,
    context_kind: Option<&str>,
    contexts: &[String],
    failure: Option<&str>,
    log: &[String],
    plan: Option<&serde_json::Value>,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO collection_devices (run_id, device_id, host, os, role, caps, version_text, prompt, context_kind, contexts, failure, log, plan, collected_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            run_id,
            device_id,
            host,
            os,
            role,
            serde_json::to_string(caps).unwrap_or_else(|_| "[]".into()),
            version_text,
            prompt,
            context_kind,
            serde_json::to_string(contexts).unwrap_or_else(|_| "[]".into()),
            failure,
            serde_json::to_string(log).unwrap_or_else(|_| "[]".into()),
            plan.map(|p| p.to_string()),
            crate::db::now_ms()
        ],
    )?;
    Ok(())
}

pub fn list_devices(conn: &Connection, run_id: &str) -> rusqlite::Result<Vec<DeviceSummary>> {
    let mut stmt = conn.prepare("SELECT device_id, host, os, role, caps, version_text, prompt, context_kind, contexts, failure, log, plan, collected_at FROM collection_devices WHERE run_id = ?1 ORDER BY collected_at")?;
    let rows = stmt.query_map(params![run_id], |r| {
        let caps: String = r.get(4)?;
        let contexts: String = r.get(8)?;
        let log: String = r.get(10)?;
        let plan: Option<String> = r.get(11)?;
        Ok(DeviceSummary {
            device_id: r.get(0)?,
            host: r.get(1)?,
            os: r.get(2)?,
            role: r.get(3)?,
            caps: serde_json::from_str(&caps).unwrap_or_default(),
            version_text: r.get(5)?,
            prompt: r.get(6)?,
            context_kind: r.get(7)?,
            contexts: serde_json::from_str(&contexts).unwrap_or_default(),
            failure: r.get(9)?,
            log: serde_json::from_str(&log).unwrap_or_default(),
            plan: plan.and_then(|p| serde_json::from_str(&p).ok()),
            collected_at: r.get(12)?,
        })
    })?;
    rows.collect()
}

#[allow(clippy::too_many_arguments)] // one row, one call
pub fn write_log(conn: &Connection, run_id: &str, device_id: &str, seq: i64, e: &LogEntry) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO command_log (run_id, device_id, seq, step_id, cmd, kind, context_kind, context_name, gate, parser, feeds, status, duration_ms, rows, raw_ref, error, verified, collected_at, shadow, shadow_detail, engine)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
        params![
            run_id,
            device_id,
            seq,
            e.step_id,
            e.cmd,
            e.kind,
            e.context_kind,
            e.context_name,
            e.gate,
            e.parser,
            serde_json::to_string(&e.feeds).unwrap_or_else(|_| "[]".into()),
            e.status,
            e.duration_ms,
            e.rows,
            e.raw_ref,
            e.error,
            e.verified,
            crate::db::now_ms(),
            e.shadow,
            e.shadow_detail,
            e.engine
        ],
    )?;
    Ok(())
}

pub fn list_log(conn: &Connection, run_id: &str, device_id: Option<&str>) -> rusqlite::Result<Vec<LogEntry>> {
    let mut stmt = conn.prepare("SELECT device_id, seq, step_id, cmd, kind, context_kind, context_name, gate, parser, feeds, status, duration_ms, rows, raw_ref, error, verified, shadow, shadow_detail, engine FROM command_log WHERE run_id = ?1 AND (?2 IS NULL OR device_id = ?2) ORDER BY device_id, seq")?;
    let rows = stmt.query_map(params![run_id, device_id], |r| {
        let feeds: String = r.get(9)?;
        Ok(LogEntry {
            device_id: r.get(0)?,
            seq: r.get(1)?,
            step_id: r.get(2)?,
            cmd: r.get(3)?,
            kind: r.get(4)?,
            context_kind: r.get(5)?,
            context_name: r.get(6)?,
            gate: r.get(7)?,
            parser: r.get(8)?,
            feeds: serde_json::from_str(&feeds).unwrap_or_default(),
            status: r.get(10)?,
            duration_ms: r.get(11)?,
            rows: r.get(12)?,
            raw_ref: r.get(13)?,
            error: r.get(14)?,
            verified: r.get(15)?,
            shadow: r.get(16)?,
            shadow_detail: r.get(17)?,
            engine: r.get(18)?,
        })
    })?;
    rows.collect()
}

/// One normalised row into its typed table. Unknown tables are refused —
/// the catalog test already holds `feeds` to the spec's list.
pub fn write_row(conn: &Connection, run_id: &str, device_id: &str, command_id: &str, row: &coreview_collect::tables::Normalised) -> rusqlite::Result<bool> {
    let Some((table, columns)) = TABLES.iter().find(|(t, _)| *t == row.table) else { return Ok(false) };
    let names: Vec<&str> = columns.to_vec();
    let placeholders: Vec<String> = (0..names.len() + 5).map(|i| format!("?{}", i + 1)).collect();
    // Quoted, because `group` and `state` are SQL words as well as column names.
    let quoted: Vec<String> = names.iter().map(|c| format!("\"{c}\"")).collect();
    let sql = format!(
        "INSERT INTO d_{table} (run_id, device_id, command_id, {}, extra, collected_at) VALUES ({})",
        quoted.join(", "),
        placeholders.join(", ")
    );
    let mut values: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Text(run_id.to_string()), rusqlite::types::Value::Text(device_id.to_string()), rusqlite::types::Value::Text(command_id.to_string())];
    for c in &names {
        values.push(match row.columns.get(*c) {
            Some(v) => rusqlite::types::Value::Text(v.clone()),
            None => rusqlite::types::Value::Null,
        });
    }
    values.push(serde_json::Value::Object(row.extra.clone()).to_string().into());
    values.push(crate::db::now_ms().into());
    conn.execute(&sql, rusqlite::params_from_iter(values))?;
    Ok(true)
}

/// Every row of one table for a run, as JSON objects (columns and extra merged, `_device` and `_command` added).
pub fn read_table(conn: &Connection, run_id: &str, table: &str, device_id: Option<&str>) -> rusqlite::Result<Vec<serde_json::Value>> {
    let Some((table, columns)) = TABLES.iter().find(|(t, _)| *t == table) else { return Ok(Vec::new()) };
    let quoted: Vec<String> = columns.iter().map(|c| format!("\"{c}\"")).collect();
    let sql = format!("SELECT device_id, command_id, {}, extra FROM d_{table} WHERE run_id = ?1 AND (?2 IS NULL OR device_id = ?2) ORDER BY rowid", quoted.join(", "));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![run_id, device_id], |r| {
        let mut obj = serde_json::Map::new();
        obj.insert("_device".into(), serde_json::Value::String(r.get(0)?));
        obj.insert("_command".into(), serde_json::Value::String(r.get(1)?));
        for (i, c) in columns.iter().enumerate() {
            let v: Option<String> = r.get(i + 2)?;
            if let Some(v) = v {
                obj.insert((*c).to_string(), serde_json::Value::String(v));
            }
        }
        let extra: String = r.get(columns.len() + 2)?;
        if let Ok(serde_json::Value::Object(e)) = serde_json::from_str::<serde_json::Value>(&extra) {
            if !e.is_empty() {
                obj.insert("_extra".into(), serde_json::Value::Object(e));
            }
        }
        Ok(serde_json::Value::Object(obj))
    })?;
    rows.collect()
}

/// How many rows each table has for a run — the "populates all tables" check.
pub fn table_counts(conn: &Connection, run_id: &str) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut out = Vec::new();
    for (table, _) in TABLES {
        let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM d_{table} WHERE run_id = ?1"), params![run_id], |r| r.get(0))?;
        out.push(((*table).to_string(), n));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use coreview_collect::tables::normalise;
    use serde_json::json;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        discovery_tables(&c).unwrap();
        shadow_columns(&c).unwrap();
        typed_columns(&c).unwrap();
        c
    }

    #[test]
    fn the_shadow_report_counts_per_os_and_command() {
        let c = conn();
        open_run(&c, "run-1", "p1", "seed", false, None, "live").unwrap();
        write_device(&c, "run-1", "dev-1", "h", Some("cisco_ios"), None, &[], "", "", None, &[], None, &[], None).unwrap();
        let entry = |seq: i64, cmd: &str, shadow: Option<&str>, detail: Option<&str>| LogEntry {
            device_id: "dev-1".into(), seq, step_id: cmd.replace(' ', "_"), cmd: cmd.into(), kind: "command".into(), context_kind: None, context_name: None,
            gate: "always".into(), parser: "textfsm:t".into(), feeds: vec![], status: "ok".into(), duration_ms: 1, rows: 1, raw_ref: None, error: None,
            verified: None, shadow: shadow.map(Into::into), shadow_detail: detail.map(Into::into), engine: Some("sidecar".into()),
        };
        write_log(&c, "run-1", "dev-1", 1, &entry(1, "show ip arp", Some("match"), None)).unwrap();
        write_log(&c, "run-1", "dev-1", 2, &entry(2, "show ip arp", Some("mismatch"), Some("row 0 field age: \"0\" vs \"-\""))).unwrap();
        write_log(&c, "run-1", "dev-1", 3, &entry(3, "show version", Some("match"), None)).unwrap();
        write_log(&c, "run-1", "dev-1", 4, &entry(4, "show clock", None, None)).unwrap();
        let report = shadow_report(&c, Some("p1")).unwrap();
        assert_eq!(report.len(), 2, "the command with no shadow verdict is not counted");
        let arp = report.iter().find(|l| l.cmd == "show ip arp").unwrap();
        assert_eq!((arp.os.as_str(), arp.compared, arp.mismatches, arp.errors), ("cisco_ios", 2, 1, 0));
        assert!(arp.last_detail.as_deref().unwrap().contains("field age"));
        assert_eq!(report.iter().find(|l| l.cmd == "show version").unwrap().mismatches, 0);
        assert!(shadow_report(&c, Some("other")).unwrap().is_empty());
        assert_eq!(list_log(&c, "run-1", None).unwrap()[1].shadow.as_deref(), Some("mismatch"));
    }

    #[test]
    fn every_typed_table_exists_and_takes_a_normalised_row() {
        let c = conn();
        open_run(&c, "run-1", "p1", "192.0.2.10", false, None, "live").unwrap();
        write_device(&c, "run-1", "dev-1", "192.0.2.10", Some("cisco_ios"), Some("switch"), &["switching".into()], "Cisco IOS", "SW#", None, &[], None, &[], None).unwrap();
        let arp = normalise("arp", &json!({"ip_address": "192.0.2.1", "mac_address": "0000.0000.0001", "interface": "Vlan10", "age": "0", "protocol": "Internet"}));
        assert!(write_row(&c, "run-1", "dev-1", "show_ip_arp", &arp).unwrap());
        let got = read_table(&c, "run-1", "arp", None).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["ip"], "192.0.2.1");
        assert_eq!(got[0]["_extra"]["protocol"], "Internet");
        assert_eq!(got[0]["_device"], "dev-1");
        for (table, _) in TABLES {
            let n: i64 = c.query_row(&format!("SELECT COUNT(*) FROM d_{table}"), [], |r| r.get(0)).unwrap();
            assert_eq!(n, if *table == "arp" { 1 } else { 0 }, "{table}");
        }
        let counts = table_counts(&c, "run-1").unwrap();
        assert_eq!(counts.iter().find(|(t, _)| t == "arp").unwrap().1, 1);
        assert!(!write_row(&c, "run-1", "dev-1", "x", &normalise("no_such_table", &json!({}))).unwrap());
    }

    #[test]
    fn a_run_its_devices_and_its_log_read_back_and_cascade() {
        let c = conn();
        open_run(&c, "run-1", "p1", "seed", true, Some("/tmp/diag"), "live").unwrap();
        write_device(&c, "run-1", "dev-1", "h", None, None, &[], "", "", Some("vdom"), &["root".into()], Some("auth"), &["no".into()], Some(&json!({"steps": []}))).unwrap();
        let e = LogEntry { device_id: "dev-1".into(), seq: 1, step_id: "show_version".into(), cmd: "show version".into(), kind: "command".into(), context_kind: None, context_name: None, gate: "always".into(), parser: "textfsm:x".into(), feeds: vec!["device".into()], status: "ok".into(), duration_ms: 12, rows: 1, raw_ref: Some("h/001-show-version.txt".into()), error: None, verified: Some("lab".into()), shadow: None, shadow_detail: None, engine: Some("sidecar".into()) };
        write_log(&c, "run-1", "dev-1", 1, &e).unwrap();
        finish_run(&c, "run-1", "finished").unwrap();
        let runs = list_runs(&c, "p1").unwrap();
        assert_eq!(runs.len(), 1);
        assert!(runs[0].plan_only && runs[0].devices == 1 && runs[0].status == "finished" && runs[0].finished_ms.is_some());
        let devices = list_devices(&c, "run-1").unwrap();
        assert_eq!(devices[0].contexts, vec!["root"]);
        assert_eq!(devices[0].failure.as_deref(), Some("auth"));
        assert_eq!(devices[0].plan.as_ref().unwrap()["steps"], json!([]));
        let log = list_log(&c, "run-1", Some("dev-1")).unwrap();
        assert_eq!(log[0].raw_ref.as_deref(), Some("h/001-show-version.txt"));
        assert_eq!(run_project(&c, "run-1").unwrap().as_deref(), Some("p1"));
        c.execute("DELETE FROM collection_runs WHERE id = 'run-1'", []).unwrap();
        assert!(list_devices(&c, "run-1").unwrap().is_empty());
        assert!(list_log(&c, "run-1", None).unwrap().is_empty());
    }
}

/// LT-526: a database made new today must have what a migrated one has.
/// The runner stamps a new database with the current version without
/// running the steps, so a table that only a migration creates was never
/// made on a fresh install.
#[cfg(test)]
mod fresh {
    #[test]
    fn a_brand_new_database_has_the_collection_tables_and_the_shadow_columns() {
        let dir = std::env::temp_dir().join(format!("cv-fresh-{}-{}", std::process::id(), crate::db::now_ms()));
        let conn = crate::db::open(&dir.join("coreview.db")).unwrap();
        for table in ["collection_runs", "collection_devices", "command_log", "d_arp", "d_route", "d_neighbor", "d_link", "d_l3_adjacency"] {
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1", [table], |r| r.get(0)).unwrap();
            assert_eq!(n, 1, "a fresh database has no {table}");
        }
        let cols: Vec<String> = conn.prepare("PRAGMA table_info(command_log)").unwrap().query_map([], |r| r.get::<_, String>(1)).unwrap().filter_map(|r| r.ok()).collect();
        for c in ["shadow", "shadow_detail", "engine"] {
            assert!(cols.iter().any(|x| x == c), "a fresh command_log has no {c}");
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// LT-656: a database made before `ap` had its neighbour columns gets
    /// them on open, and a row with them is written whole.
    #[test]
    fn a_typed_table_made_without_a_column_gains_it() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE d_ap (run_id TEXT NOT NULL, device_id TEXT NOT NULL, command_id TEXT NOT NULL, ap_name TEXT, ap_ip TEXT, extra TEXT NOT NULL DEFAULT '{}', collected_at INTEGER NOT NULL);").unwrap();
        super::discovery_tables(&conn).unwrap();
        super::typed_columns(&conn).unwrap();
        let cols: Vec<String> = conn.prepare("PRAGMA table_info(d_ap)").unwrap().query_map([], |r| r.get::<_, String>(1)).unwrap().filter_map(|r| r.ok()).collect();
        for c in ["nbr_switch", "nbr_ip", "nbr_chassis", "nbr_platform", "local_port"] {
            assert!(cols.iter().any(|x| x == c), "d_ap still has no {c}: {cols:?}");
        }
    }
}

/// Schema 8 (LT-527): the spec's `link` and `l3_adjacency`, written by the
/// topology builder for a collection run. Evidence is kept whole, as JSON.
pub fn topology_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS d_link (
            run_id TEXT NOT NULL REFERENCES collection_runs (id) ON DELETE CASCADE,
            a_dev TEXT NOT NULL, a_if TEXT, b_dev TEXT NOT NULL, b_if TEXT,
            kind TEXT NOT NULL, confidence REAL NOT NULL, both_directions INTEGER NOT NULL,
            lag_group TEXT, evidence TEXT NOT NULL DEFAULT '[]'
        );
        CREATE INDEX IF NOT EXISTS d_link_run ON d_link (run_id);
        CREATE TABLE IF NOT EXISTS d_l3_adjacency (
            run_id TEXT NOT NULL REFERENCES collection_runs (id) ON DELETE CASCADE,
            a_dev TEXT NOT NULL, a_if TEXT, a_vrf TEXT, b_dev TEXT NOT NULL, b_if TEXT, b_vrf TEXT,
            subnet TEXT NOT NULL, proto TEXT, confidence REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS d_l3_adjacency_run ON d_l3_adjacency (run_id);
        "#,
    )
}

/// Replace a run's links and layer-3 adjacencies with the graph's.
pub fn write_topology(conn: &Connection, run_id: &str, graph: &coreview_topology::Graph) -> rusqlite::Result<()> {
    let name = |id: &str| graph.node(id).map(|n| n.name.clone()).unwrap_or_else(|| id.to_string());
    conn.execute("DELETE FROM d_link WHERE run_id = ?1", params![run_id])?;
    conn.execute("DELETE FROM d_l3_adjacency WHERE run_id = ?1", params![run_id])?;
    for l in &graph.links {
        conn.execute(
            "INSERT INTO d_link (run_id, a_dev, a_if, b_dev, b_if, kind, confidence, both_directions, lag_group, evidence) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                run_id,
                name(&l.a.node),
                l.a.port,
                name(&l.b.node),
                l.b.port,
                serde_json::to_value(l.kind).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(),
                l.confidence as f64,
                l.both_directions as i64,
                l.bundle.as_ref().and_then(|b| b.a_name.clone()),
                serde_json::to_string(&l.evidence).unwrap_or_else(|_| "[]".into())
            ],
        )?;
    }
    for a in &graph.l3 {
        conn.execute(
            "INSERT INTO d_l3_adjacency (run_id, a_dev, a_if, a_vrf, b_dev, b_if, b_vrf, subnet, proto, confidence) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![run_id, name(&a.a), a.a_if, a.vrf, name(&a.b), a.b_if, a.vrf, a.subnet, a.confirmed_by.join(","), a.confidence as f64],
        )?;
    }
    Ok(())
}

/// Everything the builder reads for one run: each device and its rows by table.
pub fn topology_input(conn: &Connection, run_id: &str) -> rusqlite::Result<Vec<coreview_topology::DeviceIn>> {
    let mut out = Vec::new();
    for d in list_devices(conn, run_id)? {
        if d.failure.is_some() && d.os.is_none() {
            continue;
        }
        let mut tables = std::collections::BTreeMap::new();
        for (table, _) in TABLES {
            let rows: Vec<coreview_topology::Row> = read_table(conn, run_id, table, Some(&d.device_id))?
                .into_iter()
                .filter_map(|v| {
                    let mut o = v.as_object()?.clone();
                    let command = o.remove("_command").and_then(|c| c.as_str().map(str::to_string)).unwrap_or_default();
                    o.remove("_device");
                    let extra = o.remove("_extra").and_then(|e| e.as_object().cloned()).unwrap_or_default();
                    let columns = o.into_iter().filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string()))).collect();
                    Some(coreview_topology::Row { command, columns, extra })
                })
                .collect();
            if !rows.is_empty() {
                tables.insert((*table).to_string(), rows);
            }
        }
        out.push(coreview_topology::DeviceIn { device_id: d.device_id, host: d.host, os: d.os, role: d.role, prompt: d.prompt, version_text: d.version_text, tables });
    }
    Ok(out)
}

/// LT-527 end to end below the page: rows as a collection writes them, read
/// back as the builder's input, built, written to `d_link`, and stored as a
/// crawl run the review screen reads.
#[cfg(test)]
mod topology_tests {
    use super::*;
    use coreview_collect::tables::normalise;
    use serde_json::json;

    #[test]
    fn a_runs_rows_become_links_and_a_crawl_run() {
        let dir = std::env::temp_dir().join(format!("cv-topo-{}-{}", std::process::id(), crate::db::now_ms()));
        let conn = crate::db::open(&dir.join("coreview.db")).unwrap();
        conn.execute("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P',0,0)", []).unwrap();
        open_run(&conn, "col-1", "p1", "192.0.2.1", false, None, "live").unwrap();
        for (dev, host, name, peer, peer_ip, local, remote) in [("dev-a", "192.0.2.1", "SW-A", "SW-B", "192.0.2.2", "Gi1/0/1", "Gi1/0/2"), ("dev-b", "192.0.2.2", "SW-B", "SW-A", "192.0.2.1", "Gi1/0/2", "Gi1/0/1")] {
            write_device(&conn, "col-1", dev, host, Some("cisco_ios"), Some("switch"), &[], "", &format!("{name}#"), None, &[], None, &[], None).unwrap();
            write_row(&conn, "col-1", dev, "show_version", &normalise("device", &json!({"hostname": name, "serial": format!("FAKE-{name}")}))).unwrap();
            write_row(&conn, "col-1", dev, "show_cdp_neighbors_detail", &{
                let mut n = normalise("neighbor", &json!({"neighbor_name": peer, "local_interface": local, "neighbor_interface": remote, "mgmt_address": peer_ip}));
                n.columns.insert("proto".into(), "cdp".into());
                n
            })
            .unwrap();
            write_row(&conn, "col-1", dev, "show_ip_route", &normalise("route", &json!({"protocol": "S", "network": "0.0.0.0", "prefix_length": "0", "nexthop_ip": "192.0.2.254"}))).unwrap();
        }
        let input = topology_input(&conn, "col-1").unwrap();
        assert_eq!(input.len(), 2);
        assert_eq!(input[0].rows("neighbor")[0].command, "show_cdp_neighbors_detail");
        let graph = coreview_topology::build(&input);
        assert_eq!(graph.links.len(), 1);
        assert!(graph.links[0].both_directions);
        write_topology(&conn, "col-1", &graph).unwrap();
        let (n, conf): (i64, f64) = conn.query_row("SELECT COUNT(*), MAX(confidence) FROM d_link WHERE run_id = 'col-1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((n, conf), (1, 1.0));
        // Stored as a crawl run the way collection_topology stores it, and read back as the review reads one.
        let view = coreview_topology::crawl_view::view(&graph);
        crate::db::open_crawl_run(&conn, "topo-1", "p1", 1, "collection col-1").unwrap();
        for d in &view.devices {
            crate::db::append_crawl_device(&conn, "topo-1", &serde_json::to_string(d).unwrap()).unwrap();
        }
        crate::db::close_crawl_run(&conn, "topo-1", "complete", &json!({"notVisited": view.not_visited, "failures": [], "cancelled": false}).to_string()).unwrap();
        let back = crate::db::crawl_run_result(&conn, "topo-1", "p1").unwrap().unwrap();
        let devices = back["devices"].as_array().unwrap();
        assert_eq!(devices.len(), 2);
        let a = devices.iter().find(|d| d["hostname"] == "SW-A").unwrap();
        assert_eq!(a["neighbors"][0]["shortName"], "SW-B");
        assert_eq!(a["neighbors"][0]["localInterface"], "Gi1/0/1");
        // `details` is flattened into the device, as the crawl writes it.
        assert_eq!(a["routes"][0]["prefix"], "0.0.0.0/0", "Path-Trace reads routes from the newest run");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// LT-531 below the page: route, address and ARP rows as a collection
    /// stores them (the IOS templates' own field names), read back and traced.
    #[test]
    fn a_runs_stored_rows_are_traced() {
        let dir = std::env::temp_dir().join(format!("cv-path-{}-{}", std::process::id(), crate::db::now_ms()));
        let conn = crate::db::open(&dir.join("coreview.db")).unwrap();
        conn.execute("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P',0,0)", []).unwrap();
        open_run(&conn, "col-2", "p1", "192.0.2.1", false, None, "live").unwrap();
        let row = |dev: &str, cmd: &str, table: &str, v: serde_json::Value| write_row(&conn, "col-2", dev, cmd, &normalise(table, &v)).unwrap();
        write_device(&conn, "col-2", "r1", "192.0.2.1", Some("cisco_ios"), Some("router"), &[], "", "R1#", None, &[], None, &[], None).unwrap();
        row("r1", "show_version", "device", json!({"hostname": "R1", "serial": "FAKE-R1"}));
        row("r1", "show_ip_route", "route", json!({"protocol": "C", "network": "192.0.2.0", "prefix_length": "24", "nexthop_if": "GigabitEthernet0/0"}));
        row("r1", "show_ip_route", "route", json!({"protocol": "C", "network": "198.51.100.0", "prefix_length": "30", "nexthop_if": "GigabitEthernet0/1"}));
        row("r1", "show_ip_route", "route", json!({"protocol": "S", "network": "203.0.113.0", "prefix_length": "24", "nexthop_ip": "198.51.100.2"}));
        write_device(&conn, "col-2", "r2", "198.51.100.2", Some("cisco_ios"), Some("router"), &[], "", "R2#", None, &[], None, &[], None).unwrap();
        row("r2", "show_version", "device", json!({"hostname": "R2", "serial": "FAKE-R2"}));
        row("r2", "show_ip_interface_brief", "ip_address", json!({"interface": "GigabitEthernet0/1", "ip_address": "198.51.100.2"}));
        row("r2", "show_ip_route", "route", json!({"protocol": "C", "network": "198.51.100.0", "prefix_length": "30", "nexthop_if": "GigabitEthernet0/1"}));
        row("r2", "show_ip_route", "route", json!({"protocol": "C", "network": "203.0.113.0", "prefix_length": "24", "nexthop_if": "GigabitEthernet0/2"}));
        row("r2", "show_ip_arp", "arp", json!({"address": "203.0.113.9", "mac_address": "0000.0000.0309", "interface": "GigabitEthernet0/2"}));
        let input = topology_input(&conn, "col-2").unwrap();
        let out = coreview_path::trace_run(&input, &coreview_path::Request { from: "192.0.2.10".into(), to: "203.0.113.9".into(), ..Default::default() });
        let p = &out.forward.paths[0];
        assert_eq!(p.hops.iter().map(|h| h.device.as_str()).collect::<Vec<_>>(), vec!["R1", "R2"], "{:#?}", out.forward);
        assert_eq!(p.hops[0].next_hop.as_deref(), Some("198.51.100.2"));
        assert_eq!(p.hops[0].out_interface.as_deref(), Some("GigabitEthernet0/1"));
        assert_eq!(p.hops[1].next_hop_mac.as_deref(), Some("000000000309"));
        assert!(matches!(p.ending, coreview_path::walk::Ending::Delivered { .. }));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
