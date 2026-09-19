import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FILE_PATTERN,
  describeCapture,
  describeStamp,
  patternProblem,
  previewFileName,
} from './fileNames';

// Invented names and RFC 5737 addresses only (D-027).
const dev = { name: 'LAB-SW-A', address: '192.0.2.10', site: 'Lab Two' };

describe('capture filename patterns (LT-151)', () => {
  it('names files exactly as before by default', () => {
    expect(previewFileName('', dev, '20260828-101530', 'running-config')).toBe(
      '20260828-101530-running-config.txt',
    );
    expect(previewFileName(DEFAULT_FILE_PATTERN, dev, '20260828-101530', 'show-commands')).toBe(
      '20260828-101530-show-commands.txt',
    );
  });

  it('fills every token, matching the backend byte for byte', () => {
    // The same case as backup.rs `a_pattern_fills_every_token_from_the_device`.
    expect(
      previewFileName(
        '{site}_{device}_{date}_{address}_{stamp}_{kind}',
        { name: 'EDGE-01', address: '192.0.2.7', site: 'Lab Two' },
        '20260828-101530',
        'running-config',
      ),
    ).toBe('Lab-Two_EDGE-01_2026-08-28_192.0.2.7_20260828-101530_running-config.txt');
  });

  it('refuses a pattern that would overwrite, or has a typo', () => {
    expect(patternProblem('')).toBeNull();
    expect(patternProblem('{device}-{kind}')).toMatch('{stamp}');
    expect(patternProblem('{device}-{stamp}')).toMatch('{kind}');
    expect(patternProblem('{sit}-{stamp}-{kind}')).toMatch('{sit}');
    expect(patternProblem('{stamp}-{kind}-{')).not.toBeNull();
    expect(patternProblem('{stamp}-{kind}}')).not.toBeNull();
    expect(previewFileName('{device}', dev, '20260828-101530', 'running-config')).toBeNull();
  });

  it('keeps separators out of the name whatever a device calls itself', () => {
    const f = previewFileName('{site}/{device}-{stamp}-{kind}', { name: '../../x', address: '', site: '..' },
      '20260828-101530', 'running-config');
    expect(f).not.toMatch(/[/\\]/);
    expect(f).toBe('x-20260828-101530-running-config.txt');
  });

  it('shortens a long device name to fit instead of refusing the backup', () => {
    const long = 'A'.repeat(300);
    const f = previewFileName('{device}-{site}-{stamp}-{kind}', { name: long, address: '', site: long },
      '20260828-101530', 'running-config');
    expect(f).not.toBeNull();
    expect(f!.endsWith('-20260828-101530-running-config.txt')).toBe(true);
    expect(f!.length).toBeLessThanOrEqual(96);
    // Only the pattern's own text can make it too long.
    expect(previewFileName(`${'x'.repeat(90)}-{stamp}-{kind}`, dev, '20260828-101530', 'running-config')).toBeNull();
  });

  it('reads a run stamp as a date and time (LT-152)', () => {
    expect(describeStamp('20260828-101530')).toBe('2026-08-28 10:15:30');
    expect(describeStamp('not-a-stamp')).toBe('not-a-stamp');
  });

  it('reads the date and kind back wherever the pattern put them', () => {
    expect(describeCapture('20260828-101530-running-config.txt')).toBe('2026-08-28 10:15:30 · running config');
    expect(describeCapture('Lab_SW_20260828-101530_show-commands.txt')).toBe(
      '2026-08-28 10:15:30 · show commands — Lab_SW_20260828-101530_show-commands.txt',
    );
    expect(describeCapture('notes.txt')).toBe('notes.txt');
  });
});
