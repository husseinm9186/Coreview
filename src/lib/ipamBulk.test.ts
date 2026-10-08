import { describe, expect, it } from 'vitest';

import type { IpamAddress } from './ipam';
import { describeBulk, planBulk } from './ipamBulk';

const addr = (a: Partial<IpamAddress>): IpamAddress =>
  ({ address: '192.0.2.10', value: 0, label: 'x', source: 'typed', vrfId: 'default',
     entryId: `e-${a.address ?? '192.0.2.10'}`, ...a }) as IpamAddress;

/** A row that came from a device on the diagram: no entry behind it. */
const drawn = (address: string): IpamAddress =>
  ({ address, value: 0, label: 'CORE-SW1', source: 'drawn', vrfId: 'default' }) as IpamAddress;

describe('doing one thing to everything the filter found', () => {
  it('adds a tag only where it is not already there', () => {
    const plan = planBulk(
      [addr({ address: '192.0.2.1' }), addr({ address: '192.0.2.2', tags: ['pci'] })],
      { kind: 'add-tags', tags: ['pci'] },
    );
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({ address: '192.0.2.1', before: '', after: 'pci' });
    expect(plan.unchanged).toBe(1);
  });

  it('keeps tags it already had when adding another', () => {
    const plan = planBulk([addr({ tags: ['core'] })], { kind: 'add-tags', tags: ['pci'] });
    expect(plan.changes[0]!.patch).toEqual({ tags: ['core', 'pci'] });
  });

  it('lower-cases and deduplicates what is typed', () => {
    const plan = planBulk([addr({})], { kind: 'add-tags', tags: ['PCI', ' pci ', 'Core'] });
    expect(plan.changes[0]!.patch).toEqual({ tags: ['pci', 'core'] });
  });

  it('removes a tag, and takes the field away when it was the last one', () => {
    const one = planBulk([addr({ tags: ['pci'] })], { kind: 'remove-tags', tags: ['pci'] });
    expect(one.changes[0]!.patch).toEqual({ tags: undefined });
    const some = planBulk([addr({ tags: ['pci', 'core'] })], { kind: 'remove-tags', tags: ['pci'] });
    expect(some.changes[0]!.patch).toEqual({ tags: ['core'] });
  });

  it('removing a tag nothing carries changes nothing', () => {
    const plan = planBulk([addr({ tags: ['core'] })], { kind: 'remove-tags', tags: ['pci'] });
    expect(plan.changes).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('will not edit a row that belongs to a device on the diagram', () => {
    const plan = planBulk([drawn('192.0.2.11'), addr({})], { kind: 'add-tags', tags: ['pci'] });
    expect(plan.changes).toHaveLength(1);
    expect(plan.notOurs).toBe(1);
  });

  it('sets an owner, and clearing it removes the field rather than storing a blank', () => {
    const set = planBulk([addr({})], { kind: 'set-owner', value: 'Network' });
    expect(set.changes[0]!.patch).toEqual({ owner: 'Network' });
    const cleared = planBulk([addr({ owner: 'Network' })], { kind: 'set-owner', value: '  ' });
    expect(cleared.changes[0]!.patch).toEqual({ owner: undefined });
  });

  it('changes what an address is held as', () => {
    const plan = planBulk([addr({ kind: 'in-use' })], { kind: 'set-kind', value: 'reserved' });
    expect(plan.changes[0]).toMatchObject({ before: 'in-use', after: 'reserved' });
  });

  it('says what it will do before it does it', () => {
    const plan = planBulk(
      [addr({ address: '192.0.2.1' }), addr({ address: '192.0.2.2', tags: ['pci'] }), drawn('192.0.2.3')],
      { kind: 'add-tags', tags: ['pci'] },
    );
    expect(describeBulk(plan)).toBe('1 to change, 1 already so, 1 belong to a device');
  });

  it('nothing selected plans nothing', () => {
    expect(planBulk([], { kind: 'add-tags', tags: ['pci'] })).toEqual({ changes: [], unchanged: 0, notOurs: 0 });
  });
});
