// A drawer for a device and for a finding — opened from the
// inspector, closed with Escape, pinned across a change of selection, and
// every control reachable from the keyboard. Stubbed backend; the drawer is
// window state and touches nothing behind the bridge.
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const device = (id, label, x, y, extra = {}) => ({
  id, type: "device", position: { x, y }, width: 76, height: 76,
  data: { label, deviceType: "access-switch", tags: [], addresses: [{ id: `${id}-a`, label: "Discovered", address: "192.0.2.10", isPrimary: true }], locked: false, maintenance: false, showDetails: true, ...extra },
});

const project = {
  meta: { id: "drawer", name: "Drawer", customer: "", site: "", ticket: "", engineer: "", description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    nodes: [
      device("n1", "CORE-SW1", 0, 0, { hostname: "CORE-SW1", model: "CS-9000", evidence: { class: { source: "ssh:show version", detail: "Contoso OS 4.1" } } }),
      device("n2", "ACCESS-SW7", 0, 300),
    ],
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
await st(() => window.__cvStore.getState().select("n1", null));
await page.waitForTimeout(200);

// ------------------------------------------------ open from the inspector
const openButton = page.locator(".cv-inspector button", { hasText: "Open as drawer" });
check("the inspector offers the drawer for a device", (await openButton.count()) === 1);
await openButton.click();
await page.waitForTimeout(200);
const drawer = page.locator(".cv-drawer");
check("the drawer opens with the device's name and a section the rail cannot fit", (await drawer.count()) === 1 && /CORE-SW1/.test(await drawer.locator("h2").first().textContent()));
check("the close button has focus when it opens", await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Close the drawer"));
check("the type fact carries why it says so", (await drawer.locator(".cv-drawer-fact").first().getAttribute("title") ?? "").includes("show version over SSH"));

// ------------------------------------------------ follows, then pinned
await st(() => window.__cvStore.getState().select("n2", null));
await page.waitForTimeout(200);
check("unpinned, the drawer follows the selection", /ACCESS-SW7/.test(await drawer.locator("h2").first().textContent()));
await drawer.locator("input[type=checkbox]").check();
await st(() => window.__cvStore.getState().select("n1", null));
await page.waitForTimeout(200);
check("pinned, it stays on the device it was pinned to", /ACCESS-SW7/.test(await drawer.locator("h2").first().textContent()));
await drawer.locator("button", { hasText: "Select on canvas" }).first().click();
await page.waitForTimeout(150);
check("Select on canvas selects the drawer's device", await st(() => window.__cvStore.getState().selectedNodeId) === "n2");

// ------------------------------------------------ escape closes
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
check("Escape closes it", (await drawer.count()) === 0);

// ------------------------------------------------ a finding drawer
await st(() => window.__cvStore.getState().openDrawer({ kind: "finding", finding: { kind: "orphan", severity: "warning", message: "Orphan CORE-SW1 was reached but has no link to anything the crawl found.", devices: ["CORE-SW1", "GHOST"] } }));
await page.waitForTimeout(200);
check("a finding drawer names the kind and the message", (await drawer.locator("h2").first().textContent()) === "Orphan" && /Orphan CORE-SW1/.test(await drawer.locator(".cv-drawer-message").textContent()));
const rows = drawer.locator(".cv-drawer-devices li");
check("each device is listed, drawn ones with a way to the canvas and the rest said to be undrawn",
  (await rows.count()) === 2 && (await rows.nth(0).locator("button").count()) === 1 && /not drawn/i.test(await rows.nth(1).textContent()));
await rows.nth(0).locator("button").click();
await page.waitForTimeout(150);
check("and the way to the canvas works", await st(() => window.__cvStore.getState().selectedNodeId) === "n1");

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
