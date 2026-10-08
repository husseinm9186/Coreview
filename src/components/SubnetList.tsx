import { useEffect, useState } from 'react';

import { ipc, isDesktop, type SubnetInfo } from '../lib/ipc';
import { t } from '../i18n';

type Row = { value: string; info: SubnetInfo | null; problem: string | null };

const blank = (value = ''): Row => ({ value, info: null, problem: null });

/**
 * A list of subnets, each checked as it is typed.
 *
 * A single comma-separated box is smaller, and it puts every mistake in one
 * place: one bad entry makes the whole field wrong, and the message cannot say
 * which part. A row per subnet means the fourth one being a typo is obvious
 * while the other three keep working.
 *
 * The count is shown per row because it is the number that decides whether a
 * sweep takes ten seconds or ten minutes, and it is worth seeing before
 * pressing anything.
 */
export function SubnetList({
  label,
  subnets,
  onChange,
  disabled,
  placeholder = '192.168.1.0/24',
  /** Show how many addresses each subnet holds. Useful for a sweep, noise for
   *  a crawl limit, where the subnet is a boundary rather than work to do. */
  showCounts = false,
  scanned,
  onScannedChange,
}: {
  label: string;
  subnets: string[];
  onChange: (subnets: string[]) => void;
  disabled: boolean;
  placeholder?: string;
  showCounts?: boolean;
  /** The subnets whose scan box is ticked. Given with
   *  `onScannedChange`, each row has the box. */
  scanned?: string[];
  onScannedChange?: (scanned: string[]) => void;
}) {
  const [rows, setRows] = useState<Row[]>(
    subnets.length ? subnets.map((s) => blank(s)) : [blank()],
  );

  // The rows are seeded once, which is right while someone is typing into
  // them and wrong the moment the list is set from outside — restoring a
  // saved scan handed in subnets this never showed. Adopting the
  // incoming list only when it differs from what these rows last emitted
  // keeps typing untouched: during typing the two are already equal.
  useEffect(() => {
    const mine = [...new Set(rows.map((r) => r.value.trim()).filter(Boolean))].join(',');
    const theirs = subnets.map((s) => s.trim()).filter(Boolean);
    if (mine === theirs.join(',')) return;
    setRows(theirs.length ? theirs.map((s) => blank(s)) : [blank()]);
    // `rows` is deliberately not a dependency: this reacts to the list being
    // set from outside, not to its own edits, which are what emit it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subnets]);

  // Validate whatever changed, through the same parser the run will use, so
  // the form cannot accept something the backend then rejects.
  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    void Promise.all(
      rows.map(async (r) => {
        const text = r.value.trim();
        if (!text) return { ...r, info: null, problem: null };
        try {
          return { ...r, info: await ipc.describeSubnet(text), problem: null };
        } catch (e) {
          return { ...r, info: null, problem: e instanceof Error ? e.message : String(e) };
        }
      }),
    ).then((next) => {
      if (cancelled) return;
      const changed = next.some(
        (n, i) => n.info !== rows[i]?.info || n.problem !== rows[i]?.problem,
      );
      if (changed) setRows(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.map((r) => r.value).join('\u0000')]);

  const publish = (next: Row[]) => {
    setRows(next);
    // The same subnet typed twice is one subnet; the second row says so.
    onChange([...new Set(next.map((r) => r.value.trim()).filter(Boolean))]);
  };
  const isRepeat = (i: number) => {
    const v = rows[i]?.value.trim();
    return Boolean(v) && rows.slice(0, i).some((r) => r.value.trim() === v);
  };
  const ticked = new Set((scanned ?? []).map((x) => x.trim()));
  const tick = (value: string, on: boolean) => {
    const v = value.trim();
    const next = new Set(ticked);
    if (on) next.add(v);
    else next.delete(v);
    onScannedChange?.([...next].filter(Boolean));
  };

  const setAt = (i: number, value: string) =>
    publish(rows.map((r, j) => (j === i ? { ...r, value } : r)));
  const add = () => publish([...rows, blank()]);
  const removeAt = (i: number) =>
    publish(rows.length === 1 ? [blank()] : rows.filter((_, j) => j !== i));

  const totalHosts = rows.reduce((n, r) => n + (r.info?.hosts ?? 0), 0);

  return (
    <div className="cv-subnets">
      <span className="cv-subnets-label">{label}</span>
      {rows.map((r, i) => (
        <div className="cv-subnet-row" key={i}>
          <input
            className={`cv-input${r.problem ? ' is-bad' : ''}`}
            value={r.value}
            spellCheck={false}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => setAt(i, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && i === rows.length - 1) add();
            }}
            aria-label={`${label} ${i + 1}`}
          />
          <button
            type="button"
            className="cv-btn cv-btn-small"
            onClick={() => removeAt(i)}
            disabled={disabled || (rows.length === 1 && !r.value)}
            aria-label={`Remove subnet ${i + 1}`}
            title={t('subnetList.remove')}
          >
            −
          </button>
          {onScannedChange && (
            <label className="cv-check cv-check-inline cv-subnet-scan" title={t('scan.boxHint')}>
              <input
                type="checkbox"
                checked={Boolean(r.value.trim()) && ticked.has(r.value.trim())}
                disabled={disabled || !r.value.trim() || Boolean(r.problem) || isRepeat(i)}
                onChange={(e) => tick(r.value, e.target.checked)}
                aria-label={`${t('scan.box')} ${r.value.trim() || i + 1}`}
              />
              {t('scan.box')}
            </label>
          )}
          {r.problem ? (
            <span className="cv-subnet-problem">{r.problem}</span>
          ) : isRepeat(i) ? (
            <span className="cv-subnet-problem">{t('subnetList.duplicate')}</span>
          ) : showCounts && r.info ? (
            <span className="cv-help">
              {r.info.hosts.toLocaleString()} addresses · {r.info.network}–{r.info.broadcast}
            </span>
          ) : null}
        </div>
      ))}
      <div className="cv-subnet-actions">
        <button type="button" className="cv-btn cv-btn-small" onClick={add} disabled={disabled}>
          {t('subnetList.addSubnet')}
        </button>
        {showCounts && totalHosts > 0 && rows.filter((r) => r.info).length > 1 && (
          <span className="cv-help">{totalHosts.toLocaleString()} addresses in total</span>
        )}
      </div>
    </div>
  );
}
