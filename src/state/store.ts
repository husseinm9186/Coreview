import { EMPTY_TREE, type FolderTree } from '../lib/projectFolders';
import { create } from 'zustand';
import type { Edge, Node } from '@xyflow/react';
import { applyEdgeChanges, applyNodeChanges, type EdgeChange, type NodeChange } from '@xyflow/react';

import { ipc, isDesktop, type ProbeResultDto, type IconLibEntry, type StoredSettings, type JobSnapshot, type CrawledDevice, type Neighbor, setCurrentProject } from '../lib/ipc';
import { applyJob } from '../lib/jobs';
import { forgetSummary, rememberSummary, summarise } from '../lib/projectSummary';
import { staleCredentials, withoutStaleCredentials } from '../lib/credentialScope';
import { uid } from '../lib/id';
import { newProbe } from '../lib/probes';
import { migrateDocument } from '../lib/migrate';
import type { TimeFormat } from '../lib/timeFormat';
import { linkStyleDefaults, type LinkStyleDefaults } from '../lib/linkDefaults';
import { groupBySubnet as bucketBySubnet } from '../lib/subnetGroups';
import {
  DEFAULT_VRF, entriesOf, normaliseCidr, parseCidr as parseCidrOf, rangeProblem, subnetProblem,
  toAddress as addressOf, toValue,
  type IpamContainer, type IpamEntry, type IpamRange, type IpamState, type IpamVrf,
} from '../lib/ipam';
import { diffOf, noteChange } from '../lib/ipamAudit';
import {
  agreedBy, auditView, carriedBy, customFieldProblem, nameProblem, withoutField, withoutReference,
  type CustomFieldDraft,
} from '../lib/ipamMeta';
import { tidyLayout as evenOutSpacing } from '../lib/tidyLayout';
import { hierarchicalLayout } from '../lib/hierarchyLayout';
import { routeLinks as chooseLinkSides } from '../lib/routeLinks';
import { zoneDeltas } from '../lib/zones';
import { alignTo, distribute } from '../lib/alignment';
import { copySelection, pasteClipping, type Clipping } from '../lib/clipboard';
import { layersOf, standardLayers, withNewLayer, withoutLayer, withStandardLayers, type Layer } from '../lib/layers';
import { svgForDevice } from '../lib/customShapes';
import { deleteHistory, loadHistory, saveHistory } from '../lib/historyStore';
import { forceLayout, orthogonalLayout, radialLayout } from '../lib/autoLayout';
import type { CredentialRule } from '../lib/credentialBindings';
import { readProfile, withProfile, type CrawlProfile } from '../lib/crawlProfiles';
import type { IntentRule } from '../lib/intentChecks';
import type { LifecycleRow } from '../lib/lifecycle';
import type { DrawerContent } from '../components/Drawer';
import { applyChanges, type Change } from '../lib/reconcile';
import { probeFromTemplate, targetOf, withTemplate, type ProbeTemplate } from '../lib/probeTemplates';
import type { Sample } from '../lib/sparkline';
import type { CanvasFilter } from '../lib/canvasFilter';
import type { InkStroke } from '../lib/ink';
import type { CommentThread } from '../lib/comments';
import { MAX_RACK_UNITS, furnitureRackables, placementProblem, rackableOf, racksFromDevices, spanOf, type Airflow, type Rack, type RackFace, type RackFurniture, type Rackable } from '../lib/rack';
import { furnitureProblem, newFurniture, type FurnitureKind } from '../lib/rackFurniture';
import { stackPreset, stackProblem, type Stack } from '../lib/stacking';
import { deviceColor as computeDeviceColor } from '../theme';
import { activePage, allEdges, allNodes, duplicatePage as duplicatePageIn, newPage, renamePage as renamePageIn, reorderPages as reorderPagesIn, setActivePage as setActivePageIn, withNewPage, withoutPage, withPage, nodeById, edgeById } from '../lib/pages';
import { pageForContent } from '../lib/pageRect';
import type { ColourBy } from '../lib/tinting';
import {
  linkStatus as computeLinkStatus,
  nodeStatus as computeNodeStatus,
} from '../health/evaluate';
import type {
  DeviceNodeData,
  EventRow,
  HealthStatus,
  LinkData,
  NoteNodeData,
  Probe,
  ProbeRuntime,
  ProjectMeta,
  SessionState,
} from '../types/domain';

export type TopoNode = Node<DeviceNodeData, 'device'> | Node<NoteNodeData, 'note'>;
export type TopoEdge = Edge<LinkData>;

/**
 * One independent drawing (LT-094). Its own devices, links, and everything
 * about how they are drawn — completely separate from any other page in the
 * project, the way a rack elevation and a logical topology are two drawings
 * rather than two views of one.
 */
export interface ProjectPage {
  id: string;
  name: string;
  nodes: TopoNode[];
  edges: TopoEdge[];
  canvas: {
    gridEnabled: boolean;
    snapEnabled: boolean;
    minimap: boolean;
    /** What a link looks like unless it has been given a look of its own
     *  (LT-079). On the page, so the choice travels with the diagram. */
    linkStyle?: Partial<LinkStyleDefaults>;
    /** Little hops where one link crosses another. On by default: two lines
     *  meeting at a point look exactly like two lines joined at a point. */
    lineJumps?: boolean;
    /** The sheet the diagram is drawn on. On by default; turning it off gives
     *  back the endless desk for a diagram that is not going on paper. Named
     *  apart from "page" (LT-094) so the print-sheet boundary of one drawing
     *  is never confused with which of several drawings this is. */
    sheet?: boolean;
    /** What the sheet has grown to. Grows automatically, shrinks only through
     *  "Fit page to content" — a sheet that snaps smaller mid-drag makes the
     *  whole layout jump. */
    sheetRect?: { x: number; y: number; w: number; h: number };
    /** The views this page is drawn in. A network is documented more than
     *  once — physical, logical, the change on Saturday — and three files that
     *  disagree within a fortnight is what this exists to avoid. */
    layers?: Layer[];
    /** What device colour means. Health is the default and is what the app is
     *  for; the others answer questions a general drawing tool cannot, because
     *  it does not know what an address is. */
    colourBy?: ColourBy;
    /** How device nodes are drawn. 'glyph' is the icon with its name beneath
     *  and no box, the way a network diagram is normally drawn. 'card' is the
     *  bordered panel that holds the same text inside it. */
    nodeStyle?: 'glyph' | 'card';
    /** Device glyphs drawn as outlines (the default) or as solid tiles —
     *  the device's colour filled, the glyph in ink over it (LT-168). A
     *  device can override it. */
    glyphVariant?: 'outline' | 'solid';
    /** LT-238: freehand marks on this page, in diagram coordinates. */
    ink?: InkStroke[];
    /** LT-238: ink kept but not shown, nor exported. */
    inkHidden?: boolean;
    /** Named places on this page to come back to (LT-192): where the viewport
     *  was, and how far in. */
    viewpoints?: { id: string; name: string; x: number; y: number; zoom: number }[];
    /** The minimap coloured by health rather than drawn plain (LT-191). */
    minimapHealth?: boolean;
  };
}

/** The durable part of a project. Everything else is UI or live state. */
/** One SSH session's tab (LT-320). Window state — see `sshSessions`. */
export interface SshTab {
  /** The backend's session id; also the key of its terminal. */
  id: string;
  /** What was connected to. */
  address: string;
  /** What the tab is called — the device's name where it has one. */
  label: string;
  /** The node it was opened from, so the tab can select it again. */
  nodeId?: string;
  status: 'open' | 'closed';
  /** Why it ended, once it has. */
  reason?: string;
  /** LT-324: where this session's transcript is being appended, if it is. */
  logPath?: string | null;
  /** LT-325: when the device last took a keepalive, so "is it still up" is
   *  answered by looking rather than by typing into somebody's command line. */
  lastAlive?: number;
  /** LT-503: the tab's own identity, fixed when it is first opened. `id` is
   *  the session's and changes when an ended session is reopened here. */
  tabKey?: string;
  /** LT-503: the saved login it was opened with — its id, never a secret —
   *  so an ended session can be opened again from its own tab. */
  credentialId?: string;
}

export interface ProjectDocument {
  pages: ProjectPage[];
  /** Which page is being viewed and edited. Always one of `pages` once
   *  through migration/emptyDocument — never used to mean "no page". */
  activePageId: string;
  /** Flat and project-wide regardless of which page a device or link is
   *  drawn on (LT-094) — which page something is drawn on is not the same
   *  question as whether it is being checked. */
  probes: Probe[];
  /** Shapes captured from a device already on the canvas (LT-104), kept
   *  with this project rather than a shared library. Optional — absent on
   *  every project saved before this existed, same as `canvas.layers`. */
  customShapes?: IconLibEntry[];
  /** Snap a dragged object to the grid where no alignment guide applies
   *  (LT-175, the D-013 amendment). A project setting, off by default. */
  gridSnap?: boolean;
  /** The project's racks (LT-195). A device is in one when its `rack` names
   *  it; where, is its `rackU`. Absent on projects saved before racks. */
  racks?: Rack[];
  /** LT-683, D-065: the stacks — the diagram's devices in member order,
   *  with a technology. Absent on projects saved before stacks. */
  stacks?: Stack[];
  /** LT-209: saved credentials to try first by subnet or vendor. Vault ids
   *  only. */
  credentialRules?: CredentialRule[];
  /** LT-212: named crawl settings. No secrets — see crawlProfiles.ts. */
  crawlProfiles?: CrawlProfile[];
  /** LT-437: rules about how the estate is meant to be, checked against
   *  every crawl and reported among the findings. See intentChecks.ts. */
  intentRules?: IntentRule[];
  /** LT-439: the operator's own lifecycle table — model, end of sale, end of
   *  support — read from a CSV he supplies. Nothing is fetched from a vendor. */
  lifecycle?: LifecycleRow[];
  /** LT-222: saved checks to add to other devices. */
  probeTemplates?: ProbeTemplate[];
  /** LT-271: a sample's guided tour, and the steps already done. */
  guide?: { done: string[]; hidden?: boolean };
  /** LT-286: the saved credentials this project reaches for, by vault id.
   *  Ids only — every secret stays in the vault (D-006), so a project handed
   *  to someone else carries a reference to nothing they can open. Written by
   *  "Keep for this project" in the crawl and backup forms, so a rescan or a
   *  backup does not start by typing the same password again. */
  /** `ssh` is the first login tried; `sshMore` (LT-497) the others, in order. */
  credentialDefaults?: { ssh?: string; sshMore?: string[]; snmp?: string[] };
  /** LT-285: the address register's declared half — subnets someone wrote
   *  down and addresses held back. What is *known* about addresses is derived
   *  from the devices themselves and is not stored twice. */
  ipam?: IpamState;
}

/** The dock's tabs (LT-675). */
export type PathQuestion = { to: string; app: string; protocol: string; port: string; vrf: string };
export type InspectorTab = 'status' | 'identity' | 'ports' | 'checks' | 'notes';
export type DockTab = 'objects' | 'events' | 'discover' | 'crawl' | 'collect' | 'backup' | 'path' | 'trace' | 'tracert' | 'whereis' | 'ssh';

export interface AppSettings {
  reduceMotion: boolean;
  /** How timestamps are written (LT-076). A machine preference, not part of
   *  the document: two people reading the same diagram may want different
   *  clocks. */
  timeFormat: TimeFormat;
  /** LT-298: the address table's columns this machine has hidden. Stored as
   *  what is hidden rather than what is shown, so a custom field added later
   *  appears without anybody having to go and find it. */
  registerHiddenColumns: string[];
  highContrast: boolean;
  /** LT-674: the chrome's size, as a multiple of the root size the screen
   *  sets (0.85–1.4). A machine preference. The canvas's zoom is its own. */
  uiScale: number;
  /** LT-676: where the dock sits — along the bottom, or popped out to the
   *  right for wide tables. A view preference for this machine. */
  dockSide: 'bottom' | 'right';
  /** The overview box, bottom-right. A view preference for this machine, like
   *  which panels are open — not part of any project. */
  minimap: boolean;
  /** Paper for exports and printing. 'fit' sizes the file to the diagram. */
  paper: string;
  orientation: 'portrait' | 'landscape';
  /** 'light' draws the diagram on white, for a document or a projector. */
  ground: 'dark' | 'light';
  /** Where configuration backups are written. Chosen by the user, and kept
   *  well away from exports: a running-config holds SNMP communities and
   *  hashed passwords, and must not travel inside a project someone shares. */
  backupFolder: string | null;
  /** Where exports land without prompting. Null falls back to a save dialog. */
  exportFolder: string | null;
  /** LT-321–325: how the SSH terminal behaves. How somebody likes to read and
   *  work, so these belong to the machine and never to a project. */
  terminal: TerminalSettings;
}

/**
 * The terminal's preferences as they come back from the settings table.
 *
 * Everything stored is a string, and a stored value that has become nonsense —
 * a hand-edited database, a setting written by an older build — falls back to
 * the default rather than leaving the terminal with a font size of `NaN`.
 */
export function terminalFromStored(stored: StoredSettings, current: TerminalSettings): TerminalSettings {
  const number = (raw: string | undefined, fallback: number, low: number, high: number) => {
    const n = Number(raw);
    return raw !== undefined && Number.isFinite(n) ? Math.min(Math.max(n, low), high) : fallback;
  };
  const flag = (raw: string | undefined, fallback: boolean) =>
    raw === undefined ? fallback : raw === 'true';
  return {
    fontFamily: stored.sshFontFamily ?? current.fontFamily,
    fontSize: number(stored.sshFontSize, current.fontSize, 8, 32),
    colourise: flag(stored.sshColourise, current.colourise),
    // Zero is off, and is a real choice; anything above an hour is not.
    keepaliveSeconds: number(stored.sshKeepaliveSeconds, current.keepaliveSeconds, 0, 3600),
    logByDefault: flag(stored.sshLogByDefault, current.logByDefault),
    openWith: stored.sshOpenWith === 'external' ? 'external' : 'panel',
    externalCommand: stored.sshExternalCommand ?? current.externalCommand,
    copyOnSelect: flag(stored.sshCopyOnSelect, current.copyOnSelect),
    pasteOnRight: flag(stored.sshPasteOnRight, current.pasteOnRight),
  };
}

/** @see AppSettings.terminal */
export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  /** LT-322: colour output from devices that send none. */
  colourise: boolean;
  /** LT-325: seconds between keepalives; 0 turns them off. */
  keepaliveSeconds: number;
  /** LT-324: start every session logging, without being asked each time. */
  logByDefault: boolean;
  /** LT-321: where a plain **SSH to this device** goes. */
  openWith: 'panel' | 'external';
  /** The command that opens somebody else's terminal, with {user}, {host} and
   *  {port}. Empty means the sensible one for this platform. */
  externalCommand: string;
  /** LT-344: highlighting text copies it, the way PuTTY does. Off until it is
   *  asked for — it replaces the clipboard every time a line is highlighted
   *  to read it, which is a nasty surprise for anyone who did not expect it. */
  copyOnSelect: boolean;
  /** LT-344: right-click pastes into the session instead of opening the menu.
   *  Off until asked for: it types into a live device with no confirmation. */
  pasteOnRight: boolean;
}

/** What the terminal does before anyone has said otherwise. */
export const TERMINAL_DEFAULTS: TerminalSettings = {
  fontFamily: '',
  fontSize: 12,
  colourise: true,
  // Long enough not to be chatter, short enough to beat a five-minute idle
  // timer and to hold a NAT translation open.
  keepaliveSeconds: 30,
  logByDefault: false,
  openWith: 'panel',
  externalCommand: '',
  copyOnSelect: false,
  pasteOnRight: false,
};

export interface HistoryEntry {
  pages: ProjectPage[];
  activePageId: string;
  probes: Probe[];
  customShapes?: IconLibEntry[];
  /** LT-285: the address register is part of the document, so removing a
   *  subnet by accident is undone like anything else. */
  ipam?: IpamState;
  /** LT-682: the racks and their furniture, and the stacks (LT-683), for
   *  the same reason. Absent on histories saved before them. */
  racks?: Rack[];
  stacks?: Stack[];
}

interface Store {
  // --- project
  projects: ProjectMeta[];
  /** LT-485: the folders on the project screen, and which folder is open. */
  folderTree: FolderTree;
  projectFolderId: string | null;
  setProjectFolder: (id: string | null) => void;
  meta: ProjectMeta | null;
  doc: ProjectDocument;
  dirty: boolean;
  lastSavedAt: number | null;
  /** When a person last asked for a save (LT-380). Autosave does not set it. */
  savedAck: number | null;

  // --- selection & ui
  selectedNodeId: string | null;
  /** A node that has just been made and should be typed into straight away. */
  editingNodeId: string | null;
  /** Devices the panel filter currently matches, lit up on the canvas so the
   *  table and the drawing answer the same question at the same time. */
  canvasHighlight: Set<string> | null;
  /** LT-348: bumped to ask the canvas to fit what is on the page. A counter
   *  rather than a flag, so two requests in a row both take effect. Landing on
   *  a generated page showing one corner of it is a poor way to arrive. */
  fitRequest: number;
  /** Unsaved work recovered from a previous session that ended badly. */
  recovery: { savedAt: number } | null;
  selectedEdgeId: string | null;
  settings: AppSettings;
  /** Runtime-indexed icon library. Never persisted with the project — the
   *  project stores an iconRef plus an inlined copy instead. */
  iconLibrary: IconLibEntry[];
  iconLibraryDir: string | null;
  iconLibraryError: string | null;
  /** The shapes that ship inside the installer (D-022) — always there,
   *  untouched by loading or clearing the user's own folder. */
  bundledIcons: IconLibEntry[];
  /** The bundled stencil packs (LT-103) each of those shapes came from —
   *  Cisco today — each removable to free space. */
  stencilPacks: { name: string }[];
  panelOpen: boolean;
  /** LT-675: which of the dock's tabs is showing — held here so the rail
   *  can name it and open it, not only the panel's own strip. */
  dockTab: DockTab;
  setDockTab: (tab: DockTab) => void;
  /** LT-677: which of the device inspector's tabs is showing. Kept across a
   *  change of selection, so editing the identities of several devices does
   *  not mean choosing Identity again for each. */
  inspectorTab: InspectorTab;
  setInspectorTab: (tab: InspectorTab) => void;
  /** LT-677: devices handed to the Backups tab by something other than a
   *  crawl — the inspector's Backup button. The panel takes them and clears it. */
  backupHandover: { address: string; name: string }[] | null;
  requestBackup: (targets: { address: string; name: string }[] | null) => void;
  /** LT-678: whether Discover's Advanced step is unfolded. The Collect view
   *  lives under it, so a request for that view opens it. */
  discoverAdvanced: boolean;
  setDiscoverAdvanced: (open: boolean) => void;
  /** LT-679: the one question the four path tools answer — where to, for
   *  what — kept here so it is asked once and carried from tab to tab.
   *  From stays with each tool, because each chooses it from a different
   *  list (a crawl's devices, this machine or a device, the diagram). */
  pathQuestion: PathQuestion;
  setPathQuestion: (patch: Partial<PathQuestion>) => void;
  /** LT-677: a question for Where is, asked from the inspector. */
  whereIsRequest: string | null;
  requestWhereIs: (query: string | null) => void;
  /** LT-675: the top bar's Search asks the canvas to open the command
   *  palette, which owns it. */
  commandPaletteRequest: boolean;
  requestCommandPalette: (on: boolean) => void;
  paletteOpen: boolean;
  inspectorOpen: boolean;

  // --- live
  session: { id: string | null; state: SessionState; startedAt: number | null };
  runtime: Map<string, ProbeRuntime>;
  /** LT-224: each probe's latest results, for its live sparkline. */
  recentSamples: Map<string, Sample[]>;
  events: EventRow[];
  statusMessage: string | null;

  // --- history
  past: HistoryEntry[];
  future: HistoryEntry[];

  // actions
  refreshProjects: () => Promise<void>;
  createProject: (meta: Partial<ProjectMeta>, doc?: ProjectDocument) => Promise<void>;
  openProject: (id: string) => Promise<void>;
  closeProject: () => Promise<void>;
  saveProject: (opts?: { auto?: boolean }) => Promise<void>;
  duplicateProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  updateMeta: (patch: Partial<ProjectMeta>) => void;

  // --- pages (LT-094)
  /** Adds a page and makes it the active one. */
  addPage: (name: string) => void;
  /** LT-348: a page that arrives with a diagram already on it, for Path
   *  Intelligence. The same Pages machinery as `addPage` — unique name, link
   *  style inherited, made active — so a generated page renames, saves,
   *  exports and deletes like any other. Returns its id. */
  addGeneratedPage: (name: string, content: { nodes: TopoNode[]; edges: TopoEdge[] }) => string;
  /** Removes a page and everything drawn on it, cascading to its probes.
   *  Refuses to remove the last page. */
  removePage: (id: string) => void;
  renamePage: (id: string, name: string) => void;
  /** A copy of one page with fresh ids throughout and no probes carried
   *  over — the same rule paste already applies to a copied selection. */
  duplicatePage: (id: string) => void;
  reorderPages: (fromIndex: number, toIndex: number) => void;
  setActivePage: (id: string) => void;

  onNodesChange: (changes: NodeChange<TopoNode>[]) => void;
  /** Bind the current selection together so it moves as one. */
  groupSelected: () => void;
  /** Release the group a node belongs to. */
  ungroup: (nodeId: string) => void;
  /** Every node in this node's group, itself included. Empty if ungrouped. */
  groupMembers: (nodeId: string) => string[];
  /** Binds each subnet's devices together. Returns how many groups were made. */
  groupBySubnet: () => { groups: number; ungrouped: number };
  tidyLayout: () => { moved: number; rows: number; locked: number };
  /** Rearranges the page as a top-to-bottom flow. Unlike `tidyLayout`, this
   *  deliberately moves things: it is for a topology that arrived without an
   *  arrangement worth keeping. */
  flowLayout: () => { moved: number; tiers: number; locked: number };
  /** LT-177: radial, force-directed or orthogonal — on the selection when
   *  two or more devices are selected, otherwise the page. One undo step. */
  autoLayout: (kind: 'radial' | 'force' | 'orthogonal') => { moved: number; scope: 'selection' | 'page'; locked: number; tooMany?: number };
  routeLinks: () => number;
  addLayer: (name: string) => void;
  removeLayer: (id: string) => void;
  setLayer: (id: string, patch: Partial<Layer>) => void;
  /** LT-184: adds Physical, Logical, Overlay and Annotations where missing. */
  addStandardLayers: () => number;
  /** Releases every link somebody pinned, so they all follow again. */
  unpinLinks: () => number;
  /** Lines a selection up on one edge, or evens the gaps between them. */
  copySelection: () => number;
  paste: () => number;
  /** LT-186: pastes at the coordinates the objects were copied from — onto
   *  whichever page is open, so a copy can land in the same place on another. */
  pasteInPlace: () => number;
  /** Whether there is anything to paste. */
  canPaste: () => boolean;
  selectAll: () => void;
  selectNone: () => void;
  beginEditing: (id: string | null) => void;
  setCanvasHighlight: (ids: Set<string> | null) => void;
  requestFit: () => void;
  /** Presentation mode (LT-193): the chrome hidden, the diagram alone. A way
   *  of looking, not part of the project, so never saved. */
  presenting: boolean;
  setPresenting: (on: boolean) => void;
  /** LT-300: the address register has a screen of its own, reached from the
   *  toolbar. The diagram stays mounted behind it — leaving comes back to the
   *  same selection and the same viewport. */
  registerOpen: boolean;
  setRegisterOpen: (on: boolean) => void;
  /** LT-303: the user guide, on a screen of its own. */
  helpOpen: boolean;
  setHelpOpen: (on: boolean) => void;
  /** LT-320: the interactive SSH sessions this window has open, one per tab
   *  in the panel's SSH section. Window state, never the document: a live
   *  connection cannot be saved, and a `.coreview` file must not carry a
   *  hostname and a username it was never asked to keep. */
  sshSessions: SshTab[];
  sshActive: string | null;
  /** LT-453: the canvas is zoomed far enough out that a device draws as a
   *  glyph and a name only — the level of detail the benchmark measures.
   *  **Off unless the page was opened with `?lod=on`**: the measurement
   *  LT-188's protocol demands was stopped by the machine for memory before
   *  it finished, so nothing is claimed for it and nothing ships on by
   *  default until it has been measured (D-031). */
  farZoom: boolean;
  lodEnabled: boolean;
  setFarZoom: (far: boolean) => void;
  /** LT-444: the drawer beside the canvas — a device or a finding — and
   *  whether it is pinned. Window state, never the document. */
  drawer: DrawerContent | null;
  drawerPinned: boolean;
  openDrawer: (content: DrawerContent) => void;
  closeDrawer: () => void;
  setDrawerPinned: (on: boolean) => void;
  /** LT-432: every job running or stopping right now, as `jobs.rs` reports
   *  them on `coreview://job`. Window state: a job belongs to the process,
   *  not to the document, and the list is rebuilt from `job_list` on load. */
  jobs: JobSnapshot[];
  setJobs: (jobs: JobSnapshot[]) => void;
  applyJobEvent: (snapshot: JobSnapshot) => void;
  openSshTab: (tab: SshTab) => void;
  setSshActive: (id: string | null) => void;
  /** The session ended — at the device's end or ours. The tab stays, with
   *  what it said, until it is closed by hand: a shell that vanishes the
   *  moment it drops takes the error message with it. */
  /** LT-503: an ended session's tab takes its new session's id. */
  reopenSshTab: (oldId: string, newId: string) => void;
  endSshTab: (id: string, reason: string) => void;
  /** Takes the tab away. The backend is told separately. */
  forgetSshTab: (id: string) => void;
  /** LT-335: drops references to credentials the vault no longer holds.
   *  Returns how many went, so the caller can say so. */
  pruneStaleCredentials: (inVault: { id: string }[]) => number;
  /** LT-324: the transcript started, moved or stopped. */
  setSshLog: (id: string, path: string | null) => void;
  /** LT-325: a keepalive went out and the connection took it. */
  noteSshAlive: (id: string, at: number) => void;
  /** LT-319: Compare, Racks and the two imports, on a screen of their own.
   *  None of them reports on the live diagram, and all four want height the
   *  bottom panel does not have. A way of looking, so never saved. */
  toolsOpen: boolean;
  toolsView: 'compare' | 'racks' | 'csv' | 'visio' | 'lifecycle' | 'settings';
  setToolsOpen: (on: boolean, view?: 'compare' | 'racks' | 'csv' | 'visio' | 'settings') => void;
  setToolsView: (view: 'compare' | 'racks' | 'csv' | 'visio' | 'lifecycle' | 'settings') => void;
  /** LT-184: true while the canvas is being printed, so views set not to
   *  print are left off the page. Not part of the document. */
  printing: boolean;
  setPrinting: (on: boolean) => void;
  /** LT-230: a bottom-panel tab asked for from elsewhere (the command
   *  palette); the panel opens it and clears the request. */
  panelRequest: string | null;
  /** LT-527: a topology built from a collection run, waiting for the Discover
   *  panel to open it in its review — as it opens SNMP walk files. */
  pendingCrawlResult: { devices: CrawledDevice[]; notVisited: Neighbor[]; label: string; failures?: { address: string; reason: string }[] } | null;
  setPendingCrawlResult: (r: { devices: CrawledDevice[]; notVisited: Neighbor[]; label: string; failures?: { address: string; reason: string }[] } | null) => void;
  /** LT-619: a Discover run on the collector, which outlives the panel. */
  discoverRun: { runId: string; status: string; failures: { address: string; reason: string }[] } | null;
  setDiscoverRun: (r: { runId: string; status: string; failures: { address: string; reason: string }[] } | null) => void;
  /** LT-232, LT-233: what is dimmed. View state, not saved with the project. */
  canvasFilter: CanvasFilter | null;
  setCanvasFilter: (f: CanvasFilter | null) => void;
  /** LT-421: devices whose branch is folded away. A view, never the
   *  document — nothing here is saved with the project. */
  collapsed: string[];
  toggleCollapsed: (id: string) => void;
  expandAll: () => void;
  focus: { ids: string[]; hops: number } | null;
  /** LT-238: the ink tool in hand, if any, and its colour and width. */
  inkTool: { mode: 'pen' | 'eraser'; color: string; width: number } | null;
  setInkTool: (t: { mode: 'pen' | 'eraser'; color: string; width: number } | null) => void;
  addInkStroke: (s: InkStroke) => void;
  /** LT-238: the stroke being drawn, before it is kept. */
  inkDraft: InkStroke | null;
  removeInkStroke: (id: string) => void;
  setFocus: (f: { ids: string[]; hops: number } | null) => void;
  requestPanelTab: (tab: string | null) => void;
  setGridSnap: (on: boolean) => void;
  /** LT-209: the project's credential rules by subnet or vendor. */
  setCredentialRules: (rules: CredentialRule[]) => void;
  /** LT-271: records guided-tour steps as done, or hides the tour. No-ops on
   *  a project with no tour. */
  noteGuide: (...steps: string[]) => void;
  hideGuide: () => void;
  /** Bumped whenever the vault changes — created, unlocked, a credential
   *  saved, replaced or deleted. Every credential chooser on screen watches
   *  it, because each used to keep its own copy of the vault's state and a
   *  second chooser went on believing there was no vault at all (LT-292). */
  vaultRevision: number;
  bumpVault: () => void;
  /** LT-286: this project uses that saved credential from now on. */
  rememberCredential: (kind: 'ssh' | 'snmp', id: string) => void;
  addProjectSsh: (id: string) => void;
  replaceProjectCredential: (kind: 'ssh' | 'snmp', oldId: string, newId: string | undefined) => void;
  forgetCredential: (kind: 'ssh' | 'snmp', id?: string) => void;
  /** LT-212. */
  saveCrawlProfile: (profile: CrawlProfile) => void;
  /** LT-437: the project's intent rules, replaced whole. One undo step. */
  setIntentRules: (rules: IntentRule[]) => void;
  /** LT-439: the project's lifecycle table, replaced whole. One undo step. */
  setLifecycle: (rows: LifecycleRow[]) => void;
  /** LT-216: the accepted changes of a crawl review, as one undo step.
   *  Returns the devices it added. */
  applyCrawlChanges: (accepted: Change[]) => TopoNode[];
  /** LT-222. `applyProbeTemplate` adds the check to each device with an
   *  address, as one undo step, and says how many it added and skipped. */
  saveProbeTemplate: (t: ProbeTemplate) => void;
  deleteProbeTemplate: (id: string) => void;
  applyProbeTemplate: (templateId: string, nodeIds: string[]) => { added: number; skipped: string[] };
  deleteCrawlProfile: (id: string) => void;
  /** LT-195–196: racks. Each returns why it could not, or null when done. */
  /** LT-285, LT-288, LT-289: the address register. Each returns why it could
   *  not, or null. A subnet the app derived is *adopted* by declaring it —
   *  `addIpamSubnet` with the CIDR it was derived as. */
  addIpamSubnet: (
    cidr: string,
    patch?: {
      name?: string; vlan?: number; note?: string; vrfId?: string; containerId?: string;
      siteId?: string; tenantId?: string; custom?: Record<string, string>;
    },
  ) => string | null;
  updateIpamSubnet: (
    id: string,
    patch: {
      cidr?: string; name?: string; vlan?: number; note?: string; vrfId?: string; containerId?: string;
      siteId?: string; tenantId?: string; custom?: Record<string, string>;
    },
  ) => string | null;
  removeIpamSubnet: (id: string) => void;
  addIpamEntry: (entry: Omit<IpamEntry, 'id'>) => string | null;
  updateIpamEntry: (id: string, patch: Partial<Omit<IpamEntry, 'id'>>) => string | null;
  removeIpamEntry: (id: string) => void;
  /** LT-298: a filter worth keeping, by name. */
  saveIpamView: (name: string, query: string) => string | null;
  removeIpamView: (id: string) => void;
  /** LT-298: one edit applied to many entries, as one undo step. */
  applyIpamBulk: (changes: readonly { entryId: string; patch: Partial<Omit<IpamEntry, 'id'>> }[], what: string) => number;
  /** LT-294: a DHCP pool or an excluded span. */
  addIpamRange: (range: Omit<IpamRange, 'id'>) => string | null;
  updateIpamRange: (id: string, patch: Partial<Omit<IpamRange, 'id'>>) => string | null;
  removeIpamRange: (id: string) => void;
  /** LT-297: the hierarchy and the routing tables. */
  addIpamContainer: (container: Omit<IpamContainer, 'id'>) => string | null;
  updateIpamContainer: (id: string, patch: Partial<Omit<IpamContainer, 'id'>>) => string | null;
  removeIpamContainer: (id: string) => void;
  addIpamVrf: (vrf: Omit<IpamVrf, 'id'>) => string | null;
  updateIpamVrf: (id: string, patch: Partial<Omit<IpamVrf, 'id'>>) => string | null;
  removeIpamVrf: (id: string) => string | null;
  /** LT-298: a site or a tenant — the same shape, kept as two lists. `id`
   *  null adds one. Returns why it could not be saved, or null. */
  saveIpamPlace: (kind: 'site' | 'tenant', id: string | null, place: { name: string; note?: string }) => string | null;
  /** Removes it, and every subnet and address naming it is left with none. */
  removeIpamPlace: (kind: 'site' | 'tenant', id: string) => void;
  /** LT-298: the operator's own fields. `id` null adds one. */
  saveIpamField: (id: string | null, draft: CustomFieldDraft) => string | null;
  /** Removes the field and every value anybody put in it. */
  removeIpamField: (id: string) => void;
  /** LT-297: one subnet becomes several, or several become one. Both take the
   *  plan they were shown, so what is committed is what was reviewed. */
  splitIpamSubnet: (cidr: string, vrfId: string, into: number) => string | null;
  mergeIpamSubnets: (cidrs: [string, string], vrfId: string, into: string) => string | null;
  /** LT-295: edit a device's own address from the register, on whichever page
   *  the device is drawn. Writes through to the device; one undo step. */
  editDeviceAddress: (
    nodeId: string,
    addressId: string | undefined,
    patch: { label?: string; address?: string; interfaceLabel?: string; mac?: string; hostname?: string },
  ) => string | null;
  addRack: (name: string, units: number) => string | null;
  updateRack: (id: string, patch: Partial<Omit<Rack, 'id' | 'items'>>) => string | null;
  removeRack: (id: string) => void;
  placeInRack: (nodeId: string, rackId: string, u: number, face?: RackFace) => string | null;
  takeOutOfRack: (nodeId: string) => void;
  setRackDetails: (nodeId: string, patch: { rackFace?: RackFace; rackDepth?: 'full' | 'half'; airflow?: Airflow; powerW?: number; weightKg?: number; rackColour?: string; depthMm?: number }) => string | null;
  /** LT-682, LT-686: furniture on a rack. Each returns why it could not, or null. */
  addFurniture: (rackId: string, kind: FurnitureKind, label?: string, units?: number, u?: number, face?: RackFace) => string | null;
  updateFurniture: (rackId: string, itemId: string, patch: Partial<Omit<RackFurniture, 'id' | 'kind'>>) => string | null;
  placeFurniture: (rackId: string, itemId: string, u: number, face?: RackFace) => string | null;
  removeFurniture: (rackId: string, itemId: string) => void;
  /** LT-683: stacks. */
  addStack: (stack: Omit<Stack, 'id'>) => string | null;
  updateStack: (id: string, patch: Partial<Omit<Stack, 'id'>>) => string | null;
  removeStack: (id: string) => void;
  buildRacksFromDevices: () => { racks: number; placed: number; full: string[] };
  restoreRecovery: () => void;
  discardRecovery: () => void;
  arrange: (
    ids: string[],
    how: 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom' | 'across' | 'down',
  ) => number;
  onEdgesChange: (changes: EdgeChange<TopoEdge>[]) => void;
  addNode: (node: TopoNode) => void;
  addEdge: (edge: TopoEdge) => void;
  updateNodeData: (id: string, patch: Partial<DeviceNodeData & NoteNodeData>) => void;
  /** The same change applied to many nodes as one undoable step. Applying it
   *  node by node would leave forty entries in the undo history for one
   *  action, and undoing would then have to be pressed forty times. */
  /** LT-236: one change to several links, as one undo step. */
  updateManyEdgeData: (ids: string[], patch: Partial<LinkData>, label?: string) => void;
  /** LT-239: a device's or link's comments, as one undo step. */
  setComments: (objectId: string, threads: CommentThread[], label: string) => void;
  updateManyNodeData: (
    ids: string[],
    patch: Partial<DeviceNodeData & NoteNodeData>,
    label?: string,
  ) => void;
  /** Rewrites each selected node's data from its own current value, for
   *  changes that are not the same everywhere — adding a tag to nodes that
   *  have different tags already. */
  mapManyNodeData: (
    ids: string[],
    change: (data: DeviceNodeData & NoteNodeData) => Partial<DeviceNodeData & NoteNodeData>,
    label?: string,
  ) => void;
  updateEdgeData: (id: string, patch: Partial<LinkData>) => void;
  /** LT-157: moves one end of a link to another device, as one undoable step.
   *  The moved end forgets what described the old device — its port label, its
   *  hand-placed anchor and where its port label sat. A link to itself, or to
   *  a device that is not on the page, is refused. */
  reconnectEdge: (id: string, which: 'source' | 'target', nodeId: string, anchor?: { x: number; y: number }) => void;
  deleteSelected: () => void;
  select: (nodeId: string | null, edgeId: string | null) => void;

  upsertProbe: (probe: Probe) => void;
  /** Applies one timing policy to every check in the project. */
  setProbeTiming: (intervalSeconds: number, failureThreshold: number) => number;
  removeProbe: (probeId: string) => void;
  probesFor: (objectId: string) => Probe[];
  nodeStatus: (nodeId: string) => HealthStatus;
  linkStatus: (edgeId: string) => HealthStatus;

  commit: (label?: string) => void;
  undo: () => void;
  redo: () => void;

  startValidation: () => Promise<void>;
  stopValidation: () => Promise<void>;
  applyEngineEvent: (payload: unknown) => void;
  testNow: (probe: Probe) => Promise<ProbeResultDto>;
  loadEvents: () => Promise<void>;

  setSettings: (patch: Partial<AppSettings>) => void;
  /** LT-321–325: a terminal preference, remembered on this machine. */
  setTerminalSettings: (patch: Partial<TerminalSettings>) => void;
  loadSettings: () => Promise<void>;
  chooseFolder: (which: 'backupFolder' | 'exportFolder') => Promise<string | null>;
  clearFolder: (which: 'backupFolder' | 'exportFolder') => Promise<void>;
  loadIconLibrary: (dir: string) => Promise<void>;
  ensureNodeCheck: (id: string) => void;
  clearIconLibrary: () => Promise<void>;
  /** Permanent — restored only by reinstalling the app (LT-103). Refreshes
   *  the bundled shape list afterward, so the palette drops that pack's
   *  shapes without needing a restart. */
  /** Hides the pack and deletes its files where it can. Permanent either way;
   *  see the status message for whether the space came back. */
  removeStencilPack: (name: string) => Promise<void>;
  /** Captures a device already on the canvas as a new shape in this
   *  project's own library (LT-104), so it can be dragged onto the canvas
   *  again — customisation and all — without repeating it. */
  saveCustomShape: (nodeId: string, name: string) => void;
  /** Only from this project's own library — undoable, unlike removing a
   *  stencil pack, since nothing was deleted from disk. */
  removeCustomShape: (id: string) => void;
  setCanvas: (patch: Partial<ProjectPage['canvas']>) => void;
  /** How links on this diagram are drawn by default — every page, since a
   *  diagram whose pages disagree about it is nobody's intent. */
  setDefaultLinkStyle: (style: LinkStyleDefaults) => void;
  setPanelOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setInspectorOpen: (open: boolean) => void;
  setStatusMessage: (msg: string | null) => void;
}

/** LT-224: how many results the live sparkline shows. */
const RECENT_SAMPLES = 120;

export const emptyDocument = (): ProjectDocument => {
  const id = uid();
  const page = newPage('Page 1', id);
  // LT-184: a new project starts with the usual views, all empty.
  page.canvas = { ...page.canvas, layers: standardLayers(uid) };
  return {
    pages: [page],
    activePageId: id,
    probes: [],
  };
};

/** LT-185: at least two hundred steps, and they outlive closing the app. */
export const HISTORY_LIMIT = 200;

/** The most devices a force-directed layout is run on at once (LT-177). */
export const FORCE_LAYOUT_LIMIT = 1500;

/**
 * Per-machine view preferences: which panels are open.
 *
 * localStorage is the right home for these — unlike the icon library folder,
 * which the backend also reads and so belongs in the database. Nothing outside
 * this file reads them, they are meaningless on another machine, and losing
 * them costs a click.
 */
function viewPref(key: string, fallback = true): boolean {
  try {
    const v = localStorage.getItem(`coreview.view.${key}`);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

/** LT-298: the register's hidden columns, remembered for this machine. */
function readHiddenColumns(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem('coreview.view.registerHiddenColumns') ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The remembered clock, defaulting to the DTG this was built around. */
function readTimeFormat(): TimeFormat {
  try {
    const v = localStorage.getItem('coreview.view.timeFormat');
    const allowed: TimeFormat[] = ['dtg-zulu', 'dtg-local', 'local-24', 'local-12'];
    return allowed.includes(v as TimeFormat) ? (v as TimeFormat) : 'dtg-zulu';
  } catch {
    return 'dtg-zulu';
  }
}

function rememberView(key: string, open: boolean): void {
  try {
    localStorage.setItem(`coreview.view.${key}`, open ? '1' : '0');
  } catch {
    /* private mode, or storage disabled — the panel just reopens next time */
  }
}

/** The group a node belongs to, if any. */
function groupOf(node: TopoNode | undefined): string | undefined {
  return (node?.data as { groupId?: string } | undefined)?.groupId;
}

/**
 * Applies React Flow's changes, then carries the rest of a group along.
 *
 * A group is drawn as nothing at all — it is a device and the notes that
 * explain it staying together, not a box around them. So the only place it
 * exists is here: when one member is dragged, its companions move by the same
 * delta.
 *
 * Members React Flow already moved are skipped. Dragging a multi-selection
 * emits a position change per node, and moving those again would send anything
 * both selected and grouped twice as far.
 */
export function moveGroups(changes: NodeChange<TopoNode>[], before: TopoNode[]): TopoNode[] {
  const after = applyNodeChanges(changes, before) as TopoNode[];

  const deltas = new Map<string, { dx: number; dy: number }>();
  const movedItself = new Set<string>();
  for (const c of changes) {
    if (c.type !== 'position' || !c.position) continue;
    movedItself.add(c.id);
    const was = before.find((n) => n.id === c.id);
    const groupId = groupOf(was);
    if (!was || !groupId || deltas.has(groupId)) continue;
    deltas.set(groupId, {
      dx: c.position.x - was.position.x,
      dy: c.position.y - was.position.y,
    });
  }
  // A section carries whatever is standing in it. Membership is geometric and
  // recomputed, so nothing has to be re-assigned when a device is dragged into
  // one — and a device dragged out is simply out.
  const dragged: { id: string; dx: number; dy: number }[] = [];
  for (const c of changes) {
    if (c.type !== 'position' || !c.position) continue;
    const was = before.find((n) => n.id === c.id);
    if (!was) continue;
    dragged.push({
      id: c.id,
      dx: c.position.x - was.position.x,
      dy: c.position.y - was.position.y,
    });
  }
  const fromZones = zoneDeltas(dragged, before);

  if (deltas.size === 0 && fromZones.size === 0) return after;

  return after.map((n) => {
    if (movedItself.has(n.id)) return n;
    const groupId = groupOf(n);
    const d = (groupId ? deltas.get(groupId) : undefined) ?? fromZones.get(n.id);
    // A locked companion stays put, the same as it would under its own drag.
    if (!d || (n.data as { locked?: boolean }).locked) return n;
    return { ...n, position: { x: n.position.x + d.dx, y: n.position.y + d.dy } };
  });
}

/** What was copied, kept for the session rather than per project, so a chunk
 *  of one diagram can be pasted into another. */
let clipboard: Clipping | null = null;
/** LT-186: the copy as it was taken, which pasting never moves on — paste in
 *  place always puts it back where it came from, however many pastes since. */
let copiedAt: Clipping | null = null;

/** Every device on every page, as a rack sees it (LT-195). */
function rackables(doc: ProjectDocument): Rackable[] {
  return allNodes(doc)
    .filter((n) => n.type === 'device')
    .map((n) => rackableOf(n.id, n.data as DeviceNodeData));
}

const sameRack = (a: string | undefined, b: string) => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

function rackNameProblem(racks: readonly Rack[], name: string): string | null {
  if (!name) return 'A rack needs a name.';
  if (racks.some((r) => sameRack(r.name, name))) return `There is already a rack called ${name}.`;
  return null;
}

function rackUnitsProblem(units: number): string | null {
  return Number.isInteger(units) && units >= 1 && units <= MAX_RACK_UNITS ? null : `A rack is 1 to ${MAX_RACK_UNITS}U.`;
}

/** Patches devices' data wherever they are drawn, by id. Pages with none of
 *  them keep their objects. */
function patchDevices(doc: ProjectDocument, patches: ReadonlyMap<string, Partial<DeviceNodeData>>): ProjectDocument {
  if (patches.size === 0) return doc;
  return {
    ...doc,
    pages: doc.pages.map((p) =>
      p.nodes.some((n) => patches.has(n.id))
        ? {
            ...p,
            nodes: p.nodes.map((n) => {
              const patch = patches.get(n.id);
              if (!patch || n.type !== 'device') return n;
              const data = { ...n.data, ...patch } as Record<string, unknown>;
              // An undefined in a patch means "remove", not "store undefined".
              for (const k of Object.keys(patch)) if (data[k] === undefined) delete data[k];
              return { ...n, data } as TopoNode;
            }),
          }
        : p,
    ),
  };
}

/** Adds a paste to the open page, selected and with nothing else selected, so
 *  it can be dragged into place straight away. */
function placePaste(set: (fn: (s: Store) => Partial<Store>) => void, fresh: Clipping): void {
  set((state) => ({
    doc: withPage(state.doc, {
      nodes: [
        ...activePage(state.doc).nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
        ...fresh.nodes,
      ],
      edges: [...activePage(state.doc).edges, ...fresh.edges],
    }),
    dirty: true,
    selectedNodeId: fresh.nodes.length === 1 ? fresh.nodes[0]!.id : null,
    selectedEdgeId: null,
  }));
}

/**
 * Crash recovery.
 *
 * Edits are already saved for real 2.5 seconds after they stop, so the slot
 * here covers only the window that save can miss: the app dying mid-edit, or
 * the machine going down before the debounce fires. Written every minute and
 * on the way out, offered back only when it is newer than the last real save
 * — an old slot is stale, not a recovery.
 */
const recoveryKey = (id: string) => `coreview.recovery.${id}`;
let recoveryTimer: ReturnType<typeof setInterval> | null = null;
let recoveryUnload: (() => void) | null = null;

function writeRecovery(get: () => Store): void {
  const { meta, doc, dirty } = get();
  if (!meta || !dirty) return;
  try {
    localStorage.setItem(
      recoveryKey(meta.id),
      JSON.stringify({ savedAt: Date.now(), document: doc }),
    );
  } catch {
    /* storage full or blocked — the debounced real save still runs */
  }
}

function clearRecovery(id: string): void {
  try {
    localStorage.removeItem(recoveryKey(id));
  } catch {
    /* nothing to clear */
  }
}

function readRecovery(id: string): { savedAt: number; document: ProjectDocument } | null {
  try {
    const raw = localStorage.getItem(recoveryKey(id));
    if (!raw) return null;
    const slot = JSON.parse(raw) as { savedAt?: number; document?: ProjectDocument };
    // A slot written before LT-094 has no `pages` — pre-migration shape, and
    // restoreRecovery merges this straight onto emptyDocument() without
    // running migrateDocument. Discarding it here is the same "old slot is
    // stale" rule this function already applies to time, applied to shape.
    if (typeof slot.savedAt !== 'number' || !slot.document?.pages) return null;
    return { savedAt: slot.savedAt, document: slot.document };
  } catch {
    return null;
  }
}

/**
 * One undo step (LT-185): the document's parts as they are, shared rather than
 * copied.
 *
 * Every change to the document already replaces what it changes and keeps the
 * rest, so an entry can hold the same objects the document does and two hundred
 * steps cost little more than one diagram — a deep copy per step made two
 * hundred steps of a large diagram hundreds of megabytes. The price is that
 * nothing may edit a document object in place; in development every entry is
 * frozen, so anything that tries fails loudly in the harnesses instead of
 * quietly rewriting history.
 */
/** Drops fields that are undefined or blank, so clearing a name in a form
 *  leaves the record without one rather than carrying an empty string that
 *  then renders as a named-nothing row (LT-288). */
/** The same, minus the fields a record always writes explicitly. */
/** LT-298: a register record as its history should describe it — a site by
 *  name, a linked device by what the diagram calls it, each custom field
 *  under its own name — rather than as ids nobody can read. */
function readable(record: object, doc: ProjectDocument): Record<string, unknown> {
  const nodes = allNodes(doc);
  return auditView(record as Record<string, unknown>, doc.ipam, (id) => {
    const label = (nodes.find((n) => n.id === id)?.data as { label?: string } | undefined)?.label;
    return label?.trim() || undefined;
  });
}

function extras<T extends Record<string, unknown>>(from: T, ...drop: (keyof T)[]): Partial<T> {
  const rest = { ...from };
  for (const k of drop) delete rest[k];
  return clean(rest);
}

function clean<T extends Record<string, unknown>>(patch: T | undefined): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out as Partial<T>;
}

function snapshot(doc: ProjectDocument): HistoryEntry {
  const entry: HistoryEntry = {
    pages: doc.pages,
    activePageId: doc.activePageId,
    probes: doc.probes,
    customShapes: doc.customShapes,
    ipam: doc.ipam,
    racks: doc.racks,
    stacks: doc.stacks,
  };
  if (import.meta.env.DEV) deepFreeze(entry);
  return entry;
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const v of Object.values(value)) deepFreeze(v, seen);
}


/** Hierarchy edges for devices that name the switch they hang off (LT-145).
 *
 * `switchPort` is written as `LAB-CORE-SW1 Gi1/0/11` by a crawl that read the
 * switch's MAC table, so the switch name is everything before the last space.
 * A name matching nothing on the page yields nothing rather than a guess.
 */
function hangsOffLinks(
  devices: TopoNode[],
): { source: string; target: string; direction: 'reverse' }[] {
  // By label *and* by hostname: the label is whatever is drawn — often an
  // address, because that is what a sweep had to go on — while `switchPort`
  // names the device by the hostname the crawl learned.
  const byName = new Map<string, string>();
  for (const n of devices) {
    const d = n.data as DeviceNodeData;
    for (const name of [d.label, d.hostname]) {
      const key = name?.trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, n.id);
    }
  }
  const out: { source: string; target: string; direction: 'reverse' }[] = [];
  for (const n of devices) {
    const where = (n.data as DeviceNodeData).switchPort?.trim();
    if (!where) continue;
    const cut = where.lastIndexOf(' ');
    const switchName = (cut > 0 ? where.slice(0, cut) : where).toLowerCase();
    const switchId = byName.get(switchName);
    if (!switchId || switchId === n.id) continue;
    // `reverse` means the source end is the way out, and the switch is.
    out.push({ source: switchId, target: n.id, direction: 'reverse' });
  }
  return out;
}

export const useStore = create<Store>((set, get) => ({
  projects: [],
  folderTree: EMPTY_TREE,
  projectFolderId: null,
  setProjectFolder: (id) => set({ projectFolderId: id }),
  meta: null,
  vaultRevision: 0,
  registerOpen: false,
  helpOpen: false,
  toolsOpen: false,
  toolsView: 'compare',
  sshSessions: [],
  sshActive: null,
  jobs: [],
  drawer: null,
  drawerPinned: false,
  farZoom: false,
  lodEnabled: typeof location !== 'undefined' && new URLSearchParams(location.search).get('lod') === 'on',
  doc: emptyDocument(),
  dirty: false,
  lastSavedAt: null,
  savedAck: null,
  selectedNodeId: null,
  editingNodeId: null,
  canvasHighlight: null,
  fitRequest: 0,
  recovery: null,
  selectedEdgeId: null,
  iconLibrary: [],
  iconLibraryDir: null,
  iconLibraryError: null,
  bundledIcons: [],
  stencilPacks: [],
  settings: {
    reduceMotion:
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    // LT-242: the system's own "more contrast" setting until one is chosen here.
    highContrast: viewPref('highContrast', (() => {
      try {
        return window.matchMedia?.('(prefers-contrast: more)').matches ?? false;
      } catch {
        return false;
      }
    })()),
    uiScale: (() => {
      try {
        const v = Number(localStorage.getItem('coreview.view.uiScale'));
        return v >= 0.85 && v <= 1.4 ? v : 1;
      } catch {
        return 1;
      }
    })(),
    dockSide: (() => {
      try {
        return localStorage.getItem('coreview.view.dockSide') === 'right' ? 'right' : 'bottom';
      } catch {
        return 'bottom';
      }
    })(),
    minimap: viewPref('minimap'),
    timeFormat: readTimeFormat(),
    registerHiddenColumns: readHiddenColumns(),
    paper: 'fit',
    orientation: 'landscape',
    ground: 'dark',
    backupFolder: null,
    exportFolder: null,
    terminal: TERMINAL_DEFAULTS,
  },
  panelOpen: viewPref('panelOpen'),
  dockTab: 'objects',
  inspectorTab: 'status',
  backupHandover: null,
  discoverAdvanced: false,
  pathQuestion: { to: '', app: '', protocol: 'tcp', port: '', vrf: '' },
  whereIsRequest: null,
  commandPaletteRequest: false,
  // Which panels are open is a view preference for this machine, not part of
  // the project, so it lives in localStorage rather than the document (which
  // would mark it dirty and travel in an export) or the settings table.
  paletteOpen: viewPref('paletteOpen'),
  inspectorOpen: viewPref('inspectorOpen'),
  session: { id: null, state: 'stopped', startedAt: null },
  runtime: new Map(),
  recentSamples: new Map(),
  events: [],
  statusMessage: null,
  presenting: false,
  printing: false,
  panelRequest: null,
  pendingCrawlResult: null,
  discoverRun: null,
  canvasFilter: null,
  collapsed: [],
  focus: null,
  inkTool: null,
  inkDraft: null,
  past: [],
  future: [],

  async refreshProjects() {
    const [projects, folderTree] = await Promise.all([
      ipc.listProjects(),
      // A tree that cannot be read leaves every project at the top rather
      // than hiding the list.
      ipc.listProjectFolders().catch(() => EMPTY_TREE),
    ]);
    // An open folder that is gone falls back to the top.
    const open = get().projectFolderId;
    const still = open === null || folderTree.folders.some((f) => f.id === open);
    set({ projects, folderTree, ...(still ? {} : { projectFolderId: null }) });
  },

  async createProject(partial, doc) {
    const now = Date.now();
    const meta: ProjectMeta = {
      id: uid(),
      name: partial.name?.trim() || 'Untitled project',
      customer: partial.customer ?? '',
      site: partial.site ?? '',
      ticket: partial.ticket ?? '',
      engineer: partial.engineer ?? '',
      description: partial.description ?? '',
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    const document = doc ?? emptyDocument();
    // Re-key probes so a seeded sample never shares ids with another project.
    document.probes = document.probes.map((p) => ({ ...p, projectId: meta.id }));
    await ipc.saveProject({ meta, documentVersion: 1, document });
    // LT-485: made inside a folder, it lives in that folder.
    const folder = get().projectFolderId;
    if (folder) await ipc.moveProjectToFolder(meta.id, folder).catch(() => undefined);
    set({ meta, doc: document, dirty: false, lastSavedAt: now, savedAck: null, past: [], future: [] });
    // LT-494: a project made here is open, exactly as one opened from the
    // list is — told to the layer that scopes settings and backups, and its
    // (empty) settings read, so a folder chosen in it is kept.
    await setCurrentProject(meta.id);
    await get().loadSettings();
    await get().refreshProjects();
  },

  async openProject(id) {
    await get().closeProject();
    const pkg = await ipc.loadProject(id);
    if (!pkg) {
      set({ statusMessage: 'That project could not be found in local storage.' });
      return;
    }
    // LT-413/LT-414: from here on, settings and backups are this project's.
    // Set before anything reads them, and cleared by `closeProject`.
    await setCurrentProject(id);
    // And read again, because the first read happened on the project list
    // where there was no project — so it saw this computer's preferences and
    // none of this project's.
    await get().loadSettings();
    // Wraps a pre-LT-094 document into a single page, then (LT-065) brings an
    // old document's device glyphs onto square bounds so the selection ring
    // and corners hug them. Marks the doc dirty only when it actually
    // changed something, so opening a current project is read-only.
    const { doc, changed } = migrateDocument(pkg.document);
    set({
      meta: pkg.meta,
      doc,
      dirty: changed > 0,
      lastSavedAt: pkg.meta.updatedAt,
      savedAck: null,
      past: [],
      future: [],
      runtime: new Map(),
      recentSamples: new Map(),
      events: [],
      selectedNodeId: null,
      selectedEdgeId: null,
    });
    // LT-185: the undo history of the save being opened, if it is still that
    // save. A document that had to be migrated is not the one its history was
    // taken from, so it starts fresh.
    if (changed === 0) {
      const kept = await loadHistory(pkg.meta.id, pkg.meta.updatedAt);
      if (kept && get().meta?.id === pkg.meta.id && get().meta?.updatedAt === pkg.meta.updatedAt) {
        set({ past: kept.past.slice(-HISTORY_LIMIT), future: kept.future.slice(0, HISTORY_LIMIT) });
      }
    }
    await get().loadEvents();

    // Anything left behind by a session that ended badly. Only offered when
    // it is newer than the last real save; an older slot is stale.
    const slot = readRecovery(pkg.meta.id);
    set({ recovery: slot && slot.savedAt > pkg.meta.updatedAt ? { savedAt: slot.savedAt } : null });
    if (slot && slot.savedAt <= pkg.meta.updatedAt) clearRecovery(pkg.meta.id);

    if (recoveryTimer) clearInterval(recoveryTimer);
    // Not under automation: the Playwright harness suffers occasional
    // environmental page reloads mid-run, and the writer then arms a
    // perfectly correct recovery banner whose 34px shifts every screen
    // measurement taken after it. The harness tests recovery by planting
    // slots directly, so it loses no coverage; real sessions are unaffected.
    if (!navigator.webdriver) {
      recoveryTimer = setInterval(() => writeRecovery(get), 60_000);
      const onUnload = () => writeRecovery(get);
      window.addEventListener('beforeunload', onUnload);
      recoveryUnload = () => window.removeEventListener('beforeunload', onUnload);
    }
  },

  restoreRecovery() {
    const { meta } = get();
    if (!meta) return;
    const slot = readRecovery(meta.id);
    if (!slot) {
      set({ recovery: null });
      return;
    }
    // The restored state is an edit on top of what was loaded, so undo can
    // take it back and the debounced save will make it real.
    get().commit('Restore unsaved work');
    set({
      doc: { ...emptyDocument(), ...slot.document },
      dirty: true,
      recovery: null,
      selectedNodeId: null,
      selectedEdgeId: null,
    });
    clearRecovery(meta.id);
  },

  discardRecovery() {
    const { meta } = get();
    if (meta) clearRecovery(meta.id);
    set({ recovery: null });
  },

  async closeProject() {
    // Closing always stops probing first (test cases 14, 15). Since LT-491
    // this cannot throw: a stop that met an error is still a stop.
    if (get().session.state !== 'stopped') await get().stopValidation();
    // LT-491: unsaved work is saved before anything is let go. A save that
    // fails keeps the project open and says why — closing would lose it —
    // where before it threw half-way and the screen simply stayed put.
    if (get().meta && get().dirty) {
      try {
        await get().saveProject();
      } catch (err) {
        set({ statusMessage: `Not closed: this project's changes could not be saved (${err instanceof Error ? err.message : String(err)}). Fix that, or export the project, then close it again.` });
        return;
      }
    }
    // Nothing that follows may read another project's settings or backups —
    // and what this one chose is dropped rather than left in the form for the
    // next project to inherit, which is the whole of LT-414.
    await setCurrentProject(null).catch(() => undefined);
    set((s) => ({ settings: { ...s.settings, backupFolder: null, exportFolder: null } }));
    if (recoveryTimer) {
      clearInterval(recoveryTimer);
      recoveryTimer = null;
    }
    recoveryUnload?.();
    recoveryUnload = null;
    // LT-320: and every shell. Leaving a project must not leave a login open
    // on somebody's core switch.
    if (get().sshSessions.length) await ipc.sshCloseAll().catch(() => 0);
    set({
      meta: null,
      doc: emptyDocument(),
      dirty: false,
      runtime: new Map(),
      recentSamples: new Map(),
      events: [],
      past: [],
      future: [],
      selectedNodeId: null,
      selectedEdgeId: null,
      sshSessions: [],
      sshActive: null,
    });
  },

  async saveProject(opts) {
    const { meta, doc } = get();
    if (!meta) return;
    const updated = { ...meta, updatedAt: Date.now() };
    await ipc.saveProject({ meta: updated, documentVersion: 1, document: doc });
    // The save is real, so the crash slot for it is stale.
    clearRecovery(meta.id);
    // LT-679: what the project card says about it, as of now, on this machine.
    rememberSummary(meta.id, summarise(doc, get().nodeStatus, updated.updatedAt));
    // LT-380: an explicit save says so; autosave stays quiet, because a
    // flash on its own schedule would answer no press in particular.
    set({
      meta: updated,
      dirty: false,
      lastSavedAt: updated.updatedAt,
      savedAck: opts?.auto ? get().savedAck : updated.updatedAt,
    });
    // LT-185: this save's undo history, kept on this machine only.
    void saveHistory(meta.id, updated.updatedAt, get().past, get().future);
    await get().refreshProjects();
  },

  async duplicateProject(id) {
    const pkg = await ipc.loadProject(id);
    if (!pkg) return;
    const now = Date.now();
    const meta: ProjectMeta = {
      ...pkg.meta,
      id: uid(),
      name: `${pkg.meta.name} (copy)`,
      createdAt: now,
      updatedAt: now,
    };
    const doc = pkg.document as ProjectDocument;
    // Deep copy so edits to the duplicate cannot touch the original.
    const copy: ProjectDocument = JSON.parse(JSON.stringify(doc));
    copy.probes = copy.probes.map((p) => ({ ...p, projectId: meta.id }));
    await ipc.saveProject({ meta, documentVersion: 1, document: copy });
    // LT-485: a copy sits beside its original.
    const folder = get().folderTree.placement[id];
    if (folder) await ipc.moveProjectToFolder(meta.id, folder).catch(() => undefined);
    await get().refreshProjects();
  },

  async deleteProject(id) {
    forgetSummary(id);
    if (get().meta?.id === id) await get().closeProject();
    await ipc.deleteProject(id);
    await deleteHistory(id);
    await get().refreshProjects();
  },

  updateMeta(patch) {
    const meta = get().meta;
    if (!meta) return;
    set({ meta: { ...meta, ...patch }, dirty: true });
  },

  addPage(name) {
    get().commit('Add a page');
    set((s) => ({ doc: withNewPage(s.doc, name, uid()), dirty: true }));
  },

  addGeneratedPage(name, content) {
    const id = uid();
    // An undo step, like adding a page by hand: generating one is something
    // somebody did and may want to take back.
    get().commit('Add an application path page');
    set((s) => ({ doc: withNewPage(s.doc, name, id, content), dirty: true }));
    return id;
  },

  removePage(id) {
    get().commit('Remove a page');
    set((s) => ({ doc: withoutPage(s.doc, id), dirty: true }));
  },

  renamePage(id, name) {
    set((s) => ({ doc: renamePageIn(s.doc, id, name), dirty: true }));
  },

  duplicatePage(id) {
    get().commit('Duplicate a page');
    set((s) => ({ doc: duplicatePageIn(s.doc, id, uid), dirty: true }));
  },

  reorderPages(fromIndex, toIndex) {
    set((s) => ({ doc: reorderPagesIn(s.doc, fromIndex, toIndex), dirty: true }));
  },

  setInkTool(t) {
    set({ inkTool: t });
  },

  addInkStroke(stroke) {
    get().commit('Draw');
    set((s) => {
      const page = activePage(s.doc);
      return { doc: withPage(s.doc, { canvas: { ...page.canvas, ink: [...(page.canvas.ink ?? []), stroke] } }), dirty: true };
    });
  },

  removeInkStroke(id) {
    const page = activePage(get().doc);
    if (!(page.canvas.ink ?? []).some((x) => x.id === id)) return;
    get().commit('Erase');
    set((s) => {
      const p = activePage(s.doc);
      return { doc: withPage(s.doc, { canvas: { ...p.canvas, ink: (p.canvas.ink ?? []).filter((x) => x.id !== id) } }), dirty: true };
    });
  },

  toggleCollapsed(id) {
    set((s) => ({
      collapsed: s.collapsed.includes(id) ? s.collapsed.filter((x) => x !== id) : [...s.collapsed, id],
    }));
  },

  expandAll() {
    set({ collapsed: [] });
  },

  setCanvasFilter(f) {
    set({ canvasFilter: f });
  },

  setFocus(f) {
    set({ focus: f });
  },

  setPendingCrawlResult(r) {
    set({ pendingCrawlResult: r });
  },
  setDiscoverRun(r) {
    set({ discoverRun: r });
  },
  requestPanelTab(tab) {
    set({ panelRequest: tab, ...(tab ? { panelOpen: true } : {}) });
  },

  setInspectorTab(tab) {
    set({ inspectorTab: tab });
  },
  requestBackup(targets) {
    set({ backupHandover: targets });
    if (targets) get().requestPanelTab('backup');
  },
  setPathQuestion(patch) {
    set((s) => ({ pathQuestion: { ...s.pathQuestion, ...patch } }));
  },
  setDiscoverAdvanced(open) {
    set({ discoverAdvanced: open });
  },
  requestWhereIs(query) {
    set({ whereIsRequest: query });
    if (query !== null) get().requestPanelTab('whereis');
  },
  setDockTab(tab) {
    set({ dockTab: tab });
  },

  requestCommandPalette(on) {
    set({ commandPaletteRequest: on });
  },

  setPrinting(on) {
    set({ printing: on });
  },

  setFarZoom(far) {
    if (get().farZoom !== far) set({ farZoom: far });
  },

  openDrawer(content) {
    set({ drawer: content });
  },

  closeDrawer() {
    set({ drawer: null, drawerPinned: false });
  },

  setDrawerPinned(on) {
    set({ drawerPinned: on });
  },

  setJobs(jobs) {
    set({ jobs: [...jobs].sort((a, b) => a.id - b.id) });
  },

  applyJobEvent(snapshot) {
    set((s) => ({ jobs: applyJob(s.jobs, snapshot) }));
  },

  openSshTab(tab) {
    set((s) => ({
      sshSessions: [...s.sshSessions.filter((t) => t.id !== tab.id), { ...tab, tabKey: tab.tabKey ?? tab.id }],
      sshActive: tab.id,
      panelOpen: true,
    }));
  },

  setSshActive(id) {
    set({ sshActive: id });
  },

  reopenSshTab(oldId, newId) {
    set((s) => ({
      sshSessions: s.sshSessions.map((t) => (t.id === oldId ? { ...t, id: newId, status: 'open' as const, reason: undefined, logPath: null } : t)),
      sshActive: s.sshActive === oldId ? newId : s.sshActive,
    }));
  },

  endSshTab(id, reason) {
    set((s) => ({
      sshSessions: s.sshSessions.map((t) => (t.id === id ? { ...t, status: 'closed' as const, reason } : t)),
    }));
  },

  forgetSshTab(id) {
    set((s) => {
      const left = s.sshSessions.filter((t) => t.id !== id);
      return {
        sshSessions: left,
        sshActive: s.sshActive === id ? (left[left.length - 1]?.id ?? null) : s.sshActive,
      };
    });
  },

  pruneStaleCredentials(inVault) {
    const { doc } = get();
    const stale = staleCredentials(doc, inVault);
    if (stale.length === 0) return 0;
    const cleaned = withoutStaleCredentials(doc, inVault);
    if (!cleaned) return 0;
    // Not an undo step: nothing the operator did caused it, and a credential
    // that is gone from the vault cannot be brought back by undoing a diagram.
    set({ doc: cleaned, dirty: true });
    return stale.length;
  },

  setSshLog(id, path) {
    set((s) => ({ sshSessions: s.sshSessions.map((t) => (t.id === id ? { ...t, logPath: path } : t)) }));
  },

  noteSshAlive(id, at) {
    set((s) => ({ sshSessions: s.sshSessions.map((t) => (t.id === id ? { ...t, lastAlive: at } : t)) }));
  },

  setToolsOpen(on, view) {
    set({ toolsOpen: on, ...(view ? { toolsView: view } : {}), ...(on ? { registerOpen: false, helpOpen: false } : {}) });
  },

  setToolsView(view) {
    set({ toolsView: view });
  },

  setRegisterOpen(on) {
    set({ registerOpen: on, ...(on ? { helpOpen: false, toolsOpen: false } : {}) });
  },

  setHelpOpen(on) {
    set({ helpOpen: on, ...(on ? { registerOpen: false, toolsOpen: false } : {}) });
  },

  setPresenting(on) {
    set({ presenting: on });
  },

  addIpamSubnet(cidr, patch) {
    const problem = subnetProblem(cidr);
    if (problem) return problem;
    const normal = normaliseCidr(cidr)!;
    const had = get().doc.ipam?.subnets ?? [];
    const vrfId = patch?.vrfId ?? DEFAULT_VRF.id;
    if (had.some((x) => normaliseCidr(x.cidr) === normal && (x.vrfId ?? DEFAULT_VRF.id) === vrfId)) {
      return `${normal} is already in the register.`;
    }
    get().commit('Add a subnet');
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          subnets: [...had, { id: uid(), cidr: normal, ...clean(patch) }],
          audit: noteChange(s.doc.ipam, { action: 'added', object: 'subnet', label: normal }),
        },
      },
      dirty: true,
    }));
    return null;
  },

  updateIpamSubnet(id, patch) {
    const had = get().doc.ipam?.subnets ?? [];
    const at = had.find((x) => x.id === id);
    if (!at) return 'That subnet is no longer in the register.';
    let cidr = at.cidr;
    if (patch.cidr !== undefined) {
      const problem = subnetProblem(patch.cidr);
      if (problem) return problem;
      cidr = normaliseCidr(patch.cidr)!;
      if (had.some((x) => x.id !== id && normaliseCidr(x.cidr) === cidr)) return `${cidr} is already in the register.`;
    }
    get().commit('Edit a subnet');
    const after = { id: at.id, cidr, ...clean({ ...at, ...patch, id: undefined, cidr: undefined }) };
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          // `clean` drops an emptied field rather than storing "", so clearing
          // a name leaves the subnet unnamed instead of named nothing.
          subnets: (s.doc.ipam?.subnets ?? []).map((x) => (x.id === id ? after : x)),
          audit: noteChange(s.doc.ipam, {
            action: 'edited', object: 'subnet', label: cidr,
            changes: diffOf(readable(at, s.doc), readable(after, s.doc)),
          }),
        },
      },
      dirty: true,
    }));
    return null;
  },

  removeIpamSubnet(id) {
    const gone = (get().doc.ipam?.subnets ?? []).find((x) => x.id === id);
    if (!gone) return;
    get().commit('Remove a subnet');
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          subnets: (s.doc.ipam?.subnets ?? []).filter((x) => x.id !== id),
          audit: noteChange(s.doc.ipam, { action: 'removed', object: 'subnet', label: gone.cidr }),
        },
      },
      dirty: true,
    }));
  },

  addIpamEntry(entry) {
    if (toValue(entry.address) === null) return 'That is not an IPv4 address.';
    const address = entry.address.trim();
    const had = entriesOf(get().doc.ipam);
    if (had.some((e) => e.address.trim() === address)) return `${address} is already in the register.`;
    get().commit('Add an address');
    const made: IpamEntry = {
      id: uid(), address, label: entry.label.trim(), kind: entry.kind,
      ...extras(entry, 'address', 'label', 'kind'),
    };
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          entries: [...entriesOf(s.doc.ipam), made],
          reservations: undefined,
          audit: noteChange(s.doc.ipam, {
            action: 'added', object: 'address', label: address, changes: diffOf({}, readable(made, s.doc)),
          }),
        },
      },
      dirty: true,
    }));
    return null;
  },

  updateIpamEntry(id, patch) {
    const had = entriesOf(get().doc.ipam);
    const at = had.find((e) => e.id === id);
    if (!at) return 'That address is no longer in the register.';
    const address = patch.address === undefined ? at.address : patch.address.trim();
    if (toValue(address) === null) return 'That is not an IPv4 address.';
    if (had.some((e) => e.id !== id && e.address.trim() === address)) return `${address} is already in the register.`;
    get().commit('Edit an address');
    const next: IpamEntry = {
      id: at.id,
      address,
      label: (patch.label ?? at.label).trim(),
      kind: patch.kind ?? at.kind,
      ...extras({ ...at, ...patch }, 'id', 'address', 'label', 'kind'),
    };
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          entries: entriesOf(s.doc.ipam).map((e) => (e.id === id ? next : e)),
          reservations: undefined,
          audit: noteChange(s.doc.ipam, {
            action: 'edited', object: 'address', label: address,
            changes: diffOf(readable(at, s.doc), readable(next, s.doc)),
          }),
        },
      },
      dirty: true,
    }));
    return null;
  },

  /**
   * LT-298: keeps a filter under a name.
   *
   * A view holds only the query, never the addresses it matched — so it cannot
   * go stale, and reopening it asks the register again rather than showing an
   * answer from last week.
   */
  saveIpamView(name, query) {
    const label = name.trim();
    if (!label) return 'Give the view a name.';
    if (!query.trim()) return 'There is no filter to save.';
    const had = get().doc.ipam?.views ?? [];
    if (had.some((v) => v.name.toLowerCase() === label.toLowerCase())) {
      return `There is already a view called ${label}.`;
    }
    get().commit('Save a view');
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          views: [...(s.doc.ipam?.views ?? []), { id: uid(), name: label, query: query.trim() }],
        },
      },
      dirty: true,
    }));
    return null;
  },

  saveIpamPlace(kind, id, place) {
    const list = kind === 'site' ? 'sites' : 'tenants';
    const had = get().doc.ipam?.[list] ?? [];
    const problem = nameProblem(had, place.name, id ?? undefined);
    if (problem) return problem;
    const name = place.name.trim();
    const note = place.note?.trim() || undefined;
    const before = id ? had.find((x) => x.id === id) : undefined;
    if (id && !before) return `That ${kind} is no longer in the register.`;
    const after = { id: id ?? uid(), name, ...(note ? { note } : {}) };
    get().commit(before ? `Edit a ${kind}` : `Add a ${kind}`);
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          [list]: before
            ? (s.doc.ipam?.[list] ?? []).map((x) => (x.id === id ? after : x))
            : [...(s.doc.ipam?.[list] ?? []), after],
          audit: noteChange(s.doc.ipam, {
            action: before ? 'edited' : 'added', object: kind, label: name,
            changes: diffOf(before ?? {}, after),
          }),
        },
      },
      dirty: true,
    }));
    return null;
  },

  removeIpamPlace(kind, id) {
    const list = kind === 'site' ? 'sites' : 'tenants';
    const gone = (get().doc.ipam?.[list] ?? []).find((x) => x.id === id);
    if (!gone) return;
    get().commit(`Remove a ${kind}`);
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...withoutReference(s.doc.ipam ?? {}, kind, id),
          audit: noteChange(s.doc.ipam, { action: 'removed', object: kind, label: gone.name }),
        },
      },
      dirty: true,
    }));
  },

  saveIpamField(id, draft) {
    const had = get().doc.ipam?.customFields ?? [];
    const problem = customFieldProblem(had, draft, id ?? undefined);
    if (problem) return problem;
    const before = id ? had.find((f) => f.id === id) : undefined;
    if (id && !before) return 'That field is no longer in the register.';
    const choices = draft.type === 'choice'
      ? [...new Set((draft.choices ?? []).map((c) => c.trim()).filter(Boolean))]
      : undefined;
    const after = {
      id: id ?? uid(),
      name: draft.name.trim(),
      type: draft.type,
      ...(choices ? { choices } : {}),
      on: [...new Set(draft.on)],
    };
    get().commit(before ? 'Edit a field' : 'Add a field');
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          customFields: before
            ? (s.doc.ipam?.customFields ?? []).map((f) => (f.id === id ? after : f))
            : [...(s.doc.ipam?.customFields ?? []), after],
          audit: noteChange(s.doc.ipam, {
            action: before ? 'edited' : 'added', object: 'field', label: after.name,
            changes: diffOf(
              before ? { ...before, choices: before.choices?.join(', '), on: before.on.join(', ') } : {},
              { ...after, choices: after.choices?.join(', '), on: after.on.join(', ') },
            ),
          }),
        },
      },
      dirty: true,
    }));
    return null;
  },

  removeIpamField(id) {
    const gone = (get().doc.ipam?.customFields ?? []).find((f) => f.id === id);
    if (!gone) return;
    get().commit('Remove a field');
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...withoutField(s.doc.ipam ?? {}, id),
          audit: noteChange(s.doc.ipam, { action: 'removed', object: 'field', label: gone.name }),
        },
      },
      dirty: true,
    }));
  },

  removeIpamView(id) {
    if (!(get().doc.ipam?.views ?? []).some((v) => v.id === id)) return;
    get().commit('Remove a view');
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: { ...s.doc.ipam, views: (s.doc.ipam?.views ?? []).filter((v) => v.id !== id) },
      },
      dirty: true,
    }));
  },

  /**
   * LT-298: applies one decision to many entries and commits **once**.
   *
   * Calling `updateIpamEntry` in a loop would be correct and unusable: two
   * hundred changes would be two hundred undo steps, so putting it back would
   * mean pressing undo two hundred times. A bulk edit is one decision and
   * undoes as one.
   */
  applyIpamBulk(changes, what) {
    if (changes.length === 0) return 0;
    const had = entriesOf(get().doc.ipam);
    let changed = 0;
    const next = had.map((e) => {
      const change = changes.find((c) => c.entryId === e.id);
      if (!change) return e;
      changed += 1;
      const merged = { ...e, ...change.patch };
      return {
        id: e.id,
        address: merged.address,
        label: merged.label,
        kind: merged.kind,
        ...extras(merged, 'id', 'address', 'label', 'kind'),
      } as IpamEntry;
    });
    if (changed === 0) return 0;
    get().commit(what);
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          entries: next,
          reservations: undefined,
          audit: noteChange(s.doc.ipam, {
            action: 'edited',
            object: 'address',
            label: `${changed} addresses`,
            changes: [{ field: what }],
          }),
        },
      },
      dirty: true,
    }));
    return changed;
  },

  removeIpamEntry(id) {
    const gone = entriesOf(get().doc.ipam).find((e) => e.id === id);
    if (!gone) return;
    get().commit('Remove an address');
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          entries: entriesOf(s.doc.ipam).filter((e) => e.id !== id),
          reservations: undefined,
          audit: noteChange(s.doc.ipam, { action: 'removed', object: 'address', label: gone.address }),
        },
      },
      dirty: true,
    }));
  },

  addIpamRange(range) {
    const problem = rangeProblem(range.from, range.to);
    if (problem) return problem;
    get().commit('Add a range');
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          ranges: [
            ...(s.doc.ipam?.ranges ?? []),
            {
              id: uid(), from: range.from.trim(), to: range.to.trim(), kind: range.kind,
              ...extras(range, 'from', 'to', 'kind'),
            },
          ],
        },
      },
      dirty: true,
    }));
    return null;
  },

  updateIpamRange(id, patch) {
    const had = get().doc.ipam?.ranges ?? [];
    const at = had.find((r) => r.id === id);
    if (!at) return 'That range is no longer in the register.';
    const from = (patch.from ?? at.from).trim();
    const to = (patch.to ?? at.to).trim();
    const problem = rangeProblem(from, to);
    if (problem) return problem;
    get().commit('Edit a range');
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          ranges: (s.doc.ipam?.ranges ?? []).map((r) => {
            if (r.id !== id) return r;
            return {
              id: r.id, from, to, kind: patch.kind ?? r.kind,
              ...extras({ ...r, ...patch }, 'id', 'from', 'to', 'kind'),
            };
          }),
        },
      },
      dirty: true,
    }));
    return null;
  },

  removeIpamRange(id) {
    if (!(get().doc.ipam?.ranges ?? []).some((r) => r.id === id)) return;
    get().commit('Remove a range');
    set((s) => ({
      doc: { ...s.doc, ipam: { ...s.doc.ipam, ranges: (s.doc.ipam?.ranges ?? []).filter((r) => r.id !== id) } },
      dirty: true,
    }));
  },

  /** LT-295: the register edits the device, not a copy of it. Every page is
   *  searched, because the register is project-wide and `updateNodeData` only
   *  reaches the page being looked at. */
  editDeviceAddress(nodeId, addressId, patch) {
    if (patch.address !== undefined && toValue(patch.address) === null) return 'That is not an IPv4 address.';
    const page = get().doc.pages.find((p) => p.nodes.some((n) => n.id === nodeId));
    if (!page) return 'That device is no longer in this project.';
    get().commit('Edit an address');
    set((s) => ({
      doc: {
        ...s.doc,
        pages: s.doc.pages.map((p) =>
          p.id !== page.id
            ? p
            : {
                ...p,
                nodes: p.nodes.map((n) => {
                  if (n.id !== nodeId) return n;
                  const d = n.data as DeviceNodeData;
                  const addresses = (d.addresses ?? []).map((a) =>
                    a.id !== addressId
                      ? a
                      : {
                          ...a,
                          ...(patch.address !== undefined ? { address: patch.address.trim() } : {}),
                          ...(patch.interfaceLabel !== undefined ? { label: patch.interfaceLabel.trim() } : {}),
                        },
                  );
                  return {
                    ...n,
                    data: {
                      ...d,
                      addresses,
                      ...(patch.label !== undefined ? { label: patch.label.trim() } : {}),
                      ...(patch.mac !== undefined ? { mac: patch.mac.trim() } : {}),
                      ...(patch.hostname !== undefined ? { hostname: patch.hostname.trim() } : {}),
                    },
                  } as TopoNode;
                }),
              },
        ),
      },
      dirty: true,
    }));
    if (patch.address !== undefined) get().ensureNodeCheck(nodeId);
    return null;
  },

  addIpamContainer(container) {
    const problem = subnetProblem(container.cidr);
    if (problem) return problem;
    const cidr = normaliseCidr(container.cidr)!;
    const name = container.name.trim();
    if (!name) return 'Give the container a name.';
    const had = get().doc.ipam?.containers ?? [];
    const vrfId = container.vrfId ?? DEFAULT_VRF.id;
    if (had.some((c) => normaliseCidr(c.cidr) === cidr && (c.vrfId ?? DEFAULT_VRF.id) === vrfId)) {
      return `${cidr} is already a container here.`;
    }
    get().commit('Add a container');
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          containers: [...had, { id: uid(), cidr, name, ...extras(container, 'cidr', 'name') }],
          audit: noteChange(s.doc.ipam, { action: 'added', object: 'container', label: `${cidr} ${name}` }),
        },
      },
      dirty: true,
    }));
    return null;
  },

  updateIpamContainer(id, patch) {
    const had = get().doc.ipam?.containers ?? [];
    const at = had.find((c) => c.id === id);
    if (!at) return 'That container is no longer in the register.';
    let cidr = at.cidr;
    if (patch.cidr !== undefined) {
      const problem = subnetProblem(patch.cidr);
      if (problem) return problem;
      cidr = normaliseCidr(patch.cidr)!;
    }
    const name = (patch.name ?? at.name).trim();
    if (!name) return 'Give the container a name.';
    get().commit('Edit a container');
    const next: IpamContainer = { id: at.id, cidr, name, ...extras({ ...at, ...patch }, 'id', 'cidr', 'name') };
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          containers: (s.doc.ipam?.containers ?? []).map((c) => (c.id === id ? next : c)),
          audit: noteChange(s.doc.ipam, {
            action: 'edited', object: 'container', label: cidr, changes: diffOf(at, next),
          }),
        },
      },
      dirty: true,
    }));
    return null;
  },

  /** The subnets inside it are left exactly where they are: a container is a
   *  folder, and removing a folder does not delete the network. */
  removeIpamContainer(id) {
    const gone = (get().doc.ipam?.containers ?? []).find((c) => c.id === id);
    if (!gone) return;
    get().commit('Remove a container');
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          containers: (s.doc.ipam?.containers ?? []).filter((c) => c.id !== id),
          subnets: (s.doc.ipam?.subnets ?? []).map((x) => (x.containerId === id ? { ...x, containerId: undefined } : x)),
          audit: noteChange(s.doc.ipam, { action: 'removed', object: 'container', label: `${gone.cidr} ${gone.name}` }),
        },
      },
      dirty: true,
    }));
  },

  addIpamVrf(vrf) {
    const name = vrf.name.trim();
    if (!name) return 'Give the routing table a name.';
    const had = get().doc.ipam?.vrfs ?? [];
    if (name.toLowerCase() === DEFAULT_VRF.name.toLowerCase() || had.some((v) => v.name.trim().toLowerCase() === name.toLowerCase())) {
      return `There is already a routing table called ${name}.`;
    }
    get().commit('Add a routing table');
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          vrfs: [...had, { id: uid(), name, ...extras(vrf, 'name') }],
          audit: noteChange(s.doc.ipam, { action: 'added', object: 'routing table', label: name }),
        },
      },
      dirty: true,
    }));
    return null;
  },

  updateIpamVrf(id, patch) {
    const had = get().doc.ipam?.vrfs ?? [];
    const at = had.find((v) => v.id === id);
    if (!at) return 'That routing table is no longer in the register.';
    const name = (patch.name ?? at.name).trim();
    if (!name) return 'Give the routing table a name.';
    get().commit('Edit a routing table');
    const next: IpamVrf = { id: at.id, name, ...extras({ ...at, ...patch }, 'id', 'name') };
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          vrfs: (s.doc.ipam?.vrfs ?? []).map((v) => (v.id === id ? next : v)),
          audit: noteChange(s.doc.ipam, {
            action: 'edited', object: 'routing table', label: name, changes: diffOf(at, next),
          }),
        },
      },
      dirty: true,
    }));
    return null;
  },

  /** Refused while anything is still in it: a subnet whose routing table has
   *  gone is a subnet that has quietly moved to the default one. */
  removeIpamVrf(id) {
    const ipam = get().doc.ipam;
    const gone = (ipam?.vrfs ?? []).find((v) => v.id === id);
    if (!gone) return 'That routing table is no longer in the register.';
    const inUse =
      (ipam?.subnets ?? []).filter((x) => x.vrfId === id).length +
      (ipam?.containers ?? []).filter((c) => c.vrfId === id).length +
      entriesOf(ipam).filter((e) => e.vrfId === id).length;
    if (inUse > 0) {
      return `${gone.name} still holds ${inUse} thing${inUse === 1 ? '' : 's'}. Move or remove them first.`;
    }
    get().commit('Remove a routing table');
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          vrfs: (s.doc.ipam?.vrfs ?? []).filter((v) => v.id !== id),
          audit: noteChange(s.doc.ipam, { action: 'removed', object: 'routing table', label: gone.name }),
        },
      },
      dirty: true,
    }));
    return null;
  },

  /**
   * One declared subnet becomes several, in one step.
   *
   * The addresses and ranges inside are not touched: they are derived from
   * where they sit, so once the children exist every one of them is already
   * in the right child. What this does is replace the declaration — which is
   * why a range straddling a new boundary is a question for the person, and
   * the screen asks it before calling this.
   */
  splitIpamSubnet(cidr, vrfId, into) {
    const normal = normaliseCidr(cidr);
    if (!normal) return 'That is not an IPv4 subnet.';
    const parsed = parseCidrOf(normal)!;
    if (!Number.isInteger(into) || into <= parsed.prefix || into > 32) {
      return `A /${into} is not a smaller subnet than ${normal}.`;
    }
    if (into - parsed.prefix > 8) return 'That is too many subnets at once. Split in smaller steps.';
    const had = get().doc.ipam?.subnets ?? [];
    const parent = had.find((x) => normaliseCidr(x.cidr) === normal && (x.vrfId ?? DEFAULT_VRF.id) === vrfId);

    const size = 2 ** (32 - into);
    const count = 2 ** (into - parsed.prefix);
    const children = Array.from({ length: count }, (_, i) => ({
      id: uid(),
      cidr: `${addressOf(parsed.network + i * size)}/${into}`,
      ...(parent?.name ? { name: `${parent.name} ${i + 1}` } : {}),
      ...(parent?.vlan !== undefined ? { vlan: parent.vlan } : {}),
      ...(vrfId !== DEFAULT_VRF.id ? { vrfId } : {}),
      ...(parent?.containerId ? { containerId: parent.containerId } : {}),
      // LT-298: a split moves nothing to another building or another owner.
      ...carriedBy(parent),
    }));

    get().commit('Split a subnet');
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          subnets: [...(s.doc.ipam?.subnets ?? []).filter((x) => x.id !== parent?.id), ...children],
          audit: noteChange(s.doc.ipam, {
            action: 'split', object: 'subnet', label: normal,
            changes: [{ field: 'into', after: children.map((c) => c.cidr).join(', ') }],
          }),
        },
      },
      dirty: true,
    }));
    return null;
  },

  /** Two declared subnets become the one they are the halves of. */
  mergeIpamSubnets(cidrs, vrfId, into) {
    const target = normaliseCidr(into);
    if (!target) return 'That is not an IPv4 subnet.';
    const had = get().doc.ipam?.subnets ?? [];
    const wanted = cidrs.map((c) => normaliseCidr(c));
    const parts = had.filter(
      (x) => wanted.includes(normaliseCidr(x.cidr)) && (x.vrfId ?? DEFAULT_VRF.id) === vrfId,
    );
    const first = parts[0];
    get().commit('Merge subnets');
    set((s) => ({
      doc: {
        ...s.doc,
        ipam: {
          ...s.doc.ipam,
          subnets: [
            ...(s.doc.ipam?.subnets ?? []).filter((x) => !parts.some((p) => p.id === x.id)),
            {
              id: uid(),
              cidr: target,
              ...(first?.name ? { name: first.name } : {}),
              ...(first?.vlan !== undefined ? { vlan: first.vlan } : {}),
              ...(vrfId !== DEFAULT_VRF.id ? { vrfId } : {}),
              ...(first?.containerId ? { containerId: first.containerId } : {}),
              // LT-298: only what every half agreed on (D-050).
              ...agreedBy(parts),
            },
          ],
          audit: noteChange(s.doc.ipam, {
            action: 'merged', object: 'subnet', label: target,
            changes: [{ field: 'from', before: cidrs.join(', ') }],
          }),
        },
      },
      dirty: true,
    }));
    return null;
  },

  addRack(name, units) {
    const trimmed = name.trim();
    const racks = get().doc.racks ?? [];
    const problem = rackNameProblem(racks, trimmed) ?? rackUnitsProblem(units);
    if (problem) return problem;
    get().commit('Add a rack');
    set((s) => ({ doc: { ...s.doc, racks: [...(s.doc.racks ?? []), { id: uid(), name: trimmed, units }] }, dirty: true }));
    return null;
  },

  updateRack(id, patch) {
    const doc = get().doc;
    const racks = doc.racks ?? [];
    const rack = racks.find((r) => r.id === id);
    if (!rack) return 'That rack is no longer there.';
    const name = patch.name?.trim() ?? rack.name;
    const units = patch.units ?? rack.units;
    const problem =
      (name.toLowerCase() !== rack.name.toLowerCase() ? rackNameProblem(racks, name) : null) ?? rackUnitsProblem(units);
    if (problem) return problem;
    const members = [...rackables(doc).filter((d) => sameRack(d.rack, rack.name)), ...furnitureRackables(rack)];
    const over = members.find((d) => (spanOf(d)?.top ?? 0) > units);
    if (over) return `${over.label} sits at U${spanOf(over)!.top}, above ${units}U. Move it first.`;
    get().commit('Change a rack');
    // Renaming carries the devices with it: they name the rack they are in.
    const moved = new Map(members.filter((d) => d.kind !== 'furniture').map((d) => [d.id, { rack: name }]));
    // LT-685, LT-689: the place and the limits travel in the same patch; an
    // empty string clears a field.
    const rest: Partial<Rack> = {};
    for (const k of ['building', 'floor', 'room', 'row', 'position', 'notes'] as const) {
      if (patch[k] !== undefined) rest[k] = patch[k]!.trim() || undefined;
    }
    for (const k of ['powerLimitW', 'weightLimitKg', 'widthMm', 'depthMm'] as const) {
      if (patch[k] !== undefined) rest[k] = Number.isFinite(patch[k]) && patch[k]! > 0 ? patch[k] : undefined;
    }
    set((s) => ({
      doc: {
        ...patchDevices(s.doc, moved),
        racks: (s.doc.racks ?? []).map((r) => (r.id === id ? { ...r, ...rest, name, units } : r)),
      },
      dirty: true,
    }));
    return null;
  },

  removeRack(id) {
    if (!(get().doc.racks ?? []).some((r) => r.id === id)) return;
    get().commit('Remove a rack');
    // Devices keep their rack name and U: removing the drawing of a rack does
    // not unrack anything, and adding it back puts them where they were.
    set((s) => ({ doc: { ...s.doc, racks: (s.doc.racks ?? []).filter((r) => r.id !== id) }, dirty: true }));
  },

  placeInRack(nodeId, rackId, u, face) {
    const doc = get().doc;
    const rack = (doc.racks ?? []).find((r) => r.id === rackId);
    const devices = rackables(doc);
    const device = devices.find((d) => d.id === nodeId);
    if (!rack || !device) return 'That rack or device is no longer there.';
    const problem = placementProblem(rack, [...devices, ...furnitureRackables(rack)], device, u, face);
    if (problem) return problem;
    get().commit('Place in a rack');
    set((s) => ({
      doc: patchDevices(s.doc, new Map([[nodeId, { rack: rack.name, rackU: u, ...(face ? { rackFace: face } : {}) }]])),
      dirty: true,
    }));
    return null;
  },

  takeOutOfRack(nodeId) {
    get().commit('Take out of a rack');
    set((s) => ({ doc: patchDevices(s.doc, new Map([[nodeId, { rackU: undefined }]])), dirty: true }));
  },

  setRackDetails(nodeId, patch) {
    const doc = get().doc;
    const devices = rackables(doc);
    const device = devices.find((d) => d.id === nodeId);
    if (!device) return 'That device is no longer there.';
    const rack = (doc.racks ?? []).find((r) => sameRack(device.rack, r.name));
    // A change of face or depth can make a placed box collide: refused, the
    // same as a move into occupied space.
    if (rack && spanOf(device) && (patch.rackFace !== undefined || patch.rackDepth !== undefined)) {
      const changed: Rackable = { ...device, ...patch };
      const problem = placementProblem(rack, [...devices, ...furnitureRackables(rack)], changed, device.rackU!, changed.rackFace);
      if (problem) return problem;
    }
    get().commit('Change how a device is racked');
    set((s) => ({ doc: patchDevices(s.doc, new Map([[nodeId, patch]])), dirty: true }));
    return null;
  },

  addFurniture(rackId, kind, label, units, u, face) {
    const rack = (get().doc.racks ?? []).find((r) => r.id === rackId);
    if (!rack) return 'That rack is no longer there.';
    const item = newFurniture(kind, uid(), label, units);
    // LT-692: it lands on the face it was dropped on, whatever its kind's habit.
    if (face) item.face = face;
    const problem = furnitureProblem(item);
    if (problem) return problem;
    if (u !== undefined && item.units > 0) {
      const others = [...rackables(get().doc), ...furnitureRackables(rack)];
      const asRackable: Rackable = { id: item.id, label: item.label, rack: rack.name, rackUnits: item.units, rackFace: item.face, rackDepth: item.depth, kind: 'furniture', furniture: item.kind };
      const blocked = placementProblem(rack, others, asRackable, u, item.face);
      if (blocked) return blocked;
      item.u = u;
    }
    get().commit(kind === 'reserved' ? 'Reserve rack space' : 'Add to a rack');
    set((s) => ({ doc: { ...s.doc, racks: (s.doc.racks ?? []).map((r) => (r.id === rackId ? { ...r, items: [...(r.items ?? []), item] } : r)) }, dirty: true }));
    return null;
  },

  updateFurniture(rackId, itemId, patch) {
    const doc = get().doc;
    const rack = (doc.racks ?? []).find((r) => r.id === rackId);
    const item = rack?.items?.find((f) => f.id === itemId);
    if (!rack || !item) return 'That item is no longer there.';
    const next: RackFurniture = { ...item, ...patch };
    if (patch.label !== undefined) next.label = patch.label.trim();
    const problem = furnitureProblem(next);
    if (problem) return problem;
    // A change of height, face or depth can make a placed item collide.
    if (next.u !== undefined && next.units > 0) {
      const others = [...rackables(doc), ...furnitureRackables(rack).filter((f) => f.id !== itemId)];
      const asRackable: Rackable = { id: next.id, label: next.label, rack: rack.name, rackU: next.u, rackUnits: next.units, rackFace: next.face, rackDepth: next.depth, kind: 'furniture', furniture: next.kind };
      const blocked = placementProblem(rack, others, asRackable, next.u, next.face);
      if (blocked) return blocked;
    }
    for (const k of Object.keys(next) as (keyof RackFurniture)[]) if (next[k] === undefined) delete next[k];
    get().commit('Change a rack item');
    set((s) => ({ doc: { ...s.doc, racks: (s.doc.racks ?? []).map((r) => (r.id === rackId ? { ...r, items: (r.items ?? []).map((f) => (f.id === itemId ? next : f)) } : r)) }, dirty: true }));
    return null;
  },

  placeFurniture(rackId, itemId, u, face) {
    const doc = get().doc;
    const rack = (doc.racks ?? []).find((r) => r.id === rackId);
    const item = rack?.items?.find((f) => f.id === itemId);
    if (!rack || !item) return 'That item is no longer there.';
    return get().updateFurniture(rackId, itemId, { u, ...(face ? { face } : {}) });
  },

  removeFurniture(rackId, itemId) {
    if (!(get().doc.racks ?? []).some((r) => r.id === rackId && r.items?.some((f) => f.id === itemId))) return;
    get().commit('Remove from a rack');
    set((s) => ({ doc: { ...s.doc, racks: (s.doc.racks ?? []).map((r) => (r.id === rackId ? { ...r, items: (r.items ?? []).filter((f) => f.id !== itemId) } : r)) }, dirty: true }));
  },

  addStack(stack) {
    const problem = stackProblem(stack, stackPreset(stack.technology));
    if (problem) return problem;
    const taken = (get().doc.stacks ?? []).flatMap((s) => s.members.map((m) => m.nodeId));
    const twice = stack.members.find((m) => taken.includes(m.nodeId));
    if (twice) return 'A device can be in one stack only.';
    get().commit('Add a stack');
    set((s) => ({ doc: { ...s.doc, stacks: [...(s.doc.stacks ?? []), { ...stack, id: uid(), name: stack.name.trim() }] }, dirty: true }));
    return null;
  },

  updateStack(id, patch) {
    const was = (get().doc.stacks ?? []).find((s) => s.id === id);
    if (!was) return 'That stack is no longer there.';
    const next: Stack = { ...was, ...patch, id };
    const problem = stackProblem(next, stackPreset(next.technology));
    if (problem) return problem;
    const taken = (get().doc.stacks ?? []).filter((s) => s.id !== id).flatMap((s) => s.members.map((m) => m.nodeId));
    const twice = next.members.find((m) => taken.includes(m.nodeId));
    if (twice) return 'A device can be in one stack only.';
    get().commit('Change a stack');
    set((s) => ({ doc: { ...s.doc, stacks: (s.doc.stacks ?? []).map((x) => (x.id === id ? { ...next, name: next.name.trim() } : x)) }, dirty: true }));
    return null;
  },

  removeStack(id) {
    if (!(get().doc.stacks ?? []).some((s) => s.id === id)) return;
    get().commit('Remove a stack');
    set((s) => ({ doc: { ...s.doc, stacks: (s.doc.stacks ?? []).filter((x) => x.id !== id) }, dirty: true }));
  },

  buildRacksFromDevices() {
    const doc = get().doc;
    const before = doc.racks ?? [];
    const got = racksFromDevices(before, rackables(doc), uid);
    const added = got.racks.length - before.length;
    if (added === 0 && got.placed.size === 0) return { racks: 0, placed: 0, full: got.full.map((d) => d.label) };
    get().commit('Build racks from devices');
    const patches = new Map([...got.placed].map(([id, u]) => [id, { rackU: u }]));
    set((s) => ({ doc: { ...patchDevices(s.doc, patches), racks: got.racks }, dirty: true }));
    return { racks: added, placed: got.placed.size, full: got.full.map((d) => d.label) };
  },

  saveProbeTemplate(t) {
    if (!t.name.trim()) return;
    set((s) => ({ doc: { ...s.doc, probeTemplates: withTemplate(s.doc.probeTemplates ?? [], t) }, dirty: true }));
  },

  deleteProbeTemplate(id) {
    set((s) => ({ doc: { ...s.doc, probeTemplates: (s.doc.probeTemplates ?? []).filter((t) => t.id !== id) }, dirty: true }));
  },

  applyProbeTemplate(templateId, nodeIds) {
    const doc = get().doc;
    const t = (doc.probeTemplates ?? []).find((x) => x.id === templateId);
    const meta = get().meta;
    if (!t || !meta) return { added: 0, skipped: [] };
    const skipped: string[] = [];
    const probes: Probe[] = [];
    for (const id of nodeIds) {
      const node = nodeById(doc, id);
      if (!node || node.type !== 'device') continue;
      const d = node.data as DeviceNodeData;
      const target = targetOf(d);
      if (!target) {
        skipped.push(d.label);
        continue;
      }
      probes.push(probeFromTemplate(t, 'node', id, meta.id, target, uid()));
    }
    if (probes.length) {
      get().commit(`Add ${t.name}`);
      set((s) => ({ doc: { ...s.doc, probes: [...s.doc.probes, ...probes] }, dirty: true }));
    }
    return { added: probes.length, skipped };
  },

  applyCrawlChanges(accepted) {
    if (accepted.length === 0) return [];
    get().commit('Apply a crawl');
    const page = activePage(get().doc);
    const before = new Set(page.edges.map((e) => e.id));
    const next = applyChanges(page, accepted);
    // New links take the page's link style, as `addEdge` gives them (LT-079).
    const style = linkStyleDefaults(page.canvas.linkStyle);
    const edges = next.edges.map((e) => (before.has(e.id) ? e : ({ ...e, data: { ...style, ...(e.data ?? {}) } } as TopoEdge)));
    const kept = new Set([...next.nodes.map((n) => n.id), ...edges.map((e) => e.id)]);
    const removed = new Set([...page.nodes, ...page.edges].map((o) => o.id).filter((id) => !kept.has(id)));
    set((s) => ({
      doc: {
        ...withPage(s.doc, { nodes: next.nodes, edges }),
        // Checks on anything removed go with it.
        probes: s.doc.probes.filter((p) => !removed.has(p.objectId)),
      },
      dirty: true,
    }));
    for (const c of accepted) if (c.patch && 'addresses' in c.patch.data) get().ensureNodeCheck(c.patch.id);
    return next.added;
  },

  setIntentRules(rules) {
    get().commit();
    set((s) => ({ doc: { ...s.doc, intentRules: rules }, dirty: true }));
  },

  setLifecycle(rows) {
    get().commit();
    set((s) => ({ doc: { ...s.doc, lifecycle: rows }, dirty: true }));
  },

  saveCrawlProfile(profile) {
    const clean = readProfile(profile);
    if (!clean) return;
    set((s) => ({ doc: { ...s.doc, crawlProfiles: withProfile(s.doc.crawlProfiles ?? [], clean) }, dirty: true }));
  },

  deleteCrawlProfile(id) {
    set((s) => ({ doc: { ...s.doc, crawlProfiles: (s.doc.crawlProfiles ?? []).filter((p) => p.id !== id) }, dirty: true }));
  },

  setCredentialRules(rules) {
    set((s) => ({ doc: { ...s.doc, credentialRules: rules }, dirty: true }));
  },

  noteGuide(...steps) {
    const guide = get().doc.guide;
    const fresh = steps.filter((id) => guide && !guide.done.includes(id));
    if (!guide || fresh.length === 0) return;
    set((s) => ({ doc: { ...s.doc, guide: { ...guide, done: [...guide.done, ...fresh] } }, dirty: true }));
  },

  hideGuide() {
    const guide = get().doc.guide;
    if (!guide) return;
    set((s) => ({ doc: { ...s.doc, guide: { ...guide, hidden: true } }, dirty: true }));
  },

  bumpVault() {
    set((s) => ({ vaultRevision: s.vaultRevision + 1 }));
  },

  rememberCredential(kind, id) {
    set((s) => {
      const had = s.doc.credentialDefaults ?? {};
      const next =
        kind === 'ssh'
          ? { ...had, ssh: id }
          : { ...had, snmp: [...new Set([...(had.snmp ?? []), id])] };
      return { doc: { ...s.doc, credentialDefaults: next }, dirty: true };
    });
  },

  /** LT-497: another SSH login for the project, tried after the first. */
  addProjectSsh(id) {
    set((s) => {
      const had = s.doc.credentialDefaults ?? {};
      if (had.ssh === id || (had.sshMore ?? []).includes(id)) return {};
      // The first one saved is the project's first login.
      const next = had.ssh ? { ...had, sshMore: [...(had.sshMore ?? []), id] } : { ...had, ssh: id };
      return { doc: { ...s.doc, credentialDefaults: next }, dirty: true };
    });
  },

  /** LT-497: one of the project's logins, replaced by another or removed. */
  replaceProjectCredential(kind, oldId, newId) {
    set((s) => {
      const had = s.doc.credentialDefaults ?? {};
      const swap = (list: string[] | undefined) => (list ?? []).flatMap((x) => (x === oldId ? (newId ? [newId] : []) : [x]));
      const next =
        kind === 'ssh'
          ? had.ssh === oldId
            ? { ...had, ssh: newId ?? had.sshMore?.[0], sshMore: newId ? had.sshMore : (had.sshMore ?? []).slice(1) }
            : { ...had, sshMore: swap(had.sshMore) }
          : { ...had, snmp: swap(had.snmp) };
      return { doc: { ...s.doc, credentialDefaults: next }, dirty: true };
    });
  },

  /** Without an `id`, the project forgets every credential of that kind;
   *  with one, only that credential, and only if it is the one in use. The
   *  first version read `id !== undefined && x !== id`, which emptied the
   *  whole SNMP list whenever it was called without an id. */
  forgetCredential(kind, id) {
    set((s) => {
      const had = s.doc.credentialDefaults;
      if (!had) return {};
      const next =
        kind === 'ssh'
          ? { ...had, ssh: id !== undefined && had.ssh !== id ? had.ssh : undefined }
          : { ...had, snmp: id === undefined ? [] : (had.snmp ?? []).filter((x) => x !== id) };
      return { doc: { ...s.doc, credentialDefaults: next }, dirty: true };
    });
  },

  setGridSnap(on) {
    set((s) => ({ doc: { ...s.doc, gridSnap: on }, dirty: true }));
  },

  setActivePage(id) {
    set((s) => ({ doc: setActivePageIn(s.doc, id) }));
  },

  onNodesChange(changes) {
    const structural = changes.some((c) => c.type === 'remove' || c.type === 'add');
    if (structural) get().commit();
    // LT-356: which device is selected is view state, not document state.
    // Marking the project dirty for it made a click look like unsaved work,
    // had autosave rewrite a document identical to the stored one, and let
    // closing ask about changes nobody made. Anything else still dirties.
    const substantive = changes.some((c) => c.type !== 'select');
    set((s) => ({
      doc: withPage(s.doc, { nodes: moveGroups(changes, activePage(s.doc).nodes) }),
      ...(substantive ? { dirty: true } : {}),
    }));
  },

  groupSelected() {
    const selected = activePage(get().doc).nodes.filter((n) => n.selected);
    // One object is not a group, and grouping is only meaningful across two.
    if (selected.length < 2) return;
    get().commit('Group');
    const groupId = uid();
    const ids = new Set(selected.map((n) => n.id));
    set((s) => ({
      doc: withPage(s.doc, {
        nodes: activePage(s.doc).nodes.map((n) =>
          ids.has(n.id) ? ({ ...n, data: { ...n.data, groupId } } as TopoNode) : n,
        ),
      }),
      dirty: true,
    }));
  },

  ungroup(nodeId) {
    const groupId = groupOf(activePage(get().doc).nodes.find((n) => n.id === nodeId));
    if (!groupId) return;
    get().commit('Ungroup');
    set((s) => ({
      doc: withPage(s.doc, {
        nodes: activePage(s.doc).nodes.map((n) => {
          if (groupOf(n) !== groupId) return n;
          const data = { ...n.data };
          delete (data as { groupId?: string }).groupId;
          return { ...n, data } as TopoNode;
        }),
      }),
      dirty: true,
    }));
  },

  groupBySubnet() {
    const { assignments, subnets, ungrouped } = bucketBySubnet(activePage(get().doc).nodes);
    if (assignments.size === 0) return { groups: 0, ungrouped };
    get().commit('Group by subnet');
    // One id per subnet rather than the subnet string itself: a group id is
    // opaque everywhere else, and making it meaningful here would invite
    // something to start parsing it.
    const ids = new Map(subnets.map((s) => [s, uid()]));
    set((state) => ({
      doc: withPage(state.doc, {
        nodes: activePage(state.doc).nodes.map((n) => {
          const subnet = assignments.get(n.id);
          return subnet
            ? ({ ...n, data: { ...n.data, groupId: ids.get(subnet) } } as TopoNode)
            : n;
        }),
      }),
      dirty: true,
    }));
    return { groups: subnets.length, ungrouped };
  },

  tidyLayout() {
    const nodes = activePage(get().doc).nodes;
    const { moved, rows } = evenOutSpacing(nodes);
    const locked = nodes.filter((n) => (n.data as { locked?: boolean }).locked).length;
    if (moved.size === 0) return { moved: 0, rows, locked };
    get().commit('Tidy layout');
    set((state) => {
      const nodes = activePage(state.doc).nodes.map((n) => {
        const at = moved.get(n.id);
        return at ? ({ ...n, position: at } as TopoNode) : n;
      });
      // LT-420: the sheet follows, for the same reason it does after Arrange.
      return { doc: withPage(state.doc, { nodes, canvas: { ...activePage(state.doc).canvas, sheetRect: pageForContent(nodes) } }), dirty: true };
    });
    return { moved: moved.size, rows, locked };
  },

  autoLayout(kind) {
    const page = activePage(get().doc);
    const devices = page.nodes.filter((n) => n.type === 'device' && (n.data as DeviceNodeData).deviceType !== 'zone');
    const selected = devices.filter((n) => n.selected);
    const scope = selected.length >= 2 ? 'selection' : 'page';
    const chosen = scope === 'selection' ? selected : devices;
    const input = chosen.map((n) => ({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      width: n.width ?? n.measured?.width ?? 76,
      height: n.height ?? n.measured?.height ?? 76,
      locked: Boolean((n.data as DeviceNodeData).locked),
    }));
    const links = page.edges.map((e) => ({ source: e.source, target: e.target }));
    // Force-directed compares every pair on every pass: past this many it
    // would hold the window for minutes. Refused rather than started.
    if (kind === 'force' && input.length > FORCE_LAYOUT_LIMIT) {
      return { moved: 0, scope, locked: 0, tooMany: FORCE_LAYOUT_LIMIT };
    }
    const moved = kind === 'radial' ? radialLayout(input, links) : kind === 'force' ? forceLayout(input, links) : orthogonalLayout(input, links);
    const locked = input.filter((n) => n.locked).length;
    const changed = [...moved].filter(([id, at]) => {
      const n = chosen.find((c) => c.id === id)!;
      return n.position.x !== at.x || n.position.y !== at.y;
    });
    if (changed.length === 0) return { moved: 0, scope, locked };
    get().commit('Lay out');
    set((state) => ({
      doc: withPage(state.doc, {
        nodes: activePage(state.doc).nodes.map((n) => {
          const at = moved.get(n.id);
          return at ? ({ ...n, position: at } as TopoNode) : n;
        }),
      }),
      dirty: true,
    }));
    return { moved: changed.length, scope, locked };
  },

  flowLayout() {
    const page = activePage(get().doc);
    // Devices only. A note is an annotation about a place on the diagram, and
    // sweeping notes into the hierarchy would file each one under a tier it
    // has no business being in.
    const allDevices = page.nodes.filter((n) => n.type === 'device');
    // LT-371: on the selection when two or more devices are selected,
    // otherwise the page — the same rule `autoLayout` has had since LT-177.
    // Arranging a chosen corner of a large diagram is a different and equally
    // reasonable request from arranging all of it, and it was only the
    // hierarchical layout that could not do it.
    const selected = allDevices.filter((n) => n.selected);
    const devices = selected.length >= 2 ? selected : allDevices;
    const { moved, tiers, locked } = hierarchicalLayout(
      devices.map((n) => ({
        id: n.id,
        deviceType: (n.data as DeviceNodeData).deviceType,
        width: n.width ?? 76,
        height: n.height ?? 76,
        locked: (n.data as DeviceNodeData).locked,
      })),
      // LT-145: the proven direction goes with the link. Without it the
      // layout falls back to guessing tiers from the glyph, which is what put
      // an access switch at the top of a diagram crawled from one.
      // Plus evidence the links do not carry: a device whose `switchPort`
      // names a switch on this page hangs off it (LT-146), and a switch sits
      // above what is plugged into it. That comes from a MAC table, so it is
      // proof — and unlike a drawn arrow it is not something anyone wants on
      // every access port.
      [
        ...page.edges.map((e) => ({
          source: e.source,
          target: e.target,
          direction: (e.data as LinkData | undefined)?.direction,
        })),
        ...hangsOffLinks(devices),
      ],
      { originX: 80, originY: 80 },
    );
    if (moved.size === 0) return { moved: 0, tiers, locked };
    get().commit('Arrange top to bottom');
    set((state) => {
      const nodes = activePage(state.doc).nodes.map((n) => {
        const at = moved.get(n.id);
        return at ? ({ ...n, position: at } as TopoNode) : n;
      });
      // LT-420: the sheet follows the drawing it holds.
      //
      // Growth has always been automatic and shrinking was not, for a good
      // reason written down beside `sheetRect`: a sheet that snaps smaller
      // *mid-drag* makes the layout jump under the pointer. Rearranging is
      // not a drag — it is the one moment the diagram's size certainly
      // changed, and after a crawl places two hundred devices the sheet is
      // left far larger than the drawing, so the boundary means nothing and
      // an export crops.
      return { doc: withPage(state.doc, { nodes, canvas: { ...activePage(state.doc).canvas, sheetRect: pageForContent(nodes) } }), dirty: true };
    });
    return { moved: moved.size, tiers, locked };
  },

  routeLinks() {
    const changed = chooseLinkSides(activePage(get().doc).nodes, activePage(get().doc).edges);
    if (changed.length === 0) return 0;
    get().commit('Re-route links');
    const byId = new Map(changed.map((c) => [c.id, c]));
    set((state) => ({
      doc: withPage(state.doc, {
        edges: activePage(state.doc).edges.map((e) => {
          const want = byId.get(e.id);
          if (!want) return e;
          // A floating anchor (LT-098) is exactly the kind of "not the
          // computed default" this action exists to undo — leaving one in
          // place would have the link silently ignore its own new side.
          const data = { ...(e.data as LinkData) };
          delete data.sourceAnchor;
          delete data.targetAnchor;
          delete data.pinnedSides;
          return {
            ...e,
            sourceHandle: want.sourceHandle,
            targetHandle: want.targetHandle,
            data,
          } as TopoEdge;
        }),
      }),
      dirty: true,
    }));
    return changed.length;
  },

  addLayer(name) {
    const page = activePage(get().doc);
    const layers = layersOf(page.canvas.layers);
    get().commit('Add a view');
    set((s) => ({
      doc: withPage(s.doc, {
        canvas: { ...activePage(s.doc).canvas, layers: withNewLayer(layers, name, uid()) },
      }),
      dirty: true,
    }));
  },

  removeLayer(id) {
    const layers = layersOf(activePage(get().doc).canvas.layers);
    get().commit('Remove a view');
    // The objects on it are deliberately left alone: they fall back to being
    // on every view, which is where an unassigned object lives. Deleting a
    // view of the network must not delete the network.
    set((s) => ({
      doc: withPage(s.doc, {
        canvas: { ...activePage(s.doc).canvas, layers: withoutLayer(layers, id) },
      }),
      dirty: true,
    }));
  },

  addStandardLayers() {
    const page = activePage(get().doc);
    const used = new Set<string>();
    for (const o of [...page.nodes, ...page.edges]) {
      for (const l of ((o.data as { layers?: string[] } | undefined)?.layers ?? [])) used.add(l);
    }
    const before = layersOf(page.canvas.layers);
    const next = withStandardLayers(page.canvas.layers, uid, used);
    const added = next.filter((l) => !before.some((b) => b.id === l.id)).length;
    if (added === 0) return 0;
    get().commit('Add the standard views');
    set((s) => ({
      doc: withPage(s.doc, { canvas: { ...activePage(s.doc).canvas, layers: next } }),
      dirty: true,
    }));
    return added;
  },

  setLayer(id, patch) {
    const layers = layersOf(activePage(get().doc).canvas.layers);
    set((s) => ({
      doc: withPage(s.doc, {
        canvas: {
          ...activePage(s.doc).canvas,
          layers: layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
        },
      }),
      // Which views are on is part of how the diagram was left.
      dirty: true,
    }));
  },

  copySelection() {
    const { nodes, edges } = activePage(get().doc);
    clipboard = copySelection(nodes, edges);
    copiedAt = clipboard;
    return clipboard.nodes.length;
  },

  canPaste() {
    return Boolean(copiedAt && copiedAt.nodes.length > 0);
  },

  pasteInPlace() {
    if (!copiedAt || copiedAt.nodes.length === 0) return 0;
    const fresh = pasteClipping(copiedAt, { x: 0, y: 0 }, uid);
    get().commit('Paste in place');
    placePaste(set, fresh);
    // A plain paste after this goes on from here, as it would after any paste.
    clipboard = { nodes: fresh.nodes.map((n) => ({ ...n })), edges: fresh.edges.map((e) => ({ ...e })) };
    return fresh.nodes.length;
  },

  paste() {
    if (!clipboard || clipboard.nodes.length === 0) return 0;
    const fresh = pasteClipping(clipboard, { x: 40, y: 40 }, uid);
    get().commit('Paste');
    placePaste(set, fresh);
    // Pasting again offsets further, so a run of pastes makes a row rather
    // than a stack nobody can separate.
    clipboard = {
      nodes: fresh.nodes.map((n) => ({ ...n })),
      edges: fresh.edges.map((e) => ({ ...e })),
    };
    return fresh.nodes.length;
  },

  selectNone() {
    set((state) => ({
      doc: withPage(state.doc, {
        nodes: activePage(state.doc).nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
        edges: activePage(state.doc).edges.map((e) => (e.selected ? { ...e, selected: false } : e)),
      }),
      selectedNodeId: null,
      selectedEdgeId: null,
    }));
  },

  requestFit() {
    set((s) => ({ fitRequest: s.fitRequest + 1 }));
  },

  setCanvasHighlight(ids) {
    set({ canvasHighlight: ids });
  },

  beginEditing(id) {
    set({ editingNodeId: id });
  },

  selectAll() {
    set((state) => ({
      doc: withPage(state.doc, {
        nodes: activePage(state.doc).nodes.map((n) => (n.selected ? n : { ...n, selected: true })),
      }),
      selectedNodeId: null,
      selectedEdgeId: null,
    }));
  },

  arrange(ids, how) {
    const wanted = new Set(ids);
    const boxes = activePage(get().doc)
      .nodes.filter((n) => wanted.has(n.id) && !(n.data as { locked?: boolean }).locked)
      .map((n) => ({
        id: n.id,
        x: n.position.x,
        y: n.position.y,
        w: n.width ?? n.measured?.width ?? 168,
        h: n.height ?? n.measured?.height ?? 92,
      }));
    const moved =
      how === 'across'
        ? distribute(boxes, 'x')
        : how === 'down'
          ? distribute(boxes, 'y')
          : alignTo(boxes, how);
    if (moved.size === 0) return 0;
    get().commit('Arrange');
    set((state) => ({
      doc: withPage(state.doc, {
        nodes: activePage(state.doc).nodes.map((n) => {
          const at = moved.get(n.id);
          return at ? ({ ...n, position: at } as TopoNode) : n;
        }),
      }),
      dirty: true,
    }));
    return moved.size;
  },

  unpinLinks() {
    const pinned = activePage(get().doc).edges.filter(
      (e) => (e.data as { pinnedSides?: boolean } | undefined)?.pinnedSides,
    );
    if (pinned.length === 0) return 0;
    const ids = new Set(pinned.map((e) => e.id));
    get().commit('Release links');
    set((state) => ({
      doc: withPage(state.doc, {
        edges: activePage(state.doc).edges.map((e) =>
          ids.has(e.id) ? ({ ...e, data: { ...e.data, pinnedSides: false } } as TopoEdge) : e,
        ),
      }),
      dirty: true,
    }));
    return pinned.length;
  },

  groupMembers(nodeId) {
    const nodes = activePage(get().doc).nodes;
    const groupId = groupOf(nodes.find((n) => n.id === nodeId));
    return groupId ? nodes.filter((n) => groupOf(n) === groupId).map((n) => n.id) : [];
  },

  onEdgesChange(changes) {
    const structural = changes.some((c) => c.type === 'remove' || c.type === 'add');
    if (structural) get().commit();
    set((s) => ({
      doc: withPage(s.doc, { edges: applyEdgeChanges(changes, activePage(s.doc).edges) as TopoEdge[] }),
      dirty: true,
    }));
  },

  addNode(node) {
    get().commit();
    set((s) => ({ doc: withPage(s.doc, { nodes: [...activePage(s.doc).nodes, node] }), dirty: true }));
  },

  addEdge(edge) {
    get().commit();
    // LT-079: a new link is born with the look the operator chose, so a
    // diagram drawn after that choice needs no tidying up afterwards. What
    // the caller set explicitly still wins — a crawl that marks a link red
    // means it.
    const style = linkStyleDefaults(activePage(get().doc).canvas.linkStyle);
    const withStyle = {
      ...edge,
      data: { ...style, ...(edge.data ?? {}) },
    } as typeof edge;
    set((s) => ({ doc: withPage(s.doc, { edges: [...activePage(s.doc).edges, withStyle] }), dirty: true }));
  },

  updateNodeData(id, patch) {
    set((s) => ({
      doc: withPage(s.doc, {
        nodes: activePage(s.doc).nodes.map((n) =>
          n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as TopoNode) : n,
        ),
      }),
      dirty: true,
    }));
    // LT-061: the primary check follows the primary address. A device that
    // has an address and no check gets one; a check aimed at nothing gets
    // the address the moment it exists. Only address edits do this — a
    // target typed into the check itself is never overwritten from here.
    if ('addresses' in patch) get().ensureNodeCheck(id);
  },

  /** The automatic half of monitoring (LT-061): give a device's primary
   *  check the device's primary address. Called on address edits; a check
   *  the operator aimed somewhere on purpose keeps its aim unless the
   *  addresses change again. Searches every page: monitoring is project-wide
   *  regardless of which page a device is drawn on (LT-094). */
  ensureNodeCheck(id) {
    const { doc, meta } = get();
    if (!meta) return;
    const node = allNodes(doc).find((n) => n.id === id);
    if (!node || node.type !== 'device') return;
    const d = node.data as DeviceNodeData;
    const primary =
      d.addresses?.find((a) => a.isPrimary && a.address.trim())?.address.trim() ??
      d.addresses?.find((a) => a.address.trim())?.address.trim();
    if (!primary) return;
    const mine = doc.probes.filter((p) => p.objectId === id);
    if (mine.length === 0) {
      get().upsertProbe(newProbe('node', id, meta.id, primary, 'Management'));
      return;
    }
    const lead = mine.find((p) => p.isPrimary) ?? mine[0]!;
    if (lead.target.trim() !== primary) {
      get().upsertProbe({ ...lead, target: primary });
    }
  },

  setComments(objectId, threads, label) {
    const doc = get().doc;
    if (nodeById(doc, objectId)) {
      get().commit(label);
      set((s) => ({ doc: patchDevices(s.doc, new Map([[objectId, { comments: threads }]])), dirty: true }));
    } else if (edgeById(doc, objectId)) {
      get().commit(label);
      set((s) => ({
        doc: { ...s.doc, pages: s.doc.pages.map((p) => (p.edges.some((e) => e.id === objectId) ? { ...p, edges: p.edges.map((e) => (e.id === objectId ? { ...e, data: { ...(e.data as LinkData), comments: threads } } : e)) } : p)) },
        dirty: true,
      }));
    }
  },

  updateManyEdgeData(ids, patch, label) {
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    get().commit(label ?? 'Edit links');
    set((s) => ({
      doc: withPage(s.doc, {
        edges: activePage(s.doc).edges.map((e) => (wanted.has(e.id) ? { ...e, data: { ...(e.data as LinkData), ...patch } } : e)),
      }),
      dirty: true,
    }));
  },

  updateManyNodeData(ids, patch, label) {
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    get().commit(label ?? 'Edit devices');
    set((s) => ({
      doc: withPage(s.doc, {
        nodes: activePage(s.doc).nodes.map((n) =>
          wanted.has(n.id) ? ({ ...n, data: { ...n.data, ...patch } } as TopoNode) : n,
        ),
      }),
      dirty: true,
    }));
  },

  mapManyNodeData(ids, change, label) {
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    get().commit(label ?? 'Edit devices');
    set((s) => ({
      doc: withPage(s.doc, {
        nodes: activePage(s.doc).nodes.map((n) =>
          wanted.has(n.id)
            ? ({
                ...n,
                data: { ...n.data, ...change(n.data as DeviceNodeData & NoteNodeData) },
              } as TopoNode)
            : n,
        ),
      }),
      dirty: true,
    }));
  },

  updateEdgeData(id, patch) {
    set((s) => ({
      doc: withPage(s.doc, {
        edges: activePage(s.doc).edges.map((e) =>
          e.id === id ? { ...e, data: { ...(e.data as LinkData), ...patch } } : e,
        ),
      }),
      dirty: true,
    }));
  },

  reconnectEdge(id, which, nodeId, anchor) {
    const page = activePage(get().doc);
    const edge = page.edges.find((e) => e.id === id);
    if (!edge) return;
    const here = which === 'source' ? edge.source : edge.target;
    const other = which === 'source' ? edge.target : edge.source;
    if (nodeId === here || nodeId === other) return;
    if (!page.nodes.some((n) => n.id === nodeId)) return;
    get().commit('Move a link');
    set((s) => ({
      doc: withPage(s.doc, {
        edges: activePage(s.doc).edges.map((e) => {
          if (e.id !== id) return e;
          const data = { ...(e.data as LinkData) };
          if (which === 'source') {
            data.sourcePortLabel = '';
            data.sourceAnchor = anchor;
            data.sourcePortAt = undefined;
          } else {
            data.targetPortLabel = '';
            data.targetAnchor = anchor;
            data.targetPortAt = undefined;
          }
          // LT-176: dropped on one of the new device's connection points, the
          // end stays exactly there.
          if (anchor) data.pinnedSides = true;
          return { ...e, [which]: nodeId, data } as TopoEdge;
        }),
      }),
      dirty: true,
    }));
  },

  deleteSelected() {
    const { doc, selectedNodeId, selectedEdgeId } = get();
    const page = activePage(doc);
    get().commit();
    const selectedNodes = new Set(
      page.nodes.filter((n) => n.selected || n.id === selectedNodeId).map((n) => n.id),
    );
    const selectedEdges = new Set(
      page.edges.filter((e) => e.selected || e.id === selectedEdgeId).map((e) => e.id),
    );
    const lockedIds = new Set(
      page.nodes.filter((n) => (n.data as { locked?: boolean }).locked).map((n) => n.id),
    );
    const nodes = page.nodes.filter((n) => !selectedNodes.has(n.id) || lockedIds.has(n.id));
    const keptNodeIds = new Set(nodes.map((n) => n.id));
    const edges = page.edges.filter(
      (e) =>
        !selectedEdges.has(e.id) && keptNodeIds.has(e.source) && keptNodeIds.has(e.target),
    );
    const removed = new Set([...selectedNodes, ...selectedEdges]);
    set({
      doc: {
        ...withPage(doc, { nodes, edges }),
        probes: doc.probes.filter((p) => !removed.has(p.objectId)),
      },
      selectedNodeId: null,
      selectedEdgeId: null,
      dirty: true,
    });
  },

  select(nodeId, edgeId) {
    set({ selectedNodeId: nodeId, selectedEdgeId: edgeId });
  },

  upsertProbe(probe) {
    set((s) => {
      const existing = s.doc.probes.findIndex((p) => p.id === probe.id);
      const probes = [...s.doc.probes];
      if (existing >= 0) probes[existing] = probe;
      else probes.push(probe);
      // Exactly one primary per object.
      if (probe.isPrimary) {
        for (let i = 0; i < probes.length; i += 1) {
          const p = probes[i]!;
          if (p.objectId === probe.objectId && p.id !== probe.id && p.isPrimary) {
            probes[i] = { ...p, isPrimary: false };
          }
        }
      }
      return { doc: { ...s.doc, probes }, dirty: true };
    });
  },

  setProbeTiming(intervalSeconds, failureThreshold) {
    // Clamped rather than validated: the field is a number input, and a
    // interval of zero would spin a check as fast as the machine allows.
    const interval = Math.min(3600, Math.max(1, Math.round(intervalSeconds)));
    const threshold = Math.min(60, Math.max(1, Math.round(failureThreshold)));
    const probes = get().doc.probes;
    if (probes.length === 0) return 0;
    get().commit('Check timing');
    set((s) => ({
      doc: {
        ...s.doc,
        probes: s.doc.probes.map((p) => ({
          ...p,
          intervalSeconds: interval,
          failureThreshold: threshold,
        })),
      },
      dirty: true,
    }));
    return probes.length;
  },

  removeProbe(probeId) {
    set((s) => ({
      doc: { ...s.doc, probes: s.doc.probes.filter((p) => p.id !== probeId) },
      dirty: true,
    }));
  },

  probesFor(objectId) {
    return get().doc.probes.filter((p) => p.objectId === objectId);
  },

  nodeStatus(nodeId) {
    const { doc, runtime, session } = get();
    // Every page, not just the active one: a status can be asked for a
    // device on any page (the Monitored Objects table spans the whole
    // project), and monitoring does not depend on which page is on screen.
    const node = nodeById(doc, nodeId);
    const maintenance = Boolean((node?.data as DeviceNodeData | undefined)?.maintenance);
    if (session.state !== 'running' && !maintenance) {
      const probes = get().probesFor(nodeId);
      // Stopped means unknown, except where the operator disabled monitoring.
      if (probes.length > 0 && probes.every((p) => !p.enabled)) return 'disabled';
      return 'unknown';
    }
    return computeNodeStatus(get().probesFor(nodeId), runtime, maintenance);
  },

  linkStatus(edgeId) {
    const { doc, runtime, session } = get();
    const edge = edgeById(doc, edgeId);
    if (!edge) return 'unknown';
    const data = (edge.data ?? {}) as LinkData;
    return computeLinkStatus({
      link: {
        enabled: data.enabled ?? true,
        maintenance: data.maintenance ?? false,
        healthRule: data.healthRule ?? { type: 'manual' },
      },
      sourceStatus: get().nodeStatus(edge.source),
      targetStatus: get().nodeStatus(edge.target),
      linkProbes: doc.probes.filter((p) => p.objectId === edgeId),
      allProbes: doc.probes,
      runtime,
      sessionRunning: session.state === 'running',
    });
  },

  commit() {
    set((s) => ({
      past: [...s.past, snapshot(s.doc)].slice(-HISTORY_LIMIT),
      future: [],
    }));
  },

  undo() {
    const { past, doc } = get();
    const prev = past[past.length - 1];
    if (!prev) return;
    set({
      doc: { ...doc, ...prev },
      past: past.slice(0, -1),
      future: [snapshot(doc), ...get().future].slice(0, HISTORY_LIMIT),
      dirty: true,
    });
  },

  redo() {
    const { future, doc } = get();
    const next = future[0];
    if (!next) return;
    set({
      doc: { ...doc, ...next },
      future: future.slice(1),
      past: [...get().past, snapshot(doc)].slice(-HISTORY_LIMIT),
      dirty: true,
    });
  },

  async startValidation() {
    const { meta, doc } = get();
    if (!meta) return;
    set({ session: { ...get().session, state: 'starting' }, statusMessage: null });
    try {
      const probes = doc.probes
        .filter((p) => p.enabled && p.kind !== 'manual')
        .map((p) => ({ ...p, projectId: meta.id }));
      if (probes.length === 0) {
        set({
          session: { id: null, state: 'stopped', startedAt: null },
          statusMessage:
            'No enabled probes in this project. Add an ICMP, TCP or DNS target to a node or link first.',
        });
        return;
      }
      const info = await ipc.startValidation(meta.id, meta.engineer || 'operator', probes);
      set({
        session: { id: info.sessionId, state: 'running', startedAt: Date.now() },
        runtime: new Map(),
        recentSamples: new Map(),
        statusMessage: `Validating ${info.probeCount} target${info.probeCount === 1 ? '' : 's'} from this machine.`,
      });
    } catch (err) {
      set({
        session: { id: null, state: 'error', startedAt: null },
        statusMessage: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async stopValidation() {
    set({ session: { ...get().session, state: 'stopping' } });
    try {
      await ipc.stopValidation();
    } catch (err) {
      // LT-491: the engine stops its probes before anything here can fail —
      // what fails is closing the session's row. Stopped is the truth either
      // way, so it is said, not thrown at whoever pressed Stop or Close.
      set({ statusMessage: `Validation stopped, but: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      set({
        session: { id: null, state: 'stopped', startedAt: null },
        runtime: new Map(),
        recentSamples: new Map(),
      });
    }
  },

  applyEngineEvent(payload) {
    const p = payload as {
      kind: string;
      result?: {
        probeId: string;
        rttMs: number | null;
        summary: string;
        timestampMs: number;
        outcome: string;
      };
      status?: HealthStatus;
      transition?: {
        probeId: string;
        objectKind: 'node' | 'link';
        objectId: string;
        timestampMs: number;
        previous: HealthStatus;
        current: HealthStatus;
        message: string;
      };
      state?: SessionState;
    };

    // LT-491: an event belongs to the run that sent it. Samples the engine
    // had already sent when Stop was pressed arrive after the page has reset,
    // and applying them relit the diagram as if nothing had stopped. Only the
    // run in progress is listened to; once stopped, nothing moves it back.
    const raw = payload as { session_id?: string; sessionId?: string };
    const from = raw.session_id ?? raw.sessionId ?? null;
    const current = get().session;
    const live = current.state === 'running' || current.state === 'starting';
    const ours = from === null || current.id === null || from === current.id;
    if ((p.kind === 'sample' || p.kind === 'transition') && (!live || !ours)) return;
    if (p.kind === 'sessionState' && (current.state === 'stopped' || current.id === null || from !== current.id)) return;

    if (p.kind === 'sample' && p.result) {
      const r = p.result;
      set((s) => {
        const runtime = new Map(s.runtime);
        const prev = runtime.get(r.probeId);
        const cfg = s.doc.probes.find((x) => x.id === r.probeId);
        runtime.set(r.probeId, {
          probeId: r.probeId,
          status: p.status ?? 'unknown',
          lastRttMs: r.rttMs,
          lastSuccessMs: r.outcome === 'success' ? r.timestampMs : (prev?.lastSuccessMs ?? null),
          lastFailureMs: r.outcome !== 'success' ? r.timestampMs : (prev?.lastFailureMs ?? null),
          lastSummary: r.summary,
          consecutiveFailures:
            r.outcome === 'success' ? 0 : (prev?.consecutiveFailures ?? 0) + 1,
          failureThreshold: cfg?.failureThreshold ?? 3,
        });
        // LT-224: the live sparkline's window.
        const recentSamples = new Map(s.recentSamples);
        const list = [...(recentSamples.get(r.probeId) ?? []), { timestampMs: r.timestampMs, status: p.status ?? 'unknown', rttMs: r.rttMs }];
        recentSamples.set(r.probeId, list.slice(-RECENT_SAMPLES));
        return { runtime, recentSamples };
      });
    }

    if (p.kind === 'transition' && p.transition) {
      const t = p.transition;
      const { meta, doc, session } = get();
      if (!meta) return;
      const probe = doc.probes.find((x) => x.id === t.probeId);
      const objectName =
        t.objectKind === 'node'
          ? ((allNodes(doc).find((n) => n.id === t.objectId)?.data as DeviceNodeData | undefined)
              ?.label ?? t.objectId)
          : linkName(get(), t.objectId);
      const row: EventRow = {
        id: uid(),
        projectId: meta.id,
        sessionId: session.id,
        timestampMs: t.timestampMs,
        objectType: t.objectKind,
        objectId: t.objectId,
        objectName,
        eventType: 'transition',
        previousStatus: t.previous,
        currentStatus: t.current,
        probeType: probe?.kind ?? null,
        target: probe?.target ?? null,
        rttMs: get().runtime.get(t.probeId)?.lastRttMs ?? null,
        message: t.message,
      };
      set((s) => ({ events: [row, ...s.events].slice(0, 5000) }));
      void ipc.recordEvent(row);
    }

    if (p.kind === 'sessionState' && p.state) {
      set((s) => ({ session: { ...s.session, state: p.state! } }));
    }
  },

  async testNow(probe) {
    return ipc.testProbeNow(probe);
  },

  async loadEvents() {
    const meta = get().meta;
    if (!meta) return;
    set({ events: await ipc.listEvents(meta.id) });
  },

  setTerminalSettings(patch) {
    set((s) => ({ settings: { ...s.settings, terminal: { ...s.settings.terminal, ...patch } } }));
    // Written through one key at a time, the way every other stored setting
    // is, so nothing has to parse a blob back out on the next start.
    const keys: Record<keyof TerminalSettings, keyof StoredSettings> = {
      fontFamily: 'sshFontFamily',
      fontSize: 'sshFontSize',
      colourise: 'sshColourise',
      keepaliveSeconds: 'sshKeepaliveSeconds',
      logByDefault: 'sshLogByDefault',
      openWith: 'sshOpenWith',
      externalCommand: 'sshExternalCommand',
      copyOnSelect: 'sshCopyOnSelect',
      pasteOnRight: 'sshPasteOnRight',
    };
    for (const [key, value] of Object.entries(patch)) {
      const stored = keys[key as keyof TerminalSettings];
      if (stored) void ipc.setSetting(stored, String(value)).catch(() => undefined);
    }
  },

  setSettings(patch) {
    if (patch.minimap !== undefined) rememberView('minimap', patch.minimap);
    // LT-242: a machine preference, kept like the others.
    if (patch.highContrast !== undefined) rememberView('highContrast', patch.highContrast);
    if (patch.uiScale !== undefined) {
      try {
        localStorage.setItem('coreview.view.uiScale', String(patch.uiScale));
      } catch {
        /* private mode — the choice lasts this session */
      }
    }
    if (patch.dockSide !== undefined) {
      try {
        localStorage.setItem('coreview.view.dockSide', patch.dockSide);
      } catch {
        /* private mode — the choice lasts this session */
      }
    }
    if (patch.registerHiddenColumns !== undefined) {
      try {
        localStorage.setItem('coreview.view.registerHiddenColumns', JSON.stringify(patch.registerHiddenColumns));
      } catch {
        /* private mode — the choice lasts this session */
      }
    }
    if (patch.timeFormat !== undefined) {
      try {
        localStorage.setItem('coreview.view.timeFormat', patch.timeFormat);
      } catch {
        /* private mode — the choice lasts this session */
      }
    }
    set((s) => ({ settings: { ...s.settings, ...patch } }));
  },

  /** Reads the folders back from the database on startup. Without this they
   *  would have to be re-picked every session, which is the whole point of
   *  storing them. */
  async loadSettings() {
    const stored = await ipc.getSettings();
    set((s) => ({
      settings: {
        ...s.settings,
        backupFolder: stored.backupFolder ?? null,
        exportFolder: stored.exportFolder ?? null,
        terminal: terminalFromStored(stored, s.settings.terminal),
      },
      iconLibraryDir: stored.iconLibraryDir ?? s.iconLibraryDir,
    }));
    if (stored.iconLibraryDir) {
      // Re-index the folder rather than trusting a remembered list: the icons
      // live outside the app and may have changed since last time.
      void get().loadIconLibrary(stored.iconLibraryDir);
    }
    // The built-in shapes (D-022). Quietly absent in the browser and in a
    // build without the resource; the palette then simply has no built-in
    // section rather than an error nobody can act on.
    if (get().bundledIcons.length === 0) {
      try {
        const bundled = await ipc.listBundledIcons();
        if (bundled.icons.length) set({ bundledIcons: bundled.icons });
      } catch {
        /* no bundled set here */
      }
    }
    try {
      set({ stencilPacks: await ipc.listStencilPacks() });
    } catch {
      /* no packs to manage here */
    }
  },

  async removeStencilPack(name) {
    const outcome = await ipc.removeStencilPack(name);
    const [bundled, packs] = await Promise.all([
      ipc.listBundledIcons(),
      ipc.listStencilPacks(),
    ]);
    set({ bundledIcons: bundled.icons, stencilPacks: packs });
    // The pack is gone from the palette either way. Whether the disk space
    // came back is a separate question, and worth a straight answer: an app
    // installed where the person running it cannot write — /Applications,
    // Program Files — cannot delete its own resources.
    get().setStatusMessage(
      outcome.deleted
        ? `Removed the ${name} stencil pack and freed the space it used.`
        : `Removed the ${name} stencil pack from the palette. Its files could not be deleted, so the space is still used — the app is installed somewhere it cannot write to.`,
    );
  },

  saveCustomShape(nodeId, name) {
    const node = allNodes(get().doc).find((n) => n.id === nodeId);
    if (!node || node.type !== 'device') return;
    const d = node.data as DeviceNodeData;
    const status = get().nodeStatus(nodeId);
    const auto = computeDeviceColor(d.deviceType, status, get().settings.ground);
    const svg = svgForDevice(d, auto);
    get().commit('Save shape');
    set((s) => ({
      doc: {
        ...s.doc,
        customShapes: [
          ...(s.doc.customShapes ?? []),
          // LT-170: a capture of a built-in glyph is Coreview's own artwork;
          // a capture of an imported picture is still someone else's.
          {
            id: uid(),
            name: name.trim() || d.label,
            category: 'Custom',
            svg,
            ...(!d.imageDataUrl || d.ownArtwork ? { own: true } : {}),
          },
        ],
      },
      dirty: true,
    }));
  },

  removeCustomShape(id) {
    get().commit('Remove shape');
    set((s) => ({
      doc: { ...s.doc, customShapes: (s.doc.customShapes ?? []).filter((c) => c.id !== id) },
      dirty: true,
    }));
  },

  /** Opens the folder picker, checks the folder can actually be written to,
   *  and stores it. Returns the chosen path, or null if cancelled. */
  async chooseFolder(which) {
    const label = which === 'backupFolder' ? 'Choose a folder for configuration backups' : 'Choose a folder for exports';
    const current = get().settings[which] ?? undefined;
    const picked = await ipc.pickFolder(label, current);
    if (!picked) return null;
    try {
      await ipc.checkFolderWritable(picked);
    } catch (err) {
      set({ statusMessage: err instanceof Error ? err.message : String(err) });
      return null;
    }
    await ipc.setSetting(which, picked);
    set((s) => ({ settings: { ...s.settings, [which]: picked } }));
    return picked;
  },

  async clearFolder(which) {
    await ipc.setSetting(which, null);
    set((s) => ({ settings: { ...s.settings, [which]: null } }));
  },

  /** Index a folder of SVGs and expose them in the palette.
   *  Desktop only: in browser mode there is no filesystem access. */
  async loadIconLibrary(dir: string) {
    if (!isDesktop) {
      set({ iconLibraryError: 'An icon library needs the desktop app.' });
      return;
    }
    try {
      const lib = await ipc.listIconLibrary(dir);
      set({
        iconLibrary: lib.icons,
        iconLibraryDir: lib.dir,
        iconLibraryError: lib.skipped.length
          ? `${lib.icons.length} loaded, ${lib.skipped.length} skipped: ${lib.skipped.slice(0, 3).join('; ')}`
          : null,
      });
      // Into the database, which is where loadSettings reads it back from on
      // startup. This wrote to localStorage, which nothing has ever read, so
      // the folder had to be typed in again every session even though the
      // backend has stored the key and re-indexed on startup all along.
      try {
        await ipc.setSetting('iconLibraryDir', lib.dir);
      } catch {
        /* the icons still loaded; only remembering the folder failed */
      }
    } catch (e) {
      set({ iconLibrary: [], iconLibraryError: String(e) });
    }
  },

  /** Forget the library folder: empty the palette section and clear the
   *  stored setting, so the app stops re-indexing it on startup and the
   *  folder input comes back. Nothing on disk is touched — the icons were
   *  never copied in. */
  async clearIconLibrary() {
    set({ iconLibrary: [], iconLibraryDir: null, iconLibraryError: null });
    try {
      await ipc.setSetting('iconLibraryDir', null);
    } catch {
      /* cleared for this session even where forgetting it failed */
    }
  },

  setDefaultLinkStyle(style) {
    // Written to every page, not just the one in front of you. The canvas is
    // per page and that is right for a grid or a set of views, but the default
    // look of a link belongs to the diagram — a project whose second page
    // draws links differently from its first is not something anyone asked
    // for, and is what made this setting look as though it did nothing.
    set((s) => ({
      doc: {
        ...s.doc,
        pages: s.doc.pages.map((p) => ({ ...p, canvas: { ...p.canvas, linkStyle: style } })),
      },
      dirty: true,
    }));
  },

  setCanvas(patch) {
    set((s) => ({
      doc: withPage(s.doc, { canvas: { ...activePage(s.doc).canvas, ...patch } }),
      dirty: true,
    }));
  },

  setPanelOpen(open) {
    rememberView('panelOpen', open);
    set({ panelOpen: open });
  },

  setPaletteOpen(open) {
    rememberView('paletteOpen', open);
    set({ paletteOpen: open });
  },

  setInspectorOpen(open) {
    rememberView('inspectorOpen', open);
    set({ inspectorOpen: open });
  },

  setStatusMessage(msg) {
    set({ statusMessage: msg });
  },
}));

function linkName(state: Store, edgeId: string): string {
  const edge = allEdges(state.doc).find((e) => e.id === edgeId);
  if (!edge) return edgeId;
  const label = (n?: TopoNode) => (n?.data as DeviceNodeData | undefined)?.label ?? '?';
  const nodes = allNodes(state.doc);
  const src = label(nodes.find((n) => n.id === edge.source));
  const dst = label(nodes.find((n) => n.id === edge.target));
  return `${src} ↔ ${dst}`;
}

// LT-062: a check added, changed or removed while validation runs reaches
// the engine without a stop/start. Watching the store beats wiring every
// mutation site: undo, restore and bulk edits all funnel through here too.
// Debounced so a burst of edits lands as one push; the engine diffs.
let probeSync: ReturnType<typeof setTimeout> | null = null;
let lastSyncedProbes: unknown = null;
useStore.subscribe((s) => {
  if (s.session.state !== 'running') {
    lastSyncedProbes = s.doc.probes;
    return;
  }
  if (s.doc.probes === lastSyncedProbes) return;
  lastSyncedProbes = s.doc.probes;
  if (probeSync) clearTimeout(probeSync);
  probeSync = setTimeout(() => {
    const { session, doc, meta } = useStore.getState();
    if (session.state !== 'running' || !meta) return;
    const probes = doc.probes
      .filter((p) => p.enabled && p.kind !== 'manual')
      .map((p) => ({ ...p, projectId: meta.id }));
    void ipc
      .updateValidation(probes)
      .then((info) => {
        useStore.setState({
          statusMessage: `Validating ${info.probeCount} target${info.probeCount === 1 ? '' : 's'} from this machine.`,
        });
      })
      .catch((err) => {
        useStore.setState({
          statusMessage: err instanceof Error ? err.message : String(err),
        });
      });
  }, 400);
});

// The Playwright harness cannot start a real validation session — that needs
// the Tauri backend — so in dev the store is reachable from the page and the
// harness stages session state directly. Never present in a build.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __cvStore: typeof useStore }).__cvStore = useStore;
}
