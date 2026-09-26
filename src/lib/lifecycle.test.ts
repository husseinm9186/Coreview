import { describe, expect, it } from 'vitest';
import { isoDate, lifecycleCsv, lifecycleFor, lifecycleVerdicts, readLifecycleCsv } from './lifecycle';
import { parseCsv } from './csv';
import { emptyDocument } from '../state/store';
import type { TopoNode } from '../state/store';

// Invented models and dates (D-027).
const TABLE = `Model,End of Sale,End of Support,Note
CS-9000,2027-01-31,2032-01-31,
CS-7000,2019-06-30,2024-06-30,replaced by CS-9000
AP-200,31/12/2023,,
AP-100,2020-01-01,not a date,
CS-7000,2000-01-01,2000-01-01,dup
`;

describe('the lifecycle table (LT-439)', () => {
  it('reads the operator\'s CSV by its headings and says what it could not read', () => {
    const { rows, problems } = readLifecycleCsv(TABLE);
    expect(rows.map((r) => [r.model, r.endOfSale, r.endOfSupport])).toEqual([
      ['CS-9000', '2027-01-31', '2032-01-31'],
      ['CS-7000', '2019-06-30', '2024-06-30'],
      ['AP-200', '2023-12-31', ''],
      ['AP-100', '2020-01-01', ''],
    ]);
    expect(problems).toEqual([
      'Row 5: "not a date" is not a date this reads (YYYY-MM-DD).',
      'Row 6: CS-7000 is listed twice; the first is kept.',
    ]);
    expect(readLifecycleCsv('a,b\n1,2').problems[0]).toMatch(/No model column/);
  });

  it('reads a date only where it cannot be misread', () => {
    expect(isoDate('2024-03-05')).toBe('2024-03-05');
    expect(isoDate('31/12/2023')).toBe('2023-12-31');
    expect(isoDate('12/31/2023')).toBe('2023-12-31');
    expect(isoDate('03/05/2023')).toBe('');
  });

  it('matches a drawn model exactly, then by the longest prefix, never by guess', () => {
    const rows = readLifecycleCsv('Model,EoS,EoL\nWS-C2960,2015-01-01,2020-01-01\nWS-C2960X,2020-01-01,2025-01-01\n').rows;
    expect(lifecycleFor('ws-c2960x-48td-l', rows)?.model).toBe('WS-C2960X');
    expect(lifecycleFor('WS-C2960-24TT', rows)?.model).toBe('WS-C2960');
    expect(lifecycleFor('C9300-48P', rows)).toBeNull();
    expect(lifecycleFor('', rows)).toBeNull();
  });

  it('reports every drawn device worst first, and a model the table lacks as unknown', () => {
    const d = emptyDocument();
    const node = (id: string, label: string, model: string) => ({ id, type: 'device', position: { x: 0, y: 0 }, data: { label, deviceType: 'l2-switch', model, tags: [], addresses: [] } }) as unknown as TopoNode;
    d.pages[0]!.nodes = [node('a', 'ACCESS-1', 'CS-7000'), node('b', 'CORE', 'CS-9000'), node('c', 'AP-3', 'AP-200'), node('d', 'MYSTERY', 'X-1')];
    const rows = readLifecycleCsv(TABLE).rows;
    const v = lifecycleVerdicts(d, rows, '2025-06-01');
    expect(v.map((x) => [x.label, x.state])).toEqual([
      ['ACCESS-1', 'unsupported'],
      ['AP-3', 'unsold'],
      ['CORE', 'current'],
      ['MYSTERY', 'unknown'],
    ]);
    const csv = parseCsv(lifecycleCsv(v));
    expect(csv[1]).toEqual(['ACCESS-1', 'CS-7000', 'unsupported', '2019-06-30', '2024-06-30', 'CS-7000']);
    expect(csv[4]).toEqual(['MYSTERY', 'X-1', 'unknown', '', '', '']);
  });
});
