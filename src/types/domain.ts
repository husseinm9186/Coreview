import type { CommentThread } from '../lib/comments';
export type HealthStatus =
  | 'unknown'
  | 'healthy'
  | 'warning'
  | 'down'
  | 'disabled'
  | 'maintenance';

export type ProbeKind = 'icmp' | 'tcp' | 'dns' | 'http' | 'https' | 'udp' | 'snmp' | 'manual';

export type ObjectKind = 'node' | 'link';

export type DeviceType =
  | 'generic'
  | 'firewall'
  | 'router'
  | 'core-switch'
  | 'distribution-switch'
  | 'access-switch'
  | 'l3-switch'
  | 'l2-switch'
  | 'wireless-controller'
  | 'access-point'
  | 'ip-phone'
  | 'blade-chassis'
  | 'load-balancer'
  | 'waf'
  | 'server'
  | 'vm'
  | 'vm-host'
  | 'storage'
  | 'endpoint'
  | 'printer'
  | 'camera'
  | 'internet'
  | 'private-cloud'
  | 'site'
  | 'vpn'
  | 'mpls-cloud'
  | 'rack'
  | 'patch-panel'
  | 'pdu'
  | 'ups'
  | 'application'
  | 'database'
  | 'custom-image'
  | 'rectangle'
  | 'rounded'
  | 'circle'
  | 'diamond'
  | 'zone'
  | 'callout'
  | 'cloud'
  | 'text';

/** The device types that are drawn as a plain shape rather than as a device
 *  glyph — a rectangle drawn as a glyph is not a rectangle. Matters to
 *  anything that has to know what outline a node actually has: LT-107 meets a
 *  glyph on its circle and one of these on its box.
 *
 *  `DeviceNode.tsx` and `diagram.ts` each still keep their own copy of this
 *  list, and they do not agree — see LT-108. */
export const SHAPE_DEVICE_TYPES: ReadonlySet<string> = new Set([
  'rectangle',
  'rounded',
  'circle',
  'diamond',
  'cloud',
  'text',
  'zone',
  'callout',
]);

/** LT-200–204: a device's tables as a crawl last read them. */
export interface DeviceInventory {
  collectedAt: number;
  uptimeSeconds?: number;
  ports: InventoryPort[];
  vlans: { id: number; name: string }[];
  routes: {
    family: 4 | 6;
    prefix: string;
    protocol: string;
    nextHops: string[];
    interface?: string;
  }[];
  spanningTree: {
    instance: string;
    vlan?: number;
    rootBridge?: string;
    isRoot: boolean;
    rootPort?: string;
    /** Ports not forwarding in this instance. */
    blocked: string[];
  }[];
}

export interface InventoryPort {
  port: string;
  description?: string;
  status: string;
  speed?: string;
  duplex?: string;
  mode?: 'trunk' | 'access' | 'routed';
  vlan?: number;
  /** A trunk's VLANs, compressed: `1,8,10,14-16`. */
  trunkVlans?: string;
  /** LT-235: error counters, when the crawl read them. */
  errors?: { input: number; crc: number; output: number; collisions: number; resets: number; drops: number };
}

export interface NodeAddress {
  id: string;
  /** Friendly label, e.g. "Management", "Loopback0", "WAN1". */
  label: string;
  address: string;
  isPrimary: boolean;
}

export interface Probe {
  id: string;
  projectId: string;
  objectKind: ObjectKind;
  objectId: string;
  name: string;
  kind: ProbeKind;
  target: string;
  tcpPort?: number | null;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  warningLatencyMs?: number | null;
  enabled: boolean;
  maintenance: boolean;
  isPrimary: boolean;
  notes?: string;
  /** `http`/`https` request path, e.g. `/health`. Unset sends `/`. */
  httpPath?: string | null;
  /** `https` only: skip certificate validation, for an internal CA or a
   *  self-signed backup-site endpoint. */
  ignoreCertErrors?: boolean;
  /** `dns` only: fail (as `address_mismatch`) if resolution does not include
   *  this address — proves a DNS/GSLB failover actually moved a name. */
  expectedAddress?: string | null;
  /** `http`/`https` only: fail (as `body_mismatch`) if a healthy response
   *  does not contain this text — catches a maintenance page or a default
   *  web-server page answering in place of the real application. */
  expectedBody?: string | null;
  /** `udp` only (LT-217): what to send — `dns`, `ntp`, or hex digits. */
  udpPayload?: string | null;
  /** `dns` only (LT-219): ask this server directly, for `dnsRecord` records. */
  dnsServer?: string | null;
  dnsRecord?: string | null;
  /** `snmp` only (LT-220): the saved SNMP credential, by vault id. */
  snmpCredentialId?: string | null;
}

export const PROBE_DEFAULTS = {
  intervalSeconds: 5,
  timeoutMs: 1000,
  failureThreshold: 3,
  recoveryThreshold: 1,
  warningLatencyMs: 100,
} as const;

export interface DeviceNodeData extends Record<string, unknown> {
  /** Which views this device appears on. Unset means every view — an object
   *  that has never been assigned belongs to all of them. */
  layers?: string[];
  label: string;
  deviceType: DeviceType;
  hostname?: string;
  vendor?: string;
  /** The hardware address, where discovery learned one (LT-121/LT-126).
   *
   *  This is the field that lets a sweep and a crawl agree that they found
   *  the same box. A name changes, an address is reassigned by DHCP, but the
   *  MAC a switch learned on a port and the MAC a ping sweep read out of the
   *  ARP table are the same twelve hex digits — so it is the strongest key
   *  the two halves of discovery share. */
  mac?: string;
  model?: string;
  /** The chassis serial. The number an RMA, a support contract and a licence
   *  are all keyed on, so it is the one piece of inventory an engineer needs
   *  off the diagram and cannot derive from anything else on it. Discovery
   *  fills it in where a device will say it; otherwise it is typed. */
  serial?: string;
  /** Whatever the asset register calls this box. Not the serial: one is the
   *  vendor's and one is the organisation's, and reconciling them is the job. */
  assetTag?: string;
  /** The software the device reported — `show version`'s first line, or an
   *  SNMP sysDescr (LT-146). Discovery knows this and had nowhere to put it,
   *  so it was thrown away; it is the field a compliance question is asked
   *  of. */
  osVersion?: string;
  /** The ports the sweep found answering, as `22/SSH, 443/HTTPS` (LT-146).
   *  A string rather than a list because it is written once by discovery,
   *  read by a person, and belongs in a spreadsheet column. */
  openPorts?: string;
  /** Where this device hangs: the switch and the port it was learned on
   *  (LT-146), as `LAB-CORE-SW1 Gi1/0/11`. The single most-asked question in
   *  a wiring closet, and until now it was buried in the notes. */
  switchPort?: string;
  /** How this was found — a ping sweep, an SSH login, SNMP, or a neighbour's
   *  report. Provenance for everything above: an operator deciding whether to
   *  trust a field needs to know who said it. */
  discoveredVia?: string;
  /** What holds several boxes together, where this is not one box (LT-148):
   *  `StackWise`, `VSF`, `VSX`, `Virtual Chassis` and so on. Empty for an
   *  ordinary switch, which is most of them. */
  stackKind?: string;
  /** The members, one per line: `1 active FOC0000TEST`. The serial matters
   *  most — a stack is one device on a diagram and four boxes an RMA is
   *  raised against, so each member keeps its own. */
  stackMembers?: string;
  /** True while the parser that read this has met no real hardware (D-026).
   *  Carried onto the device so the interface can say so rather than
   *  presenting a documentation-derived guess as a fact. */
  stackUnverified?: boolean;
  /** One half of a chassis pair drawn as two switches (LT-140). It keeps the
   *  pair's stack fields, so the inspector still lists both members, but it is
   *  one box and draws the single glyph (LT-159). */
  stackSplit?: boolean;
  /** Ticked by hand in the inspector (LT-160): an HA pair or cluster that
   *  discovery cannot see — a firewall pair, a stack not yet crawled. Draws the
   *  stacked glyph. Discovery never writes it, so a re-crawl never unticks it. */
  ha?: boolean;
  /** Show commands this device gets on top of the Backups tab's global list
   *  (LT-149), one per line. The operator's own, stored with the project on
   *  his machine — nothing ships pre-filled (D-027). */
  showCommands?: string;
  role?: string;
  /** LT-214: why a crawl decided the role it wrote, when it wrote one. */
  roleEvidence?: string;
  site?: string;
  rack?: string;
  /** Height in rack units (LT-171). Filled from the shape's defaults when the
   *  device is dropped; 0 is a zero-U device such as a vertical PDU; unset is
   *  something that does not go in a rack. Read by the rack views (LT-195). */
  rackUnits?: number;
  /** The lowest U the device occupies in its rack (LT-195). Whole U only. */
  rackU?: number;
  /** The face it is mounted from (LT-197); front when unset. */
  rackFace?: 'front' | 'rear';
  /** Whether it fills the rack front to back (the default) or only the face it
   *  is mounted on, leaving the other face's U free (LT-197). */
  rackDepth?: 'full' | 'half';
  /** LT-239: threaded comments on this device. */
  comments?: CommentThread[];
  /** LT-234: files about this device — photos, configs, contracts — by their
   *  path on this machine. Only the path is kept; the file stays where it is. */
  attachments?: { id: string; label: string; path: string }[];
  /** LT-206: what reverse DNS calls the device's address. */
  dnsName?: string;
  /** LT-199: saved credentials to try on this device first, by vault id —
   *  never the secret itself. */
  sshCredentialId?: string;
  snmpCredentialId?: string;
  /** What a crawl read from the device's command line (LT-200–204): ports,
   *  VLANs, routes, spanning tree and uptime. Replaced whole on each crawl. */
  inventory?: DeviceInventory;
  /** How many ports the device has, and how they are named — `{n}` is the
   *  port number (LT-171). The names are offered when a link's port label is
   *  typed. Defaults are generic, never a vendor's naming (D-028). */
  portCount?: number;
  portNaming?: string;
  /** The licence statement of the stencil this device's artwork came from,
   *  when a manifest gave one (LT-169). Named when the project is exported
   *  (LT-170). */
  stencilLicence?: string;
  /** The inlined artwork is Coreview's own (a captured built-in glyph), so an
   *  export does not warn about it (LT-170). */
  ownArtwork?: boolean;
  /** A section that is a logical boundary (LT-166): what kind, and its
   *  identifier — a VLAN ID, prefix, zone name, VRF, AS number or area. */
  boundaryKind?: 'vlan' | 'subnet' | 'security-zone' | 'vrf' | 'bgp-as' | 'ospf-area';
  boundaryId?: string;
  notes?: string;
  /** A runbook, a vendor portal, a ticket — opened in the OS browser from the
   *  canvas. http(s) only; enforced where it is actually opened, not here. */
  link?: string;
  tags: string[];
  /** The VLAN this device sits in, when discovery learned it (LT-027).
   *  Used by colour-by-VLAN; a switch that trunks many has none. */
  vlan?: string;
  addresses: NodeAddress[];
  locked: boolean;
  /** Suppresses status reporting for a planned outage. */
  maintenance: boolean;
  showDetails: boolean;
  imageDataUrl?: string;
  /** Objects sharing a groupId move together. Nothing is drawn for a group:
   *  it exists in behaviour only, so a device and the notes explaining it stay
   *  a unit without a box around them. */
  groupId?: string;
  /** Id of an icon from the local library. imageDataUrl carries the inlined
   *  copy so an exported project still renders on a machine without the
   *  library folder. */
  iconRef?: string;
  style?: {
    background?: string;
    border?: string;
    iconColor?: string;
    /** Overrides the page's glyph variant for this device (LT-168). */
    glyphVariant?: 'outline' | 'solid';
  };
  /** How the device's name is written (LT-181). */
  labelStyle?: { bold?: boolean; italic?: boolean; size?: number; color?: string; background?: string; align?: 'left' | 'center' | 'right' };
}

export interface NoteNodeData extends Record<string, unknown> {
  /** Which views this note appears on. Unset means every view. */
  layers?: string[];
  title?: string;
  /** See DeviceNodeData.link. */
  link?: string;
  body: string;
  /** Change-note styling for pre-check / rollback / risk annotations. */
  /** LT-237: `sticky` is the yellow sticky note. */
  variant: 'plain' | 'change' | 'sticky';
  fontSize: number;
  /** Left unset means "follow the ground". A colour here is a decision and is
   *  kept whichever ground the diagram is being drawn on. */
  textColor?: string;
  background?: string;
  borderColor?: string;
  locked: boolean;
  /** See DeviceNodeData.groupId. */
  groupId?: string;
}

/** `avoid` is orthogonal and routes round the devices in its way (LT-178). */
export type LinkPathType = 'straight' | 'step' | 'smoothstep' | 'bezier' | 'avoid';
export type LinkDirection = 'none' | 'forward' | 'reverse' | 'both';

/** What sits at the end of a line. */
export type LinkCap = 'none' | 'arrow' | 'open-arrow' | 'circle' | 'square' | 'diamond';

/** How the line itself is drawn. 'auto' keeps the health meaning — a link that
 *  is down is dashed and one that is disabled is dotted — which is right until
 *  someone needs a dashed line to mean a tunnel instead. */
export type LinkLineStyle = 'auto' | 'solid' | 'dashed' | 'dotted' | 'dash-dot';

export type LinkHealthRuleType =
  | 'manual'
  | 'follow-source'
  | 'follow-target'
  | 'both-endpoints'
  | 'dedicated-probe'
  | 'named-node-probe';

export interface LinkHealthRule {
  type: LinkHealthRuleType;
  /** For 'named-node-probe'. */
  nodeId?: string;
  probeId?: string;
  /** For 'manual'. */
  manualStatus?: HealthStatus;
}

export interface LinkData extends Record<string, unknown> {
  /** What this line is. A 'leader' points a note at the thing it is about; it
   *  is an annotation, not a cable, so it carries no health, is not counted,
   *  and does not hop over the links it crosses. */
  kind?: 'link' | 'leader';
  /** LT-239: threaded comments on this link. */
  comments?: CommentThread[];
  /** LT-215: a layer-3 hop a crawl found — one device routes via the other —
   *  rather than a cable. Drawn on the Logical view. */
  layer3?: boolean;
  sourcePortLabel: string;
  targetPortLabel: string;
  label: string;
  /** How much a bezier link bows (LT-072). React Flow's default is 0.25;
   *  unset means automatic. Dragging the curve handle sets it. */
  curvature?: number;
  /** Hand-placed routing waypoints in flow coordinates (LT-068). When set,
   *  the link runs through them instead of auto-routing; empty or unset is
   *  the automatic route. */
  waypoints?: { x: number; y: number }[];
  /** Where along the drawn path the centre label sits, 0..1. Unset is the
   *  midpoint — every link ever drawn before LT-051. */
  labelAt?: number;
  /** Where along the drawn path each port label sits, 0..1 (LT-097), the
   *  same mechanism as `labelAt`. Unset keeps the fixed-distance-from-each-
   *  end placement `portAnchors` already computes (LT-050/055's parallel-
   *  cable stacking fix) — dragging a port label is what sets this. */
  sourcePortAt?: number;
  targetPortAt?: number;
  /** Flat text attached to the link (LT-052): a port number written straight
   *  on the line, no box, no border. Each remembers its spot along the path. */
  texts?: { id: string; at: number; text: string }[];
  pathType: LinkPathType;
  direction: LinkDirection;
  width: number;
  color: string;
  enabled: boolean;
  maintenance: boolean;
  notes?: string;
  healthRule: LinkHealthRule;
  lineStyle?: LinkLineStyle;
  /** What the link is physically made of (LT-167), shown as a tag in its
   *  centre label and listed in the cable schedule. */
  cableType?: 'copper' | 'fiber-sm' | 'fiber-mm' | 'coax' | 'wireless' | 'wan' | 'trunk';
  /** How long the cable is, as written — `3 m`, `10ft` (LT-198). Listed in the
   *  cable schedule; free text, since cable is bought in whatever unit the
   *  site uses. */
  cableLength?: string;
  /** How the centre label and the two port labels are written (LT-181). */
  labelStyle?: { bold?: boolean; italic?: boolean; size?: number; color?: string; background?: string; align?: 'left' | 'center' | 'right' };
  portLabelStyle?: { bold?: boolean; italic?: boolean; size?: number; color?: string; background?: string; align?: 'left' | 'center' | 'right' };
  /** Overrides what `direction` would put at each end. Left unset, an arrow
   *  follows the flow direction as it always has. */
  startCap?: LinkCap;
  endCap?: LinkCap;
  /** Which lane this link takes out of a crowded side, worked out on every
   *  render and never saved. Several links leaving the same side of the same
   *  device would otherwise run along one another and be impossible to
   *  follow. */
  lane?: number;
  /** Where the line's colour comes from. 'status' is the default and paints
   *  the whole link by health. 'fixed' paints the line with `color` — for
   *  marking a fibre run or a carrier circuit — while everything that carries
   *  liveness stays status-coloured, so the link is still a live link. */
  colorMode?: 'status' | 'fixed';
  /** Keep this link on the sides it is drawn on, instead of letting it swing
   *  round as the devices move. Off by default: a link that stays attached to
   *  the bottom of a device after that device has been moved above its
   *  neighbour is drawn wrong, and nobody wants to correct that by hand. */
  pinnedSides?: boolean;
  /** Where this end leaves its device, as a point on the device's own
   *  bounding box rather than one of the 4 fixed handles (LT-098) — `x`/`y`
   *  each 0..1, always with one of them pinned to 0 or 1 so the point sits
   *  on the perimeter, not inside it. Unset keeps today's 4-side behaviour;
   *  set by dragging the link's end anywhere around the shape. Surviving a
   *  resize for free is the whole reason this is normalized rather than a
   *  fixed pixel offset. */
  sourceAnchor?: { x: number; y: number };
  targetAnchor?: { x: number; y: number };
}

export interface ProjectMeta {
  id: string;
  name: string;
  customer: string;
  site: string;
  ticket: string;
  engineer: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

export interface EventRow {
  id: string;
  projectId: string;
  sessionId: string | null;
  timestampMs: number;
  objectType: ObjectKind;
  objectId: string;
  objectName: string;
  eventType: 'transition' | 'session' | 'test';
  previousStatus: HealthStatus | null;
  currentStatus: HealthStatus | null;
  probeType: ProbeKind | null;
  target: string | null;
  rttMs: number | null;
  message: string;
}

export interface ProbeRuntime {
  probeId: string;
  status: HealthStatus;
  lastRttMs: number | null;
  lastSuccessMs: number | null;
  lastFailureMs: number | null;
  lastSummary: string | null;
  consecutiveFailures: number;
  failureThreshold: number;
}

export type SessionState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export const STATUS_LABEL: Record<HealthStatus, string> = {
  unknown: 'Unknown',
  healthy: 'Healthy',
  warning: 'Warning',
  down: 'Down',
  disabled: 'Disabled',
  maintenance: 'Maintenance',
};

/** Status is never carried by color alone; each has a glyph too. */
export const STATUS_GLYPH: Record<HealthStatus, string> = {
  unknown: '?',
  healthy: '✓',
  warning: '!',
  down: '✕',
  disabled: '–',
  maintenance: '⚙',
};

export const HEALTH_RULE_LABEL: Record<LinkHealthRuleType, string> = {
  manual: 'Manual — no monitoring',
  'follow-source': 'Follow source node status',
  'follow-target': 'Follow target node status',
  'both-endpoints': 'Both endpoint nodes must be healthy',
  'dedicated-probe': 'Dedicated probe target',
  'named-node-probe': 'Follow a named probe on a node',
};
