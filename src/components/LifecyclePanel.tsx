/**
 * Lifecycle (LT-439): which drawn devices are past their vendor's end of
 * sale or end of support, from a table the operator supplies as a CSV.
 * Nothing is fetched from a vendor; the table lives in the project.
 */
import { useMemo, useState } from 'react';

import { saveExport, slug } from '../lib/exports';
import { ipc } from '../lib/ipc';
import { lifecycleCsv, lifecycleVerdicts, readLifecycleCsv, type LifecycleRow, type LifecycleState } from '../lib/lifecycle';
import { useStore } from '../state/store';
import { t } from '../i18n';

const STATES: LifecycleState[] = ['unsupported', 'unsold', 'current', 'unknown'];
// A stable empty list, so the selector's result compares equal render to render.
const NO_ROWS: LifecycleRow[] = [];

export function LifecyclePanel() {
  // LT-452: the pages and the table, not the whole document.
  const pages = useStore((s) => s.doc.pages);
  const lifecycle = useStore((s) => s.doc.lifecycle);
  const meta = useStore((s) => s.meta);
  const setLifecycle = useStore((s) => s.setLifecycle);
  const exportFolder = useStore((s) => s.settings.exportFolder);
  const [problems, setProblems] = useState<string[]>([]);
  const rows = lifecycle ?? NO_ROWS;
  const today = new Date().toISOString().slice(0, 10);
  const verdicts = useMemo(() => lifecycleVerdicts({ pages }, rows, today), [pages, rows, today]);
  const counts = useMemo(() => {
    const c: Record<LifecycleState, number> = { unsupported: 0, unsold: 0, current: 0, unknown: 0 };
    for (const v of verdicts) c[v.state] += 1;
    return c;
  }, [verdicts]);

  const read = async () => {
    setProblems([]);
    try {
      const path = await ipc.pickImportFile();
      if (!path) return;
      const result = readLifecycleCsv(await ipc.readImport(path));
      setProblems(result.problems);
      if (result.rows.length) setLifecycle(result.rows);
    } catch (e) {
      setProblems([e instanceof Error ? e.message : String(e)]);
    }
  };

  const exportVerdicts = () => {
    void saveExport(`${slug(meta?.name ?? 'project')}-lifecycle.csv`, lifecycleCsv(verdicts), 'text/csv', exportFolder)
      .then((path) => { if (path) useStore.getState().setStatusMessage(t('lifecycle.exported', { path })); })
      .catch((e: unknown) => setProblems([e instanceof Error ? e.message : String(e)]));
  };

  return (
    <div className="cv-compare cv-lifecycle">
      <p className="cv-help">{t('lifecycle.help')}</p>
      <div className="cv-discover-actions">
        <button type="button" className="cv-btn cv-btn-small" onClick={() => void read()}>{t('lifecycle.choose')}</button>
        {rows.length > 0 && (
          <>
            <span className="cv-help">{t('lifecycle.rows', { count: rows.length })}</span>
            <button type="button" className="cv-btn cv-btn-small" onClick={() => setLifecycle([])}>{t('lifecycle.clear')}</button>
            <button type="button" className="cv-btn cv-btn-small" onClick={exportVerdicts}>{t('lifecycle.exportCsv')}</button>
          </>
        )}
      </div>
      {problems.length > 0 && (
        <ul className="cv-discover-problem">
          {problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}
      {rows.length === 0 ? (
        <p className="cv-help">{t('lifecycle.none')}</p>
      ) : (
        <>
          <p className="cv-help cv-lifecycle-summary">{t('lifecycle.summary', counts)}</p>
          <div className="cv-table-scroll">
            <table className="cv-table cv-compare-table">
              <thead><tr><th>Device</th><th>Model</th><th>State</th><th>End of sale</th><th>End of support</th><th>Matched</th></tr></thead>
              <tbody>
                {verdicts.map((v) => (
                  <tr key={v.nodeId} data-state={v.state} className={v.state === 'unsupported' ? 'is-worse' : v.state === 'unsold' ? 'is-changed' : ''}>
                    <td>{v.label}</td>
                    <td className="cv-mono">{v.model}</td>
                    <td>{t(`lifecycle.state.${v.state}` as `lifecycle.state.${LifecycleState}`)}</td>
                    <td className="cv-mono">{v.endOfSale}</td>
                    <td className="cv-mono">{v.endOfSupport}</td>
                    <td className="cv-help">{v.matched ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {STATES.every((s) => counts[s] === 0) && <p className="cv-help">{t('lifecycle.none')}</p>}
        </>
      )}
    </div>
  );
}
