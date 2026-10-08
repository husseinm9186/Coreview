import { describe, expect, it } from 'vitest';

import type { IpamCustomField, IpamState } from './ipam';
import {
  agreedBy,
  auditView,
  carriedBy,
  cleanCustom,
  customFieldProblem,
  customValueProblem,
  fieldKey,
  nameProblem,
  usageOf,
  visibleColumns,
  withoutField,
  withoutReference,
} from './ipamMeta';

// Invented throughout.
const circuit: IpamCustomField = { id: 'f1', name: 'Circuit ID', type: 'text', on: ['subnet'] };
const cost: IpamCustomField = { id: 'f2', name: 'Cost', type: 'number', on: ['address'] };
const tier: IpamCustomField = { id: 'f3', name: 'Tier', type: 'choice', choices: ['gold', 'silver'], on: ['subnet', 'address'] };
const since: IpamCustomField = { id: 'f4', name: 'In service', type: 'date', on: ['address'] };

const state: IpamState = {
  sites: [{ id: 's1', name: 'HQ' }, { id: 's2', name: 'Branch Two' }],
  tenants: [{ id: 't1', name: 'Finance' }],
  customFields: [circuit, cost, tier, since],
  subnets: [
    { id: 'n1', cidr: '192.0.2.0/24', siteId: 's1', tenantId: 't1', custom: { f1: 'CKT-1', f3: 'gold' } },
    { id: 'n2', cidr: '198.51.100.0/24', siteId: 's2' },
  ],
  entries: [
    { id: 'e1', address: '192.0.2.5', label: 'printer', kind: 'in-use', siteId: 's1', custom: { f2: '40', f3: 'silver' } },
    { id: 'e2', address: '192.0.2.6', label: 'spare', kind: 'reserved' },
  ],
};

describe('names for sites, tenants and fields', () => {
  it('refuses an empty name and a duplicate, whatever the case or spacing', () => {
    expect(nameProblem(state.sites!, '  ')).toMatch(/name/i);
    expect(nameProblem(state.sites!, 'hq ')).toMatch(/already/i);
    expect(nameProblem(state.sites!, 'HQ', 's1')).toBeNull(); // renaming to itself
    expect(nameProblem(state.sites!, 'Warehouse')).toBeNull();
  });

  it('turns a field name into something typed after a colon', () => {
    expect(fieldKey('Circuit ID')).toBe('circuit-id');
    expect(fieldKey('  In   service ')).toBe('in-service');
    expect(fieldKey('Cost (£)')).toBe('cost');
  });

  it('refuses a field the filter could not tell from a built-in one', () => {
    // `tag:x` already means something. A custom field called "Tag" would make
    // one of the two unreachable, and it would be the operator's.
    for (const name of ['Tag', 'VLAN', 'site', 'Tenant', 'device', 'Owner']) {
      expect(customFieldProblem([], { name, type: 'text', on: ['address'] })).toMatch(/already means/i);
    }
    expect(customFieldProblem([circuit], { name: 'circuit id', type: 'text', on: ['subnet'] })).toMatch(/already/i);
    expect(customFieldProblem([], { name: '!!!', type: 'text', on: ['subnet'] })).toMatch(/letter/i);
  });

  it('refuses a choice with nothing to choose, and a field on nothing', () => {
    expect(customFieldProblem([], { name: 'Tier', type: 'choice', choices: [' '], on: ['subnet'] })).toMatch(/choice/i);
    expect(customFieldProblem([], { name: 'Tier', type: 'text', on: [] })).toMatch(/subnets or addresses/i);
    expect(customFieldProblem([], { name: 'Tier', type: 'choice', choices: ['a'], on: ['address'] })).toBeNull();
  });
});

describe('values in custom fields', () => {
  it('checks each type the way a person would expect', () => {
    expect(customValueProblem(cost, '40')).toBeNull();
    expect(customValueProblem(cost, '-3.5')).toBeNull();
    expect(customValueProblem(cost, 'forty')).toMatch(/number/i);
    expect(customValueProblem(tier, 'gold')).toBeNull();
    expect(customValueProblem(tier, 'bronze')).toMatch(/gold, silver/);
    expect(customValueProblem(since, '2026-09-22')).toBeNull();
    expect(customValueProblem(since, '2026-02-30')).toMatch(/date/i);
    expect(customValueProblem(since, '22/09/2026')).toMatch(/YYYY-MM-DD/);
    // An empty value is clearing the field, never an error.
    for (const f of [circuit, cost, tier, since]) expect(customValueProblem(f, '  ')).toBeNull();
  });

  it('keeps only what applies to the record, trimmed, and nothing empty', () => {
    const fields = state.customFields!;
    expect(cleanCustom(fields, 'subnet', { f1: ' CKT-9 ', f2: '12', f3: '', gone: 'x' })).toEqual({ f1: 'CKT-9' });
    expect(cleanCustom(fields, 'address', { f1: 'x' })).toBeUndefined();
  });
});

describe('what uses a site, a tenant or a field', () => {
  it('counts subnets and addresses both', () => {
    expect(usageOf(state, 'site', 's1')).toBe(2);
    expect(usageOf(state, 'site', 's2')).toBe(1);
    expect(usageOf(state, 'tenant', 't1')).toBe(1);
  });

  it('removing a site leaves nothing pointing at it, and touches nothing else', () => {
    const after = withoutReference(state, 'site', 's1');
    expect(after.sites!.map((s) => s.id)).toEqual(['s2']);
    expect(after.subnets![0]!.siteId).toBeUndefined();
    expect(after.subnets![0]!.tenantId).toBe('t1');
    expect(after.entries![0]!.siteId).toBeUndefined();
    expect(after.subnets![1]!.siteId).toBe('s2');
  });

  it('removing a field removes its values everywhere, and an emptied record carries no empty object', () => {
    const after = withoutField(state, 'f3');
    expect(after.customFields!.map((f) => f.id)).toEqual(['f1', 'f2', 'f4']);
    expect(after.subnets![0]!.custom).toEqual({ f1: 'CKT-1' });
    expect(after.entries![0]!.custom).toEqual({ f2: '40' });
    const bare = withoutField(withoutField(after, 'f1'), 'f2');
    expect(bare.subnets![0]!.custom).toBeUndefined();
    expect(bare.entries![0]!.custom).toBeUndefined();
  });
});

describe('the history reads in names, not ids', () => {
  it('says the site, the tenant, the device and each field by name', () => {
    const view = auditView(
      { address: '192.0.2.5', siteId: 's1', tenantId: 't1', deviceId: 'node-9', custom: { f2: '40' } },
      state,
      (id) => (id === 'node-9' ? 'LAB-SW-A' : undefined),
    );
    expect(view).toEqual({ address: '192.0.2.5', site: 'HQ', tenant: 'Finance', device: 'LAB-SW-A', Cost: '40' });
  });
});

describe('the column chooser', () => {
  it('shows every column but the hidden ones, and a new field arrives shown', () => {
    const cols = visibleColumns(['mac', 'custom:f2'], state.customFields!);
    expect(cols).not.toContain('mac');
    expect(cols).not.toContain('custom:f2');
    expect(cols).toContain('site');
    expect(cols).toContain('custom:f3');
    // A subnet-only field is not a column in the address table.
    expect(cols).not.toContain('custom:f1');
    // Stored as what is *hidden*, so a field added tomorrow is visible
    // without anybody having to go and find it.
    expect(visibleColumns([], [...state.customFields!, { id: 'f9', name: 'New', type: 'text', on: ['address'] }]))
      .toContain('custom:f9');
  });
});

describe('what survives a split and a merge', () => {
  it('a split hands its site, tenant and fields to every child', () => {
    expect(carriedBy({ id: 'n', cidr: '192.0.2.0/24', siteId: 's1', tenantId: 't1', custom: { f1: 'x' } }))
      .toEqual({ siteId: 's1', tenantId: 't1', custom: { f1: 'x' } });
    expect(carriedBy({ id: 'n', cidr: '192.0.2.0/24' })).toEqual({});
  });

  it('a merge keeps only what both halves agree on, rather than choosing a winner', () => {
    const a = { id: 'a', cidr: '192.0.2.0/25', siteId: 's1', tenantId: 't1', custom: { f1: 'x', f2: 'same' } };
    const b = { id: 'b', cidr: '192.0.2.128/25', siteId: 's1', tenantId: 't2', custom: { f1: 'y', f2: 'same' } };
    // Same site kept; two different tenants is a disagreement, and picking
    // one would record something nobody decided.
    expect(agreedBy([a, b])).toEqual({ siteId: 's1', custom: { f2: 'same' } });
    expect(agreedBy([a, { id: 'c', cidr: '192.0.2.128/25' }])).toEqual({});
  });
});
