import { describe, expect, it } from 'vitest';

import type { IpamBlock, IpamModel } from './ipam';
import { bandOf, dashboardRows, dashboardTotals, untouched } from './ipamDashboard';

const block = (cidr: string, usable: number, used: number, over: Partial<IpamBlock> = {}): IpamBlock =>
  ({
    cidr, network: 0, prefix: 24, origin: 'declared', addresses: [],
    usable, used, excluded: 0, pooled: 0, free: usable - used, ranges: [], ...over,
  }) as IpamBlock;

const model = (blocks: IpamBlock[]): IpamModel =>
  ({ blocks, loose: [], vrfs: [], containers: [], conflicts: [], skipped: [] }) as unknown as IpamModel;

describe('which subnets are in use (LT-298)', () => {
  it('bands a subnet by how full it is', () => {
    expect(bandOf(0, 0)).toBe('empty');
    expect(bandOf(10, 3)).toBe('light');
    expect(bandOf(60, 60)).toBe('busy');
    expect(bandOf(89, 89)).toBe('busy');
    expect(bandOf(90, 90)).toBe('full');
    expect(bandOf(100, 254)).toBe('full');
  });

  it('a subnet with nothing in it is empty, not light', () => {
    // 0% and 0 used is the reclaimable case, and it must not hide among the
    // lightly-used ones.
    expect(bandOf(0, 0)).toBe('empty');
    const rows = dashboardRows(model([block('10.0.0.0/24', 254, 0)]));
    expect(rows[0]!.band).toBe('empty');
    expect(rows[0]!.untouched).toBe(true);
  });

  it('puts the fullest first, because that is the end that needs acting on', () => {
    const rows = dashboardRows(model([
      block('10.0.1.0/24', 254, 10),
      block('10.0.2.0/24', 254, 250),
      block('10.0.3.0/24', 254, 130),
    ]));
    expect(rows.map((r) => r.cidr)).toEqual(['10.0.2.0/24', '10.0.3.0/24', '10.0.1.0/24']);
  });

  it('orders the same data the same way every time', () => {
    const blocks = [block('10.0.9.0/24', 254, 0), block('10.0.1.0/24', 254, 0)];
    expect(dashboardRows(model(blocks)).map((r) => r.cidr)).toEqual(['10.0.1.0/24', '10.0.9.0/24']);
  });

  it('a subnet holding only excluded addresses is not untouched', () => {
    const rows = dashboardRows(model([block('10.0.0.0/24', 254, 0, { excluded: 5 })]));
    expect(rows[0]!.band).toBe('empty');
    expect(rows[0]!.untouched).toBe(false);
  });

  it('a DHCP pool counts as touched, because a server owns it', () => {
    const rows = dashboardRows(model([block('10.0.0.0/24', 254, 0, { pooled: 100 })]));
    expect(rows[0]!.untouched).toBe(false);
  });

  it('totals the estate and counts each band', () => {
    const rows = dashboardRows(model([
      block('10.0.1.0/24', 254, 0),
      block('10.0.2.0/24', 254, 250),
      block('10.0.3.0/24', 100, 70),
      block('10.0.4.0/24', 100, 5),
    ]));
    const totals = dashboardTotals(rows);
    expect(totals.subnets).toBe(4);
    expect(totals.usable).toBe(708);
    expect(totals.used).toBe(325);
    expect(totals.byBand).toEqual({ empty: 1, light: 1, busy: 1, full: 1 });
  });

  it('names the reclaimable ones', () => {
    const rows = dashboardRows(model([
      block('10.0.1.0/24', 254, 0),
      block('10.0.2.0/24', 254, 9),
    ]));
    expect(untouched(rows).map((r) => r.cidr)).toEqual(['10.0.1.0/24']);
  });

  it('a register with no subnets is zeroes rather than a crash', () => {
    const rows = dashboardRows(model([]));
    expect(rows).toEqual([]);
    expect(dashboardTotals(rows)).toEqual({
      subnets: 0, usable: 0, used: 0, free: 0,
      byBand: { empty: 0, light: 0, busy: 0, full: 0 },
    });
  });

  it('a /32 is not divided by zero', () => {
    const rows = dashboardRows(model([block('10.0.0.1/32', 0, 0, { prefix: 32 })]));
    expect(rows[0]!.percent).toBe(0);
    expect(rows[0]!.band).toBe('empty');
  });
});
