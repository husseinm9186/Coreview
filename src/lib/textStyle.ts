/**
 * Rich text on labels (LT-181): bold, italic, size, colour, background and
 * alignment, for a device's name, a link's centre label and its port labels.
 *
 * One style, read two ways — as CSS on the canvas and as SVG attributes in the
 * export — so a label looks the same in both. Values are checked on the way
 * out: a size outside 8–48 is clamped, and only `#rrggbb` colours are used, so
 * nothing typed into a style can put anything else into a stylesheet or an
 * exported file.
 */
import type { CSSProperties } from 'react';

export type TextAlign = 'left' | 'center' | 'right';

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  /** Pixels. */
  size?: number;
  color?: string;
  background?: string;
  align?: TextAlign;
}

const HEX = /^#[0-9a-f]{6}$/i;

export const MIN_TEXT_SIZE = 8;
export const MAX_TEXT_SIZE = 48;

export function safeColour(value: string | undefined): string | undefined {
  return value && HEX.test(value) ? value : undefined;
}

export function safeSize(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.round(Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, value)));
}

/** Whether a style changes anything at all. */
export function isStyled(t: TextStyle | undefined): boolean {
  return Boolean(
    t && (t.bold || t.italic || safeSize(t.size) || safeColour(t.color) || safeColour(t.background) || (t.align && t.align !== 'center')),
  );
}

/** The style as CSS, over whatever the label already has. */
export function cssOf(t: TextStyle | undefined): CSSProperties {
  if (!t) return {};
  const out: CSSProperties = {};
  if (t.bold) out.fontWeight = 700;
  if (t.italic) out.fontStyle = 'italic';
  const size = safeSize(t.size);
  if (size) out.fontSize = `${size}px`;
  const color = safeColour(t.color);
  if (color) out.color = color;
  const background = safeColour(t.background);
  if (background) {
    out.background = background;
    out.padding = '0 4px';
    out.borderRadius = '3px';
  }
  if (t.align) out.textAlign = t.align;
  return out;
}

/**
 * The style as attributes on an SVG `<text>`, given the label's own defaults.
 * `fill` and the size are always written, so the caller's defaults need not be
 * repeated in the markup.
 */
export function svgTextAttrs(t: TextStyle | undefined, defaults: { size: number; fill: string; weight?: number }): string {
  const size = safeSize(t?.size) ?? defaults.size;
  const fill = safeColour(t?.color) ?? defaults.fill;
  const weight = t?.bold ? 700 : defaults.weight;
  return (
    ` fill="${fill}" font-size="${size}"` +
    (weight ? ` font-weight="${weight}"` : '') +
    (t?.italic ? ' font-style="italic"' : '')
  );
}

/** The size a styled label is drawn at, for measuring it. */
export function sizeOf(t: TextStyle | undefined, fallback: number): number {
  return safeSize(t?.size) ?? fallback;
}

/**
 * Where a single line of text goes along its box for an alignment: the x to
 * draw at and the matching `text-anchor`. `left`/`right` hold the text against
 * that edge of a box `width` wide centred on `centreX`.
 */
export function alignedX(align: TextAlign | undefined, centreX: number, width: number): { x: number; anchor: 'start' | 'middle' | 'end' } {
  if (align === 'left') return { x: centreX - width / 2, anchor: 'start' };
  if (align === 'right') return { x: centreX + width / 2, anchor: 'end' };
  return { x: centreX, anchor: 'middle' };
}
