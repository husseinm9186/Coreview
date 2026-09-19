import { describe, expect, it } from 'vitest';

import { GUIDE_STEPS, guideProgress, newlyDone, type GuideState } from './guide';
import { SAMPLES } from './samples';
import type { ProbeRuntime } from '../types/domain';

const rt = (status: ProbeRuntime['status']): ProbeRuntime => ({ probeId: status, status, lastRttMs: null, lastSuccessMs: null, lastFailureMs: null, lastSummary: null, consecutiveFailures: 0, failureThreshold: 3 });
const state = (over: Partial<GuideState> = {}): GuideState => ({ selectedDevice: false, selectedLink: false, sessionRunning: false, runtime: new Map(), done: [], ...over });

describe('the guided tour (LT-271)', () => {
  it('ticks a step off when it is done, and remembers it after', () => {
    expect(newlyDone(state({ selectedDevice: true }))).toEqual(['select']);
    expect(newlyDone(state({ selectedDevice: true, done: ['select'] }))).toEqual([]);
    expect(guideProgress(state({ done: ['select'] }))[0]).toMatchObject({ done: true });
  });

  it('counts the answers only when both a green and a red one came back', () => {
    expect(newlyDone(state({ runtime: new Map([['a', rt('healthy')]]) }))).not.toContain('answer');
    expect(newlyDone(state({ runtime: new Map([['a', rt('healthy')], ['b', rt('down')]]) }))).toContain('answer');
  });

  it('leaves the steps noted elsewhere to be noted', () => {
    expect(GUIDE_STEPS.filter((s) => !s.now).map((s) => s.id)).toEqual(['search', 'report']);
    expect(newlyDone(state({ selectedDevice: true, selectedLink: true, sessionRunning: true }))).not.toContain('search');
  });

  it('comes with a sample made of invented data that the steps talk about', () => {
    const sample = SAMPLES.find((s) => s.name.includes('Guided tour'))!;
    const doc = sample.build();
    expect(doc.guide).toEqual({ done: [] });
    const labels = doc.pages[0]!.nodes.map((n) => (n.data as { label?: string }).label);
    for (const named of ['Core switch', 'Access switch 1', 'Edge firewall']) expect(labels).toContain(named);
    const core = doc.pages[0]!.nodes.find((n) => (n.data as { label?: string }).label === 'Core switch')!.data as { inventory?: { ports: unknown[] } };
    expect(core.inventory?.ports.length).toBeGreaterThan(0);
    const addresses = doc.pages[0]!.nodes.flatMap((n) => ((n.data as { addresses?: { address: string }[] }).addresses ?? []).map((a) => a.address));
    expect(addresses.every((a) => /^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|127\.0\.0\.1$)/.test(a))).toBe(true);
  });
});
