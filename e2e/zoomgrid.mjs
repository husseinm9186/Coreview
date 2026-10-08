// The wheel, the zoom and the grid: what the wheel does is a
// setting; Ctrl+= and Ctrl+− zoom, Ctrl+0 is actual size; the toolbar says
// the zoom and offers presets; the grid's gap follows the zoom and can be
// lines, dots or none; the page grows under content unless told not to.
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
  data: { label, deviceType: "access-switch", tags: [], addresses: [], locked: false, maintenance: false, showDetails: true },
});

const project = {
  meta: { id: "zoomgrid", name: "Zoom and grid", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    nodes: [device("a", "SW-A", 300, 300), device("b", "SW-B", 700, 300)],
    edges: [],
    probes: [],
    canvas: {},
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.addInitScript(({ p }) => {
  localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
  localStorage.removeItem("coreview.view.wheel");
  let next = 1;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return next++; },
    invoke(cmd) {
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "", engineer: "",
        description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
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
await page.waitForTimeout(900);

const st = (fn, arg) => page.evaluate(fn, arg);
const viewport = () => page.evaluate(() => {
  const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector(".react-flow__viewport")).transform);
  return { x: Math.round(m.e), y: Math.round(m.f), zoom: +m.a.toFixed(3) };
});
const paneCentre = async () => {
  const b = await page.locator(".react-flow__pane").boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const settle = () => page.waitForTimeout(350);

// ------------------------------------------------------------- the wheel

{
  const c = await paneCentre();
  await page.mouse.move(c.x, c.y);
  const before = await viewport();
  await page.mouse.wheel(0, -240);
  await settle();
  const after = await viewport();
  check("by default the wheel zooms", after.zoom > before.zoom, JSON.stringify({ before, after }));
  // Shift+wheel scrolls instead.
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 120);
  await page.keyboard.up("Shift");
  await settle();
  const shifted = await viewport();
  check("Shift+wheel scrolls without changing the zoom", shifted.zoom === after.zoom && (shifted.x !== after.x || shifted.y !== after.y), JSON.stringify({ after, shifted }));

  await st(() => window.__cvStore.getState().setSettings({ wheel: "scroll" }));
  await settle();
  const b0 = await viewport();
  await page.mouse.wheel(0, 120);
  await settle();
  const b1 = await viewport();
  check("set to scroll, the wheel scrolls", b1.zoom === b0.zoom && b1.y !== b0.y, JSON.stringify({ b0, b1 }));
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -240);
  await page.keyboard.up("Control");
  await settle();
  const b2 = await viewport();
  check("and Ctrl+wheel zooms", b2.zoom > b1.zoom, JSON.stringify({ b1, b2 }));
  check("the choice is remembered for this machine", (await st(() => localStorage.getItem("coreview.view.wheel"))) === "scroll");
  await st(() => window.__cvStore.getState().setSettings({ wheel: "zoom" }));
  await settle();
}

// ------------------------------------------------------------- keys and presets

{
  await page.locator(".react-flow__pane").click({ position: { x: 40, y: 40 } });
  const z0 = (await viewport()).zoom;
  await page.keyboard.press("Control+=");
  await settle();
  const z1 = (await viewport()).zoom;
  check("Ctrl+= zooms in", z1 > z0, `${z0} → ${z1}`);
  await page.keyboard.press("Control+-");
  await settle();
  const z2 = (await viewport()).zoom;
  check("Ctrl+− zooms out", z2 < z1, `${z1} → ${z2}`);
  await page.keyboard.press("Control+0");
  await settle();
  check("Ctrl+0 is actual size", (await viewport()).zoom === 1, String((await viewport()).zoom));
  check("the toolbar says the zoom", (await page.locator('[data-region="zoom-level"]').innerText()).trim() === "100 %", await page.locator('[data-region="zoom-level"]').innerText());
  await page.locator('[data-region="zoom-level"]').click();
  await page.locator(".cv-zoom-menu button", { hasText: /^200 %/ }).click();
  await settle();
  check("a preset sets it", (await viewport()).zoom === 2 && (await page.locator('[data-region="zoom-level"]').innerText()).trim() === "200 %", String((await viewport()).zoom));
  await page.locator('[data-region="zoom-level"]').click();
  await page.locator(".cv-zoom-menu button", { hasText: /^25 %/ }).click();
  await settle();
  check("and another", (await viewport()).zoom === 0.25);
}

// ------------------------------------------------------------- the grid follows the zoom

{
  const minor = () => page.locator(".cv-page").getAttribute("data-grid-minor");
  check("at a quarter the grid's gap has doubled twice: 48 units, 12 px on screen", (await minor()) === "48", await minor());
  await page.locator('[data-region="zoom-level"]').click();
  await page.locator(".cv-zoom-menu button", { hasText: /^100 %/ }).click();
  await settle();
  check("at 100 % it is 12", (await minor()) === "12", await minor());
  await page.locator('[data-region="zoom-level"]').click();
  await page.locator(".cv-zoom-menu button", { hasText: /^400 %/ }).click();
  await settle();
  check("at four times it has halved twice: 3", (await minor()) === "3", await minor());
  const pattern = await page.locator("#cv-grid-minor").getAttribute("width");
  check("and the drawn pattern says the same", pattern === "3", pattern);
  // Snapping lands on the grid that is drawn.
  await st(() => window.__cvStore.getState().setGridSnap(true));
  const moved = await st(() => {
    const s = window.__cvStore.getState();
    const n = s.doc.pages[0].nodes.find((x) => x.id === "a");
    s.onNodesChange([{ id: "a", type: "position", position: { x: n.position.x + 4, y: n.position.y + 4 }, dragging: true }]);
    s.onNodesChange([{ id: "a", type: "position", dragging: false }]);
    return s.doc.pages[0].nodes.find((x) => x.id === "a").position;
  });
  check("snapping at four times lands on a 3-unit step", moved.x % 3 === 0 && moved.y % 3 === 0, JSON.stringify(moved));
  await st(() => window.__cvStore.getState().setGridSnap(false));
  await page.locator('[data-region="zoom-level"]').click();
  await page.locator(".cv-zoom-menu button", { hasText: /^100 %/ }).click();
  await settle();

  await page.locator('[data-region="grid-menu"]').click();
  await page.locator(".cv-grid-menu button", { hasText: /^dots$/ }).click();
  await settle();
  check("dots draws dots", (await page.locator(".cv-page").getAttribute("data-grid")) === "dots" && (await page.locator("#cv-grid-minor circle").count()) === 1);
  await page.locator('[data-region="grid-menu"]').click();
  await page.locator(".cv-grid-menu button", { hasText: /^none$/ }).click();
  await settle();
  check("none draws no grid, and the page's setting says so", (await page.locator(".cv-page-grid").count()) === 0 && (await st(() => window.__cvStore.getState().doc.pages[0].canvas.gridEnabled)) === false);
  await page.locator('[data-region="grid-menu"]').click();
  await page.locator(".cv-grid-menu button", { hasText: /^lines$/ }).click();
  await settle();
  check("lines draws lines again", (await page.locator("#cv-grid-minor path").count()) === 1);
}

// ------------------------------------------------------------- the page grows, unless told not to

{
  const sheet = () => st(() => window.__cvStore.getState().doc.pages[0].canvas.sheetRect ?? null);
  const pageBox = () => page.locator(".cv-page").evaluate((e) => ({ w: parseFloat(e.style.width), h: parseFloat(e.style.height) }));
  const w0 = (await pageBox()).w;
  const openGrid = () => page.locator(".cv-grid-menu").evaluate((d) => { d.open = true; });
  await openGrid();
  await page.locator(".cv-grid-menu .cv-check input").uncheck();
  await st(() => {
    const doc = window.__cvStore.getState().doc;
    const pages = doc.pages.map((p) => (p.id === doc.activePageId ? { ...p, nodes: p.nodes.map((n) => (n.id === "b" ? { ...n, position: { x: 2600, y: 300 } } : n)) } : p));
    window.__cvStore.setState({ doc: { ...doc, pages } });
  });
  await page.waitForTimeout(700);
  check("with growth off, a device put past the edge leaves the page as it was", (await pageBox()).w === w0 && (await st(() => window.__cvStore.getState().doc.pages[0].canvas.growPage)) === false, JSON.stringify({ w0, now: await pageBox(), sheet: await sheet() }));
  await openGrid();
  await page.locator(".cv-grid-menu .cv-check input").check();
  await page.waitForTimeout(700);
  check("with growth on, the page grows to hold it", (await pageBox()).w > w0 && (await sheet())?.w > w0, JSON.stringify({ w0, now: await pageBox(), sheet: await sheet() }));
}

await browser.close();
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall zoom and grid checks passed");
