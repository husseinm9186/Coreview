/**
 * The two grounds a diagram gets drawn on.
 *
 * The dark ground is the working one — an operator watching a network at 2am
 * does not want a white screen. But a diagram that has to go into a document,
 * onto a projector, or in front of someone in daylight needs a white one, and
 * a colour chosen to glow on near-black is the wrong colour on white: amber
 * at #e8a33d is legible on #0a120f and washes out completely on #ffffff.
 *
 * So each status has two colours, not one, and the light values are darkened
 * and saturated until they hold their own against white rather than being the
 * same hue turned down.
 */
import type { HealthStatus } from './types/domain';

export type Ground = 'dark' | 'light';

export const STATUS_COLOR_DARK: Record<HealthStatus, string> = {
  // Lifted from #5b6b7c and #3d4a58, which read as smudges rather than as
  // colours once a diagram had more than a few of them on it.
  // The same four values as styles.css's --healthy/--warning/--down/--unknown,
  // so a chip in the chrome and a stroke on the canvas agree; down is the
  // brightest of the four, which is the order an eye needs.
  unknown: '#8a9bb0',
  healthy: '#35c26f',
  warning: '#f2b544',
  down: '#ff6259',
  disabled: '#55677a',
  maintenance: '#8b7ff0',
};

export const STATUS_COLOR_LIGHT: Record<HealthStatus, string> = {
  // Full strength, not the dark palette dimmed. Each has to read as itself on
  // white at a 1.5px stroke, which is how thin a link actually is — the first
  // attempt used lighter versions of these and every diagram looked faded.
  // Darkened until each holds on the warm desk as well as on the page: a
  // label stack that runs off the page is drawn on the desk.
  unknown: '#44576e',
  healthy: '#06693a',
  warning: '#8f4500',
  down: '#bf1d1d',
  disabled: '#64768a',
  maintenance: '#5323b8',
};

export function statusColors(ground: Ground): Record<HealthStatus, string> {
  return ground === 'light' ? STATUS_COLOR_LIGHT : STATUS_COLOR_DARK;
}

/** Colours for everything on the canvas that is not a status. */
export interface CanvasPalette {
  /** The dotted grid behind the diagram. */
  grid: string;
  minimapNode: string;
  minimapNote: string;
  minimapMask: string;
  /** The ring drawn round a selected node. */
  selection: string;
  /** Behind a port or centre label, so the line does not show through it. */
  labelBackground: string;
  /** A device with no status of its own. */
  neutralNode: string;
  /** A link nobody is watching: a drawing's line, not an unanswered probe. */
  linkNeutral: string;
}

export const CANVAS_DARK: CanvasPalette = {
  grid: '#1f2733',
  // At full strength: an unprobed node is information, and at 70 % it
  // fell under the 3:1 a mark needs on the page.
  minimapNode: '#5a6b80',
  minimapNote: '#3a4757',
  minimapMask: 'rgba(8,10,13,0.55)',
  // Ink, not the accent: a halo that reads on every family tint.
  selection: '#ffffff',
  labelBackground: 'rgba(12, 16, 22, 0.92)',
  neutralNode: '#8fa2b5',
  linkNeutral: '#5f6f82',
};

export const CANVAS_LIGHT: CanvasPalette = {
  grid: '#c8d3de',
  // Ink-dark marks on the light map. The old blue-greys were within a few
  // points of the mask, which is what made the minimap a washed-out blob.
  minimapNode: '#55606c',
  minimapNote: '#8a939e',
  minimapMask: 'rgba(228, 228, 228, 0.72)',
  selection: '#0b0e12',
  labelBackground: 'rgba(255, 255, 255, 0.96)',
  neutralNode: '#3d4e63',
  linkNeutral: '#3b4a5e',
};

export function canvasPalette(ground: Ground): CanvasPalette {
  return ground === 'light' ? CANVAS_LIGHT : CANVAS_DARK;
}

/**
 * Whether a colour someone chose is readable on the ground it will be drawn
 * on, and something that is if it is not.
 *
 * A link painted "a colour of its own" keeps that colour when the ground is
 * flipped, and a pale yellow chosen to stand out on black is invisible on
 * white. Rather than overriding the choice — which would lose it — it is
 * darkened only as far as it needs to be to be seen.
 */
export function readableOn(hex: string, ground: Ground): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const target = ground === 'light' ? 0.62 : 0.22;
  const l = luminance(rgb);
  if (ground === 'light' ? l <= target : l >= target) return hex;
  const factor = ground === 'light' ? 0.55 : 1.9;
  const shifted = rgb.map((c) =>
    Math.max(0, Math.min(255, Math.round(ground === 'light' ? c * factor : c * factor + 26))),
  ) as [number, number, number];
  return `#${shifted.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** The ink that reads on a solid fill of `hex`: near-black on a light
 *  colour, white on a dark one. An unparseable colour gets white. */
export function inkOn(hex: string): string {
  const rgb = parseHex(hex);
  return rgb && luminance(rgb) > 0.6 ? '#0b1220' : '#ffffff';
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Perceived brightness, 0 to 1. Not WCAG relative luminance — this only has
 *  to rank colours against one another, and the cheap weighting agrees with
 *  the eye closely enough for that. */
function luminance([r, g, b]: [number, number, number]): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * The colour a device is drawn in: what it is, always.
 *
 * Status used to take the stroke over — a down router turned red — which
 * meant a diagram could not say two things with one colour, and an orange
 * firewall was a warning until you looked twice. Now the stroke carries the
 * device's family and nothing else, and status is drawn beside it as a ring,
 * a dot or a badge (`statusMark`), so the two never fight.
 *
 * Seven families rather than a tint per type: a router and a cloud are
 * both routing, every switch and access point is switching, and the glyph's
 * shape carries the member. Each family reads on both grounds.
 */
export type DeviceFamily = 'routing' | 'switching' | 'security' | 'compute' | 'services' | 'storage' | 'physical';

export const DEVICE_FAMILY: Record<string, DeviceFamily> = {
  router: 'routing', internet: 'routing', 'mpls-cloud': 'routing', 'private-cloud': 'routing', cloud: 'routing', vpn: 'routing', zone: 'routing',
  'core-switch': 'switching', 'distribution-switch': 'switching', 'access-switch': 'switching', 'l3-switch': 'switching', 'l2-switch': 'switching',
  'wireless-controller': 'switching', 'access-point': 'switching',
  firewall: 'security', waf: 'security',
  server: 'compute', vm: 'compute', 'vm-host': 'compute', 'blade-chassis': 'compute',
  application: 'services', 'load-balancer': 'services', database: 'services',
  storage: 'storage', pdu: 'storage', ups: 'storage', site: 'storage',
  endpoint: 'physical', 'ip-phone': 'physical', printer: 'physical', camera: 'physical', rack: 'physical', 'patch-panel': 'physical', generic: 'physical',
};

export const FAMILY_TINT_DARK: Record<DeviceFamily, string> = {
  routing: '#5aa7f5',
  switching: '#3ec1d3',
  // Still orange, as every whiteboard draws a firewall, but a muted
  // terracotta that is duller than --warning and lighter than --down.
  security: '#d8865e',
  compute: '#b38cf5',
  services: '#e07bb0',
  // Sand, low in chroma, so it never reads as amber.
  storage: '#c9b27a',
  physical: '#94a3b8',
};

export const FAMILY_TINT_LIGHT: Record<DeviceFamily, string> = {
  routing: '#0b5fce',
  switching: '#0e7490',
  security: '#b4531b',
  compute: '#6d28d9',
  services: '#be185d',
  storage: '#8a6d00',
  physical: '#475569',
};

/** Per type, for whatever still reads the old shape of this table. */
export const DEVICE_TINT_DARK: Record<string, string> = Object.fromEntries(
  Object.entries(DEVICE_FAMILY).map(([type, family]) => [type, FAMILY_TINT_DARK[family]]),
);

export const DEVICE_TINT_LIGHT: Record<string, string> = Object.fromEntries(
  Object.entries(DEVICE_FAMILY).map(([type, family]) => [type, FAMILY_TINT_LIGHT[family]]),
);

/** What colour to draw a device in: its family's, on this ground. */
export function deviceColor(deviceType: string, ground: Ground): string {
  const tints = ground === 'light' ? FAMILY_TINT_LIGHT : FAMILY_TINT_DARK;
  const family = DEVICE_FAMILY[deviceType];
  return family ? tints[family] : canvasPalette(ground).neutralNode;
}

/**
 * The colour a status is marked in beside the glyph — a ring and a badge
 * for warning and down, a dot for healthy and maintenance — or nothing: a
 * device nobody has checked, or one switched off, carries no mark at all.
 * A "?" on every unknown node is the noise that teaches people to ignore
 * the "×" that matters.
 */
export function statusMark(status: HealthStatus, ground: Ground): string | null {
  if (status === 'unknown' || status === 'disabled') return null;
  return statusColors(ground)[status];
}

/** What a note looks like when nobody has chosen colours for it.
 *
 *  Stored colours are a decision and are left alone. An uncoloured note has
 *  made no decision, so it follows the ground — otherwise a diagram drawn on
 *  black and then switched to white for a document carries dark blocks
 *  through the middle of the page. */
export interface NotePalette {
  text: string;
  background: string;
  border: string;
}

export const NOTE_DARK: Record<'plain' | 'change' | 'sticky', NotePalette> = {
  plain: { text: '#d8e2ec', background: '#141c26', border: '#25313f' },
  change: { text: '#f2e6c8', background: '#2a2313', border: '#8a6d1f' },
  // A sticky note reads as one on either ground.
  sticky: { text: '#2b2408', background: '#e8d36a', border: '#b89c2a' },
};

export const NOTE_LIGHT: Record<'plain' | 'change' | 'sticky', NotePalette> = {
  plain: { text: '#16212e', background: '#ffffff', border: '#c3ceda' },
  change: { text: '#4a3506', background: '#fff8e3', border: '#d3a83c' },
  sticky: { text: '#2b2408', background: '#fbe98a', border: '#d4b53a' },
};

export function notePalette(variant: 'plain' | 'change' | 'sticky', ground: Ground): NotePalette {
  return (ground === 'light' ? NOTE_LIGHT : NOTE_DARK)[variant] ?? NOTE_LIGHT.plain;
}

/** Distinct hues, ordered so neighbours in the list do not look alike. */
export const GROUP_WHEEL_DARK = [
  '#4ea8f0', '#f59e0b', '#34d399', '#f472b6', '#a78bfa', '#22d3ee',
  '#fb923c', '#a3e635', '#fb7185', '#38bdf8', '#facc15', '#c084fc',
];

export const GROUP_WHEEL_LIGHT = [
  '#0b5fce', '#a15c00', '#067a4a', '#b8206b', '#5b32b8', '#0e7490',
  '#c2410c', '#4d7c0f', '#be123c', '#0369a1', '#8a6d00', '#7e22ce',
];

export interface Sheet {
  ground: Ground;
  paper: string;
  ink: string;
  inkDim: string;
  surface: string;
  line: string;
  header: string;
  onStatus: string;
}

export function sheetFor(ground: Ground): Sheet {
  return ground === 'light'
    ? {
        ground,
        paper: '#ffffff',
        ink: '#0d1722',
        inkDim: '#41536a',
        surface: '#f4f7fa',
        line: '#ccd6e0',
        header: '#eef3f8',
        onStatus: '#ffffff',
      }
    : {
        ground,
        paper: '#0b0e12',
        ink: '#e6f7ee',
        inkDim: '#8eb5a2',
        surface: '#111f18',
        line: '#2a3644',
        header: '#0e141b',
        onStatus: '#07110c',
      };
}

/** The tint a section is drawn in on an exported sheet. */
export const SHEET_SECTION_TINT: Record<Ground, string> = {
  light: '#0b5fce',
  dark: '#4ea8f0',
};

/**
 * Colours used away from the canvas — the export sheet, the samples, a default
 * written into a new object.
 *
 * Here rather than at the point of use so that one file answers "what colour
 * is anything", which is the only way a change of palette can be made without
 * hunting. A literal anywhere else in `src/` is a bug.
 */
export const DEFAULTS = {
  /** A link with no colour of its own. Stored in the document, so it must not
   *  depend on which ground the person drawing it happened to be using. A
   *  neutral grey, not the unknown status colour: an unwatched link and a
   *  probe that has not answered are different things. */
  linkColor: CANVAS_DARK.linkNeutral,
  /** The accent, for a picker that needs somewhere to start. */
  accent: FAMILY_TINT_DARK.routing,
  /** The paper an exported sheet is printed on when nothing says otherwise. */
  exportPaper: '#0b0e12',
  /** Where a label's colour and background pickers start. */
  labelInk: '#1f2933',
  labelBackground: '#ffffff',
} as const;
