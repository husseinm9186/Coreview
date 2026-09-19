/**
 * Sparklines for a probe's history (LT-224, D-029): response time as a line
 * with a soft fill and the latest point marked, and status as a strip beneath.
 *
 * Status is carried by shape as well as colour — a gap is a missing sample, a
 * short bar is a warning and a full bar is down — so the strip reads in
 * greyscale and to anyone who does not see the colours.
 */
export interface Sample {
  timestampMs: number;
  status: string;
  rttMs: number | null;
}

export interface Spark {
  /** SVG path of the RTT line; empty when there is no RTT at all. */
  line: string;
  /** The same, closed down to the baseline, for the fill. */
  area: string;
  last: { x: number; y: number } | null;
  min: number | null;
  max: number | null;
}

const round = (v: number) => Math.round(v * 10) / 10;

/** The RTT line across `width` × `height`, oldest at the left. A sample with
 *  no RTT breaks the line rather than dropping to zero. */
export function rttSpark(samples: readonly Sample[], width: number, height: number): Spark {
  const values = samples.map((s) => s.rttMs).filter((v): v is number => v !== null && Number.isFinite(v));
  if (values.length === 0) return { line: '', area: '', last: null, min: null, max: null };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;
  const x = (i: number) => round(samples.length === 1 ? width / 2 : (i / (samples.length - 1)) * width);
  // A flat series is drawn across the middle, not along the floor.
  const y = (v: number) => (max === min ? round(height / 2) : round(height - pad - ((v - min) / span) * (height - 2 * pad)));
  let line = '';
  let area = '';
  let run: { x: number; y: number }[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const seg = run.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join('');
    line += seg;
    area += `${seg}L${run[run.length - 1]!.x},${height}L${run[0]!.x},${height}Z`;
    run = [];
  };
  let last: { x: number; y: number } | null = null;
  samples.forEach((s, i) => {
    if (s.rttMs === null || !Number.isFinite(s.rttMs)) {
      flush();
      return;
    }
    const p = { x: x(i), y: y(s.rttMs) };
    run.push(p);
    last = p;
  });
  flush();
  return { line, area, last, min, max };
}

export interface StatusBar {
  x: number;
  width: number;
  /** Full height for down, half for warning, a sliver for healthy. */
  height: number;
  status: string;
}

/** One bar per sample across `width`; each taller the worse it is. */
export function statusBars(samples: readonly Sample[], width: number, height: number): StatusBar[] {
  if (samples.length === 0) return [];
  const w = width / samples.length;
  return samples.map((s, i) => ({
    x: round(i * w),
    width: Math.max(1, round(w - (w > 3 ? 1 : 0))),
    height: s.status === 'down' ? height : s.status === 'warning' ? round(height / 2) : s.status === 'healthy' ? Math.max(2, round(height / 5)) : 0,
    status: s.status,
  }));
}

/** Share of samples that were healthy or warning, as a whole percentage. */
export function availability(samples: readonly Sample[]): number | null {
  const judged = samples.filter((s) => ['healthy', 'warning', 'down'].includes(s.status));
  if (judged.length === 0) return null;
  return Math.round((judged.filter((s) => s.status !== 'down').length / judged.length) * 1000) / 10;
}
