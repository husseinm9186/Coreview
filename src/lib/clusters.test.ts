import { describe, expect, it } from 'vitest';

import type { TopoEdge, TopoNode } from '../state/store';
import type { DeviceType, HealthStatus } from '../types/domain';
import {
  chipSummary,
  foldableRoles,
  holdersBelow,
  holdersOfRole,
  lowestHolders,
  roleOf,
  siteKeys,
  worstOf,
} from './clusters';

const device = (id: string, deviceType: DeviceType, over: Record<string, unknown> = {}): TopoNode =>
  ({
    id,
    type: 'device',
    position: { x: 0, y: 0 },
    data: { label: id, deviceType, tags: [], addresses: [], locked: false, maintenance: false, showDetails: true, ...over },
  }) as TopoNode;
const link = (source: string, target: string): TopoEdge => ({ id: `${source}-${target}`, source, target, data: {} }) as TopoEdge;

/** A core, a distribution switch, and `n` access switches under it. */
function fan(n: number) {
  const nodes = [device('core', 'core-switch'), device('dist', 'distribution-switch')];
  const edges = [link('core', 'dist')];
  for (let i = 0; i < n; i += 1) {
    nodes.push(device(`acc${i}`, 'access-switch'));
    edges.push(link('dist', `acc${i}`));
  }
  return { nodes, edges };
}

describe('holdersBelow', () => {
  it('names the devices with six or more below them, and what each holds', () => {
    const { nodes, edges } = fan(6);
    const holders = holdersBelow(nodes, edges);
    expect([...holders.keys()].sort()).toEqual(['core', 'dist']);
    expect(holders.get('dist')!.size).toBe(6);
    // The core holds the distribution switch and the fan.
    expect(holders.get('core')!.size).toBe(7);
  });

  it('leaves a fan of five alone', () => {
    const { nodes, edges } = fan(5);
    // The distribution switch holds five; the core holds it and the five.
    const holders = holdersBelow(nodes, edges);
    expect(holders.has('dist')).toBe(false);
    expect([...holders.keys()]).toEqual(['core']);
  });

  it('never counts a note', () => {
    const { nodes, edges } = fan(5);
    nodes.push({ id: 'memo', type: 'note', position: { x: 0, y: 0 }, data: { text: 'x' } } as unknown as TopoNode);
    edges.push(link('dist', 'memo'));
    expect(holdersBelow(nodes, edges).has('dist')).toBe(false);
  });
});

describe('lowestHolders', () => {
  it('keeps the holders nearest the leaves and not the ones above them', () => {
    const { nodes, edges } = fan(8);
    expect(lowestHolders(holdersBelow(nodes, edges))).toEqual(['dist']);
  });
});

describe('worstOf', () => {
  it('ranks down above warning above healthy, and unchecked last', () => {
    expect(worstOf(['healthy', 'warning'])).toBe('warning');
    expect(worstOf(['warning', 'down', 'healthy'])).toBe('down');
    expect(worstOf(['unknown', 'healthy'])).toBe('healthy');
    expect(worstOf([])).toBe('unknown');
  });
});

describe('roleOf', () => {
  it("takes the crawl's role over the glyph", () => {
    expect(roleOf({ deviceType: 'l2-switch', role: 'Core' })).toBe('core');
    expect(roleOf({ deviceType: 'l2-switch' })).toBe('access');
    expect(roleOf({ deviceType: 'generic' })).toBe('other');
    expect(roleOf({ deviceType: 'access-point' })).toBe('wireless');
  });
});

describe('chipSummary', () => {
  it('says the count, the role word and the worst of it', () => {
    const { nodes } = fan(12);
    const held = nodes.filter((n) => n.id.startsWith('acc'));
    const status = (id: string): HealthStatus => (id === 'acc1' || id === 'acc2' ? 'down' : id === 'acc3' ? 'warning' : 'healthy');
    const chip = chipSummary(held, status);
    expect(chip.text).toBe('12 access · 2 down · 1 warning');
    expect(chip.worst).toBe('down');
  });

  it('says devices for a mixed fan, and nothing about health nobody checked', () => {
    const held = [device('s1', 'server'), device('p1', 'printer'), device('a1', 'access-switch')];
    const chip = chipSummary(held, () => 'unknown');
    expect(chip.text).toBe('3 devices');
    expect(chip.worst).toBe('unknown');
  });

  it('uses the singular for one', () => {
    expect(chipSummary([device('a', 'access-point')], () => 'healthy').text).toBe('1 AP');
  });
});

describe('folding by role', () => {
  it('lists the roles with a fan to fold, lowest first, with their counts', () => {
    const { nodes, edges } = fan(7);
    // A second distribution switch with its own fan, and a core above both.
    nodes.push(device('dist2', 'distribution-switch'));
    edges.push(link('core', 'dist2'));
    for (let i = 0; i < 6; i += 1) {
      nodes.push(device(`b${i}`, 'access-switch'));
      edges.push(link('dist2', `b${i}`));
    }
    const holders = holdersBelow(nodes, edges);
    expect(foldableRoles(nodes, holders)).toEqual([{ role: 'distribution', holders: 2, devices: 13 }]);
    expect(holdersOfRole(nodes, holders, 'distribution')).toEqual(['dist', 'dist2']);
    expect(holdersOfRole(nodes, holders, 'core')).toEqual([]);
  });
});

describe('siteKeys', () => {
  it('folds by the site a device carries, and by group where it carries none', () => {
    const nodes = [
      device('a', 'router', { site: 'Branch 1' }),
      device('b', 'router', { site: 'Branch 1 ' }),
      device('c', 'router', { groupId: 'g1' }),
      device('d', 'router'),
    ];
    expect(siteKeys(nodes)).toEqual(['g1', 'site:Branch 1']);
  });
});
