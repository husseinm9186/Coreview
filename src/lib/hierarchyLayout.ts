/**
 * Arranging a topology the way a network engineer draws one: the internet at
 * the top, the edge under it, the core under that, and the access layer at the
 * bottom, with the links running downward between them.
 *
 * This is the opposite of `tidyLayout`, and both are wanted. Tidy fixes the
 * spacing of a drawing somebody arranged by hand and must not move anything
 * else. This one *does* rearrange: it is for a topology that arrived without
 * an arrangement worth keeping — a crawl, a CSV, a drawing whose author put
 * the boxes wherever there was room — where the question is not "where were
 * these" but "what feeds what".
 *
 * How the tiers are decided, in order:
 *
 * 1. **What the device is.** A firewall sits above a core switch and below the
 *    internet, whatever the cabling says. This is the part a generic graph
 *    layout cannot know and is most of why those produce diagrams nobody
 *    recognises.
 * 2. **What it is plugged into.** A device whose type says nothing — a
 *    `generic`, an imported shape — takes a tier one below the highest thing
 *    it connects to. Applied repeatedly, so a chain of unknowns resolves.
 * 3. **How far it is from the middle.** A group of unknowns joined only to
 *    each other — a crawl that could only call everything a switch — still
 *    has a shape: the device fewest hops from everything else is its middle
 *    and goes at the top of the group, and each hop out is a tier down. The
 *    group sits below every typed tier. A lone unknown with no links goes to
 *    the bottom rather than somewhere arbitrary in the middle.
 * 4. **What the device itself said**. Where a crawl read a default
 *    route, the link carries a proven direction, and the end traffic leaves
 *    by belongs above the end it leaves from. This is applied last and beats
 *    the three above, because the first is a guess from a glyph and this is
 *    the device stating where it sends traffic it has no other route for.
 *
 * Within a tier, the order is settled by barycentre sweeps — each device
 * pulled towards the mean position of its neighbours in the tier above, then
 * in the tier below, and back — and the order with the fewest crossings is
 * the one kept. Placement is then a tree: each device centred over the span
 * of what hangs off it, a fan of more than twelve single-link devices wrapped
 * into two rows under its parent so one access switch does not make a row a
 * screen wide. A locked device, or one moved by hand since the last
 * arrangement, keeps its place; what hangs off it gathers under where it is,
 * and anything the arrangement would have laid over it moves along its row.
 */
import type { DeviceType } from '../types/domain';

export interface HierarchyNode {
  id: string;
  deviceType: DeviceType;
  width: number;
  height: number;
  /** A locked node is never moved, and never counted as placed. */
  locked?: boolean;
  /** Moved by hand since the last arrangement. Kept where it is, like a
   *  locked node, and reported separately so the message can say so. */
  pinned?: boolean;
  /** Where the node is now. A locked or pinned node keeps this and the rest
   *  flow around it; a movable node's is not read. */
  x?: number;
  y?: number;
}

export interface HierarchyEdge {
  source: string;
  target: string;
  /** Which way traffic proven to leave by this link goes.
   *
   *  Set only where a crawl read the device's own default route, so
   *  it is evidence rather than a guess: `forward` means the *target* is the
   *  way out and belongs above the source. A link nobody proved carries
   *  `none` or nothing and constrains nothing. */
  direction?: 'none' | 'forward' | 'reverse' | 'both';
}

export interface HierarchyOptions {
  /** Space between the bottom of one tier and the top of the next. */
  rankGap?: number;
  /** Space between neighbours in a tier. */
  siblingGap?: number;
  /** Past this many single-link devices under one parent, the fan wraps
   *  into two rows. */
  fanLimit?: number;
  /** Where the top-left of the arrangement goes. */
  originX?: number;
  originY?: number;
  /** The older names for `siblingGap` and `rankGap`, still read. */
  columnGap?: number;
  rowGap?: number;
}

export interface HierarchyResult {
  moved: Map<string, { x: number; y: number }>;
  /** How many tiers the topology turned out to have. */
  tiers: number;
  /** Nodes left where they were because they are locked. */
  locked: number;
  /** Nodes left where they were because somebody moved them by hand. */
  pinned: number;
}

export const RANK_GAP = 160;
export const SIBLING_GAP = 96;
export const FAN_LIMIT = 12;
/** The gap between a fan's two rows: close enough to read as one fan. */
const FAN_ROW_GAP = 48;

/**
 * The tier a device belongs to purely by what it is.
 *
 * Undefined means "the drawing has not said" — a plain shape, a `generic`, an
 * imported icon nobody typed a role onto — and those are placed by what they
 * connect to instead. Deliberately coarse: the point is a readable top-to-
 * bottom flow, not a taxonomy.
 */
export const TIER_OF_TYPE: Partial<Record<DeviceType, number>> = {
  internet: 0,
  cloud: 0,
  'private-cloud': 0,
  site: 0,
  'mpls-cloud': 0,
  vpn: 1,
  router: 1,
  firewall: 2,
  waf: 2,
  'core-switch': 3,
  'l3-switch': 3,
  'wireless-controller': 3,
  'load-balancer': 4,
  'distribution-switch': 4,
  'access-switch': 5,
  'l2-switch': 5,
  'access-point': 6,
  server: 6,
  'vm-host': 6,
  'blade-chassis': 6,
  vm: 6,
  storage: 6,
  application: 6,
  database: 6,
  printer: 7,
  camera: 7,
  'ip-phone': 7,
  endpoint: 7,
};

/** Each node's neighbours, once each, no self-links, sorted so nothing
 *  depends on the order the links were drawn. */
function adjacency(nodes: readonly HierarchyNode[], edges: readonly HierarchyEdge[]): Map<string, string[]> {
  const ids = new Set(nodes.map((n) => n.id));
  const sets = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set<string>()]));
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue;
    sets.get(e.source)!.add(e.target);
    sets.get(e.target)!.add(e.source);
  }
  return new Map([...sets].map(([id, s]) => [id, [...s].sort()]));
}

/** Hops from `start` to everything reachable. */
function hopsFrom(start: string, adj: Map<string, string[]>): Map<string, number> {
  const seen = new Map<string, number>([[start, 0]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i += 1) {
    const at = queue[i]!;
    const d = seen.get(at)!;
    for (const next of adj.get(at) ?? []) {
      if (!seen.has(next)) {
        seen.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** The tier every node lands in, by the rules in the module comment. */
export function tiersFor(nodes: HierarchyNode[], edges: HierarchyEdge[]): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const neighbours = adjacency(nodes, edges);

  const tier = new Map<string, number>();
  for (const n of nodes) {
    const t = TIER_OF_TYPE[n.deviceType];
    if (t !== undefined) tier.set(n.id, t);
  }

  // Rule 2, repeated until it stops changing anything. Bounded by the node
  // count, so a ring of unknowns cannot spin here.
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const n of nodes) {
      if (tier.has(n.id)) continue;
      const known = (neighbours.get(n.id) ?? [])
        .map((id) => tier.get(id))
        .filter((t): t is number => t !== undefined);
      if (known.length === 0) continue;
      tier.set(n.id, Math.min(...known) + 1);
      changed = true;
    }
    if (!changed) break;
  }

  // Rule 3. After rule 2 has settled, an unknown has no typed neighbour, so
  // the unknowns left form groups joined only to each other. Each group is
  // ranked from its middle — the node fewest hops from the rest of it, ties
  // to more links, then the id — and sits below every typed tier.
  const deepest = tier.size ? Math.max(...tier.values()) : -1;
  const unknown = nodes.filter((n) => !tier.has(n.id));
  const placed = new Set<string>();
  for (const n of unknown) {
    if (placed.has(n.id)) continue;
    const members = [...hopsFrom(n.id, neighbours).keys()];
    const ecc = new Map(members.map((id) => [id, Math.max(...hopsFrom(id, neighbours).values())]));
    const centre = [...members].sort(
      (a, b) =>
        ecc.get(a)! - ecc.get(b)! ||
        (neighbours.get(b)?.length ?? 0) - (neighbours.get(a)?.length ?? 0) ||
        (a < b ? -1 : 1),
    )[0]!;
    for (const [id, hops] of hopsFrom(centre, neighbours)) {
      tier.set(id, deepest + 1 + hops);
      placed.add(id);
    }
  }

  // Rule 4: a proven direction outranks all three above.
  //
  // The rules so far are the glyph, the cabling and a fallback. None of them
  // is the device's own forwarding decision, and a link carries
  // one wherever a crawl read a default route: `forward` means the target is
  // the way out. A glyph is a guess about what a box looks like; a default
  // route is the box saying where it sends traffic. So where they disagree,
  // this wins — which is the whole.
  //
  // Applied as a constraint rather than an assignment, so everything the
  // earlier rules got right is kept: only the end that is on the wrong side
  // moves, and only far enough.
  for (let pass = 0; pass < nodes.length + 1; pass += 1) {
    let changed = false;
    for (const e of edges) {
      if (!ids.has(e.source) || !ids.has(e.target)) continue;
      // `both` and `none` say nothing about which end is upstream.
      const upstream =
        e.direction === 'forward' ? e.target : e.direction === 'reverse' ? e.source : null;
      if (upstream === null) continue;
      const downstream = upstream === e.target ? e.source : e.target;
      const up = tier.get(upstream);
      const down = tier.get(downstream);
      if (up === undefined || down === undefined) continue;
      if (down > up) continue;
      tier.set(downstream, up + 1);
      changed = true;
    }
    // Bounded as well as fixed-point: a cycle of directions cannot happen
    // from real default routes, and must not spin here if it ever does.
    if (!changed) break;
  }

  // Close the gaps, so a topology with no firewalls does not leave an empty
  // band where the firewalls would have been.
  const used = [...new Set(tier.values())].sort((a, b) => a - b);
  const rank = new Map(used.map((t, i) => [t, i]));
  for (const [id, t] of tier) tier.set(id, rank.get(t) ?? 0);
  return tier;
}

/** One thing in a tier's row: a device, or a fan of single-link devices
 *  under one parent that is laid out as a block. */
interface Item {
  ids: string[];
  /** The fan's parent; a single device has none. */
  parent?: string;
  cols: number;
  rows: number;
  width: number;
  height: number;
}

/** A set of devices with no links at all is wrapped the way a fan is: a row
 *  past the fan limit becomes two. */
function fanShape(count: number, limit: number): { cols: number; rows: number } {
  if (count <= limit) return { cols: count, rows: 1 };
  return { cols: Math.ceil(count / 2), rows: 2 };
}

const mean = (xs: number[]): number | undefined =>
  xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Where every device goes.
 *
 * Locked and pinned nodes keep their positions and are reported rather than
 * moved; they still take part in deciding tiers, because what they are
 * plugged into is still true, and what hangs off them gathers under where
 * they are.
 */
export function hierarchicalLayout(
  nodes: HierarchyNode[],
  edges: HierarchyEdge[],
  options: HierarchyOptions = {},
): HierarchyResult {
  const siblingGap = options.siblingGap ?? options.columnGap ?? SIBLING_GAP;
  const rankGap = options.rankGap ?? options.rowGap ?? RANK_GAP;
  const fanLimit = options.fanLimit ?? FAN_LIMIT;
  const originX = options.originX ?? 0;
  const originY = options.originY ?? 0;

  const moved = new Map<string, { x: number; y: number }>();
  const locked = nodes.filter((n) => n.locked).length;
  const pinned = nodes.filter((n) => n.pinned && !n.locked).length;
  if (nodes.length === 0) return { moved, tiers: 0, locked, pinned };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const tier = tiersFor(nodes, edges);
  const tierCount = tier.size ? Math.max(...tier.values()) + 1 : 0;
  const adj = adjacency(nodes, edges);
  const isFixed = (id: string) => {
    const n = byId.get(id)!;
    return Boolean(n.locked || n.pinned);
  };
  // A fixed node with no position cannot anchor anything; it is simply not
  // moved.
  const fixedCentre = (id: string): { x: number; y: number } | undefined => {
    const n = byId.get(id)!;
    if (!isFixed(id) || n.x === undefined || n.y === undefined) return undefined;
    return { x: n.x + n.width / 2, y: n.y + n.height / 2 };
  };
  const movable = nodes.filter((n) => !isFixed(n.id));
  if (movable.length === 0) return { moved, tiers: tierCount, locked, pinned };

  // --- the items in each tier -------------------------------------------
  //
  // A movable node's single-link children in the tier below, past the fan
  // limit, become one block under it. The children of a fixed node are
  // blocked the same way, under where it is.
  const fanOf = new Map<string, string[]>();
  const inFan = new Set<string>();
  for (const p of nodes) {
    const tp = tier.get(p.id)!;
    const leaves = (adj.get(p.id) ?? []).filter(
      (q) => !isFixed(q) && tier.get(q) === tp + 1 && (adj.get(q)?.length ?? 0) === 1,
    );
    if (leaves.length > fanLimit) {
      fanOf.set(p.id, leaves);
      for (const q of leaves) inFan.add(q);
    }
  }
  const itemOf = (ids: string[], parent?: string): Item => {
    const w = Math.max(...ids.map((id) => byId.get(id)!.width));
    const h = Math.max(...ids.map((id) => byId.get(id)!.height));
    const { cols, rows } = ids.length > 1 ? fanShape(ids.length, fanLimit) : { cols: 1, rows: 1 };
    return {
      ids,
      parent,
      cols,
      rows,
      width: cols * w + (cols - 1) * siblingGap,
      height: rows * h + (rows - 1) * FAN_ROW_GAP,
    };
  };
  const rows = new Map<number, Item[]>();
  for (let t = 0; t < tierCount; t += 1) rows.set(t, []);
  // Isolated nodes — no links at all — wrap like a fan, so fifty hosts no
  // crawl could place do not make one row a screen wide.
  const isolated = new Map<number, string[]>();
  for (const n of movable) {
    const t = tier.get(n.id)!;
    if (inFan.has(n.id)) continue;
    if ((adj.get(n.id)?.length ?? 0) === 0) {
      isolated.set(t, [...(isolated.get(t) ?? []), n.id]);
      continue;
    }
    rows.get(t)!.push(itemOf([n.id]));
  }
  for (const [p, leaves] of fanOf) rows.get(tier.get(p)! + 1)!.push(itemOf(leaves, p));
  for (const [t, ids] of isolated) {
    ids.sort();
    if (ids.length > fanLimit) rows.get(t)!.push(itemOf(ids));
    else for (const id of ids) rows.get(t)!.push(itemOf([id]));
  }
  // Seeded by id, not by the order the nodes came in, so a re-crawl that
  // lists the same devices differently lands the same arrangement.
  for (const row of rows.values()) row.sort((a, b) => (a.ids[0]! < b.ids[0]! ? -1 : 1));
  const itemByNode = new Map<string, Item>();
  for (const row of rows.values()) for (const it of row) for (const id of it.ids) itemByNode.set(id, it);

  // --- the order within each tier ----------------------------------------
  //
  // Barycentre sweeps: each item pulled to the mean position of its
  // neighbours in the adjacent tier, down the tiers then up, and the order
  // with the fewest crossings kept. Fixed nodes count at where they are.
  const centre = new Map<Item, number>();
  const positionRow = (row: Item[]) => {
    let x = 0;
    for (const it of row) {
      centre.set(it, x + it.width / 2);
      x += it.width + siblingGap;
    }
  };
  for (const row of rows.values()) positionRow(row);
  const neighbourCentres = (it: Item, inTier: number): number[] => {
    const out: number[] = [];
    for (const id of it.ids) {
      for (const q of adj.get(id) ?? []) {
        if (tier.get(q) !== inTier) continue;
        const fixed = fixedCentre(q);
        if (fixed) out.push(fixed.x);
        else {
          const other = itemByNode.get(q);
          if (other && other !== it) out.push(centre.get(other)!);
        }
      }
    }
    return out;
  };
  const crossings = (): number => {
    let n = 0;
    for (let t = 0; t + 1 < tierCount; t += 1) {
      const upper = rows.get(t)!;
      const lower = rows.get(t + 1)!;
      const iu = new Map(upper.map((it, i) => [it, i]));
      const il = new Map(lower.map((it, i) => [it, i]));
      const pairs: [number, number][] = [];
      for (const it of upper) {
        for (const id of it.ids) {
          for (const q of adj.get(id) ?? []) {
            const other = itemByNode.get(q);
            if (!other || tier.get(q) !== t + 1 || other === it) continue;
            pairs.push([iu.get(it)!, il.get(other)!]);
          }
        }
      }
      for (let i = 0; i < pairs.length; i += 1) {
        for (let j = i + 1; j < pairs.length; j += 1) {
          const [a, b] = pairs[i]!;
          const [c, d] = pairs[j]!;
          if ((a < c && b > d) || (a > c && b < d)) n += 1;
        }
      }
    }
    return n;
  };
  const edgeCount = edges.length;
  const countable = edgeCount <= 3000;
  let best = countable ? crossings() : Number.POSITIVE_INFINITY;
  let bestOrder = new Map([...rows].map(([t, row]) => [t, [...row]]));
  const sweep = (down: boolean) => {
    const order = [...rows.keys()].sort((a, b) => (down ? a - b : b - a));
    for (const t of order) {
      const row = rows.get(t)!;
      if (row.length < 2) continue;
      const against = down ? t - 1 : t + 1;
      if (against < 0 || against >= tierCount) continue;
      const key = new Map<Item, number>();
      for (const it of row) key.set(it, mean(neighbourCentres(it, against)) ?? centre.get(it)!);
      const before = new Map(row.map((it, i) => [it, i]));
      row.sort((a, b) => key.get(a)! - key.get(b)! || before.get(a)! - before.get(b)!);
      positionRow(row);
    }
  };
  for (let pass = 0; pass < (countable ? 8 : 4); pass += 1) {
    sweep(pass % 2 === 0);
    if (!countable) continue;
    const now = crossings();
    if (now < best) {
      best = now;
      bestOrder = new Map([...rows].map(([t, row]) => [t, [...row]]));
    }
    if (now === 0) break;
  }
  if (countable) {
    for (const [t, row] of bestOrder) rows.set(t, row);
    for (const row of rows.values()) positionRow(row);
  }
  const indexOf = new Map<Item, number>();
  for (const row of rows.values()) row.forEach((it, i) => indexOf.set(it, i));

  // --- placement, as a tree ----------------------------------------------
  //
  // Each item hangs off the neighbour in the tier above that the order put
  // nearest its own barycentre; a fixed node's children hang off it at where
  // it is. An item with no parent is a root. Each item is centred over the
  // span of its children, so the diagram reads as a tree, and the spans of
  // siblings never overlap.
  const children = new Map<string, Item[]>();
  const push = (p: string, it: Item) => children.set(p, [...(children.get(p) ?? []), it]);
  const roots: Item[] = [];
  for (let t = 0; t < tierCount; t += 1) {
    for (const it of rows.get(t)!) {
      let parent: string | undefined = it.parent;
      if (parent === undefined) {
        // The nearest neighbour above, by the row positions the sweeps left.
        const cx = centre.get(it)!;
        let bestD = Number.POSITIVE_INFINITY;
        for (const id of it.ids) {
          for (const q of adj.get(id) ?? []) {
            const tq = tier.get(q)!;
            if (tq >= t) continue;
            const qx = fixedCentre(q)?.x ?? (itemByNode.get(q) ? centre.get(itemByNode.get(q)!)! : undefined);
            if (qx === undefined) continue;
            // Prefer the tier straight above; a longer edge only when
            // nothing nearer offers.
            const d = Math.abs(qx - cx) + (t - tq - 1) * 1e6;
            if (d < bestD) {
              bestD = d;
              parent = q;
            }
          }
        }
      }
      if (parent === undefined) roots.push(it);
      else push(parent, it);
    }
  }
  // Children in the order the sweeps settled.
  for (const list of children.values()) list.sort((a, b) => tier.get(a.ids[0]!)! - tier.get(b.ids[0]!)! || indexOf.get(a)! - indexOf.get(b)!);

  // The width each item's subtree needs.
  const span = new Map<Item, number>();
  const measure = (it: Item): number => {
    const kids = (it.ids.length === 1 ? children.get(it.ids[0]!) : undefined) ?? [];
    const under = kids.reduce((w, k, i) => w + (i ? siblingGap : 0) + measure(k), 0);
    const s = Math.max(it.width, under);
    span.set(it, s);
    return s;
  };
  // A fixed node's subtree is measured as a tree of its own.
  const fixedRoots = nodes.filter((n) => isFixed(n.id) && (children.get(n.id)?.length ?? 0) > 0);
  for (const r of roots) measure(r);
  const fixedSpan = new Map<string, number>();
  for (const f of fixedRoots) {
    const kids = children.get(f.id)!;
    fixedSpan.set(f.id, kids.reduce((w, k, i) => w + (i ? siblingGap : 0) + measure(k), 0));
  }

  // Left edges, relative: a root's subtree takes its span, its children
  // share the span under it.
  const left = new Map<Item, number>();
  const place = (it: Item, from: number) => {
    const s = span.get(it)!;
    left.set(it, from + (s - it.width) / 2);
    const kids = (it.ids.length === 1 ? children.get(it.ids[0]!) : undefined) ?? [];
    const under = kids.reduce((w, k, i) => w + (i ? siblingGap : 0) + span.get(k)!, 0);
    let at = from + (s - under) / 2;
    for (const k of kids) {
      place(k, at);
      at += span.get(k)! + siblingGap;
    }
  };
  let at = 0;
  for (const r of roots) {
    place(r, at);
    at += span.get(r)! + siblingGap;
  }
  // Tier tops, from the tallest item in each tier.
  const top = new Map<number, number>();
  const tall = new Map<number, number>();
  let y = originY;
  for (let t = 0; t < tierCount; t += 1) {
    const h = Math.max(0, ...rows.get(t)!.map((it) => it.height));
    top.set(t, y);
    tall.set(t, h);
    y += h + rankGap;
  }
  // The children of a fixed node, centred under where it is.
  for (const f of fixedRoots) {
    const fc = fixedCentre(f.id);
    if (!fc) {
      // Nowhere to hang them: they become roots on the right.
      for (const k of children.get(f.id)!) {
        place(k, at);
        at += span.get(k)! + siblingGap;
      }
      continue;
    }
    let from = fc.x - fixedSpan.get(f.id)! / 2 - originX;
    for (const k of children.get(f.id)!) {
      place(k, from);
      from += span.get(k)! + siblingGap;
    }
  }

  // --- flowing round what stays put ---------------------------------------
  //
  // Anything laid over a fixed node moves along its row, and everything to
  // its right in that row with it, so the order holds and nothing overlaps.
  const fixedBoxes = nodes
    .filter((n) => isFixed(n.id) && n.x !== undefined && n.y !== undefined)
    .map((n) => ({ x: n.x!, y: n.y!, w: n.width, h: n.height }));
  for (let t = 0; t < tierCount; t += 1) {
    const row = [...rows.get(t)!].sort((a, b) => left.get(a)! - left.get(b)!);
    const rowTop = top.get(t)!;
    const rowH = tall.get(t)!;
    let shift = 0;
    for (const it of row) {
      let x = left.get(it)! + originX + shift;
      for (const b of fixedBoxes) {
        const overlapsY = b.y < rowTop + rowH + rankGap / 2 && b.y + b.h > rowTop - rankGap / 2;
        const overlapsX = b.x < x + it.width + siblingGap / 2 && b.x + b.w > x - siblingGap / 2;
        if (overlapsY && overlapsX) {
          const pushed = b.x + b.w + siblingGap;
          shift += pushed - x;
          x = pushed;
        }
      }
      left.set(it, x - originX);
    }
  }

  // --- the positions --------------------------------------------------------
  for (let t = 0; t < tierCount; t += 1) {
    const rowTop = top.get(t)!;
    const rowH = tall.get(t)!;
    for (const it of rows.get(t)!) {
      const x0 = left.get(it)! + originX;
      const w = Math.max(...it.ids.map((id) => byId.get(id)!.width));
      const h = Math.max(...it.ids.map((id) => byId.get(id)!.height));
      if (it.ids.length === 1) {
        const n = byId.get(it.ids[0]!)!;
        moved.set(n.id, { x: Math.round(x0), y: Math.round(rowTop + (rowH - n.height) / 2) });
        continue;
      }
      // A fan: rows of `cols`, the last row centred under the first.
      it.ids.forEach((id, i) => {
        const r = Math.floor(i / it.cols);
        const c = i % it.cols;
        const inRow = r === it.rows - 1 ? it.ids.length - (it.rows - 1) * it.cols : it.cols;
        const rowW = inRow * w + (inRow - 1) * siblingGap;
        const n = byId.get(id)!;
        moved.set(id, {
          x: Math.round(x0 + (it.width - rowW) / 2 + c * (w + siblingGap) + (w - n.width) / 2),
          y: Math.round(rowTop + r * (h + FAN_ROW_GAP) + (h - n.height) / 2),
        });
      });
    }
  }
  return { moved, tiers: tierCount, locked, pinned };
}
