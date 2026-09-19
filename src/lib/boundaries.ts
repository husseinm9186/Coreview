/**
 * Logical boundaries (LT-166): a section that says what kind of area it is —
 * a VLAN, a subnet, a security zone, a VRF, a BGP autonomous system or an OSPF
 * area — and carries that area's identifier.
 *
 * Built on sections, not beside them: membership stays geometric (D-012), so a
 * device dragged into "VLAN 20" is in VLAN 20 on the diagram without a list to
 * maintain. The identifier is checked, but a wrong one is flagged rather than
 * refused — a diagram being drawn is allowed to be half-finished.
 */
import type { DeviceNodeData } from '../types/domain';

export type BoundaryKind = 'vlan' | 'subnet' | 'security-zone' | 'vrf' | 'bgp-as' | 'ospf-area';

export interface BoundaryInfo {
  /** The palette and inspector name. */
  label: string;
  /** What precedes the identifier in the title chip: "VLAN 20". */
  prefix: string;
  /** What the identifier field asks for. */
  hint: string;
  /** Outline dash, canvas and export alike, so kinds differ without colour. */
  dash: string;
}

export const BOUNDARIES: Record<BoundaryKind, BoundaryInfo> = {
  vlan: { label: 'VLAN boundary', prefix: 'VLAN', hint: 'VLAN ID, 1–4094', dash: '6 4' },
  subnet: { label: 'Subnet', prefix: '', hint: 'Prefix, e.g. 192.0.2.0/24 or 2001:db8::/48', dash: '2 3' },
  'security-zone': { label: 'Security zone', prefix: 'Zone', hint: 'Zone name, e.g. DMZ', dash: '10 4' },
  vrf: { label: 'VRF', prefix: 'VRF', hint: 'VRF name', dash: '10 3 2 3' },
  'bgp-as': { label: 'BGP AS', prefix: 'AS', hint: 'AS number, 1–4294967295, or asdot like 1.10', dash: '14 5' },
  'ospf-area': { label: 'OSPF area', prefix: 'Area', hint: 'Area number or dotted, e.g. 0 or 0.0.0.1', dash: '4 2 4 6' },
};

export const BOUNDARY_KINDS = Object.keys(BOUNDARIES) as BoundaryKind[];

export function isBoundaryKind(value: unknown): value is BoundaryKind {
  // Own keys only: `in` would also accept `toString` and the rest of the
  // prototype, which a crafted document could carry into a lookup.
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BOUNDARIES, value);
}

const U32 = 4294967295;
const whole = (s: string) => /^\d+$/.test(s);
const inRange = (s: string, lo: number, hi: number) => whole(s) && Number(s) >= lo && Number(s) <= hi;

function ipv4(s: string): boolean {
  const parts = s.split('.');
  return parts.length === 4 && parts.every((p) => inRange(p, 0, 255) && String(Number(p)) === p);
}

function ipv6(s: string): boolean {
  if (!/^[0-9a-f:]+$/i.test(s) || (s.match(/::/g) ?? []).length > 1) return false;
  const groups = s.split(':');
  if (s.includes('::')) return groups.length <= 8 && groups.every((g) => g === '' || /^[0-9a-f]{1,4}$/i.test(g));
  return groups.length === 8 && groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g));
}

/** What is wrong with an identifier for this kind, or null when it is fine or
 *  empty. Empty is fine: the section is still being drawn. */
export function boundaryIdProblem(kind: BoundaryKind, raw: string | undefined): string | null {
  const id = raw?.trim() ?? '';
  if (!id) return null;
  switch (kind) {
    case 'vlan':
      return inRange(id, 1, 4094) ? null : 'A VLAN ID is a whole number from 1 to 4094';
    case 'subnet': {
      const [addr, len, extra] = id.split('/');
      if (extra !== undefined || addr === undefined || len === undefined) return 'Write the prefix with its length, e.g. 192.0.2.0/24';
      if (ipv4(addr)) return inRange(len, 0, 32) ? null : 'An IPv4 prefix length is 0 to 32';
      if (ipv6(addr)) return inRange(len, 0, 128) ? null : 'An IPv6 prefix length is 0 to 128';
      return 'Not an IPv4 or IPv6 address';
    }
    case 'security-zone':
      return id.length <= 60 ? null : 'Keep a zone name to 60 characters';
    case 'vrf':
      return /^[A-Za-z0-9_.:-]{1,32}$/.test(id) ? null : 'A VRF name is up to 32 letters, digits and _ . : -';
    case 'bgp-as': {
      if (inRange(id, 1, U32)) return null;
      const dot = /^(\d+)\.(\d+)$/.exec(id);
      if (dot && inRange(dot[1]!, 0, 65535) && inRange(dot[2]!, 0, 65535) && Number(dot[1]) * 65536 + Number(dot[2]) > 0) return null;
      return 'An AS number is 1 to 4294967295, or asdot like 1.10';
    }
    case 'ospf-area':
      return inRange(id, 0, U32) || ipv4(id) ? null : 'An OSPF area is a number or dotted like 0.0.0.1';
  }
}

/** The chip a boundary shows: "VLAN 20", "192.0.2.0/24", "AS 64500". Empty for
 *  a plain section or a boundary with no identifier yet. */
export function boundaryChip(d: Pick<DeviceNodeData, 'boundaryKind' | 'boundaryId'>): string {
  if (!isBoundaryKind(d.boundaryKind)) return '';
  const id = d.boundaryId?.trim();
  if (!id) return BOUNDARIES[d.boundaryKind].prefix || BOUNDARIES[d.boundaryKind].label;
  const prefix = BOUNDARIES[d.boundaryKind].prefix;
  return prefix ? `${prefix} ${id}` : id;
}
