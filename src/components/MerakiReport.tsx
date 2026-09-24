import { useCallback, useState } from 'react';

import { t } from '../i18n';
import { saveExport } from '../lib/exports';
import { ipc, type MerakiCheck, type MerakiReport, type MerakiStatus } from '../lib/ipc';
import { reportFilename, reportSvg, statusLabel, tally } from '../lib/merakiReport';

/**
 * The health check on screen (LT-406).
 *
 * "the findings render **on screen** first and export through the PDF engine
 * that already exists" — so this is the report, and the PDF is this same
 * content drawn as SVG and handed to `diagram_pdf`. Not `.docx`: his script
 * writes one, Coreview has no `.docx` writer, and building one is days of work
 * before a single check is written.
 *
 * **Nothing is hidden; it is ranked.** Attention first, then advisories, then
 * what could not be read, then what passed. An advisory is still shown with
 * its evidence — the profile decided it is not urgent, not that it is
 * uninteresting.
 */
export function MerakiReportView({ report }: { report: MerakiReport }) {
  const [open, setOpen] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');

  const counts = tally(report);
  const actions = report.checks.flatMap((c) =>
    c.findings.filter((f) => f.severity === 'action').map((f) => ({ check: c, code: f.code })),
  );

  const savePdf = useCallback(async () => {
    setSaving(true);
    try {
      const bytes = await ipc.diagramPdf(reportSvg(report));
      const path = await saveExport(reportFilename(report), bytes, 'application/pdf');
      if (path) setSaved(`Saved ${path}`);
    } catch (e) {
      setSaved(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [report]);

  return (
    <div className="cv-meraki-report">
      <div className="cv-meraki-report-head">
        <h3>
          {report.organization} · {report.network}
        </h3>
        <span className="cv-help">{t('meraki.takenAt', { when: report.takenAt.replace('T', ' ').slice(0, 19) })}</span>
        <button type="button" onClick={() => void savePdf()} disabled={saving}>
          {t('meraki.exportPdf')}
        </button>
      </div>

      <ul className="cv-meraki-tally">
        {counts.map(({ status, count }) => (
          <li key={status} className={`cv-meraki-tile is-${status}`}>
            <strong>{count}</strong>
            <span>{statusLabel(status)}</span>
          </li>
        ))}
      </ul>

      <h4>{t('meraki.actions')}</h4>
      {actions.length === 0 ? (
        <p className="cv-help">{t('meraki.noActions')}</p>
      ) : (
        <table className="cv-table cv-meraki-actions">
          <thead>
            <tr>
              <th>{report.profile.label}</th>
              <th>Finding</th>
              <th>Where</th>
            </tr>
          </thead>
          <tbody>
            {actions.map(({ check, code }) => (
              <tr key={`${check.id}-${code}`}>
                <td>{check.title}</td>
                <td>{check.summary}</td>
                <td>{check.navigation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ol className="cv-meraki-checks">
        {ranked(report.checks).map((check) => (
          <li key={check.id} className={`cv-meraki-check is-${check.status}`}>
            <button
              type="button"
              className="cv-meraki-check-head"
              aria-expanded={open === check.id}
              onClick={() => setOpen(open === check.id ? '' : check.id)}
            >
              <span className="cv-meraki-num">{check.num}</span>
              <span className="cv-meraki-check-title">{check.title}</span>
              <span className={`cv-pill is-${check.status}`}>{statusLabel(check.status)}</span>
            </button>
            <p className="cv-meraki-summary">{check.summary}</p>
            {open === check.id && (
              <div className="cv-meraki-check-body">
                {check.observations.map((o) => (
                  <p key={o} className="cv-help">
                    {o}
                  </p>
                ))}
                {check.action && <p className="cv-meraki-action">{check.action}</p>}
                {check.details.map((detail) => (
                  <div key={detail.label}>
                    <h5>{detail.label}</h5>
                    <table className="cv-table">
                      <thead>
                        <tr>
                          {detail.columns.map((col, i) => (
                            <th key={`${detail.label}-col-${i}`}>{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {detail.rows.map((row, r) => (
                          <tr key={`${detail.label}-row-${r}`}>
                            {row.map((cell, i) => (
                              <td key={`${detail.label}-${r}-${i}`}>{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
                <p className="cv-help">{check.navigation}</p>
              </div>
            )}
          </li>
        ))}
      </ol>

      <p className="cv-help">{t('meraki.dataWindows', { windows: report.dataWindows })}</p>
      {saved && <p className="cv-saved-note">{saved}</p>}
    </div>
  );
}

/** Attention first. The order is the point of the report. */
const RANK: Record<MerakiStatus, number> = { attention: 0, advisory: 1, manual: 2, pass: 3, na: 4 };

function ranked(checks: MerakiCheck[]): MerakiCheck[] {
  return [...checks].sort((a, b) => RANK[a.status] - RANK[b.status] || a.num.localeCompare(b.num));
}
