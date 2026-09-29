use crate::{Result, TextFsmError};
use fancy_regex::Regex;
use log::{debug, trace};
use std::collections::HashMap;
use std::path::Path;

/// Represents a CLI table index file parsed into memory.
#[derive(Debug, Clone)]
pub struct ParsedCliTable {
    /// The filename of the index.
    pub fname: String,
    /// The rows of the table.
    pub rows: Vec<CliTableRow>,
}

/// A high-level interface for command-to-template mapping using index files.
#[derive(Debug, Clone)]
pub struct CliTable {
    /// List of parsed index tables.
    pub tables: Vec<ParsedCliTable>,
    /// Map of platform names to their associated regex rules for command matching.
    pub platform_regex_rules: HashMap<String, Vec<CliTableRegexRule>>,
}

/// A rule for matching a command to a specific row in an index table.
#[derive(Debug, Clone)]
pub struct CliTableRegexRule {
    /// Index into the `tables` vector.
    pub table_index: usize,
    /// Index into the `rows` vector of the selected table.
    pub row_index: usize,
    /// Pre-compiled regex for matching the CLI command.
    pub command_regex: Regex,
}

/// A single entry in a CLI table index.
#[derive(Debug, Clone, PartialEq)]
pub struct CliTableRow {
    /// List of TextFSM template filenames associated with this entry.
    pub templates: Vec<String>,
    /// Optional hostname filter (regex).
    pub hostname: Option<String>,
    /// Optional platform/vendor name.
    pub platform: Option<String>,
    /// The CLI command string (supports `[[abbrev]]` syntax).
    pub command: String,
}

impl ParsedCliTable {
    fn parse(fname: &Path) -> Result<Vec<CliTableRow>> {
        use std::io::BufReader;
        let file = std::fs::File::open(fname)?;
        let reader = BufReader::new(file);
        let mut rows: Vec<CliTableRow> = vec![];
        let mut rdr = csv::ReaderBuilder::new()
            .comment(Some(b'#'))
            .has_headers(true)
            .delimiter(b',')
            .trim(csv::Trim::All)
            .from_reader(reader);
        trace!("Reader");

        let headers: Vec<&str> = rdr.headers()?.into_iter().collect();
        trace!("Headers: {:?}", &headers);

        if !headers.contains(&"Template") {
            return Err(TextFsmError::ParseError(
                "No 'Template' column in index file".into(),
            ));
        }
        if !headers.contains(&"Command") {
            return Err(TextFsmError::ParseError(
                "No 'Command' column in index file".into(),
            ));
        }

        let template_position = headers.iter().position(|x| *x == "Template").unwrap();
        let command_position = headers.iter().position(|x| *x == "Command").unwrap();
        let maybe_platform_position = headers
            .iter()
            .position(|x| *x == "Platform")
            .or_else(|| headers.iter().position(|x| *x == "Vendor"));
        let maybe_hostname_position = headers.iter().position(|x| *x == "Hostname");

        for result in rdr.records() {
            let record = result?;
            let platform: Option<String> =
                maybe_platform_position.map(|ppos| record[ppos].to_string());
            let hostname: Option<String> =
                maybe_hostname_position.map(|hpos| record[hpos].to_string());
            let templates: Vec<String> = record[template_position]
                .split(':')
                .map(|x| x.to_string())
                .collect();
            let command = record[command_position].to_string();

            let row = CliTableRow {
                templates,
                hostname,
                platform,
                command,
            };
            rows.push(row);
        }
        Ok(rows)
    }

    /// Loads and parses a CLI table index from a file.
    pub fn from_file<P: AsRef<Path>>(fname: P) -> Result<Self> {
        let path = fname.as_ref();
        debug!("Loading cli table from {}", path.display());
        let rows = Self::parse(path)?;
        Ok(ParsedCliTable {
            fname: path.to_string_lossy().into_owned(),
            rows,
        })
    }
}

impl CliTable {
    /// Expands a string with optional tail characters into a regex group.
    /// E.g., "show" -> "(s(h(o(w)?)?)?)?"
    fn expand_string(input: &str) -> String {
        if input.is_empty() {
            return String::new();
        }

        let count = input.chars().count();
        let mut result = String::with_capacity(count * 4);

        for c in input.chars() {
            result.push('(');
            result.push(c);
        }

        for _ in 0..count {
            result.push_str(")?");
        }

        result
    }

    /// Expands command abbreviations inside `[[ ]]` into nested optional regex groups.
    fn expand_brackets(input: &str) -> String {
        let mut result = String::with_capacity(input.len());
        let mut current_pos = 0;

        while let Some(start) = input[current_pos..].find("[[") {
            // Add everything before the [[ to the result
            result.push_str(&input[current_pos..current_pos + start]);

            // Move position past the [[
            let content_start = current_pos + start + 2;

            // Look for matching ]]
            if let Some(end) = input[content_start..].find("]]") {
                let content = &input[content_start..content_start + end];
                let expanded = Self::expand_string(content);
                result.push_str(&expanded);
                current_pos = content_start + end + 2;
            } else {
                // No matching ]], treat [[ as literal
                result.push_str("[[");
                current_pos = content_start;
            }
        }

        // Add any remaining content
        result.push_str(&input[current_pos..]);
        result
    }

    fn get_directory(filename: &str) -> Option<String> {
        let path = Path::new(filename);
        path.parent().map(|p| p.to_string_lossy().into_owned())
    }

    /// Finds the appropriate template and row information for a given platform and command.
    pub fn get_template_for_command(
        &self,
        platform: &str,
        cmd: &str,
    ) -> Option<(String, CliTableRow)> {
        let plat_regex_list = self.platform_regex_rules.get(platform)?;
        for rule in plat_regex_list {
            if rule.command_regex.is_match(cmd).expect("Fancy regex ok?") {
                let row = self.tables[rule.table_index].rows[rule.row_index].clone();
                let fname = &self.tables[rule.table_index].fname;
                if let Some(fdir) = Self::get_directory(fname) {
                    return Some((fdir, row));
                }
            }
        }
        None
    }

    /// Loads a CLI table from an index file and compiles all command regexes.
    pub fn from_file<P: AsRef<Path>>(fname: P) -> Result<Self> {
        let parsed_cli_table = ParsedCliTable::from_file(fname)?;
        let tables = vec![parsed_cli_table];
        let mut platform_regex_rules: HashMap<String, Vec<CliTableRegexRule>> = Default::default();

        for (table_index, table) in tables.iter().enumerate() {
            for (row_index, row) in table.rows.iter().enumerate() {
                let expanded_command = Self::expand_brackets(&row.command);
                let anchored_command = format!("^{}$", expanded_command);
                let command_regex = Regex::new(&anchored_command)
                    .map_err(|e| TextFsmError::ParseError(e.to_string()))?;

                let rule = CliTableRegexRule {
                    table_index,
                    row_index,
                    command_regex,
                };
                let no_platform = "no-platform".to_string();
                let platform_name: &str = row.platform.as_ref().unwrap_or(&no_platform);
                platform_regex_rules
                    .entry(platform_name.into())
                    .or_default()
                    .push(rule);
            }
        }
        Ok(CliTable {
            platform_regex_rules,
            tables,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_expand_string() {
        assert_eq!(CliTable::expand_string(""), "");
        assert_eq!(CliTable::expand_string("w"), "(w)?");
        assert_eq!(CliTable::expand_string("sh"), "(s(h)?)?");
        assert_eq!(CliTable::expand_string("sho"), "(s(h(o)?)?)?");
        assert_eq!(CliTable::expand_string("show"), "(s(h(o(w)?)?)?)?");
    }

    #[test]
    fn test_expand_brackets() {
        assert_eq!(CliTable::expand_brackets("show"), "show");
        assert_eq!(CliTable::expand_brackets("sh[[ow]]"), "sh(o(w)?)?");
        assert_eq!(CliTable::expand_brackets("[[show]]"), "(s(h(o(w)?)?)?)?");
        assert_eq!(
            CliTable::expand_brackets("sh[[ow]] ip bgp"),
            "sh(o(w)?)? ip bgp"
        );
        assert_eq!(
            CliTable::expand_brackets("sh[[ow]] ip bgp su[[mmary]]"),
            "sh(o(w)?)? ip bgp su(m(m(a(r(y)?)?)?)?)?"
        );
    }
}
