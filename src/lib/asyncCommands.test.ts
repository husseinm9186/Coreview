/**
 * A command that touches the database, a file, a parser or a child
 * process does not run on the UI thread.
 *
 * In Tauri 2 a command written as a plain `fn` is executed on the main thread,
 * which is the thread the WebView paints from. `save_project` writing the
 * whole document on every autosave, `save_crawl_run` serialising up to 64 MB,
 * `list_icon_library` running LibreOffice — each of those froze the interface
 * for as long as it took, and `state.db.lock()` blocked it behind whatever
 * background task held the connection. The fix is one attribute,
 * `#[tauri::command(async)]`, and this test is what stops the next command
 * being written without it. It reads the Rust the way `isolationRules.test.ts`
 * does, so the rule cannot drift from the code.
 */
import { readdirSync, readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../src-tauri/src/', import.meta.url);

/** Things a command body does that belong off the UI thread. */
const BLOCKING = /state\.db\.lock\(|std::fs::|\bdb::|crate::db\b|read_to_string|Command::new|\.output\(\)|shapeconv::|icons::|visio|drawio|spreadsheet::|pdf::|walkfile|nmap_import|keychain::/;

interface Command {
  file: string;
  name: string;
  offThread: boolean;
  body: string;
}

/** Every `#[tauri::command]`, whether it is marked to run off the main thread, and its body. */
function commands(): Command[] {
  const out: Command[] = [];
  for (const file of readdirSync(root).filter((f) => f.endsWith('.rs'))) {
    const src = readFileSync(new URL(file, root), 'utf8');
    const re = /#\[tauri::command([^\]]*)\]\s*(?:#\[[^\]]*\]\s*)*pub (async )?fn (\w+)/g;
    for (const m of src.matchAll(re)) {
      const attr = m[1] ?? '';
      const isAsyncFn = Boolean(m[2]);
      const name = m[3]!;
      // The body: from the first `{` after the signature to its matching `}`.
      const open = src.indexOf('{', m.index! + m[0].length);
      let depth = 0;
      let end = open;
      for (let i = open; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      out.push({ file, name, offThread: isAsyncFn || /\basync\b/.test(attr), body: src.slice(open, end + 1) });
    }
  }
  return out;
}

describe('commands that block run off the UI thread', () => {
  it('finds the command table', () => {
    expect(commands().length).toBeGreaterThan(90);
  });

  it('marks every command that touches the database, a file, a parser or a process as async', () => {
    const onThread = commands()
      .filter((c) => !c.offThread && BLOCKING.test(c.body))
      .map((c) => `${c.file}: ${c.name}`);
    expect(onThread, 'add #[tauri::command(async)] to these, or make them async fn').toEqual([]);
  });
});
