/**
 * The only place the frontend talks to Rust.
 *
 * When the bundle is loaded in a plain browser (`npm run dev` without Tauri)
 * there is no backend, so project storage falls back to localStorage and any
 * probe call fails loudly. Nothing is simulated: a browser session cannot
 * produce probe results, and the UI says so.
 */
import { EMPTY_TREE, readTree, type FolderTree } from './projectFolders';
import type { PagingMode } from './showCommands';
import type { BackupCheck, CheckResult } from './checks';
import { backupCheck, backupInput, crawlInput, credentialInput, eventRow, probeConfig, projectPackage, saveCredential, sweepOptions, visioDrawing, collectionInput, topologyViewOptions, pathRequest, pathLiveInput } from './ipcPayloads';
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
  /** LT-440: the ports to try instead of the common list; empty means the common list. */
  ports?: number[];
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
  discoveredBy: 'cdp' | 'lldp' | 'fortiLink' | 'controller';
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
    | 'forti-link-stack'
    /** LT-395: ArubaOS-Switch backplane stacking, a 2930M ring. */
    | 'aruba-stack';
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
  /** LT-348: per-VRF routing tables, by VRF name. A device with a table for a
   *  VRF routes that VRF from it and from nothing else. */
  vrfRoutes?: Record<string, RouteRow[]>;
  /** LT-479: where policy routing is applied on this device; a trace says it was not evaluated. */
  policyRoutes?: { interface: string | null; name: string }[];
  /** LT-348: this device is a VXLAN tunnel endpoint. Filled from `overlay`
   *  below where a crawl collected it, or by an import. */
  vtep?: { address: string; segments: { vni: number; vlan?: number | null; prefix?: string | null }[] };
  /** LT-347: what a crawl read about this device's overlay, as the fabric
   *  printed it. Shaped by the device rather than by the path engine, so it is
   *  mapped onto `vtep` where it is used. */
  overlay?: {
    vtep?: string | null;
    segments: { vni: number; vlan?: number | null; kind?: string | null }[];
    peers: { address: string; state?: string | null; vnis: number[] }[];
    learned: { routeType: number; vni?: number | null; mac?: string | null; address?: string | null; nextHop?: string | null }[];
  };
  /** LT-480: OTV on a Nexus 7000 — the VLANs it extends, the far edges, and
   *  which edge owns each MAC. */
  otv?: {
    overlays: { name: string; extendedVlans: number[]; joinInterface?: string | null; joinAddress?: string | null }[];
    adjacencies: { overlay: string; hostname: string; address?: string | null; state?: string | null }[];
    routes: { vlan: number; mac: string; owner: string; nextHop: string }[];
  } | null;
  /** LT-348: address translation it performs. */
  nat?: { kind: 'destination' | 'source'; matches: string; becomes: string; port?: number | null; description?: string }[];
  /** LT-348: virtual addresses it answers for, and what is behind them. */
  vips?: { address: string; port?: number | null; members: string[]; description?: string }[];
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
  /** LT-438: where each field came from, by field name. */
  evidence?: Record<string, Evidence>;
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
  /** LT-347: the table the next hop is resolved in, where the device named
   *  one — NX-OS's `*via 203.0.113.4%default` in a tenant VRF. */
  nextHopVrf?: string | null;
  /** LT-347: the VXLAN segment this route crosses, from `segid: … encap:
   *  VXLAN`. Absent on a route that stays on a wire. */
  segmentId?: number | null;
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

/** LT-514: one catalog-driven collection, as `CollectionInput` in src-tauri/src/collection.rs. */
export type CollectionInput = {
  projectId: string;
  targets: string;
  port: number;
  osHint?: string;
  roleOverride?: string;
  planOnly: boolean;
  lightOnly: boolean;
  credentialId?: string;
  keepDiagnostic: boolean;
  connectTimeoutSecs?: number;
  authTimeoutSecs?: number;
  /** LT-518: a saved API login for FortiOS/AOS-CX REST, and for an FMC. */
  apiCredentialId?: string;
  /** LT-541: the FMC that manages the FTDs in this collection. */
  fmcHost?: string;
};

export type CollectionRunSummary = {
  id: string; projectId: string; seed: string; startedMs: number; finishedMs: number | null; status: string; planOnly: boolean; diagnosticDir: string | null; source: string; devices: number;
};

export type CollectionPlanStep = {
  id: string; cmd: string; gate: string; because: string[]; parser: string; feeds: string[]; weight: 'light' | 'heavy'; timeout: number; verified: 'lab' | 'docs' | 'unverified'; context: [string, string] | null; scope: string | null;
};
export type CollectionPlan = { steps: CollectionPlanStep[]; skipped: { id: string; cmd: string; reason: string }[] };

export type CollectionDevice = {
  deviceId: string; host: string; os: string | null; role: string | null; caps: string[]; versionText: string; prompt: string; contextKind: string | null; contexts: string[]; failure: string | null; log: string[]; plan: CollectionPlan | null; collectedAt: number;
};

export type CollectionLogEntry = {
  deviceId: string; seq: number; stepId: string; cmd: string; kind: 'probe' | 'command'; contextKind: string | null; contextName: string | null; gate: string; parser: string; feeds: string[]; status: string; durationMs: number; rows: number; rawRef: string | null; error: string | null; verified: string | null;
  /** LT-521: `match`, `mismatch` or `error` when shadow mode compared both parsers. */
  shadow?: string | null; shadowDetail?: string | null; engine?: string | null;
};

/** LT-527: the topology builder's graph, as `coreview-topology` serialises it. */
export type TopologyEnd = { node: string; port: string | null };
export type TopologyLink = {
  a: TopologyEnd; b: TopologyEnd; kind: 'cdp' | 'lldp' | 'api' | 'inferred_mac'; confidence: number; both_directions: boolean;
  bundle: { a_name: string | null; b_name: string | null; members: [string, string][] } | null;
  evidence: { device: string; command: string; note: string }[];
};
export type TopologyNode = { id: string; name: string; kind: 'collected' | 'neighbor' | 'unknown_switch'; os: string | null; role: string | null; model: string | null; stack_kind: string | null; members: { id: string }[]; pair: [string, string] | null; mgmt_ip: string | null };
export type TopologyGraph = {
  nodes: TopologyNode[];
  links: TopologyLink[];
  l3: { a: string; a_if: string | null; b: string; b_if: string | null; subnet: string; confirmed_by: string[]; confidence: number }[];
  overlays: { a: string; b: string | null; kind: string; name: string | null; local_ip: string | null; remote_ip: string | null }[];
  endpoints: { switch: string; port: string; mac: string; ip: string | null; vlan: string | null }[];
  findings: { kind: string; note: string; nodes: string[] }[];
};
export type TopologyViewOptions = { collapseBundles: boolean; collapseStacks: boolean; placeholders: boolean; minConfidence: number; vlan?: string; vrf?: string };
export type TopologyBuilt = { crawlRunId: string; devices: CrawledDevice[]; notVisited: Neighbor[]; graph: TopologyGraph };

// LT-531–LT-535: the path builder over a collection run (crates/coreview-path).
export type PathRequest = {
  from: string; to: string; vrf?: string | null; protocol?: string | null; port?: number | null; sourcePort?: number | null;
  downDevices?: string[]; downLinks?: { device: string; interface: string }[];
  /** Verify: each traceroute hop's answering address, null for `*`. */
  traceroute?: (string | null)[] | null;
  noReverse?: boolean;
};
export type PathMatched = { prefix: string; protocol: string; kind: string; distance: number | null; metric: number | null; nextHop: string | null; command: string };
export type PathL2Step = { device: string; inPort: string | null; outPort: string | null; vlan: string | null; blocked: boolean };
export type PathFirewall = { zoneIn: string | null; zoneOut: string | null; policy: string | null; action: string | null; verdict: 'allow' | 'deny' | 'undetermined'; reason: string };
export type PathRewrite = { rule: string; kind: string; field: 'source' | 'destination'; was: string; now: string };
export type PathOverlay = { tunnel: string; kind: string | null; local: string | null; remote: string; underlay: string[] };
export type PathDecision = 'local' | 'connected' | 'lpm' | 'default' | 'pbr';
export type PathHop = {
  device: string; inInterface: string | null; vrf: string; src: string; dst: string; decision: PathDecision;
  matched: PathMatched | null; via: PathMatched[]; outInterface: string | null; nextHop: string | null; nextHopMac: string | null;
  nextDevice: string | null; l2: PathL2Step[]; firewall: PathFirewall | null; nat: PathRewrite[]; ecmp: number; overlay: PathOverlay | null; notes: string[];
};
export type PathPlace = { switch: string; port: string; vlan: string | null; mac: string };
export type PathEnding =
  | { kind: 'delivered'; device: string | null; endpoint: PathPlace | null }
  | { kind: 'dropped'; at: string; reason: string }
  | { kind: 'denied'; at: string; policy: string | null }
  | { kind: 'unmanaged'; at: string; nextHop: string; mac: string | null; name: string | null }
  | { kind: 'insufficient'; at: string | null; reason: string }
  | { kind: 'loop'; at: string };
export type CollectedPath = { hops: PathHop[]; ending: PathEnding };
export type PathTrace = {
  from: string; to: string; source: { starts: string[]; endpoint: PathPlace | null; how: string } | null;
  paths: CollectedPath[]; warnings: string[]; truncated: boolean;
};
export type PathAsymmetry = { symmetric: boolean; onlyForward: string[]; onlyReverse: string[]; notes: string[] };
export type PathVerify = { path: number; matchPercent: number; rows: { n: number; traceroute: string | null; tracerouteDevice: string | null; modeled: string | null; agrees: boolean }[] };
export type PathOutcome = { forward: PathTrace; reverse: PathTrace | null; asymmetry: PathAsymmetry | null; verify: PathVerify | null };
export type LiveAnswer = { id: string; command: string; status: string; rows: Record<string, unknown>[]; raw: string; reason: string | null; verified: string };
export type LiveHop = {
  device: string; host: string | null; os: string | null;
  run: { host: string; answers: LiveAnswer[]; hostKey: string | null; hostKeyFirstSeen: boolean; failure: string | null; log: string[] } | null;
  check: { agrees: boolean | null; detail: string };
};
export type LiveReport = { path: number; hops: LiveHop[] };
export type PathLiveInput = { runId: string; request: PathRequest; credentialId?: string; port: number; path?: number };

/** LT-521: per (os, command), how often both parsers read a reply and how often they disagreed. */
export type ShadowLine = { os: string; cmd: string; parser: string; compared: number; mismatches: number; errors: number; lastDetail: string | null };

export type CollectionRunDetail = { run: CollectionRunSummary | null; devices: CollectionDevice[]; log: CollectionLogEntry[]; tables: [string, number][] };

export type CollectionEvent =
  | { kind: 'started'; runId: string; targets: number }
  | { kind: 'device'; runId: string; deviceId: string; host: string; phase: string }
  | { kind: 'identified'; runId: string; deviceId: string; os: string; probe: string }
  | { kind: 'probe'; runId: string; deviceId: string; id: string; cmd: string; status: string; flags: string[] }
  | { kind: 'planned'; runId: string; deviceId: string; steps: number; skipped: number }
  | { kind: 'step'; runId: string; deviceId: string; stepId: string; cmd: string; status: string; rows: number; durationMs: number; context: string | null }
  | { kind: 'deviceDone'; runId: string; deviceId: string; host: string; os: string | null; failure: string | null; commands: number }
  | { kind: 'finished'; runId: string; devices: number; failed: number; cancelled: boolean }
  | { kind: 'failed'; runId: string; error: string };

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
  /** LT-389: write a debug log of this run. Off unless asked for. */
  debugLog?: boolean;
  /** LT-497: the project's other saved SSH logins, tried after the first. */
  fallbackCredentialIds?: string[];
  /** LT-481: keep every identity command's reply, redacted, for support. */
  supportCapture?: boolean;
  /** LT-424: the project the run is kept under. Without one, nothing is kept. */
  projectId?: string;
  /** LT-199, LT-209: saved credentials bound to devices, subnets or vendors,
   *  by vault id. */
  bindings?: { scope: 'device' | 'subnet' | 'vendor'; value: string; credentialId: string }[];
};

export type CrawlDetails = {
  routes: boolean;
  spanningTree: boolean;
  vlans: boolean;
  /** LT-347: each VRF's own routing table. Off by default — the parsers were
   *  built from documentation and have met no hardware (D-051). */
  vrfs: boolean;
  /** LT-347: VTEPs, VNIs and EVPN routes. Off by default, same reason. */
  overlay: boolean;
};

export type SshProgress =
  | { kind: 'connecting'; host: string }
  | { kind: 'checkingHostKey'; host: string }
  | { kind: 'authenticating'; host: string }
  | { kind: 'awaitingSecondFactor'; host: string; message: string }
  /** LT-377: logged in, waiting for the device to draw a prompt. */
  | { kind: 'openingShell'; host: string }
  | { kind: 'ready'; host: string; hostname: string }
  | { kind: 'running'; host: string; command: string };

/** LT-345: what happened when a saved credential was tried on one device.
 *  Three outcomes, not two: `refused` is a password problem, `unreachable`
 *  means the login was never tested at all. */
export interface CredentialTestResult {
  outcome: 'reached' | 'refused' | 'unreachable';
  detail: string;
  millis: number;
}

/** LT-320: a live SSH session, as the backend lists it. */
export interface SshSession {
  id: string;
  address: string;
}

/** What a live session reports. `bytes` is base64: a chunk can end in the
 *  middle of a multi-byte character, and decoding is the terminal's job. */
export type SshEvent =
  | { kind: 'data'; id: string; bytes: string }
  | { kind: 'closed'; id: string; reason: string }
  /** LT-325: a keepalive went out and the connection was there to take it. */
  | { kind: 'alive'; id: string; at: number }
  /** LT-324: where the transcript is being written, or that it has stopped. */
  | { kind: 'logging'; id: string; path: string | null }
  /** Something went wrong that did not end the session. */
  | { kind: 'warning'; id: string; message: string };

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
  | 'output-too-large'
  | 'other';

export type CrawlFailure = {
  address: string;
  reason: string;
  kind?: FailureKind;
  /** LT-384: where the login stream was written, for a device that never
   *  reached a prompt. Absent when there was nothing to write — a device that
   *  refused the connection outright never said anything to record. */
  transcriptPath?: string;
};

/** LT-435: one change to one device in one crawl. */
export type TimelineEntry = {
  runId: string;
  takenAt: number;
  device: string;
  field: 'appeared' | 'disappeared' | 'class' | 'platform' | 'version' | 'serial' | 'address' | 'neighbour' | 'restarted' | string;
  was: string | null;
  now: string | null;
  source: string | null;
};
export type CrawlTimeline = {
  entries: TimelineEntry[];
  newestRun: string | null;
  runs: number;
  sinceLast: Record<string, number>;
};

/** LT-438: where a fact about a device came from (D-050). */
export type Evidence = {
  /** A short fixed name for the mechanism: `prompt`, `ssh:show version`,
   *  `snmp:sysDescr`, `neighbour-report`, `oui`, `fortigate:wtp`, `typed`. */
  source: string;
  /** The device that reported it, where it was a neighbour and not the device itself. */
  seenBy?: string | null;
  seenAtMs?: number | null;
  /** What was read, clipped. */
  detail?: string;
};

/** LT-432: one running job as `jobs.rs` reports it. */
export type JobKind = 'crawl' | 'backup' | 'sweep' | 'meraki' | 'icon-scan';
export type JobState = 'running' | 'stopping' | 'complete' | 'cancelled';
export type JobSnapshot = {
  id: number;
  kind: JobKind;
  state: JobState;
  phase: string;
  done: number;
  total: number | null;
  startedMs: number;
};

/** LT-424: how a kept crawl ended — or that it has not, or that the process did. */
export type CrawlRunStatus = 'running' | 'complete' | 'cancelled' | 'aborted';

export type CrawlResult = {
  devices: CrawledDevice[];
  notVisited: Neighbor[];
  failures: CrawlFailure[];
  cancelled: boolean;
  /** LT-389: where the debug log went, when the run was asked to write one. */
  debugLogPath?: string | null;
  /** LT-481: where the support capture went, and how many replies it holds. */
  supportCapture?: { folder: string; files: number; problem?: string | null } | null;
  /** LT-454: host keys trusted on first contact during this crawl. */
  firstSeenKeys?: { host: string; port: number; fingerprint: string }[];
  /** LT-424: the kept run this result was written to, when the crawl had a project. */
  runId?: string | null;
  status?: CrawlRunStatus;
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

/** LT-477: a device's own traceroute. */
export type MeasuredTrace = {
  hops: { ttl: number; address: string | null; rttsMs: number[] }[];
  command: string;
  platform: string;
};

/** LT-478: the leg a device hashes a flow onto. */
export type MeasuredLeg = { nextHop: string; interface: string | null; command: string };

export type CredentialSummary = {
  id: string;
  label: string;
  kind: string;
  username: string;
  detail: string;
  hasSecondSecret: boolean;
  /** D-059: the project that owns it; listed on the start screen only. */
  ownerProjectId?: string | null;
  ownerProjectName?: string | null;
};

/* ── Meraki (LT-404–406). What the Dashboard answers with, as Rust hands it
 *    on. Every one of these is read-only data; nothing here can change a
 *    customer's configuration, because nothing in the Rust client can. */

/** An organisation — a customer, in the operator's words. */
export type MerakiOrganization = { id: string; name: string; url?: string | null };

export type MerakiNetwork = {
  id: string;
  name: string;
  productTypes: string[];
  organizationId?: string | null;
  timeZone?: string | null;
  tags: string[];
};

/** The bars a profile judges against. */
export type MerakiThresholds = {
  latencyMs: number;
  lossPct: number;
  chanUtilPct: number;
  nonWifiPct: number;
  wifiFailPct: number;
  clientFailCount: number;
  licenceDays: number;
  stpEventCount: number;
};

/** The same facts, graded for the environment they live in. */
export type MerakiProfile = {
  id: string;
  label: string;
  summary: string;
  thresholds: MerakiThresholds;
  defaultSeverity: 'action' | 'advisory';
  actions: string[];
};

export type MerakiFinding = { code: string; severity: 'action' | 'advisory' };

export type MerakiDetail = { label: string; columns: string[]; rows: string[][] };

/** `manual` means the API returned nothing for this item — a statement about
 *  what could be read, never a task handed back to the reader. */
export type MerakiStatus = 'attention' | 'advisory' | 'manual' | 'pass' | 'na';

/** Which of the three checklists an item belongs to. */
export type MerakiSection = 'firewall' | 'wireless' | 'switching';

export type MerakiCheck = {
  id: string;
  section: MerakiSection;
  num: string;
  title: string;
  navigation: string;
  /** What the item covers, shown before the verdict. */
  checklist: string[];
  status: MerakiStatus;
  summary: string;
  observations: string[];
  details: MerakiDetail[];
  /** What to do about it, numbered. */
  steps: string[];
  findings: MerakiFinding[];
};

export type MerakiReport = {
  takenAt: string;
  organization: string;
  network: string;
  profile: MerakiProfile;
  checks: MerakiCheck[];
  dataWindows: string;
};

/** What a Meraki discovery found. `devices` is the same shape a crawl's are,
 *  which is what lets them go through the same review and reconcile path. */
export type MerakiDiscovered = {
  devices: CrawledDevice[];
  /** How many cables the estate itself reported. */
  links: number;
  /** What could not be read — a thin estate and an unreadable one look the
   *  same without this. */
  notes: string[];
};

export type MerakiBackupWritten = {
  path: string;
  networks: number;
  /** Sections read, against sections asked for. */
  read: number;
  asked: number;
};

/** Only ever returned by revealCredential, which is the one call that hands
 *  back a stored secret. */
export type RevealedCredential = {
  username: string;
  secret: string;
  secondSecret: string | null;
};

export type BackupDevice = { name: string; captures: number; latest: string | null; changedAtLatest: boolean | null };
/** LT-433: one capture in a device's history, flagged against the previous of its kind. */
export type CaptureHistoryRow = {
  file: string;
  stamp: string | null;
  kind: string | null;
  bytes: number;
  previous: string | null;
  changed: boolean | null;
};
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
  /** LT-521: "true" runs the Rust parser beside the sidecar on every collection. */
  collectorShadow: string;
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
  /** LT-321/322/323/325: how the terminal behaves. How somebody likes to read
   *  and work, so these are settings on the machine rather than facts about
   *  the estate — a project carries none of them. */
  sshFontFamily: string;
  sshFontSize: string;
  sshColourise: string;
  sshKeepaliveSeconds: string;
  sshLogByDefault: string;
  /** Where a plain **SSH to this device** goes: `panel` or `external`. */
  sshOpenWith: string;
  /** The command that opens a session elsewhere, with {user} {host} {port}. */
  sshExternalCommand: string;
  /** LT-344: clipboard manners in the terminal, both off until asked for. */
  sshCopyOnSelect: string;
  sshPasteOnRight: string;
}>;

/**
 * Which project is open, for the calls that belong to one (LT-413, LT-414).
 *
 * Settings and backups are a property of the work, not of the computer — a
 * customer's backup folder, the commands a run sends, the addresses a
 * discovery was pointed at. Rather than thread a project id through forty call
 * sites and rely on nobody forgetting one, the layer that talks to the backend
 * knows which project is open and says so on every call that needs it.
 *
 * `null` when no project is open, and the backend refuses those calls rather
 * than falling back to a shared value — falling back is the bug.
 */
let currentProjectId: string | null = null;

/** Told by the store when a project opens or closes — and, since D-059,
 *  told to Rust too, which opens every secret against it. Awaited by the
 *  store, so nothing lists or opens a credential before Rust knows. */
export async function setCurrentProject(id: string | null): Promise<void> {
  currentProjectId = id?.trim() || null;
  if (isDesktop) await invoke('set_open_project', { projectId: currentProjectId });
}

export function currentProject(): string | null {
  return currentProjectId;
}

/** The project a call belongs to, or an empty string so the backend gives the
 *  proper refusal rather than this throwing somewhere less explicable. */
const forProject = () => currentProjectId ?? '';

export const ipc = {
  /** Every stored preference. Browser mode has no backend, so none. */
  async getSettings(): Promise<StoredSettings> {
    if (!isDesktop) return {};
    return invoke<StoredSettings>('get_settings', { projectId: forProject() });
  },

  /** Stores a preference, or clears it when value is null. */
  async setSetting(key: keyof StoredSettings, value: string | null): Promise<void> {
    if (!isDesktop) return;
    await invoke('set_setting', { key, value, projectId: forProject() });
  },

  /** Picking a folder is not the same as being able to write into it: a
   *  read-only mount picks cleanly and fails at the first backup. */
  async checkFolderWritable(path: string): Promise<void> {
    if (!isDesktop) return;
    await invoke('check_folder_writable', { path });
  },

  /** LT-255: `project.coreview` and `project.yaml` in `folder/name`. */
  /** LT-456: where an export goes — the chosen folder, or a native save
   *  dialog shown in Rust — as a one-shot token and the path to tell the
   *  person. Null when the dialog was cancelled. */
  async pickExportTarget(filename: string, folder?: string | null): Promise<{ token: string; path: string } | null> {
    if (!isDesktop) throw new BackendUnavailable('Choosing where to save');
    return invoke('pick_export_target', { filename, folder: folder ?? null });
  },
  async pickExportFolder(folder?: string | null): Promise<{ token: string; path: string } | null> {
    if (!isDesktop) throw new BackendUnavailable('Choosing a folder');
    return invoke('pick_export_folder', { folder: folder ?? null });
  },
  saveProjectFolder(token: string, name: string, json: string, yaml: string) {
    return invoke<string>('save_project_folder', { token, name, json, yaml });
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

  // LT-485: folders on the project screen. The desktop app keeps them in its
  // database; the browser build has none, and says so where it matters.
  async listProjectFolders(): Promise<FolderTree> {
    if (!isDesktop) return EMPTY_TREE;
    return readTree(await invoke('list_project_folders'));
  },
  async createProjectFolder(name: string, parentId: string | null): Promise<void> {
    await invoke('create_project_folder', { name, parentId });
  },
  async renameProjectFolder(id: string, name: string): Promise<void> {
    await invoke('rename_project_folder', { id, name });
  },
  async moveProjectFolder(id: string, parentId: string | null): Promise<void> {
    await invoke('move_project_folder', { id, parentId });
  },
  async deleteProjectFolder(id: string): Promise<void> {
    await invoke('delete_project_folder', { id });
  },
  async moveProjectToFolder(id: string, folderId: string | null): Promise<void> {
    if (!isDesktop) return;
    await invoke('move_project_to_folder', { id, folderId });
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

  /** LT-477: `device`'s own traceroute to `target`. Measured, not calculated. */
  async tracerouteFromDevice(device: string, credentialId: string, target: string): Promise<MeasuredTrace> {
    return invoke('traceroute_from_device', { device, credentialId, target });
  },
  /** LT-478: which equal-cost leg `device` hashes this flow onto, from its own answer. */
  async ecmpLegFromDevice(device: string, credentialId: string, source: string, destination: string, protocol?: number | null, sourcePort?: number | null, destinationPort?: number | null): Promise<MeasuredLeg> {
    return invoke('ecmp_leg_from_device', { device, credentialId, source, destination, protocol: protocol ?? null, sourcePort: sourcePort ?? null, destinationPort: destinationPort ?? null });
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
  /** LT-227: stored crawl results, to compare two. Written by the crawl
   *  itself as it goes (LT-424); `status` is running, complete, cancelled or
   *  aborted. */
  async listCrawlRuns(projectId: string): Promise<{ id: string; takenAt: number; seed: string; devices: number; status: CrawlRunStatus }[]> {
    if (!isDesktop) return [];
    return invoke('list_crawl_runs', { projectId });
  },
  /** LT-435: what changed across every kept crawl, oldest first. */
  async crawlTimeline(projectId: string, device?: string): Promise<CrawlTimeline> {
    if (!isDesktop) throw new BackendUnavailable('Stored crawls');
    return invoke('crawl_timeline', { projectId, device: device?.trim() || null });
  },
  async crawlRunResult(id: string): Promise<CrawlResult> {
    if (!isDesktop) throw new BackendUnavailable('Stored crawls');
    // LT-455: a run is read only from the project it belongs to.
    return invoke('crawl_run_result', { id, projectId: forProject() });
  },

  /** LT-224: a probe's recorded results since `sinceMs`, oldest first. */
  async probeHistory(probeId: string, sinceMs: number, limit = 2000): Promise<{ timestampMs: number; status: string; outcome: string; rttMs: number | null }[]> {
    if (!isDesktop) return [];
    // LT-455: a probe's history is read only from this project's sessions.
    return invoke('probe_history', { probeId, projectId: forProject(), sinceMs, limit });
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

  /** LT-432: every job running or stopping right now. */
  async listJobs(): Promise<JobSnapshot[]> {
    if (!isDesktop) return [];
    return invoke('job_list');
  },
  /** LT-432: stop one job by its id; says whether there was one. */
  async cancelJob(id: number): Promise<boolean> {
    if (!isDesktop) return false;
    return invoke('job_cancel', { id });
  },
  /** LT-432: one event for every change to any job. */
  async onJob(handler: (j: JobSnapshot) => void): Promise<() => void> {
    if (!isDesktop) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    return listen('coreview://job', (e) => handler(e.payload as JobSnapshot));
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
  // LT-514: the catalog-driven collection.
  startCollection(input: CollectionInput, credentials?: CredentialInput) {
    return invoke<string>('start_collection', { input: collectionInput(input), credentials: credentials ? credentialInput(credentials) : undefined });
  },
  cancelCollection() {
    return invoke<void>('cancel_collection');
  },
  listCollectionRuns(projectId: string) {
    return invoke<CollectionRunSummary[]>('list_collection_runs', { projectId });
  },
  collectionRun(id: string) {
    return invoke<CollectionRunDetail>('collection_run', { id });
  },
  collectionTopology(runId: string, options: TopologyViewOptions) {
    return invoke<TopologyBuilt>('collection_topology', { runId, options: topologyViewOptions(options) });
  },
  collectionPath(runId: string, request: PathRequest) {
    return invoke<PathOutcome>('collection_path', { runId, request: pathRequest(request) });
  },
  collectionLive(input: PathLiveInput, credentials?: CredentialInput) {
    return invoke<LiveReport>('collection_live', { input: pathLiveInput(input), credentials: credentials ? credentialInput(credentials) : undefined });
  },
  shadowReport(projectId: string) {
    return invoke<ShadowLine[]>('shadow_report', { projectId });
  },
  collectionTable(runId: string, table: string, deviceId?: string) {
    return invoke<Record<string, unknown>[]>('collection_table', { runId, table, deviceId });
  },
  collectionRaw(runId: string, rawRef: string) {
    return invoke<string>('collection_raw', { runId, rawRef });
  },
  importCaptures(projectId: string, folder: string) {
    return invoke<string>('import_captures', { projectId, folder });
  },
  async onCollectionEvent(handler: (e: CollectionEvent) => void): Promise<() => void> {
    if (!isDesktop) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    return listen('coreview://collection', (e) => handler(e.payload as CollectionEvent));
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

  // ---------------------------------------------------- LT-320 SSH sessions

  /** Opens a shell on a device and returns the session's id. The password
   *  never crosses this boundary: the credential is named by its vault id. */
  sshOpen(
    address: string,
    credentialId: string,
    size: { cols: number; rows: number },
    port?: number,
    keepaliveSeconds?: number,
  ) {
    if (!isDesktop) throw new BackendUnavailable('An SSH session');
    return invoke<string>('ssh_open', {
      address, credentialId, port, cols: size.cols, rows: size.rows, keepaliveSeconds,
    });
  },
  /** LT-324: append this session's transcript beside the device's backups.
   *  Returns the path it is writing to. */
  sshLogStart(id: string, where: {
    folder: string; device: string; address: string; site?: string; pattern?: string;
  }) {
    return invoke<string>('ssh_log_start', { id, ...where });
  },
  sshLogStop(id: string) {
    return invoke<void>('ssh_log_stop', { id });
  },
  /** LT-325: how often this session says it is still there. 0 or undefined
   *  turns it off. */
  sshKeepalive(id: string, seconds: number | undefined) {
    return invoke<void>('ssh_keepalive', { id, seconds });
  },
  /** LT-345: try a saved credential against one device and say what happened.
   *  Opens a shell and closes it — nothing is typed and no command is run. */
  sshTestCredential(address: string, credentialId: string, port?: number) {
    if (!isDesktop) throw new BackendUnavailable('Testing a login');
    return invoke<CredentialTestResult>('ssh_test_credential', { address, credentialId, port });
  },
  /** LT-321: hand the connection to the terminal the machine already has.
   *  The password is deliberately not passed — the client asks for it.
   *  Returns what was actually run, so the window can say so. */
  sshExternal(address: string, username: string, port?: number, command?: string) {
    if (!isDesktop) throw new BackendUnavailable('An external terminal');
    return invoke<string[]>('ssh_external', { address, username, port, command });
  },
  /** Keystrokes, base64 as they came off the terminal. */
  sshSend(id: string, bytes: string) {
    return invoke<void>('ssh_send', { id, bytes });
  },
  sshResize(id: string, cols: number, rows: number) {
    return invoke<void>('ssh_resize', { id, cols, rows });
  },
  sshClose(id: string) {
    return invoke<void>('ssh_close', { id });
  },
  /** Ends every session. Closing a project must not leave a shell logged in. */
  sshCloseAll() {
    if (!isDesktop) return Promise.resolve(0);
    return invoke<number>('ssh_close_all');
  },
  /** The sessions this process still holds. They outlive a page reload, which
   *  is how the tab strip finds them again. */
  sshSessions() {
    if (!isDesktop) return Promise.resolve([] as SshSession[]);
    return invoke<SshSession[]>('ssh_sessions');
  },
  async onSshEvent(handler: (e: SshEvent) => void): Promise<() => void> {
    if (!isDesktop) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    return listen('coreview://ssh', (e) => handler(e.payload as SshEvent));
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
    return invoke<void>('start_backup', { input: backupInput(input), credentials: credentialInput(credentials), stamp, projectId: forProject() });
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
  /** D-059: hands a login to a project, or to none. Start screen only. */
  async assignCredential(id: string, projectId: string | null): Promise<void> {
    await invoke('assign_credential', { id, projectId });
  },
  listCredentials() {
    return isDesktop ? invoke<CredentialSummary[]>('list_credentials') : Promise.resolve([]);
  },

  // ── Meraki (LT-404, LT-405, LT-406). Read-only, and every call carries the
  // id of a vault credential rather than a key: the key never reaches the
  // page, in either direction.
  merakiOrganizations(credentialId: string) {
    return invoke<MerakiOrganization[]>('meraki_organizations', { credentialId });
  },
  merakiNetworks(credentialId: string, organizationId: string) {
    return invoke<MerakiNetwork[]>('meraki_networks', { credentialId, organizationId });
  },
  merakiProfiles() {
    return isDesktop ? invoke<MerakiProfile[]>('meraki_profiles') : Promise.resolve([]);
  },
  merakiBackup(credentialId: string, organizationId: string, networkIds: string[], stamp: string) {
    return invoke<MerakiBackupWritten>('meraki_backup', { credentialId, organizationId, networkIds, stamp, projectId: forProject() });
  },
  merakiHealthCheck(credentialId: string, organizationId: string, networkId: string, profile: string) {
    return invoke<MerakiReport>('meraki_health_check', { credentialId, organizationId, networkId, profile, projectId: forProject() });
  },
  /** LT-411: the estate as devices the diagram can take, in the same shape a
   *  crawl returns so the merge path is shared. */
  merakiDiscover(credentialId: string, organizationId: string, networkIds: string[]) {
    return invoke<MerakiDiscovered>('meraki_discover', { credentialId, organizationId, networkIds });
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
    return isDesktop ? invoke<BackupDevice[]>('list_backup_devices', { projectId: forProject() }) : Promise.resolve([]);
  },
  listDeviceCaptures(device: string) {
    return invoke<string[]>('list_device_captures', { device, projectId: forProject() });
  },
  /** LT-433: every capture of one device, newest first, with what changed. */
  deviceCaptureHistory(device: string) {
    return invoke<CaptureHistoryRow[]>('device_capture_history', { device, projectId: forProject() });
  },
  readCapture(device: string, filename: string) {
    return invoke<string>('read_capture', { device, filename, projectId: forProject() });
  },
  diffCaptures(device: string, before: string, after: string) {
    return invoke<DiffLine[]>('diff_captures', { device, before, after, projectId: forProject() });
  },
  /** LT-152: every run in the backup folder, newest first. */
  listBackupRuns() {
    return isDesktop ? invoke<BackupRunSummary[]>('list_backup_runs', { projectId: forProject() }) : Promise.resolve([]);
  },
  /** LT-152: two runs compared per device, and per command for show commands. */
  compareBackupRuns(before: string, after: string) {
    return invoke<ComparedDevice[]>('compare_backup_runs', { before, after, projectId: forProject() });
  },
  /** LT-153: checks against one run's show-command captures. Reads files only. */
  runBackupChecks(stamp: string, checks: BackupCheck[], roles: Record<string, string> = {}) {
    return invoke<CheckResult[]>('run_backup_checks', { stamp, checks: checks.map(backupCheck), projectId: forProject(), roles });
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
