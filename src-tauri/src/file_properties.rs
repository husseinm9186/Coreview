//! The file readers never panic on what a file holds (LT-267).
//!
//! A drawing, a scan or a workbook comes from somebody else's machine. Each
//! reader must turn anything at all — random bytes, a zip that is not a
//! workbook, XML cut off mid-element — into a result or an error.

use proptest::prelude::*;

const DRAWIO: &str = r#"<mxfile><diagram name="Core"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="EDGE-RTR1" style="shape=mxgraph.cisco.routers.router;" parent="1" vertex="1"><mxGeometry x="0" y="0" width="60" height="40" as="geometry"/></mxCell><mxCell id="b" value="CORE-SW1" style="shape=mxgraph.networks.switch;" parent="1" vertex="1"><mxGeometry x="200" y="0" width="60" height="40" as="geometry"/></mxCell><mxCell id="e" value="Gi0/0 &lt;&gt; Gi1/0/1" parent="1" source="a" target="b" edge="1"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="100" y="80"/></Array></mxGeometry></mxCell></root></mxGraphModel></diagram></mxfile>"#;

const NMAP: &str = r#"<?xml version="1.0"?><!DOCTYPE nmaprun><nmaprun args="nmap"><host><status state="up"/><address addr="192.0.2.5" addrtype="ipv4"/><hostnames><hostname name="nas1.example.test" type="PTR"/></hostnames><ports><port protocol="tcp" portid="22"><state state="open"/><service name="ssh"/></port></ports><times srtt="175"/></host><runstats><hosts up="1" total="2"/></runstats></nmaprun>"#;

fn cut_and_flip(text: &str, cut: usize, flips: &[(usize, u8)]) -> Vec<u8> {
    let mut b = text.as_bytes().to_vec();
    for (at, v) in flips {
        let i = at % b.len();
        b[i] = *v;
    }
    b.truncate(cut % (b.len() + 1));
    b
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, ..ProptestConfig::default() })]

    #[test]
    fn no_file_reader_panics_on_arbitrary_bytes(bytes in prop::collection::vec(any::<u8>(), 0..2048)) {
        let text = String::from_utf8_lossy(&bytes);
        let _ = crate::visio_import::import_vsdx(&bytes);
        let _ = crate::spreadsheet::read_xlsx(&bytes);
        let _ = crate::drawio_import::import_drawio(&text);
        let _ = crate::nmap_import::read_nmap_xml(&text);
    }

    #[test]
    fn a_damaged_drawing_or_scan_is_an_error_or_a_result(cut in any::<usize>(), flips in prop::collection::vec((any::<usize>(), any::<u8>()), 0..8)) {
        let drawio = cut_and_flip(DRAWIO, cut, &flips);
        let _ = crate::drawio_import::import_drawio(&String::from_utf8_lossy(&drawio));
        let nmap = cut_and_flip(NMAP, cut, &flips);
        let _ = crate::nmap_import::read_nmap_xml(&String::from_utf8_lossy(&nmap));
    }

    /// A real zip whose parts are nonsense is refused, not a panic.
    #[test]
    fn a_zip_of_nonsense_is_not_a_workbook_or_a_drawing(parts in prop::collection::vec(("(xl/workbook.xml|xl/_rels/workbook.xml.rels|xl/sharedStrings.xml|xl/worksheets/sheet1.xml|visio/pages/pages.xml|visio/pages/page1.xml)", ".{0,300}"), 1..6)) {
        use std::io::Write;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let mut seen = std::collections::HashSet::new();
            for (name, body) in &parts {
                if !seen.insert(name.clone()) {
                    continue;
                }
                z.start_file(name.as_str(), zip::write::SimpleFileOptions::default()).unwrap();
                z.write_all(body.as_bytes()).unwrap();
            }
            z.finish().unwrap();
        }
        let bytes = buf.into_inner();
        let _ = crate::spreadsheet::read_xlsx(&bytes);
        let _ = crate::visio_import::import_vsdx(&bytes);
    }
}

#[test]
fn the_samples_are_read() {
    assert_eq!(crate::drawio_import::import_drawio(DRAWIO).unwrap().pages[0].links.len(), 1);
    assert_eq!(crate::nmap_import::read_nmap_xml(NMAP).unwrap().hosts.len(), 1);
}
