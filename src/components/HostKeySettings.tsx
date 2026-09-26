import { useEffect, useState } from 'react';

import { ipc, isDesktop, type HostKeyRow } from '../lib/ipc';
import { t } from '../i18n';

/**
 * The SSH host keys Coreview has remembered, and the ways to forget them.
 *
 * Coreview records a device's key the first time it connects and refuses to
 * connect again if it changes. That is the right default — a changed key is
 * either a rebuilt device or someone in the middle, and those look identical
 * from here — but it needs a way out, because switches genuinely do get
 * replaced. Forgetting is deliberate and visible rather than a warning
 * somebody clicks through.
 */
export function HostKeySettings() {
  const [keys, setKeys] = useState<HostKeyRow[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => {
    void ipc
      .listHostKeys()
      .then(setKeys)
      .catch(() => setKeys([]));
  };

  useEffect(refresh, []);

  const clearAll = () => {
    void ipc.clearHostKeys().then((n) => {
      setConfirming(false);
      setMessage(
        n === 0
          ? 'There were none to forget.'
          : `Forgot ${n} host key${n === 1 ? '' : 's'}. The next connection to each device is treated as first contact.`,
      );
      refresh();
    });
  };

  const forget = (host: string) => {
    // The list stores "address:port"; the command accepts either form.
    const [address, port] = host.split(':');
    void ipc.forgetHostKey(address ?? host, Number(port) || 22).then(() => {
      setMessage(`Forgot ${host}.`);
      refresh();
    });
  };

  if (!isDesktop) return null;

  return (
    <section className="cv-hostkeys">
      <h2>{t('hostKeySettings.sshHostKeys')}</h2>

      {keys.length === 0 ? (
        <p className="cv-help">
          {t('hostKeySettings.noneRememberedYetCoreview')}
        </p>
      ) : (
        <>
          <p className="cv-help">
            {t('hostKeySettings.recordedOnFirstContact')}
          </p>
          <table className="cv-table cv-hostkey-table">
            <thead>
              <tr>
                <th>{t('hostKeySettings.device')}</th>
                <th>{t('hostKeySettings.fingerprint')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.host}>
                  <td className="cv-mono">{k.host}</td>
                  <td className="cv-mono cv-fingerprint">{k.fingerprint}</td>
                  <td>
                    <button type="button" className="cv-btn cv-btn-small" onClick={() => forget(k.host)}>
                      Forget
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="cv-hostkey-actions">
        {confirming ? (
          <>
            <span className="cv-help">
              Forget all {keys.length} remembered key{keys.length === 1 ? '' : 's'}? Every device
              becomes first contact again, and a key that has changed will be accepted silently.
            </span>
            <button type="button" className="cv-btn cv-btn-small" onClick={() => setConfirming(false)}>
              {t('hostKeySettings.keepThem')}
            </button>
            <button type="button" className="cv-btn cv-btn-small cv-btn-danger" onClick={clearAll}>
              {t('hostKeySettings.forgetAll')}
            </button>
          </>
        ) : (
          <button type="button" className="cv-btn cv-btn-small" disabled={keys.length === 0}
            onClick={() => { setMessage(null); setConfirming(true); }}>
            {t('hostKeySettings.clearSavedHostKeys')}
          </button>
        )}
      </div>

      {message && <p className="cv-help cv-hostkey-message">{message}</p>}
    </section>
  );
}
