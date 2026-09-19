// Collect in ordered groups, driven through the real Backups tab (LT-154).
//
// The Tauri bridge is stubbed, and backup events are sent into the page the
// way Tauri delivers them — adjacently tagged, through the registered
// listener — so the panel's own queue decides when each group starts. Every
// `start_backup` call is recorded, which is what proves the order, the
// pauses, and that a failure is visible before the next group begins.
//
// Every name and address here is invented for the test (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/groups.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const device = (id, label, address, role, tags = []) => ({
  id,
  type: "device",
  position: { x: 100, y: 100 },
  data: {
    label, deviceType: "generic", tags, ...(role ? { role } : {}),
    addresses: [{ id: `${id}-a`, label: "Mgmt", address, isPrimary: true }],
    locked: false, maintenance: false, showDetails: true,
  },
});

const project = {
  meta: { id: "grp", name: "Groups", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    nodes: [
      device("a", "LAB-SW-A", "192.0.2.10", "", ["bench"]),
      device("b", "LAB-RTR-B", "192.0.2.20", "Lab Router"),
      device("c", "LAB-FW-C", "192.0.2.30", "Lab Firewall"),
    ],
    edges: [], probes: [], canvas: {},
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });

await page.addInitScript(({ p }) => {
  if (!localStorage.getItem("coreview.projects.v1")) {
    localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
  }
  const listeners = {}, callbacks = {};
  let next = 1;
  const SKEY = "cv.e2e.groups.settings";
  window.__cvSettings = { backupFolder: "/tmp/coreview-e2e-not-a-real-folder",
    ...JSON.parse(localStorage.getItem(SKEY) ?? "{}") };
  window.__cvCalls = [];
  window.__cvRefuse = false;
  // Deliver a backend event exactly as Tauri would: to the registered handler,
  // with the enum tagged adjacently.
  window.__cvEmit = (payload) => {
    const id = listeners["coreview://backup"];
    callbacks[id]?.({ event: "coreview://backup", id: 0, payload });
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const id = next++; callbacks[id] = cb; return id; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") { listeners[args.event] = args.handler; return Promise.resolve(next++); }
      if (cmd === "plugin:event|unlisten") return Promise.resolve();
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "",
        engineer: "", description: "", created_at: p.meta.createdAt,
        updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project")
        return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({ ...window.__cvSettings });
      if (cmd === "set_setting") {
        window.__cvCalls.push({ cmd, args });
        if (args.value === null || args.value === undefined) delete window.__cvSettings[args.key];
        else window.__cvSettings[args.key] = args.value;
        const { backupFolder, ...rest } = window.__cvSettings;
        void backupFolder;
        localStorage.setItem(SKEY, JSON.stringify(rest));
        return Promise.resolve();
      }
      if (cmd === "start_backup" || cmd === "cancel_backup") {
        window.__cvCalls.push({ cmd, args });
        if (cmd === "start_backup" && window.__cvRefuse) return Promise.reject("Choose at least one device to back up.");
        return Promise.resolve();
      }
      if (cmd === "vault_status") return Promise.resolve({ exists: false, unlocked: false });
      return Promise.resolve([]);
    },
  };
}, { p: project });

page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));

const openBackups = async () => {
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.locator(".cv-project-open").first().click();
  await page.waitForTimeout(700);
  await page.locator("button", { hasText: "Backups" }).first().click();
  await page.waitForTimeout(500);
};

const section = page.locator(".cv-collection-groups");
const groupRows = section.locator("fieldset");
const groupField = (i, label) =>
  groupRows.nth(i).locator(".cv-field", { has: page.locator(`span:text-is("${label}")`) }).locator("input").first();
const option = (label) => section.locator(".cv-check", { hasText: label }).locator("input");
const backUp = () => page.locator("button", { hasText: /^Back up/ }).first();
const starts = () => page.evaluate(() => window.__cvCalls.filter((c) => c.cmd === "start_backup"));
const namesIn = (call) => (call?.args?.input?.targets ?? []).map((t) => t.name);
const steps = () => page.locator(".cv-group-progress li").allInnerTexts();
const emit = async (payload) => { await page.evaluate((pl) => window.__cvEmit(pl), payload); await page.waitForTimeout(200); };
// As the backend sends them: `run_backups` always emits started before
// finished, and the panel relies on that order to ignore a repeated finished.
const finishedOnly = (saved, failed, cancelled = false) =>
  emit({ kind: "finished", value: { saved, failed, cancelled } });
const finished = async (saved, failed, cancelled = false) => {
  await emit({ kind: "started", value: { devices: 1 } });
  await finishedOnly(saved, failed, cancelled);
};
const login = async () => {
  const field = (label) =>
    page.locator(".cv-discover-form .cv-field", { has: page.locator(`span:text-is("${label}")`) }).locator("input").first();
  await field("Username").fill("e2e-user");
  await field("Password").fill("e2e-not-a-password");
  await page.locator("button", { hasText: "Select all" }).click();
};

await openBackups();

// ------------------------------------------------------------- the groups

check("the Backups tab can collect in groups", (await section.count()) === 1);
check("no group ships built in (D-027)", (await groupRows.count()) === 0);
check("the pause options appear only once there is a group", (await option("Pause between groups").count()) === 0);

await section.locator("button", { hasText: "Add group" }).click();
await section.locator("button", { hasText: "Add group" }).click();
await page.waitForTimeout(150);
check("a new group starts matching nothing",
  (await groupField(0, "Roles").inputValue()) === "" && (await groupField(0, "Tags").inputValue()) === "");
await groupField(0, "Name").fill("Edge");
await groupField(0, "Roles").fill("lab router");
await groupField(1, "Name").fill("Switches");
await groupField(1, "Tags").fill("BENCH");
await page.waitForTimeout(200);
check("pausing and stopping on failure are both on by default",
  (await option("Pause between groups").isChecked()) && (await option("Stop when a group has a failure").isChecked()));

const groupCell = async (name) =>
  (await page.locator(".cv-discover-table tbody tr", { hasText: name }).first().locator("td").nth(4).innerText()).trim();
check("the table says which group each device falls into",
  (await groupCell("LAB-RTR-B")) === "Edge" && (await groupCell("LAB-SW-A")) === "Switches" &&
    (await groupCell("LAB-FW-C")) === "Everything else",
  `${await groupCell("LAB-RTR-B")} / ${await groupCell("LAB-SW-A")} / ${await groupCell("LAB-FW-C")}`);

// ------------------------------------------------- run, pause, look, go on

await login();
await backUp().click();
await page.waitForTimeout(300);
let calls = await starts();
check("only the first group starts", calls.length === 1 && JSON.stringify(namesIn(calls[0])) === '["LAB-RTR-B"]',
  JSON.stringify(calls.map(namesIn)));
let s = await steps();
check("the progress lists every group, first running and the rest waiting",
  s.length === 3 && s[0].startsWith("Running") && s[1].startsWith("Waiting") && s[2].startsWith("Waiting"), JSON.stringify(s));
check("the form is locked while it runs", await groupField(0, "Name").isDisabled());

await emit({ kind: "saved", value: { name: "LAB-RTR-B", address: "192.0.2.20", path: "/x", bytes: 10, kind: "running", unchanged: false } });
await finished(1, 0);
calls = await starts();
check("with pausing on, the next group waits", calls.length === 1, `${calls.length}`);
const cont = page.locator(".cv-group-progress button", { hasText: /^Continue with/ });
check("and offers to continue with it by name", (await cont.innerText()).includes("Switches"), await cont.innerText());
check("the form stays locked while paused", await groupField(0, "Name").isDisabled() && await backUp().isDisabled());

await cont.click();
await page.waitForTimeout(300);
calls = await starts();
check("continuing starts the second group", calls.length === 2 && JSON.stringify(namesIn(calls[1])) === '["LAB-SW-A"]',
  JSON.stringify(calls.map(namesIn)));
check("every group shares the run's one stamp", calls[0].args.stamp === calls[1].args.stamp, `${calls[0].args.stamp} ${calls[1].args.stamp}`);

await emit({ kind: "failed", value: { name: "LAB-SW-A", address: "192.0.2.10", reason: "authentication failed" } });
await finished(0, 1);
calls = await starts();
check("a group with a failure stops the collection", calls.length === 2, `${calls.length}`);
const results = await page.locator(".cv-backup-results").innerText().catch(() => "");
check("and the failure is visible before the next group starts",
  results.includes("LAB-SW-A") && results.includes("authentication failed"), results);
check("the pause says why", (await page.locator(".cv-group-progress").innerText()).includes("Switches had 1 failure"));
s = await steps();
check("the failed group reads as done with its count", s[1].includes("0 saved, 1 failed"), JSON.stringify(s));

await page.locator(".cv-group-progress button", { hasText: "Stop here" }).click();
await page.waitForTimeout(200);
calls = await starts();
s = await steps();
check("stopping there runs nothing more", calls.length === 2 && s[2].startsWith("Not run"), JSON.stringify(s));
check("and Back up is available again", !(await backUp().isDisabled()));

// ------------------------------------ reordered, no pause, straight through

await option("Pause between groups").uncheck();
await groupRows.nth(1).locator('button[aria-label="Move Switches earlier"]').click();
await page.waitForTimeout(200);
check("a group can be moved earlier", (await groupField(0, "Name").inputValue()) === "Switches");

await backUp().click();
await page.waitForTimeout(300);
calls = await starts();
check("the moved group now runs first", calls.length === 3 && JSON.stringify(namesIn(calls[2])) === '["LAB-SW-A"]',
  JSON.stringify(calls.map(namesIn)));
await finished(1, 0);
// The same finished event again, after the next group was launched, must not
// start a third group over the second.
await finishedOnly(1, 0);
calls = await starts();
check("without pausing, a clean group goes straight on — once, even if finished arrives twice",
  calls.length === 4 && JSON.stringify(namesIn(calls[3])) === '["LAB-RTR-B"]', JSON.stringify(calls.map(namesIn)));
await finished(1, 0);
calls = await starts();
check("everything else runs last", calls.length === 5 && JSON.stringify(namesIn(calls[4])) === '["LAB-FW-C"]',
  JSON.stringify(calls.map(namesIn)));
await finished(1, 0);
s = await steps();
check("when the last group finishes every step is done",
  s.length === 3 && s.every((x) => x.startsWith("Done")) && !(await backUp().isDisabled()), JSON.stringify(s));

// --------------------------------------------------------- stop mid-group

await backUp().click();
await page.waitForTimeout(300);
await page.locator("button", { hasText: /^Stop$/ }).click();
await page.waitForTimeout(150);
check("Stop asks the backend to cancel",
  (await page.evaluate(() => window.__cvCalls.filter((c) => c.cmd === "cancel_backup").length)) === 1);
await finished(0, 0, true);
calls = await starts();
s = await steps();
check("a cancelled group runs nothing after it", calls.length === 6 && s[1].startsWith("Not run") && s[2].startsWith("Not run"),
  JSON.stringify(s));

// ----------------------------------------------- remembered, and refusals

const writes = await page.evaluate(() =>
  window.__cvCalls.filter((c) => c.cmd === "set_setting" && c.args.key === "backupGroups"));
check("the groups are saved as a setting, in their new order",
  /Switches.*Edge/.test(String(writes.at(-1)?.args?.value)), String(writes.at(-1)?.args?.value));
check("and carry no credential", !JSON.stringify(writes).includes("e2e-not-a-password"));

await openBackups();
check("after a restart the groups come back in order",
  (await groupRows.count()) === 2 && (await groupField(0, "Name").inputValue()) === "Switches");

await page.evaluate(() => { window.__cvRefuse = true; });
await login();
await backUp().click();
await page.waitForTimeout(300);
const problem = await page.locator(".cv-discover-status .cv-discover-problem").innerText().catch(() => "");
s = await steps();
check("a group the backend refuses stops the collection and says why",
  problem.includes("Choose at least one device") && s.every((x) => x.startsWith("Not run")), `${problem} ${JSON.stringify(s)}`);
check("and nothing is left locked", !(await backUp().isDisabled()));

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
