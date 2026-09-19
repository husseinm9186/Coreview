// Getting around a diagram, driven through the real app (LT-191, LT-192,
// LT-193): zoom to the selection, saved views, presentation, and the minimap
// coloured by health. Invented names only (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/viewing.mjs
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
  data: { label, deviceType: "router", tags: [], addresses: [], locked: false, maintenance: false, showDetails: false },
});
const project = {
  meta: { id: "viewing", name: "Viewing", customer: "", site: "", ticket: "", engineer: "", description: "",
    createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    nodes: [device("near", "LAB-NEAR", 0, 0), device("far", "LAB-FAR", 3000, 2000), device("mid", "LAB-MID", 1500, 1000)],
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
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      if (cmd === "plugin:dialog|save") return Promise.resolve("/tmp/coreview-viewing-test.svg");
      if (cmd === "save_export") {
        const bytes = Uint8Array.from(atob(args.contentsB64), (c) => c.charCodeAt(0));
        (window.__exports ??= []).push(new TextDecoder().decode(bytes));
        return Promise.resolve(null);
      }
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "", engineer: "",
        description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({ minimap: "true" });
      return Promise.resolve([]);
    },
  };
}, { p: project });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(1000);
if (await page.locator(".cv-recovery").count()) {
  await page.locator(".cv-recovery button", { hasText: "Keep what was saved" }).click();
}

const viewport = () => page.locator(".react-flow__viewport").evaluate((el) => {
  const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
  return { x: Math.round(m.e), y: Math.round(m.f), zoom: +m.a.toFixed(3) };
});
const centreOf = (id) => page.evaluate((i) => {
  const r = document.querySelector(`.react-flow__node[data-id="${i}"]`).getBoundingClientRect();
  const pane = document.querySelector(".react-flow__pane").getBoundingClientRect();
  return { dx: Math.round(r.x + r.width / 2 - (pane.x + pane.width / 2)), dy: Math.round(r.y + r.height / 2 - (pane.y + pane.height / 2)) };
}, id);
const canvasMenu = async (label) => {
  const bare = await page.evaluate(() => {
    const r = document.querySelector(".react-flow__pane").getBoundingClientRect();
    for (let y = r.top + 40; y < r.bottom - 40; y += 30)
      for (let x = r.left + 40; x < r.right - 40; x += 30)
        if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
    return null;
  });
  await page.mouse.click(bare.x, bare.y, { button: "right" });
  await page.waitForTimeout(250);
  const item = page.locator(".cv-menu button", { hasText: label });
  const found = (await item.count()) > 0;
  if (found) await item.first().click();
  else await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  return found;
};

// ------------------------------------------------------------- LT-192 zoom to selection
// Selected the way React Flow selects: at the fitted zoom the device is a few
// pixels across, and a click on it is a test of the mouse, not of this.
await page.evaluate(() => window.__cvStore.getState().onNodesChange([{ type: "select", id: "far", selected: true }]));
await page.waitForTimeout(200);
await page.mouse.move(5, 5);
await page.keyboard.press("Shift+F");
await page.waitForTimeout(500);
let c = await centreOf("far");
check("Shift+F centres the selected device", Math.abs(c.dx) < 30 && Math.abs(c.dy) < 30, JSON.stringify(c));
check("and zooms in on it", (await viewport()).zoom >= 1.5, JSON.stringify(await viewport()));

// ------------------------------------------------------------- LT-192 saved views
const atFar = await viewport();
check("the canvas menu saves this view", await canvasMenu("Save this view"));
const saved = await page.evaluate(() => {
  const d = window.__cvStore.getState().doc;
  const pg = d.pages.find((p) => p.id === d.activePageId) ?? d.pages[0];
  return pg.canvas.viewpoints ?? [];
});
check("as View 1 on the page, where the viewport was",
  saved.length === 1 && saved[0].name === "View 1" && Math.round(saved[0].x) === atFar.x && +saved[0].zoom.toFixed(3) === atFar.zoom,
  JSON.stringify({ saved, atFar }));
await page.keyboard.press("f");
await page.waitForTimeout(500);
check("fitting the sheet moves away from it", JSON.stringify(await viewport()) !== JSON.stringify(atFar));
await page.keyboard.press("Alt+1");
await page.waitForTimeout(600);
const back = await viewport();
check("Alt+1 comes back to it", Math.abs(back.x - atFar.x) <= 1 && Math.abs(back.y - atFar.y) <= 1 && back.zoom === atFar.zoom,
  JSON.stringify({ back, atFar }));
check("the canvas menu can forget it", await canvasMenu("Forget View 1"));
const left = await page.evaluate(() => {
  const d = window.__cvStore.getState().doc;
  return (d.pages.find((p) => p.id === d.activePageId) ?? d.pages[0]).canvas.viewpoints ?? [];
});
check("and then it is gone", left.length === 0, JSON.stringify(left));

// ------------------------------------------------------------- LT-191 minimap health
check("the minimap is drawn plain by default", (await page.locator(".cv-minimap.is-health").count()) === 0);
check("the canvas menu colours it by health", await canvasMenu("Colour the minimap by health"));
check("which it then is", (await page.locator(".cv-minimap.is-health").count()) === 1);
check("with each device carrying its status", (await page.locator(".cv-minimap .cv-mm-unknown").count()) === 3,
  `${await page.locator(".cv-minimap .cv-mm-unknown").count()}`);

// ------------------------------------------------------------- LT-193 presentation
await page.evaluate(() => window.__cvStore.getState().addPage("Second page"));
await page.waitForTimeout(300);
await page.evaluate(() => {
  const s = window.__cvStore.getState();
  s.setActivePage(s.doc.pages[0].id);
});
await page.waitForTimeout(300);
await page.mouse.move(5, 5);
await page.keyboard.press("F5");
await page.waitForTimeout(500);
const chrome = () => page.evaluate(() => ({
  presenting: document.querySelector(".cv-workspace")?.classList.contains("is-presenting"),
  topbar: [...document.querySelectorAll(".cv-topbar-wrap")].some((e) => e.getBoundingClientRect().height > 0),
  palette: [...document.querySelectorAll(".cv-palette")].some((e) => e.getBoundingClientRect().width > 0),
  inspector: [...document.querySelectorAll(".cv-inspector")].some((e) => e.getBoundingClientRect().width > 0),
  tabs: [...document.querySelectorAll(".cv-page-tabs")].some((e) => e.getBoundingClientRect().height > 0),
  canvasWidth: document.querySelector(".cv-canvas")?.getBoundingClientRect().width ?? 0,
}));
let ch = await chrome();
check("F5 presents", ch.presenting === true, JSON.stringify(ch));
check("with the toolbar, panels and page tabs gone", !ch.topbar && !ch.palette && !ch.inspector && !ch.tabs, JSON.stringify(ch));
check("and the diagram filling the window", ch.canvasWidth >= 1400, JSON.stringify(ch));
const activeName = () => page.evaluate(() => {
  const d = window.__cvStore.getState().doc;
  return (d.pages.find((p) => p.id === d.activePageId) ?? d.pages[0]).name;
});
const first = await activeName();
await page.keyboard.press("PageDown");
await page.waitForTimeout(300);
check("Page Down goes to the next page", (await activeName()) === "Second page", `${first} -> ${await activeName()}`);
await page.keyboard.press("ArrowLeft");
await page.waitForTimeout(300);
check("the left arrow goes back", (await activeName()) === first, await activeName());
await page.keyboard.press("Delete");
await page.waitForTimeout(200);
const stillThree = await page.evaluate(() => {
  const d = window.__cvStore.getState().doc;
  return (d.pages.find((p) => p.id === d.activePageId) ?? d.pages[0]).nodes.length;
});
check("editing keys do nothing while presenting", stillThree === 3, `${stillThree}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
ch = await chrome();
check("Esc leaves presentation, and the chrome comes back", ch.presenting === false && ch.topbar, JSON.stringify(ch));

// ------------------------------------------------------------- LT-189 far zoom
{
  // Below 500 objects the canvas never drops detail: this three-device page
  // keeps it at any zoom.
  const pb0 = await page.locator(".react-flow__pane").boundingBox();
  await page.mouse.move(pb0.x + pb0.width / 2, pb0.y + pb0.height / 2);
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 120);
  await page.waitForTimeout(400);
  check("a small page keeps its detail however far out it is zoomed",
    (await page.locator(".cv-canvas.is-far").count()) === 0, `zoom ${(await viewport()).zoom}`);
  // A large page: 600 more devices, far off to one side.
  await page.evaluate(() => {
    const st = window.__cvStore.getState();
    const d = st.doc;
    const extra = Array.from({ length: 600 }, (_, i) => ({
      id: `bulk${i}`, type: "device", position: { x: 8000 + (i % 30) * 160, y: 8000 + Math.floor(i / 30) * 140 },
      width: 76, height: 76,
      data: { label: `BULK-${i}`, deviceType: "access-switch", tags: [], addresses: [], locked: false, maintenance: false, showDetails: false },
    }));
    window.__cvStore.setState({ doc: { ...d, pages: d.pages.map((p, i) => (i === 0 ? { ...p, nodes: [...p.nodes, ...extra] } : p)) } });
  });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__cvStore.getState().onNodesChange([{ type: "select", id: "mid", selected: true }]));
  await page.mouse.move(5, 5);
  await page.keyboard.press("Shift+F");
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__cvStore.getState().selectNone());
  const zoomNow = async () => (await viewport()).zoom;
  // A rendered box, not the element's own display: hidden by its parent, a
  // label still reports its own display as "block".
  const labelShown = () => page.locator('.react-flow__node[data-id="mid"] .cv-glyph-label').evaluate((el) => el.getClientRects().length > 0);
  const paneBox = await page.locator(".react-flow__pane").boundingBox();
  await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2);
  for (let i = 0; i < 40 && (await zoomNow()) >= 0.35; i++) await page.mouse.wheel(0, 120);
  await page.waitForTimeout(400);
  check("zoomed out past 0.4, the canvas draws without detail",
    (await zoomNow()) < 0.4 && (await page.locator(".cv-canvas.is-far").count()) === 1, `zoom ${await zoomNow()}`);
  check("a device's name is not drawn", !(await labelShown()));
  // Whichever device's grab area is really under the pointer at this zoom —
  // one may have been carried under the toolbar by the zoom.
  const target = await page.evaluate(() => {
    for (const id of ["mid", "near", "far"]) {
      const hit = document.querySelector(`.react-flow__node[data-id="${id}"] .cv-glyph-hit`);
      if (!hit) continue;
      const r = hit.getBoundingClientRect();
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      if (document.elementFromPoint(x, y) === hit) return { id, x, y };
    }
    return null;
  });
  check("a device is on screen to drag", target !== null);
  if (target) {
    const posOf = (id) => page.evaluate((i) => window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === i).position, target.id);
    const from = await posOf();
    await page.mouse.move(target.x, target.y);
    await page.mouse.down();
    await page.mouse.move(target.x + 60, target.y + 30, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const to = await posOf();
    check("but a device can still be dragged", Math.round(to.x) !== Math.round(from.x), JSON.stringify({ id: target.id, from, to }));
  }
  for (let i = 0; i < 40 && (await zoomNow()) < 0.6; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(400);
  check("zoomed back in, the detail returns",
    (await page.locator(".cv-canvas.is-far").count()) === 0 && (await labelShown()), `zoom ${await zoomNow()}`);
}

// ------------------------------------------------------------- LT-194 print-friendly export
{
  const exportMenu = page.locator("details.cv-dropdown", { has: page.locator("summary", { hasText: "Export" }) });
  const exportSvg = async (printFriendly) => {
    if (!(await exportMenu.evaluate((d) => d.open))) await exportMenu.locator("summary").click();
    await page.waitForTimeout(200);
    const box = page.locator(".cv-dropdown-menu label", { hasText: "Print-friendly" }).locator("input");
    if ((await box.isChecked()) !== printFriendly) await box.click();
    await page.locator(".cv-dropdown-menu button", { hasText: "Diagram as SVG" }).click();
    await page.waitForTimeout(600);
    return page.evaluate(() => (window.__exports ?? []).at(-1) ?? "");
  };
  const grey = (c) => /^#([0-9a-f]{2})\1\1$/i.test(c);
  const colourful = await exportSvg(false);
  const colours = colourful.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
  check("an ordinary export has colour in it", colours.some((c) => !grey(c)), `${colours.length} colours`);
  const printed = await exportSvg(true);
  const printedColours = printed.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
  check("a print-friendly export has only greys", printedColours.length > 0 && printedColours.every(grey),
    JSON.stringify([...new Set(printedColours.filter((c) => !grey(c)))]));
  check("on white paper", /<rect width="100%" height="100%" fill="#ffffff"\/>/.test(printed));
  if (process.env.PRINT_OUT) (await import("node:fs")).writeFileSync(process.env.PRINT_OUT, printed);
}

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
