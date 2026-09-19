/**
 * Stacking order (LT-101, LT-174).
 *
 * What is drawn over what follows a node's place in the page's node list — the
 * canvas gives each node a z-index from it, and the export draws in the same
 * order. So restacking is reordering that list, and every function here returns
 * a new list holding the same node objects.
 *
 * Several objects move as a block, keeping their order among themselves: a
 * selection brought to the front arrives there as it was stacked.
 */
import type { TopoNode } from '../state/store';

export type Restack = 'forward' | 'backward' | 'front' | 'back';

export function restack(nodes: readonly TopoNode[], ids: ReadonlySet<string>, how: Restack): TopoNode[] {
  if (ids.size === 0) return [...nodes];
  const moving = nodes.filter((n) => ids.has(n.id));
  const rest = nodes.filter((n) => !ids.has(n.id));
  if (moving.length === 0) return [...nodes];
  if (how === 'front') return [...rest, ...moving];
  if (how === 'back') return [...moving, ...rest];

  // One step: past the nearest object not being moved, in that direction.
  const out = [...nodes];
  if (how === 'forward') {
    for (let i = out.length - 2; i >= 0; i -= 1) {
      if (ids.has(out[i]!.id) && !ids.has(out[i + 1]!.id)) {
        [out[i], out[i + 1]] = [out[i + 1]!, out[i]!];
      }
    }
  } else {
    for (let i = 1; i < out.length; i += 1) {
      if (ids.has(out[i]!.id) && !ids.has(out[i - 1]!.id)) {
        [out[i], out[i - 1]] = [out[i - 1]!, out[i]!];
      }
    }
  }
  return out;
}

/** Whether restacking would change anything — nothing to undo otherwise. */
export function sameOrder(a: readonly TopoNode[], b: readonly TopoNode[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}
