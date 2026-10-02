// LT-677: the device inspector in tabs — Status first, read rather than
// edited; Identity, the form as it was; Ports; Checks; Notes — and the action
// row above them: SSH, Backup, Where is, Open as drawer. Stubbed backend; the
// tabs are window state, the actions hand over to the dock.
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const device = (id, label, x, y, address, extra = {}) => ({
  id, type: "device", position: { x, y }, width: 76, height: 76,
  data: { label, deviceType: "access-switch", tags: [], addresses: [{ id: `${id}-a`, label: "Discovered", address, isPrimary: true }], locked: false, maintenance: false, showDetails: true, ...extra },
});

const project = {
  meta: { id: "inspector", name: "Inspector", customer: "", site: "", ticket: "", engineer: "", description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    nodes: [
      device("n1", "CORE-SW1", 0, 0, "192.0.2.10", { vendor: "Contoso", model: "CS-9000", osVersion: "4.1", serial: "FAKE0000001", discoveredVia: "crawl", notes: "spare PSU in the cupboard" }),
      device("n2", "ACCESS-SW7", 0, 300, "192.0.2.11"),
    ],
    edges: [{ id: "e1", source: "n1", target: "n2", type: "live", data: { sourcePortLabel: "Gi1/0/48", targetPortLabel: "Gi1/0/1", enabled: true } }],
    probes: [],
    canvas: {},
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.addInitScript(({ p }) => {
  localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
  localStorage.setItem("coreview.view.panelOpen", "1");
  let next = 1;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return next++; },
    invoke(cmd) {
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "", engineer: "", description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      // A backup folder, so the Backups tab shows its device list rather than
      // asking for one first (LT-487). Nothing is written: no backup runs.
      if (cmd === "get_settings") return Promise.resolve({ backupFolder: "/tmp/coreview-e2e-not-a-real-folder" });
      if (cmd === "list_crawl_runs") return Promise.resolve([]);
      return Promise.resolve([]);
    },
  };
}, { p: project });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(700);

const st = (fn, arg) => page.evaluate(fn, arg);
const insp = page.locator(".cv-inspector");
const tabs = insp.locator('[role="tablist"].cv-inspector-tabs button[role="tab"]');
const tabNamed = (name) => insp.locator('.cv-inspector-tabs button[role="tab"]', { hasText: new RegExp(`^${name}$`) });
const kv = async () => {
  const out = {};
  for (const row of await insp.locator(".cv-kv-row").all()) out[await row.locator("dt").innerText()] = await row.locator("dd").innerText();
  return out;
};

await st(() => window.__cvStore.getState().select("n1", null));
await page.waitForTimeout(300);

// ------------------------------------------------------------- the tabs

check("a device's inspector has five tabs", (await tabs.count()) === 5, `${await tabs.count()}`);
check("named Status, Identity, Ports, Checks, Notes",
  JSON.stringify(await tabs.allInnerTexts()) === JSON.stringify(["Status", "Identity", "Ports", "Checks", "Notes"]), (await tabs.allInnerTexts()).join(" | "));
check("and starts on Status", (await tabNamed("Status").getAttribute("aria-selected")) === "true");
check("the tabs fit on one row", (await tabNamed("Status").boundingBox()).y === (await tabNamed("Notes").boundingBox()).y);

// ------------------------------------------------------------- Status

const status = await kv();
check("Status reads the address", status.Address === "192.0.2.10", JSON.stringify(status));
check("what it is plugged into, with the far port", status["Plugged into"] === "ACCESS-SW7 Gi1/0/1", status["Plugged into"]);
check("who found it", status["Seen by"] === "crawl", status["Seen by"]);
check("the platform from vendor, model and software", status.Platform === "Contoso · CS-9000 · 4.1", status.Platform);
check("and the serial", status.Serial === "FAKE0000001", status.Serial);
check("a device with no check says so", status["Last check"] === "No check on this device", status["Last check"]);
check("the recent-status strip is on Status", (await insp.locator(".cv-history").count()) === 1);
check("and the form is not", (await insp.locator(".cv-field", { hasText: /^Display name/ }).count()) === 0);

// Values on Status come from the form, so a change there shows here.
await tabNamed("Identity").click();
await page.waitForTimeout(150);
check("Identity holds the form", (await insp.locator(".cv-field", { hasText: /^Display name/ }).locator("input").inputValue()) === "CORE-SW1");
await insp.locator(".cv-field", { hasText: /^Vendor/ }).locator("input").fill("Fabrikam");
await page.waitForTimeout(150);
await tabNamed("Status").click();
await page.waitForTimeout(150);
check("and Status follows an edit made there", (await kv()).Platform === "Fabrikam · CS-9000 · 4.1", (await kv()).Platform);

// Arrows walk the tabs (LT-240), and the one chosen is kept across a selection.
await tabNamed("Status").focus();
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(150);
check("the right arrow moves to Identity", (await st(() => window.__cvStore.getState().inspectorTab)) === "identity");
await page.keyboard.press("End");
await page.waitForTimeout(150);
check("End reaches Notes", (await st(() => window.__cvStore.getState().inspectorTab)) === "notes");
check("Notes holds the notes", (await insp.locator(".cv-field", { hasText: /^Notes/ }).locator("textarea").inputValue()) === "spare PSU in the cupboard");
check("the comments", (await insp.locator("section[aria-label=Comments]").count()) === 1);
check("and the attachments", (await insp.locator("section[aria-label=Attachments]").count()) === 1);
await st(() => window.__cvStore.getState().select("n2", null));
await page.waitForTimeout(300);
check("selecting another device keeps the tab", (await st(() => window.__cvStore.getState().inspectorTab)) === "notes" && (await tabNamed("Notes").getAttribute("aria-selected")) === "true");

// ------------------------------------------------------------- Ports and Checks

await tabNamed("Ports").click();
await page.waitForTimeout(150);
check("Ports holds the count, the naming and what it connects to",
  (await insp.locator(".cv-field", { hasText: /^Ports/ }).count()) === 1 && (await insp.locator(".cv-field", { hasText: /^Port naming/ }).count()) === 1 && (await insp.locator(".cv-field", { hasText: /^Connects to/ }).count()) === 1);
const neighbours = insp.locator("section[aria-label=Neighbours] tbody tr");
check("and the neighbours, with the port at each end", (await neighbours.count()) === 1 && /Gi1\/0\/1.*CORE-SW1.*Gi1\/0\/48/s.test(await neighbours.first().innerText()), await neighbours.first().innerText());

await tabNamed("Checks").click();
await page.waitForTimeout(150);
check("Checks holds the addresses and the probes", (await insp.locator("button", { hasText: /^Add address$/ }).count()) === 1 && (await insp.locator("button", { hasText: /^Add probe$/ }).count()) === 1);
await insp.locator("button", { hasText: /^Add probe$/ }).click();
await page.waitForTimeout(200);
check("and a probe added there is on the device", (await st(() => window.__cvStore.getState().doc.probes.filter((p) => p.objectId === "n2").length)) === 1);
await tabNamed("Status").click();
await page.waitForTimeout(150);
check("after which Status says it has not been checked yet", (await kv())["Last check"] === "Not checked yet", (await kv())["Last check"]);

// ------------------------------------------------------------- the action row

const actions = insp.locator(".cv-inspector-actions button");
check("the action row is SSH, Backup, Where is, Open as drawer",
  JSON.stringify(await actions.allInnerTexts()) === JSON.stringify(["SSH", "Backup", "Where is", "Open as drawer"]), (await actions.allInnerTexts()).join(" | "));
check("above the tabs", (await actions.first().boundingBox()).y < (await tabNamed("Status").boundingBox()).y);

await actions.filter({ hasText: /^Backup$/ }).click();
await page.waitForTimeout(500);
check("Backup opens the Backups tab", (await st(() => window.__cvStore.getState().dockTab)) === "backup");
const ticked = page.locator('.cv-panel-body input[type=checkbox][aria-label^="Back up "]:checked');
check("with this device ticked and no other", (await ticked.count()) === 1 && (await ticked.first().getAttribute("aria-label")) === "Back up ACCESS-SW7",
  `${await ticked.count()} ${await ticked.first().getAttribute("aria-label").catch(() => "")}`);

await actions.filter({ hasText: /^Where is$/ }).click();
await page.waitForTimeout(500);
check("Where is opens that tab", (await st(() => window.__cvStore.getState().dockTab)) === "whereis");
check("with the device's address as the question", (await page.locator(".cv-whereis input.cv-mono").inputValue()) === "192.0.2.11");

await actions.filter({ hasText: /^Open as drawer$/ }).click();
await page.waitForTimeout(300);
check("Open as drawer still opens the drawer", (await page.locator(".cv-drawer").count()) === 1);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
// Escape closes the drawer and, on the canvas, the selection with it.
await st(() => window.__cvStore.getState().select("n2", null));
await page.waitForTimeout(300);

// SSH without a credential of its own and without the project's: refused with a
// reason, before anything is sent (LT-320).
await actions.filter({ hasText: /^SSH$/ }).click();
await page.waitForTimeout(400);
const message = await page.locator(".cv-panel-message").innerText().catch(() => "");
check("SSH with no login says why it did not open", /credential|log ?in|password/i.test(message), message);

// ------------------------------------------------------------- notes and links are untouched

await st(() => window.__cvStore.getState().select(null, "e1"));
await page.waitForTimeout(300);
check("a link's inspector has no tabs", (await tabs.count()) === 0);
check("and still takes a cable length", (await insp.locator(".cv-field", { hasText: "Cable length" }).locator("input").count()) === 1);

await browser.close();
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall inspector checks passed");
