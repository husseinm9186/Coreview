/**
 * The page as paper: sizes, margins, rulers and the print scale.
 *
 * A diagram unit is 1/144 of an inch — the default sheet is 11 by 8.5
 * inches at 1584 by 1224 — so a page preset is a size in millimetres or
 * inches turned into units, a ruler counts units back into millimetres or
 * inches from the page's corner, and printing at 1:1 means one unit on
 * paper is 1/144 inch: 96/144 CSS pixels, since a browser prints at 96 dpi.
 */
import type { Rect } from './pageRect';

export const UNITS_PER_INCH = 144;
export const UNITS_PER_MM = UNITS_PER_INCH / 25.4;

export type PageSizeId = 'a4' | 'a3' | 'letter' | 'tabloid';
export type Orientation = 'portrait' | 'landscape';
export type RulerUnits = 'mm' | 'in';

export const PAGE_SIZES: { id: PageSizeId; name: string; w: number; h: number }[] = [
  { id: 'a4', name: 'A4', w: 210 * UNITS_PER_MM, h: 297 * UNITS_PER_MM },
  { id: 'a3', name: 'A3', w: 297 * UNITS_PER_MM, h: 420 * UNITS_PER_MM },
  { id: 'letter', name: 'Letter', w: 8.5 * UNITS_PER_INCH, h: 11 * UNITS_PER_INCH },
  { id: 'tabloid', name: 'Tabloid', w: 11 * UNITS_PER_INCH, h: 17 * UNITS_PER_INCH },
];

/** The sheet for a preset, portrait or landscape, keeping its top-left. */
export function pageRectFor(id: PageSizeId, orientation: Orientation, origin: { x: number; y: number }): Rect {
  const p = PAGE_SIZES.find((s) => s.id === id) ?? PAGE_SIZES[0]!;
  const w = Math.round(orientation === 'landscape' ? p.h : p.w);
  const h = Math.round(orientation === 'landscape' ? p.w : p.h);
  return { x: origin.x, y: origin.y, w, h };
}

/** The printable margin, 10 mm, as a rect inside the sheet. */
export const PRINT_MARGIN_MM = 10;
export function marginRect(sheet: Rect): Rect {
  const m = PRINT_MARGIN_MM * UNITS_PER_MM;
  return { x: sheet.x + m, y: sheet.y + m, w: Math.max(0, sheet.w - 2 * m), h: Math.max(0, sheet.h - 2 * m) };
}

/** The zoom at which one unit prints at 1/144 inch: 96 CSS px per inch over 144 units per inch. */
export const PRINT_ACTUAL_ZOOM = 96 / UNITS_PER_INCH;

export interface RulerScale {
  /** Flow units per labelled tick. */
  major: number;
  /** Flow units per small tick, or 0 when they would crowd. */
  minor: number;
  /** The label for a major tick at `n` majors from the origin. */
  label: (n: number) => string;
}

const MM_MAJORS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
const IN_MAJORS = [1 / 8, 1 / 4, 1 / 2, 1, 2, 5, 10, 20, 50, 100, 200];

/** The ruler's steps at a zoom: the smallest labelled step at least 48 px
 *  apart on screen, with small ticks a fifth (a quarter for inches) of it
 *  while they are at least 5 px apart. */
export function rulerScale(zoom: number, units: RulerUnits): RulerScale {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const per = units === 'mm' ? UNITS_PER_MM : UNITS_PER_INCH;
  const majors = units === 'mm' ? MM_MAJORS : IN_MAJORS;
  const chosen = majors.find((m) => m * per * z >= 48) ?? majors[majors.length - 1]!;
  const parts = units === 'mm' ? 5 : 4;
  const minorUnits = (chosen / parts) * per;
  return {
    major: chosen * per,
    minor: minorUnits * z >= 5 ? minorUnits : 0,
    label: (n) => {
      const v = n * chosen;
      return units === 'mm' ? String(Math.round(v)) : `${Math.round(v * 8) / 8}″`;
    },
  };
}

/** The ticks to draw along one axis of the ruler, in flow units from the
 *  page's origin, between `from` and `to` (flow units, absolute). */
export function rulerTicks(from: number, to: number, origin: number, scale: RulerScale): { at: number; major: boolean; label?: string }[] {
  const out: { at: number; major: boolean; label?: string }[] = [];
  const step = scale.minor || scale.major;
  const first = Math.floor((from - origin) / step);
  const last = Math.ceil((to - origin) / step);
  for (let i = first; i <= last; i++) {
    const rel = i * step;
    const ratio = rel / scale.major;
    const major = Math.abs(ratio - Math.round(ratio)) < 1e-6;
    out.push({ at: origin + rel, major, ...(major ? { label: scale.label(Math.round(ratio)) } : {}) });
  }
  return out;
}
