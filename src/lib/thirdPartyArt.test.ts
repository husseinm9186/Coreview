import { describe, expect, it } from 'vitest';

import type { TopoNode } from '../state/store';
import type { DeviceNodeData } from '../types/domain';
import { artworkSummary, usesImportedArtwork, vendorSafeDocument, vendorSafeNodes } from './thirdPartyArt';

const IMG = 'data:image/svg+xml;base64,PHN2Zy8+';

const device = (id: string, over: Partial<DeviceNodeData> = {}): TopoNode =>
  ({
    id,
    type: 'device',
    position: { x: 0, y: 0 },
    data: {
      label: id, deviceType: 'router', tags: [], addresses: [], locked: false, maintenance: false,
      showDetails: true, ...over,
    },
  }) as TopoNode;

const note = { id: 'n', type: 'note', position: { x: 0, y: 0 }, data: { body: 'x' } } as unknown as TopoNode;

describe('third-party artwork in a project (LT-170)', () => {
  it('is a picture that is not Coreview’s own', () => {
    expect(usesImportedArtwork({})).toBe(false);
    expect(usesImportedArtwork({ imageDataUrl: IMG })).toBe(true);
    expect(usesImportedArtwork({ imageDataUrl: IMG, ownArtwork: true })).toBe(false);
  });

  it('is counted, with each distinct licence and the ones that gave none', () => {
    const s = artworkSummary([
      device('glyph'),
      device('a', { imageDataUrl: IMG, stencilLicence: 'Lab kit' }),
      device('b', { imageDataUrl: IMG, stencilLicence: 'Lab kit' }),
      device('c', { imageDataUrl: IMG, stencilLicence: 'Another set' }),
      device('d', { imageDataUrl: IMG }),
      device('own', { imageDataUrl: IMG, ownArtwork: true }),
      note,
    ]);
    expect(s).toEqual({ devices: 4, licences: ['Another set', 'Lab kit'], undescribed: 1 });
  });

  it('is nothing on a project drawn only with built-in shapes', () => {
    expect(artworkSummary([device('a'), device('b'), note]).devices).toBe(0);
  });
});

describe('the vendor-safe export', () => {
  it('draws imported devices as their class and leaves everything else alone', () => {
    const nodes = [
      device('lb', { deviceType: 'load-balancer', imageDataUrl: IMG, iconRef: 'x', stencilLicence: 'Lab kit', vendor: 'Example' }),
      device('pic', { deviceType: 'custom-image', imageDataUrl: IMG }),
      device('own', { imageDataUrl: IMG, ownArtwork: true }),
      device('plain'),
      note,
    ];
    const safe = vendorSafeNodes(nodes);
    const lb = safe[0]!.data as DeviceNodeData;
    expect(lb.deviceType).toBe('load-balancer');
    expect(lb.imageDataUrl).toBeUndefined();
    expect(lb.iconRef).toBeUndefined();
    expect(lb.stencilLicence).toBeUndefined();
    // What the device is stays: vendor and model are data, not artwork.
    expect(lb.vendor).toBe('Example');
    expect((safe[1]!.data as DeviceNodeData).deviceType).toBe('generic');
    expect(safe[2]).toBe(nodes[2]);
    expect(safe[3]).toBe(nodes[3]);
    expect(safe[4]).toBe(note);
    expect(artworkSummary(safe).devices).toBe(0);
    // The project itself is untouched.
    expect((nodes[0]!.data as DeviceNodeData).imageDataUrl).toBe(IMG);
  });

  it('cleans every page of a saved document and drops captured shapes that are not ours', () => {
    const doc = {
      pages: [
        { id: 'p1', nodes: [device('a', { imageDataUrl: IMG })], edges: [] },
        { id: 'p2', nodes: [device('b', { imageDataUrl: IMG, ownArtwork: true }), note], edges: [] },
      ],
      customShapes: [
        { id: 'mine', name: 'Mine', category: 'Custom', svg: '<svg/>', own: true },
        { id: 'theirs', name: 'Theirs', category: 'Custom', svg: '<svg/>' },
      ],
      probes: [],
    };
    const safe = vendorSafeDocument(doc);
    const allNodes = safe.pages.flatMap((p) => p.nodes);
    expect(artworkSummary(allNodes).devices).toBe(0);
    expect((allNodes[1]!.data as DeviceNodeData).imageDataUrl).toBe(IMG);
    expect(safe.customShapes.map((c) => c.id)).toEqual(['mine']);
    expect(JSON.stringify(safe)).not.toContain('"theirs"');
    // The original document is untouched.
    expect(doc.customShapes).toHaveLength(2);
  });

  it('cleans a single-page document from before pages existed', () => {
    const safe = vendorSafeDocument({ nodes: [device('a', { imageDataUrl: IMG })], edges: [] });
    expect(artworkSummary(safe.nodes).devices).toBe(0);
  });
});
