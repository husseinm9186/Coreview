import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { credentialsUsedBy } from '../lib/credentialScope';
import { ipc, isDesktop, type CredentialSummary } from '../lib/ipc';
import { useStore } from '../state/store';
import { VaultPassphraseForm } from './VaultGate';
import { t } from '../i18n';

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
 * Settings. **Save** does that here, at the moment the password is in
 * front of someone: it makes the vault if there is none, puts the credential
 * in it, and writes the id — never the secret (D-006) — on the project, so the
 * next scan or backup starts with it already chosen.
 *
 * LT-326: the buttons are named the way the operator asked for them — **Save**,
 * **Replace**, **Wipe** — with **Forget for this project** kept beside Wipe
 * because they are not the same thing and the difference matters. Forgetting
 * stops *this project* using a credential; wiping takes it out of the vault
 * for every project on the machine, and cannot be undone.
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
  const [problem, setProblem] = useState<string | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  // LT-293: changing or getting rid of a kept credential, without leaving the
  // run to go to Settings.
  const [replacing, setReplacing] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);

  const projectName = useStore((s) => s.meta?.name ?? '');
  const defaults = useStore((s) => s.doc.credentialDefaults);
  // LT-412: this project's, not the machine's.
  //
  // D-038 settled what this should be — "opening a second project and finding
  // the first one's login in the form is wrong, and on a tool an engineer
  // points at several customers' networks it is worse than wrong" — and
  // LT-335 wrote the rule down in `credentialScope`. It was applied to the
  // Settings screen and not to the two pickers, which are where a login is
  // actually chosen for a run against a customer's estate.
  //
  // The vault is still one store per machine (D-034). What changes is the
  // view: the rest of it is one disclosure away and says what it is.
  // LT-452: only what the scope reads — the pages, the defaults, the rules.
  const pages = useStore((s) => s.doc.pages);
  const credentialRules = useStore((s) => s.doc.credentialRules);
  const mine = useMemo(() => credentialsUsedBy({ pages, credentialDefaults: defaults, credentialRules }), [pages, defaults, credentialRules]);
  const [showEverything, setShowEverything] = useState(false);
  // Anything chosen while this form has been open stays on offer, even after
  // the project stops referring to it.
  //
  // **Forget for this project** says in its own tooltip that the credential
  // stays in the vault. Scoping the list by what the project refers to made
  // that a lie: forgetting removed the reference, so the credential left the
  // list and could not be chosen again without going hunting. Something you
  // touched a moment ago is not another project's business leaking in — it is
  // the one you were just using.
  const touched = useRef<Set<string>>(new Set());
  if (chosen) touched.current.add(chosen);
  // LT-330: SNMP too. A project keeps a list of SNMP credentials because a
  // scan tries each in turn; the first is the one everything falls back to.
  const wanted = remember ? (kind === 'ssh' ? defaults?.ssh : defaults?.snmp?.[0]) : undefined;

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

  /**
   * The project's saved login, offered rather than applied (LT-330).
   *
   * It used to be chosen for you as soon as the vault opened. The operator
   * asked for the opposite and gave the reason in the asking: "global should be
   * first but unchecked by default in the discover devices section". A crawl
   * logs into a whole estate, and it must not start doing that because a
   * credential was once saved for something else — so this is a tick, and it
   * is first in the order once it is ticked.
   *
   * A device on the diagram is the other way round and inherits silently
   * (`planSsh`): one device is not an estate, and nothing is sent until the
   * session is asked for.
   */
  // What this project refers to, plus whatever is chosen right now so a
  // deliberate choice never vanishes from under the person who made it.
  const offered = useMemo(
    () =>
      showEverything
        ? saved
        : saved.filter((c) => mine.has(c.id) || c.id === chosen || touched.current.has(c.id)),
    [saved, mine, chosen, showEverything],
  );
  const elsewhere = saved.length - offered.length;

  const projectLogin = remember ? saved.find((c) => c.id === wanted) : undefined;
  const usingProject = Boolean(wanted) && chosen === wanted;

  const chosenLabel = saved.find((c) => c.id === chosen)?.label;
  const usable = unlocked && (offered.length > 0 || saved.length > 0);
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

  /** Put it in the vault. The vault is already open by the time this runs —
   *  `VaultPassphraseForm` is what makes or unlocks it (LT-318). */
  const keep = () => {
    if (!typed) return;
    setProblem(null);
    void Promise.resolve()
      .then(() =>
        ipc.saveCredential({
          // LT-293: replacing keeps the same record, so every project pointing
          // at it follows and this project's reference does not move.
          ...(replacing && chosen ? { id: chosen } : {}),
          // LT-412: a label must not claim a relationship it cannot keep.
          // This was `${projectName || 'This project'} — ${username}`, and the
          // fallback froze the literal words *This project* into the vault —
          // so a credential made in one project was then offered in every
          // other under a label saying it belonged to the one you were
          // looking at. A project with a name may still say so; a project
          // without one says only who the login is for.
          label: replacing && chosenLabel
            ? chosenLabel
            : projectName.trim()
              ? `${projectName.trim()} — ${typed.username.trim()}`
              : typed.username.trim(),
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
        if (replacing) {
          setReplacing(false);
          setKept('Replaced. The password behind it is the new one from now on.');
          return;
        }
        setKept('Kept. This project will reach for it next time.');
      })
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };

  return (
    <>
      {projectLogin && (
        <label className="cv-check cv-check-inline cv-cred-project"
          title={t('credentialPicker.triedBeforeAnythingTyped')}>
          <input type="checkbox" checked={usingProject} disabled={disabled}
            onChange={(e) => {
              onChoose(e.target.checked ? wanted! : null);
              setKept(null);
            }} />
          Use this project&rsquo;s saved {kind === 'ssh' ? 'login' : 'SNMP credential'} first — {projectLogin.label}
        </label>
      )}
      {(usable || chosenUnresolved) && (
        <label className="cv-field cv-field-narrow">
          <span>{t('credentialPicker.credentials')}</span>
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
            <option value="">{t('credentialPicker.typeThemBelow')}</option>
            {chosenUnresolved && (
              <option value={chosen!}>
                {unlocked ? 'A credential no longer saved' : 'Kept for this project — unlocking the vault…'}
              </option>
            )}
            {offered.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {(usable || chosenUnresolved) && elsewhere > 0 && !showEverything && (
        <button
          type="button"
          className="cv-btn cv-btn-small cv-cred-elsewhere"
          disabled={disabled}
          title={t('credentialPicker.theVaultIsShared')}
          onClick={() => setShowEverything(true)}
        >
          Show {elsewhere} saved elsewhere on this computer
        </button>
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
                    Wipe “{chosenLabel ?? 'this credential'}” from the vault? The username and
                    password go with it, for every project that uses them. This cannot be undone.
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
                          setKept('Wiped from the vault.');
                        })
                        .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
                    }}>
                    {t('credentialPicker.wipeIt')}
                  </button>
                  <button type="button" className="cv-btn cv-btn-small" onClick={() => setConfirmWipe(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="cv-btn cv-btn-small" disabled={disabled}
                    title={t('credentialPicker.typeANewUsername')}
                    onClick={() => { setReplacing(true); setKept(null); setProblem(null); }}>
                    Replace
                  </button>
                  <button type="button" className="cv-btn cv-btn-small" disabled={disabled}
                    title={t('credentialPicker.thisProjectStopsUsing')}
                    onClick={() => {
                      useStore.getState().forgetCredential(kind, chosen);
                      onChoose(null);
                      setKept('This project no longer uses it. It is still in the vault.');
                    }}>
                    {t('credentialPicker.forgetForThisProject')}
                  </button>
                  <button type="button" className="cv-btn cv-btn-small cv-btn-danger" disabled={disabled}
                    title={t('credentialPicker.takeTheUsernameAnd')}
                    onClick={() => { setConfirmWipe(true); setKept(null); setProblem(null); }}>
                    Wipe
                  </button>
                </>
              )}
            </div>
          ) : replacing ? (
            <div className="cv-keep-cred-form">
              <p className="cv-help">
                {t('credentialPicker.typeTheNewUsername')}
              </p>
              <button type="button" className="cv-btn cv-btn-start" disabled={disabled || !fillable}
                title={fillable ? undefined : 'Fill the username and password in first'}
                onClick={() => void openThenKeep()}>
                {t('credentialPicker.saveOverIt')}
              </button>
              <button type="button" className="cv-btn cv-btn-small"
                onClick={() => { setReplacing(false); setProblem(null); }}>
                Cancel
              </button>
            </div>
          ) : !keeping ? (
            <button type="button" className="cv-btn cv-btn-small cv-btn-start" disabled={disabled || !fillable}
              title={fillable
                ? 'Put this username and password in the encrypted vault, and remember that this project uses them.'
                : 'Fill the username and password in first'}
              onClick={() => void openThenKeep()}>
              Save
            </button>
          ) : (
            <VaultPassphraseForm
              vault={{ exists, unlocked, minimum }}
              verb="keep"
              onProblem={setProblem}
              onCancel={() => setKeeping(false)}
              onOpened={keep}
            />
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
  kind?: 'ssh' | 'snmp' | 'api';
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
      {missing && <option value={value}>{t('credentialPicker.aCredentialNoLonger')}</option>}
      {(saved ?? []).map((c) => (
        <option key={c.id} value={c.id}>
          {c.label}{kind ? '' : ` (${c.kind.toUpperCase()})`}
        </option>
      ))}
    </select>
  );
}
