/**
 * A page drawn small (LT-183): the outline of every device and a line for every
 * link, fitted into a thumbnail, for the page navigator.
 *
 * Not a picture of the page — a sketch of where things are, which is what tells
 * one page from another at a glance. Sections are drawn as outlines so they do
 * not bury what is in them. Pure, so it is tested without a browser, and capped
 * so a page with thousands of devices is still cheap to sketch.
 */
import type { ProjectPage } from '../state/store';

export interface ThumbBox {
  x: number;
  y: number;
  w: number;
  h: number;
  zone: boolean;
}

export interface ThumbLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Thumbnail {
  boxes: ThumbBox[];
  lines: ThumbLine[];
  /** How many devices were left out to keep the sketch cheap. */
  omitted: number;
}

export const THUMB_MAX_NODES = 1500;
const PAD = 4;

export function thumbnailOf(page: Pick<ProjectPage, 'nodes' | 'edges'>, width: number, height: number): Thumbnail {
  const nodes = page.nodes.slice(0, THUMB_MAX_NODES);
  if (nodes.length === 0) return { boxes: [], lines: [], omitted: 0 };
  const size = (n: (typeof nodes)[number]) => ({
    w: n.width ?? n.measured?.width ?? 76,
    h: n.height ?? n.measured?.height ?? 76,
  });
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const { w, h } = size(n);
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  const scale = Math.min((width - 2 * PAD) / Math.max(1, maxX - minX), (height - 2 * PAD) / Math.max(1, maxY - minY), 1);
  // Centred in the thumbnail.
  const offX = (width - (maxX - minX) * scale) / 2;
  const offY = (height - (maxY - minY) * scale) / 2;
  const round = (v: number) => Math.round(v * 10) / 10;
  const centres = new Map<string, { x: number; y: number }>();
  const boxes: ThumbBox[] = nodes.map((n) => {
    const { w, h } = size(n);
    const box = {
      x: round(offX + (n.position.x - minX) * scale),
      y: round(offY + (n.position.y - minY) * scale),
      w: round(Math.max(1, w * scale)),
      h: round(Math.max(1, h * scale)),
      zone: (n.data as { deviceType?: string } | undefined)?.deviceType === 'zone',
    };
    centres.set(n.id, { x: round(box.x + box.w / 2), y: round(box.y + box.h / 2) });
    return box;
  });
  // Sections first, so devices are drawn over them.
  boxes.sort((a, b) => Number(b.zone) - Number(a.zone));
  const lines: ThumbLine[] = [];
  for (const e of page.edges) {
    const a = centres.get(e.source);
    const b = centres.get(e.target);
    if (a && b) lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  return { boxes, lines, omitted: page.nodes.length - nodes.length };
}
