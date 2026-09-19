/**
 * Automatic layouts beyond top-to-bottom tiers (LT-177, allowed by D-029).
 *
 * Each runs only when asked, on the page or the selection, and returns where
 * things go; the store applies it as one undo step. Locked devices keep their
 * place — the radial and grid layouts leave their slot to them, the
 * force-directed one treats them as fixed points the rest arrange around.
 *
 * All three are deterministic: the same diagram laid out twice lands the same
 * way twice, so a layout can be undone, adjusted and redone without it
 * reshuffling for no reason.
 *
 * Each keeps the laid-out devices centred where they already were, so laying
 * out a selection does not throw it across the page.
 */

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  locked?: boolean;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export type Positions = Map<string, { x: number; y: number }>;

function neighbours(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Map<string, string[]> {
  const ids = new Set(nodes.map((n) => n.id));
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue;
    adj.get(e.source)!.push(e.target);
    adj.get(e.target)!.push(e.source);
  }
  // Sorted, so the walk below does not depend on the order links were drawn.
  for (const list of adj.values()) list.sort();
  return adj;
}

function centroid(nodes: readonly LayoutNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const n of nodes) {
    x += n.x + n.width / 2;
    y += n.y + n.height / 2;
  }
  return { x: x / nodes.length, y: y / nodes.length };
}

/** Top-left positions for the given centres, only for unlocked nodes. */
function toPositions(nodes: readonly LayoutNode[], centres: Map<string, { x: number; y: number }>): Positions {
  const out: Positions = new Map();
  for (const n of nodes) {
    if (n.locked) continue;
    const c = centres.get(n.id);
    if (c) out.set(n.id, { x: Math.round(c.x - n.width / 2), y: Math.round(c.y - n.height / 2) });
  }
  return out;
}

/** How many hops the farthest reachable node is from `id`. */
function eccentricity(id: string, adj: Map<string, string[]>): number {
  const seen = new Map<string, number>([[id, 0]]);
  const queue = [id];
  let far = 0;
  while (queue.length) {
    const at = queue.shift()!;
    const d = seen.get(at)!;
    far = Math.max(far, d);
    for (const next of adj.get(at)!) {
      if (!seen.has(next)) {
        seen.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  return far;
}

/** Past this many nodes, the centre is picked by link count alone: finding the
 *  true centre walks the graph once per node. */
const EXACT_CENTRE_LIMIT = 600;

/**
 * The order a breadth-first walk visits everything, starting each component
 * from its centre — the node fewest hops from everything else in it, which on
 * a campus is the core even when an access switch has as many links. Ties go to
 * more links, then to the id, so the answer never depends on drawing order.
 */
function walkOrder(nodes: readonly LayoutNode[], adj: Map<string, string[]>): { order: string[]; depth: Map<string, number>; parent: Map<string, string> } {
  const exact = nodes.length <= EXACT_CENTRE_LIMIT;
  const ecc = new Map(nodes.map((n) => [n.id, exact ? eccentricity(n.id, adj) : 0]));
  const byCentrality = [...nodes].sort(
    (a, b) =>
      ecc.get(a.id)! - ecc.get(b.id)! ||
      adj.get(b.id)!.length - adj.get(a.id)!.length ||
      (a.id < b.id ? -1 : 1),
  );
  const depth = new Map<string, number>();
  const parent = new Map<string, string>();
  const order: string[] = [];
  let base = 0;
  for (const start of byCentrality) {
    if (depth.has(start.id)) continue;
    depth.set(start.id, base);
    const queue = [start.id];
    let deepest = base;
    while (queue.length) {
      const id = queue.shift()!;
      order.push(id);
      for (const next of adj.get(id)!) {
        if (depth.has(next)) continue;
        const d = depth.get(id)! + 1;
        depth.set(next, d);
        parent.set(next, id);
        deepest = Math.max(deepest, d);
        queue.push(next);
      }
    }
    // A second component starts on the ring after the first one's outermost.
    base = deepest + 1;
  }
  return { order, depth, parent };
}

/**
 * Radial: the best-connected device in the middle — on a campus, the core —
 * and everything else on rings by how many links away it is, each placed near
 * the angle of what it hangs off.
 */
export function radialLayout(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], spacing = 180): Positions {
  const movable = nodes.filter((n) => !n.locked);
  if (movable.length === 0) return new Map();
  const adj = neighbours(nodes, edges);
  const { order, depth, parent } = walkOrder(nodes, adj);
  const centre = centroid(nodes);
  const rings = new Map<number, string[]>();
  for (const id of order) {
    const d = depth.get(id)!;
    if (!rings.has(d)) rings.set(d, []);
    rings.get(d)!.push(id);
  }
  const angle = new Map<string, number>();
  const centres = new Map<string, { x: number; y: number }>();
  let radius = 0;
  for (const d of [...rings.keys()].sort((a, b) => a - b)) {
    const ring = rings.get(d)!;
    if (d === 0 && ring.length === 1) {
      centres.set(ring[0]!, centre);
      angle.set(ring[0]!, 0);
      continue;
    }
    // Far enough out that the ring holds its devices a `spacing` apart, and
    // never nearer than one step beyond the last ring.
    radius = Math.max(radius + spacing, (ring.length * spacing) / (2 * Math.PI));
    // Round the ring in the order of the angle each one's parent sits at, so
    // a branch stays together rather than crossing the diagram.
    const sorted = [...ring].sort((a, b) => {
      const pa = angle.get(parent.get(a) ?? '') ?? 0;
      const pb = angle.get(parent.get(b) ?? '') ?? 0;
      return pa - pb || (a < b ? -1 : 1);
    });
    sorted.forEach((id, i) => {
      const t = (2 * Math.PI * i) / sorted.length - Math.PI / 2;
      angle.set(id, t);
      centres.set(id, { x: centre.x + radius * Math.cos(t), y: centre.y + radius * Math.sin(t) });
    });
  }
  return toPositions(nodes, centres);
}

/**
 * Force-directed: links pull, everything pushes, locked devices hold still —
 * for a mesh, where there is no top and no middle. Starts from where things
 * are, so a diagram already roughly arranged keeps its broad shape.
 */
export function forceLayout(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], spacing = 220): Positions {
  const n = nodes.length;
  if (n === 0 || nodes.every((x) => x.locked)) return new Map();
  const adj = neighbours(nodes, edges);
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  nodes.forEach((node, i) => {
    px[i] = node.x + node.width / 2;
    py[i] = node.y + node.height / 2;
  });
  // Nodes sitting exactly on top of each other have no direction to push in;
  // a small, fixed spread gives them one without any randomness.
  const seen = new Map<string, number>();
  nodes.forEach((node, i) => {
    const key = `${Math.round(px[i]!)},${Math.round(py[i]!)}`;
    const k = seen.get(key) ?? 0;
    seen.set(key, k + 1);
    if (k > 0 && !node.locked) {
      px[i] = px[i]! + Math.cos(k * 2.399) * spacing * 0.3 * Math.sqrt(k);
      py[i] = py[i]! + Math.sin(k * 2.399) * spacing * 0.3 * Math.sqrt(k);
    }
  });
  const start = centroid(nodes);
  const iterations = n <= 150 ? 300 : n <= 600 ? 150 : 60;
  const k = spacing;
  let temperature = spacing * 2;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ddx = px[i]! - px[j]!;
        let ddy = py[i]! - py[j]!;
        let dist = Math.hypot(ddx, ddy);
        if (dist < 1) {
          ddx = 1;
          ddy = 0;
          dist = 1;
        }
        const force = (k * k) / dist;
        const fx = (ddx / dist) * force;
        const fy = (ddy / dist) * force;
        dx[i] = dx[i]! + fx;
        dy[i] = dy[i]! + fy;
        dx[j] = dx[j]! - fx;
        dy[j] = dy[j]! - fy;
      }
    }
    for (const node of nodes) {
      const i = index.get(node.id)!;
      for (const other of adj.get(node.id)!) {
        const j = index.get(other)!;
        if (j <= i) continue;
        const ddx = px[i]! - px[j]!;
        const ddy = py[i]! - py[j]!;
        const dist = Math.max(1, Math.hypot(ddx, ddy));
        const force = (dist * dist) / k;
        const fx = (ddx / dist) * force;
        const fy = (ddy / dist) * force;
        dx[i] = dx[i]! - fx;
        dy[i] = dy[i]! - fy;
        dx[j] = dx[j]! + fx;
        dy[j] = dy[j]! + fy;
      }
    }
    for (let i = 0; i < n; i++) {
      if (nodes[i]!.locked) continue;
      const len = Math.hypot(dx[i]!, dy[i]!);
      if (len === 0) continue;
      const step = Math.min(len, temperature);
      px[i] = px[i]! + (dx[i]! / len) * step;
      py[i] = py[i]! + (dy[i]! / len) * step;
    }
    temperature = Math.max(1, temperature * 0.97);
  }
  // Back to where the group was, unless something locked anchors it already.
  const anchored = nodes.some((x) => x.locked);
  const centres = new Map<string, { x: number; y: number }>();
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += px[i]!;
    cy += py[i]!;
  }
  const shiftX = anchored ? 0 : start.x - cx / n;
  const shiftY = anchored ? 0 : start.y - cy / n;
  nodes.forEach((node, i) => centres.set(node.id, { x: px[i]! + shiftX, y: py[i]! + shiftY }));
  return toPositions(nodes, centres);
}

/**
 * Orthogonal: devices on a strict grid, as a tree of blocks — the centre at the
 * top, what hangs off each device in the cells under it, and a device's hosts
 * wrapped into a compact block rather than one long row — so links run down
 * and along the grid, the look of an MDF or IDF drawing. Unlike the
 * top-to-bottom arrangement (LT-145) it goes by the links alone, not by what
 * kind of device each is.
 */
export function orthogonalLayout(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], gapX = 200, gapY = 170): Positions {
  const movable = nodes.filter((n) => !n.locked);
  if (movable.length === 0) return new Map();
  const adj = neighbours(movable, edges);
  const { order, depth, parent } = walkOrder(movable, adj);
  const cellW = Math.max(gapX, ...movable.map((n) => n.width + 60));
  const cellH = Math.max(gapY, ...movable.map((n) => n.height + 60));

  const children = new Map<string, string[]>(order.map((id) => [id, []]));
  const roots: string[] = [];
  for (const id of order) {
    const p = parent.get(id);
    if (p !== undefined) children.get(p)!.push(id);
    else roots.push(id);
  }

  // Each subtree's footprint in whole cells.
  const size = new Map<string, { w: number; h: number }>();
  const measure = (id: string): { w: number; h: number } => {
    const kids = children.get(id)!;
    let s: { w: number; h: number };
    if (kids.length === 0) s = { w: 1, h: 1 };
    else if (kids.every((k) => children.get(k)!.length === 0)) {
      const cols = Math.ceil(Math.sqrt(kids.length));
      s = { w: Math.max(1, cols), h: 1 + Math.ceil(kids.length / cols) };
    } else {
      const parts = kids.map(measure);
      s = { w: parts.reduce((a, p) => a + p.w, 0), h: 1 + Math.max(...parts.map((p) => p.h)) };
    }
    size.set(id, s);
    return s;
  };
  for (const r of roots) measure(r);

  // Cells, from each block's top-left.
  const cell = new Map<string, { c: number; r: number }>();
  const place = (id: string, c: number, r: number) => {
    const s = size.get(id)!;
    cell.set(id, { c: c + Math.floor((s.w - 1) / 2), r });
    const kids = children.get(id)!;
    if (kids.length === 0) return;
    if (kids.every((k) => children.get(k)!.length === 0)) {
      kids.forEach((k, i) => cell.set(k, { c: c + (i % s.w), r: r + 1 + Math.floor(i / s.w) }));
      return;
    }
    let at = c;
    for (const k of kids) {
      place(k, at, r + 1);
      at += size.get(k)!.w;
    }
  };
  let at = 0;
  for (const r of roots) {
    place(r, at, 0);
    at += size.get(r)!.w + 1;
  }

  const cols = Math.max(...[...cell.values()].map((v) => v.c)) + 1;
  const rowsN = Math.max(...[...cell.values()].map((v) => v.r)) + 1;
  const centre = centroid(movable);
  const left = centre.x - ((cols - 1) * cellW) / 2;
  const top = centre.y - ((rowsN - 1) * cellH) / 2;
  // Cells a locked device already covers are left to it: a device moves along
  // its row to the next free cell.
  const locked = nodes.filter((n) => n.locked);
  const takenBy = (cx: number, cy: number) =>
    locked.some((l) => Math.abs(l.x + l.width / 2 - cx) < cellW / 2 && Math.abs(l.y + l.height / 2 - cy) < cellH / 2);
  const used = new Set<string>();
  const centres = new Map<string, { x: number; y: number }>();
  for (const id of order) {
    const { r } = cell.get(id)!;
    let { c } = cell.get(id)!;
    while (used.has(`${r},${c}`) || takenBy(left + c * cellW, top + r * cellH)) c += 1;
    used.add(`${r},${c}`);
    centres.set(id, { x: left + c * cellW, y: top + r * cellH });
  }
  void depth;
  return toPositions(nodes, centres);
}
