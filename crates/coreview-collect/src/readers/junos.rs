//! Junos configuration read as XML — what the operational `show` commands
//! do not carry (LT-669): the SRX's address books, and firewall filters
//! that steer traffic into another routing instance (filter-based
//! forwarding).
//!
//! **Built from Juniper's documentation of the configuration schema
//! (D-058)**: `show configuration security address-book | display xml` and
//! `show configuration firewall | display xml`. No device met yet.

use serde_json::{json, Value};

fn text_of<'a>(n: roxmltree::Node<'a, 'a>, tag: &str) -> Option<String> {
    n.children().find(|c| c.is_element() && c.tag_name().name() == tag).and_then(|c| c.text()).map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

fn children<'a>(n: roxmltree::Node<'a, 'a>, tag: &'a str) -> impl Iterator<Item = roxmltree::Node<'a, 'a>> {
    n.children().filter(move |c| c.is_element() && c.tag_name().name() == tag)
}

/// `show configuration security address-book | display xml`: every
/// `address` in every book — a prefix (`ip-prefix`), a name (`dns-name`),
/// a range (`range-address` from/to) or a wildcard — and every
/// `address-set` as one row per member. The book's name rides along in
/// `book`; a zone-attached book (pre-11.2 style) is read the same way.
pub fn address_book(raw: &str) -> Vec<Value> {
    let Ok(doc) = roxmltree::Document::parse(raw.trim()) else { return Vec::new() };
    let mut out = Vec::new();
    for book in doc.descendants().filter(|n| n.is_element() && n.tag_name().name() == "book") {
        let book_name = text_of(book, "name").unwrap_or_else(|| "global".into());
        for a in children(book, "address") {
            let Some(name) = text_of(a, "name") else { continue };
            let mut row = json!({"name": name, "book": book_name});
            if let Some(p) = text_of(a, "ip-prefix") {
                match p.split_once('/') {
                    Some((n, l)) => {
                        row["network"] = json!(n);
                        row["mask"] = json!(l);
                    }
                    None => row["host"] = json!(p),
                }
            } else if let Some(d) = text_of(a, "dns-name").or_else(|| a.children().find(|c| c.is_element() && c.tag_name().name() == "dns-name").and_then(|c| text_of(c, "name"))) {
                row["fqdn"] = json!(d);
            } else if let Some(r) = a.children().find(|c| c.is_element() && c.tag_name().name() == "range-address") {
                if let (Some(f), Some(t)) = (text_of(r, "name").or_else(|| text_of(r, "from")), r.children().find(|c| c.is_element() && c.tag_name().name() == "to").and_then(|c| text_of(c, "name")).or_else(|| text_of(r, "to"))) {
                    row["range_start"] = json!(f);
                    row["range_end"] = json!(t);
                }
            } else if let Some(w) = a.children().find(|c| c.is_element() && c.tag_name().name() == "wildcard-address") {
                if let Some(n) = text_of(w, "name") {
                    row["wildcard"] = json!(n);
                }
            }
            out.push(row);
        }
        for set in children(book, "address-set") {
            let Some(name) = text_of(set, "name") else { continue };
            for m in set.children().filter(|c| c.is_element() && (c.tag_name().name() == "address" || c.tag_name().name() == "address-set")) {
                if let Some(member) = text_of(m, "name") {
                    out.push(json!({"name": name, "book": book_name, "member": member}));
                }
            }
        }
    }
    out
}

/// `show configuration firewall | display xml`: the terms of every
/// `family inet` filter whose action sends the packet elsewhere — `then
/// routing-instance <x>` (filter-based forwarding) or `then next-ip`. One
/// policy-route row per such term: the filter and term as the sequence,
/// its `from` addresses, protocol and destination port, and the instance
/// or next hop it steers into. Terms that only accept, discard or count
/// are not policy routes and are left out. Which interfaces apply the
/// filter is in `show configuration interfaces`, not here.
pub fn fbf(raw: &str) -> Vec<Value> {
    let Ok(doc) = roxmltree::Document::parse(raw.trim()) else { return Vec::new() };
    let mut out = Vec::new();
    for filter in doc.descendants().filter(|n| n.is_element() && n.tag_name().name() == "filter") {
        let Some(fname) = text_of(filter, "name") else { continue };
        for term in children(filter, "term") {
            let Some(tname) = text_of(term, "name") else { continue };
            let Some(then) = term.children().find(|c| c.is_element() && c.tag_name().name() == "then") else { continue };
            let instance = text_of(then, "routing-instance");
            let next_ip = then.children().find(|c| c.is_element() && c.tag_name().name() == "next-ip").and_then(|c| text_of(c, "address").or_else(|| c.text().map(|t| t.trim().to_string())));
            if instance.is_none() && next_ip.is_none() {
                continue;
            }
            let mut row = json!({"seq": format!("{fname} {tname}")});
            if let Some(from) = term.children().find(|c| c.is_element() && c.tag_name().name() == "from") {
                let list = |tag: &str| -> Vec<String> { children(from, tag).filter_map(|c| text_of(c, "name").or_else(|| c.text().map(|t| t.trim().to_string()))).filter(|s| !s.is_empty()).collect() };
                let src = list("source-address");
                let dst = list("destination-address");
                let any = list("address");
                if !src.is_empty() {
                    row["src"] = json!(src.join(", "));
                }
                if !dst.is_empty() {
                    row["dst"] = json!(dst.join(", "));
                } else if !any.is_empty() {
                    row["dst"] = json!(any.join(", "));
                }
                let proto = list("protocol");
                if !proto.is_empty() {
                    row["proto"] = json!(proto.join(", "));
                }
                let port = list("destination-port");
                if !port.is_empty() {
                    row["port"] = json!(port.join(", "));
                }
            }
            if let Some(i) = instance {
                row["action_vrf"] = json!(i);
            }
            if let Some(n) = next_ip {
                row["action_nh"] = json!(n.split('/').next().unwrap_or(&n));
            }
            out.push(row);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    //! Juniper's configuration XML shapes with invented values (D-027, D-058).
    use super::*;

    #[test]
    fn address_books_give_objects_and_set_members() {
        let xml = r#"<rpc-reply><configuration><security><address-book><book><name>global</name>
          <address><name>web-srv</name><ip-prefix>192.0.2.10/32</ip-prefix></address>
          <address><name>lan</name><ip-prefix>10.0.0.0/8</ip-prefix></address>
          <address><name>vendor</name><dns-name><name>vendor.example.test</name></dns-name></address>
          <address><name>dhcp-pool</name><range-address><name>198.51.100.10</name><to><name>198.51.100.50</name></to></range-address></address>
          <address-set><name>servers</name><address><name>web-srv</name></address><address><name>lan</name></address></address-set>
        </book></address-book></security></configuration></rpc-reply>"#;
        let rows = address_book(xml);
        assert_eq!(rows.len(), 6, "{rows:#?}");
        assert_eq!(rows[0], json!({"name": "web-srv", "book": "global", "network": "192.0.2.10", "mask": "32"}));
        assert_eq!(rows[2], json!({"name": "vendor", "book": "global", "fqdn": "vendor.example.test"}));
        assert_eq!(rows[3], json!({"name": "dhcp-pool", "book": "global", "range_start": "198.51.100.10", "range_end": "198.51.100.50"}));
        assert_eq!(rows[4], json!({"name": "servers", "book": "global", "member": "web-srv"}));
        assert_eq!(rows[5]["member"], "lan");
        use crate::tables::normalise_all;
        let n = normalise_all(&["fw_object".into()], &rows);
        assert_eq!((n[0].columns["name"].as_str(), n[0].columns["network"].as_str(), n[0].columns["mask"].as_str()), ("web-srv", "192.0.2.10", "32"));
        assert_eq!(n[4].columns["member"], "web-srv");
    }

    #[test]
    fn filter_based_forwarding_terms_are_policy_routes() {
        let xml = r#"<rpc-reply><configuration><firewall><family><inet>
          <filter><name>FBF</name>
            <term><name>to-isp-b</name><from><source-address><name>10.1.0.0/16</name></source-address><destination-address><name>0.0.0.0/0</name></destination-address><protocol>tcp</protocol><destination-port>443</destination-port></from><then><routing-instance>ISP-B</routing-instance></then></term>
            <term><name>steer</name><from><source-address><name>10.2.0.0/16</name></source-address></from><then><next-ip><address>198.51.100.1/32</address></next-ip></then></term>
            <term><name>rest</name><then><accept/></then></term>
          </filter>
          <filter><name>PROTECT</name><term><name>drop</name><from><protocol>icmp</protocol></from><then><discard/></then></term></filter>
        </inet></family></firewall></configuration></rpc-reply>"#;
        let rows = fbf(xml);
        assert_eq!(rows, vec![
            json!({"seq": "FBF to-isp-b", "src": "10.1.0.0/16", "dst": "0.0.0.0/0", "proto": "tcp", "port": "443", "action_vrf": "ISP-B"}),
            json!({"seq": "FBF steer", "src": "10.2.0.0/16", "action_nh": "198.51.100.1"}),
        ]);
    }
}
