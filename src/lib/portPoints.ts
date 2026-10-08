/**
 * Ports as connection points.
 *
 * A device with a port count offers its ports along the edge of its drawing
 * that faces the other end of a link — the glyph's own extent,
 * meets it — port 1 at the near end of the edge reading left to right or top
 * to bottom. A link whose port label names a port attaches at that port; a
 * link end dropped on a port takes the port's name as its label. Names
 * come from the device's port naming (`Gi1/0/{n}`), else from the ports a
 * crawl found, else `port n`. Pure geometry, shared by the canvas and the
 * export.
 */
import { type Anchor, type Box, anchorPoint, nearestSide } from './floatingAnchor';
import { glyphBox, glyphOutlineAnchor } from './glyphExtents';
import { portNumber } from './rackCables';
import type { Side } from './routeLinks';

/** The most ports laid along one edge: past this the ticks are under a
 *  pixel apart at 100 % and the drawing says nothing. */
export const MAX_PORTS = 96;

export interface PortedDevice {
  deviceType: string;
  portCount?: number;
  portNaming?: string;
  ports?: readonly { port: string }[];
}

/** A device node's data as the port geometry wants it: the count, the
 *  naming, and the ports a crawl found. */
export function portedOf(d: { deviceType: string; portCount?: number; portNaming?: string; inventory?: { ports: readonly { port: string }[] } }): PortedDevice {
  return { deviceType: d.deviceType, portCount: d.portCount, portNaming: d.portNaming, ports: d.inventory?.ports };
}

/** How many ports the device offers as connection points, or 0. */
export function portCountOf(d: PortedDevice): number {
  const n = Math.floor(d.portCount ?? 0);
  return n > 0 && n <= MAX_PORTS ? n : 0;
}

/** Port `k`'s name: the naming pattern, else the crawl's port with that
 *  number, else `port k`. */
export function portName(d: PortedDevice, k: number): string {
  const pattern = d.portNaming?.trim();
  if (pattern && pattern.includes('{n}')) return pattern.replaceAll('{n}', String(k));
  const found = d.ports?.find((p) => portNumber(p.port) === k);
  if (found) return found.port;
  return `port ${k}`;
}

/** The port a label names, when the device has it. With a naming pattern
 *  the label has to fit it — `Gi1/0/5` is port 5 of `Gi1/0/{n}`, and `Po1`
 *  is a port-channel, not port 1; without one, the crawl's port of that
 *  name, else the label's last run of digits. */
export function portFromLabel(d: PortedDevice, label: string | undefined): number | null {
  const count = portCountOf(d);
  const text = label?.trim();
  if (!text || count === 0) return null;
  const pattern = d.portNaming?.trim();
  let n: number | null;
  if (pattern && pattern.includes('{n}')) {
    const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{n\\}', '(\\d+)')}$`, 'i');
    const m = re.exec(text);
    n = m ? Number(m[1]) : null;
  } else {
    const found = d.ports?.find((p) => p.port.toLowerCase() === text.toLowerCase());
    n = found ? portNumber(found.port) : portNumber(text);
  }
  return n !== null && n >= 1 && n <= count ? n : null;
}

/** The side of the drawing that faces `toward`. */
export function sideToward(box: Box, d: PortedDevice, toward: { x: number; y: number }): Side {
  return nearestSide(glyphOutlineAnchor(box, d.deviceType, toward));
}

/** Where port `k` of `count` sits on `side` of the drawing, as an anchor
 *  normalised to the node's box. */
export function portAnchor(box: Box, d: PortedDevice, side: Side, k: number, count: number): Anchor {
  const g = glyphBox(box, d.deviceType);
  const f = (k - 0.5) / count;
  let p: { x: number; y: number };
  switch (side) {
    case 't': p = { x: g.x + g.w * f, y: g.y }; break;
    case 'b': p = { x: g.x + g.w * f, y: g.y + g.h }; break;
    case 'l': p = { x: g.x, y: g.y + g.h * f }; break;
    default: p = { x: g.x + g.w, y: g.y + g.h * f };
  }
  return { x: (p.x - box.x) / box.w, y: (p.y - box.y) / box.h };
}

/** Every port along `side`, with its point in flow units. */
export function portsAlong(box: Box, d: PortedDevice, side: Side): { k: number; name: string; at: { x: number; y: number }; anchor: Anchor }[] {
  const count = portCountOf(d);
  const out = [];
  for (let k = 1; k <= count; k++) {
    const anchor = portAnchor(box, d, side, k, count);
    out.push({ k, name: portName(d, k), at: anchorPoint(box, anchor), anchor });
  }
  return out;
}

/** The port nearest a point on the side facing it, within `tolerance`. */
export function nearestPort(box: Box, d: PortedDevice, point: { x: number; y: number }, tolerance: number): { k: number; name: string; at: { x: number; y: number }; anchor: Anchor; side: Side } | null {
  if (portCountOf(d) === 0) return null;
  const side = sideToward(box, d, point);
  let best: ReturnType<typeof nearestPort> = null;
  let bestD = Infinity;
  for (const p of portsAlong(box, d, side)) {
    const dist = Math.hypot(p.at.x - point.x, p.at.y - point.y);
    if (dist <= tolerance && dist < bestD) {
      best = { ...p, side };
      bestD = dist;
    }
  }
  return best;
}

/** Where a link labelled with a port meets the device: that port, on the
 *  side facing the other end; null when the label names no port it has. */
export function labelledPortAnchor(box: Box, d: PortedDevice, label: string | undefined, toward: { x: number; y: number }): Anchor | null {
  const k = portFromLabel(d, label);
  if (k === null) return null;
  return portAnchor(box, d, sideToward(box, d, toward), k, portCountOf(d));
}

/** The side of the drawing an anchor sits on — the glyph's edge it is
 *  nearest, not the node box's. A port at the right-hand end of the bottom
 *  edge is on the bottom, and the link must leave downward, though the
 *  node box's right side is closer. */
export function anchorSide(box: Box, d: PortedDevice, a: Anchor): Side {
  const g = glyphBox(box, d.deviceType);
  const p = anchorPoint(box, a);
  const dist: Record<Side, number> = {
    t: Math.abs(p.y - g.y),
    b: Math.abs(p.y - (g.y + g.h)),
    l: Math.abs(p.x - g.x),
    r: Math.abs(p.x - (g.x + g.w)),
  };
  return (Object.keys(dist) as Side[]).reduce((best, s) => (dist[s] < dist[best] ? s : best));
}
