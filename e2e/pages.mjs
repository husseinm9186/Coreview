// Pages and what sits across them, driven through the real app (Phase 1.2):
// the page navigator (LT-183), views that lock and do not print (LT-184),
// paste in place (LT-186) and templates (LT-187).
// Invented names only (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/pages.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const dev = (id, label, x, y, type = "switch") => ({
  id, type: "device", position: { x, y }, width: 76, height: 76,
  data: { label, deviceType: type, tags: [], addresses: [], locked: false, maintenance: false, showDetails: false },
});
const wire = (id, source, target) => ({
  id, source, target, sourceHandle: "b", targetHandle: "t", type: "live",
  data: { sourcePortLabel: "", targetPortLabel: "", label: "", pathType: "straight", direction: "none", width: 2,
    color: "#2fbf6b", enabled: true, maintenance: false, healthRule: { type: "manual", manualStatus: "unknown" } },
});
const canvas = { gridEnabled: true, snapEnabled: true, minimap: true, nodeStyle: "glyph" };
const project = {
  meta: { id: "pages", name: "Pages", createdAt: NOW, updatedAt: NOW },
  documentVersion: 1,
  document: {
    activePageId: "p1",
    probes: [],
    pages: [
      { id: "p1", name: "Overview",
        canvas: { ...canvas, layers: [{ id: "phys", name: "Physical", visible: true, locked: false },
          { id: "notes", name: "Notes", visible: true, locked: false }] },
        edges: [wire("e1", "a", "b"), wire("e2", "a", "c")],
        nodes: [dev("a", "SW-A", 200, 0), { ...dev("b", "SW-B", 0, 200), data: { ...dev().data, label: "SW-B", layers: ["phys"] } },
          { ...dev("c", "SW-C", 400, 200), data: { ...dev().data, label: "SW-C", layers: ["notes"] } }] },
      { id: "p2", name: "Branch", canvas, edges: [], nodes: [dev("d", "RTR-D", 0, 0, "router")] },
      { id: "p3", name: "Notes", canvas, edges: [], nodes: [] },
    ],
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.addInitScript(({ p }) => {
  let next = 1;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return next++; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      if (cmd === "plugin:dialog|save") return Promise.resolve("/tmp/coreview-pages-test.svg");
      if (cmd === "save_export") {
        const bytes = Uint8Array.from(atob(args.contentsB64), (c) => c.charCodeAt(0));
        (window.__exports ??= []).push(new TextDecoder().decode(bytes));
        return Promise.resolve(null);
      }
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
await page.waitForTimeout(1000);

const st = (fn, arg) => page.evaluate(fn, arg);
const active = () => st(() => { const d = window.__cvStore.getState().doc; return d.pages.find((p) => p.id === d.activePageId).name; });
const names = () => st(() => window.__cvStore.getState().doc.pages.map((p) => p.name).join(","));
const blur = () => page.evaluate(() => document.activeElement?.blur());

// ------------------------------------------------------ LT-183 page navigator
check("the project opens on its first page", (await active()) === "Overview", await active());
await blur();
await page.keyboard.press("Control+PageDown");
await page.waitForTimeout(200);
check("Ctrl+PageDown goes to the next page", (await active()) === "Branch", await active());
await page.keyboard.press("Control+PageDown");
await page.keyboard.press("Control+PageDown");
await page.waitForTimeout(200);
check("and stops at the last", (await active()) === "Notes", await active());
await page.keyboard.press("Control+PageUp");
await page.keyboard.press("Control+PageUp");
await page.waitForTimeout(200);
check("Ctrl+PageUp goes back", (await active()) === "Overview", await active());

await page.locator(".cv-page-nav-toggle").click();
await page.waitForTimeout(250);
const rows = page.locator(".cv-page-nav-row");
check("the navigator lists every page", (await rows.count()) === 3, String(await rows.count()));
const sketch = await rows.nth(0).evaluate((el) => ({
  boxes: el.querySelectorAll(".cv-page-thumb rect").length,
  lines: el.querySelectorAll(".cv-page-thumb line").length,
}));
check("with a sketch of what is on each", sketch.boxes === 3 && sketch.lines === 2, JSON.stringify(sketch));
check("and how much", (await rows.nth(0).locator(".cv-page-nav-count").textContent()) === "3 objects · 2 links");
const inside = await rows.nth(0).locator(".cv-page-thumb").evaluate((svg) =>
  [...svg.querySelectorAll("rect")].every((r) => {
    const b = r.getBBox();
    return b.x >= 0 && b.y >= 0 && b.x + b.width <= 96 && b.y + b.height <= 60;
  }));
check("the sketch fits its thumbnail", inside);

await rows.nth(2).click();
await page.waitForTimeout(200);
check("clicking a row opens that page", (await active()) === "Notes", await active());
check("and the navigator stays open", (await page.locator(".cv-page-nav").count()) === 1);
await page.keyboard.press("ArrowUp");
await page.waitForTimeout(150);
check("the arrow keys switch pages", (await active()) === "Branch", await active());
await st(() => { const s = window.__cvStore.getState(); s.onNodesChange([{ type: "select", id: "d", selected: true }]); });
await rows.nth(1).focus();
const nodesBefore = await st(() => JSON.stringify(Object.fromEntries(window.__cvStore.getState().doc.pages.flatMap((p) => p.nodes.map((n) => [n.id, n.position])).sort())));
await page.keyboard.press("Alt+ArrowUp");
await page.waitForTimeout(200);
check("Alt+Up moves the page up the list", (await names()) === "Branch,Overview,Notes", await names());
check("and it is still the page being looked at", (await active()) === "Branch", await active());
const nodesAfter = await st(() => JSON.stringify(Object.fromEntries(window.__cvStore.getState().doc.pages.flatMap((p) => p.nodes.map((n) => [n.id, n.position])).sort())));
check("arrow keys in the navigator move nothing on the canvas", nodesBefore === nodesAfter, nodesAfter);

await page.keyboard.press("F2");
await page.waitForTimeout(150);
const rename = page.locator(".cv-page-nav-rename");
check("F2 renames the page in place", (await rename.count()) === 1);
await page.keyboard.type("Branch office");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
check("and Enter keeps the new name", (await names()) === "Branch office,Overview,Notes", await names());
check("which the tab strip shows too",
  (await page.locator(".cv-page-tab-name").evaluateAll((els) => els.map((e) => e.value).join(","))) === "Branch office,Overview,Notes");
await rows.nth(1).dblclick();
await page.waitForTimeout(150);
await page.keyboard.press("Control+a");
await page.keyboard.press("Backspace");
await page.keyboard.press("Enter");
await page.waitForTimeout(150);
check("a blank name keeps the old one", (await names()) === "Branch office,Overview,Notes", await names());

// Dragging a row: HTML5 drag and drop.
await rows.nth(2).dragTo(rows.nth(0));
await page.waitForTimeout(250);
check("dragging a row reorders the pages", (await names()) === "Notes,Branch office,Overview", await names());

await page.keyboard.press("Escape");
await page.waitForTimeout(150);
check("Escape closes the navigator", (await page.locator(".cv-page-nav").count()) === 0);
await page.locator(".cv-page-nav-toggle").click();
await page.waitForTimeout(150);
await page.mouse.click(700, 300);
await page.waitForTimeout(150);
check("and so does a click on the canvas", (await page.locator(".cv-page-nav").count()) === 0);

// ------------------------------------------ LT-184 views: lock, print, standard
{
  await st(() => window.__cvStore.getState().setActivePage("p1"));
  await page.waitForTimeout(400);
  await page.locator("button", { hasText: "Fit view" }).first().click();
  await page.waitForTimeout(500);
  const panel = page.locator(".cv-layers");
  await panel.evaluate((el) => { el.open = true; el.scrollIntoView(); });
  await page.waitForTimeout(250);
  const posOf = (id) => st((id) => window.__cvStore.getState().doc.pages.find((p) => p.id === "p1").nodes.find((n) => n.id === id).position, id);
  const dragBy = async (id, dx) => {
    const hit = page.locator(`.react-flow__node[data-id="${id}"] .cv-glyph-hit`).first();
    const b = await hit.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + b.width / 2 + (dx * i) / 8, b.y + b.height / 2);
    await page.mouse.up();
    await page.waitForTimeout(300);
  };

  await page.getByLabel("Lock Physical").click();
  await page.waitForTimeout(250);
  const was = await posOf("b");
  await dragBy("b", 120);
  check("a device on a locked view cannot be dragged", JSON.stringify(await posOf("b")) === JSON.stringify(was),
    JSON.stringify(await posOf("b")));
  const wasA = await posOf("a");
  await dragBy("a", 120);
  check("while one on no view still can", JSON.stringify(await posOf("a")) !== JSON.stringify(wasA));
  await page.keyboard.press("Control+z");
  await page.getByLabel("Unlock Physical").click();
  await page.waitForTimeout(250);
  await dragBy("b", 120);
  check("unlocked, it moves again", JSON.stringify(await posOf("b")) !== JSON.stringify(was));
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(250);

  const printBtn = page.getByLabel("Do not print Notes");
  check("each view has a print toggle", (await printBtn.count()) === 1);
  await printBtn.click();
  await page.waitForTimeout(250);
  check("which the view remembers",
    await st(() => window.__cvStore.getState().doc.pages.find((p) => p.id === "p1").canvas.layers.find((l) => l.id === "notes").print === false));
  check("and it still shows on the canvas", (await page.locator('.react-flow__node[data-id="c"]').count()) === 1);

  const exportMenu = page.locator("details.cv-dropdown", { has: page.locator("summary", { hasText: "Export" }) });
  await exportMenu.locator("summary").click();
  await page.waitForTimeout(200);
  await page.locator(".cv-dropdown-menu button", { hasText: "Diagram as SVG" }).click();
  await page.waitForTimeout(600);
  const svg = await page.evaluate(() => (window.__exports ?? []).at(-1) ?? "");
  check("an export leaves out a view set not to print", svg.includes("SW-B") && svg.includes("SW-A") && !svg.includes("SW-C"),
    `${svg.length} bytes`);

  await page.evaluate(() => {
    window.print = () => {
      window.__printed = {
        c: document.querySelectorAll('.react-flow__node[data-id="c"]').length,
        b: document.querySelectorAll('.react-flow__node[data-id="b"]').length,
      };
    };
  });
  if (!(await exportMenu.evaluate((d) => d.open))) await exportMenu.locator("summary").click();
  await page.waitForTimeout(200);
  await page.locator(".cv-dropdown-menu button", { hasText: "Print / save as PDF" }).click();
  await page.waitForTimeout(600);
  const printed = await page.evaluate(() => window.__printed);
  check("printing leaves it off the paper", printed?.c === 0 && printed?.b === 1, JSON.stringify(printed));
  check("and it is back on the canvas afterwards", (await page.locator('.react-flow__node[data-id="c"]').count()) === 1);
  await page.keyboard.press("Escape");

  await panel.evaluate((el) => { el.open = true; el.scrollIntoView(); });
  const standard = page.locator(".cv-layers-standard");
  check("the views offer the standard ones that are missing",
    (await standard.textContent())?.trim() === "Add Logical, Overlay, Annotations", await standard.textContent());
  await standard.click();
  await page.waitForTimeout(250);
  const layerNames = await page.locator(".cv-layer-name").evaluateAll((els) => els.map((e) => e.value).join(","));
  check("and adds them beside the views already there", layerNames === "Physical,Notes,Logical,Overlay,Annotations", layerNames);
  check("after which the offer goes", (await standard.count()) === 0);

  // ------------------------------------------------------ LT-186 paste in place
  const onPage = (pid) => st((pid) => {
    const pg = window.__cvStore.getState().doc.pages.find((p) => p.id === pid);
    return { nodes: pg.nodes.map((n) => ({ id: n.id, label: n.data.label, x: n.position.x, y: n.position.y, sel: Boolean(n.selected) })), edges: pg.edges.length };
  }, pid);
  await st(() => {
    const s = window.__cvStore.getState();
    s.onNodesChange(s.doc.pages.find((p) => p.id === "p1").nodes.map((n) => ({ type: "select", id: n.id, selected: n.id === "a" || n.id === "b" })));
  });
  await blur();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(250);
  const afterPaste = await onPage("p1");
  const pastedA = afterPaste.nodes.filter((n) => n.label === "SW-A" && n.id !== "a");
  check("an ordinary paste still lands offset", pastedA.length === 1 && pastedA[0].x === 240, JSON.stringify(pastedA));
  await page.keyboard.press("Control+Shift+v");
  await page.waitForTimeout(250);
  const inPlace = (await onPage("p1")).nodes.filter((n) => !afterPaste.nodes.some((m) => m.id === n.id));
  check("Ctrl+Shift+V pastes where the copy came from, even after a paste",
    inPlace.length === 2 && inPlace.some((n) => n.label === "SW-A" && n.x === 200 && n.y === 0) &&
      inPlace.some((n) => n.label === "SW-B" && n.x === 0 && n.y === 200), JSON.stringify(inPlace));
  check("and only the paste is selected", (await onPage("p1")).nodes.filter((n) => n.sel).length === 2);
  check("with the link between them", (await onPage("p1")).edges === afterPaste.edges + 1);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(250);
  check("one undo takes it away", (await onPage("p1")).nodes.length === afterPaste.nodes.length);

  await st(() => window.__cvStore.getState().setActivePage("p3"));
  await page.waitForTimeout(300);
  await page.locator(".react-flow__pane").click({ button: "right", position: { x: 700, y: 400 } });
  await page.waitForTimeout(250);
  const item = page.locator(".cv-menu button", { hasText: "Paste in place" });
  check("the canvas menu offers paste in place", (await item.count()) === 1 && (await item.isEnabled()));
  await item.click();
  await page.waitForTimeout(300);
  const other = await onPage("p3");
  check("onto another page, at the same coordinates",
    other.nodes.length === 2 && other.nodes.some((n) => n.label === "SW-A" && n.x === 200 && n.y === 0) && other.edges === 1,
    JSON.stringify(other));
  check("and it is drawn there", (await page.locator(".react-flow__node").count()) === 2);

  await st(() => window.__cvStore.getState().createProject({ name: "Fresh" }));
  await page.waitForTimeout(500);
  const fresh = await st(() => window.__cvStore.getState().doc.pages[0].canvas.layers?.map((l) => l.name).join(","));
  check("a new project starts with Physical, Logical, Overlay and Annotations", fresh === "Physical,Logical,Overlay,Annotations", fresh);
}

// ------------------------------------------------------------- LT-187 templates
{
  const createFrom = async (name, template) => {
    await st(() => window.__cvStore.getState().closeProject());
    await page.waitForTimeout(500);
    await page.locator(".cv-welcome-actions button", { hasText: "Create project" }).click();
    await page.waitForTimeout(200);
    const modal = page.locator(".cv-modal");
    await modal.locator("input").first().fill(name);
    const chooser = modal.locator("label", { hasText: "Start from" }).locator("select");
    const offered = await chooser.locator("option").allTextContents();
    await chooser.selectOption({ label: template });
    const help = await modal.locator("label", { hasText: "Start from" }).locator(".cv-help").textContent();
    await modal.locator("button", { hasText: "Create project" }).click();
    await page.waitForTimeout(1200);
    return { offered, help };
  };
  const { offered, help } = await createFrom("From a template", "Campus three-tier");
  check("a new project can start from a template",
    offered.join("|") === "Blank|Branch office|Data centre spine-leaf|Campus three-tier|DMZ|SD-WAN overlay|MPLS L3VPN|Wireless survey|Rack elevation",
    offered.join("|"));
  check("which says what it holds and that its addresses are placeholders", /core pair/i.test(help) && /documentation ranges/.test(help), help);
  const doc = await st(() => {
    const s = window.__cvStore.getState();
    return { name: s.meta?.name, nodes: s.doc.pages[0].nodes.length, edges: s.doc.pages[0].edges.length, probes: s.doc.probes.length };
  });
  check("the project opens with the template drawn", doc.name === "From a template" && doc.nodes === 17 && doc.edges === 23, JSON.stringify(doc));
  check("and on the canvas", (await page.locator(".react-flow__node").count()) === 17 && (await page.locator(".react-flow__edge").count()) === 23);
  check("monitoring nothing", doc.probes === 0);
  await createFrom("Blank one", "Blank");
  check("Blank is an empty page", await st(() => window.__cvStore.getState().doc.pages[0].nodes.length === 0));
}

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
