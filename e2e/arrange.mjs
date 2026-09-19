// Arranging a diagram, driven through the real app (Phase 1.2): stacking
// order (LT-174), lasso selection (LT-173), grid snap (LT-175) and link
// connection points (LT-176, LT-179), the automatic layouts (LT-177) and links
// routed round devices (LT-178), styled label text (LT-181) and multi-line text
// boxes (LT-182).
// Invented names only (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/arrange.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const box = (id, label, x, y, type = "rectangle") => ({
  id, type: "device", position: { x, y }, width: 168, height: 92,
  data: { label, deviceType: type, tags: [], addresses: [], locked: false, maintenance: false, showDetails: false },
});
export const project = {
  meta: { id: "arrange", name: "Arrange", customer: "", site: "", ticket: "", engineer: "", description: "",
    createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    nodes: [box("a", "BOX-A", 0, 0), box("b", "BOX-B", 40, 30), box("c", "BOX-C", 80, 60),
      box("d", "BOX-D", 500, 0), box("e", "BOX-E", 800, 0), box("f", "BOX-F", 500, 300)],
    edges: [{
      id: "df", source: "d", target: "f", sourceHandle: "b", targetHandle: "t", type: "live",
      data: { sourcePortLabel: "", targetPortLabel: "", label: "", pathType: "straight", direction: "none", width: 2,
        color: "#2fbf6b", enabled: true, maintenance: false, healthRule: { type: "manual", manualStatus: "unknown" } },
    }],
    probes: [], canvas: {},
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.addInitScript(({ p }) => {
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
await page.waitForTimeout(1000);

const st = (fn, arg) => page.evaluate(fn, arg);
const order = () => st(() => window.__cvStore.getState().doc.pages[0].nodes.map((n) => n.id).filter((id) => "abc".includes(id)).join(""));
const selectOnly = (...ids) => st((ids) => {
  const s = window.__cvStore.getState();
  s.onNodesChange(s.doc.pages[0].nodes.map((n) => ({ type: "select", id: n.id, selected: ids.includes(n.id) })));
}, ids);
const zOf = (id) => page.locator(`.react-flow__node[data-id="${id}"]`).evaluate((el) => Number(getComputedStyle(el).zIndex));
const blur = () => page.evaluate(() => document.activeElement?.blur());

// ------------------------------------------------------------- LT-174 stacking
check("the boxes start stacked a, b, c", (await order()) === "abc", await order());
await selectOnly("a");
await blur();
await page.keyboard.press("Control+Shift+BracketRight");
await page.waitForTimeout(300);
check("Ctrl+Shift+] brings the selection to the front", (await order()) === "bca", await order());
check("and it is drawn over the others", (await zOf("a")) > (await zOf("c")) && (await zOf("a")) > (await zOf("b")),
  `${await zOf("a")} vs ${await zOf("b")}, ${await zOf("c")}`);
await page.keyboard.press("Control+z");
await page.waitForTimeout(300);
check("one undo puts it back", (await order()) === "abc", await order());

await selectOnly("c");
await page.keyboard.press("Control+Shift+BracketLeft");
await page.waitForTimeout(300);
check("Ctrl+Shift+[ sends it to the back", (await order()) === "cab", await order());
await page.keyboard.press("Control+BracketRight");
await page.waitForTimeout(300);
check("Ctrl+] brings it one step forward", (await order()) === "acb", await order());
await page.keyboard.press("Control+BracketLeft");
await page.waitForTimeout(300);
check("Ctrl+[ sends it one step back", (await order()) === "cab", await order());

await selectOnly("a", "b");
await page.keyboard.press("Control+Shift+BracketLeft");
await page.waitForTimeout(300);
check("a selection moves as a block, in its own order", (await order()) === "abc", await order());

// The menu, on one object that is not selected.
await selectOnly();
const at = await page.locator('.react-flow__node[data-id="a"]').boundingBox();
await page.mouse.click(at.x + 10, at.y + 10, { button: "right" });
await page.waitForTimeout(250);
const front = page.locator(".cv-menu button", { hasText: "Bring to front" });
check("the object menu offers Bring to front", (await front.count()) === 1);
if (await front.count()) {
  await front.click();
  await page.waitForTimeout(300);
  check("which brings just that object to the front", (await order()) === "bca", await order());
}

// ------------------------------------------------------------- LT-173 lasso
{
  await page.keyboard.press("Escape");
  await selectOnly();
  await page.keyboard.press("f");
  await page.waitForTimeout(500);
  const centre = async (id) => {
    const r = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const selected = () => st(() => window.__cvStore.getState().doc.pages[0].nodes.filter((n) => n.selected).map((n) => n.id).sort().join(""));
  /** Draws a closed outline through the given screen points with Alt held. */
  const lassoThrough = async (points, shift = false) => {
    await page.keyboard.down("Alt");
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.move(points[0].x, points[0].y);
    await page.mouse.down();
    let sawBox = false;
    for (const p of [...points.slice(1), points[0]]) {
      await page.mouse.move(p.x, p.y, { steps: 8 });
      if ((await page.locator(".react-flow__selection").count()) > 0) sawBox = true;
    }
    const drawn = await page.locator(".cv-lasso polygon").count();
    await page.mouse.up();
    if (shift) await page.keyboard.up("Shift");
    await page.keyboard.up("Alt");
    await page.waitForTimeout(300);
    return { sawBox, drawn };
  };
  const d = await centre("d");
  const f = await centre("f");
  const e = await centre("e");
  // Round d and f — a tall loop to their left side and back — missing e.
  const pad = 70;
  const loop = [
    { x: d.x - pad, y: d.y - pad }, { x: d.x + pad, y: d.y - pad }, { x: f.x + pad, y: f.y + pad }, { x: f.x - pad, y: f.y + pad },
  ];
  const first = await lassoThrough(loop);
  check("Alt+drag draws a lasso outline", first.drawn === 1);
  check("and no rectangular selection box", !first.sawBox);
  check("the lasso selects exactly what it goes round", (await selected()) === "df", await selected());
  await lassoThrough([{ x: e.x - pad, y: e.y - pad }, { x: e.x + pad, y: e.y - pad }, { x: e.x + pad, y: e.y + pad }, { x: e.x - pad, y: e.y + pad }], true);
  check("Alt+Shift adds to the selection", (await selected()) === "def", await selected());
  const pane = await page.locator(".react-flow__pane").boundingBox();
  const empty = { x: pane.x + pane.width - 150, y: pane.y + pane.height - 250 };
  await lassoThrough([empty, { x: empty.x + 40, y: empty.y }, { x: empty.x + 40, y: empty.y + 40 }]);
  check("a lasso round nothing clears the selection", (await selected()) === "", await selected());
}

// ------------------------------------------------------------- LT-175 grid snap
{
  await page.keyboard.press("Escape");
  await selectOnly();
  await page.keyboard.press("f");
  await page.waitForTimeout(500);
  const toggle = page.locator(".cv-topbar-wrap button", { hasText: /^Grid snap (on|off)$/ });
  check("the toolbar always shows whether grid snap is on", (await toggle.count()) === 1 && (await toggle.innerText()) === "Grid snap off",
    (await toggle.count()) ? await toggle.innerText() : "missing");
  await page.keyboard.press("Control+Shift+G");
  await page.waitForTimeout(300);
  check("Ctrl+Shift+G turns it on for the project",
    (await toggle.innerText()) === "Grid snap on" && (await st(() => window.__cvStore.getState().doc.gridSnap)) === true,
    await toggle.innerText());
  const posOf = (id) => st((i) => window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === i).position, id);
  /** Drags a box by an awkward screen offset, well clear of the others. */
  const dragBy = async (id, dx, dy, alt = false) => {
    const r = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
    if (alt) await page.keyboard.down("Alt");
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width / 2 + dx, r.y + r.height / 2 + dy, { steps: 12 });
    await page.mouse.up();
    if (alt) await page.keyboard.up("Alt");
    await page.waitForTimeout(300);
    return posOf(id);
  };
  const onGrid = (p) => Math.abs(p.x % 12) < 0.001 && Math.abs(p.y % 12) < 0.001;
  const snapped = await dragBy("e", 37, 113);
  check("a dragged box lands on the grid", onGrid(snapped), JSON.stringify(snapped));
  // That guides win over the grid is the rule in src/lib/gridSnap.ts, tested
  // there: a drag precise to a unit or two is a test of the pointer, not of it.
  const altered = await dragBy("e", 29, 41, true);
  check("holding Alt drops it off the grid for that drag", !onGrid(altered), JSON.stringify(altered));
  await toggle.click();
  await page.waitForTimeout(300);
  check("the toolbar button turns it off", (await toggle.innerText()) === "Grid snap off");
  const free = await dragBy("e", 31, 23);
  check("with grid snap off, a box lands where it is dropped", !onGrid(free), JSON.stringify(free));
}

// ------------------------------------------------------------- LT-176 / LT-179 connection points
{
  await page.keyboard.press("Escape");
  await selectOnly();
  await page.keyboard.press("f");
  await page.waitForTimeout(500);
  const edgeData = () => st(() => window.__cvStore.getState().doc.pages[0].edges.find((e) => e.id === "df"));
  const boxOf = (id) => page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
  /** Drags the link's target end to a screen point, reporting whether a snap
   *  ring showed on the way. */
  const dragTargetEnd = async (to) => {
    await st(() => window.__cvStore.getState().onEdgesChange([{ type: "select", id: "df", selected: true }]));
    await page.waitForTimeout(300);
    const handle = page.locator(".cv-edge-endpoint").nth(1);
    const h = await handle.boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 14 });
    const ring = await page.locator(".cv-connection-snap").count();
    await page.mouse.up();
    await page.waitForTimeout(400);
    return ring;
  };
  const f = await boxOf("f");
  // Near f's bottom-middle point, a few pixels off it.
  const ring = await dragTargetEnd({ x: f.x + f.width / 2 + 4, y: f.y + f.height - 3 });
  check("dragging a link end near a connection point shows where it will snap", ring === 1, `${ring}`);
  let ed = await edgeData();
  check("and it lands exactly on that point", ed.target === "f" && ed.data.targetAnchor?.x === 0.5 && ed.data.targetAnchor?.y === 1,
    JSON.stringify({ target: ed.target, anchor: ed.data.targetAnchor }));
  // Onto the middle of another device.
  const e = await boxOf("e");
  await dragTargetEnd({ x: e.x + e.width / 2 + 3, y: e.y + e.height / 2 - 2 });
  ed = await edgeData();
  check("dropped on another device's centre point, the link moves there, at its centre",
    ed.target === "e" && ed.data.targetAnchor?.x === 0.5 && ed.data.targetAnchor?.y === 0.5,
    JSON.stringify({ target: ed.target, anchor: ed.data.targetAnchor }));
  // Somewhere on e's outline between points: no snap, it slides as before. Close
  // in, where the points are well apart on screen — zoomed out, ten pixels of
  // tolerance covers a whole side, which is as it should be.
  await selectOnly("e");
  await page.mouse.move(5, 5);
  await page.keyboard.press("Shift+F");
  await page.waitForTimeout(500);
  await selectOnly();
  const e2 = await boxOf("e");
  const ring2 = await dragTargetEnd({ x: e2.x + e2.width * 0.62, y: e2.y + 1 });
  ed = await edgeData();
  check("away from every point there is no snap, and the end slides round the outline",
    ring2 === 0 && ed.target === "e" && ed.data.targetAnchor?.y === 0 && Math.abs(ed.data.targetAnchor.x - 0.62) < 0.05,
    JSON.stringify({ ring2, anchor: ed.data.targetAnchor }));
}

// ------------------------------------------------------------- LT-177 layouts
{
  await page.keyboard.press("Escape");
  await selectOnly();
  await page.keyboard.press("f");
  await page.waitForTimeout(400);
  const positions = () => st(() => Object.fromEntries(window.__cvStore.getState().doc.pages[0].nodes.map((n) => [n.id, n.position])));
  const menu = async (label) => {
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
  // Lock one box, which every layout must leave where it is.
  await st(() => window.__cvStore.getState().updateNodeData("c", { locked: true }));
  for (const [label, name] of [["Lay out radially", "radial"], ["Lay out as a mesh", "force-directed"], ["Lay out on a grid", "orthogonal"]]) {
    const before = await positions();
    const offered = await menu(label);
    check(`the canvas menu offers the ${name} layout`, offered);
    const after = await positions();
    const movedIds = Object.keys(after).filter((id) => after[id].x !== before[id].x || after[id].y !== before[id].y);
    check(`the ${name} layout moves the page's devices`, movedIds.length >= 3, movedIds.join(","));
    check(`and leaves the locked one where it is`, !movedIds.includes("c"), movedIds.join(","));
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
    check(`one undo puts every device back`, JSON.stringify(await positions()) === JSON.stringify(before));
  }
  // On a selection, only the selection moves.
  await selectOnly("d", "e", "f");
  const before = await positions();
  await menu("Lay out radially");
  const after = await positions();
  const movedIds = Object.keys(after).filter((id) => after[id].x !== before[id].x || after[id].y !== before[id].y);
  check("with a selection, only the selection is laid out",
    movedIds.length > 0 && movedIds.every((id) => ["d", "e", "f"].includes(id)), movedIds.join(","));
}

// ------------------------------------------------------------- LT-178 routing round devices
{
  await page.keyboard.press("Escape");
  await selectOnly();
  // d above f with box a squarely between them, and the link d→f set to route
  // round devices.
  await st(() => {
    const s = window.__cvStore.getState();
    s.updateNodeData("c", { locked: false });
    const d = s.doc;
    const place = { d: { x: 900, y: 0 }, f: { x: 900, y: 460 }, a: { x: 860, y: 220 }, e: { x: 1400, y: 0 } };
    window.__cvStore.setState({
      doc: { ...d, pages: d.pages.map((p, i) => (i === 0 ? {
        ...p,
        nodes: p.nodes.map((n) => (place[n.id] ? { ...n, position: place[n.id] } : n)),
        edges: p.edges.map((e) => (e.id === "df" ? { ...e, source: "d", target: "f", data: { ...e.data, targetAnchor: undefined, sourceAnchor: undefined, pinnedSides: undefined, pathType: "avoid" } } : e)),
      } : p)) },
    });
  });
  await page.keyboard.press("f");
  await page.waitForTimeout(800);
  const drawn = await page.locator('.react-flow__edge[data-id="df"] .react-flow__edge-path').first().getAttribute("d");
  const pts = [];
  for (const m of (drawn ?? "").matchAll(/([ML])\s*(-?[\d.]+)[ ,](-?[\d.]+)/g)) pts.push({ x: +m[2], y: +m[3] });
  const box = { x: 860, y: 220, w: 168, h: 92 };
  const cutsThrough = pts.slice(1).some((b, i) => {
    const a = pts[i];
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
    return x2 > box.x && x1 < box.x + box.w && y2 > box.y && y1 < box.y + box.h;
  });
  check("a link set to route round devices is drawn", pts.length >= 3, drawn ?? "no path");
  check("and goes round the box standing between its ends", !cutsThrough, drawn ?? "");
  const option = page.locator(".cv-inspector select option", { hasText: "Around devices" });
  await st(() => window.__cvStore.getState().select(null, "df"));
  await page.waitForTimeout(300);
  check("the link inspector offers Around devices as a path", (await option.count()) === 1);
}

// ------------------------------------------------------------- LT-181 rich text
{
  await page.keyboard.press("Escape");
  await selectOnly();
  await st(() => window.__cvStore.getState().select("f", null));
  await page.waitForTimeout(300);
  const nameSummary = page.locator(".cv-inspector details.cv-text-style summary", { hasText: "Name text" });
  check("the device inspector offers name text styling", (await nameSummary.count()) === 1);
  await nameSummary.click();
  const nameGroup = page.locator('.cv-inspector [role="group"][aria-label="Name text"]');
  const label = page.locator('.react-flow__node[data-id="f"] .cv-node-label');
  await nameGroup.locator('button[title="Bold"]').click();
  await nameGroup.locator('input[type="number"]').fill("20");
  await page.waitForTimeout(300);
  const css = await label.evaluate((el) => ({ weight: getComputedStyle(el).fontWeight, size: getComputedStyle(el).fontSize }));
  check("bold and a size show on the device's name on the canvas", css.weight === "700" && css.size === "20px", JSON.stringify(css));
  const stored = await st(() => window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === "f").data.labelStyle);
  check("and are kept on the device", stored?.bold === true && stored?.size === 20, JSON.stringify(stored));

  await st(() => {
    const s = window.__cvStore.getState();
    s.updateEdgeData("df", { label: "LINK-LABEL" });
    s.select(null, "df");
  });
  await page.waitForTimeout(300);
  await page.locator(".cv-inspector details.cv-text-style summary", { hasText: /^Label text/ }).click();
  const labelGroup = page.locator('.cv-inspector [role="group"][aria-label="Label text"]');
  await labelGroup.locator('button[title="Italic"]').click();
  await page.waitForTimeout(300);
  const centre = page.locator(".cv-edge-center", { hasText: "LINK-LABEL" });
  const style = (await centre.count()) ? await centre.evaluate((el) => getComputedStyle(el).fontStyle) : "missing";
  check("italic shows on the link's label", style === "italic", style);
  await labelGroup.locator('button[title="Italic"]').click();
  await page.waitForTimeout(300);
  const cleared = await st(() => window.__cvStore.getState().doc.pages[0].edges.find((e) => e.id === "df").data.labelStyle);
  check("turning the last choice off clears the style entirely", cleared === undefined, JSON.stringify(cleared));
}

// ------------------------------------------------------------- LT-182 text boxes
{
  await page.keyboard.press("Escape");
  await st(() => window.__cvStore.getState().select(null, null));
  await selectOnly();
  await page.waitForTimeout(200);
  const before = await st(() => window.__cvStore.getState().doc.pages[0].nodes.map((n) => n.id));
  const bare = await page.evaluate(() => {
    const r = document.querySelector(".react-flow__pane").getBoundingClientRect();
    for (let y = r.top + 60; y < r.bottom - 60; y += 30)
      for (let x = r.left + 60; x < r.right - 260; x += 30)
        if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
    return null;
  });
  await page.mouse.dblclick(bare.x, bare.y);
  await page.waitForTimeout(400);
  const editor = page.locator("textarea.cv-inline-edit");
  check("double-clicking empty canvas opens a text box to type in", (await editor.count()) === 1);
  if (await editor.count()) {
    await editor.fill("");
    await page.keyboard.type("LINE ONE");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("LINE TWO");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const made = await st((was) => window.__cvStore.getState().doc.pages[0].nodes.find((n) => !was.includes(n.id)), before);
    check("Shift+Enter starts a new line and Enter finishes", made?.data?.label === "LINE ONE\nLINE TWO", JSON.stringify(made?.data?.label));
    const rendered = page.locator(`.react-flow__node[data-id="${made?.id}"] .cv-node-label`);
    const lines = await rendered.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
    });
    check("and the text box shows both lines", lines === 2, `${lines} line(s)`);
  }
}

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
