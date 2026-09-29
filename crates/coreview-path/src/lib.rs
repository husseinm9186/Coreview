//! P3's path builder (LT-531–LT-534, D-060).
//!
//! One collection's discovery tables and the graph P2 built from them in;
//! the path a packet would take out. `model` reads each device's forwarding
//! state from its rows; `walk` follows a flow from its source — policy
//! routes, then the longest prefix in the VRF, equal-cost next hops as
//! branches, recursive next hops, each next hop to the device it is, the
//! switches between routers — and `firewall` puts NAT and policy in each
//! vendor's order on the way. `compare` traces the way back and says where
//! it differs, and holds a traceroute against the model.
//!
//! D-050 throughout: what the tables do not say is not assumed. A table
//! nobody collected stops the walk with that reason; an object a firewall
//! rule names and the tables do not define makes the verdict undetermined.

pub mod compare;
pub mod firewall;
pub mod model;
pub mod walk;

pub use compare::{run, Outcome};
pub use model::Net;
pub use walk::{trace, Request, Trace};

/// Build the model for one run and trace a request over it.
pub fn trace_run(devices: &[coreview_topology::DeviceIn], request: &Request) -> Outcome {
    let graph = coreview_topology::build(devices);
    let net = Net::build(devices, &graph);
    run(&net, request)
}
