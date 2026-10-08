//! Linux hosts and hypervisors: the JSON iproute2 and lldpd give,
//! nested in ways the table normaliser does not flatten. **Built from the
//! tools' documentation, not a capture**:
//! [`verified_against_hardware`] is `false` until the operator's support
//! capture replaces the fixtures in the tests.

use serde_json::{json, Map, Value};

pub fn verified_against_hardware() -> bool {
    false
}

fn s(v: &Value, k: &str) -> Option<String> {
    match v.get(k)? {
        Value::String(x) => Some(x.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// `ip -j addr`: one row per interface (its MAC, state, MTU) and one per
/// address on it — loopback addresses (`scope host`) left out.
pub fn ip_addr(raw: &str) -> Vec<Value> {
    let Ok(Value::Array(ifaces)) = serde_json::from_str::<Value>(raw.trim()) else { return Vec::new() };
    let mut out = Vec::new();
    for i in &ifaces {
        let Some(name) = s(i, "ifname") else { continue };
        if s(i, "link_type").as_deref() == Some("loopback") {
            continue;
        }
        let mut base = Map::new();
        base.insert("interface".into(), json!(name));
        for (k, to) in [("address", "mac_address"), ("operstate", "oper_status"), ("mtu", "mtu"), ("master", "lag")] {
            if let Some(v) = s(i, k) {
                base.insert(to.into(), json!(v));
            }
        }
        out.push(Value::Object(base));
        for a in i.get("addr_info").and_then(Value::as_array).into_iter().flatten() {
            if s(a, "scope").as_deref() == Some("host") {
                continue;
            }
            if let (Some(local), Some(len)) = (s(a, "local"), s(a, "prefixlen")) {
                out.push(json!({"interface": name, "ip_address": local, "prefix_length": len}));
            }
        }
    }
    out
}

/// `lldpcli show neighbors -f json`. lldpd writes `interface` as an object
/// keyed by name when there is one, a list of such objects when there are
/// more, and a chassis under its system name when it has one.
pub fn lldp(raw: &str) -> Vec<Value> {
    let Ok(doc) = serde_json::from_str::<Value>(raw.trim()) else { return Vec::new() };
    let Some(ifaces) = doc.pointer("/lldp/interface") else { return Vec::new() };
    let entries: Vec<(&String, &Value)> = match ifaces {
        Value::Object(m) => m.iter().collect(),
        Value::Array(list) => list.iter().filter_map(Value::as_object).flat_map(|m| m.iter()).collect(),
        _ => Vec::new(),
    };
    let first_str = |v: Option<&Value>| -> Option<String> {
        match v? {
            Value::String(x) => Some(x.clone()),
            Value::Array(a) => a.iter().find_map(|x| x.as_str().map(str::to_string)),
            _ => None,
        }
    };
    let mut out = Vec::new();
    for (local, n) in entries {
        let (name, chassis) = match n.get("chassis") {
            Some(Value::Object(c)) if c.contains_key("id") => (None, Value::Object(c.clone())),
            Some(Value::Object(c)) => match c.iter().next() {
                Some((k, v)) => (Some(k.clone()), v.clone()),
                None => (None, Value::Null),
            },
            _ => (None, Value::Null),
        };
        let port = n.get("port").cloned().unwrap_or(Value::Null);
        out.push(json!({
            "local_interface": local,
            "neighbor_name": name,
            "chassis_id": chassis.pointer("/id/value").and_then(Value::as_str),
            "mgmt_address": first_str(chassis.get("mgmt-ip")),
            "platform": chassis.get("descr").and_then(Value::as_str),
            "neighbor_interface": port.pointer("/id/value").and_then(Value::as_str),
            "port_description": port.get("descr").and_then(Value::as_str),
            "proto": "lldp",
        }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shapes from iproute2's and lldpd's documentation, not captured.
    #[test]
    fn ip_addr_gives_interfaces_and_their_addresses_not_loopback() {
        let raw = r#"[
          {"ifindex":1,"ifname":"lo","link_type":"loopback","address":"00:00:00:00:00:00","addr_info":[{"family":"inet","local":"127.0.0.1","prefixlen":8,"scope":"host"}]},
          {"ifindex":2,"ifname":"vmbr0","operstate":"UP","mtu":1500,"link_type":"ether","address":"00:00:00:00:00:10","addr_info":[
            {"family":"inet","local":"192.0.2.40","prefixlen":24,"scope":"global"},
            {"family":"inet6","local":"fe80::10","prefixlen":64,"scope":"link"}]},
          {"ifindex":3,"ifname":"eno1","master":"vmbr0","operstate":"UP","link_type":"ether","address":"00:00:00:00:00:11","addr_info":[]}
        ]"#;
        let rows = ip_addr(raw);
        assert_eq!(rows[0], json!({"interface": "vmbr0", "mac_address": "00:00:00:00:00:10", "oper_status": "UP", "mtu": "1500"}));
        assert_eq!(rows[1], json!({"interface": "vmbr0", "ip_address": "192.0.2.40", "prefix_length": "24"}));
        assert_eq!(rows[2]["ip_address"], "fe80::10");
        assert_eq!(rows[3], json!({"interface": "eno1", "mac_address": "00:00:00:00:00:11", "oper_status": "UP", "lag": "vmbr0"}));
        assert_eq!(rows.len(), 4, "loopback left out");
    }

    #[test]
    fn lldp_one_neighbour_or_several_named_or_not() {
        let one = r#"{"lldp":{"interface":{"eno1":{"via":"LLDP","chassis":{"SW1":{"id":{"type":"mac","value":"00:00:00:00:00:20"},"descr":"Cisco IOS Software","mgmt-ip":"192.0.2.1"}},"port":{"id":{"type":"ifname","value":"Gi1/0/5"},"descr":"GigabitEthernet1/0/5"}}}}}"#;
        let rows = lldp(one);
        assert_eq!(rows[0], json!({"local_interface": "eno1", "neighbor_name": "SW1", "chassis_id": "00:00:00:00:00:20", "mgmt_address": "192.0.2.1", "platform": "Cisco IOS Software", "neighbor_interface": "Gi1/0/5", "port_description": "GigabitEthernet1/0/5", "proto": "lldp"}));
        let two = r#"{"lldp":{"interface":[{"eno1":{"chassis":{"SW1":{"id":{"type":"mac","value":"00:00:00:00:00:20"},"mgmt-ip":["192.0.2.1","2001:db8::1"]}},"port":{"id":{"type":"ifname","value":"Gi1/0/5"}}}},{"eno2":{"chassis":{"id":{"type":"mac","value":"00:00:00:00:00:21"}},"port":{"id":{"type":"mac","value":"00:00:00:00:00:22"}}}}]}}"#;
        let rows = lldp(two);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["mgmt_address"], "192.0.2.1");
        assert_eq!((rows[1]["local_interface"].as_str(), rows[1]["neighbor_name"].as_str(), rows[1]["chassis_id"].as_str()), (Some("eno2"), None, Some("00:00:00:00:00:21")));
    }
}
