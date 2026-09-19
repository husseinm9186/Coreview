/**
 * The only place the frontend talks to Rust.
 *
 * When the bundle is loaded in a plain browser (`npm run dev` without Tauri)
 * there is no backend, so project storage falls back to localStorage and any
 * probe call fails loudly. Nothing is simulated: a browser session cannot
 * produce probe results, and the UI says so.
 */
import type { PagingMode } from './showCommands';
import type { BackupCheck, CheckResult } from './checks';
import { backupCheck, backupInput, crawlInput, credentialInput, eventRow, probeConfig, projectPackage, saveCredential, sweepOptions, visioDrawing } from './ipcPayloads';
import type {
  EventRow,
  Probe,
  ProbeRuntime,
  ProjectMeta,
  SessionState,
} from '../types/domain';

export const isDesktop =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export class BackendUnavailable extends Error {
  constructor(what: string) {
    super(
      `${what} needs the Coreview desktop app. Run "npm run tauri dev" instead of opening the page in a browser.`,
    );
    this.name = 'BackendUnavailable';
  }
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const api = await import('@tauri-apps/api/core');
  return api.invoke<T>(cmd, args);
}

export interface ProjectPackage {
  meta: ProjectMeta;
  documentVersion: number;
  document: unknown;
}

export interface ProbeResultDto {
  probeId: string;
  timestampMs: number;
  outcome:
    | 'success'
    | 'timeout'
    | 'unreachable'
    | 'refused'
    | 'dns_failure'
    | 'no_answer'
    | 'os_error'
    | 'invalid_target'
    | 'http_error'
    | 'certificate_error'
    | 'address_mismatch'
    | 'body_mismatch'
    /** LT-220: answered, and its uptime went backwards. */
    | 'restarted';
  rttMs: number | null;
  resolved: string[];
  summary: string;
  errorMessage: string | null;
}

export interface TracerouteProbeDto {
  host: string | null;
  rttMs: number | null;
}

export interface TracerouteHopDto {
  hop: number;
  probes: TracerouteProbeDto[];
}

export interface TracerouteResultDto {
  target: string;
  hops: TracerouteHopDto[];
  /** False when the run was cut short by its wall clock (LT-129). The hops
   *  present are real; what lies past the last one is simply unknown. */
  complete: boolean;
}

export interface SessionInfo {
  sessionId: string | null;
  projectId: string | null;
  state: SessionState;
  probeCount: number;
}

const LS_KEY = 'coreview.projects.v1';
/** Browser-mode storage was under this name until the 0.2.0 rename. */
const LS_KEY_LEGACY = 'livetopo.projects.v1';

function lsAll(): Record<string, ProjectPackage> {
  try {
    const current = localStorage.getItem(LS_KEY);
    if (current !== null) return JSON.parse(current);
    // Nothing under the new name: adopt anything left under the old one, so a
    // rename does not read as every project having disappeared.
    const legacy = localStorage.getItem(LS_KEY_LEGACY);
    if (legacy === null) return {};
    localStorage.setItem(LS_KEY, legacy);
    return JSON.parse(legacy);
  } catch {
    return {};
  }
}

function lsWrite(all: Record<string, ProjectPackage>) {
  localStorage.setItem(LS_KEY, JSON.stringify(all));
}

/** Rust returns snake_case; the UI uses camelCase. */
function camel<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => camel(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = camel(v);
    }
    return out as T;
  }
  return value as T;
}


/** What a Visio drawing yielded (LT-110). Mirrors `visio_import.rs`. */
export type ImportedDevice = {
  id: string;
  label: string;
  addresses: string[];
  deviceType: string;
  model: string;
  properties: Record<string, string>;
  /** The shape's centre, in inches from the drawing's bottom-left. */
  x: number;
  y: number;
  /** The shape's own size in inches, or 0 where the drawing left it to the
   *  master. A rack unit and a router icon are nothing like the same shape. */
  width: number;
  height: number;
  /** LT-243: how the drawing set its name, where it said. Size in points. */
  labelStyle?: { bold: boolean; italic: boolean; size: number | null; color: string; align: string } | null;
};
export type ImportedLink = {
  source: string;
  target: string;
  label: string;
  sourcePort: string;
  targetPort: string;
  /** False means the link was inferred, not stated by the drawing. */
  glued: boolean;
  /** The colour the line was drawn in, as `#rrggbb`, or empty where the
   *  drawing left it to the theme. */
  color: string;
  /** LT-243: the bends the connector was routed through, in drawing inches. */
  waypoints?: [number, number][];
};
export type ImportedPage = { name: string; devices: ImportedDevice[]; links: ImportedLink[] };
export type VisioImport = { pages: ImportedPage[]; warnings: string[] };

/** What happened when a stencil pack was removed. */
export type PackRemoval = { deleted: boolean; reason: string | null };

export type SubnetInfo = { network: string; broadcast: string; prefix: number; hosts: number };
export type SweepOptions = {
  timeoutMs: number;
  concurrency: number;
  /** Ask each host that answers what it is — name, MAC, manufacturer (LT-121). */
  identify: boolean;
  /** Try the common TCP ports on each host that answers. */
  scanPorts: boolean;
};
/** A port that completed a TCP handshake. `service` is what is registered for
 *  that number, not what was found listening: nothing reads a banner. */
export type OpenPort = { port: number; service: string };
/** Where a name came from, best first. A PTR record is the network's answer;
 *  LLMNR, NetBIOS and mDNS are the host's own. LLMNR outranks NetBIOS because
 *  Windows answers it with the real hostname rather than the 15-character
 *  uppercase NetBIOS form of it. */
export type NameSource = 'dns' | 'llmnr' | 'netBios' | 'mdns' | 'certificate';
/** `hostname` is what this host is called — a PTR record (LT-109), else what
 *  the host answers over NetBIOS or mDNS (LT-121). Null where nothing knew,
 *  never the address repeated back. `mac` is null for anything not on this
 *  segment, because ARP does not cross a router. */
export type SweepHit = {
  ip: string;
  rttMs: number | null;
  hostname: string | null;
  nameSource: NameSource | null;
  mac: string | null;
  vendor: string | null;
  ports: OpenPort[];
  /** LT-124: the device serial its certificate carries, and the product it
   *  names (`Fortinet FortiSwitch`). Null where it has no certificate or the
   *  certificate says neither. */
  serial: string | null;
  product: string | null;
  /** LT-124: the plain-HTTP page's `Server` header (`cisco-IOS`) and its
   *  title when it is not a default page. The software, never a name. */
  webServer: string | null;
  webTitle: string | null;
};
/** Mirrors the Rust SweepEvent enum, which is tagged with `kind`. */
export type SweepEvent =
  | { kind: 'started'; total: number }
  | ({ kind: 'alive' } & SweepHit)
  | { kind: 'progress'; done: number; total: number }
  | { kind: 'finished'; alive: number; scanned: number; cancelled: boolean };

/** Sent for one run and never stored. The backend has no way to give these
 *  back — nothing reads a password out of Coreview once it is in. */
export type CredentialInput = {
  username: string;
  password: string;
  enablePassword?: string;
};

export type DeviceClassName =
  | 'router' | 'switch' | 'firewall' | 'wireless-controller' | 'access-point'
  | 'phone' | 'camera' | 'printer' | 'server' | 'endpoint' | 'unknown';

export type DeviceAddress = { ip: string; interface: string | null; isManagement: boolean };

export type Neighbor = {
  deviceId: string;
  shortName: string;
  addresses: DeviceAddress[];
  localInterface: string | null;
  remoteInterface: string | null;
  platform: string | null;
  /** The chassis serial, where the neighbour advertised one. CDP carries it
   *  in brackets after the device id; LLDP and FortiLink do not. */
  serial: string | null;
  capabilities: string[];
  version: string | null;
  class: DeviceClassName;
  discoveredBy: 'cdp' | 'lldp' | 'fortiLink';
  chassisId: string | null;
  /** Who registered the chassis id's MAC prefix. The maker only — a vendor
   *  does not say what a device is. */
  vendor: string | null;
};

/** Something seen on a switch port that announced nothing about itself. */
export type AttachedDevice = {
  mac: string;
  port: string;
  address: string | null;
  vendor: string | null;
  /** What the device calls itself, when something on the path knew. A MAC and
   *  an OUI give "Hewlett Packard"; this gives "HPLJ-3rdfloor". */
  hostname: string | null;
  /** What it is, when a device that could actually tell said so. */
  class: DeviceClassName | null;
  /** The VLAN the switch learned it on, when the MAC table said so (LT-027). */
  vlan?: string | null;
  /** Distinct addresses sharing that port. One means something is plugged in;
   *  many means the port leads to another switch. Zero means the count says
   *  nothing — a firewall interface carries a whole network. */
  portPopulation: number;
};

/** One box inside a stack or chassis pair (LT-139). */
export type StackMember = {
  id: string;
  role: string | null;
  state: string | null;
  model: string | null;
  serial: string | null;
  mac: string | null;
  priority: string | null;
};

/** What a device said about being stacked.
 *
 *  `kind` decides how it draws: a stack, VSF or Virtual Chassis is one node;
 *  VSX, StackWise Virtual, VSS and a FortiSwitch MCLAG pair are two chassis
 *  with an inter-switch link, and collapsing those would hide the redundancy
 *  they exist to provide. `unverified` is true while the parser behind this
 *  has not yet met real hardware (D-026) — the interface must not present a
 *  documentation-derived guess as a fact. */
export type StackInfo = {
  kind:
    | 'stack-wise'
    | 'stack-wise-virtual'
    | 'vss'
    | 'vsf'
    | 'vsx'
    | 'virtual-chassis'
    | 'vendor-stack'
    | 'forti-link-stack';
  members: StackMember[];
  peer: string | null;
  interSwitchLink: string | null;
  peerReachable: boolean | null;
  unverified: boolean;
};

export type CrawledDevice = {
  hostname: string;
  address: string;
  addresses: DeviceAddress[];
  probeTarget: string;
  class: DeviceClassName;
  platform: string | null;
  /** Every chassis serial the device reported, comma-separated. A list rather
   *  than a value because a stack is one device with several boxes in it. */
  serial: string | null;
  version: string | null;
  neighbors: Neighbor[];
  hops: number;
  /** How the device answered. SSH gives neighbours and interfaces; SNMP gives
   *  a name and nothing about what it connects to. */
  reachedBy: 'ssh' | 'snmp' | 'reported';
  attached: AttachedDevice[];
  /** Where this device sends traffic it has no other route for (LT-131) —
   *  its default route's next hop. Resolved to a device by the topology
   *  builder, which is what turns it into a direction on a link. Null where
   *  it has no default route or nothing answered: never a guess. */
  defaultNextHop?: string | null;
  /** Whether this is one switch or several (LT-139). Null means nothing
   *  reported a stack, which for most devices is the truth. */
  stack?: StackInfo | null;
  /** What the device says it has aggregated (LT-009): `show etherchannel
   *  summary`, so two cables in a LAG draw as one link. */
  portChannels?: { name: string; protocol: string; members: string[] }[];
  /** LT-200: the IPv4 and IPv6 routing tables. */
  routes?: RouteRow[];
  /** LT-202: one entry per spanning-tree instance. */
  spanningTree?: StpInstance[];
  /** LT-203: VLANs, and each port's mode. */
  vlans?: VlanRow[];
  portVlans?: PortVlansRow[];
  /** LT-204: every port with status, speed and duplex, and the uptime. */
  ports?: PortStatusRow[];
  uptimeSeconds?: number | null;
  /** LT-235: each port's error counters, by its full name. */
  counters?: { port: string; inputErrors: number; crc: number; outputErrors: number; collisions: number; resets: number; outputDrops: number; duplexSpeed: string | null }[];
  /** LT-206: its PTR name, where DNS has one. */
  dnsName?: string | null;
};

export type RouteRow = {
  family: 4 | 6;
  prefix: string;
  code: string;
  protocol: string;
  nextHops: string[];
  interface: string | null;
  distance: number | null;
  metric: number | null;
};

export type StpInstance = {
  instance: string;
  vlan: number | null;
  protocol: string | null;
  rootBridge: string | null;
  rootPriority: number | null;
  isRoot: boolean;
  rootPort: string | null;
  bridgeAddress: string | null;
  ports: { port: string; role: string; state: string; cost: number | null }[];
};

export type VlanRow = { id: number; name: string; status: string; ports: string[] };
export type PortVlansRow = { port: string; mode: 'trunk' | 'access' | 'routed'; vlan: number | null; trunkVlans: number[] };
export type PortStatusRow = {
  port: string;
  description: string;
  status: string;
  vlan: string;
  duplex: string;
  speed: string;
  media: string;
};

/** Optional, and only used for devices that refuse SSH. */
export type SnmpInput = {
  version: 'v2c' | 'v3';
  community?: string;
  username?: string;
  /** The word a device configuration uses: "sha", "md5", "sha256". */
  authProtocol?: string;
  authPassword?: string;
  /** "aes 256", "aes", "des"; omit for authentication without privacy. */
  privacy?: string;
  privacyPassword?: string;
};

export type CrawlInput = {
  seed: string;
  subnets: string[];
  crawlClasses: DeviceClassName[];
  maxHops: number;
  maxDevices: number;
  secondFactor: boolean;
  addressPreference: 'loopback' | 'management' | 'first' | 'interface';
  interfaceName?: string;
  port: number;
  /** Telnet is never chosen for you: absent means SSH. */
  transport?: 'ssh' | 'telnet' | 'sshThenTelnet';
  /** SNMP credentials typed for this run — a list since LT-142, so v2c and
   *  v3 can be mixed and each is tried in turn. */
  snmp?: SnmpInput[];
  /** A saved credential to use instead of typed ones. Only the id travels. */
  credentialId?: string;
  /** Saved SNMP credentials, by id. Tried before the typed ones. */
  snmpCredentialIds?: string[];
  /** LT-200–204: which extra tables to read from each device. Absent reads
   *  all of them. */
  details?: CrawlDetails;
  /** LT-206: look up reverse DNS names for what was found. Absent means yes. */
  reverseDns?: boolean;
  /** LT-208: devices at once (1–32), seconds before giving up on one
   *  (30–1800), and retries for a device that did not answer (0–3). */
  concurrency?: number;
  perHostTimeoutSecs?: number;
  retries?: number;
  /** LT-199, LT-209: saved credentials bound to devices, subnets or vendors,
   *  by vault id. */
  bindings?: { scope: 'device' | 'subnet' | 'vendor'; value: string; credentialId: string }[];
};

export type CrawlDetails = { routes: boolean; spanningTree: boolean; vlans: boolean };

export type SshProgress =
  | { kind: 'connecting'; host: string }
  | { kind: 'checkingHostKey'; host: string }
  | { kind: 'authenticating'; host: string }
  | { kind: 'awaitingSecondFactor'; host: string; message: string }
  | { kind: 'ready'; host: string; hostname: string }
  | { kind: 'running'; host: string; command: string };

export type CrawlEvent =
  | { kind: 'started'; seed: string }
  /** LT-278: the progress is nested — it has a `kind` of its own. */
  | { kind: 'ssh'; progress: SshProgress }
  | { kind: 'reached'; hostname: string; address: string; probeTarget: string; class: DeviceClassName; platform: string | null; hops: number; reachedBy: 'ssh' | 'snmp' | 'reported' }
  | { kind: 'skipped'; name: string; reason: string }
  /** LT-278: nested for the same reason. */
  | { kind: 'failed'; failure: CrawlFailure }
  /** LT-210. */
  | { kind: 'queued'; address: string; hops: number }
  | { kind: 'visiting'; address: string; hops: number }
  /** LT-208. */
  | { kind: 'retrying'; address: string; attempt: number }
  | { kind: 'finished'; reached: number; failed: number; cancelled: boolean };

/** Why a device could not be reached (LT-144).
 *
 *  `reachable-no-ssh` and `unreachable` are the two the operator most needs
 *  told apart, and they used to be the same message: a dropped SYN and a host
 *  that is switched off both time out. The crawl pings on failure to settle
 *  it. */
export type FailureKind =
  | 'reachable-no-ssh'
  | 'unreachable'
  | 'refused'
  | 'auth-rejected'
  | 'auth-timed-out'
  | 'no-prompt'
  | 'host-key-changed'
  | 'command-timed-out'
  | 'other';

export type CrawlFailure = {
  address: string;
  reason: string;
  kind?: FailureKind;
};

export type CrawlResult = {
  devices: CrawledDevice[];
  notVisited: Neighbor[];
  failures: CrawlFailure[];
  cancelled: boolean;
};

/** `commands` are this device's own show commands (LT-149), run after the
 *  global list. Absent or empty when none were asked for. */
export type BackupTarget = { address: string; name: string; commands?: string[]; site?: string };

export type BackupEvent =
  | { kind: 'started'; devices: number }
  | ({ kind: 'ssh' } & { [k: string]: unknown })
  | { kind: 'saved'; name: string; address: string; path: string; bytes: number; unchanged: boolean }
  | { kind: 'failed'; name: string; address: string; reason: string }
  | { kind: 'finished'; saved: number; failed: number; cancelled: boolean };

export type HostKeyRow = { host: string; fingerprint: string };

/** LT-264: one line of the credential use log — uses within an hour of each
 *  other for the same purpose and device are one line. */
export type CredentialUse = { credentialId: string; label: string; purpose: string; target: string; firstMs: number; lastMs: number; uses: number };

export type VaultStatus = {
  exists: boolean;
  unlocked: boolean;
  credentials: number;
  minimumPassphrase: number;
  /** LT-262: this machine keeps the vault key in its system keychain. */
  keptInKeychain?: boolean;
};

/** LT-124: one entry of a gateway's ARP table. */
export type GatewayArpEntry = { ip: string; mac: string; vendor: string | null };

export type CredentialSummary = {
  id: string;
  label: string;
  kind: string;
  username: string;
  detail: string;
  hasSecondSecret: boolean;
};

/** Only ever returned by revealCredential, which is the one call that hands
 *  back a stored secret. */
export type RevealedCredential = {
  username: string;
  secret: string;
  secondSecret: string | null;
};

export type BackupDevice = { name: string; captures: number; latest: string | null };
/** Mirrors the Rust DiffLine, which is tagged with `kind`. */
export type DiffLine =
  | { kind: 'same'; value: string }
  | { kind: 'added'; value: string }
  | { kind: 'removed'; value: string };

/** LT-152: one backup run — every device backed up with one stamp. */
export type BackupRunSummary = { stamp: string; devices: number; kinds: CaptureKindSlug[] };
export type CaptureKindSlug = 'running' | 'startup' | 'show-commands';
export type ComparedPart = {
  /** The command, or the kind's slug for a configuration. */
  name: string;
  status: 'same' | 'changed' | 'onlyBefore' | 'onlyAfter';
  added: number;
  removed: number;
  /** Changed lines only, capped. */
  lines: DiffLine[];
  truncated: boolean;
  /** Too long for a line-by-line diff; compared as sets of lines. */
  approximate: boolean;
};
export type ComparedDevice = {
  device: string;
  kind: CaptureKindSlug;
  before: string | null;
  after: string | null;
  parts: ComparedPart[];
  changed: number;
};

/** What a library folder's `coreview-stencils.json` says about one shape
 *  (LT-169). Validated in Rust before it gets here. */
export type StencilMeta = {
  class?: string;
  vendor?: string;
  model?: string;
  ports?: number;
  portNaming?: string;
  rackUnits?: number;
  /** The folder's licence statement — the operator's responsibility (D-028). */
  licence: string;
};
export type IconLibEntry = {
  id: string;
  name: string;
  category: string;
  svg: string;
  meta?: StencilMeta;
  /** Coreview's own artwork — a shape captured from a built-in glyph (LT-104),
   *  never counted as third-party (LT-170). */
  own?: boolean;
};
export type IconLibrary = { dir: string; icons: IconLibEntry[]; skipped: string[] };

/** Preferences that outlive a restart. Paths only — nothing secret. */
export type StoredSettings = Partial<{
  backupFolder: string;
  exportFolder: string;
  iconLibraryDir: string;
  addressPreference: string;
  // LT-135: how the last discovery run was set up, so it can be repeated
  // without retyping. None of these is a secret — the passwords behind
  // `scanCredentialId` and `scanSnmpCredentialId` stay in the vault.
  scanSeed: string;
  /** Comma-separated, because a setting is one string. */
  scanSubnets: string;
  scanPort: string;
  scanMaxHops: string;
  scanCredentialId: string;
  /** The SNMP credentials' *shape* as JSON (LT-142): version, v3 user name,
   *  algorithms and any saved-credential id. Never a community string and
   *  never a passphrase — those are secrets and live in the vault. */
  scanSnmpRows: string;
  /** LT-149: the Backups tab's global show commands, one per line, and the
   *  paging choice. The operator's own — nothing ships pre-filled (D-027). */
  backupShowCommands: string;
  backupPaging: string;
  /** LT-150: named command sets applied by role or tag, as JSON. */
  backupCommandSets: string;
  /** LT-151: how capture files are named, e.g. `{site}_{device}_{stamp}_{kind}`. */
  backupFilePattern: string;
  /** LT-153: checks against captured output, as JSON. None ship built in. */
  backupChecks: string;
  /** LT-154: ordered collection groups, as JSON. None ship built in. */
  backupGroups: string;
}>;

export const ipc = {
  /** Every stored preference. Browser mode has no backend, so none. */
  async getSettings(): Promise<StoredSettings> {
    if (!isDesktop) return {};
    return invoke<StoredSettings>('get_settings');
  },

  /** Stores a preference, or clears it when value is null. */
  async setSetting(key: keyof StoredSettings, value: string | null): Promise<void> {
    if (!isDesktop) return;
    await invoke('set_setting', { key, value });
  },

  /** Picking a folder is not the same as being able to write into it: a
   *  read-only mount picks cleanly and fails at the first backup. */
  async checkFolderWritable(path: string): Promise<void> {
    if (!isDesktop) return;
    await invoke('check_folder_writable', { path });
  },

  /** LT-255: `project.coreview` and `project.yaml` in `folder/name`. */
  saveProjectFolder(folder: string, name: string, json: string, yaml: string) {
    return invoke<string>('save_project_folder', { folder, name, json, yaml });
  },

  /** Native folder picker. Returns null if the user cancelled. */
  async pickFolder(title: string, defaultPath?: string): Promise<string | null> {
    if (!isDesktop) throw new BackendUnavailable('Choosing a folder');
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ directory: true, multiple: false, title, defaultPath });
    return typeof picked === 'string' ? picked : null;
  },

  /** Index a user-chosen folder of SVGs. Desktop only. */
  /** The diagram as a PDF (LT-077). Vector, at the chosen paper size. */
  async diagramPdf(svg: string): Promise<Uint8Array> {
    if (!isDesktop) throw new BackendUnavailable('Exporting a PDF');
    return Uint8Array.from(await invoke<number[]>('diagram_pdf', { svg }));
  },
  /** LT-251: several drawings as one PDF, a page each. */
  async diagramPdfPages(svgs: string[]): Promise<Uint8Array> {
    if (!isDesktop) throw new BackendUnavailable('Exporting a PDF');
    return Uint8Array.from(await invoke<number[]>('diagram_pdf_pages', { svgs }));
  },

  /** LT-244: a draw.io drawing, read like a Visio one. */
  importDrawio(path: string) {
    return invoke<VisioImport>('import_drawio', { path });
  },

  /** The diagram as a Visio drawing (LT-078): shapes and connectors a
   *  colleague can edit, not a picture. */
  async diagramVsdx(drawing: {
    title: string;
    /** LT-249: one per page, each with its links' bends. */
    pages: {
      name: string;
      width: number;
      height: number;
      shapes: { id: string; name: string; x: number; y: number; width: number; height: number }[];
      links: { from: string; to: string; label: string; points: [number, number][] }[];
    }[];
  }): Promise<Uint8Array> {
    if (!isDesktop) throw new BackendUnavailable('Exporting to Visio');
    return Uint8Array.from(await invoke<number[]>('diagram_vsdx', { drawing: visioDrawing(drawing) }));
  },

  /** Stencils bundled in the installer. None ship since D-028. */
  listBundledIcons(): Promise<IconLibrary> {
    if (!isDesktop) return Promise.resolve({ dir: '', icons: [], skipped: [] });
    return invoke<IconLibrary>('list_bundled_icons');
  },

  /** The bundled stencil packs (LT-103) — none ship since D-028 — each
   *  removable to free space. */
  listStencilPacks(): Promise<{ name: string }[]> {
    if (!isDesktop) return Promise.resolve([]);
    return invoke<{ name: string }[]>('list_stencil_packs');
  },

  /** Permanent — restored only by reinstalling the app. `deleted` says whether
   *  the files actually went: on a read-only install the pack is hidden and
   *  the space stays used, and the interface has to say so rather than claim
   *  otherwise. */
  removeStencilPack(name: string): Promise<PackRemoval> {
    if (!isDesktop) throw new BackendUnavailable('Removing a stencil pack');
    return invoke<PackRemoval>('remove_stencil_pack', { name });
  },

  listIconLibrary(dir: string) {
    return invoke<IconLibrary>('list_icon_library', { dir });
  },

  async listProjects(): Promise<ProjectMeta[]> {
    if (!isDesktop) {
      return Object.values(lsAll())
        .map((p) => p.meta)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return camel<ProjectMeta[]>(await invoke('list_projects'));
  },

  async saveProject(pkg: ProjectPackage): Promise<void> {
    if (!isDesktop) {
      const all = lsAll();
      all[pkg.meta.id] = pkg;
      lsWrite(all);
      return;
    }
    await invoke('save_project', { package: projectPackage(pkg) });
  },

  async loadProject(id: string): Promise<ProjectPackage | null> {
    if (!isDesktop) return lsAll()[id] ?? null;
    return camel<ProjectPackage | null>(await invoke('load_project', { id }));
  },

  async deleteProject(id: string): Promise<void> {
    if (!isDesktop) {
      const all = lsAll();
      delete all[id];
      lsWrite(all);
      return;
    }
    await invoke('delete_project', { id });
  },

  async setArchived(id: string, archived: boolean): Promise<void> {
    if (!isDesktop) {
      const all = lsAll();
      const p = all[id];
      if (p) {
        p.meta.archived = archived;
        lsWrite(all);
      }
      return;
    }
    await invoke('set_project_archived', { id, archived });
  },

  /** LT-234: opens a device attachment (documents only), or its folder. */
  async openAttachment(path: string, reveal: boolean): Promise<void> {
    if (!isDesktop) throw new BackendUnavailable('Opening a file');
    return invoke('open_attachment', { path, reveal });
  },
  /** LT-234: a file to attach, chosen with the system dialog. */
  async chooseAttachment(): Promise<string | null> {
    if (!isDesktop) return null;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ multiple: false, directory: false });
    return typeof picked === 'string' ? picked : null;
  },

  /** LT-225: `device`'s own ping to `target`, over SSH with a saved
   *  credential by id. */
  async pingFromDevice(device: string, credentialId: string, target: string, count = 3): Promise<{ sent: number; received: number; minMs: number | null; avgMs: number | null; maxMs: number | null; output: string }> {
    if (!isDesktop) throw new BackendUnavailable('Pinging from a device');
    return invoke('ping_from_device', { device, credentialId, target, count });
  },

  /** LT-246: a saved snmpwalk of one device, read into what an SNMP crawl
   *  would have found. `address` is where it is managed from, when the walk
   *  does not say. */
  async readSnmpWalk(text: string, address?: string): Promise<{ device: CrawledDevice | null; rows: number; unknownNames: string[]; unknownRows: number; problems: string[] }> {
    if (!isDesktop) throw new BackendUnavailable('Reading an SNMP walk');
    return invoke('read_snmp_walk', { text, address: address ?? null });
  },

  /** LT-248: an `nmap -oX` report, as ping-sweep rows. */
  async readNmapXml(text: string): Promise<{ hosts: SweepHit[]; scanned: number | null; up: number | null; args: string | null }> {
    if (!isDesktop) throw new BackendUnavailable('Reading an Nmap report');
    return invoke('read_nmap_xml', { text });
  },

  /** LT-226: a project's validation sessions, and what each probe did in one. */
  async listSessions(projectId: string): Promise<{ id: string; startedAt: number; stoppedAt: number | null; samples: number; transitions: number }[]> {
    if (!isDesktop) return [];
    return invoke('list_sessions', { projectId });
  },
  async sessionSummary(sessionId: string): Promise<import('./runDiff').ProbeSummary[]> {
    if (!isDesktop) return [];
    return invoke('session_summary', { sessionId });
  },
  /** LT-227: stored crawl results, to compare two. */
  async saveCrawlRun(projectId: string, seed: string, result: CrawlResult): Promise<string | null> {
    if (!isDesktop) return null;
    return invoke('save_crawl_run', { projectId, seed, result });
  },
  async listCrawlRuns(projectId: string): Promise<{ id: string; takenAt: number; seed: string; devices: number }[]> {
    if (!isDesktop) return [];
    return invoke('list_crawl_runs', { projectId });
  },
  async crawlRunResult(id: string): Promise<CrawlResult> {
    if (!isDesktop) throw new BackendUnavailable('Stored crawls');
    return invoke('crawl_run_result', { id });
  },

  /** LT-224: a probe's recorded results since `sinceMs`, oldest first. */
  async probeHistory(probeId: string, sinceMs: number, limit = 2000): Promise<{ timestampMs: number; status: string; outcome: string; rttMs: number | null }[]> {
    if (!isDesktop) return [];
    return invoke('probe_history', { probeId, sinceMs, limit });
  },

  async testProbeNow(probe: Probe): Promise<ProbeResultDto> {
    if (!isDesktop) throw new BackendUnavailable('Testing a target');
    return camel<ProbeResultDto>(await invoke('test_probe_now', { config: probeConfig(probe) }));
  },

  async validateTarget(target: string): Promise<string> {
    if (!isDesktop) throw new BackendUnavailable('Target validation');
    return invoke<string>('validate_target', { target });
  },

  /** LT-090: an on-demand path snapshot, not a scheduled probe. */
  async traceroute(target: string): Promise<TracerouteResultDto> {
    if (!isDesktop) throw new BackendUnavailable('Traceroute');
    return camel<TracerouteResultDto>(await invoke('traceroute_now', { target }));
  },

  /** LT-095: opens a device/note link in the OS's own browser. There is no
   *  shell plugin here by design — this is the one narrow door for it. */
  async openExternalUrl(url: string): Promise<void> {
    if (!isDesktop) throw new BackendUnavailable('Opening a link');
    await invoke('open_external_url', { url });
  },

  async startValidation(
    projectId: string,
    operator: string,
    probes: Probe[],
  ): Promise<SessionInfo> {
    if (!isDesktop) throw new BackendUnavailable('Starting validation');
    return camel<SessionInfo>(
      await invoke('start_validation', { projectId, operator, probes: probes.map(probeConfig) }),
    );
  },

  /** Bring a running session's targets in line with the document (LT-062). */
  async updateValidation(probes: Probe[]): Promise<SessionInfo> {
    if (!isDesktop) return { sessionId: null, projectId: null, state: 'stopped', probeCount: 0 };
    return camel<SessionInfo>(await invoke('update_validation', { probes: probes.map(probeConfig) }));
  },

  async stopValidation(): Promise<SessionInfo> {
    if (!isDesktop) return { sessionId: null, projectId: null, state: 'stopped', probeCount: 0 };
    return camel<SessionInfo>(await invoke('stop_validation'));
  },

  async sessionStatus(): Promise<SessionInfo> {
    if (!isDesktop) return { sessionId: null, projectId: null, state: 'stopped', probeCount: 0 };
    return camel<SessionInfo>(await invoke('session_status'));
  },

  async probeSnapshot(): Promise<ProbeRuntime[]> {
    if (!isDesktop) return [];
    return camel<ProbeRuntime[]>(await invoke('probe_snapshot'));
  },

  async listEvents(projectId: string, limit = 2000): Promise<EventRow[]> {
    if (!isDesktop) return [];
    return camel<EventRow[]>(await invoke('list_events', { projectId, limit }));
  },

  async recordEvent(event: EventRow): Promise<void> {
    if (!isDesktop) return;
    await invoke('record_event', { event: eventRow(event) });
  },

  async appInfo(): Promise<{ version: string; dataDir: string; documentVersion: number }> {
    if (!isDesktop) {
      return { version: 'dev (browser)', dataDir: 'browser localStorage', documentVersion: 1 };
    }
    return camel(await invoke('app_info'));
  },

  /** Validate a subnet and say how big it is, without starting anything. */
  describeSubnet(subnet: string) {
    return invoke<SubnetInfo>('describe_subnet', { subnet });
  },

  /** Begin a ping sweep. Resolves with the number of addresses to be tried;
   *  results arrive on the sweep event. */
  startSweep(subnets: string[], options: SweepOptions) {
    return invoke<number>('start_sweep', { subnets, options: sweepOptions(options) });
  },

  /** Stop the running sweep. Safe to call when none is running. */
  cancelSweep() {
    return invoke<void>('cancel_sweep');
  },

  /** Subscribe to sweep progress and hits. */
  async onSweepEvent(handler: (e: SweepEvent) => void): Promise<() => void> {
    if (!isDesktop) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    return listen('coreview://sweep', (e) => handler(e.payload as SweepEvent));
  },

  /** Walk the network from a seed address. Credentials are used for this run
   *  and never stored. */
  /** `fallbackCredentials` are tried in order when the first is rejected. */
  startCrawl(
    input: CrawlInput,
    credentials: CredentialInput,
    fallbackCredentials?: CredentialInput[],
  ) {
    return invoke<void>('start_crawl', { input: crawlInput(input), credentials: credentialInput(credentials), fallbackCredentials: fallbackCredentials?.map(credentialInput) });
  },
  cancelCrawl() {
    return invoke<void>('cancel_crawl');
  },
  async onCrawlEvent(handler: (e: CrawlEvent) => void): Promise<() => void> {
    if (!isDesktop) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    return listen('coreview://crawl', (e) => handler(e.payload as CrawlEvent));
  },
  async onCrawlResult(handler: (r: CrawlResult) => void): Promise<() => void> {
    if (!isDesktop) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    return listen('coreview://crawl-result', (e) => handler(e.payload as CrawlResult));
  },

  /** Capture configurations into the chosen backup folder. */
  startBackup(
    input: {
      targets: BackupTarget[];
      kinds: ('running' | 'startup')[];
      secondFactor: boolean;
      port: number;
      credentialId?: string;
      /** LT-149: run on every selected device. Only commands that read are
       *  allowed; the backend refuses the whole run otherwise. */
      showCommands?: string[];
      paging?: PagingMode;
      /** LT-151: capture filename pattern; absent is the default. */
      filePattern?: string;
    },
    credentials: CredentialInput,
    stamp: string,
  ) {
    return invoke<void>('start_backup', { input: backupInput(input), credentials: credentialInput(credentials), stamp });
  },
  cancelBackup() {
    return invoke<void>('cancel_backup');
  },
  async onBackupEvent(handler: (e: BackupEvent) => void): Promise<() => void> {
    if (!isDesktop) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    // LT-073: the backend tags its enum adjacently; flatten before anyone
    // reads it, or every payload field is undefined.
    const { normaliseBackupEvent } = await import('./backupEvent');
    return listen('coreview://backup', (e) => {
      const event = normaliseBackupEvent(e.payload);
      if (event) handler(event);
    });
  },

  /** The credential vault. Every call here takes secrets in; only
   *  revealCredential returns one, and only while unlocked. */
  vaultStatus() {
    return isDesktop
      ? invoke<VaultStatus>('vault_status')
      : Promise.resolve({ exists: false, unlocked: false, credentials: 0, minimumPassphrase: 12 });
  },
  createVault(passphrase: string) {
    return invoke<void>('create_vault', { passphrase });
  },
  unlockVault(passphrase: string) {
    return invoke<void>('unlock_vault', { passphrase });
  },
  lockVault() {
    return invoke<void>('lock_vault');
  },
  /** LT-262: keep the open vault's key in the system keychain, or stop. */
  rememberVaultKey() {
    return invoke<void>('remember_vault_key');
  },
  forgetVaultKey() {
    return invoke<void>('forget_vault_key');
  },
  /** LT-262: open the vault with a kept key, where this machine keeps one. */
  unlockVaultFromKeychain() {
    return isDesktop ? invoke<'opened' | 'off' | 'stale'>('unlock_vault_from_keychain') : Promise.resolve('off' as const);
  },
  discardVault() {
    return invoke<number>('discard_vault');
  },
  saveCredential(credential: {
    id?: string;
    label: string;
    kind: string;
    username: string;
    secret: string;
    secondSecret?: string;
    detail?: string;
  }) {
    return invoke<string>('save_credential', { credential: saveCredential(credential) });
  },
  listCredentials() {
    return isDesktop ? invoke<CredentialSummary[]>('list_credentials') : Promise.resolve([]);
  },
  revealCredential(id: string) {
    return invoke<RevealedCredential>('reveal_credential', { id });
  },
  /** The vault as ciphertext, for moving it to another machine. Opening it
   *  elsewhere still needs the passphrase. */
  exportVault() {
    return invoke<unknown>('export_vault');
  },
  /** Takes the credentials out of an exported package. Needs the passphrase
   *  of the vault they were exported from, and this vault unlocked.
   *  Returns how many were imported. */
  importVault(vault: unknown, passphrase: string) {
    return invoke<number>('import_vault', { vault, passphrase });
  },
  deleteCredential(id: string) {
    return invoke<void>('delete_credential', { id });
  },
  /** LT-264: where saved credentials were offered, newest first. Local only. */
  listCredentialUse(credentialId?: string, limit = 500) {
    if (!isDesktop) return Promise.resolve([] as CredentialUse[]);
    return invoke<CredentialUse[]>('list_credential_use', { credentialId: credentialId ?? null, limit });
  },
  clearCredentialUse() {
    return invoke<number>('clear_credential_use');
  },

  /** Native open dialog for a project package. Returns null if cancelled. */
  async pickProjectFile(): Promise<string | null> {
    if (!isDesktop) throw new BackendUnavailable('Choosing a file');
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({
      multiple: false,
      title: 'Import a Coreview project',
      filters: [{ name: 'Coreview project', extensions: ['coreview', 'livetopo', 'json'] }],
    });
    return typeof picked === 'string' ? picked : null;
  },

  /** LT-245, LT-247: a device or link list — CSV or Excel — or a NetBox
   *  export. */
  async pickImportFile(): Promise<string | null> {
    if (!isDesktop) throw new BackendUnavailable('Choosing a file');
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({
      multiple: false,
      title: 'Import devices or links',
      filters: [
        { name: 'Spreadsheet or NetBox export', extensions: ['csv', 'txt', 'xlsx', 'xlsm', 'json', 'yaml', 'yml'] },
        { name: 'CSV', extensions: ['csv', 'txt'] },
        { name: 'Excel workbook', extensions: ['xlsx', 'xlsm'] },
        { name: 'NetBox export', extensions: ['json', 'yaml', 'yml'] },
      ],
    });
    return typeof picked === 'string' ? picked : null;
  },

  /** LT-245: every sheet of a workbook, as rows of text. */
  readSpreadsheet(path: string) {
    return invoke<{ name: string; rows: string[][] }[]>('read_spreadsheet', { path });
  },

  /** Reads a file the user chose in the open dialog. */
  readImport(path: string) {
    return invoke<string>('read_import', { path });
  },

  /** Native open dialog for a Visio drawing (LT-110). Null if cancelled. */
  async pickVisioFile(): Promise<string | null> {
    if (!isDesktop) throw new BackendUnavailable('Choosing a file');
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({
      multiple: false,
      title: 'Import a Visio or draw.io drawing',
      filters: [
        { name: 'Visio or draw.io drawing', extensions: ['vsdx', 'VSDX', 'drawio', 'xml'] },
        { name: 'Visio drawing', extensions: ['vsdx', 'VSDX'] },
        { name: 'draw.io drawing', extensions: ['drawio', 'xml'] },
      ],
    });
    return typeof picked === 'string' ? picked : null;
  },

  /** Reads a Visio drawing as devices and links. */
  importVisio(path: string) {
    return invoke<VisioImport>('import_visio', { path });
  },

  /** Devices with backups on disk. */
  listBackupDevices() {
    return isDesktop ? invoke<BackupDevice[]>('list_backup_devices') : Promise.resolve([]);
  },
  listDeviceCaptures(device: string) {
    return invoke<string[]>('list_device_captures', { device });
  },
  readCapture(device: string, filename: string) {
    return invoke<string>('read_capture', { device, filename });
  },
  diffCaptures(device: string, before: string, after: string) {
    return invoke<DiffLine[]>('diff_captures', { device, before, after });
  },
  /** LT-152: every run in the backup folder, newest first. */
  listBackupRuns() {
    return isDesktop ? invoke<BackupRunSummary[]>('list_backup_runs') : Promise.resolve([]);
  },
  /** LT-152: two runs compared per device, and per command for show commands. */
  compareBackupRuns(before: string, after: string) {
    return invoke<ComparedDevice[]>('compare_backup_runs', { before, after });
  },
  /** LT-153: checks against one run's show-command captures. Reads files only. */
  runBackupChecks(stamp: string, checks: BackupCheck[]) {
    return invoke<CheckResult[]>('run_backup_checks', { stamp, checks: checks.map(backupCheck) });
  },
  /** LT-124: a gateway's ARP table over SNMP, with a saved credential. The
   *  optional step after a sweep; the sweep itself stays credential-free. */
  readGatewayArp(gateway: string, credentialId: string) {
    return invoke<GatewayArpEntry[]>('read_gateway_arp', { gateway, credentialId });
  },

  /** Remembered SSH host keys, and the ways to forget them. */
  listHostKeys() {
    return isDesktop ? invoke<HostKeyRow[]>('list_host_keys') : Promise.resolve([]);
  },
  clearHostKeys() {
    return invoke<number>('clear_host_keys');
  },
  forgetHostKey(host: string, port: number) {
    return invoke<boolean>('forget_host_key', { host, port });
  },

  /** Subscribe to engine samples and transitions. */
  async onEngineEvent(handler: (payload: unknown) => void): Promise<() => void> {
    if (!isDesktop) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    const un = await listen('coreview://engine', (e) => handler(camel(e.payload)));
    return un;
  },
};
