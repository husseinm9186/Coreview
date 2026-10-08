import { describe, expect, it } from 'vitest';

import type { IpamAddress } from './ipam';
import { matchesFilter, parseFilter, tagsInUse } from './ipamFilter';

const addr = (a: Partial<IpamAddress>): IpamAddress =>
  ({ address: '192.0.2.10', value: 0, label: 'CORE-SW1', source: 'typed', vrfId: 'default', ...a }) as IpamAddress;

const keep = (a: IpamAddress, q: string) => matchesFilter(a, parseFilter(q));

describe('filtering the register', () => {
  it('an empty filter keeps everything', () => {
    expect(keep(addr({}), '')).toBe(true);
    expect(keep(addr({}), '   ')).toBe(true);
  });

  it('a bare word searches everything a person might remember', () => {
    const a = addr({ hostname: 'core-sw1', owner: 'Network', note: 'top of rack' });
    expect(keep(a, 'core')).toBe(true);
    expect(keep(a, 'rack')).toBe(true);
    expect(keep(a, 'network')).toBe(true);
    expect(keep(a, '192.0.2')).toBe(true);
    expect(keep(a, 'nothing-like-this')).toBe(false);
  });

  it('every term must match, because that is what typing two means', () => {
    const a = addr({ vlan: '14', kind: 'reserved' });
    expect(keep(a, 'vlan:14 kind:reserved')).toBe(true);
    expect(keep(a, 'vlan:14 kind:in-use')).toBe(false);
  });

  it('a tag matches exactly, so an exclusion can be trusted', () => {
    const a = addr({ tags: ['core-switches'] });
    expect(keep(a, 'tag:core-switches')).toBe(true);
    // `core` must not match `core-switches`, or -tag:core would quietly
    // exclude things it was never asked to.
    expect(keep(a, 'tag:core')).toBe(false);
  });

  it('a leading minus excludes', () => {
    const tagged = addr({ tags: ['decommissioned'] });
    const plain = addr({});
    expect(keep(tagged, '-tag:decommissioned')).toBe(false);
    expect(keep(plain, '-tag:decommissioned')).toBe(true);
  });

  it('finds what a crawl saw rather than what was typed', () => {
    expect(keep(addr({ source: 'crawled' }), 'source:crawled')).toBe(true);
    expect(keep(addr({ source: 'typed' }), 'source:crawled')).toBe(false);
    expect(keep(addr({ source: 'typed' }), '-source:crawled')).toBe(true);
  });

  it('an unknown field is treated as text, not as an error', () => {
    const a = addr({ note: 'printer:2f on the landing' });
    expect(keep(a, 'printer:2f')).toBe(true);
    expect(parseFilter('printer:2f')).toEqual([{ field: null, value: 'printer:2f', negated: false }]);
  });

  it('a quoted value may contain a space', () => {
    const a = addr({ owner: 'Network Team' });
    expect(keep(a, 'owner:"network team"')).toBe(true);
    expect(parseFilter('owner:"network team"')).toEqual([
      { field: 'owner', value: 'network team', negated: false },
    ]);
  });

  it('matching ignores case on both sides', () => {
    expect(keep(addr({ tags: ['PCI'.toLowerCase()] }), 'TAG:pci')).toBe(true);
    expect(keep(addr({ hostname: 'CORE-SW1' }), 'core-sw1')).toBe(true);
  });

  it('offers every tag in use, sorted and deduplicated', () => {
    expect(tagsInUse([
      addr({ tags: ['pci', 'core'] }),
      addr({ tags: ['core'] }),
      addr({}),
    ])).toEqual(['core', 'pci']);
  });

  it('an address with no tags is not matched by any tag term', () => {
    expect(keep(addr({}), 'tag:anything')).toBe(false);
    expect(keep(addr({}), '-tag:anything')).toBe(true);
  });
});

describe('where, whose, which device, and the operator\'s own fields', () => {
  const fields = [
    { id: 'f1', name: 'Circuit ID', type: 'text' as const, on: ['address' as const] },
    { id: 'f2', name: 'Tier', type: 'choice' as const, choices: ['gold', 'silver'], on: ['address' as const] },
  ];
  const hq = addr({
    address: '192.0.2.5',
    site: { name: 'HQ', from: 'own' },
    tenant: { name: 'Finance', from: 'subnet' },
    deviceLabel: 'LAB-SW-A',
    custom: { f1: 'CKT-100-A', f2: 'gold' },
  });
  const branch = addr({ address: '192.0.2.6', site: { name: 'HQ Annex', from: 'subnet' }, custom: { f2: 'silver' } });
  const find = (q: string, a: IpamAddress) => matchesFilter(a, parseFilter(q, fields));

  it('narrows by site and tenant exactly, so an exclusion can be trusted', () => {
    expect(find('site:hq', hq)).toBe(true);
    // "HQ Annex" is not HQ. If it were, `-site:hq` would quietly hide it.
    expect(find('site:hq', branch)).toBe(false);
    expect(find('site:"hq annex"', branch)).toBe(true);
    expect(find('tenant:finance', hq)).toBe(true);
    expect(find('-tenant:finance', branch)).toBe(true);
  });

  it('narrows by device by any part of its name', () => {
    expect(find('device:sw-a', hq)).toBe(true);
    expect(find('device:sw-a', branch)).toBe(false);
  });

  it('knows each custom field by its own name', () => {
    expect(find('circuit-id:ckt-100', hq)).toBe(true);
    // A choice is exact, like a tag.
    expect(find('tier:gold', hq)).toBe(true);
    expect(find('tier:gol', hq)).toBe(false);
    expect(find('-tier:gold', branch)).toBe(true);
  });

  it('a bare word finds the site, tenant, device and field values too', () => {
    expect(find('finance', hq)).toBe(true);
    expect(find('ckt-100', hq)).toBe(true);
    expect(find('lab-sw-a', hq)).toBe(true);
  });

  it('without the field definitions, a custom name is just a word', () => {
    // The old rule, unchanged: an unknown field is text, not an error.
    expect(matchesFilter(hq, parseFilter('tier:gold'))).toBe(false);
  });
});
