import { useRef } from 'react';

/**
 * The previous list, for as long as every item is the same by `same` (LT-189).
 *
 * Dragging a device replaces the document — and so every list read from it —
 * on every frame, though nothing but one position changed. A panel that shows
 * names and statuses can hold on to the list it already has and skip its work
 * entirely until something it actually shows changes.
 */
export function useStableList<T>(items: readonly T[], same: (a: T, b: T) => boolean): readonly T[] {
  const ref = useRef(items);
  const prev = ref.current;
  if (
    prev !== items &&
    (prev.length !== items.length || items.some((item, i) => !same(item, prev[i]!)))
  ) {
    ref.current = items;
  }
  return ref.current;
}
