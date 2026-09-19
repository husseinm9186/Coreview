//! Reads what a device's TLS certificate says about it (LT-124).
//!
//! The same code the ping sweep uses, pointed at one address, so a vendor's
//! certificate can be checked before anyone relies on what the sweep shows.
//! Reads only; nothing is validated, completed or stored.
//!
//! ```text
//! CV_HOST=192.0.2.10 cargo run -p coreview-probe --example cert_probe
//! CV_HOST=192.0.2.10 CV_PORT=8443 cargo run -p coreview-probe --example cert_probe
//! ```

use coreview_probe::certfetch::certificate_identity;

#[tokio::main]
async fn main() {
    let host: std::net::Ipv4Addr = std::env::var("CV_HOST")
        .expect("set CV_HOST")
        .parse()
        .expect("CV_HOST must be an IPv4 address");
    let port: u16 = std::env::var("CV_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(443);

    match certificate_identity(host, port, 3000).await {
        None => println!("{host}:{port} — no certificate (no TLS, or nothing readable)"),
        Some(id) => {
            println!("{host}:{port}");
            println!("  host name     : {:?}", id.host_name());
            println!("  device serial : {:?}", id.device_serial());
            println!("  organisation  : {:?}", id.organisation);
            println!("  unit          : {:?}", id.unit);
            println!("  dns names     : {:?}", id.dns_names);
        }
    }
}
