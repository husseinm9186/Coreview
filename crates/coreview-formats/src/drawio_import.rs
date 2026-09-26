//! Reading a draw.io (diagrams.net) drawing as a topology (LT-244).
//!
//! The result is the same `VisioImport` the Visio reader produces, so the
//! import panel previews, corrects and places both the same way — one set of
//! rules for turning a picture into devices and links, not two.
//!
//! **Written against drawings saved by draw.io itself** — the examples the
//! draw.io project publishes, from the web app, the desktop app and Google
//! Drive, versions 7.7 to 24.8. What they showed:
//!
//! * A page's model is either plain XML inside `<diagram>` or compressed:
//!   base64 of raw deflate of the URL-encoded XML. Both are in the wild, even
//!   within the last few years.
//! * **Most lines are not attached to anything.** In the bus-topology example
//!   sixteen of seventeen edges have no `source` or `target`, only a
//!   `sourcePoint` and a `targetPoint`. Such a line is joined to the device its
//!   end sits on, and marked as inferred rather than stated.
//! * Labels are HTML (`eth0:<br>xx.xxx`, `Server Farm<div>with firewalls</div>`).
//! * A shape inside a container — a rack — has coordinates relative to it.
//! * Areas and captions are plain vertices too: a filled rectangle labelled
//!   "Enterprise Networks", a `text;` cell. They are not devices.
//! * Bends are `<Array as="points">` inside the edge's geometry.
//! * A bus is often a line with other lines ending on it (the Veeam and bus
//!   examples). That joins no two devices, so it is reported, not guessed at.
//! * An AWS VPC or subnet is a stencil shape too (`mxgraph.aws4.group`), and is
//!   an area.

use std::collections::HashMap;

use crate::visio_import::{addresses_in, name_without_address, ImportedDevice, ImportedLink, ImportedPage, TextStyle, VisioImport};

/// Diagram pixels to the inches the shared model measures in.
const PX_PER_INCH: f64 = 96.0;
/// How far a loose line's end may sit from a shape and still be taken to
/// touch it, in pixels.
const TOUCH: f64 = 12.0;

/// `a%20b` → `a b`, as `decodeURIComponent` does, over UTF-8.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(b) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A compressed page: base64, then raw deflate, then URL-encoded text.
fn inflate_page(text: &str) -> Result<String, String> {
    use base64::Engine;
    use std::io::Read;
    let packed = base64::engine::general_purpose::STANDARD
        .decode(text.split_whitespace().collect::<String>())
        .map_err(|e| format!("a page is not base64: {e}"))?;
    let mut inflated = String::new();
    flate2::read::DeflateDecoder::new(packed.as_slice())
        .take(64 * 1024 * 1024)
        .read_to_string(&mut inflated)
        .map_err(|e| format!("a page could not be decompressed: {e}"))?;
    Ok(percent_decode(&inflated))
}

/// `key=value;key2=value2;flag;` as a map; a bare word maps to itself.
fn style_map(style: &str) -> HashMap<String, String> {
    style
        .split(';')
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => (k.to_string(), v.to_string()),
            None => (p.to_string(), p.to_string()),
        })
        .collect()
}

/// A label's text: HTML tags gone, line breaks as spaces, entities read.
fn plain_label(value: &str) -> String {
    let with_breaks = value.replace("<br>", " ").replace("<br/>", " ").replace("<div>", " ").replace("</div>", " ").replace("<p>", " ").replace("</p>", " ");
    // Only what looks like a tag is a tag: `Gi0/0 <> Gi1/0/1` is a label.
    let mut out = String::new();
    let mut in_tag = false;
    let chars: Vec<char> = with_breaks.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if !in_tag && c == '<' && chars.get(i + 1).is_some_and(|n| n.is_ascii_alphabetic() || *n == '/' || *n == '!') {
            in_tag = true;
        } else if in_tag && c == '>' {
            in_tag = false;
        } else if !in_tag {
            out.push(c);
        }
    }
    let decoded = out.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A Coreview device type from a draw.io shape name and label.
pub fn device_type_for_shape(shape: &str, label: &str) -> &'static str {
    let s = format!("{} {}", shape.to_ascii_lowercase().replace(['.', '_'], " "), label.to_ascii_lowercase());
    const RULES: &[(&[&str], &str)] = &[
        (&["wireless lan controller", "wlc", "wireless controller"], "wireless-controller"),
        (&["access point", "wireless hub", "wireless router", "antenna", "wifi"], "access-point"),
        (&["firewall"], "firewall"),
        (&["load balancer", "netscaler"], "load-balancer"),
        (&["router"], "router"),
        (&["layer 3 switch", "l3 switch", "multilayer"], "l3-switch"),
        (&["core switch"], "core-switch"),
        (&["switch", " hub", "bridge"], "l2-switch"),
        (&["patch panel"], "patch-panel"),
        (&["pdu"], "pdu"),
        (&[" ups"], "ups"),
        (&["storage", " nas", " san", "disk"], "storage"),
        (&["database"], "database"),
        (&["virtual", " vm "], "vm"),
        (&["server", "mainframe", "blade", "rack ibm", "rack oracle", "rack dell", "rack hp"], "server"),
        (&["printer"], "printer"),
        (&["phone"], "ip-phone"),
        (&["camera", "cctv"], "camera"),
        (&["cloud", "internet"], "internet"),
        (&["laptop", "desktop", " pc", "workstation", "terminal", "client", "monitor", "tablet", "mobile"], "endpoint"),
    ];
    RULES.iter().find(|(words, _)| words.iter().any(|w| s.contains(w))).map_or("generic", |(_, t)| t)
}

struct Cell<'a> {
    id: String,
    parent: String,
    label: String,
    style: HashMap<String, String>,
    vertex: bool,
    edge: bool,
    source: Option<String>,
    target: Option<String>,
    geometry: Option<roxmltree::Node<'a, 'a>>,
}

fn num(n: roxmltree::Node, name: &str) -> f64 {
    n.attribute(name).and_then(|v| v.parse().ok()).unwrap_or(0.0)
}

fn read_page(xml: &str, name: &str) -> Result<(ImportedPage, Vec<String>), String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("{name}: {e}"))?;
    let mut cells: Vec<Cell> = Vec::new();
    for node in doc.descendants().filter(|n| n.has_tag_name("mxCell")) {
        // A cell wrapped in <object> or <UserObject> takes its id and label
        // from the wrapper, which is where custom data lives too.
        let wrapper = node.parent_element().filter(|p| p.has_tag_name("object") || p.has_tag_name("UserObject"));
        let id = wrapper.and_then(|w| w.attribute("id")).or_else(|| node.attribute("id")).unwrap_or_default().to_string();
        let label = wrapper.and_then(|w| w.attribute("label")).or_else(|| node.attribute("value")).unwrap_or_default();
        cells.push(Cell {
            id,
            parent: node.attribute("parent").unwrap_or_default().to_string(),
            label: plain_label(label),
            style: style_map(node.attribute("style").unwrap_or_default()),
            vertex: node.attribute("vertex") == Some("1"),
            edge: node.attribute("edge") == Some("1"),
            source: node.attribute("source").map(str::to_string),
            target: node.attribute("target").map(str::to_string),
            geometry: node.children().find(|c| c.has_tag_name("mxGeometry")),
        });
    }
    let by_id: HashMap<&str, &Cell> = cells.iter().map(|c| (c.id.as_str(), c)).collect();

    // Absolute position of a cell's origin: its own offset plus every
    // containing vertex's.
    let origin = |id: &str| -> (f64, f64) {
        let (mut x, mut y) = (0.0, 0.0);
        let mut at = by_id.get(id).map(|c| c.parent.as_str());
        let mut hops = 0;
        while let Some(p) = at.and_then(|p| by_id.get(p)) {
            if !p.vertex || hops > 64 {
                break;
            }
            if let Some(g) = p.geometry {
                x += num(g, "x");
                y += num(g, "y");
            }
            at = Some(p.parent.as_str());
            hops += 1;
        }
        (x, y)
    };
    // A vertex's box on the page, in pixels.
    let boxes: HashMap<&str, (f64, f64, f64, f64)> = cells
        .iter()
        .filter(|c| c.vertex)
        .filter_map(|c| {
            let g = c.geometry?;
            let (ox, oy) = origin(&c.id);
            Some((c.id.as_str(), (ox + num(g, "x"), oy + num(g, "y"), num(g, "width"), num(g, "height"))))
        })
        .collect();

    let is_text = |c: &Cell| c.style.contains_key("text") || c.style.get("shape").is_some_and(|s| s == "text") || c.style.contains_key("edgeLabel");
    // A stencil shape, but not a group: an AWS VPC or subnet is drawn as
    // `mxgraph.aws4.group` and is an area, not a device.
    let has_shape = |c: &Cell| {
        let shape = c.style.get("shape").map(String::as_str).unwrap_or("");
        !shape.contains("group") && (shape.starts_with("mxgraph.") || shape == "image" || c.style.contains_key("image"))
    };
    // The shape a loose line's end touches: the smallest box within reach
    // that is a drawn shape, so a zone behind a device does not win.
    let touching = |x: f64, y: f64| -> Option<String> {
        cells
            .iter()
            .filter(|c| c.vertex && !is_text(c) && has_shape(c))
            .filter_map(|c| {
                let (bx, by, w, h) = *boxes.get(c.id.as_str())?;
                let dx = (bx - x).max(0.0).max(x - (bx + w));
                let dy = (by - y).max(0.0).max(y - (by + h));
                ((dx * dx + dy * dy).sqrt() <= TOUCH).then(|| (w * h, c.id.clone()))
            })
            .min_by(|a, b| a.0.total_cmp(&b.0))
            .map(|(_, id)| id)
    };

    let mut warnings = Vec::new();
    let mut links = Vec::new();
    let mut loose = 0;
    for e in cells.iter().filter(|c| c.edge) {
        let point = |role: &str| {
            e.geometry.and_then(|g| g.children().find(|p| p.has_tag_name("mxPoint") && p.attribute("as") == Some(role))).map(|p| {
                let (ox, oy) = origin(&e.id);
                (ox + num(p, "x"), oy + num(p, "y"))
            })
        };
        let glued = e.source.is_some() && e.target.is_some();
        let a = e.source.clone().or_else(|| point("sourcePoint").and_then(|(x, y)| touching(x, y)));
        let b = e.target.clone().or_else(|| point("targetPoint").and_then(|(x, y)| touching(x, y)));
        let (Some(a), Some(b)) = (a, b) else {
            loose += 1;
            continue;
        };
        if a == b || !boxes.contains_key(a.as_str()) || !boxes.contains_key(b.as_str()) {
            loose += 1;
            continue;
        }
        let (ox, oy) = origin(&e.id);
        let waypoints = e
            .geometry
            .and_then(|g| g.children().find(|c| c.has_tag_name("Array") && c.attribute("as") == Some("points")))
            .map(|arr| arr.children().filter(|p| p.has_tag_name("mxPoint")).map(|p| [(ox + num(p, "x")) / PX_PER_INCH, -(oy + num(p, "y")) / PX_PER_INCH]).collect())
            .unwrap_or_default();
        let (sp, tp) = crate::visio_import::split_port_pair(&e.label).unwrap_or_default();
        links.push(ImportedLink {
            source: a,
            target: b,
            label: if sp.is_empty() { e.label.clone() } else { String::new() },
            source_port: sp,
            target_port: tp,
            glued,
            color: e.style.get("strokeColor").filter(|c| c.starts_with('#')).map(|c| c.to_ascii_lowercase()).unwrap_or_default(),
            waypoints,
        });
    }
    if loose > 0 {
        warnings.push(format!(
            "{name}: {loose} line{} not joined to two shapes were left out — a line that ends on another line, as a bus is often drawn, joins no device.",
            if loose == 1 { "" } else { "s" }
        ));
    }

    let ends: std::collections::HashSet<&str> = links.iter().flat_map(|l| [l.source.as_str(), l.target.as_str()]).collect();
    let mut devices = Vec::new();
    let mut skipped = 0;
    for c in cells.iter().filter(|c| c.vertex) {
        let Some(&(x, y, w, h)) = boxes.get(c.id.as_str()) else { continue };
        let is_device = ends.contains(c.id.as_str()) || (has_shape(c) && !is_text(c) && !c.style.contains_key("container"));
        if !is_device {
            if !c.label.is_empty() || has_shape(c) {
                skipped += 1;
            }
            continue;
        }
        let shape = c.style.get("shape").cloned().unwrap_or_default();
        let readable_shape = shape.rsplit('.').next().unwrap_or("").replace('_', " ");
        let name = name_without_address(&c.label);
        let bits = c.style.get("fontStyle").and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
        let style = TextStyle {
            bold: bits & 1 != 0,
            italic: bits & 2 != 0,
            size: c.style.get("fontSize").and_then(|v| v.parse::<f64>().ok()).map(|px| px * 0.75),
            color: c.style.get("fontColor").filter(|v| v.starts_with('#')).map(|v| v.to_ascii_lowercase()).unwrap_or_default(),
            align: c.style.get("align").filter(|a| ["left", "center", "right"].contains(&a.as_str())).cloned().unwrap_or_default(),
        };
        devices.push(ImportedDevice {
            id: c.id.clone(),
            label: if name.is_empty() { readable_shape.clone() } else { name },
            addresses: addresses_in(&c.label),
            device_type: device_type_for_shape(&shape, &c.label).to_string(),
            model: readable_shape,
            properties: HashMap::new(),
            x: (x + w / 2.0) / PX_PER_INCH,
            y: -(y + h / 2.0) / PX_PER_INCH,
            width: w / PX_PER_INCH,
            height: h / PX_PER_INCH,
            label_style: (style != TextStyle::default()).then_some(style),
        });
    }
    if skipped > 0 {
        warnings.push(format!("{name}: {skipped} area{}, caption{} and other shape{} that are not devices were left out.", if skipped == 1 { "" } else { "s" }, if skipped == 1 { "" } else { "s" }, if skipped == 1 { "" } else { "s" }));
    }
    Ok((ImportedPage { name: name.to_string(), devices, links }, warnings))
}

/// A whole `.drawio` file, every page.
pub fn import_drawio(text: &str) -> Result<VisioImport, String> {
    let doc = roxmltree::Document::parse(text).map_err(|e| format!("This is not a draw.io file: {e}"))?;
    let root = doc.root_element();
    let mut pages = Vec::new();
    let mut warnings = Vec::new();
    let diagrams: Vec<_> = if root.has_tag_name("mxfile") {
        root.children().filter(|n| n.has_tag_name("diagram")).collect()
    } else if root.has_tag_name("mxGraphModel") {
        let (page, w) = read_page(text, "Page-1")?;
        return Ok(VisioImport { pages: vec![page], warnings: w });
    } else {
        return Err(format!("This is XML, but not a draw.io drawing (it starts with <{}>).", root.tag_name().name()));
    };
    for (i, d) in diagrams.iter().enumerate() {
        let name = d.attribute("name").map(str::to_string).unwrap_or_else(|| format!("Page-{}", i + 1));
        let result = match d.children().find(|n| n.has_tag_name("mxGraphModel")) {
            Some(model) => read_page(&text[model.range()], &name),
            None => inflate_page(d.text().unwrap_or_default()).and_then(|xml| read_page(&xml, &name)),
        };
        match result {
            Ok((page, w)) => {
                pages.push(page);
                warnings.extend(w);
            }
            Err(e) => warnings.push(format!("{name} could not be read: {e}")),
        }
    }
    if pages.is_empty() {
        return Err(warnings.first().cloned().unwrap_or_else(|| "The file has no pages.".into()));
    }
    Ok(VisioImport { pages, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A page in the shapes draw.io writes, with invented names: a glued
    /// link, a loose one whose ends sit on two devices, a bend, a rack with a
    /// server inside it, an HTML label, a zone and a caption.
    const PAGE: &str = r##"<mxGraphModel dx="1927" dy="1028" grid="1" gridSize="10" page="1" pageWidth="827" pageHeight="1169"><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="zone" value="Server room" style="whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=none;verticalAlign=top;" parent="1" vertex="1"><mxGeometry x="0" y="0" width="800" height="600" as="geometry"/></mxCell>
<mxCell id="rtr" value="EDGE-RTR1&lt;br&gt;192.0.2.1" style="verticalLabelPosition=bottom;html=1;verticalAlign=top;shape=mxgraph.cisco.routers.router;fontStyle=1;fontSize=16;fontColor=#FF0000;" parent="1" vertex="1"><mxGeometry x="100" y="100" width="60" height="40" as="geometry"/></mxCell>
<mxCell id="sw" value="CORE-SW1" style="shape=mxgraph.cisco.switches.layer_3_switch;html=1;" parent="1" vertex="1"><mxGeometry x="400" y="100" width="60" height="40" as="geometry"/></mxCell>
<mxCell id="rack" value="" style="shape=mxgraph.rackGeneral.container;container=1;collapsible=0;" parent="1" vertex="1"><mxGeometry x="400" y="300" width="210" height="380" as="geometry"/></mxCell>
<mxCell id="srv" value="Mail server" style="shape=mxgraph.rack.ibm.ibm_x3550_m4;html=1;" parent="rack" vertex="1"><mxGeometry x="33" y="61" width="168" height="20" as="geometry"/></mxCell>
<mxCell id="cap" value="eth0:&lt;br&gt;xx.xxx" style="text;html=1;strokeColor=none;" parent="1" vertex="1"><mxGeometry x="200" y="200" width="40" height="20" as="geometry"/></mxCell>
<mxCell id="e1" value="Gi0/0 &lt;&gt; Gi1/0/1" style="endArrow=none;html=1;strokeColor=#0070C0;" parent="1" source="rtr" target="sw" edge="1"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="130" y="60"/><mxPoint x="430" y="60"/></Array></mxGeometry></mxCell>
<mxCell id="e2" value="" style="endArrow=none;html=1;" parent="1" edge="1"><mxGeometry width="50" height="50" relative="1" as="geometry"><mxPoint x="430" y="145" as="sourcePoint"/><mxPoint x="520" y="365" as="targetPoint"/></mxGeometry></mxCell>
<mxCell id="e3" value="" style="endArrow=none;html=1;" parent="1" edge="1"><mxGeometry relative="1" as="geometry"><mxPoint x="700" y="700" as="sourcePoint"/><mxPoint x="750" y="750" as="targetPoint"/></mxGeometry></mxCell>
</root></mxGraphModel>"##;

    fn compressed(xml: &str) -> String {
        use base64::Engine;
        use std::io::Write;
        let encoded: String = xml.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
        let mut z = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        z.write_all(encoded.as_bytes()).unwrap();
        base64::engine::general_purpose::STANDARD.encode(z.finish().unwrap())
    }

    #[test]
    fn a_page_reads_as_devices_and_links() {
        let file = format!(r#"<mxfile host="app.diagrams.net" version="24.8.3"><diagram name="Core" id="a">{PAGE}</diagram><diagram name="Copy" id="b">{}</diagram></mxfile>"#, compressed(PAGE));
        let r = import_drawio(&file).unwrap();
        assert_eq!(r.pages.len(), 2, "{:?}", r.warnings);
        assert_eq!(r.pages[0], r.pages[1].clone().tap_name("Core"), "a compressed page reads the same as a plain one");
        let p = &r.pages[0];

        let rtr = p.devices.iter().find(|d| d.id == "rtr").unwrap();
        assert_eq!((rtr.label.as_str(), rtr.device_type.as_str()), ("EDGE-RTR1", "router"));
        assert_eq!(rtr.addresses, vec!["192.0.2.1"]);
        assert_eq!(rtr.label_style.as_ref().map(|s| (s.bold, s.size, s.color.as_str())), Some((true, Some(12.0), "#ff0000")));
        assert!((rtr.x - 130.0 / 96.0).abs() < 1e-9 && (rtr.y + 120.0 / 96.0).abs() < 1e-9, "centre, in inches, y up");
        assert_eq!(p.devices.iter().find(|d| d.id == "sw").unwrap().device_type, "l3-switch");
        let srv = p.devices.iter().find(|d| d.id == "srv").unwrap();
        assert!((srv.x - (400.0 + 33.0 + 84.0) / 96.0).abs() < 1e-9, "inside the rack, offset by it");
        assert_eq!(srv.device_type, "server");
        assert!(!p.devices.iter().any(|d| d.id == "zone" || d.id == "cap"), "a zone and a caption are not devices");

        let glued = p.links.iter().find(|l| l.glued).unwrap();
        assert_eq!((glued.source_port.as_str(), glued.target_port.as_str(), glued.color.as_str()), ("Gi0/0", "Gi1/0/1", "#0070c0"));
        assert_eq!(glued.waypoints, vec![[130.0 / 96.0, -60.0 / 96.0], [430.0 / 96.0, -60.0 / 96.0]]);
        let loose = p.links.iter().find(|l| !l.glued).unwrap();
        assert_eq!((loose.source.as_str(), loose.target.as_str()), ("sw", "srv"), "a loose line joins what its ends touch — the server, not the rack round it");
        assert!(r.warnings.iter().any(|w| w.contains("1 line not joined")), "{:?}", r.warnings);
        assert!(r.warnings.iter().any(|w| w.contains("not devices")), "{:?}", r.warnings);
    }

    /// A real drawing: `CV_DRAWIO=file.drawio cargo test -p coreview
    /// real_drawio -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn a_real_drawio_when_given_one() {
        let text = std::fs::read_to_string(std::env::var("CV_DRAWIO").expect("CV_DRAWIO")).unwrap();
        let r = import_drawio(&text).unwrap();
        for p in &r.pages {
            println!("page {}: {} devices, {} links ({} glued)", p.name, p.devices.len(), p.links.len(), p.links.iter().filter(|l| l.glued).count());
            for d in p.devices.iter().take(6) {
                println!("  {} [{}] {:?}", d.label, d.device_type, d.addresses);
            }
        }
        println!("warnings: {:?}", r.warnings);
    }

    #[test]
    fn other_files_are_named_for_what_they_are() {
        assert!(import_drawio("<nmaprun/>").unwrap_err().contains("not a draw.io"));
        assert!(import_drawio("not xml").unwrap_err().contains("not a draw.io"));
        // As an attribute arrives once the XML reader has decoded it.
        assert_eq!(plain_label("Enterprise&nbsp;<div>Location</div>"), "Enterprise Location");
        assert_eq!(plain_label("Gi0/0 <> Gi1/0/1"), "Gi0/0 <> Gi1/0/1");
        assert_eq!(percent_decode("a%20b%C3%A9"), "a bé");
    }

    trait TapName {
        fn tap_name(self, name: &str) -> Self;
    }
    impl TapName for ImportedPage {
        fn tap_name(mut self, name: &str) -> Self {
            self.name = name.to_string();
            self
        }
    }
}
