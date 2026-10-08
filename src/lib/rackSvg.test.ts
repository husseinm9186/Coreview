import { describe, expect, it } from 'vitest';

import { rackElevationSvg } from './rackSvg';

describe('rack elevation export', () => {
  const racks = [{ id: 'r', name: 'Rack <A>', units: 4 }];
  const devices = [
    { id: 'sw', label: 'SW & 1', rack: 'Rack <A>', rackUnits: 1, rackU: 4 },
    { id: 'srv', label: 'SRV', rack: 'Rack <A>', rackUnits: 2, rackU: 1, rackFace: 'rear' as const },
    { id: 'pdu', label: 'PDU', rack: 'Rack <A>', rackUnits: 0 },
  ];

  it('draws each rack with its U numbers and the devices on that face', () => {
    const svg = rackElevationSvg(racks, devices, 'front');
    expect(svg).toContain('Rack &lt;A&gt;');
    expect(svg).toContain('SW &amp; 1');
    for (const u of [1, 2, 3, 4]) expect(svg).toContain(`>${u}</text>`);
    expect(svg).toContain('SRV (rear)');
    expect(svg).toContain('url(#behind)');
    expect(svg).toContain('Zero-U: PDU');
  });

  it('draws the rear with the rear-mounted box as seen and the front one behind', () => {
    const svg = rackElevationSvg(racks, devices, 'rear');
    expect(svg).toContain('>SRV</text>');
    expect(svg).toContain('SW &amp; 1 (rear)');
    expect(svg).toContain('4U · rear');
  });

  it('escapes what it writes, so names cannot break the file', () => {
    const svg = rackElevationSvg(racks, devices, 'front');
    // Every < opens a known tag, and every & starts an entity.
    expect(svg.match(/<(?!\/?(svg|defs|pattern|line|rect|text|path|title|circle)\b)/g)).toBeNull();
    expect(svg.match(/&(?!amp;|lt;|gt;|quot;)/g)).toBeNull();
    expect((svg.match(/<text\b/g) ?? []).length).toBe((svg.match(/<\/text>/g) ?? []).length);
  });
});

describe('cables in the export', () => {
  const racks = [{ id: 'r', name: 'R1', units: 6, items: [{ id: 'pdu', kind: 'pdu-vertical' as const, label: 'PDU A', units: 0, face: 'rear' as const, outlets: 8 }] }];
  const devices = [
    { id: 'sw', label: 'SW', rack: 'R1', rackUnits: 1, rackU: 6, kind: 'device' as const, deviceType: 'access-switch', portCount: 24, powerFeeds: [{ pduId: 'pdu', outlet: 2 }] },
    { id: 'fw', label: 'FW', rack: 'R1', rackUnits: 1, rackU: 4, kind: 'device' as const, deviceType: 'firewall', portCount: 8 },
    { id: 'srv', label: 'SRV', rack: 'R2', rackUnits: 1, rackU: 1, kind: 'device' as const },
  ];
  const links = [
    { id: 'e1', source: 'sw', target: 'fw', sourcePortLabel: 'Gi1/0/24', targetPortLabel: 'port1', cableType: 'copper' },
    { id: 'e2', source: 'sw', target: 'srv', sourcePortLabel: 'Gi1/0/1', targetPortLabel: 'eth0' },
  ];

  it('draws the front with port ticks, a cable between two ports, and a stub to another rack', () => {
    const svg = rackElevationSvg(racks, devices, 'front', { links });
    expect(svg).toContain('<title>SW Gi1/0/24 ↔ FW port1</title>');
    expect(svg).toContain('→ SRV, R2');
    expect((svg.match(/<rect [^>]*fill="#6b7a8c"/g) ?? []).length).toBeGreaterThanOrEqual(24 + 8);
  });

  it('draws the rear with the cord from the supply to the PDU outlet', () => {
    const svg = rackElevationSvg(racks, devices, 'rear', { links });
    expect(svg).toContain('<title>SW supply A → PDU A outlet 2</title>');
    expect(svg).not.toContain('SW Gi1/0/24');
  });
});
