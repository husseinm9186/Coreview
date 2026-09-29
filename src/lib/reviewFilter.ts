/**
 * What of a crawl reaches the review (LT-216, LT-417, LT-502).
 *
 * The ticks in the results table decide which crawled devices are placed. A
 * node is wanted when any identity it carries — its MAC, any of its
 * addresses, or its name — is one a ticked row carries too; a link is kept
 * only when both its ends will be on the page.
 */
import type { Change } from './reconcile';
import { identitiesOfNode } from './topology';
import type { TopoNode } from '../state/store';

export function wantedNode(n: TopoNode, keep: ReadonlySet<string>): boolean {
  // LT-502: a silent device — or the unmanaged switch inferred in front of
  // several — is not a row in the table and so never matched a tick; the
  // filter dropped all of them while the button said "+ 49". They reach the
  // topology only when their own section was open and they were chosen
  // there, which is the decision.
  const tags = ((n.data as { tags?: string[] } | undefined)?.tags ?? []);
  if (tags.includes('attached')) return true;
  return keep.size === 0 || identitiesOfNode(n).some((k) => keep.has(k));
}

export function reviewable(
  changes: readonly Change[],
  page: { nodes: readonly { id: string }[] },
  topo: { nodes: readonly TopoNode[] },
  keep: ReadonlySet<string>,
): Change[] {
  const wanted = (n: TopoNode) => wantedNode(n, keep);
  return changes
    .filter((c) => !(c.kind === 'added' && c.subject === 'device' && c.addNodes?.some((n) => !wanted(n))))
    // A link to a device left unticked in the table has nowhere to land.
    //
    // LT-417: **both** ends, which this used to check only for the source.
    .filter((c) => {
      if (c.kind !== 'added' || c.subject !== 'link') return true;
      const lands = (id: string) =>
        page.nodes.some((n) => n.id === id) || topo.nodes.some((n) => n.id === id && wanted(n));
      return !c.addEdges?.some((e) => !lands(e.source) || !lands(e.target));
    });
}
