//! Capture replies from a device into `captures/<host>/<command>.txt`, the
//! layout `import_captures` reads. Raw, unparsed, exactly as the
//! device answered, through the sidecar so paging and prompts are handled
//! the way a collection handles them. A lab harness: kept.
//!
//!     COREVIEW_CAPTURE_PASSWORD=… cargo run -p coreview-collect --example capture -- \
//!         --host 192.0.2.10 --user reader --out captures [--port 22] [--os cisco_ios] \
//!         [--enable] [--unverified] [--vrf CUST-A] [show ip protocols] [show glbp brief] …
//!
//! `--os` names a catalog; without it the device is fingerprinted first.
//! `--unverified` sends every `verified: unverified` command of that
//! catalog (the list); a `{vrf}` command needs `--vrf`. Commands
//! given on the command line are sent as well. A command the device
//! refuses is still written, so the refusal is on record. Every reply is
//! scrubbed of configuration secrets and of the login's own password
//! before it is written: these files are meant to be shared. The password
//! comes from `COREVIEW_CAPTURE_PASSWORD` (and `COREVIEW_CAPTURE_ENABLE`
//! with `--enable`), never from an argument, so it is not in a shell
//! history. The sidecar is found the way the app finds it in development:
//! `sidecar/.venv`, or `COREVIEW_SIDECAR_PYTHON`.

use std::path::PathBuf;

use coreview_catalog::{load_dir, verdict, Verdict};
use coreview_collect::fingerprint::{identify, is_refusal, probes};
use coreview_collect::scrub::scrub;
use coreview_collect::sidecar::{Auth, Sidecar, SidecarLocation};
use serde_json::{json, Value};

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn slug(command: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in command.trim().chars() {
        if c.is_ascii_alphanumeric() || c == '.' {
            out.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    out.trim_end_matches('-').to_string()
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(host), Some(user), Some(out)) = (arg(&args, "--host"), arg(&args, "--user"), arg(&args, "--out")) else {
        eprintln!("usage: capture --host <addr> --user <name> --out <dir> [--port 22] [--os <catalog>] [--enable] [--unverified] [--vrf <name>] [command…]");
        std::process::exit(2);
    };
    let port: u16 = arg(&args, "--port").and_then(|p| p.parse().ok()).unwrap_or(22);
    let os_arg = arg(&args, "--os");
    let vrf = arg(&args, "--vrf");
    let unverified = args.iter().any(|a| a == "--unverified");
    let enable = args.iter().any(|a| a == "--enable");
    let Ok(password) = std::env::var("COREVIEW_CAPTURE_PASSWORD") else {
        eprintln!("set COREVIEW_CAPTURE_PASSWORD (and COREVIEW_CAPTURE_ENABLE with --enable); a password is never an argument");
        std::process::exit(2);
    };
    // Everything after the named options that is not an option value is a command.
    let mut extra: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if ["--host", "--user", "--out", "--port", "--os", "--vrf"].contains(&a.as_str()) {
            i += 2;
            continue;
        }
        if a.starts_with("--") {
            i += 1;
            continue;
        }
        extra.push(a.clone());
        i += 1;
    }

    // An installed tree can be named instead of the repository's, so
    // CI can prove the installed catalogs and templates are the ones used.
    let catalog_dir = std::env::var("COREVIEW_CATALOG_DIR").map(PathBuf::from).unwrap_or_else(|_| repo().join("resources/catalog"));
    let catalogs = load_dir(&catalog_dir).expect("the catalogs load");
    let templates = std::env::var("COREVIEW_TEMPLATES_DIR").map(PathBuf::from).unwrap_or_else(|_| repo().join("resources/templates/ntc"));
    let location = match std::env::var("COREVIEW_SIDECAR_PYTHON") {
        Ok(python) => SidecarLocation { python: PathBuf::from(python), cwd: std::env::var("COREVIEW_SIDECAR_DIR").map(PathBuf::from).unwrap_or_else(|_| repo().join("sidecar")), templates_dir: templates },
        Err(_) => {
            let venv = repo().join("sidecar/.venv/bin/python");
            if !venv.exists() {
                eprintln!("no sidecar: make sidecar/.venv (sidecar/README.md) or set COREVIEW_SIDECAR_PYTHON");
                std::process::exit(2);
            }
            SidecarLocation { python: venv, cwd: repo().join("sidecar"), templates_dir: templates }
        }
    };
    let auth = Auth { username: user, password, enable: if enable { std::env::var("COREVIEW_CAPTURE_ENABLE").ok() } else { None }, private_key: None };
    let mut sidecar = Sidecar::spawn(&location).await.expect("the sidecar starts");

    // Which catalog: named, or fingerprinted through a generic session.
    let os = match os_arg {
        Some(os) => os,
        None => {
            let r = sidecar.open("fp", &host, port, "generic", &auth, &json!({}), 8000, 20000, None, "ssh").await.expect("open");
            if r.status != "ok" {
                eprintln!("{host}: {}: {}", r.status, r.error.unwrap_or_default());
                std::process::exit(1);
            }
            let mut found = None;
            for probe in probes(&catalogs) {
                let reply = sidecar.run("fp", &probe, "none", &[], 20000).await.expect("run");
                if reply.status == "ok" && !is_refusal(&reply.raw) {
                    if let Some(id) = identify(&catalogs, &probe, &reply.raw) {
                        found = Some(id.os);
                        break;
                    }
                }
            }
            let _ = sidecar.close("fp").await;
            let Some(os) = found else {
                eprintln!("{host}: no catalog fingerprint matched; pass --os");
                std::process::exit(1);
            };
            os
        }
    };
    let catalog = catalogs.iter().find(|c| c.os == os).unwrap_or_else(|| {
        eprintln!("no catalog named {os}");
        std::process::exit(2);
    });
    eprintln!("{host}: {os}");

    let mut commands: Vec<String> = Vec::new();
    if let Some(fp) = &catalog.fingerprint {
        commands.push(fp.probe.clone());
    }
    for p in &catalog.caps_probe {
        commands.push(p.cmd.clone());
    }
    if unverified {
        for c in catalog.commands.iter().filter(|c| c.verified == coreview_catalog::Verified::Unverified) {
            if c.cmd.contains('{') {
                match &vrf {
                    Some(v) => commands.push(c.cmd.replace("{vrf}", v).replace("{vr}", v).replace("{ri}", v)),
                    None => eprintln!("skipping {} (needs --vrf)", c.cmd),
                }
            } else {
                commands.push(c.cmd.clone());
            }
        }
    }
    commands.extend(extra);
    commands.dedup();

    let session_spec: Value = serde_json::to_value(&catalog.session).unwrap_or(Value::Null);
    // First contact is trusted here, as `ssh` does; the fingerprint is printed to compare by hand.
    let r = sidecar.open("s", &host, port, &os, &auth, &session_spec, 8000, 20000, None, "ssh").await.expect("open");
    if let Some(k) = r.extra.get("host_key").and_then(|v| v.as_str()) {
        eprintln!("{host}: host key {k}");
    }
    if r.status != "ok" {
        eprintln!("{host}: {}: {}", r.status, r.error.unwrap_or_default());
        std::process::exit(1);
    }
    let dir = PathBuf::from(&out).join(host.replace(['/', '\\', ':'], "-"));
    std::fs::create_dir_all(&dir).expect("the output folder");
    let mut n = 0;
    for cmd in &commands {
        if let Verdict::Refused(why) = verdict(cmd) {
            eprintln!("not sent: {cmd} ({why})");
            continue;
        }
        // The catalog's parser for this command, so a run proves parsing as well as transport.
        let parser = catalog.commands.iter().find(|c| &c.cmd == cmd).map(|c| c.parser.clone()).filter(|p| p.starts_with("textfsm:")).unwrap_or_else(|| "none".into());
        let reply = sidecar.run("s", cmd, &parser, &[], 60000).await.expect("run");
        let path = dir.join(format!("{}.txt", slug(cmd)));
        // These files leave the machine (they come to be turned into fixtures), so
        // every reply is scrubbed of configuration secrets and the login's own
        // password before it is written — a `show run | include ^crypto` probe
        // can carry a pre-shared key.
        let mut text = scrub(&reply.raw);
        for secret in [&auth.password].into_iter().chain(auth.enable.iter()) {
            if secret.len() >= 3 {
                text = text.replace(secret.as_str(), "<removed-by-coreview>");
            }
        }
        std::fs::write(&path, &text).expect("write");
        n += 1;
        eprintln!("{:<12} {cmd}  → {} ({} rows)", reply.status, path.display(), reply.rows.len());
    }
    let _ = sidecar.close("s").await;
    sidecar.quit().await;
    eprintln!("{n} files under {}", dir.display());
}
