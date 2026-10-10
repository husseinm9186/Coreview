// Checking GitHub for a newer release: a button under Tools → Settings,
// and a tick for doing it at start that is off until somebody ticks it.
// The stub stands in for the backend and records every message the page
// sends, which is how this proves the one thing that matters most: with the
// tick off, nothing is sent on load. Invented versions and notes only.
//
// Every "restart" is a fresh browser page: the dev server serves the app as
// a few hundred modules, and a Chromium page reloaded a fourth time runs
// out of resources. What the stubbed backend keeps (the one setting) lives
// here, in the harness, and is handed to each page.
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const project = {
  meta: { id: "up", name: "Updates", customer: "", site: "", ticket: "", engineer: "", description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: { nodes: [], edges: [], probes: [], canvas: {} },
};

/** The stubbed backend's memory: the settings table, and what the next
 *  check finds (none | newer | refused | install-fails). */
const backend = { stored: {}, found: "none" };

const browser = await chromium.launch();
let page = null;

/** A fresh page, as a restart of the app: the backend's memory comes with
 *  it, and what the page changed is read back when it is closed. */
const start = async () => {
  if (page) {
    backend.stored = await page.evaluate(() => window.__stored);
    await page.close();
  }
  page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.addInitScript(({ p, stored, found }) => {
    window.__stored = { ...stored };
    window.__found = found;
    window.__calls = [];
    let next = 1;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      transformCallback() { return next++; },
      invoke(cmd, args = {}) {
        window.__calls.push({ cmd, args });
        if (cmd === "plugin:event|listen") return Promise.resolve(next++);
        const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "", engineer: "", description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
        if (cmd === "list_projects") return Promise.resolve([meta]);
        if (cmd === "save_project") return Promise.resolve();
        if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
        if (cmd === "get_settings") return Promise.resolve({ ...window.__stored });
        if (cmd === "set_setting") {
          if (args.value) window.__stored[args.key] = args.value; else delete window.__stored[args.key];
          return Promise.resolve();
        }
        if (cmd === "app_info") return Promise.resolve({ version: "2.9.0", dataDir: "/nowhere", documentVersion: 1 });
        if (cmd === "check_for_update") {
          if (window.__found === "refused") return Promise.reject("Could not reach github.com: connection refused");
          if (window.__found === "none") return Promise.resolve({ current: "2.9.0", available: null });
          return Promise.resolve({ current: "2.9.0", available: { version: "2.9.1", notes: "**Fixes**\n- An invented fix.", date: "2026-10-20T09:00:00Z" } });
        }
        if (cmd === "install_update") {
          if (window.__found === "install-fails") return Promise.reject("The download's signature does not match Coreview's key, so it was not installed.");
          return new Promise(() => {}); // success never returns: the process restarted
        }
        return Promise.resolve([]);
      },
    };
  }, { p: project, stored: backend.stored, found: backend.found });
  page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
};

/** Into the project, then Tools → Settings; the Updates block. */
const openSettings = async () => {
  await start();
  await page.locator(".cv-project-open").first().click();
  await page.waitForTimeout(700);
  await page.locator(".cv-btn-tools").first().click();
  await page.waitForTimeout(300);
  await page.locator(".cv-tools .cv-tabs button", { hasText: "Settings" }).first().click();
  await page.waitForTimeout(400);
  return page.locator('[data-region="updates"]');
};
const sent = (cmd) => page.evaluate((c) => window.__calls.filter((x) => x.cmd === c).length, cmd);
const setFound = async (found) => { backend.found = found; await page.evaluate((f) => { window.__found = f; }, found); };

// ------------------------------------------------- off by default: silence
let updates = await openSettings();
check("Settings has an Updates block", (await updates.count()) === 1);
check("it says Coreview never contacts GitHub on its own", /never contacts GitHub on its own/.test(await updates.innerText()), (await updates.innerText()).slice(0, 200));
check("the at-start tick is off until somebody ticks it", !(await updates.locator('[data-field="update-on-start"]').isChecked()));
check("and nothing was sent to GitHub on load", (await sent("check_for_update")) === 0, String(await sent("check_for_update")));
check("the top bar announces nothing", (await page.locator('[data-action="update-available"]').count()) === 0);

// ------------------------------------------------- the button: up to date
await updates.locator('[data-action="check-updates"]').click();
await page.waitForTimeout(400);
check("pressing the button sends one check", (await sent("check_for_update")) === 1, String(await sent("check_for_update")));
check("and says this is the latest version, by number", /latest version, 2\.9\.0/.test(await updates.locator('[data-hint="updates"]').innerText()), await updates.locator('[data-hint="updates"]').innerText());
check("with nothing to install", (await updates.locator('[data-action="install-update"]').count()) === 0);

// ------------------------------------------------- the button: GitHub unreachable
await setFound("refused");
await updates.locator('[data-action="check-updates"]').click();
await page.waitForTimeout(400);
check("a check that cannot reach GitHub says so, in its words",
  /Could not check: Could not reach github\.com: connection refused/.test(await updates.locator('[data-hint="updates"]').innerText()),
  await updates.locator('[data-hint="updates"]').innerText());
check("and the button can be pressed again", await updates.locator('[data-action="check-updates"]').isEnabled());

// ------------------------------------------------- the button: a newer release
await setFound("newer");
await updates.locator('[data-action="check-updates"]').click();
await page.waitForTimeout(400);
check("a newer release is named with the version in hand", /Coreview 2\.9\.1 is available\. You have 2\.9\.0\./.test(await updates.locator('[data-hint="updates"]').innerText()), await updates.locator('[data-hint="updates"]').innerText());
const found = updates.locator('[data-region="update-found"]');
check("its date is shown", /Published 2026-10-20/.test(await found.innerText()), (await found.innerText()).slice(0, 200));
await found.locator("summary", { hasText: "What changed" }).click();
check("its notes open on request", /An invented fix/.test(await found.innerText()));
check("and the install button says it restarts", (await found.locator('[data-action="install-update"]').innerText()).includes("Install and restart"));
check("the top bar now offers the update", (await page.locator('[data-action="update-available"]').innerText()).includes("Update to 2.9.1"));
check("every check was one request; nothing else was sent to GitHub", (await sent("check_for_update")) === 3 && (await sent("install_update")) === 0);

// ------------------------------------------------- installing: a refused download
await setFound("install-fails");
await found.locator('[data-action="install-update"]').click();
await page.waitForTimeout(400);
check("installing sends the install", (await sent("install_update")) === 1);
check("and a download whose signature fails says it was not installed",
  /was not installed/.test(await updates.locator('[data-hint="updates"]').innerText()), await updates.locator('[data-hint="updates"]').innerText());

// ------------------------------------------------- installing: the download runs
await setFound("newer");
await updates.locator('[data-action="check-updates"]').click();
await page.waitForTimeout(400);
await updates.locator('[data-action="install-update"]').click();
await page.waitForTimeout(300);
check("while downloading, the buttons wait", !(await updates.locator('[data-action="check-updates"]').isEnabled()));
check("and the line says it is downloading", /Downloading/.test(await updates.locator('[data-hint="updates"]').innerText()), await updates.locator('[data-hint="updates"]').innerText());

// ------------------------------------------------- the tick: kept, and acted on at start
backend.found = "none";
updates = await openSettings();
await updates.locator('[data-field="update-on-start"]').check();
await page.waitForTimeout(300);
const saved = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "set_setting" && c.args.key === "updateCheckOnStart").at(-1)?.args);
check("ticking it is kept, as the one setting", saved?.value === "1", JSON.stringify(saved));
backend.found = "newer";
updates = await openSettings();
check("after a restart the tick is still on", await updates.locator('[data-field="update-on-start"]').isChecked());
check("and one check was sent at start, before any button", (await sent("check_for_update")) === 1, String(await sent("check_for_update")));
check("the top bar says what it found", (await page.locator('[data-action="update-available"]').innerText()).includes("Update to 2.9.1"));
await page.locator('[data-action="update-available"]').click();
await page.waitForTimeout(400);
check("and pressing that opens Settings at the update", (await page.locator('[data-region="updates"] [data-action="install-update"]').count()) === 1);

// A failed automatic check stays quiet: nobody pressed anything.
backend.found = "refused";
updates = await openSettings();
check("an automatic check that cannot reach GitHub announces nothing in the top bar", (await page.locator('[data-action="update-available"]').count()) === 0);
check("but Settings says why, for whoever looks", /Could not check/.test(await updates.locator('[data-hint="updates"]').innerText()));

// Off again: silence again.
await updates.locator('[data-field="update-on-start"]').uncheck();
await page.waitForTimeout(300);
const cleared = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "set_setting" && c.args.key === "updateCheckOnStart").at(-1)?.args);
check("unticking clears the setting rather than storing a no", cleared?.value === null, JSON.stringify(cleared));
backend.found = "newer";
updates = await openSettings();
check("and with it off, a restart sends nothing again", (await sent("check_for_update")) === 0, String(await sent("check_for_update")));

await browser.close();
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
