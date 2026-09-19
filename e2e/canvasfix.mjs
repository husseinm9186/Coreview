// Two reported canvas bugs, driven through the real app (LT-157, LT-158).
//
// LT-157 — "I can't move the link from one device to another": dragging a
// selected link's end onto a different device must reattach it there.
// LT-158 — space + drag "some times it doesn't work and i get this" (a
// selection box): the two ways that happens with real input are the button
// going down a moment before space, and focus left in a panel field.
//
// A small fixture of its own, so the result does not depend on the state the
// long interaction harness leaves behind. Invented names only (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/canvasfix.mjs
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
  meta: { id: "canvasfix", name: "Canvas fix", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    nodes: [device("n1", "LAB-A", 0, 0), device("n2", "LAB-B", 0, 300), device("n3", "LAB-C", 420, 300)],
    edges: [{
      id: "e1", source: "n1", target: "n2", sourceHandle: "b", targetHandle: "t", type: "live",
      data: {
        sourcePortLabel: "Gi1/0/1", targetPortLabel: "Gi0/1", label: "", pathType: "bezier",
        direction: "forward", width: 2, color: "#2fbf6b", enabled: true, maintenance: false,
        healthRule: { type: "manual", manualStatus: "healthy" },
      },
    }],
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
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "", engineer: "",
        description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project")
        return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({});
      return Promise.resolve([]);
    },
  };
}, { p: project });

page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(900);
if (await page.locator(".cv-recovery").count()) {
  await page.locator(".cv-recovery button", { hasText: "Keep what was saved" }).click();
  await page.waitForTimeout(300);
}

const edge = (id) => page.evaluate((eid) => {
  const d = window.__cvStore.getState().doc;
  const edges = d.pages ? Object.values(d.pages).flatMap((pg) => pg.edges ?? []) : d.edges ?? [];
  const e = edges.find((x) => x.id === eid);
  return e && { source: e.source, target: e.target, targetPortLabel: e.data?.targetPortLabel, sourcePortLabel: e.data?.sourcePortLabel };
}, id);
const edgeCount = () => page.evaluate(() => {
  const d = window.__cvStore.getState().doc;
  return (d.pages ? Object.values(d.pages).flatMap((pg) => pg.edges ?? []) : d.edges ?? []).length;
});
const centre = async (sel) => {
  const b = await page.locator(sel).first().boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const selectLink = async () => {
  await page.locator('.cv-edge-hit[data-id="e1"] path').first().click({ force: true });
  await page.waitForTimeout(300);
};
/** Drags the link's target end (the second endpoint handle) to a point. */
const dragTargetEndTo = async (to) => {
  await selectLink();
  const handles = page.locator(".cv-edge-endpoint");
  if ((await handles.count()) < 2) return false;
  const from = await centre('.cv-edge-endpoint >> nth=1');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 16 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  return true;
};

// ------------------------------------------------------------- LT-157

const startEdges = await edgeCount();
check("the fixture link runs LAB-A to LAB-B", JSON.stringify(await edge("e1")) ===
  JSON.stringify({ source: "n1", target: "n2", targetPortLabel: "Gi0/1", sourcePortLabel: "Gi1/0/1" }),
  JSON.stringify(await edge("e1")));

check("a selected link shows its end handles", await dragTargetEndTo(await centre('.react-flow__node[data-id="n3"]')));
let e1 = await edge("e1");
check("dragging a link's end onto another device moves it there", e1?.target === "n3", JSON.stringify(e1));
check("the other end stays where it was", e1?.source === "n1", JSON.stringify(e1));
check("the moved end forgets the old device's port", e1?.targetPortLabel === "", JSON.stringify(e1));
check("and the other end keeps its own", e1?.sourcePortLabel === "Gi1/0/1", JSON.stringify(e1));
check("no link is added or lost", (await edgeCount()) === startEdges, `${startEdges} -> ${await edgeCount()}`);

await page.mouse.click(1400, 80);
await page.keyboard.press("Control+z");
await page.waitForTimeout(400);
e1 = await edge("e1");
check("one undo puts the end back", e1?.target === "n2" && e1?.targetPortLabel === "Gi0/1", JSON.stringify(e1));

await dragTargetEndTo(await centre('.react-flow__node[data-id="n1"]'));
e1 = await edge("e1");
check("dropping an end on the link's other device does not make a loop", e1?.target === "n2", JSON.stringify(e1));

const n2 = await page.locator('.react-flow__node[data-id="n2"]').boundingBox();
await dragTargetEndTo({ x: n2.x + n2.width + 6, y: n2.y + n2.height / 2 });
e1 = await edge("e1");
check("dropping an end beside its own device still just moves it round that device",
  e1?.target === "n2", JSON.stringify(e1));

// ------------------------------------------------------------- LT-273
// Moving a device must be undoable, as one step, companions included.
const posOf = (id) => page.evaluate((i) => {
  const d = window.__cvStore.getState().doc;
  const nodes = d.pages ? Object.values(d.pages).flatMap((pg) => pg.nodes ?? []) : d.nodes ?? [];
  const n = nodes.find((x) => x.id === i);
  return n && { x: Math.round(n.position.x), y: Math.round(n.position.y) };
}, id);
const undoDepth = () => page.evaluate(() => window.__cvStore.getState().past.length);
// n1 and n2 grouped, so a drag of one carries the other.
await page.evaluate(() => {
  const st = window.__cvStore.getState();
  st.onNodesChange([{ type: "select", id: "n1", selected: true }, { type: "select", id: "n2", selected: true }]);
  st.groupSelected();
  st.selectNone();
});
await page.waitForTimeout(300);
await page.mouse.click(1400, 80);
// Clear of the minimap in the corner, which would otherwise take the press.
{
  const pane = await page.locator(".react-flow__pane").boundingBox();
  const cx = pane.x + pane.width / 2;
  const cy = pane.y + pane.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(cx - 300, cy - 200, { steps: 10 });
  await page.mouse.up({ button: "middle" });
  await page.waitForTimeout(300);
}
const n3From = await posOf("n3");
const n2From = await posOf("n2");
const depthBefore = await undoDepth();
await page.locator('.react-flow__node[data-id="n3"] .cv-glyph-hit').click();
await page.waitForTimeout(200);
check("a click with no movement takes no undo step", (await undoDepth()) === depthBefore,
  `${depthBefore} -> ${await undoDepth()}`);
const n3Box = await page.locator('.react-flow__node[data-id="n3"] .cv-glyph-hit').boundingBox();
await page.mouse.move(n3Box.x + n3Box.width / 2, n3Box.y + n3Box.height / 2);
await page.mouse.down();
await page.mouse.move(n3Box.x + n3Box.width / 2 + 160, n3Box.y + n3Box.height / 2 + 60, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(400);
const n3Moved = await posOf("n3");
check("the device was dragged", JSON.stringify(n3Moved) !== JSON.stringify(n3From), JSON.stringify({ n3From, n3Moved }));
check("a drag takes exactly one undo step", (await undoDepth()) === depthBefore + 1, `${depthBefore} -> ${await undoDepth()}`);
await page.mouse.click(1400, 80);
await page.keyboard.press("Control+z");
await page.waitForTimeout(300);
check("one undo puts the dragged device back", JSON.stringify(await posOf("n3")) === JSON.stringify(n3From),
  JSON.stringify({ n3From, now: await posOf("n3") }));
const groupOf = (id) => page.evaluate((i) => {
  const d = window.__cvStore.getState().doc;
  const nodes = d.pages ? Object.values(d.pages).flatMap((pg) => pg.nodes ?? []) : d.nodes ?? [];
  return nodes.find((x) => x.id === i)?.data?.groupId ?? null;
}, id);
check("and undoes only the move — the grouping before it stays", (await groupOf("n1")) !== null);
await page.keyboard.press("Control+y");
await page.waitForTimeout(300);
check("redo moves it again", JSON.stringify(await posOf("n3")) === JSON.stringify(n3Moved),
  JSON.stringify({ n3Moved, now: await posOf("n3") }));
await page.keyboard.press("Control+z");
await page.waitForTimeout(300);
if ((await groupOf("n1")) === null) {
  await page.evaluate(() => {
    const st = window.__cvStore.getState();
    st.onNodesChange([{ type: "select", id: "n1", selected: true }, { type: "select", id: "n2", selected: true }]);
    st.groupSelected();
    st.selectNone();
  });
  await page.waitForTimeout(300);
}
// Back to the whole sheet, so both members are on the canvas, not under a panel.
await page.keyboard.press("Escape");
await page.keyboard.press("f");
await page.waitForTimeout(500);
const n1From = await posOf("n1");
const n2Box = await page.locator('.react-flow__node[data-id="n2"] .cv-glyph-hit').boundingBox();
await page.mouse.move(n2Box.x + n2Box.width / 2, n2Box.y + n2Box.height / 2);
await page.mouse.down();
await page.mouse.move(n2Box.x + n2Box.width / 2 - 140, n2Box.y + n2Box.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(400);
check("the group member dragged moved", JSON.stringify(await posOf("n2")) !== JSON.stringify(n2From),
  JSON.stringify({ n2From, now: await posOf("n2") }));
check("and carried the rest of its group", JSON.stringify(await posOf("n1")) !== JSON.stringify(n1From),
  JSON.stringify({ n1From, now: await posOf("n1") }));
await page.mouse.click(1400, 80);
await page.keyboard.press("Control+z");
await page.waitForTimeout(300);
check("and one undo brings the whole group back",
  JSON.stringify(await posOf("n2")) === JSON.stringify(n2From) && JSON.stringify(await posOf("n1")) === JSON.stringify(n1From),
  JSON.stringify({ n1: await posOf("n1"), n2: await posOf("n2") }));

// ------------------------------------------------------------- LT-158

const viewport = () => page.locator(".react-flow__viewport").evaluate((el) => {
  const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
  return { x: m.e, y: m.f };
});
const bare = async () => {
  const pane = await page.locator(".react-flow__pane").boundingBox();
  return { x: pane.x + pane.width - 260, y: pane.y + pane.height - 200 };
};
await page.mouse.click(1400, 80);
await page.waitForTimeout(200);

// Unchanged: space first, then the button.
let at = await bare();
let was = await viewport();
await page.keyboard.down("Space");
await page.mouse.move(at.x, at.y);
await page.mouse.down();
await page.mouse.move(at.x - 180, at.y - 110, { steps: 12 });
await page.mouse.up();
await page.keyboard.up("Space");
await page.waitForTimeout(300);
let now = await viewport();
check("space then drag pans, as before", Math.abs(now.x - was.x) > 80, `${Math.round(now.x - was.x)}px`);

// The button a moment before space.
at = await bare();
was = await viewport();
await page.mouse.move(at.x, at.y);
await page.mouse.down();
await page.mouse.move(at.x - 6, at.y - 4, { steps: 2 });
await page.keyboard.down("Space");
await page.waitForTimeout(60);
await page.mouse.move(at.x - 200, at.y - 120, { steps: 12 });
const boxDuring = await page.locator(".react-flow__selection").count();
await page.mouse.up();
await page.keyboard.up("Space");
await page.waitForTimeout(300);
now = await viewport();
check("pressing space just after the button still pans", Math.abs(now.x - was.x) > 80,
  `${Math.round(now.x - was.x)}px`);
check("and draws no selection box", boxDuring === 0, `${boxDuring} selection box(es) while dragging`);
const leftSelected = await page.locator(".react-flow__nodesselection").count();
check("and leaves no devices selected by a box", leftSelected === 0, `${leftSelected} box selection(s) left`);

// LT-287: the space bar is never let go, which is how a person actually pans.
at = await bare();
was = await viewport();
await page.keyboard.down("Space");
await page.mouse.move(at.x, at.y);
await page.mouse.down();
await page.mouse.move(at.x - 170, at.y - 100, { steps: 12 });
let during = await viewport();
check("the diagram moves while the space bar is still held", Math.abs(during.x - was.x) > 80,
  `${Math.round(during.x - was.x)}px`);
await page.mouse.up();
// Still held: a second drag must pan too, without touching the keyboard.
was = await viewport();
await page.mouse.move(at.x, at.y);
await page.mouse.down();
await page.mouse.move(at.x - 120, at.y - 60, { steps: 10 });
await page.mouse.up();
during = await viewport();
check("and a second drag pans without letting the key go", Math.abs(during.x - was.x) > 50,
  `${Math.round(during.x - was.x)}px`);

// The right button, which is what he reaches for, and no menu with it.
was = await viewport();
await page.mouse.move(at.x, at.y);
await page.mouse.down({ button: "right" });
await page.mouse.move(at.x - 150, at.y - 90, { steps: 10 });
await page.mouse.up({ button: "right" });
await page.waitForTimeout(200);
now = await viewport();
check("a right-button drag pans while space is held", Math.abs(now.x - was.x) > 60, `${Math.round(now.x - was.x)}px`);
check("and opens no menu over the diagram", (await page.locator(".cv-menu").count()) === 0, `${await page.locator(".cv-menu").count()} menu(s)`);
await page.keyboard.up("Space");
await page.waitForTimeout(200);

// Shift is the key the report starts from: "when I hold shift and try to drag
// around to move the whole diagram around". It has to be a hand too.
was = await viewport();
await page.keyboard.down("Shift");
await page.mouse.move(at.x, at.y);
await page.mouse.down();
await page.mouse.move(at.x - 140, at.y - 80, { steps: 10 });
during = await viewport();
check("shift and a drag move the diagram", Math.abs(during.x - was.x) > 60,
  `${Math.round(during.x - was.x)}px`);
check("and draw no selection box while they do",
  (await page.locator(".react-flow__selection").count()) === 0);
await page.mouse.up();
await page.keyboard.up("Shift");
await page.waitForTimeout(200);

// Alt+Shift stays the lasso that adds to a selection (LT-173), whichever way
// round the two keys are pressed.
for (const order of [["Alt", "Shift"], ["Shift", "Alt"]]) {
  await page.keyboard.down(order[0]);
  await page.keyboard.down(order[1]);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 60, at.y + 20, { steps: 6 });
  const drawn = await page.locator(".cv-lasso polygon").count();
  await page.mouse.up();
  await page.keyboard.up(order[1]);
  await page.keyboard.up(order[0]);
  await page.waitForTimeout(150);
  check(`${order.join("+")} still draws a lasso, not a pan`, drawn === 1, `${drawn} outline(s)`);
}

// Focus left in a panel field.
// Whatever the step above left selected, start clean: an overlay left by a
// stray selection box would otherwise take this click and hide every result
// after it.
await page.keyboard.press("Escape");
await page.evaluate(() => {
  const st = window.__cvStore.getState();
  st.select("n3", null);
});
await page.waitForTimeout(400);
const field = page.locator(".cv-inspector input[type=text], .cv-inspector input:not([type])").first();
const hasField = (await field.count()) > 0;
check("the inspector offers a text field to focus", hasField);
if (hasField) {
  await field.click();
  // The device's own name, read from the store: the inspector re-renders when
  // the canvas is pressed, so a field located again would not be the same one.
  const labelOf = () => page.evaluate(() => {
    const d = window.__cvStore.getState().doc;
    const nodes = d.pages ? Object.values(d.pages).flatMap((pg) => pg.nodes ?? []) : d.nodes ?? [];
    return nodes.find((n) => n.id === "n3")?.data?.label;
  });
  const labelBefore = await labelOf();
  at = await bare();
  was = await viewport();
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.keyboard.down("Space");
  await page.waitForTimeout(60);
  await page.mouse.move(at.x - 200, at.y - 120, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await page.waitForTimeout(300);
  now = await viewport();
  check("after typing in a panel field, space-drag on the canvas pans", Math.abs(now.x - was.x) > 80,
    `${Math.round(now.x - was.x)}px`);
  check("and puts no space into the device's name", (await labelOf()) === labelBefore,
    `${JSON.stringify(labelBefore)} -> ${JSON.stringify(await labelOf())}`);
}

// ------------------------------------------------------------- LT-189
// Pointing at a link traces it and fades the rest. Pressing a button — to pan
// or drag — must end that: a diagram left faded for the whole pan flickered,
// and on a large page re-fading cost most of every frame.
await page.keyboard.press("Escape");
await page.mouse.click(1400, 80);
await page.keyboard.press("f");
await page.waitForTimeout(600);
// TraceFade's own rule; the app stylesheet mentions the class too.
const fading = () => page.evaluate(() =>
  [...document.querySelectorAll("style")].some((s) => s.textContent.includes(".cv-link-body:not([data-edge=")));
// A point really on the link, where what is under the pointer belongs to it.
const onLine = await page.evaluate(() => {
  const path = document.querySelector('.react-flow__edge[data-id="e1"] .react-flow__edge-path');
  if (!path) return null;
  const m = path.getScreenCTM();
  const len = path.getTotalLength();
  for (let i = 1; i < 40; i++) {
    const p = path.getPointAtLength((len * i) / 40);
    const at = { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
    const el = document.elementFromPoint(at.x, at.y);
    if (el?.closest?.('.cv-edge-hit[data-id="e1"], .react-flow__edge[data-id="e1"]')) return at;
  }
  return null;
});
check("a point on the link can be found to point at", onLine !== null);
if (onLine) {
  await page.mouse.move(onLine.x - 40, onLine.y - 40);
  await page.mouse.move(onLine.x, onLine.y, { steps: 4 });
  await page.waitForTimeout(300);
  check("pointing at a link traces it", await fading());
  await page.mouse.down({ button: "middle" });
  await page.waitForTimeout(100);
  check("pressing a button there ends the tracing", !(await fading()));
  let refaded = false;
  for (let i = 1; i <= 15; i++) {
    await page.mouse.move(onLine.x + i * 12, onLine.y + i * 6);
    if (await fading()) refaded = true;
  }
  await page.mouse.up({ button: "middle" });
  check("and panning with it held does not trace again", !refaded);
}

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
