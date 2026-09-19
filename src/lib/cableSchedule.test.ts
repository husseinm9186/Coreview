import { describe, expect, it } from 'vitest';

import type { ProjectDocument, TopoEdge, TopoNode } from '../state/store';
import { cableSchedule, cableScheduleCsv, cableScheduleMarkdown } from './cableSchedule';

const dev = (id: string, label: string, deviceType = 'switch') =>
  ({ id, type: 'device', position: { x: 0, y: 0 }, data: { label, deviceType, tags: [], addresses: [], locked: false, maintenance: false, showDetails: false } }) as unknown as TopoNode;
const link = (id: string, source: string, target: string, over: Record<string, unknown> = {}) =>
  ({ id, source, target, data: { sourcePortLabel: '', targetPortLabel: '', label: '', ...over } }) as unknown as TopoEdge;
const doc = (pages: { name: string; nodes: TopoNode[]; edges: TopoEdge[] }[]) =>
  ({ pages: pages.map((p, i) => ({ id: `p${i}`, canvas: {}, ...p })), activePageId: 'p0', probes: [] }) as unknown as ProjectDocument;

describe('cable schedule (LT-198)', () => {
  const d = doc([
    {
      name: 'Floor 1',
      nodes: [dev('sw', 'SW-1'), dev('ap', 'AP-1', 'access-point'), dev('srv', 'SRV-1'), dev('note', 'Callout', 'callout'),
        { id: 'n', type: 'note', position: { x: 0, y: 0 }, data: { body: '' } } as unknown as TopoNode],
      edges: [
        link('e1', 'sw', 'srv', { sourcePortLabel: 'Gi1/0/10', targetPortLabel: 'eth0', cableType: 'copper', cableLength: ' 3 m ', label: 'C-0010' }),
        link('e2', 'sw', 'ap', { sourcePortLabel: 'Gi1/0/2', cableType: 'fiber-sm', label: 'Uplink' }),
        link('e3', 'note', 'sw', { kind: 'leader' }),
        link('e4', 'n', 'sw'),
      ],
    },
    { name: 'Floor 0', nodes: [dev('fw', 'FW'), dev('sw0', 'SW-0')], edges: [link('e5', 'fw', 'sw0')] },
  ]);

  it('lists every cable between devices with its ports, type, length and label', () => {
    expect(cableSchedule(d)).toEqual([
      { page: 'Floor 0', deviceA: 'FW', portA: '', deviceB: 'SW-0', portB: '', cable: '', length: '', label: '' },
      { page: 'Floor 1', deviceA: 'SW-1', portA: 'Gi1/0/2', deviceB: 'AP-1', portB: '', cable: 'Fibre, single-mode', length: '', label: 'Uplink' },
      { page: 'Floor 1', deviceA: 'SW-1', portA: 'Gi1/0/10', deviceB: 'SRV-1', portB: 'eth0', cable: 'Copper', length: '3 m', label: 'C-0010' },
    ]);
  });

  it('writes it as CSV, guarded against spreadsheet formulas', () => {
    const csv = cableScheduleCsv([{ page: 'P', deviceA: '=cmd', portA: '1', deviceB: 'B, C', portB: '2', cable: 'Copper', length: '1 m', label: '' }]);
    expect(csv).toBe('Page,Device A,Port A,Device B,Port B,Cable,Length,Label\r\nP,\'=cmd,1,"B, C",2,Copper,1 m,');
  });

  it('writes it as a Markdown table for the report', () => {
    const md = cableScheduleMarkdown(cableSchedule(d));
    expect(md.split('\n')).toHaveLength(5);
    expect(md).toContain('| Floor 1 | SW-1 | Gi1/0/10 | SRV-1 | eth0 | Copper | 3 m | C-0010 |');
    expect(cableScheduleMarkdown([])).toContain('No links between devices');
    expect(cableScheduleMarkdown([{ page: 'P', deviceA: 'a|b', portA: '', deviceB: 'c', portB: '', cable: '', length: '', label: '' }])).toContain('a\\|b');
  });
});
