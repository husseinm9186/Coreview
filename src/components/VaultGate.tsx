import { useCallback, useEffect, useState } from 'react';

import { ipc } from '../lib/ipc';
import { useStore } from '../state/store';

/**
 * The step in front of every "save this password": is there a vault, and is it
 * open? (LT-318.)
 *
 * This was written once inside `CredentialPicker` and then needed a second
 * time by the per-device override. Two copies of *create the vault, or unlock
 * it, and offer to hand the key to the operating system* is two chances to get
 * the security-shaped half of it wrong, so there is one copy and both use it.
 */
export interface VaultState {
  /** A vault file exists on this machine. */
  exists: boolean;
  /** It is open, so credentials can be read and written. */
  unlocked: boolean;
  /** The shortest passphrase the backend will accept for a new vault. */
  minimum: number;
}

/** The vault's state, refreshed whenever anything in it changes.
 *
 *  `refresh` resolves with what it read rather than only setting state: a
 *  caller that has just asked "is the vault open?" needs the answer now, and
 *  the rendered copy is a render behind. Another chooser on the same form may
 *  have made the vault a moment ago (LT-292). */
export function useVaultState(): { vault: VaultState; refresh: () => Promise<VaultState> } {
  const [vault, setVault] = useState<VaultState>({ exists: false, unlocked: false, minimum: 12 });
  const refresh = useCallback(
    () =>
      ipc
        .vaultStatus()
        .then((v) => {
          const next = { exists: v.exists, unlocked: v.unlocked, minimum: v.minimumPassphrase };
          setVault(next);
          return next;
        })
        .catch(() => ({ exists: false, unlocked: false, minimum: 12 })),
    [],
  );
  const vaultRevision = useStore((s) => s.vaultRevision);
  useEffect(() => {
    void refresh();
  }, [refresh, vaultRevision]);
  return { vault, refresh };
}

/**
 * Make the vault if there is none, unlock it if it is shut — then hand back.
 *
 * `onOpened` runs with the vault open, which is when the thing that put this
 * form up can finally do what it was asked to do.
 */
export function VaultPassphraseForm({
  vault,
  onOpened,
  onCancel,
  onProblem,
  disabled = false,
  verb = 'save',
}: {
  vault: VaultState;
  onOpened: () => void;
  onCancel: () => void;
  onProblem: (message: string | null) => void;
  disabled?: boolean;
  /** What the button says it will do once the vault is open — "save" here,
   *  "keep" where the surrounding form has always called it keeping. */
  verb?: string;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [keepKey, setKeepKey] = useState(true);
  const { exists, unlocked, minimum } = vault;
  const ready = exists ? passphrase.length > 0 : passphrase.length >= minimum;

  const open = () => {
    onProblem(null);
    const step = unlocked
      ? Promise.resolve(undefined)
      : exists
        ? ipc.unlockVault(passphrase).then(() => (keepKey ? ipc.rememberVaultKey() : undefined))
        : passphrase !== again
          ? Promise.reject(new Error('The two passphrases do not match.'))
          : ipc.createVault(passphrase).then(() => (keepKey ? ipc.rememberVaultKey() : undefined));
    void step
      .then(() => {
        setPassphrase('');
        setAgain('');
        onOpened();
      })
      .catch((e: unknown) => onProblem(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="cv-keep-cred-form">
      <p className="cv-help">
        {exists
          ? 'The vault is locked. Its passphrase opens it; the credential goes in there, and only its id is written on the project.'
          : `Saved credentials live in an encrypted vault. Choose a passphrase for it — at least ${minimum} characters. It is never stored, and there is no recovery, because a recovery path is a second way in.`}
      </p>
      <label className="cv-field cv-field-narrow">
        <span>Vault passphrase</span>
        <input className="cv-input" type="password" value={passphrase} disabled={disabled}
          autoComplete={exists ? 'current-password' : 'new-password'}
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && ready) open(); }} />
      </label>
      {!exists && (
        <label className="cv-field cv-field-narrow">
          <span>Again</span>
          <input className="cv-input" type="password" value={again} autoComplete="new-password" disabled={disabled}
            onChange={(e) => setAgain(e.target.value)} />
        </label>
      )}
      {/* LT-262, and the point of the exercise: without this the passphrase is
          typed once per session instead of once ever. */}
      <label className="cv-check cv-check-inline"
        title="The key that opens the vault — never the passphrase — is kept by Windows Credential Manager, the macOS Keychain or the Secret Service. Anyone who can use this computer's account can then use the saved credentials.">
        <input type="checkbox" checked={keepKey} disabled={disabled} onChange={(e) => setKeepKey(e.target.checked)} />
        Open the vault by itself on this computer
      </label>
      <button type="button" className="cv-btn cv-btn-start" onClick={open} disabled={disabled || !ready}>
        {exists ? `Unlock and ${verb}` : `Create vault and ${verb}`}
      </button>
      <button type="button" className="cv-btn cv-btn-small" onClick={() => { onProblem(null); onCancel(); }}>
        Cancel
      </button>
    </div>
  );
}
