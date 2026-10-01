//! The collector end to end against `examples/fake_sidecar.rs`: a device
//! is fingerprinted from its `show version`, its probes set flags, the
//! plan runs light first with the gated commands in and the others
//! skipped with a reason, VRFs found expand the second pass, contexts are
//! entered and left, a raw configuration comes back scrubbed, and an
//! authentication failure ends the run without a second try.

use std::path::PathBuf;

use coreview_catalog::load_dir;
use coreview_collect::run::{collect_device, Quiet, RunOptions, Target};
use coreview_collect::sidecar::{Auth, Sidecar, SidecarLocation};
use serde_json::json;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Build the fake once and hand back a `python`-shaped location that runs it.
fn fake_location(script: &serde_json::Value, contexts: &str) -> SidecarLocation {
    // cargo builds every example before running the integration tests; the binary sits beside the test's own.
    let exe = std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().join("examples").join(if cfg!(windows) { "fake_sidecar.exe" } else { "fake_sidecar" });
    assert!(exe.exists(), "no fake sidecar at {}", exe.display());
    let dir = std::env::temp_dir().join(format!("coreview-fake-sidecar-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script_path = dir.join(format!("script-{}.json", rand_suffix()));
    std::fs::write(&script_path, serde_json::to_string(script).unwrap()).unwrap();
    // The client passes `-m coreview_sidecar`; a wrapper script swallows that and sets the script.
    let wrapper = dir.join(format!("run-{}.sh", rand_suffix()));
    std::fs::write(&wrapper, format!("#!/bin/sh\nFAKE_SIDECAR_SCRIPT='{}' FAKE_SIDECAR_CONTEXTS='{}' exec '{}'\n", script_path.display(), contexts, exe.display())).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    SidecarLocation { python: wrapper, cwd: dir, templates_dir: repo().join("resources/templates/ntc") }
}

fn rand_suffix() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() as u64
}

fn auth() -> Auth {
    Auth { username: "reader".into(), password: "not-a-real-password-fixture".into(), enable: None, private_key: None }
}

fn catalyst_script() -> serde_json::Value {
    json!({
        "show version": {"status": "ok", "raw": "Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E7\ncisco WS-C2960X-24TS-L (APM86XXX) processor", "rows": [{"version": "15.2(7)E7", "hostname": "SW-A", "hardware": ["WS-C2960X-24TS-L"], "serial": ["FAKE0000001"]}]},
        "show ip protocols": {"status": "ok", "raw": "*** IP Routing is NSF aware ***\n\nRouting Protocol is \"ospf 1\"\n  Router ID 192.0.2.10", "rows": []},
        "show run | include ^ip routing|^router |^ip route |^vrf definition|^ip vrf |^interface Tunnel|^ip nat |^crypto |^ip policy|^mpls |^interface Port-channel|^ standby|^ vrrp|^ glbp": {"status": "ok", "raw": "ip routing\nvrf definition CUST-A\nrouter ospf 1\n", "rows": []},
        "show vrf": {"status": "ok", "raw": "  Name   Default RD   Protocols   Interfaces\n  CUST-A 65000:1      ipv4        Vl10\n", "rows": [{"name": "CUST-A", "default_rd": "65000:1", "protocols": "ipv4", "interfaces": ["Vl10"]}]},
        "show ip route vrf CUST-A": {"status": "ok", "raw": "S 0.0.0.0/0 via 192.0.2.1", "rows": [{"protocol": "S", "network": "0.0.0.0", "mask": "0", "nexthop_ip": ["192.0.2.1"]}]},
        "show ip arp vrf CUST-A": {"status": "ok", "raw": "Internet 192.0.2.1 0 0000.0000.0001 ARPA Vlan10", "rows": [{"ip_address": "192.0.2.1", "mac_address": "0000.0000.0001", "interface": "Vlan10", "age": "0"}]},
        "show running-config": {"status": "ok", "raw": "hostname SW-A\nenable secret 5 $1$FAKE$notreal\nsnmp-server community FAKE-COMMUNITY RO\nend", "rows": []},
        "show ip ospf neighbor": {"status": "ok", "raw": "Neighbor ID Pri State Dead Time Address Interface\n192.0.2.11 1 FULL/DR 00:00:35 192.0.2.11 Vlan10", "rows": [{"neighbor_id": "192.0.2.11", "priority": "1", "state": "FULL/DR", "dead_time": "00:00:35", "address": "192.0.2.11", "interface": "Vlan10"}]},
        "show cdp neighbors detail": {"status": "ok", "raw": "Device ID: SW-B", "rows": [{"neighbor_name": "SW-B", "local_interface": "Gi1/0/1", "neighbor_interface": "Gi1/0/24", "management_ip": "192.0.2.11", "platform": "cisco WS-C2960X", "capabilities": "Switch IGMP"}]}
    })
}

#[tokio::test]
async fn a_catalyst_is_recognised_probed_planned_and_run_light_first() {
    let catalogs = load_dir(&repo().join("resources/catalog")).unwrap();
    let loc = fake_location(&catalyst_script(), "[]");
    let mut sidecar = Sidecar::spawn(&loc).await.expect("the fake sidecar starts");
    let target = Target { host: "192.0.2.10".into(), port: 22, os_hint: None, role_override: None, known_host_key: None };
    let run = collect_device(&mut sidecar, &catalogs, &target, &auth(), &RunOptions::default(), &Quiet).await;
    assert_eq!(run.failure, None, "{:?}", run.log);
    assert_eq!(run.os.as_deref(), Some("cisco_ios"));
    assert_eq!(run.identified_by.as_deref(), Some("show version"));
    assert_eq!(run.role.as_deref(), Some("switch"));
    // The probe answered OSPF, so routing and ospf are on and the ospf command ran.
    assert!(run.caps.contains(&"ospf".to_string()) && run.caps.contains(&"routing".to_string()), "{:?}", run.caps);
    let probe = run.probes.iter().find(|p| p.id == "show_ip_protocols").unwrap();
    assert_eq!(probe.flags_set, vec!["ospf", "routing"]);
    let cmds: Vec<&str> = run.results.iter().map(|r| r.step.cmd.as_str()).collect();
    assert!(cmds.contains(&"show ip ospf neighbor"), "{cmds:?}");
    assert!(cmds.contains(&"show cdp neighbors detail"));
    // BGP was never set, so its command was skipped and says why.
    let plan = run.plan.as_ref().unwrap();
    assert!(plan.skipped.iter().any(|s| s.cmd == "show bgp all summary" && s.reason.contains("cap.bgp")), "{:?}", plan.skipped);
    // Light before heavy: the running-config (heavy) comes after every light command.
    let heavy_at = cmds.iter().position(|c| *c == "show running-config").unwrap();
    let light_after = run.results[heavy_at..].iter().filter(|r| r.step.weight == coreview_catalog::Weight::Light && r.step.context.is_none()).count();
    assert_eq!(light_after, 0, "a light command ran after the heavy configuration: {cmds:?}");
    // The VRF the first pass found expanded the second pass.
    assert!(cmds.contains(&"show ip route vrf CUST-A"), "{cmds:?}");
    assert!(cmds.contains(&"show ip arp vrf CUST-A"), "{cmds:?}");
    // The configuration came back scrubbed.
    let cfg = run.results.iter().find(|r| r.step.cmd == "show running-config").unwrap();
    assert!(!cfg.outcome.raw.contains("FAKE-COMMUNITY") && !cfg.outcome.raw.contains("$1$FAKE"), "{}", cfg.outcome.raw);
    // The type digit stays (it says what kind of hash was there); the hash does not.
    assert!(cfg.outcome.raw.contains("enable secret 5 <removed-by-coreview>"), "{}", cfg.outcome.raw);
    // A command the fake does not know is unsupported, not fatal.
    let unsupported = run.results.iter().filter(|r| r.outcome.status == "unsupported").count();
    assert!(unsupported > 0);
    sidecar.quit().await;
}

#[tokio::test]
async fn a_fortigate_with_vdoms_runs_its_vdom_commands_inside_each_one() {
    let catalogs = load_dir(&repo().join("resources/catalog")).unwrap();
    let script = json!({
        "get system status": {"status": "ok", "raw": "Version: FortiGate-60F v7.2.8,build1639,240208 (GA.M)\nVirtual domain configuration: multiple\nCurrent HA mode: standalone", "rows": []},
        "get system interface physical": {"status": "ok", "raw": "==[port1]\n", "rows": [{"interface": "port1", "ip": "192.0.2.1", "mask": "255.255.255.0", "status": "up"}]},
        "get router info routing-table all": {"status": "ok", "raw": "S* 0.0.0.0/0 [10/0] via 192.0.2.254, port1", "rows": [{"protocol": "S", "network": "0.0.0.0/0", "nexthop_ip": "192.0.2.254", "interface": "port1"}]}
    });
    let loc = fake_location(&script, r#"["root","dmz"]"#);
    let mut sidecar = Sidecar::spawn(&loc).await.unwrap();
    let target = Target { host: "192.0.2.1".into(), port: 22, os_hint: None, role_override: None, known_host_key: None };
    let run = collect_device(&mut sidecar, &catalogs, &target, &auth(), &RunOptions::default(), &Quiet).await;
    assert_eq!(run.failure, None, "{:?}", run.log);
    assert_eq!(run.os.as_deref(), Some("fortios"));
    assert_eq!(run.context_kind.as_deref(), Some("vdom"));
    assert_eq!(run.contexts, vec!["root", "dmz"]);
    assert!(run.caps.contains(&"vdom".to_string()));
    let per_vdom: Vec<(&str, &str)> = run.results.iter().filter_map(|r| r.step.context.as_ref().map(|c| (c.1.as_str(), r.step.cmd.as_str()))).collect();
    assert!(per_vdom.contains(&("root", "get router info routing-table all")), "{per_vdom:?}");
    assert!(per_vdom.contains(&("dmz", "get router info routing-table all")), "{per_vdom:?}");
    let global: Vec<&str> = run.results.iter().filter(|r| r.step.scope.as_deref() == Some("global")).map(|r| r.step.cmd.as_str()).collect();
    assert!(global.contains(&"get system interface physical"), "{global:?}");
    sidecar.quit().await;
}

/// LT-547: a live check on a hop in a VDOM is asked inside that VDOM — the
/// switch comes before the first command, and the session goes back after.
#[tokio::test]
async fn a_live_check_asks_inside_the_hops_vdom() {
    let catalogs = load_dir(&repo().join("resources/catalog")).unwrap();
    let fortios = catalogs.iter().find(|c| c.os == "fortios").unwrap();
    let script = json!({"get router info routing-table details 203.0.113.5": {"status": "ok", "raw": "Routing table for VRF=0\nRouting entry for 203.0.113.0/24\n  Known via \"static\", distance 10, metric 0, best\n  * vrf 0 192.0.2.254, via port1\n", "rows": []}});
    let loc = fake_location(&script, r#"["root","dmz"]"#);
    let mut sidecar = Sidecar::spawn(&loc).await.unwrap();
    let target = Target { host: "192.0.2.1".into(), port: 22, os_hint: Some("fortios".into()), role_override: None, known_host_key: None };
    let vars: std::collections::BTreeMap<String, String> = [("dst", "203.0.113.5"), ("src", "192.0.2.10"), ("vrf", "default")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    let _ = sidecar.drain_events();
    let run = coreview_collect::live::ask(&mut sidecar, fortios, &target, &auth(), &RunOptions::default(), &vars, Some(("vdom".into(), "dmz".into()))).await;
    assert_eq!(run.failure, None, "{:?}", run.log);
    assert!(run.log.iter().any(|l| l == "asked inside vdom dmz"), "{:?}", run.log);
    let ops: Vec<String> = sidecar.drain_events().iter().filter_map(|e| e.extra.get("msg").and_then(|m| m.as_str()).map(str::to_string)).collect();
    let first_switch = ops.iter().position(|o| o == "switch").expect("a switch");
    let first_run = ops.iter().position(|o| o == "run").expect("a run");
    assert!(first_switch < first_run, "{ops:?}");
    assert_eq!(ops.iter().filter(|o| *o == "switch").count(), 2, "in, then back out: {ops:?}");
    let answer = run.answers.iter().find(|a| a.command == "get router info routing-table details 203.0.113.5").unwrap();
    assert!(answer.raw.contains("192.0.2.254"));
    sidecar.quit().await;
}

/// LT-550: a Proxmox host, recognised by `ip -j link`, flagged by
/// `pveversion`, read through Coreview's readers. JSON in the shapes of
/// iproute2's and lldpd's documentation, not captured (D-058).
#[tokio::test]
async fn a_proxmox_host_is_recognised_and_read_through_its_readers() {
    let catalogs = load_dir(&repo().join("resources/catalog")).unwrap();
    let addr = r#"[{"ifindex":2,"ifname":"vmbr0","operstate":"UP","mtu":1500,"link_type":"ether","address":"00:00:00:00:00:10","addr_info":[{"family":"inet","local":"192.0.2.40","prefixlen":24,"scope":"global"}]}]"#;
    let lldp = r#"{"lldp":{"interface":{"eno1":{"chassis":{"SW1":{"id":{"type":"mac","value":"00:00:00:00:00:20"},"mgmt-ip":"192.0.2.1"}},"port":{"id":{"type":"ifname","value":"Gi1/0/5"}}}}}}"#;
    let script = json!({
        "ip -j link": {"status": "ok", "raw": "[{\"ifindex\":2,\"ifname\":\"vmbr0\"}]", "rows": []},
        "pveversion": {"status": "ok", "raw": "pve-manager/8.2.2/9355359cd7afbae4 (running kernel: 6.8.4-2-pve)", "rows": []},
        "ip -j addr": {"status": "ok", "raw": addr, "rows": []},
        "lldpcli show neighbors -f json": {"status": "ok", "raw": lldp, "rows": []},
        "ip -j neigh": {"status": "ok", "raw": "[]", "rows": [{"dst": "192.0.2.1", "dev": "vmbr0", "lladdr": "00:00:00:00:00:20", "state": ["REACHABLE"]}]}
    });
    let loc = fake_location(&script, "[]");
    let mut sidecar = Sidecar::spawn(&loc).await.unwrap();
    let target = Target { host: "192.0.2.40".into(), port: 22, os_hint: None, role_override: None, known_host_key: None };
    let run = collect_device(&mut sidecar, &catalogs, &target, &auth(), &RunOptions::default(), &Quiet).await;
    assert_eq!(run.failure, None, "{:?}", run.log);
    assert_eq!(run.os.as_deref(), Some("hosts"));
    assert_eq!(run.identified_by.as_deref(), Some("ip -j link"));
    assert_eq!(run.role.as_deref(), Some("host"));
    assert!(run.caps.contains(&"proxmox".to_string()), "{:?}", run.caps);
    let by = |id: &str| run.results.iter().find(|r| r.step.id == id).unwrap_or_else(|| panic!("{id} not run"));
    let a = by("ip_j_addr");
    assert_eq!(a.outcome.engine.as_deref(), Some("rust"), "read by Coreview's reader, not the sidecar");
    assert_eq!(a.outcome.rows[1]["ip_address"], "192.0.2.40");
    let n = by("lldpcli_show_neighbors_f_json");
    assert_eq!((n.outcome.rows[0]["neighbor_name"].as_str(), n.outcome.rows[0]["neighbor_interface"].as_str()), (Some("SW1"), Some("Gi1/0/5")));
    // What is normalised from them is what P2 and P3 read.
    let tables = coreview_collect::tables::normalise_all(&a.step.feeds, &a.outcome.rows);
    assert!(tables.iter().any(|t| t.table == "ip_address" && t.columns.get("ip").map(String::as_str) == Some("192.0.2.40") && t.columns.get("prefixlen").map(String::as_str) == Some("24")));
    assert!(tables.iter().any(|t| t.table == "interface" && t.columns.get("mac").map(String::as_str) == Some("00:00:00:00:00:10")));
    sidecar.quit().await;
}

#[tokio::test]
async fn a_wrong_password_ends_the_run_at_once_with_no_second_try() {
    let catalogs = load_dir(&repo().join("resources/catalog")).unwrap();
    let loc = fake_location(&catalyst_script(), "[]");
    let mut sidecar = Sidecar::spawn(&loc).await.unwrap();
    let target = Target { host: "192.0.2.10".into(), port: 22, os_hint: None, role_override: None, known_host_key: None };
    let bad = Auth { username: "reader".into(), password: "wrong-password-fixture".into(), enable: None, private_key: None };
    let run = collect_device(&mut sidecar, &catalogs, &target, &bad, &RunOptions::default(), &Quiet).await;
    assert_eq!(run.failure.as_deref(), Some("auth"));
    assert!(run.results.is_empty() && run.probes.is_empty());
    sidecar.quit().await;
}

#[tokio::test]
async fn an_os_hint_skips_the_fingerprint_and_an_unknown_device_says_so() {
    let catalogs = load_dir(&repo().join("resources/catalog")).unwrap();
    let loc = fake_location(&catalyst_script(), "[]");
    let mut sidecar = Sidecar::spawn(&loc).await.unwrap();
    let target = Target { host: "192.0.2.10".into(), port: 22, os_hint: Some("cisco_ios".into()), role_override: Some("router".into()), known_host_key: None };
    let run = collect_device(&mut sidecar, &catalogs, &target, &auth(), &RunOptions { light_only: true, ..Default::default() }, &Quiet).await;
    assert_eq!(run.failure, None);
    assert_eq!(run.role.as_deref(), Some("router"));
    assert!(run.results.iter().all(|r| r.step.weight == coreview_catalog::Weight::Light));
    assert!(!run.results.iter().any(|r| r.step.cmd == "show running-config"));

    let unknown = fake_location(&json!({"show version": {"status": "ok", "raw": "Welcome to NoSuchOS 1.0", "rows": []}}), "[]");
    let mut sidecar2 = Sidecar::spawn(&unknown).await.unwrap();
    let run2 = collect_device(&mut sidecar2, &catalogs, &Target { host: "192.0.2.99".into(), port: 22, os_hint: None, role_override: None, known_host_key: None }, &auth(), &RunOptions::default(), &Quiet).await;
    assert_eq!(run2.failure.as_deref(), Some("unrecognised"));
    sidecar.quit().await;
    sidecar2.quit().await;
}

#[tokio::test]
async fn parse_answers_without_a_device_and_a_dead_sidecar_is_an_error_not_a_hang() {
    let loc = fake_location(&json!({}), "[]");
    let mut sidecar = Sidecar::spawn(&loc).await.unwrap();
    let r = sidecar.parse("cisco_ios", "show ip arp", "textfsm:cisco_ios_show_ip_arp", &[], "raw text").await.unwrap();
    assert_eq!(r.status, "ok");
    assert_eq!(r.rows[0]["parsed"], "textfsm:cisco_ios_show_ip_arp");
    let events = sidecar.drain_events();
    assert!(events.iter().any(|e| e.event == "log"));
    sidecar.quit().await;
    let missing = SidecarLocation { python: PathBuf::from("/no/such/python"), cwd: std::env::temp_dir(), templates_dir: std::env::temp_dir() };
    assert!(matches!(Sidecar::spawn(&missing).await, Err(coreview_collect::SidecarError::Spawn(_))));
}

/// LT-522: the guard is in the client, so a write verb never reaches the
/// process however it was built — the fake reports on `close` everything
/// it was ever sent.
#[tokio::test]
async fn a_refused_command_never_reaches_the_sidecar_process() {
    let loc = fake_location(&json!({"show version": {"status": "ok", "raw": "Cisco IOS Software", "rows": []}}), "[]");
    let mut sidecar = Sidecar::spawn(&loc).await.unwrap();
    let opened = sidecar.open("s", "192.0.2.10", 22, "cisco_ios", &auth(), &json!({}), 5000, 5000, None).await.unwrap();
    assert_eq!(opened.status, "ok");
    let ok = sidecar.run("s", "show version", "none", &[], 5000).await.unwrap();
    assert_eq!(ok.status, "ok");
    for bad in ["reload", "configure terminal", "show version ; write memory", "show run | redirect flash:x", "copy running-config startup-config"] {
        let r = sidecar.run("s", bad, "none", &[], 5000).await.unwrap();
        assert_eq!(r.status, "refused", "{bad}");
        assert!(r.error.as_deref().unwrap_or("").contains("read-only allowlist"), "{bad}: {:?}", r.error);
    }
    let closed = sidecar.close("s").await.unwrap();
    let sent: Vec<String> = closed.extra.get("sent").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
    assert_eq!(sent, vec!["show version"], "the process saw {sent:?}");
    sidecar.quit().await;
}


/// LT-521: with the Rust engine and shadow on, every `textfsm:` reply the
/// sidecar parsed is parsed again in Rust and the rows compared; with the
/// catalog flipped to `parser_engine: rust`, the sidecar is asked for no
/// parse at all and the rows are Rust's.
#[tokio::test]
async fn shadow_mode_compares_both_parsers_and_a_flipped_os_parses_in_rust() {
    use coreview_catalog::textfsm::Engine;
    let arp_raw = "Protocol  Address          Age (min)  Hardware Addr   Type   Interface\nInternet  192.0.2.1               0   0000.0000.0001  ARPA   Vlan10\n";
    let engine = std::sync::Arc::new(Engine::new(repo().join("resources/templates/ntc")));
    let rust_arp: Vec<serde_json::Value> = engine.parse("cisco_ios_show_ip_arp", &[], arp_raw).unwrap().into_iter().map(serde_json::Value::Object).collect();
    let mut script = catalyst_script();
    // The sidecar agrees on the ARP table …
    script["show ip arp"] = json!({"status": "ok", "raw": arp_raw, "rows": rust_arp});
    // … and is made to disagree on the inventory.
    script["show inventory"] = json!({"status": "ok", "raw": "NAME: \"1\", DESCR: \"WS-C2960X-24TS-L\"\nPID: WS-C2960X-24TS-L  , VID: V05  , SN: FAKE0000001\n", "rows": [{"name": "1", "descr": "WRONG", "pid": "WS-C2960X-24TS-L", "vid": "V05", "sn": "FAKE0000001"}]});
    let catalogs = load_dir(&repo().join("resources/catalog")).unwrap();
    let loc = fake_location(&script, "[]");
    let mut sidecar = Sidecar::spawn(&loc).await.unwrap();
    let target = Target { host: "192.0.2.10".into(), port: 22, os_hint: Some("cisco_ios".into()), role_override: None, known_host_key: None };
    let options = RunOptions { engine: Some(engine.clone()), shadow: true, ..Default::default() };
    let run = collect_device(&mut sidecar, &catalogs, &target, &auth(), &options, &Quiet).await;
    let by = |cmd: &str| run.results.iter().find(|r| r.step.cmd == cmd).unwrap().outcome.clone();
    let arp = by("show ip arp");
    assert_eq!(arp.shadow.as_ref().unwrap().verdict, "match", "{:?}", arp.shadow);
    let inv = by("show inventory");
    let s = inv.shadow.as_ref().unwrap();
    assert_eq!(s.verdict, "mismatch");
    assert!(s.detail.as_deref().unwrap().contains("row 0 field descr"), "{:?}", s.detail);
    assert_eq!(inv.engine.as_deref(), Some("sidecar"), "shadow mode does not change whose rows are kept");
    // A command the fake refuses was never parsed, so it has no verdict.
    assert!(run.results.iter().filter(|r| r.outcome.status == "unsupported").all(|r| r.outcome.shadow.is_none()));
    sidecar.quit().await;

    // Flipped: the sidecar returns wrong rows, and they are not the ones kept.
    let mut flipped = catalogs.clone();
    flipped.iter_mut().find(|c| c.os == "cisco_ios").unwrap().parser_engine = Some("rust".into());
    let mut sidecar = Sidecar::spawn(&fake_location(&script, "[]")).await.unwrap();
    let run = collect_device(&mut sidecar, &flipped, &target, &auth(), &RunOptions { engine: Some(engine), shadow: true, ..Default::default() }, &Quiet).await;
    let inv = run.results.iter().find(|r| r.step.cmd == "show inventory").unwrap().outcome.clone();
    assert_eq!(inv.engine.as_deref(), Some("rust"));
    assert_eq!(inv.rows[0]["descr"], "WS-C2960X-24TS-L", "the Rust engine's rows, not the sidecar's");
    assert!(inv.shadow.is_none(), "a flipped OS is not shadowed");
    sidecar.quit().await;
}

/// LT-588: a sidecar that stops answering ends its device at once, is
/// replaced, and the run goes on — the next device is still collected.
#[tokio::test]
async fn a_sidecar_that_dies_on_one_device_is_replaced_and_the_next_device_is_still_collected() {
    use coreview_collect::collector::SidecarSlot;
    let catalogs = load_dir(&repo().join("resources/catalog")).unwrap();
    let mut script = catalyst_script();
    script["show cdp neighbors detail"]["crash_once"] = json!(true);
    let mut slot = SidecarSlot::new(fake_location(&script, "[]"));
    let never = tokio_util::sync::CancellationToken::new();
    let target = |h: &str| Target { host: h.into(), port: 22, os_hint: None, role_override: None, known_host_key: None };
    let started = std::time::Instant::now();
    let first = slot.collect(&catalogs, &target("192.0.2.10"), &auth(), &RunOptions::default(), &Quiet, &never).await.expect("not cancelled");
    assert_eq!(first.failure.as_deref(), Some("sidecar"), "{:?}", first.log);
    assert!(started.elapsed() < std::time::Duration::from_secs(20), "a dead sidecar is not waited on: {:?}", started.elapsed());
    let second = slot.collect(&catalogs, &target("192.0.2.11"), &auth(), &RunOptions::default(), &Quiet, &never).await.expect("not cancelled");
    assert_eq!(second.failure, None, "the next device gets a fresh sidecar: {:?}", second.log);
    assert!(second.results.iter().any(|r| r.step.cmd == "show cdp neighbors detail" && r.outcome.status == "ok"));
    slot.quit().await;
}

/// LT-589: Stop ends the device in progress at once, whatever it is waiting on.
#[tokio::test]
async fn stop_ends_a_device_stuck_on_a_command_at_once() {
    use coreview_collect::collector::SidecarSlot;
    let catalogs = load_dir(&repo().join("resources/catalog")).unwrap();
    let mut script = catalyst_script();
    script["show cdp neighbors detail"]["stall"] = json!(true);
    let mut slot = SidecarSlot::new(fake_location(&script, "[]"));
    let stop = tokio_util::sync::CancellationToken::new();
    let stopper = stop.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        stopper.cancel();
    });
    let started = std::time::Instant::now();
    let target = Target { host: "192.0.2.10".into(), port: 22, os_hint: None, role_override: None, known_host_key: None };
    let out = slot.collect(&catalogs, &target, &auth(), &RunOptions::default(), &Quiet, &stop).await;
    assert!(out.is_none(), "a cancelled device reports nothing");
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "Stop waited {:?}", started.elapsed());
    slot.quit().await;
}

/// LT-611: a probe that times out is not followed by a 45 s wait on a
/// close the stuck sidecar cannot answer. The fingerprint's own wait is
/// 20 s plus the client's 15; the close used to add 45 more.
#[tokio::test]
async fn a_stuck_fingerprint_probe_is_not_followed_by_a_close_wait() {
    let catalogs = load_dir(&repo().join("resources/catalog")).unwrap();
    let mut script = catalyst_script();
    script["show version"]["stall"] = json!(true);
    let loc = fake_location(&script, "[]");
    let mut sidecar = Sidecar::spawn(&loc).await.unwrap();
    let target = Target { host: "192.0.2.10".into(), port: 22, os_hint: None, role_override: None, known_host_key: None };
    let started = std::time::Instant::now();
    let run = collect_device(&mut sidecar, &catalogs, &target, &auth(), &RunOptions::default(), &Quiet).await;
    assert_eq!(run.failure.as_deref(), Some("sidecar"));
    assert!(started.elapsed() < std::time::Duration::from_secs(60), "waited {:?}", started.elapsed());
}

/// LT-617: a sidecar that cannot be started ends the run, rather than
/// being tried again for every device still queued.
#[tokio::test]
async fn a_sidecar_that_cannot_start_is_the_runs_end() {
    use coreview_collect::collector::SidecarSlot;
    let catalogs = load_dir(&repo().join("resources/catalog")).unwrap();
    let mut loc = fake_location(&catalyst_script(), "[]");
    loc.python = std::path::PathBuf::from("/nonexistent/python-fixture");
    let mut slot = SidecarSlot::new(loc);
    let never = tokio_util::sync::CancellationToken::new();
    let target = Target { host: "192.0.2.10".into(), port: 22, os_hint: None, role_override: None, known_host_key: None };
    let run = slot.collect(&catalogs, &target, &auth(), &RunOptions::default(), &Quiet, &never).await.expect("a run, failed");
    assert_eq!(run.failure.as_deref(), Some("sidecar"));
    assert!(slot.lost(), "the slot says the sidecar is gone for good");
    slot.quit().await;
}

/// LT-627: a command that times out takes the device's SSH session with
/// it. The device ends there as `timeout`, with what it had; the sidecar is
/// not the one at fault, so the next device still uses it.
#[tokio::test]
async fn a_timed_out_command_ends_the_device_and_keeps_the_sidecar() {
    use coreview_collect::collector::SidecarSlot;
    let catalogs = load_dir(&repo().join("resources/catalog")).unwrap();
    let mut script = catalyst_script();
    script["show cdp neighbors detail"]["status_once"] = json!("timeout");
    let mut slot = SidecarSlot::new(fake_location(&script, "[]"));
    let never = tokio_util::sync::CancellationToken::new();
    let target = |h: &str| Target { host: h.into(), port: 22, os_hint: None, role_override: None, known_host_key: None };
    let first = slot.collect(&catalogs, &target("192.0.2.10"), &auth(), &RunOptions::default(), &Quiet, &never).await.unwrap();
    assert_eq!(first.failure.as_deref(), Some("timeout"), "{:?}", first.log);
    assert!(first.results.iter().any(|r| r.step.cmd == "show version"), "what came before it stands");
    assert!(!first.results.iter().any(|r| r.step.cmd == "show running-config"), "nothing after it is asked: {:?}", first.results.iter().map(|r| &r.step.cmd).collect::<Vec<_>>());
    assert!(!slot.lost());
    let second = slot.collect(&catalogs, &target("192.0.2.11"), &auth(), &RunOptions::default(), &Quiet, &never).await.unwrap();
    assert_eq!(second.failure, None, "{:?}", second.log);
    slot.quit().await;
}
