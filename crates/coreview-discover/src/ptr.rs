//! Names from reverse DNS for what a crawl found (LT-206).
//!
//! A crawl names the devices it logs into from their prompts, and the ones
//! that speak CDP or LLDP from what they advertise. Everything else — the
//! printers and workstations learned on switch ports — arrives as a MAC and an
//! address from ARP. Where the estate's DNS has a PTR record for that address,
//! that is a name an engineer recognises, and the sweep already asks for it
//! (LT-109). This asks the same question of the crawl's results.
//!
//! A name a device gave about itself is never replaced: DNS fills gaps only.
//! Lookups run a few at a time under a timeout, because a crawl of a large
//! flat network can have hundreds of addresses and a slow resolver must not
//! hold the result up.

use std::future::Future;
use std::net::IpAddr;

use crate::crawl::CrawlResult;

/// How many lookups at once.
const PARALLEL: usize = 16;

/// Fills in names from `lookup` — reverse DNS in the app, anything in a test —
/// for attached devices with an address and no name, and records each reached
/// device's own PTR name. Returns how many names were found.
pub async fn enrich_names<F, Fut>(result: &mut CrawlResult, lookup: F) -> usize
where
    F: Fn(IpAddr) -> Fut,
    Fut: Future<Output = Option<String>> + Send + 'static,
{
    // Every distinct address worth asking about.
    let mut wanted: Vec<IpAddr> = Vec::new();
    let mut want = |text: &str| {
        if let Ok(ip) = text.parse::<IpAddr>() {
            if !wanted.contains(&ip) {
                wanted.push(ip);
            }
        }
    };
    for d in &result.devices {
        want(&d.address);
        for a in d.attached.iter().filter(|a| a.hostname.is_none()) {
            if let Some(addr) = &a.address {
                want(addr);
            }
        }
    }

    let mut names: std::collections::HashMap<IpAddr, String> = std::collections::HashMap::new();
    for chunk in wanted.chunks(PARALLEL) {
        // Started together, so a chunk takes as long as its slowest lookup.
        let answers = futures_join(chunk.iter().map(|ip| lookup(*ip))).await;
        for (ip, name) in chunk.iter().zip(answers) {
            if let Some(n) = name {
                names.insert(*ip, n);
            }
        }
    }

    let mut found = 0;
    for d in &mut result.devices {
        if let Some(n) = d.address.parse::<IpAddr>().ok().and_then(|ip| names.get(&ip)) {
            d.dns_name = Some(n.clone());
            found += 1;
        }
        for a in d.attached.iter_mut().filter(|a| a.hostname.is_none()) {
            if let Some(n) = a.address.as_deref().and_then(|t| t.parse::<IpAddr>().ok()).and_then(|ip| names.get(&ip)) {
                a.hostname = Some(n.clone());
                found += 1;
            }
        }
    }
    found
}

/// Runs a batch of lookups at the same time and returns their answers in order.
async fn futures_join<Fut>(futures: impl Iterator<Item = Fut>) -> Vec<Option<String>>
where
    Fut: Future<Output = Option<String>> + Send + 'static,
{
    let mut set = tokio::task::JoinSet::new();
    let mut count = 0;
    for (i, f) in futures.enumerate() {
        set.spawn(async move { (i, f.await) });
        count += 1;
    }
    let mut out = vec![None; count];
    while let Some(joined) = set.join_next().await {
        if let Ok((i, name)) = joined {
            out[i] = name;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crawl::{AttachedDevice, CrawledDevice, DeviceDetails, ReachedBy};
    use crate::types::DeviceClass;

    fn attached(mac: &str, address: Option<&str>, hostname: Option<&str>) -> AttachedDevice {
        AttachedDevice {
            mac: mac.into(),
            port: "Gi0/1".into(),
            address: address.map(str::to_string),
            vendor: None,
            hostname: hostname.map(str::to_string),
            class: None,
            port_population: 1,
            vlan: None,
        }
    }

    fn device(address: &str, attached: Vec<AttachedDevice>) -> CrawledDevice {
        CrawledDevice {
            hostname: "SW1".into(),
            address: address.into(),
            addresses: vec![],
            probe_target: address.into(),
            class: DeviceClass::Switch,
            platform: None,
            serial: None,
            version: None,
            neighbors: vec![],
            hops: 0,
            reached_by: ReachedBy::Ssh,
            attached,
            port_channels: vec![],
            default_next_hop: None,
            stack: None,
            dns_name: None,
            details: DeviceDetails::default(),
        }
    }

    #[tokio::test]
    async fn fills_names_only_where_there_are_none() {
        let mut result = CrawlResult {
            devices: vec![device(
                "192.0.2.10",
                vec![
                    attached("aa", Some("192.0.2.50"), None),
                    attached("bb", Some("192.0.2.51"), Some("PRINTER-3F")),
                    attached("cc", None, None),
                    attached("dd", Some("192.0.2.52"), None),
                ],
            )],
            ..Default::default()
        };
        let found = enrich_names(&mut result, |ip| async move {
            match ip.to_string().as_str() {
                "192.0.2.10" => Some("sw1.example.test".to_string()),
                "192.0.2.50" => Some("desk-12.example.test".to_string()),
                "192.0.2.51" => Some("should-not-win.example.test".to_string()),
                _ => None,
            }
        })
        .await;
        let d = &result.devices[0];
        assert_eq!(found, 2);
        assert_eq!(d.dns_name.as_deref(), Some("sw1.example.test"));
        assert_eq!(d.attached[0].hostname.as_deref(), Some("desk-12.example.test"));
        assert_eq!(d.attached[1].hostname.as_deref(), Some("PRINTER-3F"), "a name the device gave is kept");
        assert_eq!(d.attached[2].hostname, None);
        assert_eq!(d.attached[3].hostname, None, "no PTR record, no name");
    }

    #[tokio::test]
    async fn looks_up_a_chunk_at_the_same_time() {
        let devices: Vec<CrawledDevice> = (1..=10).map(|i| device(&format!("192.0.2.{i}"), vec![])).collect();
        let mut result = CrawlResult { devices, ..Default::default() };
        let started = std::time::Instant::now();
        enrich_names(&mut result, |_| async {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            None
        })
        .await;
        assert!(started.elapsed() < std::time::Duration::from_millis(1_000), "{:?}", started.elapsed());
    }

    #[tokio::test]
    async fn asks_once_per_address() {
        let asked = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut result = CrawlResult {
            devices: vec![
                device("192.0.2.10", vec![attached("aa", Some("192.0.2.50"), None)]),
                device("192.0.2.11", vec![attached("aa", Some("192.0.2.50"), None)]),
            ],
            ..Default::default()
        };
        let log = std::sync::Arc::clone(&asked);
        enrich_names(&mut result, move |ip| {
            let log = std::sync::Arc::clone(&log);
            async move {
                log.lock().unwrap().push(ip);
                None
            }
        })
        .await;
        assert_eq!(asked.lock().unwrap().len(), 3);
    }
}
