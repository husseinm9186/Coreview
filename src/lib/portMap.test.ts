import { describe, expect, it } from 'vitest';

import { portMap, portMapCsv, portTotals } from './portMap';
import type { CrawledDevice, PortStatusRow } from './ipc';

const port = (over: Partial<PortStatusRow> & { port: string }): PortStatusRow => ({
  description: '',
  status: 'notconnect',
  vlan: '1',
  duplex: 'auto',
  speed: 'auto',
  media: '',
  ...over,
});

const at = (mac: string, p: string, address: string | null = null) => ({
  mac, port: p, address, vendor: 'Ubiquiti', hostname: null, class: null, portPopulation: 1,
});

const sw = (hostname: string, over: Partial<CrawledDevice> = {}): CrawledDevice =>
  ({
    hostname,
    address: '10.0.0.1',
    addresses: [],
    probeTarget: '10.0.0.1',
    class: 'switch',
    platform: null,
    serial: null,
    version: null,
    neighbors: [],
    hops: 0,
    reachedBy: 'ssh',
    attached: [],
    ...over,
  }) as CrawledDevice;

describe('the port map (LT-340)', () => {
  const devices = [
    sw('ACC-SW1', {
      ports: [
        port({ port: 'Gi0/1', status: 'connected', description: 'Printer' }),
        port({ port: 'Gi0/2', status: 'notconnect' }),
        port({ port: 'Gi0/3', status: 'disabled' }),
        port({ port: 'Gi0/24', status: 'connected', description: 'Uplink' }),
      ],
      attached: [at('0000.5e00.5301', 'Gi0/1', '192.168.77.20')],
      neighbors: [
        { deviceId: 'CORE-SW.example', shortName: 'CORE-SW', localInterface: 'GigabitEthernet0/24' },
      ] as never,
    }),
  ];

  it('lists every port the switch reported, busy or not', () => {
    expect(portMap(devices).map((r) => r.port)).toEqual(['Gi0/1', 'Gi0/2', 'Gi0/3', 'Gi0/24']);
  });

  it('puts what was learned on the port it was learned on', () => {
    const rows = portMap(devices);
    expect(rows[0]!.learned).toHaveLength(1);
    expect(rows[0]!.learned[0]!.address).toBe('192.168.77.20');
    expect(rows[1]!.learned).toHaveLength(0);
  });

  it('matches a neighbour whatever length the switch wrote the port name in', () => {
    // The neighbour says GigabitEthernet0/24; the port table says Gi0/24.
    expect(portMap(devices).find((r) => r.port === 'Gi0/24')!.neighbour).toBe('CORE-SW');
  });

  it('calls a port free only when all three say so', () => {
    const rows = portMap(devices);
    const free = rows.filter((r) => r.free).map((r) => r.port);
    expect(free).toEqual(['Gi0/2']);
    // Connected with something learned on it — not free.
    expect(rows.find((r) => r.port === 'Gi0/1')!.free).toBe(false);
    // Connected with a neighbour on it — not free.
    expect(rows.find((r) => r.port === 'Gi0/24')!.free).toBe(false);
  });

  it('keeps a shut port apart from a free one', () => {
    // Both are capacity, but reclaiming a shut port is somebody's decision —
    // it was probably shut on purpose. Merging them overstates what is spare.
    const shut = portMap(devices).find((r) => r.port === 'Gi0/3')!;
    expect(shut.shut).toBe(true);
    expect(shut.free).toBe(false);
  });

  it('does not call a disconnected port free if something is still learned on it', () => {
    // The table has not aged out yet. "notconnect" alone is not enough.
    const stale = [sw('A', {
      ports: [port({ port: 'Gi0/5', status: 'notconnect' })],
      attached: [at('0000.5e00.53aa', 'Gi0/5')],
    })];
    expect(portMap(stale)[0]!.free).toBe(false);
  });

  it('contributes nothing for a device that was not asked for its ports', () => {
    // An empty port map is honest. Building rows from the MAC table alone
    // would list only the busy ports, which is the opposite of the question.
    expect(portMap([sw('B', { attached: [at('0000.5e00.53bb', 'Gi0/1')] })])).toEqual([]);
  });
});

describe('how many are going spare', () => {
  it('counts free, shut and in use per device, emptiest first', () => {
    const devices = [
      sw('BUSY', { ports: [port({ port: 'Gi0/1', status: 'connected' })] }),
      sw('SPARE', {
        ports: [
          port({ port: 'Gi0/1' }),
          port({ port: 'Gi0/2' }),
          port({ port: 'Gi0/3', status: 'disabled' }),
        ],
      }),
    ];
    const totals = portTotals(portMap(devices));
    expect(totals[0]).toEqual({ device: 'SPARE', ports: 3, free: 2, shut: 1, used: 0 });
    expect(totals[1]).toEqual({ device: 'BUSY', ports: 1, free: 0, shut: 0, used: 1 });
  });
});

describe('the CSV somebody has to hand over', () => {
  const rows = portMap([
    sw('ACC-SW1', {
      ports: [
        port({ port: 'Gi0/1', status: 'connected', description: 'Reception, desk 4' }),
        port({ port: 'Gi0/2' }),
      ],
      attached: [at('0000.5e00.5301', 'Gi0/1', '192.168.77.20')],
    }),
  ]);

  it('has a header and one row per port, free ones included', () => {
    const lines = portMapCsv(rows).trim().split('\n');
    expect(lines[0]).toMatch(/^Device,Port,Description,Status,VLAN/);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('free');
  });

  it('says what state each port is in, in a word', () => {
    expect(portMapCsv(rows)).toContain('in use');
    expect(portMapCsv(rows)).toContain('free');
  });

  it('quotes a description with a comma in it rather than breaking the file', () => {
    expect(portMapCsv(rows)).toContain('"Reception, desk 4"');
  });

  it('carries the MAC and the address so the sheet can be searched', () => {
    expect(portMapCsv(rows)).toContain('0000.5e00.5301');
    expect(portMapCsv(rows)).toContain('192.168.77.20');
  });
});
