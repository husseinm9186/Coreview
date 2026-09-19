/**
 * The isolation frame's rules (LT-258, LT-266): the command table cannot fall
 * behind the backend, and what the rules let through and refuse.
 */
import { readdirSync, readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

interface Rules {
  COMMANDS: Record<string, string[]>;
  PLUGINS: string[];
  check: (message: unknown) => string | null;
  guard: (message: Record<string, unknown>) => Record<string, unknown>;
}

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

const rules: Rules = (() => {
  const scope: { coreviewIsolation?: Rules } = {};
  // The file as the frame loads it, run against a stand-in for `window`.
  new Function('window', read('isolation/rules.js'))(scope);
  return scope.coreviewIsolation!;
})();

/** Every `#[tauri::command]` and the names the page sends its arguments by. */
function backendCommands(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const dir = new URL('src-tauri/src/', root);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.rs'))) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    const re = /#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*pub (?:async )?fn (\w+)\s*(?:<[^>]*>)?\(([\s\S]*?)\)\s*(?:->|\{)/g;
    for (const m of src.matchAll(re)) {
      const params = m[2]!.replace(/\/\/[^\n]*/g, '').split(/,(?![^<]*>)/).map((p) => p.trim()).filter((p) => p.includes(':'));
      const args = params
        .filter((p) => !/State<|AppHandle|Window/.test(p))
        .map((p) => p.split(':')[0]!.trim().replace(/^mut\s+/, '').replace(/^_/, '').replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()));
      out.set(m[1]!, args);
    }
  }
  return out;
}

describe('the isolation rules (LT-258)', () => {
  it('know every command the backend registers, by its own argument names', () => {
    const backend = backendCommands();
    const handler = /generate_handler!\[([\s\S]*?)\]/.exec(read('src-tauri/src/main.rs'))![1]!;
    const registered = handler.split(',').map((s) => s.trim().split('::').pop()!).filter(Boolean);
    expect(Object.keys(rules.COMMANDS).sort()).toEqual([...registered].sort());
    for (const name of registered) expect(rules.COMMANDS[name], name).toEqual(backend.get(name));
  });

  it('let the app\'s own calls through untouched', () => {
    const ok = { cmd: 'start_crawl', callback: 1, error: 2, options: {}, payload: { input: { seed: '192.0.2.1' }, credentials: { username: 'u', password: 'p' }, fallbackCredentials: [] } };
    expect(rules.check(ok)).toBeNull();
    expect(rules.guard(ok)).toBe(ok);
    expect(rules.check({ cmd: 'list_projects', callback: 1, error: 2, payload: {} })).toBeNull();
    expect(rules.check({ cmd: 'plugin:dialog|open', callback: 1, error: 2, payload: { options: { multiple: false } } })).toBeNull();
  });

  it('refuse what the page has no business sending', () => {
    const at = (payload: unknown, cmd = 'save_export') => rules.check({ cmd, callback: 1, error: 2, payload });
    expect(rules.check({ cmd: 'drop_everything', callback: 1, error: 2, payload: {} })).toMatch(/no command called drop_everything/);
    expect(rules.check({ cmd: 'plugin:shell|execute', callback: 1, error: 2, payload: {} })).toMatch(/no use for plugin:shell\|execute/);
    expect(at({ path: '/tmp/x', contentsB64: '', extra: 1 })).toMatch(/sends "extra"/);
    expect(at([1, 2])).toMatch(/not named/);
    expect(at(JSON.parse('{"path":"/tmp/x","contentsB64":{"__proto__":{"polluted":true}}}'))).toMatch(/__proto__/);
    let deep: unknown = 'x';
    for (let i = 0; i < 80; i += 1) deep = [deep];
    expect(at({ path: deep, contentsB64: '' })).toMatch(/nested too deeply/);
    expect(rules.check(null)).toMatch(/names no command/);
  });

  it('send a refusal on as ipc_refused, keeping the callbacks so the call fails', () => {
    const out = rules.guard({ cmd: 'save_export', callback: 7, error: 8, options: { headers: {} }, payload: { path: '/tmp/x', injected: true } });
    expect(out).toMatchObject({ cmd: 'ipc_refused', callback: 7, error: 8, payload: { command: 'save_export' } });
    expect(String((out.payload as { reason: string }).reason)).toMatch(/injected/);
    expect(rules.check(out)).toBeNull();
  });

  it('never throw, whatever arrives (LT-266)', () => {
    const shapes: unknown[] = [undefined, 0, 'x', [], {}, { cmd: 1 }, { cmd: 'save_export', payload: 5 }, { cmd: 'save_export', payload: new Uint8Array(4) }, { cmd: 'plugin:event|listen', payload: { event: 'e', handler: 1 } }];
    for (let i = 0; i < 2000; i += 1) {
      const cmds = Object.keys(rules.COMMANDS);
      const random = (depth: number): unknown => {
        const r = Math.random();
        if (depth > 3 || r < 0.3) return [null, true, 1.5, 'text', ''][Math.floor(Math.random() * 5)];
        if (r < 0.6) return Array.from({ length: Math.floor(Math.random() * 4) }, () => random(depth + 1));
        return Object.fromEntries(Array.from({ length: Math.floor(Math.random() * 4) }, () => [Math.random().toString(36).slice(2, 7), random(depth + 1)]));
      };
      shapes.push({ cmd: cmds[Math.floor(Math.random() * cmds.length)], callback: 1, error: 2, payload: random(0) });
    }
    for (const s of shapes) expect(() => rules.guard(s as Record<string, unknown>)).not.toThrow();
  });
});
