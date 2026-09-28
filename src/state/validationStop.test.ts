/**
 * LT-491: Stop validation must stop, and closing a project must close it.
 *
 * The engine's own stop is sound — it cancels every probe and waits at most
 * three seconds. What the operator saw was the page: events the engine had
 * already sent when Stop was pressed landed after the page had reset, with
 * nothing asking which session they belonged to, so the diagram lit up again
 * and the header could go back to "stopping"; and a close that met any error
 * stopped half-way, with the screen still on the project and nothing said.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ipc } from '../lib/ipc';
import { useStore } from './store';

const running = () =>
  useStore.setState({
    session: { id: 's1', state: 'running', startedAt: 1 },
    meta: { id: 'p1', name: 'Stop test', customer: '', site: '', ticket: '', engineer: '', description: '', createdAt: 1, updatedAt: 1, archived: false },
    dirty: false,
    runtime: new Map(),
    recentSamples: new Map(),
  });

const sample = (sessionId: string) => ({
  kind: 'sample',
  session_id: sessionId,
  status: 'up',
  result: { probeId: 'probe-1', rttMs: 2, summary: 'reply', timestampMs: 5, outcome: 'success' },
});

afterEach(() => vi.restoreAllMocks());

describe('stopping validation (LT-491)', () => {
  it('drops the samples that were already on their way when Stop was pressed', async () => {
    running();
    await useStore.getState().stopValidation();
    expect(useStore.getState().session.state).toBe('stopped');
    useStore.getState().applyEngineEvent(sample('s1'));
    expect(useStore.getState().runtime.size, 'a late sample relit the diagram').toBe(0);
    expect(useStore.getState().recentSamples.size).toBe(0);
  });

  it('never lets a late engine event move a stopped run back to stopping or running', async () => {
    running();
    await useStore.getState().stopValidation();
    useStore.getState().applyEngineEvent({ kind: 'sessionState', session_id: 's1', project_id: 'p1', state: 'stopping' });
    expect(useStore.getState().session.state).toBe('stopped');
    useStore.getState().applyEngineEvent({ kind: 'sessionState', session_id: 's1', project_id: 'p1', state: 'running' });
    expect(useStore.getState().session.state).toBe('stopped');
  });

  it('still applies what belongs to the run in progress, and ignores another run', () => {
    running();
    useStore.getState().applyEngineEvent(sample('s1'));
    expect(useStore.getState().runtime.get('probe-1')?.status).toBe('up');
    useStore.getState().applyEngineEvent(sample('some-other-session'));
    expect(useStore.getState().runtime.size).toBe(1);
  });

  it('ends stopped and says why when the stop call itself fails', async () => {
    running();
    vi.spyOn(ipc, 'stopValidation').mockRejectedValue(new Error('Local database error: locked'));
    await expect(useStore.getState().stopValidation()).resolves.toBeUndefined();
    expect(useStore.getState().session.state).toBe('stopped');
    expect(useStore.getState().statusMessage).toMatch(/locked/);
  });
});

describe('closing a project while validation runs (LT-491)', () => {
  it('closes even when stopping reports an error', async () => {
    running();
    vi.spyOn(ipc, 'stopValidation').mockRejectedValue(new Error('Local database error: locked'));
    await useStore.getState().closeProject();
    expect(useStore.getState().meta, 'the project was left open').toBeNull();
    expect(useStore.getState().session.state).toBe('stopped');
  });

  it('keeps the project open, and says so, when its unsaved work cannot be saved', async () => {
    running();
    useStore.setState({ dirty: true });
    vi.spyOn(ipc, 'saveProject').mockRejectedValue(new Error('disk full'));
    await useStore.getState().closeProject();
    expect(useStore.getState().meta?.id, 'closing would have lost unsaved work').toBe('p1');
    expect(useStore.getState().statusMessage).toMatch(/disk full/);
  });
});
