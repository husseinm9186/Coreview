import { describe, expect, it } from 'vitest';

import type { CrawledDevice, Neighbor } from './ipc';
import { crawlFindings } from './crawlFindings';

const nb = (name: string, local: string, remote: string): Neighbor => ({
  deviceId: name, shortName: name, addresses: [], localInterface: local, remoteInterface: remote, platform: null,
  serial: null, capabilities: [], version: null, class: 'switch', discoveredBy: 'cdp', chassisId: null, vendor: null,
});
const dev = (hostname: string, neighbors: Neighbor[], over: Partial<CrawledDevice> = {}): CrawledDevice => ({
  hostname, address: '', addresses: [], probeTarget: '', class: 'switch', platform: null, serial: null, version: null,
  neighbors, hops: 0, reachedBy: 'ssh', attached: [], ...over,
});
const kinds = (f: ReturnType<typeof crawlFindings>) => f.map((x) => x.kind);

describe('crawl findings (LT-213)', () => {
  it('finds nothing wrong with a tidy tree', () => {
    const f = crawlFindings({ devices: [
      dev('CORE', [nb('ACC1', 'GigabitEthernet1/0/1', 'GigabitEthernet0/1')]),
      dev('ACC1', [nb('CORE', 'GigabitEthernet0/1', 'GigabitEthernet1/0/1')]),
    ] });
    expect(f).toEqual([]);
  });

  it('flags a link only one end reports', () => {
    const f = crawlFindings({ devices: [dev('CORE', [nb('ACC1', 'Gi1/0/1', 'Gi0/1')]), dev('ACC1', [])] });
    expect(kinds(f)).toEqual(['one-way']);
    expect(f[0]!.message).toBe('CORE sees ACC1 on Gi1/0/1, but ACC1 does not see CORE.');
  });

  it('does not call a link one-way when the far end was only reached over SNMP', () => {
    const f = crawlFindings({ devices: [dev('CORE', [nb('ACC1', 'Gi1/0/1', 'Gi0/1')]), dev('ACC1', [], { reachedBy: 'snmp' })] });
    expect(kinds(f)).not.toContain('one-way');
  });

  it('flags a loop that spanning tree does not break, and not one it does', () => {
    const triangle = (blocked: boolean) => [
      dev('A', [nb('B', 'Gi0/1', 'Gi0/1'), nb('C', 'Gi0/2', 'Gi0/1')]),
      dev('B', [nb('A', 'Gi0/1', 'Gi0/1'), nb('C', 'Gi0/2', 'Gi0/2')]),
      dev('C', [nb('A', 'Gi0/1', 'Gi0/2'), nb('B', 'Gi0/2', 'Gi0/2')], {
        spanningTree: blocked ? [{ instance: 'VLAN0001', vlan: 1, protocol: 'rstp', rootBridge: null, rootPriority: null, isRoot: false, rootPort: null, bridgeAddress: null,
          ports: [{ port: 'Gi0/2', role: 'Altn', state: 'BLK', cost: 4 }] }] : [],
      }),
    ];
    const open = crawlFindings({ devices: triangle(false) });
    expect(kinds(open)).toEqual(['loop']);
    expect(open[0]!.devices.sort()).toEqual(['A', 'B', 'C']);
    const broken = crawlFindings({ devices: triangle(true) });
    expect(kinds(broken)).toEqual(['blocked']);
    expect(broken[0]!.message).toMatch(/^B Gi0\/2 – C Gi0\/2 is blocked/);
  });

  it('treats two cables in a bundle as one link, and two unbundled as a loop', () => {
    const pair = (bundled: boolean) => [
      dev('A', [nb('B', 'Gi0/1', 'Gi0/1'), nb('B', 'Gi0/2', 'Gi0/2')], bundled ? { portChannels: [{ name: 'Po1', protocol: 'LACP', members: ['Gi0/1', 'Gi0/2'] }] } : {}),
      dev('B', [nb('A', 'Gi0/1', 'Gi0/1'), nb('A', 'Gi0/2', 'Gi0/2')], bundled ? { portChannels: [{ name: 'Po1', protocol: 'LACP', members: ['Gi0/1', 'Gi0/2'] }] } : {}),
    ];
    expect(kinds(crawlFindings({ devices: pair(true) }))).toEqual([]);
    expect(kinds(crawlFindings({ devices: pair(false) }))).toEqual(['loop']);
  });

  it('flags a drawn link neither end saw, an up trunk nobody identified, and an orphan', () => {
    const f = crawlFindings({ devices: [
      dev('CORE', [], {
        ports: [
          { port: 'Gi0/9', description: '', status: 'connected', vlan: 'trunk', duplex: 'a-full', speed: '1000', media: '' },
          { port: 'Gi0/2', description: '', status: 'connected', vlan: '10', duplex: 'a-full', speed: '1000', media: '' },
        ],
        portVlans: [{ port: 'Gi0/9', mode: 'trunk', vlan: 1, trunkVlans: [] }, { port: 'Gi0/2', mode: 'access', vlan: 10, trunkVlans: [] }],
      }),
      dev('ACC9', []),
    ] }, [{ a: 'core', b: 'ACC9' }]);
    expect(kinds(f)).toEqual(['not-seen', 'unidentified', 'orphan', 'orphan']);
    expect(f[1]!.message).toBe('CORE Gi0/9 is an up trunk with no neighbour reporting on it.');
  });

  it('flags one MAC alone on two ports, but not one behind an uplink', () => {
    const at = (mac: string, port: string, portPopulation: number) => ({ mac, port, address: null, vendor: null, hostname: null, class: null, portPopulation });
    const f = crawlFindings({ devices: [
      dev('SW1', [], { attached: [at('0000.5e00.5301', 'Gi0/3', 1), at('0000.5e00.5399', 'Gi0/24', 30)] }),
      dev('SW2', [], { attached: [at('00:00:5E:00:53:01', 'GigabitEthernet0/7', 1), at('0000.5e00.5399', 'Gi0/5', 1)] }),
    ] });
    expect(kinds(f)).toEqual(['duplicate-mac']);
    expect(f[0]!.message).toBe('00:00:5e:00:53:01 is the only device on SW1 Gi0/3 and SW2 Gi0/7.');
  });
});
