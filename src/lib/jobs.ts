/**
 * The running jobs as the window keeps them (LT-432).
 *
 * `jobs.rs` reports every change to any job on one event. This is the pure
 * half: fold a snapshot into the list, drop a job once it has ended, and
 * say what a job's header should read. The store calls it; nothing here
 * touches React.
 */
import type { JobKind, JobSnapshot } from './ipc';
import { t } from '../i18n';

/** A snapshot folded into the list: replaced by id, appended when new, and
 *  removed once the job has ended — an ended job is history, not a job. */
export function applyJob(jobs: readonly JobSnapshot[], snapshot: JobSnapshot): JobSnapshot[] {
  const rest = jobs.filter((j) => j.id !== snapshot.id);
  if (snapshot.state === 'complete' || snapshot.state === 'cancelled') return rest;
  return [...rest, snapshot].sort((a, b) => a.id - b.id);
}

/** What the job is called, for a header. */
export function jobName(kind: JobKind): string {
  switch (kind) {
    case 'crawl':
      return t('jobs.kind.crawl');
    case 'backup':
      return t('jobs.kind.backup');
    case 'sweep':
      return t('jobs.kind.sweep');
  }
}

/** `n of total` where the total is known, `n` where it is not. */
export function jobCount(job: Pick<JobSnapshot, 'done' | 'total'>): string {
  return job.total == null ? String(job.done) : t('jobs.count', { done: job.done, total: job.total });
}

/** The header line: name · phase · count · elapsed. */
export function jobLine(job: JobSnapshot, nowMs: number): string {
  const secs = Math.max(0, Math.floor((nowMs - job.startedMs) / 1000));
  const elapsed = secs < 60 ? t('jobs.elapsedSeconds', { count: secs }) : t('jobs.elapsedMinutes', { count: Math.floor(secs / 60) });
  const state = job.state === 'stopping' ? ` · ${t('jobs.stopping')}` : '';
  return `${jobName(job.kind)} · ${job.phase} · ${jobCount(job)} · ${elapsed}${state}`;
}
