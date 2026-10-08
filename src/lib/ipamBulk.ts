/**
 * Doing one thing to everything the filter found.
 *
 * Filtering made a long register answerable; this makes it editable. "Tag
 * everything a crawl found", "give this subnet's addresses an owner", "clear a
 * tag that no longer means anything" — each is one decision, and doing it two
 * hundred times by hand is how registers stop being maintained.
 *
 * **It plans, then applies**, like the CSV import and the ingestion before it.
 * The count of what will actually change is the number that matters, and it is
 * not the number of rows on screen: an address that already carries the tag is
 * not a change, and an address that is not a register entry cannot be changed
 * at all.
 *
 * **Only the register's own entries can be edited, and that is not a
 * limitation to apologise for.** A row that came from a device drawn on the
 * diagram belongs to that device — its address is a fact about the device, and
 * the register displays it rather than owning it. Bulk-editing those would
 * write a fact the device never reported. They are counted and named instead.
 */
import type { EntryKind, IpamAddress, IpamEntry } from './ipam';

export type BulkAction =
  | { kind: 'add-tags'; tags: string[] }
  | { kind: 'remove-tags'; tags: string[] }
  | { kind: 'set-owner'; value: string }
  | { kind: 'set-purpose'; value: string }
  | { kind: 'set-kind'; value: EntryKind };

export interface BulkChange {
  entryId: string;
  address: string;
  /** What the row shows now, and what it would show after. */
  before: string;
  after: string;
  /** The patch to hand to `updateIpamEntry`. */
  patch: Partial<Omit<IpamEntry, 'id'>>;
}

export interface BulkPlan {
  changes: BulkChange[];
  /** Rows already in the wanted state — no change, and not a failure. */
  unchanged: number;
  /** Rows the register does not own, so cannot edit. */
  notOurs: number;
}

const tidyTags = (tags: readonly string[]): string[] =>
  [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];

/** What `action` would do to `addresses`, without doing any of it. */
export function planBulk(addresses: readonly IpamAddress[], action: BulkAction): BulkPlan {
  const plan: BulkPlan = { changes: [], unchanged: 0, notOurs: 0 };

  for (const a of addresses) {
    if (!a.entryId) {
      plan.notOurs += 1;
      continue;
    }
    const had = a.tags ?? [];
    let before = '';
    let after = '';
    let patch: Partial<Omit<IpamEntry, 'id'>> | null = null;

    switch (action.kind) {
      case 'add-tags': {
        const wanted = tidyTags(action.tags);
        const next = tidyTags([...had, ...wanted]);
        if (next.length !== had.length) {
          before = had.join(', ');
          after = next.join(', ');
          patch = { tags: next };
        }
        break;
      }
      case 'remove-tags': {
        const drop = new Set(tidyTags(action.tags));
        const next = had.filter((t) => !drop.has(t));
        if (next.length !== had.length) {
          before = had.join(', ');
          after = next.join(', ');
          // Undefined rather than [] so the field leaves the record entirely.
          patch = { tags: next.length ? next : undefined };
        }
        break;
      }
      case 'set-owner': {
        const value = action.value.trim();
        if ((a.owner ?? '') !== value) {
          before = a.owner ?? '';
          after = value;
          patch = { owner: value || undefined };
        }
        break;
      }
      case 'set-purpose': {
        const value = action.value.trim();
        if ((a.purpose ?? '') !== value) {
          before = a.purpose ?? '';
          after = value;
          patch = { purpose: value || undefined };
        }
        break;
      }
      case 'set-kind': {
        if (a.kind !== action.value) {
          before = a.kind ?? '';
          after = action.value;
          patch = { kind: action.value };
        }
        break;
      }
    }

    if (patch) plan.changes.push({ entryId: a.entryId, address: a.address, before, after, patch });
    else plan.unchanged += 1;
  }

  return plan;
}

/** A sentence saying what the plan will do, for the button that does it. */
export function describeBulk(plan: BulkPlan): string {
  const parts = [`${plan.changes.length} to change`];
  if (plan.unchanged) parts.push(`${plan.unchanged} already so`);
  if (plan.notOurs) parts.push(`${plan.notOurs} belong to a device`);
  return parts.join(', ');
}
