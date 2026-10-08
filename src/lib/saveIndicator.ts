/**
 * What the save indicator in the top bar says, and in what colour.
 *
 * The indicator used to be a statement of fact about the document — "Saved
 * 6:49:16 PM" — which is true whether or not anybody pressed anything.
 * Pressing Save on an already-saved document therefore changed nothing on
 * screen and the button felt dead.
 *
 * So there are two different things here and they are kept apart. `lastSavedAt`
 * is when the document last reached disk, by any route. `savedAck` is when a
 * *person* asked for that, and only an explicit save sets it — autosave runs
 * every couple of seconds and a green flash on its schedule would say nothing
 * about the press it is meant to answer.
 */
export type SaveTone = 'dirty' | 'acknowledged' | 'idle';

/** How long an acknowledgement stays on screen before the timestamp returns. */
export const SAVE_ACK_MS = 2000;

export interface SaveState {
  dirty: boolean;
  lastSavedAt: number | null;
  savedAck: number | null;
  now: number;
}

export interface SaveIndicator {
  /** What it reads, before any timestamp. */
  label: string;
  tone: SaveTone;
  /** The instant to write after the label, or null for none. */
  at: number | null;
}

export function saveIndicator({ dirty, lastSavedAt, savedAck, now }: SaveState): SaveIndicator {
  // An edit made since the save is the more important thing to say. Saving and
  // then typing one character leaves the document unsaved, whatever happened
  // two hundred milliseconds ago.
  if (dirty) return { label: 'Unsaved changes', tone: 'dirty', at: null };
  // A clock corrected under a running session can stamp an acknowledgement in
  // the future. That is not freshness, so the window is bounded at both ends.
  const age = savedAck === null ? Infinity : now - savedAck;
  if (age >= 0 && age <= SAVE_ACK_MS) return { label: 'Saved', tone: 'acknowledged', at: null };
  return { label: 'Saved', tone: 'idle', at: lastSavedAt };
}
