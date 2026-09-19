//! Walking a network from one seed address.
//!
//! Log in, ask what the device can see, decide which of those are worth
//! visiting, repeat. The shape is the same as the Python crawler this replaces,
//! with three differences that matter on a real estate:
//!
//! * It does not recurse. A recursive crawl of a large network is a stack of
//!   open SSH sessions, and a failure deep in it takes the whole run with it.
//!   This is a queue.
//! * A device that fails is recorded and the crawl continues. One unreachable
//!   switch must not end a survey of two hundred.
//! * Devices are identified by name, not address. The same switch is reached
//!   at one address and advertised at another, and an address-keyed visited set
//!   crawls it twice and draws it twice.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

use crate::cdp::parse_cdp_detail;
use crate::filter::DiscoveryFilter;
use crate::hostkeys::HostKeyStore;
use crate::interfaces::{addresses_from, parse_ip_interface_brief};
use crate::lldp::parse_lldp_detail;
use crate::snmp::{classify_identity, identify, SnmpAuth};
use crate::ssh::{Credentials, Device, SshError, SshOptions, SshProgress, Secret};
use crate::types::{AddressPreference, DeviceAddress, DeviceClass, Neighbor};

#[derive(Clone, Debug)]
pub struct CrawlOptions {
    /// Which devices the crawl may log into. Only `should_crawl` is consulted:
    /// the presentation half of the filter belongs to the UI, after the crawl
    /// has collected everything it can see.
    pub filter: DiscoveryFilter,
    /// How many hops from the seed. A guard against a crawl that walks out of
    /// the estate through a link nobody remembered.
    pub max_hops: usize,
    /// Ceiling on devices visited, whatever the topology says.
    pub max_devices: usize,
    /// How many devices to work on at once. Forced to 1 when a second factor
    /// is in play — nobody can approve sixty-four Duo pushes at the same time.
    pub concurrency: usize,
    /// The estate uses Duo or another push factor. Setting this up front avoids
    /// the first few devices racing before it is detected.
    pub second_factor: bool,
    /// Which of a device's addresses a probe should target afterwards.
    pub address_preference: AddressPreference,
    pub ssh: SshOptions,
    /// Credential sets to try when the first one is rejected.
    ///
    /// A single estate rarely has a single login: sites migrate between TACACS
    /// realms, and appliances from a different vendor keep their own local
    /// account. On the network this was built against the Cisco and the
    /// FortiSwitch take different passwords, so one crawl could reach one or
    /// the other and never both.
    pub fallback_credentials: Vec<Credentials>,
    /// How to reach a command line. Telnet is never chosen on its own — a run
    /// has to ask for it.
    pub transport: Transport,
    /// Which VDOM to enter on a FortiGate that has them enabled. Almost always
    /// `root`; a management VDOM under another name is common enough that it
    /// has to be settable.
    pub vdom: String,
    /// When set, a device that refuses SSH is still identified over SNMP.
    ///
    /// Worth having because the two are not interchangeable and not equally
    /// available: a read-only community is far easier to get approved than
    /// shell access, and on the network this was built against a neighbouring
    /// switch rejected SSH credentials while answering SNMP quite happily.
    /// Without this it would appear as an unreachable address and nothing else.
    /// Every SNMP credential to try, in order (LT-142). A real estate is not
    /// one credential: a Catalyst answers v3 with SHA and AES-256 while older
    /// kit answers v2c with a community, and one of each is common. Empty
    /// means SNMP is off, which is the default — see
    /// `snmp_is_off_unless_asked_for`.
    pub snmp: Vec<SnmpAuth>,
    pub snmp_timeout: Duration,
    /// LT-200–204: the extra tables to read from each command line.
    pub details: DetailOptions,
    /// LT-208: how long one device may take, login and every command, before
    /// the crawl gives up on it and moves on.
    pub per_host_timeout: Duration,
    /// LT-208: how many more times to try a device that did not answer at all.
    /// A rejected login is never retried.
    pub retries: u32,
    /// LT-199, LT-209: credentials bound to a device, a subnet or a vendor,
    /// tried before the run's own on the devices they match.
    pub bindings: Vec<crate::bindings::Binding>,
}

impl Default for CrawlOptions {
    fn default() -> Self {
        Self {
            filter: DiscoveryFilter::default(),
            max_hops: 8,
            max_devices: 500,
            concurrency: 4,
            second_factor: false,
            address_preference: AddressPreference::default(),
            ssh: SshOptions::default(),
            fallback_credentials: Vec::new(),
            transport: Transport::default(),
            vdom: "root".to_string(),
            snmp: Vec::new(),
            snmp_timeout: Duration::from_secs(5),
            details: DetailOptions::default(),
            bindings: Vec::new(),
            per_host_timeout: Duration::from_secs(300),
            retries: 1,
        }
    }
}

/// How much a device was willing to tell us.
///
/// Kept on the record because the difference matters: an SSH device reported
/// its own neighbours and its interface table, while an SNMP one only said what
/// it is. Presenting them identically would imply the map is more complete than
/// it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReachedBy {
    Ssh,
    Snmp,
    /// Never logged into, but described in full by a device that was —
    /// including that device's own neighbours. A FortiAP is the case this
    /// exists for: the FortiGate knows its name, address, serial and what its
    /// wired port is plugged into. Presenting it as reached would claim we
    /// verified it ourselves.
    Reported,
}

/// A device the crawl identified.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawledDevice {
    /// The device's own name, from its prompt. The identity everything else
    /// keys on.
    pub hostname: String,
    /// The address it was actually reached on.
    pub address: String,
    /// Every address it reports, with interface names where known.
    pub addresses: Vec<DeviceAddress>,
    /// The address a probe should aim at, under the chosen preference.
    pub probe_target: String,
    pub class: DeviceClass,
    pub platform: Option<String>,
    /// Every chassis serial this device reports, comma-separated.
    ///
    /// A list rather than one value because a stack is one device with several
    /// boxes in it: one hostname, one management address, one node on a
    /// diagram, and four switches that can each be RMA'd separately.
    #[serde(default)]
    pub serial: Option<String>,
    pub version: Option<String>,
    pub neighbors: Vec<Neighbor>,
    pub hops: usize,
    pub reached_by: ReachedBy,
    /// Addresses this device has learned on its ports, with the maker of each
    /// where the registry knows it. Everything plugged in that says nothing
    /// for itself is in here.
    pub attached: Vec<AttachedDevice>,
    /// What this device says it has aggregated (LT-009): the bundles from
    /// `show etherchannel summary`, so two cables in a LAG draw as one link.
    pub port_channels: Vec<crate::etherchannel::PortChannel>,
    /// Where this device sends traffic it has no other route for (LT-131).
    /// Resolved to a device by the topology builder, which is what turns it
    /// into a direction on a link. `None` where it has no default route, or
    /// where nothing answered — never a guess.
    #[serde(default)]
    pub default_next_hop: Option<String>,
    /// Whether this is one switch or several (LT-139). `None` means nothing
    /// reported a stack, which for most devices is the truth.
    #[serde(default)]
    pub stack: Option<crate::stacking::StackInfo>,
    /// Routes, spanning tree, VLANs, ports and uptime (LT-200, LT-202–204).
    /// Empty for a device reached any way but a command line, and for any
    /// part the run did not ask for.
    #[serde(flatten)]
    pub details: DeviceDetails,
    /// LT-206: what reverse DNS calls the address it was reached on, where the
    /// estate has a PTR record for it.
    #[serde(default)]
    pub dns_name: Option<String>,
}

/// What a command line says about a device beyond its identity and
/// neighbours, each part asked for only when the run wants it.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDetails {
    /// LT-200: the IPv4 and IPv6 routing tables.
    pub routes: Vec<crate::routes::Route>,
    /// LT-202: one entry per spanning-tree instance.
    pub spanning_tree: Vec<crate::stp::StpInstance>,
    /// LT-203: the VLANs the device has, and each port's mode.
    pub vlans: Vec<crate::vlans::Vlan>,
    pub port_vlans: Vec<crate::vlans::PortVlans>,
    /// LT-204: every port with its status, speed and duplex.
    pub ports: Vec<crate::vlans::PortStatus>,
    /// LT-204: seconds since the device last started.
    pub uptime_seconds: Option<u64>,
    /// LT-235: each port's error counters.
    pub counters: Vec<crate::counters::PortCounters>,
}

/// Which of the extra tables a crawl collects (LT-200–204). Each costs a
/// command or two per device, so each can be turned off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct DetailOptions {
    pub routes: bool,
    pub spanning_tree: bool,
    pub vlans: bool,
}

impl Default for DetailOptions {
    fn default() -> Self {
        Self { routes: true, spanning_tree: true, vlans: true }
    }
}

/// Something seen on a port that announced nothing about itself.
///
/// Deliberately not a `Neighbor`: a neighbour told us who it is, and this did
/// not. All that is known is a MAC, the port it was learned on, sometimes an
/// address from ARP, and who made it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedDevice {
    pub mac: String,
    pub port: String,
    pub address: Option<String>,
    pub vendor: Option<String>,
    /// What the device calls itself, when something on the path knew. A MAC
    /// and an OUI give "Hewlett Packard"; this gives "HPLJ-3rdfloor".
    pub hostname: Option<String>,
    /// What it is, when a device that can actually tell said so. `None` here
    /// leaves the OUI classifier its turn rather than overriding it with a
    /// guess.
    pub class: Option<crate::types::DeviceClass>,
    /// How many distinct addresses share this port. One means something is
    /// plugged into it; many means it leads to another switch.
    pub port_population: usize,
    /// The VLAN the switch learned this device on, when the MAC table said so
    /// (LT-027). Unambiguous for an access port; empty on a device that
    /// announced itself over a discovery protocol instead.
    pub vlan: Option<String>,
}

/// Why a device could not be reached (LT-144).
///
/// The reason used to be a sentence and nothing else, so the interface parsed
/// English to decide how to present it and could not group four identical
/// timeouts into one explanation. Worse, the two cases an operator most needs
/// told apart — *this device is up but will not take SSH* and *there is
/// nothing at this address* — produced the **same** message, because a
/// dropped SYN and an absent host both time out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailureKind {
    /// The address answers ICMP, but SSH did not complete. The device is
    /// there; something between here and its port 22 is not. On the network
    /// this was built against that is every FortiGate-managed FortiAP, which
    /// exposes no SSH to the LAN at all.
    ReachableNoSsh,
    /// Nothing answered SSH and nothing answered a ping either.
    Unreachable,
    /// Actively refused — something is at that address and nothing is
    /// listening on that port.
    Refused,
    /// The credentials were rejected.
    AuthRejected,
    /// Authentication was never completed — a push factor nobody approved.
    AuthTimedOut,
    /// It answered SSH and never presented a prompt: not a device with a CLI.
    NoPrompt,
    /// The host key is not the one remembered. Never a device to log into
    /// until a person has looked at why.
    HostKeyChanged,
    /// It answered, then stopped part way through a command.
    CommandTimedOut,
    /// Anything else, including a protocol error.
    Other,
}

impl FailureKind {
    /// What to tell the operator to do about it, in one line.
    pub fn advice(&self) -> &'static str {
        match self {
            FailureKind::ReachableNoSsh => {
                "This device is up but did not take an SSH session. Check that SSH is enabled \
                 and reachable from here — a controller-managed access point usually offers \
                 none at all."
            }
            FailureKind::Unreachable => {
                "Nothing at this address answered SSH or a ping. It may be off, or on a \
                 network this machine cannot reach."
            }
            FailureKind::Refused => "Something is at this address, but nothing is listening on that port.",
            FailureKind::AuthRejected => "The credentials were refused. Try another set.",
            FailureKind::AuthTimedOut => "Authentication was never completed — a push factor was not approved in time.",
            FailureKind::NoPrompt => "It accepted the session but never gave a prompt; it may not have a CLI.",
            FailureKind::HostKeyChanged => "The host key has changed. Confirm why before logging in again.",
            FailureKind::CommandTimedOut => "It answered, then stopped responding part way through.",
            FailureKind::Other => "See the message for what the device said.",
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlFailure {
    pub address: String,
    pub reason: String,
    /// What kind of failure it was, so the interface can group and explain
    /// without reading the sentence (LT-144).
    pub kind: FailureKind,
}

/// Turns an SSH failure into a kind, asking the network where the error alone
/// cannot tell.
///
/// A dropped SYN and a host that is switched off both surface as
/// `ConnectTimeout`, and those are very different things to an operator. One
/// ping settles it — and only on the failure path, so a crawl that succeeds
/// pays nothing for this.
async fn classify_failure(error: &crate::ssh::SshError, address: &str) -> FailureKind {
    use crate::ssh::SshError;
    match error {
        SshError::AuthFailed { .. } => FailureKind::AuthRejected,
        SshError::AuthTimeout { .. } => FailureKind::AuthTimedOut,
        SshError::NoPrompt { .. } => FailureKind::NoPrompt,
        SshError::HostKeyChanged(_) => FailureKind::HostKeyChanged,
        SshError::CommandTimeout { .. } => FailureKind::CommandTimedOut,
        SshError::Connect { source, .. }
            if source.kind() == std::io::ErrorKind::ConnectionRefused =>
        {
            FailureKind::Refused
        }
        SshError::ConnectTimeout { .. } | SshError::Connect { .. } => {
            if answers_ping(address).await {
                FailureKind::ReachableNoSsh
            } else {
                FailureKind::Unreachable
            }
        }
        SshError::Protocol { .. } => FailureKind::Other,
    }
}

/// Whether an address answers ICMP. Never an error: a machine that cannot
/// send a ping at all simply learns nothing extra here.
async fn answers_ping(address: &str) -> bool {
    let Ok(target) = coreview_probe::validate::parse_target(address) else { return false };
    matches!(
        coreview_probe::icmp::ping_once(&target, 1_500).await,
        Ok(p) if p.outcome.is_success()
    )
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CrawlEvent {
    Started {
        seed: String,
    },
    /// Mirrors SshProgress so the UI has one stream to watch, including the
    /// "approve the push on your phone" message. Named rather than flattened
    /// (LT-278): the progress has a `kind` of its own, and flattening wrote
    /// the key twice, so the interface never saw an `ssh` event.
    Ssh { progress: SshProgress },
    Reached(Box<CrawledDevice>),
    /// Seen as a neighbour but not visited: filtered out, no address, or a
    /// class the crawl does not walk into.
    Skipped {
        name: String,
        reason: String,
    },
    /// Named for the same reason as `Ssh` (LT-278): a failure has a `kind`.
    Failed { failure: CrawlFailure },
    /// LT-210: a device is waiting its turn.
    Queued {
        address: String,
        hops: usize,
    },
    /// LT-210: a device is being dialled now.
    Visiting {
        address: String,
        hops: usize,
    },
    /// LT-208: a device did not answer and will be tried again shortly.
    Retrying {
        address: String,
        attempt: u32,
    },
    Finished {
        reached: usize,
        failed: usize,
        cancelled: bool,
    },
}

/// What a crawl found.
#[derive(Debug, Default)]
pub struct CrawlResult {
    pub devices: Vec<CrawledDevice>,
    pub failures: Vec<CrawlFailure>,
    /// Neighbours seen but never visited — access points, phones, anything
    /// outside the subnet filter. Still worth drawing.
    pub not_visited: Vec<Neighbor>,
    pub cancelled: bool,
}

/// Everything one device contributes, so the visiting step is independent of
/// the scheduling step and can be tested on its own.
struct Visit {
    device: CrawledDevice,
    neighbors: Vec<Neighbor>,
    /// Devices this one described well enough to place on a diagram, without
    /// the crawl ever connecting to them.
    reported: Vec<CrawledDevice>,
}

/// How to reach a device's command line.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Transport {
    /// SSH only. The default, and the only one that protects anything.
    #[default]
    Ssh,
    /// Telnet only, for equipment that offers nothing else.
    Telnet,
    /// SSH, then telnet if nothing is listening. Never after a *rejected*
    /// password: the account exists and the credentials are wrong, and
    /// sending them again in clear text would be worse than failing.
    SshThenTelnet,
}

/// A command-line session, however it was reached.
///
/// The parsers, the prompt handling and the command set are the same either
/// way; only the bytes underneath differ.
enum Session {
    Ssh(Box<Device>),
    Telnet(Box<crate::telnet::TelnetDevice>),
}

impl Session {
    async fn run(&mut self, command: &str) -> Result<String, SshError> {
        match self {
            Session::Ssh(d) => d.run(command).await,
            Session::Telnet(d) => d.run(command).await,
        }
    }

    async fn enable(&mut self, password: Option<&Secret>) -> Result<bool, SshError> {
        match self {
            Session::Ssh(d) => d.enable(password).await,
            Session::Telnet(d) => d.enable(password).await,
        }
    }

    fn hostname(&self) -> &str {
        match self {
            Session::Ssh(d) => d.hostname(),
            Session::Telnet(d) => d.hostname(),
        }
    }

    async fn close(self) {
        match self {
            Session::Ssh(d) => d.close().await,
            Session::Telnet(d) => d.close().await,
        }
    }
}

/// Opens a telnet session with the crawl's timeouts.
async fn telnet_session(
    address: &str,
    credentials: &Credentials,
    options: &CrawlOptions,
) -> Result<Session, SshError> {
    // Telnet has no port of its own in the options: 23 is the only one it is
    // ever on, and a device with telnet somewhere else is not the common case
    // this exists for.
    crate::telnet::TelnetDevice::connect(
        address,
        23,
        credentials,
        options.ssh.connect_timeout,
        options.ssh.command_timeout,
    )
    .await
    .map(|d| Session::Telnet(Box::new(d)))
}

/// Crawls from a seed address.
///
/// Never returns an error: a crawl that dies because one device misbehaved is
/// worse than one that reports what it managed. Failures are in the result.
/// The default gateway to visit next, if it should be (LT-156).
///
/// The crawl follows what CDP and LLDP report, and a firewall at the edge
/// usually speaks neither — so the device at the top of every diagram was the
/// one discovery never tried, although the switch's own default route had
/// just named its address. It is visited like a neighbour: within the hop
/// limit, inside the allowed subnets, and not already tried. Then SSH and each
/// SNMP credential are tried on it, like everything else.
fn gateway_to_visit<'a>(
    next_hop: Option<&'a str>,
    hops: usize,
    options: &CrawlOptions,
    tried: &HashSet<String>,
) -> Option<&'a str> {
    let hop = next_hop?.trim();
    if hop.is_empty() || hops + 1 > options.max_hops || tried.contains(hop) {
        return None;
    }
    options.filter.allows_address(hop).then_some(hop)
}

pub async fn crawl(
    seed: &str,
    credentials: Credentials,
    options: CrawlOptions,
    store: Arc<std::sync::Mutex<HostKeyStore>>,
    events: mpsc::Sender<CrawlEvent>,
    cancel: CancellationToken,
) -> CrawlResult {
    crawl_from(&[seed.to_string()], credentials, options, store, events, cancel).await
}

/// Crawls from several seeds at once (LT-207): each is queued at hop 0, and the
/// same visited sets stop two seeds in one network crawling it twice.
pub async fn crawl_from(
    seeds: &[String],
    credentials: Credentials,
    options: CrawlOptions,
    store: Arc<std::sync::Mutex<HostKeyStore>>,
    events: mpsc::Sender<CrawlEvent>,
    cancel: CancellationToken,
) -> CrawlResult {
    let _ = events
        .send(CrawlEvent::Started {
            seed: seeds.join(", "),
        })
        .await;

    let mut result = CrawlResult::default();
    let mut queue: VecDeque<(String, usize)> = VecDeque::new();
    for seed in seeds {
        queue.push_back((seed.clone(), 0));
    }

    // Two visited sets, because a device has two kinds of identity and both
    // cause duplicate work if ignored. Addresses stop us dialling the same
    // endpoint twice; names stop us crawling one device twice because it was
    // advertised under two addresses.
    let mut tried_addresses: HashSet<String> = HashSet::new();
    let mut seen_hostnames: HashSet<String> = HashSet::new();
    let mut pending_neighbors: HashMap<String, Neighbor> = HashMap::new();

    // Serialising authentication is the whole answer to "pause for Duo before
    // moving to the next device". Only the login is serialised, because that
    // is where the push happens.
    let auth_gate = Arc::new(Mutex::new(()));
    let serialise = Arc::new(std::sync::atomic::AtomicBool::new(options.second_factor));

    // LT-208: visits run side by side, up to `concurrency`, each under the
    // per-device time limit and retried when nothing answered. The shared
    // state — the queue and the visited sets — is only touched here, between
    // visits, so no two visits can decide the same thing at once.
    let credentials = Arc::new(credentials);
    let options = Arc::new(options);
    let at_once = options.concurrency.max(1);
    let mut running: tokio::task::JoinSet<(usize, String, usize, Outcome)> = tokio::task::JoinSet::new();
    let mut dispatched = 0usize;
    // Which dispatch each reached device came from, so the result lists them in
    // the order they were started rather than the order they happened to
    // finish, and one run reads the same as the next.
    let mut order_of: HashMap<String, usize> = HashMap::new();

    // LT-210: what has been announced as waiting, so each is announced once.
    let mut announced: HashSet<String> = HashSet::new();
    loop {
        for (address, hops) in &queue {
            if !tried_addresses.contains(address) && announced.insert(address.clone()) {
                let _ = events.send(CrawlEvent::Queued { address: address.clone(), hops: *hops }).await;
            }
        }
        while running.len() < at_once && !cancel.is_cancelled() {
            let Some((address, hops)) = queue.pop_front() else { break };
            if result.devices.len() + running.len() >= options.max_devices {
                let _ = events
                    .send(CrawlEvent::Skipped {
                        name: address.clone(),
                        reason: format!("stopped at the {} device limit", options.max_devices),
                    })
                    .await;
                queue.clear();
                break;
            }
            if !tried_addresses.insert(address.clone()) {
                continue;
            }
            // What a neighbour already said about this address: its name and
            // platform decide which bound credentials apply (LT-209), and
            // SNMP falls back on its class.
            let known = pending_neighbors
                .values()
                .find(|n| n.addresses.iter().any(|a| a.ip == address))
                .cloned();
            let _ = events.send(CrawlEvent::Visiting { address: address.clone(), hops }).await;
            let job = VisitJob {
                address: address.clone(),
                known,
                hops,
                credentials: Arc::clone(&credentials),
                options: Arc::clone(&options),
                store: Arc::clone(&store),
                events: events.clone(),
                auth_gate: Arc::clone(&auth_gate),
                serialise: Arc::clone(&serialise),
            };
            let index = dispatched;
            dispatched += 1;
            // Boxed deliberately. Every awaited call inside `visit` — the SSH
            // handshake, the command reads, the SNMP fallback — is inlined
            // into one state machine, and it grew past the stack a thread is
            // given; the symptom was a stack overflow in an unrelated test.
            running.spawn(async move { (index, address, hops, Box::pin(job.run()).await) });
        }

        if running.is_empty() {
            if cancel.is_cancelled() {
                result.cancelled = true;
            }
            break;
        }

        let joined = tokio::select! {
            _ = cancel.cancelled() => {
                // Stop now, not after the slowest device: nothing half-read
                // from a visit that was cut off is reported.
                running.abort_all();
                result.cancelled = true;
                break;
            }
            joined = running.join_next() => joined,
        };
        let Some(Ok((index, _address, hops, outcome))) = joined else { continue };

        match outcome {
            Outcome::Failed(failure) => {
                let _ = events.send(CrawlEvent::Failed { failure: failure.clone() }).await;
                result.failures.push(failure);
            }
            Outcome::Snmp { device, failure } => {
                if !seen_hostnames.insert(device.hostname.clone()) {
                    let _ = events.send(CrawlEvent::Failed { failure: failure.clone() }).await;
                    result.failures.push(failure);
                    continue;
                }
                // LT-134: a device reached over SNMP reports its LLDP
                // neighbours, and they are followed like any other device's,
                // within the same limits.
                for neighbor in &device.neighbors {
                    pending_neighbors
                        .entry(neighbor.short_name.clone())
                        .or_insert_with(|| neighbor.clone());
                    if hops + 1 > options.max_hops
                        || !options.filter.should_crawl(neighbor)
                        || seen_hostnames.contains(&neighbor.short_name)
                    {
                        continue;
                    }
                    if let Some(next) = neighbor.probe_target(&options.address_preference) {
                        if !tried_addresses.contains(next) {
                            queue.push_back((next.to_string(), hops + 1));
                        }
                    }
                }
                let _ = events.send(CrawlEvent::Reached(device.clone())).await;
                order_of.insert(device.hostname.clone(), index);
                result.devices.push(*device);
            }
            Outcome::Visited(visit) => {
                // The same device reached by a second address: record nothing
                // new, and above all do not crawl its neighbours again.
                if !seen_hostnames.insert(visit.device.hostname.clone()) {
                    continue;
                }

                for address in &visit.device.addresses {
                    tried_addresses.insert(address.ip.clone());
                }

                for neighbor in &visit.neighbors {
                    pending_neighbors
                        .entry(neighbor.short_name.clone())
                        .or_insert_with(|| neighbor.clone());

                    if hops + 1 > options.max_hops {
                        continue;
                    }
                    if !options.filter.should_crawl(neighbor) {
                        continue;
                    }
                    if seen_hostnames.contains(&neighbor.short_name) {
                        continue;
                    }
                    if let Some(next) = neighbor.probe_target(&options.address_preference) {
                        if !tried_addresses.contains(next) {
                            queue.push_back((next.to_string(), hops + 1));
                        }
                    }
                }

                // LT-156: the way out, which no neighbour table names.
                if let Some(gateway) = gateway_to_visit(
                    visit.device.default_next_hop.as_deref(),
                    hops,
                    &options,
                    &tried_addresses,
                ) {
                    queue.push_back((gateway.to_string(), hops + 1));
                }

                let _ = events
                    .send(CrawlEvent::Reached(Box::new(visit.device.clone())))
                    .await;
                order_of.insert(visit.device.hostname.clone(), index);
                result.devices.push(visit.device);

                // Devices described by the one just visited. They are not
                // queued for connection: nobody asked to log into an access
                // point, and trying would put failed authentications in a
                // security log for no gain.
                for reported in visit.reported {
                    if !seen_hostnames.insert(reported.hostname.clone()) {
                        continue;
                    }
                    for neighbor in &reported.neighbors {
                        pending_neighbors
                            .entry(neighbor.short_name.clone())
                            .or_insert_with(|| neighbor.clone());
                    }
                    let _ = events
                        .send(CrawlEvent::Reached(Box::new(reported.clone())))
                        .await;
                    order_of.insert(reported.hostname.clone(), index);
                    result.devices.push(reported);
                }
            }
        }
    }
    result
        .devices
        .sort_by_key(|d| order_of.get(&d.hostname).copied().unwrap_or(usize::MAX));

    // Everything seen but not logged into, deliberately unfiltered.
    //
    // The filter's presentation half is *not* applied here. Discovery collects
    // and the user filters afterwards — that is the whole point of doing it in
    // two steps. Applying it now would silently drop the most interesting
    // findings: a switch just outside the subnet limit is a link leaving the
    // estate, which is something you want to see precisely because the crawl
    // would not dial it.
    result.not_visited = pending_neighbors
        .into_values()
        .filter(|n| !seen_hostnames.contains(&n.short_name))
        .collect();
    result.not_visited.sort_by(|a, b| a.short_name.cmp(&b.short_name));

    let _ = events
        .send(CrawlEvent::Finished {
            reached: result.devices.len(),
            failed: result.failures.len(),
            cancelled: result.cancelled,
        })
        .await;
    result
}

/// What one visit came to (LT-208).
enum Outcome {
    /// Boxed: a visit carries a whole device and its neighbours, and the
    /// other outcomes are small.
    Visited(Box<Visit>),
    /// SSH failed but SNMP identified it; the SSH failure is kept in case the
    /// device turns out to have been reached already under another address.
    Snmp { device: Box<CrawledDevice>, failure: CrawlFailure },
    Failed(CrawlFailure),
}

/// Everything a visit needs, owned, so it can run beside others.
struct VisitJob {
    address: String,
    known: Option<Neighbor>,
    hops: usize,
    credentials: Arc<Credentials>,
    options: Arc<CrawlOptions>,
    store: Arc<std::sync::Mutex<HostKeyStore>>,
    events: mpsc::Sender<CrawlEvent>,
    auth_gate: Arc<Mutex<()>>,
    serialise: Arc<std::sync::atomic::AtomicBool>,
}

/// A failure worth trying again: nothing answered. Everything else — a
/// refused port, a rejected password, a changed host key — fails the same way
/// every time, and retrying a password could lock an account.
fn worth_retrying(e: &SshError) -> bool {
    match e {
        SshError::ConnectTimeout { .. } => true,
        SshError::Connect { source, .. } => source.kind() != std::io::ErrorKind::ConnectionRefused,
        _ => false,
    }
}

impl VisitJob {
    async fn run(self) -> Outcome {
        let limit = self.options.per_host_timeout;
        let mut attempt = 0u32;
        let error = loop {
            let visited = tokio::time::timeout(
                limit,
                Box::pin(visit(
                    &self.address,
                    self.known.as_ref(),
                    self.hops,
                    &self.credentials,
                    &self.options,
                    Arc::clone(&self.store),
                    &self.events,
                    Arc::clone(&self.auth_gate),
                    Arc::clone(&self.serialise),
                )),
            )
            .await;
            match visited {
                Ok(Ok(v)) => return Outcome::Visited(Box::new(v)),
                Ok(Err(e)) if worth_retrying(&e) && attempt < self.options.retries => {
                    attempt += 1;
                    let _ = self
                        .events
                        .send(CrawlEvent::Retrying { address: self.address.clone(), attempt })
                        .await;
                    tokio::time::sleep(Duration::from_secs(2 * u64::from(attempt))).await;
                }
                Ok(Err(e)) => break e,
                Err(_) => {
                    return Outcome::Failed(CrawlFailure {
                        address: self.address.clone(),
                        reason: format!(
                            "{}: gave up after {} seconds without finishing",
                            self.address,
                            limit.as_secs()
                        ),
                        kind: FailureKind::CommandTimedOut,
                    })
                }
            }
        };
        let failure = CrawlFailure {
            address: self.address.clone(),
            reason: error.to_string(),
            kind: classify_failure(&error, &self.address).await,
        };
        // SSH would not have it. Before writing the device off, ask whether it
        // will identify itself over SNMP — a device that answers is worth
        // drawing, even without its neighbours. What a neighbour already said
        // about it is passed along: SNMP often cannot tell a device's role,
        // and throwing that away would make a device change kind depending on
        // which protocol reached it.
        match Box::pin(identify_over_snmp(&self.address, self.hops, &self.options, self.known.as_ref())).await {
            Some(device) => Outcome::Snmp { device: Box::new(device), failure },
            None => Outcome::Failed(failure),
        }
    }
}

/// What a crawl knows about a device before dialling it, for matching bound
/// credentials.
fn target_of<'a>(address: &'a str, known: Option<&'a Neighbor>) -> crate::bindings::Target<'a> {
    crate::bindings::Target {
        address,
        hostname: known.map(|n| n.short_name.as_str()),
        platform: known.and_then(|n| n.platform.as_deref().or(n.vendor.as_deref())),
    }
}

/// Asks a device to identify itself over SNMP, when SSH would not have it.
///
/// Returns `None` when SNMP is not configured or the device does not answer,
/// so the caller falls through to recording the original SSH failure — which
/// is the more useful error of the two.
async fn identify_over_snmp(
    address: &str,
    hops: usize,
    options: &CrawlOptions,
    known: Option<&Neighbor>,
) -> Option<CrawledDevice> {
    // Each credential in turn until one answers. SNMPv3 reports a wrong
    // password and a wrong algorithm identically, so there is no way to tell
    // "not this credential" from "not SNMP at all" except by trying.
    let mut identity = None;
    // LT-199, LT-209: credentials bound to this device come first.
    for auth in crate::bindings::snmp_order(&options.bindings, &target_of(address, known), &options.snmp) {
        if let Ok(found) = identify(address, 161, auth, options.snmp_timeout).await {
            identity = Some((found, auth));
            break;
        }
    }
    let (identity, auth) = identity?;

    // LT-134: its links and what is plugged into it, over the credential that
    // just worked. Best effort: a device that identifies but will not give its
    // tables is still drawn, as before.
    let topology = Box::pin(crate::snmp_topology::read_topology(address, auth, options.snmp_timeout))
        .await
        .unwrap_or_default();
    // Addresses for the MACs, from the same device's own ARP table, where it
    // learned any.
    let arp: HashMap<String, String> = if topology.mac_entries.is_empty() {
        HashMap::new()
    } else {
        Box::pin(crate::snmp::arp_table(address, 161, auth, options.snmp_timeout))
            .await
            .map(|rows| rows.into_iter().map(|e| (e.mac.replace(':', ""), e.ip.to_string())).collect())
            .unwrap_or_default()
    };
    device_from_snmp(address, hops, identity, topology, &arp, known)
}

/// A device as SNMP describes it: its identity, its LLDP neighbours, and what
/// its forwarding table says is plugged in, with addresses from its own ARP
/// table. Shared by the crawl and by a saved walk file (LT-246), so a device
/// read either way is the same record. `None` when nothing names it.
pub fn device_from_snmp(
    address: &str,
    hops: usize,
    identity: crate::snmp::SnmpIdentity,
    topology: crate::snmp_topology::SnmpTopology,
    arp: &HashMap<String, String>,
    known: Option<&Neighbor>,
) -> Option<CrawledDevice> {
    let attached = crate::snmp_topology::attached_devices(&topology.neighbors, &topology.mac_entries, arp);

    // The device's own name first, then whatever the neighbour called it.
    let hostname = identity
        .name
        .clone()
        .map(|n| crate::cdp::short_name(&n))
        .filter(|n| !n.is_empty())
        .or_else(|| known.map(|n| n.short_name.clone()))
        .filter(|n| !n.is_empty())?;

    // SNMP's view of what a device *is* is often weaker than a neighbour's:
    // sysServices is frequently 0 on equipment that plainly bridges. Prefer
    // whichever of the two actually knows something.
    let class = match classify_identity(&identity) {
        DeviceClass::Unknown => known.map(|n| n.class).unwrap_or(DeviceClass::Unknown),
        decided => decided,
    };

    Some(CrawledDevice {
        hostname,
        address: address.to_string(),
        addresses: vec![DeviceAddress {
            ip: address.to_string(),
            interface: None,
            is_management: true,
        }],
        probe_target: address.to_string(),
        class,
        // The model from ENTITY-MIB where the device gave one, because
        // sysDescr is a paragraph and `WS-C2960CX-8PC-L` is a model.
        platform: identity
            .models
            .first()
            .cloned()
            .or_else(|| identity.description.clone()),
        // LT-134: the real serial, from the standard ENTITY-MIB — not
        // invented from sysDescr, which is what this used to refuse to do and
        // was right to refuse. Measured against the operator's 2960CX: the
        // chassis serial matches `show version` exactly, and a stack reports
        // one per member, which is what `serial_field` joins.
        serial: serial_field(&identity.serials),
        version: identity.description,
        // LT-134: its LLDP neighbours, read from LLDP-MIB. Empty where the
        // device does not implement it, which is still the honest answer.
        neighbors: topology.neighbors,
        hops,
        reached_by: ReachedBy::Snmp,
        // SNMP gave an identity. Nothing was asked about routing or
        // stacking, so nothing is claimed about either.
        default_next_hop: None,
        stack: None,
        // LT-134: what its forwarding table says is plugged in.
        attached,
        port_channels: Vec::new(),
        details: DeviceDetails::default(),
        dns_name: None,
    })
}

/// Logs into one device and asks it everything worth asking.
#[allow(clippy::too_many_arguments)]
async fn visit(
    address: &str,
    known: Option<&Neighbor>,
    hops: usize,
    credentials: &Credentials,
    options: &CrawlOptions,
    store: Arc<std::sync::Mutex<HostKeyStore>>,
    events: &mpsc::Sender<CrawlEvent>,
    auth_gate: Arc<Mutex<()>>,
    serialise: Arc<std::sync::atomic::AtomicBool>,
) -> Result<Visit, SshError> {
    let (tx, mut rx) = mpsc::channel::<SshProgress>(32);
    let forward = events.clone();
    let flag = Arc::clone(&serialise);
    let pump = tokio::spawn(async move {
        while let Some(p) = rx.recv().await {
            // A push seen once means every later login must wait its turn,
            // even if the run started assuming otherwise.
            if matches!(p, SshProgress::AwaitingSecondFactor { .. }) {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            let _ = forward.send(CrawlEvent::Ssh { progress: p }).await;
        }
    });

    // LT-209: bound logins that match this device first, then the run's.
    let run: Vec<Credentials> =
        std::iter::once(credentials.clone()).chain(options.fallback_credentials.iter().cloned()).collect();
    let order = crate::bindings::ssh_order(&options.bindings, &target_of(address, known), &run);
    let (mut device, credentials) = {
        // Held only across the login. Commands afterwards can overlap freely;
        // it is the push that cannot.
        let _lock = if serialise.load(std::sync::atomic::Ordering::Relaxed) {
            Some(auth_gate.lock().await)
        } else {
            None
        };

        let mut connected = None;
        let mut rejected = None;
        for cred in order {
            let attempt = match options.transport {
                Transport::Telnet => telnet_session(address, cred, options).await,
                Transport::Ssh | Transport::SshThenTelnet => {
                    let ssh = Device::connect(
                        address,
                        cred,
                        options.ssh.clone(),
                        Arc::clone(&store),
                        Some(tx.clone()),
                    )
                    .await
                    .map(|d| Session::Ssh(Box::new(d)));
                    match ssh {
                        // Nothing listening on 22, and the run said telnet is
                        // acceptable. Not after a rejected password: the
                        // account exists and the credentials are wrong, and
                        // sending them again in clear text would be worse
                        // than failing.
                        Err(SshError::Connect { .. } | SshError::ConnectTimeout { .. })
                            if options.transport == Transport::SshThenTelnet =>
                        {
                            telnet_session(address, cred, options).await
                        }
                        other => other,
                    }
                }
            };
            match attempt
            {
                Ok(d) => {
                    connected = Some((d, cred));
                    break;
                }
                // Only a rejected password is worth another set. A timeout, a
                // refused connection or a changed host key fails identically
                // for every credential, and retrying those would multiply the
                // wait and, on a locking account policy, do real harm.
                Err(e @ SshError::AuthFailed { .. }) => rejected = Some(e),
                Err(e) => return Err(e),
            }
        }
        match connected {
            Some(pair) => pair,
            None => return Err(rejected.expect("a failed loop leaves an error")),
        }
    };

    // Escalate before asking for anything privileged. From user mode the
    // neighbour commands often work but the configuration does not, and it is
    // better to find out now than at backup time.
    let _ = device.enable(credentials.enable_password.as_ref()).await;

    let hostname = device.hostname().to_string();

    // Both protocols, always. CDP misses everything that is not Cisco, and
    // LLDP is off by default on plenty of Cisco kit — asking only one leaves a
    // silent hole in the map.
    let cdp = device.run("show cdp neighbors detail").await.unwrap_or_default();
    let lldp = device.run("show lldp neighbors detail").await.unwrap_or_default();
    let brief = device.run("show ip interface brief").await.unwrap_or_default();
    let version = device.run("show version").await.unwrap_or_default();
    // LLDP does not require a device to advertise a management address, and
    // plenty do not — a FortiSwitch on the network this was built against is
    // named and classified correctly and has nowhere to connect. The switch
    // that sees it knows: the chassis id is a MAC, and this maps it.
    let mut arp = crate::arp::parse_arp_table(&device.run("show ip arp").await.unwrap_or_default());
    // What the switch has learned on each port. Discovery protocols only see
    // devices that speak them; a printer or a workstation announces nothing,
    // and on a real diagram those are most of what is plugged in.
    let learned = crate::mac_table::parse_mac_table(
        &device.run("show mac address-table").await.unwrap_or_default(),
    );
    // What is aggregated (LT-009). FortiOS rejects the command harmlessly and
    // the parser reads an empty answer as no bundles.
    let port_channels = crate::etherchannel::parse_etherchannel_summary(
        &device.run("show etherchannel summary").await.unwrap_or_default(),
    );

    // LT-131: which way this device sends unknown traffic. One line, not a
    // forwarding table — the operator asked for direction and warned it must
    // not be slow, and the default route is the cheap accurate answer.
    // `version` is the platform hint because it is already in hand and says
    // "Cisco IOS Software", "FortiOS" or the like.
    let mut default_next_hop = None;
    for command in crate::defaultroute::commands_for(&version) {
        let out = device.run(command).await.unwrap_or_default();
        if let Some(hop) = crate::defaultroute::parse_default_route(&out) {
            default_next_hop = Some(hop.to_string());
            break;
        }
    }

    // LT-139: one switch or several. The parsers behind this were written
    // from vendor documentation (D-026) and each result says so, so nothing
    // downstream can present a guess as a fact.
    let mut stack = None;
    for command in crate::stacking::commands_for(&version) {
        let out = device.run(command).await.unwrap_or_default();
        if let Some(found) = crate::stacking::parse_any(&out) {
            // A stack of one is a standalone switch. Recording it would put a
            // StackWise badge on every unstacked box in an estate.
            if found.is_really_stacked() {
                stack = Some(found);
                break;
            }
        }
    }

    // LT-200, LT-202–204: the tables beyond identity and neighbours, from the
    // same session. Asked only of a platform whose output has been captured
    // and parsed — FortiOS is not one yet, and gets nothing rather than a
    // misreading.
    let details = if crate::fortios::rejected_command(&version) {
        DeviceDetails::default()
    } else {
        read_details(&mut device, &version, options.details).await
    };

    // FortiSwitch and FortiGate answer SSH and then reject all of the above
    // with a parse error. Without this the crawl logs in, takes the hostname
    // off the prompt and learns nothing else — on hardware that is common in
    // exactly the networks this is for. Asked second because IOS is the usual
    // case and this costs a round trip.
    let forti = if crate::fortios::rejected_command(&version) {
        // A FIPS-CC FortiGate holds a banner open and reads the next command
        // as the answer to it. Nothing else works until it is accepted, and
        // on a box with no banner this sends nothing.
        if crate::fortios::fips_banner_pending(&version) {
            let _ = device.run("a").await;
        }
        let status = device.run("get system status").await.unwrap_or_default();
        let status = crate::fortios::parse_system_status(&status);
        // On a VDOM-enabled FortiGate the interesting tables live inside a
        // VDOM, and asking outside one answers for the wrong network.
        if status.vdoms_enabled {
            let _ = device.run("config vdom").await;
            let _ = device.run(&format!("edit {}", options.vdom)).await;
        }
        let ifaces = device.run("get system interface").await.unwrap_or_default();
        let neighbours = device
            .run("get switch lldp neighbors-summary")
            .await
            .unwrap_or_default();
        // A FortiGate rejects the FortiSwitch LLDP command and, on a
        // non-super_admin account, every `diagnose`. The switches it manages
        // are still in its configuration, and that is a certain link.
        let managed = crate::fortios::parse_managed_switches(
            &device
                .run("show switch-controller managed-switch")
                .await
                .unwrap_or_default(),
        );
        // Each managed AP reports what its own wired port is plugged into.
        // That is a cable, and on this network it is the only evidence of a
        // switch that speaks nothing else the crawler can use.
        let access_points = crate::fortios::parse_wtp_status(
            &device
                .run("get wireless-controller wtp-status")
                .await
                .unwrap_or_default(),
        );
        // A FortiGate's own ARP table, which a FortiSwitch does not have.
        let forti_arp =
            crate::arp::parse_arp_table(&device.run("get system arp").await.unwrap_or_default());
        // Two sources, because which one answers depends on the account. The
        // device store is richer; `diagnose` is refused outright by any admin
        // profile that is not super_admin, which is what a discovery account
        // should be. The lease list is what actually runs there.
        let mut endpoints = read_device_store(&mut device).await;
        let leases = crate::fortios::parse_dhcp_leases(
            &device.run("execute dhcp lease-list").await.unwrap_or_default(),
        );
        merge_endpoint_lists(&mut endpoints, leases);
        let mut forti_neighbors = crate::fortios::parse_lldp_summary(&neighbours);
        for m in managed {
            if !forti_neighbors.iter().any(|n| n.device_id == m.device_id) {
                forti_neighbors.push(m);
            }
        }
        Some(FortiFacts {
            addresses: crate::fortios::parse_system_interface(&ifaces),
            neighbors: forti_neighbors,
            arp: forti_arp,
            endpoints,
            access_points,
            status,
        })
    } else {
        None
    };

    device.close().await;
    drop(pump);

    if let Some(f) = &forti {
        arp.extend(f.arp.iter().map(|(k, v)| (k.clone(), v.clone())));
    }

    let interfaces = parse_ip_interface_brief(&brief);
    let mut addresses = addresses_from(&interfaces, address);
    if let Some(f) = &forti {
        if addresses.is_empty() {
            addresses = f.addresses.clone();
        }
    }
    if addresses.is_empty() {
        // A platform whose interface table this parser does not understand.
        // The address that worked is still a fact worth keeping.
        addresses.push(DeviceAddress {
            ip: address.to_string(),
            interface: None,
            is_management: true,
        });
    }

    let mut neighbors = merge_neighbors(parse_cdp_detail(&cdp), parse_lldp_detail(&lldp));

    // Fill in an address for anything that did not advertise one. Only where
    // there is none: an address a device advertised about itself beats one
    // inferred from a MAC.
    if !arp.is_empty() {
        for n in &mut neighbors {
            if !n.addresses.is_empty() {
                continue;
            }
            let Some(mac) = n.chassis_id.as_deref().and_then(crate::arp::normalise_mac) else {
                continue;
            };
            if let Some(ip) = arp.get(&mac) {
                n.addresses.push(DeviceAddress {
                    ip: ip.clone(),
                    interface: None,
                    is_management: true,
                });
            }
        }
    }

    // The other way round, for a neighbour whose chassis id is a name rather
    // than a MAC. The switch learned exactly one address on that port, so the
    // device on the far end is the one holding it — LABDESKTOP01 announces a
    // name and no address, and this is what finds it.
    //
    // Only where the port has learned exactly one. Two or more and the far end
    // is another switch, and picking one of them would be a guess.
    if !learned.is_empty() && !arp.is_empty() {
        let population = crate::mac_table::count_by_port(&learned);
        for n in &mut neighbors {
            if !n.addresses.is_empty() {
                continue;
            }
            let Some(port) = n.local_interface.as_deref() else { continue };
            let on_port: Vec<&crate::mac_table::MacEntry> = learned
                .iter()
                .filter(|e| same_interface(port, &e.port))
                .collect();
            if on_port.len() != 1 {
                continue;
            }
            let entry = on_port[0];
            if population.get(&entry.port).copied().unwrap_or(0) != 1 {
                continue;
            }
            if let Some(ip) = arp.get(&entry.mac) {
                n.addresses.push(DeviceAddress {
                    ip: ip.clone(),
                    interface: None,
                    is_management: true,
                });
                if n.vendor.is_none() {
                    n.vendor = crate::oui::vendor(&entry.mac).map(str::to_string);
                }
            }
        }
    }
    if let Some(f) = &forti {
        if neighbors.is_empty() {
            neighbors = f.neighbors.clone();
        }
    }
    let probe_target = options
        .address_preference
        .choose(&addresses)
        .map(|a| a.ip.clone())
        .unwrap_or_else(|| address.to_string());

    // "FortiSwitch-224E" classifies where an IOS version banner would.
    let forti_status = forti.as_ref().map(|f| &f.status);
    let platform = match forti_status {
        Some(s) if s.model.is_some() => s.model.clone(),
        _ => platform_from_version(&version),
    };
    let version_line = match forti_status {
        Some(s) if s.version.is_some() => s.version.as_deref(),
        _ => first_line(&version),
    };
    let class = crate::classify::classify(platform.as_deref(), &[], version_line);

    // A port with a discovery neighbour is a link to something that already
    // introduced itself; anything else learned there is behind that device,
    // not attached here. That is observed rather than assumed.
    let mut uplinks: std::collections::HashSet<String> = neighbors
        .iter()
        .filter_map(|n| n.local_interface.clone())
        .collect();
    // A bundle whose member is an uplink is an uplink itself: the MAC table
    // reports addresses learned across a LAG on Po1, not on the member port,
    // and without this the entire far side of the network shows as "attached"
    // to this switch (seen live the first time the lab had a LAG, LT-009).
    for pc in &port_channels {
        if pc
            .members
            .iter()
            .any(|m| uplinks.iter().any(|u| crate::crawl::same_interface(u, m)))
        {
            uplinks.insert(pc.name.clone());
        }
    }
    let population = crate::mac_table::count_by_port(&learned);
    let mut attached = Vec::new();
    for entry in &learned {
        if uplinks.iter().any(|u| crate::crawl::same_interface(u, &entry.port)) {
            continue;
        }
        attached.push(AttachedDevice {
            address: arp.get(&entry.mac).cloned(),
            vendor: crate::oui::vendor(&entry.mac).map(str::to_string),
            port_population: population.get(&entry.port).copied().unwrap_or(1),
            mac: entry.mac.clone(),
            port: entry.port.clone(),
            hostname: None,
            class: None,
            vlan: entry.vlan.clone(),
        });
    }

    // A FortiGate already knows what is on the network by name. Merging it
    // here rather than beside it means the attached-device filter, the vendor
    // counts and the drawing all work on one list.
    if let Some(f) = &forti {
        merge_endpoints(&mut attached, &f.endpoints);
    }

    let reported = forti
        .as_ref()
        .map(|f| reported_access_points(&f.access_points))
        .unwrap_or_default();

    Ok(Visit {
        reported,
        device: CrawledDevice {
            hostname,
            address: address.to_string(),
            addresses,
            probe_target,
            class,
            platform,
            serial: serial_field(&serials_in_version(&version)),
            version: first_line(&version).map(str::to_string),
            neighbors: neighbors.clone(),
            hops,
            reached_by: ReachedBy::Ssh,
            attached,
            port_channels,
            default_next_hop,
            stack,
            details,
            dns_name: None,
        },
        neighbors,
    })
}

/// Reads the tables a run asked for. Every command is best effort: a platform
/// that rejects one gives an empty part, never a failed visit.
async fn read_details(device: &mut Session, version: &str, wanted: DetailOptions) -> DeviceDetails {
    let mut details = DeviceDetails { uptime_seconds: crate::uptime::parse_uptime(version), ..DeviceDetails::default() };
    if wanted.routes {
        for command in crate::routes::commands_for(version) {
            let out = device.run(command).await.unwrap_or_default();
            details.routes.extend(crate::routes::parse_routes(&out));
        }
    }
    if wanted.spanning_tree {
        let out = device.run(crate::stp::COMMAND).await.unwrap_or_default();
        details.spanning_tree = crate::stp::parse_spanning_tree(&out);
    }
    if wanted.vlans {
        let brief = device.run("show vlan brief").await.unwrap_or_default();
        let trunks = device.run("show interfaces trunk").await.unwrap_or_default();
        let status = device.run("show interfaces status").await.unwrap_or_default();
        details.vlans = crate::vlans::parse_vlan_brief(&brief);
        details.ports = crate::vlans::parse_interface_status(&status);
        details.port_vlans = crate::vlans::port_vlans(&details.ports, &crate::vlans::parse_trunks(&trunks));
        // LT-235: errors per port, read with the ports.
        let interfaces = device.run(crate::counters::COMMAND).await.unwrap_or_default();
        details.counters = crate::counters::parse_interface_counters(&interfaces);
    }
    details
}

/// What a FortiOS device answered, once it has been asked in its own language.
struct FortiFacts {
    status: crate::fortios::SystemStatus,
    addresses: Vec<DeviceAddress>,
    neighbors: Vec<Neighbor>,
    arp: std::collections::HashMap<String, String>,
    endpoints: Vec<crate::fortios::Endpoint>,
    access_points: Vec<crate::fortios::AccessPoint>,
}

/// How many times to answer the pager before giving up.
///
/// A large FortiGate holds thousands of devices, and each page is a round
/// trip. The cap is here so a device that answers the pager with the pager
/// cannot hold a crawl open forever; hitting it costs a truncated list, which
/// is worth more than a crawl that never ends.
const MAX_DEVICE_STORE_PAGES: usize = 200;

/// Everything the FortiGate knows about what is on the network.
///
/// This is the one command that turns a MAC address into a named device with
/// an operating system and a hardware type, which is what an accurate diagram
/// of endpoints needs and what an OUI lookup alone cannot give.
async fn read_device_store(device: &mut Session) -> Vec<crate::fortios::Endpoint> {
    let Ok(first) = device
        .run("diagnose user-device-store device memory list")
        .await
    else {
        return Vec::new();
    };
    let mut out = first;
    let mut pages = 0;
    while crate::fortios::pagination_pending(&out) && pages < MAX_DEVICE_STORE_PAGES {
        pages += 1;
        match device.run("y").await {
            Ok(next) if !next.is_empty() => out.push_str(&next),
            // Nothing more is coming; keep what was collected rather than
            // spinning on an unchanging answer.
            _ => break,
        }
    }
    crate::fortios::parse_device_store(&out)
}

/// Turns the access points a FortiGate manages into devices for the diagram.
///
/// The tunnel from the FortiGate to an AP runs over the network and is not a
/// cable, so no link to the FortiGate is produced. The AP's own LLDP is a
/// cable, and it becomes the AP's neighbour — which is how a switch that
/// answers nothing else ends up correctly drawn, attached to the right port.
fn reported_access_points(aps: &[crate::fortios::AccessPoint]) -> Vec<CrawledDevice> {
    aps.iter()
        .filter_map(|ap| {
            // Without an address there is nothing to probe and nothing to
            // fold against; the name alone would make a node that cannot be
            // checked or matched.
            let address = ap.address.clone()?;
            Some(CrawledDevice {
                hostname: ap.name.clone(),
                addresses: vec![DeviceAddress {
                    ip: address.clone(),
                    interface: None,
                    is_management: true,
                }],
                probe_target: address.clone(),
                address,
                class: DeviceClass::AccessPoint,
                platform: ap
                    .software_version
                    .as_deref()
                    .and_then(|v| v.split('-').next())
                    .map(str::to_string),
                // Reported by its controller, never logged into.
                serial: None,
                version: ap.software_version.clone(),
                neighbors: ap.uplink.clone().into_iter().collect(),
                hops: 0,
                reached_by: ReachedBy::Reported,
                // A neighbour said this exists. It was never asked anything.
                default_next_hop: None,
                stack: None,
                attached: Vec::new(),
                port_channels: Vec::new(),
                details: DeviceDetails::default(),
                dns_name: None,
            })
        })
        .collect()
}

/// Folds a second list of endpoints into the first, matching on MAC.
///
/// The device store and the lease list overlap: the same laptop is in both.
/// Whichever answered first keeps its fields, and the second only fills gaps,
/// so a richer source is never overwritten by a thinner one.
fn merge_endpoint_lists(into: &mut Vec<crate::fortios::Endpoint>, extra: Vec<crate::fortios::Endpoint>) {
    for e in extra {
        let Some(existing) = into.iter_mut().find(|x| x.mac == e.mac) else {
            into.push(e);
            continue;
        };
        if existing.address.is_none() {
            existing.address = e.address;
        }
        if existing.hostname.is_none() {
            existing.hostname = e.hostname;
        }
        if existing.os_name.is_none() {
            existing.os_name = e.os_name;
        }
        if existing.interface.is_none() {
            existing.interface = e.interface;
        }
        if existing.fortiap_ssid.is_none() {
            existing.fortiap_ssid = e.fortiap_ssid;
        }
        if existing.fortiap_name.is_none() {
            existing.fortiap_name = e.fortiap_name;
        }
    }
}

/// Folds what the FortiGate knows into what the switches saw.
///
/// The same physical device usually appears in both: a MAC in a switch's
/// table, and a named record in the FortiGate's store. Matching on MAC is
/// what keeps that one device instead of two, and the FortiGate's name and
/// class win because it actually knows, where the switch only inferred.
fn merge_endpoints(attached: &mut Vec<AttachedDevice>, endpoints: &[crate::fortios::Endpoint]) {
    for e in endpoints {
        let class = crate::fortios::endpoint_class(e);
        if let Some(existing) = attached.iter_mut().find(|a| a.mac == e.mac) {
            if existing.address.is_none() {
                existing.address.clone_from(&e.address);
            }
            if existing.hostname.is_none() {
                existing.hostname.clone_from(&e.hostname);
            }
            if existing.class.is_none() {
                existing.class = class;
            }
            continue;
        }
        attached.push(AttachedDevice {
            mac: e.mac.clone(),
            // The interface the FortiGate saw it on, or the SSID when it came
            // in over wireless and there is no wired port to name.
            port: e
                .interface
                .clone()
                .or_else(|| e.fortiap_ssid.clone())
                .unwrap_or_default(),
            address: e.address.clone(),
            vendor: e
                .hardware_vendor
                .clone()
                .or_else(|| crate::oui::vendor(&e.mac).map(str::to_string)),
            hostname: e.hostname.clone(),
            class,
            // A FortiGate interface carries a whole network, so this is not a
            // port count and must not be read as one.
            port_population: 0,
            vlan: None,
        });
    }
}

/// Combines what the two protocols saw of the same link.
///
/// A device running both advertises the same neighbour twice. Keying on the
/// neighbour name and the local port keeps one entry per adjacency; CDP is
/// preferred where they disagree because it carries a platform string and LLDP
/// does not, but an LLDP-only neighbour is kept — that is the whole reason for
/// asking both.
pub fn merge_neighbors(cdp: Vec<Neighbor>, lldp: Vec<Neighbor>) -> Vec<Neighbor> {
    let same = |a: &Neighbor, b: &Neighbor| {
        a.short_name.eq_ignore_ascii_case(&b.short_name)
            && same_interface(
                a.local_interface.as_deref().unwrap_or(""),
                b.local_interface.as_deref().unwrap_or(""),
            )
    };

    let mut merged: Vec<Neighbor> = Vec::new();

    for n in cdp {
        merged.push(n);
    }
    for mut n in lldp {
        if let Some(existing) = merged.iter_mut().find(|e| same(e, &n)) {
            // Fill gaps CDP left rather than discarding the LLDP view entirely.
            if existing.addresses.is_empty() && !n.addresses.is_empty() {
                existing.addresses = std::mem::take(&mut n.addresses);
            }
            if existing.remote_interface.is_none() {
                existing.remote_interface = n.remote_interface.take();
            }
            continue;
        }
        merged.push(n);
    }
    merged
}

/// Whether two interface names refer to the same port.
///
/// CDP prints `GigabitEthernet0/8` and LLDP prints `Gi0/8` for the same port on
/// the same switch. Comparing the strings directly means one adjacency becomes
/// two, and every device running both protocols gets a duplicate edge — which
/// is exactly what a real switch produced the first time this was pointed at
/// one.
///
/// The rule: split each name into its alphabetic prefix and its numeric tail.
/// The tails must match exactly; the shorter prefix must be a prefix of the
/// longer. That makes `Gi` match `GigabitEthernet`, `Te` match
/// `TenGigabitEthernet` and `Po` match `Port-channel`, without inventing a
/// table of abbreviations that would go stale.
pub fn same_interface(a: &str, b: &str) -> bool {
    let split = |s: &str| {
        let s = s.trim().to_ascii_lowercase();
        let head: String = s.chars().take_while(|c| c.is_ascii_alphabetic() || *c == '-').filter(|c| *c != '-').collect();
        let tail: String = s.chars().skip_while(|c| c.is_ascii_alphabetic() || *c == '-').collect();
        (head, tail)
    };
    let (ha, ta) = split(a);
    let (hb, tb) = split(b);
    if ta != tb {
        return false;
    }
    if ha.is_empty() || hb.is_empty() {
        // No alphabetic part at all — compare what is left, so a bare port
        // number is not treated as matching everything.
        return ha == hb && !ta.is_empty();
    }
    ha.starts_with(&hb) || hb.starts_with(&ha)
}

fn first_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).find(|l| !l.is_empty())
}

/// Every chassis serial in a `show version`, in the order the device lists
/// them.
///
/// **A stack is one device with several serials**, and that is the ordinary
/// case in a wiring closet, not an exotic one: a StackWise stack of four
/// switches has one hostname, one management address and one entry on a
/// diagram, but four boxes that can each be RMA'd. Returning only the first
/// would name one member and quietly lose the rest, which is worse than
/// useless on the one field a support case is raised against.
///
/// Read from `show version`, which the crawl already runs. `show inventory` is
/// the fuller answer — it reaches line cards and optics too — but it is
/// another round trip per device, and on a stack `show version` prints a
/// `System Serial Number` per member, which is the question being asked here.
///
/// Deduplicated, because the first member's serial appears both in the summary
/// at the top and again in its own block further down.
pub fn serials_in_version(version: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |candidate: &str| {
        let v = candidate.trim().trim_matches('"').to_ascii_uppercase();
        if looks_like_a_serial(&v) && !out.contains(&v) {
            out.push(v);
        }
    };
    for line in version.lines() {
        let t = line.trim();
        if let Some((label, value)) = t.split_once(':') {
            let l = label.trim().to_ascii_lowercase();
            // "System Serial Number     : FOC1932X0AB", once per stack member.
            // The motherboard's own serial is a different part and is not what
            // a support contract is keyed on, so it is skipped deliberately.
            if l.contains("serial number") && !l.contains("motherboard") {
                push(value);
                continue;
            }
        }
        // IOS and NX-OS single units, which print no "serial number" line at
        // all: "Processor board ID FOC1932X0AB".
        let lower = t.to_ascii_lowercase();
        if let Some(rest) = lower
            .strip_prefix("processor board id")
            .or_else(|| lower.strip_prefix("processor board id:"))
        {
            let offset = t.len() - rest.len();
            if let Some(word) = t[offset..].split_whitespace().next() {
                push(word);
            }
        }
    }
    out
}

/// Whether a token could be a chassis serial.
///
/// Deliberately strict. A wrong serial is worse than a missing one, and a
/// `show version` is full of things that sit next to a colon.
fn looks_like_a_serial(v: &str) -> bool {
    v.len() >= 8
        && v.len() <= 20
        && v.chars().all(|c| c.is_ascii_alphanumeric())
        && v.chars().any(|c| c.is_ascii_digit())
        && v.chars().any(|c| c.is_ascii_alphabetic())
}

/// The serials of a device as one field: `FOC1932X0AB, FOC1932X0CD`.
///
/// A comma and a space, because that is how a person writes a list and the
/// field is read by people. Nothing else in the app splits on it — the CSV
/// writer quotes a cell containing commas, so this survives a round trip
/// through a spreadsheet.
pub fn serial_field(serials: &[String]) -> Option<String> {
    (!serials.is_empty()).then(|| serials.join(", "))
}

/// Pulls a model out of a `show version` banner, for classification.
fn platform_from_version(version: &str) -> Option<String> {
    // A `show version` on a Catalyst runs to sixty lines and puts "Model
    // number" near the bottom, past where a short scan would look.
    for line in version.lines().take(80) {
        let t = line.trim();
        // "Model number            : WS-C2960X-24TS-L"
        if let Some((label, value)) = t.split_once(':') {
            let l = label.trim().to_ascii_lowercase();
            if l.contains("model number") || l.contains("model") && l.contains("hardware") {
                let v = value.trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
        // "cisco WS-C2960X-24TS-L (PowerPC405) processor" — and the same line
        // is capitalised on some trains.
        let lower = t.to_ascii_lowercase();
        if let Some(offset) = lower.strip_prefix("cisco ").map(|_| "cisco ".len()) {
            let rest = &t[offset..];
            if let Some(model) = rest.split_whitespace().next() {
                if model.len() > 3 {
                    return Some(model.to_string());
                }
            }
        }
    }
    // NX-OS puts the family in the banner rather than a model line.
    first_line(version).map(str::to_string)
}

#[cfg(test)]
mod serial_tests {
    use super::{serial_field, serials_in_version};

    /// A four-member StackWise stack, in the shape IOS prints it: a summary
    /// serial at the top and a block per switch below.
    const STACK: &str = "\
Cisco IOS Software, IOS-XE Software, Catalyst L3 Switch Software
Technology Package License Information:

System Serial Number            : FOC1932X0AA
Motherboard Serial Number       : FOC1932MOTH

Switch 02
---------
Switch uptime                   : 40 weeks, 2 days
Base Ethernet MAC Address       : 00:11:22:33:44:55
System Serial Number            : FOC1932X0BB

Switch 03
---------
System Serial Number            : FOC1932X0CC

Switch 04
---------
System Serial Number            : FOC1932X0DD
";

    #[test]
    fn a_stack_yields_every_members_serial_in_order() {
        // The case this exists for. One hostname, one address, one node on the
        // diagram — four boxes that can each be RMA'd.
        assert_eq!(
            serials_in_version(STACK),
            vec!["FOC1932X0AA", "FOC1932X0BB", "FOC1932X0CC", "FOC1932X0DD"]
        );
    }

    #[test]
    fn the_motherboard_serial_is_not_the_chassis_serial() {
        // A different part, and not what a support contract is keyed on.
        assert!(!serials_in_version(STACK).contains(&"FOC1932MOTH".to_string()));
    }

    #[test]
    fn the_same_serial_printed_twice_is_listed_once() {
        let twice = "System Serial Number : FOC1932X0AA\n\
                     Switch 01\n\
                     System Serial Number : FOC1932X0AA\n";
        assert_eq!(serials_in_version(twice), vec!["FOC1932X0AA"]);
    }

    #[test]
    fn a_single_switch_that_prints_no_serial_line_still_gives_one_up() {
        // IOS and NX-OS on a lone unit: no "serial number" label anywhere.
        let ios = "cisco WS-C2960X-24TS-L (PowerPC405) processor (revision H0)\n\
                   Processor board ID FOC1932X0AB\n";
        assert_eq!(serials_in_version(ios), vec!["FOC1932X0AB"]);
    }

    #[test]
    fn nothing_that_merely_sits_next_to_a_colon_is_taken_for_a_serial() {
        let noise = "\
Technology Package License Information: none
System Serial Number            :
Uptime                          : 40 weeks
Configuration register is 0x2102
";
        assert_eq!(serials_in_version(noise), Vec::<String>::new());
    }

    #[test]
    fn the_field_reads_as_a_list_a_person_would_write() {
        assert_eq!(
            serial_field(&serials_in_version(STACK)).as_deref(),
            Some("FOC1932X0AA, FOC1932X0BB, FOC1932X0CC, FOC1932X0DD")
        );
        assert_eq!(serial_field(&[]), None);
    }
}

#[cfg(test)]
mod tests {

    /// LT-278: every event reaches the interface under its own kind. The
    /// failure and SSH-progress payloads carry a `kind` of their own, and an
    /// internally tagged enum wrote both keys — a browser keeps the last, so
    /// the panel saw `auth-rejected` or `awaitingSecondFactor` and never
    /// `failed` or `ssh`.
    #[test]
    fn every_event_arrives_under_its_own_kind() {
        let kind_of = |e: &CrawlEvent| -> Vec<String> {
            let text = serde_json::to_string(e).unwrap();
            // The top-level "kind" keys, as a browser would meet them: each one
            // before the first nested object opens.
            let top = &text[..text[1..].find('{').map(|i| i + 1).unwrap_or(text.len())];
            top.match_indices("\"kind\":\"").map(|(i, m)| {
                let rest = &top[i + m.len()..];
                rest[..rest.find('"').unwrap()].to_string()
            }).collect()
        };
        let failed = CrawlEvent::Failed { failure: CrawlFailure {
            address: "192.0.2.1".into(),
            reason: "rejected".into(),
            kind: FailureKind::AuthRejected,
        } };
        assert_eq!(kind_of(&failed), vec!["failed"], "{}", serde_json::to_string(&failed).unwrap());
        let push = CrawlEvent::Ssh { progress: SshProgress::AwaitingSecondFactor { host: "192.0.2.1".into(), message: "Approve".into() } };
        assert_eq!(kind_of(&push), vec!["ssh"], "{}", serde_json::to_string(&push).unwrap());
    }
    use super::*;
    use crate::types::{DeviceAddress, Protocol};

    fn neighbor(name: &str, local: &str, protocol: Protocol) -> Neighbor {
        Neighbor {
            serial: None,
            device_id: name.into(),
            short_name: name.into(),
            addresses: vec![],
            local_interface: Some(local.into()),
            remote_interface: Some("Gi0/1".into()),
            platform: None,
            capabilities: vec![],
            version: None,
            class: DeviceClass::Switch,
            discovered_by: protocol,
            chassis_id: None,
            vendor: None,
        }
    }

    #[test]
    fn one_adjacency_seen_by_both_protocols_is_one_neighbour() {
        // A device running CDP and LLDP advertises the same link twice, and
        // drawing it twice puts two edges between the same pair of nodes.
        let cdp = vec![neighbor("SW2", "Gi1/0/1", Protocol::Cdp)];
        let lldp = vec![neighbor("SW2", "Gi1/0/1", Protocol::Lldp)];
        let merged = merge_neighbors(cdp, lldp);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].discovered_by, Protocol::Cdp, "CDP carries a platform string");
    }

    #[test]
    fn an_lldp_only_neighbour_survives_the_merge() {
        // The entire reason for asking both: this is the Aruba switch CDP
        // cannot see.
        let cdp = vec![neighbor("SW2", "Gi1/0/1", Protocol::Cdp)];
        let lldp = vec![neighbor("ARUBA-1", "Gi1/0/9", Protocol::Lldp)];
        let merged = merge_neighbors(cdp, lldp);
        assert_eq!(merged.len(), 2);
        assert!(merged.iter().any(|n| n.short_name == "ARUBA-1"));
    }

    #[test]
    fn the_same_name_on_a_different_port_is_a_different_link() {
        // Two links to the same neighbour is a normal thing — a port channel
        // seen as two adjacencies — and collapsing them loses a real edge.
        let cdp = vec![
            neighbor("SW2", "Gi1/0/1", Protocol::Cdp),
            neighbor("SW2", "Gi1/0/2", Protocol::Cdp),
        ];
        let merged = merge_neighbors(cdp, vec![]);
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn lldp_fills_in_what_cdp_left_blank() {
        let mut cdp_entry = neighbor("SW2", "Gi1/0/1", Protocol::Cdp);
        cdp_entry.addresses = vec![];
        let mut lldp_entry = neighbor("SW2", "Gi1/0/1", Protocol::Lldp);
        lldp_entry.addresses = vec![DeviceAddress::management("10.1.1.2")];

        let merged = merge_neighbors(vec![cdp_entry], vec![lldp_entry]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].addresses.len(), 1, "the address LLDP knew was dropped");
        assert_eq!(merged[0].addresses[0].ip, "10.1.1.2");
    }

    #[test]
    fn cdp_and_lldp_names_for_one_port_are_the_same_port() {
        // From a real switch: CDP said GigabitEthernet0/8 and LLDP said Gi0/8
        // for the same access point, and the diagram gained a duplicate edge.
        assert!(same_interface("GigabitEthernet0/8", "Gi0/8"));
        assert!(same_interface("Gi0/8", "GigabitEthernet0/8"));
        assert!(same_interface("TenGigabitEthernet1/0/1", "Te1/0/1"));
        assert!(same_interface("Port-channel10", "Po10"));
        assert!(same_interface("Ethernet1/1", "Eth1/1"));
        assert!(same_interface("Gi0/8", "gi0/8"));
    }

    #[test]
    fn different_ports_are_not_merged() {
        // The failure in the other direction loses a real link.
        assert!(!same_interface("GigabitEthernet0/8", "Gi0/9"));
        assert!(!same_interface("GigabitEthernet1/0/8", "Gi0/8"));
        assert!(!same_interface("Gi0/1", "Te0/1"), "different media, same number");
        assert!(!same_interface("", ""));
    }

    #[test]
    fn one_adjacency_named_two_ways_merges_into_one() {
        let cdp = vec![neighbor("AP-1", "GigabitEthernet0/8", Protocol::Cdp)];
        let lldp = vec![neighbor("AP-1", "Gi0/8", Protocol::Lldp)];
        assert_eq!(merge_neighbors(cdp, lldp).len(), 1);
    }

    #[test]
    fn a_catalyst_version_banner_classifies_as_a_switch() {
        // A real C2960CX came back Unknown: the model line sits past the first
        // thirty lines, and the family was missing from the switch list.
        let banner = "\
Cisco IOS Software, C2960CX Software (C2960CX-UNIVERSALK9-M), Version 15.2(7)E, RELEASE SOFTWARE (fc3)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 1986-2019 by Cisco Systems, Inc.

LAB-CORE-SW1 uptime is 5 weeks
System image file is \"flash:/c2960cx-universalk9-mz.152-7.E.bin\"
";
        let platform = platform_from_version(banner).unwrap();
        assert_eq!(
            crate::classify::classify(Some(&platform), &[], Some(banner)),
            DeviceClass::Switch,
            "platform was {platform:?}"
        );
    }

    #[test]
    fn a_model_is_pulled_from_a_version_banner() {
        let ios = "\
Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(4)E7
cisco WS-C2960X-24TS-L (APM86XXX) processor (revision H0) with 524288K bytes
Model number            : WS-C2960X-24TS-L
";
        assert_eq!(
            platform_from_version(ios).as_deref(),
            Some("WS-C2960X-24TS-L")
        );
    }

    #[test]
    fn an_unrecognised_banner_still_yields_something_to_classify_on() {
        let nxos = "Cisco Nexus Operating System (NX-OS) Software\nVersion 9.3(3)";
        let p = platform_from_version(nxos).unwrap();
        assert!(p.contains("Nexus"), "got {p}");
        // And that is enough for the classifier.
        assert_eq!(
            crate::classify::classify(Some(&p), &[], None),
            DeviceClass::Switch
        );
    }

    /// LT-144. The operator asked whether 8 seconds was too short for a
    /// normal device. Measured on his own subnet the same day: the Cisco at
    /// .7 and the FortiSwitch at .203 answer every open port in 0.00s, while
    /// the two FortiAPs answer nothing at all. So a timeout never means
    /// "slow" on a LAN — it means the packets are going nowhere, and the
    /// message has to say which nowhere.
    #[test]
    fn every_failure_kind_says_what_to_do_about_it() {
        for kind in [
            FailureKind::ReachableNoSsh,
            FailureKind::Unreachable,
            FailureKind::Refused,
            FailureKind::AuthRejected,
            FailureKind::AuthTimedOut,
            FailureKind::NoPrompt,
            FailureKind::HostKeyChanged,
            FailureKind::CommandTimedOut,
        ] {
            let advice = kind.advice();
            assert!(!advice.is_empty(), "{kind:?} has no advice");
            // None of them may tell the operator the device was merely slow,
            // which is the reading "did not answer within 8s" invites.
            assert!(
                !advice.to_ascii_lowercase().contains("slow"),
                "{kind:?} suggests the device is slow: {advice}"
            );
        }
    }

    /// The two an operator most needs told apart must not be the same thing.
    #[test]
    fn up_without_ssh_is_not_the_same_as_nothing_there() {
        assert_ne!(FailureKind::ReachableNoSsh, FailureKind::Unreachable);
        assert_ne!(
            FailureKind::ReachableNoSsh.advice(),
            FailureKind::Unreachable.advice()
        );
        // The one that is up should point at SSH, not at the address.
        assert!(FailureKind::ReachableNoSsh.advice().contains("SSH"));
    }

    /// An error that names its own cause is classified from the error alone;
    /// only a timeout or a bare connect error needs the network asked.
    #[tokio::test]
    async fn an_error_that_knows_its_cause_needs_no_ping() {
        use crate::ssh::SshError;
        let cases = [
            (SshError::AuthFailed { host: "h".into() }, FailureKind::AuthRejected),
            (SshError::NoPrompt { host: "h".into() }, FailureKind::NoPrompt),
            (SshError::HostKeyChanged("changed".into()), FailureKind::HostKeyChanged),
            (
                SshError::CommandTimeout { host: "h".into(), command: "show run".into() },
                FailureKind::CommandTimedOut,
            ),
            (
                SshError::AuthTimeout { host: "h".into(), timeout: Duration::from_secs(90) },
                FailureKind::AuthTimedOut,
            ),
            (
                SshError::Connect {
                    host: "h".into(),
                    port: 22,
                    source: std::io::Error::from(std::io::ErrorKind::ConnectionRefused),
                },
                FailureKind::Refused,
            ),
        ];
        for (error, want) in cases {
            // An address that cannot parse means `answers_ping` is never
            // consulted, so this asserts the error-only path.
            assert_eq!(classify_failure(&error, "not-an-address").await, want);
        }
    }

    /// A timeout against an address nothing answers is "nothing there", not
    /// a slow device — which is the whole correction.
    #[tokio::test]
    async fn a_timeout_with_no_ping_is_nothing_there() {
        use crate::ssh::SshError;
        // RFC 5737 documentation range: guaranteed to answer nothing.
        let error =
            SshError::ConnectTimeout { host: "192.0.2.1".into(), timeout: Duration::from_secs(8) };
        assert_eq!(classify_failure(&error, "192.0.2.1").await, FailureKind::Unreachable);
    }

    #[test]
    fn snmp_is_off_unless_asked_for() {
        // A community string is a credential; using one nobody supplied would
        // be surprising, and an estate without SNMP should see no attempts.
        assert!(CrawlOptions::default().snmp.is_empty());
    }

    #[test]
    fn how_a_device_was_reached_is_recorded() {
        // The distinction matters: SSH gives neighbours and an interface
        // table, SNMP gives a name. Presenting them identically would imply
        // the map is more complete than it is.
        assert_ne!(ReachedBy::Ssh, ReachedBy::Snmp);
        let json = serde_json::to_string(&ReachedBy::Snmp).unwrap();
        assert_eq!(json, "\"snmp\"", "the interface reads this");
    }

    #[test]
    fn crawl_options_default_to_something_survivable() {
        // These are the guards against a crawl that never ends: a link nobody
        // remembered, a routing loop, a lab connected to production.
        let o = CrawlOptions::default();
        assert!(o.max_hops > 0 && o.max_hops <= 16);
        assert!(o.max_devices > 0);
        assert!(o.concurrency >= 1);
        assert!(!o.second_factor, "opt in, since most estates do not use it");
    }
}

#[cfg(test)]
mod endpoint_merge_tests {
    use super::*;
    use crate::fortios::Endpoint;

    fn switch_saw(mac: &str, port: &str) -> AttachedDevice {
        AttachedDevice {
            mac: mac.to_string(),
            port: port.to_string(),
            address: None,
            vendor: Some("Hewlett Packard".to_string()),
            hostname: None,
            class: None,
            port_population: 1,
            vlan: None,
        }
    }

    fn fortigate_knows(mac: &str, hostname: &str, kind: &str) -> Endpoint {
        Endpoint {
            mac: mac.to_string(),
            address: Some("192.168.77.71".to_string()),
            hostname: Some(hostname.to_string()),
            hardware_type: Some(kind.to_string()),
            interface: Some("internal3".to_string()),
            online: true,
            ..Endpoint::default()
        }
    }

    #[test]
    fn one_device_seen_twice_stays_one_device() {
        // The switch has the MAC on a port; the FortiGate has the same MAC
        // with a name. Two entries here would draw the printer twice.
        let mut attached = vec![switch_saw("aa:bb:cc:dd:ee:ff", "port5")];
        merge_endpoints(
            &mut attached,
            &[fortigate_knows("aa:bb:cc:dd:ee:ff", "HPLJ-3rdfloor", "Printer")],
        );
        assert_eq!(attached.len(), 1);
        assert_eq!(attached[0].hostname.as_deref(), Some("HPLJ-3rdfloor"));
        assert_eq!(attached[0].class, Some(crate::types::DeviceClass::Printer));
    }

    #[test]
    fn the_port_the_switch_saw_is_kept() {
        // "port5" is where the cable is. "internal3" is which FortiGate leg
        // the traffic came in on — true, but useless for finding the device.
        let mut attached = vec![switch_saw("aa:bb:cc:dd:ee:ff", "port5")];
        merge_endpoints(
            &mut attached,
            &[fortigate_knows("aa:bb:cc:dd:ee:ff", "HPLJ-3rdfloor", "Printer")],
        );
        assert_eq!(attached[0].port, "port5");
    }

    #[test]
    fn an_address_the_switch_lacked_is_filled_in() {
        let mut attached = vec![switch_saw("aa:bb:cc:dd:ee:ff", "port5")];
        merge_endpoints(
            &mut attached,
            &[fortigate_knows("aa:bb:cc:dd:ee:ff", "HPLJ-3rdfloor", "Printer")],
        );
        assert_eq!(attached[0].address.as_deref(), Some("192.168.77.71"));
    }

    #[test]
    fn a_device_only_the_fortigate_saw_is_added() {
        let mut attached = Vec::new();
        merge_endpoints(
            &mut attached,
            &[fortigate_knows("aa:bb:cc:dd:ee:ff", "DESKTOP-QA1", "Computer")],
        );
        assert_eq!(attached.len(), 1);
        assert_eq!(attached[0].port, "internal3");
    }

    #[test]
    fn a_wireless_device_is_labelled_with_its_ssid() {
        // There is no wired port to name, and an empty port would read as a
        // device nobody can locate.
        let mut attached = Vec::new();
        let wireless = Endpoint {
            mac: "3c:22:fb:aa:bb:cc".to_string(),
            hostname: Some("iPhone".to_string()),
            fortiap_ssid: Some("CorpWiFi".to_string()),
            ..Endpoint::default()
        };
        merge_endpoints(&mut attached, &[wireless]);
        assert_eq!(attached[0].port, "CorpWiFi");
    }

    #[test]
    fn a_fortigate_leg_is_not_reported_as_a_port_count() {
        // One FortiGate interface carries a whole network. Reporting a
        // population would make the uplink heuristic treat every endpoint
        // behind it as a switch.
        let mut attached = Vec::new();
        merge_endpoints(
            &mut attached,
            &[fortigate_knows("aa:bb:cc:dd:ee:ff", "DESKTOP-QA1", "Computer")],
        );
        assert_eq!(attached[0].port_population, 0);
    }

    #[test]
    fn the_oui_still_answers_when_the_fortigate_does_not() {
        let mut attached = Vec::new();
        let bare = Endpoint {
            mac: crate::arp::normalise_mac("00:00:0c:11:22:33").expect("a valid MAC"),
            ..Endpoint::default()
        };
        merge_endpoints(&mut attached, &[bare]);
        assert!(attached[0].vendor.is_some(), "OUI lookup should have named it");
    }

    #[test]
    fn nothing_from_the_fortigate_changes_nothing() {
        let mut attached = vec![switch_saw("aa:bb:cc:dd:ee:ff", "port5")];
        merge_endpoints(&mut attached, &[]);
        assert_eq!(attached.len(), 1);
        assert_eq!(attached[0].hostname, None);
    }

    // ------------------------------------------------ LT-156: the gateway

    fn tried(addresses: &[&str]) -> HashSet<String> {
        addresses.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn a_default_gateway_is_queued_like_a_neighbour() {
        let options = CrawlOptions::default();
        assert_eq!(gateway_to_visit(Some("192.0.2.1"), 0, &options, &tried(&[])), Some("192.0.2.1"));
    }

    #[test]
    fn no_route_means_nothing_to_visit() {
        let options = CrawlOptions::default();
        assert_eq!(gateway_to_visit(None, 0, &options, &tried(&[])), None);
        assert_eq!(gateway_to_visit(Some("  "), 0, &options, &tried(&[])), None);
    }

    #[test]
    fn a_gateway_outside_the_allowed_subnets_is_not_dialled() {
        let mut options = CrawlOptions::default();
        options.filter.subnets = vec![coreview_probe::sweep::parse_cidr("192.0.2.0/24").unwrap()];
        assert_eq!(gateway_to_visit(Some("198.51.100.1"), 0, &options, &tried(&[])), None);
        options.filter.exclude_subnets = vec![coreview_probe::sweep::parse_cidr("192.0.2.1/32").unwrap()];
        assert_eq!(gateway_to_visit(Some("192.0.2.1"), 0, &options, &tried(&[])), None, "excluded wins");
    }

    #[test]
    fn the_hop_limit_and_the_visited_set_still_apply_to_a_gateway() {
        let options = CrawlOptions { max_hops: 1, ..Default::default() };
        assert_eq!(gateway_to_visit(Some("192.0.2.1"), 1, &options, &tried(&[])), None, "one hop too far");
        assert_eq!(gateway_to_visit(Some("192.0.2.1"), 0, &options, &tried(&[])), Some("192.0.2.1"));
        assert_eq!(gateway_to_visit(Some("192.0.2.1"), 0, &options, &tried(&["192.0.2.1"])), None, "already tried");
    }
}
