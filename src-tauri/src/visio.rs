//! The diagram as a Visio drawing (LT-078).
//!
//! Colleagues who do not have Coreview still have Visio, and a picture they
//! cannot edit is worth much less than a drawing they can. A `.vsdx` is an
//! OPC package — a zip of XML parts with relationship files pointing at each
//! other — so this writes the smallest set of parts Visio will open without
//! offering to repair the file: content types, the package and document
//! relationships, the document and its page collection, and a page part for
//! every page of the project (LT-249) holding its shapes and the connectors
//! between them. A link routed by hand keeps its route: the connector runs
//! through the same bends.
//!
//! Units: Visio works in inches with the origin at the *bottom* left; the
//! diagram is in pixels from the top left. Both conversions happen here, in
//! one place, so nothing downstream has to remember which way up a page is.

/// A device to draw: a box with a name, in diagram pixels from the top left.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisioShape {
    pub id: String,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A link between two shapes, by their ids.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisioLink {
    pub from: String,
    pub to: String,
    /// What to write along the connector — the ports, usually.
    pub label: String,
    /// LT-249: the bends the link is routed through, in diagram pixels from
    /// the page's top left. Empty for a link left to route itself.
    #[serde(default)]
    pub points: Vec<[f64; 2]>,
}

/// One page of the drawing.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisioPage {
    pub name: String,
    pub shapes: Vec<VisioShape>,
    pub links: Vec<VisioLink>,
    /// Page size in diagram pixels.
    pub width: f64,
    pub height: f64,
}

/// The whole drawing, as the frontend hands it over.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisioDrawing {
    pub title: String,
    pub pages: Vec<VisioPage>,
}

/// Pixels to inches. Visio pages are measured in inches; 96 px to the inch is
/// the CSS convention the diagram is drawn with.
const PX_PER_INCH: f64 = 96.0;

fn inches(px: f64) -> f64 {
    px / PX_PER_INCH
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// `[Content_Types].xml` — every part in the package, by extension and name.
fn content_types(pages: usize) -> String {
    let parts: String = (1..=pages)
        .map(|n| format!("\n  <Override PartName=\"/visio/pages/page{n}.xml\" ContentType=\"application/vnd.ms-visio.page+xml\"/>"))
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/>
  <Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/>{parts}
</Types>"#
    )
}

fn package_rels() -> String {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/document" Target="visio/document.xml"/>
</Relationships>"#
        .to_string()
}

fn document_rels() -> String {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/pages" Target="pages/pages.xml"/>
</Relationships>"#
        .to_string()
}

fn document_xml() -> String {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<VisioDocument xmlns="http://schemas.microsoft.com/office/visio/2012/main" xml:space="preserve">
  <DocumentSettings TopPage="0" DefaultTextStyle="0" DefaultLineStyle="0" DefaultFillStyle="0" DefaultGuideStyle="0"/>
</VisioDocument>"#
        .to_string()
}

fn pages_rels(pages: usize) -> String {
    let rels: String = (1..=pages)
        .map(|n| format!("\n  <Relationship Id=\"rId{n}\" Type=\"http://schemas.microsoft.com/visio/2010/relationships/page\" Target=\"page{n}.xml\"/>"))
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}
</Relationships>"#
    )
}

fn pages_xml(d: &VisioDrawing) -> String {
    let mut pages = String::new();
    for (i, p) in d.pages.iter().enumerate() {
        let fallback = format!("Page-{}", i + 1);
        let name = if !p.name.trim().is_empty() {
            p.name.as_str()
        } else if d.pages.len() == 1 && !d.title.is_empty() {
            d.title.as_str()
        } else {
            fallback.as_str()
        };
        pages.push_str(&format!(
            r#"
  <Page ID="{id}" NameU="{name}" Name="{name}" ViewScale="-1" ViewCenterX="{cx:.4}" ViewCenterY="{cy:.4}">
    <PageSheet LineStyle="0" FillStyle="0" TextStyle="0">
      <Cell N="PageWidth" V="{w:.4}"/>
      <Cell N="PageHeight" V="{h:.4}"/>
      <Cell N="PageScale" V="1" U="IN_F"/>
      <Cell N="DrawingScale" V="1" U="IN_F"/>
    </PageSheet>
    <Rel r:id="rId{rel}"/>
  </Page>"#,
            id = i,
            rel = i + 1,
            name = esc(name),
            w = inches(p.width),
            h = inches(p.height),
            cx = inches(p.width) / 2.0,
            cy = inches(p.height) / 2.0,
        ));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Pages xmlns="http://schemas.microsoft.com/office/visio/2012/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xml:space="preserve">{pages}
</Pages>"#
    )
}

/// One page: a rectangle per device, a connector per link.
fn page_xml(d: &VisioPage) -> String {
    let page_h = inches(d.height);
    let mut shapes = String::new();
    // Visio ids start at 1, and connectors reference shapes by id.
    let mut id_of: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();

    for (i, s) in d.shapes.iter().enumerate() {
        let id = i + 1;
        id_of.insert(s.id.as_str(), id);
        let w = inches(s.width);
        let h = inches(s.height);
        // Visio pins a shape at its centre, measured from the bottom left.
        let pin_x = inches(s.x) + w / 2.0;
        let pin_y = page_h - (inches(s.y) + h / 2.0);
        shapes.push_str(&format!(
            r#"    <Shape ID="{id}" NameU="Device{id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">
      <Cell N="PinX" V="{pin_x:.4}"/>
      <Cell N="PinY" V="{pin_y:.4}"/>
      <Cell N="Width" V="{w:.4}"/>
      <Cell N="Height" V="{h:.4}"/>
      <Cell N="LocPinX" V="{lpx:.4}" F="Width*0.5"/>
      <Cell N="LocPinY" V="{lpy:.4}" F="Height*0.5"/>
      <Section N="Geometry" IX="0">
        <Cell N="NoFill" V="0"/>
        <Row T="RelMoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>
        <Row T="RelLineTo" IX="2"><Cell N="X" V="1"/><Cell N="Y" V="0"/></Row>
        <Row T="RelLineTo" IX="3"><Cell N="X" V="1"/><Cell N="Y" V="1"/></Row>
        <Row T="RelLineTo" IX="4"><Cell N="X" V="0"/><Cell N="Y" V="1"/></Row>
        <Row T="RelLineTo" IX="5"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>
      </Section>
      <Text>{name}</Text>
    </Shape>
"#,
            id = id,
            pin_x = pin_x,
            pin_y = pin_y,
            w = w,
            h = h,
            lpx = w / 2.0,
            lpy = h / 2.0,
            name = esc(&s.name),
        ));
    }

    // Connectors: a one-dimensional shape from the centre of one box to the
    // centre of another, glued to both so Visio keeps them attached when the
    // shapes are moved.
    let mut connects = String::new();
    let base = d.shapes.len();
    for (j, l) in d.links.iter().enumerate() {
        let (Some(&from), Some(&to)) = (id_of.get(l.from.as_str()), id_of.get(l.to.as_str())) else {
            continue;
        };
        let id = base + j + 1;
        let a = &d.shapes[from - 1];
        let b = &d.shapes[to - 1];
        let ax = inches(a.x) + inches(a.width) / 2.0;
        let ay = page_h - (inches(a.y) + inches(a.height) / 2.0);
        let bx = inches(b.x) + inches(b.width) / 2.0;
        let by = page_h - (inches(b.y) + inches(b.height) / 2.0);
        // A 1-D shape: Visio measures its geometry from its own origin, not
        // from the page. Written in page coordinates the line vanished — the
        // shapes drew, the link did not — so the run is (0,0)→(Width,0) with
        // the shape pinned at the midpoint and rotated onto the bearing.
        if !l.points.is_empty() {
            // LT-249: a routed link. The run is written unrotated, measured
            // from its begin point, which is how Visio itself saves a
            // connector: the local origin sits on BeginX/BeginY, so `LocPin`
            // is half of a width and height that can be negative.
            let (w, h) = (bx - ax, by - ay);
            let mut rows = String::from(r#"        <Row T="MoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>
"#);
            let mut ix = 2;
            for [px, py] in &l.points {
                let (x, y) = (inches(*px), page_h - inches(*py));
                rows.push_str(&format!("        <Row T=\"LineTo\" IX=\"{ix}\"><Cell N=\"X\" V=\"{:.4}\"/><Cell N=\"Y\" V=\"{:.4}\"/></Row>\n", x - ax, y - ay));
                ix += 1;
            }
            rows.push_str(&format!("        <Row T=\"LineTo\" IX=\"{ix}\"><Cell N=\"X\" V=\"{w:.4}\"/><Cell N=\"Y\" V=\"{h:.4}\"/></Row>\n"));
            shapes.push_str(&format!(
                r#"    <Shape ID="{id}" NameU="Link{id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">
      <Cell N="PinX" V="{px:.4}"/>
      <Cell N="PinY" V="{py:.4}"/>
      <Cell N="Width" V="{w:.4}"/>
      <Cell N="Height" V="{h:.4}"/>
      <Cell N="LocPinX" V="{lpx:.4}" F="Width*0.5"/>
      <Cell N="LocPinY" V="{lpy:.4}" F="Height*0.5"/>
      <Cell N="BeginX" V="{ax:.4}"/>
      <Cell N="BeginY" V="{ay:.4}"/>
      <Cell N="EndX" V="{bx:.4}"/>
      <Cell N="EndY" V="{by:.4}"/>
      <Cell N="ObjType" V="2"/>
      <Section N="Geometry" IX="0">
        <Cell N="NoFill" V="1"/>
        <Cell N="NoShow" V="0"/>
{rows}      </Section>
      <Text>{label}</Text>
    </Shape>
"#,
                px = (ax + bx) / 2.0,
                py = (ay + by) / 2.0,
                lpx = w / 2.0,
                lpy = h / 2.0,
                label = esc(&l.label),
            ));
            connects.push_str(&format!(
                r#"    <Connect FromSheet="{id}" FromCell="BeginX" FromPart="9" ToSheet="{from}" ToCell="PinX" ToPart="3"/>
    <Connect FromSheet="{id}" FromCell="EndX" FromPart="12" ToSheet="{to}" ToCell="PinX" ToPart="3"/>
"#
            ));
            continue;
        }
        let dx = bx - ax;
        let dy = by - ay;
        let length = (dx * dx + dy * dy).sqrt().max(0.0001);
        let angle = dy.atan2(dx);
        shapes.push_str(&format!(
            r#"    <Shape ID="{id}" NameU="Link{id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">
      <Cell N="PinX" V="{px:.4}"/>
      <Cell N="PinY" V="{py:.4}"/>
      <Cell N="Width" V="{len:.4}"/>
      <Cell N="Height" V="0"/>
      <Cell N="LocPinX" V="{half:.4}" F="Width*0.5"/>
      <Cell N="LocPinY" V="0" F="Height*0.5"/>
      <Cell N="Angle" V="{angle:.6}"/>
      <Cell N="BeginX" V="{ax:.4}"/>
      <Cell N="BeginY" V="{ay:.4}"/>
      <Cell N="EndX" V="{bx:.4}"/>
      <Cell N="EndY" V="{by:.4}"/>
      <Cell N="ObjType" V="2"/>
      <Section N="Geometry" IX="0">
        <Cell N="NoFill" V="1"/>
        <Cell N="NoShow" V="0"/>
        <Row T="MoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>
        <Row T="LineTo" IX="2"><Cell N="X" V="{len:.4}"/><Cell N="Y" V="0"/></Row>
      </Section>
      <Text>{label}</Text>
    </Shape>
"#,
            id = id,
            px = (ax + bx) / 2.0,
            py = (ay + by) / 2.0,
            len = length,
            half = length / 2.0,
            angle = angle,
            ax = ax,
            ay = ay,
            bx = bx,
            by = by,
            label = esc(&l.label),
        ));
        // Glue: which end of the connector attaches to which shape.
        connects.push_str(&format!(
            r#"    <Connect FromSheet="{id}" FromCell="BeginX" FromPart="9" ToSheet="{from}" ToCell="PinX" ToPart="3"/>
    <Connect FromSheet="{id}" FromCell="EndX" FromPart="12" ToSheet="{to}" ToCell="PinX" ToPart="3"/>
"#,
            id = id,
            from = from,
            to = to,
        ));
    }

    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<PageContents xmlns="http://schemas.microsoft.com/office/visio/2012/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xml:space="preserve">
  <Shapes>
{shapes}  </Shapes>
  <Connects>
{connects}  </Connects>
</PageContents>"#
    )
}

/// The whole `.vsdx` as bytes.
pub fn to_vsdx(d: &VisioDrawing) -> Result<Vec<u8>, String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let opts = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut put = |name: &str, body: String| -> Result<(), String> {
            zip.start_file(name, opts).map_err(|e| e.to_string())?;
            zip.write_all(body.as_bytes()).map_err(|e| e.to_string())
        };
        if d.pages.is_empty() {
            return Err("There are no pages to draw.".into());
        }
        put("[Content_Types].xml", content_types(d.pages.len()))?;
        put("_rels/.rels", package_rels())?;
        put("visio/document.xml", document_xml())?;
        put("visio/_rels/document.xml.rels", document_rels())?;
        put("visio/pages/pages.xml", pages_xml(d))?;
        put("visio/pages/_rels/pages.xml.rels", pages_rels(d.pages.len()))?;
        for (i, page) in d.pages.iter().enumerate() {
            put(&format!("visio/pages/page{}.xml", i + 1), page_xml(page))?;
        }
        zip.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lab() -> VisioDrawing {
        VisioDrawing {
            title: "Lab network".into(),
            pages: vec![VisioPage {
                name: String::new(),
                width: 1584.0,
                height: 1224.0,
                shapes: vec![
                    VisioShape { id: "a".into(), name: "9300-LAB".into(), x: 96.0, y: 96.0, width: 192.0, height: 96.0 },
                    VisioShape { id: "b".into(), name: "Cisco-Rack1-3850".into(), x: 768.0, y: 480.0, width: 192.0, height: 96.0 },
                ],
                links: vec![VisioLink { from: "a".into(), to: "b".into(), label: "Po1".into(), points: vec![] }],
            }],
        }
    }

    fn part(bytes: &[u8], name: &str) -> String {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).expect("zip");
        let mut f = zip.by_name(name).unwrap_or_else(|_| panic!("missing part {name}"));
        let mut s = String::new();
        std::io::Read::read_to_string(&mut f, &mut s).expect("read");
        s
    }

    #[test]
    fn the_package_holds_every_part_visio_requires() {
        let bytes = to_vsdx(&lab()).expect("vsdx");
        // A zip, and one Visio will not offer to repair: the content types,
        // both relationship files, the document, the page collection and the
        // page itself.
        assert_eq!(&bytes[..2], b"PK");
        for name in [
            "[Content_Types].xml",
            "_rels/.rels",
            "visio/document.xml",
            "visio/_rels/document.xml.rels",
            "visio/pages/pages.xml",
            "visio/pages/_rels/pages.xml.rels",
            "visio/pages/page1.xml",
        ] {
            let _ = part(&bytes, name);
        }
    }

    #[test]
    fn every_device_becomes_a_named_shape() {
        let page = part(&to_vsdx(&lab()).expect("vsdx"), "visio/pages/page1.xml");
        assert!(page.contains("<Text>9300-LAB</Text>"), "{page}");
        assert!(page.contains("<Text>Cisco-Rack1-3850</Text>"));
        assert_eq!(page.matches("Type=\"Shape\"").count(), 3, "two devices and one link");
    }

    #[test]
    fn the_link_is_glued_to_both_devices() {
        let page = part(&to_vsdx(&lab()).expect("vsdx"), "visio/pages/page1.xml");
        assert!(page.contains(r#"FromCell="BeginX""#), "no glue at the start");
        assert!(page.contains(r#"FromCell="EndX""#), "no glue at the end");
        assert!(page.contains("<Text>Po1</Text>"), "the port label is missing");
    }

    #[test]
    fn pixels_become_inches_with_the_origin_flipped() {
        let page = part(&to_vsdx(&lab()).expect("vsdx"), "visio/pages/page1.xml");
        // Device A: x 96px + half of 192px = 192px = 2in across.
        assert!(page.contains(r#"<Cell N="PinX" V="2.0000"/>"#), "{page}");
        // Page is 1224px = 12.75in tall; A's centre is 144px = 1.5in from the
        // top, so 11.25in from the bottom — Visio measures upward.
        assert!(page.contains(r#"<Cell N="PinY" V="11.2500"/>"#), "{page}");
    }

    /// Written out so the package can be unzipped and looked at, and — on a
    /// machine with Visio — opened.
    #[test]
    fn a_real_drawing_is_written_out() {
        let bytes = to_vsdx(&lab()).expect("vsdx");
        let out = std::env::temp_dir().join("coreview-visio-check.vsdx");
        std::fs::write(&out, &bytes).expect("write");
        eprintln!("wrote {} ({} bytes)", out.display(), bytes.len());
    }

    /// LT-249: every page, named, each its own part, and a routed link that
    /// the importer reads back with the same bends.
    #[test]
    fn pages_and_routes_survive_the_round_trip() {
        let mut d = lab();
        d.pages[0].name = "Core".into();
        let mut second = d.pages[0].clone();
        second.name = "Branch".into();
        // Down from a's centre (192, 144), across, and down into b's (864, 528).
        second.links[0].points = vec![[192.0, 336.0], [864.0, 336.0]];
        d.pages.push(second);
        let bytes = to_vsdx(&d).expect("vsdx");
        let pages = part(&bytes, "visio/pages/pages.xml");
        assert!(pages.contains(r#"Name="Core""#) && pages.contains(r#"Name="Branch""#), "{pages}");
        assert!(part(&bytes, "[Content_Types].xml").contains("/visio/pages/page2.xml"));
        assert!(part(&bytes, "visio/pages/_rels/pages.xml.rels").contains(r#"Target="page2.xml""#));

        let read = crate::visio_import::import_vsdx(&bytes).expect("reads back");
        assert_eq!(read.pages.len(), 2);
        assert_eq!(read.pages[1].name, "Branch");
        assert_eq!(read.pages[0].links[0].waypoints, Vec::<[f64; 2]>::new(), "a straight link stays straight");
        let bends = &read.pages[1].links[0].waypoints;
        assert_eq!(bends.len(), 2, "{bends:?}");
        // 192px = 2in; 336px down a 12.75in page is 9.25in up.
        assert!((bends[0][0] - 2.0).abs() < 1e-3 && (bends[0][1] - 9.25).abs() < 1e-3, "{bends:?}");
        assert!((bends[1][0] - 9.0).abs() < 1e-3 && (bends[1][1] - 9.25).abs() < 1e-3, "{bends:?}");
    }

    #[test]
    fn a_name_with_xml_in_it_cannot_break_the_file() {
        let mut d = lab();
        d.pages[0].shapes[0].name = "SW <core> & \"edge\"".into();
        let page = part(&to_vsdx(&d).expect("vsdx"), "visio/pages/page1.xml");
        assert!(page.contains("SW &lt;core&gt; &amp; &quot;edge&quot;"), "{page}");
        assert!(!page.contains("<core>"));
    }

    #[test]
    fn a_link_to_a_device_that_is_not_there_is_skipped_not_written_broken() {
        let mut d = lab();
        d.pages[0].links.push(VisioLink { from: "a".into(), to: "ghost".into(), label: "".into(), points: vec![] });
        let page = part(&to_vsdx(&d).expect("vsdx"), "visio/pages/page1.xml");
        assert_eq!(page.matches("Type=\"Shape\"").count(), 3, "the ghost link must not be drawn");
    }
}
