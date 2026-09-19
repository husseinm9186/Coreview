/**
 * Moving around the canvas by keyboard (LT-240): Alt and an arrow go to the
 * nearest device in that direction.
 *
 * "In that direction" is a cone either side of the arrow, so a device a little
 * off the line still counts; a device straight ahead is preferred to a nearer
 * one off to the side.
 */
export interface NavBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Direction = 'left' | 'right' | 'up' | 'down';

const centre = (b: NavBox) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export function nearestInDirection(boxes: readonly NavBox[], fromId: string, dir: Direction): string | null {
  const from = boxes.find((b) => b.id === fromId);
  if (!from) return null;
  const c = centre(from);
  // Straight ahead first — within 30° of the arrow — and only if nothing is
  // there, anything within 60°: a device on the same row wins over a nearer
  // one on the row below.
  for (const cone of [30, 60]) {
    const limit = Math.tan((cone * Math.PI) / 180);
    let best: { id: string; score: number } | null = null;
    for (const b of boxes) {
      if (b.id === fromId) continue;
      const p = centre(b);
      const along = dir === 'left' ? c.x - p.x : dir === 'right' ? p.x - c.x : dir === 'up' ? c.y - p.y : p.y - c.y;
      const across = dir === 'left' || dir === 'right' ? Math.abs(p.y - c.y) : Math.abs(p.x - c.x);
      if (along <= 0 || across > along * limit) continue;
      const score = along + across * 2;
      if (!best || score < best.score) best = { id: b.id, score };
    }
    if (best) return best.id;
  }
  return null;
}

/** The device nearest a point, for starting from nothing selected. */
export function nearestTo(boxes: readonly NavBox[], x: number, y: number): string | null {
  let best: { id: string; d: number } | null = null;
  for (const b of boxes) {
    const p = centre(b);
    const d = Math.hypot(p.x - x, p.y - y);
    if (!best || d < best.d) best = { id: b.id, d };
  }
  return best?.id ?? null;
}
