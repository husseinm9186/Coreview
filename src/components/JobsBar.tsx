/**
 * Every job running right now, one header each: what it is, its
 * phase, how far it has got, how long it has run, and Cancel. Drawn from the
 * store's `jobs` list, which `jobs.rs` keeps current, so a crawl
 * started from the Discover tab shows here whichever tab is open.
 */
import { useEffect, useState } from 'react';

import { jobLine } from '../lib/jobs';
import { ipc } from '../lib/ipc';
import { useStore } from '../state/store';
import { t } from '../i18n';

export function JobsBar({ compact = false }: { compact?: boolean }) {
  const jobs = useStore((s) => s.jobs);
  const [now, setNow] = useState(() => Date.now());
  // The elapsed figure moves once a second while anything runs; nothing
  // ticks when the list is empty.
  useEffect(() => {
    if (jobs.length === 0) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [jobs.length]);
  if (jobs.length === 0) return null;
  return (
    <div className={`cv-jobs${compact ? ' is-compact' : ''}`} role="status" aria-live="polite" aria-label={t('jobs.running', { count: jobs.length })}>
      {jobs.map((j) => (
        <div key={j.id} className={`cv-job is-${j.state}`} data-kind={j.kind} data-job={j.id}>
          <span className="cv-job-line">{jobLine(j, now)}</span>
          {j.total != null && j.total > 0 && (
            <progress className="cv-job-progress" max={j.total} value={Math.min(j.done, j.total)} aria-hidden="true" />
          )}
          <button
            type="button"
            className="cv-btn cv-btn-small cv-btn-stop"
            disabled={j.state === 'stopping'}
            onClick={() => void ipc.cancelJob(j.id).catch(() => false)}
          >
            {j.state === 'stopping' ? t('jobs.stopping') : t('jobs.cancel')}
          </button>
        </div>
      ))}
    </div>
  );
}
