/**
 * The read-only allowlist, as the reconciliation and the catalog tests
 * apply it. The Rust collector (`crates/coreview-catalog/src/allowlist.rs`)
 * and the sidecar (`sidecar/coreview_sidecar/allowlist.py`) implement the
 * same rule; `allowlist.test.ts` holds the three to one fixture,
 * `resources/catalog/allowlist-cases.json`.
 *
 * The spec's non-negotiable, and how it is read here:
 *
 *   commands must match
 *   ^(show|get|display|dis |diagnose|execute (traceroute|ping)|test |ping|traceroute|/.* print)
 *   and never contain config/write/commit/reload/reboot/factoryreset/delete/clear
 *
 * Read literally, "never contain config" refuses `show running-config`,
 * `show configuration | display set` and `show config running`, which the
 * same spec lists in every catalog. So the second half is read as verbs,
 * not substrings: a forbidden word is refused when it is the first token
 * of the command or of any `;`-separated segment, and `running-config`,
 * `configuration` and `config running` after a read verb are nouns. Two
 * things the literal rule misses are added: a pipe may only feed a filter
 * (`include`, `section`, `json`, …), never `redirect`, `tee`, `append`,
 * `save` or `copy`, which write files; and a command may not carry a
 * newline. A handful of read-only commands the spec lists but its regex
 * does not cover are allowed as literals, each named below.
 */

const VERB = /^(show|get|display|dis |diagnose|execute (traceroute|ping)|test |ping|traceroute|\/.* print)/;

/** Read-only commands the spec lists that its own regex does not reach. Literal prefixes. */
const LITERALS = [
  'execute switch-controller get-conn-status', // FortiOS, cap.fortilink
  'execute traceroute-options source', // FortiOS live-path, precedes execute traceroute
  'packet-tracer input', // ASA/FTD live-path: a simulation, changes nothing
  'ip -j ', 'ip -4 ', 'ip -6 ', 'ip addr', 'ip route', 'ip neigh', 'ip link', 'ip vrf', // hosts (phase 4)
  'bridge -j fdb show', 'bridge fdb show',
  'lldpcli show ', 'lldpctl',
  'esxcli network nic list', 'esxcli network vswitch standard list', 'vim-cmd hostsvc/net/query_networkhint',
  'Get-NetIPConfiguration', 'Get-NetRoute', 'Get-NetNeighbor',
  // LT-550: the JSON forms of the ESXi and Windows reads.
  'esxcli --formatter=json system version get',
  'esxcli --formatter=json system hostname get',
  'esxcli --formatter=json network nic list',
  'esxcli --formatter=json network ip interface ipv4 get',
  'esxcli --formatter=json network ip route ipv4 list',
  'esxcli --formatter=json network ip neighbor list',
  'Get-NetAdapter',
  'Get-NetIPAddress',
  'net show ', 'nv show ', // Cumulus
  'pveversion', 'qm list', 'pct list', // Proxmox
];

const FORBIDDEN = new Set([
  'config', 'configure', 'conf', 'write', 'wr', 'commit', 'reload', 'reboot', 'factoryreset', 'factory-reset',
  'delete', 'del', 'clear', 'erase', 'copy', 'set', 'request', 'install', 'format', 'no', 'debug', 'undebug',
  'shutdown', 'halt', 'rm', 'sudo', 'su', 'kill', 'system-view', 'edit', 'load', 'rollback', 'restore', 'upgrade',
]);

/** Pipe targets that only filter what comes back. */
const FILTERS = new Set([
  'include', 'inc', 'i', 'exclude', 'exc', 'e', 'begin', 'b', 'section', 'sec', 'count', 'c', 'json', 'json-pretty', 'xml',
  'display', 'no-more', 'match', 'except', 'find', 'last', 'grep', 'head', 'tail', 'ConvertTo-Json', 'format-json',
  'utility', 'trim', 'refresh', 'sort', 'uniq', 'wc', 'nomore',
]);

/**
 * 'ok', or the reason the command is refused. Every implementation returns
 * these exact strings so the shared fixture can pin them.
 */
/** LT-557: a literal is a prefix, so its command's words are checked too —
 *  `ip link` must not let `ip link set …` through. */
const WRITE_WORDS = new Set(['add', 'del', 'delete', 'set', 'change', 'replace', 'flush', 'append', 'prepend', 'exec', 'save', 'restore', 'update', 'configure', 'unconfigure', 'pause', 'resume', 'restart', 'reset', 'shutdown', 'destroy', 'remove', 'start', 'stop', 'create', 'migrate']);

/** LT-556: shell operators — a second command, a background one, a
 *  substitution or a redirection. `|` is a pipe and is checked apart. */
const SHELL = ['&&', '||', '&', '`', '$(', '>', '<'];

export function allowlistVerdict(command) {
  if (typeof command !== 'string') return 'not a string';
  if (/[\r\n]/.test(command)) return 'carries a newline';
  const trimmed = command.trim();
  if (!trimmed) return 'empty';
  // LT-556: what a shell would run as a second command, or write to a file.
  if (SHELL.some((op) => trimmed.includes(op))) return 'carries a shell operator';
  const literal = LITERALS.some((l) => trimmed.startsWith(l));
  if (!literal && !VERB.test(trimmed)) return 'first word is not a read verb';
  const segments = trimmed.split(';');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i].trim();
    const first = seg.split(/\s+/)[0]?.toLowerCase().replace(/^\//, '') ?? '';
    const segLiteral = LITERALS.some((l) => seg.startsWith(l));
    if (FORBIDDEN.has(first) && !segLiteral) return `forbidden verb "${first}"`;
    if (segLiteral) {
      const w = seg.split(/\s+/).find((x) => WRITE_WORDS.has(x.toLowerCase()));
      if (w) return `"${w.toLowerCase()}" changes the device`;
    }
    // LT-556: every chained command is a read command in its own right.
    if (i > 0 && seg && !segLiteral && !VERB.test(seg)) return "a chained command's first word is not a read verb";
  }
  const pipes = trimmed.split('|').slice(1);
  for (const pipe of pipes) {
    const target = pipe.trim().split(/\s+/)[0] ?? '';
    // `show run | include ^ip route |^router ` — a regex alternation inside an include, not a new pipe.
    if (target === '' || target.startsWith('^') || target.startsWith('[')) continue;
    if (!FILTERS.has(target)) return `pipe target "${target}" is not a filter`;
  }
  return 'ok';
}
