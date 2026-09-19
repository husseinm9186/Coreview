/**
 * The print-friendly export (LT-194): the diagram in greys, on white, with as
 * little ink as it can be drawn with.
 *
 * Every colour in the exported SVG is mapped by its brightness. Near-white
 * becomes white, so header bands and filled surfaces cost no ink. A coloured
 * mark becomes a grey dark enough to read on paper, so statuses stay legible —
 * and they are told apart by what they already carry beside their colour: a
 * glyph on every badge and link label (✓ ! ✕ ? – ⚙), and a down link's dashes.
 *
 * Only hex colours are written into an export; an imported stencil is an
 * embedded picture and is left as it is.
 */

/** Perceived brightness, 0 to 1 — the same weighting the theme uses. */
function brightness(r: number, g: number, b: number): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');

/** One colour, as print will have it. */
export function printGrey(hex: string): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const full = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const l = brightness(r, g, b);
  // Paper, surfaces, bands: white. Printing a 95% grey is ink for nothing.
  if (l >= 0.85) return '#ffffff';
  const saturation = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  // A coloured mark is darkened, so a pale status colour is still a mark on
  // paper and white glyphs on a badge still read. Neutral ink keeps its weight.
  // A neutral mid-grey is a mark too — the disabled status is one — and gets the
  // same ceiling; light greys (hairlines, rules) and dark ink keep their weight.
  const grey = saturation > 0.15 ? Math.min(l * 0.75, 0.5) : l > 0.5 && l < 0.7 ? 0.5 : l;
  const v = hex2(grey * 255);
  return `#${v}${v}${v}`;
}

/** An exported SVG with every colour mapped for print. */
export function printFriendly(svg: string): string {
  return svg.replace(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g, (c) => printGrey(c));
}
