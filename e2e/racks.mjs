// Racks and cables, driven through the real app (Phase 1.4): the rack
// elevation editor (LT-195), racks from devices (LT-196), front and rear
// (LT-197) and the cable schedule (LT-198).
// Invented names only (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/racks.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const dev = (id, label, x, y, type, extra = {}) => ({
  id, type: "device", position: { x, y }, width: 76, height: 76,
  data: { label, deviceType: type, tags: [], addresses: [], locked: false, maintenance: false, showDetails: false, ...extra },
});
const wire = (id, source, target, extra = {}) => ({
  id, source, target, sourceHandle: "b", targetHandle: "t", type: "live",
  data: { sourcePortLabel: "", targetPortLabel: "", label: "", pathType: "straight", direction: "none", width: 2,
    color: "#2fbf6b", enabled: true, maintenance: false, healthRule: { type: "manual", manualStatus: "unknown" }, ...extra },
});
const canvas = { gridEnabled: true, snapEnabled: true, minimap: true, nodeStyle: "glyph" };
const project = {
  meta: { id: "racks", name: "Racks", createdAt: NOW, updatedAt: NOW },
  documentVersion: 1,
  document: {
    activePageId: "p1",
    probes: [],
    pages: [
      { id: "p1", name: "Logical", canvas,
        nodes: [
          dev("sw", "SW-1", 0, 0, "access-switch", { rack: "RACK-01", rackUnits: 1 }),
          dev("srv", "SRV-1", 200, 0, "server", { rack: "RACK-01", rackUnits: 2 }),
          dev("panel", "PANEL-1", 400, 0, "patch-panel", { rack: "RACK-01", rackUnits: 1, rackDepth: "half" }),
          dev("pdu", "PDU-1", 600, 0, "pdu", { rack: "RACK-01", rackUnits: 0 }),
          dev("ap", "AP-1", 0, 200, "access-point", { rackUnits: 1 }),
          dev("laptop", "LAPTOP", 200, 200, "endpoint"),
        ],
        edges: [
          wire("e1", "sw", "srv", { sourcePortLabel: "Gi1/0/10", targetPortLabel: "eth0", cableType: "copper", cableLength: "2 m", label: "C-0001" }),
          wire("e2", "sw", "panel", { sourcePortLabel: "Gi1/0/2", targetPortLabel: "2", cableType: "fiber-mm" }),
        ] },
    ],
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await page.addInitScript(({ p }) => {
  let next = 1;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return next++; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      if (cmd === "plugin:dialog|save") return Promise.resolve("/tmp/coreview-racks-test.out");
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
const data = (id) => st((id) => window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === id).data, id);
const uOf = async (id) => (await data(id)).rackU;
const message = () => page.locator(".cv-racks-message").textContent();
const positions = () => st(() => JSON.stringify(window.__cvStore.getState().doc.pages[0].nodes.map((n) => n.position)));
const item = (id) => page.locator(`.cv-rack-item[data-device="${id}"]`);
const slots = (name) => page.locator(`.cv-rack-slots[data-rack="${name}"]`);
const UNIT = 14;
/** Drags onto a rack so the dragged box's top lands in U `topU`. */
const dragInto = async (source, rackName, topU, units) => {
  const rackUnits = await slots(rackName).evaluate((el) => Math.round(el.clientHeight / 14));
  const y = 2 + (rackUnits - topU) * UNIT + UNIT / 2;
  // The panel scrolls: bring the target U into view first, as a person would.
  await slots(rackName).evaluate((el, y) => {
    const body = el.closest(".cv-panel-body");
    const r = el.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    body.scrollTop += r.top + y - (b.top + b.height / 2);
  }, y);
  await page.waitForTimeout(100);
  await source.dragTo(slots(rackName), { targetPosition: { x: 40, y } });
  await page.waitForTimeout(300);
};

await page.locator(".cv-panel-tabs button, .cv-panel button", { hasText: /^Racks$/ }).first().click();
await page.waitForTimeout(300);

// ------------------------------------------------------ LT-196 from devices
check("the Racks tab starts with no racks", (await page.locator(".cv-racks-empty").count()) === 1);
const before = await positions();
await page.locator(".cv-racks button", { hasText: "Build racks from devices" }).click();
await page.waitForTimeout(300);
check("building from devices makes the rack the devices name", (await page.locator(".cv-rack").count()) === 1 &&
  (await page.locator(".cv-rack-name").inputValue()) === "RACK-01");
check("and says what it did", (await message()) === "Added 1 rack and placed 3 devices.", await message());
check("filling from the top", (await uOf("sw")) === 42 && (await uOf("srv")) === 40 && (await uOf("panel")) === 39,
  `${await uOf("sw")} ${await uOf("srv")} ${await uOf("panel")}`);
check("without moving anything on the diagram", (await positions()) === before);
check("the zero-U device is listed apart", (await page.locator(".cv-rack-foot").textContent()).includes("Zero-U: PDU-1"));
const srvBox = await item("srv").boundingBox();
check("a 2U device is drawn two U tall", Math.round(srvBox.height) === 2 * UNIT, String(srvBox.height));

// ------------------------------------------------------------ LT-195 editing
await dragInto(item("sw"), "RACK-01", 30, 1);
check("dragging a device moves it to a whole U", (await uOf("sw")) === 30, String(await uOf("sw")));
await dragInto(item("sw"), "RACK-01", 41, 1);
check("into space another holds is refused", (await uOf("sw")) === 30 && /taken by SRV-1/.test(await message()), await message());
await dragInto(item("srv"), "RACK-01", 1, 2);
check("a device can go to the bottom U", (await uOf("srv")) === 1, String(await uOf("srv")));
await item("sw").click();
await page.keyboard.press("ArrowUp");
await page.waitForTimeout(200);
check("the arrow keys move the selected device a U", (await uOf("sw")) === 31, String(await uOf("sw")));
await page.keyboard.press("Control+z");
await page.waitForTimeout(200);
check("and undo puts it back", (await uOf("sw")) === 30, String(await uOf("sw")));
await item("sw").click();
check("the device's details are shown", /U30 · 1U · mounted front · full depth/.test(await page.locator(".cv-racks-chosen").textContent()));

await page.locator(".cv-racks input[aria-label='Filter devices']").fill("AP");
await page.waitForTimeout(200);
const waitingAp = page.locator(".cv-racks-device", { hasText: "AP-1" });
check("devices with a height and no rack wait beside the racks", (await waitingAp.count()) === 1 &&
  (await page.locator(".cv-racks-device", { hasText: "LAPTOP" }).count()) === 0);
await page.locator(".cv-racks input[aria-label='New rack name']").fill("RACK-02");
await page.locator(".cv-racks input[aria-label='New rack height in U']").fill("12");
await page.locator(".cv-racks button", { hasText: "Add rack" }).click();
await page.waitForTimeout(300);
check("a rack can be added with its height", (await page.locator(".cv-rack").count()) === 2 &&
  (await slots("RACK-02").evaluate((el) => el.clientHeight)) === 12 * UNIT);
await page.locator(".cv-racks input[aria-label='New rack name']").fill("rack-02");
await page.locator(".cv-racks button", { hasText: "Add rack" }).click();
await page.waitForTimeout(200);
check("but not twice under one name", (await page.locator(".cv-rack").count()) === 2 && /already a rack/.test(await message()), await message());
await dragInto(waitingAp, "RACK-02", 12, 1);
check("dragging a waiting device in puts it in that rack", (await data("ap")).rack === "RACK-02" && (await uOf("ap")) === 12,
  JSON.stringify(await data("ap")));
const name2 = page.locator(".cv-rack", { has: slots("RACK-02") }).locator(".cv-rack-name");
await name2.fill("RACK-02B");
await name2.blur();
await page.waitForTimeout(300);
check("renaming a rack carries its devices with it", (await data("ap")).rack === "RACK-02B");
const height2 = page.locator(".cv-rack", { has: slots("RACK-02B") }).locator("input[aria-label='Rack height in U']");
await height2.fill("4");
await height2.blur();
await page.waitForTimeout(300);
check("shrinking a rack below a device is refused", /above 4U/.test(await message()) && (await height2.inputValue()) === "12", await message());

// ---------------------------------------------------------- LT-197 front and rear
await page.locator(".cv-seg button", { hasText: "Rear" }).click();
await page.waitForTimeout(200);
check("from the rear, a full-depth device shows from behind", (await item("srv").getAttribute("class")).includes("is-behind"));
check("and a half-depth one on the front face is not there", (await item("panel").count()) === 0);
await page.locator(".cv-seg button", { hasText: "Front" }).click();
await page.waitForTimeout(200);
await item("panel").click();
await page.locator(".cv-racks-chosen button", { hasText: "Mount rear" }).click();
await page.waitForTimeout(200);
check("a device can be mounted on the rear", (await data("panel")).rackFace === "rear" && (await item("panel").count()) === 0);
await page.locator(".cv-seg button", { hasText: "Rear" }).click();
await page.waitForTimeout(200);
check("where the rear view shows it", (await item("panel").count()) === 1 && !(await item("panel").getAttribute("class")).includes("is-behind"));
await page.locator(".cv-seg button", { hasText: "Front" }).click();
await page.waitForTimeout(200);
await dragInto(page.locator(".cv-racks-device", { hasText: "AP-1" }).or(item("ap")).first(), "RACK-01", 39, 1);
// AP-1 moved racks: into U39, which the rear-mounted half-depth panel shares.
check("a full-depth device cannot share a U with a rear half-depth one", (await data("ap")).rack === "RACK-02B", await message());
await item("sw").click();
await page.locator(".cv-racks-chosen button", { hasText: "Make half depth" }).click();
await page.waitForTimeout(200);
await dragInto(item("sw"), "RACK-01", 39, 1);
check("but a half-depth one on the front can", (await uOf("sw")) === 39, `${await uOf("sw")} ${await message()}`);

// Exporting the elevation.
await page.locator(".cv-racks button", { hasText: "Export front as SVG" }).click();
await page.waitForTimeout(400);
const svg = await page.evaluate(() => (window.__exports ?? []).at(-1) ?? "");
check("the elevation exports as SVG with every rack", svg.startsWith("<svg") && svg.includes("RACK-01") && svg.includes("RACK-02B") && svg.includes(">SW-1<"),
  svg.slice(0, 80));

// A copy is another box: it keeps its rack but not the U.
await st(() => {
  const s = window.__cvStore.getState();
  s.onNodesChange(s.doc.pages[0].nodes.map((n) => ({ type: "select", id: n.id, selected: n.id === "srv" })));
  s.copySelection();
  s.paste();
});
await page.waitForTimeout(300);
const copy = await st(() => window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.data.label === "SRV-1" && n.id !== "srv").data);
check("a pasted copy is not in the original's U", copy.rack === "RACK-01" && copy.rackU === undefined, JSON.stringify(copy));
check("and waits to be placed", (await page.locator(".cv-rack-foot").first().textContent()).includes("Not placed: SRV-1"));

// ------------------------------------------------------------- LT-198 cables
await page.locator(".cv-panel button", { hasText: /^Monitored objects/ }).first().click();
await st(() => window.__cvStore.getState().select(null, "e2"));
await page.waitForTimeout(300);
const length = page.locator(".cv-inspector .cv-field", { hasText: "Cable length" }).locator("input");
check("a link's inspector takes a cable length", (await length.count()) === 1);
await length.fill("15 m");
await page.waitForTimeout(200);
check("which the link keeps", await st(() => window.__cvStore.getState().doc.pages[0].edges.find((e) => e.id === "e2").data.cableLength === "15 m"));

const exportMenu = page.locator("details.cv-dropdown", { has: page.locator("summary", { hasText: "Export" }) });
await exportMenu.locator("summary").click();
await page.waitForTimeout(200);
await page.locator(".cv-dropdown-menu button", { hasText: "Cable schedule as CSV" }).click();
await page.waitForTimeout(400);
const csv = await page.evaluate(() => (window.__exports ?? []).at(-1) ?? "");
check("the cable schedule exports as CSV, in port order", csv ===
  "Page,Device A,Port A,Device B,Port B,Cable,Length,Label\r\n" +
  "Logical,SW-1,Gi1/0/2,PANEL-1,2,\"Fibre, multimode\",15 m,\r\n" +
  "Logical,SW-1,Gi1/0/10,SRV-1,eth0,Copper,2 m,C-0001", JSON.stringify(csv));
if (!(await exportMenu.evaluate((d) => d.open))) await exportMenu.locator("summary").click();
await page.waitForTimeout(200);
await page.locator(".cv-dropdown-menu button", { hasText: "Validation report" }).click();
await page.waitForTimeout(400);
const report = await page.evaluate(() => (window.__exports ?? []).at(-1) ?? "");
check("and is in the report", report.includes("## Cable schedule (2)") && report.includes("| Logical | SW-1 | Gi1/0/10 | SRV-1 | eth0 | Copper | 2 m | C-0001 |"),
  report.slice(report.indexOf("## Cable"), report.indexOf("## Cable") + 300));

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
