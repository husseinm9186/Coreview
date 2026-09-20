import { useEffect, useState } from 'react';

import { t } from '../i18n';
import { CredentialOverride } from './CredentialOverride';
import { credentialsUsedBy } from '../lib/credentialScope';
import { ipc, isDesktop, type CredentialSummary } from '../lib/ipc';
import { useStore } from '../state/store';
import { VaultSettings } from './VaultSettings';

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
  const projectDefaults = useStore((s) => s.doc.credentialDefaults);
  const doc = useStore((s) => s.doc);
  const vaultRevision = useStore((s) => s.vaultRevision);
  const terminal = useStore((s) => s.settings.terminal);
  const setTerminal = useStore((s) => s.setTerminalSettings);
  const [saved, setSaved] = useState<CredentialSummary[]>([]);
  const [pruned, setPruned] = useState(0);
  const [everything, setEverything] = useState(false);

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

  const ssh = projectDefaults?.ssh;
  // A project keeps a list of SNMP credentials because a scan tries each in
  // turn; the first is the one everything else falls back to.
  const snmp = projectDefaults?.snmp?.[0];
  const named = (id: string | undefined) => (id ? saved.find((c) => c.id === id)?.label : undefined);

  const used = credentialsUsedBy(doc);
  const mine = saved.filter((c) => used.has(c.id));
  const elsewhere = saved.length - mine.length;

  return (
    <div className="cv-settings">
      <section className="cv-settings-block">
        <h2>{t('settings.globalLogins')}</h2>
        <p className="cv-help">{t('settings.globalHint')}</p>
        {!isDesktop ? (
          <p className="cv-help">{t('cred.desktopOnly')}</p>
        ) : (
          <div className="cv-settings-creds">
            {/* The same control the inspector uses on a device (LT-318) —
                type it, Save, Replace, Wipe — pointed at the project instead
                of at one switch. One form, one set of words, two scopes. */}
            <CredentialOverride
              kind="ssh"
              scope="project"
              device={t('settings.thisProject')}
              credentialId={ssh}
              onChange={(id) => {
                if (id) useStore.getState().rememberCredential('ssh', id);
                else useStore.getState().forgetCredential('ssh');
              }}
            />
            <CredentialOverride
              kind="snmp"
              scope="project"
              device={t('settings.thisProject')}
              credentialId={snmp}
              onChange={(id) => {
                if (id) useStore.getState().rememberCredential('snmp', id);
                else if (snmp) useStore.getState().forgetCredential('snmp', snmp);
              }}
            />
          </div>
        )}
        <p className="cv-help">
          {ssh || snmp
            ? t('settings.inUse', {
                ssh: named(ssh) ?? t('settings.none'),
                snmp: named(snmp) ?? t('settings.none'),
              })
            : t('settings.noneYet')}
        </p>
        {pruned > 0 && <p className="cv-help cv-settings-pruned">{t('settings.pruned', { count: pruned })}</p>}
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
        {/* The whole vault is a machine-wide thing and is not hidden — but it
            is not this project's business either, so it says which it is and
            stays shut until it is asked for (LT-335). */}
        <details className="cv-settings-vault" open={everything}
          onToggle={(e) => setEverything((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>{t('settings.everything', { count: elsewhere })}</summary>
          <p className="cv-help">{t('settings.everythingHint')}</p>
          {everything && <VaultSettings />}
        </details>
      </section>
    </div>
  );
}
