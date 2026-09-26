/**
 * Which subnets are in use, and which are not (LT-298).
 *
 * The register answers that subnet by subnet. This answers it for the estate
 * at a glance, which is a different job — and it is the question the operator
 * asked the register to be able to answer.
 *
 * Nothing here is stored: every number is derived from the same `buildIpam`
 * the list beneath it uses, so the two cannot disagree.
 */
import { useMemo } from 'react';

import { t } from '../i18n';
import { allNodes } from '../lib/pages';
import { buildIpam } from '../lib/ipam';
import { dashboardRows, dashboardTotals, untouched, type Band } from '../lib/ipamDashboard';
import { useStore } from '../state/store';

const BAND_LABEL: Record<Band, () => string> = {
  full: () => t('dash.full'),
  busy: () => t('dash.busy'),
  light: () => t('dash.light'),
  empty: () => t('dash.empty'),
};

export function IpamDashboard() {
  // LT-452: the register is derived from the pages and its own state only.
  const pages = useStore((s) => s.doc.pages);
  const ipam = useStore((s) => s.doc.ipam);
  const model = useMemo(() => buildIpam(allNodes({ pages }), ipam), [pages, ipam]);
  const rows = useMemo(() => dashboardRows(model), [model]);
  const totals = useMemo(() => dashboardTotals(rows), [rows]);
  const spare = useMemo(() => untouched(rows), [rows]);

  if (rows.length === 0) {
    return <p className="cv-muted cv-lab-view">{t('dash.nothing')}</p>;
  }

  return (
    <div className="cv-lab-view cv-dash">
      <div className="cv-lab-bar">
        <span className="cv-help">
          {t('dash.summary', {
            subnets: totals.subnets,
            used: totals.used,
            usable: totals.usable,
          })}
        </span>
        {(['full', 'busy', 'light', 'empty'] as Band[]).map((b) =>
          totals.byBand[b] ? (
            <span key={b} className={`cv-pill cv-band-${b}`}>
              {totals.byBand[b]} {BAND_LABEL[b]()}
            </span>
          ) : null,
        )}
      </div>

      {spare.length > 0 && (
        // The reclaimable ones, said plainly rather than left to be spotted.
        <p className="cv-help">
          {t('dash.untouched', { list: spare.slice(0, 12).map((r) => r.cidr).join(', ') })}
        </p>
      )}

      <table className="cv-table cv-dash-table">
        <thead>
          <tr>
            <th>{t('dash.colSubnet')}</th>
            <th>{t('dash.colName')}</th>
            <th>{t('dash.colVlan')}</th>
            <th className="cv-num">{t('dash.colUsed')}</th>
            <th className="cv-num">{t('dash.colFree')}</th>
            <th className="cv-num">{t('dash.colUsable')}</th>
            <th>{t('dash.colHowFull')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.cidr} data-band={r.band}>
              <td className="cv-mono">{r.cidr}</td>
              <td>{r.name ?? ''}</td>
              <td className="cv-mono">{r.vlan === undefined ? '' : r.vlan}</td>
              <td className="cv-num">{r.used}</td>
              <td className="cv-num">{r.free}</td>
              <td className="cv-num">{r.usable}</td>
              <td>
                {/* The bar is the scan; the number is the detail. */}
                <span className="cv-bar" aria-hidden="true">
                  <span className={`cv-bar-fill cv-band-${r.band}`} style={{ width: `${r.percent}%` }} />
                </span>
                <span className="cv-mono cv-bar-value">{r.percent}%</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
