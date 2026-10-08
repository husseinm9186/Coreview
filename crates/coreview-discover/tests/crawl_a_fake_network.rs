//! Crawls a small fake network end to end.
//!
//! Two SSH servers stand in for two switches, on 127.0.0.1 and 127.0.0.2 — the
//! whole of 127.0.0.0/8 is loopback, so both can listen on the same port and
//! the crawler can reach them the way it would reach real devices, by address
//! alone.
//!
//! The topology is deliberately awkward:
//!
//! * SW1 advertises SW2, and SW2 advertises SW1 straight back. A crawler
//!   without a visited set loops between them forever.
//! * SW2 also advertises an access point, which must appear in the results and
//!   must not be logged into.
//! * SW2 advertises an Aruba switch over LLDP only, which a CDP-only crawl
//!   would never see.

use std::sync::Arc;
use std::time::Duration;

use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use coreview_discover::crawl::{crawl, CrawlEvent, CrawlOptions};
use coreview_discover::filter::DiscoveryFilter;
use coreview_discover::hostkeys::HostKeyStore;
use coreview_discover::ssh::{Credentials, Secret, SshOptions};
use coreview_discover::types::DeviceClass;
use coreview_probe::sweep::parse_cidr;

/// CDP as SW1 sees the world: one neighbour, SW2 at 127.0.0.2.
fn sw1_cdp() -> String {
    "-------------------------\r\n\
     Device ID: SW2.lab.example.com\r\n\
     Entry address(es):\r\n  IP address: 127.0.0.2\r\n\
     Platform: cisco WS-C2960X-24TS-L,  Capabilities: Switch IGMP\r\n\
     Interface: GigabitEthernet1/0/1,  Port ID (outgoing port): GigabitEthernet1/0/2\r\n\
     Holdtime : 137 sec\r\n\r\n\
     Total cdp entries displayed : 1\r\n"
        .into()
}

/// SW2 points back at SW1 — the loop — and adds an access point.
fn sw2_cdp() -> String {
    "-------------------------\r\n\
     Device ID: SW1.lab.example.com\r\n\
     Entry address(es):\r\n  IP address: 127.0.0.1\r\n\
     Platform: cisco WS-C3850-48P,  Capabilities: Router Switch\r\n\
     Interface: GigabitEthernet1/0/2,  Port ID (outgoing port): GigabitEthernet1/0/1\r\n\
     Holdtime : 140 sec\r\n\r\n\
     -------------------------\r\n\
     Device ID: AP-FLOOR2\r\n\
     Entry address(es):\r\n  IP address: 127.0.0.9\r\n\
     Platform: cisco AIR-CAP2702I-E-K9,  Capabilities: Trans-Bridge\r\n\
     Interface: GigabitEthernet1/0/7,  Port ID (outgoing port): GigabitEthernet0\r\n\
     Holdtime : 155 sec\r\n\r\n\
     Total cdp entries displayed : 2\r\n"
        .into()
}

/// An Aruba switch, visible over LLDP only.
fn sw2_lldp() -> String {
    "------------------------------------------------\r\n\
     Local Intf: Gi1/0/12\r\n\
     Chassis id: 001a.2b3c.4d5e\r\n\
     Port id: 001a.2b3c.4d60\r\n\
     Port Description: 1/1/1\r\n\
     System Name: ARUBA-EDGE-1\r\n\r\n\
     System Description:\r\n\
     ArubaOS-CX GL_10.09.1010, Aruba 6300M\r\n\r\n\
     Time remaining: 97 seconds\r\n\
     Enabled Capabilities: B,R\r\n\
     Management Addresses:\r\n    IP: 203.0.113.40\r\n\r\n\
     Total entries displayed: 1\r\n"
        .into()
}

/// Which dialect a fake switch answers in.
///
/// A Dell's answers are a different shape, and the crawl has to notice
/// from `show version` alone. Testing the parsers proves they read Dell output;
/// only this proves the crawl ever hands them any.
/// Every command every fake was asked, by hostname.
static ASKED: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

fn asked_of(hostname: &str) -> Vec<String> {
    ASKED.lock().unwrap().iter().filter(|(h, _)| h == hostname).map(|(_, c)| c.clone()).collect()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Flavour {
    Cisco,
    DellOs10,
    /// Answers only Junos's spellings, with Junos's refusal for the rest.
    Junos,
    /// A bash shell — every Cisco spelling is `command not found`.
    Cumulus,
    /// Cumulus 5 — NCLU gone, NVUE answering from real
    /// captures.
    Cumulus5,
    /// An Aruba CX 6200 on 10.18, with a real login
    /// banner and the lines after it, answering real AOS-CX captures.
    ArubaCx,
    /// A FortiGate 60F on 7.6, answering with the layouts the
    /// collector was proven on in a lab.
    FortiGate76,
}

#[derive(Clone)]
struct FakeSwitch {
    flavour: Flavour,
    hostname: String,
    cdp: String,
    lldp: String,
    loopback: String,
    /// `show ip arp`, for resolving a neighbour that advertises no address.
    arp: String,
    /// `show mac address-table`, for resolving one by the port it is on.
    macs: String,
}

impl server::Handler for FakeSwitch {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        if password == "correct-horse" {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            })
        }
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        _channel: ChannelId,
        _term: &str,
        _cw: u32,
        _rh: u32,
        _pw: u32,
        _ph: u32,
        _modes: &[(russh::Pty, u32)],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.flavour == Flavour::ArubaCx {
            // A real 6200 after the password — HPE's legend,
            // the registration nag, `Last login` and the login count — then
            // the prompt (`fixtures/aoscx/ssh_login.txt`, reduced).
            let login = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/aoscx/ssh_login.txt"));
            let lines: Vec<&str> = login.lines().collect();
            let shown: Vec<&str> = lines[6..25].iter().chain(lines[27..29].iter()).copied().collect();
            session.data(channel, format!("{}\r\n{}# ", shown.join("\r\n"), self.hostname).into_bytes())?;
            return Ok(());
        }
        session.data(channel, format!("\r\n{}#", self.hostname).into_bytes())?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let line = String::from_utf8_lossy(data);
        let command = line.trim();
        // What each fake was asked, so a test can say what it was not.
        if let Ok(mut asked) = ASKED.lock() {
            asked.push((self.hostname.clone(), command.to_string()));
        }

        if self.flavour == Flavour::DellOs10 {
            let body = dell_answer(command, self.hostname_address());
            session.data(
                channel,
                format!("{command}\r\n{body}{}#", self.hostname).into_bytes(),
            )?;
            return Ok(());
        }
        if self.flavour == Flavour::Cumulus {
            let body = cumulus_answer(command, self.hostname_address());
            session.data(
                channel,
                format!("{command}\r\n{body}{}#", self.hostname).into_bytes(),
            )?;
            return Ok(());
        }
        if self.flavour == Flavour::Cumulus5 {
            let mut body = cumulus5_answer(command).replace("\r\n", "\n");
            if !body.is_empty() && !body.ends_with('\n') {
                body.push('\n');
            }
            let body = body.replace('\n', "\r\n");
            session.data(channel, format!("{command}\r\n{body}{}$ ", self.hostname).into_bytes())?;
            return Ok(());
        }
        if self.flavour == Flavour::FortiGate76 {
            let mut body = fortigate76_answer(command);
            if !body.is_empty() && !body.ends_with('\n') {
                body.push('\n');
            }
            let body = body.replace("\r\n", "\n").replace('\n', "\r\n");
            session.data(channel, format!("{command}\r\n{body}{} # ", self.hostname).into_bytes())?;
            return Ok(());
        }
        if self.flavour == Flavour::ArubaCx {
            let mut body = aruba_cx_answer(command).replace("\r\n", "\n");
            if !body.is_empty() && !body.ends_with('\n') {
                body.push('\n');
            }
            let body = body.replace('\n', "\r\n");
            session.data(channel, format!("{command}\r\n{body}{}# ", self.hostname).into_bytes())?;
            return Ok(());
        }
        if self.flavour == Flavour::Junos {
            let body = junos_answer(command, self.hostname_address());
            session.data(
                channel,
                format!("{command}\r\n{body}{}#", self.hostname).into_bytes(),
            )?;
            return Ok(());
        }

        let body: String = match command {
            "terminal length 0" | "enable" => String::new(),
            "show cdp neighbors detail" => self.cdp.clone(),
            "show lldp neighbors detail" => self.lldp.clone(),
            "show ip arp" => self.arp.clone(),
            "show mac address-table" => self.macs.clone(),
            "show ip interface brief" => format!(
                "Interface              IP-Address      OK? Method Status                Protocol\r\n\
                 GigabitEthernet1/0/1   {}        YES NVRAM  up                    up\r\n\
                 Loopback0              {}       YES NVRAM  up                    up\r\n",
                self.hostname_address(),
                self.loopback
            ),
            "show version" => format!(
                "Cisco IOS Software, C2960X Software, Version 15.2(4)E7\r\n\
                 cisco WS-C2960X-24TS-L (APM86XXX) processor\r\n\
                 Model number            : WS-C2960X-24TS-L\r\n\
                 {} uptime is 3 weeks\r\n",
                self.hostname
            ),
            _ => "% Invalid input detected at '^' marker.\r\n".into(),
        };

        session.data(
            channel,
            format!("{command}\r\n{body}{}#", self.hostname).into_bytes(),
        )?;
        Ok(())
    }
}

impl FakeSwitch {
    fn hostname_address(&self) -> &str {
        if self.hostname == "SW1" {
            "127.0.0.1"
        } else {
            "127.0.0.2"
        }
    }
}

/// Starts a switch on `bind_ip:port`.
async fn start(bind_ip: &str, port: u16, switch: FakeSwitch) {
    let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
        .expect("host key");
    let config = Arc::new(server::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        auth_rejection_time: Duration::from_millis(1),
        keys: vec![key],
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind((bind_ip, port)).await.unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let config = Arc::clone(&config);
            let switch = switch.clone();
            tokio::spawn(async move {
                let _ = server::run_stream(config, stream, switch).await;
            });
        }
    });
}

/// A port free on both loopback addresses.
async fn free_port() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    port
}

async fn start_network() -> u16 {
    let port = free_port().await;
    start(
        "127.0.0.1",
        port,
        FakeSwitch {
            flavour: Flavour::Cisco,
            hostname: "SW1".into(),
            cdp: sw1_cdp(),
            lldp: sw1_lldp(),
            loopback: "10.255.0.1".into(),
            // SW1 has seen the silent switch and knows its address.
            arp: concat!(
                "Protocol  Address          Age (min)  Hardware Addr   Type   Interface\r\n",
                "Internet  127.0.0.4               0   e81c.ba00.0002  ARPA   Vlan1\r\n",
                "Internet  127.0.0.9               0   7456.3c00.0001  ARPA   Vlan1\r\n",
            )
            .into(),
            // Gi0/5 has learned exactly one address, so whatever is on the far
            // end is the thing holding it. Gi0/6 has two, so it leads to
            // another switch and picking one of them would be a guess.
            macs: concat!(
                "Vlan    Mac Address       Type        Ports\r\n",
                "   1    7456.3c00.0001    DYNAMIC     Gi0/5\r\n",
                "   1    aaaa.bbbb.cccc    DYNAMIC     Gi0/6\r\n",
                "   1    aaaa.bbbb.cccd    DYNAMIC     Gi0/6\r\n",
            )
            .into(),
        },
    )
    .await;
    start(
        "127.0.0.2",
        port,
        FakeSwitch {
            flavour: Flavour::Cisco,
            hostname: "SW2".into(),
            cdp: sw2_cdp(),
            lldp: sw2_lldp(),
            loopback: "10.255.0.2".into(),
            arp: String::new(),
            macs: String::new(),
        },
    )
    .await;
    // The switch SW1 can see but that advertises no address of its own. It is
    // reachable — the point is that its address has to be worked out from the
    // chassis id and SW1's ARP table before anything can reach it.
    start(
        "127.0.0.4",
        port,
        FakeSwitch {
            flavour: Flavour::Cisco,
            hostname: "SILENT-SW".into(),
            cdp: String::new(),
            lldp: String::new(),
            loopback: "10.255.0.4".into(),
            arp: String::new(),
            macs: String::new(),
        },
    )
    .await;
    port
}

/// A switch that advertises a chassis id and no management address, which is
/// what a FortiSwitch does and what left one undrawable on the real network.
fn sw1_lldp() -> String {
    concat!(
        // A switch that advertises a chassis id and no management address,
        // which is what a FortiSwitch does.
        "------------------------------------------------\r\n",
        "Local Intf: Gi0/9\r\n",
        "Chassis id: e81c.ba00.0002\r\n",
        "Port id: port24\r\n",
        "System Name: SILENT-SW\r\n\r\n",
        "System Description:\r\n",
        "FortiSwitch-224E v7.6.1\r\n\r\n",
        "Time remaining: 96 seconds\r\n",
        "System Capabilities: B,R\r\n",
        "Enabled Capabilities: B\r\n\r\n",
        // A name and nothing else. Its port has learned exactly one address,
        // so the switch knows where it is even though it never said.
        "------------------------------------------------\r\n",
        "Local Intf: Gi0/5\r\n",
        "Chassis id: DESKTOP-QUIET\r\n",
        "Port id: eth0\r\n",
        "System Name: DESKTOP-QUIET\r\n\r\n",
        "Time remaining: 96 seconds\r\n",
        "System Capabilities: S\r\n",
        "Enabled Capabilities: S\r\n\r\n",
        // The same, but its port carries two addresses, so which one it is
        // cannot be established.
        "------------------------------------------------\r\n",
        "Local Intf: Gi0/6\r\n",
        "Chassis id: CROWDED-PORT\r\n",
        "Port id: eth0\r\n",
        "System Name: CROWDED-PORT\r\n\r\n",
        "Time remaining: 96 seconds\r\n",
        "System Capabilities: S\r\n",
        "Enabled Capabilities: S\r\n\r\n",
        "Total entries displayed: 3\r\n",
    )
    .into()
}

/// How a Dell PowerSwitch on OS10 answers.
///
/// The point of this is as much what it *refuses* as what it returns: a Dell
/// has no CDP and does not know `show lldp neighbors detail`, so every Cisco
/// question the crawl asks comes back as an error. If the crawl has no Dell
/// arm, the device is reached, logged into, and yields nothing — which is a
/// green test and a blank diagram.
///
/// Dell's shapes, invented values.
/// Cumulus Linux 4.4 on an SN2010, from NVIDIA's documented layouts.
/// A bash shell: anything it lacks is `command not found`.
fn cumulus_answer(command: &str, address: &str) -> String {
    let word = command.split_whitespace().next().unwrap_or("");
    match command {
        "terminal length 0" | "no page" => format!("-bash: {word}: command not found\r\n"),
        "export PAGER=cat VTYSH_PAGER=cat" => String::new(),
        "net show system" => concat!(
            "Hostname......... LAB-CUMULUS-1\r\n",
            "Build............ Cumulus Linux 4.4.0\r\n",
            "Model............ Mlnx X86 MSN2010\r\n",
            "Serial Number.... MT0000EXAMPLE\r\n",
            "Product Name..... MSN2010\r\n",
        )
        .into(),
        "lldpctl" => concat!(
            "-------------------------------------------------------------------------------\r\n",
            "LLDP neighbors:\r\n",
            "-------------------------------------------------------------------------------\r\n",
            "Interface:    swp51, via: LLDP, RID: 1, Time: 0 day, 00:01:23\r\n",
            "  Chassis:\r\n",
            "    ChassisID:    mac 00:1c:73:aa:bb:cc\r\n",
            "    SysName:      spine01\r\n",
            "    MgmtIP:       203.0.113.1\r\n",
            "    Capability:   Bridge, on\r\n",
            "  Port:\r\n",
            "    PortID:       ifname swp1\r\n",
        )
        .into(),
        "ip -4 -o addr show" => format!(
            "1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever\r\n\
             2: eth0    inet {address}/8 scope global eth0\\       valid_lft forever\r\n\
             1: lo    inet 10.255.0.21/32 scope global lo\\       valid_lft forever\r\n"
        ),
        "ip neigh show" => "10.9.9.9 dev swp1 lladdr 00:50:56:aa:bb:cc REACHABLE\r\n".into(),
        "bridge fdb show" => "00:50:56:aa:bb:cc dev swp1 vlan 10 master bridge\r\n44:38:39:00:00:11 dev swp1 vlan 10 master bridge permanent\r\n".into(),
        "net show interface bonds" => concat!(
            "    Name     Speed   MTU   Mode     Summary\r\n",
            "--  -------  ------  ----  -------  ----------------------------------\r\n",
            "UP  bond01   2G      9216  802.3ad  Bond Members: swp1(UP), swp2(UP)\r\n",
        )
        .into(),
        _ if word.starts_with('/') => format!("-bash: {word}: No such file or directory\r\n"),
        _ => format!("-bash: {word}: command not found\r\n"),
    }
}

/// An SN2010 on Cumulus 5.18, answering with real
/// captures (`fixtures/cumulus5/`, reduced). `-o json` is answered
/// in NVIDIA's schema where a capture's values could be carried over, and
/// refused for the LLDP view — so both the JSON reading and the fall-back
/// to the captured table are exercised in one crawl.
fn cumulus5_answer(command: &str) -> String {
    macro_rules! capture {
        ($f:literal) => {
            include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/cumulus5/", $f)).to_string()
        };
    }
    let word = command.split_whitespace().next().unwrap_or("");
    match command {
        "export PAGER=cat VTYSH_PAGER=cat" => String::new(),
        "nv show system" => "                   operational          applied\n-----------------  -------------------  -----------------\nuptime             5:07:49\nhostname           leaf-b02             leaf-b02\nproduct-name       Cumulus Linux\n".into(),
        "nv show platform" => capture!("nv_show_platform.txt"),
        "nv show system version" => capture!("nv_show_system_version.txt"),
        "nv show interface" => capture!("nv_show_interface.txt"),
        "nv show interface -o json" => r#"{"bond1": {"type": "bond", "link": {"oper-status": "up", "admin-status": "up", "speed": "10G", "mtu": 9216}, "bond": {"member": {"swp49": {}, "swp50": {}}}},
 "eth0": {"type": "eth", "link": {"oper-status": "up", "admin-status": "up", "speed": "1G", "mtu": 1500}, "ip": {"address": {"127.0.0.2/8": {}}, "vrf": "mgmt"}},
 "vlan110": {"type": "svi", "link": {"oper-status": "up", "admin-status": "up"}, "ip": {"address": {"10.66.110.3/24": {}}, "vrr": {"address": {"10.66.110.1/24": {}}}}},
 "vlan250": {"type": "svi", "link": {"oper-status": "up", "admin-status": "up"}, "ip": {"address": {"10.66.250.3/29": {}}}}}"#.into(),
        // The switch's answer — names, descriptions, models, and no address the reader found.
        "nv show interface lldp-detail -o json" => r#"{"swp1": {"lldp": {"neighbor": {"cx-1": {"chassis": {"system-name": "cx-1", "system-description": "HPE ANW JL727A  ML.10.18.1002", "capability": {"is-bridge": "on"}}, "port": {"name": "1/1/50"}}}}}, "swp9": {"lldp": {"neighbor": {"access-a1.lab.example.net": {"chassis": {"system-name": "access-a1.lab.example.net"}, "lldp-med": {"inventory": {"model": "WS-C3560-24PS"}}}}}}}"#.into(),
        "nv show interface lldp-detail" => capture!("lldpcli_show_neighbors_details.txt"),
        "nv show vrf -o json" => r#"{"default": {"table": 254}, "mgmt": {"table": 1001}}"#.into(),
        "nv show vrf default router rib ipv4 route -o json" => r#"{"0.0.0.0/0": {"route-entry": {"1": {"protocol": "ospf", "distance": 110, "metric": 10, "flags": {"selected": {}, "installed": {}}, "via-entry": {"10.66.250.1": {"type": "ip-address", "interface": "vlan250"}}}}},
 "10.66.110.0/24": {"route-entry": {"1": {"protocol": "connected", "distance": 0, "metric": 0, "flags": {"selected": {}}, "via-entry": {"vlan110": {"type": "interface", "interface": "vlan110"}}}}}}"#.into(),
        "nv show vrf default router rib ipv6 route -o json" | "nv show vrf mgmt router rib ipv6 route -o json" => "{}".into(),
        "nv show vrf default router rib ipv6 route" => capture!("nv_show_rib_ipv6_route.txt"),
        "nv show vrf mgmt router rib ipv4 route -o json" => r#"{"0.0.0.0/0": {"route-entry": {"1": {"protocol": "static", "distance": 1, "metric": 0, "flags": {"selected": {}}, "via-entry": {"127.0.0.1": {"type": "ip-address", "interface": "eth0"}}}}}}"#.into(),
        "nv show vrf default router rib ipv4 route 0.0.0.0/0 -o json" => r#"{"route-entry": {"1": {"protocol": "ospf", "flags": {"selected": {}}, "via-entry": {"10.66.250.1": {"interface": "vlan250"}}}}}"#.into(),
        "nv show bridge domain -o json" => r#"{"br_default": {"type": "vlan-aware"}}"#.into(),
        "nv show bridge domain br_default vlan -o json" => "not json\n".into(),
        "nv show bridge domain br_default vlan" => capture!("nv_show_bridge_domain_vlan.txt"),
        "nv show bridge domain br_default port -o json" => "Error: The requested item does not exist.\n".into(),
        "nv show bridge domain br_default port vlan" => capture!("nv_show_bridge_domain_port_vlan.txt"),
        "nv show bridge domain br_default stp -o json" => "Error: The requested item does not exist.\n".into(),
        "nv show bridge domain br_default stp" => capture!("nv_show_bridge_domain_stp.txt"),
        "nv show bridge domain br_default stp port" => capture!("nv_show_bridge_domain_stp_port.txt"),
        "nv show nve vxlan -o json" => r#"{"enable": "off"}"#.into(),
        "ip neigh show" => "10.66.110.50 dev vlan110 lladdr 00:50:56:aa:bb:cc REACHABLE\n".into(),
        "bridge fdb show" => "00:50:56:aa:bb:cc dev swp2 vlan 110 master br_default\n1c:34:da:00:28:3f dev swp2 vlan 110 master br_default permanent\n".into(),
        _ if word == "nv" => "Error: The requested item does not exist.\n".into(),
        _ => format!("-bash: {word}: command not found\n"),
    }
}

/// An Aruba CX 6200. `show version` and `show system` are
/// real captures (serial and MAC replaced); the tables are
/// ntc-templates' captures of real AOS-CX output — the ones the collector's
/// templates are verified on. Anything else is refused the way AOS-CX
/// refuses it.
fn aruba_cx_answer(command: &str) -> String {
    macro_rules! ntc {
        ($f:literal) => {
            include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../resources/templates/tests/aruba_aoscx/", $f)).to_string()
        };
    }
    let word = command.split_whitespace().next().unwrap_or("");
    match command {
        "no page" => String::new(),
        "show version" => "-----------------------------------------------------------------------------\nAOS-CX\n(c) Copyright 2017-2026 Hewlett Packard Enterprise Development LP\n-----------------------------------------------------------------------------\nVersion      : ML.10.18.1002\nBuild Date   : 2026-08-27 04:58:32 UTC\nBuild ID     : AOS-CX:ML.10.18.1002:0ea5714e629d:202608270437\nActive Image : primary\n".into(),
        "show system" => "Hostname               : cx-1\nSystem Description     : ML.10.18.1002\nVendor                 : HPE ANW\nProduct Name           : JL727A 6200F 48G CL4 4SFP+370W Swch\nChassis Serial Nbr     : XX00EXAMPLE\nBase MAC Address       : 00005e-005301\nAOS-CX Version         : ML.10.18.1002\nUp Time                : 1 week, 5 days, 14 hours, 15 minutes\n".into(),
        "show lldp neighbor-info detail" => ntc!("show_lldp_neighbors-info_detail/show_lldp_neighbors-info_detail.raw"),
        "show mac-address-table" => ntc!("show_mac-address-table/show_mac-address-table.raw"),
        "show arp all-vrfs" => ntc!("show_arp_all-vrfs/show_arp_all-vrfs.raw"),
        "show interface" => ntc!("show_interface/show_interface2.raw"),
        "show ip route all-vrfs" | "show ip route 0.0.0.0/0" => ntc!("show_ip_route_all-vrfs/show_ip_route_all-vrfs.raw"),
        "show ipv6 route all-vrfs" => "No ipv6 routes configured\n".into(),
        "show vlan" => ntc!("show_vlan/show_vlan.raw"),
        _ => format!("Invalid input: {word}\n"),
    }
}

/// The lab FortiGate's 7.6 replies, every value invented,
/// from `fixtures/fortios76/`. Every Cisco spelling is refused the way
/// FortiOS refuses it.
fn fortigate76_answer(command: &str) -> String {
    macro_rules! lab {
        ($f:literal) => {
            include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/fortios76/", $f)).to_string()
        };
    }
    match command {
        "get system status" => lab!("get_system_status_fortigate.txt"),
        "get system interface" => lab!("get_system_interface_fortigate.txt"),
        "get router info routing-table all" | "get router info routing-table details 0.0.0.0" => lab!("get_router_info_routing_table_all_fortigate.txt"),
        "get system arp" => "Address           Age(min)   Hardware Addr      Interface\n192.0.2.22        0          00:00:5e:00:53:22 internal\n".into(),
        _ => "Unknown action 0\nCommand fail. Return code -1\n".into(),
    }
}

/// A Junos EX, from Juniper's documented layouts. Every
/// Cisco spelling is refused the way Junos refuses it.
fn junos_answer(command: &str, address: &str) -> String {
    let unknown = "                 ^\r\nunknown command.\r\n";
    match command {
        "terminal length 0" | "enable" | "set cli screen-length 0" => String::new(),
        "show version" => "Hostname: LAB-JUNOS-1\r\nModel: ex4300-48t\r\nJunos: 21.4R3-S1.5\r\n".into(),
        "show chassis hardware" => concat!(
            "Hardware inventory:\r\n",
            "Item             Version  Part number  Serial number     Description\r\n",
            "Chassis                                PE3717190123      EX4300-48T\r\n",
        )
        .into(),
        "show interfaces terse" => format!(
            "Interface               Admin Link Proto    Local                 Remote\r\n\
             ge-0/0/0                up    up\r\n\
             ge-0/0/0.0              up    up   inet     {address}/8\r\n\
             lo0.0                   up    up   inet     10.255.0.7          --> 0/0\r\n"
        ),
        "show lldp neighbors" => concat!(
            "Local Interface    Parent Interface    Chassis Id          Port info          System Name\r\n",
            "ge-0/0/1           -                   00:1c:73:aa:bb:cc   Ethernet1          leaf1\r\n",
        )
        .into(),
        "show arp no-resolve" => concat!(
            "MAC Address       Address         Interface                Flags\r\n",
            "00:50:56:aa:bb:cc 10.9.9.9        irb.100 [ge-0/0/3.0]     none\r\n",
        )
        .into(),
        "show ethernet-switching table" => concat!(
            "   Vlan                MAC                 MAC         Age    Logical                NH        RTR\r\n",
            "   name                address             flags              interface              Index     ID\r\n",
            "   v100                00:50:56:aa:bb:cc   D             -   ge-0/0/3.0             0         0\r\n",
        )
        .into(),
        "show lacp interfaces" => concat!(
            "Aggregated interface: ae0\r\n",
            "    LACP state:       Role   Exp   Def  Dist  Col  Syn  Aggr  Timeout  Activity\r\n",
            "      ge-0/0/10       Actor    No    No   Yes  Yes  Yes   Yes     Fast    Active\r\n",
            "      ge-0/0/10     Partner    No    No   Yes  Yes  Yes   Yes     Fast    Active\r\n",
        )
        .into(),
        _ => unknown.into(),
    }
}

fn dell_answer(command: &str, address: &str) -> String {
    let invalid = "% Error: Invalid input at \"^\" marker.\r\n";
    match command {
        "terminal length 0" | "enable" => String::new(),
        "show version" => concat!(
            "Dell EMC Networking OS10 Enterprise\r\n",
            "Copyright (c) 1999-2024 by Dell Inc. All Rights Reserved.\r\n",
            "OS Version: 10.5.4.2\r\n",
            "System Type: S5248F-ON\r\n",
        )
        .into(),
        // OS10's LLDP table, which the Cisco reader cannot make sense of.
        "show lldp neighbors" => concat!(
            "Loc PortID          Rem Host Name   Rem Port Id            Rem Chassis Id\r\n",
            "-------------------------------------------------------------------------\r\n",
            "ethernet1/1/2       SW1             GigabitEthernet1/0/24  aa:bb:cc:00:22:01\r\n",
        )
        .into(),
        "show mac address-table" => concat!(
            "VlanId  Mac Address         Type       Interface\r\n",
            "10      aa:bb:cc:00:22:01   dynamic    ethernet1/1/2\r\n",
        )
        .into(),
        "show port-channel summary" => concat!(
            "Group Port-Channel      Type   Protocol  Member Ports\r\n",
            "10    port-channel10 (U) Eth    DYNAMIC   1/1/9(P) 1/1/10(P)\r\n",
        )
        .into(),
        "show ip interface brief" => format!(
            "Interface                Status     IP Address          Description\r\n\
             ethernet1/1/1            up         {address}/8\r\n"
        ),
        _ => invalid.into(),
    }
}

fn creds() -> Credentials {
    Credentials {
        username: "admin".into(),
        password: Secret::new("correct-horse"),
        enable_password: None,
    }
}

fn options(port: u16) -> CrawlOptions {
    CrawlOptions {
        filter: DiscoveryFilter {
            // 127.0.0.0/8 keeps the crawl on the fake network; the Aruba's
            // 203.0.113.40 is outside it and must not be dialled.
            subnets: vec![parse_cidr("127.0.0.0/8").unwrap()],
            ..Default::default()
        },
        ssh: SshOptions {
            port,
            connect_timeout: Duration::from_secs(5),
            auth_timeout: Duration::from_secs(10),
            command_timeout: Duration::from_secs(10),
            login_transcript: None,
            support_capture: None,
            max_output_bytes: coreview_discover::ssh::DEFAULT_MAX_OUTPUT_BYTES,
        },
        ..Default::default()
    }
}

#[tokio::test]
async fn crawls_two_switches_without_looping_between_them() {
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, mut rx) = mpsc::channel(256);

    let result = crawl(
        "127.0.0.1",
        creds(),
        options(port),
        store,
        tx,
        CancellationToken::new(),
    )
    .await;

    let names: Vec<&str> = result.devices.iter().map(|d| d.hostname.as_str()).collect();
    assert_eq!(
        names,
        vec!["SW1", "SW2", "SILENT-SW"],
        "both switches plus the one whose address came from ARP, each once"
    );
    assert!(result.failures.is_empty(), "unexpected failures: {:?}", result.failures);
    assert!(!result.cancelled);

    // SW2 advertises SW1 back. Without a visited set this never terminates,
    // and the fact that it did is the assertion.
    let reached = rx
        .try_recv()
        .into_iter()
        .chain(std::iter::from_fn(|| rx.try_recv().ok()))
        .filter(|e| matches!(e, CrawlEvent::Reached(_)))
        .count();
    assert_eq!(reached, 3, "one Reached event per device, no repeats");
}

/// One estate, more than one login.
///
/// Sites migrate between TACACS realms and appliances keep their own local
/// account. On the network this was built against, the Cisco and the
/// FortiSwitch take different passwords, so a crawl with one credential set
/// reached one of them and never both.
#[tokio::test]
async fn a_rejected_password_falls_back_to_the_next_credential() {
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let wrong = Credentials {
        username: "netops".into(),
        password: Secret::new("not-the-password"),
        enable_password: None,
    };
    let mut opts = options(port);
    opts.fallback_credentials = vec![creds()];

    let result = crawl("127.0.0.1", wrong, opts, store, tx, CancellationToken::new()).await;

    let names: Vec<&str> = result.devices.iter().map(|d| d.hostname.as_str()).collect();
    assert_eq!(
        names,
        vec!["SW1", "SW2", "SILENT-SW"],
        "the second credential should get in"
    );
    assert!(result.failures.is_empty(), "{:?}", result.failures);
}

/// A login bound to a subnet is tried on the devices in it, before the
/// run's own — with the run's login wrong everywhere, the bound one is the only
/// way in, and a device outside the subnet stays out.
#[tokio::test]
async fn a_login_bound_to_a_subnet_is_used_on_devices_inside_it_only() {
    use coreview_discover::bindings::{Binding, Scope};
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let wrong = Credentials {
        username: "netops".into(),
        password: Secret::new("not-the-password"),
        enable_password: None,
    };
    let mut opts = options(port);
    opts.bindings = vec![Binding {
        scope: Scope::parse("subnet", "127.0.0.1/32").unwrap(),
        ssh: Some(creds()),
        snmp: None,
    }];

    let result = crawl("127.0.0.1", wrong, opts, store, tx, CancellationToken::new()).await;

    let names: Vec<&str> = result.devices.iter().map(|d| d.hostname.as_str()).collect();
    assert!(names.contains(&"SW1"), "the bound login gets into the device it is bound to: {names:?}");
    assert!(!names.contains(&"SW2"), "and is not tried outside its subnet: {names:?}");
    assert!(
        result.failures.iter().any(|f| f.address == "127.0.0.2"),
        "SW2 fails on the run's own login: {:?}",
        result.failures
    );
}

/// Two seeds in one network do not crawl it twice, and each seed that
/// is its own island is reached.
#[tokio::test]
async fn several_seeds_share_one_visited_set() {
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);
    let seeds = vec!["127.0.0.2".to_string(), "127.0.0.1".to_string()];
    let result = coreview_discover::crawl::crawl_from(&seeds, creds(), options(port), store, tx, CancellationToken::new()).await;
    let mut names: Vec<&str> = result.devices.iter().map(|d| d.hostname.as_str()).collect();
    names.sort();
    assert_eq!(names, vec!["SILENT-SW", "SW1", "SW2"], "each device once");
}

/// The fallback is for a rejected password and nothing else.
#[tokio::test]
async fn every_credential_being_wrong_still_reports_one_failure() {
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let wrong = |p: &str| Credentials {
        username: "netops".into(),
        password: Secret::new(p),
        enable_password: None,
    };
    let mut opts = options(port);
    opts.fallback_credentials = vec![wrong("also-wrong")];

    let result = crawl("127.0.0.1", wrong("wrong"), opts, store, tx, CancellationToken::new()).await;

    assert!(result.devices.is_empty());
    assert_eq!(result.failures.len(), 1, "one device, one failure: {:?}", result.failures);
    assert!(
        result.failures[0].reason.contains("rejected"),
        "the last rejection is what to report: {:?}",
        result.failures[0]
    );
}

/// LLDP does not require a management address, and plenty of devices do not
/// advertise one. Without resolving it there is nowhere to connect, and no
/// credential can help — a FortiSwitch sat undrawable on the real network for
/// exactly this reason.
#[tokio::test]
async fn a_neighbour_that_advertises_no_address_is_resolved_from_arp() {
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let result = crawl("127.0.0.1", creds(), options(port), store, tx, CancellationToken::new()).await;

    let silent = result
        .devices
        .iter()
        .find(|d| d.hostname == "SILENT-SW")
        .expect("the switch with no advertised address should have been reached");
    // Its chassis id is e81c.ba00.0002 and SW1's ARP table maps that to
    // 127.0.0.4. Nothing else in the crawl knows that address.
    assert_eq!(silent.address, "127.0.0.4");

    // And it is one device, not two: the same switch must not appear once as
    // an addressless neighbour and again as a reached device.
    assert_eq!(
        result.devices.iter().filter(|d| d.hostname == "SILENT-SW").count(),
        1
    );
}

/// A device that announces a name and no address at all.
///
/// The switch learned exactly one address on that port, so the thing on the
/// far end is what holds it. LABDESKTOP01 on the real network is found this
/// way and no other.
#[tokio::test]
async fn a_neighbour_with_only_a_name_is_resolved_from_the_port_it_is_on() {
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let result = crawl("127.0.0.1", creds(), options(port), store, tx, CancellationToken::new()).await;

    let sw1 = result.devices.iter().find(|d| d.hostname == "SW1").expect("SW1");
    let quiet = sw1
        .neighbors
        .iter()
        .find(|n| n.short_name == "DESKTOP-QUIET")
        .expect("the device that announces only a name");
    assert_eq!(quiet.address(), Some("127.0.0.9"));

    // And the port with two addresses on it is left alone: the far end is
    // another switch, and choosing one of them would be a guess.
    let crowded = sw1
        .neighbors
        .iter()
        .find(|n| n.short_name == "CROWDED-PORT")
        .expect("the neighbour on the shared port");
    assert_eq!(
        crowded.address(),
        None,
        "a port with more than one address must not be guessed from"
    );
}

#[tokio::test]
async fn an_access_point_is_recorded_but_never_logged_into() {
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let result = crawl("127.0.0.1", creds(), options(port), store, tx, CancellationToken::new()).await;

    // Nothing tried to log into it — there is no SSH server on 127.0.0.9, so a
    // crawl that tried would have recorded a failure.
    assert!(
        !result.failures.iter().any(|f| f.address == "127.0.0.9"),
        "the crawler dialled an access point: {:?}",
        result.failures
    );
    assert!(!result.devices.iter().any(|d| d.hostname.contains("AP")));

    // But it is still in the results, because it belongs on a diagram.
    let ap = result
        .not_visited
        .iter()
        .find(|n| n.short_name == "AP-FLOOR2")
        .expect("the access point should be reported, just not crawled");
    assert_eq!(ap.class, DeviceClass::AccessPoint);
}

#[tokio::test]
async fn a_switch_only_lldp_can_see_is_found() {
    // The Aruba. A CDP-only crawl misses it silently.
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let result = crawl("127.0.0.1", creds(), options(port), store, tx, CancellationToken::new()).await;

    let aruba = result
        .not_visited
        .iter()
        .find(|n| n.short_name == "ARUBA-EDGE-1")
        .expect("LLDP-only neighbour missing from the results");
    assert_eq!(aruba.class, DeviceClass::Switch);
    assert_eq!(aruba.addresses[0].ip, "203.0.113.40");

    // It is a switch, so it would normally be crawled — but its address is
    // outside the subnet filter, which is what keeps a crawl inside an estate.
    assert!(
        !result.failures.iter().any(|f| f.address == "203.0.113.40"),
        "the crawler left the subnet filter: {:?}",
        result.failures
    );
}

#[tokio::test]
async fn the_probe_target_is_the_loopback_not_the_address_dialled() {
    // The point of running `show ip interface brief` during a crawl.
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let result = crawl("127.0.0.1", creds(), options(port), store, tx, CancellationToken::new()).await;

    let sw1 = result.devices.iter().find(|d| d.hostname == "SW1").unwrap();
    assert_eq!(sw1.address, "127.0.0.1", "reached on the seed address");
    assert_eq!(
        sw1.probe_target, "10.255.0.1",
        "a probe should aim at the loopback, which stays up when a port does not"
    );
    assert_eq!(sw1.class, DeviceClass::Switch);
    assert_eq!(sw1.platform.as_deref(), Some("WS-C2960X-24TS-L"));
}

#[tokio::test]
async fn a_hop_limit_stops_the_crawl_going_further() {
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let result = crawl(
        "127.0.0.1",
        creds(),
        CrawlOptions {
            max_hops: 0,
            ..options(port)
        },
        store,
        tx,
        CancellationToken::new(),
    )
    .await;

    assert_eq!(result.devices.len(), 1, "only the seed should be visited");
    assert_eq!(result.devices[0].hostname, "SW1");
    // Its neighbours are still reported — they were seen, just not followed.
    assert!(result.not_visited.iter().any(|n| n.short_name == "SW2"));
}

#[tokio::test]
async fn one_unreachable_device_does_not_end_the_crawl() {
    // The failure mode the Python original had: an exception deep in the
    // recursion takes the whole survey with it.
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    // Seed with a dead address first; the crawl should report it and stop
    // there, having nothing else queued — then prove the same run style works
    // from a live seed.
    let dead = crawl(
        "127.0.0.3",
        creds(),
        options(port),
        Arc::clone(&store),
        tx.clone(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(dead.devices.len(), 0);
    assert_eq!(dead.failures.len(), 1, "the failure should be recorded, not thrown");
    assert!(dead.failures[0].reason.contains("127.0.0.3"), "got: {:?}", dead.failures[0]);

    let live = crawl("127.0.0.1", creds(), options(port), store, tx, CancellationToken::new()).await;
    assert_eq!(live.devices.len(), 3, "a later crawl is unaffected");
}

#[tokio::test]
async fn wrong_credentials_fail_every_device_rather_than_hanging() {
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let result = crawl(
        "127.0.0.1",
        Credentials {
            username: "admin".into(),
            password: Secret::new("wrong"),
            enable_password: None,
        },
        options(port),
        store,
        tx,
        CancellationToken::new(),
    )
    .await;

    assert!(result.devices.is_empty());
    assert_eq!(result.failures.len(), 1);
    let reason = &result.failures[0].reason;
    assert!(!reason.contains("wrong"), "the password leaked into a failure: {reason}");
}

/// A port that accepts a connection and then says nothing, the way a device
/// behind a half-open firewall does. Counts how often it was dialled.
async fn silent_listener(ip: &str) -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
    let listener = tokio::net::TcpListener::bind((ip, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = Arc::clone(&count);
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((stream, _)) = listener.accept().await {
            seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            held.push(stream);
        }
    });
    (port, count)
}

fn quick(port: u16) -> CrawlOptions {
    let mut o = options(port);
    o.ssh.connect_timeout = Duration::from_millis(300);
    o
}

/// A device that never answered is tried again, as many times as the
/// run allows, and says so.
#[tokio::test]
async fn a_device_that_does_not_answer_is_retried() {
    let (port, dialled) = silent_listener("127.0.0.1").await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, mut rx) = mpsc::channel(256);
    let mut opts = quick(port);
    opts.retries = 2;
    let result = crawl("127.0.0.1", creds(), opts, store, tx, CancellationToken::new()).await;
    assert_eq!(result.failures.len(), 1);
    assert_eq!(dialled.load(std::sync::atomic::Ordering::SeqCst), 3, "the first try and two more");
    let retries = std::iter::from_fn(|| rx.try_recv().ok())
        .filter(|e| matches!(e, CrawlEvent::Retrying { .. }))
        .count();
    assert_eq!(retries, 2);
}

/// A device that takes longer than the per-device limit is given up on.
#[tokio::test]
async fn a_device_that_takes_too_long_is_given_up_on() {
    let (port, _) = silent_listener("127.0.0.1").await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);
    let mut opts = options(port);
    opts.ssh.connect_timeout = Duration::from_secs(30);
    opts.per_host_timeout = Duration::from_millis(400);
    opts.retries = 0;
    let started = std::time::Instant::now();
    let result = crawl("127.0.0.1", creds(), opts, store, tx, CancellationToken::new()).await;
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    assert_eq!(result.failures.len(), 1);
    assert!(result.failures[0].reason.contains("gave up"), "{:?}", result.failures[0]);
}

/// Several devices are worked on at once, up to the limit.
#[tokio::test]
async fn devices_are_visited_side_by_side() {
    let (port, _) = silent_listener("127.0.0.1").await;
    // The same port on three more loopback addresses, all silent.
    for ip in ["127.0.0.3", "127.0.0.4", "127.0.0.5"] {
        let l = tokio::net::TcpListener::bind((ip, port)).await.unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((s, _)) = l.accept().await {
                held.push(s);
            }
        });
    }
    let seeds: Vec<String> = ["127.0.0.1", "127.0.0.3", "127.0.0.4", "127.0.0.5"].iter().map(|s| s.to_string()).collect();
    let run = |concurrency: usize| {
        let seeds = seeds.clone();
        async move {
            let mut opts = quick(port);
            opts.ssh.connect_timeout = Duration::from_millis(500);
            opts.retries = 0;
            opts.concurrency = concurrency;
            let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
            let (tx, _rx) = mpsc::channel(256);
            let started = std::time::Instant::now();
            let r = coreview_discover::crawl::crawl_from(&seeds, creds(), opts, store, tx, CancellationToken::new()).await;
            (started.elapsed(), r.failures.len())
        }
    };
    let (together, failed) = run(4).await;
    assert_eq!(failed, 4);
    let (one_by_one, _) = run(1).await;
    assert!(one_by_one >= Duration::from_millis(1_900), "{one_by_one:?}");
    assert!(together < one_by_one / 2, "four at once {together:?}, one at a time {one_by_one:?}");
}

/// Stopping a run stops it now, not after the slowest device.
#[tokio::test]
async fn cancelling_stops_visits_in_progress() {
    let (port, _) = silent_listener("127.0.0.1").await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);
    let mut opts = options(port);
    opts.ssh.connect_timeout = Duration::from_secs(30);
    let cancel = CancellationToken::new();
    let stopper = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        stopper.cancel();
    });
    let started = std::time::Instant::now();
    let result = crawl("127.0.0.1", creds(), opts, store, tx, cancel).await;
    assert!(result.cancelled);
    assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
}

/// The debug log has to answer the question a crawl that "missed"
/// something always raises: did it not see the device, or see it and decline?
/// The first real log could not say — one device, then a ninety-second gap.
///
/// This network has every kind of decision in it: a loop, a device found
/// through ARP, an access point the crawl must never log into, and a switch
/// outside the subnet limit. Each must appear, followed or declined, with its
/// reason — and the password it logged in with must not.
#[tokio::test]
async fn the_debug_log_says_what_was_followed_and_why_the_rest_was_not() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("crawl.log");
    coreview_discover::debuglog::start(&path, "Coreview test").expect("start the log");

    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);
    let result = crawl("127.0.0.1", creds(), options(port), store, tx, CancellationToken::new()).await;
    coreview_discover::debuglog::stop();
    let log = std::fs::read_to_string(&path).expect("the log is there");

    // The run, from both ends.
    assert!(log.contains("started from 127.0.0.1"), "{log}");
    assert!(log.contains("subnet limit: 127.0.0.0/8"), "{log}");
    assert!(
        log.contains("finished after") && log.contains(&format!("{} reached", result.devices.len())),
        "the end of the run and its count:\n{log}",
    );

    // Every device reached says so, with what it had.
    for d in &result.devices {
        assert!(log.contains(&format!("reached as {}", d.hostname)), "{} missing:\n{log}", d.hostname);
    }
    assert!(log.contains("CDP gave"), "per-protocol counts:\n{log}");

    // Followed, and declined with the reason — the part that was missing.
    assert!(log.contains("following SW2 at"), "{log}");
    assert!(
        log.contains("not following AP-FLOOR2 — an access point is not a kind this run logs into"),
        "the access point, and why:\n{log}",
    );
    assert!(log.contains("outside the subnet limit"), "the switch beyond the limit, and why:\n{log}");
    assert!(log.contains("already reached"), "the loop back to SW1, and why:\n{log}");

    assert!(!log.contains("correct-horse"), "the password reached the log:\n{log}");
}

/// A Junos is identified from `show version`, asked its own
/// questions and none of Cisco's, and what it answers is read — the fake
/// refuses every other spelling the way Junos does.
#[tokio::test]
async fn a_junos_answering_in_its_own_dialect_is_read() {
    let port = free_port().await;
    start(
        "127.0.0.2",
        port,
        FakeSwitch {
            flavour: Flavour::Junos,
            // The prompt Junos draws is `user@host>`; the fake ends every
            // prompt in `#`, and the part that matters is the `@`.
            hostname: "admin@LAB-JUNOS-1".into(),
            cdp: String::new(),
            lldp: String::new(),
            loopback: "10.255.0.7".into(),
            arp: String::new(),
            macs: String::new(),
        },
    )
    .await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);
    let result = crawl("127.0.0.2", creds(), options(port), store, tx, CancellationToken::new()).await;
    assert_eq!(result.failures.len(), 0, "{:?}", result.failures);
    assert_eq!(result.devices.len(), 1, "{:?}", result.devices);
    let j = &result.devices[0];
    assert_eq!(j.hostname, "LAB-JUNOS-1", "the host after the @");
    assert_eq!(j.platform.as_deref(), Some("EX4300-48T"));
    assert_eq!(j.class, DeviceClass::Switch);
    assert_eq!(j.serial.as_deref(), Some("PE3717190123"), "from show chassis hardware");
    assert!(j.addresses.iter().any(|a| a.ip == "10.255.0.7"), "from show interfaces terse: {:?}", j.addresses);
    assert_eq!(j.port_channels.iter().map(|p| (p.name.as_str(), p.members.clone())).collect::<Vec<_>>(), [("ae0", vec!["ge-0/0/10".to_string()])]);
    let seen: Vec<&str> = result.not_visited.iter().map(|n| n.short_name.as_str()).collect();
    assert!(seen.contains(&"leaf1"), "the LLDP table was read: {seen:?}");
    assert!(j.attached.iter().any(|a| a.mac == "005056aabbcc" && a.address.as_deref() == Some("10.9.9.9")), "the switching table and the ARP table met: {:?}", j.attached);
}

/// A Cumulus switch answers every Cisco spelling with bash's
/// `command not found`; the crawl must not take that for an identity, must
/// find the platform at `net show system`, and must then read it the
/// platform's own way.
#[tokio::test]
async fn a_cumulus_switch_in_a_bash_shell_is_identified_and_read() {
    let port = free_port().await;
    start(
        "127.0.0.2",
        port,
        FakeSwitch {
            flavour: Flavour::Cumulus,
            // `cumulus@LAB-CUMULUS-1:mgmt:~$` in life; the fake ends every
            // prompt in `#`, and what matters is the part after the `@`.
            hostname: "cumulus@LAB-CUMULUS-1:mgmt:~".into(),
            cdp: String::new(),
            lldp: String::new(),
            loopback: "10.255.0.21".into(),
            arp: String::new(),
            macs: String::new(),
        },
    )
    .await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);
    let result = crawl("127.0.0.2", creds(), options(port), store, tx, CancellationToken::new()).await;
    assert_eq!(result.failures.len(), 0, "{:?}", result.failures);
    assert_eq!(result.devices.len(), 1, "{:?}", result.devices);
    let c = &result.devices[0];
    assert_eq!(c.hostname, "LAB-CUMULUS-1", "the host after the @, before the :");
    assert_eq!(c.platform.as_deref(), Some("MSN2010"));
    assert_eq!(c.class, DeviceClass::Switch);
    assert_eq!(c.serial.as_deref(), Some("MT0000EXAMPLE"));
    assert!(c.addresses.iter().any(|a| a.ip == "10.255.0.21"), "from ip addr: {:?}", c.addresses);
    assert!(!c.addresses.iter().any(|a| a.ip == "127.0.0.1"), "the loopback's own address is not one");
    assert_eq!(c.port_channels.iter().map(|p| (p.name.as_str(), p.members.len())).collect::<Vec<_>>(), [("bond01", 2)]);
    let spine = result.not_visited.iter().find(|n| n.short_name == "spine01").expect("lldpctl was read");
    assert_eq!(spine.addresses.first().map(|a| a.ip.as_str()), Some("203.0.113.1"), "with the address a crawl goes on by");
    assert!(c.attached.iter().any(|a| a.mac == "005056aabbcc" && a.address.as_deref() == Some("10.9.9.9")), "fdb and neighbours met: {:?}", c.attached);
    // Once known for what it is, it is asked only its own questions.
    let asked = asked_of("cumulus@LAB-CUMULUS-1:mgmt:~");
    for cisco in ["show vlan brief", "show interfaces status", "show interfaces trunk", "show spanning-tree", "show switch", "show ip route", "show cdp neighbors detail", "show ip policy"] {
        assert!(!asked.contains(&cisco.to_string()), "a Cumulus was asked `{cisco}`: {asked:?}");
    }
    assert!(asked.contains(&"net show system".to_string()) && asked.contains(&"lldpctl".to_string()), "{asked:?}");
}

/// An SN2010 on Cumulus 5. NCLU is gone,
/// so `net show system` is refused like every Cisco spelling; the crawl must
/// find it at `nv show system`, name it from NVUE's platform and version,
/// read the JSON where it reads and the captured table where it does not,
/// and ask none of Cumulus 4's or Cisco's questions after it knows.
#[tokio::test]
async fn a_cumulus_5_switch_is_identified_and_read_through_nvue() {
    let port = free_port().await;
    start(
        "127.0.0.2",
        port,
        FakeSwitch {
            flavour: Flavour::Cumulus5,
            hostname: "netops@leaf-b02:mgmt:~".into(),
            cdp: String::new(),
            lldp: String::new(),
            loopback: String::new(),
            arp: String::new(),
            macs: String::new(),
        },
    )
    .await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);
    let mut o = options(port);
    o.details = coreview_discover::crawl::DetailOptions { routes: true, spanning_tree: true, vlans: true, vrfs: true, overlay: true };
    let result = crawl("127.0.0.2", creds(), o, store, tx, CancellationToken::new()).await;
    // Its private neighbour and its gateway are followed even with no
    // subnet named; nothing answers there in this test, so they fail and are
    // the only failures.
    let mut failed: Vec<&str> = result.failures.iter().map(|f| f.address.as_str()).collect();
    failed.sort();
    assert_eq!(failed, ["10.66.250.1", "10.77.0.7"], "{:?}", result.failures);
    assert_eq!(result.devices.len(), 1, "{:?}", result.devices);
    let c = &result.devices[0];
    assert_eq!(c.hostname, "leaf-b02");
    assert_eq!(c.platform.as_deref(), Some("MSN2010"), "from nv show platform");
    assert_eq!(c.serial.as_deref(), Some("MT0000EXMP"));
    assert_eq!(c.version.as_deref(), Some("Cumulus Linux 5.18.0"), "from nv show system version");
    assert_eq!(c.class, DeviceClass::Switch);
    // The JSON's addresses; VRR's shared one is not this box's.
    assert!(c.addresses.iter().any(|a| a.ip == "10.66.250.3"), "{:?}", c.addresses);
    assert!(!c.addresses.iter().any(|a| a.ip == "10.66.110.1"), "{:?}", c.addresses);
    assert_eq!(c.port_channels.iter().map(|p| (p.name.as_str(), p.members.clone())).collect::<Vec<_>>(), [("bond1", vec!["swp49".to_string(), "swp50".to_string()])], "{:?}", asked_of("netops@leaf-b02:mgmt:~"));
    // The LLDP view refused JSON; its table was read, CDP included.
    let cx = result.not_visited.iter().find(|n| n.short_name == "cx-1").expect("the 6200 was seen");
    assert_eq!(cx.addresses.first().map(|a| a.ip.as_str()), Some("198.51.100.4"));
    assert!(result.not_visited.iter().any(|n| n.short_name == "wlc-a1"), "heard over CDP: {:?}", result.not_visited.iter().map(|n| &n.short_name).collect::<Vec<_>>());
    assert_eq!(c.default_next_hop.as_deref(), Some("10.66.250.1"));
    let d = &c.details;
    assert!(d.routes.iter().any(|r| r.prefix == "0.0.0.0/0" && r.next_hops == ["10.66.250.1"]), "{:?}", d.routes);
    assert!(d.routes.iter().any(|r| r.prefix == "fe80::/64"), "the IPv6 table fell back to the captured one: {:?}", d.routes);
    assert_eq!(d.vrf_routes.keys().collect::<Vec<_>>(), ["mgmt"]);
    assert_eq!(d.vlans.len(), 23, "the captured VLAN table, after the JSON did not read");
    assert!(d.port_vlans.iter().any(|p| p.port == "bond1" && p.mode == "trunk" && p.trunk_vlans.contains(&250)));
    assert_eq!(d.spanning_tree.len(), 1);
    assert!(d.spanning_tree[0].is_root && d.spanning_tree[0].ports.iter().any(|p| p.port == "peerlink" && p.state == "FWD"));
    assert!(d.overlay.is_none(), "VXLAN is off");
    assert!(c.attached.iter().any(|a| a.mac == "005056aabbcc" && a.address.as_deref() == Some("10.66.110.50")), "fdb and neighbours met: {:?}", c.attached);
    let asked = asked_of("netops@leaf-b02:mgmt:~");
    for never in ["show vlan brief", "show spanning-tree", "show ip route", "show cdp neighbors detail", "show vrf", "net show route", "lldpctl"] {
        assert!(!asked.contains(&never.to_string()), "a Cumulus 5 was asked `{never}`: {asked:?}");
    }
    assert!(!asked.iter().any(|a| a.starts_with("sudo")), "never sudo: {asked:?}");
}

/// An Aruba CX 6200 on 10.18. The login prints
/// HPE's legend, `Last login` and the login count before the prompt; the
/// banner says `AOS-CX`, not `ArubaOS-CX`; and the switch is then read with
/// what the collector reads it with — `show interface` for addresses and
/// LAGs, `show arp all-vrfs`, every VRF's routes, `show vlan` — and asked
/// none of Cisco's spellings.
#[tokio::test]
async fn an_aruba_cx_6200_is_logged_into_past_its_banner_and_read_the_collectors_way() {
    let port = free_port().await;
    start(
        "127.0.0.2",
        port,
        FakeSwitch { flavour: Flavour::ArubaCx, hostname: "cx-1".into(), cdp: String::new(), lldp: String::new(), loopback: String::new(), arp: String::new(), macs: String::new() },
    )
    .await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);
    let mut o = options(port);
    o.details = coreview_discover::crawl::DetailOptions { routes: true, vlans: true, vrfs: true, ..Default::default() };
    let result = crawl("127.0.0.2", creds(), o, store, tx, CancellationToken::new()).await;
    // Its private neighbours are followed; nothing answers there in
    // this test, so they are the only failures.
    let mut failed: Vec<&str> = result.failures.iter().map(|f| f.address.as_str()).collect();
    failed.sort();
    assert_eq!(failed, ["10.252.15.17", "10.252.15.18", "172.25.0.189"], "{:?}", result.failures);
    assert_eq!(result.devices.len(), 1, "{:?}", result.devices);
    let cx = &result.devices[0];
    assert_eq!(cx.hostname, "cx-1");
    assert_eq!(cx.platform.as_deref(), Some("JL727A 6200F 48G CL4 4SFP+370W SWCH"));
    assert_eq!(cx.serial.as_deref(), Some("XX00EXAMPLE"));
    assert_eq!(cx.class, DeviceClass::Switch);
    assert!(cx.addresses.iter().any(|a| a.ip == "10.1.2.1"), "from show interface: {:?}", cx.addresses);
    assert_eq!(cx.port_channels.iter().map(|p| (p.name.as_str(), p.members.len())).collect::<Vec<_>>(), [("lag1", 2)]);
    assert_eq!(cx.default_next_hop.as_deref(), Some("172.25.0.189"));
    assert!(cx.details.routes.iter().any(|r| r.prefix == "0.0.0.0/0" && r.next_hops.len() == 2));
    assert_eq!(cx.details.vlans.first().map(|v| v.id), Some(1));
    assert!(cx.details.port_vlans.iter().any(|p| p.port == "lag1" && p.vlan == Some(666)));
    assert!(!result.not_visited.is_empty(), "the LLDP table was read");
    let asked = asked_of("cx-1");
    for cisco in ["show etherchannel summary", "show cdp neighbors detail", "show interfaces status", "show vlan brief", "show ip interface brief", "show ip route"] {
        assert!(!asked.contains(&cisco.to_string()), "a CX was asked `{cisco}`: {asked:?}");
    }
    assert!(asked.contains(&"show arp all-vrfs".to_string()), "{asked:?}");
}

/// A FortiGate on 7.6 is read the way the collector reads it in a
/// lab — its 7.6 interface list, and its routing table with
/// each route's interface, which the classic crawler never asked for.
#[tokio::test]
async fn a_fortigate_on_7_6_gives_its_routing_table_to_the_classic_crawler() {
    let port = free_port().await;
    start(
        "127.0.0.2",
        port,
        FakeSwitch { flavour: Flavour::FortiGate76, hostname: "LAB-FGT".into(), cdp: String::new(), lldp: String::new(), loopback: String::new(), arp: String::new(), macs: String::new() },
    )
    .await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);
    let mut o = options(port);
    o.details = coreview_discover::crawl::DetailOptions { routes: true, ..Default::default() };
    let result = crawl("127.0.0.2", creds(), o, store, tx, CancellationToken::new()).await;
    assert_eq!(result.failures.len(), 0, "{:?}", result.failures);
    let fgt = &result.devices[0];
    assert_eq!(fgt.platform.as_deref(), Some("FortiGate-60F"));
    assert_eq!(fgt.serial.as_deref(), Some("FGTFAKE0000001"));
    assert!(fgt.addresses.iter().any(|a| a.ip == "198.51.100.1"), "vlan20, a logical interface: {:?}", fgt.addresses);
    let routes = &fgt.details.routes;
    let default = routes.iter().find(|r| r.prefix == "0.0.0.0/0").expect("the default route");
    assert_eq!(default.next_hops, ["203.0.113.1", "198.51.100.1"]);
    assert_eq!(default.interface.as_deref(), Some("wan2"));
    assert!(routes.iter().any(|r| r.prefix == "172.16.1.0/24" && r.interface.as_deref() == Some("internal")));
    assert_eq!(fgt.default_next_hop.as_deref(), Some("203.0.113.1"));
    assert!(asked_of("LAB-FGT").contains(&"get router info routing-table all".to_string()));
}

#[tokio::test]
async fn a_dell_answering_in_its_own_dialect_is_still_read() {
    // Every Cisco question this device is asked comes back as an
    // error: no CDP, and no `show lldp neighbors detail`. Without the Dell arm
    // the crawl logs in successfully and learns nothing — a device on the
    // diagram with no links, which is the failure this test exists to catch.
    let port = free_port().await;
    start(
        "127.0.0.2",
        port,
        FakeSwitch {
            flavour: Flavour::DellOs10,
            hostname: "LAB-DELL-1".into(),
            cdp: String::new(),
            lldp: String::new(),
            loopback: "10.255.0.9".into(),
            arp: String::new(),
            macs: String::new(),
        },
    )
    .await;

    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);
    let result = crawl(
        "127.0.0.2",
        creds(),
        options(port),
        store,
        tx,
        CancellationToken::new(),
    )
    .await;

    assert_eq!(result.failures.len(), 0, "{:?}", result.failures);
    assert_eq!(result.devices.len(), 1, "{:?}", result.devices);
    let dell = &result.devices[0];
    assert_eq!(dell.hostname, "LAB-DELL-1");
    assert_eq!(dell.class, DeviceClass::Switch, "S5248F-ON is a switch");

    // The neighbour came out of the four-column table, which means the crawl
    // noticed the platform and asked the Dell question.
    let seen: Vec<&str> = result
        .not_visited
        .iter()
        .map(|n| n.short_name.as_str())
        .collect();
    assert!(seen.contains(&"SW1"), "the OS10 LLDP table was not read: {seen:?}");
    let sw1 = result
        .not_visited
        .iter()
        .find(|n| n.short_name == "SW1")
        .expect("SW1");
    assert_eq!(sw1.local_interface.as_deref(), Some("ethernet1/1/2"));
    assert_eq!(
        sw1.remote_interface.as_deref(),
        Some("GigabitEthernet1/0/24"),
        "a remote port id is read by column, not by splitting on spaces",
    );
}

/// A ticked subnet is swept for the login port, and a device no
/// neighbour names is logged into and identified as well. Unticked, the same
/// crawl reaches only the seed.
#[tokio::test]
async fn a_ticked_subnet_reaches_a_device_no_neighbour_names() {
    let port = free_port().await;
    for (addr, name) in [("127.0.0.66", "SEED-SW"), ("127.0.0.69", "LONE-RTR")] {
        start(addr, port, FakeSwitch { flavour: Flavour::Cisco, hostname: name.into(), cdp: String::new(), lldp: String::new(), loopback: String::new(), arp: String::new(), macs: String::new() }).await;
    }
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));

    let (tx, _rx) = mpsc::channel(256);
    let without = crawl("127.0.0.66", creds(), options(port), Arc::clone(&store), tx, CancellationToken::new()).await;
    assert_eq!(without.devices.iter().map(|d| d.hostname.as_str()).collect::<Vec<_>>(), ["SEED-SW"]);

    let (tx, mut rx) = mpsc::channel(4096);
    let mut o = options(port);
    o.scan_subnets = coreview_discover::subnetscan::parse_scan_subnets(&["127.0.0.64/29".into()]).unwrap();
    let with = crawl("127.0.0.66", creds(), o, store, tx, CancellationToken::new()).await;
    let mut names: Vec<&str> = with.devices.iter().map(|d| d.hostname.as_str()).collect();
    names.sort();
    assert_eq!(names, ["LONE-RTR", "SEED-SW"], "{:?}", with.failures);
    assert!(with.failures.is_empty(), "{:?}", with.failures);
    let mut scanned = None;
    while let Ok(e) = rx.try_recv() {
        if let coreview_discover::crawl::CrawlEvent::Scanned { subnet, tried, answered } = e {
            scanned = Some((subnet, tried, answered));
        }
    }
    assert_eq!(scanned, Some(("127.0.0.64/29".to_string(), 6, 2)));
}
