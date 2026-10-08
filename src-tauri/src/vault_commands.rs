//! IPC for the credential vault.
//!
//! **Exactly one command returns a secret**, and it is `reveal_credential`.
//! Everything else takes credentials in and hands back references.
//!
//! That one exception is deliberate and was asked for: an administrator has to
//! be able to check what is stored, and a vault you cannot read from is a
//! vault people work around by keeping a spreadsheet. The cost is real and
//! worth stating — once a secret can cross to the interface, "not visible from
//! the GUI" is a rendering promise rather than an architectural one, and a
//! rendering promise does not survive a devtools window.
//!
//! What survives is the narrower guarantee, and a test enforces it: no *other*
//! command may return a secret. Listing, saving, status and deletion cannot
//! leak one by accident; revealing is a single, named, deliberate act that
//! requires the vault to be unlocked first.
//!
//! The unlocked key lives in memory for the length of the app session and is
//! zeroed when it is dropped. It is never written anywhere.

use coreview_discover::snmp::{AuthKind, PrivKind, SnmpAuth};
use coreview_discover::ssh::{Credentials, Secret};
use coreview_discover::vault::{self, SealedSecret, VaultHeader, VaultKey};
use serde::Deserialize;
use tauri::State;

use crate::commands::AppState;
use crate::db;

type CmdResult<T> = Result<T, String>;

pub fn db_err(e: impl std::fmt::Display) -> String {
    format!("Local database error: {e}")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// What the interface is allowed to know about the vault.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub exists: bool,
    pub unlocked: bool,
    pub credentials: usize,
    pub minimum_passphrase: usize,
    /// Whether this machine keeps the vault key in its keychain.
    pub kept_in_keychain: bool,
}

/// The setting that says the key is kept in the keychain, so the
/// keychain is only asked when it holds something — on macOS asking can show
/// a prompt.
const KEYCHAIN_SETTING: &str = "vaultKeyInKeychain";

fn kept_in_keychain(conn: &rusqlite::Connection) -> CmdResult<bool> {
    Ok(db::all_settings(conn).map_err(db_err)?.get(KEYCHAIN_SETTING).is_some_and(|v| v == "1"))
}

/// Keeps the unlocked vault's key in the system keychain, so the vault
/// opens by itself on this machine from now on.
#[tauri::command(async)]
pub fn remember_vault_key(state: State<'_, AppState>) -> CmdResult<()> {
    let guard = state.vault_key.lock().map_err(db_err)?;
    let key = guard.as_ref().ok_or("Unlock the vault first; the key is kept only once it is open.")?;
    crate::keychain::remember(&crate::keychain::entry()?, key)?;
    let conn = state.db.lock().map_err(db_err)?;
    db::set_setting(&conn, KEYCHAIN_SETTING, Some("1")).map_err(db_err)
}

/// Removes the key from the keychain; the passphrase is needed again.
#[tauri::command(async)]
pub fn forget_vault_key(state: State<'_, AppState>) -> CmdResult<()> {
    crate::keychain::forget(&crate::keychain::entry()?)?;
    let conn = state.db.lock().map_err(db_err)?;
    db::set_setting(&conn, KEYCHAIN_SETTING, None).map_err(db_err)
}

/// Opens the vault with the kept key, when this machine keeps one.
/// `opened`, `off` (nothing kept here), or `stale` (what was kept no longer
/// opens this vault, and has been removed).
#[tauri::command(async)]
pub fn unlock_vault_from_keychain(state: State<'_, AppState>) -> CmdResult<String> {
    let header = {
        let conn = state.db.lock().map_err(db_err)?;
        if !kept_in_keychain(&conn)? {
            return Ok("off".into());
        }
        match db::vault_header(&conn).map_err(db_err)? {
            Some((salt, verifier)) => VaultHeader { salt, verifier },
            None => return Ok("off".into()),
        }
    };
    let outcome = crate::keychain::recall(&crate::keychain::entry()?, &header)?;
    let conn = state.db.lock().map_err(db_err)?;
    Ok(match outcome {
        crate::keychain::Recalled::Opened(key) => {
            *state.vault_key.lock().map_err(db_err)? = Some(key);
            "opened".into()
        }
        crate::keychain::Recalled::NothingKept | crate::keychain::Recalled::Stale => {
            db::set_setting(&conn, KEYCHAIN_SETTING, None).map_err(db_err)?;
            "stale".into()
        }
    })
}

/// A saved credential as the interface sees it: everything except the secrets.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSummary {
    pub id: String,
    pub label: String,
    /// "ssh" or "snmp".
    pub kind: String,
    pub username: String,
    /// Algorithm words for SNMPv3. Not secret, and needed to show what a
    /// credential is configured for.
    pub detail: String,
    /// Whether a second secret is stored — an enable password, or an SNMPv3
    /// privacy password. Whether one exists is not itself a secret, and the
    /// interface needs it to render honestly.
    pub has_second_secret: bool,
    /// The project that owns it, and its name, for the start screen.
    pub owner_project_id: Option<String>,
    pub owner_project_name: Option<String>,
}

#[tauri::command(async)]
pub fn vault_status(state: State<'_, AppState>) -> CmdResult<VaultStatus> {
    let conn = state.db.lock().map_err(db_err)?;
    let exists = db::vault_header(&conn).map_err(db_err)?.is_some();
    let credentials = db::list_credentials(&conn).map_err(db_err)?.len();
    let unlocked = state.vault_key.lock().map_err(db_err)?.is_some();
    Ok(VaultStatus {
        exists,
        unlocked,
        credentials,
        minimum_passphrase: vault::MIN_PASSPHRASE,
        kept_in_keychain: kept_in_keychain(&conn)?,
    })
}

/// Creates the vault and leaves it unlocked for this session.
#[tauri::command(async)]
pub fn create_vault(state: State<'_, AppState>, passphrase: String) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    if db::vault_header(&conn).map_err(db_err)?.is_some() {
        return Err("A vault already exists. Unlock it, or discard it and start again.".into());
    }
    let (header, key) = vault::create(&passphrase).map_err(|e| e.to_string())?;
    db::create_vault(&conn, &header.salt, &header.verifier, now_ms()).map_err(db_err)?;
    *state.vault_key.lock().map_err(db_err)? = Some(key);
    Ok(())
}

#[tauri::command(async)]
pub fn unlock_vault(state: State<'_, AppState>, passphrase: String) -> CmdResult<()> {
    let header = {
        let conn = state.db.lock().map_err(db_err)?;
        db::vault_header(&conn)
            .map_err(db_err)?
            .ok_or("There is no vault yet. Create one before unlocking it.")?
    };
    let key = vault::unlock(
        &passphrase,
        &VaultHeader {
            salt: header.0,
            verifier: header.1,
        },
    )
    .map_err(|e| e.to_string())?;
    *state.vault_key.lock().map_err(db_err)? = Some(key);
    Ok(())
}

/// Locks the vault, dropping the key.
#[tauri::command]
pub fn lock_vault(state: State<'_, AppState>) -> CmdResult<()> {
    // Dropping it zeroes it — VaultKey is ZeroizeOnDrop.
    *state.vault_key.lock().map_err(db_err)? = None;
    Ok(())
}

/// Discards the vault and everything in it.
///
/// The only way past a forgotten passphrase, and destructive by necessity:
/// without the key the stored rows are unreadable, so keeping them would be
/// keeping rubbish, and leaving them would make a new vault look like it had
/// contents. Returns how many credentials went, for the confirmation.
#[tauri::command(async)]
pub fn discard_vault(state: State<'_, AppState>) -> CmdResult<usize> {
    let conn = state.db.lock().map_err(db_err)?;
    let removed = db::destroy_vault(&conn).map_err(db_err)?;
    *state.vault_key.lock().map_err(db_err)? = None;
    // A key kept for the vault that is gone goes with it.
    if kept_in_keychain(&conn)? {
        if let Ok(entry) = crate::keychain::entry() {
            let _ = crate::keychain::forget(&entry);
        }
        db::set_setting(&conn, KEYCHAIN_SETTING, None).map_err(db_err)?;
    }
    Ok(removed)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveCredential {
    /// Absent for a new credential.
    pub id: Option<String>,
    pub label: String,
    /// "ssh" or "snmp".
    pub kind: String,
    pub username: String,
    pub secret: String,
    /// Enable password, or SNMPv3 privacy password.
    pub second_secret: Option<String>,
    /// SNMPv3 algorithm words, for example "sha|aes 256"; for an API login,
    /// its HTTPS port.
    pub detail: Option<String>,
}

#[tauri::command(async)]
pub fn save_credential(state: State<'_, AppState>, credential: SaveCredential) -> CmdResult<String> {
    let guard = state.vault_key.lock().map_err(db_err)?;
    let key = guard.as_ref().ok_or_else(|| vault::VaultError::Locked.to_string())?;

    let sealed = vault::seal(key, &credential.secret).map_err(|e| e.to_string())?;
    let extra = match credential.second_secret.filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => {
            let e = vault::seal(key, &s).map_err(|err| err.to_string())?;
            Some((e.nonce, e.ciphertext))
        }
    };

    let id = credential
        .id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let stored = db::StoredCredential {
        id: id.clone(),
        label: credential.label,
        kind: credential.kind,
        username: credential.username,
        secret: (sealed.nonce, sealed.ciphertext),
        extra,
        detail: credential.detail.unwrap_or_default(),
    };

    let conn = state.db.lock().map_err(db_err)?;
    // Replacing another project's login is refused like opening it.
    if db::credential_owner(&conn, &id).map_err(db_err)?.is_some() {
        db::may_use_credential(&conn, crate::commands::open_project(&state).as_deref(), &id)?;
    }
    let is_new = db::credential_owner(&conn, &id).map_err(db_err)?.is_none();
    db::save_credential(&conn, &stored, now_ms()).map_err(db_err)?;
    // A login saved inside a project is that project's.
    if is_new {
        db::set_credential_owner(&conn, &id, crate::commands::open_project(&state).as_deref()).map_err(db_err)?;
    }
    Ok(id)
}

/// Hands a credential to a project, or back to none. Only from the
/// start screen, where the whole vault is managed — inside a project this
/// would be a way to take another project's login.
#[tauri::command(async)]
pub fn assign_credential(state: State<'_, AppState>, id: String, project_id: Option<String>) -> CmdResult<()> {
    if crate::commands::open_project(&state).is_some() {
        return Err("Close the project first: logins are handed between projects from the start screen.".into());
    }
    let conn = state.db.lock().map_err(db_err)?;
    let changed = db::set_credential_owner(&conn, &id, project_id.as_deref().filter(|p| !p.is_empty())).map_err(db_err)?;
    if changed == 0 {
        return Err("That saved credential no longer exists.".into());
    }
    Ok(())
}

/// The saved credentials, without their secrets.
///
/// Works while locked, on purpose: knowing that a credential called "Core
/// switches" exists is not the same as knowing its password, and a list that
/// vanished when locked would make the vault unusable to reason about.
///
/// Inside a project, only the ones it owns or its diagram refers to;
/// on the start screen, every one, each with the project that owns it.
#[tauri::command(async)]
pub fn list_credentials(state: State<'_, AppState>) -> CmdResult<Vec<CredentialSummary>> {
    let open = crate::commands::open_project(&state);
    let conn = state.db.lock().map_err(db_err)?;
    let rows = db::list_credentials_for(&conn, open.as_deref()).map_err(db_err)?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        // Only to report whether one exists — the value is not read.
        let has_second_secret = db::credential(&conn, &row.id)
            .map_err(db_err)?
            .map(|c| c.extra.is_some())
            .unwrap_or(false);
        out.push(CredentialSummary {
            id: row.id,
            label: row.label,
            kind: row.kind,
            username: row.username,
            detail: row.detail,
            has_second_secret,
            owner_project_id: row.owner_id,
            owner_project_name: row.owner_name,
        });
    }
    Ok(out)
}

/// What a stored credential actually contains.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealedCredential {
    pub username: String,
    pub secret: String,
    pub second_secret: Option<String>,
}

/// Shows a stored credential in the clear.
///
/// The single command that returns a secret. It exists because an
/// administrator has to be able to verify what is saved — the alternative is
/// people keeping the real copy somewhere else.
///
/// Requires the vault to be unlocked, so revealing always costs the
/// passphrase at least once per session rather than being available to anyone
/// who reaches the running app.
#[tauri::command(async)]
pub fn reveal_credential(
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<RevealedCredential> {
    let guard = state.vault_key.lock().map_err(db_err)?;
    let key = guard.as_ref().ok_or_else(|| vault::VaultError::Locked.to_string())?;
    let stored = {
        let conn = state.db.lock().map_err(db_err)?;
        db::may_use_credential(&conn, crate::commands::open_project(&state).as_deref(), &id)?;
        db::credential(&conn, &id)
            .map_err(db_err)?
            .ok_or("That saved credential no longer exists.")?
    };
    Ok(RevealedCredential {
        username: stored.username,
        secret: open_secret(key, &stored.secret)?,
        second_secret: match &stored.extra {
            None => None,
            Some(e) => Some(open_secret(key, e)?),
        },
    })
}

#[tauri::command(async)]
pub fn delete_credential(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    db::may_use_credential(&conn, crate::commands::open_project(&state).as_deref(), &id)?;
    db::delete_credential(&conn, &id).map_err(db_err)?;
    Ok(())
}

/// The vault as a portable bundle, still encrypted.
///
/// Exists so credentials can move to another machine deliberately. What comes
/// out is ciphertext and the salt needed to derive the key again — importing it
/// requires the same passphrase, so this is not a way to read secrets, and the
/// vault does not even need to be unlocked to produce it.
///
/// It is still the most dangerous thing the app can write: it is every stored
/// credential in one file, and its safety rests entirely on the passphrase. The
/// interface defaults to leaving it out and says so plainly.
#[tauri::command(async)]
pub fn export_vault(state: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    let conn = state.db.lock().map_err(db_err)?;
    let (salt, verifier) = db::vault_header(&conn)
        .map_err(db_err)?
        .ok_or("There is no vault to export.")?;

    let mut items = Vec::new();
    for (id, ..) in db::list_credentials(&conn).map_err(db_err)? {
        if let Some(c) = db::credential(&conn, &id).map_err(db_err)? {
            items.push(serde_json::json!({
                "id": c.id,
                "label": c.label,
                "kind": c.kind,
                "username": c.username,
                "detail": c.detail,
                "secretNonce": c.secret.0,
                "secretCipher": c.secret.1,
                "extraNonce": c.extra.as_ref().map(|e| e.0.clone()),
                "extraCipher": c.extra.as_ref().map(|e| e.1.clone()),
            }));
        }
    }

    Ok(serde_json::json!({
        "vaultVersion": 1,
        "salt": salt,
        "verifier": verifier,
        "credentials": items,
    }))
}

/// Takes the credentials out of an exported project package.
///
/// The credentials in that file are sealed under the *exporting* machine's
/// key, so importing them needs that machine's passphrase — there is no way
/// around it, and no way to check the file is worth importing without it.
/// Each secret is opened with the imported key and resealed under this
/// vault's, so nothing on disk here is ever encrypted with someone else's
/// passphrase.
///
/// Requires the local vault to be unlocked: this writes into it.
#[tauri::command(async)]
pub fn import_vault(
    state: State<'_, AppState>,
    vault: serde_json::Value,
    passphrase: String,
) -> CmdResult<usize> {
    let guard = state.vault_key.lock().map_err(db_err)?;
    let local = guard.as_ref().ok_or_else(|| vault::VaultError::Locked.to_string())?;

    let bytes = |v: &serde_json::Value| -> Option<Vec<u8>> {
        v.as_array()?
            .iter()
            .map(|n| n.as_u64().and_then(|x| u8::try_from(x).ok()))
            .collect()
    };

    let header = vault::VaultHeader {
        salt: bytes(&vault["salt"]).ok_or("That package's credentials are damaged.")?,
        verifier: bytes(&vault["verifier"]).ok_or("That package's credentials are damaged.")?,
    };
    // Fails here, before anything is written, if the passphrase is wrong.
    let source = vault::unlock(&passphrase, &header).map_err(|e| e.to_string())?;

    let items = vault["credentials"]
        .as_array()
        .ok_or("That package has no credentials to import.")?;

    let conn = state.db.lock().map_err(db_err)?;
    let mut imported = 0usize;
    for item in items {
        let reseal = |nonce: &serde_json::Value, cipher: &serde_json::Value| -> CmdResult<Option<(Vec<u8>, Vec<u8>)>> {
            let (Some(nonce), Some(ciphertext)) = (bytes(nonce), bytes(cipher)) else {
                return Ok(None);
            };
            let plain = vault::open(&source, &vault::SealedSecret { nonce, ciphertext })
                .map_err(|e| e.to_string())?;
            let sealed = vault::seal(local, &plain).map_err(|e| e.to_string())?;
            Ok(Some((sealed.nonce, sealed.ciphertext)))
        };

        let Some(secret) = reseal(&item["secretNonce"], &item["secretCipher"])? else {
            continue;
        };
        let extra = reseal(&item["extraNonce"], &item["extraCipher"])?;

        let text = |k: &str| item[k].as_str().unwrap_or_default().to_string();
        let stored = db::StoredCredential {
            // A fresh id: an import must not overwrite a local credential that
            // happens to share one, which two vaults seeded from the same
            // export would.
            id: uuid::Uuid::new_v4().to_string(),
            label: text("label"),
            kind: text("kind"),
            username: text("username"),
            secret,
            extra,
            detail: text("detail"),
        };
        db::save_credential(&conn, &stored, now_ms()).map_err(db_err)?;
        imported += 1;
    }

    Ok(imported)
}

/// Rebuilds SSH credentials from the vault, for use inside this process.
///
/// Deliberately not a command. It returns plaintext, so it is callable from
/// Rust and unreachable from the interface — the whole arrangement rests on
/// that distinction.
pub fn ssh_credentials(state: &AppState, id: &str) -> CmdResult<Credentials> {
    let guard = state.vault_key.lock().map_err(db_err)?;
    let key = guard.as_ref().ok_or_else(|| vault::VaultError::Locked.to_string())?;
    let stored = {
        let conn = state.db.lock().map_err(db_err)?;
        // The one place an SSH secret is opened, so the one check.
        db::may_use_credential(&conn, crate::commands::open_project(state).as_deref(), id)?;
        db::credential(&conn, id)
            .map_err(db_err)?
            .ok_or("That saved credential no longer exists.")?
    };

    let password = open_secret(key, &stored.secret)?;
    let enable_password = match &stored.extra {
        None => None,
        Some(e) => Some(Secret::new(open_secret(key, e)?)),
    };
    Ok(Credentials {
        username: stored.username,
        password: Secret::new(password),
        enable_password,
    })
}

/// A saved API login (kind `api`), for the REST collectors. Not a
/// command, for the same reason as `ssh_credentials`.
pub fn api_credentials(state: &AppState, id: &str) -> CmdResult<coreview_collect::api::ApiLogin> {
    let guard = state.vault_key.lock().map_err(db_err)?;
    let key = guard.as_ref().ok_or_else(|| vault::VaultError::Locked.to_string())?;
    let stored = {
        let conn = state.db.lock().map_err(db_err)?;
        // As for every kind of secret.
        db::may_use_credential(&conn, crate::commands::open_project(state).as_deref(), id)?;
        db::credential(&conn, id).map_err(db_err)?.ok_or("That saved credential no longer exists.")?
    };
    if stored.kind != "api" {
        return Err("That saved credential is not an API login.".into());
    }
    // An API login's `detail` is its HTTPS port; blank is 443.
    let port = stored.detail.trim().parse::<u16>().ok().filter(|p| *p != 0);
    Ok(coreview_collect::api::ApiLogin { username: stored.username, secret: open_secret(key, &stored.secret)?, port })
}

/// Notes that a saved credential was offered to `target`, in the local
/// log only. Best effort: a log that could not be written never stops the job
/// the credential was opened for.
pub fn note_use(state: &AppState, credential_id: &str, purpose: &str, target: &str) {
    if let Ok(conn) = state.db.lock() {
        let _ = db::record_credential_use(&conn, credential_id, purpose, target, db::now_ms());
    }
}

/// Where saved credentials were used, newest first. Read on this
/// machine and never sent anywhere.
#[tauri::command(async)]
pub fn list_credential_use(state: State<'_, AppState>, credential_id: Option<String>, limit: Option<i64>) -> CmdResult<Vec<db::CredentialUseRow>> {
    let conn = state.db.lock().map_err(db_err)?;
    db::list_credential_use(&conn, credential_id.as_deref(), limit.unwrap_or(500).clamp(1, 5_000)).map_err(db_err)
}

#[tauri::command(async)]
pub fn clear_credential_use(state: State<'_, AppState>) -> CmdResult<usize> {
    let conn = state.db.lock().map_err(db_err)?;
    db::clear_credential_use(&conn).map_err(db_err)
}

/// Every SSH login the open project keeps — owned by it or referred
/// to by it — in the order a run tries them after its first login:
/// the ids the page sent, in their order (the project's default and its
/// other logins), then every other one the project keeps, by label.
/// The login the run starts with is never repeated, and with no project open
/// nothing is added: the vault is the machine's, the project is the scope.
pub fn project_login_order(state: &AppState, sent: &[String], first: Option<&str>) -> Vec<String> {
    let kept: Vec<String> = match crate::commands::open_project(state) {
        Some(p) => match state.db.lock() {
            Ok(conn) => db::list_credentials_for(&conn, Some(&p)).map(|rows| rows.into_iter().filter(|c| c.kind == "ssh").map(|c| c.id).collect()).unwrap_or_default(),
            Err(_) => Vec::new(),
        },
        None => Vec::new(),
    };
    login_order(sent, &kept, first)
}

/// The login a device job starts with, then every other SSH login the open
/// project keeps, each opened and paired with its id so the one a device
/// accepts can be recorded. A kept login that has gone, or will not open, is
/// one fewer to try; the chosen one must open.
pub fn ssh_login_chain(state: &AppState, first: &str) -> CmdResult<Vec<(String, Credentials)>> {
    let mut chain = vec![(first.to_string(), ssh_credentials(state, first)?)];
    for id in project_login_order(state, &[], Some(first)) {
        if !credential_exists(state, &id) {
            continue;
        }
        if let Ok(c) = ssh_credentials(state, &id) {
            chain.push((id, c));
        }
    }
    Ok(chain)
}

/// The pure half of `project_login_order`.
pub fn login_order(sent: &[String], kept: &[String], first: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in sent.iter().chain(kept.iter()) {
        let id = id.trim();
        if id.is_empty() || Some(id) == first.map(str::trim) || out.iter().any(|o| o == id) {
            continue;
        }
        out.push(id.to_string());
    }
    out
}

/// Whether the vault still holds this credential.
///
/// A project stores credential *ids*, and the vault is machine-wide and
/// outlives any one project. So an id can go stale — the credential
/// was wiped, or the project was opened on a machine whose vault never had it
/// — and a stale id must never be fatal to anything.
pub fn credential_exists(state: &AppState, id: &str) -> bool {
    let Ok(conn) = state.db.lock() else { return false };
    matches!(db::credential(&conn, id), Ok(Some(_)))
}

/// What kind a saved credential is — `ssh` or `snmp` — without opening it.
pub fn credential_kind(state: &AppState, id: &str) -> CmdResult<String> {
    let conn = state.db.lock().map_err(db_err)?;
    Ok(db::credential(&conn, id)
        .map_err(db_err)?
        .ok_or("That saved credential no longer exists.")?
        .kind)
}

/// Rebuilds SNMP credentials from the vault. Also not a command, for the same
/// reason.
pub fn snmp_credentials(state: &AppState, id: &str) -> CmdResult<SnmpAuth> {
    let guard = state.vault_key.lock().map_err(db_err)?;
    let key = guard.as_ref().ok_or_else(|| vault::VaultError::Locked.to_string())?;
    let stored = {
        let conn = state.db.lock().map_err(db_err)?;
        // As for SSH.
        db::may_use_credential(&conn, crate::commands::open_project(state).as_deref(), id)?;
        db::credential(&conn, id)
            .map_err(db_err)?
            .ok_or("That saved credential no longer exists.")?
    };

    let secret = open_secret(key, &stored.secret)?;
    // "sha|aes 256" — algorithm words, which are not secret and so are stored
    // in clear beside the ciphertext.
    let (auth_word, priv_word) = stored.detail.split_once('|').unwrap_or(("sha", ""));

    if stored.username.is_empty() {
        return Ok(SnmpAuth::V2c { community: secret });
    }
    Ok(SnmpAuth::V3 {
        username: stored.username,
        auth_protocol: AuthKind::parse(auth_word).unwrap_or(AuthKind::Sha1),
        auth_password: secret,
        privacy: PrivKind::parse(priv_word),
        privacy_password: match &stored.extra {
            None => String::new(),
            Some(e) => open_secret(key, e)?,
        },
    })
}

pub fn open_secret(key: &VaultKey, parts: &(Vec<u8>, Vec<u8>)) -> CmdResult<String> {
    vault::open(
        key,
        &SealedSecret {
            nonce: parts.0.clone(),
            ciphertext: parts.1.clone(),
        },
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {

    /// Every login the project keeps is tried, not just its default
    /// and the ones listed after it; the chosen first one is not repeated.
    #[test]
    fn every_login_the_project_keeps_follows_the_ones_sent() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(super::login_order(&s(&["b", "c"]), &s(&["a", "b", "c", "d", "e"]), Some("a")), s(&["b", "c", "d", "e"]));
        assert_eq!(super::login_order(&s(&[]), &s(&["a", "d"]), None), s(&["a", "d"]));
        assert_eq!(super::login_order(&s(&["x", "x", " "]), &s(&[]), Some("y")), s(&["x"]));
    }

    /// Only `reveal_credential` may return a secret, checked against the
    /// source rather than by inspection.
    ///
    /// Revealing is a deliberate act with a name that says so. A future edit
    /// that quietly returned plaintext from `list_credentials` or
    /// `vault_status` would look perfectly reasonable in review and would undo
    /// the arrangement without anybody noticing.
    #[test]
    fn only_the_reveal_command_returns_a_secret() {
        let source = include_str!("vault_commands.rs");
        let source = source.split("#[cfg(test)]").next().unwrap();
        let mut offenders = Vec::new();

        for block in source.split("#[tauri::command]").skip(1) {
            let signature: String = block.chars().take(400).collect();
            let name = signature
                .split("pub fn ")
                .nth(1)
                .and_then(|s| s.split('(').next())
                .unwrap_or("?")
                .to_string();
            if name == "reveal_credential" {
                continue;
            }

            // The return type, up to the opening brace.
            let returns = signature
                .split("->")
                .nth(1)
                .and_then(|s| s.split('{').next())
                .unwrap_or("")
                .to_string();

            for forbidden in [
                "Credentials",
                "SnmpAuth",
                "VaultKey",
                "SealedSecret",
                "StoredCredential",
                "RevealedCredential",
            ] {
                if returns.contains(forbidden) {
                    offenders.push(format!("{name} returns {forbidden}"));
                }
            }
        }

        assert!(
            offenders.is_empty(),
            "a command other than reveal_credential returns something secret: {offenders:?}"
        );
    }

    #[test]
    fn revealing_is_a_single_named_command() {
        // If a second way to read a secret appears, it should be a deliberate
        // decision rather than something that accumulated.
        // Only the code above the test module — otherwise this test's own
        // text counts as a match and the check passes for the wrong reason.
        let source = include_str!("vault_commands.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        let revealers = code.matches("RevealedCredential> {").count();
        assert_eq!(revealers, 1, "there should be exactly one way to read a secret");
    }

    #[test]
    fn the_functions_that_do_return_secrets_are_not_commands() {
        // ssh_credentials and snmp_credentials exist and hand back plaintext;
        // the point is that they are plain Rust functions.
        let source = include_str!("vault_commands.rs");
        for name in ["fn ssh_credentials", "fn snmp_credentials"] {
            let at = source.find(name).expect("function missing");
            let before = &source[at.saturating_sub(200)..at];
            assert!(
                !before.contains("#[tauri::command]"),
                "{name} has become reachable from the interface"
            );
        }
    }
}
