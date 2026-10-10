import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { t } from '../i18n';
import { Colouriser } from '../lib/colourise';
import { ipc, type SshEvent } from '../lib/ipc';
import { formatTime } from '../lib/timeFormat';
import { useStore, type SshTab } from '../state/store';
import { ChromeIcon } from './chromeIcons';

/**
 * Open shells, one tab each, with the controls that make one usable
 * for a day's work.
 *
 * SecureCRT's arrangement: right-click a device, get a shell, and find
 * every open shell sitting as tabs beside each other. This is that — the
 * bottom panel's **SSH** section, a tab per session, the device's own screen
 * inside it — plus four things that make it usable: colour for devices
 * that send none, a font and a size, a
 * transcript saved where the backups go, and a keepalive so a session stays up
 * until it is closed rather than until the device gets bored.
 *
 * Nothing here interprets what the device sends. `xterm.js` draws it, and
 * keystrokes go back exactly as typed. That is the difference between this and
 * everything else the app does over SSH: a crawl reads until it recognises a
 * prompt, and a person wants the prompt itself.
 *
 * **The terminals live outside React.** A `Terminal` owns a canvas and its
 * scrollback; unmounting one to switch tabs would throw away everything the
 * device has said. So every open session's terminal is mounted at once and the
 * inactive ones are hidden, and the instances are kept in the module-level map
 * below, which is also where the event listener finds them.
 */
type Held = {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  colour: Colouriser;
  /** The session this screen is showing now — it changes when an
   *  ended session is reopened in the same tab, and the screen stays. */
  id: string;
  reconnecting?: boolean;
};
const terminals = new Map<string, Held>();

/**
 * Opens a new session to the same device with the same saved login,
 * in the tab of the one that ended — the screen and its scrollback kept, the
 * terminal re-keyed to the new session before the tab is, so nothing in
 * between takes it for a tab that has gone.
 */
async function reconnect(held: Held) {
  if (held.reconnecting) return;
  const tab = useStore.getState().sshSessions.find((t) => t.id === held.id);
  if (!tab || tab.status !== 'closed' || !tab.credentialId) return;
  held.reconnecting = true;
  held.term.write(`\r\n\x1b[2m${t('ssh.reconnecting', { name: tab.label })}\x1b[0m\r\n`);
  try {
    const { keepaliveSeconds, logByDefault } = useStore.getState().settings.terminal;
    const id = await ipc.sshOpen(tab.address, tab.credentialId, { cols: held.term.cols, rows: held.term.rows }, undefined, keepaliveSeconds);
    terminals.set(id, held);
    terminals.delete(held.id);
    held.id = id;
    useStore.getState().reopenSshTab(tab.id, id);
    const folder = useStore.getState().settings.backupFolder;
    if (logByDefault && folder) {
      await ipc.sshLogStart(id, { folder, device: tab.label, address: tab.address, site: '' }).catch(() => undefined);
    }
  } catch (e: unknown) {
    held.term.write(`\x1b[2m${e instanceof Error ? e.message : String(e)}\x1b[0m\r\n\x1b[2m${t('ssh.pressEnter')}\x1b[0m\r\n`);
  } finally {
    held.reconnecting = false;
  }
}

/** Drops a terminal and everything it was holding. */
function dispose(id: string) {
  const held = terminals.get(id);
  if (!held) return;
  held.term.dispose();
  terminals.delete(id);
}

/** Fonts worth offering, and the reason each one is here. */
const FONTS: { value: string; label: string }[] = [
  { value: '', label: 'System monospace' },
  { value: 'Cascadia Mono, Consolas, monospace', label: 'Cascadia Mono' },
  { value: 'Consolas, monospace', label: 'Consolas' },
  { value: 'JetBrains Mono, monospace', label: 'JetBrains Mono' },
  { value: 'Menlo, monospace', label: 'Menlo' },
  { value: 'DejaVu Sans Mono, monospace', label: 'DejaVu Sans Mono' },
  { value: 'Courier New, monospace', label: 'Courier New' },
];

const SYSTEM_MONO = 'ui-monospace, "Cascadia Mono", "JetBrains Mono", Consolas, monospace';

/** The colours a terminal draws with, read from the chrome's own tokens so a
 *  shell does not sit in the window looking like a different application. */
function themeFromChrome(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--bg-raised', '#13171d'),
    foreground: token('--text', '#e8eee9'),
    cursor: token('--accent', '#4da3ff'),
    // No `--selection` token exists; the accent at a third is what the rest
    // of the chrome selects with.
    selectionBackground: 'rgba(78, 168, 240, 0.35)',
  };
}

/** Text to the device, encoded the way the backend wants it. */
function sendText(id: string, text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return ipc.sshSend(id, btoa(binary)).catch(() => undefined) as Promise<void>;
}

/** Base64 from the backend, as the bytes it stands for. */
function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function SshPanel() {
  const tabs = useStore((s) => s.sshSessions);
  const active = useStore((s) => s.sshActive);
  const setActive = useStore((s) => s.setSshActive);
  const terminal = useStore((s) => s.settings.terminal);
  const setTerminal = useStore((s) => s.setTerminalSettings);
  const backupFolder = useStore((s) => s.settings.backupFolder);
  const timeFormat = useStore((s) => s.settings.timeFormat);
  const [problem, setProblem] = useState<string | null>(null);
  const [finding, setFinding] = useState('');
  const [findOpen, setFindOpen] = useState(false);
  // Sending one command to several sessions. Closed, empty and with
  // nothing ticked every time it is opened — see the guard rails below.
  const [sending, setSending] = useState(false);
  const [command, setCommand] = useState('');
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const current = tabs.find((tab) => tab.id === active);
  const open = tabs.filter((tab) => tab.status === 'open');
  const chosen = open.filter((tab) => targets.has(tab.id));

  /** Find in the session in front of you. */
  const find = (forward: boolean) => {
    const held = active ? terminals.get(active) : undefined;
    if (!held || !finding) return;
    if (forward) held.search.findNext(finding);
    else held.search.findPrevious(finding);
  };

  /**
   * Send the command to every ticked session.
   *
   * Only to sessions that are **open**, and only to ones still on screen —
   * both re-checked here rather than trusted from when the box was ticked,
   * because a session can drop between ticking and confirming and the whole
   * point of this dialog is that nothing is sent anywhere unexpected.
   */
  const sendToMany = () => {
    const live = tabs.filter((tab) => tab.status === 'open' && targets.has(tab.id));
    if (live.length === 0) {
      setProblem(t('ssh.sendPickSome'));
      return;
    }
    for (const tab of live) void sendText(tab.id, `${command}\r`);
    setNote(t('ssh.sendSent', { count: t('ssh.sessions', { count: live.length }) }));
    setConfirming(false);
    setSending(false);
    setCommand('');
    setTargets(new Set());
  };

  // One listener for every session: the event carries the id, and the map
  // above says which terminal it belongs to.
  //
  // `colourise` is read from the store inside the handler rather than closed
  // over, so switching the toggle takes effect on the next byte instead of
  // needing the subscription torn down and rebuilt mid-session.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    // A prompt never ends in a newline, so the colouriser would hold it back
    // for ever. Whatever is still held a moment after the device stops talking
    // is written through uncoloured.
    const flushes = new Map<string, ReturnType<typeof setTimeout>>();
    const flushSoon = (id: string) => {
      clearTimeout(flushes.get(id));
      flushes.set(
        id,
        setTimeout(() => {
          const held = terminals.get(id);
          if (held?.colour.pending) held.term.write(held.colour.flush());
        }, 40),
      );
    };

    void ipc
      .onSshEvent((e: SshEvent) => {
        // A login stage, before any session id exists — show it on the
        // status line so the wait is legible instead of a frozen "Connecting…".
        if (e.kind === 'progress') {
          const name = useStore.getState().doc.pages.flatMap((pg) => pg.nodes).find((n) => n.type === 'device' && (n.data as { addresses?: { address: string }[] }).addresses?.some((a) => a.address === e.address));
          const label = (name?.data as { label?: string } | undefined)?.label ?? e.address;
          useStore.getState().setStatusMessage(t(`ssh.stage.${e.stage}`, { name: label }));
          return;
        }
        const held = terminals.get(e.id);
        if (e.kind === 'data') {
          if (!held) return;
          const bytes = decode(e.bytes);
          if (!useStore.getState().settings.terminal.colourise) {
            // Anything the colouriser was holding goes out first, or the
            // screen loses a line at the moment the toggle is turned off.
            if (held.colour.pending) held.term.write(held.colour.flush());
            held.term.write(bytes);
            return;
          }
          held.term.write(held.colour.feed(new TextDecoder().decode(bytes)));
          flushSoon(e.id);
          return;
        }
        if (e.kind === 'closed') {
          if (held?.colour.pending) held.term.write(held.colour.flush());
          held?.term.write(`\r\n\x1b[2m${e.reason}\x1b[0m\r\n`);
          // And how to get it back, where that is possible.
          if (useStore.getState().sshSessions.find((x) => x.id === e.id)?.credentialId) {
            held?.term.write(`\x1b[2m${t('ssh.pressEnter')}\x1b[0m\r\n`);
          }
          useStore.getState().endSshTab(e.id, e.reason);
          return;
        }
        if (e.kind === 'alive') {
          useStore.getState().noteSshAlive(e.id, e.at);
          return;
        }
        if (e.kind === 'logging') {
          useStore.getState().setSshLog(e.id, e.path);
          return;
        }
        setProblem(e.message);
      })
      .then((off) => {
        if (cancelled) off();
        else stop = off;
      })
      .catch((err: unknown) => setProblem(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
      for (const timer of flushes.values()) clearTimeout(timer);
      stop?.();
    };
  }, []);

  // The font and the size belong to every open session at once, so they are
  // applied here rather than inside each terminal.
  useEffect(() => {
    for (const held of terminals.values()) {
      held.term.options.fontFamily = terminal.fontFamily || SYSTEM_MONO;
      held.term.options.fontSize = terminal.fontSize;
      try {
        held.fit.fit();
      } catch {
        /* not laid out yet; the resize observer will do it */
      }
    }
  }, [terminal.fontFamily, terminal.fontSize]);

  // A tab that has gone — closed by hand, or taken away with the project —
  // leaves a terminal holding a canvas and its scrollback. Nothing else drops
  // them, so this does.
  useEffect(() => {
    const live = new Set(tabs.map((tab) => tab.id));
    for (const id of [...terminals.keys()]) if (!live.has(id)) dispose(id);
  }, [tabs]);

  /** Start or stop this session's transcript. */
  const toggleLog = (tab: SshTab) => {
    setProblem(null);
    if (tab.logPath) {
      void ipc.sshLogStop(tab.id).catch((e: unknown) => setProblem(String(e)));
      return;
    }
    if (!backupFolder) {
      setProblem(t('ssh.logNoFolder'));
      return;
    }
    const node = tab.nodeId
      ? useStore
          .getState()
          .doc.pages.flatMap((page) => page.nodes)
          .find((n) => n.id === tab.nodeId)
      : undefined;
    const data = (node?.data ?? {}) as { site?: string };
    void ipc
      .sshLogStart(tab.id, {
        folder: backupFolder,
        device: tab.label,
        address: tab.address,
        site: data.site ?? '',
        pattern: undefined,
      })
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };

  const controls = (
    <div className="cv-ssh-controls">
      <label className="cv-field cv-field-narrow">
        <span>{t('ssh.font')}</span>
        <select className="cv-input" value={terminal.fontFamily}
          onChange={(e) => setTerminal({ fontFamily: e.target.value })}>
          {FONTS.map((f) => (
            <option key={f.label} value={f.value}>{f.value ? f.label : t('ssh.systemFont')}</option>
          ))}
        </select>
      </label>
      <label className="cv-field cv-field-narrow cv-ssh-size">
        <span>{t('ssh.size')}</span>
        <input className="cv-input" type="number" min={8} max={32} value={terminal.fontSize}
          onChange={(e) => setTerminal({ fontSize: Math.min(Math.max(Number(e.target.value) || 12, 8), 32) })} />
      </label>
      <label className="cv-check cv-check-inline" title={t('ssh.colourHint')}>
        <input type="checkbox" checked={terminal.colourise}
          onChange={(e) => setTerminal({ colourise: e.target.checked })} />
        {t('ssh.colour')}
      </label>
      {/* Both off until asked for, and each says why in its tooltip. */}
      <label className="cv-check cv-check-inline" title={t('ssh.copyOnSelectHint')}>
        <input type="checkbox" checked={terminal.copyOnSelect}
          onChange={(e) => setTerminal({ copyOnSelect: e.target.checked })} />
        {t('ssh.copyOnSelect')}
      </label>
      <label className="cv-check cv-check-inline" title={t('ssh.pasteOnRightHint')}>
        <input type="checkbox" checked={terminal.pasteOnRight}
          onChange={(e) => setTerminal({ pasteOnRight: e.target.checked })} />
        {t('ssh.pasteOnRight')}
      </label>
      <label className="cv-check cv-check-inline" title={t('ssh.logHint')}>
        <input type="checkbox" checked={Boolean(current?.logPath)} disabled={!current}
          onChange={() => current && toggleLog(current)} />
        {t('ssh.log')}
      </label>
      <label className="cv-field cv-field-narrow cv-ssh-size" title={t('ssh.keepaliveHint')}>
        <span>{t('ssh.keepalive')}</span>
        <input className="cv-input" type="number" min={0} max={3600} value={terminal.keepaliveSeconds}
          onChange={(e) => {
            const seconds = Math.min(Math.max(Number(e.target.value) || 0, 0), 3600);
            setTerminal({ keepaliveSeconds: seconds });
            // Every open session follows, not just the next one opened.
            for (const tab of useStore.getState().sshSessions) {
              if (tab.status === 'open') void ipc.sshKeepalive(tab.id, seconds).catch(() => undefined);
            }
          }} />
      </label>
      <button type="button" className="cv-btn cv-btn-small" onClick={() => setFindOpen((was) => !was)}
        disabled={!current} aria-expanded={findOpen}>
        {t('ssh.find')}
      </button>
      {/* Sending to several. The button opens a form; the form does
          not send. */}
      <button type="button" className="cv-btn cv-btn-small" disabled={open.length === 0}
        title={open.length === 0 ? t('ssh.sendNoneOpen') : t('ssh.sendToManyHint')}
        onClick={() => { setSending(true); setTargets(new Set()); setConfirming(false); setNote(null); }}>
        {t('ssh.sendToMany')}
      </button>
    </div>
  );

  if (tabs.length === 0) {
    return (
      <div className="cv-ssh cv-ssh-empty">
        <p className="cv-help">{t('ssh.empty')}</p>
        <div className="cv-ssh-foot" data-region="ssh-foot">
          <span className="cv-ssh-foot-name">{t('ssh.noSession')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="cv-ssh">
      <div className="cv-tabs cv-ssh-tabs" role="tablist" aria-label={t('ssh.title')}>
        {tabs.map((tab) => (
          <span key={tab.id} className={`cv-ssh-tab${tab.id === active ? ' is-active' : ''}`}>
            <button type="button" role="tab" aria-selected={tab.id === active}
              tabIndex={tab.id === active ? 0 : -1}
              className={tab.id === active ? 'is-active' : ''}
              title={tab.status === 'closed' ? tab.reason : tab.address}
              onClick={() => setActive(tab.id)}>
              <span className={`cv-ssh-dot${tab.status === 'closed' ? ' is-closed' : ''}`} aria-hidden="true" />{' '}
              {tab.label}
              {tab.logPath ? <> <ChromeIcon name="pen" size={11} /><span className="cv-sr">{t('ssh.logging')}</span></> : null}
            </button>
            <button type="button" className="cv-ssh-close" aria-label={t('ssh.closeOne', { name: tab.label })}
              onClick={() => {
                void ipc.sshClose(tab.id).catch(() => undefined);
                dispose(tab.id);
                useStore.getState().forgetSshTab(tab.id);
              }}>
              ×
            </button>
          </span>
        ))}
      </div>
      {controls}
      {findOpen && (
        <div className="cv-ssh-find">
          <input className="cv-input" value={finding} autoFocus
            aria-label={t('ssh.findPlaceholder')} placeholder={t('ssh.findPlaceholder')}
            onChange={(e) => setFinding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') find(!e.shiftKey);
              if (e.key === 'Escape') setFindOpen(false);
            }} />
          <button type="button" className="cv-btn cv-btn-small" onClick={() => find(false)}
            aria-label={t('ssh.findPrev')}>‹</button>
          <button type="button" className="cv-btn cv-btn-small" onClick={() => find(true)}
            aria-label={t('ssh.findNext')}>›</button>
          <button type="button" className="cv-btn cv-btn-small" onClick={() => setFindOpen(false)}
            aria-label={t('ssh.findClose')}>×</button>
        </div>
      )}
      {sending && (
        <div className="cv-ssh-send" data-region="send-to-many">
          <strong>{t('ssh.sendToManyTitle')}</strong>
          <p className="cv-help">{t('ssh.sendToManyHint')}</p>
          <label className="cv-field">
            <span>{t('ssh.sendCommand')}</span>
            <input className="cv-input cv-mono" value={command} spellCheck={false}
              onChange={(e) => { setCommand(e.target.value); setConfirming(false); }} />
          </label>
          <fieldset className="cv-ssh-targets">
            <legend>{t('ssh.sendTargets')}</legend>
            {/* Ticked by hand, one at a time. There is deliberately no
                "all" — choosing every device in an estate should take as
                long as it deserves. */}
            {open.map((tab) => (
              <label key={tab.id} className="cv-check cv-check-inline">
                <input type="checkbox" checked={targets.has(tab.id)}
                  onChange={(e) => {
                    setConfirming(false);
                    setTargets((was) => {
                      const next = new Set(was);
                      if (e.target.checked) next.add(tab.id);
                      else next.delete(tab.id);
                      return next;
                    });
                  }} />
                {tab.label}
              </label>
            ))}
          </fieldset>
          {confirming ? (
            <>
              <p className="cv-problem">
                {t('ssh.sendConfirm', {
                  command,
                  count: t('ssh.sessions', { count: chosen.length }),
                })}
              </p>
              <p className="cv-help">{t('ssh.sendNames', { names: chosen.map((c) => c.label).join(', ') })}</p>
              <div className="cv-keep-cred-held">
                <button type="button" className="cv-btn cv-btn-small cv-btn-danger" onClick={sendToMany}>
                  {t('ssh.sendGo')}
                </button>
                <button type="button" className="cv-btn cv-btn-small" onClick={() => setConfirming(false)}>
                  {t('ssh.sendCancel')}
                </button>
              </div>
            </>
          ) : (
            <div className="cv-keep-cred-held">
              <button type="button" className="cv-btn cv-btn-small cv-btn-start"
                disabled={!command.trim() || chosen.length === 0}
                onClick={() => setConfirming(true)}>
                {t('ssh.sendToMany')}
              </button>
              <button type="button" className="cv-btn cv-btn-small"
                onClick={() => { setSending(false); setConfirming(false); }}>
                {t('ssh.sendCancel')}
              </button>
            </div>
          )}
        </div>
      )}
      {problem && <p className="cv-problem">{problem}</p>}
      {!problem && note && <p className="cv-help">{note}</p>}
      <div className="cv-ssh-screens">
        {tabs.map((tab) => (
          <SshTerminal key={tab.tabKey ?? tab.id} tab={tab} visible={tab.id === active} />
        ))}
      </div>
      {/* The terminal's own footer: which session, whether it is logging,
          and when it last answered a keepalive. */}
      <div className="cv-ssh-foot" data-region="ssh-foot">
        <span className="cv-ssh-foot-name">{current ? current.label : t('ssh.noSession')}</span>
        {current?.logPath && <span className="cv-ssh-logging">{t('ssh.logTo', { path: current.logPath })}</span>}
        {current?.lastAlive !== undefined && (
          <span className="cv-ssh-foot-alive">{t('ssh.aliveAt', { time: formatTime(current.lastAlive, timeFormat) })}</span>
        )}
      </div>
    </div>
  );
}

/** One session's screen. Created once and kept until its tab is closed. */
function SshTerminal({ tab, visible }: { tab: SshTab; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = host.current;
    if (!mount) return;
    let held = terminals.get(tab.id);
    const isNew = !held;
    if (!held) {
      const { fontFamily, fontSize } = useStore.getState().settings.terminal;
      const term = new Terminal({
        fontFamily: fontFamily || SYSTEM_MONO,
        fontSize,
        // A device's output is worth scrolling back through; this is a few
        // hundred kilobytes per session and is not written anywhere.
        scrollback: 5000,
        theme: themeFromChrome(),
        // The device decides when to wrap, which is what the PTY size is for.
        convertEol: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      // A `show running-config` scrolls past long before it can be
      // read, and scrollback nobody can search is scrollback nobody uses.
      const search = new SearchAddon();
      term.loadAddon(search);
      held = { term, fit, search, colour: new Colouriser(), id: tab.id };
      terminals.set(tab.id, held);

      // Clipboard manners, both off until asked for. Read from the
      // store when the event happens rather than closed over, so a checkbox
      // takes effect on the next click instead of the next session.
      term.onSelectionChange(() => {
        if (!useStore.getState().settings.terminal.copyOnSelect) return;
        const picked = term.getSelection();
        if (picked) void navigator.clipboard?.writeText(picked).catch(() => undefined);
      });
      // Keystrokes as typed. Nothing is added, not even a newline: Enter is
      // already a carriage return in the data xterm hands over.
      // The session it sends to is the screen's current one, and in a
      // tab whose session has ended, Enter opens it again instead.
      const mine = held;
      term.onData((data) => {
        const now = useStore.getState().sshSessions.find((x) => x.id === mine.id);
        if (now?.status === 'closed') {
          if (data.includes('\r')) void reconnect(mine);
          return;
        }
        void sendText(mine.id, data);
      });
    }
    // Coming back to the SSH screen remounts this component with a
    // fresh host element, while the terminal and its scrollback live on in
    // `terminals`. A terminal is `open()`ed into its host exactly once, when
    // it is created; `open()` cannot re-parent an existing one. So on a
    // remount the terminal's own element is *moved* into the new host, then
    // refreshed — xterm draws nothing into a freshly re-parented element
    // until it is, which is why the screen came back blank.
    if (isNew) {
      held.term.open(mount);
    } else if (held.term.element && held.term.element.parentElement !== mount) {
      mount.appendChild(held.term.element);
      try {
        held.fit.fit();
      } catch {
        // no size yet; the visible effect below fits once there is one
      }
      held.term.refresh(0, held.term.rows - 1);
    }
    return () => undefined;
  }, [tab.id]);

  // Fit to whatever room the panel has, and tell the device when that changes
  // — otherwise it keeps wrapping for the size it was given at login.
  useEffect(() => {
    if (!visible) return;
    const held = terminals.get(tab.id);
    const mount = host.current;
    if (!held || !mount) return;
    const settle = () => {
      try {
        held.fit.fit();
      } catch {
        return;
      }
      if (tab.status === 'open') {
        void ipc.sshResize(tab.id, held.term.cols, held.term.rows).catch(() => undefined);
      }
    };
    settle();
    // A repaint after the fit, so a terminal that was off-screen and
    // has just come back draws its buffer rather than an empty screen.
    held.term.refresh(0, held.term.rows - 1);
    held.term.focus();
    const observer = new ResizeObserver(settle);
    observer.observe(mount);
    return () => observer.disconnect();
  }, [tab.id, tab.status, visible]);

  return (
    <div
      ref={host}
      className="cv-ssh-screen"
      hidden={!visible}
      // Right-click pastes, when it has been asked for. It types into
      // a live device with nothing to confirm, which is why it is off by
      // default and why what it sent is said out loud afterwards.
      onContextMenu={(e) => {
        if (!useStore.getState().settings.terminal.pasteOnRight) return;
        e.preventDefault();
        void navigator.clipboard
          ?.readText()
          .then((text) => (text ? sendText(tab.id, text) : undefined))
          .catch(() => undefined);
      }}
    />
  );
}
