// LT-487: a backup or export folder is a project's (LT-414), so it is
// chosen where a project is open — its Settings, and inline in Backups when
// that panel needs one — and the start screen says so instead of offering
// buttons whose save the backend refuses. The stub refuses exactly as
// `set_setting` does: a project key with no project is an error.
// Invented paths only (D-027).
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;
const PICKED = "/home/example/coreview-backups";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const project = {
  meta: { id: "fs", name: "Folder settings", customer: "", site: "", ticket: "", engineer: "", description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: { nodes: [], edges: [], probes: [], canvas: {} },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await page.addInitScript(({ p, picked }) => {
  const PROJECT_KEYS = ["backupFolder", "exportFolder"];
  const stored = {}; // projectId -> { key: value }
  window.__refuseNext = null;
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
      if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({ ...(stored[args.projectId] ?? {}) });
      if (cmd === "plugin:dialog|open") return Promise.resolve(picked);
      if (cmd === "check_folder_writable") return Promise.resolve();
      if (cmd === "set_setting") {
        if (window.__refuseNext) { const m = window.__refuseNext; window.__refuseNext = null; return Promise.reject(m); }
        if (PROJECT_KEYS.includes(args.key)) {
          if (!args.projectId) return Promise.reject("That setting belongs to a project, and no project is open.");
          stored[args.projectId] = { ...(stored[args.projectId] ?? {}) };
          if (args.value) stored[args.projectId][args.key] = args.value; else delete stored[args.projectId][args.key];
        }
        return Promise.resolve();
      }
      return Promise.resolve([]);
    },
  };
}, { p: project, picked: PICKED });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(500);

// ------------------------------------------------------------ start screen
const start = page.locator(".cv-folders");
check("the start screen offers no folder button whose save would be refused",
  (await start.locator("button", { hasText: /Choose folder|Change/ }).count()) === 0,
  String(await start.locator("button").count()));
check("and says where the folders are chosen instead",
  /chosen for each project/.test(await start.innerText()), (await start.innerText()).slice(0, 200));

// ------------------------------------------------------ inside a project
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(700);
await page.locator(".cv-btn-tools").first().click();
await page.waitForTimeout(300);
await page.locator(".cv-tools .cv-tabs button", { hasText: "Settings" }).first().click();
await page.waitForTimeout(500);
const inSettings = page.locator('[data-region="project-folders"] .cv-folders');
check("the project's Settings has its folders", (await inSettings.count()) === 1);
await inSettings.locator(".cv-folder-row", { hasText: "Configuration backups" }).locator("button", { hasText: "Choose folder" }).click();
await page.waitForTimeout(400);
const saved = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "set_setting").at(-1)?.args);
check("choosing a backup folder saves it to this project", saved?.key === "backupFolder" && saved?.projectId === "fs" && saved?.value === "/home/example/coreview-backups", JSON.stringify(saved));
check("and shows it once kept", (await inSettings.innerText()).includes("/home/example/coreview-backups"), (await inSettings.innerText()).slice(0, 200));

// A refused save is said, where it happened.
await page.evaluate(() => { window.__refuseNext = "The disk said no."; });
await inSettings.locator(".cv-folder-row", { hasText: "Exports" }).locator("button", { hasText: "Choose folder" }).click();
await page.waitForTimeout(400);
check("a refused save is said beside the folder, not swallowed",
  /The disk said no\./.test(await inSettings.innerText()), (await inSettings.innerText()).slice(0, 300));
check("and the folder is not shown as chosen", (await inSettings.locator(".cv-folder-row", { hasText: "Exports" }).innerText()).includes("Ask me each time"));

// ------------------------------------------- Backups asks where it can save
// A fresh start: the stub keeps nothing across a reload, so no folder is set.
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(700);
await page.locator("button", { hasText: "Backups" }).first().click();
await page.waitForTimeout(500);
const backups = page.locator(".cv-panel");
check("Backups with no folder offers the chooser itself, not a trip to the start screen",
  (await backups.locator(".cv-folders button", { hasText: "Choose folder" }).count()) >= 1 && !/on the Coreview start screen/.test(await backups.innerText()),
  (await backups.innerText()).slice(0, 300));
await backups.locator(".cv-folders .cv-folder-row", { hasText: "Configuration backups" }).locator("button", { hasText: "Choose folder" }).click();
await page.waitForTimeout(500);
check("and once one is chosen there, the backup form appears",
  (await backups.locator(".cv-discover-form").count()) >= 1, (await backups.innerText()).slice(0, 200));

await browser.close();
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
