/**
 * The command palette (LT-230, LT-231): Ctrl/Cmd+K, then type.
 *
 * Without a prefix it searches the whole project — devices on every page,
 * their addresses, MACs, hostnames, ports, VLANs and subnets, the probes, the
 * notes and the shapes — and choosing a result goes to it: to its page,
 * selected, in view. With `>` it lists commands instead. Arrow keys move,
 * Enter chooses, Escape closes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { fuzzyScore, search, searchIndex, type SearchItem, type SearchKind } from '../lib/search';
import { useStore } from '../state/store';
import { DEVICE_LABEL, PALETTE_GROUPS } from './icons';

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

const KIND_LABEL: Record<SearchKind, string> = {
  device: 'Device',
  address: 'Address',
  mac: 'MAC',
  hostname: 'Hostname',
  port: 'Port',
  vlan: 'VLAN',
  subnet: 'Subnet',
  probe: 'Probe',
  note: 'Note',
  shape: 'Shape',
};

export function CommandPalette({
  commands,
  onGoTo,
  onAddShape,
  onClose,
}: {
  commands: PaletteCommand[];
  onGoTo: (item: SearchItem) => void;
  onAddShape: (type: string) => void;
  onClose: () => void;
}) {
  const doc = useStore((s) => s.doc);
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const shapes = useMemo(
    () => [...new Set(PALETTE_GROUPS.flatMap((g) => g.items))].map((type) => ({ type, label: DEVICE_LABEL[type] })),
    [],
  );
  const index = useMemo(() => searchIndex(doc, shapes), [doc, shapes]);
  const commandMode = query.startsWith('>');

  const rows: { key: string; title: string; detail: string; kind: string; choose: () => void }[] = useMemo(() => {
    if (commandMode) {
      const q = query.slice(1).trim();
      return commands
        .map((c) => ({ c, score: q ? fuzzyScore(q, c.label) : 0 }))
        .filter((x) => x.score !== null)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .map(({ c }) => ({ key: c.id, title: c.label, detail: c.hint ?? '', kind: 'Command', choose: c.run }));
    }
    return search(index, query).map((item, i) => ({
      key: `${item.kind}-${i}-${item.text}`,
      title: item.text,
      detail: item.detail,
      kind: KIND_LABEL[item.kind],
      choose: () => (item.kind === 'shape' && item.shape ? onAddShape(item.shape) : onGoTo(item)),
    }));
  }, [commandMode, commands, index, onAddShape, onGoTo, query]);

  useEffect(() => input.current?.focus(), []);
  // LT-271: opening search is a step of the guided tour.
  useEffect(() => useStore.getState().noteGuide('search'), []);
  useEffect(() => setAt(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const choose = (i: number) => {
    const row = rows[i];
    if (!row) return;
    onClose();
    row.choose();
  };

  return (
    <div className="cv-palette-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="cv-command-palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="cv-input cv-command-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="cv-command-results"
          aria-activedescendant={rows[at] ? `cv-command-${at}` : undefined}
          aria-label="Search the project, or type > for commands"
          placeholder="Search devices, addresses, ports, VLANs… or > for commands"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setAt((i) => Math.min(rows.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setAt((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(at);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
            e.stopPropagation();
          }}
        />
        <ul ref={list} id="cv-command-results" className="cv-command-results" role="listbox">
          {rows.map((r, i) => (
            <li
              key={r.key}
              id={`cv-command-${i}`}
              role="option"
              aria-selected={i === at}
              className={i === at ? 'is-active' : ''}
              onMouseEnter={() => setAt(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
            >
              <span className="cv-command-kind">{r.kind}</span>
              <span className="cv-command-title">{r.title}</span>
              <span className="cv-command-detail">{r.detail}</span>
            </li>
          ))}
        </ul>
        <p className="cv-command-foot">
          {query && rows.length === 0 ? 'Nothing matches.' : commandMode ? `${rows.length} command${rows.length === 1 ? '' : 's'}` : query ? `${rows.length} found` : 'Type to search every page. > for commands.'}
        </p>
      </div>
    </div>
  );
}
