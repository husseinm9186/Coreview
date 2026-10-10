import { useEffect, useState } from 'react';

import { t } from '../i18n';
import { CredentialOverride } from './CredentialOverride';
import { FolderSettings } from './FolderSettings';
import { MerakiSettings } from './MerakiSettings';
import { credentialsUsedBy } from '../lib/credentialScope';
import { ipc, isDesktop, type CredentialSummary } from '../lib/ipc';
import { useStore } from '../state/store';
import { TIME_FORMATS, isLocalFormat, zoneLabel, type TimeFormat } from '../lib/timeFormat';

/**
 * Settings, on the Tools screen.
 *
 * Global SSH and SNMP logins have a settings tab under Tools and Settings in
 * the top menu, and the reason is plain from where those things lived before: the vault was on the
 * project screen, which you have to close a project to see, and the discovery
 * logins were inside the Discover devices form, which is a panel about running
 * a scan. "What does this project log in with" had no place that answered it.
 *
 * **"Global" means global to this project, and to nothing else**.
 * `credentialDefaults` has been per-project — it lives on the
 * document — but this screen used to show the vault's whole contents
 * underneath it, so opening a second project displayed the first one's logins
 * by name and username. The secrets never moved; the fact of them did, and
 * that is a leak. What this screen shows now is what *this* project refers to.
 * The rest of the vault is one disclosure away and says plainly that it is the
 * whole machine.
 */
export function SettingsView() {
  const uiScale = useStore((s) => s.settings.uiScale);
  const settings = useStore((s) => s.settings);
  const projectDefaults = useStore((s) => s.doc.credentialDefaults);
  // Only what the scope reads.
  const pages = useStore((s) => s.doc.pages);
  const credentialRules = useStore((s) => s.doc.credentialRules);
  const vaultRevision = useStore((s) => s.vaultRevision);
  const terminal = useStore((s) => s.settings.terminal);
  const setTerminal = useStore((s) => s.setTerminalSettings);
  const update = useStore((s) => s.update);
  const [saved, setSaved] = useState<CredentialSummary[]>([]);
  const [pruned, setPruned] = useState(0);

  useEffect(() => {
    void ipc
      .listCredentials()
      .then((all) => {
        setSaved(all);
        // A project that refers to a credential the vault no longer
        // holds used to fail a whole crawl with "That saved credential no
        // longer exists", from wherever the run happened to touch it. The
        // reference is dropped here, once, where it can be explained.
        const gone = useStore.getState().pruneStaleCredentials(all);
        if (gone) setPruned(gone);
      })
      .catch(() => setSaved([]));
  }, [vaultRevision]);

  // Every login the project keeps, in the order a crawl tries them.
  const sshIds = [projectDefaults?.ssh, ...(projectDefaults?.sshMore ?? [])].filter((id): id is string => !!id);
  const snmpIds = projectDefaults?.snmp ?? [];
  const named = (id: string | undefined) => (id ? saved.find((c) => c.id === id)?.label : undefined);

  /** One of the SFTP server's settings: kept in the store for the screen,
   *  and written to the project's settings as the folders are. */
  const keepSftp = (key: 'sftpHost' | 'sftpPort' | 'sftpFolder' | 'sftpCredentialId', value: string) => {
    useStore.getState().setSettings({ [key]: value });
    void ipc.setSetting(key, value.trim() || null).catch(() => {});
  };

  const used = credentialsUsedBy({ pages, credentialDefaults: projectDefaults, credentialRules });
  const mine = saved.filter((c) => used.has(c.id));

  /** Where the check for a newer release has got to, in one line. */
  const updateStatus = (() => {
    switch (update.state) {
      case 'checking': return t('settings.updateChecking');
      case 'latest': return t('settings.updateLatest', { version: update.current ?? '' });
      case 'available': return t('settings.updateAvailable', { version: update.version ?? '', current: update.current ?? '' });
      case 'installing': {
        const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;
        const done = update.total ? `${mb(update.downloaded)} of ${mb(update.total)}` : mb(update.downloaded);
        return t('settings.updateInstalling', { done });
      }
      case 'problem': return t('settings.updateProblem', { why: update.problem ?? '' });
      default: return '';
    }
  })();
  const updateBusy = update.state === 'checking' || update.state === 'installing';

  return (
    <div className="cv-settings">
      <section className="cv-settings-block">
        <h2>{t('settings.globalLogins')}</h2>
        <p className="cv-help">{t('settings.globalHint')}</p>
        {!isDesktop ? (
          <p className="cv-help">{t('cred.desktopOnly')}</p>
        ) : (
          <div className="cv-settings-creds" data-region="project-logins">
            {/* The same control the inspector uses on a device —
                type it, Save, Replace, Wipe — pointed at the project instead
                of at one switch. One form, one set of words, two scopes.
                One block per login the project keeps, in the order a
                crawl tries them, and an empty one to add the next. */}
            {sshIds.map((id, i) => (
              <CredentialOverride
                key={id}
                kind="ssh"
                scope="project"
                device={sshIds.length > 1 ? t('settings.thisProjectNth', { n: i + 1 }) : t('settings.thisProject')}
                credentialId={id}
                onChange={(next) => useStore.getState().replaceProjectCredential('ssh', id, next)}
              />
            ))}
            {sshIds.length > 0 && <p className="cv-help cv-settings-another">{t('settings.anotherSsh')}</p>}
            <CredentialOverride
              key={`ssh-new-${sshIds.length}`}
              kind="ssh"
              scope="project"
              device={t('settings.thisProject')}
              credentialId={undefined}
              onChange={(id) => {
                if (id) useStore.getState().addProjectSsh(id);
              }}
            />
            {snmpIds.map((id, i) => (
              <CredentialOverride
                key={id}
                kind="snmp"
                scope="project"
                device={snmpIds.length > 1 ? t('settings.thisProjectNth', { n: i + 1 }) : t('settings.thisProject')}
                credentialId={id}
                onChange={(next) => useStore.getState().replaceProjectCredential('snmp', id, next)}
              />
            ))}
            {snmpIds.length > 0 && <p className="cv-help cv-settings-another">{t('settings.anotherSnmp')}</p>}
            <CredentialOverride
              key={`snmp-new-${snmpIds.length}`}
              kind="snmp"
              scope="project"
              device={t('settings.thisProject')}
              credentialId={undefined}
              onChange={(id) => {
                if (id) useStore.getState().rememberCredential('snmp', id);
              }}
            />
          </div>
        )}
        <p className="cv-help">
          {sshIds.length || snmpIds.length
            ? t('settings.inUse', {
                ssh: sshIds.map((id) => named(id) ?? '?').join(', ') || t('settings.none'),
                snmp: snmpIds.map((id) => named(id) ?? '?').join(', ') || t('settings.none'),
              })
            : t('settings.noneYet')}
        </p>
        {pruned > 0 && <p className="cv-help cv-settings-pruned">{t('settings.pruned', { count: pruned })}</p>}
      </section>

      {/* This project's folders, chosen where the project is open. */}
      <section className="cv-settings-block" data-region="project-folders">
        <FolderSettings />
      </section>

      {/* The server a Cisco device sends its configuration to when a backup
          is asked for over SNMP, and the login it is given. A project's,
          like the folders. The tick itself is on the Backups tab. */}
      <section className="cv-settings-block" data-region="snmp-backup">
        <h2>{t('settings.sftp')}</h2>
        <p className="cv-help">{t('settings.sftpHint')}</p>
        <div className="cv-row">
          <label className="cv-field">
            <span>{t('settings.sftpHost')}</span>
            <input className="cv-input cv-mono" value={settings.sftpHost} placeholder="files.example.net" spellCheck={false}
              data-field="sftp-host" aria-label={t('settings.sftpHost')} onChange={(e) => keepSftp('sftpHost', e.target.value)} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>{t('settings.sftpPort')}</span>
            <input className="cv-input" inputMode="numeric" value={settings.sftpPort} placeholder="22"
              data-field="sftp-port" aria-label={t('settings.sftpPort')}
              onChange={(e) => keepSftp('sftpPort', e.target.value.replace(/[^0-9]/g, '').slice(0, 5))} />
          </label>
          <label className="cv-field">
            <span>{t('settings.sftpFolder')}</span>
            <input className="cv-input cv-mono" value={settings.sftpFolder} placeholder="/configs" spellCheck={false}
              data-field="sftp-folder" aria-label={t('settings.sftpFolder')} onChange={(e) => keepSftp('sftpFolder', e.target.value)} />
          </label>
        </div>
        <CredentialOverride
          kind="sftp"
          scope="project"
          device={t('settings.sftpDevice')}
          credentialId={settings.sftpCredentialId || undefined}
          onChange={(id) => keepSftp('sftpCredentialId', id ?? '')}
        />
      </section>

      <section className="cv-settings-block" data-region="display">
        <h2>{t('settings.display')}</h2>
        <p className="cv-help">{t('settings.displayHint')}</p>
        <label className="cv-field cv-field-narrow">
          <span>{t('settings.uiScale')}</span>
          <select className="cv-input" value={String(uiScale)} onChange={(e) => useStore.getState().setSettings({ uiScale: Number(e.target.value) })}>
            {[0.85, 1, 1.15, 1.3, 1.4].map((v) => <option key={v} value={String(v)}>{Math.round(v * 100)} %</option>)}
          </select>
        </label>
        {/* What the wheel does on the diagram. */}
        <label className="cv-field cv-field-narrow" title={t('settings.wheelHint')}>
          <span>{t('settings.wheel')}</span>
          <select className="cv-input" value={settings.wheel} aria-label={t('settings.wheel')} onChange={(e) => useStore.getState().setSettings({ wheel: e.target.value === 'scroll' ? 'scroll' : 'zoom' })}>
            <option value="zoom">{t('settings.wheelZoom')}</option>
            <option value="scroll">{t('settings.wheelScroll')}</option>
          </select>
        </label>
        {/* The three machine preferences that lived in the top bar. */}
        <label className="cv-check" title={t('settings.reduceMotionHint')}>
          <input type="checkbox" checked={settings.reduceMotion} onChange={(e) => useStore.getState().setSettings({ reduceMotion: e.target.checked })} />
          {t('settings.reduceMotion')}
        </label>
        <label className="cv-check" title={t('settings.highContrastHint')}>
          <input type="checkbox" checked={settings.highContrast} onChange={(e) => useStore.getState().setSettings({ highContrast: e.target.checked })} />
          {t('settings.highContrast')}
        </label>
        <label className="cv-field cv-field-narrow" title={`Times shown in ${isLocalFormat(settings.timeFormat) ? zoneLabel() : 'Zulu (UTC)'}`}>
          <span>{t('settings.times')}</span>
          <select className="cv-input" value={settings.timeFormat} onChange={(e) => useStore.getState().setSettings({ timeFormat: e.target.value as TimeFormat })}>
            {TIME_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
      </section>
      {/* The one host nobody typed in. Nothing is sent until the button is
          pressed or the tick, off until somebody ticks it, is on. */}
      <section className="cv-settings-block" data-region="updates">
        <h2>{t('settings.updates')}</h2>
        <p className="cv-help">{t('settings.updatesHint')}</p>
        <div className="cv-row cv-update-row">
          <button type="button" className="cv-btn" data-action="check-updates" disabled={updateBusy}
            onClick={() => void useStore.getState().checkForUpdate()}>
            {t('settings.checkForUpdates')}
          </button>
          {updateStatus && <span className={update.state === 'problem' ? 'cv-help cv-update-problem' : 'cv-help'} data-hint="updates" role="status">{updateStatus}</span>}
        </div>
        {update.state === 'available' && (
          <div className="cv-update-found" data-region="update-found">
            {update.date && <p className="cv-help">{t('settings.updatePublished', { date: update.date.slice(0, 10) })}</p>}
            {update.notes && (
              <details className="cv-update-notes">
                <summary>{t('settings.updateNotes')}</summary>
                <pre>{update.notes}</pre>
              </details>
            )}
            <button type="button" className="cv-btn cv-btn-start" data-action="install-update"
              onClick={() => void useStore.getState().installUpdate()}>
              {t('settings.updateInstall')}
            </button>
            <p className="cv-help">{t('settings.updateInstallHint')}</p>
          </div>
        )}
        <label className="cv-check" title={t('settings.updateOnStartHint')}>
          <input type="checkbox" data-field="update-on-start" checked={settings.updateCheckOnStart}
            onChange={(e) => void useStore.getState().setUpdateCheckOnStart(e.target.checked)} />
          {t('settings.updateOnStart')}
        </label>
        <p className="cv-help">{t('settings.updateOnStartHint')}</p>
        <p className="cv-help">{t('settings.updateReleases')}</p>
      </section>
      <section className="cv-settings-block">
        <h2>{t('settings.terminal')}</h2>
        <p className="cv-help">{t('settings.terminalHint')}</p>
        <div className="cv-row">
          <label className="cv-field cv-field-narrow">
            <span>{t('settings.openWith')}</span>
            <select className="cv-input" value={terminal.openWith}
              onChange={(e) => setTerminal({ openWith: e.target.value === 'external' ? 'external' : 'panel' })}>
              <option value="panel">{t('settings.openPanel')}</option>
              <option value="external">{t('settings.openExternal')}</option>
            </select>
          </label>
          <label className="cv-field">
            <span>{t('settings.externalCommand')}</span>
            <input className="cv-input cv-mono" value={terminal.externalCommand}
              placeholder="putty -ssh {user}@{host} -P {port}" spellCheck={false}
              onChange={(e) => setTerminal({ externalCommand: e.target.value })} />
          </label>
        </div>
        <p className="cv-help">{t('settings.externalHint')}</p>
        <label className="cv-check cv-check-inline">
          <input type="checkbox" checked={terminal.logByDefault}
            onChange={(e) => setTerminal({ logByDefault: e.target.checked })} />
          {t('settings.logByDefault')}
        </label>
      </section>

      <section className="cv-settings-block" data-region="project-credentials">
        <h2>{t('settings.projectCredentials')}</h2>
        <p className="cv-help">{t('settings.projectCredentialsHint')}</p>
        {mine.length === 0 ? (
          <p className="cv-help">{t('settings.noneForProject')}</p>
        ) : (
          <table className="cv-table cv-vault-table">
            <thead>
              <tr>
                <th>{t('settings.colName')}</th>
                <th>{t('settings.colFor')}</th>
                <th>{t('settings.colUser')}</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((c) => (
                <tr key={c.id}>
                  <td>{c.label}</td>
                  <td>{c.kind.toUpperCase()}</td>
                  <td className="cv-mono">{c.username || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {/* Another project's logins are not this project's business —
            not listed, not revealed, and refused by Rust if asked for. The
            whole vault is managed from the start screen, with no project open. */}
        <p className="cv-help cv-settings-elsewhere">{t('settings.otherProjects')}</p>
      </section>

      {/* "make sure it goes to the settings at the top menu with
          options to select the customers and networks". */}
      <section className="cv-settings-block" data-region="meraki">
        <MerakiSettings credentials={saved} />
      </section>
    </div>
  );
}
