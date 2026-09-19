/**
 * Address management, built from what the project already knows (LT-285).
 *
 * The question this answers is the one an engineer asks with a spreadsheet
 * open beside the diagram: *what is on this network, and which address is
 * free?* Everything needed to answer it is already in the project — a device
 * carries its addresses, a crawled device carries its connected routes, which
 * are the real prefixes with the real masks, and its VLANs. None of that is
 * gathered again here; this is the arithmetic over it.
 *
 * Two things it is not. It is not a source of truth that overrides the
 * network: a subnet nobody has scanned shows what is *known*, not what is
 * there, and the counts say so by naming where each address came from. And it
 * ships nothing pre-filled — no example prefixes, no default supernets, no
 * organisation's addressing plan (D-027). What is in it is what the operator
 * put there or what discovery found on his own network.
 *
 * IPv4 only for now, deliberately: a v6 subnet's "free addresses" is not a
 * number anyone wants counted, and pretending otherwise would be worse than
 * saying so. IPv6 addresses on a device are listed against the device; they
 * are simply not bucketed into prefixes here.
 */
import type { TopoNode } from '../state/store';
import type { DeviceNodeData } from '../types/domain';

/**
 * A routing table of its own (LT-297).
 *
 * Two networks can hold the same addresses and never meet — a lab beside
 * production, or two customers on one engineer's laptop. Everything in the
 * register belongs to exactly one, and uniqueness is `vrf + address` rather
 * than `address`, which is the whole reason this exists.
 */
export interface IpamVrf {
  id: string;
  name: string;
  /** The route distinguisher, where the network has one. Free text: it is
   *  written down to be recognised, not parsed. */
  rd?: string;
  note?: string;
}

/** The VRF everything is in until someone says otherwise. Never stored; a
 *  project with no VRFs behaves exactly as it did before they existed. */
export const DEFAULT_VRF: IpamVrf = { id: 'global', name: 'Global' };

/**
 * A folder for address space, not a subnet anything sits on (LT-297).
 *
 * `10.0.0.0/8` holds Texas holds San Antonio holds the subnets people are
 * actually addressed out of. Two things a flat list cannot do: roll a
 * utilisation figure up to "how full is this site", and say what has *not*
 * been handed out yet, which is what allocating the next free /26 needs.
 */
export interface IpamContainer {
  id: string;
  parentId?: string;
  name: string;
  cidr: string;
  note?: string;
  vrfId?: string;
}

/** A subnet the operator declared himself, as it is kept on the project. */
export interface IpamSubnet {
  id: string;
  /** `10.0.0.0/24`. The one field that must parse. */
  cidr: string;
  name?: string;
  vlan?: number;
  note?: string;
  vrfId?: string;
  /** The container it was allocated out of, where it was. */
  containerId?: string;
}

/**
 * What an address is spoken for as (LT-289).
 *
 * The three are not decoration: they are what makes a free count mean
 * anything. *reserved* is held for something not built yet, *in use* is a real
 * address on something not drawn — a printer, a server, a static lease — and
 * *excluded* is an address nobody may hand out, which is neither free nor in
 * use and has to be subtracted from both.
 */
export type EntryKind = 'reserved' | 'in-use' | 'excluded';

export const ENTRY_KINDS: EntryKind[] = ['reserved', 'in-use', 'excluded'];

/**
 * How an address is used, where the register knows (LT-297).
 *
 * Separate from the kind above, which says whether an address may be handed
 * out. This says what it *is*, and it is the difference between a printer and
 * a gateway when someone is reading the subnet to decide where to put a new
 * box.
 */
export type AssignmentType =
  | 'static'
  | 'dhcp'
  | 'dhcp-reservation'
  | 'gateway'
  | 'infrastructure'
  | 'virtual-ip'
  | 'loopback'
  | 'transit'
  | 'unknown';

export const ASSIGNMENT_TYPES: AssignmentType[] = [
  'static', 'dhcp', 'dhcp-reservation', 'gateway', 'infrastructure',
  'virtual-ip', 'loopback', 'transit', 'unknown',
];

/** An address the register itself holds, rather than one read off a device. */
export interface IpamEntry {
  id: string;
  address: string;
  label: string;
  kind: EntryKind;
  note?: string;
  /** LT-297: what is actually on the address, where it is known. */
  assignment?: AssignmentType;
  hostname?: string;
  fqdn?: string;
  mac?: string;
  owner?: string;
  purpose?: string;
  /** LT-297: which routing table. Absent means the default one. */
  vrfId?: string;
}

/**
 * A span of a subnet spoken for as a whole (LT-294).
 *
 * The reason this exists rather than two hundred `excluded` records: a DHCP
 * pool is one decision, and an engineer will mark one range where he will
 * never mark two hundred addresses. Without it a pool reads as empty space,
 * someone takes the "next free" address out of the middle of it, and the
 * server leases the same one to a laptop that afternoon.
 */
export type RangeKind = 'dhcp' | 'excluded';

export const RANGE_KINDS: RangeKind[] = ['dhcp', 'excluded'];

export interface IpamRange {
  id: string;
  /** First and last address of the span, inclusive. */
  from: string;
  to: string;
  kind: RangeKind;
  name?: string;
  note?: string;
}

/** The shape before LT-289, kept so a project saved that morning still opens.
 *  `migrate.ts` turns it into entries; nothing else reads it. */
export interface IpamReservation {
  id: string;
  address: string;
  label: string;
  note?: string;
}

/** The project's half of all this: declarations, never discoveries. */
/** One thing that happened to the register (LT-297). */
export interface IpamAuditEntry {
  id: string;
  /** Epoch milliseconds. */
  at: number;
  /** 'added' | 'edited' | 'removed' | 'split' | 'merged' | 'allocated'. */
  action: string;
  /** 'subnet' | 'address' | 'range' | 'container' | 'vrf'. */
  object: string;
  /** What it was, in the words the table shows — `10.20.30.0/24`. */
  label: string;
  /** Field-by-field, for the readable diff. Only what changed. */
  changes?: { field: string; before?: string; after?: string }[];
}

export interface IpamState {
  subnets?: IpamSubnet[];
  entries?: IpamEntry[];
  /** LT-294: DHCP pools and excluded spans. */
  ranges?: IpamRange[];
  /** LT-297: the hierarchy, the routing tables, and what happened. */
  containers?: IpamContainer[];
  vrfs?: IpamVrf[];
  audit?: IpamAuditEntry[];
  /** Pre-LT-289. Read only by the migration. */
  reservations?: IpamReservation[];
}

/** The most history a project carries. Past this the oldest go: a register's
 *  history is worth keeping, and worth keeping bounded — this travels inside
 *  every exported package. */
export const AUDIT_LIMIT = 500;

/** Where the register learned an address. A typed one carries a `kind`. */
export type AddressSource = 'drawn' | 'crawled' | 'typed';

export interface IpamAddress {
  address: string;
  /** Sorts and compares as a number, which is the whole reason this exists. */
  value: number;
  label: string;
  source: AddressSource;
  /** Set when `source` is 'typed' — what the register holds it as. */
  kind?: EntryKind;
  /** Set when `source` is 'typed' — so the row can be edited or removed. */
  entryId?: string;
  nodeId?: string;
  /** Which of the device's addresses this is (LT-295): the id lets an edit
   *  here write through to the right one on the device. */
  addressId?: string;
  /** Which of the device's addresses this is — "Management", "Loopback0". */
  interfaceLabel?: string;
  mac?: string;
  vlan?: string;
  note?: string;
  assignment?: AssignmentType;
  hostname?: string;
  fqdn?: string;
  owner?: string;
  purpose?: string;
  /** Set when the address falls inside a range (LT-294). */
  inRange?: { id: string; kind: RangeKind; name?: string };
  /** Which routing table this is in (LT-297). */
  vrfId: string;
}

export type SubnetOrigin = 'declared' | 'connected route' | 'from addresses';

export interface IpamBlock {
  cidr: string;
  /** Network address as a number, and the prefix length, for containment. */
  network: number;
  prefix: number;
  name?: string;
  vlan?: number;
  note?: string;
  origin: SubnetOrigin;
  /** Addresses that belong here, in address order. */
  addresses: IpamAddress[];
  /** Usable host addresses: the block minus network and broadcast, except
   *  for /31 and /32 where every address is usable (RFC 3021). */
  usable: number;
  /** Addresses something is on: devices, plus entries held as reserved or in
   *  use. An excluded address is not one of these (LT-289). */
  used: number;
  /** Addresses nobody may hand out. Subtracted from free, counted in neither. */
  excluded: number;
  /** Usable addresses inside a DHCP pool (LT-294). Not free to hand out by
   *  hand, and not "used" either — a server owns them. */
  pooled: number;
  free: number;
  /** The ranges that fall in this block, in address order. */
  ranges: (IpamRange & { fromValue: number; toValue: number; size: number })[];
  /** The lowest usable address nothing is on, or null when the block is full
   *  or too large to walk (anything shorter than a /16 — a /8 has sixteen
   *  million addresses and the answer is always "the second one"). */
  nextFree: string | null;
  /** Set when the subnet is in the register by hand, which is what makes it
   *  editable. A derived block has none until it is adopted (LT-288). */
  subnetId?: string;
  /** Set when a block the operator declared is also one the network confirms —
   *  a device's connected route, or simply addresses sitting in it. Adopting a
   *  subnet must not hide where it came from. */
  alsoDerived?: Exclude<SubnetOrigin, 'declared'>;
  /** The interface a connected route named, kept as a suggestion for the name
   *  field even after the subnet is declared. */
  routeInterface?: string;
  /** LT-297: which routing table, and which folder of address space. */
  vrfId: string;
  containerId?: string;
}

export interface IpamConflict {
  vrfId: string;
  cidr: string;
  address: string;
  holders: { nodeId: string; label: string }[];
}

export interface IpamContainerNode {
  id: string;
  name: string;
  cidr: string;
  network: number;
  prefix: number;
  vrfId: string;
  note?: string;
  parentId?: string;
  children: IpamContainerNode[];
  /** Subnets directly inside this container and no deeper one. */
  subnets: IpamBlock[];
  /** Every address of the block, used or not. */
  capacity: number;
  /** Address space already given to a child container or a subnet. */
  allocated: number;
  freeSpace: number;
  /** Rolled up from everything underneath. */
  usable: number;
  used: number;
}

export interface IpamModel {
  blocks: IpamBlock[];
  vrfs: IpamVrf[];
  containers: IpamContainerNode[];
  conflicts: IpamConflict[];
  /** Addresses that parse but sit in no block — only possible when a block
   *  was removed while something was still on it. Kept visible rather than
   *  dropped: an address that vanishes from a register is worse than one in
   *  an awkward place. */
  loose: IpamAddress[];
  /** Devices carrying an address that is not IPv4, or not an address at all. */
  skipped: { nodeId: string; label: string; address: string }[];
}

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** An IPv4 address as a number, or null when it is not one. */
export function toValue(address: string): number | null {
  const m = V4.exec(address.trim());
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return octets.reduce((acc, o) => acc * 256 + o, 0);
}

export function toAddress(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}

/** `10.0.0.0/24` as its network number and prefix, or null. */
export function parseCidr(cidr: string): { network: number; prefix: number } | null {
  const [head, tail, ...rest] = cidr.trim().split('/');
  if (rest.length || !head || tail === undefined) return null;
  const prefix = Number(tail);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32 || tail.trim() === '') return null;
  const value = toValue(head);
  if (value === null) return null;
  const size = 2 ** (32 - prefix);
  return { network: Math.floor(value / size) * size, prefix };
}

/** The canonical form: the network address, not whatever was typed inside it. */
export function normaliseCidr(cidr: string): string | null {
  const parsed = parseCidr(cidr);
  return parsed ? `${toAddress(parsed.network)}/${parsed.prefix}` : null;
}

/** Why a typed subnet cannot be used, in the words to put under the field. */
export function subnetProblem(cidr: string): string | null {
  if (!cidr.trim()) return 'Give a subnet, like 10.20.30.0/24.';
  return parseCidr(cidr) ? null : 'That is not an IPv4 subnet. It wants an address and a prefix, like 10.20.30.0/24.';
}

/** Why a typed range cannot be used, in the words to put under the field. */
export function rangeProblem(from: string, to: string, block?: { network: number; prefix: number }): string | null {
  const a = toValue(from);
  const b = toValue(to);
  if (a === null) return 'The first address is not an IPv4 address.';
  if (b === null) return 'The last address is not an IPv4 address.';
  if (b < a) return 'The last address comes before the first one.';
  if (block && (!contains(block, a) || !contains(block, b))) return 'The range has to sit inside the subnet.';
  return null;
}

function contains(block: { network: number; prefix: number }, value: number): boolean {
  const size = 2 ** (32 - block.prefix);
  return value >= block.network && value < block.network + size;
}

function usableOf(prefix: number): number {
  const size = 2 ** (32 - prefix);
  return prefix >= 31 ? size : Math.max(size - 2, 0);
}

/** The /24 an address sits in — the fallback when nothing declares its mask. */
function twentyFourOf(value: number): { network: number; prefix: number } {
  return { network: Math.floor(value / 256) * 256, prefix: 24 };
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Everything the project knows about addresses, bucketed into blocks.
 *
 * Blocks come from three places, in this order of authority: what the operator
 * declared, the connected routes a crawl read off the devices themselves, and
 * failing both, the /24 around an address that is otherwise homeless. An
 * address lands in the *most specific* block that contains it, which is what
 * the device's own routing table would do with it.
 */
export function buildIpam(nodes: readonly TopoNode[], state: IpamState | undefined): IpamModel {
  const blocks: IpamBlock[] = [];
  const add = (
    parsed: { network: number; prefix: number },
    origin: SubnetOrigin,
    extra: Partial<IpamBlock> & { vrfId?: string } = {},
  ) => {
    const cidr = `${toAddress(parsed.network)}/${parsed.prefix}`;
    const vrfId = extra.vrfId ?? DEFAULT_VRF.id;
    // Keyed by routing table as well as prefix: the same subnet in two VRFs is
    // two subnets, and that is the point of having them (LT-297).
    const already = blocks.find((b) => b.cidr === cidr && b.vrfId === vrfId);
    if (already) {
      // A subnet the operator declared *and* the network confirms. Adopting
      // one must not throw away the fact that a device routes it (LT-288).
      if (origin !== 'declared' && !already.alsoDerived) already.alsoDerived = origin;
      if (extra.routeInterface && !already.routeInterface) already.routeInterface = extra.routeInterface;
      return;
    }
    blocks.push({
      cidr,
      network: parsed.network,
      prefix: parsed.prefix,
      origin,
      addresses: [],
      usable: usableOf(parsed.prefix),
      used: 0,
      excluded: 0,
      pooled: 0,
      ranges: [],
      free: usableOf(parsed.prefix),
      nextFree: null,
      ...extra,
      // After the spread: `extra` carries an explicit `vrfId: undefined` when
      // the caller did not set one, which would undo the default above.
      vrfId,
    });
  };

  for (const s of state?.subnets ?? []) {
    const parsed = parseCidr(s.cidr);
    if (!parsed) continue;
    add(parsed, 'declared', {
      name: s.name, vlan: s.vlan, note: s.note, subnetId: s.id,
      vrfId: s.vrfId, containerId: s.containerId,
    });
  }

  const addresses: IpamAddress[] = [];
  const skipped: IpamModel['skipped'] = [];

  for (const n of nodes) {
    if (n.type !== 'device') continue;
    const d = (n.data ?? {}) as Partial<DeviceNodeData>;
    const label = text(d.label) ?? n.id;
    // Connected routes are the only place a real mask is known, so they make
    // blocks before anything is placed in them.
    for (const r of d.inventory?.routes ?? []) {
      if (r.family !== 4 || r.protocol !== 'connected') continue;
      const parsed = parseCidr(r.prefix);
      if (parsed) add(parsed, 'connected route', { name: text(r.interface), routeInterface: text(r.interface) });
    }
    for (const a of d.addresses ?? []) {
      const value = toValue(a.address ?? '');
      if (value === null) {
        if (text(a.address)) skipped.push({ nodeId: n.id, label, address: a.address.trim() });
        continue;
      }
      addresses.push({
        address: a.address.trim(),
        value,
        label,
        // A device on the diagram is in the default routing table: nothing on
        // a drawing says which VRF a box is in, and inventing one would be a
        // guess dressed as a fact.
        vrfId: DEFAULT_VRF.id,
        source: d.discoveredVia ? 'crawled' : 'drawn',
        nodeId: n.id,
        addressId: a.id,
        interfaceLabel: text(a.label),
        mac: text(d.mac),
        vlan: text(d.vlan),
        hostname: text(d.hostname),
      });
    }
  }

  for (const e of entriesOf(state)) {
    const value = toValue(e.address ?? '');
    if (value === null) continue;
    addresses.push({
      address: e.address.trim(),
      value,
      label: e.label.trim() || e.kind,
      vrfId: e.vrfId ?? DEFAULT_VRF.id,
      source: 'typed',
      kind: e.kind,
      entryId: e.id,
      note: text(e.note),
      assignment: e.assignment,
      hostname: text(e.hostname),
      fqdn: text(e.fqdn),
      mac: text(e.mac),
      owner: text(e.owner),
      purpose: text(e.purpose),
    });
  }

  /** The most specific block holding an address, *inside its own routing
   *  table* — a /30 inside a declared /16 wins, exactly as the routing table
   *  would have it, and a block in another VRF is not a candidate at all. */
  const holderOf = (value: number, vrfId: string = DEFAULT_VRF.id): IpamBlock | undefined => {
    let best: IpamBlock | undefined;
    for (const b of blocks) {
      if (b.vrfId !== vrfId || !contains(b, value)) continue;
      if (!best || b.prefix > best.prefix) best = b;
    }
    return best;
  };

  // Anything still homeless makes its own /24, so nothing is invisible. An
  // address that already has a home *confirms* it: a subnet someone declared
  // and then put devices on was still derived from those addresses, and
  // adopting it must not erase that (LT-288).
  for (const a of addresses) {
    const holder = holderOf(a.value, a.vrfId);
    if (holder) {
      if (holder.origin === 'declared' && !holder.alsoDerived) holder.alsoDerived = 'from addresses';
      continue;
    }
    add(twentyFourOf(a.value), 'from addresses', { vrfId: a.vrfId });
  }

  for (const a of addresses) holderOf(a.value, a.vrfId)?.addresses.push(a);

  const loose = addresses.filter((a) => !holderOf(a.value, a.vrfId));

  // LT-294: spans, placed in whichever block holds their first address.
  for (const r of state?.ranges ?? []) {
    const fromValue = toValue(r.from ?? '');
    const toValueEnd = toValue(r.to ?? '');
    if (fromValue === null || toValueEnd === null || toValueEnd < fromValue) continue;
    const holder = holderOf(fromValue);
    if (!holder) continue;
    holder.ranges.push({ ...r, fromValue, toValue: toValueEnd, size: toValueEnd - fromValue + 1 });
  }

  for (const b of blocks) {
    b.addresses.sort((x, y) => x.value - y.value || x.label.localeCompare(y.label));
    b.ranges.sort((x, y) => x.fromValue - y.fromValue);

    /** Every usable address of this block a range covers, by kind. Counted by
     *  walking only where the block is small enough to walk; a /8 with a pool
     *  in it is counted by arithmetic instead. */
    const size = 2 ** (32 - b.prefix);
    const firstUsable = b.prefix >= 31 ? b.network : b.network + 1;
    const lastUsable = b.prefix >= 31 ? b.network + size - 1 : b.network + size - 2;
    const clamp = (r: { fromValue: number; toValue: number }) => {
      const from = Math.max(r.fromValue, firstUsable);
      const to = Math.min(r.toValue, lastUsable);
      return to < from ? null : { from, to };
    };

    // By address, not by row: a device with two names on one address is one
    // address taken, and an excluded address is neither used nor free.
    const excluded = new Set<number>();
    const used = new Set<number>();
    for (const a of b.addresses) (a.kind === 'excluded' ? excluded : used).add(a.value);
    // An address both excluded and in use is in use; the exclusion is the
    // thing that turned out to be wrong, and hiding it would be the lie.
    for (const v of used) excluded.delete(v);

    // A range's addresses, minus anything already counted as used or
    // excluded on its own — a DHCP reservation inside its own pool is one
    // address, not two.
    let pooled = 0;
    let rangeExcluded = 0;
    const covered = new Set<number>();
    for (const r of b.ranges) {
      const span = clamp(r);
      if (!span) continue;
      let count = span.to - span.from + 1;
      // Walk only what is worth walking; beyond that the overlap with
      // individual records is a rounding error on a number in the millions.
      if (count <= 65536) {
        count = 0;
        for (let v = span.from; v <= span.to; v += 1) {
          if (covered.has(v)) continue;
          covered.add(v);
          if (used.has(v) || excluded.has(v)) continue;
          count += 1;
        }
      }
      if (r.kind === 'dhcp') pooled += count;
      else rangeExcluded += count;
    }

    b.used = used.size;
    b.excluded = excluded.size + rangeExcluded;
    b.pooled = pooled;
    b.free = Math.max(b.usable - b.used - b.excluded - b.pooled, 0);
    b.nextFree = nextFreeIn(b, new Set([...used, ...excluded]), b.ranges);

    // Tell each address which range it sits in, so the row can say so.
    for (const a of b.addresses) {
      const r = b.ranges.find((x) => a.value >= x.fromValue && a.value <= x.toValue);
      if (r) a.inRange = { id: r.id, kind: r.kind, name: r.name };
    }
  }

  blocks.sort((a, b) => a.vrfId.localeCompare(b.vrfId) || a.network - b.network || a.prefix - b.prefix);

  return {
    blocks,
    loose,
    skipped,
    vrfs: vrfsOf(state),
    containers: containerTree(state, blocks),
    conflicts: conflictsIn(blocks),
  };
}

/** Every routing table the project has, the default one always first. */
export function vrfsOf(state: IpamState | undefined): IpamVrf[] {
  const own = (state?.vrfs ?? []).filter((v) => v.id !== DEFAULT_VRF.id);
  return [DEFAULT_VRF, ...own];
}

/**
 * Two devices on one address in one routing table.
 *
 * Deliberately narrow. A typed record sitting on an address a device holds is
 * not a conflict — it is somebody documenting the device — and flagging it
 * would train people to ignore the column. Two *devices* answering to the
 * same address is the fault that takes a network down, and that is what this
 * reports.
 */
export function conflictsIn(blocks: readonly IpamBlock[]): IpamConflict[] {
  const out: IpamConflict[] = [];
  for (const b of blocks) {
    const byValue = new Map<number, IpamAddress[]>();
    for (const a of b.addresses) {
      if (!a.nodeId) continue;
      byValue.set(a.value, [...(byValue.get(a.value) ?? []), a]);
    }
    for (const [value, held] of byValue) {
      const devices = [...new Set(held.map((a) => a.nodeId!))];
      if (devices.length < 2) continue;
      out.push({
        vrfId: b.vrfId,
        cidr: b.cidr,
        address: toAddress(value),
        holders: held
          .filter((a, i) => held.findIndex((x) => x.nodeId === a.nodeId) === i)
          .map((a) => ({ nodeId: a.nodeId!, label: a.label })),
      });
    }
  }
  return out.sort((a, b) => toValue(a.address)! - toValue(b.address)!);
}

/**
 * The containers, as a tree, with each subnet under the most specific one that
 * holds it and the numbers rolled up.
 *
 * `allocated` is the address space already given to something — a child
 * container or a subnet — and `freeSpace` is what is left to allocate out of.
 * That is a different question from how many *addresses* are used, which is
 * `used`, and the two are shown side by side because a container can be full
 * of empty subnets.
 */
export function containerTree(state: IpamState | undefined, blocks: readonly IpamBlock[]): IpamContainerNode[] {
  const parsed = (state?.containers ?? [])
    .map((c) => ({ c, at: parseCidr(c.cidr) }))
    .filter((x): x is { c: IpamContainer; at: { network: number; prefix: number } } => x.at !== null);

  const nodes = new Map<string, IpamContainerNode>();
  for (const { c, at } of parsed) {
    nodes.set(c.id, {
      id: c.id,
      name: c.name,
      cidr: `${toAddress(at.network)}/${at.prefix}`,
      network: at.network,
      prefix: at.prefix,
      vrfId: c.vrfId ?? DEFAULT_VRF.id,
      note: c.note,
      parentId: c.parentId,
      children: [],
      subnets: [],
      capacity: 2 ** (32 - at.prefix),
      allocated: 0,
      freeSpace: 0,
      usable: 0,
      used: 0,
    });
  }

  // A container's parent is the most specific other container that holds it,
  // in the same routing table — worked out rather than trusted, because a
  // `parentId` and a CIDR can disagree and the CIDR is the fact.
  const roots: IpamContainerNode[] = [];
  for (const n of nodes.values()) {
    let best: IpamContainerNode | undefined;
    for (const other of nodes.values()) {
      if (other.id === n.id || other.vrfId !== n.vrfId) continue;
      if (!contains(other, n.network) || other.prefix >= n.prefix) continue;
      if (!best || other.prefix > best.prefix) best = other;
    }
    n.parentId = best?.id;
    if (best) best.children.push(n);
    else roots.push(n);
  }

  for (const b of blocks) {
    let best: IpamContainerNode | undefined;
    for (const n of nodes.values()) {
      if (n.vrfId !== b.vrfId || !contains(n, b.network)) continue;
      if (!best || n.prefix > best.prefix) best = n;
    }
    if (best) best.subnets.push(b);
  }

  const roll = (n: IpamContainerNode): void => {
    n.children.sort((a, b) => a.network - b.network || a.prefix - b.prefix);
    n.subnets.sort((a, b) => a.network - b.network || a.prefix - b.prefix);
    for (const c of n.children) roll(c);
    n.allocated =
      n.children.reduce((sum, c) => sum + c.capacity, 0) +
      n.subnets.reduce((sum, b) => sum + 2 ** (32 - b.prefix), 0);
    n.freeSpace = Math.max(n.capacity - n.allocated, 0);
    n.usable =
      n.children.reduce((sum, c) => sum + c.usable, 0) + n.subnets.reduce((sum, b) => sum + b.usable, 0);
    n.used =
      n.children.reduce((sum, c) => sum + c.used, 0) + n.subnets.reduce((sum, b) => sum + b.used, 0);
  };
  roots.sort((a, b) => a.vrfId.localeCompare(b.vrfId) || a.network - b.network || a.prefix - b.prefix);
  for (const r of roots) roll(r);
  return roots;
}

/** The register's own addresses, reading the pre-LT-289 field where a project
 *  has not been through `migrate.ts` — an export opened straight from disk,
 *  for one. */
export function entriesOf(state: IpamState | undefined): IpamEntry[] {
  const entries = state?.entries ?? [];
  const old = (state?.reservations ?? []).filter(
    (r) => !entries.some((e) => e.id === r.id || e.address.trim() === r.address.trim()),
  );
  return [...entries, ...old.map((r): IpamEntry => ({ ...r, kind: 'reserved' }))];
}

/**
 * The lowest usable address in a block that nothing is on.
 *
 * Blocks shorter than a /16 are not walked: the answer for a /8 is always its
 * second address, and counting to sixteen million to say so would hold the
 * interface up for no one's benefit.
 */
export function nextFreeIn(
  block: { network: number; prefix: number },
  taken: ReadonlySet<number>,
  ranges: readonly { fromValue: number; toValue: number }[] = [],
): string | null {
  if (block.prefix < 16) return null;
  const size = 2 ** (32 - block.prefix);
  const first = block.prefix >= 31 ? block.network : block.network + 1;
  const last = block.prefix >= 31 ? block.network + size - 1 : block.network + size - 2;
  for (let v = first; v <= last; v += 1) {
    if (taken.has(v)) continue;
    // A pool is a server's to hand out and an excluded span is nobody's; the
    // next free address is neither (LT-294).
    if (ranges.some((r) => v >= r.fromValue && v <= r.toValue)) continue;
    return toAddress(v);
  }
  return null;
}

/** A block's utilisation as a percentage, rounded, 0 when it has no room. */
export function utilisation(block: IpamBlock): number {
  return block.usable === 0 ? 0 : Math.round((block.used / block.usable) * 100);
}

/**
 * The register as rows, for the CSV the spreadsheet this replaces was.
 *
 * One row per known address rather than one per subnet: a subnet summary is
 * two sums away from this, and the rows are what gets pasted into a change
 * request.
 */
export function ipamRows(model: IpamModel): string[][] {
  const rows: string[][] = [
    ['Subnet', 'Subnet name', 'VLAN', 'Address', 'Name', 'Held as', 'Used as', 'Hostname',
     'FQDN', 'Owner', 'Purpose', 'Interface', 'MAC', 'In range', 'Known from', 'Note'],
  ];
  const row = (b: IpamBlock | null, a: IpamAddress) => [
    b?.cidr ?? '',
    b?.name ?? '',
    b?.vlan === undefined ? '' : String(b.vlan),
    a.address,
    a.label,
    a.kind ?? '',
    a.assignment ?? '',
    a.hostname ?? '',
    a.fqdn ?? '',
    a.owner ?? '',
    a.purpose ?? '',
    a.interfaceLabel ?? '',
    a.mac ?? '',
    a.inRange ? (a.inRange.name ?? a.inRange.kind) : '',
    a.source,
    a.note ?? '',
  ];
  for (const b of model.blocks) for (const a of b.addresses) rows.push(row(b, a));
  for (const a of model.loose) rows.push(row(null, a));
  return rows;
}
