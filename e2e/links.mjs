// How a link meets a device and where its labels sit: a
// core switch above an access switch, one link between them with two port
// labels and a cable tag. The link must end on the switch's drawn tile, not
// on the square around it, and the port chips must sit beside the line, clear
// of the device's name and of the centre label.
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const device = (id, label, x, y, deviceType, extra = {}) => ({
  id, type: "device", position: { x, y }, width: 76, height: 76,
  data: { label, deviceType, tags: [], addresses: [{ id: `${id}-a`, address: "192.0.2.10", isPrimary: true }], locked: false, maintenance: false, showDetails: true, ...extra },
});

const project = {
  meta: { id: "links", name: "Links", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    nodes: [
      device("core", "Core switch", 300, 100, "core-switch", { portCount: 48, portNaming: "Gi1/0/{n}" }),
      device("acc", "Access switch 1", 300, 320, "access-switch"),
      device("rtr", "Router", 700, 100, "router", { portCount: 4, portNaming: "Gi0/0/{n}" }),
      device("fw", "Edge firewall", 300, -60, "firewall"),
    ],
    edges: [
      { id: "e1", source: "core", target: "acc", type: "live",
        data: { sourcePortLabel: "Gi1/0/24", targetPortLabel: "Gi1/0/1", label: "Trunk VLAN 10,20", pathType: "smoothstep", cableType: "trunk",
          direction: "none", width: 2, enabled: true, maintenance: false, healthRule: { type: "manual", manualStatus: "healthy" } } },
      { id: "e2", source: "core", target: "rtr", type: "live",
        data: { sourcePortLabel: "Te1/1/1", targetPortLabel: "Gi0/0/0", label: "", pathType: "straight",
          direction: "none", width: 2, enabled: true, maintenance: false, healthRule: { type: "manual", manualStatus: "healthy" } } },
      { id: "e3", source: "fw", target: "core", type: "live",
        data: { sourcePortLabel: "port3", targetPortLabel: "Gi1/0/48", label: "10 Gb", pathType: "smoothstep", cableType: "fiber-mm",
          direction: "none", width: 2, enabled: true, maintenance: false, healthRule: { type: "manual", manualStatus: "healthy" } } },
    ],
    probes: [],
    canvas: {},
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
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
// Screen boxes are read back into flow units through the viewport's transform.
const vp = async () => {
  const origin = await page.locator(".react-flow").first().boundingBox();
  const m = await page.evaluate(() => getComputedStyle(document.querySelector(".react-flow__viewport")).transform);
  const n = (m.match(/-?\d+(\.\d+)?/g) ?? ["1", "0", "0", "1", "0", "0"]).map(Number);
  return { k: n[0], tx: n[4], ty: n[5], ox: origin.x, oy: origin.y };
};
const overlap = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const box = async (sel) => {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) return null;
  const v = await vp();
  return { x: (b.x - v.ox - v.tx) / v.k, y: (b.y - v.oy - v.ty) / v.k, width: b.width / v.k, height: b.height / v.k };
};
const pathEnds = async (edgeId) => {
  const d = await page.locator(`.react-flow__edge[data-id="${edgeId}"] path`).first().getAttribute("d");
  const nums = d.match(/-?\d+(\.\d+)?/g).map(Number);
  return { d, start: { x: nums[0], y: nums[1] }, end: { x: nums[nums.length - 2], y: nums[nums.length - 1] } };
};

// ------------------------------------------------------------- the link meets the drawing

{
  const e1 = await pathEnds("e1");
  // The core switch's tile occupies 4.2..19.8 of its 24-grid: the link leaves
  // at 76 * 19.8 / 24 = 62.7 below the node's top, not at 76.
  // The core switch has 48 ports named Gi1/0/{n}, so a link labelled
  // Gi1/0/24 leaves from port 24 along the tile's bottom edge
  // (tile x 1.2..22.8 of 24 → 76 * (1.2 + 21.6 * 23.5 / 48) / 24 = 37.3).
  check("a link leaving the bottom of a switch starts on the tile's lower edge, not the square's, at its port",
    Math.abs(e1.start.y - (100 + 62.7)) < 2 && Math.abs(e1.start.x - (300 + 37.3)) < 2, JSON.stringify(e1.start));
  // The access switch's tile starts 7.2 down its 24-grid: 76 * 7.2 / 24 = 22.8.
  check("and arrives on the access switch's tile, not its square",
    Math.abs(e1.end.y - (320 + 22.8)) < 2, JSON.stringify(e1.end));
  const e2 = await pathEnds("e2");
  // The router's 4 ports face the core switch on its left side; Gi0/0/0 names
  // no port it has (ports are 1–4), so the link meets the circle on the bearing.
  check("a link to a router meets its circle on the bearing",
    Math.abs(e2.end.x - (700 + 76 * 2.2 / 24)) < 2 && Math.abs(e2.end.y - 138) < 2, JSON.stringify(e2.end));
  // Gi1/0/48 is port 48 of the core switch: the link from the firewall above lands on it, at the
  // right-hand end of the top edge (76 * (1.2 + 21.6 * 47.5 / 48) / 24 = 71.5), and still arrives from above.
  const e3 = await pathEnds("e3");
  check("a link labelled with a port the device has lands on that port", Math.abs(e3.end.x - (300 + 71.5)) < 2 && Math.abs(e3.end.y - (100 + 76 * 4.2 / 24)) < 2, JSON.stringify(e3.end));
  const nums = e3.d.match(/-?\d+(\.\d+)?/g).map(Number);
  check("and arrives on it from above, the side the port is on", nums[nums.length - 3] < e3.end.y - 5 && Math.abs(nums[nums.length - 4] - e3.end.x) < 1, e3.d);
}

// ------------------------------------------------------------- port labels beside the line, clear of the name

{
  const name = await box('[data-id="core"] .cv-glyph-text');
  const chip = await box('.cv-edge-port:has-text("Gi1/0/24")');
  const centre = await box(".cv-edge-center");
  const e1 = await pathEnds("e1");
  check("the source port chip does not sit on the core switch's name", !overlap(name, chip), JSON.stringify({ name, chip }));
  check("nor on the centre label", !overlap(centre, chip), JSON.stringify({ centre, chip }));
  // Beside the line: the chip's centre is off the vertical link by more than its half width.
  const lineX = e1.start.x; // the link is vertical: both ends are at x ≈ 338
  const cx = chip.x + chip.width / 2;
  check("and it is beside the line, not on it", Math.abs(cx - lineX) > chip.width / 2 + 3, `chip centre ${cx.toFixed(0)} line ${lineX.toFixed(0)} width ${chip.width.toFixed(0)}`);
  const tchip = await box('.cv-edge-port:has-text("Gi1/0/1")');
  const allChips = await page.locator(".cv-edge-port").evaluateAll((els) => els.map((e) => [e.textContent, e.style.transform]));
  check("the two ends' chips take opposite sides", (cx - lineX) * (tchip.x + tchip.width / 2 - lineX) < 0, JSON.stringify({ cx, t: tchip.x + tchip.width / 2, lineX, d: e1.d, allChips }));
  // The link arrives from above, so its chip sits a chip-length above the tile.
  check("and the target chip is near the access switch, not mid-link", Math.abs(tchip.y + tchip.height / 2 - 342.8) < 60 && tchip.y + tchip.height / 2 < 342.8, JSON.stringify(tchip));
}

// ------------------------------------------------------------- the centre label of a short link slides past the name

{
  const name = await box('[data-id="fw"] .cv-glyph-text');
  const centre = await box('.react-flow__edge[data-id="e3"] ~ * .cv-edge-center, .cv-edge-center:has-text("10 Gb")');
  check("on a short link down from a device, the cable tag sits below the device's name, not on it", !overlap(name, centre) && centre.y > name.y + name.height - 2, JSON.stringify({ name, centre }));
  const pchip = await box('.cv-edge-port:has-text("port3")');
  check("and its port chip is clear of the name too", !overlap(name, pchip) && !overlap(centre, pchip), JSON.stringify({ name, pchip, centre }));
}

// ------------------------------------------------------------- ports as connection points

{
  // Select the core→router link and drag its router end to the router's third port on its left side.
  await page.locator('.cv-edge-hit[data-id="e2"] path').first().click({ force: true });
  await page.waitForTimeout(300);
  const v = await vp();
  const toScreen = (fx, fy) => ({ x: v.ox + v.tx + fx * v.k, y: v.oy + v.ty + fy * v.k });
  const ends = page.locator(".cv-edge-endpoint");
  check("a selected link shows its two end handles", (await ends.count()) === 2);
  const handle = await ends.nth(1).boundingBox();
  // Port 3 of 4 on the router's left edge: y = 100 + 76 * (2.2 + 19.6 * 2.5 / 4) / 24.
  const port3 = toScreen(700 + 76 * 2.2 / 24, 100 + 76 * (2.2 + 19.6 * 2.5 / 4) / 24);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(port3.x - 9, port3.y + 10, { steps: 8 });
  await page.waitForTimeout(150);
  check("near a device with ports, its ports are shown as ticks on the side facing the pointer",
    (await page.locator('.cv-port-ticks[data-node="rtr"] circle').count()) === 4 && (await page.locator(".cv-port-ticks").getAttribute("data-side")) === "l", String(await page.locator(".cv-port-ticks circle").count()));
  await page.mouse.move(port3.x + 2, port3.y + 1, { steps: 6 });
  await page.waitForTimeout(150);
  check("snapped to a port, the ring names it", (await page.locator(".cv-connection-snap-name").textContent()) === "Gi0/0/3", await page.locator(".cv-connection-snap-name").textContent().catch(() => "none"));
  await page.mouse.up();
  await page.waitForTimeout(300);
  const e2 = await page.evaluate(() => window.__cvStore.getState().doc.pages[0].edges.find((e) => e.id === "e2").data);
  check("dropped on the port, the end is anchored there and takes the port's name", e2.targetPortLabel === "Gi0/0/3" && e2.targetAnchor && Math.abs(e2.targetAnchor.x - 2.2 / 24) < 0.01, JSON.stringify({ label: e2.targetPortLabel, anchor: e2.targetAnchor }));
  const path = await pathEnds("e2");
  check("and the link now ends on that port", Math.abs(path.end.y - (100 + 76 * (2.2 + 19.6 * 2.5 / 4) / 24)) < 1.5, JSON.stringify(path.end));
}

// ------------------------------------------------------------- auto routing round everything, in lanes

{
  // A note between the core switch and the access switch; e1 set to auto goes round it.
  await page.evaluate(() => {
    const s = window.__cvStore.getState();
    const doc = s.doc;
    const note = { id: "memo", type: "note", position: { x: 290, y: 215 }, width: 100, height: 70, data: { title: "", body: "memo", variant: "sticky", fontSize: 12 } };
    const pages = doc.pages.map((p) => (p.id === doc.activePageId ? { ...p, nodes: [...p.nodes, note] } : p));
    window.__cvStore.setState({ doc: { ...doc, pages } });
    s.updateEdgeData("e1", { pathType: "auto" });
  });
  await page.waitForTimeout(400);
  const routed = await pathEnds("e1");
  const xs = routed.d.match(/-?\d+(\.\d+)?/g).map(Number).filter((_, i) => i % 2 === 0);
  check("set to auto, a link goes round a note in its way", Math.max(...xs) > 390 + 10 || Math.min(...xs) < 290 - 10, routed.d);
  check("and still starts and ends where it did", Math.abs(routed.start.y - 162.7) < 2 && Math.abs(routed.end.y - 342.8) < 2, JSON.stringify([routed.start, routed.end]));
  // A second auto link between the same pair takes its own lane.
  await page.evaluate(() => {
    const s = window.__cvStore.getState();
    const doc = s.doc;
    const twin = { id: "e1b", source: "core", target: "acc", type: "live", data: { sourcePortLabel: "Gi1/0/25", targetPortLabel: "Gi1/0/2", label: "", pathType: "auto", direction: "none", width: 2, enabled: true, maintenance: false, healthRule: { type: "manual", manualStatus: "healthy" } } };
    const pages = doc.pages.map((p) => (p.id === doc.activePageId ? { ...p, edges: [...p.edges, twin] } : p));
    window.__cvStore.setState({ doc: { ...doc, pages } });
  });
  await page.waitForTimeout(400);
  const one = await pathEnds("e1");
  const two = await pathEnds("e1b");
  const midX = (d) => { const n = d.match(/-?\d+(\.\d+)?/g).map(Number); const xs = n.filter((_, i) => i % 2 === 0); return xs[Math.floor(xs.length / 2)]; };
  check("two auto links between one pair run in separate lanes", one.d !== two.d && Math.abs(midX(one.d) - midX(two.d)) >= 8, JSON.stringify({ a: midX(one.d), b: midX(two.d) }));
  // Re-route all: every link back on the page's default path, hand-drawn routes and pinned ends gone.
  await page.evaluate(() => window.__cvStore.getState().updateEdgeData("e2", { waypoints: [{ x: 500, y: 50 }] }));
  await page.waitForTimeout(200);
  const n = await page.evaluate(() => window.__cvStore.getState().rerouteAll());
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => window.__cvStore.getState().doc.pages[0].edges.map((e) => [e.id, e.data.pathType, (e.data.waypoints ?? []).length, e.data.targetAnchor ?? null]));
  check("Re-route all puts every link on the page's default path with no hand-drawn route or pinned end", n === 4 && after.every(([, p, w, a]) => p === "bezier" && w === 0 && a === null), JSON.stringify(after));
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  check("and one undo brings them back", (await page.evaluate(() => window.__cvStore.getState().doc.pages[0].edges.find((e) => e.id === "e1").data.pathType)) === "auto");
}

await browser.close();
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall link checks passed");
