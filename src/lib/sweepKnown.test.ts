import { describe, expect, it } from 'vitest';

import { gatewayGuess, knownOnDiagram, sweepPatch, type SweptHost } from './sweepKnown';

describe('a first guess at the gateway (LT-124)', () => {
  it('is the first usable address of the subnet', () => {
    expect(gatewayGuess('192.0.2.0/24')).toBe('192.0.2.1');
    expect(gatewayGuess('198.51.100.128/25')).toBe('198.51.100.129');
    expect(gatewayGuess('10.20.0.0/16')).toBe('10.20.0.1');
    // A host address inside the subnet, with stray spaces, still finds it.
    expect(gatewayGuess(' 192.0.2.77/24 ')).toBe('192.0.2.1');
  });

  it('is empty for anything that is not an IPv4 subnet with room for a router', () => {
    expect(gatewayGuess('')).toBe('');
    expect(gatewayGuess('192.0.2.0')).toBe('');
    expect(gatewayGuess('192.0.2.300/24')).toBe('');
    expect(gatewayGuess('192.0.2.1/32')).toBe('');
  });
});

// Invented names, RFC 5737 addresses, and a made-up MAC (D-027).
const host = (over: Partial<SweptHost> = {}): SweptHost => ({
  ip: '192.0.2.7', hostname: null, mac: null, vendor: null, ports: [], ...over,
});

const node = (id: string, data: Record<string, unknown>) => ({
  id,
  type: 'device',
  position: { x: 0, y: 0 },
  data: { tags: [], addresses: [], locked: false, maintenance: false, showDetails: true, ...data },
});

const nodes = [
  node('sw', {
    label: 'LAB-CORE-SW', hostname: 'LAB-CORE-SW', model: 'C2960CX', serial: 'FOC0000TEST',
    discoveredVia: 'SSH login',
    addresses: [{ id: 'a', label: 'Mgmt', address: '192.0.2.7', isPrimary: true }],
  }),
  node('desk', {
    label: 'DESK-PC-1', mac: '02:00:5e:00:00:01', switchPort: 'LAB-CORE-SW Gi1/0/11',
    discoveredVia: 'Seen on a switch port',
  }),
];

describe('what the diagram knows about a swept host (LT-125)', () => {
  it('finds a crawled device by address and returns what the crawl learned', () => {
    // The cast mirrors how the panel passes page nodes; the shape is a node.
    const k = knownOnDiagram(nodes as never, host());
    expect(k).toMatchObject({
      nodeId: 'sw', label: 'LAB-CORE-SW', model: 'C2960CX', serial: 'FOC0000TEST', discoveredVia: 'SSH login',
    });
  });

  it('finds one by MAC under a different label, with its switch port', () => {
    const k = knownOnDiagram(nodes as never, host({ ip: '192.0.2.129', mac: '02-00-5E-00-00-01', hostname: 'LabDesktop01' }));
    expect(k?.nodeId).toBe('desk');
    expect(k?.switchPort).toBe('LAB-CORE-SW Gi1/0/11');
  });

  it('says nothing about a host that is not drawn', () => {
    expect(knownOnDiagram(nodes as never, host({ ip: '192.0.2.99' }))).toBeNull();
    expect(knownOnDiagram([], host())).toBeNull();
  });
});

describe('what a sweep may write onto a drawn device (LT-155)', () => {
  const ports = [{ port: 22, service: 'SSH' }, { port: 443, service: 'HTTPS' }];

  it('keeps how the crawl found the device, and the name it gave', () => {
    const patch = sweepPatch(
      { label: 'LAB-CORE-SW', hostname: 'LAB-CORE-SW', discoveredVia: 'SSH login' },
      host({ hostname: 'lab-core-sw.local', ports }),
    );
    expect(patch.discoveredVia).toBeUndefined();
    expect(patch.hostname).toBeUndefined();
    expect(patch.openPorts).toBe('22/SSH, 443/HTTPS');
  });

  it('fills only what the device lacks', () => {
    const patch = sweepPatch(
      { mac: '02:00:5e:00:00:01', discoveredVia: 'Seen on a switch port' },
      host({ mac: '02:00:5e:00:00:01', vendor: 'Example Maker', hostname: 'LabDesktop01' }),
    );
    expect(patch).toEqual({ vendor: 'Example Maker', hostname: 'LabDesktop01' });
  });

  it('claims a device nothing else has claimed', () => {
    expect(sweepPatch({}, host()).discoveredVia).toBe('Ping sweep');
    expect(sweepPatch({ discoveredVia: '   ' }, host()).discoveredVia).toBe('Ping sweep');
  });

  it('fills a missing serial from a certificate but never replaces one (LT-124)', () => {
    expect(sweepPatch({}, host({ serial: 'FOC0000TEST' })).serial).toBe('FOC0000TEST');
    expect(sweepPatch({ serial: 'FOC1111TEST' }, host({ serial: 'FOC0000TEST' }))).not.toHaveProperty('serial');
  });

  it('leaves open ports alone when the sweep found none', () => {
    expect(sweepPatch({ openPorts: '22/SSH' }, host())).not.toHaveProperty('openPorts');
  });
});
