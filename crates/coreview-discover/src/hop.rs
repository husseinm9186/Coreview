//! Reaching a device through another device's own SSH.
//!
//! A crawl that hops: log in to a device, then from
//! that device's own prompt run `ssh` to the next one, and on down the
//! chain, instead of opening a new SSH session to every address straight
//! from the machine Coreview runs on. That is how an engineer reaches a
//! switch that only the core can see, and it is what a jump host is for.
//!
//! This module is the part with no I/O: a small state machine that, given
//! what has come back on the channel so far, says what to send next — the
//! answer to the host-key question, the password at the right moment — and
//! when the login has landed or failed. The byte-pushing lives in
//! `Device::hop_to`, which drives it over the channel it already owns.
//!
//! **It never writes to the device it passes through.** The `ssh` command
//! is sent with `StrictHostKeyChecking=accept-new` turned *off* and
//! `UserKnownHostsFile=/dev/null`, so the intermediate switch keeps no
//! record of where Coreview went; the fingerprint question is answered in
//! the session only, and the password is typed at the next device's own
//! prompt, never before it.
//!
//! Every device that advertises CDP or LLDP is a possible intermediate, so
//! the command is spelled the way the device running it spells `ssh`
//! ([`HopDialect`], picked from the platform the crawl already identified):
//! OpenSSH's `ssh user@host` on a Linux-shell switch (Cumulus, SONiC) or a
//! host — an SN2010, for one — the bare `ssh user@host` an EOS, Junos,
//! AOS-CX, Dell or Comware CLI takes, Cisco's `ssh -l user host` on IOS,
//! NX-OS and IOS-XR, and FortiOS's `execute ssh user@host`. The handshake
//! after the command — the fingerprint question, the password, the landing
//! — is the same whatever the pair, so only the command and the way out
//! differ. A platform with no known client form (an ArubaOS-Switch menu,
//! an AireOS controller) is not a hop origin, and the crawl reaches past it
//! directly and says so rather than guess a command.

use crate::ssh::Secret;

/// How a device spells "open an SSH session to another device". Picked from
/// the platform the crawl identified (see `dialect::hop_dialect_for`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HopDialect {
    /// `ssh <options> user@host` — OpenSSH, on a Linux shell or a host.
    /// The options keep the hop off the intermediate's `known_hosts`.
    #[default]
    OpenSsh,
    /// `ssh user@host` — a network CLI that takes the OpenSSH user@host form
    /// without the `-o` options (Arista EOS, Junos, ArubaOS-CX, Dell OS10,
    /// Comware, Huawei). The default for an unrecognised CLI, too.
    UserAtHost,
    /// `ssh -l user host` — Cisco IOS, IOS-XE, NX-OS, IOS-XR.
    CiscoDashL,
    /// `execute ssh user@host` — FortiOS.
    FortiOs,
}

impl HopDialect {
    /// The command that opens a session to `address` as `user`. OpenSSH is
    /// told not to touch the intermediate's `known_hosts` (so the hop
    /// leaves no trace on the device it passes through) and not to try a
    /// key or a dance this state machine does not drive; a network CLI
    /// keeps no user `known_hosts` file and takes none of that.
    pub fn ssh_command(self, user: &str, address: &str) -> String {
        match self {
            HopDialect::OpenSsh => format!(
                "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null -o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=1 {user}@{address}"
            ),
            HopDialect::UserAtHost => format!("ssh {user}@{address}"),
            HopDialect::CiscoDashL => format!("ssh -l {user} {address}"),
            HopDialect::FortiOs => format!("execute ssh {user}@{address}"),
        }
    }

    /// Leaving the hopped-into session: back to the device we came from.
    /// Every CLI built so far leaves with `exit`.
    pub fn exit_command(self) -> &'static str {
        "exit"
    }
}

/// What the driver should do next, from the output so far.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HopAction {
    /// Nothing yet — read more from the channel.
    Wait,
    /// Send this line (a newline is added by the driver). Answering the
    /// fingerprint question.
    Send(String),
    /// Send the password for the device being reached, then a newline.
    SendPassword,
    /// The login landed: the next device has drawn its prompt.
    Landed,
    /// The login failed, with a reason safe to show (no device output).
    Failed(HopError),
}

/// Why a hop did not land. Each is a class, not a quote of the device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HopError {
    /// The password was rejected, or too many prompts came.
    Rejected,
    /// The far device refused the connection or could not be reached.
    Unreachable,
    /// The far host's name did not resolve on the intermediate.
    Unresolved,
    /// The intermediate has no `ssh` client, or would not run it.
    NoClient,
    /// The far host's key check failed in a way `no` could not get past.
    HostKey,
}

impl HopError {
    pub fn describe(&self) -> &'static str {
        match self {
            HopError::Rejected => "the next device rejected the login",
            HopError::Unreachable => "the next device could not be reached from the one before it",
            HopError::Unresolved => "the next device's name did not resolve on the device before it",
            HopError::NoClient => "the device before it has no usable ssh client",
            HopError::HostKey => "the next device's host key could not be accepted",
        }
    }
}

/// The driver's state across reads. One hop; reset for the next.
#[derive(Debug, Default)]
pub struct Hop {
    answered_fingerprint: bool,
    sent_password: bool,
    /// The prompt of the device we are hopping *from*, so its reappearance
    /// (the `ssh` command having failed and returned us to it) is not
    /// mistaken for the next device's prompt.
    from_prompt: String,
}

impl Hop {
    /// `from_prompt` is the trimmed prompt line of the device the `ssh`
    /// command is being run on.
    pub fn new(from_prompt: &str) -> Self {
        Hop { from_prompt: from_prompt.trim().to_string(), ..Hop::default() }
    }

    /// What to do, from everything seen since the `ssh` command was sent.
    /// `buffer` is the rendered output (escape sequences already stripped).
    pub fn advance(&mut self, buffer: &str) -> HopAction {
        let low = buffer.to_ascii_lowercase();

        // Failures first: once any of these is in the buffer the login is
        // not going to land, whatever else is there.
        if let Some(err) = failure_in(&low) {
            return HopAction::Failed(err);
        }

        // The fingerprint question, answered once. OpenSSH asks it when the
        // key is new even with checking off? No — with
        // StrictHostKeyChecking=no it does not prompt; but an older client,
        // or one on a device that ignores the option, still might, so it is
        // answered if it appears.
        if !self.answered_fingerprint && asks_to_continue(&low) {
            self.answered_fingerprint = true;
            return HopAction::Send("yes".into());
        }

        // The password prompt — but only the next device's. The line asks
        // for a password and ends at the colon, still being written.
        if !self.sent_password && asks_for_password(buffer) {
            self.sent_password = true;
            return HopAction::SendPassword;
        }

        // Landed: a prompt that is not the one we came from, drawn after we
        // sent the password (or after the fingerprint, for a key login we
        // are not driving but might still land). A device that sent us back
        // to the original prompt has not landed.
        if self.sent_password {
            if let Some(line) = last_nonempty(buffer) {
                let t = line.trim();
                if looks_like_prompt(t) && t != self.from_prompt && !asks_for_password(buffer) {
                    return HopAction::Landed;
                }
            }
        }

        HopAction::Wait
    }
}

/// A failure class named in the output, if any.
fn failure_in(low: &str) -> Option<HopError> {
    const REJECTED: &[&str] = &["permission denied", "access denied", "authentication failed", "too many authentication failures", "login incorrect"];
    const UNREACHABLE: &[&str] = &["connection refused", "connection timed out", "no route to host", "network is unreachable", "connection closed", "operation timed out", "unable to connect"];
    const UNRESOLVED: &[&str] = &["could not resolve", "name or service not known", "nodename nor servname", "name does not resolve"];
    const NO_CLIENT: &[&str] = &["command not found", "ssh: not found", "unknown command", "invalid input", "% unknown", "bad command"];
    const HOST_KEY: &[&str] = &["host key verification failed", "no matching host key", "remote host identification has changed"];
    if REJECTED.iter().any(|m| low.contains(m)) {
        Some(HopError::Rejected)
    } else if UNRESOLVED.iter().any(|m| low.contains(m)) {
        Some(HopError::Unresolved)
    } else if HOST_KEY.iter().any(|m| low.contains(m)) {
        Some(HopError::HostKey)
    } else if UNREACHABLE.iter().any(|m| low.contains(m)) {
        Some(HopError::Unreachable)
    } else if NO_CLIENT.iter().any(|m| low.contains(m)) {
        Some(HopError::NoClient)
    } else {
        None
    }
}

fn asks_to_continue(low: &str) -> bool {
    low.contains("are you sure you want to continue connecting") || low.contains("(yes/no") || low.contains("fingerprint")
}

/// The last line is a password request: it mentions a password and ends at
/// the colon the device is waiting after.
fn asks_for_password(buffer: &str) -> bool {
    let Some(line) = last_nonempty(buffer) else { return false };
    let t = line.trim_end();
    let low = t.to_ascii_lowercase();
    (low.ends_with("password:") || low.ends_with("password: ") || low.ends_with("passphrase:") || (low.contains("password for") && t.ends_with(':')))
        && !low.contains("password changed")
}

fn last_nonempty(buffer: &str) -> Option<&str> {
    buffer.lines().rev().find(|l| !l.trim().is_empty())
}

/// A line that looks like a shell or CLI prompt: it ends in one of the
/// characters a prompt ends in, and what precedes it is short and has no
/// interior spaces beyond a path/context. Deliberately close to
/// `cli::prompt_from_line`, but it only has to tell "a prompt" from "a
/// password request or a banner line", so it is simpler.
fn looks_like_prompt(line: &str) -> bool {
    let t = line.trim_end();
    let Some(last) = t.chars().last() else { return false };
    if !matches!(last, '#' | '$' | '>' | '%') {
        return false;
    }
    let head = t[..t.len() - last.len_utf8()].trim_end();
    // A prompt's head is non-empty, not too long, and not a sentence.
    !head.is_empty() && head.len() <= 64 && head.split_whitespace().count() <= 3 && !head.ends_with(',') && !head.to_ascii_lowercase().contains("password")
}

/// Secret-aware: the driver hands the password straight to the channel, so
/// this module never needs to see it; the type is here to keep the surface
/// in one place.
pub type HopSecret = Secret;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_openssh_command_leaves_no_trace_and_forces_a_password() {
        let c = HopDialect::OpenSsh.ssh_command("netops", "198.51.100.4");
        assert!(c.contains("UserKnownHostsFile=/dev/null"), "{c}");
        assert!(c.contains("StrictHostKeyChecking=no"));
        assert!(c.contains("PubkeyAuthentication=no") && c.contains("NumberOfPasswordPrompts=1"));
        assert!(c.ends_with("netops@198.51.100.4"));
    }

    #[test]
    fn each_platform_spells_the_ssh_command_its_own_way() {
        assert_eq!(HopDialect::UserAtHost.ssh_command("admin", "10.0.0.9"), "ssh admin@10.0.0.9");
        assert_eq!(HopDialect::CiscoDashL.ssh_command("admin", "10.0.0.9"), "ssh -l admin 10.0.0.9");
        assert_eq!(HopDialect::FortiOs.ssh_command("admin", "10.0.0.9"), "execute ssh admin@10.0.0.9");
        for d in [HopDialect::OpenSsh, HopDialect::UserAtHost, HopDialect::CiscoDashL, HopDialect::FortiOs] {
            assert_eq!(d.exit_command(), "exit");
        }
    }

    /// The dialect is picked from the platform the crawl identified.
    #[test]
    fn the_platform_decides_the_hop_command() {
        use crate::dialect::{hop_dialect_for, Family};
        assert_eq!(hop_dialect_for(Family::Cumulus), Some(HopDialect::OpenSsh));
        assert_eq!(hop_dialect_for(Family::Sonic), Some(HopDialect::OpenSsh));
        assert_eq!(hop_dialect_for(Family::Vyatta), Some(HopDialect::OpenSsh));
        assert_eq!(hop_dialect_for(Family::CiscoIos), Some(HopDialect::CiscoDashL));
        assert_eq!(hop_dialect_for(Family::CiscoNxOs), Some(HopDialect::CiscoDashL));
        assert_eq!(hop_dialect_for(Family::FortiOs), Some(HopDialect::FortiOs));
        assert_eq!(hop_dialect_for(Family::AristaEos), Some(HopDialect::UserAtHost));
        assert_eq!(hop_dialect_for(Family::ArubaOsCx), Some(HopDialect::UserAtHost));
        assert_eq!(hop_dialect_for(Family::Junos), Some(HopDialect::UserAtHost));
        assert_eq!(hop_dialect_for(Family::ArubaOsSwitch), Some(HopDialect::UserAtHost));
        assert_eq!(hop_dialect_for(Family::PanOs), Some(HopDialect::UserAtHost));
        assert_eq!(hop_dialect_for(Family::Dell), Some(HopDialect::UserAtHost));
        // A wireless controller is not a transit device.
        assert_eq!(hop_dialect_for(Family::AireOs), None);
        assert_eq!(hop_dialect_for(Family::ArubaController), None);
        // An unrecognised CLI gets the most permissive network form.
        assert_eq!(hop_dialect_for(Family::Generic), Some(HopDialect::UserAtHost));
    }

    /// A real capture: ssh from one switch to another. The
    /// banner, the fingerprint question, the password, the landing.
    #[test]
    fn an_ssh_from_a_switch_to_the_6200() {
        let mut h = Hop::new("netops@leaf-b02:mgmt:~$");
        // Banner and the fingerprint question.
        let a = h.advance("The authenticity of host '198.51.100.4' can't be established.\nED25519 key fingerprint is SHA256:Example.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ");
        assert_eq!(a, HopAction::Send("yes".into()));
        // The nag and the password prompt.
        let a = h.advance("Warning: Permanently added '198.51.100.4'.\n\n (C) Copyright 2017-2026 Hewlett Packard Enterprise.\nnetops@198.51.100.4's password: ");
        assert_eq!(a, HopAction::SendPassword);
        // Still reading: last login lines, then the 6200's prompt.
        assert_eq!(h.advance("Last login: 2026-10-06 17:13:33\nUser \"netops\" has logged in 7 times in the past 30 days\n"), HopAction::Wait);
        assert_eq!(h.advance("Last login: 2026-10-06 17:13:33\nUser \"netops\" has logged in 7 times\ncx-1# "), HopAction::Landed);
    }

    #[test]
    fn a_key_login_with_no_fingerprint_prompt_still_lands() {
        let mut h = Hop::new("admin@core:~$");
        // StrictHostKeyChecking=no: no question, straight to the password.
        assert_eq!(h.advance("admin@10.0.0.9's password: "), HopAction::SendPassword);
        assert_eq!(h.advance("leaf01:~$ "), HopAction::Landed);
    }

    #[test]
    fn returning_to_the_same_prompt_is_not_a_landing() {
        let mut h = Hop::new("netops@leaf-b02:mgmt:~$");
        assert_eq!(h.advance("netops@198.51.100.4's password: "), HopAction::SendPassword);
        // A wrong password drops back to the switch's own prompt.
        assert_eq!(h.advance("Permission denied, please try again.\nnetops@leaf-b02:mgmt:~$ "), HopAction::Failed(HopError::Rejected));
    }

    #[test]
    fn every_failure_class_is_told_apart() {
        let f = |s: &str| {
            let mut h = Hop::new("sw#");
            h.advance(s)
        };
        assert_eq!(f("ssh: connect to host 10.0.0.9 port 22: Connection refused"), HopAction::Failed(HopError::Unreachable));
        assert_eq!(f("ssh: connect to host 10.0.0.9 port 22: Connection timed out"), HopAction::Failed(HopError::Unreachable));
        assert_eq!(f("ssh: Could not resolve hostname leaf99: Name or service not known"), HopAction::Failed(HopError::Unresolved));
        assert_eq!(f("-bash: ssh: command not found"), HopAction::Failed(HopError::NoClient));
        assert_eq!(f("% Unknown command or computer name"), HopAction::Failed(HopError::NoClient));
        assert_eq!(f("Host key verification failed."), HopAction::Failed(HopError::HostKey));
        assert_eq!(f("netops@host: Permission denied (publickey,password)."), HopAction::Failed(HopError::Rejected));
        // A failure beats an otherwise-landable prompt in the same buffer.
        let mut h = Hop::new("sw#");
        h.advance("sw# x");
        assert_eq!(h.advance("Permission denied\nsw# "), HopAction::Failed(HopError::Rejected));
    }

    #[test]
    fn a_password_request_is_not_mistaken_for_a_prompt() {
        assert!(asks_for_password("user@host's password: "));
        assert!(asks_for_password("Password: "));
        assert!(!asks_for_password("some text, no colon"));
        assert!(!looks_like_prompt("netops@198.51.100.4's password:"));
        assert!(looks_like_prompt("cx-1# "));
        assert!(looks_like_prompt("netops@leaf-b02:mgmt:~$"));
        assert!(!looks_like_prompt("Please read the following carefully before you continue #"));
    }
}
