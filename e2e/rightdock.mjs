// Discover and Terminal open in a right dock, beside the inspector, never
// replacing it: Discover devices at a narrow column, the terminal at half the
// window, the wide tables still along the bottom. The side is remembered per
// tab. Discover's run bar is a sticky footer; the terminal has its own.
// Stubbed backend. Invented names only.
//
//     npm run dev            # in another terminal
//     node e2e/rightdock.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const project = {
  meta: { id: "rd", name: "Right dock", customer: "", site: "", ticket: "", engineer: "", description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    nodes: [{ id: "n1", type: "device", position: { x: 0, y: 0 }, width: 76, height: 76,
      data: { label: "CORE-1", deviceType: "core-switch", tags: [], addresses: [], locked: false, maintenance: false, showDetails: false } }],
    edges: [], probes: [], canvas: {},
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

const box = (sel) => page.locator(sel).first().boundingBox();
const tab = (name) => page.locator('.cv-panel button[role="tab"]', { hasText: name }).first();
const openTab = async (name) => { await tab(name).click(); await page.waitForTimeout(400); };
const st = (fn, arg) => page.evaluate(fn, arg);
const body = () => page.locator(".cv-body");
const hasClass = async (sel, cls) => (await page.locator(sel).first().getAttribute("class"))?.split(/\s+/).includes(cls);

// --- the wide tables stay along the bottom -----------------------------
{
  await openTab("Monitored objects");
  const b = { panel: await box(".cv-panel"), canvas: await box(".cv-canvas") };
  check("Monitored objects is along the bottom", !(await hasClass(".cv-body", "is-dock-right")) && b.panel.y >= b.canvas.y + b.canvas.height - 1, JSON.stringify(b));
}

// --- Discover devices opens on the right, narrow, beside the inspector --
{
  await openTab("Discover devices");
  check("Discover devices moves the dock to the right", await hasClass(".cv-body", "is-dock-right"));
  check("at a narrow width, not half the window", await hasClass(".cv-body", "is-dock-narrow"));
  const r = { panel: await box(".cv-panel"), canvas: await box(".cv-canvas"), inspector: await box(".cv-inspector") };
  check("down the right of the window", r.panel.x >= r.canvas.x + r.canvas.width && r.panel.x + r.panel.width >= 1498, JSON.stringify(r));
  check("the inspector is still there, to the left of the dock", r.inspector && r.inspector.width > 1 && r.inspector.x + r.inspector.width <= r.panel.x + 1, JSON.stringify(r));
  check("about a third of the window wide", r.panel.width > 340 && r.panel.width < 560, String(r.panel.width));
  check("its run bar is a sticky footer with a one-line summary", (await page.locator(".cv-discover-run .cv-discover-run-summary").isVisible()), "");
  check("and the Discover button is on it", (await page.locator('.cv-discover-run [data-region="crawl-start"]').count()) === 1);
}

// --- the terminal opens on the right at half the window ----------------
{
  await openTab("SSH");
  check("SSH is on the right too", await hasClass(".cv-body", "is-dock-right"));
  check("but wider — half the window", await hasClass(".cv-body", "is-dock-wide"));
  const r = { panel: await box(".cv-panel"), canvas: await box(".cv-canvas") };
  check("noticeably wider than Discover", r.panel.width > 560, String(r.panel.width));
  check("it has its own footer", (await page.locator('[data-region="ssh-foot"]').count()) === 1);
}

// --- back to a wide table, back to the bottom --------------------------
{
  await openTab("Path check");
  check("switching to Path check brings the dock back to the bottom", !(await hasClass(".cv-body", "is-dock-right")));
}

// --- the side is remembered per tab ------------------------------------
{
  await openTab("Discover devices");
  const side = page.locator('[data-action="dock-side"]');
  check("on Discover the button offers to dock below", (await side.innerText()) === "Dock below");
  await side.click();
  await page.waitForTimeout(400);
  check("docking it below moves it to the bottom", !(await hasClass(".cv-body", "is-dock-right")));
  check("and it is remembered for that tab", (await st(() => JSON.parse(localStorage.getItem("coreview.view.dockPlacements") ?? "{}"))).crawl === "bottom");
  // SSH is untouched by Discover's override.
  await openTab("SSH");
  check("the terminal still opens on the right", await hasClass(".cv-body", "is-dock-right"));

  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".cv-project-open").first().click();
  await page.waitForTimeout(700);
  if (await page.locator(".cv-recovery").count()) {
    await page.locator(".cv-recovery button", { hasText: "Keep what was saved" }).click();
    await page.waitForTimeout(300);
  }
  await openTab("Discover devices");
  check("after a reopen Discover is still along the bottom where it was left", !(await hasClass(".cv-body", "is-dock-right")));
}

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
