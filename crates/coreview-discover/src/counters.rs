//! Error counters per port (LT-235).
//!
//! A port that is up can still be the fault: CRC errors from a bad cable, input
//! errors from a duplex mismatch, output drops from a saturated uplink. `show
//! interfaces status` says a port is connected; this says whether it is well.
//!
//! **Written against captured output** (not D-026): `show interfaces` from a
//! WS-C2960CX on IOS 15.2(7)E, 2026-09-16 — physical ports and SVIs, up and
//! down, with the counter lines as the platform prints them.

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortCounters {
    /// The full name, as `show interfaces` prints it: `GigabitEthernet0/1`.
    pub port: String,
    pub input_errors: u64,
    pub crc: u64,
    pub output_errors: u64,
    pub collisions: u64,
    pub resets: u64,
    pub output_drops: u64,
    /// The duplex and speed line, when the port has one: `Full-duplex, 1000Mb/s`.
    pub duplex_speed: Option<String>,
}

impl PortCounters {
    pub fn has_errors(&self) -> bool {
        self.input_errors > 0 || self.crc > 0 || self.output_errors > 0 || self.collisions > 0
    }
}

/// The number before `label` in a comma-separated counter line:
/// `0 input errors, 12 CRC, 0 frame` → `number_before(line, "CRC")` is 12.
fn number_before(line: &str, label: &str) -> Option<u64> {
    for part in line.split(',') {
        let p = part.trim();
        if let Some(n) = p.strip_suffix(label) {
            return n.trim().parse().ok();
        }
    }
    None
}

pub const COMMAND: &str = "show interfaces";

pub fn parse_interface_counters(output: &str) -> Vec<PortCounters> {
    let mut out: Vec<PortCounters> = Vec::new();
    for raw in output.lines() {
        let line = raw.trim_end();
        if !line.starts_with(' ') && line.contains(" is ") && line.contains("line protocol is") {
            out.push(PortCounters { port: line.split(" is ").next().unwrap_or("").trim().to_string(), ..Default::default() });
            continue;
        }
        let Some(p) = out.last_mut() else { continue };
        let t = line.trim();
        if t.contains("input errors") {
            p.input_errors = number_before(t, "input errors").unwrap_or(0);
            p.crc = number_before(t, "CRC").unwrap_or(0);
        } else if t.contains("output errors") {
            p.output_errors = number_before(t, "output errors").unwrap_or(0);
            p.collisions = number_before(t, "collisions").unwrap_or(0);
            p.resets = number_before(t, "interface resets").unwrap_or(0);
        } else if let Some(rest) = t.split("Total output drops:").nth(1) {
            p.output_drops = rest.trim().parse().unwrap_or(0);
        } else if (t.contains("-duplex") || t.contains("Duplex")) && t.contains("b/s") {
            p.duplex_speed = Some(t.split(", media type").next().unwrap_or(t).to_string());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured 2026-09-16, two ports and the SVI; MACs renumbered.
    const CAPTURED: &str = "\
Vlan1 is up, line protocol is up 
  Hardware is EtherSVI, address is cc7f.7500.00c0 (bia cc7f.7500.00c0)
  Input queue: 2/75/1261/0 (size/max/drops/flushes); Total output drops: 0
     0 input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored
     0 output errors, 2 interface resets
GigabitEthernet0/1 is up, line protocol is up (connected) 
  Hardware is Gigabit Ethernet, address is cc7f.7500.0081 (bia cc7f.7500.0081)
  Full-duplex, 1000Mb/s, media type is 10/100/1000BaseTX
  Input queue: 0/75/0/0 (size/max/drops/flushes); Total output drops: 18955
     0 runts, 0 giants, 0 throttles 
     0 input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored
     0 output errors, 0 collisions, 2 interface resets
GigabitEthernet0/10 is down, line protocol is down (notconnect) 
  Auto-duplex, Auto-speed, media type is 10/100/1000BaseTX
     0 input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored
     0 output errors, 0 collisions, 0 interface resets
";

    #[test]
    fn reads_the_captured_counters() {
        let got = parse_interface_counters(CAPTURED);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].port, "Vlan1");
        assert_eq!(got[0].resets, 2);
        assert_eq!(got[1].port, "GigabitEthernet0/1");
        assert_eq!(got[1].output_drops, 18955);
        assert_eq!(got[1].duplex_speed.as_deref(), Some("Full-duplex, 1000Mb/s"));
        assert!(!got[1].has_errors());
        assert_eq!(got[2].duplex_speed, None);
    }

    /// The captured lines with the errors a bad cable leaves.
    #[test]
    fn reads_errors_in_the_captured_layout() {
        let text = "GigabitEthernet0/3 is up, line protocol is up (connected) \n     1532 input errors, 1498 CRC, 34 frame, 0 overrun, 0 ignored\n     12 output errors, 7 collisions, 1 interface resets\n";
        let got = &parse_interface_counters(text)[0];
        assert_eq!((got.input_errors, got.crc, got.output_errors, got.collisions, got.resets), (1532, 1498, 12, 7, 1));
        assert!(got.has_errors());
    }
}
