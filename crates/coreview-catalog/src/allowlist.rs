//! The read-only allowlist, as the collector applies it to every command
//! before it is sent — catalog entries included. `scripts/allowlist.mjs`
//! and `sidecar/coreview_sidecar/allowlist.py` implement the same rule and
//! return the same reason strings; `resources/catalog/allowlist-cases.json`
//! pins all three to one fixture.
//!
//! The spec's non-negotiable reads: commands must match
//! `^(show|get|display|dis |diagnose|execute (traceroute|ping)|test |ping|traceroute|/.* print)`
//! and never contain config/write/commit/reload/reboot/factoryreset/delete/clear.
//! Read literally, "never contain config" refuses `show running-config`,
//! which the same spec lists in every catalog; so the second half is read
//! as verbs: a forbidden word is refused when it is the first token of the
//! command or of any `;`-separated segment, and `running-config`,
//! `configuration` and `config running` after a read verb are nouns. Two
//! things the literal rule misses are added: a pipe may only feed a filter,
//! never `redirect`, `tee`, `append`, `save` or `copy`; and a command may
//! not carry a newline. A handful of read-only commands the spec lists but
//! its regex does not cover are allowed as literals, named below.

use std::sync::OnceLock;

use regex::Regex;

/// Read-only commands the spec lists that its own regex does not reach. Literal prefixes.
const LITERALS: &[&str] = &[
    "execute switch-controller get-conn-status",
    "execute traceroute-options source",
    "packet-tracer input",
    "ip -j ",
    "ip -4 ",
    "ip -6 ",
    "ip addr",
    "ip route",
    "ip neigh",
    "ip link",
    "ip vrf",
    "bridge -j fdb show",
    "bridge fdb show",
    "lldpcli show ",
    "lldpctl",
    "esxcli network nic list",
    "esxcli network vswitch standard list",
    "vim-cmd hostsvc/net/query_networkhint",
    "Get-NetIPConfiguration",
    "Get-NetRoute",
    "Get-NetNeighbor",
    // LT-550: the JSON forms of the ESXi and Windows reads.
    "esxcli --formatter=json system version get",
    "esxcli --formatter=json system hostname get",
    "esxcli --formatter=json network nic list",
    "esxcli --formatter=json network ip interface ipv4 get",
    "esxcli --formatter=json network ip route ipv4 list",
    "esxcli --formatter=json network ip neighbor list",
    "Get-NetAdapter",
    "Get-NetIPAddress",
    "net show ",
    "nv show ",
    "pveversion",
    "qm list",
    "pct list",
];

const FORBIDDEN: &[&str] = &[
    "config", "configure", "conf", "write", "wr", "commit", "reload", "reboot", "factoryreset", "factory-reset", "delete", "del", "clear",
    "erase", "copy", "set", "request", "install", "format", "no", "debug", "undebug", "shutdown", "halt", "rm", "sudo", "su", "kill",
    "system-view", "edit", "load", "rollback", "restore", "upgrade",
];

/// LT-557: a literal is a prefix, so its command's words are checked too —
/// `ip link` must not let `ip link set …` through.
const WRITE_WORDS: &[&str] = &["add", "del", "delete", "set", "change", "replace", "flush", "append", "prepend", "exec", "save", "restore", "update", "configure", "unconfigure", "pause", "resume", "restart", "reset", "shutdown", "destroy", "remove", "start", "stop", "create", "migrate"];

/// LT-556: shell operators — a second command, a background one, a
/// substitution or a redirection. `|` is a pipe and is checked apart.
const SHELL: &[&str] = &["&&", "||", "&", "`", "$(", ">", "<"];

/// Pipe targets that only filter what comes back.
const FILTERS: &[&str] = &[
    "include", "inc", "i", "exclude", "exc", "e", "begin", "b", "section", "sec", "count", "c", "json", "json-pretty", "xml", "display",
    "no-more", "match", "except", "find", "last", "grep", "head", "tail", "ConvertTo-Json", "format-json", "utility", "trim", "refresh",
    "sort", "uniq", "wc", "nomore",
];

fn verb() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(show|get|display|dis |diagnose|execute (traceroute|ping)|test |ping|traceroute|/.* print)").expect("a fixed regex"))
}

/// `Ok` or the reason, worded exactly as the other two implementations word it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Ok,
    Refused(String),
}

impl Verdict {
    pub fn is_ok(&self) -> bool {
        matches!(self, Verdict::Ok)
    }
    pub fn reason(&self) -> &str {
        match self {
            Verdict::Ok => "ok",
            Verdict::Refused(r) => r,
        }
    }
}

/// The allowlist verdict for one command line.
pub fn verdict(command: &str) -> Verdict {
    if command.contains('\r') || command.contains('\n') {
        return Verdict::Refused("carries a newline".into());
    }
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Verdict::Refused("empty".into());
    }
    // LT-556: what a shell would run as a second command, or write to a file.
    if SHELL.iter().any(|op| trimmed.contains(op)) {
        return Verdict::Refused("carries a shell operator".into());
    }
    let literal = LITERALS.iter().any(|l| trimmed.starts_with(l));
    if !literal && !verb().is_match(trimmed) {
        return Verdict::Refused("first word is not a read verb".into());
    }
    for (i, segment) in trimmed.split(';').enumerate() {
        let seg = segment.trim();
        let first = seg.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
        let first = first.strip_prefix('/').unwrap_or(&first);
        let seg_literal = LITERALS.iter().any(|l| seg.starts_with(l));
        if FORBIDDEN.contains(&first) && !seg_literal {
            return Verdict::Refused(format!("forbidden verb \"{first}\""));
        }
        if seg_literal {
            if let Some(w) = seg.split_whitespace().find(|w| WRITE_WORDS.contains(&w.to_ascii_lowercase().as_str())) {
                return Verdict::Refused(format!("\"{}\" changes the device", w.to_ascii_lowercase()));
            }
        }
        // LT-556: every chained command is a read command in its own right.
        if i > 0 && !seg.is_empty() && !seg_literal && !verb().is_match(seg) {
            return Verdict::Refused("a chained command's first word is not a read verb".into());
        }
    }
    for pipe in trimmed.split('|').skip(1) {
        let target = pipe.split_whitespace().next().unwrap_or("");
        // `show run | include ^ip route |^router ` — a regex alternation inside an include, not a new pipe.
        if target.is_empty() || target.starts_with('^') || target.starts_with('[') {
            continue;
        }
        if !FILTERS.contains(&target) {
            return Verdict::Refused(format!("pipe target \"{target}\" is not a filter"));
        }
    }
    Verdict::Ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_read_verb_is_allowed_and_a_write_verb_is_not() {
        assert!(verdict("show ip route").is_ok());
        assert!(verdict("get system status").is_ok());
        assert!(verdict("display current-configuration").is_ok());
        assert!(verdict("/ip route print").is_ok());
        assert_eq!(verdict("configure terminal").reason(), "first word is not a read verb");
        assert_eq!(verdict("write memory").reason(), "first word is not a read verb");
        assert_eq!(verdict("reload").reason(), "first word is not a read verb");
    }

    #[test]
    fn a_configuration_is_a_noun_after_a_read_verb() {
        assert!(verdict("show running-config").is_ok());
        assert!(verdict("show configuration | display set").is_ok());
        assert!(verdict("show config running").is_ok());
    }

    #[test]
    fn a_second_segment_is_judged_on_its_own() {
        assert_eq!(verdict("show version ; reload").reason(), "forbidden verb \"reload\"");
        assert_eq!(verdict("show version ; configure terminal").reason(), "forbidden verb \"configure\"");
    }

    #[test]
    fn a_pipe_may_only_filter() {
        assert!(verdict("show run | include ^ip route |^router ").is_ok());
        assert!(verdict("show version | json").is_ok());
        assert_eq!(verdict("show run | redirect flash:x").reason(), "pipe target \"redirect\" is not a filter");
        assert_eq!(verdict("show run | tee bootflash:x").reason(), "pipe target \"tee\" is not a filter");
        assert_eq!(verdict("show configuration | save /var/tmp/x").reason(), "pipe target \"save\" is not a filter");
    }

    #[test]
    fn a_newline_never_passes() {
        assert_eq!(verdict("show version\nreload").reason(), "carries a newline");
    }

    #[test]
    fn the_literals_the_spec_lists_pass() {
        assert!(verdict("execute switch-controller get-conn-status").is_ok());
        assert!(verdict("packet-tracer input inside tcp 192.0.2.2 1024 192.0.2.1 443").is_ok());
        assert!(verdict("ip -j addr").is_ok());
        assert_eq!(verdict("execute reboot").reason(), "first word is not a read verb");
        assert_eq!(verdict("execute factoryreset").reason(), "first word is not a read verb");
    }

    /// The fixture shared with the JavaScript and Python implementations.
    #[test]
    fn the_shared_cases_agree() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../resources/catalog/allowlist-cases.json");
        let text = std::fs::read_to_string(path).expect("allowlist-cases.json beside the catalogs");
        let cases: Vec<(String, String)> = serde_json::from_str::<Vec<serde_json::Value>>(&text)
            .expect("a JSON list")
            .into_iter()
            .map(|c| (c["command"].as_str().unwrap().to_string(), c["verdict"].as_str().unwrap().to_string()))
            .collect();
        assert!(cases.len() >= 20, "the fixture has {} cases", cases.len());
        for (command, expected) in cases {
            assert_eq!(verdict(&command).reason(), expected, "for {command:?}");
        }
    }
}
