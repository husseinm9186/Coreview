import { useCallback, useState } from 'react';

import { t } from '../i18n';
import { saveExport } from '../lib/exports';
import { ipc, type MerakiCheck, type MerakiReport, type MerakiSection, type MerakiStatus } from '../lib/ipc';
import {
  actionItems,
  advisoryItems,
  reportFilename,
  reportSvg,
  sectionTitle,
  statusLabel,
  tally,
  STATUS_KEY,
} from '../lib/merakiReport';

/**
 * The health check on screen (LT-406, reshaped by LT-410).
 *
 * The first version was twenty one-line verdicts. What the operator compared it
 * against is a twenty-six item assessment a customer can act on without asking
 * anybody what it means, and the difference is structure: a key to the
 * verdicts, what was found at a glance, the actions and advisories as two
 * tables, and then each item with **what it covers**, what was observed, the
 * evidence, and **numbered steps**.
 *
 * **Nothing is hidden; it is ranked.** An advisory is still shown with its
 * evidence and its steps — the profile decided it is not urgent, not that it is
 * uninteresting.
 *
 * **The tool is not named anywhere in here.** The report is the customer's
 * document.
 */
export function MerakiReportView({ report }: { report: MerakiReport }) {
  const [open, setOpen] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');

  const counts = tally(report);
  const actions = actionItems(report);
  const advisories = advisoryItems(report);
  const products = [...new Set(report.checks.map((c) => c.section))];

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
        <h3>Network Health Check</h3>
        <button type="button" onClick={() => void savePdf()} disabled={saving}>
          {t('meraki.exportPdf')}
        </button>
      </div>

      <table className="cv-table cv-meraki-meta">
        <tbody>
          <tr>
            <th>{t('meraki.customer')}</th>
            <td>{report.organization}</td>
          </tr>
          <tr>
            <th>{t('meraki.networksAssessed')}</th>
            <td>{report.network}</td>
          </tr>
          <tr>
            <th>{t('meraki.dateGenerated')}</th>
            <td>{report.takenAt.replace('T', ' ').slice(0, 19)} UTC</td>
          </tr>
          <tr>
            <th>{t('meraki.profile')}</th>
            <td>
              {report.profile.label} — {report.profile.summary}
            </td>
          </tr>
        </tbody>
      </table>

      <h4>{t('meraki.howToRead')}</h4>
      <ul className="cv-meraki-key">
        {STATUS_KEY.map(({ status, meaning }) => (
          <li key={status}>
            <span className={`cv-pill is-${status}`}>{statusLabel(status)}</span> {meaning}
          </li>
        ))}
      </ul>
      <p className="cv-help">{t('meraki.dataWindows', { windows: report.dataWindows })}</p>
      <p className="cv-help">
        {products.map((s) => sectionTitle(s).replace(' Health Check', '')).join(' · ')} ·{' '}
        {t('meraki.itemsAssessed', { count: report.checks.length })}
      </p>

      <h4>{t('meraki.atAGlance')}</h4>
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
        <SummaryTable rows={actions} what={t('meraki.recommendedAction')} />
      )}

      <h4>{t('meraki.advisories')}</h4>
      {advisories.length === 0 ? (
        <p className="cv-help">{t('meraki.noAdvisories')}</p>
      ) : (
        <SummaryTable rows={advisories} what={t('meraki.suggestedImprovement')} />
      )}

      {(['firewall', 'wireless', 'switching'] as MerakiSection[]).map((section) => {
        const inSection = report.checks.filter((c) => c.section === section);
        if (inSection.length === 0) return null;
        return (
          <section key={section} className="cv-meraki-section">
            <h4>{sectionTitle(section)}</h4>
            <ol className="cv-meraki-checks">
              {ranked(inSection).map((check) => (
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
                  <p className="cv-meraki-nav">{check.navigation}</p>
                  <p className="cv-meraki-summary">{check.summary}</p>
                  {open === check.id && <CheckBody check={check} />}
                </li>
              ))}
            </ol>
          </section>
        );
      })}

      {saved && <p className="cv-saved-note">{saved}</p>}
    </div>
  );
}

/** The action items and advisories tables, which are the same shape. */
function SummaryTable({ rows, what }: { rows: { check: MerakiCheck; step: string }[]; what: string }) {
  return (
    <table className="cv-table cv-meraki-actions">
      <thead>
        <tr>
          <th>#</th>
          <th>{t('meraki.area')}</th>
          <th>{what}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ check, step }, i) => (
          <tr key={`${check.id}-${i}`}>
            <td>{i + 1}</td>
            <td>{check.title}</td>
            <td>{step}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** What an item covers, what was seen, the evidence, and what to do. */
function CheckBody({ check }: { check: MerakiCheck }) {
  return (
    <div className="cv-meraki-check-body">
      {check.checklist.length > 0 && (
        <>
          <h5>{t('meraki.checklist')}</h5>
          <ul className="cv-meraki-checklist">
            {check.checklist.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </>
      )}

      {check.observations.length > 0 && (
        <>
          <h5>{t('meraki.observed')}</h5>
          {check.observations.map((o) => (
            <p key={o} className="cv-help">
              {o}
            </p>
          ))}
        </>
      )}

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

      {check.steps.length > 0 && (
        <>
          <h5>
            {check.status === 'attention' ? t('meraki.recommendedAction') : t('meraki.suggestedImprovement')}
          </h5>
          <ol className="cv-meraki-steps">
            {check.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

/** Attention first. The order is the point of the report. */
const RANK: Record<MerakiStatus, number> = { attention: 0, advisory: 1, manual: 2, pass: 3, na: 4 };

function ranked(checks: MerakiCheck[]): MerakiCheck[] {
  return [...checks].sort((a, b) => RANK[a.status] - RANK[b.status] || a.num.localeCompare(b.num, 'en', { numeric: true }));
}
