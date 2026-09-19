/**
 * One search over everything in a project (LT-230, LT-231): devices on every
 * page and what is known about them — addresses, MACs, hostnames, ports,
 * VLANs, subnets — and probes, notes and shapes, for the command palette.
 *
 * Matching is fuzzy the way a palette should be: every typed character in
 * order, words and starts of words counting most, so `csw1` finds `CORE-SW1`
 * and `10.2` finds `192.0.2.10`. Exact and prefix matches rank first; an
 * address or MAC is matched with its punctuation ignored, so `5e0053` finds
 * `00:00:5e:00:53:01`.
 */
import type { ProjectDocument } from '../state/store';
import type { DeviceNodeData, NoteNodeData } from '../types/domain';

export type SearchKind = 'device' | 'address' | 'mac' | 'hostname' | 'port' | 'vlan' | 'subnet' | 'probe' | 'note' | 'shape';

export interface SearchItem {
  kind: SearchKind;
  /** What is shown and matched. */
  text: string;
  /** Where it is, shown beside it. */
  detail: string;
  /** The object to go to, and the page it is on. */
  nodeId?: string;
  pageId?: string;
  /** For a shape: its device type. */
  shape?: string;
}

/** Scores `text` against `query`: higher is better, `null` for no match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - t.length;
  const at = t.indexOf(q);
  if (at >= 0) return 600 - at - t.length / 10;
  // Punctuation-blind, for addresses and MACs.
  const bare = (s: string) => s.replace(/[\s.:\-_/]/g, '');
  if (bare(q).length >= 3 && bare(t).includes(bare(q))) return 500 - t.length / 10;
  // Every character, in order.
  let score = 0;
  let from = 0;
  let run = 0;
  // A space typed between words matches anything, so `br rtr` finds `BRANCH-RTR`.
  for (const ch of q.replace(/\s+/g, '')) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    const startOfWord = i === 0 || /[\s.\-_/:]/.test(t[i - 1]!);
    run = i === from ? run + 1 : 0;
    score += 10 + (startOfWord ? 15 : 0) + run * 5 - Math.min(i - from, 10);
    from = i + 1;
  }
  return Math.max(1, score - t.length / 5);
}

/** Everything in the project worth finding. */
export function searchIndex(doc: ProjectDocument, shapes: readonly { type: string; label: string }[] = []): SearchItem[] {
  const out: SearchItem[] = [];
  const seen = new Set<string>();
  const add = (item: SearchItem) => {
    const key = `${item.kind}|${item.text.toLowerCase()}|${item.nodeId ?? item.shape ?? ''}`;
    if (seen.has(key) || !item.text.trim()) return;
    seen.add(key);
    out.push(item);
  };
  // Every device's name first, so a link can be named from either page.
  const labels = new Map<string, string>();
  for (const page of doc.pages) for (const n of page.nodes) if (n.type === 'device') labels.set(n.id, (n.data as DeviceNodeData).label);
  for (const page of doc.pages) {
    const where = doc.pages.length > 1 ? ` · ${page.name}` : '';
    for (const n of page.nodes) {
      if (n.type === 'note') {
        const d = n.data as NoteNodeData;
        const first = (d.body ?? '').split('\n').find((l) => l.trim()) ?? '';
        add({ kind: 'note', text: d.title?.trim() || first.slice(0, 60) || 'Note', detail: `Note${where}`, nodeId: n.id, pageId: page.id });
        continue;
      }
      const d = n.data as DeviceNodeData;
      const at = { nodeId: n.id, pageId: page.id };
      add({ kind: 'device', text: d.label, detail: [d.role, d.model, d.addresses?.[0]?.address].filter(Boolean).join(' · ') + where, ...at });
      for (const a of d.addresses ?? []) if (a.address) add({ kind: 'address', text: a.address, detail: `${d.label} ${a.label}${where}`, ...at });
      if (d.mac) add({ kind: 'mac', text: d.mac, detail: `${d.label}${where}`, ...at });
      for (const h of [d.hostname, d.dnsName]) if (h && h !== d.label) add({ kind: 'hostname', text: h, detail: `${d.label}${where}`, ...at });
      const inv = d.inventory;
      for (const p of inv?.ports ?? []) {
        add({ kind: 'port', text: `${d.label} ${p.port}`, detail: [p.description, p.status, p.mode === 'trunk' ? 'trunk' : p.vlan !== undefined ? `VLAN ${p.vlan}` : ''].filter(Boolean).join(' · '), ...at });
      }
      for (const v of inv?.vlans ?? []) add({ kind: 'vlan', text: `VLAN ${v.id} ${v.name}`, detail: `${d.label}${where}`, ...at });
      if (d.vlan) add({ kind: 'vlan', text: `VLAN ${d.vlan}`, detail: `${d.label}${where}`, ...at });
      for (const r of inv?.routes ?? []) {
        if (r.protocol === 'connected') add({ kind: 'subnet', text: r.prefix, detail: `${d.label} ${r.interface ?? ''}${where}`.trim(), ...at });
      }
    }
    for (const e of page.edges) {
      const l = e.data as { sourcePortLabel?: string; targetPortLabel?: string } | undefined;
      if (l?.sourcePortLabel) add({ kind: 'port', text: `${labels.get(e.source) ?? ''} ${l.sourcePortLabel}`, detail: `to ${labels.get(e.target) ?? ''}${where}`, nodeId: e.source, pageId: page.id });
      if (l?.targetPortLabel) add({ kind: 'port', text: `${labels.get(e.target) ?? ''} ${l.targetPortLabel}`, detail: `to ${labels.get(e.source) ?? ''}${where}`, nodeId: e.target, pageId: page.id });
    }
  }
  const pageOf = new Map(doc.pages.flatMap((p) => p.nodes.map((n) => [n.id, p.id] as const)));
  for (const p of doc.probes) {
    add({ kind: 'probe', text: `${labels.get(p.objectId) ?? 'Link'} — ${p.name}`, detail: `${p.kind.toUpperCase()} ${p.target}`, nodeId: pageOf.has(p.objectId) ? p.objectId : undefined, pageId: pageOf.get(p.objectId) });
  }
  for (const s of shapes) add({ kind: 'shape', text: s.label, detail: 'Add to the page', shape: s.type });
  return out;
}

/** The best matches, best first. */
export function search(index: readonly SearchItem[], query: string, limit = 40): SearchItem[] {
  if (!query.trim()) return [];
  return index
    .map((item) => ({ item, score: fuzzyScore(query, item.text) }))
    .filter((x): x is { item: SearchItem; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.item.text.localeCompare(b.item.text))
    .slice(0, limit)
    .map((x) => x.item);
}
