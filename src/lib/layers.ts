/**
 * Layers: more than one drawing in one document.
 *
 * A network is documented more than once. The physical layer says which cable
 * is in which socket; the logical one says which VLAN reaches which building;
 * a third says what the change on Saturday will do. They share every device
 * and almost no links, and keeping them as three files means three files that
 * disagree within a fortnight.
 *
 * So a layer is a property of an object rather than a container of them.
 * Nothing has to move between layers, an object can be on more than one, and
 * an object that has never been assigned is on every layer — which is what
 * makes a document drawn before layers existed still open with everything
 * visible.
 */

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  /** Locked layers draw normally and refuse to be edited, for a background
   *  everything else is drawn on top of. */
  locked: boolean;
  /** LT-184: left out of every export and of printing when false. Absent on
   *  every layer made before this existed, and absent means printed. */
  print?: boolean;
}

export const DEFAULT_LAYER: Layer = {
  id: 'base',
  name: 'Base',
  visible: true,
  locked: false,
};

/** What an object says about where it belongs. */
export type LayerRef = string[] | undefined;

/**
 * Whether an object should be drawn.
 *
 * An object with no layers is on all of them. That is the rule that keeps a
 * diagram drawn before any of this existed from disappearing the moment
 * somebody adds a layer to it.
 */
export function isVisible(on: LayerRef, layers: Layer[]): boolean {
  if (!on || on.length === 0) return true;
  const shown = new Set(layers.filter((l) => l.visible).map((l) => l.id));
  // Layers the document no longer has are ignored rather than hiding the
  // object: deleting a layer must not delete what was on it.
  const known = new Set(layers.map((l) => l.id));
  const relevant = on.filter((id) => known.has(id));
  if (relevant.length === 0) return true;
  return relevant.some((id) => shown.has(id));
}

/**
 * Whether an object goes into an export or onto paper (LT-184): what is being
 * looked at, less the views set not to print. The same rules as `isVisible` —
 * an object on no view, or only on views the document no longer has, is on all
 * of them — and an object on several goes out if any of them does.
 */
export function isPrinted(on: LayerRef, layers: Layer[]): boolean {
  if (!on || on.length === 0) return true;
  const out = new Set(layers.filter((l) => l.visible && l.print !== false).map((l) => l.id));
  const known = new Set(layers.map((l) => l.id));
  const relevant = on.filter((id) => known.has(id));
  if (relevant.length === 0) return true;
  return relevant.some((id) => out.has(id));
}

/** Whether every view goes out as it is shown, so nothing needs filtering. */
export function allPrinted(layers: Layer[]): boolean {
  return layers.every((l) => l.visible && l.print !== false);
}

/** The views a new project starts with (LT-184): the ways a network is usually
 *  drawn more than once. Empty to begin with — anything on none of them is on
 *  all of them — so they cost nothing until something is put on one. */
export const STANDARD_LAYER_NAMES = ['Physical', 'Logical', 'Overlay', 'Annotations'] as const;

export function standardLayers(makeId: () => string): Layer[] {
  return STANDARD_LAYER_NAMES.map((name) => ({ id: makeId(), name, visible: true, locked: false }));
}

/** Adds whichever standard views a document does not have yet, by name, and
 *  drops the placeholder base view if nothing has been done with it — nothing
 *  put on it (`used`, the view ids objects are on) and no setting changed. */
export function withStandardLayers(stored: Layer[] | undefined, makeId: () => string, used: ReadonlySet<string> = new Set()): Layer[] {
  const current = layersOf(stored);
  const taken = new Set(current.map((l) => l.name.toLowerCase()));
  const added = standardLayers(makeId).filter((l) => !taken.has(l.name.toLowerCase()));
  const untouchedBase = (l: Layer) =>
    l.id === DEFAULT_LAYER.id && !used.has(l.id) && l.name === DEFAULT_LAYER.name && l.visible && !l.locked && l.print !== false;
  const kept = current.length === 1 && untouchedBase(current[0]!) ? [] : current;
  return [...kept, ...added];
}

/** Whether an object can be edited: everything it is on must be unlocked. */
export function isEditable(on: LayerRef, layers: Layer[]): boolean {
  if (!on || on.length === 0) return true;
  const locked = new Set(layers.filter((l) => l.locked).map((l) => l.id));
  return !on.some((id) => locked.has(id));
}

/** The layers a document has, with the base one guaranteed. */
export function layersOf(stored: Layer[] | undefined): Layer[] {
  if (!stored || stored.length === 0) return [DEFAULT_LAYER];
  return stored;
}

/** Adds a layer, with a name that is not already taken. */
export function withNewLayer(layers: Layer[], name: string, id: string): Layer[] {
  const taken = new Set(layers.map((l) => l.name.toLowerCase()));
  let candidate = name.trim() || 'Layer';
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${name.trim() || 'Layer'} ${n}`;
    n += 1;
  }
  return [...layers, { id, name: candidate, visible: true, locked: false }];
}

/**
 * Removing a layer.
 *
 * The objects on it are not removed — they fall back to being on every layer,
 * which is where an unassigned object lives. Deleting a view of the network
 * must not delete the network.
 */
export function withoutLayer(layers: Layer[], id: string): Layer[] {
  const left = layers.filter((l) => l.id !== id);
  return left.length === 0 ? [DEFAULT_LAYER] : left;
}

/** Puts an object on a layer, or takes it off. */
export function toggleOn(on: LayerRef, id: string): string[] {
  const current = on ?? [];
  return current.includes(id) ? current.filter((l) => l !== id) : [...current, id];
}
