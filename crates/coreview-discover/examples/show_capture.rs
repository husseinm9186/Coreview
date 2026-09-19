//! Run a list of show commands against one device and file the output (LT-149).
//!
//! The same code path the Backups tab uses, driven from the terminal, so a
//! paging choice or a command list can be checked against real hardware before
//! anyone relies on it.
//!
//! ```text
//! CV_HOST=192.0.2.10 CV_USER=admin CV_PASS=... \
//! CV_BACKUP_DIR=/tmp/captures \
//! CV_SHOW='show version;show clock;show ip interface brief' \
//! CV_PAGING=auto \
//!   cargo run -p coreview-discover --example show_capture
//! ```
//!
//! `CV_PAGING` is one of `auto`, `cisco-ios`, `cisco-asa`, `palo-alto`,
//! `forti-os`, `aruba-hp`, `juniper`, `huawei-h3c`, `none`. `CV_ENABLE`,
//! `CV_PORT`, `CV_PATTERN` (a filename pattern) and `CV_SITE` are optional. Credentials come from the environment only and are
//! never written anywhere; the capture lands in `CV_BACKUP_DIR`, which should
//! be somewhere outside the repository.

use std::sync::Arc;
use std::time::Duration;

use coreview_discover::capture::{run_backups, BackupOptions, BackupTarget, ShowPlan};
use coreview_discover::hostkeys::HostKeyStore;
use coreview_discover::showcmd::Paging;
use coreview_discover::ssh::{Credentials, Secret, SshOptions};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Days since 1970-01-01 as a proleptic Gregorian date (Hinnant's algorithm),
/// so the example needs no date crate.
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = (yoe + era * 400 + i64::from(m <= 2)) as i32;
    (y, m, d)
}

#[tokio::main]
async fn main() {
    let host = std::env::var("CV_HOST").expect("set CV_HOST");
    let root = std::env::var("CV_BACKUP_DIR").expect("set CV_BACKUP_DIR, outside the repository");
    let commands: Vec<String> = std::env::var("CV_SHOW")
        .expect("set CV_SHOW, semicolon separated")
        .split(';')
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    let paging = Paging::parse(&std::env::var("CV_PAGING").unwrap_or_default())
        .expect("unknown CV_PAGING");
    let port: u16 = std::env::var("CV_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(22);

    let refused = coreview_discover::showcmd::refused(&commands);
    if !refused.is_empty() {
        for (c, why) in refused {
            eprintln!("refused `{c}`: {why}");
        }
        std::process::exit(2);
    }

    let credentials = Credentials {
        username: std::env::var("CV_USER").expect("set CV_USER"),
        password: Secret::new(std::env::var("CV_PASS").expect("set CV_PASS")),
        enable_password: std::env::var("CV_ENABLE").ok().map(Secret::new),
    };
    let options = BackupOptions {
        root: root.into(),
        kinds: Vec::new(),
        ssh: SshOptions {
            port,
            connect_timeout: Duration::from_secs(10),
            auth_timeout: Duration::from_secs(60),
            command_timeout: Duration::from_secs(60),
        },
        second_factor: false,
        show: Some(ShowPlan { commands, paging }),
        // LT-151: e.g. CV_PATTERN='{site}_{device}_{stamp}_{kind}'.
        file_pattern: std::env::var("CV_PATTERN").ok(),
    };

    let (tx, mut rx) = mpsc::channel(256);
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let stamp = {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // The app's own stamp shape, 20260828-101530 (UTC here), so a
        // filename pattern's {date} and {stamp} come out as they do in the app.
        let days = (secs / 86_400) as i64;
        let rem = secs % 86_400;
        let (y, m, d) = civil_from_days(days);
        coreview_discover::backup::stamp(
            y,
            m,
            d,
            (rem / 3600) as u32,
            (rem % 3600 / 60) as u32,
            (rem % 60) as u32,
        )
    };

    let run = run_backups(
        vec![BackupTarget {
            address: host.clone(),
            name: host,
            commands: Vec::new(),
            site: std::env::var("CV_SITE").unwrap_or_default(),
        }],
        credentials,
        options,
        store,
        stamp,
        tx,
        CancellationToken::new(),
    )
    .await;

    for s in &run.saved {
        println!("saved {} ({} bytes) -> {}", s.name, s.bytes, s.path);
    }
    for f in &run.failed {
        println!("failed {}: {}", f.name, f.reason);
    }
}
