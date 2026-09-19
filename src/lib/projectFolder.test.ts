import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { projectFolderFiles, sortedKeys } from './projectFolder';

describe('a project as a folder (LT-255)', () => {
  const pkg = { project: { name: 'Lab', id: 'p1' }, document: { pages: [{ name: 'Core', nodes: [{ id: 'n1', data: { label: 'CORE-SW1', notes: 'line one\nline two' } }] }] }, vault: { secret: 'x' } };

  it('writes the same content twice, key order fixed, and never the vault', () => {
    const a = projectFolderFiles(pkg);
    const b = projectFolderFiles({ vault: 1, document: pkg.document, project: { id: 'p1', name: 'Lab' } });
    expect(a).toEqual(b);
    expect(a.json).not.toContain('vault');
    expect(a.yaml).not.toContain('vault');
    expect(a.json.indexOf('"document"')).toBeLessThan(a.json.indexOf('"project"'));
  });

  it('is YAML that reads back to exactly the JSON', () => {
    const { json, yaml } = projectFolderFiles(pkg);
    expect(parse(yaml)).toEqual(JSON.parse(json));
    expect(yaml.startsWith('# A readable copy')).toBe(true);
  });

  it('sorts nested keys and keeps arrays in order', () => {
    expect(JSON.stringify(sortedKeys({ b: [{ z: 1, a: 2 }, 3], a: undefined, c: null }))).toBe('{"b":[{"a":2,"z":1},3],"c":null}');
  });
});
