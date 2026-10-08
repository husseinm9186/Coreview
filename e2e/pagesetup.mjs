// The page as paper: rulers along the top and left at the zoom,
// page presets that fix the sheet's size, the print margin, and the 1:1
// print scale that sets the viewport for the print job.
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
  data: { label, deviceType: "router", tags: [], addresses: [], locked: false, maintenance: false, showDetails: true },
});

const project = {
  meta: { id: "pagesetup", name: "Page setup", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: { nodes: [device("a", "R-A", 300, 300)], edges: [], probes: [], canvas: {} },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.addInitScript(({ p }) => {
  localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
  localStorage.removeItem("coreview.view.printScale");
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
const canvas = () => st(() => window.__cvStore.getState().doc.pages[0].canvas);
const viewport = () => page.evaluate(() => {
  const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector(".react-flow__viewport")).transform);
  return { x: Math.round(m.e), y: Math.round(m.f), zoom: +m.a.toFixed(3) };
});
const openPage = () => page.locator(".cv-page-menu").evaluate((d) => { d.open = true; });
const settle = () => page.waitForTimeout(350);

// ------------------------------------------------------------- rulers

{
  check("no rulers until asked", (await page.locator(".cv-rulers").count()) === 0);
  await openPage();
  await page.locator(".cv-page-menu .cv-check", { hasText: "Rulers" }).locator("input").check();
  await settle();
  check("rulers appear along the top and left", (await page.locator(".cv-ruler.is-top").count()) === 1 && (await page.locator(".cv-ruler.is-left").count()) === 1 && (await canvas()).rulers === true);
  // At 100 % a labelled tick every 10 mm.
  await page.locator('[data-region="zoom-level"]').click();
  await page.locator(".cv-zoom-menu button", { hasText: /^100 %/ }).click();
  await settle();
  const labels = await page.locator(".cv-ruler.is-top text").evaluateAll((els) => els.map((e) => e.textContent));
  check("labelled every 10 mm at 100 %, counted from the page's corner", labels.includes("0") && labels.includes("10") && labels.includes("50") && !labels.includes("5"), JSON.stringify(labels.slice(0, 8)));
  check("and the rulers say their step", (await page.locator(".cv-rulers").getAttribute("data-major")) === String(Math.round((10 * 144 / 25.4) * 100) / 100), await page.locator(".cv-rulers").getAttribute("data-major"));
  await openPage();
  await page.locator(".cv-page-menu .cv-seg button", { hasText: /^inches$/ }).click();
  await settle();
  const inchLabels = await page.locator(".cv-ruler.is-top text").evaluateAll((els) => els.map((e) => e.textContent));
  check("inches label in inches, every half inch at 100 %", inchLabels.includes("0″") && inchLabels.includes("0.5″") && inchLabels.includes("1″"), JSON.stringify(inchLabels.slice(0, 6)));
  await page.locator('[data-region="zoom-level"]').click();
  await page.locator(".cv-zoom-menu button", { hasText: /^25 %/ }).click();
  await settle();
  const far = await page.locator(".cv-ruler.is-top text").evaluateAll((els) => els.map((e) => e.textContent));
  check("zoomed out the step opens up: every 2 inches at a quarter", far.includes("0″") && far.includes("2″") && !far.includes("1″"), JSON.stringify(far.slice(0, 6)));
  await page.locator('[data-region="zoom-level"]').click();
  await page.locator(".cv-zoom-menu button", { hasText: /^100 %/ }).click();
  await settle();
}

// ------------------------------------------------------------- page sizes and margins

{
  await openPage();
  await page.locator(".cv-page-menu button", { hasText: /^A4$/ }).click();
  await settle();
  let c = await canvas();
  check("A4 fixes the sheet to 1684 by 1191 units, landscape, and stops it growing", c.pageSize?.id === "a4" && c.pageSize?.orientation === "landscape" && c.sheetRect.w === 1684 && c.sheetRect.h === 1191 && c.growPage === false, JSON.stringify({ pageSize: c.pageSize, sheet: c.sheetRect, grow: c.growPage }));
  check("the toolbar says so", /Page: A4 landscape/.test(await page.locator('[data-region="page-menu"]').innerText()), await page.locator('[data-region="page-menu"]').innerText());
  await openPage();
  await page.locator(".cv-page-menu .cv-seg button", { hasText: /^portrait$/ }).click();
  await settle();
  c = await canvas();
  check("portrait turns it round", c.sheetRect.w === 1191 && c.sheetRect.h === 1684 && c.pageSize.orientation === "portrait");
  const drawn = await page.locator(".cv-page").evaluate((e) => ({ w: parseFloat(e.style.width), h: parseFloat(e.style.height) }));
  check("and the sheet is drawn that size", drawn.w === 1191 && drawn.h === 1684, JSON.stringify(drawn));
  await openPage();
  await page.locator(".cv-page-menu .cv-check", { hasText: "Show the print margin" }).locator("input").check();
  await settle();
  const m = await page.locator('[data-region="page-margins"]').evaluate((e) => ({ left: parseFloat(e.style.left), width: parseFloat(e.style.width) }));
  check("the print margin is drawn 10 mm in", Math.abs(m.left - 56.69) < 0.1 && Math.abs(m.width - (1191 - 2 * 56.69)) < 0.2, JSON.stringify(m));
  await openPage();
  await page.locator(".cv-page-menu button", { hasText: /^fits the diagram$/ }).click();
  await settle();
  c = await canvas();
  check("fits the diagram lets it grow again, at the default sheet", c.pageSize === undefined && c.growPage === true && c.sheetRect.w === 1584, JSON.stringify({ pageSize: c.pageSize, grow: c.growPage, sheet: c.sheetRect }));
}

// ------------------------------------------------------------- the 1:1 print scale

{
  await st(() => window.__cvStore.getState().setSettings({ printScale: "actual" }));
  const before = await viewport();
  await st(() => window.__cvStore.getState().setPrinting(true));
  await settle();
  const printing = await viewport();
  check("printing at 1:1 puts the sheet's corner at the paper's at 96/144", printing.zoom === 0.667 && printing.x === 0 && printing.y === 0, JSON.stringify(printing));
  await st(() => window.__cvStore.getState().setPrinting(false));
  await settle();
  const after = await viewport();
  check("and puts the view back afterwards", after.zoom === before.zoom && after.x === before.x && after.y === before.y, JSON.stringify({ before, after }));
  check("the choice is remembered for this machine", (await st(() => localStorage.getItem("coreview.view.printScale"))) === "actual");
  await st(() => window.__cvStore.getState().setSettings({ printScale: "fit" }));
  await st(() => window.__cvStore.getState().setPrinting(true));
  await settle();
  check("scaled to fit, printing leaves the view alone", (await viewport()).zoom === before.zoom);
  await st(() => window.__cvStore.getState().setPrinting(false));
}

await browser.close();
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall page setup checks passed");
