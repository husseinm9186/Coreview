/**
 * Where devices are while a drag is in flight (LT-189).
 *
 * Dragging used to write every frame's position into the project document.
 * Every device, link and panel subscribed to the document then re-ran its
 * selectors — some twenty thousand of them at a thousand devices — to learn
 * that one device had moved, and dragging ran at a handful of frames a second.
 *
 * So positions in flight live here instead, and the document is written once,
 * on release, exactly as the last frame of a drag always was (groups and
 * sections carried by the total movement, as `moveGroups` does). Only what
 * moved is published, so a link reads its two ends from here and re-renders
 * only when one of them is moving.
 */
import { create } from 'zustand';

import type { TopoNode } from './store';

interface DragOverlay {
  /** The devices that have moved in the drag under way, by id; null when no
   *  drag is in flight. */
  moved: Map<string, TopoNode> | null;
  publish: (moved: Map<string, TopoNode> | null) => void;
}

export const useDragOverlay = create<DragOverlay>((set) => ({
  moved: null,
  publish: (moved) => set({ moved }),
}));
