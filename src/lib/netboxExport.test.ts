import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { netboxExport, netboxJson, netboxYaml } from './netboxExport';
import { readNetbox } from './netbox';
import { emptyDocument } from '../state/store';
import type { TopoEdge, TopoNode } from '../state/store';

// Invented, on documentation addresses (D-027).
const doc = () => {
  const d = emptyDocument();
  const core = {
    id: 'core', type: 'device', position: { x: 0, y: 0 },
    data: {
      label: 'CORE-SW1', deviceType: 'core-switch', vendor: 'Contoso Networks', model: 'CS-9000', serial: 'TEST0001',
      role: 'core', site: 'Head office', rack: 'R1', rackU: 20, tags: ['prod'], notes: 'Two PSUs.',
      addresses: [{ id: 'a1', label: 'Loopback0', address: '192.0.2.1', isPrimary: true }, { id: 'a2', label: 'Vlan10', address: '192.0.2.10', isPrimary: false }],
      inventory: {
        collectedAt: 0, routes: [], spanningTree: [],
        vlans: [{ id: 10, name: 'STAFF' }],
        ports: [
          { port: 'Gi1/0/1', status: 'connected', mode: 'trunk', vlan: 1, speed: '1000', duplex: 'full' },
          { port: 'Gi1/0/2', description: 'desk 12', status: 'notconnect', mode: 'access', vlan: 10 },
        ],
      },
    },
  } as unknown as TopoNode;
  const access = {
    id: 'acc', type: 'device', position: { x: 0, y: 200 },
    data: { label: 'ACCESS-SW7', deviceType: 'access-switch', tags: [], addresses: [{ id: 'b1', label: 'Discovered', address: '192.0.2.7', isPrimary: true }] },
  } as unknown as TopoNode;
  const sticky = { id: 'n1', type: 'note', position: { x: 0, y: 0 }, data: { label: 'remember' } } as unknown as TopoNode;
  const link = {
    id: 'l1', source: 'core', target: 'acc', type: 'live',
    data: { label: 'uplink', sourcePortLabel: 'Gi1/0/1', targetPortLabel: 'Gi0/24' },
  } as unknown as TopoEdge;
  const leader = { id: 'l2', source: 'core', target: 'acc', type: 'live', data: { kind: 'leader' } } as unknown as TopoEdge;
  d.pages[0]!.nodes = [core, access, sticky];
  d.pages[0]!.edges = [link, leader];
  return d;
};

describe('the NetBox export (LT-436)', () => {
  const meta = { name: 'Lab', site: 'Head office' };

  it('writes devices, interfaces, addresses, cables and VLANs in the API\'s own shape', () => {
    const out = netboxExport(doc(), meta, new Date(0));
    expect(out.devices.map((d) => d.name)).toEqual(['CORE-SW1', 'ACCESS-SW7']);
    expect(out.devices[0]).toMatchObject({
      device_type: { model: 'CS-9000', manufacturer: { name: 'Contoso Networks' } },
      role: { name: 'core' }, site: { name: 'Head office' }, rack: { name: 'R1' }, position: 20,
      serial: 'TEST0001', primary_ip4: { address: '192.0.2.1/32' }, tags: [{ name: 'prod' }],
    });
    // A device with nothing said about it claims nothing.
    expect(out.devices[1]).toMatchObject({ rack: null, asset_tag: null, device_type: { model: 'access-switch', manufacturer: null } });
    expect(out.interfaces.map(({ id, ...rest }) => (expect(id).toEqual(expect.any(Number)), rest))).toEqual([
      { device: { name: 'CORE-SW1' }, name: 'Gi1/0/1', enabled: true, speed: 1_000_000, mode: 'tagged' },
      { device: { name: 'CORE-SW1' }, name: 'Gi1/0/2', enabled: true, mode: 'access', untagged_vlan: { vid: 10 }, description: 'desk 12' },
    ]);
    expect(out.ip_addresses.map((a) => a.address)).toEqual(['192.0.2.1/32', '192.0.2.10/32', '192.0.2.7/32']);
    expect(out.cables).toHaveLength(1);
    expect(out.cables[0]).toMatchObject({
      label: 'uplink',
      a_terminations: [{ object: { device: { name: 'CORE-SW1' }, name: 'Gi1/0/1' } }],
      b_terminations: [{ object: { device: { name: 'ACCESS-SW7' }, name: 'Gi0/24' } }],
    });
    expect(out.vlans).toEqual([{ id: expect.any(Number), vid: 10, name: 'STAFF', site: { name: 'Head office' }, status: 'active' }]);
    const ids = [...out.devices, ...out.interfaces, ...out.ip_addresses, ...out.cables, ...out.vlans].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(out._coreview.exported).toBe('1970-01-01T00:00:00.000Z');
  });

  it('reads straight back in through the NetBox reader, in JSON and in YAML', () => {
    for (const text of [netboxJson(doc(), meta), netboxYaml(doc(), meta)]) {
      const back = readNetbox(text);
      expect(back.problems).toEqual([]);
      expect(back.devices.map((d) => [d.name, d.type, d.address, d.model, d.site, d.rackU])).toEqual([
        ['CORE-SW1', 'core-switch', '192.0.2.1', 'CS-9000', 'Head office', 20],
        ['ACCESS-SW7', 'access-switch', '192.0.2.7', 'access-switch', 'Head office', undefined],
      ]);
      expect(back.links).toEqual([
        { source: 'CORE-SW1', target: 'ACCESS-SW7', sourcePort: 'Gi1/0/1', targetPort: 'Gi0/24', label: 'uplink', healthRule: 'both-endpoints' },
      ]);
    }
    expect(parseYaml(netboxYaml(doc(), meta)).devices).toHaveLength(2);
  });
});
