import { useEffect, useState } from 'react';

import { t } from '../i18n';
import { CredentialOverride } from './CredentialOverride';
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
 * **"Global" here means the project's**, not the machine's — he said "global
 * project password". `credentialDefaults` has been exactly that since LT-286:
 * one SSH credential and a list of SNMP ones, held on the project as vault ids
 * and never as secrets (D-006). This gives them a home rather than a second
 * store, and it is what a device inherits when it has no login of its own and
 * what the discovery form offers first (LT-330).
 *
 * The terminal's preferences sit here too, because they were already settings
 * with nowhere to be (LT-321–325), and the vault itself, because "where are my
 * passwords" and "what is my password" are the same question asked twice.
 */
export function SettingsView() {
  const projectDefaults = useStore((s) => s.doc.credentialDefaults);
  const vaultRevision = useStore((s) => s.vaultRevision);
  const terminal = useStore((s) => s.settings.terminal);
  const setTerminal = useStore((s) => s.setTerminalSettings);
  const [saved, setSaved] = useState<CredentialSummary[]>([]);

  useEffect(() => {
    void ipc.listCredentials().then(setSaved).catch(() => setSaved([]));
  }, [vaultRevision]);

  const ssh = projectDefaults?.ssh;
  // A project keeps a list of SNMP credentials because a scan tries each in
  // turn; the first is the one everything else falls back to.
  const snmp = projectDefaults?.snmp?.[0];
  const named = (id: string | undefined) => (id ? saved.find((c) => c.id === id)?.label : undefined);

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

      <section className="cv-settings-block">
        <h2>{t('settings.vault')}</h2>
        <VaultSettings />
      </section>
    </div>
  );
}
