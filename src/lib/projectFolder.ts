/**
 * A project written as a folder for version control (LT-255): the package as
 * JSON, which Coreview opens, and the same content as YAML, which a person
 * reads in a diff.
 *
 * Keys are written in a fixed order — sorted — at every level, so saving a
 * project that has not changed writes identical files and a real change is
 * the only thing a commit shows. Saved credentials are never part of it: a
 * folder like this is made to be pushed somewhere.
 */
import { stringify } from 'yaml';

/** The same value with every object's keys in sorted order. */
export function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortedKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function projectFolderFiles(pkg: Record<string, unknown>): { json: string; yaml: string } {
  // Never the vault, even if a caller passes a package that carries one.
  const { vault: _vault, ...rest } = pkg;
  void _vault;
  const stable = sortedKeys(rest);
  return {
    json: `${JSON.stringify(stable, null, 2)}\n`,
    yaml:
      '# A readable copy of project.coreview, written by Coreview for version control.\n' +
      '# Coreview opens the .coreview file; edits made here are not read back.\n' +
      stringify(stable, { lineWidth: 0, minContentWidth: 0, aliasDuplicateObjects: false }),
  };
}
