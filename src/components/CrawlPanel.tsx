import { useEffect, useMemo, useRef, useState } from 'react';

import { useStore } from '../state/store';
import {
  ipc,
  isDesktop,
  type CrawlDetails,
  type CrawlEvent,
  type CrawledDevice,
  type CrawlFailure,
  type CrawlResult,
  type DeviceClassName,
  type Neighbor,
  type SnmpInput,
  type StoredSettings,
} from '../lib/ipc';
import { CredentialPicker, SavedCredentialSelect } from './CredentialPicker';
import { bindingsFor, ruleProblem, type CredentialRule } from '../lib/credentialBindings';
import { uid } from '../lib/id';
import { seedsFromCsv } from '../lib/seeds';
import { discoverySuggestions } from '../lib/discoverySuggestions';
import { dryRun, inCidr, ipToInt, parseCidr, type DryRunPlan } from '../lib/dryRun';
import { reconcile, type Change } from '../lib/reconcile';
import type { TopoNode } from '../state/store';
import { readProfile, type CrawlProfile } from '../lib/crawlProfiles';
import { crawlFindings, FINDING_LABEL, type DrawnLink } from '../lib/crawlFindings';
import { allEdges, allNodes } from '../lib/pages';
import { reduceCrawlTable, stateCounts, STATE_LABEL, tableRows, type CrawlTable } from '../lib/crawlTable';
import { SubnetList } from './SubnetList';
import { failureAdvice, failureHeading, reasonWithoutAddress } from '../lib/failures';
import { newProbe } from '../lib/probes';
import { buildTopology } from '../lib/topology';
import { ChangeReport } from './ChangeReport';
import { selectAttached, vendorCounts } from '../lib/attached';
import type { DeviceNodeData } from '../types/domain';
import { activePage } from '../lib/pages';

const CLASS_LABEL: Record<DeviceClassName, string> = {
  router: 'Router',
  switch: 'Switch',
  firewall: 'Firewall',
  'wireless-controller': 'Wireless controller',
  'access-point': 'Access point',
  phone: 'Phone',
  camera: 'Camera',
  printer: 'Printer',
  server: 'Server',
  endpoint: 'Endpoint',
  unknown: 'Unknown',
};

/** The glyphs the canvas already knows, keyed by discovered class. */
/** Classes the crawl logs into by default. */
const INFRASTRUCTURE: DeviceClassName[] = ['router', 'switch', 'firewall', 'wireless-controller'];

/** Everything that can be ticked as somewhere to log in to. Phones, printers
 *  and cameras are on the list because someone may genuinely want to, not
 *  because it is a good idea by default. */
const LOGIN_CHOICES: { value: DeviceClassName; label: string }[] = [
  { value: 'router', label: 'Routers' },
  { value: 'switch', label: 'Switches' },
  { value: 'firewall', label: 'Firewalls' },
  { value: 'wireless-controller', label: 'WLCs' },
  { value: 'access-point', label: 'Access points' },
  { value: 'server', label: 'Servers' },
  { value: 'printer', label: 'Printers' },
  { value: 'camera', label: 'Cameras' },
  { value: 'phone', label: 'Phones' },
  { value: 'endpoint', label: 'Endpoints' },
  { value: 'unknown', label: 'Unclassified' },
];

/** One row of the results list: something reached, or something merely seen. */
type Row = {
  key: string;
  name: string;
  address: string;
  probeTarget: string;
  klass: DeviceClassName;
  platform: string | null;
  reached: boolean;
  /** How the device answered, so the table never overstates what is known. */
  via: 'ssh' | 'snmp' | 'reported' | null;
  picked: boolean;
};

/**
 * Discover, then filter, then build — in that order and as three visible steps.
 *
 * A crawl of a real network finds far more than anyone wants to draw. Nothing
 * reaches the canvas until it has passed a filter the user set, and the filter
 * is applied here rather than during the crawl so changing your mind costs a
 * click instead of another walk of the estate.
 */
/** One SNMP credential the operator has entered or picked (LT-142). */
type SnmpRow = {
  key: string;
  version: 'v2c' | 'v3';
  community: string;
  user: string;
  auth: string;
  authPass: string;
  priv: string;
  privPass: string;
  /** Set when this row is a saved credential rather than a typed one. */
  credentialId: string | null;
};

/** What of an SNMP row may be written to the plain-text settings table.
 *
 *  **Never a community string and never a passphrase.** Those are secrets,
 *  they live in the encrypted vault, and the only thing that crosses into
 *  settings is the id of the credential holding them. The operator asked for
 *  this in as many words and D-006 has always required it. */
export function snmpRowsShape(rows: SnmpRow[]): string {
  return JSON.stringify(
    rows.map((r) => ({
      version: r.version,
      user: r.user,
      auth: r.auth,
      priv: r.priv,
      credentialId: r.credentialId,
    })),
  );
}

/** Rebuilds rows from what was saved, with every secret field left empty. */
export function restoreSnmpRows(stored: string): SnmpRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      ...blankSnmpRow(),
      version: r.version === 'v3' ? ('v3' as const) : ('v2c' as const),
      user: typeof r.user === 'string' ? r.user : '',
      auth: typeof r.auth === 'string' ? r.auth : 'sha',
      priv: typeof r.priv === 'string' ? r.priv : 'aes 256',
      credentialId: typeof r.credentialId === 'string' ? r.credentialId : null,
    };
  });
}

let snmpRowSeq = 0;
function blankSnmpRow(): SnmpRow {
  snmpRowSeq += 1;
  return {
    key: `snmp-${snmpRowSeq}`,
    version: 'v2c',
    community: '',
    user: '',
    auth: 'sha',
    authPass: '',
    priv: 'aes 256',
    privPass: '',
    credentialId: null,
  };
}

/** The rows that are complete enough to be worth sending.
 *
 *  Half a v3 user fails on every device with an error that looks like the
 *  devices are at fault, so an incomplete row is dropped rather than tried.
 *  Pure, so the rule is tested without a form. */
export function snmpRowsForRun(rows: SnmpRow[]): {
  typed: SnmpInput[];
  savedIds: string[];
} {
  const typed: SnmpInput[] = [];
  const savedIds: string[] = [];
  for (const r of rows) {
    if (r.credentialId) {
      savedIds.push(r.credentialId);
      continue;
    }
    if (r.version === 'v2c') {
      if (r.community.trim()) typed.push({ version: 'v2c', community: r.community.trim() });
      continue;
    }
    if (!r.user.trim() || !r.authPass) continue;
    typed.push({
      version: 'v3',
      username: r.user.trim(),
      authProtocol: r.auth,
      authPassword: r.authPass,
      privacy: r.priv || undefined,
      privacyPassword: r.privPass,
    });
  }
  return { typed, savedIds };
}

export function CrawlPanel({
  onBackup,
}: {
  /** Hands devices to the Backups tab, which owns the credentials and the
   *  folder. Duplicating the backup form here would mean two places to keep
   *  right. */
  onBackup: (targets: { address: string; name: string }[]) => void;
}) {
  const store = useStore();
  const [seed, setSeed] = useState('');
  const [subnets, setSubnets] = useState<string[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [enablePassword, setEnablePassword] = useState('');
  const [secondFactor, setSecondFactor] = useState(false);
  // The seed as it was when the run started, for the stored crawl (LT-227).
  const seedRef = useRef('');
  // LT-200–204: the tables beyond neighbours, each a command or two a device.
  const [details, setDetails] = useState<CrawlDetails>({ routes: true, spanningTree: true, vlans: true });
  // LT-206.
  const [reverseDns, setReverseDns] = useState(true);
  // LT-210: where each device is, live.
  const [table, setTable] = useState<CrawlTable>(new Map());
  // LT-211: the plan a run would follow, worked out with nothing sent.
  const [plan, setPlan] = useState<DryRunPlan | null>(null);
  // LT-216: a crawl's changes, waiting to be accepted.
  const [review, setReview] = useState<{ changes: Change[]; ticked: Set<string>; dangling: number } | null>(null);
  // LT-208.
  const [concurrency, setConcurrency] = useState(4);
  const [perHost, setPerHost] = useState(300);
  const [retries, setRetries] = useState(1);
  const [port, setPort] = useState(22);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [maxHops, setMaxHops] = useState(4);
  const [preference, setPreference] = useState<'loopback' | 'management' | 'first'>('loopback');
  // SNMP is optional and only used where SSH is refused, so it lives behind a
  // disclosure rather than adding six more fields to the main row.
  const [snmpOpen, setSnmpOpen] = useState(false);
  // LT-142: a list, not one. A real estate answers several ways — a Catalyst
  // on v3 with SHA and AES-256, older kit on v2c with a community — and one
  // credential means a crawl that identifies a fraction of what it could.
  const [snmpRows, setSnmpRows] = useState<SnmpRow[]>([blankSnmpRow()]);

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  // Written only by the final result, never by the event stream. The two
  // arrive on separate channels with no ordering between them, so letting both
  // write produced a list that disagreed with its own count.
  const [failures, setFailures] = useState<CrawlFailure[]>([]);
  // Live count while the crawl runs, so failures are visible before it ends.
  const [liveFailed, setLiveFailed] = useState(0);

  // Chosen before the run: the classes the crawl is allowed to log into.
  // Everything discovered is drawn either way — this only decides what gets a
  // connection attempt, which is what sets off intrusion alerts.
  const [loginClasses, setLoginClasses] = useState<DeviceClassName[]>(INFRASTRUCTURE);
  const [transport, setTransport] = useState<'ssh' | 'telnet' | 'sshThenTelnet'>('ssh');
  // Silent devices — the ones that announce nothing — are drawn only when
  // asked for. A flat /24 can hold two hundred, and drawing them all buries
  // the topology the diagram exists to show.
  const [showAttached, setShowAttached] = useState(false);
  const [attachedVendor, setAttachedVendor] = useState('');
  const [attachedSubnet, setAttachedSubnet] = useState('');
  const [attachedPort, setAttachedPort] = useState('');
  const [singlePortOnly, setSinglePortOnly] = useState(true);
  // A second login, tried only where the first is rejected.
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupUsername, setBackupUsername] = useState('');
  const [backupPassword, setBackupPassword] = useState('');
  const [backupEnable, setBackupEnable] = useState('');
  const [result, setResult] = useState<{ devices: CrawledDevice[]; notVisited: Neighbor[] } | null>(
    null,
  );

  // Filter, applied after the crawl.
  const [classes, setClasses] = useState<DeviceClassName[]>([]);
  const [search, setSearch] = useState('');

  // LT-135: a scan is set up once and repeated. Everything here is what the
  // run was *shaped* like — never a password: those stay in the vault and are
  // referenced by id. Loaded once on mount; `restored` keeps the save effect
  // below from writing empty defaults over what was just read.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void ipc
      .getSettings()
      .then((st) => {
        if (cancelled) return;
        if (st.scanSeed) setSeed(st.scanSeed);
        if (st.scanSubnets) setSubnets(st.scanSubnets.split(',').filter(Boolean));
        if (st.scanPort) setPort(Number(st.scanPort) || 22);
        if (st.scanMaxHops) setMaxHops(Number(st.scanMaxHops) || 4);
        // LT-292: what *this project* keeps wins over the machine-wide
        // setting. The setting is one scan's shape for whoever opens the app;
        // the project's credentials belong to the estate it describes, and a
        // second project must not start with the first one's login.
        const kept = useStore.getState().doc.credentialDefaults;
        if (kept?.ssh) setCredentialId(kept.ssh);
        else if (st.scanCredentialId) setCredentialId(st.scanCredentialId);

        const keptSnmp = kept?.snmp ?? [];
        if (keptSnmp.length) {
          setSnmpRows(keptSnmp.map((id) => ({ ...blankSnmpRow(), credentialId: id })));
          setSnmpOpen(true);
        } else if (st.scanSnmpRows) {
          const restored = restoreSnmpRows(st.scanSnmpRows);
          if (restored.length) {
            setSnmpRows(restored);
            setSnmpOpen(true);
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setRestored(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Saved as it is changed rather than on scan, so a run that is set up and
  // then abandoned is still there tomorrow.
  useEffect(() => {
    if (!restored) return;
    const save: [keyof StoredSettings, string | null][] = [
      ['scanSeed', seed.trim() || null],
      ['scanSubnets', subnets.length ? subnets.join(',') : null],
      ['scanPort', String(port)],
      ['scanMaxHops', String(maxHops)],
      ['scanCredentialId', credentialId],
      ['scanSnmpRows', snmpOpen ? snmpRowsShape(snmpRows) : null],
    ];
    for (const [key, value] of save) void ipc.setSetting(key, value).catch(() => {});
  }, [restored, seed, subnets, port, maxHops, credentialId, snmpOpen, snmpRows]);

  const seenKeys = useRef<Set<string>>(new Set());

  useEffect(() => {
    let offEvent: (() => void) | undefined;
    let offResult: (() => void) | undefined;

    void ipc
      .onCrawlEvent((e: CrawlEvent) => {
        // LT-210: every event also moves a row of the live table.
        setTable((t) => reduceCrawlTable(t, e));
        switch (e.kind) {
          case 'started':
            setStatus(`Walking the network from ${e.seed}…`);
            break;
          case 'ssh': {
            // LT-278: the progress is nested; before, this read fields off a
            // flattened event that never arrived under this kind.
            const p = e.progress;
            if (p.kind === 'awaitingSecondFactor') {
              // A push is pending. The one status that has to shout: without
              // it, waiting for Duo looks exactly like a hang.
              setPushMessage(p.message);
            } else if (p.kind === 'connecting') {
              setStatus(`Connecting to ${p.host}…`);
            }
            break;
          }
          case 'reached':
            setPushMessage(null);
            setStatus(`Reached ${e.hostname} (${e.address})`);
            break;
          case 'failed':
            setLiveFailed((n) => n + 1);
            setStatus(
              `${e.failure.address} could not be reached — ${reasonWithoutAddress(e.failure.address, e.failure.reason)}`,
            );
            break;
          case 'finished':
            setRunning(false);
            setPushMessage(null);
            setStatus(
              e.cancelled
                ? `Stopped — reached ${e.reached}, ${e.failed} failed`
                : `Reached ${e.reached} device${e.reached === 1 ? '' : 's'}, ${e.failed} failed`,
            );
            break;
        }
      })
      .then((f) => {
        offEvent = f;
      });

    void ipc
      .onCrawlResult((r: CrawlResult) => {
        // LT-227: every crawl is kept, so two can be compared later.
        const pid = useStore.getState().meta?.id;
        if (pid) void ipc.saveCrawlRun(pid, seedRef.current, r).catch(() => {});
        const next = resultRows(r, seenKeys.current);
        setRows((prev) => [...prev, ...next]);
        setFailures(r.failures);
        // The adjacencies live here and nowhere else. Flattening to rows threw
        // away who is plugged into what, which is why the built diagram used
        // to be a grid of unconnected boxes.
        setResult({ devices: r.devices, notVisited: r.notVisited });
      })
      .then((f) => {
        offResult = f;
      });

    return () => {
      offEvent?.();
      offResult?.();
    };
  }, []);

  /** LT-246: saved snmpwalk files, one device each, read into the table as if
   *  a crawl had reached them over SNMP. Nothing is contacted. */
  const readWalks = async (files: File[]) => {
    setProblem(null);
    const devices: CrawledDevice[] = [];
    const notes: string[] = [];
    for (const file of files) {
      try {
        const r = await ipc.readSnmpWalk(await file.text());
        if (r.device) devices.push(r.device);
        for (const p of r.problems) notes.push(`${file.name}: ${p}`);
        if (r.unknownRows > 0) notes.push(`${file.name}: ${r.unknownRows} rows named by MIBs this does not read (${r.unknownNames.slice(0, 3).join(', ')}${r.unknownNames.length > 3 ? '…' : ''}) — walk with -On to keep everything.`);
      } catch (e) {
        notes.push(`${file.name}: ${String(e)}`);
      }
    }
    const names = new Set(devices.map((d) => d.hostname.toLowerCase()));
    const heard = new Map<string, Neighbor>();
    for (const d of devices) for (const n of d.neighbors) if (!names.has(n.shortName.toLowerCase())) heard.set(n.shortName.toLowerCase(), n);
    const walked = { devices, notVisited: [...heard.values()] };
    seenKeys.current = new Set();
    setRows(resultRows(walked, seenKeys.current));
    setFailures([]);
    setResult(walked);
    const read = `Read ${devices.length} device${devices.length === 1 ? '' : 's'} from ${files.length} walk file${files.length === 1 ? '' : 's'}${walked.notVisited.length ? `, and ${walked.notVisited.length} neighbour${walked.notVisited.length === 1 ? '' : 's'} they report` : ''}.`;
    setStatus(read);
    if (notes.length) setProblem(`${read} ${notes.join(' ')}`);
  };

  /** Only sends SNMP credentials when they are complete enough to work. */
  const snmpForRun = () =>
    snmpOpen ? snmpRowsForRun(snmpRows) : { typed: [], savedIds: [] };

  const start = async () => {
    setProblem(null);
    setRows([]);
    setFailures([]);
    setLiveFailed(0);
    setPushMessage(null);
    seenKeys.current = new Set();
    setResult(null);
    setRunning(true);
    seedRef.current = seed.trim();
    try {
      await ipc.startCrawl(
        {
          seed: seed.trim(),
          subnets,
          crawlClasses: loginClasses,
          maxHops,
          maxDevices: 500,
          secondFactor,
          addressPreference: preference,
          port,
          transport,
          snmp: snmpForRun().typed,
          credentialId: credentialId ?? undefined,
          // The backend has taken saved SNMP credentials by id all along;
          // nothing ever sent one, so the vault's SNMP half was unreachable
          // from a crawl (LT-135). The passphrases are fetched inside Rust
          // and never travel through the interface.
          snmpCredentialIds: snmpForRun().savedIds,
          details,
          reverseDns,
          concurrency,
          perHostTimeoutSecs: perHost,
          retries,
          // LT-199, LT-209: vault ids only; Rust opens them.
          bindings: bindingsFor(useStore.getState().doc),
        },
        { username, password, enablePassword: enablePassword || undefined },
        backupUsername.trim()
          ? [
              {
                username: backupUsername.trim(),
                password: backupPassword,
                enablePassword: backupEnable || undefined,
              },
            ]
          : undefined,
      );
    } catch (err) {
      setRunning(false);
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  const counts = useMemo(() => {
    const by = new Map<DeviceClassName, number>();
    rows.forEach((r) => by.set(r.klass, (by.get(r.klass) ?? 0) + 1));
    return [...by.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (classes.length && !classes.includes(r.klass)) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.address.includes(q) ||
        (r.platform ?? '').toLowerCase().includes(q)
      );
    });
  }, [rows, classes, search]);

  const picked = visible.filter((r) => r.picked);

  /** Only what was logged into can be backed up: a device seen by a neighbour
   *  has not proved it will accept a session, and one found over SNMP has
   *  proved it will not. */
  const backupable = picked.filter((r) => r.via === 'ssh');

  const backUp = () => {
    if (!backupable.length) return;
    store.setStatusMessage(
      `Sending ${backupable.length} device${backupable.length === 1 ? '' : 's'} to the Backups tab`,
    );
    onBackup(backupable.map((r) => ({ address: r.probeTarget || r.address, name: r.name })));
  };

  const toggleClass = (c: DeviceClassName) =>
    setClasses((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  const toggleRow = (key: string) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, picked: !r.picked } : r)));
  const setAllVisible = (picked: boolean) => {
    const keys = new Set(visible.map((v) => v.key));
    setRows((prev) => prev.map((r) => (keys.has(r.key) ? { ...r, picked } : r)));
  };

  /**
   * Builds the diagram from the crawl.
   *
   * Not from the rows: those are a flattened list and know nothing about who
   * is plugged into what. The result carries every device's neighbours with
   * the port at each end, which is what makes this a diagram rather than a
   * grid of boxes.
   */
  const attachedFilter = useMemo(
    () => ({
      vendor: attachedVendor,
      subnet: attachedSubnet,
      port: attachedPort,
      // A port carrying several addresses leads to another switch, and what
      // is behind it belongs to that switch rather than this one.
      maxPerPort: singlePortOnly ? 1 : undefined,
    }),
    [attachedVendor, attachedSubnet, attachedPort, singlePortOnly],
  );
  const chosenAttached = useMemo(
    () => (result ? selectAttached(result.devices, attachedFilter) : []),
    [result, attachedFilter],
  );
  const makers = useMemo(() => (result ? vendorCounts(result.devices) : []), [result]);
  const attachedTotal = useMemo(
    () => (result ? selectAttached(result.devices, {}).length : 0),
    [result],
  );

  const build = () => {
    if (!result || !store.meta) return;
    const keep = new Set(picked.map((r) => r.key.toLowerCase()));
    const page = activePage(store.doc);
    const bottom = page.nodes.reduce((m, n) => Math.max(m, n.position.y + 120), 0);

    const topo = buildTopology(result, store.meta.id, {
      origin: { x: 80, y: bottom + 80 },
      attached: showAttached ? chosenAttached : [],
      // A second crawl updates the diagram rather than drawing another copy
      // of the network beside it, so re-running discovery is something you can
      // do weekly instead of once. Scoped to the active page (LT-094).
      existingNodes: page.nodes,
      existingEdges: page.edges,
      // LT-215: cables on the Physical view, layer-3 hops on the Logical one,
      // where the page has them.
      views: {
        physical: (page.canvas.layers ?? []).find((l) => l.name.toLowerCase() === 'physical')?.id,
        logical: (page.canvas.layers ?? []).find((l) => l.name.toLowerCase() === 'logical')?.id,
      },
    });

    // The ticks in the table decide what is placed. Matching on the drawn
    // label keeps that honest without the builder having to know about rows.
    const wanted = (n: TopoNode) =>
      keep.size === 0 || keep.has(String((n.data as DeviceNodeData).label).toLowerCase());

    // LT-216: nothing is written yet. The crawl's changes are listed for
    // review — additions and updates ticked, removals and moves not — and
    // only what is accepted is applied, as one undo step.
    const limits = subnets.map(parseCidr).filter((c): c is NonNullable<typeof c> => c !== null);
    const inScope = limits.length
      ? (address: string) => {
          const ip = ipToInt(address);
          return ip !== null && limits.some((c) => inCidr(ip, c));
        }
      : null;
    const changes = reconcile({ page, topo, devices: result.devices, inScope })
      .filter((c) => !(c.kind === 'added' && c.subject === 'device' && c.addNodes?.some((n) => !wanted(n))))
      // A link to a device left unticked in the table has nowhere to land.
      .filter((c) => !(c.kind === 'added' && c.subject === 'link' && c.addEdges?.some((e) => !page.nodes.some((n) => n.id === e.source) && !topo.nodes.some((n) => n.id === e.source && wanted(n)))));
    setReview({ changes, ticked: new Set(changes.filter((c) => c.accept).map((c) => c.id)), dangling: topo.danglingLinks });
  };

  const applyReview = () => {
    if (!review || !store.meta) return;
    const accepted = review.changes.filter((c) => review.ticked.has(c.id));
    const added = store.applyCrawlChanges(accepted);
    for (const node of added) {
      const address = (node.data as DeviceNodeData).addresses?.[0]?.address;
      // Ticking the row was the decision (LT-061): everything placed with an
      // address arrives monitored, not just what was logged into.
      if (address) store.upsertProbe(newProbe('node', node.id, store.meta.id, address, 'Discovered'));
    }
    const count = (kind: string) => accepted.filter((c) => c.kind === kind).length;
    const parts = [`Applied ${accepted.length} of ${review.changes.length} change${review.changes.length === 1 ? '' : 's'}:`,
      `${count('added')} added, ${count('changed')} updated, ${count('moved')} moved, ${count('removed')} removed.`];
    if (review.dangling) parts.push(`${review.dangling} link ends were not on the diagram.`);
    store.setStatusMessage(parts.join(' '));
    setReview(null);
    setAllVisible(false);
  };

  if (!isDesktop) {
    return (
      <p className="cv-help cv-discover-empty">
        Discovery needs the desktop app — a browser cannot open SSH connections.
      </p>
    );
  }

  // LT-212: the form as a profile, and a profile back into the form.
  const currentProfile = (name: string): CrawlProfile => ({
    id: uid(), name, seed, subnets, maxHops, preference, port, transport,
    credentialId: credentialId ?? null, snmp: snmpOpen ? snmpRowsShape(snmpRows) : null, details, reverseDns,
    concurrency, perHostTimeoutSecs: perHost, retries, secondFactor,
  });
  const applyProfile = (raw: CrawlProfile) => {
    const p = readProfile(raw);
    if (!p) return;
    setSeed(p.seed);
    setSubnets(p.subnets);
    setMaxHops(p.maxHops);
    setPreference(p.preference);
    setPort(p.port);
    setTransport(p.transport);
    setCredentialId(p.credentialId);
    const rows = p.snmp ? restoreSnmpRows(p.snmp) : [];
    setSnmpRows(rows.length ? rows : [blankSnmpRow()]);
    setSnmpOpen(rows.length > 0);
    setDetails(p.details);
    setReverseDns(p.reverseDns);
    setConcurrency(p.concurrency);
    setPerHost(p.perHostTimeoutSecs);
    setRetries(p.retries);
    setSecondFactor(p.secondFactor);
    setPlan(null);
    useStore.getState().setStatusMessage(`Loaded the ${p.name} profile. Passwords are not part of a profile.`);
  };

  return (
    <div className="cv-discover">
      <CrawlProfiles disabled={running} current={currentProfile} apply={applyProfile} />
      <div className="cv-discover-form">
        {/* LT-207: one seed or several — addresses, hostnames, ranges — or a CSV. */}
        <label className="cv-field">
          <span>Seed devices</span>
          <input className="cv-input" value={seed} spellCheck={false} disabled={running}
            placeholder="10.1.1.1, core-sw1, 10.1.2.0/24"
            title="Addresses, hostnames or ranges up to a /20, separated by commas. A range is narrowed to what answers on the login port."
            onChange={(e) => setSeed(e.target.value)} />
        </label>
        <label className="cv-btn cv-btn-small cv-seed-csv" aria-disabled={running}>
          From CSV…
          <input type="file" accept=".csv,text/csv" hidden disabled={running}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              void file.text().then((text) => {
                const found = seedsFromCsv(text);
                setSeed((s) => [...new Set([...s.split(/[\s,;]+/).filter(Boolean), ...found])].join(', '));
                useStore.getState().setStatusMessage(
                  found.length ? `Read ${found.length} seed${found.length === 1 ? '' : 's'} from ${file.name}.` : `Nothing in ${file.name} looked like an address or a hostname.`,
                );
              });
            }} />
        </label>
        {/* LT-296: the project already knows its subnets and which of its
            devices a crawl can walk from. Offered, never applied on its own —
            a scan reaches out to real equipment and stays something he
            starts. */}
        <button type="button" className="cv-btn cv-btn-small cv-fill-from-project" disabled={running}
          title="Put this project's switches and routers in the seeds, and its subnets in the limits"
          onClick={() => {
            const found = discoverySuggestions(useStore.getState().doc);
            if (!found.seeds.length && !found.subnets.length) {
              useStore.getState().setStatusMessage(
                'Nothing to fill in yet: this project has no addressed switches or routers, and no subnets in the register.',
              );
              return;
            }
            if (found.seeds.length) {
              setSeed((was) => [...new Set([...was.split(/[\s,;]+/).filter(Boolean), ...found.seeds])].join(', '));
            }
            if (found.subnets.length) setSubnets((was) => [...new Set([...was, ...found.subnets])]);
            useStore.getState().setStatusMessage(
              `Filled in ${found.seeds.length} seed${found.seeds.length === 1 ? '' : 's'} and ${found.subnets.length} subnet${found.subnets.length === 1 ? '' : 's'} from this project. Change anything before you scan.`,
            );
          }}>
          Fill from this project
        </button>
        <CredentialPicker kind="ssh" disabled={running} chosen={credentialId} onChoose={setCredentialId}
          remember typed={{ username, secret: password, secondSecret: enablePassword }}>
          <label className="cv-field cv-field-narrow">
            <span>Username</span>
            <input className="cv-input" value={username} autoComplete="off" disabled={running}
              onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>Password</span>
            <input className="cv-input" type="password" value={password} autoComplete="off"
              disabled={running} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>Enable</span>
            <input className="cv-input" type="password" value={enablePassword} autoComplete="off"
              disabled={running} onChange={(e) => setEnablePassword(e.target.value)} />
          </label>
        </CredentialPicker>
        <label className="cv-field cv-field-narrow">
          <span>Hops</span>
          <select className="cv-input" value={maxHops} disabled={running}
            onChange={(e) => setMaxHops(Number(e.target.value))}>
            {[1, 2, 3, 4, 6, 8].map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
        </label>
        <label className="cv-field cv-field-narrow">
          <span>Probe address</span>
          <select className="cv-input" value={preference} disabled={running}
            onChange={(e) => setPreference(e.target.value as typeof preference)}>
            <option value="loopback">Loopback</option>
            <option value="management">Management</option>
            <option value="first">First found</option>
          </select>
        </label>
        <label className="cv-field cv-field-narrow" title="How many devices to work on at the same time. A push factor still logs in one at a time.">
          <span>At once</span>
          <select className="cv-input" value={concurrency} disabled={running}
            onChange={(e) => setConcurrency(Number(e.target.value))}>
            {[1, 2, 4, 8, 16, 32].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="cv-field cv-field-narrow" title="How long one device may take — login and every command — before the crawl moves on">
          <span>Give up after</span>
          <select className="cv-input" value={perHost} disabled={running}
            onChange={(e) => setPerHost(Number(e.target.value))}>
            {[[60, '1 min'], [120, '2 min'], [300, '5 min'], [600, '10 min']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="cv-field cv-field-narrow" title="Tries again when nothing answered. A refused login is never retried.">
          <span>Retries</span>
          <select className="cv-input" value={retries} disabled={running}
            onChange={(e) => setRetries(Number(e.target.value))}>
            {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="cv-field cv-field-narrow">
          <span>Port</span>
          <input className="cv-input" type="number" value={port} disabled={running}
            onChange={(e) => setPort(Number(e.target.value) || 22)} />
        </label>

      </div>

      <SubnetList label="Stay inside these subnets" subnets={subnets} onChange={setSubnets}
        disabled={running} placeholder="10.1.0.0/16" />

      {/* Telnet is never chosen for anyone. It puts every credential and every
          byte of output on the wire in clear text, which is not a flaw in the
          implementation — it is what the protocol is — so the run has to ask
          for it and the form says what it costs. */}
      <label className="cv-field cv-field-narrow cv-transport">
        <span>Reach devices over</span>
        <select
          className="cv-input"
          value={transport}
          disabled={running}
          onChange={(e) => setTransport(e.target.value as typeof transport)}
        >
          <option value="ssh">SSH only</option>
          <option value="sshThenTelnet">SSH, then telnet if nothing answers</option>
          <option value="telnet">Telnet only</option>
        </select>
      </label>
      {transport !== 'ssh' && (
        <p className="cv-help cv-transport-warning">
          Telnet sends the username, the password and everything the device replies in clear
          text, readable by anything on the path. Coreview will not fall back to it after a
          password is <em>rejected</em> — the account exists and the credentials are wrong, and
          sending them again unprotected would be worse than failing.
        </p>
      )}

      {/* Two logins, because one estate rarely has one. Sites migrate between
          TACACS realms and appliances keep a local account of their own. */}
      <details
        className="cv-backup-creds"
        open={backupOpen}
        onToggle={(e) => setBackupOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>Second login, if the first is refused</summary>
        <div className="cv-discover-form">
          <label className="cv-field cv-field-narrow">
            <span>Username</span>
            <input className="cv-input" value={backupUsername} autoComplete="off" disabled={running}
              onChange={(e) => setBackupUsername(e.target.value)} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>Password</span>
            <input className="cv-input" type="password" value={backupPassword} autoComplete="off"
              disabled={running} onChange={(e) => setBackupPassword(e.target.value)} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>Enable</span>
            <input className="cv-input" type="password" value={backupEnable} autoComplete="off"
              disabled={running} onChange={(e) => setBackupEnable(e.target.value)} />
          </label>
        </div>
        <span className="cv-help">
          Used only where the first login is rejected. A timeout or a refused connection is not
          retried — a second password will not help, and on a locking account policy it would do
          harm.
        </span>
      </details>

      {/* Chosen before the run, because a connection attempt to a phone or a
          camera is what sets off an intrusion alert, and by then it has
          happened. Everything discovered is drawn either way — this decides
          only what gets logged into. */}
      <div className="cv-login-classes">
        <span className="cv-subnets-label">Log in to</span>
        <div className="cv-class-chips">
          {LOGIN_CHOICES.map(({ value, label }) => {
            const on = loginClasses.includes(value);
            return (
              <button
                key={value}
                type="button"
                className={`cv-chip${on ? ' is-on' : ''}`}
                disabled={running}
                aria-pressed={on}
                onClick={() =>
                  setLoginClasses((prev) =>
                    prev.includes(value) ? prev.filter((c) => c !== value) : [...prev, value],
                  )
                }
              >
                {label}
              </button>
            );
          })}
        </div>
        <span className="cv-help">
          Everything found is drawn, including whatever is not ticked here. Unticking something
          means Coreview will not try to log in to it — nothing more.
        </span>
      </div>

      <div className="cv-discover-run">
        {running ? (
          <button type="button" className="cv-btn cv-btn-stop" onClick={() => void ipc.cancelCrawl()}>
            Stop
          </button>
        ) : (
          <button type="button" className="cv-btn cv-btn-start" onClick={() => void start()}
            disabled={!seed.trim() || (!credentialId && (!username || !password))}>
            Discover
          </button>
        )}
        {!running && (
          <button type="button" className="cv-btn" disabled={!seed.trim()}
            title="Show what this run would do, without sending anything to the network"
            onClick={() => {
              void ipc.listCredentials().catch(() => []).then((saved) => {
                const label = (id: string) => saved.find((c) => c.id === id)?.label ?? 'a credential no longer saved';
                const runLogin = credentialId ? `${label(credentialId)} (chosen above)` : username ? `${username} (typed above)` : 'no login given';
                const snmp = snmpForRun();
                setPlan(dryRun({
                  seed, subnets, maxHops, maxDevices: 500, port, details, reverseDns, concurrency,
                  perHostTimeoutSecs: perHost, retries, secondFactor, transport,
                  bindings: bindingsFor(useStore.getState().doc),
                  snmpCount: snmp.typed.length + snmp.savedIds.length,
                }, label, runLogin));
              });
            }}>
            Dry run
          </button>
        )}
        {!running && (
          <label className="cv-btn" title="Files saved from snmpwalk on another machine, one device each — with MIB names, -On, or no MIBs">
            Open SNMP walks…
            <input type="file" multiple accept=".txt,.walk,.snmpwalk,text/plain" hidden aria-label="Open SNMP walk files"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                if (files.length) void readWalks(files);
              }} />
          </label>
        )}
        <label className="cv-check cv-check-inline">
          <input type="checkbox" checked={secondFactor} disabled={running}
            onChange={(e) => setSecondFactor(e.target.checked)} />
          These devices use Duo or another push factor — log in one at a time
        </label>
      </div>

      <CredentialRules disabled={running} />

      <fieldset className="cv-crawl-details" disabled={running}>
        <legend>Also read from each device</legend>
        {([
          ['vlans', 'Ports and VLANs', 'show interfaces status, show vlan brief, show interfaces trunk'],
          ['spanningTree', 'Spanning tree', 'show spanning-tree'],
          ['routes', 'Routing table', 'show ip route, show ipv6 route'],
        ] as const).map(([key, label, commands]) => (
          <label key={key} className="cv-check cv-check-inline" title={commands}>
            <input type="checkbox" checked={details[key]}
              onChange={(e) => setDetails((d) => ({ ...d, [key]: e.target.checked }))} />
            {label}
          </label>
        ))}
        <label className="cv-check cv-check-inline" title="A PTR lookup for each address found, where nothing else named it">
          <input type="checkbox" checked={reverseDns} onChange={(e) => setReverseDns(e.target.checked)} />
          Names from reverse DNS
        </label>
      </fieldset>

      <details className="cv-snmp" open={snmpOpen}
        onToggle={(e) => setSnmpOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Also try SNMP for devices that refuse SSH</summary>
        {snmpRows.map((row, i) => {
          const set = (patch: Partial<SnmpRow>) =>
            setSnmpRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
          return (
            <div className="cv-discover-form cv-snmp-row" key={row.key}>
              {/* The vault already holds SNMP credentials; nothing offered
                  them here, so a community string or a v3 passphrase had to
                  be retyped for every run (LT-135). */}
              <CredentialPicker kind="snmp" disabled={running} chosen={row.credentialId}
                onChoose={(id) => set({ credentialId: id })} remember
                typed={{
                  username: row.version === 'v3' ? row.user : 'v2c',
                  secret: row.version === 'v3' ? row.authPass : row.community,
                  secondSecret: row.version === 'v3' ? row.privPass : undefined,
                }}>
                <span className="cv-help cv-snmp-typed">Typed below. Keep it for this project and the next scan starts with it.</span>
              </CredentialPicker>
              {row.credentialId === null && (
                <>
                  <label className="cv-field cv-field-narrow">
                    <span>Version</span>
                    <select className="cv-input" value={row.version} disabled={running}
                      onChange={(e) => set({ version: e.target.value as 'v2c' | 'v3' })}>
                      <option value="v2c">v2c</option>
                      <option value="v3">v3</option>
                    </select>
                  </label>
                  {row.version === 'v2c' ? (
                    <label className="cv-field">
                      <span>Community (read-only)</span>
                      <input className="cv-input" type="password" value={row.community}
                        autoComplete="off" disabled={running}
                        onChange={(e) => set({ community: e.target.value })} />
                    </label>
                  ) : (
                    <>
                      <label className="cv-field cv-field-narrow">
                        <span>User</span>
                        <input className="cv-input" value={row.user} autoComplete="off"
                          disabled={running} onChange={(e) => set({ user: e.target.value })} />
                      </label>
                      <label className="cv-field cv-field-narrow">
                        <span>Auth</span>
                        <select className="cv-input" value={row.auth} disabled={running}
                          onChange={(e) => set({ auth: e.target.value })}>
                          <option value="sha">sha</option>
                          <option value="md5">md5</option>
                          <option value="sha256">sha256</option>
                          <option value="sha512">sha512</option>
                        </select>
                      </label>
                      <label className="cv-field cv-field-narrow">
                        <span>Auth password</span>
                        <input className="cv-input" type="password" value={row.authPass}
                          autoComplete="off" disabled={running}
                          onChange={(e) => set({ authPass: e.target.value })} />
                      </label>
                      <label className="cv-field cv-field-narrow">
                        <span>Privacy</span>
                        <select className="cv-input" value={row.priv} disabled={running}
                          onChange={(e) => set({ priv: e.target.value })}>
                          <option value="">none</option>
                          <option value="aes">aes</option>
                          <option value="aes 192">aes 192</option>
                          <option value="aes 256">aes 256</option>
                          <option value="des">des</option>
                        </select>
                      </label>
                      <label className="cv-field cv-field-narrow">
                        <span>Privacy password</span>
                        <input className="cv-input" type="password" value={row.privPass}
                          autoComplete="off" disabled={running}
                          onChange={(e) => set({ privPass: e.target.value })} />
                      </label>
                    </>
                  )}
                </>
              )}
              {snmpRows.length > 1 && (
                <button type="button" className="cv-btn cv-btn-small" disabled={running}
                  aria-label={`Remove SNMP credential ${i + 1}`}
                  onClick={() => setSnmpRows((prev) => prev.filter((_, j) => j !== i))}>
                  Remove
                </button>
              )}
            </div>
          );
        })}
        <div className="cv-discover-form">
          <button type="button" className="cv-btn cv-btn-small" disabled={running}
            onClick={() => setSnmpRows((prev) => [...prev, blankSnmpRow()])}>
            Add another SNMP credential
          </button>
          <span className="cv-help">
            Each is tried in turn until one answers. v2c and v3 can be mixed.
          </span>
        </div>
        <p className="cv-help">
          Used only where SSH is refused. A device that answers is named and classified, but
          cannot report its neighbours, so it appears without links.
        </p>
      </details>

      {pushMessage && (
        <p className="cv-discover-push" role="status">
          {pushMessage}
        </p>
      )}

      {plan && <DryRunPanel plan={plan} onClose={() => setPlan(null)} />}
      {table.size > 0 && <LiveCrawlTable table={table} />}
      {result && <CrawlFindingsList result={result} />}

      <p className="cv-discover-status">
        {problem ? <span className="cv-discover-problem">{problem}</span>
          : status ?? 'Typed credentials are used for this run and then forgotten. "Keep for this project" puts them in the encrypted vault and remembers which one this project uses, so the next scan does not ask again.'}
      </p>

      {rows.length > 0 && (
        <>
          <div className="cv-discover-filter">
            <span className="cv-filter-label">Show</span>
            {counts.map(([c, n]) => (
              <button key={c} type="button"
                className={`cv-chip ${classes.includes(c) ? 'is-on' : ''}`}
                onClick={() => toggleClass(c)}>
                {CLASS_LABEL[c]} <b>{n}</b>
              </button>
            ))}
            <input className="cv-input cv-filter-search" placeholder="Name, address or platform"
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>

          {result && <ChangeReport result={result} />}

          {review && (
            <ReconcileReview
              review={review}
              onToggle={(id) => setReview((r) => {
                if (!r) return r;
                const ticked = new Set(r.ticked);
                if (ticked.has(id)) ticked.delete(id);
                else ticked.add(id);
                return { ...r, ticked };
              })}
              onApply={applyReview}
              onCancel={() => setReview(null)}
            />
          )}

          <div className="cv-discover-actions">
            <button type="button" className="cv-btn cv-btn-small" onClick={() => setAllVisible(true)}>
              Select all
            </button>
            <button type="button" className="cv-btn cv-btn-small" onClick={() => setAllVisible(false)}>
              Select none
            </button>
            <button type="button" className="cv-btn cv-btn-small cv-btn-start"
              onClick={build} disabled={!picked.length}>
              Add {picked.length}
              {showAttached && chosenAttached.length > 0 ? ` + ${chosenAttached.length}` : ''} to diagram
            </button>
            <button type="button" className="cv-btn cv-btn-small" onClick={backUp}
              disabled={!backupable.length}
              title={
                backupable.length < picked.length
                  ? 'Only devices Coreview logged into can be backed up'
                  : undefined
              }>
              Back up {backupable.length}
            </button>
            <span className="cv-help">
              {visible.length} of {rows.length} shown
              {failures.length > 0 && ` · ${failures.length} could not be reached`}
            </span>
          </div>

          <table className="cv-table cv-discover-table">
            <thead>
              <tr>
                <th />
                <th>Device</th>
                <th>Kind</th>
                <th>Probe address</th>
                <th>Platform</th>
                <th>How</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.key}>
                  <td>
                    <input type="checkbox" checked={r.picked} aria-label={`Include ${r.name}`}
                      onChange={() => toggleRow(r.key)} />
                  </td>
                  <td>{r.name}</td>
                  <td>{CLASS_LABEL[r.klass]}</td>
                  <td className="cv-mono">{r.probeTarget || '—'}</td>
                  <td>{r.platform ?? '—'}</td>
                  <td className={r.reached ? 'cv-reached' : 'cv-seen'}>
                    {r.via === 'ssh'
                      ? 'Logged in'
                      : r.via === 'snmp'
                        ? 'SNMP only'
                        : r.via === 'reported'
                          ? 'Described by its controller'
                          : 'Seen by a neighbour'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {running && liveFailed > 0 && (
        <p className="cv-help cv-discover-live-failed">
          {liveFailed} device{liveFailed === 1 ? '' : 's'} could not be reached so far
        </p>
      )}

      {result && attachedTotal > 0 && (
        <details className="cv-attached" open={showAttached}
          onToggle={(e) => setShowAttached((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>
            {attachedTotal} more {attachedTotal === 1 ? 'device was' : 'devices were'} seen on
            switch ports without announcing anything
          </summary>

          <p className="cv-help">
            These speak no discovery protocol — printers, cameras, workstations. A switch knows
            they are there because it learned their address on a port. Nothing here is drawn
            unless you ask: a flat network can hold hundreds, and all of them at once would bury
            the topology.
          </p>

          <div className="cv-discover-form">
            <label className="cv-field cv-field-narrow">
              <span>Made by</span>
              <input className="cv-input" list="cv-makers" value={attachedVendor}
                placeholder="any" onChange={(e) => setAttachedVendor(e.target.value)} />
              <datalist id="cv-makers">
                {makers.map((m) => (
                  <option key={m.vendor} value={m.vendor}>{`${m.vendor} (${m.count})`}</option>
                ))}
              </datalist>
            </label>
            <label className="cv-field cv-field-narrow">
              <span>In subnet</span>
              <input className="cv-input" value={attachedSubnet} placeholder="any"
                onChange={(e) => setAttachedSubnet(e.target.value)} />
            </label>
            <label className="cv-field cv-field-narrow">
              <span>On port</span>
              <input className="cv-input" value={attachedPort} placeholder="any"
                onChange={(e) => setAttachedPort(e.target.value)} />
            </label>
          </div>

          <label className="cv-check cv-check-inline">
            <input type="checkbox" checked={singlePortOnly}
              onChange={(e) => setSinglePortOnly(e.target.checked)} />
            Only ports with one device on them
          </label>
          <p className="cv-help">
            A port carrying several addresses leads to another switch, and what is behind it
            belongs on that switch's part of the diagram rather than hanging off this one.
          </p>

          <p className="cv-help">
            <strong>{chosenAttached.length}</strong> of {attachedTotal} match. They will be added
            with the devices ticked above, each hanging off the port it was learned on.
          </p>
        </details>
      )}

      {!running && failures.length > 0 && (
        <details className="cv-discover-failures">
          <summary>{failures.length} device{failures.length === 1 ? '' : 's'} could not be reached</summary>
          {/* LT-144: grouped by why, with what to do about it. Four
              controller-managed access points used to read as four identical
              timeouts, which invites the wrong fix — a longer timeout. They
              now read as one group saying the devices are up and offer no
              SSH. */}
          {[...new Map(failures.map((f) => [f.kind ?? 'other', f.kind])).keys()].map((kind) => {
            const group = failures.filter((f) => (f.kind ?? 'other') === kind);
            const advice = failureAdvice(group[0]?.kind);
            return (
              <div className="cv-failure-group" key={kind}>
                <h5>
                  {failureHeading(group[0]?.kind)} <span className="cv-muted">({group.length})</span>
                </h5>
                {advice && <p className="cv-help">{advice}</p>}
                <ul>
                  {group.map((f) => (
                    <li key={f.address}>
                      <code>{f.address}</code> — {reasonWithoutAddress(f.address, f.reason)}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </details>
      )}
    </div>
  );
}

/**
 * LT-209: saved credentials to try first on a subnet or a vendor's devices.
 * Kept with the project — they are ids into this machine's vault, not secrets —
 * and sent with every crawl alongside each device's own (LT-199).
 */
function CredentialRules({ disabled }: { disabled: boolean }) {
  const rules = useStore((s) => s.doc.credentialRules) ?? [];
  const setRules = useStore((s) => s.setCredentialRules);
  const patch = (id: string, change: Partial<CredentialRule>) =>
    setRules(rules.map((r) => (r.id === id ? { ...r, ...change } : r)));
  return (
    <details className="cv-cred-rules" open={rules.length > 0 || undefined}>
      <summary>Saved credentials by subnet or vendor{rules.length ? ` (${rules.length})` : ''}</summary>
      <p className="cv-help">
        Tried before the login above on the devices they match — a device's own (in its inspector) first, then the
        narrowest subnet, then the vendor.
      </p>
      {rules.map((r) => {
        const problem = ruleProblem(r);
        return (
          <div key={r.id} className="cv-discover-form cv-cred-rule">
            <select className="cv-input" aria-label="Match by" value={r.scope} disabled={disabled}
              onChange={(e) => patch(r.id, { scope: e.target.value as CredentialRule['scope'] })}>
              <option value="subnet">Subnet</option>
              <option value="vendor">Vendor or platform</option>
            </select>
            <input className="cv-input" aria-label="Subnet or vendor" value={r.value} disabled={disabled} spellCheck={false}
              placeholder={r.scope === 'subnet' ? '192.0.2.0/24' : 'FortiSwitch'}
              aria-invalid={Boolean(problem && r.value)}
              onChange={(e) => patch(r.id, { value: e.target.value })} />
            <SavedCredentialSelect label="Saved credential for this rule" value={r.credentialId || undefined} disabled={disabled}
              onChange={(id) => patch(r.id, { credentialId: id ?? '' })} />
            <button type="button" className="cv-layer-remove" aria-label="Remove this rule" disabled={disabled}
              onClick={() => setRules(rules.filter((x) => x.id !== r.id))}>×</button>
            {problem && r.value && <span className="cv-help cv-cred-rule-problem">{problem}</span>}
          </div>
        );
      })}
      <button type="button" className="cv-btn cv-btn-small" disabled={disabled}
        onClick={() => setRules([...rules, { id: uid(), scope: 'subnet', value: '', credentialId: '' }])}>
        Add a rule
      </button>
    </details>
  );
}

/** LT-210: one row per device, where it is in the crawl right now. Open while
 *  a run is going; a finished run's table stays until the next one starts. */
function LiveCrawlTable({ table }: { table: CrawlTable }) {
  const rows = tableRows(table);
  const counts = stateCounts(table);
  return (
    <details className="cv-crawl-table" open>
      <summary>
        Devices this run{' '}
        <span className="cv-palette-count">
          {Object.entries(counts).map(([state, n]) => `${n} ${STATE_LABEL[state as keyof typeof STATE_LABEL].toLowerCase()}`).join(' · ')}
        </span>
      </summary>
      <div className="cv-table-scroll">
        <table className="cv-table">
          <thead>
            <tr><th>Address</th><th>Name</th><th>Hops</th><th>State</th><th>Detail</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.address} data-state={r.state}>
                <td className="cv-mono">{r.address}</td>
                <td>{r.name ?? ''}</td>
                <td>{r.hops ?? ''}</td>
                <td><span className={`cv-crawl-state is-${r.state}`}>{STATE_LABEL[r.state]}</span></td>
                <td className="cv-crawl-detail">{r.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** LT-211: a crawl's plan, from its settings alone. */
function DryRunPanel({ plan, onClose }: { plan: DryRunPlan; onClose: () => void }) {
  return (
    <section className="cv-dry-run" aria-label="Dry run">
      <header>
        <strong>Dry run</strong>
        <span className="cv-help">Nothing was sent: no ping, no DNS, no login.</span>
        <button type="button" className="cv-layer-remove" aria-label="Close the dry run" onClick={onClose}>×</button>
      </header>
      <h4>Seeds</h4>
      <ul>
        {plan.seeds.map((s) => (
          <li key={s.seed} data-kind={s.kind}>
            <span className="cv-mono">{s.seed}</span>{' — '}
            {s.kind === 'address' && (s.allowed ? <>would be dialled with {s.credentials.join(', then ')}</> : <>outside the subnet limit, not dialled</>)}
            {s.kind === 'range' && <>{s.allowed} of {s.addresses} addresses inside the limit would be checked on the login port first, then dialled with {s.credentials.join(', then ')}</>}
            {s.kind === 'hostname' && <>would be looked up in DNS when the run starts; which address it is is not known yet</>}
            {s.kind === 'invalid' && <span className="cv-dry-run-bad">{s.reason}</span>}
          </li>
        ))}
      </ul>
      <h4>Limits</h4>
      <ul>{plan.limits.map((l) => <li key={l}>{l}</li>)}</ul>
      <h4>Asked of each device</h4>
      <p className="cv-mono cv-dry-run-commands">{plan.commands.join(' · ')}</p>
      <p className="cv-help">{plan.snmp}. Neighbours found along the way are dialled within the same limits; who they are is only known once the run starts.</p>
    </section>
  );
}

/** LT-212: pick, save and remove named crawl settings. */
function CrawlProfiles({
  disabled,
  current,
  apply,
}: {
  disabled: boolean;
  current: (name: string) => CrawlProfile;
  apply: (p: CrawlProfile) => void;
}) {
  const profiles = useStore((s) => s.doc.crawlProfiles) ?? [];
  const save = useStore((s) => s.saveCrawlProfile);
  const remove = useStore((s) => s.deleteCrawlProfile);
  const [chosen, setChosen] = useState('');
  const [name, setName] = useState('');
  return (
    <div className="cv-crawl-profiles">
      <label className="cv-field cv-field-narrow">
        <span>Profile</span>
        <select className="cv-input" value={chosen} disabled={disabled || profiles.length === 0}
          onChange={(e) => {
            setChosen(e.target.value);
            const p = profiles.find((x) => x.id === e.target.value);
            if (p) {
              apply(p);
              setName(p.name);
            }
          }}>
          <option value="">{profiles.length ? 'Choose a saved profile' : 'No profiles yet'}</option>
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <input className="cv-input" aria-label="Profile name" placeholder="Name these settings" value={name} disabled={disabled}
        onChange={(e) => setName(e.target.value)} />
      <button type="button" className="cv-btn cv-btn-small" disabled={disabled || !name.trim()}
        title="Seeds, limits, tables and saved credentials — never a password"
        onClick={() => {
          save(current(name.trim()));
          const saved = (useStore.getState().doc.crawlProfiles ?? []).find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
          if (saved) setChosen(saved.id);
          useStore.getState().setStatusMessage(`Saved the ${name.trim()} profile.`);
        }}>
        Save profile
      </button>
      {chosen && (
        <button type="button" className="cv-btn cv-btn-small" disabled={disabled}
          onClick={() => {
            remove(chosen);
            setChosen('');
          }}>
          Delete profile
        </button>
      )}
    </div>
  );
}

/** LT-213: what the crawl says is wrong, worst first. */
function CrawlFindingsList({ result }: { result: Pick<CrawlResult, 'devices'> }) {
  const doc = useStore((s) => s.doc);
  const findings = useMemo(() => {
    // Links already drawn between devices, by the names a crawl knows them by.
    const nameOf = new Map(
      allNodes(doc)
        .filter((n) => n.type === 'device')
        .map((n) => {
          const d = n.data as DeviceNodeData;
          return [n.id, d.hostname || d.label] as const;
        }),
    );
    const drawn: DrawnLink[] = allEdges(doc)
      .map((e) => ({ a: nameOf.get(e.source) ?? '', b: nameOf.get(e.target) ?? '' }))
      .filter((l) => l.a && l.b);
    return crawlFindings(result, drawn);
  }, [doc, result]);
  if (findings.length === 0) {
    return <p className="cv-help cv-findings-none">No one-way links, loops, orphans or duplicate MACs found.</p>;
  }
  return (
    <details className="cv-findings" open>
      <summary>
        Findings <span className="cv-palette-count">{findings.length}</span>
      </summary>
      <ul>
        {findings.map((f, i) => (
          <li key={i} className={`is-${f.severity}`} data-kind={f.kind}>
            <span className="cv-finding-kind">{FINDING_LABEL[f.kind]}</span> {f.message}
          </li>
        ))}
      </ul>
    </details>
  );
}

const KIND_HEADING: Record<Change['kind'], string> = {
  added: 'New',
  changed: 'Changed',
  moved: 'Moved — not applied unless ticked',
  removed: 'Not found this time — not removed unless ticked',
};

/** LT-216: each change a crawl would make, to accept or reject. */
/** A crawl's devices, then the neighbours it only heard about, as table rows —
 *  skipping any key already shown. Shared by a live crawl and by walk files
 *  read from disk (LT-246). */
function resultRows(r: { devices: CrawledDevice[]; notVisited: Neighbor[] }, seen: Set<string>): Row[] {
  const next: Row[] = [];
  const add = (row: Row) => {
    if (seen.has(row.key)) return;
    seen.add(row.key);
    next.push(row);
  };
  r.devices.forEach((d: CrawledDevice) =>
    add({
      key: d.hostname,
      name: d.hostname,
      address: d.address,
      probeTarget: d.probeTarget,
      klass: d.class,
      platform: d.platform,
      reached: true,
      via: d.reachedBy,
      picked: true,
    }),
  );
  r.notVisited.forEach((n: Neighbor) =>
    add({
      key: n.shortName,
      name: n.shortName,
      address: n.addresses[0]?.ip ?? '',
      probeTarget: n.addresses[0]?.ip ?? '',
      klass: n.class,
      platform: n.platform,
      reached: false,
      via: null,
      // Only what we logged into is ticked to begin with. Everything
      // else is a claim from a neighbour, not something confirmed.
      picked: false,
    }),
  );
  return next;
}

function ReconcileReview({
  review,
  onToggle,
  onApply,
  onCancel,
}: {
  review: { changes: Change[]; ticked: Set<string> };
  onToggle: (id: string) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const kinds = (['added', 'changed', 'moved', 'removed'] as const).filter((k) => review.changes.some((c) => c.kind === k));
  return (
    <section className="cv-reconcile" aria-label="Review the crawl's changes">
      <header>
        <strong>Review the changes</strong>
        <span className="cv-help">Nothing has been changed yet. Untick anything you do not want.</span>
      </header>
      {review.changes.length === 0 && <p className="cv-help">The diagram already matches what the crawl found.</p>}
      {kinds.map((kind) => (
        <div key={kind} className={`cv-reconcile-group is-${kind}`}>
          <h4>{KIND_HEADING[kind]}</h4>
          <ul>
            {review.changes.filter((c) => c.kind === kind).map((c) => (
              <li key={c.id}>
                <label className="cv-check">
                  <input type="checkbox" checked={review.ticked.has(c.id)} onChange={() => onToggle(c.id)} />
                  <span className="cv-reconcile-title">{c.title}</span>
                </label>
                {c.details.length > 0 && <span className="cv-reconcile-detail">{c.details.join(' · ')}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="cv-discover-actions">
        <button type="button" className="cv-btn cv-btn-small cv-btn-start" onClick={onApply} disabled={review.ticked.size === 0}>
          Apply {review.ticked.size} change{review.ticked.size === 1 ? '' : 's'}
        </button>
        <button type="button" className="cv-btn cv-btn-small" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
