/**
 * What the status line says after an arrangement, in one place: the canvas
 * menu, the command palette and the toolbar strip all run the same layouts
 * and must describe the result the same way.
 */
import { t } from '../i18n';

interface Kept {
  /** Locked devices left alone. */
  locked: number;
  /** Devices moved by hand since the last arrangement, left where they
   *  were put. */
  pinned: number;
}

function kept(r: Kept): string[] {
  const out: string[] = [];
  if (r.pinned) out.push(t('canvasTools.stayedPinned', { devices: t('plural.device', { count: r.pinned }) }));
  if (r.locked) out.push(t('canvasTools.stayedLocked', { devices: t('plural.lockedDevice', { count: r.locked }) }));
  return out;
}

export function arrangeByLayerMessage(r: Kept & { moved: number; tiers: number }): string {
  if (r.moved === 0) return r.pinned > 0 ? t('canvasTools.arrangedAllPinned') : t('canvasTools.arrangedNothing');
  return [
    t('canvasTools.arranged', { devices: t('plural.device', { count: r.moved }), layers: t('plural.layer', { count: r.tiers }) }),
    ...kept(r),
    t('canvasTools.undoHint'),
  ].join(' ');
}

export function layoutMessage(r: Kept & { moved: number; scope: 'selection' | 'page'; tooMany?: number }): string {
  if (r.tooMany) return t('canvasTools.meshLimit', { limit: r.tooMany.toLocaleString() });
  if (r.moved === 0) return r.pinned > 0 ? t('canvasTools.arrangedAllPinned') : t('canvasTools.laidOutNothing');
  return [
    t('canvasTools.laidOut', {
      devices: t('plural.device', { count: r.moved }),
      where: t(r.scope === 'selection' ? 'canvasTools.inSelection' : 'canvasTools.onPage'),
    }),
    ...kept(r),
    t('canvasTools.undoHint'),
  ].join(' ');
}
