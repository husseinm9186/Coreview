//! How long a device has been up.
//!
//! The model, serial and firmware were already read from `show version`; the
//! uptime is on the same page and was being thrown away. A switch that has been
//! up for three days in an estate where everything else has been up for a year
//! is the first thing an engineer looks at.
//!
//! **Written against captured output**: the uptime line of `show version` from
//! a WS-C2960CX on IOS 15.2(7)E, 2026-09-16; the
//! `get system performance status` line of a FortiGate-60F on 7.6.7 and a
//! FortiSwitch-224E on 7.6.1, both 2026-09-20; and `show version` on
//! a Nexus 9000v 9.3.3 in the lab, the same day.

/// The uptime in seconds, from either shape a device states it in:
///
///   * IOS, on `show version` — `SW1 uptime is 8 weeks, 2 days, 2 hours`
///   * FortiOS, on `get system performance status` —
///     `Uptime: 8 days,  22 hours,  55 minutes`, doubled spaces and all
///
/// Both are a list of `<number> <unit>` separated by commas, so only finding
/// the start of the list differs.
pub fn parse_uptime(version: &str) -> Option<u64> {
    let text = version
        .lines()
        .find_map(|l| l.split_once(" uptime is ").map(|(_, rest)| rest))
        .or_else(|| {
            version
                .lines()
                .find_map(|l| l.trim_start().strip_prefix("Uptime:"))
        })?;
    let mut total: u64 = 0;
    let mut any = false;
    for part in text.split(',') {
        let mut words = part.split_whitespace();
        let (Some(n), Some(unit)) = (words.next(), words.next()) else { continue };
        let Ok(n) = n.parse::<u64>() else { continue };
        // NX-OS writes the plural as `day(s)`, so the bracket has to come off
        // before the `s` does. `days` and `day` still reduce to the
        // same word.
        let unit = unit.trim_end_matches("(s)");
        let seconds = match unit.trim_end_matches('s') {
            "year" => 365 * 86_400,
            "week" => 7 * 86_400,
            "day" => 86_400,
            "hour" => 3_600,
            "minute" => 60,
            "second" => 1,
            _ => continue,
        };
        total = total.saturating_add(n.saturating_mul(seconds));
        any = true;
    }
    any.then_some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_captured_line() {
        // Captured 2026-09-16; the hostname is invented.
        let v = "LAB-CORE-SW1 uptime is 8 weeks, 2 days, 2 hours, 8 minutes\nSystem returned to ROM by reload\n";
        assert_eq!(parse_uptime(v), Some(8 * 7 * 86_400 + 2 * 86_400 + 2 * 3_600 + 8 * 60));
    }

    /// The FortiOS shape, from the two devices in the lab. FortiOS
    /// prints two spaces after each comma, and says `Uptime:` rather than
    /// naming the host.
    #[test]
    fn reads_the_fortios_line() {
        let g = "Version: FortiGate-60F v7.6.7\nUptime: 8 days,  22 hours,  55 minutes\n";
        assert_eq!(parse_uptime(g), Some(8 * 86_400 + 22 * 3_600 + 55 * 60));
        let s = "Uptime: 22 days,  18 hours,  56 minutes\n";
        assert_eq!(parse_uptime(s), Some(22 * 86_400 + 18 * 3_600 + 56 * 60));
    }

    /// NX-OS brackets its plurals. Found by crawling a Nexus 9000v
    /// that reported no uptime while `show version` plainly stated one — the
    /// third platform family in a row whose uptime was silently dropped.
    #[test]
    fn reads_the_nexus_line_with_its_bracketed_plurals() {
        let v = "Kernel uptime is 0 day(s), 0 hour(s), 23 minute(s), 42 second(s)\n";
        assert_eq!(parse_uptime(v), Some(23 * 60 + 42));
        let long = "Kernel uptime is 12 day(s), 3 hour(s), 4 minute(s), 5 second(s)\n";
        assert_eq!(parse_uptime(long), Some(12 * 86_400 + 3 * 3_600 + 4 * 60 + 5));
    }

    #[test]
    fn reads_years_and_a_single_unit() {
        assert_eq!(parse_uptime("R1 uptime is 1 year, 1 week, 1 minute"), Some(365 * 86_400 + 7 * 86_400 + 60));
        assert_eq!(parse_uptime("nothing here"), None);
    }
}
