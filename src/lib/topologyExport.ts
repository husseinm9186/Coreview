/**
 * LT-548: the P2 topology a collection built, written out — JSON as the
 * builder gave it, CSV one row per link, Markdown for a person: devices,
 * links with how each was seen and its confidence, layer-3 adjacencies,
 * overlays and findings. Names, not the builder's internal ids.
 */
import { csvCell } from './csv';
import { t } from '../i18n';
import type { TopologyGraph, TopologyLink } from './ipc';

const nameOf = (g: TopologyGraph) => {
  const names = new Map(g.nodes.map((n) => [n.id, n.name]));
  return (id: string | null | undefined) => (id ? names.get(id) ?? id : '');
};

function linkCells(g: TopologyGraph, l: TopologyLink): string[] {
  const name = nameOf(g);
  const members = l.bundle ? l.bundle.members.map(([a, b]) => `${a}/${b}`).join(' ') : '';
  return [
    name(l.a.node), l.a.port ?? '', name(l.b.node), l.b.port ?? '', l.kind, l.confidence.toFixed(1),
    l.both_directions ? 'yes' : 'no', l.bundle?.a_name ?? '', members,
    l.evidence.map((e) => `${e.device}: ${e.note}`).join('; '),
  ];
}

export function topologyJson(g: TopologyGraph): string {
  return `${JSON.stringify(g, null, 2)}\n`;
}

/** One row per link. */
export function topologyCsv(g: TopologyGraph): string {
  const head = ['a_device', 'a_port', 'b_device', 'b_port', 'kind', 'confidence', 'both_ends', 'bundle', 'members', 'evidence'];
  return `${[head, ...g.links.map((l) => linkCells(g, l))].map((r) => r.map(csvCell).join(',')).join('\n')}\n`;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');

export function topologyMarkdown(g: TopologyGraph, run: string): string {
  const name = nameOf(g);
  const out = [`# ${t('collect.export.title', { run })}`, ''];
  out.push(`## ${t('collect.export.devices')}`, '', table(
    [t('collect.export.name'), t('collect.export.kind'), t('collect.export.model'), t('collect.export.address')],
    g.nodes.map((n) => [n.name, n.kind, n.model ?? n.os ?? '', n.mgmt_ip ?? '']),
  ), '');
  out.push(`## ${t('collect.export.links')}`, '', table(
    [t('collect.export.from'), t('collect.export.to'), t('collect.export.seen'), t('collect.export.confidence')],
    g.links.map((l) => [`${name(l.a.node)} ${l.a.port ?? ''}`.trim(), `${name(l.b.node)} ${l.b.port ?? ''}`.trim(), l.bundle ? `${l.kind}, ${l.bundle.a_name ?? ''} (${l.bundle.members.length})` : l.kind, l.confidence.toFixed(1)]),
  ), '');
  if (g.l3.length) {
    out.push(`## ${t('collect.export.l3')}`, '', table(
      [t('collect.export.from'), t('collect.export.to'), t('collect.export.subnet'), t('collect.export.confirmed')],
      g.l3.map((a) => [`${name(a.a)} ${a.a_if ?? ''}`.trim(), `${name(a.b)} ${a.b_if ?? ''}`.trim(), a.subnet, a.confirmed_by.join(', ') || '—']),
    ), '');
  }
  if (g.overlays.length) {
    out.push(`## ${t('collect.export.overlays')}`, '', table(
      [t('collect.export.from'), t('collect.export.to'), t('collect.export.kind'), t('collect.export.name')],
      g.overlays.map((o) => [name(o.a), o.b ? name(o.b) : o.remote_ip ?? '', o.kind, o.name ?? '']),
    ), '');
  }
  if (g.findings.length) out.push(`## ${t('collect.findings')}`, '', ...g.findings.map((f) => `- ${f.note}`), '');
  return `${out.join('\n')}\n`;
}
