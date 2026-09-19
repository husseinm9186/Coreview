import { useCallback, useEffect, useState } from 'react';

import { ipc, isDesktop, type CredentialSummary } from '../lib/ipc';
import { useStore } from '../state/store';

/**
 * Choose a saved credential, or type one for this run.
 *
 * Typed is the default and always available: the vault is a convenience, and a
 * discovery run should never be blocked because someone has not set one up.
 *
 * When a saved credential is chosen the typed fields disappear rather than
 * being ignored — a form that shows a password box which does nothing is how
 * people end up certain they typed the right thing.
 *
 * LT-286: typed also used to mean *typed again, every time*. A fresh install
 * has no vault, so there was nothing to choose and no way to keep what had
 * just been typed without leaving the run and building a vault by hand in
 * Settings. "Keep for this project" does that here, at the moment the password
 * is in front of someone: it makes the vault if there is none, puts the
 * credential in it, and writes the id — never the secret (D-006) — on the
 * project, so the next scan or backup starts with it already chosen.
 */
export function CredentialPicker({
  kind,
  disabled,
  chosen,
  onChoose,
  typed,
  remember = false,
  children,
}: {
  kind: 'ssh' | 'snmp';
  disabled: boolean;
  chosen: string | null;
  onChoose: (id: string | null) => void;
  /** What is in the typed fields, so it can be kept (LT-286). */
  typed?: { username: string; secret: string; secondSecret?: string };
  /** Offer to keep it on the project, and reach for what was kept. */
  remember?: boolean;
  /** The typed fields, shown only when nothing is chosen. */
  children: React.ReactNode;
}) {
  const [saved, setSaved] = useState<CredentialSummary[]>([]);
  const [unlocked, setUnlocked] = useState(false);
  const [exists, setExists] = useState(false);
  const [minimum, setMinimum] = useState(12);
  // The keeping half: closed until asked for, because most runs are one-off.
  const [keeping, setKeeping] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [keepKey, setKeepKey] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  // LT-293: changing or getting rid of a kept credential, without leaving the
  // run to go to Settings.
  const [replacing, setReplacing] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);

  const projectName = useStore((s) => s.meta?.name ?? '');
  const defaults = useStore((s) => s.doc.credentialDefaults);
  const wanted = remember && kind === 'ssh' ? defaults?.ssh : undefined;

  const refresh = useCallback(
    () =>
      Promise.all([
        ipc.vaultStatus().then((v) => {
          setUnlocked(v.unlocked);
          setExists(v.exists);
          setMinimum(v.minimumPassphrase);
        }),
        ipc
          .listCredentials()
          .then((all) => setSaved(all.filter((c) => c.kind === kind)))
          .catch(() => setSaved([])),
      ]).then(() => undefined),
    [kind],
  );

  const vaultRevision = useStore((s) => s.vaultRevision);
  useEffect(() => {
    void refresh();
  }, [refresh, vaultRevision]);

  // What this project used last time, once the vault is open and the
  // credential is still in it. Only when nothing has been chosen by hand.
  useEffect(() => {
    if (!wanted || chosen || !unlocked) return;
    if (saved.some((c) => c.id === wanted)) onChoose(wanted);
    // onChoose is a setState from the panel above and stable enough to leave
    // out; including it re-runs this on every keystroke in the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, chosen, unlocked, saved]);

  const chosenLabel = saved.find((c) => c.id === chosen)?.label;
  const usable = unlocked && saved.length > 0;
  // A credential this project remembers can be chosen before the vault has
  // finished opening — it opens by itself, and that is a round trip (LT-292).
  // Rendering nothing at all in that moment hides both the chooser and the
  // typed fields, which reads as a form that has lost its login box.
  const chosenUnresolved = Boolean(chosen) && !saved.some((c) => c.id === chosen);
  const fillable = Boolean(typed?.username.trim() && typed?.secret);

  /** Ask the vault how it is *now*, then either keep straight away or put the
   *  passphrase form up. Reading it fresh matters: another chooser on the same
   *  form may have made the vault a moment ago, and this one's copy of
   *  `exists` would still say there is none (LT-292). */
  const openThenKeep = async () => {
    const v = await ipc.vaultStatus().catch(() => null);
    if (v) {
      setExists(v.exists);
      setUnlocked(v.unlocked);
      setMinimum(v.minimumPassphrase);
    }
    if (v?.exists && v.unlocked) keep();
    else setKeeping(true);
  };

  /** Make the vault if there is none, open it if it is shut, then keep it. */
  const keep = () => {
    if (!typed) return;
    setProblem(null);
    const open = !exists
      ? passphrase !== again
        ? Promise.reject(new Error('The two passphrases do not match.'))
        : ipc.createVault(passphrase).then(() => (keepKey ? ipc.rememberVaultKey() : undefined))
      : !unlocked
        ? ipc.unlockVault(passphrase).then(() => (keepKey ? ipc.rememberVaultKey() : undefined))
        : Promise.resolve(undefined);
    void open
      .then(() =>
        ipc.saveCredential({
          // LT-293: replacing keeps the same record, so every project pointing
          // at it follows and this project's reference does not move.
          ...(replacing && chosen ? { id: chosen } : {}),
          label: replacing && chosenLabel ? chosenLabel : `${projectName || 'This project'} — ${typed.username.trim()}`,
          kind,
          username: typed.username.trim(),
          secret: typed.secret,
          secondSecret: typed.secondSecret || undefined,
        }),
      )
      .then(async (id) => {
        await refresh();
        useStore.getState().bumpVault();
        useStore.getState().rememberCredential(kind, id);
        onChoose(id);
        setKeeping(false);
        setPassphrase('');
        setAgain('');
        if (replacing) {
          setReplacing(false);
          setKept('Replaced. The password behind it is the new one from now on.');
          return;
        }
        setKept(
          exists
            ? 'Kept. This project will reach for it next time.'
            : keepKey
              ? 'Kept, and the vault will open by itself on this computer.'
              : 'Kept. The vault asks for its passphrase once each time Coreview starts.',
        );
      })
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };

  return (
    <>
      {(usable || chosenUnresolved) && (
        <label className="cv-field cv-field-narrow">
          <span>Credentials</span>
          <select
            className="cv-input"
            value={chosen ?? ''}
            disabled={disabled}
            onChange={(e) => {
              const id = e.target.value || null;
              onChoose(id);
              // Choosing by hand is also a decision worth keeping (LT-286).
              if (remember) {
                if (id) useStore.getState().rememberCredential(kind, id);
                else useStore.getState().forgetCredential(kind);
              }
            }}
          >
            <option value="">Type them below</option>
            {chosenUnresolved && (
              <option value={chosen!}>
                {unlocked ? 'A credential no longer saved' : 'Kept for this project — unlocking the vault…'}
              </option>
            )}
            {saved.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {/* Hidden rather than ignored when a saved credential is in use — except
          while replacing it, where typing the new login into them is the whole
          point (LT-293). */}
      {(!chosen || replacing) && children}
      {remember && isDesktop && (
        <div className="cv-keep-cred">
          {chosen && !replacing ? (
            <div className="cv-keep-cred-held">
              {confirmWipe ? (
                <>
                  <span className="cv-help">
                    Delete “{chosenLabel ?? 'this credential'}” from the vault? The password goes
                    with it, for every project that uses it. This cannot be undone.
                  </span>
                  <button type="button" className="cv-btn cv-btn-small cv-btn-danger" disabled={disabled}
                    onClick={() => {
                      setProblem(null);
                      void ipc
                        .deleteCredential(chosen)
                        .then(() => refresh())
                        .then(() => {
                          useStore.getState().bumpVault();
                          useStore.getState().forgetCredential(kind, chosen);
                          onChoose(null);
                          setConfirmWipe(false);
                          setKept('Deleted from the vault.');
                        })
                        .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
                    }}>
                    Delete it
                  </button>
                  <button type="button" className="cv-btn cv-btn-small" onClick={() => setConfirmWipe(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="cv-btn cv-btn-small" disabled={disabled}
                    title="Type a new username and password over this saved credential. Every project using it follows."
                    onClick={() => { setReplacing(true); setKept(null); setProblem(null); }}>
                    Replace it
                  </button>
                  <button type="button" className="cv-btn cv-btn-small" disabled={disabled}
                    title="This project stops using it. The credential stays in the vault."
                    onClick={() => {
                      useStore.getState().forgetCredential(kind, chosen);
                      onChoose(null);
                      setKept('This project no longer uses it. It is still in the vault.');
                    }}>
                    Forget for this project
                  </button>
                  <button type="button" className="cv-btn cv-btn-small" disabled={disabled}
                    onClick={() => { setConfirmWipe(true); setKept(null); setProblem(null); }}>
                    Delete from the vault
                  </button>
                </>
              )}
            </div>
          ) : replacing ? (
            <div className="cv-keep-cred-form">
              <p className="cv-help">
                Type the new username and password above, then save. The same saved credential is
                overwritten, so anything else using it gets the new password too.
              </p>
              <button type="button" className="cv-btn cv-btn-start" disabled={disabled || !fillable}
                title={fillable ? undefined : 'Fill the username and password in first'}
                onClick={() => void openThenKeep()}>
                Save over it
              </button>
              <button type="button" className="cv-btn cv-btn-small"
                onClick={() => { setReplacing(false); setProblem(null); }}>
                Cancel
              </button>
            </div>
          ) : !keeping ? (
            <button type="button" className="cv-btn cv-btn-small" disabled={disabled || !fillable}
              title={fillable ? undefined : 'Fill the username and password in first'}
              onClick={() => void openThenKeep()}>
              Keep for this project
            </button>
          ) : (
            <div className="cv-keep-cred-form">
              <p className="cv-help">
                {exists
                  ? 'The vault is locked. Its passphrase opens it; the credential goes in there, and this project remembers which one it is.'
                  : `Kept credentials live in an encrypted vault. Choose a passphrase for it — at least ${minimum} characters. It is never stored, and there is no recovery, because a recovery path is a second way in.`}
              </p>
              <label className="cv-field cv-field-narrow">
                <span>Vault passphrase</span>
                <input className="cv-input" type="password" value={passphrase}
                  autoComplete={exists ? 'current-password' : 'new-password'}
                  onChange={(e) => setPassphrase(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (exists || passphrase.length >= minimum)) keep(); }} />
              </label>
              {!exists && (
                <label className="cv-field cv-field-narrow">
                  <span>Again</span>
                  <input className="cv-input" type="password" value={again} autoComplete="new-password"
                    onChange={(e) => setAgain(e.target.value)} />
                </label>
              )}
              {/* LT-262, and the point of the exercise: without this the
                  passphrase is typed once per session instead of once ever. */}
              <label className="cv-check cv-check-inline" title="The key that opens the vault — never the passphrase — is kept by Windows Credential Manager, the macOS Keychain or the Secret Service. Anyone who can use this computer's account can then use the saved credentials.">
                <input type="checkbox" checked={keepKey} onChange={(e) => setKeepKey(e.target.checked)} />
                Open the vault by itself on this computer
              </label>
              <button type="button" className="cv-btn cv-btn-start" onClick={keep}
                disabled={exists ? !passphrase : passphrase.length < minimum}>
                {exists ? 'Unlock and keep' : 'Create vault and keep'}
              </button>
              <button type="button" className="cv-btn cv-btn-small" onClick={() => { setKeeping(false); setProblem(null); }}>
                Cancel
              </button>
            </div>
          )}
          {problem && <p className="cv-problem">{problem}</p>}
          {!problem && kept && <p className="cv-help">{kept}</p>}
        </div>
      )}
    </>
  );
}

/**
 * The vault's saved credentials of one kind (or every kind), as a plain select
 * of ids (LT-199, LT-209). Says why it is empty when the vault is locked or has
 * nothing saved, rather than showing an empty list.
 */
export function SavedCredentialSelect({
  kind,
  value,
  onChange,
  label,
  disabled = false,
}: {
  kind?: 'ssh' | 'snmp';
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  label: string;
  disabled?: boolean;
}) {
  const [saved, setSaved] = useState<CredentialSummary[] | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  useEffect(() => {
    void ipc.vaultStatus().then((s) => setUnlocked(s.unlocked)).catch(() => setUnlocked(false));
    void ipc
      .listCredentials()
      .then((all) => setSaved(kind ? all.filter((c) => c.kind === kind) : all))
      .catch(() => setSaved([]));
  }, [kind]);
  const missing = value && saved && !saved.some((c) => c.id === value);
  return (
    <select
      className="cv-input"
      aria-label={label}
      value={value ?? ''}
      disabled={disabled || !unlocked}
      title={!unlocked ? 'Unlock the credential vault to choose one' : undefined}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      <option value="">{!unlocked ? 'Vault locked' : saved?.length ? 'None' : 'Nothing saved yet'}</option>
      {missing && <option value={value}>A credential no longer saved</option>}
      {(saved ?? []).map((c) => (
        <option key={c.id} value={c.id}>
          {c.label}{kind ? '' : ` (${c.kind.toUpperCase()})`}
        </option>
      ))}
    </select>
  );
}
