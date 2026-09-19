//! Prints the shape of the tables LT-134 reads — IF-MIB interface names,
//! LLDP-MIB neighbours, BRIDGE-MIB forwarding — on one device, with any
//! credential, so a parser is written against what devices really return.
//!
//! Structure only: row counts, index lengths and value kinds. No names,
//! addresses or MACs are printed.
//!
//! ```text
//! CV_HOST=192.0.2.1 CV_COMMUNITY=public \
//!   cargo run -p coreview-discover --example snmp_tables
//! CV_HOST=192.0.2.1 CV_V3_USER=netops CV_V3_AUTH=sha CV_V3_AUTH_PASS=... \
//!   CV_V3_PRIV=aes CV_V3_PRIV_PASS=... \
//!   cargo run -p coreview-discover --example snmp_tables
//! ```

use std::collections::BTreeMap;
use std::time::Duration;

use coreview_discover::snmp::{walk_table, AuthKind, PrivKind, SnmpAuth, Walked};

const TABLES: &[(&str, &[u64])] = &[
    ("IF-MIB ifName", &[1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 1]),
    ("LLDP lldpLocPortId", &[1, 0, 8802, 1, 1, 2, 1, 3, 7, 1, 3]),
    ("LLDP lldpRemChassisIdSubtype", &[1, 0, 8802, 1, 1, 2, 1, 4, 1, 1, 4]),
    ("LLDP lldpRemPortIdSubtype", &[1, 0, 8802, 1, 1, 2, 1, 4, 1, 1, 6]),
    ("LLDP lldpRemPortId", &[1, 0, 8802, 1, 1, 2, 1, 4, 1, 1, 7]),
    ("LLDP lldpRemSysName", &[1, 0, 8802, 1, 1, 2, 1, 4, 1, 1, 9]),
    ("LLDP lldpRemManAddrIfSubtype", &[1, 0, 8802, 1, 1, 2, 1, 4, 2, 1, 3]),
    ("BRIDGE dot1dBasePortIfIndex", &[1, 3, 6, 1, 2, 1, 17, 1, 4, 1, 2]),
    ("BRIDGE dot1dTpFdbPort", &[1, 3, 6, 1, 2, 1, 17, 4, 3, 1, 2]),
    // LT-201: BGP4-MIB peers and OSPF-MIB neighbours.
    ("BGP4 bgpPeerState", &[1, 3, 6, 1, 2, 1, 15, 3, 1, 2]),
    ("BGP4 bgpPeerRemoteAs", &[1, 3, 6, 1, 2, 1, 15, 3, 1, 9]),
    ("OSPF ospfNbrState", &[1, 3, 6, 1, 2, 1, 14, 10, 1, 6]),
    ("OSPF ospfNbrRtrId", &[1, 3, 6, 1, 2, 1, 14, 10, 1, 3]),
    ("Q-BRIDGE dot1qTpFdbPort", &[1, 3, 6, 1, 2, 1, 17, 7, 1, 2, 2, 1, 2]),
];

#[tokio::main]
async fn main() {
    let host = std::env::var("CV_HOST").expect("set CV_HOST");
    let auth = if let Ok(username) = std::env::var("CV_V3_USER") {
        SnmpAuth::V3 {
            username,
            auth_protocol: AuthKind::parse(&std::env::var("CV_V3_AUTH").unwrap_or_else(|_| "sha".into()))
                .expect("bad CV_V3_AUTH"),
            auth_password: std::env::var("CV_V3_AUTH_PASS").expect("set CV_V3_AUTH_PASS"),
            privacy: std::env::var("CV_V3_PRIV").ok().map(|p| PrivKind::parse(&p).expect("bad CV_V3_PRIV")),
            privacy_password: std::env::var("CV_V3_PRIV_PASS").unwrap_or_default(),
        }
    } else {
        SnmpAuth::V2c { community: std::env::var("CV_COMMUNITY").expect("set CV_COMMUNITY or CV_V3_USER") }
    };

    println!("tables on .{}", host.rsplit('.').next().unwrap_or("?"));
    for (label, column) in TABLES {
        match walk_table(&host, 161, &auth, Duration::from_secs(4), column, 5000).await {
            Err(e) => println!("  {label:<30} error: {e}"),
            Ok(rows) if rows.is_empty() => println!("  {label:<30}    0 rows"),
            Ok(rows) => {
                // How many rows have each index length, and what the values are.
                let mut lengths: BTreeMap<usize, usize> = BTreeMap::new();
                let mut kinds: BTreeMap<String, usize> = BTreeMap::new();
                for (index, value) in &rows {
                    *lengths.entry(index.split('.').count()).or_default() += 1;
                    let kind = match value {
                        Walked::Int(_) => "integer".to_string(),
                        Walked::Octets(b) => format!("{} bytes", b.len()),
                        Walked::Other => "other".to_string(),
                    };
                    *kinds.entry(kind).or_default() += 1;
                }
                let lengths: Vec<String> = lengths.iter().map(|(l, n)| format!("{n}×{l}-part")).collect();
                let kinds: Vec<String> = kinds.iter().take(4).map(|(k, n)| format!("{n}×{k}")).collect();
                println!(
                    "  {label:<30} {:>4} rows; index {}; values {}",
                    rows.len(),
                    lengths.join(", "),
                    kinds.join(", ")
                );
            }
        }
    }
    decoder_facts(&host, &auth).await;
}

async fn column(host: &str, auth: &SnmpAuth, oid: &[u64]) -> Vec<(String, Walked)> {
    walk_table(host, 161, auth, Duration::from_secs(4), oid, 5000).await.unwrap_or_default()
}

/// Facts a decoder needs that are still not identifying: subtype numbers,
/// capability bits, and whether one table's keys fall inside another's.
async fn decoder_facts(host: &str, auth: &SnmpAuth) {
    let ints = |rows: &[(String, Walked)]| -> BTreeMap<i64, usize> {
        let mut m = BTreeMap::new();
        for (_, v) in rows {
            if let Walked::Int(n) = v {
                *m.entry(*n).or_default() += 1;
            }
        }
        m
    };
    let texts = |rows: &[(String, Walked)]| -> Vec<String> {
        rows.iter()
            .filter_map(|(_, v)| match v {
                Walked::Octets(b) => Some(String::from_utf8_lossy(b).trim().to_string()),
                _ => None,
            })
            .collect()
    };
    let chassis = column(host, auth, &[1, 0, 8802, 1, 1, 2, 1, 4, 1, 1, 4]).await;
    let port = column(host, auth, &[1, 0, 8802, 1, 1, 2, 1, 4, 1, 1, 6]).await;
    let loc_subtype = column(host, auth, &[1, 0, 8802, 1, 1, 2, 1, 3, 7, 1, 2]).await;
    println!("  facts: chassis-id subtypes {:?}, remote port-id subtypes {:?}, local port-id subtypes {:?}",
        ints(&chassis), ints(&port), ints(&loc_subtype));

    let caps = column(host, auth, &[1, 0, 8802, 1, 1, 2, 1, 4, 1, 1, 12]).await;
    let cap_bytes: Vec<String> = caps.iter().filter_map(|(_, v)| match v {
        Walked::Octets(b) => Some(b.iter().map(|x| format!("{x:02x}")).collect::<String>()),
        _ => None,
    }).collect();
    println!("  facts: remote capabilities-enabled bitmaps {cap_bytes:?}");

    let if_names = texts(&column(host, auth, &[1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 1]).await);
    let loc_ids = texts(&column(host, auth, &[1, 0, 8802, 1, 1, 2, 1, 3, 7, 1, 3]).await);
    let loc_descs = texts(&column(host, auth, &[1, 0, 8802, 1, 1, 2, 1, 3, 7, 1, 4]).await);
    let matches = |xs: &[String]| xs.iter().filter(|x| if_names.contains(x)).count();
    println!("  facts: local LLDP port ids equal to an ifName {}/{}; local port descriptions equal to an ifName {}/{}",
        matches(&loc_ids), loc_ids.len(), matches(&loc_descs), loc_descs.len());

    let if_index: std::collections::BTreeSet<i64> = column(host, auth, &[1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 1]).await
        .iter().filter_map(|(i, _)| i.parse().ok()).collect();
    let base_ports: std::collections::BTreeSet<i64> = column(host, auth, &[1, 3, 6, 1, 2, 1, 17, 1, 4, 1, 2]).await
        .iter().filter_map(|(i, _)| i.parse().ok()).collect();
    let fdb_ports = ints(&column(host, auth, &[1, 3, 6, 1, 2, 1, 17, 4, 3, 1, 2]).await);
    let in_base = fdb_ports.keys().filter(|p| base_ports.contains(p)).count();
    let in_if = fdb_ports.keys().filter(|p| if_index.contains(p)).count();
    println!("  facts: distinct FDB port numbers {}; inside the bridge-port set {in_base}; inside the ifIndex set {in_if}; port 0 present {}",
        fdb_ports.len(), fdb_ports.contains_key(&0));
    let q = column(host, auth, &[1, 3, 6, 1, 2, 1, 17, 7, 1, 2, 2, 1, 2]).await;
    let fdb_ids: std::collections::BTreeSet<String> = q.iter().filter_map(|(i, _)| i.split('.').next().map(str::to_string)).collect();
    println!("  facts: Q-BRIDGE FDB ids (VLAN-like) distinct {}", fdb_ids.len());
}
