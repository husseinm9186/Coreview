/**
 * The user guide, in the app (LT-303).
 *
 * The same `docs/USER_GUIDE.md` that ships in the repository, read at build
 * time and shown here — one copy, so what the app says and what the repository
 * says cannot drift apart. Sections down the left, the section you picked on
 * the right, and a search box that reads the whole of every section rather than
 * only the titles, because nobody looking for "why is my device grey" knows
 * which of thirty headings it lives under.
 *
 * A screen rather than a dialog, for the same reason the register is one
 * (D-044): it is read alongside the work, at length, and a dialog that covers
 * the thing you are reading about is a dialog you close before you have
 * finished.
 */
import { useMemo, useState } from 'react';

import { t } from '../i18n';
import { helpSections, searchHelp, type HelpBlock } from '../lib/helpDoc';
import { inlinePieces } from '../lib/noteMarkdown';
import { useStore } from '../state/store';
import guide from '../../docs/USER_GUIDE.md?raw';

/** `**bold**`, `*italic*`, `` `code` `` and links, as the notes already do. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {inlinePieces(text).map((piece, i) => {
        const key = `${i}-${piece.text}`;
        switch (piece.kind) {
          case 'code':
            return <code key={key}>{piece.text}</code>;
          case 'link':
            return (
              <a key={key} href={piece.url} target="_blank" rel="noreferrer noopener">
                {piece.text}
              </a>
            );
          case 'bold':
            return <strong key={key}>{piece.text}</strong>;
          case 'italic':
            return <em key={key}>{piece.text}</em>;
          case 'strike':
            return <s key={key}>{piece.text}</s>;
          default:
            return <span key={key}>{piece.text}</span>;
        }
      })}
    </>
  );
}

function Block({ block }: { block: HelpBlock }) {
  switch (block.kind) {
    case 'heading':
      return <h3 className="cv-help-h3"><Inline text={block.text} /></h3>;
    case 'paragraph':
      return <p><Inline text={block.text} /></p>;
    case 'bullet':
      return <li><Inline text={block.text} /></li>;
    case 'number':
      return <li value={block.n}><Inline text={block.text} /></li>;
    case 'quote':
      return <blockquote><Inline text={block.text} /></blockquote>;
    case 'code':
      return <pre className="cv-help-code"><code>{block.lines.join('\n')}</code></pre>;
    case 'rule':
      return <hr />;
    case 'table':
      return (
        <div className="cv-help-tablewrap">
          <table className="cv-table">
            <thead>
              <tr>{block.head.map((h, i) => <th key={`${i}-${h}`}><Inline text={h} /></th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => <td key={`${c}-${cell}`}><Inline text={cell} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** Bullets and numbers are wrapped in one list rather than one list each. */
function Blocks({ blocks }: { blocks: readonly HelpBlock[] }) {
  const out: React.ReactNode[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]!;
    if (block.kind === 'bullet' || block.kind === 'number') {
      const run: HelpBlock[] = [];
      const kind = block.kind;
      while (i < blocks.length && blocks[i]!.kind === kind) {
        run.push(blocks[i]!);
        i += 1;
      }
      i -= 1;
      const List = kind === 'bullet' ? 'ul' : 'ol';
      out.push(
        <List key={`list-${i}`}>
          {run.map((b, n) => <Block key={`${n}-${'text' in b ? b.text : ''}`} block={b} />)}
        </List>,
      );
      continue;
    }
    out.push(<Block key={`b-${i}`} block={block} />);
  }
  return <>{out}</>;
}

export function HelpScreen() {
  const close = useStore((s) => s.setHelpOpen);
  const sections = useMemo(() => helpSections(guide), []);
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(sections[0]?.id ?? '');

  const found = useMemo(() => searchHelp(sections, query), [sections, query]);
  // A search that has narrowed the list moves to its first hit, so the body
  // is never a section the list no longer offers.
  const shown = found.find((s) => s.id === at) ?? found[0];

  return (
    <div className="cv-helpscreen" data-region="help">
      <div className="cv-register-head">
        <h1 className="cv-register-title">{t('help.title')}</h1>
        <input className="cv-input cv-help-search" value={query} aria-label={t('help.search')}
          placeholder={t('help.search')} onChange={(e) => setQuery(e.target.value)} />
        <span className="cv-help">{t('help.found', { count: found.length })}</span>
        <button type="button" className="cv-btn cv-register-back" onClick={() => close(false)}>
          {t('help.back')}
        </button>
      </div>

      <div className="cv-helpscreen-body">
        <nav className="cv-help-nav" aria-label={t('help.contents')}>
          {found.map((s) => (
            <button key={s.id} type="button"
              className={`cv-help-navitem${shown?.id === s.id ? ' is-active' : ''}`}
              aria-current={shown?.id === s.id} onClick={() => setAt(s.id)}>
              {s.title}
            </button>
          ))}
          {found.length === 0 && <p className="cv-help">{t('help.noMatch')}</p>}
        </nav>

        <article className="cv-help-body">
          {shown ? (
            <>
              <h2 className="cv-help-h2">{shown.title}</h2>
              <Blocks blocks={shown.blocks} />
            </>
          ) : (
            <p className="cv-help">{t('help.noMatch')}</p>
          )}
        </article>
      </div>
    </div>
  );
}
