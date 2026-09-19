//! How long a device has been up (LT-204).
//!
//! The model, serial and firmware were already read from `show version`; the
//! uptime is on the same page and was being thrown away. A switch that has been
//! up for three days in an estate where everything else has been up for a year
//! is the first thing an engineer looks at.
//!
//! **Written against captured output**: the uptime line of `show version` from
//! a WS-C2960CX on IOS 15.2(7)E, 2026-09-16.

/// The uptime in seconds, from a line like
/// `SW1 uptime is 8 weeks, 2 days, 2 hours, 8 minutes`.
pub fn parse_uptime(version: &str) -> Option<u64> {
    let line = version.lines().find(|l| l.contains(" uptime is "))?;
    let text = line.split(" uptime is ").nth(1)?;
    let mut total: u64 = 0;
    let mut any = false;
    for part in text.split(',') {
        let mut words = part.split_whitespace();
        let (Some(n), Some(unit)) = (words.next(), words.next()) else { continue };
        let Ok(n) = n.parse::<u64>() else { continue };
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

    #[test]
    fn reads_years_and_a_single_unit() {
        assert_eq!(parse_uptime("R1 uptime is 1 year, 1 week, 1 minute"), Some(365 * 86_400 + 7 * 86_400 + 60));
        assert_eq!(parse_uptime("nothing here"), None);
    }
}
