/**
 * Probe templates (LT-222): a check set up once — "HTTPS health page",
 * "Core SNMP uptime" — and added to other devices with their own address.
 *
 * A template is a probe without what belongs to one device: its target and
 * the object it checks. Kept with the project. An SNMP template names a saved
 * credential by vault id, never a secret, like the probe it came from.
 */
import type { DeviceNodeData, ObjectKind, Probe, ProbeKind } from '../types/domain';

export interface ProbeTemplate {
  id: string;
  name: string;
  kind: ProbeKind;
  tcpPort?: number | null;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  warningLatencyMs?: number | null;
  httpPath?: string | null;
  ignoreCertErrors?: boolean;
  expectedAddress?: string | null;
  expectedBody?: string | null;
  udpPayload?: string | null;
  dnsServer?: string | null;
  dnsRecord?: string | null;
  snmpCredentialId?: string | null;
}

const CARRIED = [
  'kind', 'tcpPort', 'intervalSeconds', 'timeoutMs', 'failureThreshold', 'recoveryThreshold', 'warningLatencyMs',
  'httpPath', 'ignoreCertErrors', 'expectedAddress', 'expectedBody', 'udpPayload', 'dnsServer', 'dnsRecord', 'snmpCredentialId',
] as const;

export function templateFromProbe(probe: Probe, name: string, id: string): ProbeTemplate {
  const t: Record<string, unknown> = { id, name: name.trim() };
  for (const k of CARRIED) if (probe[k] !== undefined) t[k] = probe[k];
  return t as unknown as ProbeTemplate;
}

/** A probe for one object from a template, aimed at `target`. */
export function probeFromTemplate(
  t: ProbeTemplate,
  objectKind: ObjectKind,
  objectId: string,
  projectId: string,
  target: string,
  id: string,
): Probe {
  const p: Record<string, unknown> = {
    id,
    projectId,
    objectKind,
    objectId,
    name: t.name,
    target,
    enabled: true,
    maintenance: false,
    isPrimary: false,
  };
  for (const k of CARRIED) if (t[k] !== undefined) p[k] = t[k];
  return p as unknown as Probe;
}

/** The address a template's check aims at on a device: its primary address. */
export function targetOf(d: DeviceNodeData): string {
  const addrs = d.addresses ?? [];
  return (addrs.find((a) => a.isPrimary) ?? addrs[0])?.address ?? '';
}

/** Adds a template, replacing one saved under the same name. */
export function withTemplate(list: readonly ProbeTemplate[], t: ProbeTemplate): ProbeTemplate[] {
  const at = list.findIndex((x) => x.name.toLowerCase() === t.name.toLowerCase());
  if (at < 0) return [...list, t];
  const next = [...list];
  next[at] = { ...t, id: list[at]!.id };
  return next;
}
