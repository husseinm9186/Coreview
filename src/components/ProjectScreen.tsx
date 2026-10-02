import { useEffect, useRef, useState } from 'react';

import { useStore, type ProjectDocument } from '../state/store';
import { SAMPLES } from '../lib/samples';
import { readSummary } from '../lib/projectSummary';
import { STATUS_COLOR } from './edges/LiveEdge';
import { TEMPLATES, templateById } from '../lib/templates';
import { ipc, isDesktop } from '../lib/ipc';
import { FolderSettings } from './FolderSettings';
import { HostKeySettings } from './HostKeySettings';
import { VaultSettings } from './VaultSettings';
import type { ProjectMeta } from '../types/domain';
import { t } from '../i18n';
import {
  childFolders,
  destinations,
  pathLabel,
  pathTo,
  projectCountWithin,
  projectsIn,
  subtreeIds,
  type ProjectFolder,
} from '../lib/projectFolders';

export function ProjectScreen() {
  const projects = useStore((s) => s.projects);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ProjectMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Set when an imported package turned out to carry credentials, so the
  // passphrase can be asked for after the project itself is safely in.
  const [pending, setPending] = useState<{
    meta: ProjectMeta;
    document: ProjectDocument;
    vault?: unknown;
  } | null>(null);
  const [vaultPassphrase, setVaultPassphrase] = useState('');
  const [vaultNote, setVaultNote] = useState<string | null>(null);

  useEffect(() => {
    void useStore.getState().refreshProjects();
    // The chosen folders live in the database, so they have to be read back
    // before anything can use them.
    void useStore.getState().loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // LT-485: one folder at a time. Archived projects stay one flat list, each
  // with the folder it is filed in.
  const tree = useStore((s) => s.folderTree);
  const here = useStore((s) => s.projectFolderId);
  const setHere = useStore((s) => s.setProjectFolder);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmFolder, setConfirmFolder] = useState<ProjectFolder | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [folderProblem, setFolderProblem] = useState<string | null>(null);
  const live = projects.filter((p) => !p.archived);
  const visible = showArchived ? projects.filter((p) => p.archived) : projectsIn(tree, live, here);
  // LT-679: a search across what is shown — name, customer, site, ticket.
  const [search, setSearch] = useState('');
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? visible.filter((p) => [p.name, p.customer, p.site, p.ticket].some((v) => (v ?? '').toLowerCase().includes(needle)))
    : visible;
  const folders = showArchived ? [] : childFolders(tree, here);
  const crumbs = pathTo(tree, here);

  /** Runs one folder change, then reads the tree back; a refusal is shown. */
  const folderAction = (run: () => Promise<void>) => {
    setFolderProblem(null);
    void run()
      .then(() => useStore.getState().refreshProjects())
      .catch((e: unknown) => setFolderProblem(e instanceof Error ? e.message : String(e)));
  };
  const createFolder = () => {
    const name = (newFolder ?? '').trim();
    if (!name) return;
    folderAction(async () => {
      await ipc.createProjectFolder(name, here);
      setNewFolder(null);
    });
  };
  const renameFolder = () => {
    if (!renaming) return;
    const { id, name } = renaming;
    folderAction(async () => {
      await ipc.renameProjectFolder(id, name);
      setRenaming(null);
    });
  };
  /** A project or a folder dropped on a folder (or on a breadcrumb). */
  const dropOn = (target: string | null, e: React.DragEvent) => {
    e.preventDefault();
    setDropTarget(null);
    const projectId = e.dataTransfer.getData('application/x-coreview-project');
    const folderId = e.dataTransfer.getData('application/x-coreview-folder');
    if (projectId) folderAction(() => ipc.moveProjectToFolder(projectId, target));
    else if (folderId && folderId !== target) folderAction(() => ipc.moveProjectFolder(folderId, target));
  };
  const dropProps = (target: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDropTarget(target ?? '');
    },
    onDragLeave: () => setDropTarget(null),
    onDrop: (e: React.DragEvent) => dropOn(target, e),
  });
  const isDropTarget = (target: string | null) => dropTarget === (target ?? '');

  type Package = { meta: ProjectMeta; document: ProjectDocument; vault?: unknown };

  const openImported = (pkg: Package) =>
    useStore.getState().createProject(
      { ...pkg.meta, name: `${pkg.meta.name} (imported)` },
      pkg.document as ProjectDocument,
    );

  const readPackage = async (text: string) => {
    const pkg = JSON.parse(text) as Package;
    if (!pkg?.meta?.name || !pkg.document) throw new Error('missing project metadata');
    // A package carrying credentials asks about them here, before the project
    // opens — creating it first would navigate away from this screen and the
    // question would never be seen. Either answer still opens the project, so
    // a refused or failed credential import never costs the diagram.
    if (pkg.vault) {
      setPending(pkg);
      setVaultPassphrase('');
      setVaultNote(null);
      return;
    }
    await openImported(pkg);
  };

  const failedImport = (err: unknown) =>
    setError(
      `That file could not be read as a Coreview project (${
        err instanceof Error ? err.message : String(err)
      }). Choose a .coreview file exported from Coreview (.livetopo files from before the rename still work).`,
    );

  /** Native dialog, then a backend read.
   *
   *  This was an `<input type="file" accept=".coreview,...">`, which does not
   *  work on Linux: WebKitGTK turns the accept list into a filter that matches
   *  nothing when the extension has no registered MIME type, so the dialog
   *  opened on an empty folder with Open greyed out and no way to proceed. */
  const importFromDialog = async () => {
    setError(null);
    try {
      const path = await ipc.pickProjectFile();
      if (!path) return;
      await readPackage(await ipc.readImport(path));
    } catch (err) {
      failedImport(err);
    }
  };

  /** Browser fallback, where there is no native dialog. */
  const importPackage = async (file: File) => {
    setError(null);
    try {
      await readPackage(await file.text());
    } catch (err) {
      failedImport(err);
    }
  };

  const importCredentials = () => {
    if (!pending) return;
    const pkg = pending;
    setVaultNote(null);
    void ipc
      .importVault(pkg.vault, vaultPassphrase)
      .then(async (n) => {
        setPending(null);
        setVaultPassphrase('');
        await openImported(pkg);
        useStore.getState().setStatusMessage(
          `Imported ${t('plural.credential', { count: n })}, re-sealed with this machine's passphrase.`,
        );
      })
      .catch((e: unknown) => setVaultNote(e instanceof Error ? e.message : String(e)));
  };

  const skipCredentials = () => {
    if (!pending) return;
    const pkg = pending;
    setPending(null);
    setVaultPassphrase('');
    void openImported(pkg).then(() =>
      useStore.getState().setStatusMessage('Credentials left in the file. The project was imported without them.'),
    );
  };

  return (
    <div className="cv-welcome">
      <div className="cv-welcome-inner">
        <header className="cv-welcome-head">
          <h1>{t('projectScreen.coreview')}</h1>
          <p>
            {t('projectScreen.drawTheTopologyYou')}
          </p>
        </header>

        <div className="cv-welcome-actions">
          <button type="button" className="cv-btn cv-btn-start" onClick={() => setCreating(true)}>
            {t('projectScreen.createProject')}
          </button>
          <button
            type="button"
            className="cv-btn"
            onClick={() => (isDesktop ? void importFromDialog() : fileRef.current?.click())}
          >
            {t('projectScreen.importProject')}
          </button>
          {!isDesktop && (
            <input
              ref={fileRef}
              type="file"
              accept=".coreview,.livetopo,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importPackage(f);
                e.target.value = '';
              }}
            />
          )}
          <label className="cv-check cv-check-inline">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            {t('projectScreen.showArchived')}
          </label>
        </div>

        {error && <p className="cv-error">{error}</p>}

        {pending != null && (
          <section className="cv-welcome-section cv-import-vault">
            <h2>{t('projectScreen.thisPackageAlsoCarries')}</h2>
            <p className="cv-help">
              {t('projectScreen.theyAreSealedWith')}
            </p>
            <div className="cv-discover-form">
              <label className="cv-field">
                <span>{t('projectScreen.passphraseOfTheExporting')}</span>
                <input
                  className="cv-input"
                  type="password"
                  value={vaultPassphrase}
                  autoComplete="off"
                  onChange={(e) => setVaultPassphrase(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && vaultPassphrase && importCredentials()}
                />
              </label>
              <button
                type="button"
                className="cv-btn cv-btn-start"
                onClick={importCredentials}
                disabled={!vaultPassphrase}
              >
                {t('projectScreen.importCredentials')}
              </button>
              <button type="button" className="cv-btn" onClick={skipCredentials}>
                {t('projectScreen.skipThem')}
              </button>
            </div>
          </section>
        )}

        {vaultNote && <p className="cv-help cv-hostkey-message">{vaultNote}</p>}

        {/* LT-679: folders down the left, the projects as cards, the samples
            on the right. The crumbs, drag-and-drop, rename and delete of
            LT-485 are as they were, inside the middle column. */}
        <div className="cv-proj">
        <aside className="cv-proj-side" aria-label={t('projectScreen.folders')} data-region="project-folders">
          <button type="button" className={`cv-proj-side-item${!showArchived && here === null ? ' is-current' : ''}`}
            aria-current={!showArchived && here === null ? 'true' : undefined}
            onClick={() => { setShowArchived(false); setHere(null); }}>
            <span>{t('projectScreen.allProjects')}</span>
            <span className="cv-proj-side-count">{live.length}</span>
          </button>
          {childFolders(tree, null).map((f) => {
            const current = !showArchived && (here === f.id || crumbs.some((c) => c.id === f.id));
            return (
              <button key={f.id} type="button" className={`cv-proj-side-item${current ? ' is-current' : ''}`}
                aria-current={current ? 'true' : undefined}
                onClick={() => { setShowArchived(false); setHere(f.id); }}>
                <span><span className="cv-pfolder-glyph" aria-hidden="true">▸</span> {f.name}</span>
                <span className="cv-proj-side-count">{projectCountWithin(tree, live, f.id)}</span>
              </button>
            );
          })}
          <button type="button" className={`cv-proj-side-item${showArchived ? ' is-current' : ''}`}
            aria-current={showArchived ? 'true' : undefined}
            onClick={() => setShowArchived(true)}>
            <span>{t('projectScreen.archived')}</span>
            <span className="cv-proj-side-count">{projects.filter((p) => p.archived).length}</span>
          </button>
        </aside>
        <div className="cv-proj-main">
        <input className="cv-input cv-proj-search" type="search" value={search} placeholder={t('projectScreen.search')}
          aria-label={t('projectScreen.search')} title={t('projectScreen.searchHint')}
          onChange={(e) => setSearch(e.target.value)} />
        <section className="cv-welcome-section" data-region="projects">
          <div className="cv-pfolder-head">
            <h2>{showArchived ? 'Archived projects' : crumbs.length ? crumbs[crumbs.length - 1]!.name : 'Recent projects'}</h2>
            {!showArchived && isDesktop && newFolder === null && (
              <button type="button" className="cv-btn cv-btn-small" onClick={() => setNewFolder('')}>
                {t('folders.new')}
              </button>
            )}
          </div>

          {/* LT-485: where this is, and the way back up. Each crumb is also a
              place to drop a project or a folder. */}
          {!showArchived && crumbs.length > 0 && (
            <nav className="cv-pfolder-crumbs" aria-label={t('folders.path')}>
              <button type="button" className={`cv-pfolder-crumb${isDropTarget(null) ? ' is-drop' : ''}`}
                onClick={() => setHere(null)} {...dropProps(null)}>
                {t('folders.top')}
              </button>
              {crumbs.map((f, i) => (
                <span key={f.id} className="cv-pfolder-crumb-step">
                  <span aria-hidden="true"> › </span>
                  {i === crumbs.length - 1 ? (
                    <span className="cv-pfolder-crumb is-here" aria-current="page">{f.name}</span>
                  ) : (
                    <button type="button" className={`cv-pfolder-crumb${isDropTarget(f.id) ? ' is-drop' : ''}`}
                      onClick={() => setHere(f.id)} {...dropProps(f.id)}>
                      {f.name}
                    </button>
                  )}
                </span>
              ))}
            </nav>
          )}

          {newFolder !== null && (
            <div className="cv-pfolder-new">
              <input className="cv-input" autoFocus value={newFolder} maxLength={80}
                aria-label={t('folders.name')} placeholder={t('folders.name')}
                onChange={(e) => setNewFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createFolder();
                  if (e.key === 'Escape') setNewFolder(null);
                }} />
              <button type="button" className="cv-btn cv-btn-small cv-btn-start" disabled={!newFolder.trim()} onClick={createFolder}>
                {t('folders.create')}
              </button>
              <button type="button" className="cv-btn cv-btn-small" onClick={() => setNewFolder(null)}>{t('folders.cancel')}</button>
            </div>
          )}
          {folderProblem && <p className="cv-error cv-pfolder-problem">{folderProblem}</p>}

          {visible.length === 0 && folders.length === 0 ? (
            <p className="cv-help">
              {showArchived
                ? 'Nothing archived.'
                : here
                  ? t('folders.empty')
                  : 'No projects yet. Create one, or open a sample below to see how validation works.'}
            </p>
          ) : (
            <ul className="cv-project-list">
              {folders.map((f) => (
                <li key={f.id} className={`cv-pfolder-row${isDropTarget(f.id) ? ' is-drop' : ''}`} data-folder={f.id}
                  draggable={renaming?.id !== f.id}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-coreview-folder', f.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  {...dropProps(f.id)}>
                  {renaming?.id === f.id ? (
                    <div className="cv-pfolder-new">
                      <input className="cv-input" autoFocus value={renaming.name} maxLength={80} aria-label={t('folders.name')}
                        onChange={(e) => setRenaming({ id: f.id, name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') renameFolder();
                          if (e.key === 'Escape') setRenaming(null);
                        }} />
                      <button type="button" className="cv-btn cv-btn-small cv-btn-start" disabled={!renaming.name.trim()} onClick={renameFolder}>
                        {t('folders.rename')}
                      </button>
                      <button type="button" className="cv-btn cv-btn-small" onClick={() => setRenaming(null)}>{t('folders.cancel')}</button>
                    </div>
                  ) : (
                    <button type="button" className="cv-project-open cv-pfolder-open" onClick={() => setHere(f.id)}>
                      <span className="cv-project-title"><span className="cv-pfolder-glyph" aria-hidden="true">▸</span> {f.name}</span>
                      <span className="cv-project-meta">
                        {t('folders.contents', { count: projectCountWithin(tree, live, f.id) })}
                        {childFolders(tree, f.id).length > 0 && ` · ${t('folders.subfolders', { count: childFolders(tree, f.id).length })}`}
                      </span>
                    </button>
                  )}
                  <div className="cv-project-tools">
                    <select className="cv-input cv-pfolder-move" value="" aria-label={t('folders.moveFolder', { name: f.name })}
                      onChange={(e) => {
                        const to = e.target.value;
                        if (to) folderAction(() => ipc.moveProjectFolder(f.id, to === '\u0000top' ? null : to));
                      }}>
                      <option value="">{t('folders.moveTo')}</option>
                      {here !== null && <option value={'\u0000top'}>{t('folders.top')}</option>}
                      {destinations(tree, f.id)
                        .filter((d) => d.id !== here)
                        .map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                    </select>
                    <button type="button" className="cv-btn cv-btn-small" onClick={() => setRenaming({ id: f.id, name: f.name })}>
                      {t('folders.rename')}
                    </button>
                    <button type="button" className="cv-btn cv-btn-small is-danger" onClick={() => setConfirmFolder(f)}>
                      {t('folders.delete')}
                    </button>
                  </div>
                </li>
              ))}
              {needle && shown.length === 0 && (
                <li className="cv-help">{t('projectScreen.noMatch')}</li>
              )}
              {shown.map((p) => (
                <li key={p.id} data-project={p.id} className="cv-project-card"
                  draggable={!showArchived && tree.folders.length > 0}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-coreview-project', p.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}>
                  <button
                    type="button"
                    className="cv-project-open"
                    onClick={() => void useStore.getState().openProject(p.id)}
                  >
                    <span className="cv-project-title">{p.name}</span>
                    <span className="cv-project-meta">
                      {[p.customer, p.site, p.ticket].filter(Boolean).join(' · ') || 'No metadata'}
                      {showArchived && tree.placement[p.id] && ` · ${t('folders.in', { path: pathLabel(tree, tree.placement[p.id]!) })}`}
                    </span>
                    {/* LT-679: how it stood when it was last saved here. */}
                    <ProjectHealth id={p.id} />
                    <span className="cv-project-date">
                      Modified {new Date(p.updatedAt).toLocaleString()}
                    </span>
                  </button>
                  <div className="cv-project-tools">
                    {!showArchived && tree.folders.length > 0 && (
                      <select className="cv-input cv-pfolder-move" value="" aria-label={t('folders.moveProject', { name: p.name })}
                        onChange={(e) => {
                          const to = e.target.value;
                          if (to) folderAction(() => ipc.moveProjectToFolder(p.id, to === '\u0000top' ? null : to));
                        }}>
                        <option value="">{t('folders.moveTo')}</option>
                        {here !== null && <option value={'\u0000top'}>{t('folders.top')}</option>}
                        {destinations(tree)
                          .filter((d) => d.id !== here)
                          .map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                      </select>
                    )}
                    <button
                      type="button"
                      className="cv-btn cv-btn-small"
                      onClick={() => void useStore.getState().duplicateProject(p.id)}
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      className="cv-btn cv-btn-small"
                      onClick={() =>
                        void ipc
                          .setArchived(p.id, !p.archived)
                          .then(() => useStore.getState().refreshProjects())
                      }
                    >
                      {p.archived ? 'Restore' : 'Archive'}
                    </button>
                    <button
                      type="button"
                      className="cv-btn cv-btn-small is-danger"
                      onClick={() => setConfirmDelete(p)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        </div>

        <aside className="cv-proj-samples">
        <section className="cv-welcome-section">
          <h2>{t('projectScreen.startFromASample')}</h2>
          <p className="cv-help">
            {t('projectScreen.samplesUseDocumentationAddress')}
          </p>
          <div className="cv-sample-grid">
            {SAMPLES.map((s) => (
              <button
                key={s.name}
                type="button"
                className="cv-sample"
                onClick={() =>
                  void useStore.getState().createProject(
                    { name: s.name, customer: 'Example Customer', site: 'Example site', engineer: '' },
                    s.build(),
                  )
                }
              >
                <span className="cv-sample-title">{s.name.replace('Sample — ', '')}</span>
                <span className="cv-sample-desc">{s.description}</span>
              </button>
            ))}
          </div>
        </section>
        </aside>
        </div>

        <FolderSettings />

        <VaultSettings />

        <HostKeySettings />

        <footer className="cv-welcome-foot">
          {t('projectScreen.coreviewRunsEveryCheck')}
        </footer>
      </div>

      {creating && <CreateDialog onClose={() => setCreating(false)} />}
      {/* LT-485: a folder is deleted; nothing in it is. */}
      {confirmFolder && (() => {
        const inside = subtreeIds(tree, confirmFolder.id);
        const sub = inside.size - 1;
        const count = projectCountWithin(tree, projects, confirmFolder.id);
        const parent = pathLabel(tree, confirmFolder.parentId) || t('folders.top');
        return (
          <div className="cv-modal-backdrop" role="presentation">
            <div className="cv-modal" role="dialog" aria-label={t('folders.confirmDelete')}>
              <h2>{t('folders.deleteTitle', { name: confirmFolder.name })}</h2>
              <p>{t('folders.deleteBody', { projects: t('folders.projectCount', { count }), folders: t('folders.folderCount', { count: sub }), parent })}</p>
              <div className="cv-modal-actions">
                <button type="button" className="cv-btn" onClick={() => setConfirmFolder(null)}>{t('folders.keep')}</button>
                <button type="button" className="cv-btn is-danger" onClick={() => {
                  const id = confirmFolder.id;
                  setConfirmFolder(null);
                  folderAction(() => ipc.deleteProjectFolder(id));
                }}>
                  {t('folders.deleteConfirm')}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      {confirmDelete && (
        <div className="cv-modal-backdrop" role="presentation">
          <div className="cv-modal" role="dialog" aria-label={t('projectScreen.confirmDelete')}>
            <h2>Delete “{confirmDelete.name}”?</h2>
            <p>
              {t('projectScreen.thisRemovesTheDiagram')}
            </p>
            <div className="cv-modal-actions">
              <button type="button" className="cv-btn" onClick={() => setConfirmDelete(null)}>
                {t('projectScreen.keepProject')}
              </button>
              <button
                type="button"
                className="cv-btn is-danger"
                onClick={() => {
                  void useStore.getState().deleteProject(confirmDelete.id);
                  setConfirmDelete(null);
                }}
              >
                {t('projectScreen.deletePermanently')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** LT-679: the card's health line — devices, pages, and how the checks stood at the last save. */
function ProjectHealth({ id }: { id: string }) {
  const s = readSummary(id);
  if (!s) return null;
  const dot = (status: 'healthy' | 'warning' | 'down', n: number) => (
    <span className="cv-project-health-part">
      <i className="cv-health-dot" style={{ background: STATUS_COLOR[status] }} aria-hidden="true" /> {n} {status}
    </span>
  );
  return (
    <span className="cv-project-health" data-region="project-health">
      {s.devices > 0 ? (
        <>
          {dot('healthy', s.healthy)} · {dot('warning', s.warning)} · {dot('down', s.down)} ·{' '}
          {t('projectScreen.counts', { count: s.devices })} · {t('projectScreen.pages', { count: s.pages })}
        </>
      ) : (
        <>{t('projectScreen.counts', { count: 0 })} · {t('projectScreen.pages', { count: s.pages })}</>
      )}
    </span>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const create = useStore((s) => s.createProject);
  const [form, setForm] = useState({
    name: '',
    customer: '',
    site: '',
    ticket: '',
    engineer: '',
    description: '',
  });
  // LT-187: what the first page starts with.
  const [template, setTemplate] = useState('blank');
  const chosen = templateById(template);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <div className="cv-modal-backdrop" onClick={onClose} role="presentation">
      <div className="cv-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t('projectScreen.createProject')}>
        <h2>{t('projectScreen.newProject')}</h2>
        <label className="cv-field">
          <span className="cv-field-label">{t('projectScreen.projectName')}</span>
          <input className="cv-input" autoFocus value={form.name} onChange={set('name')} />
        </label>
        <div className="cv-row">
          <label className="cv-field">
            <span className="cv-field-label">{t('projectScreen.customer')}</span>
            <input className="cv-input" value={form.customer} onChange={set('customer')} />
          </label>
          <label className="cv-field">
            <span className="cv-field-label">{t('projectScreen.site')}</span>
            <input className="cv-input" value={form.site} onChange={set('site')} />
          </label>
        </div>
        <div className="cv-row">
          <label className="cv-field">
            <span className="cv-field-label">{t('projectScreen.changeTicket')}</span>
            <input className="cv-input" value={form.ticket} onChange={set('ticket')} />
          </label>
          <label className="cv-field">
            <span className="cv-field-label">{t('projectScreen.engineer')}</span>
            <input className="cv-input" value={form.engineer} onChange={set('engineer')} />
          </label>
        </div>
        <label className="cv-field">
          <span className="cv-field-label">{t('projectScreen.description')}</span>
          <textarea className="cv-input" rows={3} value={form.description} onChange={set('description')} />
        </label>
        <label className="cv-field">
          <span className="cv-field-label">{t('projectScreen.startFrom')}</span>
          <select className="cv-input" value={template} onChange={(e) => setTemplate(e.target.value)}>
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <span className="cv-help">
            {chosen?.description} Names and addresses are placeholders from the documentation ranges; nothing is monitored until you add it.
          </span>
        </label>
        <div className="cv-modal-actions">
          <button type="button" className="cv-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="cv-btn cv-btn-start"
            disabled={!form.name.trim()}
            onClick={() => {
              void create(form, template === 'blank' ? undefined : chosen?.build());
              onClose();
            }}
          >
            {t('projectScreen.createProject')}
          </button>
        </div>
      </div>
    </div>
  );
}
