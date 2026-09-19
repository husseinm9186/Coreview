import { describe, expect, it } from 'vitest';

import {
  buildTopology,
  chassisOfPort,
  identity,
  identitiesOfNode,
  macKey,
  stackFields,
  shortInterface,
  CLASS_GLYPH,
} from './topology';
import type { CrawledDevice, DeviceClassName, Neighbor } from './ipc';
import type { DeviceNodeData, LinkData } from '../types/domain';
import { drawsStacked } from './stacked';

const neighbor = (
  name: string,
  local: string | null,
  remote: string | null,
  over: Partial<Neighbor> = {},
): Neighbor => ({
  deviceId: name,
  serial: null,
  shortName: name.split('.')[0] ?? name,
  addresses: over.addresses ?? [{ ip: '', interface: null, isManagement: false }],
  localInterface: local,
  remoteInterface: remote,
  platform: null,
  capabilities: [],
  version: null,
  class: 'switch',
  discoveredBy: 'cdp',
  chassisId: null,
  vendor: null,
  ...over,
});

const device = (
  hostname: string,
  address: string,
  neighbors: Neighbor[],
  over: Partial<CrawledDevice> = {},
): CrawledDevice => ({
  hostname,
  serial: null,
  address,
  addresses: [{ ip: address, interface: null, isManagement: true }],
  probeTarget: address,
  class: 'switch',
  platform: null,
  version: null,
  neighbors,
  hops: 0,
  reachedBy: 'ssh',
  attached: [],
  ...over,
});

/** A device node as the ping sweep leaves it on the canvas (LT-121). */
const sweptNode = (
  id: string,
  label: string,
  address: string,
  mac?: string,
): { id: string; type: string; position: { x: number; y: number }; data: DeviceNodeData } => ({
  id,
  type: 'device',
  position: { x: 100, y: 400 },
  data: {
    label,
    deviceType: 'generic',
    tags: [],
    addresses: [{ id: `${id}-a`, label: 'Discovered', address, isPrimary: true }],
    locked: false,
    maintenance: false,
    showDetails: true,
    ...(mac ? { mac } : {}),
  } as DeviceNodeData,
});

/** A MAC on a switch port, as the crawler reports one. */
const attached = (mac: string, port: string, over: Record<string, unknown> = {}) => ({
  mac,
  port,
  address: null,
  vendor: null,
  hostname: null,
  class: null,
  portPopulation: 1,
  vlan: null,
  ...over,
});

const labels = (t: ReturnType<typeof buildTopology>) =>
  t.nodes.map((n) => (n.data as DeviceNodeData).label).sort();
const ports = (t: ReturnType<typeof buildTopology>) =>
  t.edges.map((e) => {
    const d = e.data as LinkData;
    return `${d.sourcePortLabel}<->${d.targetPortLabel}`;
  });

describe('buildTopology', () => {
  it('draws cables on the physical view and layer-3 hops on the logical one (LT-215)', () => {
    const route = (prefix: string, hop: string) => ({ family: 4 as const, prefix, code: 'O', protocol: 'ospf', nextHops: [hop], interface: null, distance: 110, metric: 2 });
    const src = {
      devices: [
        device('CORE', '10.0.0.1', [neighbor('DIST', 'Gi1/0/1', 'Gi0/1')], { routes: [route('10.9.0.0/16', '10.0.0.2')] }),
        device('DIST', '10.0.0.2', [], { hops: 1, routes: [route('0.0.0.0/0', '10.0.0.1'), route('10.8.0.0/16', '10.0.0.1')] }),
      ],
      notVisited: [],
    };
    const t = buildTopology(src, 'p', { views: { physical: 'phys', logical: 'logi' } });
    const cable = t.edges.find((e) => !(e.data as LinkData).layer3)!;
    const l3 = t.edges.filter((e) => (e.data as LinkData).layer3);
    expect((cable.data as LinkData).layers).toEqual(['phys']);
    expect(l3).toHaveLength(1);
    const d = l3[0]!.data as LinkData;
    expect(d.layers).toEqual(['logi']);
    expect(d.direction).toBe('both');
    expect(d.lineStyle).toBe('dashed');
    expect(d.notes).toMatch(/via this device/);

    // Found again, the hop is not drawn twice; with no Logical view, not at all.
    const again = buildTopology(src, 'p', { views: { physical: 'phys', logical: 'logi' }, existingNodes: t.nodes, existingEdges: t.edges });
    expect(again.edges.filter((e) => (e.data as LinkData).layer3)).toHaveLength(0);
    expect(buildTopology(src, 'p').edges.filter((e) => (e.data as LinkData).layer3)).toHaveLength(0);
  });

  it('draws a switch by the role the evidence gives it, and never overwrites a role someone wrote (LT-214)', () => {
    const hosts = [1, 2, 3, 4, 5].map((i) => ({ mac: `0000.5e00.53${i}0`, port: `Gi0/${i}`, address: null, vendor: null, hostname: null, class: null, portPopulation: 1 }));
    const t = buildTopology({ devices: [device('ACC-SW9', '10.0.0.9', [], { attached: hosts })], notVisited: [] }, 'p');
    const data = t.nodes.find((n) => (n.data as DeviceNodeData).label === 'ACC-SW9')!.data as DeviceNodeData;
    expect(data.deviceType).toBe('access-switch');
    expect(data.role).toBe('Access');
    expect(data.roleEvidence).toMatch(/5 hosts plugged straight in/);

    const drawn = { ...t.nodes.find((n) => (n.data as DeviceNodeData).label === 'ACC-SW9')!, data: { ...data, role: 'Lab bench' } };
    const again = buildTopology({ devices: [device('ACC-SW9', '10.0.0.9', [], { attached: hosts })], notVisited: [] }, 'p', { existingNodes: [drawn as never] });
    expect(again.updated.find((u) => u.id === drawn.id)?.data.role).toBeUndefined();
  });

  it('puts what a crawl read about a device on its node, new or already drawn (LT-200–204)', () => {
    const read = device('CORE-SW', '10.0.0.1', [], {
      uptimeSeconds: 600,
      routes: [{ family: 4, prefix: '0.0.0.0/0', code: 'S*', protocol: 'static', nextHops: ['10.0.0.254'], interface: null, distance: 1, metric: 0 }],
    });
    const fresh = buildTopology({ devices: [read], notVisited: [] }, 'p', { collectedAt: 7 });
    const inv = (fresh.nodes[0]!.data as DeviceNodeData).inventory!;
    expect(inv.collectedAt).toBe(7);
    expect(inv.uptimeSeconds).toBe(600);
    expect(inv.routes[0]!.nextHops).toEqual(['10.0.0.254']);

    const again = buildTopology({ devices: [{ ...read, uptimeSeconds: 900 }], notVisited: [] }, 'p', {
      existingNodes: fresh.nodes,
      collectedAt: 8,
    });
    expect(again.nodes).toHaveLength(0);
    const patch = again.updated.find((u) => u.id === fresh.nodes[0]!.id)!.data;
    expect(patch.inventory).toMatchObject({ collectedAt: 8, uptimeSeconds: 900 });
  });

  it('links the devices it discovered, with the interface at each end', () => {
    // The whole point: discovery already knows who is plugged into what.
    const t = buildTopology(
      {
        devices: [
          device('CORE-SW', '10.0.0.1', [neighbor('ACC-SW1', 'Gi1/0/1', 'Gi0/1')]),
          device('ACC-SW1', '10.0.0.2', [], { hops: 1 }),
        ],
        notVisited: [],
      },
      'p',
    );
    expect(labels(t)).toEqual(['ACC-SW1', 'CORE-SW']);
    expect(t.edges).toHaveLength(1);
    expect(ports(t)).toEqual(['Gi1/0/1<->Gi0/1']);
    // The name as reported survives on the link, not only its short form.
    expect((t.edges[0]!.data as LinkData).notes).toContain('Gi1/0/1');
  });

  it('collapses a cable reported from both ends into one link', () => {
    // Both switches report the same cable. Drawn twice it looks like a
    // redundant pair that does not exist.
    const t = buildTopology(
      {
        devices: [
          device('CORE-SW', '10.0.0.1', [neighbor('ACC-SW1', 'Gi1/0/1', 'Gi0/1')]),
          device('ACC-SW1', '10.0.0.2', [neighbor('CORE-SW', 'Gi0/1', 'Gi1/0/1')], { hops: 1 }),
        ],
        notVisited: [],
      },
      'p',
    );
    expect(t.edges).toHaveLength(1);
  });

  it('keeps two cables between the same pair as two links', () => {
    // The opposite mistake: keying only on the pair would merge a real
    // dual-homed pair into a single line.
    const t = buildTopology(
      {
        devices: [
          device('CORE-SW', '10.0.0.1', [
            neighbor('ACC-SW1', 'Gi1/0/1', 'Gi0/1'),
            neighbor('ACC-SW1', 'Gi1/0/2', 'Gi0/2'),
          ]),
        ],
        notVisited: [],
      },
      'p',
    );
    expect(t.edges).toHaveLength(2);
    expect(ports(t).sort()).toEqual(['Gi1/0/1<->Gi0/1', 'Gi1/0/2<->Gi0/2']);
  });

  it('folds the same device seen under different names into one node', () => {
    // CDP says SW1.example.com, LLDP says SW1, the prompt says sw1. Three
    // nodes with a third of the links each is not a diagram of anything.
    const t = buildTopology(
      {
        devices: [
          device('CORE-SW', '10.0.0.1', [neighbor('SW1.example.com', 'Gi1/0/1', 'Gi0/1')]),
          device('sw1', '10.0.0.2', [], { hops: 1 }),
        ],
        notVisited: [neighbor('SW1', null, null)],
      },
      'p',
    );
    expect(t.nodes).toHaveLength(2);
  });

  it('places devices that were only seen, never logged into', () => {
    // Phones, printers and endpoints are most of a real diagram and are never
    // logged into.
    const t = buildTopology(
      {
        devices: [
          device('ACC-SW1', '10.0.0.2', [
            neighbor('SEP001122334455', 'Gi1/0/5', 'Port 1', { class: 'phone' }),
            neighbor('HP-LaserJet', 'Gi1/0/6', 'eth0', { class: 'printer' }),
          ]),
        ],
        notVisited: [],
      },
      'p',
    );
    expect(labels(t)).toEqual(['ACC-SW1', 'HP-LaserJet', 'SEP001122334455']);
    expect(t.edges).toHaveLength(2);
  });

  it('gives a phone and a camera their own glyphs', () => {
    // These mapped to 'endpoint-client' and 'camera-iot', which are not device
    // types; both fell through to the generic box.
    const t = buildTopology(
      {
        devices: [
          device('SW', '10.0.0.1', [
            neighbor('PHONE', 'Gi1/0/5', 'P1', { class: 'phone' }),
            neighbor('CAM', 'Gi1/0/6', 'eth0', { class: 'camera' }),
          ]),
        ],
        notVisited: [],
      },
      'p',
    );
    const types = t.nodes.map((n) => (n.data as DeviceNodeData).deviceType);
    expect(types).toContain('endpoint');
    expect(types).toContain('camera');
    expect(types).not.toContain('generic');
  });

  it('leaves out classes that were not asked for, and counts the links that lost an end', () => {
    const t = buildTopology(
      {
        devices: [
          device('SW', '10.0.0.1', [
            neighbor('PHONE', 'Gi1/0/5', 'P1', { class: 'phone' }),
            neighbor('ACC-SW1', 'Gi1/0/1', 'Gi0/1'),
          ]),
        ],
        notVisited: [],
      },
      'p',
      { include: ['switch'] },
    );
    expect(labels(t)).toEqual(['ACC-SW1', 'SW']);
    expect(t.edges).toHaveLength(1);
    expect(t.danglingLinks).toBe(1);
  });

  it('lays devices out by distance from the seed, not in a grid', () => {
    const t = buildTopology(
      {
        devices: [
          device('CORE', '10.0.0.1', [neighbor('A', 'Gi1/0/1', 'Gi0/1')], { hops: 0 }),
          device('A', '10.0.0.2', [neighbor('B', 'Gi0/2', 'Gi0/1')], { hops: 1 }),
          device('B', '10.0.0.3', [], { hops: 2 }),
        ],
        notVisited: [],
      },
      'p',
    );
    const y = (label: string) =>
      t.nodes.find((n) => (n.data as DeviceNodeData).label === label)!.position.y;
    expect(y('CORE')).toBeLessThan(y('A'));
    expect(y('A')).toBeLessThan(y('B'));
  });

  it('never links a device to itself', () => {
    // A device that reports itself as its own neighbour, which happens on
    // stacks and with some LLDP implementations.
    const t = buildTopology(
      { devices: [device('SW', '10.0.0.1', [neighbor('SW', 'Gi1/0/1', 'Gi1/0/2')])], notVisited: [] },
      'p',
    );
    expect(t.edges).toHaveLength(0);
  });

  it('handles a crawl that reached nothing', () => {
    const t = buildTopology({ devices: [], notVisited: [] }, 'p');
    expect(t.nodes).toEqual([]);
    expect(t.edges).toEqual([]);
  });
});

describe('one device reported under two names', () => {
  it('folds an SNMP sysName and an LLDP name that share an address', () => {
    // A switch reached over SNMP reports its sysName, which is not always the
    // name it advertises over LLDP. Two names, one address, one device.
    const t = buildTopology(
      {
        devices: [
          device('CORE-SW', '10.0.0.1', [
            neighbor('LAB-ACC-SW', 'Gi1/0/1', 'Port 1', {
              addresses: [{ ip: '10.0.0.2', interface: null, isManagement: true }],
            }),
          ]),
          // The same switch, reached over SNMP, calling itself something else.
          device('USW-Lite-8-PoE', '10.0.0.2', [], { hops: 1, reachedBy: 'snmp' }),
        ],
        notVisited: [],
      },
      'p',
    );
    expect(t.nodes).toHaveLength(2);
    // The reached device wins, because it knows more about itself.
    expect(labels(t)).toEqual(['CORE-SW', 'USW-Lite-8-PoE']);
    // And the link follows the fold rather than dangling.
    expect(t.edges).toHaveLength(1);
    expect(t.danglingLinks).toBe(0);
  });

  it('keeps two devices that merely have no address apart', () => {
    // Folding on a missing address would collapse every unaddressed device
    // into one.
    const t = buildTopology(
      {
        devices: [
          device('SW', '10.0.0.1', [
            neighbor('PHONE-A', 'Gi1/0/5', 'P1', { class: 'phone', addresses: [] }),
            neighbor('PHONE-B', 'Gi1/0/6', 'P1', { class: 'phone', addresses: [] }),
          ]),
        ],
        notVisited: [],
      },
      'p',
    );
    expect(t.nodes).toHaveLength(3);
  });
});

describe('a device whose only name is a MAC', () => {
  it('is drawn as its maker rather than as hex', () => {
    // A chassis id of 7456.3c00.0001 on a switch port tells an operator
    // nothing. "Ubiquiti device" tells them what they are looking at.
    const t = buildTopology(
      {
        devices: [
          device('SW', '10.0.0.1', [
            neighbor('7456.3c00.0001', 'Gi1/0/7', 'eth0', {
              shortName: '7456.3c00.0001',
              vendor: 'Ubiquiti',
              class: 'unknown',
            }),
          ]),
        ],
        notVisited: [],
      },
      'p',
    );
    expect(labels(t)).toContain('Ubiquiti device');
  });

  it('still counts two devices from one maker as two devices', () => {
    // The label changes; the identity must not, or a network full of one
    // vendor's kit collapses into a single node.
    const t = buildTopology(
      {
        devices: [
          device('SW', '10.0.0.1', [
            neighbor('7456.3c00.0001', 'Gi1/0/7', 'eth0', {
              shortName: '7456.3c00.0001', vendor: 'Ubiquiti', class: 'unknown',
            }),
            neighbor('7456.3c00.ffff', 'Gi1/0/8', 'eth0', {
              shortName: '7456.3c00.ffff', vendor: 'Ubiquiti', class: 'unknown',
            }),
          ]),
        ],
        notVisited: [],
      },
      'p',
    );
    expect(t.nodes).toHaveLength(3);
    expect(t.edges).toHaveLength(2);
  });

  it('leaves a real name alone', () => {
    const t = buildTopology(
      {
        devices: [device('SW', '10.0.0.1', [
          neighbor('ACC-SW1', 'Gi1/0/1', 'Gi0/1', { vendor: 'Cisco Systems' }),
        ])],
        notVisited: [],
      },
      'p',
    );
    expect(labels(t)).toContain('ACC-SW1');
  });
});

describe('drawing what a switch has learned', () => {
  const attached = (over = {}) => ({
    device: {
      mac: 'aabbccddeeff',
      port: 'GigabitEthernet1/0/7',
      address: '10.0.0.50',
      vendor: 'Axis Communications',
      hostname: null,
      class: null,
      portPopulation: 1,
      ...over,
    },
    host: 'CORE-SW',
  });

  it('hangs a silent device off the port it was learned on', () => {
    const t = buildTopology(
      { devices: [device('CORE-SW', '10.0.0.1', [])], notVisited: [] },
      'p',
      { attached: [attached()] },
    );
    expect(labels(t)).toContain('Axis Communications device');
    expect(t.edges).toHaveLength(1);
    // The port is on the link, written the way a diagram writes it.
    expect((t.edges[0]!.data as { sourcePortLabel: string }).sourcePortLabel).toBe('Gi1/0/7');
  });

  it('draws nothing when nothing was asked for', () => {
    // A flat /24 can hold two hundred of these; they appear only on request.
    const t = buildTopology(
      { devices: [device('CORE-SW', '10.0.0.1', [])], notVisited: [] },
      'p',
    );
    expect(t.nodes).toHaveLength(1);
    expect(t.edges).toHaveLength(0);
  });

  it('prefers a name the device gave over the maker of its chip', () => {
    // "HPLJ-3rdfloor" can be found on a floor. "Axis Communications device"
    // cannot, and there may be forty of them.
    const t = buildTopology(
      { devices: [device('CORE-SW', '10.0.0.1', [])], notVisited: [] },
      'p',
      { attached: [attached({ hostname: 'HPLJ-3rdfloor' })] },
    );
    expect(labels(t)).toContain('HPLJ-3rdfloor');
    expect(labels(t)).not.toContain('Axis Communications device');
  });

  it('draws the glyph only when something could actually tell us', () => {
    const known = buildTopology(
      { devices: [device('CORE-SW', '10.0.0.1', [])], notVisited: [] },
      'p',
      { attached: [attached({ class: 'printer' })] },
    );
    const printer = known.nodes.find((n) => n.data.label !== 'CORE-SW');
    expect(printer?.data.deviceType).toBe('printer');

    // With no class, an OUI is not evidence of a role: a plain box is right.
    const guessed = buildTopology(
      { devices: [device('CORE-SW', '10.0.0.1', [])], notVisited: [] },
      'p',
      { attached: [attached()] },
    );
    const box = guessed.nodes.find((n) => n.data.label !== 'CORE-SW');
    expect(box?.data.deviceType).toBe('generic');
  });

  it('falls back to the MAC when the maker is unknown', () => {
    const t = buildTopology(
      { devices: [device('CORE-SW', '10.0.0.1', [])], notVisited: [] },
      'p',
      { attached: [attached({ vendor: null })] },
    );
    expect(labels(t)).toContain('aabbccddeeff');
  });

  it('skips one whose switch is not on the diagram', () => {
    // Filtered out, or never reached — either way there is nothing to hang it
    // from, and a floating node says less than no node.
    const t = buildTopology(
      { devices: [device('OTHER-SW', '10.0.0.9', [])], notVisited: [] },
      'p',
      { attached: [attached()] },
    );
    expect(t.nodes).toHaveLength(1);
    expect(t.edges).toHaveLength(0);
  });
});

describe('re-crawling a diagram that already exists', () => {
  const source = {
    devices: [
      device('CORE-SW', '10.0.0.1', [neighbor('ACC-SW1', 'Gi1/0/1', 'Gi0/1')]),
      device('ACC-SW1', '10.0.0.2', [], { hops: 1 }),
    ],
    notVisited: [],
  };

  it('keeps a device that is already drawn, and the position it was put in', () => {
    // Without this a second crawl draws the whole network again beside the
    // first, which makes discovery something you do once.
    const first = buildTopology(source, 'p');
    const arranged = first.nodes.map((n) => ({ ...n, position: { x: 999, y: 777 } }));

    const second = buildTopology(source, 'p', {
      existingNodes: arranged,
      existingEdges: first.edges,
    });

    expect(second.nodes).toHaveLength(0);
    expect(second.edges).toHaveLength(0);
    expect(second.updated).toHaveLength(2);
    // The ids are the ones already on the diagram, so nothing is replaced.
    expect(second.updated.map((u) => u.id).sort()).toEqual(arranged.map((n) => n.id).sort());
  });

  it('never unticks HA someone ticked by hand (LT-160)', () => {
    const first = buildTopology(source, 'p');
    const ticked = first.nodes.map((n) => ({ ...n, data: { ...n.data, ha: true } }) as typeof n);
    const second = buildTopology(source, 'p', { existingNodes: ticked, existingEdges: first.edges });
    expect(second.updated.length).toBeGreaterThan(0);
    for (const u of second.updated) expect('ha' in u.data).toBe(false);
  });

  it('routes a link across when the operator has put the devices side by side', () => {
    // Build-time routing earns its keep on a re-crawl: the first draw is
    // tiered, but by the second the diagram has been arranged by hand, and a
    // link that still dives under two devices standing in a row is wrong.
    const first = buildTopology(source, 'p');
    const sideBySide = first.nodes.map((n, i) => ({
      ...n,
      position: { x: i * 600, y: 200 },
    }));
    // The same crawl again, but with no existing edges, so the link between
    // the two arranged devices is drawn afresh against their real positions.
    const second = buildTopology(source, 'p', {
      existingNodes: sideBySide,
      existingEdges: [],
    });

    expect(second.edges).toHaveLength(1);
    expect(second.edges[0]!.sourceHandle).toBe('r');
    expect(second.edges[0]!.targetHandle).toBe('l');
  });

  it('still routes down when the diagram is drawn in tiers', () => {
    // The common case, and the one the previous check must not have broken.
    const first = buildTopology(source, 'p');
    const tiered = first.nodes.map((n, i) => ({ ...n, position: { x: 0, y: i * 400 } }));
    const second = buildTopology(source, 'p', { existingNodes: tiered, existingEdges: [] });
    expect(second.edges[0]!.sourceHandle).toBe('b');
    expect(second.edges[0]!.targetHandle).toBe('t');
  });

  it('adds only what is new', () => {
    const first = buildTopology(source, 'p');
    const grown = {
      devices: [
        device('CORE-SW', '10.0.0.1', [
          neighbor('ACC-SW1', 'Gi1/0/1', 'Gi0/1'),
          neighbor('ACC-SW2', 'Gi1/0/2', 'Gi0/1'),
        ]),
        device('ACC-SW1', '10.0.0.2', [], { hops: 1 }),
        device('ACC-SW2', '10.0.0.3', [], { hops: 1 }),
      ],
      notVisited: [],
    };

    const second = buildTopology(grown, 'p', {
      existingNodes: first.nodes,
      existingEdges: first.edges,
    });

    expect(labels(second)).toEqual(['ACC-SW2']);
    expect(second.edges).toHaveLength(1);
  });

  it('does not redraw a cable it already drew', () => {
    const first = buildTopology(source, 'p');
    const second = buildTopology(source, 'p', {
      existingNodes: first.nodes,
      existingEdges: first.edges,
    });
    expect(second.edges).toHaveLength(0);
  });

  it('never writes over the label', () => {
    // The crawl writes what it can newly establish. A name somebody corrected
    // by hand is not that.
    const first = buildTopology(source, 'p');
    const second = buildTopology(source, 'p', {
      existingNodes: first.nodes,
      existingEdges: first.edges,
    });
    expect(second.updated.length).toBeGreaterThan(0);
    for (const u of second.updated) expect(u.data.label).toBeUndefined();
  });
});

describe('shortInterface', () => {
  it('writes interfaces the way a diagram does', () => {
    expect(shortInterface('GigabitEthernet0/1')).toBe('Gi0/1');
    expect(shortInterface('TenGigabitEthernet1/0/48')).toBe('Te1/0/48');
    expect(shortInterface('FastEthernet0/24')).toBe('Fa0/24');
    expect(shortInterface('Port-channel10')).toBe('Po10');
    expect(shortInterface('Vlan100')).toBe('Vl100');
  });

  it('writes Nexus ports the way NX-OS does', () => {
    // Every Nexus port is an "Ethernet" whatever its speed, and the switch
    // itself calls them Eth1/1.
    expect(shortInterface('Ethernet1/1')).toBe('Eth1/1');
    expect(shortInterface('Ethernet1/49')).toBe('Eth1/49');
    expect(shortInterface('port-channel10')).toBe('Po10');
    expect(shortInterface('mgmt0')).toBe('mgmt0');
  });

  it('does not shorten TenGigabitEthernet to Etn', () => {
    // The Ethernet rule matches inside the longer name if tried first.
    expect(shortInterface('TenGigabitEthernet1/1')).toBe('Te1/1');
  });

  it('leaves alone what it does not recognise', () => {
    // Non-Cisco ports, and forms that are already short.
    expect(shortInterface('Gi0/1')).toBe('Gi0/1');
    expect(shortInterface('Port 4')).toBe('Port 4');
    expect(shortInterface('eth1')).toBe('eth1');
    expect(shortInterface('7456.3c00.0001')).toBe('7456.3c00.0001');
  });
});

describe('identity', () => {
  it('ignores the domain and the case', () => {
    expect(identity('SW1.example.com', '')).toBe(identity('sw1', ''));
  });

  it('does not cut a MAC at its first dot', () => {
    // Stripping a domain suffix mangles a Cisco-style MAC: 7456.3c00.0001
    // becomes 7456, which every device from that vendor shares.
    expect(identity('7456.3c00.0001', '')).not.toBe(identity('7456.3c00.ffff', ''));
    expect(identity('7456.3c00.0001', '')).toBe(identity('7456.3C00.0001', ''));
  });

  it('falls back to the address when there is no usable name', () => {
    expect(identity('', '10.0.0.9')).toBe('a:10.0.0.9');
    expect(identity('unknown', '10.0.0.9')).toBe('a:10.0.0.9');
  });
});

describe('CLASS_GLYPH', () => {
  it('maps every class to a real device type', () => {
    const classes: DeviceClassName[] = [
      'router', 'switch', 'firewall', 'wireless-controller', 'access-point',
      'phone', 'camera', 'printer', 'server', 'endpoint', 'unknown',
    ];
    for (const c of classes) expect(CLASS_GLYPH[c]).toBeTruthy();
  });
});

describe('port-channels fold into one link (LT-009)', () => {
  const po1 = { name: 'Po1', protocol: 'LACP', members: ['Gi1/0/11', 'Gi1/0/12'] };
  const at = (ip: string) => ({ addresses: [{ ip, interface: null, isManagement: true }] });
  const pair = (a: Partial<CrawledDevice>, b: Partial<CrawledDevice>) => [
    device('9300-LAB', '192.168.77.20', [
      neighbor('Cisco-Rack1-3850', 'GigabitEthernet1/0/11', 'GigabitEthernet1/0/11', at('192.168.77.111')),
      neighbor('Cisco-Rack1-3850', 'GigabitEthernet1/0/12', 'GigabitEthernet1/0/12', at('192.168.77.111')),
    ], a),
    device('Cisco-Rack1-3850', '192.168.77.111', [
      neighbor('9300-LAB', 'GigabitEthernet1/0/11', 'GigabitEthernet1/0/11', at('192.168.77.20')),
      neighbor('9300-LAB', 'GigabitEthernet1/0/12', 'GigabitEthernet1/0/12', at('192.168.77.20')),
    ], b),
  ];

  it('two bundled cables draw as one Po link, members in the notes', () => {
    // The lab, verbatim: Po1 over Gi1/0/11 + Gi1/0/12 on both switches.
    const built = buildTopology(
      { devices: pair({ portChannels: [po1] }, { portChannels: [po1] }), notVisited: [] },
      'p1',
    );
    expect(built.edges).toHaveLength(1);
    const d = built.edges[0]!.data!;
    expect(d.sourcePortLabel).toBe('Po1');
    expect(d.targetPortLabel).toBe('Po1');
    expect(d.notes).toContain('Gi1/0/11');
    expect(d.notes).toContain('Gi1/0/12');
    expect(d.notes).toContain('2 bundled ports');
  });

  it('one side reporting the bundle is enough — the other was not crawled', () => {
    const built = buildTopology(
      { devices: pair({ portChannels: [po1] }, {}), notVisited: [] },
      'p1',
    );
    expect(built.edges).toHaveLength(1);
    expect(built.edges[0]!.data!.sourcePortLabel).toBe('Po1');
  });

  it('unbundled parallel cables still draw as two links', () => {
    // D-014's line: never infer a bundle. No etherchannel data, no folding.
    const built = buildTopology({ devices: pair({}, {}), notVisited: [] }, 'p1');
    expect(built.edges).toHaveLength(2);
  });

});

/**
 * LT-126 — joining a sweep to a crawl.
 *
 * Reported as "the cdp/lldp crowler and the sweep don't really build the
 * diagram like they are disconnected". A sweep places hosts it knows by name
 * and address; a crawl learns which switch port each MAC sits on. Keyed on a
 * single canonical string the two never met, so the crawl drew a second box
 * and left the swept one floating.
 */
describe('one device is one identity (LT-132/LT-133)', () => {
  it('does not give every address-labelled host the same identity', () => {
    // `identity` strips a domain by cutting at the first dot, and an address
    // has dots — so a whole subnet of swept hosts collapsed into `n:192`.
    const a = identity('192.168.77.7', '192.168.77.7');
    const b = identity('192.168.77.129', '192.168.77.129');
    expect(a).not.toBe(b);
    // And an address is not a name, so it keys on the address.
    expect(a).toBe('a:192.168.77.7');
  });

  it('still strips a domain from a real hostname', () => {
    expect(identity('SW1.example.com', '10.0.0.1')).toBe('n:sw1');
    // A generic first label is still that host's name, not every host's.
    expect(identity('host.docker.internal', '10.0.0.9')).toBe('n:host');
  });

  it('recognises a crawled device as the host the sweep already drew', () => {
    // The report this comes from: `host.docker.internal (192.168.77.129)`
    // listed as gone and `LABDESKTOP01 (192.168.77.129)` as new. One machine,
    // one address, two boxes. The names genuinely differ — the address is the
    // only thing the two sightings share, so it has to be enough.
    const swept = sweptNode('h', 'host.docker.internal', '192.168.77.129');
    const t = buildTopology(
      { devices: [device('LABDESKTOP01', '192.168.77.129', [])], notVisited: [] },
      'p',
      { existingNodes: [swept] as never },
    );
    expect(labels(t)).toEqual([]);
    expect(t.updated.map((u) => u.id)).toEqual(['h']);
  });

  it('recognises a crawled switch as the address the sweep drew', () => {
    // A sweep that found no name labels the node with the address itself.
    const swept = sweptNode('sw', '192.168.77.7', '192.168.77.7');
    const t = buildTopology(
      { devices: [device('LAB-CORE-SW1', '192.168.77.7', [])], notVisited: [] },
      'p',
      { existingNodes: [swept] as never },
    );
    expect(labels(t)).toEqual([]);
    expect(t.updated.map((u) => u.id)).toEqual(['sw']);
  });

  it('anchors attached devices to a switch that was already on the diagram', () => {
    // The moment a crawled switch could be an existing node, the anchor
    // lookup — which only searched the nodes this run created — found
    // nothing, and every port on that switch went unlinked.
    const swept = sweptNode('sw', '192.168.77.7', '192.168.77.7');
    const a = attached('aabb.ccdd.eeff', 'Gi1/0/9', { hostname: 'NEW-BOX' });
    const t = buildTopology(
      { devices: [device('LAB-CORE-SW1', '192.168.77.7', [], { attached: [a] })], notVisited: [] },
      'p',
      { attached: [{ device: a, host: 'LAB-CORE-SW1' }], existingNodes: [swept] as never },
    );
    expect(labels(t)).toEqual(['NEW-BOX']);
    const cable = t.edges.find((e) => e.source === 'sw' || e.target === 'sw');
    expect(cable, `nothing anchored to the existing switch: ${JSON.stringify(t.edges)}`).toBeTruthy();
    expect((cable!.data as Partial<LinkData>).sourcePortLabel).toBe('Gi1/0/9');
  });

  it('keeps two genuinely different devices apart', () => {
    // The join must not over-merge: different address, different name.
    const swept = sweptNode('a', '192.168.77.7', '192.168.77.7');
    const t = buildTopology(
      { devices: [device('OTHER-SW', '192.168.77.8', [])], notVisited: [] },
      'p',
      { existingNodes: [swept] as never },
    );
    expect(labels(t)).toEqual(['OTHER-SW']);
  });
});

describe('a stack is visible on the device (LT-148)', () => {
  const member = (id: string, role: string, serial: string | null) => ({
    id, role, state: null, model: null, serial, mac: null, priority: null,
  });
  const stackOf = (kind: string, members: ReturnType<typeof member>[], unverified = true) => ({
    kind, members, peer: null, interSwitchLink: null, peerReachable: null, unverified,
  });

  it('puts every member and its serial on the device', () => {
    // A stack is one device on a diagram and four boxes an RMA is raised
    // against, so each member has to keep its own number.
    const got = stackFields(
      stackOf('stack-wise', [
        member('1', 'active', 'FOC0000TEST'),
        member('2', 'standby', 'FOC0000TES2'),
      ]) as never,
    );
    expect(got.stackKind).toBe('StackWise');
    expect(got.stackMembers).toBe('1 active FOC0000TEST\n2 standby FOC0000TES2');
    expect(got.stackUnverified).toBe(true);
  });

  it('names each technology the way its vendor does', () => {
    const kind = (k: string) => stackFields(stackOf(k, [member('1', 'a', null)]) as never).stackKind;
    expect(kind('vsx')).toBe('VSX');
    expect(kind('vsf')).toBe('VSF');
    expect(kind('stack-wise-virtual')).toBe('StackWise Virtual');
    expect(kind('virtual-chassis')).toBe('Virtual Chassis');
    expect(kind('forti-link-stack')).toBe('FortiLink stack');
  });

  it('still lists members whose serial it could not read', () => {
    // "Two chassis and I could not read their serials" is a different and
    // more useful statement than nothing at all.
    const got = stackFields(
      stackOf('vsx', [member('local', 'primary', null), member('peer', 'secondary', null)]) as never,
    );
    expect(got.stackMembers).toBe('local primary\npeer secondary');
  });

  it('says nothing at all for a device that is one box', () => {
    // Which is most of them, and an empty badge on every switch would be
    // worse than no badge.
    expect(stackFields(null)).toEqual({});
    expect(stackFields(undefined)).toEqual({});
    expect(stackFields(stackOf('stack-wise', []) as never)).toEqual({});
  });

  it('carries the unverified flag through, because the parsers are guesses', () => {
    // D-026: every stacking parser was written from vendor documentation and
    // has met no hardware. The interface must be able to say so.
    const unverified = stackFields(stackOf('vsf', [member('1', 'conductor', null)], true) as never);
    const proven = stackFields(stackOf('vsf', [member('1', 'conductor', null)], false) as never);
    expect(unverified.stackUnverified).toBe(true);
    expect(proven.stackUnverified).toBe(false);
  });

  it('reaches the device through a crawl', () => {
    const t = buildTopology(
      {
        devices: [
          device('CORE-SW', '10.0.0.1', [], {
            stack: stackOf('stack-wise', [
              member('1', 'active', 'FOC1'),
              member('2', 'member', 'FOC2'),
            ]),
          } as never),
        ],
        notVisited: [],
      },
      'p',
    );
    const d = t.nodes[0]!.data as DeviceNodeData;
    expect(d.stackKind).toBe('StackWise');
    expect(d.stackMembers).toContain('FOC2');
    expect(d.stackUnverified).toBe(true);
  });
});

describe('a chassis pair draws as two chassis (LT-140)', () => {
  const svl = {
    kind: 'stack-wise-virtual',
    members: [{ id: '1', role: null, state: null, model: null, serial: 'FOC1', mac: null, priority: null },
              { id: '2', role: null, state: null, model: null, serial: 'FOC2', mac: null, priority: null }],
    peer: null,
    interSwitchLink: 'HundredGigE1/0/25',
    peerReachable: null,
    unverified: true,
  };

  it('splits one crawled device into two switches joined by the SVL', () => {
    const t = buildTopology(
      { devices: [device('CORE-SW', '10.0.0.1', [], { stack: svl } as never)], notVisited: [] },
      'p',
    );
    // One management plane, two chassis.
    expect(labels(t)).toEqual(['CORE-SW (1)', 'CORE-SW (2)']);
    const isl = t.edges.find((e) => (e.data as Partial<LinkData>).label === 'HundredGigE1/0/25');
    expect(isl, `no ISL drawn: ${JSON.stringify(t.edges)}`).toBeTruthy();
  });

  it('gives the second chassis no address of its own', () => {
    // The pair answers on one address. Two probes on one box would call a
    // dead chassis healthy.
    const t = buildTopology(
      { devices: [device('CORE-SW', '10.0.0.1', [], { stack: svl } as never)], notVisited: [] },
      'p',
    );
    const second = t.nodes.find((n) => (n.data as DeviceNodeData).label === 'CORE-SW (2)');
    expect((second!.data as DeviceNodeData).addresses).toEqual([]);
    expect((second!.data as DeviceNodeData).serial).toBe('FOC2');
  });

  it('lands a downstream link on the chassis whose port it is really on', () => {
    // Cisco numbers a port by its member, which is the only non-guesswork
    // way to say which half a cable is plugged into.
    const t = buildTopology(
      {
        devices: [
          device('CORE-SW', '10.0.0.1', [neighbor('ACC-SW1', 'Te2/0/1', 'Gi0/1')], {
            stack: svl,
          } as never),
          device('ACC-SW1', '10.0.0.2', [], { hops: 1 }),
        ],
        notVisited: [],
      },
      'p',
    );
    const second = t.nodes.find((n) => (n.data as DeviceNodeData).label === 'CORE-SW (2)')!;
    const downstream = t.edges.find(
      (e) => (e.data as Partial<LinkData>).sourcePortLabel === 'Te2/0/1',
    );
    expect(downstream, 'the neighbour link was not drawn').toBeTruthy();
    expect(
      downstream!.source === second.id || downstream!.target === second.id,
      'the link landed on the wrong chassis',
    ).toBe(true);
  });

  it('reads the member number out of an interface name', () => {
    expect(chassisOfPort('HundredGigE1/0/25')).toBe('1');
    expect(chassisOfPort('TenGigabitEthernet2/0/1')).toBe('2');
    expect(chassisOfPort('Gi1/0/11')).toBe('1');
    // No member number in these, so nothing may be inferred.
    expect(chassisOfPort('Port 4')).toBeNull();
    expect(chassisOfPort('lag1')).toBeNull();
    expect(chassisOfPort(null)).toBeNull();
  });

  it('does not split a VSX pair, which is already two devices', () => {
    // Each half of a VSX pair is its own SSH target, so a crawl reached them
    // separately. Splitting would invent two more switches.
    const vsx = { ...svl, kind: 'vsx', interSwitchLink: 'lag256' };
    const t = buildTopology(
      { devices: [device('AGG-1', '10.0.0.1', [], { stack: vsx } as never)], notVisited: [] },
      'p',
    );
    expect(labels(t)).toEqual(['AGG-1']);
  });

  it('does not split a plain stack, which really is one switch', () => {
    const stack = { ...svl, kind: 'stack-wise' };
    const t = buildTopology(
      { devices: [device('ACC-SW', '10.0.0.1', [], { stack } as never)], notVisited: [] },
      'p',
    );
    expect(labels(t)).toEqual(['ACC-SW']);
  });

  it('draws each half of a split pair as one box, and a plain stack as stacked (LT-159)', () => {
    const t = buildTopology(
      { devices: [device('CORE-SW', '10.0.0.1', [], { stack: svl } as never)], notVisited: [] },
      'p',
    );
    expect(t.nodes).toHaveLength(2);
    for (const n of t.nodes) expect(drawsStacked(n.data as DeviceNodeData)).toBe(false);
    // Each half still lists the pair's members.
    for (const n of t.nodes) expect((n.data as DeviceNodeData).stackMembers).toBeTruthy();

    const plain = buildTopology(
      { devices: [device('ACC-SW', '10.0.0.1', [], { stack: { ...svl, kind: 'stack-wise' } } as never)], notVisited: [] },
      'p',
    );
    expect(drawsStacked(plain.nodes[0]!.data as DeviceNodeData)).toBe(true);
  });
});

describe('direction comes from the default route (LT-131)', () => {
  it('points a link the way the device says it forwards', () => {
    // ACC-SW1 sends unknown traffic to 10.0.0.1, which is CORE-SW. So the
    // arrow leaves the access switch towards the core, which is what an
    // operator draws by hand.
    const t = buildTopology(
      {
        devices: [
          device('CORE-SW', '10.0.0.1', [neighbor('ACC-SW1', 'Gi1/0/1', 'Gi0/1')]),
          device('ACC-SW1', '10.0.0.2', [], { hops: 1, defaultNextHop: '10.0.0.1' } as never),
        ],
        notVisited: [],
      },
      'p',
    );
    expect(t.edges).toHaveLength(1);
    const d = t.edges[0]!.data as Partial<LinkData>;
    // The link is drawn CORE-SW -> ACC-SW1, so traffic flowing the other way
    // is 'reverse'.
    expect(d.direction).toBe('reverse');
  });

  it('leaves a link undirected when nothing said which way is out', () => {
    // A guessed arrow is worse than none: it reads as fact.
    const t = buildTopology(
      {
        devices: [
          device('CORE-SW', '10.0.0.1', [neighbor('ACC-SW1', 'Gi1/0/1', 'Gi0/1')]),
          device('ACC-SW1', '10.0.0.2', [], { hops: 1 }),
        ],
        notVisited: [],
      },
      'p',
    );
    expect((t.edges[0]!.data as Partial<LinkData>).direction).toBeUndefined();
  });

  it('ignores a next hop that is not a device on the diagram', () => {
    // The gateway out of the estate is usually not something we crawled.
    const t = buildTopology(
      {
        devices: [
          device('CORE-SW', '10.0.0.1', [neighbor('ACC-SW1', 'Gi1/0/1', 'Gi0/1')], {
            defaultNextHop: '203.0.113.1',
          } as never),
          device('ACC-SW1', '10.0.0.2', [], { hops: 1 }),
        ],
        notVisited: [],
      },
      'p',
    );
    expect((t.edges[0]!.data as Partial<LinkData>).direction).toBeUndefined();
  });
});

describe('link style is the document default (LT-130)', () => {
  it('a discovered link names no path type, so the default reaches it', () => {
    // Naming it here is exactly how every crawled link came out smooth-step
    // however the document default was set. `store.addEdge` fills these in.
    const t = buildTopology(
      {
        devices: [
          device('CORE-SW', '10.0.0.1', [neighbor('ACC-SW1', 'Gi1/0/1', 'Gi0/1')]),
          device('ACC-SW1', '10.0.0.2', [], { hops: 1 }),
        ],
        notVisited: [],
      },
      'p',
    );
    const d = t.edges[0]!.data as Partial<LinkData>;
    expect(d.pathType).toBeUndefined();
    expect(d.direction).toBeUndefined();
    expect(d.color).toBeUndefined();
    // What the link actually means is still stated.
    expect(d.sourcePortLabel).toBe('Gi1/0/1');
    expect(d.healthRule).toEqual({ type: 'both-endpoints' });
  });

  it('an attached-device link leaves its style to the default too', () => {
    const a = attached('aabb.ccdd.eeff', 'Gi1/0/9', { hostname: 'NEW-BOX' });
    const t = buildTopology(
      { devices: [device('ACC-SW1', '10.0.0.2', [], { attached: [a] })], notVisited: [] },
      'p',
      { attached: [{ device: a, host: 'ACC-SW1' }], existingNodes: [] },
    );
    const cable = t.edges.find((e) => (e.data as Partial<LinkData>).sourcePortLabel === 'Gi1/0/9');
    expect(cable).toBeTruthy();
    expect((cable!.data as Partial<LinkData>).pathType).toBeUndefined();
  });
});

describe('joining a sweep to a crawl', () => {
  // ---------------------------------------------------------------- LT-126
  //
  // The operator's report: "the cdp/lldp crowler and the sweep don't really
  // build the diagram like they are disconnected". A sweep places hosts; a
  // crawl learns which switch port each MAC is on; the two never met, so the
  // crawl drew a second box and left the swept one floating.

  it('wires a host the sweep already placed to the port the switch learned it on', () => {
    const swept = sweptNode('host-1', 'LabDesktop01', '192.168.77.129', '74:56:3c:00:00:01');
    const t = buildTopology(
      {
        devices: [
          device('ACC-SW1', '192.168.77.7', [], {
            // Cisco's spelling of the same address the sweep read as colons.
            attached: [attached('7456.3c00.0001', 'GigabitEthernet1/0/11')],
          }),
        ],
        notVisited: [],
      },
      'p',
      {
        attached: [{ device: attached('7456.3c00.0001', 'GigabitEthernet1/0/11'), host: 'ACC-SW1' }],
        existingNodes: [swept] as never,
      },
    );

    // No second box for a host that is already on the diagram.
    expect(labels(t)).toEqual(['ACC-SW1']);

    // And it is now cabled to the port it is really on.
    const cable = t.edges.find((e) => e.target === 'host-1' || e.source === 'host-1');
    expect(cable, `no link to the swept host: ${JSON.stringify(t.edges)}`).toBeTruthy();
    expect((cable!.data as LinkData).sourcePortLabel).toBe('Gi1/0/11');
  });

  it('matches on the address when the sweep never learned a MAC', () => {
    // A host behind a router has no ARP entry here, so the sweep has no MAC
    // for it — the address is then the strongest thing the two share.
    const swept = sweptNode('host-2', 'printer-3f', '10.20.0.44');
    const a = attached('0011.2233.4455', 'Gi1/0/5', { address: '10.20.0.44' });
    const t = buildTopology(
      { devices: [device('ACC-SW1', '10.0.0.2', [], { attached: [a] })], notVisited: [] },
      'p',
      { attached: [{ device: a, host: 'ACC-SW1' }], existingNodes: [swept] as never },
    );
    expect(labels(t)).toEqual(['ACC-SW1']);
    expect(t.edges.some((e) => e.target === 'host-2' || e.source === 'host-2')).toBe(true);
    // The MAC is written back, so the next crawl matches on it directly even
    // if DHCP has moved the address on.
    expect(t.updated.find((u) => u.id === 'host-2')?.data.mac).toBe('0011.2233.4455');
  });

  it('still draws a host the diagram has never seen', () => {
    // The join must not swallow genuinely new devices.
    const a = attached('aabb.ccdd.eeff', 'Gi1/0/9', { hostname: 'NEW-BOX' });
    const t = buildTopology(
      { devices: [device('ACC-SW1', '10.0.0.2', [], { attached: [a] })], notVisited: [] },
      'p',
      { attached: [{ device: a, host: 'ACC-SW1' }], existingNodes: [] },
    );
    expect(labels(t)).toEqual(['ACC-SW1', 'NEW-BOX']);
    // A new one carries its MAC from the start, so the next run recognises it.
    const box = t.nodes.find((n) => (n.data as DeviceNodeData).label === 'NEW-BOX');
    expect((box!.data as DeviceNodeData).mac).toBe('aabb.ccdd.eeff');
  });

  it('does not cable the same host to the same port twice on a re-crawl', () => {
    // Running discovery again is meant to update the diagram, not stack a
    // second cable on every one already drawn.
    const swept = sweptNode('host-1', 'LabDesktop01', '192.168.77.129', '74:56:3c:00:00:01');
    const a = attached('7456.3c00.0001', 'Gi1/0/11');
    const first = buildTopology(
      { devices: [device('ACC-SW1', '192.168.77.7', [], { attached: [a] })], notVisited: [] },
      'p',
      { attached: [{ device: a, host: 'ACC-SW1' }], existingNodes: [swept] as never },
    );
    const switchNode = first.nodes.find((n) => (n.data as DeviceNodeData).label === 'ACC-SW1')!;
    const cable = first.edges.find((e) => e.target === 'host-1' || e.source === 'host-1')!;

    const second = buildTopology(
      { devices: [device('ACC-SW1', '192.168.77.7', [], { attached: [a] })], notVisited: [] },
      'p',
      {
        attached: [{ device: a, host: 'ACC-SW1' }],
        existingNodes: [swept, switchNode] as never,
        existingEdges: [cable] as never,
      },
    );
    expect(second.edges.some((e) => e.target === 'host-1' || e.source === 'host-1')).toBe(false);
  });

  it('reads a MAC however each side spells it', () => {
    // Cisco, the ARP table and Windows all write the same address differently.
    expect(macKey('7456.3c00.0001')).toBe('74563c000001');
    expect(macKey('74:56:3c:00:00:01')).toBe('74563c000001');
    expect(macKey('74-56-3C-00-00-01')).toBe('74563c000001');
    expect(macKey('not a mac')).toBeNull();
    expect(macKey('')).toBeNull();
    expect(macKey(null)).toBeNull();
    // Too short is not a MAC with the separators stripped out.
    expect(macKey('74:56:3c')).toBeNull();
  });

  it('offers every identifier a node carries, strongest first', () => {
    const n = sweptNode('host-1', 'LabDesktop01', '192.168.77.129', '74:56:3c:00:00:01');
    expect(identitiesOfNode(n as never)).toEqual([
      'm:74563c000001',
      'a:192.168.77.129',
      'n:labdesktop01',
    ]);
    // A node with nothing but a name is still findable by it.
    const bare = sweptNode('host-3', 'Lonely', '');
    (bare.data as DeviceNodeData).addresses = [];
    expect(identitiesOfNode(bare as never)).toEqual(['n:lonely']);
  });
});
