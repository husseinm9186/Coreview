//! The vault key in the operating system's keychain, when asked for (LT-262).
//!
//! Off unless the operator turns it on, per machine. On, the key that opens
//! the vault — never the passphrase — is kept in Windows Credential Manager,
//! the macOS Keychain or the Secret Service on Linux, and the vault opens by
//! itself when Coreview starts. A kept key is used only if it opens this
//! vault's verifier; one left from a vault since discarded is forgotten rather
//! than tried again.

use coreview_discover::vault::{self, VaultHeader, VaultKey};

pub const SERVICE: &str = "Coreview";
pub const ACCOUNT: &str = "vault-key";

/// The one entry Coreview keeps.
pub fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("The system keychain is not available: {e}"))
}

pub fn remember(entry: &keyring::Entry, key: &VaultKey) -> Result<(), String> {
    entry
        .set_secret(&vault::key_bytes(key))
        .map_err(|e| format!("The key could not be kept in the system keychain: {e}"))
}

/// What the keychain had.
pub enum Recalled {
    Opened(VaultKey),
    NothingKept,
    /// Something was kept, but it does not open this vault; it has been
    /// removed.
    Stale,
}

pub fn recall(entry: &keyring::Entry, header: &VaultHeader) -> Result<Recalled, String> {
    let bytes = match entry.get_secret() {
        Ok(b) => zeroize::Zeroizing::new(b),
        Err(keyring::Error::NoEntry) => return Ok(Recalled::NothingKept),
        Err(e) => return Err(format!("The system keychain could not be read: {e}")),
    };
    match vault::unlock_with_key(&bytes, header) {
        Ok(key) => Ok(Recalled::Opened(key)),
        Err(_) => {
            forget(entry)?;
            Ok(Recalled::Stale)
        }
    }
}

/// Removes the kept key. Nothing kept is not an error.
pub fn forget(entry: &keyring::Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("The key could not be removed from the system keychain: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock() -> keyring::Entry {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        keyring::Entry::new(SERVICE, ACCOUNT).unwrap()
    }

    /// The machine's real keychain, under a test account: `cargo test -p
    /// coreview real_keychain -- --ignored` with a Secret Service, Credential
    /// Manager or Keychain available.
    #[test]
    #[ignore]
    fn the_real_keychain_keeps_and_forgets_a_key() {
        let entry = keyring::Entry::new(SERVICE, "vault-key-test").unwrap();
        let (header, key) = vault::create("correct horse battery staple").unwrap();
        remember(&entry, &key).unwrap();
        assert!(matches!(recall(&entry, &header).unwrap(), Recalled::Opened(_)), "kept and read back");
        forget(&entry).unwrap();
        assert!(matches!(recall(&entry, &header).unwrap(), Recalled::NothingKept), "and gone");
    }

    #[test]
    fn a_kept_key_opens_its_own_vault_and_only_that() {
        let entry = mock();
        let passphrase = "correct horse battery staple"; // not a credential
        let (header, key) = vault::create(passphrase).unwrap();
        assert!(matches!(recall(&entry, &header).unwrap(), Recalled::NothingKept));

        remember(&entry, &key).unwrap();
        let Recalled::Opened(opened) = recall(&entry, &header).unwrap() else { panic!("the kept key should open the vault") };
        let sealed = vault::seal(&key, "a secret").unwrap();
        assert_eq!(vault::open(&opened, &sealed).unwrap(), "a secret");

        // A new vault: the old key must not open it, and is forgotten.
        let (other, _) = vault::create(passphrase).unwrap();
        assert!(matches!(recall(&entry, &other).unwrap(), Recalled::Stale));
        assert!(matches!(recall(&entry, &other).unwrap(), Recalled::NothingKept));

        remember(&entry, &key).unwrap();
        forget(&entry).unwrap();
        forget(&entry).unwrap();
        assert!(matches!(recall(&entry, &header).unwrap(), Recalled::NothingKept));
    }
}
