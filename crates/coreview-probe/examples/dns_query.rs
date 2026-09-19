//! One DNS query probe against a real server (LT-219), for checking the query
//! and parser against what servers actually send.
//!
//!     CV_SERVER=192.0.2.53 CV_NAME=app.example.test CV_RECORD=A \
//!         cargo run -p coreview-probe --example dns_query

#[tokio::main]
async fn main() {
    let server = std::env::var("CV_SERVER").expect("set CV_SERVER");
    let name = std::env::var("CV_NAME").expect("set CV_NAME");
    let record = std::env::var("CV_RECORD").unwrap_or_else(|_| "A".into());
    let r = coreview_probe::dnsquery::probe_dns_query("example", &name, &server, &record, None, 2_000, 0).await;
    println!("{:?}: {}", r.outcome, r.summary);
}
