import { useEffect, useMemo, useState } from 'react';

import {
  EXPECT_CHOICES,
  checkLabel,
  isComplete,
  newCheck,
  orderResults,
  parseChecks,
  serializeChecks,
  summarise,
  type BackupCheck,
  type CheckExpect,
  type CheckResult,
  type CheckVerdict,
} from '../lib/checks';
import { describeStamp } from '../lib/fileNames';
import { ipc, type BackupRunSummary } from '../lib/ipc';

const VERDICT_LABEL: Record<CheckVerdict, string> = {
  pass: 'Pass',
  fail: 'Fail',
  notCaptured: 'Not captured',
  rejected: 'Not accepted',
};

/**
 * Checks that turn a backup run's show-command captures into pass or fail
 * (LT-153), each with the line that decided it.
 *
 * Its own component because the Backups panel already carries capture,
 * browsing and before-and-after; this reads the same runs and nothing else.
 */
export function BackupChecks({ runs }: { runs: BackupRunSummary[] }) {
  const [checks, setChecks] = useState<BackupCheck[]>([]);
  const [restored, setRestored] = useState(false);
  const [run, setRun] = useState('');
  const [results, setResults] = useState<CheckResult[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);

  useEffect(() => {
    void ipc
      .getSettings()
      .then((st) => setChecks(parseChecks(st.backupChecks)))
      .catch(() => {})
      .finally(() => setRestored(true));
  }, []);
  useEffect(() => {
    if (!restored) return;
    void ipc.setSetting('backupChecks', serializeChecks(checks)).catch(() => {});
  }, [restored, checks]);

  // Checks read show-command captures, so a run with only configurations in
  // it has nothing to offer them.
  const showRuns = useMemo(() => runs.filter((r) => r.kinds.includes('show-commands')), [runs]);
  useEffect(() => {
    setRun((prev) => (prev && showRuns.some((r) => r.stamp === prev) ? prev : showRuns[0]?.stamp ?? ''));
  }, [showRuns]);

  const edit = (id: string, patch: Partial<BackupCheck>) =>
    setChecks((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const ready = checks.filter(isComplete);

  const runChecks = () => {
    setProblem(null);
    setResults(null);
    setChecking(true);
    void ipc
      .runBackupChecks(run, ready)
      .then(setResults)
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
      .finally(() => setChecking(false));
  };

  const byId = new Map(checks.map((c) => [c.id, c]));
  const counts = results ? summarise(results) : null;
  const shown = results
    ? orderResults(results, checks).filter((r) => !onlyProblems || r.verdict !== 'pass')
    : [];

  return (
    <section className="cv-backup-checks">
      <h4 className="cv-backup-head">Checks</h4>
      <p className="cv-help">
        A check looks for something in one command&apos;s output across a run&apos;s show-command
        captures — a route that must be there, an error that must not be — and says pass or fail
        with the line that decided it. <em>Contains</em> looks for the text exactly as written;{' '}
        <em>matches</em> takes a regular expression. Checks only read files already taken.
      </p>

      {checks.map((c) => (
        <fieldset key={c.id} className="cv-check-row" aria-label={`Check ${checkLabel(c) || 'new'}`}>
          {/* Empty fields, no placeholders: the checks are the operator's own
              and nothing from any real project ships (D-027). */}
          <label className="cv-field cv-field-narrow">
            <span>Name</span>
            <input className="cv-input" value={c.name} onChange={(e) => edit(c.id, { name: e.target.value })} />
          </label>
          <label className="cv-field cv-field-wide">
            <span>Command</span>
            <input className="cv-input cv-mono" value={c.command} spellCheck={false}
              onChange={(e) => edit(c.id, { command: e.target.value })} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>Output</span>
            <select className="cv-input" value={c.expect}
              onChange={(e) => edit(c.id, { expect: e.target.value as CheckExpect })}>
              {EXPECT_CHOICES.map((x) => (
                <option key={x.value} value={x.value}>{x.label}</option>
              ))}
            </select>
          </label>
          <label className="cv-field cv-field-wide">
            <span>Text or pattern</span>
            <input className="cv-input cv-mono" value={c.pattern} spellCheck={false}
              onChange={(e) => edit(c.id, { pattern: e.target.value })} />
          </label>
          <label className="cv-check cv-check-inline">
            <input type="checkbox" checked={c.ignoreCase} onChange={(e) => edit(c.id, { ignoreCase: e.target.checked })} />
            Ignore case
          </label>
          <button type="button" className="cv-btn cv-btn-small"
            onClick={() => setChecks((prev) => prev.filter((x) => x.id !== c.id))}>
            Remove check
          </button>
        </fieldset>
      ))}

      <div className="cv-before-after-pick">
        <button type="button" className="cv-btn cv-btn-small" onClick={() => setChecks((prev) => [...prev, newCheck()])}>
          Add check
        </button>
        {showRuns.length === 0 ? (
          <span className="cv-help">Take a backup with show commands to have something to check.</span>
        ) : (
          <>
            <label className="cv-field cv-field-narrow">
              <span>Run</span>
              <select className="cv-input" value={run} onChange={(e) => setRun(e.target.value)}>
                {showRuns.map((r) => (
                  <option key={r.stamp} value={r.stamp}>
                    {describeStamp(r.stamp)} · {r.devices} device{r.devices === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="cv-btn cv-btn-small" onClick={runChecks}
              disabled={checking || !run || ready.length === 0}>
              {checking ? 'Checking…' : `Run ${ready.length || ''} check${ready.length === 1 ? '' : 's'}`}
            </button>
            <label className="cv-check cv-check-inline">
              <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
              Only what did not pass
            </label>
          </>
        )}
      </div>
      {checks.length > ready.length && (
        <p className="cv-help">
          {checks.length - ready.length} check{checks.length - ready.length === 1 ? ' is' : 's are'} missing a
          command or text and will not run.
        </p>
      )}

      {problem && <p className="cv-discover-problem">{problem}</p>}

      {counts && results && (
        <>
          <p className="cv-help cv-check-summary">
            {counts.pass} passed · {counts.fail} failed · {counts.rejected} not accepted ·{' '}
            {counts.notCaptured} not captured
            {results.length === 0 && ' — no device in this run has show-command captures'}
          </p>
          {shown.length > 0 && (
            <div className="cv-check-results-wrap">
              <table className="cv-table cv-check-results">
                <thead>
                  <tr><th>Result</th><th>Device</th><th>Check</th><th>Evidence</th></tr>
                </thead>
                <tbody>
                  {shown.map((r, i) => {
                    const c = byId.get(r.checkId);
                    return (
                      <tr key={`${r.device}-${r.checkId}-${i}`}>
                        <td><span className={`cv-verdict is-${r.verdict}`}>{VERDICT_LABEL[r.verdict]}</span></td>
                        <td>{r.device}</td>
                        <td>{c ? checkLabel(c) : r.checkId}</td>
                        <td>
                          <span className="cv-help">{r.why}</span>
                          {r.evidence !== null && (
                            <div className="cv-mono cv-check-evidence">
                              {r.line !== null ? `line ${r.line}: ` : ''}
                              {r.evidence}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
