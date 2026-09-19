import type { DeviceNodeData } from '../types/domain';

/**
 * Whether a device draws the stacked glyph (LT-159, LT-160).
 *
 * A stack or chassis pair discovery reported, or HA ticked by hand. Not one
 * half of a chassis pair drawn as two switches (LT-140): that half still
 * carries the pair's stack fields, so the inspector lists both members, but
 * it is one box.
 */
export function drawsStacked(d: Pick<DeviceNodeData, 'ha' | 'stackKind' | 'stackMembers' | 'stackSplit'>): boolean {
  if (d.ha) return true;
  if (d.stackSplit) return false;
  return Boolean(d.stackKind?.trim() || d.stackMembers?.trim());
}
