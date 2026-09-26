/**
 * The four things that are not about the diagram in front of you (LT-319).
 *
 * The bottom panel answers one question — *what is happening to my diagram
 * right now* — and it had grown ten tabs wide, so the answer arrived in a strip
 * a few rows tall. Four of the ten were never that question: comparing two
 * backup runs, laying out rack elevations, and the two imports. None reports on
 * a live diagram, and all four want height.
 *
 * So they get a screen, the same way the register did (LT-300, D-044). The
 * panel keeps Monitored objects, Event timeline, Ping sweep, Discover devices,
 * Backups and Path check, each of which is something running against the
 * diagram while you work.
 *
 * The diagram stays mounted behind, so leaving comes back to the same
 * selection and the same viewport.
 */
import { t } from '../i18n';
import { ComparePanel } from './ComparePanel';
import { CsvImportPanel } from './CsvImportPanel';
import { RackPanel } from './RackPanel';
import { SettingsView } from './SettingsView';
import { VisioImportPanel } from './VisioImportPanel';
import { useStore } from '../state/store';
import { LifecyclePanel } from './LifecyclePanel';

export type ToolsView = 'compare' | 'racks' | 'csv' | 'visio' | 'lifecycle' | 'settings';

const VIEWS: { id: ToolsView; label: () => string }[] = [
  { id: 'compare', label: () => t('tools.compare') },
  { id: 'racks', label: () => t('tools.racks') },
  { id: 'csv', label: () => t('tools.csv') },
  { id: 'visio', label: () => t('tools.visio') },
  // LT-439: which drawn devices are past their vendor's dates, from a table
  // the operator supplies.
  { id: 'lifecycle', label: () => t('tools.lifecycle') },
  // LT-327: and Settings, which is a place to go rather than a panel about the
  // diagram, exactly like the rest of this screen.
  { id: 'settings', label: () => t('settings.title') },
];

export function ToolsScreen() {
  const close = useStore((s) => s.setToolsOpen);
  const view = useStore((s) => s.toolsView);
  const setView = useStore((s) => s.setToolsView);
  const name = useStore((s) => s.meta?.name ?? '');

  return (
    <div className="cv-register cv-tools" data-region="tools">
      <div className="cv-register-head">
        <h1 className="cv-register-title">
          {t('tools.title')}
          {name && <span className="cv-register-project"> · {name}</span>}
        </h1>
        <div className="cv-tabs cv-register-tabs" role="tablist" aria-label={t('tools.title')}
          onKeyDown={(e) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
            const tabs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]')];
            const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1
              : (at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            e.preventDefault();
            tabs[next]?.focus();
            tabs[next]?.click();
          }}>
          {VIEWS.map((v) => (
            <button key={v.id} type="button" role="tab" aria-selected={view === v.id}
              tabIndex={view === v.id ? 0 : -1}
              className={view === v.id ? 'is-active' : ''} onClick={() => setView(v.id)}>
              {v.label()}
            </button>
          ))}
        </div>
        <button type="button" className="cv-btn cv-register-back" onClick={() => close(false)}>
          {t('tools.back')}
        </button>
      </div>
      <div className="cv-register-body cv-tools-body">
        {view === 'compare' ? <ComparePanel />
          : view === 'racks' ? <RackPanel />
          : view === 'csv' ? <CsvImportPanel />
          : view === 'lifecycle' ? <LifecyclePanel />
          : view === 'settings' ? <SettingsView />
          : <VisioImportPanel />}
      </div>
    </div>
  );
}
