/**
 * Which subnets are in use, and which are not.
 *
 * This is the question the register exists to answer: which subnets are
 * used and which are free, so that is still known later. The
 * register already answers it subnet by subnet; a dashboard answers it for the
 * whole estate at a glance, which is a different job.
 *
 * **Everything here is derived, nothing is stored.** The numbers come from
 * `buildIpam`, so the dashboard cannot disagree with the list beneath it and
 * cannot go stale.
 *
 * **Empty and full are both worth finding, and so is neither.** A subnet at
 * 98% is about to hurt; a subnet at 0% is reclaimable; the middle is fine and
 * should not shout. That is why the bands exist rather than a single sorted
 * list — a sorted list makes you read all of it to find the two that matter.
 */
import type { IpamBlock, IpamModel } from './ipam';
import { utilisation } from './ipam';

/** How full a subnet is, in the terms an engineer acts on. */
export type Band = 'empty' | 'light' | 'busy' | 'full';

/** Above this a subnet is about to run out. */
export const FULL_AT = 90;
/** Above this it is worth watching. */
export const BUSY_AT = 60;

export interface DashboardRow {
  cidr: string;
  name?: string;
  vlan?: number;
  usable: number;
  used: number;
  free: number;
  excluded: number;
  pooled: number;
  percent: number;
  band: Band;
  /** True where nothing at all is recorded in it. */
  untouched: boolean;
}

export interface DashboardTotals {
  subnets: number;
  usable: number;
  used: number;
  free: number;
  /** Subnets in each band, for the summary line. */
  byBand: Record<Band, number>;
}

export function bandOf(percent: number, used: number): Band {
  if (used === 0) return 'empty';
  if (percent >= FULL_AT) return 'full';
  if (percent >= BUSY_AT) return 'busy';
  return 'light';
}

/** One row per subnet, fullest first — the end of the list that needs acting on. */
export function dashboardRows(model: IpamModel): DashboardRow[] {
  const row = (b: IpamBlock): DashboardRow => {
    const percent = utilisation(b);
    return {
      cidr: b.cidr,
      ...(b.name ? { name: b.name } : {}),
      ...(b.vlan === undefined ? {} : { vlan: b.vlan }),
      usable: b.usable,
      used: b.used,
      free: b.free,
      excluded: b.excluded,
      pooled: b.pooled,
      percent,
      band: bandOf(percent, b.used),
      untouched: b.used === 0 && b.excluded === 0 && b.pooled === 0,
    };
  };
  return model.blocks
    .map(row)
    // Fullest first, then the largest, then by name so the order never wobbles
    // between renders of the same data.
    .sort((a, b) => b.percent - a.percent || b.usable - a.usable || a.cidr.localeCompare(b.cidr));
}

export function dashboardTotals(rows: readonly DashboardRow[]): DashboardTotals {
  const byBand: Record<Band, number> = { empty: 0, light: 0, busy: 0, full: 0 };
  let usable = 0;
  let used = 0;
  let free = 0;
  for (const r of rows) {
    byBand[r.band] += 1;
    usable += r.usable;
    used += r.used;
    free += r.free;
  }
  return { subnets: rows.length, usable, used, free, byBand };
}

/** The subnets nothing has ever been recorded in — the reclaimable ones. */
export function untouched(rows: readonly DashboardRow[]): DashboardRow[] {
  return rows.filter((r) => r.untouched);
}
