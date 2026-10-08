/**
 * The path the Rust builder calculates over a collection run
 * (`crates/coreview-path`), in the forms the page needs.
 *
 * Path-Trace already highlights a path, draws an application page from it and
 * writes its report from `TraceResult`. `asTraceResult` turns the builder's
 * answer into that shape, so those keep working unchanged; what the builder
 * adds — the decision, the switches between routers, firewall verdicts, NAT,
 * the way back — is shown beside it from the result itself. `toCsv` and
 * `toMarkdown` are the exports the spec names; JSON is the result as it came.
 */
import { t } from '../i18n';
import type { CollectedPath, PathEnding, PathHop, PathOutcome, PathTrace } from './ipc';
import type { Hop, HopSegment, TraceResult } from './pathTrace';

/** The collection run a stored crawl run was built from: the seed names it. */
export function collectionRunOf(seed: string | undefined | null): string | null {
  const m = /^collection (\S+)$/.exec((seed ?? '').trim());
  return m?.[1] ?? null;
}

function why(h: PathHop): string {
  const m = h.matched;
  switch (h.decision) {
    case 'local':
      return t('cpath.why.local', { dst: h.dst });
    case 'connected':
      return t('cpath.why.connected', { prefix: m?.prefix ?? '', out: h.outInterface ?? '—' });
    case 'pbr':
      return t('cpath.why.pbr', { nextHop: h.nextHop ?? h.outInterface ?? '—' });
    case 'default':
      return t('cpath.why.default', { nextHop: h.nextHop ?? '—' });
    default:
      return t('cpath.why.lpm', { prefix: m?.prefix ?? '', protocol: m?.kind ?? '', nextHop: h.nextHop ?? h.outInterface ?? '—' });
  }
}

/** One of the builder's hops as the page's engine writes one. */
function asHop(h: PathHop): Hop {
  const notes = [...h.notes];
  // Say when the hop came from the device's forwarding table, not its RIB.
  if (h.matched?.table === 'forwarding') notes.push(t('cpath.forwardingTable', { command: h.matched.command.replace(/^fib:/, '') }));
  if (h.firewall) notes.push(t('cpath.firewallNote', { verdict: t(`cpath.verdict.${h.firewall.verdict}`), reason: h.firewall.reason }));
  for (const n of h.nat) notes.push(t('cpath.natNote', { rule: n.rule, field: t(`cpath.field.${n.field}`), was: n.was, now: n.now }));
  const dnat = h.nat.find((n) => n.field === 'destination');
  const segment: HopSegment | undefined = dnat ? { kind: 'nat', was: dnat.was, now: dnat.now, description: dnat.rule } : undefined;
  return {
    device: h.device,
    prefix: h.matched?.prefix ?? (h.decision === 'local' ? `${h.dst}/32` : ''),
    protocol: h.matched?.kind ?? h.decision,
    nextHop: h.nextHop,
    outInterface: h.outInterface,
    distance: h.matched?.distance ?? null,
    metric: h.matched?.metric ?? null,
    why: why(h),
    via: h.via.map((v) => ({ prefix: v.prefix, protocol: v.kind, nextHop: v.nextHop })),
    ...(h.matched?.table ? { table: h.matched.table } : {}),
    ...(segment ? { segment } : {}),
    ...(h.vrf && h.vrf !== 'default' ? { vrf: h.vrf } : {}),
    ...(h.ecmp > 1 ? { ecmp: h.ecmp } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

/** In a sentence, how a path ended. */
export function endingText(e: PathEnding): string {
  switch (e.kind) {
    case 'delivered':
      if (e.device) return t('cpath.end.deliveredDevice', { device: e.device });
      if (e.endpoint) return t('cpath.end.deliveredEndpoint', { switch: e.endpoint.switch, port: e.endpoint.port });
      return t('cpath.end.delivered');
    case 'dropped':
      return t('cpath.end.dropped', { at: e.at, reason: e.reason });
    case 'denied':
      return t('cpath.end.denied', { at: e.at, policy: e.policy ?? '—' });
    case 'unmanaged':
      return t('cpath.end.unmanaged', { at: e.at, nextHop: e.nextHop, name: e.name ?? e.mac ?? t('cpath.nobody') });
    case 'insufficient':
      return e.reason;
    case 'loop':
      return t('cpath.end.loop', { at: e.at });
  }
}

/**
 * The builder's answer as the page's `TraceResult`. Every path is kept; the
 * result is `delivered` only when every path arrives, and otherwise takes the
 * first path that did not, because that is what the page says in red.
 */
export function asTraceResult(trace: PathTrace): TraceResult {
  const paths = trace.paths.map((p) => p.hops.map(asHop));
  const stuck = trace.paths.find((p) => p.ending.kind !== 'delivered');
  if (!stuck) return { kind: 'delivered', paths };
  const e = stuck.ending;
  if (e.kind === 'insufficient') return { kind: 'insufficient', reason: e.reason, paths };
  if (e.kind === 'loop') return { kind: 'loop', paths, at: e.at };
  if (e.kind === 'delivered') return { kind: 'delivered', paths };
  return { kind: 'unreachable', paths, at: e.at, reason: endingText(e) };
}

/** Every device either direction crosses, for the diagram highlight. */
export function devicesIn(outcome: PathOutcome): string[] {
  const names = new Set<string>();
  for (const p of outcome.forward.paths) for (const h of p.hops) names.add(h.device);
  return [...names];
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function l2Text(h: PathHop): string {
  return h.l2.map((s) => `${s.device}${s.inPort ? ` ${s.inPort}` : ''}${s.outPort ? `→${s.outPort}` : ''}${s.blocked ? ' (STP blocked)' : ''}`).join(' | ');
}

function rowsOf(direction: string, trace: PathTrace): string[][] {
  const out: string[][] = [];
  trace.paths.forEach((p: CollectedPath, i) => {
    p.hops.forEach((h, n) => {
      out.push([
        direction, String(i + 1), String(n + 1), h.device, h.inInterface ?? '', h.vrf, h.src, h.dst, h.decision,
        h.matched?.prefix ?? '', h.matched?.kind ?? '', h.nextHop ?? '', h.nextDevice ?? '', h.outInterface ?? '',
        h.firewall ? `${h.firewall.verdict}${h.firewall.policy ? ` (${h.firewall.policy})` : ''}` : '',
        h.nat.map((x) => `${x.field} ${x.was}→${x.now}`).join('; '), l2Text(h), h.notes.join(' '),
      ]);
    });
    out.push([direction, String(i + 1), '', '', '', '', '', '', `end:${p.ending.kind}`, '', '', '', '', '', '', '', '', endingText(p.ending)]);
  });
  return out;
}

/** One row per hop, both directions, and one per path's ending. */
export function toCsv(outcome: PathOutcome): string {
  const head = ['direction', 'path', 'hop', 'device', 'in_interface', 'vrf', 'src', 'dst', 'decision', 'prefix', 'protocol', 'next_hop', 'next_device', 'out_interface', 'firewall', 'nat', 'l2_path', 'notes'];
  const rows = [head, ...rowsOf('forward', outcome.forward), ...(outcome.reverse ? rowsOf('reverse', outcome.reverse) : [])];
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\n')}\n`;
}

function traceMarkdown(title: string, trace: PathTrace): string[] {
  const lines = [`## ${title}`, ''];
  if (trace.source) lines.push(trace.source.how, '');
  trace.paths.forEach((p, i) => {
    if (trace.paths.length > 1) lines.push(`### ${t('trace.ecmpLeg', { n: i + 1, of: trace.paths.length })}`, '');
    lines.push(`| # | ${t('trace.colDevice')} | ${t('cpath.colDecision')} | ${t('trace.colPrefix')} | ${t('trace.colNextHop')} | ${t('trace.colOut')} | ${t('cpath.colFirewall')} | NAT |`);
    lines.push('|---|---|---|---|---|---|---|---|');
    p.hops.forEach((h, n) => {
      const fw = h.firewall ? `${t(`cpath.verdict.${h.firewall.verdict}`)}${h.firewall.policy ? ` (${h.firewall.policy})` : ''}` : '';
      const nat = h.nat.map((x) => `${x.was} → ${x.now}`).join('; ');
      lines.push(`| ${n + 1} | ${h.device} | ${h.decision} | ${h.matched?.prefix ?? ''} | ${h.nextHop ?? ''} | ${h.outInterface ?? ''} | ${fw} | ${nat} |`);
    });
    lines.push('', endingText(p.ending), '');
  });
  if (trace.warnings.length) lines.push(...trace.warnings.map((w) => `- ${w}`), '');
  return lines;
}

/** A report a person reads: each direction's hop table, the differences, the traceroute. */
export function toMarkdown(outcome: PathOutcome): string {
  const f = outcome.forward;
  const lines = [`# ${t('cpath.reportTitle', { from: f.from, to: f.to })}`, '', ...traceMarkdown(t('cpath.forward'), f)];
  if (outcome.reverse) lines.push(...traceMarkdown(t('cpath.reverse'), outcome.reverse));
  if (outcome.asymmetry) {
    lines.push(`## ${t('cpath.asymmetry')}`, '', outcome.asymmetry.symmetric ? t('cpath.symmetric') : t('cpath.asymmetric'), '');
    lines.push(...outcome.asymmetry.notes.map((n) => `- ${n}`), '');
  }
  if (outcome.verify) {
    lines.push(`## ${t('cpath.verify')}`, '', t('cpath.matchPercent', { pct: outcome.verify.matchPercent }), '');
    lines.push(`| TTL | ${t('trace.colAddress')} | ${t('trace.colDevice')} | ${t('cpath.modeled')} | |`, '|---|---|---|---|---|');
    for (const r of outcome.verify.rows) lines.push(`| ${r.n} | ${r.traceroute ?? '*'} | ${r.tracerouteDevice ?? ''} | ${r.modeled ?? ''} | ${r.agrees ? '✓' : '✗'} |`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
