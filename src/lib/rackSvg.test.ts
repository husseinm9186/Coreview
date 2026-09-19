import { describe, expect, it } from 'vitest';

import { rackElevationSvg } from './rackSvg';

describe('rack elevation export (LT-195, LT-197)', () => {
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
    expect(svg.match(/<(?!\/?(svg|defs|pattern|line|rect|text)\b)/g)).toBeNull();
    expect(svg.match(/&(?!amp;|lt;|gt;|quot;)/g)).toBeNull();
    expect((svg.match(/<text\b/g) ?? []).length).toBe((svg.match(/<\/text>/g) ?? []).length);
  });
});
