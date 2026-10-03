/**
 * The rail (LT-675, D-064): one column of the modes this app has, always in
 * sight, so Addresses and Tools stop being detours reached from the top bar
 * and the dock's tabs have a name you can press without the dock being open.
 *
 * Diagram, Addresses, Tools and Settings are screens; Discover, Monitor,
 * Paths, Backups and Terminal are the dock's tabs, opened through the same
 * request the inspector already uses. The one that is showing is marked
 * `aria-current`.
 */
import { t } from '../i18n';
import { useStore, type DockTab } from '../state/store';

type Mode = 'diagram' | 'discover' | 'monitor' | 'paths' | 'backups' | 'racks' | 'addresses' | 'tools' | 'terminal' | 'settings';

const DOCK: Partial<Record<Mode, DockTab>> = { discover: 'crawl', monitor: 'objects', paths: 'trace', backups: 'backup', terminal: 'ssh' };
const DOCK_MODE: Partial<Record<DockTab, Mode>> = {
  crawl: 'discover', discover: 'discover', collect: 'discover',
  objects: 'monitor', events: 'monitor',
  trace: 'paths', path: 'paths', tracert: 'paths', whereis: 'paths',
  backup: 'backups',
  ssh: 'terminal',
};

/** The class the top bar's button carried before the rail (LT-675): the
 * harnesses and the guide reach Tools and Addresses by it, and it still
 * names the same thing. */
const HANDLE: Partial<Record<Mode, string>> = { addresses: 'cv-btn-register', tools: 'cv-btn-tools' };

/** Simple strokes, drawn here rather than imported: no artwork ships that is not ours (D-019). */
function Glyph({ mode }: { mode: Mode }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (mode) {
    case 'diagram':
      return <svg viewBox="0 0 20 20" aria-hidden><g {...p}><rect x="3" y="3" width="5" height="4" rx="1" /><rect x="12" y="3" width="5" height="4" rx="1" /><rect x="7.5" y="13" width="5" height="4" rx="1" /><path d="M5.5 7v3h9V7M10 10v3" /></g></svg>;
    case 'discover':
      return <svg viewBox="0 0 20 20" aria-hidden><g {...p}><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="3" /><path d="M10 3v2M10 15v2M3 10h2M15 10h2" /></g></svg>;
    case 'monitor':
      return <svg viewBox="0 0 20 20" aria-hidden><g {...p}><path d="M2 11h4l2-6 3 10 2-6 2 2h3" /></g></svg>;
    case 'paths':
      return <svg viewBox="0 0 20 20" aria-hidden><g {...p}><circle cx="4" cy="15" r="2" /><circle cx="16" cy="5" r="2" /><path d="M6 15h4a3 3 0 0 0 3-3V8a3 3 0 0 1 3-3" /></g></svg>;
    case 'backups':
      return <svg viewBox="0 0 20 20" aria-hidden><g {...p}><rect x="3" y="4" width="14" height="4" rx="1" /><path d="M4 8v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8M8 12h4" /></g></svg>;
    case 'addresses':
      return <svg viewBox="0 0 20 20" aria-hidden><g {...p}><path d="M7 3 5 17M15 3l-2 14M3 8h15M2 13h15" /></g></svg>;
    case 'racks':
      return <svg viewBox="0 0 20 20" aria-hidden><g {...p}><rect x="4" y="2" width="12" height="16" rx="1" /><path d="M6 6h8M6 9.5h8M6 13h8M6 16h8M4 2v-0M4 18v1M16 18v1" /></g></svg>;
    case 'tools':
      return <svg viewBox="0 0 20 20" aria-hidden><g {...p}><path d="M12.5 3.5a3.5 3.5 0 0 0-3 5.3L4 14.3 5.7 16l5.5-5.5a3.5 3.5 0 0 0 5.3-3l-2.3 2.3-2.3-.7-.7-2.3z" /></g></svg>;
    case 'terminal':
      return <svg viewBox="0 0 20 20" aria-hidden><g {...p}><rect x="2.5" y="4" width="15" height="12" rx="1.5" /><path d="M6 8l3 2-3 2M10 13h4" /></g></svg>;
    case 'settings':
      return <svg viewBox="0 0 20 20" aria-hidden><g {...p}><circle cx="10" cy="10" r="2.5" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" /></g></svg>;
  }
}

export function NavRail() {
  const registerOpen = useStore((s) => s.registerOpen);
  const toolsOpen = useStore((s) => s.toolsOpen);
  const toolsView = useStore((s) => s.toolsView);
  const helpOpen = useStore((s) => s.helpOpen);
  const panelOpen = useStore((s) => s.panelOpen);
  const dockTab = useStore((s) => s.dockTab);

  const current: Mode | null = registerOpen
    ? 'addresses'
    : toolsOpen
      ? toolsView === 'settings' ? 'settings' : toolsView === 'racks' ? 'racks' : 'tools'
      : helpOpen
        ? null
        : panelOpen
          ? (DOCK_MODE[dockTab] ?? 'diagram')
          : 'diagram';

  const go = (mode: Mode) => {
    const s = useStore.getState();
    switch (mode) {
      case 'diagram':
        s.setRegisterOpen(false);
        s.setToolsOpen(false);
        s.setHelpOpen(false);
        return;
      case 'addresses':
        s.setRegisterOpen(true);
        return;
      case 'tools':
        s.setToolsOpen(true, s.toolsView === 'settings' || s.toolsView === 'racks' ? 'compare' : undefined);
        return;
      // LT-681: the rack elevations, from the rail.
      case 'racks':
        s.setToolsOpen(true, 'racks');
        return;
      case 'settings':
        s.setToolsOpen(true, 'settings');
        return;
      default: {
        s.setRegisterOpen(false);
        s.setToolsOpen(false);
        s.setHelpOpen(false);
        const tab = DOCK[mode];
        if (tab) s.requestPanelTab(tab);
      }
    }
  };

  const items: { mode: Mode; label: string }[] = [
    { mode: 'diagram', label: t('nav.diagram') },
    { mode: 'discover', label: t('nav.discover') },
    { mode: 'monitor', label: t('nav.monitor') },
    { mode: 'paths', label: t('nav.paths') },
    { mode: 'backups', label: t('nav.backups') },
    { mode: 'racks', label: t('nav.racks') },
    { mode: 'addresses', label: t('nav.addresses') },
    { mode: 'tools', label: t('nav.tools') },
    { mode: 'terminal', label: t('nav.terminal') },
  ];

  return (
    <nav className="cv-nav" aria-label={t('nav.title')} data-region="nav">
      {items.map((i) => (
        <button
          key={i.mode}
          type="button"
          className={`cv-nav-item${HANDLE[i.mode] ? ` ${HANDLE[i.mode]}` : ''}${current === i.mode ? ' is-current' : ''}`}
          aria-current={current === i.mode ? 'page' : undefined}
          title={i.label}
          onClick={() => go(i.mode)}
        >
          <Glyph mode={i.mode} />
          <span>{i.label}</span>
        </button>
      ))}
      <span className="cv-nav-space" />
      <button
        type="button"
        className={`cv-nav-item${current === 'settings' ? ' is-current' : ''}`}
        aria-current={current === 'settings' ? 'page' : undefined}
        title={t('nav.settings')}
        onClick={() => go('settings')}
      >
        <Glyph mode="settings" />
        <span>{t('nav.settings')}</span>
      </button>
    </nav>
  );
}
