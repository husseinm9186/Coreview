import { useCallback, useEffect, useState } from 'react';

import { t } from '../i18n';
import {
  snmpDraft,
  snmpOverrideProblem,
  sshDraft,
  sshOverrideProblem,
  type SnmpOverride,
  type SshOverride,
} from '../lib/credentialOverride';
import { ipc, isDesktop, type CredentialSummary } from '../lib/ipc';
import { useStore } from '../state/store';
import { useVaultState, VaultPassphraseForm } from './VaultGate';

/**
 * A username and password typed against one device, saved and cleared from the
 * device itself (LT-318).
 *
 * The inspector could already point a device at a credential that was already
 * in the vault. That is the wrong half to have first: on a fresh install the
 * vault is empty, so the chooser offers nothing and the only way to give one
 * switch its own login is to leave the device, open Settings, and build a
 * credential by hand with no idea which device it was for.
 *
 * So this types it here. Save makes the vault if there is none, puts the
 * secret in it encrypted, and writes the **id** on the node — never the
 * password (D-006), which is why this survives closing the project, and why
 * the project file can be handed to somebody without handing over the login.
 * Clear takes it out of the vault and unsets the id.
 */
export function CredentialOverride({
  kind,
  device,
  credentialId,
  onChange,
  disabled = false,
  scope = 'device',
}: {
  kind: 'ssh' | 'snmp';
  /** What the device is called, which is what the saved credential is named after. */
  device: string;
  credentialId: string | undefined;
  onChange: (id: string | undefined) => void;
  disabled?: boolean;
  /** What this login belongs to. The same form does both (LT-327); only the
   *  words change, because "for this device" on the Settings screen would be
   *  saying the opposite of what it does. */
  scope?: 'device' | 'project';
}) {
  const { vault, refresh: refreshVault } = useVaultState();
  const [saved, setSaved] = useState<CredentialSummary[]>([]);
  const [editing, setEditing] = useState(false);
  const [gate, setGate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [ssh, setSsh] = useState<SshOverride>({ username: '', password: '', enable: '' });
  const [snmp, setSnmp] = useState<SnmpOverride>({
    version: 'v2c', community: '', user: '', auth: 'sha', authPassword: '', privacy: 'aes 256', privacyPassword: '',
  });

  const vaultRevision = useStore((s) => s.vaultRevision);
  const refresh = useCallback(
    () => ipc.listCredentials().then(setSaved).catch(() => setSaved([])),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh, vaultRevision]);

  const held = credentialId ? saved.find((c) => c.id === credentialId) : undefined;
  const problemNow = kind === 'ssh' ? sshOverrideProblem(ssh) : snmpOverrideProblem(snmp);

  /** Put the secret in the vault under this device's name and keep its id. */
  const save = () => {
    if (problemNow) {
      setProblem(problemNow);
      return;
    }
    setBusy(true);
    setProblem(null);
    const draft = kind === 'ssh' ? sshDraft(device, ssh) : snmpDraft(device, snmp);
    // Replacing keeps the same record so anything else pointing at it follows;
    // a new one gets a new id.
    void ipc
      .saveCredential({ ...(held ? { id: held.id } : {}), ...draft })
      .then(async (id) => {
        await refresh();
        await refreshVault();
        useStore.getState().bumpVault();
        onChange(id);
        setEditing(false);
        setGate(false);
        setSsh({ username: '', password: '', enable: '' });
        setSnmp((s) => ({ ...s, community: '', authPassword: '', privacyPassword: '' }));
        setNote(t('cred.kept'));
      })
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  /** Open the vault first if it is shut, then save. */
  const saveOrGate = () => {
    if (problemNow) {
      setProblem(problemNow);
      return;
    }
    setNote(null);
    // Read the vault fresh: the rendered copy is a render behind, and the
    // other override on this same device may have just made the vault.
    void refreshVault().then((v) => {
      if (v.exists && v.unlocked) save();
      else setGate(true);
    });
  };

  const clear = () => {
    setBusy(true);
    setProblem(null);
    const id = credentialId!;
    void ipc
      .deleteCredential(id)
      .then(() => refresh())
      .then(() => {
        useStore.getState().bumpVault();
        onChange(undefined);
        setConfirmClear(false);
        setNote(t('cred.cleared'));
      })
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  if (!isDesktop) return <p className="cv-help">{t('cred.desktopOnly')}</p>;

  const fields =
    kind === 'ssh' ? (
      <>
        <label className="cv-field cv-field-narrow">
          <span>{t('cred.username')}</span>
          <input className="cv-input" value={ssh.username} autoComplete="off" disabled={disabled || busy}
            onChange={(e) => setSsh({ ...ssh, username: e.target.value })} />
        </label>
        <label className="cv-field cv-field-narrow">
          <span>{t('cred.password')}</span>
          <input className="cv-input" type="password" value={ssh.password} autoComplete="new-password"
            disabled={disabled || busy} onChange={(e) => setSsh({ ...ssh, password: e.target.value })} />
        </label>
        <label className="cv-field cv-field-narrow">
          <span>{t('cred.enable')}</span>
          <input className="cv-input" type="password" value={ssh.enable ?? ''} autoComplete="new-password"
            disabled={disabled || busy} onChange={(e) => setSsh({ ...ssh, enable: e.target.value })} />
        </label>
      </>
    ) : (
      <>
        <label className="cv-field cv-field-narrow">
          <span>{t('cred.version')}</span>
          <select className="cv-input" value={snmp.version} disabled={disabled || busy}
            onChange={(e) => setSnmp({ ...snmp, version: e.target.value as 'v2c' | 'v3' })}>
            <option value="v2c">v2c</option>
            <option value="v3">v3</option>
          </select>
        </label>
        {snmp.version === 'v2c' ? (
          <label className="cv-field">
            <span>{t('cred.community')}</span>
            <input className="cv-input" type="password" value={snmp.community ?? ''} autoComplete="new-password"
              disabled={disabled || busy} onChange={(e) => setSnmp({ ...snmp, community: e.target.value })} />
          </label>
        ) : (
          <>
            <label className="cv-field cv-field-narrow">
              <span>{t('cred.user')}</span>
              <input className="cv-input" value={snmp.user ?? ''} autoComplete="off" disabled={disabled || busy}
                onChange={(e) => setSnmp({ ...snmp, user: e.target.value })} />
            </label>
            <label className="cv-field cv-field-narrow">
              <span>{t('cred.auth')}</span>
              <select className="cv-input" value={snmp.auth ?? 'sha'} disabled={disabled || busy}
                onChange={(e) => setSnmp({ ...snmp, auth: e.target.value })}>
                <option value="sha">sha</option>
                <option value="md5">md5</option>
                <option value="sha256">sha256</option>
                <option value="sha384">sha384</option>
                <option value="sha512">sha512</option>
              </select>
            </label>
            <label className="cv-field cv-field-narrow">
              <span>{t('cred.authPassword')}</span>
              <input className="cv-input" type="password" value={snmp.authPassword ?? ''} autoComplete="new-password"
                disabled={disabled || busy} onChange={(e) => setSnmp({ ...snmp, authPassword: e.target.value })} />
            </label>
            <label className="cv-field cv-field-narrow">
              <span>{t('cred.privacy')}</span>
              <select className="cv-input" value={snmp.privacy ?? 'aes 256'} disabled={disabled || busy}
                onChange={(e) => setSnmp({ ...snmp, privacy: e.target.value })}>
                <option value="none">none</option>
                <option value="des">des</option>
                <option value="aes">aes</option>
                <option value="aes 192">aes 192</option>
                <option value="aes 256">aes 256</option>
              </select>
            </label>
            <label className="cv-field cv-field-narrow">
              <span>{t('cred.privacyPassword')}</span>
              <input className="cv-input" type="password" value={snmp.privacyPassword ?? ''} autoComplete="new-password"
                disabled={disabled || busy} onChange={(e) => setSnmp({ ...snmp, privacyPassword: e.target.value })} />
            </label>
          </>
        )}
      </>
    );

  return (
    <div className="cv-cred-override" data-kind={kind}>
      <div className="cv-cred-override-head">
        <strong>
          {t(scope === 'project'
            ? (kind === 'ssh' ? 'cred.sshProject' : 'cred.snmpProject')
            : (kind === 'ssh' ? 'cred.ssh' : 'cred.snmp'))}
        </strong>
        <span className="cv-help">{t(scope === 'project' ? 'cred.projectHint' : 'cred.override')}</span>
      </div>

      {held && !editing ? (
        <div className="cv-keep-cred-held">
          <span className="cv-help">{t('cred.savedAs', { label: held.label })}</span>
          {confirmClear ? (
            <>
              <span className="cv-help">{t('cred.clearConfirm', { label: held.label })}</span>
              <button type="button" className="cv-btn cv-btn-small cv-btn-danger" disabled={disabled || busy}
                onClick={clear}>
                {t('cred.clearYes')}
              </button>
              <button type="button" className="cv-btn cv-btn-small" onClick={() => setConfirmClear(false)}>
                {t('cred.cancel')}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="cv-btn cv-btn-small" disabled={disabled || busy}
                onClick={() => { setEditing(true); setNote(null); setProblem(null); }}>
                {t('cred.replace')}
              </button>
              <button type="button" className="cv-btn cv-btn-small" disabled={disabled || busy}
                onClick={() => { setConfirmClear(true); setNote(null); setProblem(null); }}>
                {t('cred.clear')}
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          {!held && credentialId && (
            <p className="cv-help">
              {vault.unlocked ? 'A credential no longer saved.' : 'Saved — unlocking the vault…'}
            </p>
          )}
          <div className="cv-row">{fields}</div>
          {gate ? (
            <VaultPassphraseForm vault={vault} disabled={busy} onProblem={setProblem}
              onCancel={() => setGate(false)} onOpened={() => { void refreshVault().then(save); }} />
          ) : (
            <div className="cv-keep-cred-held">
              <button type="button" className="cv-btn cv-btn-small cv-btn-start" disabled={disabled || busy || Boolean(problemNow)}
                title={problemNow ?? undefined} onClick={saveOrGate}>
                {busy ? t('cred.saving') : t('cred.save')}
              </button>
              {editing && (
                <button type="button" className="cv-btn cv-btn-small" onClick={() => { setEditing(false); setProblem(null); }}>
                  {t('cred.cancel')}
                </button>
              )}
            </div>
          )}
        </>
      )}
      {problem && <p className="cv-problem">{problem}</p>}
      {!problem && note && <p className="cv-help">{note}</p>}
    </div>
  );
}
