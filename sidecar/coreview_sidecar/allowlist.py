"""
The read-only allowlist, applied a second time here, after Rust has
already applied it: defence in depth, and the audit trail when something
that should never reach the sidecar does. Same rule and the same reason
strings as scripts/allowlist.mjs and crates/coreview-catalog; the shared
fixture resources/catalog/allowlist-cases.json pins all three.
"""
import re

VERB = re.compile(r"^(show|get|display|dis |diagnose|execute (traceroute|ping)|test |ping|traceroute|/.* print)")

# Read-only commands the spec lists that its own regex does not reach. Literal prefixes.
LITERALS = (
    "execute switch-controller get-conn-status",
    "execute traceroute-options source",
    "packet-tracer input",
    "ip -j ", "ip -4 ", "ip -6 ", "ip addr", "ip route", "ip neigh", "ip link", "ip vrf",
    "bridge -j fdb show", "bridge fdb show",
    "lldpcli show ", "lldpctl",
    "esxcli network nic list", "esxcli network vswitch standard list", "vim-cmd hostsvc/net/query_networkhint",
    "Get-NetIPConfiguration", "Get-NetRoute", "Get-NetNeighbor",
    "net show ", "nv show ",
    "pveversion", "qm list", "pct list",
)

FORBIDDEN = frozenset(
    "config configure conf write wr commit reload reboot factoryreset factory-reset delete del clear erase copy set "
    "request install format no debug undebug shutdown halt rm sudo su kill system-view edit load rollback restore upgrade".split()
)

# Pipe targets that only filter what comes back.
FILTERS = frozenset(
    "include inc i exclude exc e begin b section sec count c json json-pretty xml display no-more match except find "
    "last grep head tail ConvertTo-Json format-json utility trim refresh sort uniq wc nomore".split()
)


def verdict(command) -> str:
    """'ok', or the reason the command is refused."""
    if not isinstance(command, str):
        return "not a string"
    if "\r" in command or "\n" in command:
        return "carries a newline"
    trimmed = command.strip()
    if not trimmed:
        return "empty"
    literal = any(trimmed.startswith(l) for l in LITERALS)
    if not literal and not VERB.match(trimmed):
        return "first word is not a read verb"
    for segment in trimmed.split(";"):
        seg = segment.strip()
        words = seg.split()
        first = words[0].lower() if words else ""
        if first.startswith("/"):
            first = first[1:]
        if first in FORBIDDEN and not any(seg.startswith(l) for l in LITERALS):
            return f'forbidden verb "{first}"'
    for pipe in trimmed.split("|")[1:]:
        words = pipe.strip().split()
        target = words[0] if words else ""
        # `show run | include ^ip route |^router ` — a regex alternation inside an include, not a new pipe.
        if target == "" or target.startswith("^") or target.startswith("["):
            continue
        if target not in FILTERS:
            return f'pipe target "{target}" is not a filter'
    return "ok"
