/**
 * Path validation (LT-225): is A reachable from B, and along what the diagram
 * says is between them.
 *
 * Two answers, kept side by side because each alone misleads. The *drawn*
 * path — the fewest links from B to A on the diagram — with each hop's live
 * status says where a failure is if there is one; the *test* — a probe from
 * this machine, or the device's own ping — says whether traffic actually gets
 * through. A healthy drawing with a failing test means the drawing is wrong or
 * the fault is somewhere nothing is checked.
 */
import type { TopoEdge, TopoNode } from '../state/store';
import type { HealthStatus, LinkData } from '../types/domain';

export interface DrawnPath {
  nodeIds: string[];
  edgeIds: string[];
}

/** The fewest-links path between two devices, ignoring leader lines. */
export function drawnPath(nodes: readonly TopoNode[], edges: readonly TopoEdge[], fromId: string, toId: string): DrawnPath | null {
  if (fromId === toId) return { nodeIds: [fromId], edgeIds: [] };
  const exists = new Set(nodes.map((n) => n.id));
  if (!exists.has(fromId) || !exists.has(toId)) return null;
  const adj = new Map<string, { to: string; edge: string }[]>();
  for (const e of edges) {
    if ((e.data as LinkData | undefined)?.kind === 'leader') continue;
    if (!exists.has(e.source) || !exists.has(e.target)) continue;
    adj.set(e.source, [...(adj.get(e.source) ?? []), { to: e.target, edge: e.id }]);
    adj.set(e.target, [...(adj.get(e.target) ?? []), { to: e.source, edge: e.id }]);
  }
  const via = new Map<string, { from: string; edge: string }>();
  const queue = [fromId];
  const seen = new Set([fromId]);
  while (queue.length) {
    const at = queue.shift()!;
    if (at === toId) break;
    // Sorted, so the same drawing always gives the same path.
    for (const step of [...(adj.get(at) ?? [])].sort((a, b) => a.to.localeCompare(b.to) || a.edge.localeCompare(b.edge))) {
      if (seen.has(step.to)) continue;
      seen.add(step.to);
      via.set(step.to, { from: at, edge: step.edge });
      queue.push(step.to);
    }
  }
  if (!seen.has(toId)) return null;
  const nodeIds = [toId];
  const edgeIds: string[] = [];
  for (let at = toId; at !== fromId; ) {
    const back = via.get(at)!;
    edgeIds.unshift(back.edge);
    nodeIds.unshift(back.from);
    at = back.from;
  }
  return { nodeIds, edgeIds };
}

export interface PathVerdict {
  /** The first hop along the path that is down, device or link. */
  firstDown: { kind: 'device' | 'link'; id: string } | null;
  /** How many hops have no live status to go on. */
  unchecked: number;
}

export function judgePath(path: DrawnPath, nodeStatus: (id: string) => HealthStatus, linkStatus: (id: string) => HealthStatus): PathVerdict {
  let unchecked = 0;
  for (let i = 0; i < path.nodeIds.length; i++) {
    const n = path.nodeIds[i]!;
    const ns = nodeStatus(n);
    if (ns === 'down') return { firstDown: { kind: 'device', id: n }, unchecked };
    if (ns === 'unknown') unchecked++;
    const e = path.edgeIds[i];
    if (e === undefined) continue;
    const ls = linkStatus(e);
    if (ls === 'down') return { firstDown: { kind: 'link', id: e }, unchecked };
  }
  return { firstDown: null, unchecked };
}
