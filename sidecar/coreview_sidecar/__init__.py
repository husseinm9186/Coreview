"""
The Coreview collector sidecar (LT-513, D-060 Phase 1).

A temporary bridge: scrapli drives the SSH session and TextFSM reads the
answers, while Rust owns everything else — the catalog, the plan, SQLite,
the graph and the user interface. It speaks JSON lines over stdin/stdout,
never touches the disk, never logs a secret, and sends nothing the
read-only allowlist refuses even if asked. Phase 4 deletes it.
"""

__version__ = "0.1.0"
PROTOCOL_VERSION = 1
