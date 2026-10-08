/**
 * Device templates for the racks: what a kind of box is
 * before it is any particular box — its height in U, its depth, its ports,
 * its power supplies, what it draws and weighs, which way it breathes.
 *
 * Two sources. A generic set written here, by role and size, with the
 * figures a planner reaches for (a 48-port 1U access switch, a 2U two-socket
 * server, a 2U 1500 VA UPS). And the NetBox devicetype-library's YAML
 * (CC0-1.0), one file at a time from wherever the operator keeps it — never
 * vendored — read for the fields the rack cares about: `u_height`,
 * `is_full_depth`, `weight` and `weight_unit`, `airflow`, the `interfaces`
 * list, `power-ports` with their draw, `front-ports` and `rear-ports`.
 */
import { parse as parseYaml } from 'yaml';

import type { Airflow } from './rack';
import type { FurnitureKind } from './rackFurniture';

export interface DeviceTemplate {
  id: string;
  name: string;
  /** Where it came from: ours, or a NetBox device type (manufacturer · model). */
  source: 'generic' | 'netbox';
  manufacturer?: string;
  model?: string;
  partNumber?: string;
  /** A device class it fits, or a kind of furniture, or both — applied to whichever it is dropped on. */
  deviceType?: string;
  furniture?: FurnitureKind;
  units: number;
  depth: 'full' | 'half';
  depthMm?: number;
  ports?: number;
  portNaming?: string;
  /** Power supplies, and the draw the guide quotes. */
  psus?: number;
  powerW?: number;
  weightKg?: number;
  airflow?: Airflow;
  /** Outlets, where it is a PDU. */
  outlets?: number;
  note?: string;
}

const g = (t: Omit<DeviceTemplate, 'source' | 'id'> & { id: string }): DeviceTemplate => ({ source: 'generic', ...t });

/** The generic set: nothing vendor-specific, figures a planner can correct on the box. */
export const GENERIC_TEMPLATES: DeviceTemplate[] = [
  g({ id: 'sw-24-1u', name: '24-port access switch, 1U', deviceType: 'access-switch', units: 1, depth: 'half', depthMm: 300, ports: 24, portNaming: 'Gi1/0/{n}', psus: 1, powerW: 60, weightKg: 4, airflow: 'side-to-side' }),
  g({ id: 'sw-48-1u', name: '48-port access switch, 1U', deviceType: 'access-switch', units: 1, depth: 'half', depthMm: 350, ports: 48, portNaming: 'Gi1/0/{n}', psus: 1, powerW: 90, weightKg: 5.5, airflow: 'side-to-side' }),
  g({ id: 'sw-48-poe-1u', name: '48-port PoE access switch, 1U', deviceType: 'access-switch', units: 1, depth: 'half', depthMm: 400, ports: 48, portNaming: 'Gi1/0/{n}', psus: 2, powerW: 740, weightKg: 7, airflow: 'front-to-back' }),
  g({ id: 'sw-dist-1u', name: '48-port distribution switch, 1U', deviceType: 'distribution-switch', units: 1, depth: 'full', depthMm: 450, ports: 48, portNaming: 'Te1/0/{n}', psus: 2, powerW: 250, weightKg: 8, airflow: 'front-to-back' }),
  g({ id: 'sw-core-1u', name: '32-port core switch, 1U', deviceType: 'core-switch', units: 1, depth: 'full', depthMm: 500, ports: 32, portNaming: 'Eth1/{n}', psus: 2, powerW: 400, weightKg: 10, airflow: 'front-to-back' }),
  g({ id: 'sw-core-2u', name: 'Core switch, 2U', deviceType: 'core-switch', units: 2, depth: 'full', depthMm: 600, ports: 48, portNaming: 'Eth1/{n}', psus: 2, powerW: 800, weightKg: 18, airflow: 'front-to-back' }),
  g({ id: 'router-1u', name: 'Branch router, 1U', deviceType: 'router', units: 1, depth: 'half', depthMm: 300, ports: 4, portNaming: 'Gi0/0/{n}', psus: 1, powerW: 60, weightKg: 4, airflow: 'side-to-side' }),
  g({ id: 'router-2u', name: 'Edge router, 2U', deviceType: 'router', units: 2, depth: 'full', depthMm: 500, ports: 8, portNaming: 'Gi0/0/{n}', psus: 2, powerW: 250, weightKg: 14, airflow: 'front-to-back' }),
  g({ id: 'fw-1u', name: 'Firewall, 1U', deviceType: 'firewall', units: 1, depth: 'half', depthMm: 400, ports: 8, portNaming: 'port{n}', psus: 2, powerW: 120, weightKg: 6, airflow: 'front-to-back' }),
  g({ id: 'fw-2u', name: 'Firewall, 2U', deviceType: 'firewall', units: 2, depth: 'full', depthMm: 550, ports: 16, portNaming: 'port{n}', psus: 2, powerW: 400, weightKg: 16, airflow: 'front-to-back' }),
  g({ id: 'wlc-1u', name: 'Wireless controller, 1U', deviceType: 'wireless-controller', units: 1, depth: 'half', depthMm: 400, ports: 4, portNaming: 'Te0/0/{n}', psus: 2, powerW: 150, weightKg: 6, airflow: 'front-to-back' }),
  g({ id: 'lb-1u', name: 'Load balancer, 1U', deviceType: 'load-balancer', units: 1, depth: 'full', depthMm: 500, ports: 8, portNaming: '1.{n}', psus: 2, powerW: 250, weightKg: 9, airflow: 'front-to-back' }),
  g({ id: 'srv-1u', name: 'Server, 1U', deviceType: 'server', units: 1, depth: 'full', depthMm: 750, ports: 4, portNaming: 'eth{n}', psus: 2, powerW: 350, weightKg: 18, airflow: 'front-to-back' }),
  g({ id: 'srv-2u', name: 'Server, 2U', deviceType: 'server', units: 2, depth: 'full', depthMm: 750, ports: 4, portNaming: 'eth{n}', psus: 2, powerW: 500, weightKg: 28, airflow: 'front-to-back' }),
  g({ id: 'srv-4u', name: 'Server, 4U', deviceType: 'server', units: 4, depth: 'full', depthMm: 800, ports: 4, portNaming: 'eth{n}', psus: 2, powerW: 1200, weightKg: 45, airflow: 'front-to-back' }),
  g({ id: 'storage-2u', name: 'Storage array, 2U', deviceType: 'storage', units: 2, depth: 'full', depthMm: 700, ports: 4, portNaming: 'eth{n}', psus: 2, powerW: 450, weightKg: 30, airflow: 'front-to-back' }),
  g({ id: 'storage-4u', name: 'Storage shelf, 4U', deviceType: 'storage', units: 4, depth: 'full', depthMm: 800, ports: 2, psus: 2, powerW: 800, weightKg: 55, airflow: 'front-to-back' }),
  g({ id: 'blade-10u', name: 'Blade chassis, 10U', deviceType: 'blade-chassis', units: 10, depth: 'full', depthMm: 850, ports: 8, psus: 6, powerW: 6000, weightKg: 180, airflow: 'front-to-back' }),
  g({ id: 'pp-24', name: 'Patch panel, 24 ports', furniture: 'patch-panel', units: 1, depth: 'half', depthMm: 100, ports: 24, airflow: 'passive', weightKg: 1 }),
  g({ id: 'pp-48', name: 'Patch panel, 48 ports', furniture: 'patch-panel', units: 2, depth: 'half', depthMm: 100, ports: 48, airflow: 'passive', weightKg: 2 }),
  g({ id: 'fibre-12', name: 'Fibre enclosure, 12 LC duplex', furniture: 'fibre-panel', units: 1, depth: 'half', depthMm: 250, ports: 12, airflow: 'passive', weightKg: 2 }),
  g({ id: 'ups-1500', name: 'UPS 1500 VA, 2U', furniture: 'ups', units: 2, depth: 'full', depthMm: 500, psus: 1, powerW: 0, weightKg: 28, airflow: 'front-to-back', note: '1000 W load; about 8 minutes at full load' }),
  g({ id: 'ups-3000', name: 'UPS 3000 VA, 2U', furniture: 'ups', units: 2, depth: 'full', depthMm: 650, psus: 1, powerW: 0, weightKg: 45, airflow: 'front-to-back', note: '2700 W load' }),
  g({ id: 'pdu-0u-24', name: 'PDU, vertical, 24 outlets', furniture: 'pdu-vertical', units: 0, depth: 'half', outlets: 24, powerW: 7400, weightKg: 5, airflow: 'passive', note: 'rated 32 A at 230 V' }),
  g({ id: 'pdu-1u-8', name: 'PDU, 1U, 8 outlets', furniture: 'pdu', units: 1, depth: 'half', outlets: 8, powerW: 3700, weightKg: 2, airflow: 'passive', note: 'rated 16 A at 230 V' }),
  g({ id: 'kvm-1u', name: 'KVM switch, 8 ports', furniture: 'kvm', units: 1, depth: 'half', depthMm: 250, ports: 8, airflow: 'passive', weightKg: 2 }),
  g({ id: 'console-16', name: 'Console server, 16 ports', furniture: 'console-server', units: 1, depth: 'half', depthMm: 250, ports: 16, psus: 1, powerW: 20, weightKg: 2, airflow: 'passive' }),
];

/** A whole number of U; NetBox allows halves, which a rack here cannot place. */
const wholeUnits = (u: unknown): number => {
  const n = Number(u);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.ceil(n));
};

const kgOf = (weight: unknown, unit: unknown): number | undefined => {
  const n = Number(weight);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const u = String(unit ?? 'kg').toLowerCase();
  return u === 'lb' ? Math.round(n * 0.4536 * 10) / 10 : u === 'g' ? n / 1000 : u === 'oz' ? Math.round(n * 0.02835 * 10) / 10 : n;
};

const airflowOf = (a: unknown): Airflow | undefined => {
  switch (String(a ?? '')) {
    case 'front-to-rear': return 'front-to-back';
    case 'rear-to-front': return 'back-to-front';
    case 'left-to-right': case 'right-to-left': case 'side-to-rear': return 'side-to-side';
    case 'passive': return 'passive';
    default: return undefined;
  }
};

/** Which class a NetBox device type reads as, from its interfaces and its name. */
function classOf(model: string, interfaces: number, powerOutlets: number, subdevice: unknown): { deviceType?: string; furniture?: FurnitureKind } {
  const m = model.toLowerCase();
  if (powerOutlets > 0) return { furniture: 'pdu' };
  if (/\bups\b|smart-ups|smartups/.test(m)) return { furniture: 'ups' };
  if (/patch|panel/.test(m) && interfaces === 0) return { furniture: 'patch-panel' };
  if (/firewall|fortigate|palo|asa|srx|checkpoint|gateway/.test(m)) return { deviceType: 'firewall' };
  if (/router|isr|asr|mx\d|cisco c8|edgerouter/.test(m)) return { deviceType: 'router' };
  if (/storage|array|nas|jbod|shelf/.test(m)) return { deviceType: 'storage' };
  if (/server|poweredge|proliant|thinksystem|superserver|r\d{3}|dl\d{3}/.test(m)) return { deviceType: 'server' };
  if (/wlc|wireless controller|aruba 7\d{3}|mobility/.test(m)) return { deviceType: 'wireless-controller' };
  if (/chassis|blade|enclosure/.test(m) && subdevice === 'parent') return { deviceType: 'blade-chassis' };
  if (interfaces >= 40) return { deviceType: 'access-switch' };
  if (interfaces >= 8) return { deviceType: 'distribution-switch' };
  if (interfaces > 0) return { deviceType: 'l3-switch' };
  return { deviceType: 'generic' };
}

/**
 * A template from one NetBox device-type YAML file, or why it is not one.
 * Only the rack's fields are read; the file's other content is left alone.
 */
export function templateFromNetboxYaml(text: string, id: string): { template: DeviceTemplate } | { problem: string } {
  let y: Record<string, unknown>;
  try {
    const parsed = parseYaml(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { problem: 'This file is not a device type: it does not read as one YAML document.' };
    y = parsed as Record<string, unknown>;
  } catch (e) {
    return { problem: `This file is not YAML: ${e instanceof Error ? e.message : String(e)}` };
  }
  const manufacturer = typeof y.manufacturer === 'string' ? y.manufacturer : undefined;
  const model = typeof y.model === 'string' ? y.model : undefined;
  if (!model) return { problem: 'This file has no "model": a NetBox device type names one.' };
  const interfaces = Array.isArray(y.interfaces) ? (y.interfaces as unknown[]).length : 0;
  const powerPorts = Array.isArray(y['power-ports']) ? (y['power-ports'] as Record<string, unknown>[]) : [];
  const powerOutlets = Array.isArray(y['power-outlets']) ? (y['power-outlets'] as unknown[]).length : 0;
  const frontPorts = Array.isArray(y['front-ports']) ? (y['front-ports'] as unknown[]).length : 0;
  const draw = powerPorts.reduce((s, p) => s + (Number(p.maximum_draw) || 0), 0);
  const cls = classOf(model, interfaces, powerOutlets, y.subdevice_role);
  const first = Array.isArray(y.interfaces) && (y.interfaces as Record<string, unknown>[])[0]?.name;
  const portNaming = typeof first === 'string' ? first.replace(/\d+$/, '{n}') : undefined;
  const template: DeviceTemplate = {
    id,
    name: `${manufacturer ? `${manufacturer} ` : ''}${model}`,
    source: 'netbox',
    manufacturer,
    model,
    partNumber: typeof y.part_number === 'string' ? y.part_number : undefined,
    ...cls,
    units: wholeUnits(y.u_height ?? 1),
    depth: y.is_full_depth === false ? 'half' : 'full',
    ports: interfaces > 0 ? interfaces : frontPorts > 0 ? frontPorts : undefined,
    portNaming: interfaces > 0 ? portNaming : undefined,
    psus: powerPorts.length > 0 ? powerPorts.length : undefined,
    powerW: draw > 0 ? draw : undefined,
    weightKg: kgOf(y.weight, y.weight_unit),
    airflow: airflowOf(y.airflow),
    outlets: powerOutlets > 0 ? powerOutlets : undefined,
  };
  for (const k of Object.keys(template) as (keyof DeviceTemplate)[]) if (template[k] === undefined) delete template[k];
  return { template };
}

/** What applying a template to a device sets. */
export function deviceFieldsFrom(t: DeviceTemplate): { rackUnits: number; rackDepth: 'full' | 'half'; depthMm?: number; portCount?: number; portNaming?: string; powerW?: number; weightKg?: number; airflow?: Airflow; vendor?: string; model?: string } {
  const out = {
    rackUnits: t.units,
    rackDepth: t.depth,
    depthMm: t.depthMm,
    portCount: t.ports,
    portNaming: t.portNaming,
    powerW: t.powerW,
    weightKg: t.weightKg,
    airflow: t.airflow,
    vendor: t.manufacturer,
    model: t.model,
  };
  for (const k of Object.keys(out) as (keyof typeof out)[]) if (out[k] === undefined) delete out[k];
  return out;
}
