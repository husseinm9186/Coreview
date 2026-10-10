/**
 * Clusters: what a big estate folds into so that it can be walked.
 *
 * A device holding six or more devices below it can collapse to a chip —
 * "12 access · 2 down" — and when the diagram is zoomed out so far that a
 * fan's labels would be dust, every such fan folds on its own. The chip says
 * what is inside and the worst of it, so nothing is lost from view that the
 * view could have shown.
 *
 * Nothing here changes the document: which devices are folded is window
 * state, and the branch itself is `collapseBranch.ts`'s.
 */
import { branchFolder } from './collapseBranch';
import type { TopoEdge, TopoNode } from '../state/store';
import type { DeviceNodeData, DeviceType, HealthStatus } from '../types/domain';
import { TIER_OF_TYPE } from './hierarchyLayout';

/** A device with this many below it is a fan worth folding. */
export const FOLD_MIN = 6;

/** The zoom under which the fans fold on their own: the same line below
 *  which the canvas stops drawing labels, since a thirteen-pixel label is
 *  five pixels there and a fan of them is dust. */
export const AUTO_FOLD_ZOOM = 0.4;

/** The devices with at least `min` devices hanging below them, each with
 *  the set it would fold away. Only devices count, never notes. */
export function holdersBelow(nodes: TopoNode[], edges: TopoEdge[], min = FOLD_MIN): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const device = new Set(nodes.filter((n) => n.type === 'device').map((n) => n.id));
  const fold = branchFolder(nodes, edges);
  for (const n of nodes) {
    if (!device.has(n.id)) continue;
    const below = fold(n.id);
    for (const id of below) if (!device.has(id)) below.delete(id);
    if (below.size >= min) out.set(n.id, below);
  }
  return out;
}

/** The holders nearest the leaves: those whose fold holds no other holder.
 *  Folding these leaves the backbone drawn and the fans as chips; folding
 *  a core would swallow the whole estate into one chip. */
export function lowestHolders(holders: Map<string, Set<string>>): string[] {
  return [...holders]
    .filter(([, below]) => ![...below].some((id) => holders.has(id)))
    .map(([id]) => id)
    .sort();
}

const SEVERITY: Record<HealthStatus, number> = {
  down: 5,
  warning: 4,
  healthy: 3,
  maintenance: 2,
  disabled: 1,
  unknown: 0,
};

/** The status that matters most among several: down before warning before
 *  healthy, and a device nobody has checked last. */
export function worstOf(statuses: Iterable<HealthStatus>): HealthStatus {
  let worst: HealthStatus = 'unknown';
  for (const s of statuses) if (SEVERITY[s] > SEVERITY[worst]) worst = s;
  return worst;
}

/** The role word a tree and a chip sort devices under. A crawl's own role
 *  wins; the glyph decides the rest. */
export type RoleKey =
  | 'wan' | 'edge' | 'firewall' | 'core' | 'distribution' | 'access' | 'wireless'
  | 'compute' | 'services' | 'storage' | 'endpoints' | 'other';

export const ROLE_ORDER: RoleKey[] = [
  'wan', 'edge', 'firewall', 'core', 'distribution', 'access', 'wireless', 'compute', 'services', 'storage', 'endpoints', 'other',
];

export const ROLE_WORD: Record<RoleKey, { one: string; many: string; title: string }> = {
  wan: { one: 'WAN', many: 'WAN', title: 'WAN' },
  edge: { one: 'router', many: 'routers', title: 'Edge' },
  firewall: { one: 'firewall', many: 'firewalls', title: 'Firewalls' },
  core: { one: 'core switch', many: 'core switches', title: 'Core' },
  distribution: { one: 'distribution switch', many: 'distribution switches', title: 'Distribution' },
  access: { one: 'access switch', many: 'access', title: 'Access' },
  wireless: { one: 'AP', many: 'APs', title: 'Wireless' },
  compute: { one: 'server', many: 'servers', title: 'Compute' },
  services: { one: 'service', many: 'services', title: 'Services' },
  storage: { one: 'storage', many: 'storage', title: 'Storage' },
  endpoints: { one: 'endpoint', many: 'endpoints', title: 'Endpoints' },
  other: { one: 'device', many: 'devices', title: 'Other' },
};

const ROLE_OF_LABEL: Record<string, RoleKey> = {
  core: 'core',
  distribution: 'distribution',
  access: 'access',
  edge: 'edge',
  firewall: 'firewall',
  'load balancer': 'services',
  wireless: 'wireless',
};

const ROLE_OF_TYPE: Partial<Record<DeviceType, RoleKey>> = {
  internet: 'wan', cloud: 'wan', 'private-cloud': 'wan', 'mpls-cloud': 'wan', site: 'wan',
  vpn: 'edge', router: 'edge',
  firewall: 'firewall', waf: 'firewall',
  'core-switch': 'core', 'l3-switch': 'core',
  'distribution-switch': 'distribution',
  'access-switch': 'access', 'l2-switch': 'access',
  'wireless-controller': 'wireless', 'access-point': 'wireless',
  server: 'compute', 'vm-host': 'compute', 'blade-chassis': 'compute', vm: 'compute',
  'load-balancer': 'services', application: 'services', database: 'services',
  storage: 'storage',
  printer: 'endpoints', camera: 'endpoints', 'ip-phone': 'endpoints', endpoint: 'endpoints',
};

export function roleOf(data: Pick<DeviceNodeData, 'deviceType' | 'role'>): RoleKey {
  const byLabel = data.role ? ROLE_OF_LABEL[data.role.trim().toLowerCase()] : undefined;
  return byLabel ?? ROLE_OF_TYPE[data.deviceType] ?? 'other';
}

/** The tier a role sits in, for "fold below the access layer first". */
export function tierOfRole(role: RoleKey): number {
  const type = (Object.entries(ROLE_OF_TYPE) as [DeviceType, RoleKey][]).find(([, r]) => r === role)?.[0];
  return type ? (TIER_OF_TYPE[type] ?? 99) : 99;
}

export interface ChipSummary {
  count: number;
  /** The role word for what is inside — "access" when it is all access
   *  switches, "devices" when it is mixed. */
  word: string;
  worst: HealthStatus;
  down: number;
  warning: number;
  text: string;
}

/** What a chip says for the devices it holds: "12 access · 2 down". */
export function chipSummary(held: TopoNode[], statusOf: (id: string) => HealthStatus): ChipSummary {
  const roles = new Set(held.map((n) => roleOf(n.data as DeviceNodeData)));
  const role = roles.size === 1 ? [...roles][0]! : 'other';
  const count = held.length;
  const word = count === 1 ? ROLE_WORD[role].one : ROLE_WORD[role].many;
  const statuses = held.map((n) => statusOf(n.id));
  const down = statuses.filter((s) => s === 'down').length;
  const warning = statuses.filter((s) => s === 'warning').length;
  const worst = worstOf(statuses);
  const parts = [`${count} ${word}`];
  if (down) parts.push(`${down} down`);
  if (warning) parts.push(`${warning} warning`);
  return { count, word, worst, down, warning, text: parts.join(' · ') };
}

/** The holders to fold for "collapse below <role>": the lowest holders of
 *  that role. */
export function holdersOfRole(nodes: TopoNode[], holders: Map<string, Set<string>>, role: RoleKey): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return lowestHolders(holders).filter((id) => {
    const n = byId.get(id);
    return n ? roleOf(n.data as DeviceNodeData) === role : false;
  });
}

/** The roles that have a holder worth folding, in tier order, with how many. */
export function foldableRoles(nodes: TopoNode[], holders: Map<string, Set<string>>): { role: RoleKey; holders: number; devices: number }[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<RoleKey, { holders: number; devices: number }>();
  for (const id of lowestHolders(holders)) {
    const n = byId.get(id);
    if (!n) continue;
    const role = roleOf(n.data as DeviceNodeData);
    const at = out.get(role) ?? { holders: 0, devices: 0 };
    at.holders += 1;
    at.devices += holders.get(id)!.size;
    out.set(role, at);
  }
  return ROLE_ORDER.filter((r) => out.has(r)).map((role) => ({ role, ...out.get(role)! }));
}

/** The fold keys for "collapse by site": one per site name the devices
 *  carry, and one per group for the grouped devices that carry no site. */
export function siteKeys(nodes: TopoNode[]): string[] {
  const keys = new Set<string>();
  for (const n of nodes) {
    if (n.type !== 'device') continue;
    const d = n.data as DeviceNodeData & { groupId?: string };
    const site = d.site?.trim();
    if (site) keys.add(`site:${site}`);
    else if (d.groupId) keys.add(d.groupId);
  }
  return [...keys].sort();
}
