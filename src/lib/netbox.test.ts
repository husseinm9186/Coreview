import { describe, expect, it } from 'vitest';

import { readNetbox, typeFromRole } from './netbox';

// Invented records in the shape NetBox's serializers write.
const devices = {
  count: 2, next: null, previous: null,
  results: [
    {
      id: 1, url: 'https://netbox.example.test/api/dcim/devices/1/', display: 'CORE-SW1', name: 'CORE-SW1',
      device_type: { id: 3, display: 'C9300-48P', manufacturer: { id: 1, display: 'Cisco', name: 'Cisco', slug: 'cisco' }, model: 'C9300-48P', slug: 'c9300-48p' },
      role: { id: 2, display: 'Core Switch', name: 'Core Switch', slug: 'core-switch' },
      platform: null, serial: 'FOC0000X0AA', asset_tag: 'A-100',
      site: { id: 1, display: 'Lab', name: 'Lab', slug: 'lab' },
      rack: { id: 4, display: 'R01', name: 'R01' }, position: 42.0, face: { value: 'front', label: 'Front' },
      primary_ip: { id: 9, family: { value: 4, label: 'IPv4' }, address: '192.0.2.10/24' },
      primary_ip4: { id: 9, family: { value: 4, label: 'IPv4' }, address: '192.0.2.10/24' },
      tags: [{ id: 1, name: 'core', slug: 'core' }], comments: '', description: 'Main core',
    },
    {
      id: 2, display: 'EDGE-RTR1', name: 'EDGE-RTR1',
      device_type: { model: 'ISR4331', manufacturer: { name: 'Cisco' } },
      device_role: { name: 'Router' }, site: { name: 'Lab' }, rack: null, position: null,
      primary_ip4: null, serial: '', tags: [],
    },
  ],
};

const cables = [
  {
    id: 7, display: '#7', type: 'cat6', label: 'C-0007',
    a_terminations: [{ object_type: 'dcim.interface', object_id: 11, object: { id: 11, display: 'Gi1/0/1', device: { id: 1, display: 'CORE-SW1', name: 'CORE-SW1' }, name: 'Gi1/0/1', cable: 7 } }],
    b_terminations: [{ object_type: 'dcim.interface', object_id: 21, object: { id: 21, display: 'Gi0/0/0', device: { id: 2, display: 'EDGE-RTR1', name: 'EDGE-RTR1' }, name: 'Gi0/0/0', cable: 7 } }],
  },
  // Before 3.3: one termination a side.
  { id: 8, label: '', termination_a_type: 'dcim.interface', termination_a: { device: { name: 'CORE-SW1' }, name: 'Gi1/0/2' }, termination_b_type: 'dcim.interface', termination_b: { device: { name: 'EDGE-RTR1' }, name: 'Gi0/0/1' } },
  { id: 9, label: 'to-circuit', a_terminations: [{ object_type: 'circuits.circuittermination', object: { id: 3, display: 'CID-1: Termination A' } }], b_terminations: [] },
];

describe('NetBox from a file (LT-247)', () => {
  it('reads an API list response of devices', () => {
    const r = readNetbox(JSON.stringify(devices));
    expect(r.devices).toHaveLength(2);
    expect(r.devices[0]).toMatchObject({
      name: 'CORE-SW1', type: 'core-switch', address: '192.0.2.10', vendor: 'Cisco', model: 'C9300-48P', serial: 'FOC0000X0AA',
      assetTag: 'A-100', role: 'Core Switch', site: 'Lab', rack: 'R01', rackU: 42, tags: ['core'], notes: 'Main core',
    });
    expect(r.devices[1]).toMatchObject({ name: 'EDGE-RTR1', type: 'router', address: '', role: 'Router' });
  });

  it('reads cables of either generation, and says which it could not', () => {
    const r = readNetbox(JSON.stringify(cables));
    expect(r.links).toEqual([
      { source: 'CORE-SW1', target: 'EDGE-RTR1', sourcePort: 'Gi1/0/1', targetPort: 'Gi0/0/0', label: 'C-0007', healthRule: 'both-endpoints' },
      { source: 'CORE-SW1', target: 'EDGE-RTR1', sourcePort: 'Gi1/0/2', targetPort: 'Gi0/0/1', label: '', healthRule: 'both-endpoints' },
    ]);
    expect(r.problems).toEqual(['Cable to-circuit does not end on a device at both sides; skipped.']);
  });

  it('reads a combined file in YAML, filling an address from ip_addresses', () => {
    const yaml = `
devices:
  - name: ACCESS-SW7
    device_type: { model: C9200L-24P, manufacturer: { name: Cisco } }
    role: { name: Access Switch }
    site: { name: Lab }
    primary_ip4: null
ip_addresses:
  - address: 192.0.2.7/24
    assigned_object_type: dcim.interface
    assigned_object: { name: Vlan1, device: { name: ACCESS-SW7 } }
cables:
  results: []
`;
    const r = readNetbox(yaml);
    expect(r.devices).toEqual([expect.objectContaining({ name: 'ACCESS-SW7', type: 'access-switch', address: '192.0.2.7', model: 'C9200L-24P' })]);
    expect(r.problems).toEqual([]);
  });

  it('refuses what is not NetBox, plainly', () => {
    expect(readNetbox('{"hello": 1').problems[0]).toMatch(/neither JSON nor YAML/);
    expect(readNetbox('[{"a": 1}]').problems[0]).toMatch(/No NetBox devices or cables/);
  });

  it('chooses a glyph from the words in a role', () => {
    expect(typeFromRole('Perimeter Firewall')).toBe('firewall');
    expect(typeFromRole('Wireless AP')).toBe('access-point');
    expect(typeFromRole('Leaf')).toBe('l2-switch');
    expect(typeFromRole('', 'ISR4331 router')).toBe('router');
    expect(typeFromRole('Something else')).toBe('generic');
  });
});
