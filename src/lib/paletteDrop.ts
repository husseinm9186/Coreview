/**
 * Turning a palette drag payload into a node.
 *
 * Extracted from Canvas so it can be tested directly: HTML5 drag-and-drop does
 * not fire from synthetic events, so driving a real drop in a headless browser
 * is not practical. The decision logic is the part worth covering, and it is
 * pure.
 */
import type { DeviceNodeData, DeviceType, NoteNodeData } from '../types/domain';
import type { TopoNode } from '../state/store';
import type { IconLibEntry } from './ipc';
import { utf8ToBase64 } from './base64';
import { isStencilClass } from './shapeCatalog';
import { BOUNDARIES, isBoundaryKind } from './boundaries';

/** Base64 data URL for an SVG, safe for non-ASCII glyph names. */
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${utf8ToBase64(svg)}`;
}

export interface DropDeps {
  makeDeviceNode: (type: DeviceType, x: number, y: number) => TopoNode;
  makeNote: (x: number, y: number, variant?: NoteNodeData['variant']) => TopoNode;
  iconLibrary: IconLibEntry[];
}

/**
 * Returns the node a palette payload should create, or null if the payload is
 * not one we recognise.
 *
 * Payloads:
 *   'note' | 'change-note'   annotation nodes
 *   'icon:<id>'              an SVG from the local icon library
 *   'boundary:<kind>'        a section that is a logical boundary (LT-166)
 *   '<deviceType>'           one of the built-in glyphs
 */
export function nodeForDrop(
  payload: string,
  x: number,
  y: number,
  deps: DropDeps,
): TopoNode | null {
  const raw = payload.trim();
  if (!raw) return null;

  if (raw === 'note' || raw === 'change-note' || raw === 'sticky-note') {
    return deps.makeNote(x, y, raw === 'change-note' ? 'change' : raw === 'sticky-note' ? 'sticky' : 'plain');
  }

  // LT-166: a logical boundary is a section that knows what kind it is.
  if (raw.startsWith('boundary:')) {
    const kind = raw.slice('boundary:'.length);
    if (!isBoundaryKind(kind)) return null;
    const node = deps.makeDeviceNode('zone', x, y);
    const data = node.data as DeviceNodeData;
    data.boundaryKind = kind;
    data.label = BOUNDARIES[kind].label;
    return node;
  }

  if (raw.startsWith('icon:')) {
    const id = raw.slice('icon:'.length);
    if (!id) return null;
    const icon = deps.iconLibrary.find((i) => i.id === id);
    // LT-169: a manifest says what the shape is, so the device is that class —
    // with that class's defaults, then whatever the manifest itself gives.
    const meta = icon?.meta;
    const node = deps.makeDeviceNode(isStencilClass(meta?.class) ? meta.class : 'generic', x, y);
    const data = node.data as DeviceNodeData;
    if (meta) {
      if (meta.vendor) data.vendor = meta.vendor;
      if (meta.model) data.model = meta.model;
      if (meta.ports !== undefined) data.portCount = meta.ports;
      if (meta.portNaming) data.portNaming = meta.portNaming;
      if (meta.rackUnits !== undefined) data.rackUnits = meta.rackUnits;
      data.stencilLicence = meta.licence;
    }
    // Keep the reference even when the icon is not currently loaded, so a
    // project made against a library that is temporarily missing still says
    // which icon it wanted.
    data.iconRef = id;
    data.label = icon?.name ?? id;
    // The inlined copy is what makes an exported project render on a machine
    // without the library folder.
    if (icon) data.imageDataUrl = svgToDataUrl(icon.svg);
    if (icon?.own) data.ownArtwork = true;
    return node;
  }

  return deps.makeDeviceNode(raw as DeviceType, x, y);
}
