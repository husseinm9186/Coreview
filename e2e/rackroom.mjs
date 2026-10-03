// LT-681–LT-689: the racks screen rebuilt — reached from the rail; furniture
// and reservations added from the page and placed by the same rules as
// devices; a stack with its technology and its cables drawn as the vendor's
// guide draws them; airflow per box and a rack that says when they fight;
// building, floor, room, row and position; faceplates drawn as what they
// are; zoom; budgets. Stubbed backend; the elevation is document state.
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;
const UNIT = 14;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const dev = (id, label, x, y, deviceType, extra = {}) => ({
  id, type: "device", position: { x, y }, width: 76, height: 76,
  data: { label, deviceType, tags: [], addresses: [], locked: false, maintenance: false, showDetails: true, ...extra },
});

const project = {
  meta: { id: "rackroom", name: "Rack room", customer: "", site: "", ticket: "", engineer: "", description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    nodes: [
      dev("sw1", "ACC-SW-1", 0, 0, "access-switch", { rack: "RACK-01", rackUnits: 1, rackU: 42, portCount: 48, airflow: "front-to-back" }),
      dev("sw2", "ACC-SW-2", 200, 0, "access-switch", { rack: "RACK-01", rackUnits: 1, rackU: 41, portCount: 48, airflow: "front-to-back" }),
      dev("sw3", "ACC-SW-3", 400, 0, "access-switch", { rack: "RACK-01", rackUnits: 1, rackU: 40, portCount: 48 }),
      dev("fw", "EDGE-FW", 0, 200, "firewall", { rack: "RACK-01", rackUnits: 1, rackU: 38, airflow: "back-to-front", powerW: 120, weightKg: 3.2 }),
      dev("srv", "SRV-1", 200, 200, "server", { rack: "RACK-02", rackUnits: 2, rackU: 20, powerW: 450, weightKg: 18 }),
    ],
    edges: [],
    probes: [],
    canvas: {},
    racks: [
      { id: "r1", name: "RACK-01", units: 42, building: "HQ", floor: "2", room: "2.14", row: "B", position: "03" },
      { id: "r2", name: "RACK-02", units: 24, building: "HQ", floor: "2", room: "2.14", row: "B", position: "04", powerLimitW: 400 },
    ],
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript(({ p }) => {
  localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
  let next = 1;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return next++; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "", engineer: "", description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({});
      if (cmd === "plugin:dialog|save") return Promise.resolve("/tmp/coreview-rackroom-test.out");
      if (cmd === "pick_export_target") return Promise.resolve({ token: `t-${next++}`, path: `/tmp/${args.filename}` });
      if (cmd === "save_export") {
        const bytes = Uint8Array.from(atob(args.contentsB64), (c) => c.charCodeAt(0));
        (window.__exports ??= []).push(new TextDecoder().decode(bytes));
        return Promise.resolve(null);
      }
      return Promise.resolve([]);
    },
  };
}, { p: project });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(800);

const st = (fn, arg) => page.evaluate(fn, arg);
const item = (id) => page.locator(`.cv-rack-item[data-device="${id}"]`);
const rackNamed = (name) => page.locator(".cv-rack", { has: page.locator(`.cv-rack-slots[data-rack="${name}"]`) });
const message = () => page.locator(".cv-racks-message").textContent();
const racks = () => st(() => window.__cvStore.getState().doc.racks);

// ------------------------------------------------------------- LT-681 the rail

await page.locator(".cv-nav-item", { hasText: /^Racks$/ }).click();
await page.waitForTimeout(600);
check("Racks is on the rail and opens the racks screen", (await page.locator(".cv-racks").count()) === 1 && (await page.locator(".cv-nav-item.is-current").innerText()) === "Racks");
check("Tools still offers it as a tab", (await page.locator(".cv-tools .cv-tabs button", { hasText: /^Racks$/ }).count()) === 1);

// ------------------------------------------------------------- LT-685 where

check("racks are grouped under where they stand", (await page.locator(".cv-racks-place-head").textContent()) === "HQ · Floor 2 · Room 2.14", await page.locator(".cv-racks-place-head").textContent());
check("in row and position order", JSON.stringify(await page.locator(".cv-rack-name").evaluateAll((els) => els.map((e) => e.value))) === JSON.stringify(["RACK-01", "RACK-02"]));
check("and each rack says its place", (await rackNamed("RACK-01").locator('[data-region="rack-place"]').innerText()).startsWith("HQ · Floor 2 · Room 2.14 · Row B · 03"), await rackNamed("RACK-01").locator('[data-region="rack-place"]').innerText());
await rackNamed("RACK-02").locator("button", { hasText: /^Where$/ }).click();
await rackNamed("RACK-02").getByLabel("Row of rack RACK-02").fill("C");
await rackNamed("RACK-02").getByLabel("Row of rack RACK-02").blur();
await page.waitForTimeout(200);
check("the place is edited on the rack", (await racks()).find((r) => r.id === "r2").row === "C");
await rackNamed("RACK-02").locator("button", { hasText: /^Where$/ }).click();
await page.waitForTimeout(100);
await page.getByLabel("Filter by building, floor, room or rack").fill("RACK-02");
await page.waitForTimeout(200);
check("a filter narrows to one rack", (await page.locator(".cv-rack").count()) === 1);
await page.getByLabel("Filter by building, floor, room or rack").fill("");
await page.waitForTimeout(200);

// ------------------------------------------------------------- LT-687 faceplates

const sw1 = item("sw1");
check("a switch is drawn with its class glyph, a colour strip and a port row",
  (await sw1.locator(".cv-rack-item-glyph").count()) === 1 && (await sw1.locator(".cv-rack-item-strip").count()) === 1 && (await sw1.locator(".cv-fascia.is-ports").getAttribute("data-count")) === "48");
check("the U numbers run down both posts, every fifth marked",
  (await page.locator('.cv-rack-slots[data-rack="RACK-01"]').locator("..").locator(".cv-rack-numbers.is-right li").count()) === 42 && (await page.locator(".cv-rack-numbers.is-left li.is-fifth").first().innerText()) === "40");
await page.locator(".cv-seg button", { hasText: "Rear" }).click();
await page.waitForTimeout(200);
check("from the rear a device shows its power supplies, not its ports", (await sw1.locator(".cv-fascia.is-psus").count()) === 1 && (await sw1.locator(".cv-fascia.is-ports").count()) === 0);
await page.locator(".cv-seg button", { hasText: "Front" }).click();
await page.waitForTimeout(200);

// ------------------------------------------------------------- LT-684 airflow

check("a front-to-back box breathes in on the front", (await sw1.locator(".cv-rack-air.is-in").count()) === 1);
check("a back-to-front one blows out of it", (await item("fw").locator(".cv-rack-air.is-out").count()) === 1);
const summary1 = () => rackNamed("RACK-01").locator('[data-region="rack-summary"]').innerText();
check("and the rack says its airflow is mixed", /2 front-to-back · 1 back-to-front/.test(await summary1()) && /mixed/.test(await summary1()), await summary1());
await item("sw3").click();
await page.getByLabel("Airflow of ACC-SW-3").selectOption("front-to-back");
await page.waitForTimeout(200);
check("airflow is set from the chosen bar", (await st(() => window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === "sw3").data.airflow)) === "front-to-back" && (await item("sw3").locator(".cv-rack-air.is-in").count()) === 1);

// ------------------------------------------------------------- LT-682, LT-686 furniture and reservations

await rackNamed("RACK-01").locator(".cv-rack-name").click();
await page.locator('.cv-racks-furniture-item[data-kind="patch-panel"]').click();
await page.waitForTimeout(250);
let items = (await racks()).find((r) => r.id === "r1").items ?? [];
check("a patch panel is added to the chosen rack at the first free U from the top", items.length === 1 && items[0].kind === "patch-panel" && items[0].u === 39, JSON.stringify(items));
check("drawn as a row of jacks", (await page.locator('.cv-rack-item[data-kind="patch-panel"] .cv-fascia.is-jacks').getAttribute("data-count")) === "24");
await page.locator('.cv-racks-furniture-item[data-kind="reserved"]').click();
await page.waitForTimeout(250);
const reservation = page.locator('.cv-rack-item[data-kind="reserved"]');
check("a reservation takes its U, hatched", (await reservation.count()) === 1 && (await reservation.getAttribute("data-bottom")) === "37");
// A box grows upward from its U, and U38 is the firewall's: put the
// reservation lower before making it taller.
await st(() => { const s = window.__cvStore.getState(); const f = s.doc.racks[0].items.find((x) => x.kind === "reserved"); s.placeFurniture("r1", f.id, 20); });
await page.waitForTimeout(200);
await reservation.click();
await page.getByLabel("Reserved for").fill("the new core switch, Q3");
await page.getByLabel("Reserved for").blur();
await page.getByLabel("Height in U", { exact: true }).fill("3");
await page.getByLabel("Height in U", { exact: true }).blur();
await page.waitForTimeout(250);
items = (await racks()).find((r) => r.id === "r1").items;
const res = items.find((f) => f.kind === "reserved");
check("what it is for, and how tall, typed on it", res.note === "the new core switch, Q3" && res.units === 3, JSON.stringify(res));
check("and the faceplate says so", /Reserved — the new core switch, Q3/.test(await reservation.innerText()));
check("the rack counts it apart", /3U reserved/.test(await summary1()), await summary1());
// A device cannot be dropped into reserved space.
const problem = await st(() => window.__cvStore.getState().placeInRack("sw3", "r1", 21));
check("nothing else is placed on a reservation", /taken by Reserved/.test(problem ?? ""), problem);
check("a reservation cannot grow into what is there", /taken by/.test((await st(() => { const s = window.__cvStore.getState(); const f = s.doc.racks[0].items.find((x) => x.kind === "reserved"); return s.updateFurniture("r1", f.id, { units: 20 }); })) ?? ""));
await page.locator('.cv-racks-furniture-item[data-kind="pdu-vertical"]').click();
await page.waitForTimeout(250);
check("a vertical PDU is zero-U and listed apart", /Zero-U: PDU \(vertical, zero-U\)/.test(await rackNamed("RACK-01").locator(".cv-rack-foot").innerText()));
await page.locator('.cv-rack-item[data-kind="patch-panel"]').click();
await page.locator(".cv-racks-chosen button", { hasText: /^Remove$/ }).click();
await page.waitForTimeout(250);
check("furniture can be removed again", !((await racks()).find((r) => r.id === "r1").items ?? []).some((f) => f.kind === "patch-panel"));
await item("sw1").click();
await page.keyboard.press("Control+z");
await page.waitForTimeout(300);
check("and undo brings it back", ((await racks()).find((r) => r.id === "r1").items ?? []).some((f) => f.kind === "patch-panel"));

// ------------------------------------------------------------- LT-683 stacks

await page.locator(".cv-racks button", { hasText: /^New stack$/ }).click();
await page.getByLabel("Stack name").fill("ACCESS-STACK");
await page.getByLabel("Technology").selectOption("cisco-stackwise-480");
for (const id of ["sw1", "sw2", "sw3"]) await page.getByLabel("Add a member…").selectOption(id);
check("the editor numbers the members and names their roles from the guide", /1.*ACC-SW-1.*Active/s.test(await page.locator(".cv-racks-stackmembers").innerText()) && /2.*ACC-SW-2.*Standby/s.test(await page.locator(".cv-racks-stackmembers").innerText()));
check("and says the preset is from the vendor's guide", /Catalyst 9300 StackWise/.test(await page.locator(".cv-racks-stacknote").innerText()));
await page.locator('[data-region="stack-editor"] button', { hasText: /^Add stack$/ }).click();
await page.waitForTimeout(300);
const stacks = await st(() => window.__cvStore.getState().doc.stacks);
check("a stack is kept in the document with its members in order", stacks.length === 1 && stacks[0].technology === "cisco-stackwise-480" && stacks[0].topology === "ring" && stacks[0].members.map((m) => m.nodeId).join(",") === "sw1,sw2,sw3", JSON.stringify(stacks));
check("each member's faceplate carries its number", (await item("sw1").locator(".cv-rack-item-stack").innerText()) === "1" && (await item("sw3").locator(".cv-rack-item-stack").innerText()) === "3");
check("StackWise ports are on the rear, so the front draws no cables", (await rackNamed("RACK-01").locator('[data-region="rack-cables"]').count()) === 0);
await page.locator(".cv-seg button", { hasText: "Rear" }).click();
await page.waitForTimeout(300);
const cables = rackNamed("RACK-01").locator('[data-region="rack-cables"] .cv-rack-cable');
check("the rear draws the ring: three cables for three members, the last closing it", (await cables.count()) === 3);
check("with a legend naming the stack and the technology", /ACCESS-STACK · StackWise-480.*ring/.test(await rackNamed("RACK-01").locator('[data-region="rack-legend"]').innerText()));
await page.locator(".cv-seg button", { hasText: "Front" }).click();
await page.waitForTimeout(200);
await page.locator(".cv-racks-stack button", { hasText: "ACCESS-STACK" }).click();
await page.getByLabel("Technology").selectOption("aruba-vsx");
check("a pair technology refuses three members", /two members|at most 2/.test((await (async () => { await page.locator('[data-region="stack-editor"] button', { hasText: /^Save stack$/ }).click(); await page.waitForTimeout(200); return message(); })()) ?? ""), await message());
await page.getByLabel("Technology").selectOption("aruba-vsf");
await page.getByLabel("Topology").selectOption("chain");
await page.locator('[data-region="stack-editor"] button', { hasText: /^Save stack$/ }).click();
await page.waitForTimeout(300);
check("VSF ports are front ports, so the front draws a chain of two", (await cables.count()) === 2 && (await st(() => window.__cvStore.getState().doc.stacks[0].topology)) === "chain");
check("and a dashed stub says where a member in another rack is", (await rackNamed("RACK-01").locator(".cv-rack-cable.is-elsewhere").count()) === 0);
check("a device cannot be in two stacks", /one stack/.test(await st(() => window.__cvStore.getState().addStack({ name: "B", technology: "custom", topology: "ring", members: [{ nodeId: "sw1", number: 1 }, { nodeId: "fw", number: 2 }] })) ?? ""));

// ------------------------------------------------------------- LT-689 budgets

const summary2 = await rackNamed("RACK-02").locator('[data-region="rack-summary"]').innerText();
check("a rack sums its power against its limit, and its weight, and says when it is over", /450 W \/ 400 W/.test(summary2) && /18 kg/.test(summary2) && (await rackNamed("RACK-02").locator('[data-region="rack-summary"] .is-over').count()) >= 1, summary2);
check("and its U", /2U used · 22U free · 0U reserved/.test(summary2), summary2);

// ------------------------------------------------------------- LT-688 zoom

const before = await page.locator('.cv-rack-slots[data-rack="RACK-01"]').boundingBox();
await page.locator(".cv-racks-zoomctl button", { hasText: "+" }).click();
await page.waitForTimeout(200);
const after = await page.locator('.cv-rack-slots[data-rack="RACK-01"]').boundingBox();
check("zooming in makes the rack bigger on screen", after.height > before.height * 1.1 && (await page.locator(".cv-racks-zoomvalue").innerText()) === "125%", `${before.height} -> ${after.height}`);
// A drop at 125 % still lands on the U under the pointer.
const slots = page.locator('.cv-rack-slots[data-rack="RACK-01"]');
const unitsTall = await slots.evaluate((el) => Math.round(el.clientHeight / 14));
const y = (2 + (unitsTall - 10) * UNIT + UNIT / 2) * 1.25;
await slots.evaluate((el, y) => { const body = el.closest(".cv-racks-stage"); const r = el.getBoundingClientRect(); const b = body.getBoundingClientRect(); body.scrollTop += r.top + y - (b.top + b.height / 2); }, y);
await page.waitForTimeout(100);
await item("fw").dragTo(slots, { targetPosition: { x: 40, y } });
await page.waitForTimeout(300);
check("a drop while zoomed lands on the U under the pointer", (await st(() => window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === "fw").data.rackU)) === 10, String(await st(() => window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === "fw").data.rackU)));
await page.locator(".cv-racks-zoomvalue").click();
await page.waitForTimeout(200);
check("and 100 % comes back", (await page.locator(".cv-racks-zoomvalue").innerText()) === "100%");

// ------------------------------------------------------------- LT-692 a drop lands on the face you see

await page.locator(".cv-seg button", { hasText: "Front" }).click();
await page.waitForTimeout(200);
await rackNamed("RACK-02").locator(".cv-rack-name").click();
await page.locator('.cv-racks-furniture-item[data-kind="pdu"]').click();
await page.waitForTimeout(200);
const pdu = (await racks()).find((r) => r.id === "r2").items.find((f) => f.kind === "pdu");
check("a PDU added while the front shows is mounted on the front, and is there", pdu?.face === "front" && (await page.locator('.cv-rack-item[data-kind="pdu"]').count()) === 1, JSON.stringify(pdu));
await page.locator('.cv-racks-furniture-item[data-kind="console-server"]').click();
await page.waitForTimeout(200);
check("and so is a console server", (await page.locator('.cv-rack-item[data-kind="console-server"]').isVisible()));
await page.locator('.cv-racks-furniture-item[data-kind="pdu-vertical"]').click();
await page.waitForTimeout(200);
check("a zero-U PDU is drawn as a strip down the post", (await rackNamed("RACK-02").locator('[data-region="rack-zerou"] .cv-rack-zerou-item').count()) === 1);
await page.locator(".cv-seg button", { hasText: "Rear" }).click();
await page.waitForTimeout(200);
check("mounted on the front, the strip is not on the rear", (await rackNamed("RACK-02").locator('[data-region="rack-zerou"] .cv-rack-zerou-item').count()) === 0);
await page.locator(".cv-seg button", { hasText: "Front" }).click();
await page.waitForTimeout(200);

// ------------------------------------------------------------- LT-693 colour

await page.locator('.cv-rack-item[data-kind="pdu"]').click();
await page.locator('[data-region="rack-colour"] .cv-swatch').nth(3).click();
await page.waitForTimeout(200);
check("a swatch colours a piece of furniture", (await racks()).find((r) => r.id === "r2").items.find((f) => f.kind === "pdu").colour === "#e4564a" && (await page.locator('.cv-rack-item[data-kind="pdu"] .cv-rack-item-strip').count()) === 1);
await item("srv").click();
await page.locator('[data-region="rack-colour"] .cv-swatch').nth(4).click();
await page.waitForTimeout(200);
check("and a device, replacing its class colour", (await st(() => window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === "srv").data.rackColour)) === "#b07ff0" && (await item("srv").evaluate((el) => getComputedStyle(el).getPropertyValue("--rack-item-colour").trim())) === "#b07ff0");
await page.locator('[data-region="rack-colour"] .cv-swatch.is-none').click();
await page.waitForTimeout(200);
check("× takes the colour away again", (await st(() => window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === "srv").data.rackColour)) === undefined);

// ------------------------------------------------------------- LT-696 faceplates

check("a switch's faceplate carries port blocks, uplinks and a status light",
  (await item("sw1").locator(".cv-fascia.is-ports").getAttribute("data-count")) === "48" && (await item("sw1").locator(".cv-fascia.is-uplinks").count()) === 1 && (await item("sw1").locator(".cv-rack-led").count()) === 1);
check("a server's carries drive bays", (await item("srv").locator(".cv-fascia.is-bays").count()) === 1);
check("a PDU's carries outlets and a patch panel's jacks", (await page.locator('.cv-rack-item[data-kind="pdu"] .cv-fascia.is-outlets').count()) === 1 && (await page.locator('.cv-rack-item[data-kind="patch-panel"] .cv-fascia.is-jacks').count()) === 1);
await page.locator(".cv-seg button", { hasText: "Rear" }).click();
await page.waitForTimeout(200);
check("and the rear of a device shows fans and power supplies", (await item("sw1").locator(".cv-fascia.is-psus").count()) === 1 && (await item("sw1").locator(".cv-fascia.is-fans").count()) === 1);
await page.locator(".cv-seg button", { hasText: "Front" }).click();

// ------------------------------------------------------------- LT-694 the editor is a card

await page.locator(".cv-racks-stack button", { hasText: "ACCESS-STACK" }).click();
await page.waitForTimeout(200);
const editor = await page.locator('[data-region="stack-editor"]').boundingBox();
const stage = await page.locator('[data-region="rack-stage"]').boundingBox();
check("the stack editor is a card across the top, above the stage, not down the column", editor.width > 900 && editor.y + editor.height <= stage.y + 1 && editor.height < 260, JSON.stringify({ editor, stage }));
await page.locator('[data-region="stack-editor"] button', { hasText: /^Cancel$/ }).click();

// ------------------------------------------------------------- LT-695 the side view

await page.locator(".cv-seg button", { hasText: "Side" }).click();
await page.waitForTimeout(300);
const sideOf = (id) => page.locator(`.cv-rack-side-item[data-device="${id}"]`);
check("the side view draws every placed box as a bar", (await page.locator(".cv-rack-side-item").count()) >= 6);
check("a full-depth box reaches most of the way, a half-depth one well under half",
  (await sideOf("sw1").getAttribute("data-depth")) === "85" && (await page.locator('.cv-rack-side-item[data-depth="40"]').count()) >= 1);
check("from the front rail for a front-mounted box", (await sideOf("sw1").boundingBox()).x < (await rackNamed("RACK-01").locator(".cv-rack-slots").boundingBox()).x + 6);
await sideOf("srv").click();
await page.getByLabel("Depth of SRV-1 in millimetres").fill("730");
await page.getByLabel("Depth of SRV-1 in millimetres").blur();
await page.waitForTimeout(250);
check("a depth in millimetres sizes the bar against the rack's depth", (await sideOf("srv").getAttribute("data-depth")) === "73" && /730 mm/.test(await sideOf("srv").innerText()), await sideOf("srv").getAttribute("data-depth"));
await rackNamed("RACK-02").locator("button", { hasText: /^Where$/ }).click();
await rackNamed("RACK-02").getByLabel("Depth of rack RACK-02 in millimetres").fill("800");
await rackNamed("RACK-02").getByLabel("Depth of rack RACK-02 in millimetres").blur();
await page.waitForTimeout(250);
check("and the rack's own depth, set under Where, rescales it", (await sideOf("srv").getAttribute("data-depth")) === "91", await sideOf("srv").getAttribute("data-depth"));
await rackNamed("RACK-02").locator("button", { hasText: /^Where$/ }).click();
await page.waitForTimeout(100);
check("the rack says its size", /800 mm deep · 600 mm wide/.test(await rackNamed("RACK-02").locator('[data-region="rack-place"]').innerText()));
await page.locator(".cv-seg button", { hasText: "Front" }).click();
await page.waitForTimeout(200);

// ------------------------------------------------------------- the export carries it all

await page.locator(".cv-racks button", { hasText: "Export front as SVG" }).click();
await page.waitForTimeout(400);
const svg = await page.evaluate(() => (window.__exports ?? []).at(-1) ?? "");
check("the SVG export carries the place, the reservation and the stack",
  svg.startsWith("<svg") && svg.includes("HQ · Floor 2 · Room 2.14 · Row B · 03") && svg.includes("Reserved — the new core switch, Q3") && /ACCESS-STACK: VSF/.test(svg) && svg.includes("1U used") === false,
  svg.slice(0, 120));
check("and the usage line", /\d+U used · \d+U free · 3U reserved/.test(svg));

await browser.close();
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall rack-room checks passed");
