import { describe, expect, it } from 'vitest';

import { discoverySuggestions } from './discoverySuggestions';
import type { ProjectDocument, TopoNode } from '../state/store';

/** Documentation addresses only — nothing from anyone's network (D-027). */
const device = (id: string, label: string, deviceType: string, address: string, extra = {}): TopoNode =>
  ({
    id,
    type: 'device',
    position: { x: 0, y: 0 },
    data: {
      label,
      deviceType,
      tags: [],
      addresses: address ? [{ id: `${id}-a`, label: 'Management', address, isPrimary: true }] : [],
      ...extra,
    },
  }) as unknown as TopoNode;

const doc = (nodes: TopoNode[], ipam?: ProjectDocument['ipam']): ProjectDocument =>
  ({
    pages: [{ id: 'p', name: 'P', nodes, edges: [], canvas: {} }],
    activePageId: 'p',
    probes: [],
    ...(ipam ? { ipam } : {}),
  }) as unknown as ProjectDocument;

describe('what to put in the discovery form (LT-296)', () => {
  it('starts from the devices a crawl can actually walk from', () => {
    const s = discoverySuggestions(
      doc([
        device('a', 'Printer', 'printer', '192.0.2.50'),
        device('b', 'Core', 'core-switch', '192.0.2.10'),
        device('c', 'Edge', 'firewall', '192.0.2.1'),
      ]),
    );
    // A printer is never a seed; a core switch comes before a firewall.
    expect(s.seeds).toEqual(['192.0.2.10', '192.0.2.1']);
  });

  it('prefers a device a crawl has already reached', () => {
    const s = discoverySuggestions(
      doc([
        device('a', 'Access 2', 'access-switch', '192.0.2.12'),
        device('b', 'Access 1', 'access-switch', '192.0.2.11', { discoveredVia: 'CDP' }),
      ]),
    );
    expect(s.seeds).toEqual(['192.0.2.11', '192.0.2.12']);
  });

  it('offers the register\'s subnets, in address order', () => {
    const s = discoverySuggestions(
      doc([device('a', 'Core', 'core-switch', '198.51.100.10')], {
        subnets: [{ id: 's1', cidr: '192.0.2.0/24', name: 'Site' }],
      }),
    );
    expect(s.subnets).toEqual(['192.0.2.0/24', '198.51.100.0/24']);
  });

  it('counts the devices it could not use, rather than going quiet', () => {
    const s = discoverySuggestions(doc([device('a', 'Core', 'core-switch', '')]));
    expect(s.seeds).toEqual([]);
    expect(s.skipped).toBe(1);
  });

  it('never repeats an address, and stops at the limit', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      device(`n${i}`, `Switch ${i}`, 'access-switch', '192.0.2.20'),
    );
    expect(discoverySuggestions(doc(many)).seeds).toEqual(['192.0.2.20']);

    const distinct = Array.from({ length: 8 }, (_, i) =>
      device(`d${i}`, `Switch ${i}`, 'access-switch', `192.0.2.${20 + i}`),
    );
    expect(discoverySuggestions(doc(distinct), 3).seeds).toHaveLength(3);
  });

  it('has nothing to say about an empty project, and does not mind', () => {
    expect(discoverySuggestions(doc([]))).toEqual({ seeds: [], subnets: [], skipped: 0 });
  });
});
