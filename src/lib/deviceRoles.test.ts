import { describe, expect, it } from 'vitest';

import type { DeviceClassName } from './ipc';
import { INFRASTRUCTURE_CLASSES, isInfrastructure, roleCounts } from './deviceRoles';

const row = (klass: DeviceClassName) => ({ klass });

describe('choosing by role', () => {
  it('counts the network as infrastructure', () => {
    for (const k of ['router', 'switch', 'firewall', 'wireless-controller', 'access-point', 'server'] as const) {
      expect(isInfrastructure(k), k).toBe(true);
    }
  });

  it('counts what the network carries as not infrastructure', () => {
    for (const k of ['phone', 'camera', 'printer', 'endpoint'] as const) {
      expect(isInfrastructure(k), k).toBe(false);
    }
  });

  it('leaves an unidentified device out, because it is far more often a workstation', () => {
    expect(isInfrastructure('unknown')).toBe(false);
  });

  it('every class is decided one way or the other', () => {
    const all: DeviceClassName[] = [
      'router', 'switch', 'firewall', 'wireless-controller', 'access-point',
      'phone', 'camera', 'printer', 'server', 'endpoint', 'unknown',
    ];
    for (const k of all) expect(typeof isInfrastructure(k)).toBe('boolean');
    // And the list itself holds no class that is not a real one.
    for (const k of INFRASTRUCTURE_CLASSES) expect(all).toContain(k);
  });

  it('says how many each choice would tick before it is pressed', () => {
    const rows = [
      row('switch'), row('switch'), row('router'), row('firewall'),
      row('endpoint'), row('printer'), row('unknown'), row('phone'),
    ];
    expect(roleCounts(rows)).toEqual({ infrastructure: 4, everything: 8 });
  });

  it('an empty crawl offers nothing rather than a wrong number', () => {
    expect(roleCounts([])).toEqual({ infrastructure: 0, everything: 0 });
  });
});
