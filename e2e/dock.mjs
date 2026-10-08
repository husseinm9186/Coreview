// The dock — the same tabs grouped by what they answer, the job
// strip along its bottom with the clock, and Pop out, which sends it down the
// right of the window and is remembered. Stubbed backend; the dock is window
// state and touches nothing behind the bridge.
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const device = (id, label, x, y) => ({
  id, type: "device", position: { x, y }, width: 76, height: 76,
  data: { label, deviceType: "access-switch", tags: [], addresses: [{ id: `${id}-a`, label: "Discovered", address: "192.0.2.10", isPrimary: true }], locked: false, maintenance: false, showDetails: true },
});

const project = {
  meta: { id: "dock", name: "Dock", customer: "", site: "", ticket: "", engineer: "", description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    nodes: [device("n1", "CORE-SW1", 0, 0), device("n2", "ACCESS-SW7", 0, 300)],
    edges: [],
    probes: [],
    canvas: {},
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.addInitScript(({ p }) => {
  localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
  let next = 1;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return next++; },
    invoke(cmd) {
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "", engineer: "", description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({});
      return Promise.resolve([]);
    },
  };
}, { p: project });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(700);

const st = (fn, arg) => page.evaluate(fn, arg);
const box = (sel) => page.locator(sel).first().boundingBox();

// ------------------------------------------------------------- the groups

const groups = page.locator(".cv-panel .cv-tabs .cv-tab-group");
check("the tabs sit in four groups", (await groups.count()) === 4, `${await groups.count()}`);
const names = await page.locator(".cv-tab-group-name").allTextContents();
check("named Monitor, Discover, Paths and Ops, in that order",
  JSON.stringify(names) === JSON.stringify(["Monitor", "Discover", "Paths", "Ops"]), names.join(" | "));

const under = async (group) => page.locator(`.cv-tab-group[data-group="${group}"] button[role="tab"]`).allInnerTexts();
check("Monitor holds the objects and the timeline, with their counts",
  JSON.stringify(await under("monitor")) === JSON.stringify(["Monitored objects (2)", "Event timeline (0)"]), (await under("monitor")).join(" | "));
// Collect is under Discover devices ▸ Advanced now.
check("Discover holds the crawler and the ping sweep",
  JSON.stringify(await under("discover")) === JSON.stringify(["Discover devices", "Ping sweep"]), (await under("discover")).join(" | "));
check("Paths holds the four answers to where it goes",
  JSON.stringify(await under("paths")) === JSON.stringify(["Path-Trace", "Path check", "Tracert", "Where is"]), (await under("paths")).join(" | "));
check("Ops holds Backups and SSH",
  JSON.stringify(await under("ops")) === JSON.stringify(["Backups", "SSH"]), (await under("ops")).join(" | "));
check("every tab is there exactly once", (await page.locator('.cv-panel button[role="tab"]').count()) === 10);

// the arrows still walk the tabs, past the group headings.
await page.locator('.cv-panel button[role="tab"]', { hasText: "Monitored objects" }).focus();
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(150);
check("the right arrow moves to the timeline", (await st(() => window.__cvStore.getState().dockTab)) === "events");
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(150);
check("and on into the next group", (await st(() => window.__cvStore.getState().dockTab)) === "crawl");
check("which the rail marks as Discover", (await page.locator(".cv-nav-item.is-current").innerText()) === "Discover");
await page.keyboard.press("End");
await page.waitForTimeout(150);
check("End reaches SSH, the last tab", (await st(() => window.__cvStore.getState().dockTab)) === "ssh");
await page.locator('.cv-panel button[role="tab"]', { hasText: "Monitored objects" }).click();
await page.waitForTimeout(150);

// ------------------------------------------------------------- the strip

check("the strip runs along the dock's bottom",
  (await box(".cv-panel .cv-dock-strip")).y > (await box(".cv-panel-body")).y);
const clock = page.locator(".cv-dock-clock");
const dtg = await clock.innerText();
check("with the clock in the DTG the setting starts on", /^\d{6}Z [A-Z]{3} \d{2}$/.test(dtg), dtg);
await st(() => window.__cvStore.getState().setSettings({ timeFormat: "local-24" }));
await page.waitForTimeout(150);
const local = await clock.innerText();
check("and the clock follows Settings ▸ Times", local !== dtg && /\d{2}:\d{2}/.test(local), local);
await st(() => window.__cvStore.getState().setSettings({ timeFormat: "dtg-zulu" }));

check("no job, no job line", (await page.locator(".cv-dock-strip .cv-job").count()) === 0);
await st(() => window.__cvStore.getState().setJobs([{ id: 7, kind: "backup", state: "running", phase: "saving", done: 2, total: 5, startedMs: Date.now() - 5000 }]));
await page.waitForTimeout(200);
const line = page.locator(".cv-dock-strip .cv-job");
check("a running job shows in the strip", (await line.count()) === 1);
check("with what it is and how far it has got", /Backup.*2 of 5/.test(await line.innerText()), await line.innerText());
check("and Cancel", (await line.locator("button", { hasText: "Cancel" }).count()) === 1);
check("the top bar does not repeat it while the dock is in sight", (await page.locator(".cv-topbar .cv-jobs").count()) === 0);

await page.locator(".cv-nav-item.cv-btn-tools").click();
await page.waitForTimeout(300);
check("a screen over the dock puts the job line in the top bar instead", (await page.locator(".cv-topbar .cv-jobs .cv-job").count()) === 1);
await page.locator(".cv-nav-item", { hasText: /^Diagram$/ }).click();
await page.waitForTimeout(300);
check("and back", (await page.locator(".cv-topbar .cv-jobs").count()) === 0 && (await line.count()) === 1);

await page.locator(".cv-panel button", { hasText: /^Hide$/ }).click();
await page.waitForTimeout(250);
check("folded away, the dock still shows the strip", (await page.locator(".cv-panel.is-collapsed .cv-dock-strip .cv-job").count()) === 1);
await page.locator(".cv-panel.is-collapsed button", { hasText: "Show status and events" }).click();
await page.waitForTimeout(250);
await st(() => window.__cvStore.getState().setJobs([]));

// ------------------------------------------------------------- pop out

const side = page.locator('[data-action="dock-side"]');
check("the dock offers Pop out", (await side.innerText()) === "Pop out");
const below = { panel: await box(".cv-panel"), canvas: await box(".cv-canvas") };
check("and starts along the bottom, under the canvas", below.panel.y >= below.canvas.y + below.canvas.height - 1,
  JSON.stringify(below));
await side.click();
await page.waitForTimeout(400);
const right = { panel: await box(".cv-panel"), canvas: await box(".cv-canvas"), inspector: await box(".cv-inspector"), main: await box(".cv-main") };
check("Pop out puts the dock down the right of the window",
  right.panel.x >= right.canvas.x + right.canvas.width && right.panel.x + right.panel.width >= 1498, JSON.stringify(right));
check("the full height of the body", right.panel.height > 800, `${right.panel.height}`);
check("without the inspector running under it", right.inspector.x + right.inspector.width <= right.panel.x + 1, JSON.stringify(right));
check("and the button now reads Dock below", (await side.innerText()) === "Dock below");
check("the tabs still answer", (await page.locator('.cv-panel button[role="tab"]').count()) === 10);

// F5 hides the dock wherever it is.
await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
await page.keyboard.press("F5");
await page.waitForTimeout(300);
check("presenting hides the popped-out dock", (await page.locator(".cv-panel").isVisible()) === false);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("and Escape brings it back where it was", (await page.locator(".cv-panel").isVisible()) === true && (await box(".cv-panel")).x > 800);

// Remembered on this machine, like the panels.
await page.reload({ waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(700);
if (await page.locator(".cv-recovery").count()) {
  await page.locator(".cv-recovery button", { hasText: "Keep what was saved" }).click();
  await page.waitForTimeout(300);
}
check("the side is remembered across a reopen", (await box(".cv-panel")).x > 800 && (await side.innerText()) === "Dock below");
await side.click();
await page.waitForTimeout(400);
const back = { panel: await box(".cv-panel"), canvas: await box(".cv-canvas") };
check("Dock below puts it back under the canvas", back.panel.y >= back.canvas.y + back.canvas.height - 1 && back.panel.width > 1200,
  JSON.stringify(back));
check("and that is remembered too", (await st(() => localStorage.getItem("coreview.view.dockSide"))) === "bottom");

await browser.close();
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall dock checks passed");
