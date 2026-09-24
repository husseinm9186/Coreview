import { useCallback, useEffect, useMemo, useState } from 'react';

import { t } from '../i18n';
import {
  ipc,
  type CredentialSummary,
  type MerakiNetwork,
  type MerakiOrganization,
  type MerakiProfile,
  type MerakiReport,
} from '../lib/ipc';
import { MerakiReportView } from './MerakiReport';

/**
 * Meraki, on the Tools › Settings screen (LT-404).
 *
 * "make sure it goes to the settings at the top menu with options to select
 * the customers and networks" — so the customer list and the network list are
 * both **picked from what the key returns**, never typed. A Meraki network id
 * is an `L_` followed by eighteen digits; asking anyone to type one is asking
 * for a support conversation.
 *
 * **The key never reaches this component.** It is a vault credential, and
 * every call below passes its *id*. The page cannot read a Meraki key any
 * more than it can read an SSH password, which is the same rule and the same
 * mechanism (D-006).
 */
export function MerakiSettings({ credentials }: { credentials: CredentialSummary[] }) {
  const keys = useMemo(() => credentials.filter((c) => c.kind === 'meraki'), [credentials]);
  const [credentialId, setCredentialId] = useState('');
  const [organizations, setOrganizations] = useState<MerakiOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [networks, setNetworks] = useState<MerakiNetwork[]>([]);
  const [networkId, setNetworkId] = useState('');
  const [profiles, setProfiles] = useState<MerakiProfile[]>([]);
  const [profileId, setProfileId] = useState('smb');
  const [busy, setBusy] = useState<'' | 'organizations' | 'networks' | 'backup' | 'health'>('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [report, setReport] = useState<MerakiReport | null>(null);

  // One saved key is the common case, so it is chosen rather than making
  // somebody pick from a list of one.
  useEffect(() => {
    if (!credentialId && keys.length > 0) setCredentialId(keys[0]!.id);
  }, [keys, credentialId]);

  useEffect(() => {
    void ipc.merakiProfiles().then(setProfiles).catch(() => setProfiles([]));
  }, []);

  const connect = useCallback(async () => {
    if (!credentialId) return;
    setBusy('organizations');
    setError('');
    setNote('');
    setReport(null);
    try {
      const found = await ipc.merakiOrganizations(credentialId);
      setOrganizations(found);
      setNetworks([]);
      setOrganizationId('');
      setNetworkId('');
      if (found.length === 1) setOrganizationId(found[0]!.id);
    } catch (e) {
      setOrganizations([]);
      setError(String(e));
    } finally {
      setBusy('');
    }
  }, [credentialId]);

  // Choosing a customer loads its networks; nothing else needs a button.
  useEffect(() => {
    if (!credentialId || !organizationId) return;
    let cancelled = false;
    setBusy('networks');
    setError('');
    ipc
      .merakiNetworks(credentialId, organizationId)
      .then((found) => {
        if (cancelled) return;
        setNetworks(found);
        setNetworkId(found.length === 1 ? found[0]!.id : '');
      })
      .catch((e) => {
        if (!cancelled) {
          setNetworks([]);
          setError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setBusy('');
      });
    return () => {
      cancelled = true;
    };
  }, [credentialId, organizationId]);

  const runBackup = useCallback(async () => {
    if (!credentialId || !organizationId) return;
    // A whole customer, or the one network chosen. Backing up everything is
    // the normal thing to want and the slow thing to do by hand.
    const chosen = networkId ? [networkId] : networks.map((n) => n.id);
    if (chosen.length === 0) return;
    setBusy('backup');
    setError('');
    setNote('');
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const written = await ipc.merakiBackup(credentialId, organizationId, chosen, stamp);
      const done = t('meraki.backupDone', {
        networks: t('meraki.networks', { count: written.networks }),
        path: written.path,
      });
      setNote(
        written.read === written.asked
          ? done
          : `${done} — ${t('meraki.backupPartial', { read: written.read, asked: written.asked })}`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy('');
    }
  }, [credentialId, organizationId, networkId, networks]);

  const runHealth = useCallback(async () => {
    if (!credentialId || !organizationId || !networkId) return;
    setBusy('health');
    setError('');
    setNote('');
    setReport(null);
    try {
      setReport(await ipc.merakiHealthCheck(credentialId, organizationId, networkId, profileId));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy('');
    }
  }, [credentialId, organizationId, networkId, profileId]);

  const profile = profiles.find((p) => p.id === profileId);

  return (
    <section className="cv-meraki">
      <h2>{t('meraki.title')}</h2>
      <p className="cv-help">{t('meraki.hint')}</p>

      {keys.length === 0 ? (
        <p className="cv-notice">{t('meraki.noKey')}</p>
      ) : (
        <>
          <div className="cv-meraki-row">
            <label>
              {t('meraki.key')}
              <select
                value={credentialId}
                onChange={(e) => setCredentialId(e.target.value)}
                disabled={busy !== ''}
              >
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={() => void connect()} disabled={!credentialId || busy !== ''}>
              {busy === 'organizations' ? t('meraki.loading') : t('meraki.load')}
            </button>
          </div>
          <p className="cv-help">{t('meraki.keyHint')}</p>

          {organizations.length > 0 && (
            <div className="cv-meraki-row">
              <label>
                {t('meraki.customer')}
                <select
                  value={organizationId}
                  onChange={(e) => setOrganizationId(e.target.value)}
                  disabled={busy !== ''}
                >
                  <option value="">{t('meraki.chooseCustomer')}</option>
                  {organizations.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('meraki.network')}
                <select
                  value={networkId}
                  onChange={(e) => setNetworkId(e.target.value)}
                  disabled={busy !== '' || networks.length === 0}
                >
                  <option value="">{t('meraki.chooseNetwork')}</option>
                  {networks.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
                </select>
              </label>
              <span className="cv-meraki-count">
                {busy === 'networks'
                  ? t('meraki.loading')
                  : networks.length > 0
                    ? t('meraki.networks', { count: networks.length })
                    : organizationId
                      ? t('meraki.noNetworks')
                      : t('meraki.customers', { count: organizations.length })}
              </span>
            </div>
          )}

          {organizationId && (
            <>
              <div className="cv-meraki-row">
                <button
                  type="button"
                  onClick={() => void runBackup()}
                  disabled={busy !== '' || networks.length === 0}
                >
                  {busy === 'backup' ? t('meraki.backupRunning') : t('meraki.backup')}
                </button>
                <span className="cv-help">{t('meraki.backupHint')}</span>
              </div>

              <div className="cv-meraki-row">
                <label>
                  {t('meraki.profile')}
                  <select value={profileId} onChange={(e) => setProfileId(e.target.value)} disabled={busy !== ''}>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" onClick={() => void runHealth()} disabled={busy !== '' || !networkId}>
                  {busy === 'health' ? t('meraki.healthRunning') : t('meraki.health')}
                </button>
              </div>
              {profile && <p className="cv-help">{profile.summary}</p>}
              <p className="cv-help">{t('meraki.healthHint')}</p>
            </>
          )}
        </>
      )}

      {error && <p className="cv-error" role="alert">{error}</p>}
      {note && <p className="cv-saved-note">{note}</p>}
      {report && <MerakiReportView report={report} />}
      <p className="cv-help">{t('meraki.unverified')}</p>
    </section>
  );
}
