//! Fetching a file from an SFTP server — the second half of a backup over
//! SNMP ([`crate::snmp_backup`]).
//!
//! The device sends its configuration to the server the operator named;
//! this logs in to that server with the same login the device was given,
//! reads the one file back, and disconnects. Nothing is written to the
//! server and nothing is removed from it: what the device sent stays where
//! the operator's server keeps it. The server's host key is checked and
//! remembered in the same store as every device's, so a server that changes
//! its key is refused the way a device is.

use std::sync::Arc;
use std::time::Duration;

use russh::client;
use tokio::time::timeout;

use crate::hostkeys::HostKeyStore;
use crate::snmp_backup::SftpServer;
use crate::ssh::{authenticate, network_device_algorithms, Credentials, SshError, SshProgress, Verifier};

#[derive(Debug, thiserror::Error)]
pub enum SftpError {
    /// Reaching or logging in to the server, in the SSH client's own terms.
    #[error("the SFTP server {0}")]
    Ssh(SshError),
    #[error("the SFTP server {host} did not offer SFTP: {source}")]
    NoSubsystem { host: String, source: russh::Error },
    #[error("the SFTP server {host} has no file at {path}: the device said it sent one — did it reach the server?")]
    NoSuchFile { host: String, path: String },
    #[error("reading {path} from the SFTP server {host}: {why}")]
    Read { host: String, path: String, why: String },
}

/// Reads `path` from `server`.
///
/// `connect_timeout` bounds the connection and key exchange, `auth_timeout`
/// the login, and `read_timeout` the file itself — a configuration is small,
/// but a server that accepts a login and then says nothing must not hold
/// a backup run open.
pub async fn fetch(
    server: &SftpServer,
    path: &str,
    store: Arc<std::sync::Mutex<HostKeyStore>>,
    connect_timeout: Duration,
    auth_timeout: Duration,
    read_timeout: Duration,
) -> Result<Vec<u8>, SftpError> {
    let host = server.host.trim();
    crate::say!(crate::debuglog::Area::Ssh, "{host}:{} fetching {path} as {}", server.port, server.username);

    let rejection = Arc::new(std::sync::Mutex::new(None));
    let verifier = Verifier {
        host: host.to_string(),
        port: server.port,
        store,
        rejection: Arc::clone(&rejection),
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(120)),
        preferred: network_device_algorithms(),
        ..Default::default()
    });

    let connect = client::connect(config, (host, server.port), verifier);
    let mut handle = match timeout(connect_timeout, connect).await {
        Err(_) => return Err(SftpError::Ssh(SshError::ConnectTimeout { host: host.to_string(), timeout: connect_timeout })),
        Ok(Err(e)) => {
            if let Some(why) = rejection.lock().unwrap().take() {
                return Err(SftpError::Ssh(SshError::HostKeyChanged(why)));
            }
            return Err(SftpError::Ssh(SshError::Protocol { host: host.to_string(), source: e }));
        }
        Ok(Ok(h)) => h,
    };

    let credentials = Credentials {
        username: server.username.clone(),
        password: server.password.clone(),
        enable_password: None,
    };
    // Progress is a device's affair; a server's login is quick or it is a
    // failure, so nobody watches it.
    let quiet = |_: SshProgress| {};
    match timeout(auth_timeout, authenticate(&mut handle, host, &credentials, &quiet)).await {
        Err(_) => return Err(SftpError::Ssh(SshError::AuthTimeout { host: host.to_string(), timeout: auth_timeout })),
        Ok(Err(e)) => return Err(SftpError::Ssh(e)),
        Ok(Ok(())) => {}
    }

    let protocol = |e: russh::Error| SftpError::Ssh(SshError::Protocol { host: host.to_string(), source: e });
    let channel = handle.channel_open_session().await.map_err(protocol)?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| SftpError::NoSubsystem { host: host.to_string(), source: e })?;

    let read = async {
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| SftpError::NoSubsystem {
                host: host.to_string(),
                source: russh::Error::IO(std::io::Error::other(e.to_string())),
            })?;
        let bytes = match sftp.read(path).await {
            Ok(b) => b,
            Err(russh_sftp::client::error::Error::Status(s))
                if s.status_code == russh_sftp::protocol::StatusCode::NoSuchFile =>
            {
                return Err(SftpError::NoSuchFile { host: host.to_string(), path: path.to_string() })
            }
            Err(e) => return Err(SftpError::Read { host: host.to_string(), path: path.to_string(), why: e.to_string() }),
        };
        let _ = sftp.close().await;
        Ok(bytes)
    };
    let result = match timeout(read_timeout, read).await {
        Err(_) => Err(SftpError::Read {
            host: host.to_string(),
            path: path.to_string(),
            why: format!("no answer within {}s", read_timeout.as_secs()),
        }),
        Ok(r) => r,
    };
    let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    match &result {
        Ok(bytes) => crate::say!(crate::debuglog::Area::Ssh, "{host}: fetched {path}, {} bytes", bytes.len()),
        Err(e) => crate::say!(crate::debuglog::Area::Ssh, "{host}: {e}"),
    }
    result
}
