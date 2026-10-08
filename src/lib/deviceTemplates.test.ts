import { describe, expect, it } from 'vitest';

import { GENERIC_TEMPLATES, deviceFieldsFrom, templateFromNetboxYaml } from './deviceTemplates';

describe('the generic templates', () => {
  it('each has a whole height, a depth and a class or a kind, and ids are unique', () => {
    const ids = new Set<string>();
    for (const t of GENERIC_TEMPLATES) {
      expect(Number.isInteger(t.units)).toBe(true);
      expect(['full', 'half']).toContain(t.depth);
      expect(t.deviceType || t.furniture).toBeTruthy();
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
    }
    expect(GENERIC_TEMPLATES.length).toBeGreaterThanOrEqual(24);
  });

  it('applying one sets the rack fields a device has', () => {
    const t = GENERIC_TEMPLATES.find((x) => x.id === 'sw-48-poe-1u')!;
    expect(deviceFieldsFrom(t)).toEqual({ rackUnits: 1, rackDepth: 'half', depthMm: 400, portCount: 48, portNaming: 'Gi1/0/{n}', powerW: 740, weightKg: 7, airflow: 'front-to-back' });
  });
});

// A device type in the shape the NetBox devicetype-library uses, with
// invented names — nothing from the library itself is here.
const YAML = `---
manufacturer: Example Networks
model: EX-48P
slug: example-networks-ex-48p
part_number: EX-48P-R
u_height: 1
is_full_depth: false
airflow: front-to-rear
weight: 12.5
weight_unit: lb
console-ports:
  - name: console
    type: rj-45
power-ports:
  - name: PS1
    type: iec-60320-c14
    maximum_draw: 350
  - name: PS2
    type: iec-60320-c14
    maximum_draw: 350
interfaces:
  - name: GigabitEthernet1/0/1
    type: 1000base-t
  - name: GigabitEthernet1/0/2
    type: 1000base-t
  - name: TenGigabitEthernet1/1/1
    type: 10gbase-x-sfpp
`;

describe('a NetBox device type', () => {
  it('reads the rack\'s fields: height, depth, airflow, weight in kilograms, supplies and their draw, ports and their naming', () => {
    const r = templateFromNetboxYaml(YAML, 'nb-1');
    expect('template' in r).toBe(true);
    const t = ('template' in r ? r.template : null)!;
    expect(t).toMatchObject({ id: 'nb-1', name: 'Example Networks EX-48P', source: 'netbox', manufacturer: 'Example Networks', model: 'EX-48P', partNumber: 'EX-48P-R', units: 1, depth: 'half', airflow: 'front-to-back', weightKg: 5.7, psus: 2, powerW: 700, ports: 3, portNaming: 'GigabitEthernet1/0/{n}' });
    expect(t.deviceType).toBe('l3-switch');
  });

  it('rounds a half-U height up, and knows a PDU by its outlets', () => {
    const pdu = templateFromNetboxYaml('manufacturer: X\nmodel: Strip 8\nu_height: 0.5\npower-outlets:\n  - name: 1\n  - name: 2\n', 'nb-2');
    expect('template' in pdu && pdu.template).toMatchObject({ units: 1, furniture: 'pdu', outlets: 2 });
  });

  it('says what is wrong with a file that is not a device type', () => {
    expect(templateFromNetboxYaml('just: words', 'x')).toEqual({ problem: expect.stringMatching(/no "model"/) });
    expect(templateFromNetboxYaml('- a\n- b', 'x')).toEqual({ problem: expect.stringMatching(/one YAML document/) });
    expect(templateFromNetboxYaml('a: [unclosed', 'x')).toEqual({ problem: expect.stringMatching(/not YAML/) });
  });
});
