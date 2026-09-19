/**
 * Exactly what each structured command is sent (LT-259).
 *
 * The backend refuses any field it does not declare, so a typo, a stale field
 * or something injected into an object on its way is an error rather than
 * silently ignored. That only works if this side sends nothing extra: a probe
 * in the document carries notes and a primary flag the probe engine has no
 * use for, and a project package read from a file can carry anything. So
 * every structured input is built here from a list of the fields the Rust
 * struct declares, and nothing else.
 *
 * `src-tauri/fixtures/ipc/*.json` holds one full payload per input, written
 * from these builders; `ipcPayloads.test.ts` checks they still match, and the
 * Rust side checks it can read each one and refuses one field more.
 */
import type { EventRow, Probe, ProjectMeta } from '../types/domain';

/** snake_case keys, as the probe engine and the database declare them. */
export function snake(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snake);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = snake(v);
    }
    return out;
  }
  return value;
}

/** Only `keys`, and only those with a value. */
export function only<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (value[k] !== undefined) out[k] = value[k];
  return out;
}

/** `ProbeConfig` in `coreview-probe/src/types.rs`. */
export const PROBE_CONFIG_KEYS = [
  'id', 'projectId', 'objectKind', 'objectId', 'name', 'kind', 'target', 'tcpPort', 'intervalSeconds', 'timeoutMs',
  'failureThreshold', 'recoveryThreshold', 'warningLatencyMs', 'enabled', 'maintenance', 'httpPath', 'ignoreCertErrors',
  'expectedAddress', 'expectedBody', 'udpPayload', 'dnsServer', 'dnsRecord', 'snmpCredentialId',
] as const satisfies readonly (keyof Probe)[];

export const probeConfig = (p: Probe) => snake(only(p, PROBE_CONFIG_KEYS));

/** `ProjectMeta` in `src-tauri/src/db.rs`. */
export const PROJECT_META_KEYS = ['id', 'name', 'customer', 'site', 'ticket', 'engineer', 'description', 'createdAt', 'updatedAt', 'archived'] as const satisfies readonly (keyof ProjectMeta)[];

/** `ProjectPackage`: the document stays opaque to Rust and is sent whole. */
export const projectPackage = (pkg: { meta: ProjectMeta; documentVersion: number; document: unknown }) => ({
  meta: snake(only(pkg.meta, PROJECT_META_KEYS)),
  document_version: pkg.documentVersion,
  document: pkg.document,
});

/** `EventRow` in `src-tauri/src/db.rs`. */
export const EVENT_ROW_KEYS = [
  'id', 'projectId', 'sessionId', 'timestampMs', 'objectType', 'objectId', 'objectName', 'eventType', 'previousStatus',
  'currentStatus', 'probeType', 'target', 'rttMs', 'message',
] as const satisfies readonly (keyof EventRow)[];

export const eventRow = (e: EventRow) => snake(only(e, EVENT_ROW_KEYS));

type Obj = Record<string, unknown>;
const pickAll = (value: unknown, keys: readonly string[]): Obj => only((value ?? {}) as Obj, keys);

/** `CredentialInput` in `src-tauri/src/discovery.rs`. */
export const credentialInput = (c: { username: string; password: string; enablePassword?: string }) =>
  pickAll(c, ['username', 'password', 'enablePassword']);

const SNMP_INPUT_KEYS = ['version', 'community', 'username', 'authProtocol', 'authPassword', 'privacy', 'privacyPassword'];

/** `CrawlInput` and what it holds, in `src-tauri/src/discovery.rs`. */
export const crawlInput = (input: object) => {
  const i = input as Obj;
  const out = pickAll(i, [
    'seed', 'subnets', 'crawlClasses', 'maxHops', 'maxDevices', 'secondFactor', 'addressPreference', 'interfaceName', 'port',
    'transport', 'vdom', 'snmp', 'credentialId', 'snmpCredentialIds', 'details', 'bindings', 'reverseDns', 'concurrency',
    'perHostTimeoutSecs', 'retries',
  ]);
  if (Array.isArray(i.snmp)) out.snmp = i.snmp.map((s) => pickAll(s, SNMP_INPUT_KEYS));
  if (i.details) out.details = pickAll(i.details, ['routes', 'spanningTree', 'vlans']);
  if (Array.isArray(i.bindings)) out.bindings = i.bindings.map((b) => pickAll(b, ['scope', 'value', 'credentialId']));
  return out;
};

/** `BackupInput` and `BackupTarget`. */
export const backupInput = (input: object) => {
  const i = input as Obj;
  const out = pickAll(i, ['credentialId', 'targets', 'kinds', 'secondFactor', 'port', 'showCommands', 'paging', 'filePattern']);
  if (Array.isArray(i.targets)) out.targets = i.targets.map((t) => pickAll(t, ['address', 'name', 'commands', 'site']));
  return out;
};

/** `SweepOptions` in `coreview-probe/src/sweep.rs`. */
export const sweepOptions = (o: object) => pickAll(o, ['timeoutMs', 'concurrency', 'identify', 'scanPorts']);

/** `SaveCredential` in `src-tauri/src/vault_commands.rs`. */
export const saveCredential = (c: object) => pickAll(c, ['id', 'label', 'kind', 'username', 'secret', 'secondSecret', 'detail']);

/** `Check` in `coreview-discover/src/checks.rs`. */
export const backupCheck = (c: object) => pickAll(c, ['id', 'name', 'command', 'expect', 'pattern', 'ignoreCase']);

/** `VisioDrawing`, `VisioPage`, `VisioShape` and `VisioLink` in `src-tauri/src/visio.rs`. */
export const visioDrawing = (d: object) => {
  const drawing = d as Obj;
  return {
    ...pickAll(drawing, ['title']),
    pages: ((drawing.pages as unknown[]) ?? []).map((p) => {
      const page = p as Obj;
      return {
        ...pickAll(page, ['name', 'width', 'height']),
        shapes: ((page.shapes as unknown[]) ?? []).map((s) => pickAll(s, ['id', 'name', 'x', 'y', 'width', 'height'])),
        links: ((page.links as unknown[]) ?? []).map((l) => pickAll(l, ['from', 'to', 'label', 'points'])),
      };
    }),
  };
};
