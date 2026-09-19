import { memo } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';

import { useStore } from '../../state/store';
import { canvasPalette, notePalette } from '../../theme';
import { ipc } from '../../lib/ipc';
import type { NoteNodeData } from '../../types/domain';
import { inlinePieces, noteBlocks } from '../../lib/noteMarkdown';

/** Every link — in body text or the note's own Link field — opens the same
 *  way: through the one Rust command that actually leaves the app (LT-095).
 *  There is no shell plugin here by design, so a plain `<a href>` must never
 *  be allowed to navigate the webview itself. */
function openLink(url: string) {
  ipc.openExternalUrl(url).catch((err: unknown) => console.error(err));
}

/** A note's body, from the shared Markdown reader (LT-096, LT-237). */
function renderBody(body: string) {
  return noteBlocks(body).map((b, i) => {
    const key = `${i}-${b.kind}`;
    switch (b.kind) {
      case 'heading':
        return b.level === 1 ? <h3 key={key}>{inline(b.text)}</h3> : b.level === 2 ? <h4 key={key}>{inline(b.text)}</h4> : <h5 key={key}>{inline(b.text)}</h5>;
      case 'check':
        return (
          <label key={key} className="cv-note-check">
            <input type="checkbox" checked={b.checked} readOnly tabIndex={-1} />
            <span>{inline(b.text)}</span>
          </label>
        );
      case 'bullet':
        return <li key={key}>{inline(b.text)}</li>;
      case 'number':
        return <p key={key} className="cv-note-number"><span>{b.n}.</span> {inline(b.text)}</p>;
      case 'quote':
        return <blockquote key={key}>{inline(b.text)}</blockquote>;
      case 'rule':
        return <hr key={key} />;
      case 'blank':
        return <br key={key} />;
      default:
        return <p key={key}>{inline(b.text)}</p>;
    }
  });
}

/** Exported for direct testing (LT-096) — a JSX-returning parser is still a
 *  pure function; no render/DOM needed to check its output shape. */
export function inline(text: string) {
  return inlinePieces(text).map((p, i) => {
    switch (p.kind) {
      case 'bold':
        return <strong key={i}>{p.text}</strong>;
      case 'italic':
        return <em key={i}>{p.text}</em>;
      case 'strike':
        return <s key={i}>{p.text}</s>;
      case 'code':
        return <code key={i}>{p.text}</code>;
      case 'link':
        return (
          <a
            key={i}
            href={p.url}
            className="cv-note-link"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openLink(p.url);
            }}
          >
            {p.text}
          </a>
        );
      default:
        return <span key={i}>{p.text}</span>;
    }
  });
}

function NoteNodeInner({ data, selected }: NodeProps) {
  const d = data as NoteNodeData;
  const reduceMotion = useStore((s) => s.settings.reduceMotion);
  const ground = useStore((s) => s.settings.ground);
  const fallback = notePalette(d.variant ?? 'plain', ground);
  return (
    <div
      className={`cv-note ${d.variant === 'change' ? 'is-change' : d.variant === 'sticky' ? 'is-sticky' : ''} ${selected ? 'is-selected' : ''}`}
      style={{
        background: d.background ?? fallback.background,
        color: d.textColor ?? fallback.text,
        borderColor: selected ? canvasPalette(ground).selection : (d.borderColor ?? fallback.border),
        fontSize: d.fontSize,
        transition: reduceMotion ? 'none' : undefined,
      }}
    >
      <NodeResizer
        isVisible={Boolean(selected) && !d.locked}
        minWidth={140}
        minHeight={80}
        lineClassName="cv-resize-line"
        handleClassName="cv-resize-handle"
      />
      {d.locked && <span className="cv-lock" title="Locked">🔒</span>}
      {d.link && (
        <span
          className="cv-node-link nodrag nopan"
          title={d.link}
          aria-label={`Open ${d.link}`}
          role="button"
          onClick={(e) => {
            e.stopPropagation();
            openLink(d.link!);
          }}
        >
          🔗
        </span>
      )}
      {d.title && <div className="cv-note-title">{d.title}</div>}
      <div className="cv-note-body">{renderBody(d.body)}</div>
    </div>
  );
}

export const NoteNode = memo(NoteNodeInner);
