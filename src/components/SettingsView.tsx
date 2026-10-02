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
 * Settings, on the Tools screen (LT-327).
 *
 * The operator asked for "a settings tab for global ssh user and password and
 * snmp user and password … in tools and settings in the top menu", and the
 * reason is plain from where those things lived before: the vault was on the
 * project screen, which you have to close a project to see, and the discovery
 * logins were inside the Discover devices form, which is a panel about running
 * a scan. "What does this project log in with" had no place that answered it.
 *
 * **"Global" means global to this project, and to nothing else** (LT-335).
 * `credentialDefaults` has been per-project since LT-286 — it lives on the
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
  // LT-452: only what the scope reads.
  const pages = useStore((s) => s.doc.pages);
  const credentialRules = useStore((s) => s.doc.credentialRules);
  const vaultRevision = useStore((s) => s.vaultRevision);
  const terminal = useStore((s) => s.settings.terminal);
  const setTerminal = useStore((s) => s.setTerminalSettings);
  const [saved, setSaved] = useState<CredentialSummary[]>([]);
  const [pruned, setPruned] = useState(0);

  useEffect(() => {
    void ipc
      .listCredentials()
      .then((all) => {
        setSaved(all);
        // LT-335: a project that refers to a credential the vault no longer
        // holds used to fail a whole crawl with "That saved credential no
        // longer exists", from wherever the run happened to touch it. The
        // reference is dropped here, once, where it can be explained.
        const gone = useStore.getState().pruneStaleCredentials(all);
        if (gone) setPruned(gone);
      })
      .catch(() => setSaved([]));
  }, [vaultRevision]);

  // LT-497: every login the project keeps, in the order a crawl tries them.
  const sshIds = [projectDefaults?.ssh, ...(projectDefaults?.sshMore ?? [])].filter((id): id is string => !!id);
  const snmpIds = projectDefaults?.snmp ?? [];
  const named = (id: string | undefined) => (id ? saved.find((c) => c.id === id)?.label : undefined);

  const used = credentialsUsedBy({ pages, credentialDefaults: projectDefaults, credentialRules });
  const mine = saved.filter((c) => used.has(c.id));

  return (
    <div className="cv-settings">
      <section className="cv-settings-block">
        <h2>{t('settings.globalLogins')}</h2>
        <p className="cv-help">{t('settings.globalHint')}</p>
        {!isDesktop ? (
          <p className="cv-help">{t('cred.desktopOnly')}</p>
        ) : (
          <div className="cv-settings-creds" data-region="project-logins">
            {/* The same control the inspector uses on a device (LT-318) —
                type it, Save, Replace, Wipe — pointed at the project instead
                of at one switch. One form, one set of words, two scopes.
                LT-497: one block per login the project keeps, in the order a
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

      {/* LT-487: this project's folders, chosen where the project is open. */}
      <section className="cv-settings-block" data-region="project-folders">
        <FolderSettings />
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
        {/* LT-675: the three machine preferences that lived in the top bar. */}
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
        {/* D-059: another project's logins are not this project's business —
            not listed, not revealed, and refused by Rust if asked for. The
            whole vault is managed from the start screen, with no project open. */}
        <p className="cv-help cv-settings-elsewhere">{t('settings.otherProjects')}</p>
      </section>

      {/* LT-404: "make sure it goes to the settings at the top menu with
          options to select the customers and networks". */}
      <section className="cv-settings-block" data-region="meraki">
        <MerakiSettings credentials={saved} />
      </section>
    </div>
  );
}
