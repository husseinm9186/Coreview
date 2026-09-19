import { describe, expect, it } from 'vitest';

import type { TopoEdge, TopoNode } from '../state/store';
import { edgeAriaLabel, nodeAriaLabel } from './ariaLabels';

const type = (t: string) => ({ 'core-switch': 'Core switch' })[t] ?? t;

describe('screen-reader labels (LT-241)', () => {
  it('say what a device is, its name, role, address and state', () => {
    const n = { id: 'a', type: 'device', data: { label: 'CORE-SW1', deviceType: 'core-switch', role: 'Core', locked: true, addresses: [{ address: '198.51.100.1', isPrimary: false }, { address: '192.0.2.10', isPrimary: true }] } } as unknown as TopoNode;
    expect(nodeAriaLabel(n, type)).toBe('Core switch CORE-SW1, Core, 192.0.2.10, locked');
    const note = { id: 'n', type: 'note', data: { title: 'Change', body: '\nSaturday 22:00\nmore' } } as unknown as TopoNode;
    expect(nodeAriaLabel(note, type)).toBe('Note: Change: Saturday 22:00');
  });

  it('say what a link joins, on which ports', () => {
    const names = (id: string) => ({ a: 'CORE-SW1', b: 'ACC-SW1' })[id] ?? id;
    const e = { id: 'e', source: 'a', target: 'b', data: { sourcePortLabel: 'Gi1/0/2', targetPortLabel: 'Gi0/1', label: 'Uplink' } } as unknown as TopoEdge;
    expect(edgeAriaLabel(e, names)).toBe('Link from CORE-SW1 Gi1/0/2 to ACC-SW1 Gi0/1, Uplink');
    expect(edgeAriaLabel({ ...e, data: { layer3: true } } as unknown as TopoEdge, names)).toBe('Layer 3 link from CORE-SW1 to ACC-SW1');
  });
});
