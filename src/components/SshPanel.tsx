import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { t } from '../i18n';
import { ipc, type SshEvent } from '../lib/ipc';
import { useStore, type SshTab } from '../state/store';

/**
 * Open shells, one tab each (LT-320).
 *
 * The operator asked for SecureCRT's arrangement in as many words: right-click
 * a device, get a shell, and find every shell he has open sitting as tabs
 * beside each other. This is that — the bottom panel's **SSH** section, a tab
 * per session, the device's own screen inside it.
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
const terminals = new Map<string, { term: Terminal; fit: FitAddon }>();

/** Drops a terminal and everything it was holding. */
function dispose(id: string) {
  const held = terminals.get(id);
  if (!held) return;
  held.term.dispose();
  terminals.delete(id);
}

/** The colours a terminal draws with, read from the chrome's own tokens so a
 *  shell does not sit in the window looking like a different application. */
function themeFromChrome(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--bg-raised', '#0f1a16'),
    foreground: token('--text', '#e8eee9'),
    cursor: token('--accent', '#4da3ff'),
    // No `--selection` token exists; the accent at a third is what the rest
    // of the chrome selects with.
    selectionBackground: 'rgba(78, 168, 240, 0.35)',
  };
}

export function SshPanel() {
  const tabs = useStore((s) => s.sshSessions);
  const active = useStore((s) => s.sshActive);
  const setActive = useStore((s) => s.setSshActive);
  const [problem, setProblem] = useState<string | null>(null);

  // One listener for every session: the event carries the id, and the map
  // above says which terminal it belongs to.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void ipc
      .onSshEvent((e: SshEvent) => {
        const held = terminals.get(e.id);
        if (e.kind === 'data') {
          // Base64 in, bytes out. `atob` gives one character per byte, which
          // is what xterm's byte-oriented write wants.
          const binary = atob(e.bytes);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
          held?.term.write(bytes);
          return;
        }
        held?.term.write(`\r\n\x1b[2m${e.reason}\x1b[0m\r\n`);
        useStore.getState().endSshTab(e.id, e.reason);
      })
      .then((off) => {
        if (cancelled) off();
        else stop = off;
      })
      .catch((err: unknown) => setProblem(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  // A tab that has gone — closed by hand, or taken away with the project —
  // leaves a terminal holding a canvas and its scrollback. Nothing else drops
  // them, so this does.
  useEffect(() => {
    const live = new Set(tabs.map((t) => t.id));
    for (const id of [...terminals.keys()]) if (!live.has(id)) dispose(id);
  }, [tabs]);

  if (tabs.length === 0) {
    return (
      <div className="cv-ssh cv-ssh-empty">
        <p className="cv-help">{t('ssh.empty')}</p>
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
              {tab.status === 'closed' ? '○ ' : '● '}
              {tab.label}
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
      {problem && <p className="cv-problem">{problem}</p>}
      <div className="cv-ssh-screens">
        {tabs.map((tab) => (
          <SshTerminal key={tab.id} tab={tab} visible={tab.id === active} />
        ))}
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
    if (!held) {
      const term = new Terminal({
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace',
        fontSize: 12,
        // A device's output is worth scrolling back through; this is a few
        // hundred kilobytes per session and is not written anywhere.
        scrollback: 5000,
        theme: themeFromChrome(),
        // The device decides when to wrap, which is what the PTY size is for.
        convertEol: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      held = { term, fit };
      terminals.set(tab.id, held);
      // Keystrokes as typed. Nothing is added, not even a newline: Enter is
      // already a carriage return in the data xterm hands over.
      term.onData((data) => {
        const bytes = new TextEncoder().encode(data);
        let binary = '';
        for (const b of bytes) binary += String.fromCharCode(b);
        void ipc.sshSend(tab.id, btoa(binary)).catch(() => undefined);
      });
    }
    if (held.term.element?.parentElement !== mount) held.term.open(mount);
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
    held.term.focus();
    const observer = new ResizeObserver(settle);
    observer.observe(mount);
    return () => observer.disconnect();
  }, [tab.id, tab.status, visible]);

  return <div ref={host} className="cv-ssh-screen" hidden={!visible} />;
}
