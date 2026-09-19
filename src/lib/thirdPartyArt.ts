/**
 * Third-party artwork in a project, and the vendor-safe export (LT-170, D-028).
 *
 * A device drawn from an imported stencil carries that artwork inlined as
 * `imageDataUrl`, so an export of the diagram or the project carries it too —
 * and the operator, not Coreview, is responsible for whether that artwork may
 * leave the organisation. This module says what a project holds and produces
 * the copy that holds none of it.
 *
 * Coreview's own artwork is not third-party: a shape captured from a built-in
 * glyph (LT-104) is marked `ownArtwork` and never counted. Anything else with a
 * picture is counted, including devices from projects saved before this
 * existed — when in doubt, warn.
 */
import type { TopoNode } from '../state/store';
import type { DeviceNodeData } from '../types/domain';
import type { IconLibEntry } from './ipc';

export function usesImportedArtwork(d: Pick<DeviceNodeData, 'imageDataUrl' | 'ownArtwork'>): boolean {
  return Boolean(d.imageDataUrl) && !d.ownArtwork;
}

export interface ArtworkSummary {
  /** Devices drawn with imported artwork. */
  devices: number;
  /** The distinct licence statements their manifests gave. */
  licences: string[];
  /** Of those devices, how many came with no licence statement at all. */
  undescribed: number;
}

export function artworkSummary(nodes: readonly TopoNode[]): ArtworkSummary {
  let devices = 0;
  let undescribed = 0;
  const licences = new Set<string>();
  for (const n of nodes) {
    if (n.type !== 'device') continue;
    const d = n.data as DeviceNodeData;
    if (!usesImportedArtwork(d)) continue;
    devices++;
    const licence = d.stencilLicence?.trim();
    if (licence) licences.add(licence);
    else undescribed++;
  }
  return { devices, licences: [...licences].sort(), undescribed };
}

/** A device with its imported artwork replaced by the built-in shape for its
 *  class. A bare custom image has no class, so it becomes a generic device. */
function vendorSafeDevice(n: TopoNode): TopoNode {
  if (n.type !== 'device') return n;
  const d = n.data as DeviceNodeData;
  if (!usesImportedArtwork(d)) return n;
  const data: DeviceNodeData = { ...d, deviceType: d.deviceType === 'custom-image' ? 'generic' : d.deviceType };
  delete data.imageDataUrl;
  delete data.iconRef;
  delete data.stencilLicence;
  return { ...n, data } as TopoNode;
}

/** The nodes for a vendor-safe diagram export. The originals are untouched. */
export function vendorSafeNodes(nodes: readonly TopoNode[]): TopoNode[] {
  return nodes.map(vendorSafeDevice);
}

/**
 * A saved project document made vendor-safe, for the project package.
 *
 * The document is opaque JSON to Rust (D-002) and has changed shape over time
 * (a single page, then pages), so every device node found anywhere in it is
 * cleaned, and captured shapes that are not Coreview's own are dropped.
 */
export function vendorSafeDocument<T>(doc: T): T {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const obj = value as Record<string, unknown>;
    if (obj.type === 'device' && obj.data && typeof obj.data === 'object') {
      return vendorSafeDevice(obj as unknown as TopoNode);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = k === 'customShapes' && Array.isArray(v)
        ? (v as IconLibEntry[]).filter((c) => c.own)
        : walk(v);
    }
    return out;
  };
  return walk(doc) as T;
}
