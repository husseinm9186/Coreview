//! Parse one file with one template through the Rust engine and print the rows
//! as JSON — for comparing against Python TextFSM by hand (LT-525). Kept.
//!
//!     cargo run -p coreview-catalog --example parse_one -- <templates dir> <template> <raw file>
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let engine = coreview_catalog::textfsm::Engine::new(&a[1]);
    let raw = std::fs::read_to_string(&a[3]).unwrap();
    let rows = engine.parse(&a[2], &[], &raw).unwrap();
    println!("{}", serde_json::to_string(&rows).unwrap());
}
