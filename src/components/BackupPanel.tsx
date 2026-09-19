import { useEffect, useMemo, useRef, useState } from 'react';
import {
  REST_NAME,
  groupOf,
  moveGroup,
  newGroup,
  parseGroups,
  planGroups,
  serializeGroups,
  type CollectionGroup,
  type PlannedGroup,
} from '../lib/collectionGroups';
import { PAGING_CHOICES, isPagingMode, parseCommandList, type PagingMode } from '../lib/showCommands';
import {
  commandsFor,
  newCommandSet,
  parseCommandSets,
  serializeCommandSets,
  setsFor,
  type CommandSet,
} from '../lib/commandSets';

import { useStore } from '../state/store';
import {
  ipc,
  isDesktop,
  type BackupDevice,
  type BackupEvent,
  type BackupRunSummary,
  type BackupTarget,
  type ComparedDevice,
  type ComparedPart,
  type DiffLine,
} from '../lib/ipc';

const KIND_LABEL: Record<ComparedDevice['kind'], string> = {
  running: 'running config',
  startup: 'startup config',
  'show-commands': 'show commands',
};

/** One step of an ordered collection, as the progress list shows it (LT-154). */
type GroupProgress = {
  id: string;
  name: string;
  devices: number;
  state: 'waiting' | 'running' | 'done' | 'notRun';
  saved: number;
  failed: number;
};

const STEP_LABEL: Record<GroupProgress['state'], string> = {
  waiting: 'Waiting',
  running: 'Running',
  done: 'Done',
  notRun: 'Not run',
};

function partStatus(p: ComparedPart): string {
  switch (p.status) {
    case 'same':
      return 'no change';
    case 'changed':
      return `+${p.added} −${p.removed}`;
    case 'onlyBefore':
      return 'only in the before run';
    case 'onlyAfter':
      return 'only in the after run';
  }
}
import { BackupChecks } from './BackupChecks';
import { CredentialPicker } from './CredentialPicker';
import { allNodes } from '../lib/pages';

import { FILE_TOKENS, describeCapture, describeStamp, patternProblem, previewFileName } from '../lib/fileNames';

/**
 * Take configuration backups, and look at the ones already taken.
 *
 * Two halves that belong together: capturing is worth little without being able
 * to see what changed, and a pair of timestamped captures makes that nearly
 * free. Devices come from whatever is on the diagram, so the list is the
 * network you have actually drawn rather than a separate inventory to maintain.
 */
export function BackupPanel({
  fromCrawl = [],
  onConsumed,
}: {
  /** Devices handed over from a discovery run. Shown alongside the diagram's
   *  own, because a crawl finds things that are not drawn yet and backing them
   *  up should not require drawing them first. */
  fromCrawl?: { address: string; name: string }[];
  onConsumed?: () => void;
} = {}) {
  const store = useStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [enablePassword, setEnablePassword] = useState('');
  const [secondFactor, setSecondFactor] = useState(false);
  const [port, setPort] = useState(22);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [kinds, setKinds] = useState<('running' | 'startup')[]>(['running']);
  // LT-149: show commands filed beside the configurations. Off unless ticked,
  // so an ordinary backup never runs a list someone typed last week. The list
  // and the paging choice are remembered; whether to run them is not.
  const [showOn, setShowOn] = useState(false);
  const [showText, setShowText] = useState('');
  const [paging, setPaging] = useState<PagingMode>('auto');
  const [showRestored, setShowRestored] = useState(false);
  // LT-150: command sets written once and applied by role or tag.
  const [sets, setSets] = useState<CommandSet[]>([]);
  // LT-151: how capture files are named. Blank is the default.
  const [filePattern, setFilePattern] = useState('');
  // LT-154: collect in ordered groups, stopping to look between them.
  const [groups, setGroups] = useState<CollectionGroup[]>([]);
  const [pauseBetween, setPauseBetween] = useState(true);
  const [stopOnFailure, setStopOnFailure] = useState(true);
  const [progress, setProgress] = useState<GroupProgress[]>([]);
  /** Set while a collection waits between groups: which comes next, and why
   *  it stopped. */
  const [awaitingNext, setAwaitingNext] = useState<{ index: number; name: string; why: string } | null>(null);
  /** The collection in flight. A snapshot taken when Back up is pressed, so
   *  editing the form while paused cannot change what the next group does.
   *  `started` is set only by the backend's own started event, which always
   *  precedes finished: a repeated finished event arriving after the next
   *  group was launched finds it not yet started and is ignored, instead of
   *  launching a third group over the second. */
  const queueRef = useRef<{
    plan: PlannedGroup<BackupTarget>[];
    index: number;
    started: boolean;
    pause: boolean;
    stopOnFailure: boolean;
    send: (targets: BackupTarget[]) => Promise<void>;
  } | null>(null);
  const finishedRef = useRef<((saved: number, failed: number, cancelled: boolean) => void) | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const [running, setRunning] = useState(false);
  /** Running, or paused between groups: either way the form is locked. */
  const busy = running || awaitingNext !== null;
  const [status, setStatus] = useState<string | null>(null);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ name: string; path: string; bytes: number; unchanged: boolean }[]>([]);
  const [failed, setFailed] = useState<{ name: string; reason: string }[]>([]);

  // Browsing what is already there.
  const [devices, setDevices] = useState<BackupDevice[]>([]);
  const [openDevice, setOpenDevice] = useState<string | null>(null);
  const [captures, setCaptures] = useState<string[]>([]);
  const [compare, setCompare] = useState<[string, string] | null>(null);
  const [diff, setDiff] = useState<DiffLine[] | null>(null);
  // LT-152: two whole runs, before and after a change.
  const [runs, setRuns] = useState<BackupRunSummary[]>([]);
  const [beforeRun, setBeforeRun] = useState('');
  const [afterRun, setAfterRun] = useState('');
  const [comparison, setComparison] = useState<ComparedDevice[] | null>(null);
  const [comparing, setComparing] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(true);

  /** What can be backed up: the diagram's devices, plus anything a crawl just
   *  handed over. Merged by address so a device that is both does not appear
   *  twice. */
  const targets = useMemo(() => {
    // Every page (LT-094): a device's config doesn't care which page it is
    // drawn on, the same reasoning as the Monitored Objects table.
    const fromDiagram = allNodes(store.doc)
      .filter((n) => n.type === 'device')
      .map((n) => {
        const data = n.data as {
          label?: string;
          addresses?: { address: string; isPrimary?: boolean }[];
          showCommands?: string;
          role?: string;
          tags?: string[];
          site?: string;
        };
        const address =
          data.addresses?.find((a) => a.isPrimary)?.address ?? data.addresses?.[0]?.address ?? '';
        return {
          name: data.label ?? 'device',
          address,
          // What command sets and collection groups match on (LT-150, LT-154).
          role: data.role,
          tags: data.tags ?? [],
          // The device's own Site, else the project's, for `{site}` (LT-151).
          site: data.site?.trim() || store.meta?.site || '',
          // Matching sets first, then the device's own list (LT-150).
          commands: commandsFor(sets, data),
          own: parseCommandList(data.showCommands).length,
          setNames: setsFor(sets, data).map((s) => s.name || 'unnamed set'),
        };
      })
      .filter((t) => t.address);

    const seen = new Set(fromDiagram.map((t) => t.address));
    // A device handed over from a crawl has no inspector entry yet, so it has
    // no commands of its own — only the global list applies to it.
    return [
      ...fromDiagram,
      ...fromCrawl
        .filter((t) => t.address && !seen.has(t.address))
        .map((t) => ({
          ...t,
          role: undefined as string | undefined,
          tags: [] as string[],
          commands: [] as string[],
          own: 0,
          setNames: [] as string[],
          site: store.meta?.site ?? '',
        })),
    ];
  }, [store.doc, store.meta, fromCrawl, sets]);

  const refreshDevices = () => {
    void ipc
      .listBackupDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
    // The newest run is the natural "after" and the one before it the
    // "before"; a choice already made is kept while it still exists.
    void ipc
      .listBackupRuns()
      .then((r) => {
        setRuns(r);
        const has = (s: string) => r.some((x) => x.stamp === s);
        setAfterRun((prev) => (prev && has(prev) ? prev : r[0]?.stamp ?? ''));
        setBeforeRun((prev) => (prev && has(prev) ? prev : r[1]?.stamp ?? ''));
      })
      .catch(() => setRuns([]));
  };

  useEffect(refreshDevices, []);

  // The global list comes back between sessions; it is the operator's own and
  // never a secret. Saved as it changes, once what was stored has been read.
  useEffect(() => {
    void ipc
      .getSettings()
      .then((st) => {
        if (st.backupShowCommands) setShowText(st.backupShowCommands);
        if (isPagingMode(st.backupPaging)) setPaging(st.backupPaging);
        setSets(parseCommandSets(st.backupCommandSets));
        if (st.backupFilePattern) setFilePattern(st.backupFilePattern);
        setGroups(parseGroups(st.backupGroups));
      })
      .catch(() => {})
      .finally(() => setShowRestored(true));
  }, []);
  useEffect(() => {
    if (!showRestored) return;
    void ipc.setSetting('backupShowCommands', showText.trim() ? showText : null).catch(() => {});
    void ipc.setSetting('backupPaging', paging).catch(() => {});
  }, [showRestored, showText, paging]);
  useEffect(() => {
    if (!showRestored) return;
    void ipc.setSetting('backupCommandSets', serializeCommandSets(sets)).catch(() => {});
  }, [showRestored, sets]);
  useEffect(() => {
    if (!showRestored) return;
    void ipc.setSetting('backupFilePattern', filePattern.trim() || null).catch(() => {});
  }, [showRestored, filePattern]);
  useEffect(() => {
    if (!showRestored) return;
    void ipc.setSetting('backupGroups', serializeGroups(groups)).catch(() => {});
  }, [showRestored, groups]);

  const editGroup = (id: string, patch: Partial<CollectionGroup>) =>
    setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));

  const patternIssue = patternProblem(filePattern);
  const sample = targets.find((t) => picked.has(t.address)) ?? targets[0];
  const preview = previewFileName(
    filePattern,
    sample ?? { name: 'device', address: '192.0.2.1', site: '' },
    '20260828-101530',
    showOn && !kinds.length ? 'show-commands' : kinds.includes('running') ? 'running-config' : 'startup-config',
  );

  const editSet = (id: string, patch: Partial<CommandSet>) =>
    setSets((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const globalCommands = parseCommandList(showText);
  const anyShowCommand =
    showOn &&
    (globalCommands.length > 0 ||
      targets.some((t) => picked.has(t.address) && (t.commands?.length ?? 0) > 0));

  // Handed-over devices arrive already chosen — they were picked a moment ago
  // in the other tab, and asking again would be asking twice.
  useEffect(() => {
    if (!fromCrawl.length) return;
    setPicked(new Set(fromCrawl.map((t) => t.address)));
    onConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromCrawl]);

  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    void ipc
      .onBackupEvent((e: BackupEvent) => {
        switch (e.kind) {
          case 'started':
            setStatus(`Backing up ${e.devices} device${e.devices === 1 ? '' : 's'}…`);
            // The group launched last is now really running (LT-154).
            if (queueRef.current) queueRef.current.started = true;
            break;
          case 'ssh': {
            const detail = e as unknown as { host?: string; message?: string };
            if (detail.message) setPushMessage(detail.message);
            else if (detail.host) setStatus(`Connecting to ${detail.host}…`);
            break;
          }
          case 'saved':
            setPushMessage(null);
            setSaved((prev) => [...prev, e]);
            break;
          case 'failed':
            setFailed((prev) => [...prev, { name: e.name, reason: e.reason }]);
            break;
          case 'finished':
            setPushMessage(null);
            setStatus(
              e.cancelled
                ? `Stopped — ${e.saved} saved, ${e.failed} failed`
                : `${e.saved} saved, ${e.failed} failed`,
            );
            // Through a ref: this listener is registered once, and what
            // happens next depends on the collection in flight (LT-154).
            finishedRef.current?.(e.saved, e.failed, e.cancelled);
            break;
        }
      })
      .then((f) => {
        // Unmounted before `listen` resolved: remove it now, or it stays
        // registered and every later event arrives twice.
        if (gone) f();
        else off = f;
      });
    return () => {
      gone = true;
      off?.();
    };
  }, []);

  /** Starts one group of the collection in flight. */
  const launchGroup = (index: number) => {
    const q = queueRef.current;
    const step = q?.plan[index];
    if (!q || !step) return;
    q.index = index;
    q.started = false;
    setAwaitingNext(null);
    setRunning(true);
    setProgress((prev) => prev.map((p, i) => (i === index ? { ...p, state: 'running' } : p)));
    q.send(step.targets).catch((err: unknown) => {
      // Refused before anything ran — nothing will finish, so stop here.
      queueRef.current = null;
      setRunning(false);
      setProblem(err instanceof Error ? err.message : String(err));
      setProgress((prev) => prev.map((p, i) => (i >= index ? { ...p, state: 'notRun' } : p)));
    });
  };

  /** One group finished: go on, wait, or stop (LT-154). */
  const onGroupFinished = (groupSaved: number, groupFailed: number, cancelled: boolean) => {
    refreshDevices();
    const q = queueRef.current;
    if (!q) {
      setRunning(false);
      return;
    }
    // A finished event for a group that has not started is a repeat of the
    // previous group's. Ignored — and without touching `running`, because the
    // group just launched is still going.
    if (!q.started) return;
    q.started = false;
    const i = q.index;
    const next = q.plan[i + 1];
    setProgress((prev) =>
      prev.map((p, k) =>
        k === i
          ? { ...p, state: 'done', saved: groupSaved, failed: groupFailed }
          : cancelled && k > i
            ? { ...p, state: 'notRun' }
            : p,
      ),
    );
    if (cancelled || !next) {
      queueRef.current = null;
      setRunning(false);
      return;
    }
    const name = q.plan[i]!.name;
    if (q.stopOnFailure && groupFailed > 0) {
      setRunning(false);
      setAwaitingNext({ index: i + 1, name: next.name,
        why: `${name} had ${groupFailed} failure${groupFailed === 1 ? '' : 's'}` });
      return;
    }
    if (q.pause) {
      setRunning(false);
      setAwaitingNext({ index: i + 1, name: next.name, why: `${name} is done` });
      return;
    }
    launchGroup(i + 1);
  };
  finishedRef.current = onGroupFinished;

  const stopCollection = () => {
    const q = queueRef.current;
    queueRef.current = null;
    setAwaitingNext(null);
    setRunning(false);
    if (q) setProgress((prev) => prev.map((p) => (p.state === 'waiting' ? { ...p, state: 'notRun' } : p)));
  };

  const start = () => {
    setProblem(null);
    setSaved([]);
    setFailed([]);
    // The timestamp is chosen once for the run, so every device in one backup
    // shares a filename and a set can be compared as a set — and every group
    // of an ordered collection shares it too, so the whole collection is one
    // run to before-and-after and to checks (LT-152, LT-153).
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const stamp =
      `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
      `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    // A device's own commands only travel when show commands are ticked, so
    // an ordinary backup never runs them by accident.
    const chosen = targets
      .filter((t) => picked.has(t.address))
      .map((t) => ({ ...t, commands: showOn ? (t.commands ?? []) : [] }));
    const input = {
      kinds,
      secondFactor,
      port,
      credentialId: credentialId ?? undefined,
      showCommands: showOn ? globalCommands : [],
      paging,
      filePattern: filePattern.trim() || undefined,
    };
    const credentials = { username, password, enablePassword: enablePassword || undefined };
    const plan = planGroups(groups, chosen);
    queueRef.current = {
      plan,
      index: 0,
      started: false,
      pause: pauseBetween,
      stopOnFailure,
      send: (ts) => ipc.startBackup({ ...input, targets: ts }, credentials, stamp),
    };
    setProgress(plan.map((s) => ({
      id: s.id, name: s.name, devices: s.targets.length, state: 'waiting', saved: 0, failed: 0,
    })));
    launchGroup(0);
  };

  const openCaptures = (device: string) => {
    setOpenDevice(device);
    setDiff(null);
    setCompare(null);
    void ipc.listDeviceCaptures(device).then(setCaptures).catch(() => setCaptures([]));
  };

  const runDiff = (device: string, before: string, after: string) => {
    setCompare([before, after]);
    void ipc
      .diffCaptures(device, before, after)
      .then(setDiff)
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };

  const compareRuns = () => {
    setProblem(null);
    setComparison(null);
    setComparing(true);
    void ipc
      .compareBackupRuns(beforeRun, afterRun)
      .then(setComparison)
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
      .finally(() => setComparing(false));
  };

  const toggleKind = (k: 'running' | 'startup') =>
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  if (!isDesktop) {
    return (
      <p className="cv-help cv-discover-empty">
        Backups need the desktop app — a browser cannot open SSH connections or write files.
      </p>
    );
  }

  if (!store.settings.backupFolder) {
    return (
      <p className="cv-help cv-discover-empty">
        Choose a backup folder first, on the Coreview start screen. Configurations are written
        there and nowhere else.
      </p>
    );
  }

  const changed = diff ? diff.filter((l) => l.kind !== 'same').length : 0;

  return (
    <div className="cv-discover">
      <div className="cv-discover-form">
        <CredentialPicker kind="ssh" disabled={busy} chosen={credentialId} onChoose={setCredentialId}
          remember typed={{ username, secret: password, secondSecret: enablePassword }}>
          <label className="cv-field cv-field-narrow">
            <span>Username</span>
            <input className="cv-input" value={username} autoComplete="off" disabled={busy}
              onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>Password</span>
            <input className="cv-input" type="password" value={password} autoComplete="off"
              disabled={busy} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>Enable</span>
            <input className="cv-input" type="password" value={enablePassword} autoComplete="off"
              disabled={busy} onChange={(e) => setEnablePassword(e.target.value)} />
          </label>
        </CredentialPicker>
        <label className="cv-field cv-field-narrow">
          <span>Port</span>
          <input className="cv-input" type="number" value={port} disabled={busy}
            onChange={(e) => setPort(Number(e.target.value) || 22)} />
        </label>
      </div>

      <div className="cv-discover-run">
        {running ? (
          <button type="button" className="cv-btn cv-btn-stop" onClick={() => void ipc.cancelBackup()}>
            Stop
          </button>
        ) : (
          <button type="button" className="cv-btn cv-btn-start" onClick={start}
            disabled={busy || !picked.size || (!credentialId && (!username || !password)) || (!kinds.length && !anyShowCommand) || !!patternIssue}>
            Back up {picked.size || 'selected'}
          </button>
        )}
        <label className="cv-check cv-check-inline">
          <input type="checkbox" checked={kinds.includes('running')} disabled={busy}
            onChange={() => toggleKind('running')} />
          Running config
        </label>
        <label className="cv-check cv-check-inline">
          <input type="checkbox" checked={kinds.includes('startup')} disabled={busy}
            onChange={() => toggleKind('startup')} />
          Startup config
        </label>
        <label className="cv-check cv-check-inline">
          <input type="checkbox" checked={showOn} disabled={busy}
            onChange={(e) => setShowOn(e.target.checked)} />
          Show commands
        </label>
        <label className="cv-check cv-check-inline">
          <input type="checkbox" checked={secondFactor} disabled={busy}
            onChange={(e) => setSecondFactor(e.target.checked)} />
          Duo — one device at a time
        </label>
      </div>

      <div className="cv-file-pattern">
        <label className="cv-field">
          <span>File names</span>
          <input className="cv-input cv-mono" value={filePattern} spellCheck={false} disabled={busy}
            aria-invalid={!!patternIssue} onChange={(e) => setFilePattern(e.target.value)} />
        </label>
        <p className="cv-help">
          {patternIssue ? (
            <span className="cv-discover-problem">File names {patternIssue}.</span>
          ) : (
            <>Saved as <span className="cv-mono">{preview}</span> in the device&apos;s folder. </>
          )}{' '}
          Leave blank for the default. Tokens: {FILE_TOKENS.map((t) => (
            <span key={t.token} className="cv-mono" title={t.means}>{t.token} </span>
          ))}
        </p>
      </div>

      <div className="cv-collection-groups">
        <h4 className="cv-backup-head">Collect in groups</h4>
        <p className="cv-help">
          Back up in an order, one group at a time. A device joins the first group whose roles or
          tags match it; anything left over goes last, in {REST_NAME}. With no groups, every
          selected device runs together, as before. All groups share one run time, so
          before-and-after and checks see a single run.
        </p>
        {groups.map((g, i) => (
          <fieldset key={g.id} className="cv-command-set" aria-label={`Group ${g.name}`}>
            {/* Empty fields, no placeholders: the groups are the operator's
                own and nothing from any real project ships (D-027). */}
            <span className="cv-group-order" aria-hidden="true">{i + 1}</span>
            <label className="cv-field cv-field-narrow">
              <span>Name</span>
              <input className="cv-input" value={g.name} disabled={busy}
                onChange={(e) => editGroup(g.id, { name: e.target.value })} />
            </label>
            <label className="cv-field cv-field-narrow">
              <span>Roles</span>
              <input className="cv-input" value={g.roles} disabled={busy}
                onChange={(e) => editGroup(g.id, { roles: e.target.value })} />
            </label>
            <label className="cv-field cv-field-narrow">
              <span>Tags</span>
              <input className="cv-input" value={g.tags} disabled={busy}
                onChange={(e) => editGroup(g.id, { tags: e.target.value })} />
            </label>
            <button type="button" className="cv-btn cv-btn-small" disabled={busy || i === 0}
              aria-label={`Move ${g.name} earlier`} onClick={() => setGroups((prev) => moveGroup(prev, g.id, -1))}>
              ↑
            </button>
            <button type="button" className="cv-btn cv-btn-small" disabled={busy || i === groups.length - 1}
              aria-label={`Move ${g.name} later`} onClick={() => setGroups((prev) => moveGroup(prev, g.id, 1))}>
              ↓
            </button>
            <button type="button" className="cv-btn cv-btn-small" disabled={busy}
              onClick={() => setGroups((prev) => prev.filter((x) => x.id !== g.id))}>
              Remove group
            </button>
          </fieldset>
        ))}
        <div className="cv-before-after-pick">
          <button type="button" className="cv-btn cv-btn-small" disabled={busy}
            onClick={() => setGroups((prev) => [...prev, newGroup(prev)])}>
            Add group
          </button>
          {groups.length > 0 && (
            <>
              <label className="cv-check cv-check-inline">
                <input type="checkbox" checked={pauseBetween} disabled={busy}
                  onChange={(e) => setPauseBetween(e.target.checked)} />
                Pause between groups
              </label>
              <label className="cv-check cv-check-inline">
                <input type="checkbox" checked={stopOnFailure} disabled={busy}
                  onChange={(e) => setStopOnFailure(e.target.checked)} />
                Stop when a group has a failure
              </label>
            </>
          )}
        </div>
      </div>

      {progress.length > 1 && (
        <div className="cv-group-progress" role="status">
          <ol>
            {progress.map((p) => (
              <li key={p.id}>
                <span className={`cv-verdict is-${p.state === 'done' && p.failed > 0 ? 'fail' : p.state}`}>
                  {STEP_LABEL[p.state]}
                </span>{' '}
                {p.name} · {p.devices} device{p.devices === 1 ? '' : 's'}
                {p.state === 'done' && ` — ${p.saved} saved, ${p.failed} failed`}
              </li>
            ))}
          </ol>
          {awaitingNext && (
            <div className="cv-before-after-pick">
              <span className="cv-help">{awaitingNext.why}. Look at the results below before going on.</span>
              <button type="button" className="cv-btn cv-btn-small" onClick={() => launchGroup(awaitingNext.index)}>
                Continue with {awaitingNext.name}
              </button>
              <button type="button" className="cv-btn cv-btn-small" onClick={stopCollection}>
                Stop here
              </button>
            </div>
          )}
        </div>
      )}

      {pushMessage && <p className="cv-discover-push" role="status">{pushMessage}</p>}

      {showOn && (
        <div className="cv-show-commands">
          <label className="cv-field">
            <span>Show commands for every selected device — one per line</span>
            {/* No placeholder and no preset: the list is the operator's own, and
                nothing from any real project ships in this app (D-027). */}
            <textarea className="cv-input cv-mono" rows={6} value={showText} spellCheck={false}
              disabled={busy} onChange={(e) => setShowText(e.target.value)} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>Paging</span>
            <select className="cv-input" value={paging} disabled={busy}
              onChange={(e) => setPaging(e.target.value as PagingMode)}>
              {PAGING_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </label>
          <p className="cv-help">
            Sends first: {PAGING_CHOICES.find((c) => c.value === paging)?.sends}. A device's own
            commands, set in its inspector, run after this list. Only commands that read — show,
            display, get — are ever sent; anything that could change a device is refused before a
            connection opens. Each device gets one file in its backup folder.
          </p>

          <div className="cv-command-sets">
            <h4 className="cv-backup-head">Command sets by role or tag</h4>
            <p className="cv-help">
              Write a list once and every device whose Role or tags match gets it, after the list
              above and before its own commands. Separate several roles or tags with commas.
            </p>
            {sets.map((s) => (
              <fieldset key={s.id} className="cv-command-set" aria-label={`Command set ${s.name}`}>
                {/* Empty fields, no placeholders: the sets are the operator's
                    own and nothing from any real project ships (D-027). */}
                <label className="cv-field cv-field-narrow">
                  <span>Name</span>
                  <input className="cv-input" value={s.name} disabled={busy}
                    onChange={(e) => editSet(s.id, { name: e.target.value })} />
                </label>
                <label className="cv-field cv-field-narrow">
                  <span>Roles</span>
                  <input className="cv-input" value={s.roles} disabled={busy}
                    onChange={(e) => editSet(s.id, { roles: e.target.value })} />
                </label>
                <label className="cv-field cv-field-narrow">
                  <span>Tags</span>
                  <input className="cv-input" value={s.tags} disabled={busy}
                    onChange={(e) => editSet(s.id, { tags: e.target.value })} />
                </label>
                <label className="cv-field">
                  <span>Commands — one per line</span>
                  <textarea className="cv-input cv-mono" rows={4} value={s.commands} spellCheck={false}
                    disabled={busy} onChange={(e) => editSet(s.id, { commands: e.target.value })} />
                </label>
                <button type="button" className="cv-btn cv-btn-small" disabled={busy}
                  onClick={() => setSets((prev) => prev.filter((x) => x.id !== s.id))}>
                  Remove set
                </button>
              </fieldset>
            ))}
            <button type="button" className="cv-btn cv-btn-small" disabled={busy}
              onClick={() => setSets((prev) => [...prev, newCommandSet(prev)])}>
              Add command set
            </button>
          </div>
        </div>
      )}

      <p className="cv-discover-status">
        {problem ? <span className="cv-discover-problem">{problem}</span>
          : status ?? `Saving to ${store.settings.backupFolder}`}
      </p>

      <div className="cv-backup-columns">
        <section>
          <h4 className="cv-backup-head">Devices on the diagram</h4>
          {targets.length === 0 ? (
            <p className="cv-help">
              Nothing to back up — the diagram has no devices with addresses yet. Discover some,
              or add addresses to the nodes you have.
            </p>
          ) : (
            <>
              <div className="cv-discover-actions">
                <button type="button" className="cv-btn cv-btn-small"
                  onClick={() => setPicked(new Set(targets.map((t) => t.address)))}>
                  Select all
                </button>
                <button type="button" className="cv-btn cv-btn-small" onClick={() => setPicked(new Set())}>
                  Select none
                </button>
              </div>
              <table className="cv-table cv-discover-table">
                <thead>
                  <tr>
                    <th /><th>Device</th><th>Address</th><th>Commands</th>
                    {groups.length > 0 && <th>Group</th>}
                  </tr>
                </thead>
                <tbody>
                  {targets.map((t) => (
                    <tr key={t.address}>
                      <td>
                        <input type="checkbox" checked={picked.has(t.address)} aria-label={`Back up ${t.name}`}
                          onChange={() => setPicked((prev) => {
                            const next = new Set(prev);
                            if (next.has(t.address)) next.delete(t.address); else next.add(t.address);
                            return next;
                          })} />
                      </td>
                      <td>{t.name}</td>
                      <td className="cv-mono">{t.address}</td>
                      <td className="cv-muted" title={t.commands.join('\n') || 'Set in the device inspector, or by a command set'}>
                        {t.commands.length > 0 ? `${t.commands.length}` : '—'}
                        {t.setNames.length > 0 && (
                          <span className="cv-command-set-names"> · {t.setNames.join(', ')}</span>
                        )}
                        {t.setNames.length > 0 && t.own > 0 && (
                          <span className="cv-command-set-names"> + own</span>
                        )}
                      </td>
                      {groups.length > 0 && <td>{groupOf(groups, t).name}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>

        <section>
          <h4 className="cv-backup-head">Backups taken</h4>
          {devices.length === 0 ? (
            <p className="cv-help">No backups yet.</p>
          ) : (
            <ul className="cv-backup-list">
              {devices.map((d) => (
                <li key={d.name}>
                  <button type="button" className={openDevice === d.name ? 'is-open' : ''}
                    onClick={() => openCaptures(d.name)}>
                    {d.name} <span className="cv-help">{d.captures} capture{d.captures === 1 ? '' : 's'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {openDevice && captures.length > 0 && (
            <div className="cv-backup-captures">
              <p className="cv-help">
                {captures.length > 1
                  ? 'Pick two captures to see what changed between them.'
                  : 'One capture so far — there is nothing to compare it with yet.'}
              </p>
              <ul>
                {captures.map((c, i) => (
                  <li key={c}>
                    <span className="cv-mono">{describeCapture(c)}</span>
                    {i === 0 && captures[1] !== undefined && (
                      <button type="button" className="cv-btn cv-btn-small"
                        onClick={() => runDiff(openDevice, captures[1] as string, c)}>
                        Compare with previous
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {diff && compare && (
            <div className="cv-diff">
              <p className="cv-help">
                {changed === 0
                  ? 'Identical — nothing changed between these two captures.'
                  : `${changed} line${changed === 1 ? '' : 's'} differ.`}
              </p>
              {changed > 0 && (
                <pre className="cv-diff-body">
                  {diff
                    .filter((l) => l.kind !== 'same')
                    .slice(0, 200)
                    .map((l, i) => (
                      <span key={i} className={l.kind === 'added' ? 'is-added' : 'is-removed'}>
                        {l.kind === 'added' ? '+ ' : '- '}
                        {(l as { value?: string }).value ?? ''}
                        {'\n'}
                      </span>
                    ))}
                </pre>
              )}
            </div>
          )}
        </section>
      </div>

      <section className="cv-before-after">
        <h4 className="cv-backup-head">Before and after</h4>
        {runs.length < 2 ? (
          <p className="cv-help">
            Take one backup before a change and one after it, and every device and every show
            command can be compared between the two runs here.
          </p>
        ) : (
          <>
            <div className="cv-before-after-pick">
              <label className="cv-field cv-field-narrow">
                <span>Before</span>
                <select className="cv-input" value={beforeRun} onChange={(e) => setBeforeRun(e.target.value)}>
                  {runs.map((r) => (
                    <option key={r.stamp} value={r.stamp}>
                      {describeStamp(r.stamp)} · {r.devices} device{r.devices === 1 ? '' : 's'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cv-field cv-field-narrow">
                <span>After</span>
                <select className="cv-input" value={afterRun} onChange={(e) => setAfterRun(e.target.value)}>
                  {runs.map((r) => (
                    <option key={r.stamp} value={r.stamp}>
                      {describeStamp(r.stamp)} · {r.devices} device{r.devices === 1 ? '' : 's'}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="cv-btn cv-btn-small" onClick={compareRuns}
                disabled={comparing || !beforeRun || !afterRun || beforeRun === afterRun}>
                {comparing ? 'Comparing…' : 'Compare runs'}
              </button>
              <label className="cv-check cv-check-inline">
                <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />
                Only what changed
              </label>
            </div>
            {beforeRun && beforeRun === afterRun && (
              <p className="cv-help">Pick two different runs.</p>
            )}
            {comparison && (
              <div className="cv-before-after-result">
                <p className="cv-help">
                  {comparison.length === 0
                    ? 'Neither run has any captures to compare.'
                    : `${comparison.filter((d) => d.changed > 0).length} of ${comparison.length} capture${
                        comparison.length === 1 ? '' : 's'
                      } changed between ${describeStamp(beforeRun)} and ${describeStamp(afterRun)}.`}
                </p>
                {comparison
                  .filter((d) => !onlyChanged || d.changed > 0)
                  .map((d) => (
                    <details key={`${d.device}-${d.kind}`} className="cv-compared-device" open={d.changed > 0}>
                      <summary>
                        <strong>{d.device}</strong> · {KIND_LABEL[d.kind]} —{' '}
                        {d.changed === 0
                          ? 'no change'
                          : d.parts.length === 1
                            ? partStatus(d.parts[0]!)
                            : `${d.changed} of ${d.parts.length} commands differ`}
                      </summary>
                      {d.parts
                        .filter((p) => !onlyChanged || p.status !== 'same')
                        .map((p) => (
                          <div key={p.name} className="cv-compared-part">
                            <p className="cv-compared-name">
                              <span className="cv-mono">{p.name}</span>{' '}
                              <span className={`cv-compared-status is-${p.status}`}>{partStatus(p)}</span>
                              {p.approximate && (
                                <span className="cv-help"> — too long to diff line by line; compared as sets of lines</span>
                              )}
                            </p>
                            {p.lines.length > 0 && (
                              <pre className="cv-diff-body">
                                {p.lines.map((l, i) => (
                                  <span key={i} className={l.kind === 'added' ? 'is-added' : 'is-removed'}>
                                    {l.kind === 'added' ? '+ ' : '- '}
                                    {l.value}
                                    {'\n'}
                                  </span>
                                ))}
                                {p.truncated && '… more lines not shown\n'}
                              </pre>
                            )}
                          </div>
                        ))}
                    </details>
                  ))}
              </div>
            )}
          </>
        )}
      </section>

      <BackupChecks runs={runs} />

      {(saved.length > 0 || failed.length > 0) && (
        <div className="cv-backup-results">
          {saved.map((s) => (
            <p key={s.path} className="cv-help">
              {/* Defensive after LT-073: a payload that arrives without a
                  byte count must read as unknown, never throw. */}
              <span className="cv-reached">Saved</span> {s.name ?? 'device'} —{' '}
              {typeof s.bytes === 'number' ? `${s.bytes.toLocaleString()} bytes` : 'size unknown'}
              {s.unchanged && ' (unchanged since the last capture)'}
            </p>
          ))}
          {failed.map((f) => (
            <p key={f.name} className="cv-discover-problem">{f.name} — {f.reason}</p>
          ))}
        </div>
      )}
    </div>
  );
}
