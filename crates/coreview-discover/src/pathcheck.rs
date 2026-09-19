//! Whether one device can reach another, asked of the device itself (LT-225).
//!
//! A probe answers "can *this machine* reach it". During a change the question
//! is usually narrower — can the branch switch still reach the core, can the
//! firewall reach the new server — and only the device in question can answer
//! it. This logs into that device and runs its own ping.
//!
//! **Written against captured output** (not D-026): `ping <address> repeat N
//! timeout 1` on a WS-C2960CX, IOS 15.2(7)E, 2026-09-16 — a full reply, total
//! loss, and a name the device could not resolve.
//!
//! Only an IPv4 address is ever put on the command line, parsed first and
//! written back from the parsed value, so nothing typed can reach the device's
//! command line.

use std::net::Ipv4Addr;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingFromDevice {
    pub sent: u32,
    pub received: u32,
    pub min_ms: Option<u32>,
    pub avg_ms: Option<u32>,
    pub max_ms: Option<u32>,
    /// What the device printed, trimmed, for the record.
    pub output: String,
}

/// The command for `count` echoes to `target`, one second each.
pub fn ping_command(target: Ipv4Addr, count: u32) -> String {
    format!("ping {target} repeat {} timeout 1", count.clamp(1, 20))
}

/// Reads IOS's summary line: `Success rate is 100 percent (3/3),
/// round-trip min/avg/max = 1/1/3 ms`. `None` when the device printed no
/// summary — it rejected the command or could not resolve the target.
pub fn parse_ios_ping(output: &str) -> Option<PingFromDevice> {
    let line = output.lines().find(|l| l.trim_start().starts_with("Success rate is"))?;
    let (open, close) = (line.find('(')?, line.find(')')?);
    let (received, sent) = line.get(open + 1..close)?.split_once('/')?;
    let (received, sent): (u32, u32) = (received.trim().parse().ok()?, sent.trim().parse().ok()?);
    // More replies than requests is not a summary a device prints (LT-283).
    if received > sent {
        return None;
    }
    let times: Vec<u32> = line
        .split_once('=')
        .map(|(_, rest)| rest.trim().trim_end_matches("ms").trim().split('/').filter_map(|t| t.trim().parse().ok()).collect())
        .unwrap_or_default();
    Some(PingFromDevice {
        sent,
        received,
        min_ms: times.first().copied(),
        avg_ms: times.get(1).copied(),
        max_ms: times.get(2).copied(),
        output: output.trim().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    /// LT-283: a summary claiming more replies than it sent was taken as read.
    #[test]
    fn more_replies_than_pings_is_not_a_summary() {
        assert!(parse_ios_ping("Success rate is 0 percent (1/0)\n").is_none());
        assert!(parse_ios_ping("Success rate is 100 percent (3/3)\n").is_some());
    }

    #[test]
    fn reads_the_captured_outputs() {
        // Captured 2026-09-16; addresses renumbered (LT-277).
        let full = "Type escape sequence to abort.\nSending 3, 100-byte ICMP Echos to 192.168.77.1, timeout is 1 seconds:\n!!!\nSuccess rate is 100 percent (3/3), round-trip min/avg/max = 1/1/3 ms\n";
        let got = parse_ios_ping(full).unwrap();
        assert_eq!((got.sent, got.received, got.min_ms, got.avg_ms, got.max_ms), (3, 3, Some(1), Some(1), Some(3)));

        let lost = "Type escape sequence to abort.\nSending 2, 100-byte ICMP Echos to 192.168.77.254, timeout is 1 seconds:\n..\nSuccess rate is 0 percent (0/2)\n";
        let got = parse_ios_ping(lost).unwrap();
        assert_eq!((got.sent, got.received, got.avg_ms), (2, 0, None));

        assert!(parse_ios_ping("Translating \"nosuchname\"...domain server (192.168.77.53)\n% Unrecognized host or address.").is_none());
    }

    #[test]
    fn builds_only_an_address_and_a_bounded_count() {
        assert_eq!(ping_command(Ipv4Addr::new(192, 0, 2, 1), 3), "ping 192.0.2.1 repeat 3 timeout 1");
        assert_eq!(ping_command(Ipv4Addr::new(192, 0, 2, 1), 500), "ping 192.0.2.1 repeat 20 timeout 1");
    }
}
