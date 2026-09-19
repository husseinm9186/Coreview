//! Reads a saved snmpwalk the way the import does (LT-246), and prints what it
//! found — for checking a walk from a real device before trusting the import.
//!
//! cargo run -p coreview-discover --example read_walk -- walk.txt [address]

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("a walk file");
    let address = args.next();
    let text = std::fs::read_to_string(&path).expect("readable");
    let r = coreview_discover::walkfile::read_walk(&text, address.as_deref());
    println!("rows {}, unknown rows {} {:?}", r.rows, r.unknown_rows, r.unknown_names);
    for p in &r.problems {
        println!("problem: {p}");
    }
    if let Some(d) = r.device {
        println!("{} {} {:?} platform {:?} serial {:?}", d.hostname, d.address, d.class, d.platform, d.serial);
        for a in &d.addresses {
            println!("  address {} on {:?}", a.ip, a.interface);
        }
        for n in &d.neighbors {
            println!("  {:?} {} {:?} via {:?} -> {:?} {:?}", n.discovered_by, n.short_name, n.address(), n.local_interface, n.remote_interface, n.class);
        }
        for a in &d.attached {
            println!("  attached {} on {} {:?} ({})", a.mac, a.port, a.address, a.port_population);
        }
    }
}
