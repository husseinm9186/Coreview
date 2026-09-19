/**
 * What a link is physically made of (LT-167).
 *
 * Shown as a short tag in the link's centre label — `SMF`, `Cu`, `Wi-Fi` —
 * rather than as a line style, because line style already carries status
 * (a down link is dashed) and a cable type drawn the same way would read as a
 * fault. A tag is legible in greyscale and on either ground, on the canvas and
 * in every export, and it is what the cable schedule (LT-198) lists.
 */
import type { LinkData } from '../types/domain';

export type CableType = 'copper' | 'fiber-sm' | 'fiber-mm' | 'coax' | 'wireless' | 'wan' | 'trunk';

export const CABLES: Record<CableType, { label: string; tag: string }> = {
  copper: { label: 'Copper', tag: 'Cu' },
  'fiber-sm': { label: 'Fibre, single-mode', tag: 'SMF' },
  'fiber-mm': { label: 'Fibre, multimode', tag: 'MMF' },
  coax: { label: 'Coax', tag: 'Coax' },
  wireless: { label: 'Wireless', tag: 'Wi-Fi' },
  wan: { label: 'WAN link', tag: 'WAN' },
  trunk: { label: 'Trunk', tag: 'Trunk' },
};

export const CABLE_TYPES = Object.keys(CABLES) as CableType[];

export function isCableType(value: unknown): value is CableType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CABLES, value);
}

/** The tag a link shows, or '' when no cable type is set. */
export function cableTag(d: Pick<LinkData, 'cableType'>): string {
  return isCableType(d.cableType) ? CABLES[d.cableType].tag : '';
}

/** The centre label's text: the tag, then the label. */
export function centreLabel(d: Pick<LinkData, 'cableType' | 'label'>): string {
  return [cableTag(d), d.label?.trim()].filter(Boolean).join(' · ');
}
