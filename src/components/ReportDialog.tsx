/**
 * Choosing a PDF report (LT-256, LT-257): one of the four templates, then the
 * sections, each on or off. The template chooses sections; the choice is still
 * the engineer's.
 */
import { useEffect, useRef, useState } from 'react';

import { REPORT_TEMPLATES, SECTION_LABEL, type ReportSection, type ReportTemplate } from '../lib/reportPdf';
import { t } from '../i18n';

const ALL_SECTIONS = Object.keys(SECTION_LABEL) as ReportSection[];

export function ReportDialog({
  pages,
  busy,
  onMake,
  onClose,
}: {
  /** How many pages of drawings the report will carry. */
  pages: number;
  busy: boolean;
  onMake: (template: ReportTemplate, sections: ReportSection[]) => void;
  onClose: () => void;
}) {
  const [template, setTemplate] = useState<ReportTemplate>(REPORT_TEMPLATES[0]!);
  const [sections, setSections] = useState<Set<ReportSection>>(new Set(REPORT_TEMPLATES[0]!.sections));
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  const choose = (option: ReportTemplate) => {
    setTemplate(option);
    setSections(new Set(option.sections));
  };

  return (
    <div className="cv-modal-backdrop" role="presentation" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="cv-modal cv-report-dialog" role="dialog" aria-modal="true" aria-label={t('report.dialog')}>
        <h2>{t('report.dialog')}</h2>
        <fieldset className="cv-report-templates">
          <legend>{t('report.template')}</legend>
          {REPORT_TEMPLATES.map((option, i) => (
            <label key={option.id} className={`cv-report-template${template.id === option.id ? ' is-on' : ''}`}>
              <input ref={i === 0 ? first : undefined} type="radio" name="cv-report-template" checked={template.id === option.id} onChange={() => choose(option)} />
              <span>
                <strong>{option.name}</strong>
                <small>{option.purpose}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="cv-report-sections">
          <legend>{t('report.sections')}</legend>
          {ALL_SECTIONS.map((s) => (
            <label key={s} className="cv-check cv-check-inline">
              <input type="checkbox" checked={sections.has(s)}
                onChange={(e) => setSections((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(s);
                  else next.delete(s);
                  return next;
                })} />
              {SECTION_LABEL[s]}
            </label>
          ))}
        </fieldset>
        <p className="cv-help">
          {sections.has('diagrams') ? `${t('report.drawings', { count: pages })} ` : ''}
          {sections.has('diffs') ? `${t('report.changesNote')} ` : ''}
          {t('report.local')}
        </p>
        <div className="cv-modal-actions">
          <button type="button" className="cv-btn" onClick={onClose}>{t('report.cancel')}</button>
          <button type="button" className="cv-btn cv-btn-start" disabled={busy || sections.size === 0}
            onClick={() => onMake(template, ALL_SECTIONS.filter((s) => sections.has(s)))}>
            {busy ? t('report.making') : t('report.make')}
          </button>
        </div>
      </div>
    </div>
  );
}
