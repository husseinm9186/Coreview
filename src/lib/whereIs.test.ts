import { describe, expect, it } from 'vitest';

import type { AttachedDevice, CrawledDevice } from './ipc';
import { whereIs } from './whereIs';

const attached = (a: Partial<AttachedDevice>): AttachedDevice => ({
  mac: '0000.5e00.5301',
  port: 'Gi0/1',
  address: null,
  vendor: null,
  hostname: null,
  class: null,
  vlan: null,
  portPopulation: 1,
  ...a,
});

const device = (d: Partial<CrawledDevice>): CrawledDevice =>
  ({
    hostname: 'LAB-ACCESS-SW1',
    address: '192.0.2.11',
    addresses: [{ ip: '192.0.2.11', interface: 'Vlan1', isManagement: false }],
    probeTarget: '192.0.2.11',
    class: 'switch',
    platform: 'WS-C2960CX-8PC-L',
    serial: 'FOC0000TEST',
    version: null,
    neighbors: [],
    hops: 0,
    reachedBy: 'ssh',
    attached: [],
    ...d,
  }) as CrawledDevice;

/** A printer on one port, a laptop sharing an uplink, and a phone on wi-fi. */
const estate: CrawledDevice[] = [
  device({
    attached: [
      attached({ mac: '00:0c:e6:00:00:a0', port: 'Gi0/7', vlan: '14', hostname: 'PRINTER-2F', vendor: 'Hewlett Packard' }),
      attached({ mac: '74:56:3c:00:00:01', port: 'Gi0/1', vlan: '1', portPopulation: 9, address: '192.0.2.50' }),
    ],
  }),
  device({
    hostname: 'LAB-FW1',
    address: '192.0.2.1',
    addresses: [{ ip: '192.0.2.1', interface: 'wan1', isManagement: false }],
    class: 'firewall',
    platform: 'FortiGate-60F',
    serial: 'FGT0000TEST',
    attached: [
      // A FortiGate reports a wireless client with the SSID where a switch
      // reports a port.
      attached({ mac: 'aa:bb:cc:00:00:01', port: 'CORP-WIFI', hostname: 'handset-7', vendor: 'Apple', address: '192.0.2.90' }),
    ],
  }),
];

describe('where is this (LT-338)', () => {
  it('finds a thing by its MAC however either side punctuates it', () => {
    for (const q of ['00:0c:e6:00:00:a0', '000c.e600.00a0', '000CE60000A0', '00-0c-e6-00-00-a0']) {
      const hits = whereIs(q, estate);
      expect(hits.length, q).toBe(1);
      expect(hits[0]!.seenBy).toBe('LAB-ACCESS-SW1');
      expect(hits[0]!.port).toBe('Gi0/7');
      expect(hits[0]!.vlan).toBe('14');
      expect(hits[0]!.matchedOn).toBe('mac');
    }
  });

  it('says when a port leads to another switch rather than to one thing', () => {
    const one = whereIs('00:0c:e6:00:00:a0', estate)[0]!;
    expect(one.sharedPort).toBe(false);
    const shared = whereIs('192.0.2.50', estate)[0]!;
    expect(shared.sharedPort).toBe(true);
    expect(shared.portPopulation).toBe(9);
  });

  it('answers a wireless client with the SSID it is on', () => {
    const hits = whereIs('handset-7', estate);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.port).toBe('CORP-WIFI');
    expect(hits[0]!.seenBy).toBe('LAB-FW1');
  });

  it('finds everything a maker made', () => {
    const hits = whereIs('hewlett', estate);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.hostname).toBe('PRINTER-2F');
    expect(hits[0]!.matchedOn).toBe('vendor');
  });

  it('finds a crawled device in its own right, not only things on its ports', () => {
    const hits = whereIs('LAB-FW1', estate);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.isDevice).toBe(true);
    expect(hits[0]!.deviceClass).toBe('firewall');
  });

  it('matches an address by leading octets but does not match a bare number everywhere', () => {
    expect(whereIs('192.0.2', estate).length).toBeGreaterThan(1);
    // `14` is a VLAN on one row; it must not also match every address holding 14.
    const vlanHits = whereIs('14', estate);
    expect(vlanHits.every((h) => h.matchedOn !== 'address')).toBe(true);
  });

  it('puts the surest match first', () => {
    // A maker's name that happens to contain the hex of somebody else's MAC
    // is a real hazard: `aabbcc` is both an OUI and a plausible substring.
    // The row that actually holds that MAC must come first.
    const withDecoy: CrawledDevice[] = [
      ...estate,
      device({
        hostname: 'LAB-ACCESS-SW2',
        address: '192.0.2.12',
        addresses: [{ ip: '192.0.2.12', interface: 'Vlan1', isManagement: false }],
        attached: [attached({ mac: '11:22:33:00:00:09', port: 'Gi0/2', vendor: 'aabbcc Systems' })],
      }),
    ];
    const hits = whereIs('aabbcc000001', withDecoy);
    expect(hits[0]!.matchedOn).toBe('mac');
    expect(hits[0]!.hostname).toBe('handset-7');
  });

  it('an empty query asks nothing rather than returning the estate', () => {
    expect(whereIs('', estate)).toEqual([]);
    expect(whereIs('   ', estate)).toEqual([]);
  });

  it('finds nothing when nothing matches, rather than guessing', () => {
    expect(whereIs('nothing-like-this', estate)).toEqual([]);
  });
});
