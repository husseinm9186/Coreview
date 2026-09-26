import { useStore } from '../state/store';
import { isDesktop } from '../lib/ipc';
import { t } from '../i18n';

/**
 * Where Coreview writes things, chosen once and remembered.
 *
 * The two folders are deliberately separate and the copy says so. A running
 * configuration contains SNMP communities, hashed local passwords and ACLs;
 * an export is a diagram meant to be shared. Writing them to the same place is
 * how a backup ends up attached to an email.
 */
export function FolderSettings() {
  const settings = useStore((s) => s.settings);
  const { backupFolder, exportFolder } = settings;

  if (!isDesktop) {
    return (
      <section className="cv-folders">
        <h2>{t('folderSettings.folders')}</h2>
        <p className="cv-help">
          {t('folderSettings.choosingFoldersNeedsThe')}
        </p>
      </section>
    );
  }

  const row = (
    which: 'backupFolder' | 'exportFolder',
    title: string,
    value: string | null,
    unsetHint: string,
    note: string,
  ) => (
    <div className="cv-folder-row">
      <div className="cv-folder-head">
        <span className="cv-folder-title">{title}</span>
        <span className="cv-folder-actions">
          <button type="button" className="cv-btn cv-btn-small" onClick={() => void useStore.getState().chooseFolder(which)}>
            {value ? 'Change' : 'Choose folder'}
          </button>
          {value && (
            <button type="button" className="cv-btn cv-btn-small" onClick={() => void useStore.getState().clearFolder(which)}>
              Clear
            </button>
          )}
        </span>
      </div>
      <code className={value ? 'cv-folder-path' : 'cv-folder-path is-unset'}>
        {value ?? unsetHint}
      </code>
      <p className="cv-help">{note}</p>
    </div>
  );

  return (
    <section className="cv-folders">
      <h2>{t('folderSettings.folders')}</h2>
      {row(
        'backupFolder',
        'Configuration backups',
        backupFolder,
        'Not chosen yet',
        'Device configurations are written here, one folder per device. Nothing else writes ' +
          'into it — exporting a project never touches this folder, so a configuration cannot ' +
          'leave inside a diagram you share.',
      )}
      {row(
        'exportFolder',
        'Exports',
        exportFolder,
        'Ask me each time',
        'Diagrams, reports and project packages are saved straight here. Leave it unset to be ' +
          'asked where to put each one.',
      )}
    </section>
  );
}
