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


# LT-557: a literal is a prefix, so its command's words are checked too —
# `ip link` must not let `ip link set …` through.
WRITE_WORDS = frozenset(("add", "del", "delete", "set", "change", "replace", "flush", "append", "prepend", "exec", "save", "restore", "update", "configure", "unconfigure", "pause", "resume", "restart", "reset", "shutdown", "destroy", "remove", "start", "stop", "create", "migrate"))

# LT-556: shell operators — a second command, a background one, a
# substitution or a redirection. `|` is a pipe and is checked apart.
SHELL = ("&&", "||", "&", "`", "$(", ">", "<")


def verdict(command) -> str:
    """'ok', or the reason the command is refused."""
    if not isinstance(command, str):
        return "not a string"
    if "\r" in command or "\n" in command:
        return "carries a newline"
    trimmed = command.strip()
    if not trimmed:
        return "empty"
    # LT-556: what a shell would run as a second command, or write to a file.
    if any(op in trimmed for op in SHELL):
        return "carries a shell operator"
    literal = any(trimmed.startswith(l) for l in LITERALS)
    if not literal and not VERB.match(trimmed):
        return "first word is not a read verb"
    for i, segment in enumerate(trimmed.split(";")):
        seg = segment.strip()
        words = seg.split()
        first = words[0].lower() if words else ""
        if first.startswith("/"):
            first = first[1:]
        seg_literal = any(seg.startswith(l) for l in LITERALS)
        if first in FORBIDDEN and not seg_literal:
            return f'forbidden verb "{first}"'
        if seg_literal:
            hit = next((w.lower() for w in words if w.lower() in WRITE_WORDS), None)
            if hit:
                return f'"{hit}" changes the device'
        # LT-556: every chained command is a read command in its own right.
        if i > 0 and seg and not seg_literal and not VERB.match(seg):
            return "a chained command's first word is not a read verb"
    for pipe in trimmed.split("|")[1:]:
        words = pipe.strip().split()
        target = words[0] if words else ""
        # `show run | include ^ip route |^router ` — a regex alternation inside an include, not a new pipe.
        if target == "" or target.startswith("^") or target.startswith("["):
            continue
        if target not in FILTERS:
            return f'pipe target "{target}" is not a filter'
    return "ok"
