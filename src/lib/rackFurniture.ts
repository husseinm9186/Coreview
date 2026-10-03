/**
 * What a rack holds that is not a network device (LT-682, LT-686, D-065):
 * the kinds, how tall each is by default, how it mounts, and what the
 * elevation draws for it. Heights are the common ones — a 1U patch panel,
 * a 2U UPS — and every one can be changed on the item.
 */
import type { Airflow, RackFace, RackFurniture } from './rack';

export type FurnitureKind =
  | 'patch-panel'
  | 'fibre-panel'
  | 'pdu'
  | 'pdu-vertical'
  | 'ups'
  | 'shelf'
  | 'blank'
  | 'cable-manager'
  | 'kvm'
  | 'console-server'
  | 'monitor-drawer'
  | 'server'
  | 'storage'
  | 'reserved'
  | 'other';

export interface FurnitureSpec {
  kind: FurnitureKind;
  label: string;
  /** Default height in U; 0 is zero-U (down the post). */
  units: number;
  depth: 'full' | 'half';
  face: RackFace;
  airflow?: Airflow;
  /** A sentence for the palette's tooltip. */
  hint: string;
  /** How many jacks or outlets the faceplate shows, where it has them. */
  ports?: number;
}

export const FURNITURE: FurnitureSpec[] = [
  { kind: 'patch-panel', label: 'Patch panel', units: 1, depth: 'half', face: 'front', airflow: 'passive', ports: 24, hint: '24 copper jacks in 1U; change the count on the item.' },
  { kind: 'fibre-panel', label: 'Fibre enclosure', units: 1, depth: 'half', face: 'front', airflow: 'passive', ports: 12, hint: 'LC or SC cassettes in a 1U enclosure.' },
  { kind: 'pdu', label: 'PDU (horizontal)', units: 1, depth: 'half', face: 'rear', airflow: 'passive', ports: 8, hint: 'A rack-mount power strip on the rear rails.' },
  { kind: 'pdu-vertical', label: 'PDU (vertical, zero-U)', units: 0, depth: 'half', face: 'rear', airflow: 'passive', ports: 24, hint: 'Down the rear post; takes no U.' },
  { kind: 'ups', label: 'UPS', units: 2, depth: 'full', face: 'front', airflow: 'front-to-back', hint: '2U is the common rack-mount size; a 3U or larger one has its height changed here.' },
  { kind: 'shelf', label: 'Shelf', units: 1, depth: 'full', face: 'front', airflow: 'passive', hint: 'A fixed or sliding shelf for what has no ears.' },
  { kind: 'blank', label: 'Blanking panel', units: 1, depth: 'half', face: 'front', airflow: 'passive', hint: 'Closes an empty U so cold air stays in the cold aisle.' },
  { kind: 'cable-manager', label: 'Cable manager', units: 1, depth: 'half', face: 'front', airflow: 'passive', hint: 'A horizontal finger duct; 0U for one down the post.' },
  { kind: 'kvm', label: 'KVM switch', units: 1, depth: 'half', face: 'rear', airflow: 'passive', ports: 8, hint: 'Console switch for the servers in the rack.' },
  { kind: 'console-server', label: 'Console server', units: 1, depth: 'half', face: 'rear', airflow: 'passive', ports: 16, hint: 'Serial console access to the network devices.' },
  { kind: 'monitor-drawer', label: 'Monitor and keyboard drawer', units: 1, depth: 'full', face: 'front', airflow: 'passive', hint: 'A 1U sliding drawer with a screen.' },
  { kind: 'server', label: 'Server (not on the diagram)', units: 1, depth: 'full', face: 'front', airflow: 'front-to-back', hint: 'A box that takes space but is not drawn as a network device.' },
  { kind: 'storage', label: 'Storage (not on the diagram)', units: 2, depth: 'full', face: 'front', airflow: 'front-to-back', hint: 'An array that takes space but is not drawn as a network device.' },
  { kind: 'reserved', label: 'Reserved space', units: 1, depth: 'full', face: 'front', hint: 'Keeps U free for what is coming; say what for.' },
  { kind: 'other', label: 'Other', units: 1, depth: 'full', face: 'front', hint: 'Anything else that takes U.' },
];

export function furnitureSpec(kind: FurnitureKind): FurnitureSpec {
  return FURNITURE.find((f) => f.kind === kind) ?? FURNITURE[FURNITURE.length - 1]!;
}

/** A new item of a kind, from the spec's defaults. */
export function newFurniture(kind: FurnitureKind, id: string, label?: string, units?: number): RackFurniture {
  const spec = furnitureSpec(kind);
  return {
    id,
    kind,
    label: (label ?? '').trim() || spec.label,
    units: units ?? spec.units,
    face: spec.face,
    depth: spec.depth,
    ...(spec.airflow ? { airflow: spec.airflow } : {}),
  };
}

/** Why a piece of furniture cannot be as described, or null. */
export function furnitureProblem(f: Pick<RackFurniture, 'label' | 'units'>): string | null {
  if (!f.label.trim()) return 'It needs a name.';
  if (!Number.isInteger(f.units) || f.units < 0 || f.units > 60) return 'A height is a whole number of U, 0 to 60.';
  return null;
}
