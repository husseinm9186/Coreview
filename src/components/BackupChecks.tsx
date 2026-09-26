import { useEffect, useMemo, useState } from 'react';

import {
  EXPECT_CHOICES,
  SEVERITY_CHOICES,
  checkLabel,
  checkMatrix,
  isComplete,
  matrixCsv,
  matrixMarkdown,
  newCheck,
  orderResults,
  parseChecks,
  serializeChecks,
  summarise,
  type BackupCheck,
  type CheckExpect,
  type CheckResult,
  type CheckSeverity,
  type CheckVerdict,
} from '../lib/checks';
import { saveExport, slug } from '../lib/exports';
import { describeStamp } from '../lib/fileNames';
import { ipc, type BackupRunSummary } from '../lib/ipc';
import { useStore } from '../state/store';
import { t } from '../i18n';

const VERDICT_LABEL: Record<CheckVerdict, string> = {
  pass: 'Pass',
  fail: 'Fail',
  notCaptured: 'Not captured',
  rejected: 'Not accepted',
  notApplicable: 'Not applicable',
};

/** LT-434: each drawn device's role, by the name its backups are filed under,
 *  so a check written for routers is not applicable to a switch. */
function rolesOnTheDiagram(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const page of useStore.getState().doc.pages) {
    for (const n of page.nodes) {
      const d = n.data as { label?: string; role?: string };
      const label = d.label?.trim();
      const role = d.role?.trim();
      if (label && role) out[label] = role;
    }
  }
  return out;
}

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
  // LT-434: the same results, as a grid of devices against checks.
  const [asMatrix, setAsMatrix] = useState(false);
  const exportFolder = useStore((s) => s.settings.exportFolder);

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
      .runBackupChecks(run, ready, rolesOnTheDiagram())
      .then(setResults)
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
      .finally(() => setChecking(false));
  };

  const byId = new Map(checks.map((c) => [c.id, c]));
  const counts = results ? summarise(results) : null;
  const matrix = results ? checkMatrix(results, ready) : null;
  const exportMatrix = (kind: 'csv' | 'md') => {
    if (!matrix) return;
    const name = `checks-${slug(run)}.${kind}`;
    const body = kind === 'csv' ? matrixCsv(matrix) : matrixMarkdown(matrix, run);
    void saveExport(name, body, kind === 'csv' ? 'text/csv' : 'text/markdown', exportFolder)
      .then((path) => { if (path) useStore.getState().setStatusMessage(t('checks.exported', { path })); })
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };
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
          {/* LT-434: once per stanza, how much it matters, and who it is for. */}
          <label className="cv-field cv-field-narrow">
            <span>{t('checks.block')}</span>
            <input className="cv-input cv-mono" value={c.block} spellCheck={false}
              title={t('checks.blockHint')}
              onChange={(e) => edit(c.id, { block: e.target.value })} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>{t('checks.severity')}</span>
            <select className="cv-input" value={c.severity}
              onChange={(e) => edit(c.id, { severity: e.target.value as CheckSeverity })}>
              {SEVERITY_CHOICES.map((x) => (
                <option key={x.value} value={x.value}>{x.label}</option>
              ))}
            </select>
          </label>
          <label className="cv-field cv-field-narrow">
            <span>{t('checks.roles')}</span>
            <input className="cv-input" value={c.roles.join(', ')} title={t('checks.rolesHint')}
              onChange={(e) => edit(c.id, { roles: e.target.value.split(',').map((r) => r.trim()).filter(Boolean) })} />
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
                    {describeStamp(r.stamp)} · {t('plural.device', { count: r.devices })}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="cv-btn cv-btn-small" onClick={runChecks}
              disabled={checking || !run || ready.length === 0}>
              {checking ? 'Checking…' : `Run ${t('plural.check', { count: ready.length })}`}
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
          {t('plural.checkIs', { count: checks.length - ready.length })} missing a
          command or text and will not run.
        </p>
      )}

      {problem && <p className="cv-discover-problem">{problem}</p>}

      {counts && results && (
        <>
          <p className="cv-help cv-check-summary">
            {counts.pass} passed · {counts.fail} failed · {counts.rejected} not accepted ·{' '}
            {counts.notCaptured} not captured · {counts.notApplicable} not applicable
            {results.length === 0 && ' — no device in this run has show-command captures'}
          </p>
          {results.length > 0 && (
            <div className="cv-before-after-pick">
              <label className="cv-check cv-check-inline">
                <input type="checkbox" checked={asMatrix} onChange={(e) => setAsMatrix(e.target.checked)} />
                {t('checks.asMatrix')}
              </label>
              <button type="button" className="cv-btn cv-btn-small" onClick={() => exportMatrix('csv')}>{t('checks.exportCsv')}</button>
              <button type="button" className="cv-btn cv-btn-small" onClick={() => exportMatrix('md')}>{t('checks.exportMarkdown')}</button>
            </div>
          )}
          {asMatrix && matrix && matrix.rows.length > 0 && (
            <div className="cv-check-results-wrap">
              <table className="cv-table cv-check-matrix">
                <thead>
                  <tr>
                    <th>Device</th>
                    {matrix.checks.map((c) => <th key={c.id} title={c.severity}>{checkLabel(c)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {matrix.rows.map((r) => (
                    <tr key={r.device} data-worst={r.worst ?? 'none'}>
                      <td>{r.device}</td>
                      {r.cells.map((cell, i) => (
                        <td key={matrix.checks[i]?.id ?? i} title={cell?.why ?? ''}>
                          {cell ? <span className={`cv-verdict is-${cell.verdict}`}>{VERDICT_LABEL[cell.verdict]}</span> : ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!asMatrix && shown.length > 0 && (
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
                        <td>
                          <span className={`cv-verdict is-${r.verdict}`}>{VERDICT_LABEL[r.verdict]}</span>
                          {r.verdict === 'fail' && <span className={`cv-severity is-${r.severity}`}> {r.severity}</span>}
                        </td>
                        <td>{r.device}</td>
                        <td>{c ? checkLabel(c) : r.checkId}{r.block ? <span className="cv-help"> · {r.block}</span> : null}</td>
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
