//! The lab run (LT-558): Coreview's own collection over real devices,
//! headless, through the same code the app runs — the real sidecar, each
//! device fingerprinted and its full plan sent read-only, both parsers in
//! shadow mode, rows stored through `tables::rows_for_step` — then the P2
//! topology and, when asked, P3 paths. A lab harness: kept.
//!
//!     COREVIEW_LAB_PASSWORD=… cargo run -p coreview-path --example lab_run -- \
//!         --user reader --out /somewhere/outside/the/repo 192.0.2.1 192.0.2.2 … \
//!         [--trace 192.0.2.50 203.0.113.9 [--flow tcp/443]]… \
//!         [--follow <hops> [--subnet 192.0.2.0/24]] [--api-user <name>]
//!
//! `--follow` collects the hosts as seeds and follows their CDP/LLDP
//! neighbours as "Discover devices" does (LT-576). `--api-user` adds the
//! REST side for FortiOS and AOS-CX, its key from COREVIEW_LAB_API_KEY.
//!
//! `--replay <dir>` in place of the hosts reads an earlier run's stored
//! replies again through today's readers and templates — no device is
//! touched and no password is needed — and writes the graph and traces
//! beside them.
//!
//! The password comes only from the environment. Everything written — each
//! device's summary, every reply (scrubbed, the password masked), the
//! graph, the traces — goes under `--out`, which should not be in the
//! repository: it is the lab's own data (D-027).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use coreview_catalog::plan::Step;
use coreview_catalog::{load_dir, Catalog};
use coreview_catalog::textfsm::Engine;
use coreview_collect::run::{collect_device, settle, CommandOutcome, Quiet, RunOptions, Target};
use coreview_collect::scrub::scrub;
use coreview_collect::sidecar::{Auth, Sidecar, SidecarLocation};
use coreview_collect::tables::{rows_for_step, rows_of};
use coreview_topology::{DeviceIn, Row};
use serde_json::json;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        out.push(if c.is_ascii_alphanumeric() || c == '.' { c.to_ascii_lowercase() } else { '-' });
    }
    out.split('-').filter(|x| !x.is_empty()).collect::<Vec<_>>().join("-")
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |n: &str| args.iter().position(|a| a == n).and_then(|i| args.get(i + 1).cloned());
    let replay = arg("--replay").map(PathBuf::from);
    let (user, out) = match (&replay, arg("--user"), arg("--out")) {
        (Some(dir), _, _) => (String::new(), dir.to_string_lossy().into_owned()),
        (None, Some(user), Some(out)) => (user, out),
        _ => {
            eprintln!("usage: lab_run --user <name> --out <dir> <host>… [--trace <from> <to>]…\n       lab_run --replay <dir> [--trace <from> <to>]…");
            std::process::exit(2);
        }
    };
    // Hosts: every bare argument that is not a flag or a flag's value.
    let mut hosts = Vec::new();
    let mut traces: Vec<(String, String, Option<String>)> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--user" | "--out" | "--replay" | "--follow" | "--subnet" | "--api-user" => i += 2,
            "--trace" => {
                let flow = (args.get(i + 3).map(String::as_str) == Some("--flow")).then(|| args.get(i + 4).cloned()).flatten();
                traces.push((args[i + 1].clone(), args[i + 2].clone(), flow.clone()));
                i += if flow.is_some() { 5 } else { 3 };
            }
            h => {
                hosts.push(h.to_string());
                i += 1;
            }
        }
    }
    let out = PathBuf::from(out);
    std::fs::create_dir_all(&out).unwrap();
    let catalogs = load_dir(&repo().join("resources/catalog")).expect("the catalogs");
    let templates = repo().join("resources/templates/ntc");
    let devices = match replay {
        Some(dir) => replayed(&dir, &catalogs, &RunOptions { engine: Some(Arc::new(Engine::new(&templates))), ..RunOptions::default() }),
        None => {
            let limits = coreview_collect::follow::Limits {
                max_hops: arg("--follow").and_then(|h| h.parse().ok()).unwrap_or(0),
                max_devices: if arg("--follow").is_some() { 50 } else { hosts.len() },
                subnets: arg("--subnet").map(|s| coreview_collect::follow::parse_subnet(&s).expect("--subnet")).into_iter().collect(),
            };
            collected(&hosts, &user, &out, &catalogs, &templates, limits, arg("--follow").is_some(), arg("--api-user")).await
        }
    };
    report(&devices, &out, &traces);
}

/// Each host collected now, its replies and summary written under `out`.
// A lab harness's knobs, passed flat.
#[allow(clippy::too_many_arguments)]
async fn collected(hosts: &[String], user: &str, out: &std::path::Path, catalogs: &[Catalog], templates: &std::path::Path, limits: coreview_collect::follow::Limits, following: bool, api_user: Option<String>) -> Vec<DeviceIn> {
    let password = std::env::var("COREVIEW_LAB_PASSWORD").unwrap_or_else(|_| {
        eprintln!("COREVIEW_LAB_PASSWORD is not set");
        std::process::exit(2);
    });
    let user = user.to_string();
    let templates = templates.to_path_buf();
    let venv = std::env::var("COREVIEW_SIDECAR_PYTHON").map(PathBuf::from).unwrap_or_else(|_| repo().join("sidecar/.venv/bin/python"));
    let location = SidecarLocation { python: venv, cwd: repo().join("sidecar"), templates_dir: templates.clone() };
    let options = RunOptions { engine: Some(Arc::new(Engine::new(&templates))), shadow: true, connect_ms: 10_000, auth_ms: 30_000, ..RunOptions::default() };
    let auth = Auth { username: user, password: password.clone(), enable: None, private_key: None };
    let api = api_user.map(|username| coreview_collect::api::ApiLogin {
        username,
        secret: std::env::var("COREVIEW_LAB_API_KEY").unwrap_or_else(|_| {
            eprintln!("--api-user needs COREVIEW_LAB_API_KEY");
            std::process::exit(2);
        }),
        port: std::env::var("COREVIEW_LAB_API_PORT").ok().and_then(|p| p.parse().ok()),
    });
    let api_secret = api.as_ref().map(|a| a.secret.clone()).unwrap_or_else(|| password.clone());
    let mask = |s: &str| scrub(s).replace(&password, "********").replace(&api_secret, "********");
    let mut frontier = coreview_collect::follow::Frontier::new(hosts, limits);

    let mut devices: Vec<DeviceIn> = Vec::new();
    let mut shadow: BTreeMap<String, (usize, usize, Vec<String>)> = BTreeMap::new();
    while let Some((host, hop)) = frontier.next_device() {
        let host = &host;
        let mut sidecar = Sidecar::spawn(&location).await.expect("the sidecar starts");
        let started = std::time::Instant::now();
        let target = Target { host: host.clone(), port: 22, os_hint: None, role_override: None, known_host_key: None };
        let mut run = collect_device(&mut sidecar, catalogs, &target, &auth, &options, &Quiet).await;
        sidecar.quit().await;
        if let Some(login) = &api {
            coreview_collect::api::collect_for(&mut run, catalogs, login, None, |_: &str, _: u16| None, &Quiet).await;
        }
        if following {
            let (own, neighbours) = coreview_collect::follow::addresses_of_run(&run);
            frontier.learn(hop, &own, &neighbours);
        }
        let dir = out.join(slug(host));
        std::fs::create_dir_all(&dir).unwrap();
        let mut steps = Vec::new();
        let mut tables: BTreeMap<String, Vec<Row>> = BTreeMap::new();
        for (n, r) in run.results.iter().enumerate() {
            std::fs::write(dir.join(format!("{:03}-{}.txt", n + 1, slug(&r.step.cmd))), mask(&r.outcome.raw)).ok();
            let rows = if r.outcome.status == "ok" { rows_of(&r.step.parser, &r.outcome) } else { Vec::new() };
            for n in rows_for_step(&r.step, &rows) {
                tables.entry(n.table.clone()).or_default().push(Row { command: r.step.id.clone(), columns: n.columns, extra: n.extra });
            }
            if let (Some(os), Some(s)) = (&run.os, &r.outcome.shadow) {
                let e = shadow.entry(format!("{os}\t{}", r.step.cmd)).or_default();
                if s.verdict == "match" {
                    e.0 += 1;
                } else {
                    e.1 += 1;
                    e.2.push(format!("{host}: {} {}", s.verdict, s.detail.clone().unwrap_or_default()));
                }
            }
            steps.push(json!({"cmd": r.step.cmd, "parser": r.step.parser, "verified": format!("{:?}", r.step.verified).to_lowercase(), "status": r.outcome.status, "rows": rows.len(), "engine": r.outcome.engine, "shadow": r.outcome.shadow, "error": r.outcome.error.as_deref().map(mask)}));
        }
        let summary = json!({
            "host": host, "os": run.os, "identified_by": run.identified_by, "role": run.role, "caps": run.caps,
            "contexts": run.contexts, "failure": run.failure, "prompt": run.prompt, "version_text": mask(&run.version_text), "log": run.log.iter().map(|l| mask(l)).collect::<Vec<_>>(),
            "seconds": started.elapsed().as_secs(), "host_key": run.host_key, "steps": steps,
            "skipped": run.plan.as_ref().map(|p| p.skipped.iter().map(|s| format!("{} — {}", s.cmd, s.reason)).collect::<Vec<_>>()),
        });
        std::fs::write(dir.join("summary.json"), serde_json::to_string_pretty(&summary).unwrap()).unwrap();
        let ok = run.results.iter().filter(|r| r.outcome.status == "ok").count();
        println!(
            "{host}: os={} role={} failure={} commands={} ok={} rows={} in {}s",
            run.os.as_deref().unwrap_or("-"),
            run.role.as_deref().unwrap_or("-"),
            run.failure.as_deref().unwrap_or("none"),
            run.results.len(),
            ok,
            tables.values().map(Vec::len).sum::<usize>(),
            started.elapsed().as_secs()
        );
        if run.failure.is_none() || run.os.is_some() {
            devices.push(DeviceIn { device_id: slug(host), host: host.clone(), os: run.os.clone(), role: run.role.clone(), prompt: run.prompt.clone(), version_text: run.version_text.clone(), tables });
        }
    }
    for (host, why) in &frontier.not_followed {
        println!("  not followed: {host} — {why}");
    }
    let shadow_rows: Vec<_> = shadow.iter().map(|(k, (m, x, d))| json!({"os_command": k, "match": m, "mismatch": x, "details": d})).collect();
    std::fs::write(out.join("shadow.json"), serde_json::to_string_pretty(&shadow_rows).unwrap()).unwrap();
    devices
}

/// An earlier run's stored replies, read again: each step rebuilt from its
/// catalog by its command, templates through the Rust engine.
fn replayed(dir: &std::path::Path, catalogs: &[Catalog], options: &RunOptions) -> Vec<DeviceIn> {
    let mut devices = Vec::new();
    let mut hosts: Vec<PathBuf> = std::fs::read_dir(dir).expect("the run's folder").filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.is_dir()).collect();
    hosts.sort();
    for h in hosts {
        if !h.join("summary.json").exists() {
            // The app's own diagnostic (`collection-<stamp>/<host>/NNN-<command>.txt`):
            // no summary, so the OS is read off the fingerprint probe's reply and
            // each file matched to its command by name, as the app's import does.
            if let Some(d) = from_app_diagnostic(&h, catalogs, options) {
                devices.push(d);
            }
            continue;
        }
        let summary: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(h.join("summary.json")).unwrap()).unwrap();
        let host = summary["host"].as_str().unwrap_or_default().to_string();
        let Some(os) = summary["os"].as_str() else { continue };
        let Some(catalog) = catalogs.iter().find(|c| c.os == os) else { continue };
        let mut rust = catalog.clone();
        rust.parser_engine = Some("rust".into());
        let mut tables: BTreeMap<String, Vec<Row>> = BTreeMap::new();
        let mut read = 0;
        for (n, st) in summary["steps"].as_array().cloned().unwrap_or_default().iter().enumerate() {
            let cmd = st["cmd"].as_str().unwrap_or_default();
            let Some(c) = catalog.commands.iter().find(|c| c.cmd == cmd) else { continue };
            if !matches!(st["status"].as_str(), Some("ok" | "parse_error")) {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(h.join(format!("{:03}-{}.txt", n + 1, slug(cmd)))) else { continue };
            let step = Step { id: c.id.clone(), cmd: c.cmd.clone(), gate: c.gate.clone(), because: Vec::new(), parser: c.parser.clone(), feeds: c.feeds.clone(), weight: c.weight(), timeout: c.timeout(), verified: c.verified, context: None, scope: None };
            let mut outcome = CommandOutcome { status: "ok".into(), raw, ..Default::default() };
            settle(&mut outcome, &step, &rust, &c.also, options);
            let rows = if outcome.status == "ok" { rows_of(&step.parser, &outcome) } else { Vec::new() };
            read += rows.len();
            for n in rows_for_step(&step, &rows) {
                tables.entry(n.table.clone()).or_default().push(Row { command: step.id.clone(), columns: n.columns, extra: n.extra });
            }
        }
        println!("{host}: os={os} rows={read} (replayed)");
        let s = |k: &str| summary[k].as_str().unwrap_or_default().to_string();
        devices.push(DeviceIn { device_id: slug(&host), host, os: Some(os.to_string()), role: summary["role"].as_str().map(str::to_string), prompt: s("prompt"), version_text: s("version_text"), tables });
    }
    devices
}

/// One host folder of the app's diagnostic, read through today's code.
fn from_app_diagnostic(h: &std::path::Path, catalogs: &[Catalog], options: &RunOptions) -> Option<DeviceIn> {
    let host = h.file_name()?.to_string_lossy().to_string();
    let mut files: Vec<(String, PathBuf)> = std::fs::read_dir(h).ok()?.flatten().map(|e| e.path()).filter(|p| p.extension().and_then(|x| x.to_str()) == Some("txt")).map(|p| {
        let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let name = match stem.split_once('-') {
            Some((n, rest)) if n.chars().all(|c| c.is_ascii_digit()) => rest.to_string(),
            _ => stem,
        };
        (slug(&name), p)
    }).collect();
    files.sort();
    let read = |p: &PathBuf| std::fs::read_to_string(p).unwrap_or_default();
    let (os, version_text) = catalogs.iter().filter_map(|c| c.fingerprint.as_ref()).find_map(|f| {
        let (_, p) = files.iter().find(|(s, _)| *s == slug(&f.probe))?;
        let text = read(p);
        coreview_collect::fingerprint::identify(catalogs, &f.probe, &text).map(|id| (id.os, text))
    })?;
    let catalog = catalogs.iter().find(|c| c.os == os)?;
    let mut rust = catalog.clone();
    rust.parser_engine = Some("rust".into());
    let mut tables: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    let mut read_rows = 0;
    let mut used = 0;
    for c in catalog.commands.iter().filter(|c| !c.cmd.contains('{') && c.parser != "api") {
        for (_, p) in files.iter().filter(|(s, _)| *s == slug(&c.cmd)) {
            used += 1;
            let step = Step { id: c.id.clone(), cmd: c.cmd.clone(), gate: c.gate.clone(), because: Vec::new(), parser: c.parser.clone(), feeds: c.feeds.clone(), weight: c.weight(), timeout: c.timeout(), verified: c.verified, context: None, scope: None };
            let mut outcome = CommandOutcome { status: "ok".into(), raw: read(p), ..Default::default() };
            settle(&mut outcome, &step, &rust, &c.also, options);
            let rows = if outcome.status == "ok" { rows_of(&step.parser, &outcome) } else { Vec::new() };
            read_rows += rows.len();
            for n in rows_for_step(&step, &rows) {
                tables.entry(n.table.clone()).or_default().push(Row { command: step.id.clone(), columns: n.columns, extra: n.extra });
            }
        }
    }
    println!("{host}: os={os} files={} read={used} rows={read_rows} (app diagnostic)", files.len());
    Some(DeviceIn { device_id: slug(&host), host, os: Some(os), role: None, prompt: String::new(), version_text, tables })
}

/// The graph and the traces, printed and written under `out`.
fn report(devices: &[DeviceIn], out: &std::path::Path, traces: &[(String, String, Option<String>)]) {
    let graph = coreview_topology::build(devices);
    // What the app hands the review screen from the same graph (LT-576).
    let started = std::time::Instant::now();
    let seeds: Vec<String> = devices.first().map(|d| vec![d.host.clone()]).unwrap_or_default();
    let view = coreview_topology::crawl_view::view_with(&graph, &coreview_topology::crawl_view::ViewOptions { seeds, ..Default::default() });
    println!("crawl view: {} devices, {} not visited, in {} ms", view.devices.len(), view.not_visited.len(), started.elapsed().as_millis());
    std::fs::write(out.join("graph.json"), serde_json::to_string_pretty(&graph).unwrap()).unwrap();
    println!("\ngraph: {} nodes, {} links ({} both ends), {} l3, {} overlays, {} endpoints, {} findings",
        graph.nodes.len(), graph.links.len(), graph.links.iter().filter(|l| l.both_directions).count(),
        graph.l3.len(), graph.overlays.len(), graph.endpoints.len(), graph.findings.len());
    for l in &graph.links {
        let name = |id: &str| graph.node(id).map(|n| n.name.clone()).unwrap_or_else(|| id.to_string());
        println!("  link {} {} — {} {}  [{:?} {:.1}]", name(&l.a.node), l.a.port.as_deref().unwrap_or(""), name(&l.b.node), l.b.port.as_deref().unwrap_or(""), l.kind, l.confidence);
    }
    for f in &graph.findings {
        println!("  finding: {}", f.note);
    }
    let net = coreview_path::Net::build(devices, &graph);
    for (n, (from, to, flow)) in traces.iter().enumerate() {
        let (protocol, port) = match flow.as_deref().and_then(|f| f.split_once('/')) {
            Some((p, n)) => (Some(p.to_string()), n.parse().ok()),
            None => (None, None),
        };
        let outcome = coreview_path::run(&net, &coreview_path::Request { from: from.clone(), to: to.clone(), protocol, port, ..Default::default() });
        std::fs::write(out.join(format!("trace-{}.json", n + 1)), serde_json::to_string_pretty(&outcome).unwrap()).unwrap();
        println!("\ntrace {from} → {to}:");
        for (pi, p) in outcome.forward.paths.iter().enumerate() {
            let hops: Vec<String> = p.hops.iter().map(|h| format!("{}[{}{}]", h.device, h.out_interface.as_deref().unwrap_or(""), h.firewall.as_ref().map(|f| format!(" {:?}", f.verdict)).unwrap_or_default())).collect();
            println!("  path {}: {} → {:?}", pi + 1, hops.join(" → "), p.ending);
        }
        for w in &outcome.forward.warnings {
            println!("  warning: {w}");
        }
    }
}
