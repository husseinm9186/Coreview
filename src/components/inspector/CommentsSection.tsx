/**
 * Comments on a device or a link (LT-239): threads with replies, resolved
 * when done. The name signed on a comment is remembered on this machine.
 */
import { useState } from 'react';

import { addReply, addThread, openThreads, setResolved, type CommentThread } from '../../lib/comments';
import { uid } from '../../lib/id';
import { formatTime } from '../../lib/timeFormat';
import { useStore } from '../../state/store';

const AUTHOR_KEY = 'coreview.commentAuthor';

function rememberedAuthor(): string {
  try {
    return localStorage.getItem(AUTHOR_KEY) ?? '';
  } catch {
    return '';
  }
}

export function CommentsSection({ threads, onChange }: { threads: CommentThread[] | undefined; onChange: (next: CommentThread[], label: string) => void }) {
  const timeFormat = useStore((s) => s.settings.timeFormat);
  const [author, setAuthor] = useState(rememberedAuthor);
  const [text, setText] = useState('');
  const [replying, setReplying] = useState<Record<string, string>>({});
  const [showResolved, setShowResolved] = useState(false);
  const list = threads ?? [];
  const shown = list.filter((t) => showResolved || !t.resolved);
  const remember = (name: string) => {
    setAuthor(name);
    try {
      localStorage.setItem(AUTHOR_KEY, name);
    } catch {
      /* storage off: the name is asked again next time */
    }
  };

  return (
    <section className="cv-section cv-comments" aria-label="Comments">
      <h3>
        Comments <span className="cv-palette-count">{openThreads(list)} open</span>
      </h3>
      {list.some((t) => t.resolved) && (
        <label className="cv-check cv-check-inline">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
        </label>
      )}
      {shown.map((t) => (
        <article key={t.id} className={`cv-comment${t.resolved ? ' is-resolved' : ''}`}>
          <header>
            <strong>{t.author}</strong> <span className="cv-help">{formatTime(t.at, timeFormat, false)}</span>
            <button type="button" className="cv-btn cv-btn-small" onClick={() => onChange(setResolved(list, t.id, !t.resolved), t.resolved ? 'Reopen a comment' : 'Resolve a comment')}>
              {t.resolved ? 'Reopen' : 'Resolve'}
            </button>
          </header>
          <p>{t.text}</p>
          {t.replies.map((r) => (
            <div key={r.id} className="cv-comment-reply">
              <strong>{r.author}</strong> <span className="cv-help">{formatTime(r.at, timeFormat, false)}</span>
              <p>{r.text}</p>
            </div>
          ))}
          <div className="cv-row cv-row-tight">
            <input className="cv-input" aria-label="Reply" placeholder="Reply" value={replying[t.id] ?? ''}
              onChange={(e) => setReplying((x) => ({ ...x, [t.id]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !(replying[t.id] ?? '').trim()) return;
                onChange(addReply(list, t.id, author, replying[t.id] ?? '', Date.now(), uid()), 'Reply to a comment');
                setReplying((x) => ({ ...x, [t.id]: '' }));
              }} />
          </div>
        </article>
      ))}
      <div className="cv-comment-new">
        <input className="cv-input" aria-label="Your name" placeholder="Your name" value={author} onChange={(e) => remember(e.target.value)} />
        <textarea className="cv-input" aria-label="New comment" rows={2} placeholder="Ask or note something about this" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="button" className="cv-btn cv-btn-small" disabled={!text.trim()}
          onClick={() => {
            onChange(addThread(list, author, text, Date.now(), uid()), 'Comment');
            setText('');
          }}>
          Comment
        </button>
      </div>
    </section>
  );
}
