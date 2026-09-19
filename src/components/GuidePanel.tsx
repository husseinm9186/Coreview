/**
 * The guided tour beside the canvas (LT-271). Shown only on a project that
 * carries one — the guided sample — and hidden for good with one click.
 */
import { useEffect } from 'react';

import { guideProgress, newlyDone } from '../lib/guide';
import { activePage } from '../lib/pages';
import { useStore } from '../state/store';
import { t } from '../i18n';

export function GuidePanel() {
  const guide = useStore((s) => s.doc.guide);
  const selectedDevice = useStore((s) => activePage(s.doc).nodes.some((n) => n.selected && n.type === 'device'));
  const selectedLink = useStore((s) => activePage(s.doc).edges.some((e) => e.selected));
  const sessionRunning = useStore((s) => s.session.state === 'running');
  const runtime = useStore((s) => s.runtime);

  const state = { selectedDevice, selectedLink, sessionRunning, runtime, done: guide?.done ?? [] };
  const fresh = guide ? newlyDone(state) : [];
  useEffect(() => {
    if (fresh.length) useStore.getState().noteGuide(...fresh);
  }, [fresh.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!guide || guide.hidden) return null;
  const steps = guideProgress(state);
  const next = steps.find((s) => !s.done);
  const count = steps.filter((s) => s.done).length;

  return (
    <aside className="cv-tour" aria-label={t('tour.label')}>
      <header>
        <strong>{t('tour.label')}</strong>
        <span className="cv-help">{t('tour.progress', { done: count, total: steps.length })}</span>
        <button type="button" className="cv-btn cv-btn-small" onClick={() => useStore.getState().hideGuide()}>
          {t('tour.hide')}
        </button>
      </header>
      <ol>
        {steps.map(({ step, done }) => (
          <li key={step.id} className={done ? 'is-done' : next?.step.id === step.id ? 'is-next' : ''} aria-current={next?.step.id === step.id ? 'step' : undefined}>
            <span className="cv-tour-mark" aria-hidden="true">{done ? '✓' : '•'}</span>
            <span>
              <span className="cv-tour-title">{step.title}</span>
              {next?.step.id === step.id && <span className="cv-tour-detail">{step.detail}</span>}
            </span>
          </li>
        ))}
      </ol>
      {!next && <p className="cv-help">{t('tour.finished')}</p>}
    </aside>
  );
}
