import { tiersFor } from './hierarchyLayout';
import type { TopoEdge, TopoNode } from '../state/store';
import type { DeviceNodeData } from '../types/domain';

/**
 * Folding away what hangs off one device (LT-421).
 *
 * "I need to select device and collops, anything connected to it gets
 * collapsed, when I expand everhting expands." On a two-hundred device estate
 * a distribution switch with forty access points under it is forty icons of
 * noise while you are looking at something else.
 *
 * **Not the same as `collapse.ts`**, which folds a *grouped site* into one
 * box. This folds a *branch* of the topology into the device that holds it,
 * and the two can be used together.
 *
 * **"Anything connected to it" has to mean what hangs below it**, and that is
 * the whole of the design. Taken literally — every neighbour — collapsing an
 * access switch would swallow the core and with it the rest of the network.
 * What a reader means by collapsing a branch is the branch.
 *
 * **A view, never the document.** Nothing here deletes or moves anything; it
 * returns a set of ids to leave out of the drawing.
 */

/** Everything hanging below `id`, excluding `id` itself — it stays on the
 *  page holding the branch, and is what you click to get it back. */
export function hiddenByCollapsing(id: string, nodes: TopoNode[], edges: TopoEdge[]): Set<string> {
  const ids = new Set(nodes.map((n) => n.id));
  if (!ids.has(id)) return new Set();

  const near = new Map<string, string[]>();
  for (const n of nodes) near.set(n.id, []);
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    near.get(e.source)!.push(e.target);
    near.get(e.target)!.push(e.source);
  }

  // Which way is up. `tiersFor` is the layout's own answer — built from the
  // link direction the crawl proved (LT-145) and what a MAC table showed is
  // plugged into what (LT-146) — so a branch folds the same way the diagram is
  // already drawn, rather than inventing a second opinion about hierarchy.
  const tier = tiersFor(
    nodes.map((n) => ({
      id: n.id,
      deviceType: (n.data as DeviceNodeData).deviceType,
      width: 0,
      height: 0,
    })),
    edges.map((e) => ({ source: e.source, target: e.target })),
  );
  const tierOf = (x: string) => tier.get(x) ?? 0;
  const mine = tierOf(id);

  // Walk each way out of the device separately. A direction folds when
  // everything down it is further from the top than the device is — which is
  // why collapsing an access switch cannot take the core with it, and why a
  // ring that comes back round to the core is kept rather than folded.
  const hidden = new Set<string>();
  const claimed = new Set<string>([id]);
  for (const first of near.get(id) ?? []) {
    if (claimed.has(first)) continue;
    const branch: string[] = [];
    const queue = [first];
    claimed.add(first);
    let above = false;
    while (queue.length > 0) {
      const at = queue.pop()!;
      branch.push(at);
      if (tierOf(at) <= mine) above = true;
      for (const next of near.get(at) ?? []) {
        // The collapsed device is the wall: nothing passes through it.
        if (next === id || claimed.has(next)) continue;
        claimed.add(next);
        queue.push(next);
      }
    }
    if (above) continue;
    for (const x of branch) hidden.add(x);
  }
  return hidden;
}

/** Every node hidden by the collapsed devices, together.
 *
 *  Collapsing two devices on the same branch is not an error: what either one
 *  folds away stays folded, and neither collapsed device is ever hidden. */
export function hiddenByAll(collapsed: Iterable<string>, nodes: TopoNode[], edges: TopoEdge[]): Set<string> {
  const hidden = new Set<string>();
  for (const id of collapsed) {
    for (const h of hiddenByCollapsing(id, nodes, edges)) hidden.add(h);
  }
  for (const id of collapsed) hidden.delete(id);
  return hidden;
}

/** How many devices a collapsed one is holding, for the badge on it. */
export function foldedCount(id: string, nodes: TopoNode[], edges: TopoEdge[]): number {
  return hiddenByCollapsing(id, nodes, edges).size;
}

/** Whether collapsing this device would fold anything away. A leaf holds
 *  nothing, and offering to collapse it is offering to do nothing. */
export function worthCollapsing(id: string, nodes: TopoNode[], edges: TopoEdge[]): boolean {
  return foldedCount(id, nodes, edges) > 0;
}

/** The menu item's words, so it says what will happen before it happens. */
export function collapseLabel(id: string, nodes: TopoNode[], edges: TopoEdge[], collapsed: Set<string>): string {
  const n = foldedCount(id, nodes, edges);
  const devices = `${n} device${n === 1 ? '' : 's'}`;
  return collapsed.has(id) ? `Expand — ${devices} hidden` : `Collapse — ${devices}`;
}
