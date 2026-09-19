//! Ping sweep: find what answers inside a subnet.
//!
//! This is discovery, not monitoring. A sweep runs once, walks every host
//! address in a CIDR range concurrently, and reports what replied. The
//! validation engine in `engine.rs` is the opposite shape — a small fixed set
//! of targets checked forever on an interval — so the two share the transport
//! (`icmp::ping_once`) and nothing else.
//!
//! Every ping still goes through `validate::parse_target`, so a sweep cannot
//! reach a process argument the validator would have rejected. Addresses here
//! are generated from a parsed CIDR rather than typed by a person, so that is
//! belt and braces, but the sweep must not be the one place that bypasses it.

use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, Semaphore};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::icmp::ping_once;
use crate::validate::{parse_target, ValidationError};

/// The name behind an address, the way `ping -a` shows one (LT-109).
///
/// `ping -a` is a Windows spelling: on Linux and macOS `-a` is *audible* ping,
/// and even on Windows the name would have to be scraped out of `Pinging
/// <name> [addr]`, a localized string. What the flag actually does is a
/// reverse (PTR) lookup, so this asks the resolver directly and gets the same
/// answer on all three platforms, structured rather than parsed.
///
/// Two things this has to get right:
///
/// **An address with no PTR record is not a name.** `dns_lookup::lookup_addr`
/// passes `NI_NAMEREQD`, so `getnameinfo` errors rather than falling back to
/// the numeric form, and that case already arrives here as `None`. The guard
/// in `usable_name` is belt-and-braces against that flag changing — without
/// it, an unresolvable host would come back claiming to be called
/// "10.10.10.24", which would put the IP in the hostname column and label
/// every device with the number the sweep was meant to replace.
///
/// **A slow resolver must not hold up the sweep.** The lookup is blocking, so
/// it runs on the blocking pool under the sweep's own timeout. If it does not
/// answer in time the host is still reported, just without a name: a sweep
/// that stalls on reverse DNS is worse than one that shows an address.
pub async fn reverse_name(ip: IpAddr, timeout_ms: u64) -> Option<String> {
    let looked_up = timeout(
        Duration::from_millis(timeout_ms),
        tokio::task::spawn_blocking(move || dns_lookup::lookup_addr(&ip).ok()),
    )
    .await;

    match looked_up {
        Ok(Ok(Some(name))) => usable_name(&name, ip),
        // Timed out, the blocking task panicked, or the resolver said no.
        _ => None,
    }
}

/// Whether what the resolver handed back is a name or just the address again.
///
/// Split out from the lookup so the decision can be tested without a resolver:
/// what a given machine's DNS answers is not something a test should depend
/// on, but this rule is.
fn usable_name(raw: &str, ip: IpAddr) -> Option<String> {
    let name = raw.trim().trim_end_matches('.').trim();
    if name.is_empty() || name.eq_ignore_ascii_case(&ip.to_string()) {
        return None;
    }
    Some(name.to_string())
}

/// What a host that answered can be asked about itself (LT-121).
///
/// A sweep used to report an address and a round trip, which is the answer to
/// "is it there" and to nothing else. The operator's point was that the other
/// scanners answer "what is it" as well, so this gathers the four things that
/// can be had without credentials: a name, a hardware address, the
/// manufacturer behind it, and which of the common ports are open.
///
/// **Everything runs at once.** The three name lookups and the port scan are
/// independent I/O against the same host, so they are joined rather than
/// sequenced: identification costs about one timeout per host, not four.
///
/// **A name is preferred by source, not by who answered first.** DNS beats
/// LLMNR beats NetBIOS beats mDNS — see `NameSource`. The QNAP on the
/// operator's network answers both NetBIOS (`NAS000001`) and mDNS
/// (`NAS000001.local`), and the scanner he compared against shows the NetBIOS
/// spelling; his Windows host answers both LLMNR (`LabDesktop01`) and NetBIOS
/// (`LABDESKTOP01`), and LLMNR is the one that kept the capitals.
async fn identify(
    ip: Ipv4Addr,
    options: &SweepOptions,
    neighbours: Arc<crate::neighbour::NeighbourCache>,
    port_permits: Arc<Semaphore>,
) -> Identity {
    let names = async {
        let dns = reverse_name(IpAddr::V4(ip), options.timeout_ms);
        let llmnr = crate::names::llmnr_name(ip, options.timeout_ms);
        let netbios = crate::names::netbios_name(ip, options.timeout_ms);
        let mdns = crate::names::mdns_name(ip, options.timeout_ms);
        tokio::join!(dns, llmnr, netbios, mdns)
    };
    let ports = async {
        if !options.scan_ports {
            return Vec::new();
        }
        // Tighter than the ping timeout: on a LAN a listening port answers in
        // milliseconds, and the only thing a long wait buys is a longer wait
        // on the firewalled ones, which are the majority.
        let budget = options.timeout_ms.min(PORT_TIMEOUT_MS);
        crate::ports::scan(ip, crate::ports::COMMON_PORTS, budget, port_permits).await
    };

    // Reading the neighbour table is a file read on Linux and a process
    // elsewhere, so it goes to the blocking pool rather than stalling the
    // runtime thread that every other host on this worker is sharing.
    let mac = async {
        tokio::task::spawn_blocking(move || neighbours.mac_for(&ip)).await.ok().flatten()
    };

    let ((dns, llmnr, netbios, mdns), ports, mac) = tokio::join!(names, ports, mac);

    let (mut hostname, mut name_source) = match (dns, llmnr, netbios, mdns) {
        (Some(n), _, _, _) => (Some(n), Some(NameSource::Dns)),
        (None, Some(n), _, _) => (Some(n), Some(NameSource::Llmnr)),
        (None, None, Some(nb), _) if nb.name.is_some() => (nb.name, Some(NameSource::NetBios)),
        (None, None, _, Some(md)) => (Some(md), Some(NameSource::Mdns)),
        _ => (None, None),
    };

    let vendor = mac.as_deref().and_then(|m| {
        if crate::neighbour::is_locally_administered(m) {
            None
        } else {
            crate::oui::vendor(m).map(str::to_string)
        }
    });

    // LT-124: the certificate on its web interface. Only for a host the port
    // scan found serving HTTPS — trying TLS blind against every address that
    // answered ping would be exactly the noise the port scan is gated to
    // avoid. After the joins rather than inside them, because which port to
    // read is not known until the scan has run.
    // The plain-HTTP banner likewise, on 80 or 8080 — not 8006, whose port
    // already says Proxmox. Both read at once, so a host with both costs one
    // wait, not two.
    let https = ports.iter().map(|p| p.port).find(|p| *p == 443 || *p == 8443);
    let http = ports.iter().map(|p| p.port).find(|p| *p == 80 || *p == 8080);
    let (cert, banner) = tokio::join!(
        async {
            match https {
                Some(port) => {
                    crate::certfetch::certificate_identity(ip, port, options.timeout_ms.min(CERT_TIMEOUT_MS))
                        .await
                }
                None => None,
            }
        },
        async {
            match http {
                Some(port) => crate::banner::fetch_banner(ip, port, options.timeout_ms.min(BANNER_TIMEOUT_MS)).await,
                None => None,
            }
        }
    );
    if hostname.is_none() {
        if let Some(name) = cert.as_ref().and_then(|c| c.host_name()) {
            hostname = Some(name.to_string());
            name_source = Some(NameSource::Certificate);
        }
    }
    let serial = cert.as_ref().and_then(|c| c.device_serial()).map(str::to_string);
    let product = cert.as_ref().and_then(|c| {
        let organisation = c.organisation.as_deref().filter(|o| !PLACEHOLDER_ORGANISATIONS.contains(o));
        let parts: Vec<&str> = [organisation, c.unit.as_deref()].into_iter().flatten().collect();
        (!parts.is_empty()).then(|| parts.join(" "))
    });

    // A banner is the web server's software and never a name — see `banner`.
    let (web_server, web_title) = banner.map(|b| (b.server, b.title)).unwrap_or_default();

    Identity { hostname, name_source, mac, vendor, ports, serial, product, web_server, web_title }
}

/// What `identify` gathered.
#[derive(Debug, Default, Clone)]
struct Identity {
    hostname: Option<String>,
    name_source: Option<NameSource>,
    mac: Option<String>,
    vendor: Option<String>,
    ports: Vec<crate::ports::OpenPort>,
    serial: Option<String>,
    product: Option<String>,
    web_server: Option<String>,
    web_title: Option<String>,
}

/// Ceiling on how long one port is waited for. See `identify`.
const PORT_TIMEOUT_MS: u64 = 600;

/// Ceiling on reading one host's certificate (LT-124). Up to two connections —
/// a modern handshake, then the legacy read — so this bounds each, and it is
/// only spent on a host already known to have HTTPS open.
const CERT_TIMEOUT_MS: u64 = 1500;

/// Ceiling on reading one host's plain-HTTP banner (LT-124). One connection,
/// one request, a bounded read.
const BANNER_TIMEOUT_MS: u64 = 1500;

/// Organisation names that OpenSSL and friends fill in by default. A
/// certificate carrying one says nothing about the product.
const PLACEHOLDER_ORGANISATIONS: &[&str] = &["Internet Widgits Pty Ltd", "Default Company Ltd"];

/// How many port sockets the whole sweep may have open at once.
///
/// Eighteen ports times sixty-four hosts is over a thousand descriptors, past
/// the default soft limit on most Linux machines — and the failure that
/// causes is not a failed scan, it is unrelated parts of the app failing to
/// open files. See `ports`.
const PORT_SOCKETS: usize = 256;

/// Largest sweep we will start, in host addresses.
///
/// A /16 is 65,534 hosts. At 64 in flight and a 1 second timeout that is a few
/// minutes, which is a long wait but a legitimate thing to ask for. Anything
/// larger is almost certainly a typo — a /8 is sixteen million pings — and
/// refusing is kinder than appearing to hang.
pub const MAX_SWEEP_HOSTS: u32 = 65_534;

/// Concurrency bounds. Too few and a /24 takes minutes; too many and a laptop
/// runs out of file descriptors, or a firewall reads the burst as a scan.
pub const MIN_CONCURRENCY: usize = 1;
pub const MAX_CONCURRENCY: usize = 256;
pub const DEFAULT_CONCURRENCY: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CidrError {
    #[error("subnet is empty")]
    Empty,
    #[error("subnet must be written as address/prefix, for example 192.168.1.0/24")]
    NoPrefix,
    #[error("{0} is not an IPv4 address")]
    BadAddress(String),
    #[error("prefix length must be between 0 and 32")]
    BadPrefix,
    #[error("only IPv4 subnets can be swept")]
    NotIpv4,
    #[error("that subnet holds {0} addresses; the most that can be swept at once is {1}")]
    TooLarge(u32, u32),
}

/// An IPv4 subnet, stored as its network address and prefix length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    network: u32,
    prefix: u8,
}

impl Cidr {
    pub fn prefix(&self) -> u8 {
        self.prefix
    }

    pub fn network(&self) -> Ipv4Addr {
        Ipv4Addr::from(self.network)
    }

    pub fn broadcast(&self) -> Ipv4Addr {
        Ipv4Addr::from(self.network | !mask(self.prefix))
    }

    /// True if the address falls inside this subnet. This is what "filtered by
    /// subnet" means everywhere else in the app.
    pub fn contains(&self, ip: Ipv4Addr) -> bool {
        u32::from(ip) & mask(self.prefix) == self.network
    }

    /// The addresses a sweep should actually try.
    ///
    /// For a /31 and /32 that is every address in the range: RFC 3021 gives
    /// /31 two usable hosts for point-to-point links, and a /32 is a single
    /// host route. For everything wider, the network and broadcast addresses
    /// are skipped — pinging the broadcast address either does nothing or
    /// provokes replies from every host at once, neither of which is a
    /// discovery result.
    pub fn hosts(&self) -> impl Iterator<Item = Ipv4Addr> {
        let (first, last) = self.host_range();
        (first..=last).map(Ipv4Addr::from)
    }

    pub fn host_count(&self) -> u32 {
        let (first, last) = self.host_range();
        last - first + 1
    }

    fn host_range(&self) -> (u32, u32) {
        let broadcast = self.network | !mask(self.prefix);
        if self.prefix >= 31 {
            (self.network, broadcast)
        } else {
            (self.network + 1, broadcast - 1)
        }
    }
}

fn mask(prefix: u8) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    }
}

/// Parses `a.b.c.d/n`, normalising the address down to the network address so
/// `192.168.1.57/24` and `192.168.1.0/24` describe the same subnet. Typing a
/// host address with a prefix is the common case, not an error.
pub fn parse_cidr(input: &str) -> Result<Cidr, CidrError> {
    let text = input.trim();
    if text.is_empty() {
        return Err(CidrError::Empty);
    }
    let (addr, prefix) = text.split_once('/').ok_or(CidrError::NoPrefix)?;

    let addr: Ipv4Addr = addr
        .trim()
        .parse()
        .map_err(|_| CidrError::BadAddress(addr.trim().to_string()))?;
    let prefix: u8 = prefix
        .trim()
        .parse()
        .map_err(|_| CidrError::BadPrefix)
        .and_then(|p: u8| if p <= 32 { Ok(p) } else { Err(CidrError::BadPrefix) })?;

    Ok(Cidr {
        network: u32::from(addr) & mask(prefix),
        prefix,
    })
}

/// Parses a subnet and refuses one too large to sweep.
pub fn parse_sweepable_cidr(input: &str) -> Result<Cidr, CidrError> {
    let cidr = parse_cidr(input)?;
    let count = cidr.host_count();
    if count > MAX_SWEEP_HOSTS {
        return Err(CidrError::TooLarge(count, MAX_SWEEP_HOSTS));
    }
    Ok(cidr)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SweepOptions {
    /// Milliseconds to wait for a single reply.
    pub timeout_ms: u64,
    /// How many pings may be in flight at once.
    pub concurrency: usize,
    /// Whether to ask each host that answers what it is — its name over
    /// NetBIOS and mDNS as well as DNS, and its MAC and manufacturer from
    /// this machine's neighbour table (LT-121).
    #[serde(default = "yes")]
    pub identify: bool,
    /// Whether to try the common TCP ports on each host that answers. Off
    /// makes a sweep quieter; a scan is the noisiest thing here and some
    /// networks watch for it.
    #[serde(default = "yes")]
    pub scan_ports: bool,
}

/// Serde needs a function to default a bool to true; both of these are on
/// unless the caller says otherwise, so an old saved payload that predates
/// them behaves like the interface's own defaults.
fn yes() -> bool {
    true
}

impl Default for SweepOptions {
    fn default() -> Self {
        Self {
            timeout_ms: 1_000,
            concurrency: DEFAULT_CONCURRENCY,
            identify: true,
            scan_ports: true,
        }
    }
}

impl SweepOptions {
    /// Clamps rather than rejects. These come from a slider, and a value out of
    /// range should behave sensibly instead of failing a long-running sweep.
    pub fn clamped(self) -> Self {
        Self {
            timeout_ms: self.timeout_ms.clamp(100, 60_000),
            concurrency: self.concurrency.clamp(MIN_CONCURRENCY, MAX_CONCURRENCY),
            identify: self.identify,
            scan_ports: self.scan_ports,
        }
    }
}

/// One address that answered.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepHit {
    pub ip: String,
    pub rtt_ms: Option<f64>,
    /// What this host is called: a PTR record where there is one (LT-109),
    /// else what the host itself answers over NetBIOS or mDNS (LT-121).
    /// `None` when nothing knows, not the address repeated back.
    #[serde(default)]
    pub hostname: Option<String>,
    /// Which of those answered, so the interface can say where a name came
    /// from rather than presenting a `.local` and a PTR as the same thing.
    #[serde(default)]
    pub name_source: Option<NameSource>,
    /// The hardware address, for a host on this segment. Always `None` for
    /// anything behind a router — see `neighbour`.
    #[serde(default)]
    pub mac: Option<String>,
    /// Who registered that MAC's prefix with the IEEE.
    #[serde(default)]
    pub vendor: Option<String>,
    /// The common ports that completed a handshake. Empty when none did and
    /// when the scan was turned off — the two are not distinguished here
    /// because the interface knows which it asked for.
    #[serde(default)]
    pub ports: Vec<crate::ports::OpenPort>,
    /// The device serial its certificate carries, where one does (LT-124):
    /// a Cisco puts it in the subject, a Fortinet uses it as the name.
    #[serde(default)]
    pub serial: Option<String>,
    /// The product its certificate names, organisation then unit —
    /// `Fortinet FortiSwitch` (LT-124). `None` where the certificate says
    /// nothing of the kind, which a self-signed one usually does not.
    #[serde(default)]
    pub product: Option<String>,
    /// The `Server` header its plain-HTTP page sent (LT-124) — the web
    /// server's software, such as `cisco-IOS`. Never used as a name.
    #[serde(default)]
    pub web_server: Option<String>,
    /// That page's `<title>`, when it is not a web server's default page.
    #[serde(default)]
    pub web_title: Option<String>,
}

/// Where a name came from. Ordered best-first, which is also the order they
/// are preferred in: a PTR record is the network's own answer, a NetBIOS name
/// is the machine's, and an mDNS name is the machine's with `.local` on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NameSource {
    /// A reverse DNS (PTR) record.
    Dns,
    /// The host answered LLMNR on the multicast group. Windows gives its real
    /// hostname here, with its real capitalisation and no 15-character limit,
    /// so this is preferred over the NetBIOS spelling of the same machine.
    Llmnr,
    /// The host's NetBIOS node status reply.
    NetBios,
    /// The host's mDNS reply, so a `.local` name.
    Mdns,
    /// The name on the certificate its web interface presents (LT-124) —
    /// often the only name a switch or firewall gives without credentials.
    /// Last, because a certificate is issued once and can outlive a rename.
    Certificate,
}

/// Progress and results, streamed as the sweep runs.
///
/// A /24 takes a while and a user watching a blank screen assumes it has hung,
/// so hosts are reported the moment they answer rather than collected into a
/// final list.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
// `Alive` carries a whole `SweepHit` and outgrew the other variants when
// LT-124 added the certificate and banner fields. Allowed rather than boxed:
// events go one at a time through a channel and are never stored in bulk, so
// the size costs nothing, while boxing would change every constructor and
// consumer of the event for no gain.
#[allow(clippy::large_enum_variant)]
pub enum SweepEvent {
    Started { total: u32 },
    Alive(SweepHit),
    /// Emitted after every address, answered or not, so a progress bar can move.
    Progress { done: u32, total: u32 },
    Finished { alive: u32, scanned: u32, cancelled: bool },
}

/// Sweeps several subnets as one run.
///
/// A single combined total and one progress sequence, rather than a run per
/// subnet: a progress bar that restarts three times reads as three failures,
/// and "142 of 762" is the number someone actually wants while waiting.
///
/// Subnets are scanned in the order given, so results arrive in an order that
/// matches what was typed.
pub async fn sweep_many(
    cidrs: Vec<Cidr>,
    options: SweepOptions,
    events: mpsc::Sender<SweepEvent>,
    cancel: CancellationToken,
) -> Vec<SweepHit> {
    let options = options.clamped();
    let total: u32 = cidrs.iter().map(|c| c.host_count()).sum();
    let _ = events.send(SweepEvent::Started { total }).await;

    let mut alive = Vec::new();
    let mut done = 0u32;
    for cidr in cidrs {
        if cancel.is_cancelled() {
            break;
        }
        let (found, scanned) =
            scan_one(cidr, &options, &events, &cancel, done, total).await;
        alive.extend(found);
        done += scanned;
    }

    let _ = events
        .send(SweepEvent::Finished {
            alive: alive.len() as u32,
            scanned: done,
            cancelled: cancel.is_cancelled(),
        })
        .await;
    alive
}

/// Sweeps a subnet, sending events as they happen.
///
/// Returns the addresses that answered, in the order they answered. Cancelling
/// the token stops new pings starting and lets in-flight ones fall away; the
/// `Finished` event still arrives, with `cancelled` set, so the UI always gets
/// a terminal event to react to.
pub async fn sweep(
    cidr: Cidr,
    options: SweepOptions,
    events: mpsc::Sender<SweepEvent>,
    cancel: CancellationToken,
) -> Vec<SweepHit> {
    let options = options.clamped();
    let total = cidr.host_count();
    let _ = events.send(SweepEvent::Started { total }).await;

    let (alive, scanned) = scan_one(cidr, &options, &events, &cancel, 0, total).await;

    let _ = events
        .send(SweepEvent::Finished {
            alive: alive.len() as u32,
            scanned,
            cancelled: cancel.is_cancelled(),
        })
        .await;
    alive
}

/// One subnet's worth of scanning, without the Started and Finished events.
///
/// Split out so a multi-subnet run reports one continuous sequence:
/// `already_done` is how many addresses earlier subnets contributed, and
/// `total` is the whole run rather than this subnet.
///
/// Returns what answered and how many addresses were tried.
async fn scan_one(
    cidr: Cidr,
    options: &SweepOptions,
    events: &mpsc::Sender<SweepEvent>,
    cancel: &CancellationToken,
    already_done: u32,
    total: u32,
) -> (Vec<SweepHit>, u32) {
    let permits = Arc::new(Semaphore::new(options.concurrency));
    let port_permits = Arc::new(Semaphore::new(PORT_SOCKETS));
    // One neighbour table for the whole subnet: a /24 would otherwise read it
    // 254 times, which on Windows is 254 processes.
    let neighbours = Arc::new(crate::neighbour::NeighbourCache::new());
    let mut tasks = tokio::task::JoinSet::new();

    for ip in cidr.hosts() {
        if cancel.is_cancelled() {
            break;
        }
        let Ok(permit) = Arc::clone(&permits).acquire_owned().await else {
            break;
        };
        let cancel = cancel.clone();
        let timeout_ms = options.timeout_ms;
        let options = options.clone();
        let neighbours = Arc::clone(&neighbours);
        let port_permits = Arc::clone(&port_permits);
        tasks.spawn(async move {
            let _permit = permit;
            if cancel.is_cancelled() {
                return (ip, None, Identity::default());
            }
            // Generated from a parsed CIDR, but routed through the validator
            // anyway so this is not the one path into `ping` that skips it.
            let Ok(target) = parse_target(&ip.to_string()) else {
                return (ip, None, Identity::default());
            };
            let hit = tokio::select! {
                _ = cancel.cancelled() => None,
                res = ping_once(&target, timeout_ms) => match res {
                    Ok(p) if p.outcome.is_success() => Some(p.rtt_ms),
                    _ => None,
                },
            };
            // Only for addresses that answered — a /24 is 254 of every lookup
            // if you do it for everything, almost all of them for hosts that
            // are not there. Inside the task, so it runs under the same
            // concurrency permit as the ping rather than as a second pass.
            let identity = match hit {
                Some(_) if options.identify => {
                    tokio::select! {
                        _ = cancel.cancelled() => Identity::default(),
                        i = identify(ip, &options, neighbours, port_permits) => i,
                    }
                }
                // Identification off still means the name LT-109 promised.
                Some(_) => {
                    let hostname = tokio::select! {
                        _ = cancel.cancelled() => None,
                        n = reverse_name(IpAddr::V4(ip), timeout_ms) => n,
                    };
                    let name_source = hostname.as_ref().map(|_| NameSource::Dns);
                    Identity { hostname, name_source, ..Identity::default() }
                }
                None => Identity::default(),
            };
            (ip, hit, identity)
        });
    }

    let mut alive = Vec::new();
    let mut done = 0u32;
    while let Some(joined) = tasks.join_next().await {
        done += 1;
        if let Ok((ip, Some(rtt_ms), identity)) = joined {
            let hit = SweepHit {
                ip: ip.to_string(),
                rtt_ms,
                hostname: identity.hostname,
                name_source: identity.name_source,
                mac: identity.mac,
                vendor: identity.vendor,
                ports: identity.ports,
                serial: identity.serial,
                product: identity.product,
                web_server: identity.web_server,
                web_title: identity.web_title,
            };
            alive.push(hit.clone());
            let _ = events.send(SweepEvent::Alive(hit)).await;
        }
        let _ = events
            .send(SweepEvent::Progress {
                done: already_done + done,
                total,
            })
            .await;
    }

    (alive, done)
}

/// Convenience for the "filtered by subnet" rule applied to a list of
/// addresses that came from somewhere else — CDP neighbours, an SNMP table, a
/// diagram. Anything unparseable is excluded rather than assumed to be inside.
pub fn within_any(ip: &str, subnets: &[Cidr]) -> bool {
    match ip.trim().parse::<Ipv4Addr>() {
        Ok(addr) => subnets.iter().any(|c| c.contains(addr)),
        Err(_) => false,
    }
}

/// Parses a list of subnets, reporting which entry failed rather than which
/// text failed, so a form can mark the offending row.
pub fn parse_subnets(inputs: &[String]) -> Result<Vec<Cidr>, (usize, CidrError)> {
    inputs
        .iter()
        .enumerate()
        .map(|(i, s)| parse_cidr(s).map_err(|e| (i, e)))
        .collect()
}

impl From<ValidationError> for CidrError {
    fn from(_: ValidationError) -> Self {
        CidrError::NotIpv4
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_plain_subnet() {
        let c = parse_cidr("192.168.1.0/24").unwrap();
        assert_eq!(c.network(), Ipv4Addr::new(192, 168, 1, 0));
        assert_eq!(c.prefix(), 24);
        assert_eq!(c.broadcast(), Ipv4Addr::new(192, 168, 1, 255));
    }

    #[test]
    fn normalises_a_host_address_to_its_network() {
        // Typing the address of a device you know, with a prefix, is the
        // common way to say "this subnet".
        let c = parse_cidr("192.168.77.57/24").unwrap();
        assert_eq!(c.network(), Ipv4Addr::new(192, 168, 77, 0));
        assert!(c.contains(Ipv4Addr::new(192, 168, 77, 1)));
        assert!(c.contains(Ipv4Addr::new(192, 168, 77, 254)));
        assert!(!c.contains(Ipv4Addr::new(192, 168, 15, 1)));
    }

    #[test]
    fn a_24_skips_network_and_broadcast() {
        let c = parse_cidr("10.0.0.0/24").unwrap();
        let hosts: Vec<_> = c.hosts().collect();
        assert_eq!(hosts.len(), 254);
        assert_eq!(hosts[0], Ipv4Addr::new(10, 0, 0, 1));
        assert_eq!(hosts[253], Ipv4Addr::new(10, 0, 0, 254));
        assert_eq!(c.host_count(), 254);
    }

    #[test]
    fn a_31_sweeps_both_addresses() {
        // RFC 3021: a /31 is two usable hosts on a point-to-point link, so
        // skipping "network" and "broadcast" would leave nothing to scan.
        let c = parse_cidr("10.0.0.4/31").unwrap();
        let hosts: Vec<_> = c.hosts().collect();
        assert_eq!(hosts, vec![Ipv4Addr::new(10, 0, 0, 4), Ipv4Addr::new(10, 0, 0, 5)]);
    }

    #[test]
    fn a_32_sweeps_exactly_one_address() {
        let c = parse_cidr("10.0.0.9/32").unwrap();
        assert_eq!(c.hosts().collect::<Vec<_>>(), vec![Ipv4Addr::new(10, 0, 0, 9)]);
        assert_eq!(c.host_count(), 1);
    }

    #[test]
    fn a_30_has_two_usable_hosts() {
        let c = parse_cidr("172.16.0.0/30").unwrap();
        assert_eq!(
            c.hosts().collect::<Vec<_>>(),
            vec![Ipv4Addr::new(172, 16, 0, 1), Ipv4Addr::new(172, 16, 0, 2)]
        );
    }

    #[test]
    fn rejects_malformed_input() {
        assert_eq!(parse_cidr(""), Err(CidrError::Empty));
        assert_eq!(parse_cidr("192.168.1.0"), Err(CidrError::NoPrefix));
        assert_eq!(parse_cidr("192.168.1.0/33"), Err(CidrError::BadPrefix));
        assert_eq!(parse_cidr("192.168.1.0/abc"), Err(CidrError::BadPrefix));
        assert!(matches!(parse_cidr("not-an-ip/24"), Err(CidrError::BadAddress(_))));
        // IPv6 has no sweep: a /64 is more addresses than exist in IPv4.
        assert!(matches!(parse_cidr("2001:db8::/64"), Err(CidrError::BadAddress(_))));
    }

    #[test]
    fn refuses_a_sweep_too_large_to_finish() {
        // A /8 is sixteen million pings. Refusing beats appearing to hang.
        let err = parse_sweepable_cidr("10.0.0.0/8").unwrap_err();
        assert!(matches!(err, CidrError::TooLarge(16_777_214, MAX_SWEEP_HOSTS)));
        // A /16 is large but a real thing to ask for.
        assert!(parse_sweepable_cidr("10.1.0.0/16").is_ok());
    }

    #[test]
    fn subnet_filter_excludes_unparseable_addresses() {
        let nets = parse_subnets(&["192.168.77.0/24".into(), "10.0.0.0/8".into()]).unwrap();
        assert!(within_any("192.168.77.1", &nets));
        assert!(within_any("10.5.6.7", &nets));
        assert!(!within_any("172.16.0.1", &nets));
        // CDP reports "N/A" when a neighbour advertises no address. It must not
        // be treated as inside the filter.
        assert!(!within_any("N/A", &nets));
        assert!(!within_any("", &nets));
    }

    #[test]
    fn parse_subnets_reports_which_entry_failed() {
        let err = parse_subnets(&["192.168.1.0/24".into(), "bad".into()]).unwrap_err();
        assert_eq!(err.0, 1);
        assert_eq!(err.1, CidrError::NoPrefix);
    }

    #[test]
    fn options_are_clamped_not_rejected() {
        let o = SweepOptions {
            timeout_ms: 5,
            concurrency: 100_000,
            identify: false,
            scan_ports: false,
        }
        .clamped();
        assert_eq!(o.timeout_ms, 100);
        assert_eq!(o.concurrency, MAX_CONCURRENCY);
        // Clamping is about the numbers; the switches pass through untouched.
        assert!(!o.identify);
        assert!(!o.scan_ports);
    }

    /// Both switches are on unless the caller says otherwise, including for a
    /// payload saved before they existed — the frontend sends this struct.
    #[test]
    fn identification_is_on_by_default_and_for_an_older_payload() {
        let d = SweepOptions::default();
        assert!(d.identify);
        assert!(d.scan_ports);

        let old: SweepOptions =
            serde_json::from_str(r#"{"timeoutMs":1000,"concurrency":64}"#).unwrap();
        assert!(old.identify, "a payload predating the switch must still identify");
        assert!(old.scan_ports);

        let off: SweepOptions = serde_json::from_str(
            r#"{"timeoutMs":1000,"concurrency":64,"identify":false,"scanPorts":false}"#,
        )
        .unwrap();
        assert!(!off.identify);
        assert!(!off.scan_ports);
    }

    #[test]
    fn the_event_wire_format_is_what_the_frontend_expects() {
        // This is a contract with TypeScript, which cannot check it. Serde's
        // tagging rules decide the shape, and a newtype variant flattening or
        // not flattening changes whether the UI sees `ip` or `{ip}`.
        let json = |e: &SweepEvent| serde_json::to_string(e).unwrap();

        assert_eq!(json(&SweepEvent::Started { total: 254 }), r#"{"kind":"started","total":254}"#);
        assert_eq!(
            json(&SweepEvent::Alive(SweepHit {
                ip: "10.0.0.1".into(),
                rtt_ms: Some(1.5),
                hostname: Some("csdc.comsol.root".into()),
                name_source: Some(NameSource::Dns),
                mac: Some("24:5e:be:00:00:9e".into()),
                vendor: Some("QNAP Systems".into()),
                ports: vec![crate::ports::OpenPort { port: 22, service: "SSH".into() }],
                serial: Some("FOC0000TEST".into()),
                product: Some("Fortinet FortiSwitch".into()),
                web_server: Some("ExampleWeb/2.1".into()),
                web_title: Some("Lab Printer Status".into()),
            })),
            concat!(
                r#"{"kind":"alive","ip":"10.0.0.1","rttMs":1.5,"#,
                r#""hostname":"csdc.comsol.root","nameSource":"dns","#,
                r#""mac":"24:5e:be:00:00:9e","vendor":"QNAP Systems","#,
                r#""ports":[{"port":22,"service":"SSH"}],"#,
                r#""serial":"FOC0000TEST","product":"Fortinet FortiSwitch","#,
                r#""webServer":"ExampleWeb/2.1","webTitle":"Lab Printer Status"}"#
            )
        );
        assert_eq!(
            json(&SweepEvent::Progress { done: 7, total: 254 }),
            r#"{"kind":"progress","done":7,"total":254}"#
        );
        assert_eq!(
            json(&SweepEvent::Finished {
                alive: 3,
                scanned: 254,
                cancelled: false
            }),
            r#"{"kind":"finished","alive":3,"scanned":254,"cancelled":false}"#
        );
        // A host that answered without a parseable time still counts as alive.
        // An address that nothing could name sends `hostname: null` rather
        // than omitting the field, so the UI never has to tell "no name" apart
        // from "older backend" (LT-109) — and the same holds for everything
        // LT-121 added beside it. `ports` is an empty array, never null, so
        // the UI can map over it without a guard.
        assert_eq!(
            json(&SweepEvent::Alive(SweepHit {
                ip: "10.0.0.2".into(),
                rtt_ms: None,
                hostname: None,
                name_source: None,
                mac: None,
                vendor: None,
                ports: Vec::new(),
                serial: None,
                product: None,
                web_server: None,
                web_title: None,
            })),
            concat!(
                r#"{"kind":"alive","ip":"10.0.0.2","rttMs":null,"hostname":null,"#,
                r#""nameSource":null,"mac":null,"vendor":null,"ports":[],"#,
                r#""serial":null,"product":null,"webServer":null,"webTitle":null}"#
            )
        );
        // The name sources go over the wire in the spelling TypeScript reads.
        for (source, wire) in [
            (NameSource::Dns, "dns"),
            (NameSource::Llmnr, "llmnr"),
            (NameSource::NetBios, "netBios"),
            (NameSource::Mdns, "mdns"),
            (NameSource::Certificate, "certificate"),
        ] {
            assert_eq!(serde_json::to_string(&source).unwrap(), format!("\"{wire}\""));
        }
    }

    #[tokio::test]
    async fn sweeping_a_single_loopback_address_finds_it() {
        let (tx, mut rx) = mpsc::channel(64);
        let cidr = parse_cidr("127.0.0.1/32").unwrap();
        let hits = sweep(cidr, SweepOptions::default(), tx, CancellationToken::new()).await;

        assert_eq!(hits.len(), 1, "loopback should answer");
        assert_eq!(hits[0].ip, "127.0.0.1");

        let mut events = Vec::new();
        while let Ok(e) = rx.try_recv() {
            events.push(e);
        }
        assert!(matches!(events.first(), Some(SweepEvent::Started { total: 1 })));
        assert!(matches!(
            events.last(),
            Some(SweepEvent::Finished {
                alive: 1,
                scanned: 1,
                cancelled: false
            })
        ));
    }

    #[tokio::test]
    async fn several_subnets_report_one_continuous_progress_sequence() {
        // A progress bar that restarts per subnet reads as several failures.
        let (tx, mut rx) = mpsc::channel(4096);
        let cidrs = vec![
            parse_cidr("127.0.0.1/32").unwrap(),
            parse_cidr("127.0.0.2/32").unwrap(),
            parse_cidr("127.0.0.3/32").unwrap(),
        ];
        let hits = sweep_many(cidrs, SweepOptions::default(), tx, CancellationToken::new()).await;
        assert_eq!(hits.len(), 3, "the whole of 127/8 is loopback and answers");

        let mut events = Vec::new();
        while let Ok(e) = rx.try_recv() {
            events.push(e);
        }

        // One Started and one Finished for the run, not one per subnet.
        let started: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                SweepEvent::Started { total } => Some(*total),
                _ => None,
            })
            .collect();
        assert_eq!(started, vec![3], "one Started, carrying the combined total");

        let finished = events
            .iter()
            .filter(|e| matches!(e, SweepEvent::Finished { .. }))
            .count();
        assert_eq!(finished, 1, "one Finished for the run");

        // Progress climbs to the combined total and never restarts.
        let progress: Vec<u32> = events
            .iter()
            .filter_map(|e| match e {
                SweepEvent::Progress { done, total } => {
                    assert_eq!(*total, 3, "every Progress carries the run total");
                    Some(*done)
                }
                _ => None,
            })
            .collect();
        assert_eq!(progress, vec![1, 2, 3], "got {progress:?}");
    }

    #[tokio::test]
    async fn sweeping_no_subnets_at_all_still_finishes() {
        // A UI that clears its spinner on Finished must always get one.
        let (tx, mut rx) = mpsc::channel(16);
        let hits = sweep_many(vec![], SweepOptions::default(), tx, CancellationToken::new()).await;
        assert!(hits.is_empty());
        let mut last = None;
        while let Ok(e) = rx.try_recv() {
            last = Some(e);
        }
        assert!(matches!(last, Some(SweepEvent::Finished { scanned: 0, .. })), "got {last:?}");
    }

    #[tokio::test]
    async fn cancelling_still_produces_a_finished_event() {
        // A UI that only clears its spinner on Finished must always get one.
        let (tx, mut rx) = mpsc::channel(4096);
        let cidr = parse_cidr("192.0.2.0/24").unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();

        let hits = sweep(cidr, SweepOptions::default(), tx, cancel).await;

        assert!(hits.is_empty());
        let mut last = None;
        while let Ok(e) = rx.try_recv() {
            last = Some(e);
        }
        assert!(
            matches!(last, Some(SweepEvent::Finished { cancelled: true, .. })),
            "a cancelled sweep must still finish, got {last:?}"
        );
    }

    // --- LT-109: the name behind an address ---

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn a_real_ptr_record_is_a_name() {
        assert_eq!(
            usable_name("csdc.comsol.root", ip("10.10.10.24")),
            Some("csdc.comsol.root".to_string())
        );
    }

    #[test]
    fn the_address_repeated_back_is_not_a_name() {
        // `getnameinfo` without NI_NAMEREQD hands back the numeric form rather
        // than failing, and taking that as a hostname would label every device
        // with the number the sweep was supposed to replace. `lookup_addr`
        // does pass NI_NAMEREQD, so this is a guard against that changing
        // rather than the thing currently holding the line.
        assert_eq!(usable_name("10.10.10.24", ip("10.10.10.24")), None);
        assert_eq!(usable_name("192.0.2.1", ip("192.0.2.1")), None);
    }

    #[test]
    fn a_v6_address_repeated_back_is_not_a_name_either() {
        assert_eq!(usable_name("::1", ip("::1")), None);
        // Case differs from the canonical form; still the same address.
        assert_eq!(usable_name("FE80::1", ip("fe80::1")), None);
    }

    #[test]
    fn a_trailing_root_dot_is_dropped() {
        // Resolvers vary on whether the fully-qualified form keeps its dot.
        assert_eq!(
            usable_name("host.example.com.", ip("10.0.0.5")),
            Some("host.example.com".to_string())
        );
    }

    #[test]
    fn nothing_at_all_is_not_a_name() {
        assert_eq!(usable_name("", ip("10.0.0.5")), None);
        assert_eq!(usable_name("   ", ip("10.0.0.5")), None);
        assert_eq!(usable_name(".", ip("10.0.0.5")), None);
    }

    #[test]
    fn a_name_that_merely_contains_the_address_is_kept() {
        // Common on ISP and lab reverse zones. Only an exact match is the
        // resolver giving up; this is a real name.
        assert_eq!(
            usable_name("10-0-0-5.static.example.net", ip("10.0.0.5")),
            Some("10-0-0-5.static.example.net".to_string())
        );
    }

    #[tokio::test]
    async fn a_resolver_that_never_answers_does_not_stall_the_sweep() {
        // The documentation range has no PTR record and no route; whatever the
        // local resolver does with it, this must come back promptly rather
        // than holding a sweep open.
        let started = std::time::Instant::now();
        let name = reverse_name(ip("192.0.2.123"), 300).await;
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "reverse lookup took {:?}, which would stall a sweep",
            started.elapsed()
        );
        // Either it has no name, or the environment has an unusual resolver —
        // what must not happen is the address coming back as its own name.
        assert_ne!(name.as_deref(), Some("192.0.2.123"));
    }
}
