/**
 * Which link the pointer is on, so the rest can fade behind it.
 *
 * Tracing one link used to be pure CSS: `.react-flow__edges:has(.react-flow__
 * edge:hover)` faded every link, and `:hover` un-faded the one under the
 * pointer. That worked while the thing the pointer landed on was the line
 * itself.
 *
 * It is not any more. The band that makes a link clickable near its devices
 * (LT-112) has to sit above the node layer to do its job, which puts it in a
 * different part of the tree from the line it belongs to — so the line is
 * never `:hover`, and no selector can join the two back up. One shared value
 * does what the selector no longer can.
 *
 * Deliberately not in the app store: this changes on every pointer move across
 * a diagram, and putting it there would put a hover into the undo history and
 * into every save.
 */

import { createElement, useSyncExternalStore } from 'react';

let traced: string | null = null;
const listeners = new Set<() => void>();

/** Marks the link under the pointer, or clears it with `null`. */
export function setTraced(id: string | null): void {
  if (traced === id) return;
  traced = id;
  for (const l of listeners) l();
}

// Any press ends tracing (LT-189): pointing at a link and then pressing to pan
// or drag left the whole diagram faded for as long as the button was held.
// Nothing re-traces until the pointer next enters a link with no button down.
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => setTraced(null), true);
}

export function tracedEdge(): string | null {
  return traced;
}

export function subscribeTraced(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Fades every link but the traced one, as a single stylesheet rule (LT-189).
 *
 * It used to be an opacity each link computed for itself, so pointing at a
 * link re-rendered all of them; on a 5,000-link page a pan sweeping across
 * links did that on every frame. A selected link is never faded.
 */
export function TraceFade() {
  const id = useSyncExternalStore(subscribeTraced, tracedEdge, tracedEdge);
  if (id === null) return null;
  const quoted = JSON.stringify(id);
  return createElement(
    'style',
    null,
    `.react-flow__edge:not(.selected) .cv-link-body:not([data-edge=${quoted}]) { opacity: 0.2; }`,
  );
}
