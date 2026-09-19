/**
 * Splitting a subnet, merging two back, and finding space to allocate out of
 * a container (LT-297).
 *
 * Every one of these is planned before it is done. The arithmetic is the easy
 * half — a /24 is four /26s and everyone knows it. The half that matters is
 * what happens to the addresses and ranges already inside: which child each
 * one lands in, and what straddles a boundary and therefore needs a person to
 * decide. A split that quietly cut a DHCP pool in half would be worse than no
 * split at all, so the plan says so and the caller has to look.
 *
 * Pure, and tested without a browser: these are the rules, not the screen.
 */
import {
  parseCidr,
  toAddress,
  toValue,
  type IpamAddress,
  type IpamBlock,
  type IpamContainerNode,
} from './ipam';

export interface SplitChild {
  cidr: string;
  network: number;
  prefix: number;
  /** First and last usable address, as text, for the review table. */
  firstUsable: string;
  lastUsable: string;
  /** What falls inside this child. */
  addresses: IpamAddress[];
  /** Ranges wholly inside it. */
  ranges: IpamBlock['ranges'];
}

export interface SplitPlan {
  from: string;
  prefix: number;
  children: SplitChild[];
  /** Ranges that cross a new boundary. Each needs a decision: there is no
   *  right answer this can pick on someone's behalf. */
  straddling: { id: string; from: string; to: string; kind: string; name?: string; across: string[] }[];
  /** Why it cannot be done at all. Null when the plan is good. */
  problem: string | null;
}

/** Why a prefix cannot be split to, in the words to put under the field. */
export function splitProblem(block: { prefix: number }, into: number): string | null {
  if (!Number.isInteger(into)) return 'Give a prefix length, like 26.';
  if (into <= block.prefix) return `A /${into} is not smaller than a /${block.prefix}. Split into something longer.`;
  if (into > 32) return 'The longest prefix there is is /32.';
  if (into - block.prefix > 8) return `That is ${2 ** (into - block.prefix)} subnets. Split in smaller steps.`;
  return null;
}

/**
 * What splitting this subnet would do, before anything is done.
 *
 * Children come back in address order with the addresses and ranges that fall
 * inside each, and anything crossing a boundary is listed separately rather
 * than being assigned to whichever half happens to hold its first address.
 */
export function planSplit(block: IpamBlock, into: number): SplitPlan {
  const problem = splitProblem(block, into);
  if (problem) return { from: block.cidr, prefix: into, children: [], straddling: [], problem };

  const size = 2 ** (32 - into);
  const count = 2 ** (into - block.prefix);
  const children: SplitChild[] = [];
  for (let i = 0; i < count; i += 1) {
    const network = block.network + i * size;
    const first = into >= 31 ? network : network + 1;
    const last = into >= 31 ? network + size - 1 : network + size - 2;
    children.push({
      cidr: `${toAddress(network)}/${into}`,
      network,
      prefix: into,
      firstUsable: toAddress(first),
      lastUsable: toAddress(last),
      addresses: block.addresses.filter((a) => a.value >= network && a.value < network + size),
      ranges: block.ranges.filter((r) => r.fromValue >= network && r.toValue < network + size),
    });
  }

  const straddling = block.ranges
    .filter((r) => !children.some((c) => r.fromValue >= c.network && r.toValue < c.network + size))
    .map((r) => ({
      id: r.id,
      from: r.from,
      to: r.to,
      kind: r.kind,
      name: r.name,
      across: children
        .filter((c) => r.toValue >= c.network && r.fromValue < c.network + size)
        .map((c) => c.cidr),
    }));

  return { from: block.cidr, prefix: into, children, straddling, problem: null };
}

export interface MergePlan {
  /** The subnet the two become. */
  cidr: string;
  parts: string[];
  /** Addresses and ranges that carry over, which is all of them: a merge
   *  widens the boundary and loses nothing. */
  addresses: number;
  ranges: number;
  problem: string | null;
}

/**
 * Whether two subnets can become one, and what it would be.
 *
 * Only a real pair: the same routing table, the same prefix, adjacent, and
 * aligned so that the two together *are* the shorter prefix. `10.0.0.0/25` and
 * `10.0.0.128/25` merge; `10.0.0.128/25` and `10.0.1.0/25` do not, however
 * adjacent they look.
 */
export function planMerge(a: IpamBlock, b: IpamBlock): MergePlan {
  const parts = [a.cidr, b.cidr];
  const fail = (problem: string): MergePlan => ({ cidr: '', parts, addresses: 0, ranges: 0, problem });

  if (a.cidr === b.cidr) return fail('Those are the same subnet.');
  if (a.vrfId !== b.vrfId) return fail('Those are in different routing tables.');
  if (a.prefix !== b.prefix) return fail(`A /${a.prefix} and a /${b.prefix} do not merge. They have to be the same size.`);
  if (a.prefix === 0) return fail('A /0 is the whole of IPv4; there is nothing to merge it with.');

  const [low, high] = a.network <= b.network ? [a, b] : [b, a];
  const size = 2 ** (32 - a.prefix);
  if (high.network !== low.network + size) return fail('Those two are not next to each other.');

  const parent = { network: Math.floor(low.network / (size * 2)) * (size * 2), prefix: a.prefix - 1 };
  if (parent.network !== low.network) {
    return fail(`They are next to each other but not halves of one /${a.prefix - 1}. Merging them would take in space that is not theirs.`);
  }

  return {
    cidr: `${toAddress(parent.network)}/${parent.prefix}`,
    parts: [low.cidr, high.cidr],
    addresses: low.addresses.length + high.addresses.length,
    ranges: low.ranges.length + high.ranges.length,
    problem: null,
  };
}

export interface FreeBlock {
  cidr: string;
  network: number;
  prefix: number;
}

/**
 * The lowest free block of a given size inside a container.
 *
 * Free means overlapping nothing already there — no child container, no
 * subnet. Walked by stepping a whole block at a time from the container's
 * start, which is what makes this affordable on a /8: the candidates are
 * aligned, so there are `capacity / size` of them, not `capacity`.
 */
export function nextFreeBlock(container: IpamContainerNode, prefix: number, limit = 4096): FreeBlock | null {
  if (!Number.isInteger(prefix) || prefix <= container.prefix || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  const taken: { network: number; size: number }[] = [
    ...container.children.map((c) => ({ network: c.network, size: c.capacity })),
    ...container.subnets.map((b) => ({ network: b.network, size: 2 ** (32 - b.prefix) })),
  ];
  const end = container.network + container.capacity;
  let tried = 0;
  for (let at = container.network; at < end; at += size) {
    if (tried >= limit) return null;
    tried += 1;
    const clash = taken.some((t) => at < t.network + t.size && t.network < at + size);
    if (!clash) return { cidr: `${toAddress(at)}/${prefix}`, network: at, prefix };
  }
  return null;
}

/**
 * Every block of a size that is free in a container, up to a handful.
 *
 * The allocation screen offers a choice rather than one answer: the lowest
 * free block is usually right and occasionally the worst place to put
 * something.
 */
export function freeBlocks(container: IpamContainerNode, prefix: number, most = 8): FreeBlock[] {
  const out: FreeBlock[] = [];
  if (!Number.isInteger(prefix) || prefix <= container.prefix || prefix > 32) return out;
  const size = 2 ** (32 - prefix);
  const taken: { network: number; size: number }[] = [
    ...container.children.map((c) => ({ network: c.network, size: c.capacity })),
    ...container.subnets.map((b) => ({ network: b.network, size: 2 ** (32 - b.prefix) })),
  ];
  const end = container.network + container.capacity;
  for (let at = container.network; at < end && out.length < most; at += size) {
    const clash = taken.some((t) => at < t.network + t.size && t.network < at + size);
    if (!clash) out.push({ cidr: `${toAddress(at)}/${prefix}`, network: at, prefix });
  }
  return out;
}

/**
 * Everything that would stop an address being allocated, in the order a person
 * would check them (LT-297).
 *
 * The duplicate-MAC check is the one with teeth: the same MAC on a second
 * address, anywhere in the project, is how the machine somebody moved and
 * never mentioned gets found.
 */
export function allocationProblems(
  blocks: readonly IpamBlock[],
  block: IpamBlock,
  address: string,
  mac?: string,
): string[] {
  const out: string[] = [];
  const value = toValue(address);
  if (value === null) return ['That is not an IPv4 address.'];

  const size = 2 ** (32 - block.prefix);
  if (value < block.network || value >= block.network + size) {
    out.push(`${address} is not inside ${block.cidr}.`);
    return out;
  }
  if (block.prefix <= 30) {
    if (value === block.network) out.push(`${address} is the network address of ${block.cidr}.`);
    if (value === block.network + size - 1) out.push(`${address} is the broadcast address of ${block.cidr}.`);
  }
  const held = block.addresses.find((a) => a.value === value);
  if (held) {
    // The kind as a person says it: the stored value is `in-use`, and a
    // sentence reading "is already in-use" is a sentence written by a schema.
    const asWord = held.kind === 'in-use' ? 'in use' : held.kind;
    out.push(`${address} is already ${asWord ?? 'on the diagram'} — ${held.label}.`);
  }

  const range = block.ranges.find((r) => value >= r.fromValue && value <= r.toValue);
  if (range) {
    out.push(
      range.kind === 'dhcp'
        ? `${address} is inside the DHCP pool ${range.name ?? `${range.from}–${range.to}`}; a server hands that out.`
        : `${address} is inside the excluded range ${range.name ?? `${range.from}–${range.to}`}.`,
    );
  }

  const wanted = mac?.trim().toLowerCase();
  if (wanted) {
    for (const b of blocks) {
      for (const a of b.addresses) {
        if (a.value === value && b.cidr === block.cidr) continue;
        if (a.mac?.trim().toLowerCase() === wanted) {
          out.push(`That MAC is already on ${a.address} in ${b.cidr} — ${a.label}.`);
        }
      }
    }
  }
  return out;
}

/** `10.20.30.0/24` split in two is `/25`; the next size down from a block. */
export function halfOf(cidr: string): number | null {
  const at = parseCidr(cidr);
  return at && at.prefix < 32 ? at.prefix + 1 : null;
}
