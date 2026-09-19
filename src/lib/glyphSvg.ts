/**
 * A built-in device glyph, tinted, as standalone SVG markup.
 *
 * Shared by the diagram export (`diagram.ts`, which positions and sizes it
 * inline in a page) and LT-104's "save this shape back to the library"
 * (which wants the glyph on its own, the same shape an `IconLibEntry`
 * already is).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { DeviceGlyph, ICONS, stackedIcon } from '../components/icons';
import type { DeviceType } from '../types/domain';

/** `stacked` draws the glyph doubled, as the canvas does for a stack or an HA
 *  pair (LT-159). */
/** `stacked` draws the glyph doubled, as the canvas does for a stack or an HA
 *  pair (LT-159); `solid` draws it as a filled tile (LT-168). */
export function glyphMarkup(type: DeviceType, color: string, stacked = false, solid = false): string {
  if (solid) {
    // The tile is filled with `color` literally; only the glyph inside uses
    // currentColor, and there it must resolve to the ink, not the fill.
    const raw = renderToStaticMarkup(createElement(DeviceGlyph, { type, stacked, solid, color }));
    const inner = /style="color:(#[0-9a-f]{6})/i.exec(raw)?.[1] ?? '#ffffff';
    return raw.replaceAll('currentColor', inner);
  }
  const Icon = stacked ? stackedIcon(type) : (ICONS[type] ?? ICONS.generic);
  const raw = renderToStaticMarkup(Icon({}));
  return raw.replaceAll('currentColor', color);
}
