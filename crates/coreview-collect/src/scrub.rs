//! Secrets out of a configuration before it is kept anywhere (the spec's
//! non-negotiable; D-006). Every kind the spec lists and the ones each
//! vendor adds: enable and username secrets, SNMP communities, pre-shared
//! keys, key-strings, `set password` / `set psksecret` (FortiOS), tunnel-group
//! keys (ASA), and the hashed forms Junos, EOS, NX-OS, PAN-OS and ArubaOS
//! write. The replacement says what was there, so a diff still shows a
//! secret changed without showing either value.

use std::sync::OnceLock;

use regex::Regex;

/// (pattern, replacement) pairs, applied line by line. Each pattern keeps
/// the keyword and removes the value that follows it.
fn rules() -> &'static [(Regex, &'static str)] {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    RULES.get_or_init(|| {
        let r = |p: &str| Regex::new(p).expect("a fixed regex");
        vec![
            // Cisco IOS / IOS-XE / NX-OS / XR
            (r(r"(?m)^(\s*enable (?:secret|password)(?: level \d+)?(?: \d)?) .*$"), "$1 <removed-by-coreview>"),
            (r(r"(?m)^(\s*username \S+(?: privilege \d+)? (?:secret|password)(?: \d)?) .*$"), "$1 <removed-by-coreview>"),
            (r(r"(?m)^(\s*snmp-server community) \S+(.*)$"), "$1 <removed-by-coreview>$2"),
            (r(r"(?m)^(\s*snmp-server (?:host|user) .*?(?:auth|priv|md5|sha)) .*$"), "$1 <removed-by-coreview>"),
            (r(r"(?m)^(\s*(?:tacacs-server|radius-server) key(?: \d)?) .*$"), "$1 <removed-by-coreview>"),
            // LT-607: the community after a v1/v2c trap host, and the key on a
            // server line — forms the rules above did not reach.
            (r(r"(?m)^(\s*snmp-server host \S+(?: (?:informs|traps|vrf \S+|udp-port \d+))* version (?:1|2c)) \S+(.*)$"), "$1 <removed-by-coreview>$2"),
            (r(r"(?m)^(\s*snmp-server host \S+(?: (?:informs|traps|vrf \S+))*) \S+$"), "$1 <removed-by-coreview>"),
            (r(r"(?m)^(\s*(?:radius-server|tacacs-server) host .*? key(?: \d)?) \S+(.*)$"), "$1 <removed-by-coreview>$2"),
            (r(r"(?m)^(\s*server-private .*? key(?: \d)?) \S+(.*)$"), "$1 <removed-by-coreview>$2"),
            (r(r"(?m)^(\s*key(?: \d)?) (?:7 )?\S+$"), "$1 <removed-by-coreview>"),
            (r(r"(?m)^(\s*key-string(?: \d)?) .*$"), "$1 <removed-by-coreview>"),
            (r(r"(?m)^(\s*crypto isakmp key) \S+( .*)$"), "$1 <removed-by-coreview>$2"),
            (r(r"(?m)^(\s*pre-shared-key(?: local| remote)?(?: \d)?) .*$"), "$1 <removed-by-coreview>"),
            (r(r"(?m)^(\s*(?:ip )?ospf (?:authentication-key|message-digest-key \d+ md5)(?: \d)?) .*$"), "$1 <removed-by-coreview>"),
            (r(r"(?m)^(\s*neighbor \S+ password(?: \d)?) .*$"), "$1 <removed-by-coreview>"),
            (r(r"(?m)^(\s*(?:standby|vrrp) \d+ authentication(?: (?:md5 key-string|text))?(?: \d)?) .*$"), "$1 <removed-by-coreview>"),
            (r(r"(?m)^(\s*(?:ntp|tunnel) (?:authentication-key \d+ md5|key)(?: \d)?) .*$"), "$1 <removed-by-coreview>"),
            (r(r"(?m)^(\s*password(?: \d)?) \S+$"), "$1 <removed-by-coreview>"),
            (r(r"(?m)^(\s*secret(?: \d)?) \S+$"), "$1 <removed-by-coreview>"),
            (r(r"(?m)^(\s*wpa-psk(?: ascii| hex)?(?: \d)?) .*$"), "$1 <removed-by-coreview>"),
            // ASA
            (r(r"(?m)^(\s*(?:ikev1 |ikev2 )?(?:pre-shared-key|local-authentication pre-shared-key|remote-authentication pre-shared-key)) .*$"), "$1 <removed-by-coreview>"),
            (r(r"(?m)^(\s*passwd(?: \S+)?) \S+ encrypted$"), "$1 <removed-by-coreview>"),
            (r(r"(?m)^(\s*(?:aaa-server \S+ \(\S+\) host \S+|ldap-login-password|failover key)) .*$"), "$1 <removed-by-coreview>"),
            // FortiOS
            (r(r#"(?m)^(\s*set (?:password|passwd|psksecret|secret|key|auth-password-l1|auth-password-l2|priv-password|community|private-key|passphrase|auth-password|presharedkey|psk|wpa|ppk-secret|secondary-secret|tertiary-secret|ipsec-key|radius-secret|ha-mgmt-password|admin-password)) .*$"#), "$1 <removed-by-coreview>"),
            (r(r#"(?m)^(\s*set \S*(?:password|secret|psk|community)\S*) .*$"#), "$1 <removed-by-coreview>"),
            // Junos
            (r(r"(?m)^(\s*set snmp community) \S+(.*)$"), "$1 <removed-by-coreview>$2"),
            (r(r#"(?m)^(\s*(?:encrypted-password|plain-text-password-value|pre-shared-key (?:ascii-text|hexadecimal)|authentication-key|key \d+ secret|secret|md5 \d+ key|community \S+)) .*$"#), "$1 <removed-by-coreview>"),
            (r(r#"(?m)(secret|authentication-key|ascii-text|hexadecimal|encrypted-password) "\$\d\$[^"]*"(?: ## SECRET-DATA)?"#), "$1 <removed-by-coreview>"),
            // PAN-OS (set format)
            (r(r"(?m)^(.*\b(?:phash|password|pre-shared-key|key|secret|community|auth-password|priv-password)) \S+$"), "$1 <removed-by-coreview>"),
            // Arista EOS
            (r(r"(?m)^(\s*(?:enable|username \S+) (?:secret|password) (?:sha512|md5|0|7)) .*$"), "$1 <removed-by-coreview>"),
            // ArubaOS-Switch / AOS-CX
            (r(r"(?m)^(\s*(?:password (?:manager|operator)|user \S+ password|password) (?:sha1|sha256|plaintext|ciphertext)) .*$"), "$1 <removed-by-coreview>"),
            (r(r"(?m)^(\s*(?:radius-server|tacacs-server) host \S+ key) .*$"), "$1 <removed-by-coreview>"),
            (r(r"(?m)^(\s*snmp(?:v3)?-server (?:community|user) \S+.*?(?:auth|priv) \S+) .*$"), "$1 <removed-by-coreview>"),
            // Huawei / Comware
            (r(r"(?m)^(.*\b(?:password|authentication-mode|pre-shared-key|key|community) (?:cipher|simple|irreversible-cipher|hash)) .*$"), "$1 <removed-by-coreview>"),
            (r(r"(?m)^(\s*snmp-agent community (?:read|write)) \S+(.*)$"), "$1 <removed-by-coreview>$2"),
        ]
    })
}

/// A configuration with its secrets removed.
pub fn scrub(text: &str) -> String {
    let mut out = text.to_string();
    for (re, rep) in rules() {
        out = re.replace_all(&out, *rep).into_owned();
    }
    out
}

/// True when nothing that looks like a secret survived the scrub — the
/// check a test runs over every fixture, and the collector runs before a
/// configuration is written anywhere.
pub fn looks_clean(text: &str) -> bool {
    // The optional `5` / `7` / `9` before a Cisco value is the encryption type, not the secret.
    let re = Regex::new(r"(?mi)^\s*(?:enable secret|snmp-server community|snmp-server host \S+(?: \S+)*? version (?:1|2c)|(?:radius-server|tacacs-server) host .*? key(?: \d)?|server-private .*? key(?: \d)?|set password|set psksecret|pre-shared-key|key-string|tunnel-group .* key|encrypted-password)(?: \d)? (\S+)").unwrap();
    let survivor = re.captures_iter(text).any(|c| !c[1].starts_with("<removed-by-coreview>"));
    !survivor && !text.contains("$9$") && !text.contains("$1$") && !text.contains("$5$") && !text.contains("$8$") && !text.contains("$6$")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every kind the spec names, and each vendor's spelling. The values are
    /// obviously fake — a test fixture is never a plausible credential.
    const CONFIG: &str = r#"
hostname EDGE-1
enable secret 5 $1$FAKE$notarealhashxxxxxxxxxxxxxx
enable password 7 0123456789ABCDEF
username admin privilege 15 secret 9 $9$FAKE.notreal
username readonly password 7 0102030405
snmp-server community FAKE-COMMUNITY RO
snmp-server community FAKE-RW RW ACL-MGMT
snmp-server user v3user grp v3 auth sha FAKEAUTH priv aes 128 FAKEPRIV
tacacs-server key 7 0123456789
radius-server key FAKE-RADIUS
crypto isakmp key FAKE-PSK address 192.0.2.99
key chain OSPF
 key 1
  key-string 7 FAKEKEYSTRING
interface Tunnel0
 tunnel key 12345
 ip ospf authentication-key 7 FAKEOSPF
 ip ospf message-digest-key 1 md5 7 FAKEMD5
 standby 1 authentication md5 key-string 7 FAKEHSRP
router bgp 65000
 neighbor 192.0.2.2 password 7 FAKEBGP
ntp authentication-key 1 md5 FAKENTP 7
tunnel-group 203.0.113.9 ipsec-attributes
 ikev1 pre-shared-key FAKE-ASA-PSK
 ikev2 remote-authentication pre-shared-key FAKE-ASA-IKEV2
passwd FAKEPASSWD encrypted
failover key FAKEFAILOVER
config system admin
    edit "admin"
        set password ENC FAKEENCRYPTEDBLOB==
    next
end
config vpn ipsec phase1-interface
    edit "to-hq"
        set psksecret ENC FAKEPSKBLOB==
    next
end
config system snmp community
    edit 1
        set name "FAKE-FGT-COMMUNITY"
    next
end
set system root-authentication encrypted-password "$6$FAKE$notreal" ## SECRET-DATA
set security ike policy P1 pre-shared-key ascii-text "$9$FAKEJUNOS" ## SECRET-DATA
set snmp community FAKE-JUNOS-COMMUNITY authorization read-only
set mgt-config users admin phash FAKEPANHASH
set network ike gateway GW1 authentication pre-shared-key key -AQ==FAKEPAN
enable secret sha512 $6$FAKEARISTA$notreal
password manager sha1 FAKEARUBASHA1
user admin password ciphertext FAKEAOSCX==
radius-server host 192.0.2.5 key FAKEARUBARADIUS
local-user admin password irreversible-cipher $1c$FAKEHUAWEI
snmp-agent community read FAKEHUAWEICOMM
"#;

    #[test]
    fn every_secret_kind_is_removed_and_the_keywords_stay() {
        let out = scrub(CONFIG);
        for token in [
            "$1$FAKE", "0123456789ABCDEF", "$9$FAKE.notreal", "0102030405", "FAKE-COMMUNITY", "FAKE-RW", "FAKEAUTH", "FAKEPRIV", "FAKE-RADIUS", "FAKE-PSK",
            "FAKEKEYSTRING", "FAKEOSPF", "FAKEMD5", "FAKEHSRP", "FAKEBGP", "FAKENTP", "FAKE-ASA-PSK", "FAKE-ASA-IKEV2", "FAKEPASSWD", "FAKEFAILOVER",
            "FAKEENCRYPTEDBLOB", "FAKEPSKBLOB", "$6$FAKE$notreal", "$9$FAKEJUNOS", "FAKEPANHASH", "-AQ==FAKEPAN", "$6$FAKEARISTA", "FAKEARUBASHA1",
            "FAKEAOSCX", "FAKEARUBARADIUS", "$1c$FAKEHUAWEI", "FAKEHUAWEICOMM", "12345",
        ] {
            assert!(!out.contains(token), "{token} survived:\n{out}");
        }
        for kept in ["hostname EDGE-1", "enable secret", "snmp-server community", "RO", "RW ACL-MGMT", "router bgp 65000", "set psksecret", "tunnel-group 203.0.113.9", "interface Tunnel0", "authorization read-only", "set security ike policy P1 pre-shared-key"] {
            assert!(out.contains(kept), "{kept} was lost:\n{out}");
        }
        assert!(looks_clean(&out), "{out}");
        assert!(!looks_clean(CONFIG));
    }

    /// LT-607: three IOS forms that survived into a support capture.
    #[test]
    fn snmp_hosts_and_radius_keys_are_removed_too() {
        let text = "snmp-server host 192.0.2.5 version 2c c0mmun1ty-fixture
snmp-server host 192.0.2.6 informs version 2c other-fixture udp-port 1162
snmp-server host 192.0.2.9 public-fixture
snmp-server host 192.0.2.7 version 3 auth snmpuser
radius-server host 192.0.2.7 auth-port 1812 acct-port 1813 key 7 0123456789ABCDEFFIXTURE
tacacs-server host 192.0.2.8 key 0 plain-fixture
 server-private 192.0.2.8 key 7 0123456789ABCDEFFIXTURE
 server-private 192.0.2.9 auth-port 1812 key 0 plain-fixture
";
        let out = scrub(text);
        for token in ["c0mmun1ty-fixture", "other-fixture", "public-fixture", "0123456789ABCDEFFIXTURE", "plain-fixture"] {
            assert!(!out.contains(token), "{token} survived:\n{out}");
        }
        assert!(out.contains("snmp-server host 192.0.2.5 version 2c <removed-by-coreview>"), "{out}");
        assert!(out.contains("<removed-by-coreview> udp-port 1162"), "the rest of the line stays: {out}");
        // A v3 line is the older rule's: everything after `auth` goes, user included.
        assert!(out.contains("snmp-server host 192.0.2.7 version 3 auth <removed-by-coreview>"), "{out}");
        assert!(out.contains("radius-server host 192.0.2.7 auth-port 1812 acct-port 1813 key 7 <removed-by-coreview>"), "{out}");
        assert!(out.contains(" server-private 192.0.2.8 key 7 <removed-by-coreview>"), "{out}");
        assert!(looks_clean(&out), "{out}");
        assert!(!looks_clean(text));
    }

    #[test]
    fn a_configuration_with_no_secrets_is_left_alone() {
        let text = "hostname SW-1\ninterface GigabitEthernet1/0/1\n description uplink\n switchport mode trunk\nip route 0.0.0.0 0.0.0.0 192.0.2.1\n";
        assert_eq!(scrub(text), text);
    }
}
