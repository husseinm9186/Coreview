//! LT-549: the SNMP fallback read end to end, over UDP, from a small
//! SNMPv2c agent written here — Get and GetNext over a table held in order,
//! answered in BER by hand. The agent's rows follow the MIBs' definitions
//! (D-058), not a capture; invented names, documentation addresses, an
//! obviously fake community (D-027, LT-137).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use coreview_discover::snmp::SnmpAuth;
use coreview_discover::snmp_collect::read_for_collection;
use snmp2::{MessageType, Pdu, Value};

#[derive(Clone)]
enum V {
    Int(i64),
    Oct(Vec<u8>),
    Ip([u8; 4]),
    Oid(Vec<u64>),
    Ticks(u32),
}

fn len(out: &mut Vec<u8>, n: usize) {
    if n < 128 {
        out.push(n as u8);
    } else {
        let bytes: Vec<u8> = n.to_be_bytes().iter().copied().skip_while(|b| *b == 0).collect();
        out.push(0x80 | bytes.len() as u8);
        out.extend(bytes);
    }
}

fn tlv(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    len(&mut out, body.len());
    out.extend_from_slice(body);
    out
}

fn int_body(n: i64) -> Vec<u8> {
    let mut b = n.to_be_bytes().to_vec();
    while b.len() > 1 && ((b[0] == 0 && b[1] & 0x80 == 0) || (b[0] == 0xff && b[1] & 0x80 != 0)) {
        b.remove(0);
    }
    b
}

fn oid_body(o: &[u64]) -> Vec<u8> {
    let mut out = vec![(o[0] * 40 + o[1]) as u8];
    for &arc in &o[2..] {
        let mut stack = vec![(arc & 0x7f) as u8];
        let mut a = arc >> 7;
        while a > 0 {
            stack.push(0x80 | (a & 0x7f) as u8);
            a >>= 7;
        }
        stack.reverse();
        out.extend(stack);
    }
    out
}

fn value(v: Option<&V>, end: bool) -> Vec<u8> {
    match v {
        None if end => tlv(0x82, &[]), // endOfMibView
        None => tlv(0x81, &[]),        // noSuchInstance
        Some(V::Int(n)) => tlv(0x02, &int_body(*n)),
        Some(V::Oct(b)) => tlv(0x04, b),
        Some(V::Ip(a)) => tlv(0x40, a),
        Some(V::Oid(o)) => tlv(0x06, &oid_body(o)),
        Some(V::Ticks(t)) => tlv(0x43, &int_body(i64::from(*t))),
    }
}

fn parse_oid(s: &str) -> Vec<u64> {
    s.split('.').filter(|x| !x.is_empty()).map(|x| x.parse().unwrap()).collect()
}

fn o(s: &str) -> Vec<u64> {
    parse_oid(s)
}

fn table() -> BTreeMap<Vec<u64>, V> {
    let t = |s: &str| V::Oct(s.as_bytes().to_vec());
    let mut m = BTreeMap::new();
    // System group.
    m.insert(o("1.3.6.1.2.1.1.1.0"), t("Cisco IOS Software, C2960X Software, Version 15.2(4)E7"));
    m.insert(o("1.3.6.1.2.1.1.2.0"), V::Oid(o("1.3.6.1.4.1.9.1.1208")));
    m.insert(o("1.3.6.1.2.1.1.3.0"), V::Ticks(123_456));
    m.insert(o("1.3.6.1.2.1.1.5.0"), t("SNMP-SW"));
    m.insert(o("1.3.6.1.2.1.1.6.0"), t("lab rack 1"));
    m.insert(o("1.3.6.1.2.1.1.7.0"), V::Int(6));
    // ENTITY-MIB: one chassis.
    m.insert(o("1.3.6.1.2.1.47.1.1.1.1.5.1"), V::Int(3));
    m.insert(o("1.3.6.1.2.1.47.1.1.1.1.11.1"), t("FAKESNMP001"));
    m.insert(o("1.3.6.1.2.1.47.1.1.1.1.13.1"), t("WS-C2960X-24TS-L"));
    // ifName.
    m.insert(o("1.3.6.1.2.1.31.1.1.1.1.5"), t("Vlan10"));
    m.insert(o("1.3.6.1.2.1.31.1.1.1.1.10101"), t("Gi1/0/1"));
    // BRIDGE-MIB: bridge port 1 is Gi1/0/1; one MAC learned there.
    m.insert(o("1.3.6.1.2.1.17.1.4.1.2.1"), V::Int(10101));
    m.insert(o("1.3.6.1.2.1.17.4.3.1.2.0.0.0.0.0.85"), V::Int(1));
    m.insert(o("1.3.6.1.2.1.17.4.3.1.3.0.0.0.0.0.85"), V::Int(3));
    // CISCO-CDP-MIB: SW2 on Gi1/0/1.
    m.insert(o("1.3.6.1.4.1.9.9.23.1.2.1.1.4.10101.1"), V::Oct(vec![192, 0, 2, 2]));
    m.insert(o("1.3.6.1.4.1.9.9.23.1.2.1.1.6.10101.1"), t("SW2.lab.example.net"));
    m.insert(o("1.3.6.1.4.1.9.9.23.1.2.1.1.7.10101.1"), t("GigabitEthernet1/0/2"));
    m.insert(o("1.3.6.1.4.1.9.9.23.1.2.1.1.8.10101.1"), t("cisco WS-C2960X-24TS-L"));
    // IP-FORWARD-MIB ipCidrRouteTable: the connected VLAN and a default route.
    for (idx, ifx, ty, proto) in [("192.0.2.0.255.255.255.0.0.0.0.0.0", 5, 3, 2), ("0.0.0.0.0.0.0.0.0.192.0.2.254", 5, 4, 3)] {
        m.insert(o(&format!("1.3.6.1.2.1.4.24.4.1.5.{idx}")), V::Int(ifx));
        m.insert(o(&format!("1.3.6.1.2.1.4.24.4.1.6.{idx}")), V::Int(ty));
        m.insert(o(&format!("1.3.6.1.2.1.4.24.4.1.7.{idx}")), V::Int(proto));
    }
    // IP-MIB: the switch's own address, and one ARP entry.
    m.insert(o("1.3.6.1.2.1.4.20.1.2.192.0.2.10"), V::Int(5));
    m.insert(o("1.3.6.1.2.1.4.20.1.3.192.0.2.10"), V::Ip([255, 255, 255, 0]));
    m.insert(o("1.3.6.1.2.1.4.22.1.2.5.192.0.2.77"), V::Oct(vec![0, 0, 0, 0, 0, 0x77]));
    m
}

/// A v2c agent: Get and GetNext, the community checked.
async fn agent(community: &'static str) -> u16 {
    let sock = Arc::new(tokio::net::UdpSocket::bind(("127.0.0.1", 0)).await.unwrap());
    let port = sock.local_addr().unwrap().port();
    let data = table();
    tokio::spawn(async move {
        let mut buf = vec![0u8; 65_535];
        loop {
            let Ok((n, from)) = sock.recv_from(&mut buf).await else { return };
            let Ok(pdu) = Pdu::from_bytes(&buf[..n]) else { continue };
            if pdu.community != community.as_bytes() {
                continue; // a wrong community is not answered, as agents do
            }
            let next = matches!(pdu.message_type, MessageType::GetNextRequest);
            let mut binds = Vec::new();
            for (oid, _v) in pdu.varbinds.clone() {
                let asked = parse_oid(&oid.to_string());
                let (at, val) = if next {
                    match data.range((std::ops::Bound::Excluded(asked.clone()), std::ops::Bound::Unbounded)).next() {
                        Some((k, v)) => (k.clone(), Some(v)),
                        None => (asked.clone(), None),
                    }
                } else {
                    (asked.clone(), data.get(&asked))
                };
                let mut vb = tlv(0x06, &oid_body(&at));
                vb.extend(value(val, next));
                binds.extend(tlv(0x30, &vb));
            }
            let mut body = tlv(0x02, &int_body(i64::from(pdu.req_id)));
            body.extend(tlv(0x02, &[0]));
            body.extend(tlv(0x02, &[0]));
            body.extend(tlv(0x30, &binds));
            let mut msg = tlv(0x02, &[1]); // v2c
            msg.extend(tlv(0x04, community.as_bytes()));
            msg.extend(tlv(0xa2, &body));
            let _ = sock.send_to(&tlv(0x30, &msg), from).await;
            let _ = Value::Null; // the library's own value type is only read here
        }
    });
    port
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_device_ssh_could_not_open_is_read_over_snmp_into_the_collections_tables() {
    let port = agent("not-a-real-community").await;
    let auth = SnmpAuth::V2c { community: "not-a-real-community".into() };
    let tables = read_for_collection("127.0.0.1", port, &auth, Duration::from_secs(2)).await.expect("the agent answers");
    let by = |id: &str| tables.iter().find(|t| t.id == id).unwrap_or_else(|| panic!("no {id}"));
    let sys = &by("snmp_system").rows[0];
    assert_eq!(sys["hostname"], "SNMP-SW");
    assert_eq!(sys["serial"][0], "FAKESNMP001");
    assert_eq!(sys["model"], "WS-C2960X-24TS-L");
    let cdp = &by("snmp_cdp").rows;
    assert_eq!(cdp.len(), 1, "{cdp:?}");
    assert_eq!((cdp[0]["local_interface"].as_str(), cdp[0]["neighbor_name"].as_str(), cdp[0]["mgmt_address"].as_str()), (Some("Gi1/0/1"), Some("SW2.lab.example.net"), Some("192.0.2.2")));
    let routes = &by("snmp_routes").rows;
    assert_eq!(routes.len(), 2, "{routes:?}");
    assert!(routes.iter().any(|r| r["network"] == "0.0.0.0" && r["next_hop"] == "192.0.2.254" && r["protocol"] == "static"));
    assert!(routes.iter().any(|r| r["network"] == "192.0.2.0" && r["protocol"] == "connected" && r["interface"] == "Vlan10"));
    let addrs = &by("snmp_addresses").rows;
    assert_eq!(addrs[0]["netmask"], "255.255.255.0");
    let macs = &by("snmp_bridge").rows;
    assert!(macs.iter().any(|m| m["mac_address"] == "000000000055" && m["interface"] == "Gi1/0/1"), "{macs:?}");
    let arp = &by("snmp_arp").rows;
    assert!(arp.iter().any(|a| a["ip_address"] == "192.0.2.77"), "{arp:?}");
    // The wrong community is an error, not an empty device.
    let wrong = SnmpAuth::V2c { community: "wrong-community-fixture".into() };
    assert!(read_for_collection("127.0.0.1", port, &wrong, Duration::from_millis(400)).await.is_err());
}
