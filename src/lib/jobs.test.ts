import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { applyJob, jobCount, jobLine, jobName } from './jobs';
import type { JobSnapshot } from './ipc';

const snap = (over: Partial<JobSnapshot>): JobSnapshot => ({
  id: 1, kind: 'crawl', state: 'running', phase: 'Starting', done: 0, total: null, startedMs: 1_000, ...over,
});

describe('the running jobs (LT-432)', () => {
  it('replaces a job by id, appends a new one, and drops one that has ended', () => {
    let jobs = applyJob([], snap({ id: 2, kind: 'sweep' }));
    jobs = applyJob(jobs, snap({ id: 1 }));
    expect(jobs.map((j) => j.id)).toEqual([1, 2]);
    jobs = applyJob(jobs, snap({ id: 1, phase: 'Visiting 192.0.2.7', done: 3 }));
    expect(jobs.find((j) => j.id === 1)?.done).toBe(3);
    expect(jobs.length).toBe(2);
    jobs = applyJob(jobs, snap({ id: 2, kind: 'sweep', state: 'cancelled' }));
    expect(jobs.map((j) => j.id)).toEqual([1]);
    jobs = applyJob(jobs, snap({ id: 1, state: 'complete' }));
    expect(jobs).toEqual([]);
  });

  it('counts with a total when there is one and without when there is not', () => {
    expect(jobCount({ done: 4, total: null })).toBe('4');
    expect(jobCount({ done: 4, total: 254 })).toBe('4 of 254');
  });

  it('writes one line a person can read at a glance', () => {
    const line = jobLine(snap({ kind: 'backup', phase: 'Backing up', done: 2, total: 9, startedMs: 0 }), 75_000);
    expect(line).toBe('Backup · Backing up · 2 of 9 · 1 min');
    const stopping = jobLine(snap({ kind: 'sweep', phase: 'Sweeping', done: 10, total: 254, state: 'stopping', startedMs: 0 }), 5_000);
    expect(stopping).toBe('Sweep · Sweeping · 10 of 254 · 5 s · stopping');
    // LT-460: the two kinds that used to run outside the registry.
    const meraki = jobLine(snap({ kind: 'meraki', phase: 'Backing up Branch', done: 1, total: 4, startedMs: 0 }), 3_000);
    expect(meraki).toBe('Meraki · Backing up Branch · 1 of 4 · 3 s');
    const scan = jobLine(snap({ kind: 'icon-scan', phase: 'Converting EMF/WMF', done: 40, total: 120, startedMs: 0 }), 3_000);
    expect(scan).toBe('Icon library · Converting EMF/WMF · 40 of 120 · 3 s');
  });

  // LT-590: the collector's header read "undefined · Collecting…".
  it('names a collection, and every kind the backend runs', () => {
    const line = jobLine(snap({ kind: 'collect', phase: 'Collecting 192.0.2.1', done: 1, total: 6, startedMs: 0 }), 6_000);
    expect(line).toBe('Collection · Collecting 192.0.2.1 · 1 of 6 · 6 s');
    const rust = readFileSync('src-tauri/src/jobs.rs', 'utf8');
    const body = /pub enum Kind \{([\s\S]*?)\n\}/.exec(rust)?.[1] ?? '';
    const kinds = [...body.matchAll(/^\s{4}([A-Z]\w*),/gm)].map((m) => (m[1] ?? '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
    expect(kinds.length).toBeGreaterThan(5);
    for (const k of kinds) expect(jobName(k as JobSnapshot['kind']), k).toBeTruthy();
  });
});
