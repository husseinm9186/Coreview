/**
 * What a built-in shape brings with it when it is dropped (LT-171).
 *
 * Every value here is generic: a port count typical of the class, ports named
 * by number, a rack height typical of the class. Never a vendor's model, port
 * naming or artwork — vendor and model are the operator's to type (D-028).
 */
import type { DeviceNodeData, DeviceType, NodeAddress } from '../types/domain';

/** The device classes a stencil manifest may name (LT-169): every device type
 *  except the plain drawing shapes and a bare custom image. Mirrored in Rust as
 *  `stencil_manifest::CLASSES`, which validates the manifest; a test keeps the
 *  two identical. */
export const STENCIL_CLASSES: readonly DeviceType[] = [
  'generic',
  'firewall',
  'router',
  'core-switch',
  'distribution-switch',
  'access-switch',
  'l3-switch',
  'l2-switch',
  'wireless-controller',
  'access-point',
  'ip-phone',
  'blade-chassis',
  'load-balancer',
  'waf',
  'server',
  'vm',
  'vm-host',
  'storage',
  'endpoint',
  'printer',
  'camera',
  'internet',
  'private-cloud',
  'site',
  'vpn',
  'mpls-cloud',
  'rack',
  'patch-panel',
  'pdu',
  'ups',
  'application',
  'database',
];

export function isStencilClass(value: string | undefined): value is DeviceType {
  return value !== undefined && (STENCIL_CLASSES as readonly string[]).includes(value);
}

export interface ShapeDefaults {
  /** Ports the class typically has. */
  ports?: number;
  /** How they are named; `{n}` is the port number. */
  portNaming?: string;
  /** Height in rack units; 0 is zero-U; absent is not rack-mounted. */
  rackUnits?: number;
  /** Starts with an empty management address to fill in. */
  managementIp?: boolean;
}

const PORT = 'Port {n}';
const NIC = 'NIC {n}';

export const SHAPE_DEFAULTS: Partial<Record<DeviceType, ShapeDefaults>> = {
  router: { ports: 4, portNaming: PORT, rackUnits: 1, managementIp: true },
  firewall: { ports: 8, portNaming: PORT, rackUnits: 1, managementIp: true },
  waf: { ports: 4, portNaming: PORT, rackUnits: 1, managementIp: true },
  'load-balancer': { ports: 8, portNaming: PORT, rackUnits: 1, managementIp: true },
  'core-switch': { ports: 48, portNaming: PORT, rackUnits: 1, managementIp: true },
  'distribution-switch': { ports: 48, portNaming: PORT, rackUnits: 1, managementIp: true },
  'access-switch': { ports: 48, portNaming: PORT, rackUnits: 1, managementIp: true },
  'l3-switch': { ports: 48, portNaming: PORT, rackUnits: 1, managementIp: true },
  'l2-switch': { ports: 24, portNaming: PORT, rackUnits: 1, managementIp: true },
  'wireless-controller': { ports: 4, portNaming: PORT, rackUnits: 1, managementIp: true },
  'access-point': { ports: 1, portNaming: PORT, managementIp: true },
  server: { ports: 2, portNaming: NIC, rackUnits: 1, managementIp: true },
  'vm-host': { ports: 4, portNaming: NIC, rackUnits: 2, managementIp: true },
  'blade-chassis': { ports: 8, portNaming: 'Uplink {n}', rackUnits: 10, managementIp: true },
  storage: { ports: 4, portNaming: PORT, rackUnits: 2, managementIp: true },
  'patch-panel': { ports: 24, portNaming: '{n}', rackUnits: 1 },
  pdu: { ports: 8, portNaming: 'Outlet {n}', rackUnits: 0, managementIp: true },
  ups: { ports: 6, portNaming: 'Outlet {n}', rackUnits: 2, managementIp: true },
  'ip-phone': { ports: 2, portNaming: PORT, managementIp: true },
  endpoint: { ports: 1, portNaming: PORT, managementIp: true },
  printer: { ports: 1, portNaming: PORT, managementIp: true },
  camera: { ports: 1, portNaming: PORT, managementIp: true },
};

/** The most port names offered. A chassis with more is still typed by hand. */
export const MAX_PORT_NAMES = 128;

/** The fields a freshly dropped device of this class starts with. */
export function shapeDefaultFields(
  type: DeviceType,
  newId: () => string,
): Pick<DeviceNodeData, 'portCount' | 'portNaming' | 'rackUnits' | 'addresses'> {
  const d = SHAPE_DEFAULTS[type];
  const addresses: NodeAddress[] = d?.managementIp
    ? [{ id: newId(), label: 'Management', address: '', isPrimary: true }]
    : [];
  return {
    addresses,
    ...(d?.ports !== undefined ? { portCount: d.ports } : {}),
    ...(d?.portNaming !== undefined ? { portNaming: d.portNaming } : {}),
    ...(d?.rackUnits !== undefined ? { rackUnits: d.rackUnits } : {}),
  };
}

/** A device's port names, from its count and naming. Empty when either is
 *  missing, the count is not a positive whole number, or the naming has no
 *  `{n}` — a naming without one would name every port the same. */
export function portNames(d: Pick<DeviceNodeData, 'portCount' | 'portNaming'> | undefined): string[] {
  const count = d?.portCount;
  const naming = d?.portNaming?.trim();
  if (!naming || !naming.includes('{n}') || count === undefined || !Number.isInteger(count) || count < 1) {
    return [];
  }
  const out: string[] = [];
  for (let n = 1; n <= Math.min(count, MAX_PORT_NAMES); n++) out.push(naming.replaceAll('{n}', String(n)));
  return out;
}
