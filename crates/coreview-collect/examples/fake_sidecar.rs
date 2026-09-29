//! A sidecar that speaks the contract and has no network: it answers
//! `open` for any host, `run` from a script keyed by command, `switch`,
//! `parse` and `close`. The Rust client and the collector are tested
//! against it, so `cargo test` needs no Python. Run by `spawn_fake()` in
//! the tests with `cargo run --example fake_sidecar`.
//!
//! The script: the environment variable `FAKE_SIDECAR_SCRIPT` names a JSON
//! file `{ "<cmd>": {"status": "ok", "raw": "...", "rows": [...]}, ... }`.
//! A command not in it is `unsupported`. `FAKE_SIDECAR_CONTEXTS` (a JSON
//! list) is what `open` reports as contexts, with kind `vdom`.

use std::io::{BufRead, Write};

use serde_json::{json, Value};

fn main() {
    let script: Value = std::env::var("FAKE_SIDECAR_SCRIPT")
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    let contexts: Value = std::env::var("FAKE_SIDECAR_CONTEXTS").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!([]));
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    let mut sent: Vec<String> = Vec::new();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let id = req["id"].clone();
        let op = req["op"].as_str().unwrap_or("");
        let session = req.get("session").cloned().unwrap_or(Value::Null);
        let reply = match op {
            "hello" => json!({"id": id, "status": "ok", "sidecar": "fake", "protocol": 1, "templates_dir": req["templates_dir"]}),
            "open" => {
                // A password the fake does not like fails authentication, so the lockout rule can be tested.
                if req["auth"]["password"].as_str() == Some("wrong-password-fixture") {
                    json!({"id": id, "status": "auth", "session": session, "error": "authentication failed"})
                } else {
                    let kind = if contexts.as_array().map(|a| !a.is_empty()).unwrap_or(false) { json!("vdom") } else { Value::Null };
                    json!({"id": id, "status": "ok", "session": session, "device": req["host"], "prompt": "FAKE#", "contexts": contexts, "context_kind": kind})
                }
            }
            "run" => {
                let cmd = req["cmd"].as_str().unwrap_or("");
                sent.push(cmd.to_string());
                match script.get(cmd) {
                    Some(entry) => json!({"id": id, "status": entry["status"].as_str().unwrap_or("ok"), "session": session, "cmd": cmd, "rows": entry.get("rows").cloned().unwrap_or(json!([])), "raw": entry["raw"].as_str().unwrap_or(""), "duration_ms": 3, "error": entry.get("error").cloned().unwrap_or(Value::Null)}),
                    None => json!({"id": id, "status": "unsupported", "session": session, "cmd": cmd, "rows": [], "raw": "% Invalid input detected at '^' marker.", "duration_ms": 1, "error": "rejected by device"}),
                }
            }
            "switch" => json!({"id": id, "status": "ok", "session": session, "context": req["context"]["name"]}),
            "parse" => json!({"id": id, "status": "ok", "rows": [{"parsed": req["parser"]}], "raw": req["raw"], "duration_ms": 1}),
            "close" => json!({"id": id, "status": "ok", "session": session, "sent": sent}),
            "quit" => {
                let _ = writeln!(out, "{}", json!({"id": id, "status": "ok"}));
                let _ = out.flush();
                return;
            }
            _ => json!({"id": id, "status": "error", "error": "unhandled"}),
        };
        let _ = writeln!(out, "{}", reply);
        let _ = writeln!(out, "{}", json!({"event": "log", "session": session, "level": "debug", "msg": op}));
        let _ = out.flush();
    }
}
