/**
 * What part each crawled device plays (LT-214): core, distribution, access,
 * edge, firewall, load balancer or wireless.
 *
 * LT-145 laid a diagram out top to bottom from each device's *type* and its
 * default route. A crawl calls every switch a switch, so the core and a closet
 * switch landed on the same row. This reads the evidence a crawl already has —
 * the platform string, spanning-tree root, how many trunks and access ports are
 * up, how many hosts are plugged in, which other switches it links to — and
 * says which role fits, with the reasons, so the operator can see why and
 * overrule it.
 *
 * Every rule is evidence, not a vendor's model list: model words are used only
 * where the product line is unambiguous about its job (a FortiGate is a
 * firewall), and never to tell a core switch from an access one.
 */
import type { CrawledDevice, DeviceClassName } from './ipc';
import type { DeviceType } from '../types/domain';

export type Role = 'core' | 'distribution' | 'access' | 'edge' | 'firewall' | 'load-balancer' | 'wireless';

export interface InferredRole {
  role: Role;
  reasons: string[];
}

export const ROLE_LABEL: Record<Role, string> = {
  core: 'Core',
  distribution: 'Distribution',
  access: 'Access',
  edge: 'Edge',
  firewall: 'Firewall',
  'load-balancer': 'Load balancer',
  wireless: 'Wireless',
};

/** The glyph a role draws with, so LT-145's layout puts it on the right row. */
export const ROLE_TYPE: Record<Role, DeviceType> = {
  core: 'core-switch',
  distribution: 'distribution-switch',
  access: 'access-switch',
  edge: 'router',
  firewall: 'firewall',
  'load-balancer': 'load-balancer',
  wireless: 'wireless-controller',
};

const FIREWALL = /\b(fortigate|fortiwifi|asa\s?\d|firepower|pa-\d|palo alto|srx\d|check ?point|sonicwall|sophos xg)\b/i;
const LOAD_BALANCER = /\b(big-?ip|netscaler|citrix adc|a10 thunder|kemp|avi vantage)\b/i;
const INFRA: ReadonlySet<DeviceClassName> = new Set(['switch', 'router', 'firewall']);

const key = (s: string) => s.trim().toLowerCase();

export function inferRoles(devices: readonly CrawledDevice[]): Map<string, InferredRole> {
  const out = new Map<string, InferredRole>();
  const byName = new Map(devices.map((d) => [key(d.hostname), d]));
  const addresses = new Set(devices.flatMap((d) => [d.address, ...d.addresses.map((a) => a.ip)]));

  for (const d of devices) {
    const text = [d.platform, d.version].filter(Boolean).join(' ');
    if (d.class === 'firewall' || FIREWALL.test(text)) {
      out.set(key(d.hostname), { role: 'firewall', reasons: [d.class === 'firewall' ? 'identified as a firewall' : `platform ${d.platform ?? d.version}`] });
      continue;
    }
    if (LOAD_BALANCER.test(text)) {
      out.set(key(d.hostname), { role: 'load-balancer', reasons: [`platform ${d.platform ?? d.version}`] });
      continue;
    }
    if (d.class === 'wireless-controller' || d.class === 'access-point') {
      out.set(key(d.hostname), { role: 'wireless', reasons: ['identified as wireless'] });
      continue;
    }
    if (d.class === 'router') {
      const outside = d.defaultNextHop && !addresses.has(d.defaultNextHop);
      out.set(key(d.hostname), {
        role: 'edge',
        reasons: [outside ? `a router whose default route leaves the crawled network (${d.defaultNextHop})` : 'a router'],
      });
      continue;
    }
    if (d.class !== 'switch') continue;

    const infraNeighbours = new Set(
      d.neighbors.filter((n) => INFRA.has(n.class) || byName.has(key(n.shortName))).map((n) => key(n.shortName || n.deviceId)),
    );
    const hosts = d.attached.filter((a) => a.portPopulation === 1).length;
    const modes = d.portVlans ?? [];
    const up = new Set((d.ports ?? []).filter((p) => p.status === 'connected').map((p) => p.port));
    const upAccess = modes.filter((m) => m.mode === 'access' && up.has(m.port)).length;
    const upTrunks = modes.filter((m) => m.mode === 'trunk' && up.has(m.port)).length;
    const stp = d.spanningTree ?? [];
    const rootOf = stp.filter((i) => i.isRoot).length;
    const mostlyRoot = stp.length > 0 && rootOf / stp.length > 0.5;
    const routed = (d.routes ?? []).some((r) => !['connected', 'local', 'static'].includes(r.protocol));

    const reasons: string[] = [];
    if (hosts >= 4 || (upAccess >= 4 && upAccess >= upTrunks * 2)) {
      if (hosts >= 4) reasons.push(`${hosts} hosts plugged straight in`);
      if (upAccess >= 4) reasons.push(`${upAccess} access ports up`);
      if (infraNeighbours.size <= 2) reasons.push(`${infraNeighbours.size} switch or router neighbour${infraNeighbours.size === 1 ? '' : 's'}`);
      out.set(key(d.hostname), { role: 'access', reasons });
      continue;
    }
    if (mostlyRoot && infraNeighbours.size >= 2) {
      reasons.push(`spanning-tree root for ${rootOf} of ${stp.length} instances`, `${infraNeighbours.size} switch or router neighbours`);
      if (routed) reasons.push('learns routes from a routing protocol');
      out.set(key(d.hostname), { role: 'core', reasons });
      continue;
    }
    if (routed && infraNeighbours.size >= 2) {
      out.set(key(d.hostname), { role: 'core', reasons: ['learns routes from a routing protocol', `${infraNeighbours.size} switch or router neighbours`] });
      continue;
    }
    if (infraNeighbours.size >= 3) {
      out.set(key(d.hostname), { role: 'distribution', reasons: [`${infraNeighbours.size} switch or router neighbours`, `${hosts} hosts plugged straight in`] });
      continue;
    }
  }

  // Second pass: a switch between an inferred core and inferred access
  // switches, with nothing else said about it, is distribution; a switch hung
  // off one other switch with nothing else is access.
  for (const d of devices) {
    if (d.class !== 'switch' || out.has(key(d.hostname))) continue;
    const roles = d.neighbors.map((n) => out.get(key(n.shortName || n.deviceId))?.role);
    if (roles.includes('core') && roles.includes('access')) {
      out.set(key(d.hostname), { role: 'distribution', reasons: ['links a core switch to access switches'] });
    } else if (roles.filter((r) => r === 'core' || r === 'distribution').length >= 1 && d.neighbors.length <= 2) {
      out.set(key(d.hostname), { role: 'access', reasons: ['hangs off a core or distribution switch with nothing below it'] });
    }
  }
  return out;
}
