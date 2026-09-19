/**
 * Reconciling a crawl with the diagram (LT-216): what the crawl would change,
 * one item at a time, each accepted or rejected before anything happens.
 *
 * A crawl used to write straight into the diagram — new devices and links
 * added, known ones updated. That is right for additions and wrong for
 * anything that takes something away: a switch that did not answer this week
 * is not a switch that was removed, and a host now seen on a different port may
 * be a laptop on a desk or a cable someone moved by mistake. So:
 *
 * - **Added** devices and links, and **changed** devices, are proposed ticked.
 * - **Removed** — a device a previous crawl drew, inside this run's subnets,
 *   that nothing reported this time; a discovered link between two devices
 *   this run logged into that neither reported — and **moved** — a host now
 *   learned on a different switch port — are proposed *unticked*. Nothing is
 *   deleted or re-cabled unless someone ticks it.
 *
 * Pure: it reads a page and a built topology and returns changes; `applyChanges`
 * turns the accepted ones into the page's new nodes and links.
 */
import { edgeSignature, identitiesOfNode, identity, type BuiltTopology } from './topology';
import type { CrawledDevice } from './ipc';
import type { TopoEdge, TopoNode } from '../state/store';
import type { DeviceNodeData, LinkData } from '../types/domain';

export type ChangeKind = 'added' | 'changed' | 'removed' | 'moved';

export interface Change {
  id: string;
  kind: ChangeKind;
  subject: 'device' | 'link';
  title: string;
  details: string[];
  /** Ticked when first shown. */
  accept: boolean;
  addNodes?: TopoNode[];
  addEdges?: TopoEdge[];
  patch?: { id: string; data: Partial<DeviceNodeData> };
  removeNodeIds?: string[];
  removeEdgeIds?: string[];
}

export interface ReconcileInput {
  page: { nodes: TopoNode[]; edges: TopoEdge[] };
  topo: BuiltTopology;
  /** The crawl's devices and what they reported. */
  devices: CrawledDevice[];
  /** Whether an address is inside the run's subnet limit. With no limit
   *  nothing is proposed for removal: there is no telling what the run was
   *  meant to cover. */
  inScope: ((address: string) => boolean) | null;
}

const FIELDS: [keyof DeviceNodeData, string][] = [
  ['model', 'Model'],
  ['serial', 'Serial'],
  ['osVersion', 'Software'],
  ['hostname', 'Hostname'],
  ['dnsName', 'DNS name'],
  ['role', 'Role'],
  ['stackKind', 'Stack'],
  ['vlan', 'VLAN'],
  ['mac', 'MAC'],
  ['vendor', 'Vendor'],
];

const labelOf = (n: TopoNode | undefined) => String((n?.data as DeviceNodeData | undefined)?.label ?? 'a device');

function addressText(data: Partial<DeviceNodeData>): string {
  return (data.addresses ?? []).map((a) => a.address).filter(Boolean).join(', ');
}

export function reconcile({ page, topo, devices, inScope }: ReconcileInput): Change[] {
  const changes: Change[] = [];
  const byId = new Map(page.nodes.map((n) => [n.id, n]));
  const newById = new Map(topo.nodes.map((n) => [n.id, n]));
  const edgesClaimed = new Set<string>();

  // Moves first, so their new cables are not also offered as plain additions.
  for (const u of topo.updated) {
    const node = byId.get(u.id);
    const was = (node?.data as DeviceNodeData | undefined)?.switchPort;
    const now = u.data.switchPort;
    if (!node || !was || !now || was === now) continue;
    const oldCables = page.edges.filter(
      (e) => (e.source === u.id || e.target === u.id) && !(e.data as LinkData | undefined)?.layer3,
    );
    const newCables = topo.edges.filter((e) => e.source === u.id || e.target === u.id);
    newCables.forEach((e) => edgesClaimed.add(e.id));
    changes.push({
      id: `move:${u.id}`,
      kind: 'moved',
      subject: 'device',
      title: `${labelOf(node)} moved from ${was} to ${now}`,
      details: ['Re-cables it to the port it is on now and removes the old link.'],
      accept: false,
      patch: u,
      addEdges: newCables,
      removeEdgeIds: oldCables.map((e) => e.id),
    });
  }

  // Added devices, each with the links that reach it.
  for (const n of topo.nodes) {
    const d = n.data as DeviceNodeData;
    const withIt = topo.edges.filter(
      (e) => !edgesClaimed.has(e.id) && (e.source === n.id || e.target === n.id) && (!newById.has(e.source) || e.source === n.id || !changes.some((c) => c.addNodes?.some((x) => x.id === e.source))),
    );
    // A link between two new devices goes with whichever is listed first.
    const mine = withIt.filter((e) => !edgesClaimed.has(e.id));
    mine.forEach((e) => edgesClaimed.add(e.id));
    changes.push({
      id: `add:${n.id}`,
      kind: 'added',
      subject: 'device',
      title: `${d.label}`,
      details: [
        [d.model, addressText(d)].filter(Boolean).join(' · '),
        mine.length ? `with ${mine.length} link${mine.length === 1 ? '' : 's'}` : '',
      ].filter(Boolean),
      accept: true,
      addNodes: [n],
      addEdges: mine,
    });
  }

  // Added links between devices already drawn.
  for (const e of topo.edges) {
    if (edgesClaimed.has(e.id)) continue;
    const l = e.data as LinkData;
    const a = byId.get(e.source) ?? newById.get(e.source);
    const b = byId.get(e.target) ?? newById.get(e.target);
    changes.push({
      id: `add-link:${e.id}`,
      kind: 'added',
      subject: 'link',
      title: `${labelOf(a)}${l.sourcePortLabel ? ` ${l.sourcePortLabel}` : ''} – ${labelOf(b)}${l.targetPortLabel ? ` ${l.targetPortLabel}` : ''}`,
      details: [l.layer3 ? 'A layer-3 hop, on the Logical view' : 'A cable'],
      accept: true,
      addEdges: [e],
    });
  }

  // Changed devices: only what actually differs.
  for (const u of topo.updated) {
    if (changes.some((c) => c.id === `move:${u.id}`)) continue;
    const node = byId.get(u.id);
    if (!node) continue;
    const had = node.data as DeviceNodeData;
    const details: string[] = [];
    for (const [field, label] of FIELDS) {
      const next = u.data[field];
      if (next === undefined || next === had[field]) continue;
      details.push(had[field] ? `${label}: ${String(had[field])} → ${String(next)}` : `${label}: ${String(next)}`);
    }
    if (u.data.addresses && addressText(u.data) !== addressText(had)) {
      details.push(`Address: ${addressText(had) || 'none'} → ${addressText(u.data)}`);
    }
    if (u.data.inventory) details.push('Ports, VLANs, routes and spanning tree read again');
    if (details.length === 0) continue;
    changes.push({
      id: `change:${u.id}`,
      kind: 'changed',
      subject: 'device',
      title: labelOf(node),
      details,
      accept: true,
      patch: u,
    });
  }

  // Removed: drawn by a crawl, inside this run's reach, and not found now.
  if (inScope) {
    const found = new Set<string>();
    for (const d of devices) {
      found.add(identity(d.hostname, ''));
      for (const a of [d.address, ...d.addresses.map((x) => x.ip)]) if (a) found.add(`a:${a}`);
      for (const nb of d.neighbors) {
        found.add(identity(nb.shortName || nb.deviceId, ''));
        for (const a of nb.addresses) if (a.ip) found.add(`a:${a.ip}`);
      }
      for (const at of d.attached) {
        if (at.address) found.add(`a:${at.address}`);
      }
    }
    const touched = new Set([...topo.updated.map((u) => u.id)]);
    for (const n of page.nodes) {
      if (n.type !== 'device' || touched.has(n.id)) continue;
      const d = n.data as DeviceNodeData;
      if (!d.tags?.includes('discovered')) continue;
      const primary = d.addresses?.find((a) => a.isPrimary)?.address ?? d.addresses?.[0]?.address;
      if (!primary || !inScope(primary)) continue;
      const keys = identitiesOfNode(n);
      const hostKey = d.hostname ? identity(d.hostname, '') : null;
      const seen = found.has(`a:${primary}`) || (hostKey && found.has(hostKey)) || keys.some((k) => found.has(k));
      if (seen) continue;
      const links = page.edges.filter((e) => e.source === n.id || e.target === n.id);
      changes.push({
        id: `remove:${n.id}`,
        kind: 'removed',
        subject: 'device',
        title: `${d.label} was not found`,
        details: [`${primary} is inside this run's subnets and nothing reported it`, links.length ? `removes it and its ${links.length} link${links.length === 1 ? '' : 's'}` : 'removes it'],
        accept: false,
        removeNodeIds: [n.id],
        removeEdgeIds: links.map((e) => e.id),
      });
    }

    // Discovered links between two devices this run logged into, not reported.
    const reachedNodes = new Set(
      topo.updated
        .filter((u) => u.data.discoveredVia === 'Logged in' || u.data.inventory)
        .map((u) => u.id),
    );
    for (const e of page.edges) {
      const l = e.data as LinkData | undefined;
      const discovered = l?.layer3 || (l?.notes ?? '').startsWith('Discovered:');
      if (!discovered || !reachedNodes.has(e.source) || !reachedNodes.has(e.target)) continue;
      const sig = l?.layer3 ? `l3:${[e.source, e.target].sort().join('::')}` : edgeSignature(e, (id) => id);
      if (topo.seenLinks.has(sig)) continue;
      changes.push({
        id: `remove-link:${e.id}`,
        kind: 'removed',
        subject: 'link',
        title: `${labelOf(byId.get(e.source))} ${l?.sourcePortLabel ?? ''} – ${labelOf(byId.get(e.target))} ${l?.targetPortLabel ?? ''}`.replace(/\s+/g, ' ').trim(),
        details: ['Both ends were logged into and neither reported this link'],
        accept: false,
        removeEdgeIds: [e.id],
      });
    }
  }

  const order: ChangeKind[] = ['added', 'changed', 'moved', 'removed'];
  return changes.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/** The page after the accepted changes, and the devices it added. */
export function applyChanges(
  page: { nodes: TopoNode[]; edges: TopoEdge[] },
  accepted: readonly Change[],
): { nodes: TopoNode[]; edges: TopoEdge[]; added: TopoNode[] } {
  const removeNodes = new Set(accepted.flatMap((c) => c.removeNodeIds ?? []));
  const removeEdges = new Set(accepted.flatMap((c) => c.removeEdgeIds ?? []));
  const patches = new Map(accepted.filter((c) => c.patch).map((c) => [c.patch!.id, c.patch!.data]));
  const added = accepted.flatMap((c) => c.addNodes ?? []);
  const nodes = [
    ...page.nodes
      .filter((n) => !removeNodes.has(n.id))
      .map((n) => (patches.has(n.id) ? ({ ...n, data: { ...n.data, ...patches.get(n.id) } } as TopoNode) : n)),
    ...added,
  ];
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [
    ...page.edges.filter((e) => !removeEdges.has(e.id) && ids.has(e.source) && ids.has(e.target)),
    // A link is only added where both of its ends are on the page afterwards.
    ...accepted.flatMap((c) => c.addEdges ?? []).filter((e) => ids.has(e.source) && ids.has(e.target)),
  ];
  return { nodes, edges, added };
}
