import { describe, expect, it } from 'vitest';

import { behindInferred, bestSighting, inferredSwitches, matchesFilter, selectAttached, sightingsByMac, vendorCounts } from './attached';
import type { AttachedDevice, CrawledDevice } from './ipc';

const thing = (over: Partial<AttachedDevice> = {}): AttachedDevice => ({
  mac: '7456' + Math.random().toString(16).slice(2, 10),
  port: 'Gi0/7',
  address: '192.168.77.129',
  vendor: 'Ubiquiti',
  hostname: null,
  class: null,
  portPopulation: 1,
  ...over,
});

const host = (name: string, attached: AttachedDevice[]): CrawledDevice =>
  ({
    hostname: name,
    address: '10.0.0.1',
    addresses: [],
    serial: null,
    probeTarget: '10.0.0.1',
    class: 'switch',
    platform: null,
    version: null,
    neighbors: [],
    hops: 0,
    reachedBy: 'ssh',
    attached,
  }) as CrawledDevice;

describe('matchesFilter', () => {
  it('matches everything when nothing is asked for', () => {
    expect(matchesFilter(thing(), {})).toBe(true);
  });

  it('finds a maker by part of its name', () => {
    // "Show me the Axis cameras" is a question about a network.
    expect(matchesFilter(thing({ vendor: 'Axis Communications' }), { vendor: 'axis' })).toBe(true);
    expect(matchesFilter(thing({ vendor: 'Ubiquiti' }), { vendor: 'axis' })).toBe(false);
    expect(matchesFilter(thing({ vendor: null }), { vendor: 'axis' })).toBe(false);
  });

  it('confines to a subnet, written either way', () => {
    const d = thing({ address: '192.168.77.129' });
    expect(matchesFilter(d, { subnet: '192.168.77.0/24' })).toBe(true);
    expect(matchesFilter(d, { subnet: '192.168.77' })).toBe(true);
    expect(matchesFilter(d, { subnet: '192.168.77.0' })).toBe(true);
    // A prefix length is not an octet, which is what broke this first.
    expect(matchesFilter(d, { subnet: '192.168.77.0/24' })).toBe(true);
    expect(matchesFilter(d, { subnet: 'nonsense' })).toBe(false);
    expect(matchesFilter(d, { subnet: '10.2.80.0/24' })).toBe(false);
  });

  it('excludes an unaddressed device from a subnet question', () => {
    // Something with no address is not in the subnet, and cannot be assumed
    // into it.
    expect(matchesFilter(thing({ address: null }), { subnet: '192.168.77.0/24' })).toBe(false);
  });

  it('matches a port by part of its name', () => {
    expect(matchesFilter(thing({ port: 'Gi1/0/12' }), { port: 'Gi1/0/1' })).toBe(true);
    expect(matchesFilter(thing({ port: 'Gi0/7' }), { port: 'Gi1/0' })).toBe(false);
  });

  it('skips what is behind an uplink', () => {
    // A port carrying twenty addresses leads to another switch, and what is
    // behind it belongs to that switch's diagram.
    expect(matchesFilter(thing({ portPopulation: 20 }), { maxPerPort: 4 })).toBe(false);
    expect(matchesFilter(thing({ portPopulation: 2 }), { maxPerPort: 4 })).toBe(true);
  });

  it('can insist on an address', () => {
    // Something with no address can be drawn but never checked.
    expect(matchesFilter(thing({ address: null }), { addressedOnly: true })).toBe(false);
    expect(matchesFilter(thing({ address: '10.0.0.5' }), { addressedOnly: true })).toBe(true);
  });
});

describe('selectAttached', () => {
  it('draws a device once even when two switches saw it', () => {
    // A MAC is learned through uplinks too, and the same printer three times
    // is not a diagram of anything.
    const shared = thing({ mac: 'aabbccddeeff' });
    const out = selectAttached([host('SW1', [shared]), host('SW2', [{ ...shared }])], {});
    expect(out).toHaveLength(1);
    // The first sighting wins, which is the switch nearest the seed.
    expect(out[0]!.host).toBe('SW1');
  });

  it('applies the filter across every switch', () => {
    const out = selectAttached(
      [
        host('SW1', [thing({ mac: 'a1', vendor: 'Axis Communications' })]),
        host('SW2', [thing({ mac: 'b2', vendor: 'Ubiquiti' })]),
      ],
      { vendor: 'axis' },
    );
    expect(out.map((o) => o.device.mac)).toEqual(['a1']);
  });

  it('returns nothing when nothing was attached', () => {
    expect(selectAttached([host('SW1', [])], {})).toEqual([]);
  });
});

describe('vendorCounts', () => {
  it('offers the commonest makers first', () => {
    // What someone wants is usually the thing there is a lot of.
    const counts = vendorCounts([
      host('SW1', [
        thing({ mac: 'a', vendor: 'Ubiquiti' }),
        thing({ mac: 'b', vendor: 'Ubiquiti' }),
        thing({ mac: 'c', vendor: 'Axis Communications' }),
        thing({ mac: 'd', vendor: null }),
      ]),
    ]);
    expect(counts[0]).toEqual({ vendor: 'Ubiquiti', count: 2 });
    expect(counts.map((c) => c.vendor)).toContain('Unknown maker');
  });

  it('counts a device once however many switches saw it', () => {
    const shared = thing({ mac: 'same', vendor: 'Ubiquiti' });
    const counts = vendorCounts([host('SW1', [shared]), host('SW2', [{ ...shared }])]);
    expect(counts).toEqual([{ vendor: 'Ubiquiti', count: 1 }]);
  });
});


describe('one MAC, two switches: the quietest port wins (LT-339)', () => {
  const MAC = '74563c000001';
  const on = (port: string, portPopulation: number, over: Partial<AttachedDevice> = {}) =>
    thing({ mac: MAC, port, portPopulation, ...over });

  it('believes the switch that sees it alone over the one that sees it in a crowd', () => {
    // CORE learns it across an uplink among thirty others; ACCESS has it in
    // front of it. The old rule took whichever was crawled first.
    const devices = [host('CORE', [on('Gi0/24', 30)]), host('ACCESS', [on('Gi0/7', 1)])];
    const chosen = selectAttached(devices, {});
    expect(chosen).toHaveLength(1);
    expect(chosen[0]!.host).toBe('ACCESS');
    expect(chosen[0]!.device.port).toBe('Gi0/7');
  });

  it('and gives the same answer whichever order they were crawled in', () => {
    // The whole point: the answer is about the network, not about where the
    // crawl happened to start.
    const core = host('CORE', [on('Gi0/24', 30)]);
    const access = host('ACCESS', [on('Gi0/7', 1)]);
    expect(selectAttached([core, access], {})[0]!.host).toBe('ACCESS');
    expect(selectAttached([access, core], {})[0]!.host).toBe('ACCESS');
  });

  it('prefers the sighting that resolved an address when the ports are equally quiet', () => {
    const devices = [
      host('A', [on('Gi0/1', 1, { address: null })]),
      host('B', [on('Gi0/2', 1, { address: '192.168.77.50' })]),
    ];
    expect(selectAttached(devices, {})[0]!.host).toBe('B');
  });

  it('falls back to the name, so two identical sightings still resolve the same way', () => {
    const devices = [
      host('zulu', [on('Gi0/1', 1, { address: null })]),
      host('alpha', [on('Gi0/2', 1, { address: null })]),
    ];
    expect(selectAttached(devices, {})[0]!.host).toBe('alpha');
    expect(selectAttached([...devices].reverse(), {})[0]!.host).toBe('alpha');
  });

  it('resolves before it filters, so a filter cannot promote the wrong switch', () => {
    // ACCESS is the truth. Filtering first would drop it — 1 is inside the
    // limit, but the old order dropped CORE's 30 and kept whichever remained
    // per MAC — and leave the device hanging off the core.
    const devices = [host('CORE', [on('Gi0/24', 30)]), host('ACCESS', [on('Gi0/7', 1)])];
    expect(selectAttached(devices, { maxPerPort: 5 })[0]!.host).toBe('ACCESS');
  });

  it('drops a MAC that is only ever seen on crowded ports', () => {
    // It is behind something that speaks nothing — an inferred switch, which
    // is LT-336's job, and not an endpoint to hang off a port here.
    const devices = [host('CORE', [on('Gi0/24', 30)]), host('DIST', [on('Gi0/1', 12)])];
    expect(selectAttached(devices, { maxPerPort: 5 })).toHaveLength(0);
    // Without the limit it still resolves to exactly one place.
    expect(selectAttached(devices, {})).toHaveLength(1);
    expect(selectAttached(devices, {})[0]!.host).toBe('DIST');
  });

  it('groups every sighting so the evidence is there to show', () => {
    const devices = [host('CORE', [on('Gi0/24', 30)]), host('ACCESS', [on('Gi0/7', 1)])];
    const sightings = sightingsByMac(devices).get(MAC)!;
    expect(sightings.map((s) => s.host).sort()).toEqual(['ACCESS', 'CORE']);
    expect(bestSighting(sightings).host).toBe('ACCESS');
  });
});


describe('a crowded port with nobody answering on it is a switch (LT-336)', () => {
  // Distinct MACs per port, or LT-339 quite rightly decides the two ports are
  // seeing the same devices and moves them all to the quieter one.
  let nextMac = 0;
  const crowd = (n: number, port: string) =>
    Array.from({ length: n }, () =>
      thing({ mac: `74563c0000${String(nextMac++).padStart(2, '0')}`, port, portPopulation: n, address: null }));

  it('names the port, the switch above it, and what is behind it', () => {
    const devices = [host('ACCESS', crowd(6, 'Gi0/11'))];
    const found = inferredSwitches(selectAttached(devices, {}));
    expect(found).toHaveLength(1);
    expect(found[0]!.host).toBe('ACCESS');
    expect(found[0]!.port).toBe('Gi0/11');
    expect(found[0]!.macs).toHaveLength(6);
  });

  it('leaves a single device alone \u2014 that is a socket, not a switch', () => {
    expect(inferredSwitches(selectAttached([host('A', [thing({ port: 'Gi0/1' })])], {}))).toEqual([]);
  });

  it('leaves a phone with a PC behind it alone', () => {
    // Two MACs on one access port is a desk phone bridging a workstation. A
    // phone is a three-port switch and saying so helps nobody.
    const devices = [host('A', crowd(2, 'Gi0/3'))];
    expect(inferredSwitches(selectAttached(devices, {}))).toEqual([]);
  });

  it('but will say so if asked to count that low', () => {
    const devices = [host('A', crowd(2, 'Gi0/3'))];
    expect(inferredSwitches(selectAttached(devices, {}), 2)).toHaveLength(1);
  });

  it('keeps two crowded ports apart rather than merging them', () => {
    const devices = [host('A', [...crowd(4, 'Gi0/1'), ...crowd(3, 'Gi0/2')])];
    const found = inferredSwitches(selectAttached(devices, {}));
    expect(found.map((s) => s.port)).toEqual(['Gi0/1', 'Gi0/2']);
  });

  it('counts what LT-339 resolved, not every sighting of the same device', () => {
    // CORE sees all four across an uplink; ACCESS has them. Counting sightings
    // would invent a switch behind the core as well as the real one — the same
    // four MACs, deliberately, because that is what two switches seeing one
    // crowd looks like.
    const behind = crowd(4, 'Gi0/11');
    const devices = [
      host('CORE', behind.map((d) => ({ ...d, port: 'Gi0/24', portPopulation: 30 }))),
      host('ACCESS', behind),
    ];
    const found = inferredSwitches(selectAttached(devices, {}));
    expect(found).toHaveLength(1);
    expect(found[0]!.host).toBe('ACCESS');
  });

  it('says which inferred switch a given device sits behind', () => {
    const devices = [host('ACCESS', crowd(5, 'Gi0/11'))];
    const chosen = selectAttached(devices, {});
    const found = inferredSwitches(chosen);
    expect(behindInferred(chosen[0]!, found)?.port).toBe('Gi0/11');
    const elsewhere = { device: thing({ port: 'Gi0/2' }), host: 'ACCESS' };
    expect(behindInferred(elsewhere, found)).toBeUndefined();
  });
});
