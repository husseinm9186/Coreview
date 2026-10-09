//! A configuration backup over SNMP — the one way a configuration travels
//! over it.
//!
//! SNMP cannot read a configuration: no object returns one. What Cisco's
//! CISCO-CONFIG-COPY-MIB offers is a *request*: a row written into
//! `ccCopyTable` tells the device to copy its running or startup
//! configuration to a file server of the caller's choosing, and
//! `ccCopyState` says when it has. So this module writes that row, waits
//! for the copy to finish, destroys the row, and leaves fetching the file
//! to [`crate::sftp`]. It is the only SNMP SET Coreview sends; it is sent
//! only when a backup asked for it; and the device is left as it was found,
//! the row included.
//!
//! The SET carries the SFTP login the device will use, because the device
//! is the one logging in to the server. Under v3 with privacy that travels
//! encrypted; under v2c it crosses the network in clear, like the community
//! beside it. The interface says so where the option is ticked.
//!
//! Built from the MIB's definition rather than a capture: the column
//! numbers and enumerations are the MIB's own, and
//! [`verified_against_hardware`] says `false` until a Cisco has answered one
//! of these for real.

use std::net::IpAddr;
use std::time::Duration;

use snmp2::{Oid, Value};

use crate::backup::BackupKind;
use crate::snmp::{open_session, SnmpAuth, SnmpError};
use crate::ssh::Secret;

/// `ccCopyEntry` — every column of the one row this writes hangs off it.
const CC_COPY_ENTRY: [u64; 13] = [1, 3, 6, 1, 4, 1, 9, 9, 96, 1, 1, 1, 1];
const COL_PROTOCOL: u64 = 2;
const COL_SOURCE_FILE_TYPE: u64 = 3;
const COL_DEST_FILE_TYPE: u64 = 4;
const COL_FILE_NAME: u64 = 6;
const COL_USER_NAME: u64 = 7;
const COL_USER_PASSWORD: u64 = 8;
const COL_STATE: u64 = 10;
const COL_FAIL_CAUSE: u64 = 13;
const COL_ROW_STATUS: u64 = 14;
const COL_SERVER_ADDRESS_TYPE: u64 = 15;
const COL_SERVER_ADDRESS_REV1: u64 = 16;

/// `ccCopyProtocol`: sftp(5). The others — tftp, ftp, rcp, scp — are
/// deliberately not offered: three of them send the file in clear, and scp
/// needs a server that speaks it, which an SFTP-only server does not.
const PROTOCOL_SFTP: i64 = 5;
/// `ConfigFileType`: networkFile(1), startupConfig(3), runningConfig(4).
const FILE_TYPE_NETWORK: i64 = 1;
const FILE_TYPE_STARTUP: i64 = 3;
const FILE_TYPE_RUNNING: i64 = 4;
/// `RowStatus`: createAndGo(4), destroy(6).
const ROW_CREATE_AND_GO: i64 = 4;
const ROW_DESTROY: i64 = 6;
/// `InetAddressType`: ipv4(1), ipv6(2), dns(16).
const ADDRESS_IPV4: i64 = 1;
const ADDRESS_IPV6: i64 = 2;
const ADDRESS_DNS: i64 = 16;

/// `sysName.0`, for the device's own name as the file's.
const SYS_NAME: [u64; 9] = [1, 3, 6, 1, 2, 1, 1, 5, 0];

/// Whether this has met a Cisco. The column numbers and the enumerations
/// are the MIB's; what a real device answers has not yet been seen.
pub fn verified_against_hardware() -> bool {
    false
}

/// The server a device is asked to send its configuration to, and the login
/// it is given to do so. Coreview fetches the file from the same server with
/// the same login afterwards.
#[derive(Clone)]
pub struct SftpServer {
    pub host: String,
    pub port: u16,
    /// The folder on the server the files go into. Empty is the login's own
    /// home folder.
    pub folder: String,
    pub username: String,
    pub password: Secret,
}

impl SftpServer {
    /// Where a file of this name lands on the server.
    pub fn remote_path(&self, file: &str) -> String {
        let folder = self.folder.trim().trim_end_matches('/');
        if folder.is_empty() {
            file.to_string()
        } else {
            format!("{folder}/{file}")
        }
    }
}

impl std::fmt::Debug for SftpServer {
    /// The password is a credential; it is never printed.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SftpServer {{ {}@{}:{} {:?} }}", self.username, self.host, self.port, self.folder)
    }
}

/// How the device is asked.
#[derive(Debug, Clone)]
pub struct SnmpCopy {
    /// A credential the device accepts a SET from. Read-only ones are
    /// refused by the device, and the refusal is reported as such.
    pub auth: SnmpAuth,
    pub port: u16,
    /// Per request.
    pub timeout: Duration,
    /// How long the device is given to finish the copy once it has
    /// accepted the request.
    pub wait: Duration,
}

impl Default for SnmpCopy {
    fn default() -> Self {
        Self {
            auth: SnmpAuth::V2c { community: String::new() },
            port: 161,
            timeout: Duration::from_secs(5),
            wait: Duration::from_secs(120),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CopyError {
    /// The device refused to create the row in a way that says it has no
    /// such table — the MIB is Cisco's, and most other makers do not carry
    /// it. The caller backs the device up some other way.
    #[error("{host} has no configuration-copy table over SNMP ({status}); this is a Cisco MIB")]
    NoSuchTable { host: String, status: &'static str },
    /// The device has the table and refused the write: a read-only
    /// credential, most often.
    #[error("{host} refused the SNMP write ({status}); the credential may be read-only")]
    Refused { host: String, status: &'static str },
    /// The device took the request and reported the copy failed, with the
    /// cause it gave.
    #[error("{host} could not send its configuration: {cause}")]
    Failed { host: String, cause: &'static str },
    /// The device took the request and had not finished within the wait.
    #[error("{host} had not finished sending its configuration after {}s", .wait.as_secs())]
    NotFinished { host: String, wait: Duration },
    #[error(transparent)]
    Snmp(#[from] SnmpError),
}

impl CopyError {
    /// Whether the device can still be backed up another way — nothing
    /// about it has been changed, and the reason is about SNMP, not about
    /// the device. Every variant qualifies; the type exists so a caller
    /// says which reason it carried on past.
    pub fn is_fallback_worthy(&self) -> bool {
        true
    }
}

/// RFC 3416's error-status names, for a message that says what the device
/// said rather than a number.
fn status_name(status: u32) -> &'static str {
    match status {
        0 => "noError",
        1 => "tooBig",
        2 => "noSuchName",
        3 => "badValue",
        4 => "readOnly",
        5 => "genErr",
        6 => "noAccess",
        7 => "wrongType",
        8 => "wrongLength",
        9 => "wrongEncoding",
        10 => "wrongValue",
        11 => "noCreation",
        12 => "inconsistentValue",
        13 => "resourceUnavailable",
        14 => "commitFailed",
        15 => "undoFailed",
        16 => "authorizationError",
        17 => "notWritable",
        18 => "inconsistentName",
        _ => "unknown error",
    }
}

/// `ccCopyFailCause`'s words.
fn fail_cause(cause: i64) -> &'static str {
    match cause {
        1 => "the device gave no reason",
        2 => "the device rejected the file name",
        3 => "the copy timed out — can the device reach the SFTP server?",
        4 => "the device ran out of memory",
        5 => "the device has no such configuration",
        6 => "the device does not support SFTP for this copy",
        7 => "part of the configuration could not be applied",
        8 => "the device was not ready",
        9 => "the request was aborted",
        _ => "an unknown cause",
    }
}

/// Which the SET's refusal means: no table, or no write access.
fn classify_refusal(host: &str, status: u32) -> CopyError {
    let name = status_name(status);
    match status {
        // noAccess, readOnly and authorizationError are the device saying
        // it knows the object and will not let this credential write it.
        4 | 6 | 16 => CopyError::Refused { host: host.into(), status: name },
        // noSuchName, noCreation, notWritable and inconsistentName are what
        // a device without the table answers; wrongValue is what a device
        // that has the table but not SFTP in its protocol enumeration
        // answers, which also means "not this way".
        _ => CopyError::NoSuchTable { host: host.into(), status: name },
    }
}

fn column(col: u64, row: u64) -> Vec<u64> {
    let mut oid = CC_COPY_ENTRY.to_vec();
    oid.push(col);
    oid.push(row);
    oid
}

/// A row index nobody else is using: the MIB lets the manager pick any
/// positive Integer32, and the row is destroyed again on the way out.
fn fresh_row() -> u64 {
    let mut bytes = [0u8; 4];
    if getrandom::getrandom(&mut bytes).is_err() {
        // Anything positive will do; two managers writing the same row at
        // the same second would also need the same server and file name.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(1);
        bytes = nanos.to_be_bytes();
    }
    u64::from(u32::from_be_bytes(bytes) % 0x7fff_fffe) + 1
}

/// The file name a configuration is sent under: the device's own name
/// where the characters are safe on any server, the kind, and the run's
/// stamp, so two devices and two runs never collide.
pub fn file_name(device: &str, kind: BackupKind, stamp: &str) -> String {
    let safe: String = device
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_' { c } else { '_' })
        .collect();
    let safe = safe.trim_matches('_');
    let safe = if safe.is_empty() { "device" } else { safe };
    format!("{safe}-{}-{stamp}.cfg", kind.slug())
}

/// The device's own name from `sysName.0`, or nothing when it does not
/// answer — the caller then files the capture under the name it was given.
pub async fn system_name(host: &str, copy: &SnmpCopy) -> Option<String> {
    let mut session = open_session(host, copy.port, &copy.auth, copy.timeout).await.ok()?;
    let oid = Oid::from(&SYS_NAME[..]).ok()?;
    let pdu = tokio::time::timeout(copy.timeout, session.get(&oid)).await.ok()?.ok()?;
    for (_, value) in pdu.varbinds {
        if let Value::OctetString(bytes) = value {
            let text = String::from_utf8_lossy(bytes).trim().to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}

/// Asks `host` to send its `kind` configuration to `server` as `file`,
/// waits for it to say the copy finished, and destroys the row it wrote.
/// Returns the path on the server the file was sent to.
pub async fn request_copy(
    host: &str,
    copy: &SnmpCopy,
    server: &SftpServer,
    kind: BackupKind,
    file: &str,
) -> Result<String, CopyError> {
    let source = match kind {
        BackupKind::Running => FILE_TYPE_RUNNING,
        BackupKind::Startup => FILE_TYPE_STARTUP,
        // Only a configuration has a file type the MIB can name.
        other => {
            return Err(CopyError::Failed { host: host.into(), cause: match other {
                BackupKind::ShowCommands => "show commands cannot be sent over SNMP",
                _ => "only a configuration can be sent over SNMP",
            }})
        }
    };
    let remote = server.remote_path(file);

    crate::say!(
        crate::debuglog::Area::Snmp,
        "{host}:{} asking for {} to be sent to {}@{}:{} as {remote} with {:?}",
        copy.port,
        kind.slug(),
        server.username,
        server.host,
        server.port,
        copy.auth,
    );
    let mut session = open_session(host, copy.port, &copy.auth, copy.timeout).await?;
    let row = fresh_row();

    // The address as the MIB's InetAddress: four or sixteen octets for an
    // address, the name's own bytes for a name the device resolves itself.
    let (address_type, address_bytes): (i64, Vec<u8>) = match server.host.trim().parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => (ADDRESS_IPV4, v4.octets().to_vec()),
        Ok(IpAddr::V6(v6)) => (ADDRESS_IPV6, v6.octets().to_vec()),
        Err(_) => (ADDRESS_DNS, server.host.trim().as_bytes().to_vec()),
    };

    let oids: Vec<Vec<u64>> = [
        COL_PROTOCOL,
        COL_SOURCE_FILE_TYPE,
        COL_DEST_FILE_TYPE,
        COL_SERVER_ADDRESS_TYPE,
        COL_SERVER_ADDRESS_REV1,
        COL_FILE_NAME,
        COL_USER_NAME,
        COL_USER_PASSWORD,
        COL_ROW_STATUS,
    ]
    .iter()
    .map(|c| column(*c, row))
    .collect();
    let parsed: Vec<Oid<'_>> = oids.iter().map(|o| Oid::from(&o[..]).expect("a fixed OID parses")).collect();
    let values: Vec<(&Oid<'_>, Value<'_>)> = vec![
        (&parsed[0], Value::Integer(PROTOCOL_SFTP)),
        (&parsed[1], Value::Integer(source)),
        (&parsed[2], Value::Integer(FILE_TYPE_NETWORK)),
        (&parsed[3], Value::Integer(address_type)),
        (&parsed[4], Value::OctetString(&address_bytes)),
        (&parsed[5], Value::OctetString(remote.as_bytes())),
        (&parsed[6], Value::OctetString(server.username.as_bytes())),
        (&parsed[7], Value::OctetString(server.password.expose().as_bytes())),
        (&parsed[8], Value::Integer(ROW_CREATE_AND_GO)),
    ];

    let timeout = |host: &str| SnmpError::Timeout { host: host.into(), timeout: copy.timeout };
    let response = tokio::time::timeout(copy.timeout, session.set(&values))
        .await
        .map_err(|_| timeout(host))?
        .map_err(|e| SnmpError::Protocol { host: host.into(), source: e })?;
    if response.error_status != 0 {
        let why = classify_refusal(host, response.error_status);
        crate::say!(crate::debuglog::Area::Snmp, "{host}: the copy row was refused — {why}");
        return Err(why);
    }
    crate::say!(crate::debuglog::Area::Snmp, "{host}: copy row {row} created; waiting for the device");

    // The device reports waiting(1), running(2), successful(3), failed(4).
    let state_oid = column(COL_STATE, row);
    let state_oid = Oid::from(&state_oid[..]).expect("a fixed OID parses");
    let cause_oid = column(COL_FAIL_CAUSE, row);
    let cause_oid = Oid::from(&cause_oid[..]).expect("a fixed OID parses");
    let started = std::time::Instant::now();
    let outcome = loop {
        if started.elapsed() > copy.wait {
            break Err(CopyError::NotFinished { host: host.into(), wait: copy.wait });
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        let pdu = match tokio::time::timeout(copy.timeout, session.get(&state_oid)).await {
            Err(_) => break Err(CopyError::Snmp(timeout(host))),
            Ok(Err(e)) => break Err(CopyError::Snmp(SnmpError::Protocol { host: host.into(), source: e })),
            Ok(Ok(p)) => p,
        };
        let state = pdu.varbinds.into_iter().find_map(|(_, v)| match v {
            Value::Integer(n) => Some(n),
            _ => None,
        });
        match state {
            Some(3) => break Ok(()),
            Some(4) => {
                let cause = match tokio::time::timeout(copy.timeout, session.get(&cause_oid)).await {
                    Ok(Ok(p)) => p
                        .varbinds
                        .into_iter()
                        .find_map(|(_, v)| match v {
                            Value::Integer(n) => Some(n),
                            _ => None,
                        })
                        .unwrap_or(1),
                    _ => 1,
                };
                break Err(CopyError::Failed { host: host.into(), cause: fail_cause(cause) });
            }
            // Still waiting or running, or the row has gone — in which case
            // the next read says so again until the wait runs out.
            _ => {}
        }
    };

    // The row is destroyed whatever happened: a device is left as it was
    // found. A destroy that fails is not an error worth reporting over the
    // copy's own outcome.
    let destroy_oid = column(COL_ROW_STATUS, row);
    let destroy_oid = Oid::from(&destroy_oid[..]).expect("a fixed OID parses");
    let _ = tokio::time::timeout(copy.timeout, session.set(&[(&destroy_oid, Value::Integer(ROW_DESTROY))])).await;

    match outcome {
        Ok(()) => {
            crate::say!(crate::debuglog::Area::Snmp, "{host}: {} sent to the server as {remote}", kind.slug());
            Ok(remote)
        }
        Err(e) => {
            crate::say!(crate::debuglog::Area::Snmp, "{host}: {e}");
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_name_is_safe_on_any_server_and_unique_per_device_kind_and_run() {
        assert_eq!(file_name("core-sw-01", BackupKind::Running, "20260101-120000"), "core-sw-01-running-config-20260101-120000.cfg");
        // A name with spaces or a slash cannot become a path on the server.
        assert_eq!(file_name("edge fw/1", BackupKind::Startup, "s"), "edge_fw_1-startup-config-s.cfg");
        assert_eq!(file_name("", BackupKind::Running, "s"), "device-running-config-s.cfg");
    }

    #[test]
    fn the_remote_path_joins_the_folder_once() {
        let server = |folder: &str| SftpServer {
            host: "192.0.2.5".into(),
            port: 22,
            folder: folder.into(),
            username: "backup".into(),
            password: Secret::new("not-a-real-password"),
        };
        assert_eq!(server("/srv/configs/").remote_path("a.cfg"), "/srv/configs/a.cfg");
        assert_eq!(server("configs").remote_path("a.cfg"), "configs/a.cfg");
        assert_eq!(server("").remote_path("a.cfg"), "a.cfg");
    }

    #[test]
    fn a_refusal_is_read_as_no_table_or_no_write_access() {
        assert!(matches!(classify_refusal("h", 17), CopyError::NoSuchTable { status: "notWritable", .. }));
        assert!(matches!(classify_refusal("h", 2), CopyError::NoSuchTable { status: "noSuchName", .. }));
        assert!(matches!(classify_refusal("h", 6), CopyError::Refused { status: "noAccess", .. }));
        assert!(matches!(classify_refusal("h", 16), CopyError::Refused { status: "authorizationError", .. }));
    }

    #[test]
    fn the_server_debug_shows_no_password() {
        let server = SftpServer {
            host: "files.example.net".into(),
            port: 22,
            folder: "/configs".into(),
            username: "backup".into(),
            password: Secret::new("not-a-real-password"),
        };
        let shown = format!("{server:?}");
        assert!(shown.contains("backup@files.example.net:22"), "{shown}");
        assert!(!shown.contains("not-a-real-password"), "{shown}");
    }

    #[test]
    fn not_yet_met_a_device() {
        assert!(!verified_against_hardware());
    }
}
