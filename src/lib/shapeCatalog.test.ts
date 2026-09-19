import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEVICE_LABEL, ICONS, PALETTE_GROUPS } from '../components/icons';
import { SHAPE_DEVICE_TYPES, type DeviceType } from '../types/domain';
import {
  MAX_PORT_NAMES,
  SHAPE_DEFAULTS,
  STENCIL_CLASSES,
  isStencilClass,
  portNames,
  shapeDefaultFields,
} from './shapeCatalog';

const ALL = Object.keys(DEVICE_LABEL) as DeviceType[];

describe('the built-in shapes (LT-163–165)', () => {
  it('offers the classes the parity mission asks for', () => {
    for (const t of [
      'router', 'l3-switch', 'l2-switch', 'firewall', 'wireless-controller', 'access-point', 'ip-phone',
      'blade-chassis', 'load-balancer', 'waf', 'internet', 'mpls-cloud', 'vpn', 'cloud', 'rack',
      'patch-panel', 'pdu', 'ups', 'server', 'vm-host', 'storage',
    ] as DeviceType[]) {
      expect(ALL, t).toContain(t);
    }
  });

  it('gives every class a glyph of its own and a place in the palette', () => {
    const placed = PALETTE_GROUPS.flatMap((g) => g.items);
    for (const t of ALL) {
      expect(ICONS[t], t).toBeTypeOf('function');
      expect(placed.filter((x) => x === t), t).toHaveLength(1);
    }
  });

  it('draws no two device classes with the same glyph', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const seen = new Map<string, DeviceType>();
    // `cloud` is the plain shape the private cloud's outline also uses on
    // purpose; everything else must be told apart at a glance.
    for (const t of ALL.filter((x) => x !== 'cloud')) {
      const markup = renderToStaticMarkup(ICONS[t]({}));
      expect(seen.get(markup), `${t} draws the same as ${seen.get(markup)}`).toBeUndefined();
      seen.set(markup, t);
    }
  });

  it('names no vendor in any label (D-028)', () => {
    const vendors = /cisco|juniper|arista|palo alto|fortinet|forti|f5|check point|ubiquiti|unifi|mikrotik|catalyst|nexus/i;
    for (const t of ALL) expect(DEVICE_LABEL[t], t).not.toMatch(vendors);
  });
});

describe('what a dropped shape brings (LT-171)', () => {
  let n = 0;
  const id = () => `id-${++n}`;

  it('gives a switch its ports, rack height and an empty management address', () => {
    const f = shapeDefaultFields('l2-switch', id);
    expect(f.portCount).toBe(24);
    expect(f.portNaming).toBe('Port {n}');
    expect(f.rackUnits).toBe(1);
    expect(f.addresses).toEqual([{ id: expect.any(String), label: 'Management', address: '', isPrimary: true }]);
  });

  it('gives a patch panel ports but nothing to manage', () => {
    const f = shapeDefaultFields('patch-panel', id);
    expect(f.portCount).toBe(24);
    expect(f.addresses).toEqual([]);
  });

  it('records a zero-U PDU as 0, not as unset', () => {
    expect(shapeDefaultFields('pdu', id).rackUnits).toBe(0);
  });

  it('leaves a plain shape with nothing extra', () => {
    const f = shapeDefaultFields('rectangle', id);
    expect(f).toEqual({ addresses: [] });
  });

  it('uses only generic port names, never a vendor scheme (D-028)', () => {
    for (const [t, d] of Object.entries(SHAPE_DEFAULTS)) {
      expect(d.portNaming ?? '{n}', t).toContain('{n}');
      expect(d.portNaming ?? '', t).not.toMatch(/Gi|Te|Eth|ge-|xe-|port\d|\//);
    }
  });
});

describe('port names', () => {
  it('numbers the ports by the naming', () => {
    expect(portNames({ portCount: 3, portNaming: 'Port {n}' })).toEqual(['Port 1', 'Port 2', 'Port 3']);
    expect(portNames({ portCount: 2, portNaming: 'ge-0/0/{n}' })).toEqual(['ge-0/0/1', 'ge-0/0/2']);
  });

  it('offers nothing it cannot name properly', () => {
    expect(portNames(undefined)).toEqual([]);
    expect(portNames({ portCount: 4 })).toEqual([]);
    expect(portNames({ portCount: 4, portNaming: 'Uplink' })).toEqual([]);
    expect(portNames({ portCount: 0, portNaming: 'Port {n}' })).toEqual([]);
    expect(portNames({ portCount: 2.5, portNaming: 'Port {n}' })).toEqual([]);
  });

  it('stops at a sane number', () => {
    expect(portNames({ portCount: 10_000, portNaming: '{n}' })).toHaveLength(MAX_PORT_NAMES);
  });
});

describe('the classes a stencil manifest may name (LT-169)', () => {
  it('are every device type but the plain drawing shapes and a bare image', () => {
    const expected = ALL.filter((t) => !SHAPE_DEVICE_TYPES.has(t) && t !== 'custom-image').sort();
    expect([...STENCIL_CLASSES].sort()).toEqual(expected);
  });

  it('are exactly the list Rust validates a manifest against', () => {
    const rust = readFileSync('src-tauri/src/stencil_manifest.rs', 'utf8');
    const block = /pub const CLASSES: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1] ?? '';
    const names = [...block.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(10);
    expect(names).toEqual([...STENCIL_CLASSES]);
  });

  it('knows a class from anything else', () => {
    expect(isStencilClass('router')).toBe(true);
    expect(isStencilClass('rectangle')).toBe(false);
    expect(isStencilClass('toaster')).toBe(false);
    expect(isStencilClass(undefined)).toBe(false);
  });
});

