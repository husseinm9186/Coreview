/**
 * A probe's history (LT-224, D-029): response time as a sparkline, status as
 * a strip of bars beneath, and availability, over the live window or a stored
 * one — the last hour, day or three days.
 */
import { useEffect, useState } from 'react';

import { ipc } from '../../lib/ipc';
import { availability, rttSpark, statusBars, type Sample } from '../../lib/sparkline';
import { useStore } from '../../state/store';

const W = 240;
const H = 36;
const STRIP = 10;
const WINDOWS: [string, number][] = [
  ['Live', 0],
  ['1 hour', 3_600_000],
  ['24 hours', 86_400_000],
  ['3 days', 3 * 86_400_000],
];

export function ProbeHistory({ probeId }: { probeId: string }) {
  const live = useStore((s) => s.recentSamples.get(probeId));
  const [span, setSpan] = useState(0);
  const [stored, setStored] = useState<Sample[] | null>(null);

  useEffect(() => {
    if (span === 0) {
      setStored(null);
      return;
    }
    let cancelled = false;
    void ipc
      .probeHistory(probeId, Date.now() - span)
      .then((rows) => {
        if (!cancelled) setStored(rows.map((r) => ({ timestampMs: r.timestampMs, status: r.status, rttMs: r.rttMs })));
      })
      .catch(() => !cancelled && setStored([]));
    return () => {
      cancelled = true;
    };
  }, [probeId, span]);

  const samples = span === 0 ? (live ?? []) : (stored ?? []);
  const spark = rttSpark(samples, W, H);
  const bars = statusBars(samples, W, STRIP);
  const up = availability(samples);

  return (
    <div className="cv-probe-history">
      <div className="cv-probe-history-head">
        <span>History</span>
        <select className="cv-input" aria-label="History window" value={span} onChange={(e) => setSpan(Number(e.target.value))}>
          {WINDOWS.map(([label, ms]) => <option key={ms} value={ms}>{label}</option>)}
        </select>
        <span className="cv-help" aria-live="polite">
          {samples.length === 0
            ? span === 0 ? 'Nothing yet — start validation' : 'Nothing recorded in this window'
            : `${samples.length} result${samples.length === 1 ? '' : 's'}${up !== null ? ` · ${up}% up` : ''}${spark.min !== null ? ` · ${Math.round(spark.min)}–${Math.round(spark.max!)} ms` : ''}`}
        </span>
      </div>
      {samples.length > 0 && (
        <svg className="cv-sparkline" width={W} height={H + STRIP + 4} viewBox={`0 0 ${W} ${H + STRIP + 4}`} role="img"
          aria-label={`Response time and status, ${samples.length} results${up !== null ? `, ${up}% up` : ''}`}>
          <line x1={0} y1={H - 0.5} x2={W} y2={H - 0.5} className="cv-sparkline-base" />
          {spark.area && <path d={spark.area} className="cv-sparkline-area" />}
          {spark.line && <path d={spark.line} className="cv-sparkline-line" />}
          {spark.last && <circle cx={spark.last.x} cy={spark.last.y} r={2.5} className="cv-sparkline-last" />}
          {bars.map((b, i) => (
            <rect key={i} x={b.x} y={H + 4 + (STRIP - b.height)} width={b.width} height={b.height} className={`cv-sparkline-bar is-${b.status}`} />
          ))}
        </svg>
      )}
    </div>
  );
}
