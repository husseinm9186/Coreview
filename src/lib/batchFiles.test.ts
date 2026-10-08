import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

// Cmd.exe misreads a batch file with Unix line endings, and more so
// with non-ASCII text in it — the Windows build once ran a command called
// "m", a piece of a `rem` line. Every batch file is ASCII, with CRLF.
describe('batch files', () => {
  const files = execSync('git ls-files "*.cmd" "*.bat"', { encoding: 'utf8' }).split('\n').filter(Boolean);

  it('exist, so this test is testing something', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('are ASCII, every line ending in CRLF', () => {
    for (const f of files) {
      const bytes = readFileSync(f);
      expect([...bytes].every((b) => b < 0x80), `${f} has non-ASCII bytes`).toBe(true);
      const text = bytes.toString('latin1');
      const bareLf = text.replace(/\r\n/g, '').includes('\n');
      expect(bareLf, `${f} has a line ending in LF alone`).toBe(false);
    }
  });
});
