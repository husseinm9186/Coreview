import { describe, expect, it } from 'vitest';

import type { IpamAddress } from './ipam';
import { matchesFilter, parseFilter, tagsInUse } from './ipamFilter';

const addr = (a: Partial<IpamAddress>): IpamAddress =>
  ({ address: '192.0.2.10', value: 0, label: 'CORE-SW1', source: 'typed', vrfId: 'default', ...a }) as IpamAddress;

const keep = (a: IpamAddress, q: string) => matchesFilter(a, parseFilter(q));

describe('filtering the register (LT-298)', () => {
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
