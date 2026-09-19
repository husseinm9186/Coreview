// Before and after: two backup runs compared in the real Backups tab (LT-152).
//
// The Tauri bridge is stubbed — the comparison itself is Rust and is tested in
// `compare.rs` against real files — and every call the panel makes is
// recorded. What is checked here is that the panel asks for the right pair and
// shows what came back, per device and per command.
//
// Every name, address and line here is invented for the test (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/beforeafter.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const project = {
  meta: { id: "ba", name: "BA", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: { nodes: [], edges: [], probes: [], canvas: {} },
};

const RUNS = [
  { stamp: "20260828-110000", devices: 3, kinds: ["running", "show-commands"] },
  { stamp: "20260828-090000", devices: 3, kinds: ["running", "show-commands"] },
  { stamp: "20260827-090000", devices: 1, kinds: ["running"] },
];

const part = (name, status, extra = {}) => ({
  name, status, added: 0, removed: 0, lines: [], truncated: false, approximate: false, ...extra,
});

const COMPARISON = [
  {
    device: "LAB-SW-A", kind: "show-commands",
    before: "20260828-090000-show-commands.txt", after: "20260828-110000-show-commands.txt",
    changed: 2,
    parts: [
      part("show clock", "changed", { added: 1, removed: 1,
        lines: [{ kind: "removed", value: "09:00:01" }, { kind: "added", value: "11:00:01" }] }),
      part("show cdp neighbors", "same"),
      part("show vlan brief", "onlyAfter"),
    ],
  },
  {
    device: "LAB-SW-A", kind: "running",
    before: "20260828-090000-running-config.txt", after: "20260828-110000-running-config.txt",
    changed: 1,
    parts: [part("running-config", "changed", { added: 1, removed: 0, approximate: true,
      lines: [{ kind: "added", value: " description uplink to LAB-RTR-B" }] })],
  },
  {
    device: "LAB-RTR-B", kind: "running",
    before: "20260828-090000-running-config.txt", after: "20260828-110000-running-config.txt",
    changed: 0, parts: [part("running-config", "same")],
  },
  {
    device: "LAB-FW-C", kind: "running",
    before: "20260828-090000-running-config.txt", after: null,
    changed: 1, parts: [part("running-config", "onlyBefore")],
  },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });

await page.addInitScript(({ p, runs, comparison }) => {
  if (!localStorage.getItem("coreview.projects.v1")) {
    localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
  }
  let next = 1;
  window.__cvCalls = [];
  // Survives a reload, because this script runs again on every navigation.
  window.__cvRuns = localStorage.getItem("cv.e2e.ba.oneRun") ? [runs[0]] : runs;
  window.__cvCompareFails = false;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return next++; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "",
        engineer: "", description: "", created_at: p.meta.createdAt,
        updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project")
        return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({ backupFolder: "/tmp/coreview-e2e-not-a-real-folder" });
      if (cmd === "list_backup_runs") return Promise.resolve(window.__cvRuns);
      if (cmd === "compare_backup_runs") {
        window.__cvCalls.push({ cmd, args });
        if (window.__cvCompareFails) return Promise.reject("`../x` is not a backup run");
        return Promise.resolve(comparison);
      }
      if (cmd === "vault_status") return Promise.resolve({ exists: false, unlocked: false });
      return Promise.resolve([]);
    },
  };
}, { p: project, runs: RUNS, comparison: COMPARISON });

page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));

const openBackups = async () => {
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.locator(".cv-project-open").first().click();
  await page.waitForTimeout(700);
  await page.locator("button", { hasText: "Backups" }).first().click();
  await page.waitForTimeout(500);
};

await openBackups();

const section = page.locator(".cv-before-after");
const before = section.locator(".cv-field", { has: page.locator('span:text-is("Before")') }).locator("select");
const after = section.locator(".cv-field", { has: page.locator('span:text-is("After")') }).locator("select");
const compare = section.locator("button", { hasText: /Compare runs|Comparing/ });

check("the Backups tab has a before-and-after section", (await section.count()) === 1);
check("after defaults to the newest run", (await after.inputValue()) === "20260828-110000");
check("before defaults to the run before it", (await before.inputValue()) === "20260828-090000");
check("runs read as dates with a device count",
  (await after.locator("option").first().innerText()).includes("2026-08-28 11:00:00 · 3 devices"),
  await after.locator("option").first().innerText());

await after.selectOption("20260828-090000");
await page.waitForTimeout(150);
check("the same run on both sides cannot be compared", await compare.isDisabled());
check("and says why", (await section.innerText()).includes("Pick two different runs"));
await after.selectOption("20260828-110000");
await page.waitForTimeout(150);

await compare.click();
await page.waitForTimeout(400);
const call = await page.evaluate(() => window.__cvCalls.at(-1));
check("the chosen pair is what is asked for",
  call?.args?.before === "20260828-090000" && call?.args?.after === "20260828-110000", JSON.stringify(call));

const text = await section.innerText();
check("a summary counts what changed", text.includes("3 of 4 captures changed"), text.slice(0, 300));

const devices = section.locator(".cv-compared-device");
// Checked on the device headings: a changed line elsewhere may mention the
// unchanged device by name, and that is not the device being shown.
const headings = await devices.locator("summary").allInnerTexts();
check("only what changed is shown by default — the unchanged device is hidden",
  (await devices.count()) === 3 && headings.every((h) => !h.includes("LAB-RTR-B")), JSON.stringify(headings));

const showA = devices.filter({ hasText: "show commands" }).first();
check("show commands are summarised per command",
  (await showA.locator("summary").innerText()).includes("2 of 3 commands differ"),
  await showA.locator("summary").innerText());
check("a changed command shows its removed and added lines",
  (await showA.locator(".is-removed").first().innerText()).includes("09:00:01") &&
    (await showA.locator(".is-added").first().innerText()).includes("11:00:01"));
check("a command only in the after run says so", (await showA.innerText()).includes("only in the after run"));
check("an unchanged command is hidden while filtering", !(await showA.innerText()).includes("show cdp neighbors"));
check("a part compared as sets says so",
  (await devices.filter({ hasText: "running config" }).first().innerText()).includes("compared as sets of lines"));
check("a device missing from the after run is listed, not dropped",
  (await devices.filter({ hasText: "LAB-FW-C" }).innerText()).includes("only in the before run"));

await section.locator(".cv-check", { hasText: "Only what changed" }).locator("input").uncheck();
await page.waitForTimeout(200);
check("unticking the filter shows the unchanged device too", (await devices.count()) === 4);
check("and the unchanged command", (await showA.innerText()).includes("show cdp neighbors"));

await page.evaluate(() => { window.__cvCompareFails = true; });
await compare.click();
await page.waitForTimeout(400);
const problem = await page.locator(".cv-discover-problem").first().innerText().catch(() => "");
check("a refusal from the backend is shown as it said it", problem.includes("is not a backup run"), problem);
check("and the button is usable again", !(await compare.isDisabled()));

// With fewer than two runs there is nothing to pick.
await page.evaluate(() => localStorage.setItem("cv.e2e.ba.oneRun", "1"));
await openBackups();
const lonely = page.locator(".cv-before-after");
check("with one run there is nothing to pick", (await lonely.locator("select").count()) === 0);
check("and the section says how to get a pair",
  (await lonely.innerText()).includes("one backup before a change and one after"), await lonely.innerText());
await page.evaluate(() => localStorage.removeItem("cv.e2e.ba.oneRun"));

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
