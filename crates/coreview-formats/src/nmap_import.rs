//! An Nmap XML report read as ping-sweep results (LT-248).
//!
//! Plenty of engineers already have a scan — from a jump host, from last
//! quarter's audit — and re-sweeping from the laptop would either not reach or
//! not be allowed. `nmap -oX` is the one format every version writes the same
//! way, so it is read into the sweep's own rows, and from there onto the
//! diagram exactly as a sweep would be.
//!
//! **Written against Nmap 7.98 output captured on the lab subnet** (a
//! connect scan with version detection, and a scan with reverse DNS). What it
//! taught:
//!
//! * The file starts with `<!DOCTYPE nmaprun>` and an `xml-stylesheet`
//!   instruction. An XML reader that refuses DTDs — the default here — reports
//!   the whole file as invalid.
//! * `<hosthint>` elements precede the real `<host>` elements and repeat the
//!   same address with no ports. They are not hosts.
//! * A host's names come as `<hostname type="user">` (what was typed) and
//!   `type="PTR"` (reverse DNS), often both, often identical.
//! * Closed ports are listed with `state="closed"`; only `open` is a port.
//! * `srtt` is in microseconds.
//!
//! **Not yet seen in a capture:** the `addrtype="mac"` address and its
//! `vendor`, and `<os><osmatch>`, which Nmap writes only when it runs with
//! raw-socket privileges this machine's capture did not have. They are read
//! as `nmap.dtd` defines them, and the roadmap entry says so until a
//! privileged scan has been read.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NmapPort {
    pub port: u16,
    pub service: String,
}

/// One host that was up, in the shape of the sweep's `SweepHit`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NmapHost {
    pub ip: String,
    pub rtt_ms: Option<f64>,
    pub hostname: Option<String>,
    pub name_source: Option<&'static str>,
    pub mac: Option<String>,
    pub vendor: Option<String>,
    pub ports: Vec<NmapPort>,
    pub serial: Option<String>,
    /// The operating system Nmap matched best, else the product behind the
    /// first open port that named one.
    pub product: Option<String>,
    pub web_server: Option<String>,
    pub web_title: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NmapReport {
    pub hosts: Vec<NmapHost>,
    /// Addresses scanned and found up, from the run's own totals.
    pub scanned: Option<u32>,
    pub up: Option<u32>,
    /// The command line, so the person can see what the scan asked.
    pub args: Option<String>,
}

fn child<'a, 'i>(n: roxmltree::Node<'a, 'i>, name: &str) -> Option<roxmltree::Node<'a, 'i>> {
    n.children().find(|c| c.has_tag_name(name))
}

pub fn read_nmap_xml(xml: &str) -> Result<NmapReport, String> {
    if xml.len() > 128 * 1024 * 1024 {
        return Err("This file is too large to be one scan.".into());
    }
    let options = roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() };
    let doc = roxmltree::Document::parse_with_options(xml, options).map_err(|e| format!("This is not an Nmap XML file: {e}"))?;
    let root = doc.root_element();
    if root.tag_name().name() != "nmaprun" {
        return Err(format!("This is XML, but not an Nmap report (it starts with <{}>). Save the scan with -oX.", root.tag_name().name()));
    }

    let mut hosts = Vec::new();
    for host in root.children().filter(|n| n.has_tag_name("host")) {
        if child(host, "status").and_then(|s| s.attribute("state")) != Some("up") {
            continue;
        }
        let addresses: Vec<_> = host.children().filter(|n| n.has_tag_name("address")).collect();
        let Some(ip) = addresses.iter().find(|a| a.attribute("addrtype") == Some("ipv4")).and_then(|a| a.attribute("addr")) else {
            continue;
        };
        let mac_node = addresses.iter().find(|a| a.attribute("addrtype") == Some("mac"));
        let names: Vec<_> = child(host, "hostnames").map(|h| h.children().filter(|n| n.has_tag_name("hostname")).collect()).unwrap_or_default();
        let hostname = names
            .iter()
            .find(|n| n.attribute("type") == Some("PTR"))
            .or_else(|| names.first())
            .and_then(|n| n.attribute("name"))
            .filter(|n| *n != ip)
            .map(str::to_string);

        let mut ports = Vec::new();
        let mut first_product = None;
        let mut web_server = None;
        for port in child(host, "ports").map(|p| p.children().filter(|n| n.has_tag_name("port")).collect::<Vec<_>>()).unwrap_or_default() {
            if port.attribute("protocol") != Some("tcp") || child(port, "state").and_then(|s| s.attribute("state")) != Some("open") {
                continue;
            }
            let Some(number) = port.attribute("portid").and_then(|p| p.parse().ok()) else { continue };
            let service = child(port, "service");
            let name = service.and_then(|s| s.attribute("name")).unwrap_or("").to_string();
            let product = service.and_then(|s| s.attribute("product"));
            if first_product.is_none() {
                first_product = product.map(str::to_string);
            }
            if web_server.is_none() && name == "http" && service.and_then(|s| s.attribute("tunnel")).is_none() {
                web_server = product.map(str::to_string);
            }
            ports.push(NmapPort { port: number, service: name });
        }
        let os = child(host, "os").and_then(|o| o.children().find(|n| n.has_tag_name("osmatch"))).and_then(|m| m.attribute("name")).map(str::to_string);

        hosts.push(NmapHost {
            ip: ip.to_string(),
            rtt_ms: child(host, "times").and_then(|t| t.attribute("srtt")).and_then(|s| s.parse::<f64>().ok()).map(|us| (us / 1000.0 * 100.0).round() / 100.0),
            name_source: hostname.as_ref().map(|_| "dns"),
            hostname,
            mac: mac_node.and_then(|m| m.attribute("addr")).map(|m| m.to_ascii_lowercase()),
            vendor: mac_node.and_then(|m| m.attribute("vendor")).map(str::to_string),
            ports,
            serial: None,
            product: os.or(first_product),
            web_server,
            web_title: None,
        });
    }
    let totals = child(root, "runstats").and_then(|r| child(r, "hosts"));
    Ok(NmapReport {
        hosts,
        scanned: totals.and_then(|t| t.attribute("total")).and_then(|n| n.parse().ok()),
        up: totals.and_then(|t| t.attribute("up")).and_then(|n| n.parse().ok()),
        args: root.attribute("args").map(str::to_string),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The shape of a captured 7.98 report, with documentation addresses and
    // invented names; the MAC and OS elements follow nmap.dtd.
    const REPORT: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nmaprun>
<?xml-stylesheet href="file:///usr/share/nmap/nmap.xsl" type="text/xsl"?>
<!-- Nmap 7.98 scan initiated Wed Sep 16 17:51:01 2026 as: nmap -sT -sV -p 22,23,80,443 -oX scan.xml 192.0.2.1-10 -->
<nmaprun scanner="nmap" args="nmap -sT -sV -p 22,23,80,443 -oX scan.xml 192.0.2.1-10" start="1789599061" version="7.98" xmloutputversion="1.05">
<scaninfo type="connect" protocol="tcp" numservices="4" services="22-23,80,443"/>
<verbose level="0"/>
<debugging level="0"/>
<hosthint><status state="up" reason="unknown-response" reason_ttl="0"/>
<address addr="192.0.2.5" addrtype="ipv4"/>
<hostnames>
</hostnames>
</hosthint>
<host starttime="1789599063" endtime="1789599070"><status state="up" reason="conn-refused" reason_ttl="0"/>
<address addr="192.0.2.5" addrtype="ipv4"/>
<hostnames>
<hostname name="files.example.test" type="user"/>
<hostname name="nas1.example.test" type="PTR"/>
</hostnames>
<ports><port protocol="tcp" portid="22"><state state="open" reason="syn-ack" reason_ttl="0"/><service name="ssh" product="OpenSSH" version="10.0p2 Debian 7" extrainfo="protocol 2.0" ostype="Linux" method="probed" conf="10"><cpe>cpe:/a:openbsd:openssh:10.0p2</cpe></service></port>
<port protocol="tcp" portid="23"><state state="closed" reason="conn-refused" reason_ttl="0"/><service name="telnet" method="table" conf="3"/></port>
</ports>
<times srtt="175" rttvar="1240" to="100000"/>
</host>
<host starttime="1789599063" endtime="1789599070"><status state="up" reason="syn-ack" reason_ttl="0"/>
<address addr="192.0.2.7" addrtype="ipv4"/>
<address addr="00:00:5E:00:53:07" addrtype="mac" vendor="ICANN, IANA Department"/>
<hostnames>
</hostnames>
<ports><port protocol="tcp" portid="22"><state state="open" reason="syn-ack" reason_ttl="0"/><service name="ssh" product="Cisco SSH" version="1.25" extrainfo="protocol 2.0" ostype="IOS" method="probed" conf="10"><cpe>cpe:/a:cisco:ssh:1.25</cpe></service></port>
<port protocol="tcp" portid="80"><state state="open" reason="syn-ack" reason_ttl="0"/><service name="http" product="Cisco IOS http config" ostype="IOS" method="probed" conf="10"><cpe>cpe:/o:cisco:ios</cpe></service></port>
<port protocol="tcp" portid="443"><state state="open" reason="syn-ack" reason_ttl="0"/><service name="https" tunnel="ssl" method="table" conf="3"/></port>
</ports>
<os><osmatch name="Cisco Catalyst 2960 switch (IOS 15.2)" accuracy="96" line="1"/></os>
<times srtt="3791" rttvar="1957" to="100000"/>
</host>
<host><status state="down" reason="no-response" reason_ttl="0"/>
<address addr="192.0.2.9" addrtype="ipv4"/>
</host>
<runstats><finished time="1789599070" elapsed="9.15" exit="success"/><hosts up="2" down="8" total="10"/>
</runstats>
</nmaprun>
"#;

    #[test]
    fn a_report_reads_as_sweep_rows() {
        let r = read_nmap_xml(REPORT).unwrap();
        assert_eq!((r.scanned, r.up), (Some(10), Some(2)));
        assert_eq!(r.hosts.len(), 2, "hosthints and down hosts are not rows");
        let nas = &r.hosts[0];
        assert_eq!(nas.hostname.as_deref(), Some("nas1.example.test"), "PTR over what was typed");
        assert_eq!(nas.ports, vec![NmapPort { port: 22, service: "ssh".into() }], "closed ports left out");
        assert_eq!(nas.rtt_ms, Some(0.18), "srtt is microseconds");
        assert_eq!(nas.product.as_deref(), Some("OpenSSH"));
        let sw = &r.hosts[1];
        assert_eq!(sw.mac.as_deref(), Some("00:00:5e:00:53:07"));
        assert_eq!(sw.vendor.as_deref(), Some("ICANN, IANA Department"));
        assert_eq!(sw.product.as_deref(), Some("Cisco Catalyst 2960 switch (IOS 15.2)"), "the OS match first");
        assert_eq!(sw.web_server.as_deref(), Some("Cisco IOS http config"));
        assert_eq!(sw.ports.len(), 3);
        assert!(sw.hostname.is_none());
    }

    /// A real report, given by path: `CV_NMAP_XML=scan.xml cargo test -p
    /// coreview real_report -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn a_real_report_when_given_one() {
        let path = std::env::var("CV_NMAP_XML").expect("CV_NMAP_XML");
        let r = read_nmap_xml(&std::fs::read_to_string(path).unwrap()).unwrap();
        println!("{} of {:?} up", r.hosts.len(), r.scanned);
        for h in &r.hosts {
            println!("{} {:?} {:?} {:?} ports {:?} web {:?}", h.ip, h.hostname, h.rtt_ms, h.product, h.ports.iter().map(|p| p.port).collect::<Vec<_>>(), h.web_server);
        }
    }

    #[test]
    fn other_files_are_refused_plainly() {
        assert!(read_nmap_xml("not xml").unwrap_err().contains("not an Nmap XML"));
        assert!(read_nmap_xml("<mxfile/>").unwrap_err().contains("-oX"));
    }
}
