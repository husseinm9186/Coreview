//! An Excel workbook read as rows of text (LT-245).
//!
//! An inventory arrives as a spreadsheet far more often than as a CSV, and
//! "save it as CSV first" loses every sheet but one and mangles anything with
//! a comma or a leading zero. This reads each sheet of an `.xlsx` into a grid
//! of strings — the same grid the CSV reader produces — and the column-mapping
//! screen takes it from there.
//!
//! **Written against workbooks saved by Microsoft Excel and by LibreOffice**
//! (test workbooks of the `calamine` project; `docProps/app.xml` names the
//! producer).
//! What they showed:
//!
//! * Sheets are listed in `workbook.xml` in tab order, but the relationships
//!   that name each sheet's part are in no order at all — `rId8` before `rId3`.
//! * A cell's text is in one of four places: the shared-strings table
//!   (`t="s"`, the index in `<v>`), the cached result of a formula (`t="str"`),
//!   a boolean (`t="b"`, `0` or `1`), or a plain number with no `t`.
//! * Empty rows are simply absent — `<row r="2">` can be the first — and a
//!   cell can be present with a style and no value.
//! * A date is a number with a date style: `42663` in a cell whose style's
//!   `numFmtId` is 14, or a custom `yyyy\-mm\-dd` from LibreOffice, which also
//!   writes `t="n"` on every number. Read as a number it is nonsense in an
//!   inventory. A workbook from an old Mac counts days from 1904 instead.

use std::collections::HashMap;
use std::io::Read;

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct Sheet {
    pub name: String,
    pub rows: Vec<Vec<String>>,
}

const MAX_ROWS: usize = 100_000;
const MAX_PART: u64 = 256 * 1024 * 1024;

fn part(zip: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>, name: &str) -> Option<String> {
    let mut f = zip.by_name(name).ok()?;
    if f.size() > MAX_PART {
        return None;
    }
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

/// `B12` → column index 1. `None` for a reference that is not one.
fn column_of(reference: &str) -> Option<usize> {
    let letters: String = reference.chars().take_while(char::is_ascii_alphabetic).collect();
    if letters.is_empty() || letters.len() > 3 {
        return None;
    }
    Some(letters.bytes().fold(0usize, |acc, b| acc * 26 + usize::from(b.to_ascii_uppercase() - b'A' + 1)) - 1)
}

/// Excel's serial day number as a date, for the 1900 date system.
fn serial_date(serial: f64) -> Option<String> {
    if !(1.0..2_958_466.0).contains(&serial) {
        return None;
    }
    // Day 60 is the 29 February 1900 that never was; everything after it is
    // one day ahead. Day 1 is 1900-01-01, so day 0 is 1899-12-31, which is
    // 25 568 days before the Unix epoch.
    let serial = serial.floor() as i64;
    let z = -25_568 + if serial > 60 { serial - 1 } else { serial } + 719_468;
    // Days to a civil date (Hinnant).
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

fn is_date_format(id: u32, custom: &HashMap<u32, String>) -> bool {
    matches!(id, 14..=22 | 45..=47)
        || custom.get(&id).is_some_and(|f| {
            let f = f.to_ascii_lowercase();
            // A format with a day or a year in it, outside any quoted text.
            let bare: String = f.split('"').step_by(2).collect();
            (bare.contains('d') || bare.contains('y')) && !bare.contains('0')
        })
}

/// A number the way a person typed it: `12` not `12.0`, and no float noise.
fn number_text(v: &str) -> String {
    match v.parse::<f64>() {
        Ok(n) if n.fract() == 0.0 && n.abs() < 1e15 => format!("{}", n as i64),
        Ok(n) => {
            let s = format!("{n:.10}");
            s.trim_end_matches('0').trim_end_matches('.').to_string()
        }
        Err(_) => v.to_string(),
    }
}

fn parse(xml: &str) -> Result<roxmltree::Document<'_>, String> {
    roxmltree::Document::parse(xml).map_err(|e| format!("The workbook is damaged: {e}"))
}

fn text_of(node: roxmltree::Node) -> String {
    // Rich text is several runs; phonetic guides (`rPh`) are not the text.
    node.descendants()
        .filter(|n| n.has_tag_name("t") && !n.ancestors().any(|a| a.has_tag_name("rPh")))
        .filter_map(|n| n.text())
        .collect()
}

pub fn read_xlsx(bytes: &[u8]) -> Result<Vec<Sheet>, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| "This is not an Excel workbook (.xlsx). An older .xls file has to be saved as .xlsx or CSV first.".to_string())?;
    let workbook = part(&mut zip, "xl/workbook.xml").ok_or("This zip has no workbook in it, so it is not an .xlsx file.")?;
    let rels = part(&mut zip, "xl/_rels/workbook.xml.rels").unwrap_or_default();
    let shared_xml = part(&mut zip, "xl/sharedStrings.xml");
    let styles_xml = part(&mut zip, "xl/styles.xml");

    let targets: HashMap<String, String> = if rels.is_empty() {
        HashMap::new()
    } else {
        parse(&rels)?
            .descendants()
            .filter(|n| n.has_tag_name("Relationship"))
            .filter_map(|n| Some((n.attribute("Id")?.to_string(), n.attribute("Target")?.to_string())))
            .collect()
    };
    let shared: Vec<String> = match &shared_xml {
        Some(xml) => parse(xml)?.root_element().children().filter(|n| n.has_tag_name("si")).map(text_of).collect(),
        None => Vec::new(),
    };
    // Which cell styles are dates.
    let mut date_styles: Vec<bool> = Vec::new();
    if let Some(xml) = &styles_xml {
        let doc = parse(xml)?;
        let custom: HashMap<u32, String> = doc
            .descendants()
            .filter(|n| n.has_tag_name("numFmt"))
            .filter_map(|n| Some((n.attribute("numFmtId")?.parse().ok()?, n.attribute("formatCode")?.to_string())))
            .collect();
        if let Some(xfs) = doc.descendants().find(|n| n.has_tag_name("cellXfs")) {
            date_styles = xfs
                .children()
                .filter(|n| n.has_tag_name("xf"))
                .map(|xf| xf.attribute("numFmtId").and_then(|i| i.parse().ok()).is_some_and(|id| is_date_format(id, &custom)))
                .collect();
        }
    }

    let wb = parse(&workbook)?;
    let from_1904 = wb.descendants().find(|n| n.has_tag_name("workbookPr")).and_then(|n| n.attribute("date1904")).is_some_and(|v| v == "1" || v == "true");
    let mut sheets = Vec::new();
    for sheet in wb.descendants().filter(|n| n.has_tag_name("sheet")) {
        let name = sheet.attribute("name").unwrap_or("Sheet").to_string();
        let rid = sheet.attributes().find(|a| a.name() == "id").map(|a| a.value().to_string());
        let Some(target) = rid.and_then(|r| targets.get(&r).cloned()) else { continue };
        let path = match target.strip_prefix('/') {
            Some(abs) => abs.to_string(),
            None => format!("xl/{target}"),
        };
        let Some(xml) = part(&mut zip, &path) else { continue };
        let doc = parse(&xml)?;
        let mut rows: Vec<Vec<String>> = Vec::new();
        for row in doc.descendants().filter(|n| n.has_tag_name("row")) {
            if rows.len() >= MAX_ROWS {
                break;
            }
            let at = row.attribute("r").and_then(|r| r.parse::<usize>().ok()).map_or(rows.len(), |r| r.saturating_sub(1));
            // Absent rows are empty rows, so row numbers still line up.
            while rows.len() < at && rows.len() < MAX_ROWS {
                rows.push(Vec::new());
            }
            let mut cells: Vec<String> = Vec::new();
            for c in row.children().filter(|n| n.has_tag_name("c")) {
                let col = c.attribute("r").and_then(column_of).unwrap_or(cells.len());
                if col > 16_384 {
                    continue;
                }
                let v = c.children().find(|n| n.has_tag_name("v")).and_then(|n| n.text()).unwrap_or("");
                let text = match c.attribute("t") {
                    Some("s") => v.parse::<usize>().ok().and_then(|i| shared.get(i).cloned()).unwrap_or_default(),
                    Some("inlineStr") => c.children().find(|n| n.has_tag_name("is")).map(text_of).unwrap_or_default(),
                    Some("b") => (if v == "1" { "TRUE" } else { "FALSE" }).to_string(),
                    Some("str") | Some("e") => v.to_string(),
                    _ if v.is_empty() => String::new(),
                    _ => {
                        let style = c.attribute("s").and_then(|s| s.parse::<usize>().ok()).unwrap_or(0);
                        match (date_styles.get(style), v.parse::<f64>()) {
                            (Some(true), Ok(n)) => serial_date(if from_1904 { n + 1462.0 } else { n }).unwrap_or_else(|| number_text(v)),
                            _ => number_text(v),
                        }
                    }
                };
                if cells.len() <= col {
                    cells.resize(col + 1, String::new());
                }
                cells[col] = text;
            }
            while cells.last().is_some_and(String::is_empty) {
                cells.pop();
            }
            if rows.len() == at {
                rows.push(cells);
            }
        }
        while rows.last().is_some_and(Vec::is_empty) {
            rows.pop();
        }
        sheets.push(Sheet { name, rows });
    }
    if sheets.is_empty() {
        return Err("The workbook has no sheets that could be read.".into());
    }
    Ok(sheets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A workbook in the shape Excel saves: relationships out of order, a
    /// shared-strings table with a rich-text entry, a formula string, a
    /// boolean, a skipped row, an empty styled cell and a date.
    fn workbook() -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let o = zip::write::SimpleFileOptions::default();
            let mut put = |name: &str, body: &str| {
                z.start_file(name, o).unwrap();
                z.write_all(body.as_bytes()).unwrap();
            };
            put("xl/workbook.xml", r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Devices" sheetId="4" r:id="rId1"/><sheet name="Links" sheetId="6" r:id="rId2"/></sheets></workbook>"#);
            put("xl/_rels/workbook.xml.rels", r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>"#);
            put("xl/sharedStrings.xml", r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="6" uniqueCount="6"><si><t>Hostname</t></si><si><t>Mgmt IP</t></si><si><t>CORE-SW1</t></si><si><r><rPr><b/></rPr><t>EDGE</t></r><r><t>-RTR1</t></r></si><si><t>Installed</t></si><si><t>&amp; spare</t></si></sst>"#);
            put("xl/styles.xml", r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>"#);
            put("xl/worksheets/sheet1.xml", r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:D4"/><sheetData><row r="1" spans="1:4"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>4</v></c></row><row r="2" spans="1:4"><c r="A2" t="s"><v>2</v></c><c r="B2" t="str"><f>CONCATENATE("192.0.2.","10")</f><v>192.0.2.10</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" s="2"><v>42663</v></c></row><row r="4" spans="1:4"><c r="A4" t="s"><v>3</v></c><c r="B4" s="1"><v>1.5</v></c><c r="C4" s="2"/><c r="D4"><v>100</v></c></row></sheetData></worksheet>"#);
            put("xl/worksheets/sheet2.xml", r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Source</t></is></c><c r="B1" t="s"><v>5</v></c></row></sheetData></worksheet>"#);
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn every_sheet_reads_as_text_rows() {
        let sheets = read_xlsx(&workbook()).unwrap();
        assert_eq!(sheets.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["Devices", "Links"], "tab order, not relationship order");
        let d = &sheets[0].rows;
        assert_eq!(d[0], vec!["Hostname", "Mgmt IP", "", "Installed"], "a gap in a row is an empty cell");
        assert_eq!(d[1], vec!["CORE-SW1", "192.0.2.10", "TRUE", "2016-10-20"], "formula text, boolean, and a date as a date");
        assert!(d[2].is_empty(), "an absent row keeps the row numbers lined up");
        assert_eq!(d[3], vec!["EDGE-RTR1", "1.5", "", "100"], "rich text joined; numbers as typed");
        assert_eq!(sheets[1].rows[0], vec!["Source", "& spare"]);
    }

    #[test]
    fn dates_and_columns() {
        assert_eq!(serial_date(1.0).as_deref(), Some("1900-01-01"));
        assert_eq!(serial_date(59.0).as_deref(), Some("1900-02-28"));
        assert_eq!(serial_date(61.0).as_deref(), Some("1900-03-01"));
        assert_eq!(serial_date(45292.0).as_deref(), Some("2024-01-01"));
        assert_eq!(column_of("A1"), Some(0));
        assert_eq!(column_of("AA10"), Some(26));
        assert_eq!(number_text("0.1"), "0.1");
    }

    /// A real workbook, given by path: `CV_XLSX=book.xlsx cargo test -p
    /// coreview real_workbook -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn a_real_workbook_when_given_one() {
        let bytes = std::fs::read(std::env::var("CV_XLSX").expect("CV_XLSX")).unwrap();
        for sheet in read_xlsx(&bytes).unwrap() {
            println!("{}: {:?}", sheet.name, sheet.rows);
        }
    }

    #[test]
    fn other_files_say_what_they_are_not() {
        assert!(read_xlsx(b"Name,IP\n").unwrap_err().contains(".xlsx"));
    }
}
