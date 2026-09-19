import { describe, expect, it } from 'vitest';

import { availability, rttSpark, statusBars, type Sample } from './sparkline';

const s = (rttMs: number | null, status = 'healthy'): Sample => ({ timestampMs: 0, status, rttMs });

describe('probe history sparklines (LT-224)', () => {
  it('draws RTT oldest to newest, low at the bottom, with the last point marked', () => {
    const spark = rttSpark([s(10), s(30), s(20)], 100, 20);
    expect(spark.line).toBe('M0,18L50,2L100,10');
    expect(spark.last).toEqual({ x: 100, y: 10 });
    expect([spark.min, spark.max]).toEqual([10, 30]);
    expect(spark.area).toBe('M0,18L50,2L100,10L100,20L0,20Z');
  });

  it('breaks the line where a sample had no response time', () => {
    const spark = rttSpark([s(5), s(null, 'down'), s(5)], 100, 20);
    expect(spark.line).toBe('M0,10M100,10');
    expect(rttSpark([s(null, 'down')], 100, 20).line).toBe('');
  });

  it('makes a status bar taller the worse it is', () => {
    const bars = statusBars([s(1), s(1, 'warning'), s(null, 'down'), s(null, 'unknown')], 40, 10);
    expect(bars.map((b) => b.height)).toEqual([2, 5, 10, 0]);
    expect(bars.map((b) => b.x)).toEqual([0, 10, 20, 30]);
  });

  it('works out availability over judged samples only', () => {
    expect(availability([s(1), s(1, 'warning'), s(null, 'down'), s(null, 'unknown')])).toBe(66.7);
    expect(availability([s(null, 'unknown')])).toBeNull();
  });
});
