//! Fakes shared by the backup tests: a small SNMPv2c agent that carries
//! Cisco's configuration-copy table, and an SFTP server holding whatever
//! files a test puts on it. Both answer their protocols for real, over
//! UDP and TCP on the loopback, so what is tested is the bytes Coreview
//! sends and reads. The agent's rows follow the MIB's definitions, not a
//! capture; invented names, documentation addresses, obviously fake
//! secrets.
#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId};
use snmp2::{MessageType, Pdu, Value};

// ------------------------------------------------------------------ BER

fn len(out: &mut Vec<u8>, n: usize) {
    if n < 128 {
        out.push(n as u8);
    } else {
        let bytes: Vec<u8> = n.to_be_bytes().iter().copied().skip_while(|b| *b == 0).collect();
        out.push(0x80 | bytes.len() as u8);
        out.extend(bytes);
    }
}

fn tlv(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    len(&mut out, body.len());
    out.extend_from_slice(body);
    out
}

fn int_body(n: i64) -> Vec<u8> {
    let mut b = n.to_be_bytes().to_vec();
    while b.len() > 1 && ((b[0] == 0 && b[1] & 0x80 == 0) || (b[0] == 0xff && b[1] & 0x80 != 0)) {
        b.remove(0);
    }
    b
}

fn oid_body(o: &[u64]) -> Vec<u8> {
    let mut out = vec![(o[0] * 40 + o[1]) as u8];
    for &arc in &o[2..] {
        let mut stack = vec![(arc & 0x7f) as u8];
        let mut a = arc >> 7;
        while a > 0 {
            stack.push(0x80 | (a & 0x7f) as u8);
            a >>= 7;
        }
        stack.reverse();
        out.extend(stack);
    }
    out
}

pub fn parse_oid(s: &str) -> Vec<u64> {
    s.split('.').filter(|x| !x.is_empty()).map(|x| x.parse().unwrap()).collect()
}

/// A value as a test reads it back out of a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seen {
    Int(i64),
    Oct(Vec<u8>),
    Other,
}

impl Seen {
    pub fn text(&self) -> String {
        match self {
            Seen::Oct(b) => String::from_utf8_lossy(b).to_string(),
            other => format!("{other:?}"),
        }
    }
}

/// One SET as the agent received it: each column written, in order.
pub type SetRequest = Vec<(String, Seen)>;

/// `ccCopyEntry`, as the module under test spells it.
pub const CC_COPY_ENTRY: &str = "1.3.6.1.4.1.9.9.96.1.1.1.1";

/// How the fake Cisco behaves.
#[derive(Clone, Copy, Debug)]
pub enum Copying {
    /// The table is there; the copy succeeds after one "running" poll.
    Succeeds,
    /// The table is there; the copy fails with this `ccCopyFailCause`.
    Fails(i64),
    /// No such table: every SET is refused `notWritable`.
    NoTable,
    /// The table is there but the credential may not write: `noAccess`.
    ReadOnly,
}

pub struct Agent {
    pub port: u16,
    /// Every SET received, in order.
    pub sets: Arc<Mutex<Vec<SetRequest>>>,
}

/// A v2c agent with the system group, and the copy table behaving as
/// `copying` says. A wrong community is not answered, as agents do.
pub async fn snmp_agent(community: &'static str, sys_name: &'static str, copying: Copying) -> Agent {
    let sock = Arc::new(tokio::net::UdpSocket::bind(("127.0.0.1", 0)).await.unwrap());
    let port = sock.local_addr().unwrap().port();
    let sets: Arc<Mutex<Vec<SetRequest>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&sets);
    tokio::spawn(async move {
        let mut buf = vec![0u8; 65_535];
        // Rows the manager created, and how many times each has been polled.
        let mut polls: BTreeMap<u64, u32> = BTreeMap::new();
        loop {
            let Ok((n, from)) = sock.recv_from(&mut buf).await else { return };
            let Ok(pdu) = Pdu::from_bytes(&buf[..n]) else { continue };
            if pdu.community != community.as_bytes() {
                continue;
            }
            let mut binds = Vec::new();
            let mut error_status: i64 = 0;
            match pdu.message_type {
                MessageType::SetRequest => {
                    let mut seen = Vec::new();
                    for (oid, value) in pdu.varbinds.clone() {
                        let name = oid.to_string();
                        let v = match value {
                            Value::Integer(n) => Seen::Int(n),
                            Value::OctetString(b) => Seen::Oct(b.to_vec()),
                            _ => Seen::Other,
                        };
                        // Column 14 is RowStatus: createAndGo(4) opens a row.
                        if let Some(rest) = name.strip_prefix(&format!("{CC_COPY_ENTRY}.14.")) {
                            if let (Ok(row), Seen::Int(4)) = (rest.parse::<u64>(), &v) {
                                polls.insert(row, 0);
                            }
                        }
                        let mut vb = tlv(0x06, &oid_body(&parse_oid(&name)));
                        vb.extend(match &v {
                            Seen::Int(n) => tlv(0x02, &int_body(*n)),
                            Seen::Oct(b) => tlv(0x04, b),
                            Seen::Other => tlv(0x05, &[]),
                        });
                        binds.extend(tlv(0x30, &vb));
                        seen.push((name, v));
                    }
                    recorded.lock().unwrap().push(seen);
                    error_status = match copying {
                        Copying::NoTable => 17,
                        Copying::ReadOnly => 6,
                        _ => 0,
                    };
                }
                _ => {
                    for (oid, _) in pdu.varbinds.clone() {
                        let name = oid.to_string();
                        let answer: Vec<u8> = if name == "1.3.6.1.2.1.1.5.0" {
                            tlv(0x04, sys_name.as_bytes())
                        } else if let Some(rest) = name.strip_prefix(&format!("{CC_COPY_ENTRY}.10.")) {
                            // ccCopyState: running(2) once, then the outcome.
                            let row: u64 = rest.parse().unwrap_or(0);
                            let count = polls.entry(row).or_insert(0);
                            *count += 1;
                            let state = match (copying, *count) {
                                (_, 1) => 2,
                                (Copying::Fails(_), _) => 4,
                                _ => 3,
                            };
                            tlv(0x02, &int_body(state))
                        } else if name.starts_with(&format!("{CC_COPY_ENTRY}.13.")) {
                            let cause = match copying {
                                Copying::Fails(c) => c,
                                _ => 1,
                            };
                            tlv(0x02, &int_body(cause))
                        } else {
                            tlv(0x81, &[]) // noSuchInstance
                        };
                        let mut vb = tlv(0x06, &oid_body(&parse_oid(&name)));
                        vb.extend(answer);
                        binds.extend(tlv(0x30, &vb));
                    }
                }
            }
            let mut body = tlv(0x02, &int_body(i64::from(pdu.req_id)));
            body.extend(tlv(0x02, &int_body(error_status)));
            body.extend(tlv(0x02, &[0]));
            body.extend(tlv(0x30, &binds));
            let mut msg = tlv(0x02, &[1]); // v2c
            msg.extend(tlv(0x04, community.as_bytes()));
            msg.extend(tlv(0xa2, &body));
            let _ = sock.send_to(&tlv(0x30, &msg), from).await;
        }
    });
    Agent { port, sets }
}

// ------------------------------------------------------------------ SFTP

pub struct SftpFake {
    pub port: u16,
    /// Every path a client opened, in order.
    pub opened: Arc<Mutex<Vec<String>>>,
}

#[derive(Clone)]
struct SftpSession {
    files: Arc<HashMap<String, Vec<u8>>>,
    opened: Arc<Mutex<Vec<String>>>,
    handles: HashMap<String, String>,
    next: u32,
}

impl russh_sftp::server::Handler for SftpSession {
    type Error = russh_sftp::protocol::StatusCode;

    fn unimplemented(&self) -> Self::Error {
        russh_sftp::protocol::StatusCode::OpUnsupported
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        _pflags: russh_sftp::protocol::OpenFlags,
        _attrs: russh_sftp::protocol::FileAttributes,
    ) -> Result<russh_sftp::protocol::Handle, Self::Error> {
        self.opened.lock().unwrap().push(filename.clone());
        if !self.files.contains_key(&filename) {
            return Err(russh_sftp::protocol::StatusCode::NoSuchFile);
        }
        self.next += 1;
        let handle = format!("h{}", self.next);
        self.handles.insert(handle.clone(), filename);
        Ok(russh_sftp::protocol::Handle { id, handle })
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<russh_sftp::protocol::Data, Self::Error> {
        let path = self.handles.get(&handle).ok_or(russh_sftp::protocol::StatusCode::Failure)?;
        let bytes = &self.files[path];
        let start = usize::try_from(offset).unwrap_or(usize::MAX).min(bytes.len());
        if start >= bytes.len() {
            return Err(russh_sftp::protocol::StatusCode::Eof);
        }
        let end = start.saturating_add(len as usize).min(bytes.len());
        Ok(russh_sftp::protocol::Data { id, data: bytes[start..end].to_vec() })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<russh_sftp::protocol::Status, Self::Error> {
        self.handles.remove(&handle);
        Ok(russh_sftp::protocol::Status {
            id,
            status_code: russh_sftp::protocol::StatusCode::Ok,
            error_message: "Ok".into(),
            language_tag: "en-US".into(),
        })
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        let path = self.handles.get(&handle).ok_or(russh_sftp::protocol::StatusCode::Failure)?;
        let attrs = russh_sftp::protocol::FileAttributes { size: Some(self.files[path].len() as u64), ..Default::default() };
        Ok(russh_sftp::protocol::Attrs { id, attrs })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        let bytes = self.files.get(&path).ok_or(russh_sftp::protocol::StatusCode::NoSuchFile)?;
        let attrs = russh_sftp::protocol::FileAttributes { size: Some(bytes.len() as u64), ..Default::default() };
        Ok(russh_sftp::protocol::Attrs { id, attrs })
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        self.stat(id, path).await
    }
}

/// The SSH side: one login accepted, and the `sftp` subsystem on any
/// session channel. Everything else is refused.
struct SftpServer {
    username: &'static str,
    password: &'static str,
    files: Arc<HashMap<String, Vec<u8>>>,
    opened: Arc<Mutex<Vec<String>>>,
    channels: HashMap<ChannelId, Channel<Msg>>,
}

impl server::Handler for SftpServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == self.username && password == self.password {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject { proceed_with_methods: None, partial_success: false })
        }
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            session.channel_failure(channel_id)?;
            return Ok(());
        }
        let Some(channel) = self.channels.remove(&channel_id) else {
            session.channel_failure(channel_id)?;
            return Ok(());
        };
        session.channel_success(channel_id)?;
        let handler = SftpSession {
            files: Arc::clone(&self.files),
            opened: Arc::clone(&self.opened),
            handles: HashMap::new(),
            next: 0,
        };
        russh_sftp::server::run(channel.into_stream(), handler).await;
        Ok(())
    }
}

/// An SFTP server on the loopback holding `files` (path → bytes), reachable
/// with `username` and `password`.
pub async fn sftp_server(username: &'static str, password: &'static str, files: HashMap<String, Vec<u8>>) -> SftpFake {
    let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let config = Arc::new(server::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        auth_rejection_time: Duration::from_millis(1),
        keys: vec![key],
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let files = Arc::new(files);
    let opened = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&opened);
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let config = Arc::clone(&config);
            let handler = SftpServer {
                username,
                password,
                files: Arc::clone(&files),
                opened: Arc::clone(&seen),
                channels: HashMap::new(),
            };
            tokio::spawn(async move {
                let _ = server::run_stream(config, stream, handler).await;
            });
        }
    });
    SftpFake { port, opened }
}
