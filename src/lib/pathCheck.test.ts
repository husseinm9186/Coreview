import { describe, expect, it } from 'vitest';

import type { TopoEdge, TopoNode } from '../state/store';
import { drawnPath, judgePath } from './pathCheck';
import type { HealthStatus } from '../types/domain';

const n = (id: string) => ({ id, type: 'device', position: { x: 0, y: 0 }, data: { label: id } }) as unknown as TopoNode;
const e = (id: string, source: string, target: string, kind?: string) => ({ id, source, target, data: kind ? { kind } : {} }) as unknown as TopoEdge;

describe('path validation (LT-225)', () => {
  const nodes = ['fw', 'core', 'dist', 'acc', 'host', 'island', 'note'].map(n);
  const edges = [e('1', 'fw', 'core'), e('2', 'core', 'dist'), e('3', 'dist', 'acc'), e('4', 'acc', 'host'), e('5', 'core', 'acc'), e('6', 'note', 'host', 'leader')];

  it('takes the fewest links, whichever way the links were drawn', () => {
    expect(drawnPath(nodes, edges, 'host', 'fw')).toEqual({ nodeIds: ['host', 'acc', 'core', 'fw'], edgeIds: ['4', '5', '1'] });
  });

  it('has no path to a device nothing links to, and ignores leader lines', () => {
    expect(drawnPath(nodes, edges, 'fw', 'island')).toBeNull();
    expect(drawnPath(nodes, edges, 'note', 'host')).toBeNull();
    expect(drawnPath(nodes, edges, 'fw', 'fw')).toEqual({ nodeIds: ['fw'], edgeIds: [] });
  });

  it('names the first hop that is down, and counts what is not checked', () => {
    const path = drawnPath(nodes, edges, 'host', 'fw')!;
    const nodeStatus = (id: string): HealthStatus => (id === 'host' ? 'unknown' : 'healthy');
    expect(judgePath(path, nodeStatus, (id) => (id === '5' ? 'down' : 'healthy'))).toEqual({ firstDown: { kind: 'link', id: '5' }, unchecked: 1 });
    expect(judgePath(path, (id) => (id === 'core' ? 'down' : 'healthy'), () => 'healthy')).toEqual({ firstDown: { kind: 'device', id: 'core' }, unchecked: 0 });
    expect(judgePath(path, () => 'healthy', () => 'healthy').firstDown).toBeNull();
  });
});
