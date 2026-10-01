//! Local SQLite persistence. One database per installation, under
//! %LOCALAPPDATA%\Coreview\coreview.db. No server, no network.
//!
//! Storage strategy: project *metadata*, *sessions*, *events* and *samples* are
//! normalized because they are queried, filtered and exported. The diagram
//! itself (nodes, links, notes, probes, canvas settings) is stored as one
//! versioned JSON document per project, because it is always read and written
//! whole, and because a single document keeps undo/redo, export and schema
//! migration straightforward.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: i64 = 8;
/// Bumped whenever the diagram document shape changes; the frontend migrates.
pub const DOCUMENT_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
// LT-259: sent by the webview; a field this does not declare is refused.
#[serde(deny_unknown_fields)]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub customer: String,
    #[serde(default)]
    pub site: String,
    #[serde(default)]
    pub ticket: String,
    #[serde(default)]
    pub engineer: String,
    #[serde(default)]
    pub description: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectPackage {
    pub meta: ProjectMeta,
    pub document_version: i64,
    /// Opaque to Rust: the frontend owns the diagram shape.
    pub document: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventRow {
    pub id: String,
    pub project_id: String,
    pub session_id: Option<String>,
    pub timestamp_ms: i64,
    pub object_type: String,
    pub object_id: String,
    pub object_name: String,
    pub event_type: String,
    pub previous_status: Option<String>,
    pub current_status: Option<String>,
    pub probe_type: Option<String>,
    pub target: Option<String>,
    pub rtt_ms: Option<f64>,
    pub message: String,
}

/// Where this platform keeps an application's data (LT-401).
///
/// A parameter rather than a `cfg!`, so every platform's answer can be
/// asserted from any machine. LT-400 was a platform branch no test here could
/// see, wrong on macOS for months; this is the same shape of decision and gets
/// the same treatment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataHome {
    /// `%LOCALAPPDATA%`.
    Windows,
    /// `~/Library/Application Support`, which is where a Mac keeps this and,
    /// unlike a dotfolder, a place Finder will show.
    MacOs,
    /// `$XDG_DATA_HOME`, else `~/.local/share`.
    Xdg,
}

impl DataHome {
    fn here() -> Self {
        if cfg!(windows) {
            DataHome::Windows
        } else if cfg!(target_os = "macos") {
            DataHome::MacOs
        } else {
            DataHome::Xdg
        }
    }
}

fn base_dir_for(
    home: DataHome,
    local_app_data: Option<PathBuf>,
    xdg_data_home: Option<PathBuf>,
    user_home: Option<PathBuf>,
) -> Option<PathBuf> {
    match home {
        DataHome::Windows => local_app_data,
        DataHome::MacOs => user_home.map(|h| h.join("Library/Application Support")),
        DataHome::Xdg => xdg_data_home.or_else(|| user_home.map(|h| h.join(".local/share"))),
    }
}

pub fn data_dir() -> PathBuf {
    let base = base_dir_for(
        DataHome::here(),
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
    )
    .unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("Coreview");
    adopt_livetopo_data(&base, &dir);
    // LT-401: everything a Mac wrote before this went to the XDG folder, and
    // that includes the database. Moving without carrying it across would look
    // exactly like every project having been deleted.
    if DataHome::here() == DataHome::MacOs {
        if let Some(old) = dirs_next_local().map(|b| b.join("Coreview")) {
            adopt_from(&old, &dir);
        }
    }
    dir
}

/// Copies a whole data folder across, once, and never over anything already
/// there — so a later run cannot overwrite newer data with older.
fn adopt_from(old_dir: &Path, new_dir: &Path) {
    if new_dir.exists() || !old_dir.is_dir() {
        return;
    }
    if std::fs::create_dir_all(new_dir).is_err() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(old_dir) else { return };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let to = new_dir.join(entry.file_name());
        if kind.is_dir() {
            // Logs and transcripts live in subfolders, and a half-copied
            // folder is worse than an uncopied one.
            adopt_from(&entry.path(), &to);
        } else if kind.is_file() {
            let _ = std::fs::copy(entry.path(), to);
        }
    }
}

/// Carries a pre-rename database over to the new name.
///
/// The app was called LiveTopo until 0.2.0 and kept its database in a folder
/// of that name. Renaming the product without this would leave every existing
/// project on disk but invisible, which looks exactly like data loss.
///
/// Deliberately conservative: it only acts when there is a LiveTopo folder and
/// no Coreview folder at all, so it can never overwrite newer data, and it
/// copies rather than moves — if anything here is wrong, the original is still
/// sitting there untouched. A failure is silent on purpose; a first run that
/// starts empty is recoverable, one that refuses to start is not.
fn adopt_livetopo_data(base: &Path, new_dir: &Path) {
    let old_dir = base.join("LiveTopo");
    if new_dir.exists() || !old_dir.is_dir() {
        return;
    }
    if std::fs::create_dir_all(new_dir).is_err() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(&old_dir) else { return };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        // The database file was renamed along with everything else, so the
        // copy has to be renamed too. Copying livetopo.db verbatim leaves it
        // sitting next to a freshly created empty coreview.db, which is the
        // data loss this whole function exists to prevent. The -wal and -shm
        // siblings are carried across under the same mapping so SQLite sees a
        // coherent set rather than a database with a stranded journal.
        let name = entry.file_name();
        let renamed = name.to_string_lossy().replace("livetopo", "coreview");
        let _ = std::fs::copy(entry.path(), new_dir.join(renamed));
    }
}

fn dirs_next_local() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
}

/// Restricts the database to its owner.
///
/// It holds encrypted credentials, and while the encryption is what actually
/// protects them, a world-readable file hands an attacker the ciphertext and
/// the salt to work on offline at their leisure. Best effort: on Windows the
/// file inherits the folder's ACL, which is that platform's answer to the same
/// question.
fn restrict(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    // After WAL is enabled, so the sidecar files exist and get the same
    // treatment — a readable -wal is as good as a readable database.
    restrict(path);
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        let sidecar = std::path::PathBuf::from(sidecar);
        if sidecar.exists() {
            restrict(&sidecar);
        }
    }
    Ok(conn)
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS schema_info (version INTEGER NOT NULL);

        -- Preferences that must outlive a restart: the folders the user chose
        -- for backups, exports and the icon library. Deliberately a plain
        -- key/value table — these are a handful of paths and flags, and a
        -- typed column per setting would mean a migration for each new one.
        --
        -- Nothing secret goes in here. It is unencrypted, and it lives in the
        -- same database as the projects.
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- The same, but belonging to one project (LT-414).
        --
        -- `app_settings` above is a property of this *computer* — where its
        -- icon library is, whether the keychain opens the vault. What was
        -- wrongly kept there too is a property of the *work*: which folder a
        -- customer's backups go in, what the captures are named, which
        -- commands to run. Those followed whoever opened the app into the next
        -- project, which on a tool pointed at several customers' networks is
        -- the leak D-038 already ruled on.
        --
        -- Local, not in the document: a customer's folder path must not travel
        -- when the project is exported or sent to a colleague (D-006, D-034).
        CREATE TABLE IF NOT EXISTS project_settings (
            project_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (project_id, key)
        );

        -- SSH host keys, remembered on first contact so a later change can be
        -- refused. Fingerprints only: a public key fingerprint is not a secret,
        -- and storing it here rather than in a project keeps it out of anything
        -- that gets exported or shared.
        -- The credential vault. Nothing here is readable without the
        -- passphrase, which is not stored: `salt` and `verifier` let a key be
        -- re-derived and checked, and neither reveals anything on its own.
        CREATE TABLE IF NOT EXISTS vault_header (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            salt BLOB NOT NULL,
            verifier BLOB NOT NULL,
            created_ms INTEGER NOT NULL
        );

        -- One saved credential. The username and label are deliberately in
        -- clear: they are not secrets, they are how a person picks the right
        -- credential from a list, and encrypting them would only make the
        -- interface unusable while locked.
        CREATE TABLE IF NOT EXISTS credentials (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            kind TEXT NOT NULL,
            username TEXT NOT NULL,
            secret_nonce BLOB NOT NULL,
            secret_cipher BLOB NOT NULL,
            -- The second secret: an enable password for SSH, a privacy
            -- password for SNMPv3. Absent when there is none.
            extra_nonce BLOB,
            extra_cipher BLOB,
            -- Algorithm words for SNMPv3, which are not secret.
            detail TEXT NOT NULL DEFAULT '',
            created_ms INTEGER NOT NULL,
            -- D-059: the project it was saved in. NULL for one saved before
            -- owners existed, or from the start screen.
            project_id TEXT
        );

        CREATE TABLE IF NOT EXISTS host_keys (
            host_id TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            first_seen_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            customer TEXT NOT NULL DEFAULT '',
            site TEXT NOT NULL DEFAULT '',
            ticket TEXT NOT NULL DEFAULT '',
            engineer TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            document_version INTEGER NOT NULL DEFAULT 1,
            document TEXT NOT NULL DEFAULT '{}',
            -- LT-485: which folder of the project screen it sits in. This
            -- machine's arrangement, never part of the document or a package.
            folder_id TEXT
        );

        -- LT-485: folders on the project screen, nested by parent.
        CREATE TABLE IF NOT EXISTS project_folders (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            parent_id TEXT,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS validation_sessions (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            started_at INTEGER NOT NULL,
            stopped_at INTEGER,
            operator TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'running'
        );

        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            session_id TEXT,
            timestamp_ms INTEGER NOT NULL,
            object_type TEXT NOT NULL,
            object_id TEXT NOT NULL,
            object_name TEXT NOT NULL DEFAULT '',
            event_type TEXT NOT NULL,
            previous_status TEXT,
            current_status TEXT,
            probe_type TEXT,
            target TEXT,
            rtt_ms REAL,
            message TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_events_project_time
            ON events(project_id, timestamp_ms DESC);

        CREATE TABLE IF NOT EXISTS probe_samples (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            probe_id TEXT NOT NULL,
            timestamp_ms INTEGER NOT NULL,
            status TEXT NOT NULL,
            outcome TEXT NOT NULL,
            rtt_ms REAL,
            summary TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_samples_session
            ON probe_samples(session_id, timestamp_ms DESC);
        -- LT-227: each crawl's result, so two can be compared.
        -- LT-424: a run is opened when the crawl starts and closed when it
        -- ends; `status` is running, complete, cancelled or aborted. Devices
        -- go into crawl_run_devices as they are reached, so an unclean exit
        -- keeps what was found. `result` holds the rest of the summary —
        -- failures, neighbours not visited, cancelled — and, for runs written
        -- before schema 3, the devices as well.
        CREATE TABLE IF NOT EXISTS crawl_runs (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            taken_at INTEGER NOT NULL,
            seed TEXT NOT NULL DEFAULT '',
            devices INTEGER NOT NULL DEFAULT 0,
            result TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'complete'
        );
        CREATE INDEX IF NOT EXISTS idx_crawl_runs_project ON crawl_runs(project_id, taken_at DESC);
        CREATE TABLE IF NOT EXISTS crawl_run_devices (
            run_id TEXT NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            device TEXT NOT NULL,
            PRIMARY KEY (run_id, seq)
        );

        -- LT-264: where a saved credential was offered, and when. Rolled up by
        -- the hour, so a check that reads a device every minute is one row an
        -- hour, not sixty. Kept after the credential is deleted: it is a log.
        CREATE TABLE IF NOT EXISTS credential_use (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            credential_id TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '',
            purpose TEXT NOT NULL,
            target TEXT NOT NULL,
            first_ms INTEGER NOT NULL,
            last_ms INTEGER NOT NULL,
            uses INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_credential_use ON credential_use(credential_id, last_ms DESC);

        -- LT-224: one probe's history, read by time.
        CREATE INDEX IF NOT EXISTS idx_samples_probe
            ON probe_samples(probe_id, timestamp_ms);
        "#,
    )?;

    // LT-526: tables that arrived after the base schema was last written are
    // made here too. `apply_migrations` stamps a brand-new database with the
    // current version *without* running its steps, so a table only a
    // migration creates never existed on a fresh install. Both steps are
    // idempotent (IF NOT EXISTS; a column check), so an old database that
    // migrates is unaffected.
    crate::collection_db::discovery_tables(conn)?;
    crate::collection_db::shadow_columns(conn)?;
    crate::collection_db::typed_columns(conn)?;
    crate::collection_db::topology_tables(conn)?;

    apply_migrations(conn, MIGRATIONS)
}

/// One step of the schema's history: the version it brings the database *to*,
/// and what it does. Applied in order, each once, inside one transaction.
type Migration = (i64, fn(&Connection) -> rusqlite::Result<()>);

/// Every migration ever written, oldest first. Adding a column is a new entry
/// here and a bump of `SCHEMA_VERSION`, never an edit to an old one — a
/// database in the field may be at any version in this list.
const MIGRATIONS: &[Migration] = &[(2, split_settings_per_project), (3, crawl_runs_written_as_they_go), (4, projects_in_folders), (5, credentials_have_owners), (6, crate::collection_db::discovery_tables), (7, crate::collection_db::shadow_columns), (8, crate::collection_db::topology_tables)];

/// LT-430: the steps that take a database from its version to
/// `SCHEMA_VERSION`, in one transaction with the version bump last.
///
/// Before this the steps and the bump ran bare, so a crash between them left
/// a half-migrated database that the next start would try to migrate again.
/// The one migration that existed was idempotent by luck; the first
/// `ALTER TABLE ADD COLUMN` would not have been. Now either every step lands
/// and the version moves, or nothing does and the next start tries again.
fn apply_migrations(conn: &Connection, steps: &[Migration]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    let current: Option<i64> = tx
        .query_row("SELECT version FROM schema_info LIMIT 1", [], |r| r.get(0))
        .optional()?;
    match current {
        None => {
            tx.execute("INSERT INTO schema_info (version) VALUES (?1)", params![SCHEMA_VERSION])?;
        }
        Some(v) if v < SCHEMA_VERSION => {
            for (to, step) in steps {
                if v < *to {
                    step(&tx)?;
                }
            }
            tx.execute("UPDATE schema_info SET version = ?1", params![SCHEMA_VERSION])?;
        }
        _ => {}
    }
    tx.commit()
}

/// Schema 2 (LT-414): project-shaped settings move out of the machine-wide
/// table and into the project that was using them.
///
/// **Copied to every project that exists, then removed from the shared table.**
/// Before this, every project read one `backupFolder` — so they all had the
/// same one, and copying it to each keeps every existing project exactly as it
/// was. What changes is the future: a project made after this starts with
/// none, instead of inheriting the last one's.
///
/// A fallback would have been less code and would have kept the bug.
fn split_settings_per_project(conn: &Connection) -> rusqlite::Result<()> {
    let shared = all_settings(conn)?;
    let moving: Vec<(&str, &String)> = PROJECT_KEYS
        .iter()
        .filter_map(|k| shared.get(*k).map(|v| (*k, v)))
        .collect();
    if moving.is_empty() {
        return Ok(());
    }

    let ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM projects")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<String>>>()?
    };

    for id in &ids {
        for (key, value) in &moving {
            // A project that somehow already has its own keeps it.
            conn.execute(
                "INSERT OR IGNORE INTO project_settings (project_id, key, value) VALUES (?1, ?2, ?3)",
                params![id, key, value],
            )?;
        }
    }
    for (key, _) in &moving {
        conn.execute("DELETE FROM app_settings WHERE key = ?1", params![key])?;
    }
    Ok(())
}

/// Schema 3 (LT-424): a run gets a status, and its devices get a table of
/// their own. The table is in the base schema; this adds the column to a
/// database that already had the old `crawl_runs`. Every run written before
/// this is complete by definition, which is the column's default.
///
/// A column that is already there is left alone, so a database whose base
/// schema was built at 3 and then had its version wound back — the upgrade
/// tests do exactly that — migrates cleanly.
fn crawl_runs_written_as_they_go(conn: &Connection) -> rusqlite::Result<()> {
    let has_status = conn
        .prepare("PRAGMA table_info(crawl_runs)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .any(|name| name == "status");
    if !has_status {
        conn.execute("ALTER TABLE crawl_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'complete'", [])?;
    }
    Ok(())
}

/// Schema 4 (LT-485): a project can sit in a folder. The folders table is in
/// the base schema already; what an older database lacks is the column. A
/// column that is already there is left alone, as in schema 3.
fn projects_in_folders(conn: &Connection) -> rusqlite::Result<()> {
    let has = conn
        .prepare("PRAGMA table_info(projects)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .any(|name| name == "folder_id");
    if !has {
        conn.execute("ALTER TABLE projects ADD COLUMN folder_id TEXT", [])?;
    }
    Ok(())
}

/// Schema 5 (D-059): a credential knows the project it belongs to. Every one
/// that exists is left unowned; the projects that refer to it keep it.
fn credentials_have_owners(conn: &Connection) -> rusqlite::Result<()> {
    let has = conn
        .prepare("PRAGMA table_info(credentials)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .any(|name| name == "project_id");
    if !has {
        conn.execute("ALTER TABLE credentials ADD COLUMN project_id TEXT", [])?;
    }
    Ok(())
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn row_to_meta(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectMeta> {
    Ok(ProjectMeta {
        id: row.get("id")?,
        name: row.get("name")?,
        customer: row.get("customer")?,
        site: row.get("site")?,
        ticket: row.get("ticket")?,
        engineer: row.get("engineer")?,
        description: row.get("description")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        archived: row.get::<_, i64>("archived")? != 0,
    })
}

pub fn list_projects(conn: &Connection) -> rusqlite::Result<Vec<ProjectMeta>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, customer, site, ticket, engineer, description,
                created_at, updated_at, archived
         FROM projects ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], row_to_meta)?;
    rows.collect()
}

pub fn upsert_project(conn: &Connection, pkg: &ProjectPackage) -> rusqlite::Result<()> {
    let doc = pkg.document.to_string();
    conn.execute(
        "INSERT INTO projects
           (id, name, customer, site, ticket, engineer, description,
            created_at, updated_at, archived, document_version, document)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, customer=excluded.customer, site=excluded.site,
           ticket=excluded.ticket, engineer=excluded.engineer,
           description=excluded.description, updated_at=excluded.updated_at,
           archived=excluded.archived,
           document_version=excluded.document_version, document=excluded.document",
        params![
            pkg.meta.id,
            pkg.meta.name,
            pkg.meta.customer,
            pkg.meta.site,
            pkg.meta.ticket,
            pkg.meta.engineer,
            pkg.meta.description,
            pkg.meta.created_at,
            pkg.meta.updated_at,
            pkg.meta.archived as i64,
            pkg.document_version,
            doc,
        ],
    )?;
    Ok(())
}

pub fn load_project(conn: &Connection, id: &str) -> rusqlite::Result<Option<ProjectPackage>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, customer, site, ticket, engineer, description,
                created_at, updated_at, archived, document_version, document
         FROM projects WHERE id = ?1",
    )?;
    let pkg = stmt
        .query_row(params![id], |row| {
            let meta = row_to_meta(row)?;
            let doc_str: String = row.get("document")?;
            Ok(ProjectPackage {
                meta,
                document_version: row.get("document_version")?,
                document: serde_json::from_str(&doc_str).unwrap_or(serde_json::json!({})),
            })
        })
        .optional()?;
    Ok(pkg)
}

/// Deletes a project.
///
/// Its validation sessions and event timeline go too, and the probe samples
/// under those — `ON DELETE CASCADE` on the schema does it, and `open` turns
/// `foreign_keys` on for every connection, which is what makes the constraint
/// more than decoration. That matters more than it looks: an event carries the
/// device's *name* and the address it was checked at, so a project that left
/// its history behind would leave exactly the details someone deletes a
/// project to be rid of. `deleting_a_project_takes_its_history_with_it` pins
/// it, because a dropped pragma would break it silently.
pub fn delete_project(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
    Ok(())
}

/// Removes anything left behind by a project that is already gone.
///
/// Deleting a project used to leave its sessions, events and samples in place,
/// so any database written before that was fixed still holds them. Run once at
/// startup: it is cheap, it is idempotent, and it is the only way those rows
/// ever go away.
pub fn purge_orphans(conn: &Connection) -> rusqlite::Result<usize> {
    let tx = conn.unchecked_transaction()?;
    let mut removed = tx.execute(
        "DELETE FROM probe_samples WHERE session_id NOT IN (SELECT id FROM validation_sessions)",
        [],
    )?;
    removed += tx.execute(
        "DELETE FROM events WHERE project_id NOT IN (SELECT id FROM projects)",
        [],
    )?;
    removed += tx.execute(
        "DELETE FROM validation_sessions WHERE project_id NOT IN (SELECT id FROM projects)",
        [],
    )?;
    removed += tx.execute("DELETE FROM crawl_runs WHERE project_id NOT IN (SELECT id FROM projects)", [])?;
    tx.commit()?;
    Ok(removed)
}

// ------------------------------------------------------------------ folders

/// LT-485: one folder on the project screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFolder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
}

/// Every folder, and which folder each project is in. A project in no folder
/// is at the top and is not listed in `placement`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FolderTree {
    pub folders: Vec<ProjectFolder>,
    pub placement: std::collections::BTreeMap<String, String>,
}

/// A folder name as it is kept: trimmed, not empty, not absurd.
fn folder_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("A folder needs a name.".into());
    }
    if name.chars().count() > 80 {
        return Err("A folder name can be at most 80 characters.".into());
    }
    Ok(name.to_string())
}

fn folder_exists(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    conn.query_row("SELECT 1 FROM project_folders WHERE id = ?1", params![id], |_| Ok(()))
        .optional()
        .map(|r| r.is_some())
}

/// Refuses a second folder of the same name beside another, case-insensitively,
/// because two "Customer A" folders side by side are one mistake waiting.
fn check_sibling_name(conn: &Connection, parent: Option<&str>, name: &str, except: Option<&str>) -> Result<(), String> {
    let taken: bool = conn
        .query_row(
            "SELECT 1 FROM project_folders
             WHERE parent_id IS ?1 AND lower(name) = lower(?2) AND id IS NOT ?3",
            params![parent, name, except],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .is_some();
    if taken {
        return Err(format!("There is already a folder called “{name}” here."));
    }
    Ok(())
}

pub fn list_folders(conn: &Connection) -> rusqlite::Result<FolderTree> {
    let mut stmt = conn.prepare("SELECT id, name, parent_id FROM project_folders ORDER BY lower(name)")?;
    let folders = stmt
        .query_map([], |r| Ok(ProjectFolder { id: r.get(0)?, name: r.get(1)?, parent_id: r.get(2)? }))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut stmt = conn.prepare("SELECT id, folder_id FROM projects WHERE folder_id IS NOT NULL")?;
    let placement = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(FolderTree { folders, placement })
}

pub fn create_folder(conn: &Connection, name: &str, parent: Option<&str>) -> Result<ProjectFolder, String> {
    let name = folder_name(name)?;
    if let Some(p) = parent {
        if !folder_exists(conn, p).map_err(|e| e.to_string())? {
            return Err("That folder no longer exists.".into());
        }
    }
    check_sibling_name(conn, parent, &name, None)?;
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO project_folders (id, name, parent_id, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, name, parent, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(ProjectFolder { id, name, parent_id: parent.map(str::to_string) })
}

pub fn rename_folder(conn: &Connection, id: &str, name: &str) -> Result<(), String> {
    let name = folder_name(name)?;
    let parent: Option<String> = conn
        .query_row("SELECT parent_id FROM project_folders WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("That folder no longer exists.")?;
    check_sibling_name(conn, parent.as_deref(), &name, Some(id))?;
    conn.execute("UPDATE project_folders SET name = ?2 WHERE id = ?1", params![id, name]).map_err(|e| e.to_string())?;
    Ok(())
}

/// The folder and every folder under it, at any depth.
fn subtree(conn: &Connection, id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE under(id) AS (
             SELECT ?1
             UNION ALL
             SELECT f.id FROM project_folders f JOIN under u ON f.parent_id = u.id
         )
         SELECT id FROM under",
    )?;
    let ids = stmt.query_map(params![id], |r| r.get(0))?.collect();
    ids
}

/// Moves a folder under another, or to the top with `None`. A folder cannot
/// go inside itself or anything under it — that would cut it off from the top.
pub fn move_folder(conn: &Connection, id: &str, parent: Option<&str>) -> Result<(), String> {
    let name: String = conn
        .query_row("SELECT name FROM project_folders WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("That folder no longer exists.")?;
    if let Some(p) = parent {
        if !folder_exists(conn, p).map_err(|e| e.to_string())? {
            return Err("That folder no longer exists.".into());
        }
        if subtree(conn, id).map_err(|e| e.to_string())?.iter().any(|f| f == p) {
            return Err("A folder cannot be moved into itself or into a folder inside it.".into());
        }
    }
    check_sibling_name(conn, parent, &name, Some(id))?;
    conn.execute("UPDATE project_folders SET parent_id = ?2 WHERE id = ?1", params![id, parent]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Deletes a folder. **Never a project:** its projects and sub-folders move
/// up to its parent, in one transaction. A sub-folder whose name is already
/// taken there keeps its place under a suffixed name rather than failing.
pub fn delete_folder(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let parent: Option<String> = tx
        .query_row("SELECT parent_id FROM project_folders WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("That folder no longer exists.")?;
    tx.execute("UPDATE projects SET folder_id = ?2 WHERE folder_id = ?1", params![id, parent]).map_err(|e| e.to_string())?;
    let children: Vec<(String, String)> = {
        let mut stmt = tx.prepare("SELECT id, name FROM project_folders WHERE parent_id = ?1").map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?
    };
    for (child, name) in children {
        let mut candidate = name.clone();
        let mut n = 2;
        while check_sibling_name(&tx, parent.as_deref(), &candidate, Some(&child)).is_err() {
            candidate = format!("{name} ({n})");
            n += 1;
        }
        tx.execute("UPDATE project_folders SET parent_id = ?2, name = ?3 WHERE id = ?1", params![child, parent, candidate])
            .map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM project_folders WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Puts a project in a folder, or at the top with `None`. Does not touch
/// `updated_at`: filing a project is not editing it.
pub fn move_project(conn: &Connection, project: &str, folder: Option<&str>) -> Result<(), String> {
    if let Some(f) = folder {
        if !folder_exists(conn, f).map_err(|e| e.to_string())? {
            return Err("That folder no longer exists.".into());
        }
    }
    let changed = conn
        .execute("UPDATE projects SET folder_id = ?2 WHERE id = ?1", params![project, folder])
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("That project no longer exists.".into());
    }
    Ok(())
}

pub fn set_archived(conn: &Connection, id: &str, archived: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE projects SET archived = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, archived as i64, now_ms()],
    )?;
    Ok(())
}

pub fn open_session(
    conn: &Connection,
    id: &str,
    project_id: &str,
    operator: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO validation_sessions (id, project_id, started_at, operator, status)
         VALUES (?1,?2,?3,?4,'running')",
        params![id, project_id, now_ms(), operator],
    )?;
    Ok(())
}

pub fn close_session(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE validation_sessions SET stopped_at = ?2, status = 'stopped' WHERE id = ?1",
        params![id, now_ms()],
    )?;
    Ok(())
}

/// LT-226: a validation session, for choosing two to compare.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub started_at: i64,
    pub stopped_at: Option<i64>,
    pub samples: i64,
    pub transitions: i64,
}

pub fn list_sessions(conn: &Connection, project_id: &str) -> rusqlite::Result<Vec<SessionRow>> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.started_at, s.stopped_at,
                (SELECT COUNT(*) FROM probe_samples p WHERE p.session_id = s.id),
                (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.event_type = 'transition')
         FROM validation_sessions s WHERE s.project_id = ?1 ORDER BY s.started_at DESC LIMIT 200",
    )?;
    let rows = stmt.query_map(params![project_id], |r| {
        Ok(SessionRow { id: r.get(0)?, started_at: r.get(1)?, stopped_at: r.get(2)?, samples: r.get(3)?, transitions: r.get(4)? })
    })?;
    rows.collect()
}

/// LT-226: what one probe did in a session.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeSummary {
    pub probe_id: String,
    pub samples: i64,
    pub healthy: i64,
    pub warning: i64,
    pub down: i64,
    pub avg_rtt_ms: Option<f64>,
    /// The 95th percentile response time.
    pub p95_rtt_ms: Option<f64>,
}

pub fn session_summary(conn: &Connection, session_id: &str) -> rusqlite::Result<Vec<ProbeSummary>> {
    let mut stmt = conn.prepare(
        "SELECT probe_id, status, rtt_ms FROM probe_samples WHERE session_id = ?1 ORDER BY probe_id",
    )?;
    let mut by_probe: std::collections::BTreeMap<String, (ProbeSummary, Vec<f64>)> = std::collections::BTreeMap::new();
    let rows = stmt.query_map(params![session_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<f64>>(2)?)))?;
    for row in rows {
        let (probe_id, status, rtt) = row?;
        let entry = by_probe.entry(probe_id.clone()).or_insert_with(|| {
            (ProbeSummary { probe_id, samples: 0, healthy: 0, warning: 0, down: 0, avg_rtt_ms: None, p95_rtt_ms: None }, Vec::new())
        });
        entry.0.samples += 1;
        match status.as_str() {
            "healthy" => entry.0.healthy += 1,
            "warning" => entry.0.warning += 1,
            "down" => entry.0.down += 1,
            _ => {}
        }
        if let Some(v) = rtt {
            entry.1.push(v);
        }
    }
    Ok(by_probe
        .into_values()
        .map(|(mut s, mut rtts)| {
            if !rtts.is_empty() {
                rtts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                s.avg_rtt_ms = Some(rtts.iter().sum::<f64>() / rtts.len() as f64);
                let at = ((rtts.len() as f64) * 0.95).ceil() as usize;
                s.p95_rtt_ms = rtts.get(at.saturating_sub(1)).copied();
            }
            s
        })
        .collect())
}

/// LT-227: a stored crawl, without its result.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlRunRow {
    pub id: String,
    pub taken_at: i64,
    pub seed: String,
    pub devices: i64,
    /// LT-424: `running`, `complete`, `cancelled` or `aborted`.
    pub status: String,
}

/// How many crawls a project keeps.
pub const CRAWL_RUNS_KEPT: i64 = 50;

/// A run as it was written before schema 3 — whole, with its devices inside
/// `result`. The app no longer writes one (LT-424); the tests keep it to
/// prove such a run still reads.
#[cfg(test)]
pub fn insert_crawl_run(conn: &Connection, id: &str, project_id: &str, taken_at: i64, seed: &str, devices: i64, result: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO crawl_runs (id, project_id, taken_at, seed, devices, result) VALUES (?1,?2,?3,?4,?5,?6)",
        params![id, project_id, taken_at, seed, devices, result],
    )?;
    conn.execute(
        "DELETE FROM crawl_runs WHERE project_id = ?1 AND id NOT IN (
            SELECT id FROM crawl_runs WHERE project_id = ?1 ORDER BY taken_at DESC LIMIT ?2)",
        params![project_id, CRAWL_RUNS_KEPT],
    )?;
    Ok(())
}

/// LT-424: opens a run the moment a crawl starts, so that whatever it reaches
/// is on disk before it ends. Keeps the project to its last `CRAWL_RUNS_KEPT`;
/// the cascade takes a pruned run's devices with it.
pub fn open_crawl_run(conn: &Connection, id: &str, project_id: &str, taken_at: i64, seed: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO crawl_runs (id, project_id, taken_at, seed, devices, result, status) VALUES (?1,?2,?3,?4,0,'{}','running')",
        params![id, project_id, taken_at, seed],
    )?;
    conn.execute(
        "DELETE FROM crawl_runs WHERE project_id = ?1 AND id NOT IN (
            SELECT id FROM crawl_runs WHERE project_id = ?1 ORDER BY taken_at DESC LIMIT ?2)",
        params![project_id, CRAWL_RUNS_KEPT],
    )?;
    Ok(())
}

/// One device, as it was reached. `device` is its JSON, exactly as the
/// interface receives it in the event stream.
pub fn append_crawl_device(conn: &Connection, run_id: &str, device: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO crawl_run_devices (run_id, seq, device) VALUES (?1,
            (SELECT COALESCE(MAX(seq), 0) + 1 FROM crawl_run_devices WHERE run_id = ?1), ?2)",
        params![run_id, device],
    )?;
    conn.execute("UPDATE crawl_runs SET devices = devices + 1 WHERE id = ?1", params![run_id])?;
    Ok(())
}

/// Closes a run with everything but its devices — failures, neighbours not
/// visited, whether it was cancelled — and the status it ended in.
pub fn close_crawl_run(conn: &Connection, id: &str, status: &str, summary: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE crawl_runs SET status = ?2, result = ?3 WHERE id = ?1", params![id, status, summary])?;
    Ok(())
}

/// Run once at startup: nothing can still be running, so a run left `running`
/// is one the process died under. Marked rather than removed — its devices
/// are the whole point of writing them as they arrive.
pub fn mark_abandoned_runs(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute("UPDATE crawl_runs SET status = 'aborted' WHERE status = 'running'", [])
}

pub fn list_crawl_runs(conn: &Connection, project_id: &str) -> rusqlite::Result<Vec<CrawlRunRow>> {
    let mut stmt = conn.prepare("SELECT id, taken_at, seed, devices, status FROM crawl_runs WHERE project_id = ?1 ORDER BY taken_at DESC")?;
    let rows = stmt.query_map(params![project_id], |r| Ok(CrawlRunRow { id: r.get(0)?, taken_at: r.get(1)?, seed: r.get(2)?, devices: r.get(3)?, status: r.get(4)? }))?;
    rows.collect()
}

/// A run as the interface reads it: the summary with its devices in place and
/// its status. A run written before schema 3 carries its devices inside
/// `result` and is returned as it was; one written since takes them from
/// `crawl_run_devices`, in the order they were reached.
///
/// LT-455: `project_id` must be the run's own. One operator on one machine
/// makes this a label rather than a boundary, but LT-412–414 showed how a
/// rule applied in one place reappears in another; a run id from a different
/// project reads as *not kept* rather than as somebody else's estate.
pub fn crawl_run_result(conn: &Connection, id: &str, project_id: &str) -> rusqlite::Result<Option<serde_json::Value>> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT result, status FROM crawl_runs WHERE id = ?1 AND project_id = ?2",
            params![id, project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((result, status)) = row else { return Ok(None) };
    let mut value: serde_json::Value = serde_json::from_str(&result).unwrap_or_else(|_| serde_json::json!({}));
    if !value.is_object() {
        value = serde_json::json!({});
    }
    if value.get("devices").and_then(|d| d.as_array()).is_none() {
        let mut stmt = conn.prepare("SELECT device FROM crawl_run_devices WHERE run_id = ?1 ORDER BY seq")?;
        let devices: Vec<serde_json::Value> = stmt
            .query_map(params![id], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .filter_map(|text| serde_json::from_str(&text).ok())
            .collect();
        value["devices"] = serde_json::Value::Array(devices);
    }
    let cancelled = serde_json::json!(status == "cancelled");
    for (key, empty) in [("failures", serde_json::json!([])), ("notVisited", serde_json::json!([])), ("cancelled", cancelled)] {
        if value.get(key).is_none() {
            value[key] = empty;
        }
    }
    value["status"] = serde_json::Value::String(status);
    Ok(Some(value))
}

/// LT-264: one line of the credential use log.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialUseRow {
    pub credential_id: String,
    pub label: String,
    pub purpose: String,
    pub target: String,
    pub first_ms: i64,
    pub last_ms: i64,
    pub uses: i64,
}

/// How long uses of one credential for one purpose on one target roll up into
/// one line.
pub const CREDENTIAL_USE_ROLLUP_MS: i64 = 60 * 60 * 1000;
/// How many lines the log keeps.
pub const CREDENTIAL_USE_KEPT: i64 = 20_000;

pub fn record_credential_use(conn: &Connection, credential_id: &str, purpose: &str, target: &str, now: i64) -> rusqlite::Result<()> {
    let label: String = conn
        .query_row("SELECT label FROM credentials WHERE id = ?1", params![credential_id], |r| r.get(0))
        .optional()?
        .unwrap_or_default();
    let recent: Option<i64> = conn
        .query_row(
            "SELECT id FROM credential_use WHERE credential_id = ?1 AND purpose = ?2 AND target = ?3 AND last_ms > ?4 ORDER BY last_ms DESC LIMIT 1",
            params![credential_id, purpose, target, now - CREDENTIAL_USE_ROLLUP_MS],
            |r| r.get(0),
        )
        .optional()?;
    match recent {
        Some(id) => {
            conn.execute("UPDATE credential_use SET last_ms = ?1, uses = uses + 1 WHERE id = ?2", params![now, id])?;
        }
        None => {
            conn.execute(
                "INSERT INTO credential_use (credential_id, label, purpose, target, first_ms, last_ms) VALUES (?1,?2,?3,?4,?5,?5)",
                params![credential_id, label, purpose, target, now],
            )?;
            conn.execute(
                "DELETE FROM credential_use WHERE id NOT IN (SELECT id FROM credential_use ORDER BY last_ms DESC LIMIT ?1)",
                params![CREDENTIAL_USE_KEPT],
            )?;
        }
    }
    Ok(())
}

/// The log, newest first; one credential's, or every one's.
pub fn list_credential_use(conn: &Connection, credential_id: Option<&str>, limit: i64) -> rusqlite::Result<Vec<CredentialUseRow>> {
    let mut stmt = conn.prepare(
        "SELECT credential_id, label, purpose, target, first_ms, last_ms, uses FROM credential_use
          WHERE ?1 IS NULL OR credential_id = ?1 ORDER BY last_ms DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![credential_id, limit], |r| {
        Ok(CredentialUseRow { credential_id: r.get(0)?, label: r.get(1)?, purpose: r.get(2)?, target: r.get(3)?, first_ms: r.get(4)?, last_ms: r.get(5)?, uses: r.get(6)? })
    })?;
    rows.collect()
}

pub fn clear_credential_use(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM credential_use", [])
}

/// LT-224: one probe result, for the history sparklines.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleRow {
    pub timestamp_ms: i64,
    pub status: String,
    pub outcome: String,
    pub rtt_ms: Option<f64>,
}

/// How many samples a probe keeps. At one every five seconds that is about
/// three days — enough to see last night's flap — without the file growing
/// without end.
pub const SAMPLES_PER_PROBE: i64 = 50_000;

/// One probe result as stored.
pub struct NewSample<'a> {
    pub session_id: &'a str,
    pub probe_id: &'a str,
    pub timestamp_ms: i64,
    pub status: &'a str,
    pub outcome: &'a str,
    pub rtt_ms: Option<f64>,
    pub summary: &'a str,
}

pub fn insert_sample(conn: &Connection, s: &NewSample<'_>) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO probe_samples (session_id, probe_id, timestamp_ms, status, outcome, rtt_ms, summary)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![s.session_id, s.probe_id, s.timestamp_ms, s.status, s.outcome, s.rtt_ms, s.summary],
    )?;
    Ok(())
}

/// Drops a probe's oldest samples past the cap. Cheap enough to run now and
/// then rather than on every insert.
pub fn prune_samples(conn: &Connection, probe_id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM probe_samples WHERE probe_id = ?1 AND id <= (
            SELECT id FROM probe_samples WHERE probe_id = ?1 ORDER BY id DESC LIMIT 1 OFFSET ?2)",
        params![probe_id, SAMPLES_PER_PROBE],
    )
}

/// A probe's samples since `since_ms`, oldest first, at most `limit`.
///
/// LT-455: only from sessions of `project_id` — a sample belongs to the
/// session that took it, and the session to a project.
pub fn samples_for(conn: &Connection, probe_id: &str, project_id: &str, since_ms: i64, limit: i64) -> rusqlite::Result<Vec<SampleRow>> {
    let mut stmt = conn.prepare(
        "SELECT timestamp_ms, status, outcome, rtt_ms FROM (
            SELECT s.timestamp_ms, s.status, s.outcome, s.rtt_ms FROM probe_samples s
            JOIN validation_sessions v ON v.id = s.session_id
            WHERE s.probe_id = ?1 AND v.project_id = ?4 AND s.timestamp_ms >= ?2
            ORDER BY s.timestamp_ms DESC LIMIT ?3)
         ORDER BY timestamp_ms ASC",
    )?;
    let rows = stmt.query_map(params![probe_id, since_ms, limit, project_id], |r| {
        Ok(SampleRow { timestamp_ms: r.get(0)?, status: r.get(1)?, outcome: r.get(2)?, rtt_ms: r.get(3)? })
    })?;
    rows.collect()
}

/// How many events a project keeps (LT-426). Every probe transition is one
/// row and nothing ever removed one, so the table grew for the life of the
/// database. The page shows the newest 5,000; twenty times that is a long
/// history without being a disk.
pub const EVENTS_PER_PROJECT: i64 = 100_000;

/// Drops a project's oldest events past the cap. The same shape as
/// `prune_samples`, and cheap: `idx_events_project_time` serves it.
pub fn prune_events(conn: &Connection, project_id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM events WHERE project_id = ?1 AND timestamp_ms < (
            SELECT timestamp_ms FROM events WHERE project_id = ?1
            ORDER BY timestamp_ms DESC LIMIT 1 OFFSET ?2)",
        params![project_id, EVENTS_PER_PROJECT - 1],
    )
}

pub fn insert_event(conn: &Connection, e: &EventRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO events (id, project_id, session_id, timestamp_ms, object_type, object_id,
                             object_name, event_type, previous_status, current_status,
                             probe_type, target, rtt_ms, message)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            e.id, e.project_id, e.session_id, e.timestamp_ms, e.object_type, e.object_id,
            e.object_name, e.event_type, e.previous_status, e.current_status,
            e.probe_type, e.target, e.rtt_ms, e.message
        ],
    )?;
    Ok(())
}

pub fn list_events(
    conn: &Connection,
    project_id: &str,
    limit: i64,
) -> rusqlite::Result<Vec<EventRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, session_id, timestamp_ms, object_type, object_id, object_name,
                event_type, previous_status, current_status, probe_type, target, rtt_ms, message
         FROM events WHERE project_id = ?1 ORDER BY timestamp_ms DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![project_id, limit], |row| {
        Ok(EventRow {
            id: row.get(0)?,
            project_id: row.get(1)?,
            session_id: row.get(2)?,
            timestamp_ms: row.get(3)?,
            object_type: row.get(4)?,
            object_id: row.get(5)?,
            object_name: row.get(6)?,
            event_type: row.get(7)?,
            previous_status: row.get(8)?,
            current_status: row.get(9)?,
            probe_type: row.get(10)?,
            target: row.get(11)?,
            rtt_ms: row.get(12)?,
            message: row.get(13)?,
        })
    })?;
    rows.collect()
}

// ------------------------------------------------------------------ settings

/// Every stored preference. Small enough to read in one go on startup.
pub fn all_settings(conn: &Connection) -> rusqlite::Result<std::collections::HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM app_settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    rows.collect()
}

/// Settings that belong to a project rather than to this computer (LT-414).
///
/// Everything a backup run is shaped by: where it writes, what it names the
/// files, which commands it sends, which checks it applies.
pub const PROJECT_KEYS: [&str; 16] = [
    // LT-521: shadow mode — both parsers on every collection in this project.
    "collectorShadow",
    // Where this customer's work is written.
    "backupFolder",
    "exportFolder",
    // How a backup run is shaped: what it names files, which commands it
    // sends, in what order, and what it checks afterwards.
    "backupChecks",
    "backupCommandSets",
    "backupFilePattern",
    "backupGroups",
    "backupPaging",
    "backupShowCommands",
    // What a discovery was pointed at (LT-135). These are **addresses on a
    // customer's network** — a seed and a list of subnets — which is the half
    // of the report that said "i see it when I start a new project from ip
    // address". A second customer's project must not open with the first
    // customer's addresses in the form.
    "scanSeed",
    "scanSubnets",
    "scanPort",
    "scanMaxHops",
    "scanCredentialId",
    "scanSnmpRows",
    "addressPreference",
];

/// Whether a key belongs to a project rather than to this computer.
pub fn is_project_key(key: &str) -> bool {
    PROJECT_KEYS.contains(&key)
}

/// Every preference stored for one project.
///
/// **There is no fallback to `app_settings`, and that is the point.** Falling
/// back would leave a new project inheriting whatever the last one used, which
/// is the bug this was written for. What existed before the split was copied
/// to the projects that existed, once, by [`migrate`].
pub fn project_settings(
    conn: &Connection,
    project_id: &str,
) -> rusqlite::Result<std::collections::HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM project_settings WHERE project_id = ?1")?;
    let rows = stmt.query_map(params![project_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    rows.collect()
}

/// Writes one of a project's preferences, or clears it when `value` is `None`.
pub fn set_project_setting(
    conn: &Connection,
    project_id: &str,
    key: &str,
    value: Option<&str>,
) -> rusqlite::Result<()> {
    match value {
        Some(v) if !v.is_empty() => conn.execute(
            "INSERT INTO project_settings (project_id, key, value) VALUES (?1, ?2, ?3)
             ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value",
            params![project_id, key, v],
        )?,
        _ => conn.execute(
            "DELETE FROM project_settings WHERE project_id = ?1 AND key = ?2",
            params![project_id, key],
        )?,
    };
    Ok(())
}

/// Writes a preference, or clears it when `value` is `None`.
///
/// Clearing rather than storing an empty string keeps "never set" and "set to
/// nothing" the same thing, which is what a folder that has been un-chosen
/// should be.
pub fn set_setting(conn: &Connection, key: &str, value: Option<&str>) -> rusqlite::Result<()> {
    match value {
        Some(v) if !v.is_empty() => conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, v],
        )?,
        _ => conn.execute("DELETE FROM app_settings WHERE key = ?1", params![key])?,
    };
    Ok(())
}

// ---------------------------------------------------------------- host keys

/// Every remembered host key, for rebuilding the in-memory store on startup.
pub fn all_host_keys(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT host_id, fingerprint FROM host_keys")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    rows.collect()
}

/// Records a key seen for the first time. Does not overwrite: a fingerprint
/// that differs from the stored one is the case the store exists to catch, and
/// quietly replacing it here would defeat the whole mechanism.
pub fn remember_host_key(
    conn: &Connection,
    host_id: &str,
    fingerprint: &str,
    now_ms: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO host_keys (host_id, fingerprint, first_seen_ms) VALUES (?1, ?2, ?3)
         ON CONFLICT(host_id) DO NOTHING",
        params![host_id, fingerprint, now_ms],
    )?;
    Ok(())
}

/// Forgets everything, so every device is first contact again. The way back
/// after a switch is genuinely replaced.
pub fn clear_host_keys(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM host_keys", [])
}

/// Forgets one device.
pub fn forget_host_key(conn: &Connection, host_id: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM host_keys WHERE host_id = ?1", params![host_id])
}

// ------------------------------------------------------------------- vault

pub struct StoredCredential {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub username: String,
    pub secret: (Vec<u8>, Vec<u8>),
    pub extra: Option<(Vec<u8>, Vec<u8>)>,
    pub detail: String,
}

pub fn vault_header(conn: &Connection) -> rusqlite::Result<Option<(Vec<u8>, Vec<u8>)>> {
    conn.query_row(
        "SELECT salt, verifier FROM vault_header WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

/// Creates the vault. Refuses to replace an existing one: overwriting the
/// header would orphan every stored credential, silently and irreversibly.
pub fn create_vault(
    conn: &Connection,
    salt: &[u8],
    verifier: &[u8],
    now_ms: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO vault_header (id, salt, verifier, created_ms) VALUES (1, ?1, ?2, ?3)",
        params![salt, verifier, now_ms],
    )?;
    Ok(())
}

/// Removes the vault and everything in it.
///
/// The only way out of a forgotten passphrase, and it is destructive by
/// necessity — without the key the rows are unreadable, so keeping them would
/// only be keeping rubbish.
pub fn destroy_vault(conn: &Connection) -> rusqlite::Result<usize> {
    let removed = conn.execute("DELETE FROM credentials", [])?;
    conn.execute("DELETE FROM vault_header", [])?;
    Ok(removed)
}

pub fn save_credential(conn: &Connection, c: &StoredCredential, now_ms: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO credentials
           (id, label, kind, username, secret_nonce, secret_cipher, extra_nonce, extra_cipher, detail, created_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label, kind = excluded.kind, username = excluded.username,
           secret_nonce = excluded.secret_nonce, secret_cipher = excluded.secret_cipher,
           extra_nonce = excluded.extra_nonce, extra_cipher = excluded.extra_cipher,
           detail = excluded.detail",
        params![
            c.id, c.label, c.kind, c.username,
            c.secret.0, c.secret.1,
            c.extra.as_ref().map(|e| &e.0), c.extra.as_ref().map(|e| &e.1),
            c.detail, now_ms
        ],
    )?;
    Ok(())
}

/// Everything about the saved credentials *except* the secrets.
///
/// A deliberately separate query from `credential`, so the listing path cannot
/// accidentally carry ciphertext towards the interface.
/// id, label, kind, username, detail — everything about a saved credential
/// except its secrets.
pub type CredentialListing = (String, String, String, String, String);

pub fn list_credentials(conn: &Connection) -> rusqlite::Result<Vec<CredentialListing>> {
    let mut stmt = conn.prepare(
        "SELECT id, label, kind, username, detail FROM credentials ORDER BY label",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
    })?;
    rows.collect()
}

pub fn credential(conn: &Connection, id: &str) -> rusqlite::Result<Option<StoredCredential>> {
    conn.query_row(
        "SELECT id, label, kind, username, secret_nonce, secret_cipher, extra_nonce, extra_cipher, detail
           FROM credentials WHERE id = ?1",
        params![id],
        |r| {
            let extra_nonce: Option<Vec<u8>> = r.get(6)?;
            let extra_cipher: Option<Vec<u8>> = r.get(7)?;
            Ok(StoredCredential {
                id: r.get(0)?,
                label: r.get(1)?,
                kind: r.get(2)?,
                username: r.get(3)?,
                secret: (r.get(4)?, r.get(5)?),
                extra: extra_nonce.zip(extra_cipher),
                detail: r.get(8)?,
            })
        },
    )
    .optional()
}

pub fn delete_credential(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM credentials WHERE id = ?1", params![id])
}

// --------------------------------------------------------- D-059: owners

/// Sets the project a credential belongs to — at save, or when the start
/// screen hands an unowned one to a project.
pub fn set_credential_owner(conn: &Connection, id: &str, project: Option<&str>) -> rusqlite::Result<usize> {
    conn.execute("UPDATE credentials SET project_id = ?2 WHERE id = ?1", params![id, project])
}

/// The project a credential belongs to: `None` when there is no such
/// credential, `Some(None)` when it has no owner.
pub fn credential_owner(conn: &Connection, id: &str) -> rusqlite::Result<Option<Option<String>>> {
    conn.query_row("SELECT project_id FROM credentials WHERE id = ?1", params![id], |r| r.get(0)).optional()
}

/// Whether a project's diagram names a credential — a device's own login, the
/// project's defaults, a rule. Read from the stored document itself, which is
/// where every such reference lives.
pub fn project_refers_to(conn: &Connection, project: &str, credential: &str) -> rusqlite::Result<bool> {
    if credential.is_empty() {
        return Ok(false);
    }
    conn.query_row(
        "SELECT 1 FROM projects WHERE id = ?1 AND instr(document, ?2) > 0",
        params![project, credential],
        |_| Ok(()),
    )
    .optional()
    .map(|r| r.is_some())
}

/// D-059: whether the open project may list or open a credential. With no
/// project open — the start screen — everything may, because that is where
/// the vault is managed. Inside a project: its own, and any its diagram
/// already refers to.
pub fn may_use_credential(conn: &Connection, open: Option<&str>, id: &str) -> Result<(), String> {
    let Some(project) = open.filter(|p| !p.is_empty()) else { return Ok(()) };
    let owner = credential_owner(conn, id).map_err(|e| e.to_string())?.ok_or("That saved credential no longer exists.")?;
    if owner.as_deref() == Some(project) || project_refers_to(conn, project, id).map_err(|e| e.to_string())? {
        return Ok(());
    }
    Err("That saved login belongs to another project.".into())
}

/// One credential as a listing shows it, with who owns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedListing {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub username: String,
    pub detail: String,
    pub owner_id: Option<String>,
    pub owner_name: Option<String>,
}

/// The credentials the open project may see (every one on the start screen),
/// each with the project that owns it.
pub fn list_credentials_for(conn: &Connection, open: Option<&str>) -> rusqlite::Result<Vec<OwnedListing>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.label, c.kind, c.username, c.detail, c.project_id, p.name
           FROM credentials c LEFT JOIN projects p ON p.id = c.project_id
          ORDER BY c.label",
    )?;
    let all = stmt
        .query_map([], |r| {
            Ok(OwnedListing {
                id: r.get(0)?,
                label: r.get(1)?,
                kind: r.get(2)?,
                username: r.get(3)?,
                detail: r.get(4)?,
                owner_id: r.get(5)?,
                owner_name: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let Some(project) = open.filter(|p| !p.is_empty()) else { return Ok(all) };
    let mut out = Vec::with_capacity(all.len());
    for c in all {
        if c.owner_id.as_deref() == Some(project) || project_refers_to(conn, project, &c.id)? {
            out.push(c);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    /// LT-401. On macOS everything went to `~/.local/share/Coreview` — a
    /// dotfolder Finder hides — so a debug log written there could not be
    /// found, which looks exactly like one that was never written.
    ///
    /// The platform is a parameter so this can be asserted from Linux. LT-400
    /// was a platform branch that no test here could see and that was wrong on
    /// macOS for months; once in a day is enough.
    #[test]
    fn each_platform_keeps_its_data_where_that_platform_keeps_data() {
        use std::path::PathBuf;
        let home = || Some(PathBuf::from("/Users/someone"));
        // Windows: %LOCALAPPDATA%, whatever else is set.
        assert_eq!(
            super::base_dir_for(super::DataHome::Windows, Some(PathBuf::from("C:\\Users\\a\\AppData\\Local")), None, home()),
            Some(PathBuf::from("C:\\Users\\a\\AppData\\Local")),
        );
        // macOS: Application Support, which Finder shows and a Mac expects.
        assert_eq!(
            super::base_dir_for(super::DataHome::MacOs, None, Some(PathBuf::from("/xdg")), home()),
            Some(PathBuf::from("/Users/someone/Library/Application Support")),
        );
        // Linux: XDG first, then the default underneath HOME.
        assert_eq!(
            super::base_dir_for(super::DataHome::Xdg, None, Some(PathBuf::from("/xdg")), home()),
            Some(PathBuf::from("/xdg")),
        );
        assert_eq!(
            super::base_dir_for(super::DataHome::Xdg, None, None, home()),
            Some(PathBuf::from("/Users/someone/.local/share")),
        );
        // Nothing to go on is nothing, not a guess.
        assert_eq!(super::base_dir_for(super::DataHome::MacOs, None, None, None), None);
    }

    /// The old folder is carried across, or a Mac user's projects would all
    /// appear to have been deleted the day this shipped.
    #[test]
    fn the_folder_that_was_there_before_is_adopted_whole() {
        let root = tempfile::tempdir().expect("tempdir");
        let old = root.path().join("old/Coreview");
        std::fs::create_dir_all(old.join("logs")).expect("old");
        std::fs::write(old.join("coreview.db"), b"a database").expect("db");
        std::fs::write(old.join("logs/crawl-1.log"), b"a log").expect("log");
        let new = root.path().join("new/Coreview");

        super::adopt_from(&old, &new);
        assert_eq!(std::fs::read(new.join("coreview.db")).expect("db came across"), b"a database");
        assert_eq!(
            std::fs::read(new.join("logs/crawl-1.log")).expect("subfolders come across too"),
            b"a log",
        );

        // Already there: nothing is touched, so a later run cannot overwrite
        // newer data with older.
        std::fs::write(new.join("coreview.db"), b"newer").expect("newer");
        super::adopt_from(&old, &new);
        assert_eq!(std::fs::read(new.join("coreview.db")).expect("db"), b"newer");
    }

    /// LT-138: everything the operator types lives in one file, and that file
    /// is not inside the program.
    ///
    /// "if I put my creds I want it saved on my machine ... even after
    /// upgrade it shouldn't get wiped". An upgrade replaces the install
    /// directory; it does not touch %LOCALAPPDATA%. This pins that, so a
    /// refactor that moved the database next to the executable — which would
    /// look fine on a dev machine and wipe every project on the next upgrade
    /// — fails here instead of in the field.
    #[test]
    fn the_data_directory_is_not_inside_the_program() {
        let dir = super::data_dir();
        let text = dir.to_string_lossy().to_string();

        assert!(
            text.ends_with("Coreview"),
            "the data directory must be the app's own folder, got {text}"
        );

        // Wherever the test binary is, the data must not be under it: that is
        // the install directory's stand-in here.
        let exe = std::env::current_exe().expect("current exe");
        let exe_dir = exe.parent().expect("exe dir");
        assert!(
            !dir.starts_with(exe_dir),
            "the database would be replaced by an upgrade: {text} is under {}",
            exe_dir.display()
        );

        // And it is an absolute path, so it does not follow the working
        // directory the app happens to be launched from.
        assert!(dir.is_absolute() || text == "./Coreview", "not a fixed location: {text}");
    }

    /// The vault is in that same database rather than a file of its own, so
    /// "my data survives" is one question and not two.
    #[test]
    fn the_vault_lives_in_the_same_database_as_everything_else() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("coreview.db");
        let conn = super::open(&path).expect("open");
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .expect("prepare")
            .query_map([], |r| r.get(0))
            .expect("query")
            .filter_map(Result::ok)
            .collect();
        assert!(
            tables.iter().any(|t| t.contains("credential") || t.contains("vault")),
            "the vault is not in this database: {tables:?}"
        );
        assert!(tables.iter().any(|t| t == "projects"), "{tables:?}");
        assert!(tables.iter().any(|t| t == "app_settings"), "{tables:?}");
        assert!(tables.iter().any(|t| t == "host_keys"), "{tables:?}");
    }


    fn cred(id: &str, label: &str) -> StoredCredential {
        StoredCredential {
            id: id.into(),
            label: label.into(),
            kind: "ssh".into(),
            username: "netops".into(),
            secret: (vec![1, 2, 3], vec![9, 9, 9]),
            extra: Some((vec![4, 5, 6], vec![8, 8, 8])),
            detail: String::new(),
        }
    }

    #[test]
    fn a_vault_can_only_be_created_once() {
        // Replacing the header would orphan every stored credential, silently
        // and with no way back.
        let conn = mem();
        assert!(vault_header(&conn).unwrap().is_none());
        create_vault(&conn, b"salt", b"verifier", 1).unwrap();
        assert!(create_vault(&conn, b"other", b"other", 2).is_err());

        let (salt, verifier) = vault_header(&conn).unwrap().unwrap();
        assert_eq!(salt, b"salt");
        assert_eq!(verifier, b"verifier");
    }

    #[test]
    fn listing_credentials_returns_no_ciphertext_at_all() {
        // The listing feeds the interface. Its query is deliberately separate
        // from the one that reads a secret, so this path cannot carry
        // ciphertext towards the front end even by mistake.
        let conn = mem();
        save_credential(&conn, &cred("a", "Core switches"), 1).unwrap();

        let listed = list_credentials(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        let (id, label, kind, username, _detail) = &listed[0];
        assert_eq!((id.as_str(), label.as_str(), kind.as_str(), username.as_str()),
                   ("a", "Core switches", "ssh", "netops"));
    }

    #[test]
    fn asking_for_a_credential_that_was_wiped_is_an_answer_not_a_failure() {
        // LT-335: a project stores ids, the vault is machine-wide and outlives
        // any one project, so an id goes stale whenever a credential is wiped
        // or the project travels to another machine. `credential_exists` is
        // built on this returning `None` rather than erroring, and a whole
        // crawl used to die on the `?` that followed.
        let conn = mem();
        save_credential(&conn, &cred("a", "Core"), 1).unwrap();
        assert!(credential(&conn, "a").unwrap().is_some());
        assert!(credential(&conn, "never-existed").unwrap().is_none());
        delete_credential(&conn, "a").unwrap();
        assert!(credential(&conn, "a").unwrap().is_none());
    }

    #[test]
    fn a_credential_round_trips_with_both_secrets() {
        let conn = mem();
        save_credential(&conn, &cred("a", "Core"), 1).unwrap();
        let got = credential(&conn, "a").unwrap().unwrap();
        assert_eq!(got.secret, (vec![1, 2, 3], vec![9, 9, 9]));
        assert_eq!(got.extra, Some((vec![4, 5, 6], vec![8, 8, 8])));
    }

    #[test]
    fn a_credential_without_a_second_secret_stays_without_one() {
        // An SSH credential with no enable password, or v3 with no privacy.
        let conn = mem();
        let mut c = cred("a", "Core");
        c.extra = None;
        save_credential(&conn, &c, 1).unwrap();
        assert_eq!(credential(&conn, "a").unwrap().unwrap().extra, None);
    }

    #[test]
    fn saving_the_same_id_updates_rather_than_duplicating() {
        let conn = mem();
        save_credential(&conn, &cred("a", "Old name"), 1).unwrap();
        save_credential(&conn, &cred("a", "New name"), 2).unwrap();
        let listed = list_credentials(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].1, "New name");
    }

    #[test]
    fn destroying_the_vault_takes_the_credentials_with_it() {
        // Without the key the rows are unreadable, so keeping them would only
        // be keeping rubbish — and leaving them would make a fresh vault look
        // like it had contents.
        let conn = mem();
        create_vault(&conn, b"salt", b"verifier", 1).unwrap();
        save_credential(&conn, &cred("a", "One"), 1).unwrap();
        save_credential(&conn, &cred("b", "Two"), 1).unwrap();

        assert_eq!(destroy_vault(&conn).unwrap(), 2);
        assert!(vault_header(&conn).unwrap().is_none());
        assert!(list_credentials(&conn).unwrap().is_empty());
        // And a new vault can be created afterwards.
        assert!(create_vault(&conn, b"new", b"new", 2).is_ok());
    }

    #[test]
    fn one_credential_can_be_deleted_without_touching_the_rest() {
        let conn = mem();
        save_credential(&conn, &cred("a", "One"), 1).unwrap();
        save_credential(&conn, &cred("b", "Two"), 1).unwrap();
        assert_eq!(delete_credential(&conn, "a").unwrap(), 1);
        let listed = list_credentials(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].0, "b");
    }

    #[test]
    fn host_keys_round_trip() {
        let conn = mem();
        remember_host_key(&conn, "10.1.1.1:22", "SHA256:aaa", 1).unwrap();
        remember_host_key(&conn, "10.1.1.2:22", "SHA256:bbb", 2).unwrap();
        let all = all_host_keys(&conn).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.contains(&("10.1.1.1:22".into(), "SHA256:aaa".into())));
    }

    #[test]
    fn remembering_never_overwrites_a_key_that_already_exists() {
        // The case the whole mechanism exists for. If a second sighting could
        // silently replace the first, a changed key would never be detected.
        let conn = mem();
        remember_host_key(&conn, "10.1.1.1:22", "SHA256:original", 1).unwrap();
        remember_host_key(&conn, "10.1.1.1:22", "SHA256:different", 2).unwrap();
        let all = all_host_keys(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].1, "SHA256:original", "the stored key must not move");
    }

    #[test]
    fn clearing_reports_how_many_were_forgotten() {
        // The count is what the confirmation message needs.
        let conn = mem();
        remember_host_key(&conn, "a:22", "SHA256:a", 1).unwrap();
        remember_host_key(&conn, "b:22", "SHA256:b", 1).unwrap();
        assert_eq!(clear_host_keys(&conn).unwrap(), 2);
        assert!(all_host_keys(&conn).unwrap().is_empty());
        assert_eq!(clear_host_keys(&conn).unwrap(), 0, "clearing an empty store is not an error");
    }

    #[test]
    fn one_device_can_be_forgotten_without_touching_the_rest() {
        let conn = mem();
        remember_host_key(&conn, "a:22", "SHA256:a", 1).unwrap();
        remember_host_key(&conn, "b:22", "SHA256:b", 1).unwrap();
        assert_eq!(forget_host_key(&conn, "a:22").unwrap(), 1);
        let all = all_host_keys(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].0, "b:22");
    }

    #[test]
    fn settings_round_trip_and_survive_being_overwritten() {
        let conn = mem();
        assert_eq!(all_settings(&conn).unwrap().get("backupFolder"), None);

        set_setting(&conn, "backupFolder", Some("/home/me/backups")).unwrap();
        assert_eq!(
            all_settings(&conn).unwrap().get("backupFolder").map(String::as_str),
            Some("/home/me/backups")
        );

        set_setting(&conn, "backupFolder", Some("/home/me/other")).unwrap();
        assert_eq!(
            all_settings(&conn).unwrap().get("backupFolder").map(String::as_str),
            Some("/home/me/other")
        );
        assert_eq!(all_settings(&conn).unwrap().len(), 1, "an update, not a second row");
    }

    #[test]
    fn clearing_a_setting_makes_it_unset_rather_than_empty() {
        // A folder that has been un-chosen must read the same as one never
        // chosen, or the UI has two states meaning the same thing.
        let conn = mem();
        set_setting(&conn, "exportFolder", Some("/tmp/x")).unwrap();
        set_setting(&conn, "exportFolder", None).unwrap();
        assert_eq!(all_settings(&conn).unwrap().get("exportFolder"), None);

        set_setting(&conn, "exportFolder", Some("")).unwrap();
        assert_eq!(all_settings(&conn).unwrap().get("exportFolder"), None);
        assert!(all_settings(&conn).unwrap().is_empty());
    }

    /// LT-414: what one project is shaped by must not shape the next one.
    ///
    /// This is the operator's report in one test — "what I saved on the 1st
    /// project i see it when I start a new project".
    #[test]
    fn a_projects_settings_are_its_own() {
        let conn = mem();
        upsert_project(&conn, &pkg("one", "Customer A")).unwrap();
        upsert_project(&conn, &pkg("two", "Customer B")).unwrap();

        set_project_setting(&conn, "one", "backupFolder", Some("/a/backups")).unwrap();
        set_project_setting(&conn, "one", "backupFilePattern", Some("{device}-{date}")).unwrap();

        // The second project sees none of it, because it never chose any.
        let two = project_settings(&conn, "two").unwrap();
        assert!(two.is_empty(), "a new project inherited another's settings: {two:?}");

        // And the first still has exactly what it chose.
        let one = project_settings(&conn, "one").unwrap();
        assert_eq!(one.get("backupFolder").map(String::as_str), Some("/a/backups"));
        assert_eq!(one.get("backupFilePattern").map(String::as_str), Some("{device}-{date}"));

        // They do not collide when both set the same key to different values.
        set_project_setting(&conn, "two", "backupFolder", Some("/b/backups")).unwrap();
        assert_eq!(
            project_settings(&conn, "one").unwrap().get("backupFolder").map(String::as_str),
            Some("/a/backups"),
        );
        assert_eq!(
            project_settings(&conn, "two").unwrap().get("backupFolder").map(String::as_str),
            Some("/b/backups"),
        );

        // Clearing one clears only that one.
        set_project_setting(&conn, "two", "backupFolder", None).unwrap();
        assert!(project_settings(&conn, "two").unwrap().is_empty());
        assert_eq!(project_settings(&conn, "one").unwrap().len(), 2);
    }

    /// The migration keeps every existing project exactly as it was, and stops
    /// there — the next project made starts clean.
    #[test]
    fn the_split_carries_what_existed_and_then_stops() {
        // A database as it was before schema 2: one shared backup folder.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_info (version INTEGER NOT NULL);
             INSERT INTO schema_info (version) VALUES (1);",
        )
        .unwrap();
        migrate(&conn).unwrap();
        // migrate() creates the tables; put the old-world state in by hand and
        // run the split directly, which is what an upgrade does.
        upsert_project(&conn, &pkg("one", "Customer A")).unwrap();
        upsert_project(&conn, &pkg("two", "Customer B")).unwrap();
        set_setting(&conn, "backupFolder", Some("/shared")).unwrap();
        set_setting(&conn, "backupFilePattern", Some("{device}")).unwrap();
        set_setting(&conn, "iconLibraryDir", Some("/icons")).unwrap();
        split_settings_per_project(&conn).unwrap();

        // Both projects kept what they had been sharing.
        for id in ["one", "two"] {
            let mine = project_settings(&conn, id).unwrap();
            assert_eq!(mine.get("backupFolder").map(String::as_str), Some("/shared"), "{id}");
            assert_eq!(mine.get("backupFilePattern").map(String::as_str), Some("{device}"), "{id}");
        }

        // The shared table no longer carries them, so nothing can inherit.
        let shared = all_settings(&conn).unwrap();
        assert_eq!(shared.get("backupFolder"), None);
        assert_eq!(shared.get("backupFilePattern"), None);
        // But what is genuinely about this computer stays where it was.
        assert_eq!(shared.get("iconLibraryDir").map(String::as_str), Some("/icons"));

        // A project made after the split starts with nothing.
        upsert_project(&conn, &pkg("three", "Customer C")).unwrap();
        assert!(project_settings(&conn, "three").unwrap().is_empty());
    }

    /// The upgrade that runs on a machine that already has projects and a
    /// backup folder — end to end through `migrate`, not by calling the split
    /// by hand.
    ///
    /// This is the path that runs once on the operator's own database, and it
    /// must not lose the folder his backups are already in.
    #[test]
    fn upgrading_a_real_database_keeps_every_project_working() {
        let conn = Connection::open_in_memory().unwrap();
        // Build the schema, then wind the version back to 1 and put the
        // world as it was: two projects sharing one machine-wide folder.
        migrate(&conn).unwrap();
        conn.execute("DELETE FROM project_settings", []).unwrap();
        conn.execute("UPDATE schema_info SET version = 1", []).unwrap();
        upsert_project(&conn, &pkg("one", "Customer A")).unwrap();
        upsert_project(&conn, &pkg("two", "Customer B")).unwrap();
        set_setting(&conn, "backupFolder", Some("/customers/backups")).unwrap();
        set_setting(&conn, "scanSubnets", Some("192.0.2.0/24")).unwrap();
        set_setting(&conn, "sshFontSize", Some("14")).unwrap();

        // The upgrade.
        migrate(&conn).unwrap();
        let version: i64 = conn
            .query_row("SELECT version FROM schema_info LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        // Nobody lost anything they were using.
        for id in ["one", "two"] {
            let mine = project_settings(&conn, id).unwrap();
            assert_eq!(mine.get("backupFolder").map(String::as_str), Some("/customers/backups"), "{id}");
            assert_eq!(mine.get("scanSubnets").map(String::as_str), Some("192.0.2.0/24"), "{id}");
        }
        // The terminal preference is about this computer and did not move.
        assert_eq!(all_settings(&conn).unwrap().get("sshFontSize").map(String::as_str), Some("14"));
        // And nothing project-shaped is left to be inherited.
        let shared = all_settings(&conn).unwrap();
        for key in PROJECT_KEYS {
            assert_eq!(shared.get(key), None, "{key} is still shared");
        }

        // Running it twice changes nothing — an upgrade is not re-run, but a
        // migration that is only safe once is a migration waiting to go wrong.
        migrate(&conn).unwrap();
        assert_eq!(
            project_settings(&conn, "one").unwrap().get("backupFolder").map(String::as_str),
            Some("/customers/backups"),
        );
    }

    #[test]
    fn settings_are_independent_of_each_other() {
        let conn = mem();
        set_setting(&conn, "backupFolder", Some("/b")).unwrap();
        set_setting(&conn, "exportFolder", Some("/e")).unwrap();
        set_setting(&conn, "iconLibraryDir", Some("/i")).unwrap();
        let all = all_settings(&conn).unwrap();
        assert_eq!(all.get("backupFolder").map(String::as_str), Some("/b"));
        assert_eq!(all.get("exportFolder").map(String::as_str), Some("/e"));
        assert_eq!(all.get("iconLibraryDir").map(String::as_str), Some("/i"));
    }

    #[test]
    fn adopts_a_pre_rename_database() {
        let base = std::env::temp_dir().join(format!("cv-adopt-{}", uuid::Uuid::new_v4()));
        let old = base.join("LiveTopo");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("livetopo.db"), b"old-bytes").unwrap();
        std::fs::write(old.join("livetopo.db-wal"), b"old-wal").unwrap();

        let new_dir = base.join("Coreview");
        adopt_livetopo_data(&base, &new_dir);

        // Renamed, not just copied: the app opens coreview.db, so a verbatim
        // copy would leave the projects stranded beside an empty database.
        assert_eq!(std::fs::read(new_dir.join("coreview.db")).unwrap(), b"old-bytes");
        assert_eq!(std::fs::read(new_dir.join("coreview.db-wal")).unwrap(), b"old-wal");
        assert!(!new_dir.join("livetopo.db").exists());
        // Copied, not moved: the original stays put in case this went wrong.
        assert!(old.join("livetopo.db").exists());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn never_overwrites_data_that_is_already_there() {
        let base = std::env::temp_dir().join(format!("cv-adopt-{}", uuid::Uuid::new_v4()));
        let old = base.join("LiveTopo");
        let new_dir = base.join("Coreview");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new_dir).unwrap();
        std::fs::write(old.join("livetopo.db"), b"old-bytes").unwrap();
        std::fs::write(new_dir.join("coreview.db"), b"current-bytes").unwrap();

        adopt_livetopo_data(&base, &new_dir);

        assert_eq!(std::fs::read(new_dir.join("coreview.db")).unwrap(), b"current-bytes");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn does_nothing_when_there_is_no_old_install() {
        let base = std::env::temp_dir().join(format!("cv-adopt-{}", uuid::Uuid::new_v4()));
        let new_dir = base.join("Coreview");
        adopt_livetopo_data(&base, &new_dir);
        assert!(!new_dir.exists());
        std::fs::remove_dir_all(&base).ok();
    }
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c
    }

    /// D-059, LT-495: a credential saved in one project is neither listed nor
    /// opened in another; one a project's diagram refers to is; the start
    /// screen sees every one, with its owner.
    #[test]
    fn a_login_belongs_to_the_project_it_was_saved_in() {
        let c = mem();
        upsert_project(&c, &pkg("pa", "Customer A")).unwrap();
        upsert_project(&c, &pkg("pb", "Customer B")).unwrap();
        let cred = |id: &str, kind: &str| StoredCredential {
            id: id.into(),
            label: format!("{id} label"),
            kind: kind.into(),
            username: "reader".into(),
            secret: (vec![1], vec![2]),
            extra: None,
            detail: String::new(),
        };
        save_credential(&c, &cred("a-ssh", "ssh"), 1).unwrap();
        set_credential_owner(&c, "a-ssh", Some("pa")).unwrap();
        save_credential(&c, &cred("b-key", "meraki"), 1).unwrap();
        set_credential_owner(&c, "b-key", Some("pb")).unwrap();
        save_credential(&c, &cred("old", "ssh"), 1).unwrap(); // from before owners

        let ids = |open: Option<&str>| list_credentials_for(&c, open).unwrap().into_iter().map(|l| l.id).collect::<Vec<_>>();
        assert_eq!(ids(Some("pa")), ["a-ssh"], "A sees only its own");
        assert_eq!(ids(Some("pb")), ["b-key"], "B does not see A's login, nor the unowned one");
        assert_eq!(ids(None).len(), 3, "the start screen sees every one");
        let listed = list_credentials_for(&c, None).unwrap();
        assert_eq!(listed.iter().find(|l| l.id == "b-key").unwrap().owner_name.as_deref(), Some("Customer B"));

        assert!(may_use_credential(&c, Some("pa"), "a-ssh").is_ok());
        assert_eq!(may_use_credential(&c, Some("pa"), "b-key").unwrap_err(), "That saved login belongs to another project.");
        assert!(may_use_credential(&c, Some("pa"), "old").is_err(), "unowned and not referred to: not A's");
        assert!(may_use_credential(&c, None, "b-key").is_ok(), "the start screen manages the whole vault");
        assert!(may_use_credential(&c, Some("pa"), "gone").is_err());

        // A's diagram refers to the unowned login (saved before owners): A
        // keeps it, B still does not see it.
        let mut refers = pkg("pa", "Customer A");
        refers.document = serde_json::json!({ "credentialDefaults": { "ssh": "old" } });
        upsert_project(&c, &refers).unwrap();
        assert!(may_use_credential(&c, Some("pa"), "old").is_ok());
        assert!(ids(Some("pa")).contains(&"old".to_string()));
        assert!(!ids(Some("pb")).contains(&"old".to_string()));
        // An autosave never changes who owns what.
        save_credential(&c, &cred("a-ssh", "ssh"), 2).unwrap();
        assert_eq!(credential_owner(&c, "a-ssh").unwrap(), Some(Some("pa".to_string())));
    }

    #[test]
    fn a_vault_from_before_owners_gains_the_column_once() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE credentials (id TEXT PRIMARY KEY, label TEXT NOT NULL);").unwrap();
        credentials_have_owners(&c).unwrap();
        credentials_have_owners(&c).unwrap();
        let n = c.prepare("PRAGMA table_info(credentials)").unwrap().query_map([], |r| r.get::<_, String>(1)).unwrap().filter_map(|r| r.ok()).filter(|n| n == "project_id").count();
        assert_eq!(n, 1);
    }

    /// LT-485: folders nest; a project moves in and out; a save never
    /// moves it; a package never carries its folder.
    #[test]
    fn projects_file_into_nested_folders_and_a_save_keeps_them_there() {
        let c = mem();
        upsert_project(&c, &pkg("p1", "Branch")).unwrap();
        upsert_project(&c, &pkg("p2", "Core")).unwrap();
        let customer = create_folder(&c, "  Customer A ", None).unwrap();
        assert_eq!(customer.name, "Customer A");
        let site = create_folder(&c, "Site 1", Some(&customer.id)).unwrap();
        move_project(&c, "p1", Some(&site.id)).unwrap();
        let tree = list_folders(&c).unwrap();
        assert_eq!(tree.folders.len(), 2);
        assert_eq!(tree.placement.get("p1"), Some(&site.id));
        assert_eq!(tree.placement.get("p2"), None, "a project in no folder is at the top");

        // Every autosave is an upsert; it must not take the project out.
        upsert_project(&c, &pkg("p1", "Branch renamed")).unwrap();
        assert_eq!(list_folders(&c).unwrap().placement.get("p1"), Some(&site.id));
        // And what is exported knows nothing about it.
        let loaded = load_project(&c, "p1").unwrap().unwrap();
        assert!(!serde_json::to_string(&loaded).unwrap().contains(&site.id));

        move_project(&c, "p1", None).unwrap();
        assert!(list_folders(&c).unwrap().placement.is_empty());
        assert!(move_project(&c, "missing", None).is_err());
        assert!(move_project(&c, "p1", Some("no-such-folder")).is_err());
    }

    #[test]
    fn a_folder_cannot_go_inside_itself_and_names_do_not_repeat_side_by_side() {
        let c = mem();
        let a = create_folder(&c, "A", None).unwrap();
        let b = create_folder(&c, "B", Some(&a.id)).unwrap();
        let deep = create_folder(&c, "C", Some(&b.id)).unwrap();
        assert!(move_folder(&c, &a.id, Some(&a.id)).unwrap_err().contains("into itself"));
        assert!(move_folder(&c, &a.id, Some(&deep.id)).unwrap_err().contains("into itself"));
        move_folder(&c, &deep.id, None).unwrap();
        assert_eq!(list_folders(&c).unwrap().folders.iter().find(|f| f.id == deep.id).unwrap().parent_id, None);

        assert!(create_folder(&c, "a", None).unwrap_err().contains("already a folder"));
        assert!(create_folder(&c, "   ", None).is_err());
        assert!(create_folder(&c, &"x".repeat(81), None).is_err());
        create_folder(&c, "B", None).unwrap(); // the same name elsewhere is fine
        assert!(rename_folder(&c, &deep.id, "b").unwrap_err().contains("already a folder"));
        rename_folder(&c, &deep.id, "Renamed").unwrap();
    }

    #[test]
    fn deleting_a_folder_moves_what_was_in_it_up_and_deletes_no_project() {
        let c = mem();
        upsert_project(&c, &pkg("p1", "One")).unwrap();
        upsert_project(&c, &pkg("p2", "Two")).unwrap();
        let top = create_folder(&c, "Customer", None).unwrap();
        let mid = create_folder(&c, "Region", Some(&top.id)).unwrap();
        let leaf = create_folder(&c, "Site", Some(&mid.id)).unwrap();
        // A sibling already called "Site" where the leaf is about to land.
        let clash = create_folder(&c, "Site", Some(&top.id)).unwrap();
        move_project(&c, "p1", Some(&mid.id)).unwrap();
        move_project(&c, "p2", Some(&leaf.id)).unwrap();

        delete_folder(&c, &mid.id).unwrap();
        let tree = list_folders(&c).unwrap();
        assert_eq!(list_projects(&c).unwrap().len(), 2, "no project is ever deleted with a folder");
        assert_eq!(tree.placement.get("p1"), Some(&top.id), "its projects move up");
        assert_eq!(tree.placement.get("p2"), Some(&leaf.id), "a sub-folder's projects stay in it");
        let moved = tree.folders.iter().find(|f| f.id == leaf.id).unwrap();
        assert_eq!((moved.parent_id.as_deref(), moved.name.as_str()), (Some(top.id.as_str()), "Site (2)"));
        assert!(tree.folders.iter().any(|f| f.id == clash.id && f.name == "Site"));
        assert!(!tree.folders.iter().any(|f| f.id == mid.id));

        delete_folder(&c, &top.id).unwrap();
        let tree = list_folders(&c).unwrap();
        assert_eq!(tree.placement.get("p1"), None, "and from the top folder, to the top");
        assert!(delete_folder(&c, "gone").is_err());
    }

    /// Schema 4 on a database made before it: the column is added once, and
    /// running the step again leaves it alone.
    #[test]
    fn a_database_from_before_folders_gains_the_column() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);").unwrap();
        projects_in_folders(&c).unwrap();
        projects_in_folders(&c).unwrap();
        let columns: Vec<String> = c
            .prepare("PRAGMA table_info(projects)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert_eq!(columns.iter().filter(|n| *n == "folder_id").count(), 1);
    }

    fn pkg(id: &str, name: &str) -> ProjectPackage {
        ProjectPackage {
            meta: ProjectMeta {
                id: id.into(),
                name: name.into(),
                customer: "Contoso".into(),
                site: "HQ".into(),
                ticket: "CHG-1001".into(),
                engineer: "Operator".into(),
                description: String::new(),
                created_at: 1,
                updated_at: 1,
                archived: false,
            },
            document_version: DOCUMENT_VERSION,
            document: serde_json::json!({ "nodes": [{"id": "n1"}], "links": [] }),
        }
    }

    /// The event a deleted project must not leave behind.
    fn event(project: &str, session: &str, name: &str, target: &str) -> EventRow {
        EventRow {
            id: format!("{project}-{name}"),
            project_id: project.into(),
            session_id: Some(session.into()),
            timestamp_ms: 1,
            object_type: "node".into(),
            object_id: "n1".into(),
            object_name: name.into(),
            event_type: "status".into(),
            previous_status: None,
            current_status: Some("down".into()),
            probe_type: Some("icmp".into()),
            target: Some(target.into()),
            rtt_ms: None,
            message: String::new(),
        }
    }

    #[test]
    fn deleting_a_project_takes_its_history_with_it() {
        // An event carries the device's name and the address it was checked
        // at. Deleting the project row alone left exactly the details someone
        // deletes a project to be rid of, in a table nothing would ever show
        // them again.
        let c = mem();
        upsert_project(&c, &pkg("p1", "Going")).unwrap();
        upsert_project(&c, &pkg("p2", "Staying")).unwrap();
        open_session(&c, "s1", "p1", "Operator").unwrap();
        open_session(&c, "s2", "p2", "Operator").unwrap();
        insert_event(&c, &event("p1", "s1", "EDGE-FW-01", "192.0.2.10")).unwrap();
        insert_event(&c, &event("p2", "s2", "CORE-SW-01", "192.0.2.20")).unwrap();

        delete_project(&c, "p1").unwrap();

        let count = |sql: &str| -> i64 { c.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(count("SELECT COUNT(*) FROM events WHERE project_id = 'p1'"), 0);
        assert_eq!(
            count("SELECT COUNT(*) FROM validation_sessions WHERE project_id = 'p1'"),
            0
        );
        // And the project that was not deleted is untouched.
        assert_eq!(count("SELECT COUNT(*) FROM events WHERE project_id = 'p2'"), 1);
        assert_eq!(
            count("SELECT COUNT(*) FROM validation_sessions WHERE project_id = 'p2'"),
            1
        );
    }

    #[test]
    fn a_database_written_before_the_cascade_is_swept_clean() {
        // Every database written before that fix still holds the rows, and
        // nothing else will ever remove them.
        let c = mem();
        upsert_project(&c, &pkg("p1", "Going")).unwrap();
        open_session(&c, "s1", "p1", "Operator").unwrap();
        insert_event(&c, &event("p1", "s1", "EDGE-FW-01", "192.0.2.10")).unwrap();
        // A database written before the constraints existed: with the pragma
        // off, the project row goes and its history stays, which is exactly
        // the state the real one was found in.
        c.pragma_update(None, "foreign_keys", "OFF").unwrap();
        c.execute("DELETE FROM projects WHERE id = 'p1'", []).unwrap();
        c.pragma_update(None, "foreign_keys", "ON").unwrap();

        let count = |sql: &str| -> i64 { c.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(count("SELECT COUNT(*) FROM events"), 1, "precondition");

        assert!(purge_orphans(&c).unwrap() >= 2);
        assert_eq!(count("SELECT COUNT(*) FROM events"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM validation_sessions"), 0);
        // Idempotent, since it runs at every start.
        assert_eq!(purge_orphans(&c).unwrap(), 0);
    }

    /// Test case 17: a saved project reloads with its diagram intact.
    #[test]
    fn round_trips_a_project_document() {
        let c = mem();
        upsert_project(&c, &pkg("p1", "Branch")).unwrap();
        let loaded = load_project(&c, "p1").unwrap().unwrap();
        assert_eq!(loaded.meta.ticket, "CHG-1001");
        assert_eq!(loaded.document["nodes"][0]["id"], "n1");
    }

    /// Test case 16: duplication yields independent rows.
    #[test]
    fn duplicate_is_independent() {
        let c = mem();
        upsert_project(&c, &pkg("p1", "Branch")).unwrap();
        let mut copy = load_project(&c, "p1").unwrap().unwrap();
        copy.meta.id = "p2".into();
        copy.meta.name = "Branch (copy)".into();
        upsert_project(&c, &copy).unwrap();

        let mut edited = load_project(&c, "p2").unwrap().unwrap();
        edited.document = serde_json::json!({ "nodes": [], "links": [] });
        upsert_project(&c, &edited).unwrap();

        assert_eq!(
            load_project(&c, "p1").unwrap().unwrap().document["nodes"][0]["id"],
            "n1"
        );
        assert_eq!(
            load_project(&c, "p2").unwrap().unwrap().document["nodes"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn events_are_scoped_and_ordered() {
        let c = mem();
        upsert_project(&c, &pkg("p1", "A")).unwrap();
        upsert_project(&c, &pkg("p2", "B")).unwrap();
        for (i, pid) in [("e1", "p1"), ("e2", "p1"), ("e3", "p2")] {
            insert_event(
                &c,
                &EventRow {
                    id: i.into(),
                    project_id: pid.into(),
                    session_id: Some("s1".into()),
                    timestamp_ms: i.len() as i64,
                    object_type: "node".into(),
                    object_id: "n1".into(),
                    object_name: "CORE-SW-01".into(),
                    event_type: "transition".into(),
                    previous_status: Some("healthy".into()),
                    current_status: Some("down".into()),
                    probe_type: Some("icmp".into()),
                    target: Some("10.10.20.2".into()),
                    rtt_ms: None,
                    message: "Request timed out".into(),
                },
            )
            .unwrap();
        }
        assert_eq!(list_events(&c, "p1", 100).unwrap().len(), 2);
        assert_eq!(list_events(&c, "p2", 100).unwrap().len(), 1);
    }

    #[test]
    fn deleting_a_project_removes_its_events() {
        let c = mem();
        upsert_project(&c, &pkg("p1", "A")).unwrap();
        insert_event(
            &c,
            &EventRow {
                id: "e1".into(),
                project_id: "p1".into(),
                session_id: None,
                timestamp_ms: 1,
                object_type: "node".into(),
                object_id: "n1".into(),
                object_name: "n".into(),
                event_type: "transition".into(),
                previous_status: None,
                current_status: Some("down".into()),
                probe_type: None,
                target: None,
                rtt_ms: None,
                message: String::new(),
            },
        )
        .unwrap();
        delete_project(&c, "p1").unwrap();
        assert!(list_events(&c, "p1", 100).unwrap().is_empty());
    }
}

#[cfg(test)]
mod document_round_trip {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().expect("in-memory database");
        migrate(&c).expect("schema");
        c
    }

    /// A document carrying every field the interface has added since this
    /// storage was written, plus one it has not.
    fn document() -> serde_json::Value {
        serde_json::json!({
            "nodes": [{
                "id": "n1",
                "type": "device",
                "position": { "x": 10.5, "y": -20.25 },
                "width": 176,
                "height": 96,
                "data": {
                    "label": "CORE-SW",
                    "deviceType": "core-switch",
                    "tags": ["site-hq"],
                    "addresses": [{ "id": "a", "label": "Mgmt", "address": "10.0.0.1", "isPrimary": true }],
                    "layers": ["logical"],
                    "locked": false,
                    "maintenance": false,
                    "showDetails": true,
                    "somethingAddedNextYear": { "deeply": ["nested", 1, true, null] }
                }
            }],
            "edges": [{
                "id": "e1",
                "source": "n1",
                "target": "n1",
                "data": {
                    "kind": "leader",
                    "lineStyle": "dash-dot",
                    "startCap": "circle",
                    "endCap": "open-arrow",
                    "colorMode": "fixed",
                    "color": "#b76eff",
                    "pinnedSides": true,
                    "layers": ["physical"]
                }
            }],
            "probes": [],
            "canvas": {
                "gridEnabled": true,
                "colourBy": "subnet",
                "lineJumps": false,
                "layers": [{ "id": "logical", "name": "Logical", "visible": false, "locked": true }]
            }
        })
    }

    fn package() -> ProjectPackage {
        ProjectPackage {
            meta: ProjectMeta {
                id: "p1".into(),
                name: "Round trip".into(),
                customer: String::new(),
                site: String::new(),
                ticket: String::new(),
                engineer: String::new(),
                description: String::new(),
                created_at: 1,
                updated_at: 2,
                archived: false,
            },
            document_version: 1,
            document: document(),
        }
    }

    #[test]
    fn a_document_comes_back_byte_for_byte() {
        // The diagram's shape belongs to the interface, and this layer stores
        // it as opaque JSON on purpose. If it were ever parsed into a typed
        // struct here, every field added to the interface after that struct
        // was written would be silently dropped on the next save — and the
        // person would find out when their diagram reopened without its
        // views, its leaders or its colours.
        let c = mem();
        upsert_project(&c, &package()).expect("save");
        let back = load_project(&c, "p1").expect("load").expect("a project");
        assert_eq!(back.document, document());
    }

    #[test]
    fn a_field_this_version_has_never_heard_of_survives() {
        let c = mem();
        upsert_project(&c, &package()).expect("save");
        let back = load_project(&c, "p1").expect("load").expect("a project");
        let node = &back.document["nodes"][0]["data"];
        assert_eq!(node["somethingAddedNextYear"]["deeply"][0], "nested");
    }

    #[test]
    fn saving_twice_does_not_erode_it() {
        // Round-tripping through the database and back has to be stable, or a
        // diagram loses a little each time it is opened and saved.
        let c = mem();
        upsert_project(&c, &package()).expect("save");
        let once = load_project(&c, "p1").expect("load").expect("a project");
        upsert_project(&c, &once).expect("save again");
        let twice = load_project(&c, "p1").expect("load").expect("a project");
        assert_eq!(twice.document, document());
    }

    #[test]
    fn numbers_keep_their_precision() {
        // A position rounded to an integer on every save walks a diagram out
        // of alignment over a few sessions.
        let c = mem();
        upsert_project(&c, &package()).expect("save");
        let back = load_project(&c, "p1").expect("load").expect("a project");
        assert_eq!(back.document["nodes"][0]["position"]["y"], -20.25);
    }

    /// LT-224: samples go in, come back oldest first within a window, and a
    /// probe keeps no more than its cap.
    #[test]
    fn probe_samples_round_trip_and_prune() {
        let c = Connection::open_in_memory().unwrap();
        super::migrate(&c).unwrap();
        c.execute("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P',0,0)", []).unwrap();
        super::open_session(&c, "s1", "p1", "").unwrap();
        for i in 0..5 {
            super::insert_sample(&c, &super::NewSample { session_id: "s1", probe_id: "p1", timestamp_ms: 1_000 + i, status: if i == 3 { "down" } else { "healthy" }, outcome: "success", rtt_ms: Some(i as f64), summary: "" }).unwrap();
        }
        super::insert_sample(&c, &super::NewSample { session_id: "s1", probe_id: "other", timestamp_ms: 1_002, status: "healthy", outcome: "success", rtt_ms: None, summary: "" }).unwrap();
        let got = super::samples_for(&c, "p1", "p1", 1_001, 3).unwrap();
        assert_eq!(got.iter().map(|s| s.timestamp_ms).collect::<Vec<_>>(), vec![1_002, 1_003, 1_004]);
        assert_eq!(got[1].status, "down");
        let removed: usize = c
            .execute(
                "DELETE FROM probe_samples WHERE probe_id = 'p1' AND id <= (SELECT id FROM probe_samples WHERE probe_id = 'p1' ORDER BY id DESC LIMIT 1 OFFSET 2)",
                [],
            )
            .unwrap();
        assert_eq!(removed, 3, "the same statement prune_samples runs, with a cap of two");
        assert_eq!(super::samples_for(&c, "p1", "p1", 0, 100).unwrap().len(), 2);
        assert_eq!(super::prune_samples(&c, "p1").unwrap(), 0, "under the real cap nothing more goes");
        // LT-455: a sample from another project's session is never read as this project's.
        c.execute("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p2','Q',0,0)", []).unwrap();
        super::open_session(&c, "s2", "p2", "").unwrap();
        super::insert_sample(&c, &super::NewSample { session_id: "s2", probe_id: "p1", timestamp_ms: 5_000, status: "down", outcome: "success", rtt_ms: None, summary: "" }).unwrap();
        assert_eq!(super::samples_for(&c, "p1", "p1", 0, 100).unwrap().len(), 2, "still only this project's");
        assert_eq!(super::samples_for(&c, "p1", "p2", 0, 100).unwrap().len(), 1);
    }

    /// LT-426: a project keeps its newest events and no more; another
    /// project's are not touched by the prune.
    #[test]
    fn events_are_capped_per_project() {
        let c = Connection::open_in_memory().unwrap();
        super::migrate(&c).unwrap();
        for (id, name) in [("p1", "A"), ("p2", "B")] {
            c.execute("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?1, ?2, 0, 0)", [id, name]).unwrap();
        }
        let row = |project: &str, i: i64| EventRow {
            id: format!("{project}-{i}"),
            project_id: project.into(),
            session_id: None,
            timestamp_ms: 1_000 + i,
            object_type: "node".into(),
            object_id: "n1".into(),
            object_name: "core".into(),
            event_type: "transition".into(),
            previous_status: None,
            current_status: Some("down".into()),
            probe_type: None,
            target: None,
            rtt_ms: None,
            message: String::new(),
        };
        for i in 0..(super::EVENTS_PER_PROJECT + 25) {
            super::insert_event(&c, &row("p1", i)).unwrap();
        }
        for i in 0..3 {
            super::insert_event(&c, &row("p2", i)).unwrap();
        }
        let removed = super::prune_events(&c, "p1").unwrap();
        assert_eq!(removed, 25, "everything past the cap goes");
        let count = |p: &str| -> i64 {
            c.query_row("SELECT COUNT(*) FROM events WHERE project_id = ?1", [p], |r| r.get(0)).unwrap()
        };
        assert_eq!(count("p1"), super::EVENTS_PER_PROJECT);
        assert_eq!(count("p2"), 3, "the other project is untouched");
        // What is kept is the newest.
        let oldest: i64 = c
            .query_row("SELECT MIN(timestamp_ms) FROM events WHERE project_id = 'p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(oldest, 1_000 + 25);
        assert_eq!(super::prune_events(&c, "p1").unwrap(), 0, "under the cap nothing more goes");
    }

    /// LT-430: a migration that fails leaves the version and the tables as
    /// they were, so the next start tries again rather than running on top
    /// of half a change.
    #[test]
    fn a_failing_migration_leaves_the_database_at_its_old_version() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute("UPDATE schema_info SET version = 1", []).unwrap();
        set_setting(&conn, "backupFolder", Some("/shared")).unwrap();

        fn adds_a_marker(c: &Connection) -> rusqlite::Result<()> {
            c.execute("INSERT INTO app_settings (key, value) VALUES ('migrated', 'yes')", [])?;
            Ok(())
        }
        fn fails(_: &Connection) -> rusqlite::Result<()> {
            Err(rusqlite::Error::InvalidQuery)
        }
        let steps: &[super::Migration] = &[(2, adds_a_marker), (2, fails)];
        assert!(super::apply_migrations(&conn, steps).is_err());

        let version: i64 = conn
            .query_row("SELECT version FROM schema_info LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 1, "the bump did not land");
        let shared = all_settings(&conn).unwrap();
        assert_eq!(shared.get("migrated"), None, "the step before the failure was rolled back");
        assert_eq!(shared.get("backupFolder").map(String::as_str), Some("/shared"), "nothing else moved");

        // And the real list still takes it the rest of the way.
        migrate(&conn).unwrap();
        let version: i64 = conn
            .query_row("SELECT version FROM schema_info LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    /// LT-226, LT-227: sessions summarise per probe, crawls are kept and capped.
    #[test]
    fn sessions_summarise_and_crawls_are_kept() {
        let c = Connection::open_in_memory().unwrap();
        super::migrate(&c).unwrap();
        c.execute("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P',0,0)", []).unwrap();
        super::open_session(&c, "s1", "p1", "").unwrap();
        for (i, (status, rtt)) in [("healthy", Some(10.0)), ("healthy", Some(20.0)), ("down", None), ("warning", Some(300.0))].iter().enumerate() {
            super::insert_sample(&c, &super::NewSample { session_id: "s1", probe_id: "probe-a", timestamp_ms: i as i64, status, outcome: "success", rtt_ms: *rtt, summary: "" }).unwrap();
        }
        let sum = super::session_summary(&c, "s1").unwrap();
        assert_eq!(sum.len(), 1);
        assert_eq!((sum[0].samples, sum[0].healthy, sum[0].warning, sum[0].down), (4, 2, 1, 1));
        assert_eq!(sum[0].avg_rtt_ms, Some(110.0));
        assert_eq!(sum[0].p95_rtt_ms, Some(300.0));
        let sessions = super::list_sessions(&c, "p1").unwrap();
        assert_eq!((sessions.len(), sessions[0].samples), (1, 4));

        for i in 0..(super::CRAWL_RUNS_KEPT + 3) {
            super::insert_crawl_run(&c, &format!("r{i}"), "p1", i, "192.0.2.1", 2, "{\"devices\":[]}").unwrap();
        }
        let runs = super::list_crawl_runs(&c, "p1").unwrap();
        assert_eq!(runs.len() as i64, super::CRAWL_RUNS_KEPT);
        assert_eq!(runs[0].id, format!("r{}", super::CRAWL_RUNS_KEPT + 2));
        let old = super::crawl_run_result(&c, &runs[0].id, "p1").unwrap().expect("kept");
        assert_eq!(old["devices"], serde_json::json!([]), "a run written before schema 3 reads as it was");
        assert_eq!(old["status"], "complete");
        assert!(super::crawl_run_result(&c, "r0", "p1").unwrap().is_none(), "the oldest went");
    }

    /// LT-424: a run is on disk from the moment it starts, device by device,
    /// so a process that dies under it leaves what it had found.
    #[test]
    fn a_run_written_as_it_goes_survives_the_process_dying() {
        let c = Connection::open_in_memory().unwrap();
        super::migrate(&c).unwrap();
        c.execute("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P',0,0)", []).unwrap();
        super::open_crawl_run(&c, "run-1", "p1", 10, "192.0.2.1").unwrap();
        for host in ["CORE", "DIST-A", "DIST-B"] {
            super::append_crawl_device(&c, "run-1", &format!("{{\"hostname\":\"{host}\",\"address\":\"192.0.2.1\"}}")).unwrap();
        }
        // No close: this is the process going down mid-crawl.
        let runs = super::list_crawl_runs(&c, "p1").unwrap();
        assert_eq!((runs.len(), runs[0].devices, runs[0].status.as_str()), (1, 3, "running"));
        let partial = super::crawl_run_result(&c, "run-1", "p1").unwrap().expect("readable before it is closed");
        assert!(super::crawl_run_result(&c, "run-1", "another").unwrap().is_none(), "LT-455: a run is read only from its own project");
        assert_eq!(partial["devices"].as_array().map(Vec::len), Some(3));
        assert_eq!(partial["devices"][1]["hostname"], "DIST-A", "in the order they were reached");
        assert_eq!(partial["failures"], serde_json::json!([]));
        assert_eq!(partial["cancelled"], false);

        // The next start finds it and says what happened to it.
        assert_eq!(super::mark_abandoned_runs(&c).unwrap(), 1);
        let after = super::crawl_run_result(&c, "run-1", "p1").unwrap().unwrap();
        assert_eq!(after["status"], "aborted");
        assert_eq!(after["devices"].as_array().map(Vec::len), Some(3), "nothing was thrown away");
        assert_eq!(super::mark_abandoned_runs(&c).unwrap(), 0);

        // A run that ends properly carries its summary and its status.
        super::open_crawl_run(&c, "run-2", "p1", 20, "192.0.2.1").unwrap();
        super::append_crawl_device(&c, "run-2", "{\"hostname\":\"CORE\"}").unwrap();
        super::close_crawl_run(&c, "run-2", "cancelled", "{\"failures\":[{\"address\":\"192.0.2.9\"}],\"notVisited\":[],\"cancelled\":true}").unwrap();
        let done = super::crawl_run_result(&c, "run-2", "p1").unwrap().unwrap();
        assert_eq!((done["status"].as_str(), done["cancelled"].as_bool()), (Some("cancelled"), Some(true)));
        assert_eq!(done["failures"][0]["address"], "192.0.2.9");
        assert_eq!(done["devices"][0]["hostname"], "CORE");

        // Pruning a run takes its devices with it.
        for i in 0..super::CRAWL_RUNS_KEPT {
            super::open_crawl_run(&c, &format!("later-{i}"), "p1", 100 + i, "x").unwrap();
        }
        assert!(super::crawl_run_result(&c, "run-1", "p1").unwrap().is_none());
        let orphans: i64 = c.query_row("SELECT COUNT(*) FROM crawl_run_devices WHERE run_id = 'run-1'", [], |r| r.get(0)).unwrap();
        assert_eq!(orphans, 0, "the cascade took the devices");
    }
}
#[cfg(test)]
mod credential_use_log {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().expect("in-memory database");
        migrate(&c).expect("schema");
        c
    }

    /// LT-264: uses roll up by the hour per credential, purpose and target;
    /// a new hour or a new device is a new line; the label is kept even after
    /// the credential goes.
    #[test]
    fn uses_are_logged_rolled_up_by_the_hour() {
        let c = mem();
        let hour = CREDENTIAL_USE_ROLLUP_MS;
        record_credential_use(&c, "cred-1", "SNMP uptime check", "192.0.2.10", 1_000).unwrap();
        record_credential_use(&c, "cred-1", "SNMP uptime check", "192.0.2.10", 1_000 + hour / 2).unwrap();
        record_credential_use(&c, "cred-1", "SNMP uptime check", "192.0.2.11", 2_000).unwrap();
        record_credential_use(&c, "cred-1", "SNMP uptime check", "192.0.2.10", 1_000 + hour * 2).unwrap();
        record_credential_use(&c, "cred-2", "Backup", "CORE-SW1 (192.0.2.10)", 3_000).unwrap();

        let one = list_credential_use(&c, Some("cred-1"), 100).unwrap();
        assert_eq!(one.len(), 3);
        assert_eq!((one[0].target.as_str(), one[0].uses), ("192.0.2.10", 1), "a later hour is a new line");
        let rolled = one.iter().find(|r| r.uses == 2).expect("rolled up");
        assert_eq!((rolled.first_ms, rolled.last_ms), (1_000, 1_000 + hour / 2));
        assert_eq!(list_credential_use(&c, None, 100).unwrap().len(), 4);
        assert_eq!(clear_credential_use(&c).unwrap(), 4);
        assert!(list_credential_use(&c, None, 100).unwrap().is_empty());
    }
}
