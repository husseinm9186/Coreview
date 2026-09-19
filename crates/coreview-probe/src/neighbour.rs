//! The MAC address behind an address, read from this machine's own neighbour
//! table (LT-121).
//!
//! A ping that gets a reply has already done the work: to send the echo
//! request at all, the kernel had to resolve the target's hardware address,
//! so by the time the reply lands the ARP entry exists. This just reads it
//! back. Nothing here sends a packet of its own.
//!
//! **Only for hosts on this segment, and that is the point.** ARP is link
//! local. An address behind a router has no entry here — the kernel resolved
//! the *gateway*, not the host — so a routed sweep reports no MAC rather than
//! reporting the gateway's, which would label every remote host with the
//! router's manufacturer. The absence is the correct answer and comes for
//! free.
//!
//! **One parser for three platforms.** Linux has `/proc/net/arp`, Windows has
//! `arp -a`, macOS and the BSDs have `arp -an`, and all three lay a line out
//! differently:
//!
//! ```text
//! 192.168.77.1     0x1    0x2    00:0c:e6:00:00:a0    *    eth0     # Linux
//!   192.168.77.1          00-0c-e6-00-00-a0     dynamic             # Windows
//! ? (192.168.77.1) at 0:c:e6:0:0:a0 on en0 ifscope [ethernet]     # macOS
//! ```
//!
//! What they agree on is that the line holds an IPv4 address and a hardware
//! address, so the parser looks for exactly those two and ignores the shape
//! around them. That also side-steps the column headings, which Windows
//! localises — a parser keyed on "Physical Address" reads nothing on a German
//! machine.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::time::{Duration, Instant};

/// How long a snapshot of the table is reused before it is read again.
///
/// The table is read once for a burst of hosts rather than once per host: a
/// /24 at 64 in flight would otherwise spawn 254 copies of `arp`.
const SNAPSHOT_TTL: Duration = Duration::from_millis(500);

/// A miss is worth one re-read if the snapshot is older than this, because a
/// host that answered a moment ago may have landed in the table just after
/// the snapshot was taken. Without it the first hosts of a sweep report no
/// MAC purely on timing.
const MISS_REFRESH_AFTER: Duration = Duration::from_millis(100);

/// A snapshot of the neighbour table.
#[derive(Debug, Default, Clone)]
pub struct Neighbours {
    entries: HashMap<Ipv4Addr, String>,
}

impl Neighbours {
    /// The MAC this machine has for an address, lowercase and colon-separated.
    pub fn mac_for(&self, ip: &Ipv4Addr) -> Option<&str> {
        self.entries.get(ip).map(String::as_str)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Reads the table, re-reading only when what it holds has gone stale.
///
/// Shared across a sweep's tasks. Every method takes `&self` and locks
/// internally, so a caller does not have to hold a lock across an await.
#[derive(Debug)]
pub struct NeighbourCache {
    inner: std::sync::Mutex<Snapshot>,
}

#[derive(Debug)]
struct Snapshot {
    taken: Option<Instant>,
    table: Neighbours,
}

impl Default for NeighbourCache {
    fn default() -> Self {
        Self::new()
    }
}

impl NeighbourCache {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(Snapshot { taken: None, table: Neighbours::default() }),
        }
    }

    /// The MAC for an address, reading the table again if what is held is
    /// stale — or if this address is missing from a snapshot old enough that
    /// the entry could have arrived since.
    ///
    /// Blocking: reading `/proc` is a file read and the other platforms spawn
    /// `arp`. Call it from a blocking context, which is what the sweep does.
    pub fn mac_for(&self, ip: &Ipv4Addr) -> Option<String> {
        let mut held = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let age = held.taken.map(|t| t.elapsed());
        let stale = match age {
            None => true,
            Some(a) => a >= SNAPSHOT_TTL,
        };
        if stale {
            held.table = read_table();
            held.taken = Some(Instant::now());
        }
        if let Some(mac) = held.table.mac_for(ip) {
            return Some(mac.to_string());
        }
        // A miss on a snapshot that predates this host's reply is worth one
        // more look; a miss on a fresh one means there is genuinely no entry.
        let worth_retrying = held.taken.map(|t| t.elapsed() >= MISS_REFRESH_AFTER).unwrap_or(true);
        if worth_retrying {
            held.table = read_table();
            held.taken = Some(Instant::now());
            return held.table.mac_for(ip).map(str::to_string);
        }
        None
    }
}

/// Reads the platform's neighbour table. An unreadable table is an empty one:
/// a sweep that cannot name manufacturers is still a sweep.
pub fn read_table() -> Neighbours {
    Neighbours { entries: parse_table(&raw_table()) }
}

#[cfg(target_os = "linux")]
fn raw_table() -> String {
    std::fs::read_to_string("/proc/net/arp").unwrap_or_default()
}

#[cfg(not(target_os = "linux"))]
fn raw_table() -> String {
    // `-a` on Windows, `-an` elsewhere: BSD `arp -a` resolves every address
    // through DNS, which turns reading a table into a few hundred lookups.
    let args: &[&str] = if cfg!(windows) { &["-a"] } else { &["-an"] };
    let mut cmd = std::process::Command::new("arp");
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window when the app is run from the shell-less bundle.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout).into_owned(),
        Err(_) => String::new(),
    }
}

/// Pulls `(address, mac)` out of whatever the platform printed.
///
/// Split from the reading so it can be tested against all three real formats
/// on any machine — the thing worth testing is the parsing, and a test that
/// depended on the host's own ARP table would prove nothing and pass by luck.
pub fn parse_table(text: &str) -> HashMap<Ipv4Addr, String> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let (Some(ip), Some(mac)) = (find_ipv4(line), find_mac(line)) else { continue };
        if !usable(&ip, &mac) {
            continue;
        }
        out.insert(ip, mac);
    }
    out
}

/// The first thing on the line that parses as an IPv4 address.
///
/// Parentheses and a trailing `)` are stripped because that is how macOS
/// writes it: `? (192.168.77.1) at ...`.
fn find_ipv4(line: &str) -> Option<Ipv4Addr> {
    line.split(|c: char| c.is_whitespace() || c == '(' || c == ')')
        .find_map(|tok| tok.parse::<Ipv4Addr>().ok())
}

/// The first thing on the line that looks like a hardware address, normalised
/// to lowercase colon-separated octets.
///
/// Accepts `:` and `-` separators and single-digit octets, which is macOS's
/// spelling (`0:c:e6:...`). Rejects anything that is not six octets, which is
/// what keeps the Linux `Mask` column and Windows's `Type` column out.
fn find_mac(line: &str) -> Option<String> {
    line.split_whitespace().find_map(parse_mac)
}

fn parse_mac(token: &str) -> Option<String> {
    let sep = if token.contains(':') {
        ':'
    } else if token.contains('-') {
        '-'
    } else {
        return None;
    };
    let parts: Vec<&str> = token.split(sep).collect();
    if parts.len() != 6 {
        return None;
    }
    let mut octets = Vec::with_capacity(6);
    for p in parts {
        if p.is_empty() || p.len() > 2 || !p.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        octets.push(format!("{:02x}", u8::from_str_radix(p, 16).ok()?));
    }
    Some(octets.join(":"))
}

/// Whether an entry says anything. An incomplete ARP entry is written as all
/// zeroes on Linux, broadcast and multicast rows are the machine talking to
/// itself, and neither is a device anybody wants in a list.
fn usable(ip: &Ipv4Addr, mac: &str) -> bool {
    if mac == "00:00:00:00:00:00" || mac == "ff:ff:ff:ff:ff:ff" {
        return false;
    }
    if ip.is_broadcast() || ip.is_multicast() || ip.is_unspecified() {
        return false;
    }
    // 01:00:5e:… is IPv4 multicast at the link layer; 33:33:… is IPv6's.
    !(mac.starts_with("01:00:5e") || mac.starts_with("33:33"))
}

/// Whether a MAC is one the device made up for itself.
///
/// Bit 1 of the first octet is the "locally administered" flag. Phones and
/// laptops set it when they randomise their address for privacy, and the
/// result belongs to no manufacturer — looking it up in the IEEE registry
/// either finds nothing or, worse, finds whoever happens to own that prefix.
pub fn is_locally_administered(mac: &str) -> bool {
    let Some(first) = mac.split([':', '-', '.']).next() else { return false };
    let Ok(byte) = u8::from_str_radix(first, 16) else { return false };
    byte & 0b10 != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real `/proc/net/arp` from the Linux machine this was written on.
    #[test]
    fn reads_the_linux_table() {
        let text = "\
IP address       HW type     Flags       HW address            Mask     Device
192.168.77.1     0x1         0x2         00:0c:e6:00:00:a0     *        enp3s0
192.168.77.203   0x1         0x2         e8:1c:ba:00:00:02     *        enp3s0
192.168.77.77    0x1         0x0         00:00:00:00:00:00     *        enp3s0
";
        let t = parse_table(text);
        assert_eq!(t.len(), 2, "{t:?}");
        assert_eq!(t[&"192.168.77.1".parse().unwrap()], "00:0c:e6:00:00:a0");
        assert_eq!(t[&"192.168.77.203".parse().unwrap()], "e8:1c:ba:00:00:02");
        // Flags 0x0 with an all-zero address is an incomplete entry: the
        // kernel asked and nothing answered. Reporting it as a device would
        // put a host in the list that is not there.
        assert!(!t.contains_key(&"192.168.77.77".parse().unwrap()));
    }

    /// Windows writes octets with `-`, and localises the headings — which is
    /// why nothing here reads them.
    #[test]
    fn reads_the_windows_table() {
        let text = "\r
Interface: 192.168.77.50 --- 0x5\r
  Internet Address      Physical Address      Type\r
  192.168.77.1          00-0c-e6-00-00-a0     dynamic\r
  192.168.77.221        24-5e-be-00-00-9e     dynamic\r
  192.168.77.255        ff-ff-ff-ff-ff-ff     static\r
  239.255.255.250       01-00-5e-7f-ff-fa     static\r
";
        let t = parse_table(text);
        assert_eq!(t.len(), 2, "{t:?}");
        assert_eq!(t[&"192.168.77.221".parse().unwrap()], "24:5e:be:00:00:9e");
        // The broadcast and multicast rows are this machine talking to the
        // wire, not hosts.
        assert!(!t.contains_key(&"192.168.77.255".parse().unwrap()));
        assert!(!t.contains_key(&"239.255.255.250".parse().unwrap()));
    }

    /// macOS drops leading zeroes, so `0:c:e6` has to come back as `00:0c:e6`
    /// or the OUI lookup misses every Fortinet on the network.
    #[test]
    fn reads_the_macos_table() {
        let text = "\
? (192.168.77.1) at 0:c:e6:0:0:a0 on en0 ifscope [ethernet]
? (192.168.77.203) at e8:1c:ba:00:00:02 on en0 ifscope [ethernet]
? (192.168.77.99) at (incomplete) on en0 ifscope [ethernet]
";
        let t = parse_table(text);
        assert_eq!(t.len(), 2, "{t:?}");
        assert_eq!(t[&"192.168.77.1".parse().unwrap()], "00:0c:e6:00:00:a0");
        assert!(!t.contains_key(&"192.168.77.99".parse().unwrap()));
    }

    /// The parsed MACs have to be in the shape the OUI table reads, or the
    /// manufacturer column stays empty however well the table parses.
    #[test]
    fn what_is_parsed_feeds_the_vendor_lookup() {
        let t = parse_table("192.168.77.221 0x1 0x2 24:5e:be:00:00:9e * eth0");
        let mac = &t[&"192.168.77.221".parse().unwrap()];
        assert_eq!(crate::oui::vendor(mac), Some("QNAP Systems"));
    }

    #[test]
    fn a_line_with_no_address_is_not_an_entry() {
        assert!(parse_table("Interface: 192.168.77.50 --- 0x5").is_empty());
        assert!(parse_table("  Internet Address      Physical Address      Type").is_empty());
        assert!(parse_table("").is_empty());
    }

    #[test]
    fn a_randomised_address_is_recognised() {
        // Second bit of the first octet set: the device invented this.
        assert!(is_locally_administered("02:1a:2b:3c:4d:5e"));
        assert!(is_locally_administered("7a:00:00:00:00:01"));
        // Real registered prefixes are not.
        assert!(!is_locally_administered("24:5e:be:00:00:9e"));
        assert!(!is_locally_administered("00:0c:e6:00:00:a0"));
        assert!(!is_locally_administered("e8:1c:ba:00:00:02"));
    }
}
