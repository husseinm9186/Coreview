use crate::{DataRecord, TextFsmError};
use std::collections::BTreeSet;

/// Supported output formats for parsed results.
#[derive(Debug, Clone, Copy)]
pub enum OutputFormat {
    /// JSON format (using serde_json)
    #[cfg(feature = "json")]
    Json,
    /// YAML format (using serde_yaml)
    #[cfg(feature = "yaml")]
    Yaml,
    /// Comma-Separated Values (headers sorted alphabetically)
    #[cfg(feature = "csv_export")]
    Csv,
    /// Simple ASCII table
    Text,
    /// HTML table
    Html,
    /// XML format
    Xml,
}

/// Trait to export parsing results to various formats.
pub trait TextFsmExport {
    /// Exports the results to the specified format.
    fn export(&self, format: OutputFormat) -> Result<String, TextFsmError>;
}

impl TextFsmExport for Vec<DataRecord> {
    fn export(&self, format: OutputFormat) -> Result<String, TextFsmError> {
        match format {
            #[cfg(feature = "json")]
            OutputFormat::Json => serde_json::to_string_pretty(self)
                .map_err(|e| TextFsmError::InternalError(e.to_string())),
            #[cfg(feature = "yaml")]
            OutputFormat::Yaml => {
                serde_yaml::to_string(self).map_err(|e| TextFsmError::InternalError(e.to_string()))
            }
            #[cfg(feature = "csv_export")]
            OutputFormat::Csv => export_csv(self),
            OutputFormat::Text => export_text(self),
            OutputFormat::Html => export_html(self),
            OutputFormat::Xml => export_xml(self),
        }
    }
}

fn get_headers(records: &[DataRecord]) -> Vec<String> {
    let mut headers = BTreeSet::new();
    for rec in records {
        for k in rec.fields.keys() {
            headers.insert(k.clone());
        }
    }
    headers.into_iter().collect()
}

#[cfg(feature = "csv_export")]
fn export_csv(records: &[DataRecord]) -> Result<String, TextFsmError> {
    let headers = get_headers(records);
    let mut wtr = csv::Writer::from_writer(vec![]);

    // Write header
    wtr.write_record(&headers)
        .map_err(|e| TextFsmError::InternalError(e.to_string()))?;

    // Write records
    for rec in records {
        let row: Vec<String> = headers
            .iter()
            .map(|h| {
                if let Some(val) = rec.get(h) {
                    val.to_string()
                } else {
                    String::new()
                }
            })
            .collect();
        wtr.write_record(&row)
            .map_err(|e| TextFsmError::InternalError(e.to_string()))?;
    }

    let data = wtr
        .into_inner()
        .map_err(|e| TextFsmError::InternalError(e.to_string()))?;
    String::from_utf8(data).map_err(|e| TextFsmError::InternalError(e.to_string()))
}

fn export_html(records: &[DataRecord]) -> Result<String, TextFsmError> {
    let headers = get_headers(records);
    let mut html = String::from("<table>\n<thead>\n<tr>");
    for h in &headers {
        html.push_str(&format!("<th>{}</th>", h));
    }
    html.push_str("</tr>\n</thead>\n<tbody>\n");

    for rec in records {
        html.push_str("<tr>");
        for h in &headers {
            let val = if let Some(v) = rec.get(h) {
                let value_str = v.to_string();
                value_str
                    .replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
                    .replace('"', "&quot;")
                    .replace('\'', "&apos;")
            } else {
                String::new()
            };
            html.push_str(&format!("<td>{}</td>", val));
        }
        html.push_str("</tr>\n");
    }
    html.push_str("</tbody>\n</table>");
    Ok(html)
}

fn export_xml(records: &[DataRecord]) -> Result<String, TextFsmError> {
    let headers = get_headers(records);
    let mut xml = String::from("<results>\n");

    for rec in records {
        xml.push_str("  <record>\n");
        for h in &headers {
            if let Some(val) = rec.get(h) {
                // Sanitize tag name (XML tags cannot contain spaces)
                let tag_name = h.replace(' ', "_");
                let value_str = val.to_string();
                // Basic XML escaping
                let escaped_value = value_str
                    .replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
                    .replace('"', "&quot;")
                    .replace('\'', "&apos;");
                xml.push_str(&format!(
                    "    <{}>{}</{}>\n",
                    tag_name, escaped_value, tag_name
                ));
            }
        }
        xml.push_str("  </record>\n");
    }
    xml.push_str("</results>");
    Ok(xml)
}

fn export_text(records: &[DataRecord]) -> Result<String, TextFsmError> {
    let headers = get_headers(records);
    if headers.is_empty() {
        return Ok(String::new());
    }

    // Calculate column widths
    let mut widths: Vec<usize> = headers.iter().map(|h| h.len()).collect();

    for rec in records {
        for (i, h) in headers.iter().enumerate() {
            if let Some(val) = rec.get(h) {
                let len = val.to_string().len();
                if len > widths[i] {
                    widths[i] = len;
                }
            }
        }
    }

    let mut out = String::new();

    // Header
    for (i, h) in headers.iter().enumerate() {
        out.push_str(&format!("{:<width$}  ", h, width = widths[i]));
    }
    out.truncate(out.trim_end().len());
    out.push('\n');

    // Separator
    for (i, _) in headers.iter().enumerate() {
        out.push_str(&format!(
            "{:<width$}  ",
            "-".repeat(widths[i]),
            width = widths[i]
        ));
    }
    out.truncate(out.trim_end().len());
    out.push('\n');

    // Rows
    for rec in records {
        for (i, h) in headers.iter().enumerate() {
            let val = if let Some(v) = rec.get(h) {
                v.to_string()
            } else {
                String::new()
            };
            out.push_str(&format!("{:<width$}  ", val, width = widths[i]));
        }
        out.truncate(out.trim_end().len());
        out.push('\n');
    }

    Ok(out)
}
