/**
 * The page navigator (LT-183): every page in a list with a sketch of what is on
 * it, for a project with more pages than the tab strip shows at once.
 *
 * Opened from the button at the start of the tab strip. A row is chosen with a
 * click or the arrow keys, renamed with a double-click or F2, and moved by
 * dragging it or with Alt+Up/Down. Ctrl+PageUp and Ctrl+PageDown switch pages
 * from anywhere, open or not.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { thumbnailOf } from '../lib/pageThumb';
import { useStore, type ProjectPage } from '../state/store';

const THUMB_W = 96;
const THUMB_H = 60;

const PageSketch = memo(function PageSketch({ page }: { page: ProjectPage }) {
  const t = useMemo(() => thumbnailOf(page, THUMB_W, THUMB_H), [page]);
  return (
    <svg className="cv-page-thumb" width={THUMB_W} height={THUMB_H} viewBox={`0 0 ${THUMB_W} ${THUMB_H}`} aria-hidden="true">
      {t.lines.map((l, i) => (
        <line key={`l${i}`} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className="cv-page-thumb-link" />
      ))}
      {t.boxes.map((b, i) => (
        <rect key={`b${i}`} x={b.x} y={b.y} width={b.w} height={b.h} className={b.zone ? 'cv-page-thumb-zone' : 'cv-page-thumb-device'} />
      ))}
    </svg>
  );
});

export function PageNavigator({ onClose }: { onClose: () => void }) {
  const doc = useStore((s) => s.doc);
  const renamePage = useStore((s) => s.renamePage);
  const reorderPages = useStore((s) => s.reorderPages);
  const setActivePage = useStore((s) => s.setActivePage);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const at = Math.max(0, doc.pages.findIndex((p) => p.id === doc.activePageId));

  // The chosen row keeps the keyboard, so the arrow keys work straight away.
  useEffect(() => {
    if (renaming) return;
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, [at, renaming]);

  // Keys handled here stop here, so the arrows do not also nudge the selection
  // on the canvas.
  const onKey = (e: React.KeyboardEvent) => {
    if (renaming) return;
    const pages = doc.pages;
    const move = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (move) {
      e.preventDefault();
      e.stopPropagation();
      const to = Math.min(pages.length - 1, Math.max(0, at + move));
      if (to === at) return;
      if (e.altKey) reorderPages(at, to);
      else setActivePage(pages[to]!.id);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      setActivePage(pages[e.key === 'Home' ? 0 : pages.length - 1]!.id);
    } else if (e.key === 'F2') {
      e.preventDefault();
      e.stopPropagation();
      setRenaming(pages[at]!.id);
    } else if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="cv-page-nav" role="dialog" aria-label="Page navigator">
      <div className="cv-page-nav-head">
        <span>Pages</span>
        <span className="cv-page-nav-hint">↑↓ switch · Alt+↑↓ move · F2 rename</span>
      </div>
      <ul ref={listRef} className="cv-page-nav-list" role="listbox" aria-label="Pages" onKeyDown={onKey}>
        {doc.pages.map((p, i) => (
          <li
            key={p.id}
            role="option"
            aria-selected={i === at}
            tabIndex={i === at ? 0 : -1}
            className={`cv-page-nav-row${i === at ? ' is-active' : ''}${dragFrom !== null && dragFrom !== i ? ' is-drop' : ''}`}
            draggable={renaming !== p.id}
            onDragStart={() => setDragFrom(i)}
            onDragOver={(e) => e.preventDefault()}
            onDragEnd={() => setDragFrom(null)}
            onDrop={(e) => {
              e.preventDefault();
              if (dragFrom !== null && dragFrom !== i) reorderPages(dragFrom, i);
              setDragFrom(null);
            }}
            onClick={() => setActivePage(p.id)}
            onDoubleClick={() => setRenaming(p.id)}
          >
            <PageSketch page={p} />
            <span className="cv-page-nav-text">
              {renaming === p.id ? (
                <input
                  className="cv-page-nav-rename"
                  aria-label="Page name"
                  defaultValue={p.name}
                  autoFocus
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') {
                      e.currentTarget.value = p.name;
                      e.currentTarget.blur();
                    }
                  }}
                  // A blank name is refused by the store, which keeps the old one.
                  onBlur={(e) => {
                    if (e.target.value.trim()) renamePage(p.id, e.target.value);
                    setRenaming(null);
                  }}
                />
              ) : (
                <span className="cv-page-nav-name">{p.name}</span>
              )}
              <span className="cv-page-nav-count">
                {p.nodes.length} object{p.nodes.length === 1 ? '' : 's'} · {p.edges.length} link{p.edges.length === 1 ? '' : 's'}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
