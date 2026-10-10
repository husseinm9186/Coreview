/**
 * What an empty panel says: a glyph, what was looked for, one line on why
 * nothing is here, and the one thing to do about it. One component so every
 * panel says it the same way, and none says nothing. A feature a browser
 * cannot run says so with a chip and a way to the installed app.
 */
import { ChromeIcon, type ChromeIconName } from './chromeIcons';
import { t } from '../i18n';

export const DESKTOP_APP_URL = 'https://github.com/husseinm9186/Coreview/releases';

export function EmptyState({
  icon = 'find',
  title,
  line,
  action,
  desktopOnly,
  children,
}: {
  icon?: ChromeIconName;
  title: string;
  line?: string;
  action?: { label: string; onClick: () => void };
  /** The feature runs only in the installed app; offer it. */
  desktopOnly?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="cv-empty" role="status">
      <ChromeIcon name={icon} size={24} className="cv-empty-glyph" />
      <p className="cv-empty-title">
        {title}
        {desktopOnly && <span className="cv-empty-chip">{t('empty.desktopOnly')}</span>}
      </p>
      {line && <p className="cv-empty-line">{line}</p>}
      {action && (
        <button type="button" className="cv-btn cv-btn-small" onClick={action.onClick}>{action.label}</button>
      )}
      {desktopOnly && (
        <a className="cv-btn cv-btn-small" href={DESKTOP_APP_URL} target="_blank" rel="noreferrer noopener">{t('empty.getApp')}</a>
      )}
      {children}
    </div>
  );
}
