/**
 * Filtering the canvas (LT-232) and focusing on part of it (LT-233).
 *
 * Both answer "show me only…", and both **dim** rather than hide: the devices
 * that do not match stay where they are, faint, so the drawing keeps its shape
 * and nobody wonders where half the network went. A filter matches on what a
 * device is and what is known about it; focus keeps a selection and its
 * neighbours a chosen number of links out.
 */
import type { TopoEdge, TopoNode } from '../state/store';
import type { DeviceNodeData, HealthStatus, LinkData, NoteNodeData } from '../types/domain';

export interface CanvasFilter {
  types?: string[];
  vendor?: string;
  role?: string;
  vlan?: string;
  /** A prefix like `192.0.2.0/24`: a device with an address inside it. */
  subnet?: string;
  status?: HealthStatus;
  /** How discovery met it: logged in, over SNMP, only seen, or not discovered. */
  crawl?: 'logged-in' | 'snmp' | 'seen' | 'not-discovered';
  tag?: string;
  /** Text in a device's notes or a note's body. */
  text?: string;
}

export function filterActive(f: CanvasFilter | null | undefined): boolean {
  return Boolean(f && Object.values(f).some((v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim() !== '')));
}

const has = (hay: string | undefined, needle: string | undefined) => !needle?.trim() || (hay ?? '').toLowerCase().includes(needle.trim().toLowerCase());

function toInt(ip: string): number | null {
  const p = ip.trim().split('.');
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return p.reduce((n, x) => n * 256 + Number(x), 0);
}

export function inSubnet(address: string, prefix: string): boolean {
  const [net, len] = prefix.trim().split('/');
  const ip = toInt(address);
  const base = net ? toInt(net) : null;
  const bits = Number(len);
  if (ip === null || base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(ip / size) === Math.floor(base / size);
}

/** Whether a node passes the filter. A note passes only on text; a section
 *  (zone) always passes, being the background the rest stands on. */
export function matchesFilter(n: TopoNode, f: CanvasFilter, status: HealthStatus): boolean {
  if (n.type === 'note') {
    const d = n.data as NoteNodeData;
    const onlyText = Object.entries(f).every(([k, v]) => k === 'text' || !v || (Array.isArray(v) && v.length === 0));
    return onlyText && has(`${d.title ?? ''} ${d.body ?? ''}`, f.text);
  }
  const d = n.data as DeviceNodeData;
  if (d.deviceType === 'zone') return true;
  if (f.types?.length && !f.types.includes(d.deviceType)) return false;
  if (!has(d.vendor, f.vendor)) return false;
  if (!has(d.role, f.role)) return false;
  if (f.vlan?.trim()) {
    const want = f.vlan.trim();
    const onVlan = d.vlan === want || (d.inventory?.vlans ?? []).some((v) => String(v.id) === want || v.name.toLowerCase() === want.toLowerCase());
    if (!onVlan) return false;
  }
  if (f.subnet?.trim() && !(d.addresses ?? []).some((a) => inSubnet(a.address, f.subnet!))) return false;
  if (f.status && status !== f.status) return false;
  if (f.crawl) {
    const via = (d.discoveredVia ?? '').toLowerCase();
    const how = via === 'logged in' ? 'logged-in' : via === 'snmp' ? 'snmp' : via ? 'seen' : 'not-discovered';
    if (how !== f.crawl) return false;
  }
  if (f.tag?.trim() && !(d.tags ?? []).some((t) => t.toLowerCase() === f.tag!.trim().toLowerCase())) return false;
  if (!has(`${d.notes ?? ''} ${d.label}`, f.text)) return false;
  return true;
}

/** The selection and everything within `hops` links of it. */
export function neighbourhood(edges: readonly TopoEdge[], ids: readonly string[], hops: number): Set<string> {
  const keep = new Set(ids);
  let frontier = new Set(ids);
  for (let i = 0; i < hops && frontier.size; i++) {
    const next = new Set<string>();
    for (const e of edges) {
      if ((e.data as LinkData | undefined)?.kind === 'leader') continue;
      if (frontier.has(e.source) && !keep.has(e.target)) next.add(e.target);
      if (frontier.has(e.target) && !keep.has(e.source)) next.add(e.source);
    }
    next.forEach((id) => keep.add(id));
    frontier = next;
  }
  return keep;
}

/** What to keep lit: the filter's matches, narrowed by focus if both are on.
 *  `null` when nothing is dimmed. */
export function litNodes(
  nodes: readonly TopoNode[],
  edges: readonly TopoEdge[],
  filter: CanvasFilter | null,
  focus: { ids: string[]; hops: number } | null,
  status: (id: string) => HealthStatus,
): Set<string> | null {
  let lit: Set<string> | null = null;
  if (filterActive(filter)) lit = new Set(nodes.filter((n) => matchesFilter(n, filter!, status(n.id))).map((n) => n.id));
  if (focus && focus.ids.length) {
    const around = neighbourhood(edges, focus.ids, focus.hops);
    // Sections stay lit so the neighbourhood keeps its surroundings.
    for (const n of nodes) if ((n.data as DeviceNodeData).deviceType === 'zone') around.add(n.id);
    lit = lit ? new Set([...lit].filter((id) => around.has(id))) : around;
  }
  return lit;
}
