import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

import { en } from './en';
import { addCatalogue, locale, setLocale, t } from './index';

/** Every `t('key'` literal in the source, by file. */
function usedKeys(dir: string, out = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) usedKeys(path, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts')) {
      for (const m of readFileSync(path, 'utf8').matchAll(/\bt\(\s*'([\w.]+)'/g)) out.set(m[1]!, path);
    }
  }
  return out;
}

describe('translatable text (LT-272)', () => {
  afterEach(() => setLocale('en'));

  it('has an English message for every key the app uses', () => {
    const used = usedKeys(fileURLToPath(new URL('..', import.meta.url)));
    expect(used.size).toBeGreaterThan(0);
    for (const [key, file] of used) expect(key in en, `${key} in ${file}`).toBe(true);
  });

  it('fills placeholders and leaves a missing one visible', () => {
    expect(t('tour.progress', { done: 2, total: 6 })).toBe('2 of 6');
    expect(t('tour.progress', { done: 2 })).toBe('2 of {total}');
  });

  it('chooses the plural form the language needs', () => {
    expect(t('report.drawings', { count: 1 })).toMatch(/^1 page of/);
    expect(t('report.drawings', { count: 3 })).toMatch(/^3 pages of/);
  });

  it('falls back to English, and from a region to its language', () => {
    addCatalogue('fr', { 'tour.hide': 'Masquer la visite' });
    setLocale('fr-CA');
    expect(locale()).toBe('fr');
    expect(t('tour.hide')).toBe('Masquer la visite');
    expect(t('tour.label')).toBe('Guided tour');
    setLocale('xx');
    expect(locale()).toBe('en');
  });
});
