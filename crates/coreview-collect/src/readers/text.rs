//! Fixed-width text tables, the way a CLI prints them, read by their
//! header or their rule line rather than split on whitespace — a cell may
//! hold a space (`Dynamic ETH`, `100 Gbps`, `vlan 6`).

/// Where each named column starts in a header line, in order. `None` when
/// a name is missing, so a reader can try the next layout.
pub(crate) fn starts(header: &str, names: &[&str]) -> Option<Vec<usize>> {
    let mut out = Vec::with_capacity(names.len());
    let mut from = 0;
    for n in names {
        let at = header[from..].find(n)? + from;
        out.push(at);
        from = at + n.len();
    }
    Some(out)
}

/// A row sliced at the header's column starts, each cell trimmed.
pub(crate) fn cells(line: &str, starts: &[usize]) -> Vec<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut out = Vec::with_capacity(starts.len());
    for (i, &s) in starts.iter().enumerate() {
        let e = starts.get(i + 1).copied().unwrap_or(chars.len());
        let s = s.min(chars.len());
        let e = e.min(chars.len()).max(s);
        out.push(chars[s..e].iter().collect::<String>().trim().to_string());
    }
    out
}

pub(crate) fn is_rule(line: &str) -> bool {
    let t = line.trim();
    !t.is_empty() && t.chars().all(|c| c == '-' || c == ' ')
}


/// A rule line's dash runs as column spans — `-----  ---------  ---` →
/// three `(start, end)` pairs. Right-aligned tables (tabulate's, SONiC's)
/// are read by these, since a cell can start before its header does.
pub(crate) fn rule_spans(rule: &str) -> Vec<(usize, usize)> {
    let chars: Vec<char> = rule.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '-' {
            let s = i;
            while i < chars.len() && chars[i] == '-' {
                i += 1;
            }
            out.push((s, i));
        } else {
            i += 1;
        }
    }
    out
}

/// A row sliced at rule spans, each span widened to the gap before the
/// next so a cell wider than its rule is still whole.
pub(crate) fn cells_by_spans(line: &str, spans: &[(usize, usize)]) -> Vec<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut out = Vec::with_capacity(spans.len());
    for (i, &(s, _)) in spans.iter().enumerate() {
        let e = spans.get(i + 1).map(|n| n.0).unwrap_or(chars.len());
        let s = if i == 0 { 0 } else { s.min(chars.len()) };
        let e = e.min(chars.len()).max(s);
        out.push(chars[s..e].iter().collect::<String>().trim().to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_header_names_the_columns_and_a_rule_spans_them() {
        let st = starts("Port       Oper State      Admin", &["Port", "Oper State", "Admin"]).unwrap();
        assert_eq!(st, vec![0, 11, 27]);
        assert_eq!(cells("Eth1/1     Down (Suspend)  Enabled", &st), vec!["Eth1/1", "Down (Suspend)", "Enabled"]);
        assert!(starts("Port  Speed", &["Port", "Admin"]).is_none());
        let sp = rule_spans("-----  ---------  ---");
        assert_eq!(sp, vec![(0, 5), (7, 16), (18, 21)]);
        assert_eq!(cells_by_spans("    1  Ethernet0  up", &sp), vec!["1", "Ethernet0", "up"]);
        assert_eq!(cells_by_spans("  100  Vlan1000   down", &sp), vec!["100", "Vlan1000", "down"]);
        assert!(is_rule("---- ----") && !is_rule("- a -"));
    }
}
