//! Drives the real client against a fake Dashboard (LT-404).
//!
//! There is no Meraki key on the machine this was written on, so the client
//! has never had an answer from `api.meraki.com`. What *can* be proved without
//! one is everything that goes wrong between a request and an answer: paging,
//! the rate limit, a 429 with `Retry-After`, a refused key, an error message
//! that says what the Dashboard said — and that every request is a GET.
//!
//! The server is real and speaks HTTP over a socket, for the same reason the
//! SSH tests stand up a real server: the parts most likely to be wrong are the
//! ones a stubbed client cannot reach.

use std::sync::{Arc, Mutex};

use coreview_meraki::{Client, Error};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// What the fake Dashboard was asked, in order.
type Asked = Arc<Mutex<Vec<String>>>;

/// Stands up a server and returns the base URL to point a client at, shaped
/// like the real one — `…/api/v1` — so the paths a test sees are the paths
/// Meraki sees.
///
/// `answers` is built from that base, because a `Link: rel=next` has to point
/// back at this server.
async fn dashboard(answers: impl FnOnce(&str) -> Vec<String>) -> (String, Asked) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let base = format!("http://127.0.0.1:{port}/api/v1");
    let answers = answers(&base);
    let asked: Asked = Arc::default();
    let seen = Arc::clone(&asked);

    tokio::spawn(async move {
        let mut answers = answers.into_iter();
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut buf = vec![0u8; 4096];
            let read = socket.read(&mut buf).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..read]).to_string();
            seen.lock()
                .expect("asked")
                .push(request.lines().next().unwrap_or("").to_string());
            let body = answers.next().unwrap_or_else(|| {
                "HTTP/1.1 500 Server Error\r\nContent-Length: 0\r\n\r\n".to_string()
            });
            let _ = socket.write_all(body.as_bytes()).await;
            let _ = socket.flush().await;
            // The client sends `Connection: close` and reads to the end, so
            // the answer ends when the socket does.
            drop(socket);
        }
    });

    (base, asked)
}

fn ok(json: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{json}",
        json.len()
    )
}

fn page(json: &str, next: Option<&str>) -> String {
    let link = next
        .map(|u| format!("Link: <{u}>; rel=next\r\n"))
        .unwrap_or_default();
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{link}Content-Length: {}\r\n\r\n{json}",
        json.len()
    )
}

#[tokio::test]
async fn the_customer_list_comes_back() {
    let (base, asked) = dashboard(|_| {
        vec![ok(r#"[{"id":"111","name":"Contoso Ltd"},{"id":"222","name":"Northwind"}]"#)]
    })
    .await;
    let client = Client::for_testing(&base, "a-key").expect("client");

    let orgs = client.organizations().await.expect("organisations");
    assert_eq!(orgs.len(), 2);
    assert_eq!(orgs[0].name, "Contoso Ltd");

    // Read-only, and the one thing a test can actually check about that: the
    // request that went out was a GET.
    let line = asked.lock().expect("asked")[0].clone();
    assert!(line.starts_with("GET /api/v1/organizations "), "{line}");
}

#[tokio::test]
async fn a_long_list_is_followed_page_by_page() {
    let (base, asked) = dashboard(|base| {
        let next = format!("{base}/organizations/111/networks?startingAfter=N_1");
        vec![
            page(r#"[{"id":"N_1","name":"HQ","productTypes":["appliance","switch"]}]"#, Some(&next)),
            page(r#"[{"id":"N_2","name":"Branch"}]"#, None),
        ]
    })
    .await;

    let client = Client::for_testing(&base, "a-key").expect("client");
    let networks = client.networks("111").await.expect("networks");
    assert_eq!(networks.len(), 2, "both pages: {networks:?}");
    assert_eq!(networks[1].name, "Branch");

    let lines = asked.lock().expect("asked").clone();
    assert_eq!(lines.len(), 2, "one request per page: {lines:?}");
    assert!(lines[1].contains("startingAfter=N_1"), "the next link was followed: {lines:?}");
}

#[tokio::test]
async fn a_rate_limit_is_waited_out_rather_than_failed() {
    let (base, asked) = dashboard(|_| {
        vec![
            "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 1\r\nContent-Length: 0\r\n\r\n".to_string(),
            ok(r#"[{"id":"111","name":"Contoso Ltd"}]"#),
        ]
    })
    .await;
    let client = Client::for_testing(&base, "a-key").expect("client");

    let orgs = client.organizations().await.expect("the second attempt");
    assert_eq!(orgs.len(), 1);
    assert_eq!(asked.lock().expect("asked").len(), 2, "it asked again");
}

#[tokio::test]
async fn a_refused_key_says_so_in_words_a_person_can_act_on() {
    let (base, _) = dashboard(|_| {
        vec!["HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n".to_string()]
    })
    .await;
    let client = Client::for_testing(&base, "wrong").expect("client");
    match client.organizations().await {
        Err(Error::Unauthorised) => {}
        other => panic!("expected an unauthorised error, got {other:?}"),
    }
}

#[tokio::test]
async fn an_error_repeats_what_the_dashboard_actually_said() {
    let body = r#"{"errors":["Organization not found"]}"#;
    let (base, _) = dashboard(|_| {
        vec![format!("HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\n\r\n{body}", body.len())]
    })
    .await;
    let client = Client::for_testing(&base, "a-key").expect("client");
    match client.organizations().await {
        Err(Error::Api { status, message }) => {
            assert_eq!(status, 404);
            assert_eq!(message, "Organization not found", "not just \"HTTP 404\"");
        }
        other => panic!("expected the API's own message, got {other:?}"),
    }
}

#[tokio::test]
async fn an_endpoint_that_does_not_apply_ends_a_walk_rather_than_failing_it() {
    // A network with no appliance answers 404 for appliance endpoints. That is
    // an answer, not a fault, and a run that stopped there would never finish.
    let (base, _) = dashboard(|_| {
        vec!["HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_string()]
    })
    .await;
    let client = Client::for_testing(&base, "a-key").expect("client");
    let networks = client.networks("111").await.expect("an empty walk, not an error");
    assert!(networks.is_empty());
}

#[tokio::test]
async fn a_key_never_travels_in_the_url() {
    // A key in a query string ends up in every log that records a URL. It goes
    // in a header, and this is the check that keeps it there.
    let (base, asked) = dashboard(|_| vec![ok("[]")]).await;
    let client = Client::for_testing(&base, "s3cret-key-value").expect("client");
    let _ = client.organizations().await.expect("organisations");
    let line = asked.lock().expect("asked")[0].clone();
    assert!(!line.contains("s3cret-key-value"), "the key reached the request line: {line}");
}
