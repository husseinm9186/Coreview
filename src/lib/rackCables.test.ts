import { describe, expect, it } from 'vitest';

import type { Rackable } from './rack';
import { CABLE_COLOURS, cableColour, isUnracked, linksOutOf, patchCablesFor, pduLoad, portNumber, powerCordsFor, spreadStubs } from './rackCables';

const sw: Rackable = { id: 'sw', label: 'SW-1', rack: 'R1', rackU: 40, rackUnits: 1, kind: 'device', portCount: 48, powerW: 120, powerFeeds: [{ pduId: 'pdu', outlet: 3 }, { pduId: 'pdu', outlet: 4 }] };
const pp: Rackable = { id: 'pp', label: 'Patch 1', rack: 'R1', rackU: 39, rackUnits: 1, kind: 'furniture', furniture: 'patch-panel' };
const srv: Rackable = { id: 'srv', label: 'SRV-1', rack: 'R2', rackU: 10, rackUnits: 2, kind: 'device', powerW: 400, powerFeeds: [{ pduId: 'pdu', outlet: 1 }, { pduId: 'pdu2', outlet: 1 }] };
const loose: Rackable = { id: 'ap', label: 'AP-1', kind: 'device', rackUnits: 1 };
const pdu: Rackable = { id: 'pdu', label: 'PDU A', rack: 'R1', rackUnits: 0, kind: 'furniture', furniture: 'pdu-vertical', outlets: 8 };
const pdu2: Rackable = { id: 'pdu2', label: 'PDU B', rack: 'R2', rackUnits: 0, kind: 'furniture', furniture: 'pdu-vertical', outlets: 8 };
const items = [sw, pp, srv, loose, pdu, pdu2];

describe('port numbers', () => {
  it('reads the last run of digits in a port label', () => {
    expect(portNumber('Gi1/0/5')).toBe(5);
    expect(portNumber('eth12')).toBe(12);
    expect(portNumber('Port 3')).toBe(3);
    expect(portNumber('24')).toBe(24);
    expect(portNumber('Te1/1/1')).toBe(1);
    expect(portNumber('mgmt')).toBeNull();
    expect(portNumber('')).toBeNull();
    expect(portNumber(undefined)).toBeNull();
    expect(portNumber('port 0')).toBeNull();
  });
});

describe('patch cables', () => {
  const links = [
    { id: 'e1', source: 'sw', target: 'pp', sourcePortLabel: 'Gi1/0/5', targetPortLabel: '17', cableType: 'copper' },
    { id: 'e2', source: 'sw', target: 'srv', sourcePortLabel: 'Te1/1/1', targetPortLabel: 'eth0', cableType: 'fiber-mm' },
    { id: 'e3', source: 'ap', target: 'loose2', sourcePortLabel: '', targetPortLabel: '' },
    { id: 'e4', source: 'loose2', target: 'sw', sourcePortLabel: 'a', targetPortLabel: 'Gi1/0/48' },
  ];

  it('draws a link between two boxes in the rack from port to port', () => {
    const cables = patchCablesFor('R1', items, links, (id) => (id === 'e1' ? 'healthy' : 'unknown'));
    const e1 = cables.find((c) => c.edgeId === 'e1')!;
    expect(e1.from).toEqual({ itemId: 'sw', label: 'SW-1', port: 5, portLabel: 'Gi1/0/5' });
    expect(e1.to).toEqual({ itemId: 'pp', label: 'Patch 1', port: 17, portLabel: '17' });
    expect(e1.cableType).toBe('copper');
    expect(e1.status).toBe('healthy');
  });

  it('ends a link to another rack in a stub that says where', () => {
    const cables = patchCablesFor('R1', items, links);
    const e2 = cables.find((c) => c.edgeId === 'e2')!;
    expect(e2.from.itemId).toBe('sw');
    expect(e2.to).toEqual({ elsewhere: 'R2 U10', rack: 'R2', label: 'SRV-1', portLabel: 'eth0' });
    const e4 = cables.find((c) => c.edgeId === 'e4')!;
    expect(e4.from).toEqual({ itemId: 'sw', label: 'SW-1', port: 48, portLabel: 'Gi1/0/48' });
    expect(e4.to).toEqual({ elsewhere: 'not racked', label: 'loose2', portLabel: 'a' });
  });

  it('ignores links with no end in the rack', () => {
    expect(patchCablesFor('R1', items, links).map((c) => c.edgeId)).toEqual(['e1', 'e2', 'e4']);
    expect(patchCablesFor('R2', items, links).map((c) => c.edgeId)).toEqual(['e2']);
  });
});

describe('power feeds', () => {
  it('runs a cord from each supply to its outlet and says what is wrong', () => {
    const cords = powerCordsFor('R1', items);
    expect(cords).toHaveLength(2);
    expect(cords[0]).toMatchObject({ itemId: 'sw', supply: 0, pduId: 'pdu', pduLabel: 'PDU A', outlet: 3, problem: undefined });
    const far = powerCordsFor('R2', items);
    expect(far.find((c) => c.pduId === 'pdu')?.problem).toMatch(/PDU A is in R1/);
    expect(far.find((c) => c.pduId === 'pdu2')?.problem).toBeUndefined();
    expect(powerCordsFor('R1', [{ ...sw, powerFeeds: [{ pduId: 'pdu', outlet: 9 }] }, pdu])[0]!.problem).toMatch(/8 outlets/);
    expect(powerCordsFor('R1', [{ ...sw, powerFeeds: [{ pduId: 'gone', outlet: 1 }] }])[0]!.problem).toMatch(/no longer/);
  });

  it('sums a PDU: outlets taken, watts shared across the supplies, and a box with both supplies on it', () => {
    const load = pduLoad(pdu, items);
    expect(load).toMatchObject({ outlets: 8, used: 3, free: 5, watts: 120 + 200, twice: ['SW-1'] });
    const load2 = pduLoad(pdu2, items);
    expect(load2).toMatchObject({ used: 1, watts: 200, twice: [] });
  });
});

describe('a cable\'s colour', () => {
  it('is the link\'s own when it has one, else the cable type\'s, else grey', () => {
    const items: Rackable[] = [
      { id: 'a', label: 'A', rack: 'R1', rackU: 2, rackUnits: 1, kind: 'device', deviceType: 'access-switch' },
      { id: 'b', label: 'B', rack: 'R1', rackU: 1, rackUnits: 1, kind: 'device', deviceType: 'server' },
    ];
    const [own] = patchCablesFor('R1', items, [{ id: 'e', source: 'a', target: 'b', cableType: 'copper', color: '#e4564a', colorMode: 'fixed' }]);
    expect(cableColour(own!)).toBe('#e4564a');
    const [typed] = patchCablesFor('R1', items, [{ id: 'e', source: 'a', target: 'b', cableType: 'copper', color: '#e4564a' }]);
    expect(typed!.colour).toBeUndefined();
    expect(cableColour(typed!)).toBe(CABLE_COLOURS.copper);
    expect(cableColour({ cableType: null })).toBe('#98a3b3');
  });
});

describe('links that leave the rack', () => {
  const items: Rackable[] = [
    { id: 'sw', label: 'SW', rack: 'R1', rackU: 40, rackUnits: 1, kind: 'device', deviceType: 'access-switch', portCount: 48 },
    { id: 'srv', label: 'SRV', rack: 'R2', rackU: 20, rackUnits: 2, kind: 'device', deviceType: 'server' },
    { id: 'ap1', label: 'AP-1', kind: 'device', deviceType: 'access-point' },
    { id: 'ap2', label: 'AP-2', rack: 'R9', kind: 'device', deviceType: 'access-point' },
  ];
  const links = [
    { id: 'a', source: 'sw', target: 'ap1', sourcePortLabel: 'Gi1/0/1', targetPortLabel: 'eth0' },
    { id: 'b', source: 'sw', target: 'ap2', sourcePortLabel: 'Gi1/0/2' },
    { id: 'c', source: 'sw', target: 'srv', sourcePortLabel: 'Gi1/0/3', targetPortLabel: 'eth0' },
  ];

  it('tells a link to another rack from one to no rack at all', () => {
    const cables = patchCablesFor('R1', items, links);
    const to = (id: string) => cables.find((c) => c.edgeId === id)!.to;
    expect(isUnracked(to('a'))).toBe(true);
    // Named a rack but not placed in it: still nowhere on an elevation.
    expect(isUnracked(to('b'))).toBe(true);
    expect(isUnracked(to('c'))).toBe(false);
    expect(to('c')).toMatchObject({ elsewhere: 'R2 U20', rack: 'R2' });
  });

  it('counts and lists the links out per box', () => {
    const out = linksOutOf(patchCablesFor('R1', items, links));
    expect(out.get('sw')).toEqual({ label: 'SW', lines: ['Gi1/0/1 → AP-1 eth0', 'Gi1/0/2 → AP-2'] });
  });

  it('spreads stub labels apart, in order, only as far as needed', () => {
    expect(spreadStubs([10, 12, 11, 40], 9)).toEqual([10, 28, 19, 40]);
    expect(spreadStubs([5, 50], 9)).toEqual([5, 50]);
    expect(spreadStubs([], 9)).toEqual([]);
  });
});
