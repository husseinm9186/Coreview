//! P2's topology builder (LT-527, D-060).
//!
//! The discovery tables of one collection run in; one graph out. Devices are
//! one node per box, found by serial and MAC rather than by the address a
//! collection happened to reach them on (`identity`). Every CDP/LLDP row is a
//! claim about a cable; two claims about the same cable from its two ends
//! are one link at confidence 1.0, one claim is 0.7, and each keeps the rows
//! it came from (`links`). Cables inside a bundle fold into it, a stack is
//! one node (`collapse`). A device with no LLDP is placed where its MAC is
//! learned — 0.6 and drawn as inferred; one that names no MAC of its own is
//! known by the MAC a neighbour's ARP gives its address — and a port with a
//! crowd behind it and nobody announcing is an unknown switch (`inferred`).
//! Shared subnets are layer-3 adjacencies, confirmed by a routing neighbour
//! (`l3`); tunnels and VXLAN peers are overlays (`overlay`). `crawl_view`
//! turns the graph into the crawl result the review screen and the diagram
//! already draw.

pub mod aps;
pub mod crawl_view;
pub mod diff;
pub mod identity;
pub mod ifname;
pub mod inferred;
pub mod l3;
pub mod links;
pub mod model;

pub use model::*;

/// Build the graph for one run's devices.
pub fn build(devices: &[DeviceIn]) -> Graph {
    let mut graph = Graph::default();
    let mut ids = identity::Identities::default();
    identity::collected_nodes(devices, &mut graph, &mut ids);
    links::neighbor_links(devices, &mut graph, &mut ids);
    links::collapse_bundles(devices, &mut graph, &ids);
    identity::stacks_and_pairs(devices, &mut graph, &ids);
    aps::access_points(devices, &mut graph, &mut ids);
    identity::macs_from_arp(devices, &mut graph, &mut ids);
    inferred::mac_placements(devices, &mut graph, &mut ids);
    l3::shared_subnets(devices, &mut graph, &ids);
    l3::overlays(devices, &mut graph, &ids);
    graph.nodes.sort_by(|a, b| (a.kind, &a.name).cmp(&(b.kind, &b.name)));
    graph
}
