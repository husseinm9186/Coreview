// The racks screen rebuilt — reached from the rail; furniture
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
      // Four access points in no rack, all off ACC-SW-1.
      dev("ap1", "AP-1", 600, 0, "access-point", {}),
      dev("ap2", "AP-2", 700, 0, "access-point", {}),
      dev("ap3", "AP-3", 800, 0, "access-point", {}),
      dev("ap4", "AP-4", 900, 0, "access-point", {}),
    ],
    edges: [
      { id: "c1", source: "sw1", target: "sw2", type: "live", data: { sourcePortLabel: "Gi1/0/47", targetPortLabel: "Gi1/0/48", cableType: "copper", enabled: true } },
      { id: "c2", source: "sw1", target: "fw", type: "live", data: { sourcePortLabel: "Te1/1/1", targetPortLabel: "port1", cableType: "fiber-mm", enabled: true } },
      { id: "c3", source: "sw3", target: "srv", type: "live", data: { sourcePortLabel: "Gi1/0/12", targetPortLabel: "eth0", cableType: "copper", enabled: true } },
      // A second link to the same rack from the next port, and four to the access points.
      { id: "c4", source: "sw3", target: "srv", type: "live", data: { sourcePortLabel: "Gi1/0/13", targetPortLabel: "eth1", cableType: "copper", enabled: true } },
      ...[1, 2, 3, 4].map((n) => ({ id: `ap${n}`, source: "sw1", target: `ap${n}`, type: "live", data: { sourcePortLabel: `Gi1/0/${n}`, targetPortLabel: "eth0", cableType: "copper", enabled: true } })),
    ],
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

// ------------------------------------------------------------- the rail

await page.locator(".cv-nav-item", { hasText: /^Racks$/ }).click();
await page.waitForTimeout(600);
check("Racks is on the rail and opens the racks screen", (await page.locator(".cv-racks").count()) === 1 && (await page.locator(".cv-nav-item.is-current").innerText()) === "Racks");
check("Tools still offers it as a tab", (await page.locator(".cv-tools .cv-tabs button", { hasText: /^Racks$/ }).count()) === 1);

// ------------------------------------------------------------- a short window

{
  // Before anything else is open: the window the operator had, a stack in
  // the document, and the side column has to show it.
  await page.setViewportSize({ width: 849, height: 968 });
  await page.waitForTimeout(400);
  const tmp = await st(() => { window.__cvStore.getState().addStack({ name: "TMP-STACK", technology: "cisco-stackwise-480", topology: "ring", members: [{ nodeId: "sw1", number: 1 }, { nodeId: "sw2", number: 2 }] }); return (window.__cvStore.getState().doc.stacks ?? []).find((x) => x.name === "TMP-STACK")?.id ?? null; });
  await page.waitForTimeout(300);
  const li = page.locator(".cv-racks-stack").first();
  const btn = page.locator(".cv-racks-waiting button", { hasText: /^New stack$/ });
  const a = await li.boundingBox();
  const b = await btn.boundingBox();
  check("in a short window the stack list is not squashed under the New stack button", a && b && a.y + a.height <= b.y + 1, JSON.stringify({ a, b }));
  await li.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const a2 = await li.boundingBox();
  check("and the column scrolls to it", (await li.isVisible()) && a2.y >= 0 && a2.y + a2.height <= 968, JSON.stringify(a2));
  await st((id) => window.__cvStore.getState().removeStack(id), tmp);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(300);
}

// ------------------------------------------------------------- where

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

// ------------------------------------------------------------- faceplates

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

// ------------------------------------------------------------- airflow

check("a front-to-back box breathes in on the front", (await sw1.locator(".cv-rack-air.is-in").count()) === 1);
check("a back-to-front one blows out of it", (await item("fw").locator(".cv-rack-air.is-out").count()) === 1);
const summary1 = () => rackNamed("RACK-01").locator('[data-region="rack-summary"]').innerText();
check("and the rack says its airflow is mixed", /2 front-to-back · 1 back-to-front/.test(await summary1()) && /mixed/.test(await summary1()), await summary1());
await item("sw3").click();
await page.getByLabel("Airflow of ACC-SW-3").selectOption("front-to-back");
await page.waitForTimeout(200);
check("airflow is set from the chosen bar", (await st(() => window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === "sw3").data.airflow)) === "front-to-back" && (await item("sw3").locator(".cv-rack-air.is-in").count()) === 1);

// ------------------------------------------------------------- furniture and reservations

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

// ------------------------------------------------------------- stacks

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

// ------------------------------------------------------------- budgets

const summary2 = await rackNamed("RACK-02").locator('[data-region="rack-summary"]').innerText();
check("a rack sums its power against its limit, and its weight, and says when it is over", /450 W \/ 400 W/.test(summary2) && /18 kg/.test(summary2) && (await rackNamed("RACK-02").locator('[data-region="rack-summary"] .is-over').count()) >= 1, summary2);
check("and its U", /2U used · 22U free · 0U reserved/.test(summary2), summary2);

// ------------------------------------------------------------- zoom

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

// ------------------------------------------------------------- a drop lands on the face you see

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

// ------------------------------------------------------------- colour

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

// ------------------------------------------------------------- faceplates

check("a switch's faceplate carries port blocks, uplinks and a status light",
  (await item("sw1").locator(".cv-fascia.is-ports").getAttribute("data-count")) === "48" && (await item("sw1").locator(".cv-fascia.is-uplinks").count()) === 1 && (await item("sw1").locator(".cv-rack-led").count()) === 1);
check("a server's carries drive bays", (await item("srv").locator(".cv-fascia.is-bays").count()) === 1);
check("a PDU's carries outlets and a patch panel's jacks", (await page.locator('.cv-rack-item[data-kind="pdu"] .cv-fascia.is-outlets').count()) === 1 && (await page.locator('.cv-rack-item[data-kind="patch-panel"] .cv-fascia.is-jacks').count()) === 1);
await page.locator(".cv-seg button", { hasText: "Rear" }).click();
await page.waitForTimeout(200);
check("and the rear of a device shows fans and power supplies", (await item("sw1").locator(".cv-fascia.is-psus").count()) === 1 && (await item("sw1").locator(".cv-fascia.is-fans").count()) === 1);
await page.locator(".cv-seg button", { hasText: "Front" }).click();

// ------------------------------------------------------------- the editor is a card

await page.locator(".cv-racks-stack button", { hasText: "ACCESS-STACK" }).click();
await page.waitForTimeout(200);
const editor = await page.locator('[data-region="stack-editor"]').boundingBox();
const stage = await page.locator('[data-region="rack-stage"]').boundingBox();
check("the stack editor is a card across the top, above the stage, not down the column", editor.width > 900 && editor.y + editor.height <= stage.y + 1 && editor.height < 260, JSON.stringify({ editor, stage }));
await page.locator('[data-region="stack-editor"] button', { hasText: /^Cancel$/ }).click();

// ------------------------------------------------------------- the side view

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
check("the rack says its size", /W 600 mm · D 800 mm/.test(await rackNamed("RACK-02").locator('[data-region="rack-place"]').innerText()), await rackNamed("RACK-02").locator('[data-region="rack-place"]').innerText());
await page.locator(".cv-seg button", { hasText: "Front" }).click();
await page.waitForTimeout(200);

// ------------------------------------------------------------- patch cables, power

await page.locator(".cv-seg button", { hasText: "Front" }).click();
await page.waitForTimeout(300);
const patch1 = rackNamed("RACK-01").locator('[data-region="rack-patch"] .cv-rack-patch-cable');
// Two cables inside the rack, two stubs to RACK-02; the four links to the
// access points in no rack draw nothing here.
check("the diagram's links are drawn as patch cables between the ports they name", (await patch1.count()) === 4,
  String(await patch1.count()));
check("a cable names both ends and its type", /ACC-SW-1 Gi1\/0\/47 ↔ ACC-SW-2 Gi1\/0\/48 · copper/.test(await patch1.locator("title").first().textContent()), await patch1.locator("title").first().textContent());
check("a link to another rack ends in a stub that names the rack", (await rackNamed("RACK-01").locator('[data-region="rack-patch"] .is-elsewhere').count()) === 2 && /→ RACK-02/.test(await rackNamed("RACK-01").locator('[data-region="rack-patch"] .is-elsewhere text').first().textContent()) && /SRV-1 eth0 \(RACK-02 U20\)/.test(await rackNamed("RACK-01").locator('[data-region="rack-patch"] .is-elsewhere title').first().textContent()), await rackNamed("RACK-01").locator('[data-region="rack-patch"] .is-elsewhere text').first().textContent());
check("and the other rack shows its ends of it", (await rackNamed("RACK-02").locator('[data-region="rack-patch"] .is-elsewhere').count()) === 2);
// A cable is hit on its stroke, not on the box around it: dispatched, since
// the box's centre is a faceplate.
await patch1.first().dispatchEvent("click");
await page.waitForTimeout(200);
check("clicking a cable selects its link", (await st(() => window.__cvStore.getState().selectedEdgeId)) === "c1");
// The cable steps out of the rack — its bundle runs outside the slots, never across a box.
const cable = (id) => rackNamed("RACK-01").locator(`[data-region="rack-patch"] .cv-rack-patch-cable[data-edge="${id}"]`);
{
  const d = await cable("c1").locator("path").getAttribute("d");
  const slotsW = await rackNamed("RACK-01").locator(".cv-rack-slots").evaluate((e) => e.clientWidth);
  const xs = d.match(/-?\d+(\.\d+)?/g).map(Number).filter((_, i) => i % 2 === 0);
  check("a cable between two boxes runs out of the rack to a bundle beside it and back", Math.min(...xs) < -4 || Math.max(...xs) > slotsW + 4, `${d} (slots ${slotsW})`);
  const c2 = await cable("c2").locator("path").getAttribute("d");
  const x1 = Math.min(...d.match(/-?\d+(\.\d+)?/g).map(Number).filter((_, i) => i % 2 === 0));
  const x2 = Math.min(...c2.match(/-?\d+(\.\d+)?/g).map(Number).filter((_, i) => i % 2 === 0));
  check("two cables take two lanes of the bundle", Math.abs(x1 - x2) >= 2, `${x1} vs ${x2}`);
}
// The selected link's cable is lit and the others fade; a chosen box lights its cables; a port cell selects its link.
check("the selected link's cable glows and the rest fade back", (await cable("c1").getAttribute("class")).includes("is-lit") && (await cable("c2").getAttribute("class")).includes("is-dim"));
await item("sw1").dispatchEvent("click");
await page.waitForTimeout(200);
check("choosing a box lights every cable on it", (await rackNamed("RACK-01").locator('[data-region="rack-patch"] .is-lit').count()) === 2 && (await cable("c1").getAttribute("class")).includes("is-lit") && (await cable("c2").getAttribute("class")).includes("is-lit"), String(await rackNamed("RACK-01").locator('[data-region="rack-patch"] .is-lit').count()));
// The cell is two pixels wide: dispatched, as the cable click is.
await item("sw2").locator(".cv-fascia.is-ports i").nth(47).dispatchEvent("click");
await page.waitForTimeout(200);
check("clicking a port cell selects the link plugged into it", (await st(() => window.__cvStore.getState().selectedEdgeId)) === "c1" && (await cable("c1").getAttribute("class")).includes("is-lit"));
await page.locator("label", { hasText: /^Cables$/ }).locator("input").uncheck();
await page.waitForTimeout(200);
check("the Cables switch hides them", (await page.locator('[data-region="rack-patch"]').count()) === 0);
await page.locator("label", { hasText: /^Cables$/ }).locator("input").check();
await page.waitForTimeout(200);

// Power: a vertical PDU on the rear post, a horizontal one at the bottom.
await page.locator(".cv-seg button", { hasText: "Rear" }).click();
await page.waitForTimeout(200);
await rackNamed("RACK-01").locator(".cv-rack-name").click();
await page.locator('.cv-racks-furniture-item[data-kind="pdu-vertical"]').click();
await page.waitForTimeout(200);
const pduA = (await racks()).find((r) => r.id === "r1").items.filter((f) => f.kind === "pdu-vertical").at(-1);
const pduLine = () => rackNamed("RACK-01").locator('[data-region="pdu-load"]').last();
await page.locator('.cv-rack-item[data-device="sw1"]').click();
await page.waitForTimeout(200);
await page.getByLabel("PDU feeding supply A of ACC-SW-1").selectOption(pduA.id);
await page.waitForTimeout(200);
await page.getByLabel("Outlet feeding supply A of ACC-SW-1").fill("3");
await page.waitForTimeout(200);
const fed = await st(() => window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === "sw1").data.powerFeeds);
check("supply A is plugged into the PDU's outlet 3 from the chosen bar", JSON.stringify(fed) === JSON.stringify([{ pduId: pduA.id, outlet: 3 }]), JSON.stringify(fed));
const cords = rackNamed("RACK-01").locator('[data-region="rack-power"] .cv-rack-patch-cable');
check("the rear draws the cord from the supply to the outlet", (await cords.count()) === 1 && /ACC-SW-1 supply A → PDU \(vertical, zero-U\) outlet 3/.test(await cords.first().locator("title").textContent()), await cords.first().locator("title").textContent().catch(() => "none"));
check("and the PDU's line counts the outlet", /1 of 24 outlets/.test(await pduLine().innerText()), await pduLine().innerText());
await page.getByLabel("PDU feeding supply B of ACC-SW-1").selectOption(pduA.id);
await page.waitForTimeout(250);
check("both supplies on one PDU is flagged", /both supplies/.test(await pduLine().innerText()) && (await pduLine().evaluate((el) => el.classList.contains("is-over"))));
await page.locator(".cv-seg button", { hasText: "Front" }).click();
await page.waitForTimeout(200);

// ------------------------------------------------------------- templates

await item("sw3").click();
await page.waitForTimeout(150);
await page.getByLabel("Template").selectOption("sw-24-1u");
check("a template says what it is", /1U · 300 mm · 24 ports · 60 W · 4 kg/.test(await page.locator('[data-region="template-line"]').innerText()), await page.locator('[data-region="template-line"]').innerText());
await page.locator('[data-region="rack-templates"] button', { hasText: /^Apply to ACC-SW-3$/ }).click();
await page.waitForTimeout(250);
const sw3d = await st(() => { const d = window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === "sw3").data; return { u: d.rackUnits, ports: d.portCount, naming: d.portNaming, w: d.powerW, air: d.airflow, depth: d.depthMm }; });
check("applying it sets the device's height, ports, naming, power, airflow and depth", JSON.stringify(sw3d) === JSON.stringify({ u: 1, ports: 24, naming: "Gi1/0/{n}", w: 60, air: "side-to-side", depth: 300 }), JSON.stringify(sw3d));
await page.getByLabel("Template").selectOption("srv-2u");
await page.locator('[data-region="rack-templates"] button', { hasText: /^Apply to ACC-SW-3$/ }).click();
await page.waitForTimeout(250);
check("a template that no longer fits where the box is, is refused", /taken by|does not fit/.test(await message()) && (await st(() => window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === "sw3").data.rackUnits)) === 1, await message());
await rackNamed("RACK-02").locator(".cv-rack-name").click();
await page.getByLabel("Template").selectOption("pp-48");
await page.locator('[data-region="rack-templates"] button', { hasText: /^Add to RACK-02$/ }).click();
await page.waitForTimeout(250);
const pp48 = (await racks()).find((r) => r.id === "r2").items.at(-1);
check("a furniture template adds a box with its figures", pp48?.kind === "patch-panel" && pp48.units === 2 && pp48.ports === 48 && pp48.depthMm === 100, JSON.stringify(pp48));
check("drawn with that many jacks", (await page.locator(`.cv-rack-item[data-device="${pp48.id}"] .cv-fascia.is-jacks`).getAttribute("data-count")) === "48");
await page.locator('input[type=file][aria-label="Import a NetBox device type…"]').setInputFiles({ name: "ex-48p.yaml", mimeType: "text/yaml",
  buffer: Buffer.from("manufacturer: Example Networks\nmodel: EX-48P\nu_height: 1\nis_full_depth: false\nairflow: front-to-rear\nweight: 5.2\nweight_unit: kg\npower-ports:\n  - name: PS1\n    maximum_draw: 350\ninterfaces:\n" + Array.from({ length: 48 }, (_, i) => `  - name: GigabitEthernet1/0/${i + 1}\n    type: 1000base-t\n`).join("")) });
await page.waitForTimeout(400);
const imported = await st(() => window.__cvStore.getState().doc.deviceTemplates);
check("a NetBox device type imports as a template with its fields", imported?.length === 1 && imported[0].name === "Example Networks EX-48P" && imported[0].ports === 48 && imported[0].powerW === 350 && imported[0].airflow === "front-to-back" && imported[0].deviceType === "access-switch", JSON.stringify(imported));
check("and is offered under Imported", (await page.locator('[data-region="rack-templates"] optgroup[label="Imported from NetBox device types"] option').count()) === 1);
await page.locator('input[type=file][aria-label="Import a NetBox device type…"]').setInputFiles({ name: "bad.yaml", mimeType: "text/yaml", buffer: Buffer.from("just: words\n") });
await page.waitForTimeout(300);
check("a file that is not a device type says so", /no "model"/.test(await message()), await message());
await page.locator('[data-region="rack-templates"] button', { hasText: /^Remove template$/ }).click();
await page.waitForTimeout(200);
check("an imported template can be removed", (await st(() => (window.__cvStore.getState().doc.deviceTemplates ?? []).length)) === 0);

// ------------------------------------------------------------- the export carries it all

await page.locator(".cv-racks button", { hasText: "Export front as SVG" }).click();
await page.waitForTimeout(400);
const svg = await page.evaluate(() => (window.__exports ?? []).at(-1) ?? "");
check("the SVG export carries the place, the reservation and the stack",
  svg.startsWith("<svg") && svg.includes("HQ · Floor 2 · Room 2.14 · Row B · 03") && svg.includes("Reserved — the new core switch, Q3") && /ACCESS-STACK: VSF/.test(svg) && svg.includes("1U used") === false,
  svg.slice(0, 120));
check("and the usage line", /\d+U used · \d+U free · 3U reserved/.test(svg));
check("and the patch cables, port to port", svg.includes("<title>ACC-SW-1 Gi1/0/47 ↔ ACC-SW-2 Gi1/0/48</title>") && /→ SRV-1, RACK-02/.test(svg));
check("the export draws no stub for a link to a device in no rack, and its two stubs to the other rack do not overprint", !/not racked/.test(svg) && (() => { const ys = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)" font-size="7"[^>]*>→ SRV-1, RACK-02</g)].map((m) => Number(m[1])); return ys.length === 2 && Math.abs(ys[0] - ys[1]) >= 9; })(), (svg.match(/→ SRV-1[^<]*/g) ?? []).join(" | "));
check("and a title block with the project, the racks, the scale and the date", /front elevation · 1 U = 44\.45 mm/.test(svg) && /\d{4}-\d{2}-\d{2}/.test(svg) && /RACK-01, RACK-02/.test(svg), svg.slice(-600));

// ------------------------------------------------------------- the CAD details

check("a scale bar on the stage says what five U is", /5U · 222 mm/.test(await page.locator('[data-region="rack-scale"]').innerText()));
check("each rack says its height in mm, its width, its depth and its form",
  /H 1867 mm \(42U\) · W 600 mm · D 1000 mm · four-post/.test(await rackNamed("RACK-01").locator('[data-region="rack-dims"]').innerText()), await rackNamed("RACK-01").locator('[data-region="rack-dims"]').innerText());
await rackNamed("RACK-01").locator("button", { hasText: /^Where$/ }).click();
await rackNamed("RACK-01").getByLabel("Numbering of rack RACK-01").selectOption("top");
await page.waitForTimeout(200);
check("numbered from the top: the top rail reads 1 and the bottom 42",
  (await rackNamed("RACK-01").locator(".cv-rack-numbers.is-left li").first().innerText()) === "1" && (await rackNamed("RACK-01").locator(".cv-rack-numbers.is-left li").last().innerText()) === "42" && (await racks()).find((r) => r.id === "r1").numbering === "top");
// Dispatched: a pointer click on the middle of a 48-port faceplate can land on a port cell, which now selects the link in it.
check("and the chosen bar counts the same way", (await (async () => { await item("sw1").dispatchEvent("click"); await page.waitForTimeout(100); return page.locator(".cv-racks-chosen").innerText(); })()).includes("counted from the top"), await page.locator(".cv-racks-chosen").innerText());
await rackNamed("RACK-01").getByLabel("Numbering of rack RACK-01").selectOption("bottom");
await rackNamed("RACK-01").getByLabel("Form of rack RACK-01").selectOption("enclosed");
await rackNamed("RACK-01").getByLabel("Revision of rack RACK-01").fill("B");
await rackNamed("RACK-01").getByLabel("Revision of rack RACK-01").blur();
await page.waitForTimeout(200);
await rackNamed("RACK-01").locator("button", { hasText: /^Where$/ }).click();
check("an enclosed cabinet is drawn as one, and the revision kept", (await rackNamed("RACK-01").getAttribute("data-form")) === "enclosed" && (await racks()).find((r) => r.id === "r1").revision === "B" && /enclosed cabinet/.test(await rackNamed("RACK-01").locator('[data-region="rack-dims"]').innerText()));
await page.locator(".cv-seg button", { hasText: "Side" }).click();
await page.waitForTimeout(200);
const mm = await rackNamed("RACK-01").locator(".cv-rack-numbers.is-mm li").evaluateAll((els) => els.map((e) => e.textContent).filter(Boolean));
check("the side view's right rail is a millimetre ruler", mm[0] === "1867" && mm.includes("889") && mm.at(-1) === "222", JSON.stringify(mm));
await page.locator(".cv-seg button", { hasText: "Front" }).click();
await page.locator(".cv-racks button", { hasText: "Export front as DXF" }).click();
await page.waitForTimeout(400);
const dxf = await page.evaluate(() => (window.__exports ?? []).at(-1) ?? "");
check("the DXF export is R12 in millimetres with the named layers, the racks, the cables and the title block",
  dxf.startsWith("0\nSECTION\n2\nHEADER") && dxf.includes("8\nCABLES\n") && dxf.includes("1\nRACK-01, RACK-02") && dxf.includes("rev B · Coreview") && dxf.trimEnd().endsWith("0\nEOF"), dxf.slice(0, 80));

// ------------------------------------------------------------- what a planner should tell you

const advice = () => rackNamed("RACK-01").locator('[data-region="rack-advice"] li');
await st(() => window.__cvStore.getState().setRackDetails("sw1", { weightKg: 60 }));
await st(() => window.__cvStore.getState().updateEdgeData("c1", { cableLength: "30 cm" }));
await page.waitForTimeout(300);
const kinds = await advice().evaluateAll((els) => els.map((e) => e.dataset.kind));
check("the rack says it is top-heavy when the weight sits high, and that a cable is short for its run", kinds.includes("top-heavy") && kinds.includes("cable-short"), JSON.stringify(kinds));
check("in words a person acts on", /\d+ kg above the middle, \d+ kg below — move the heavy boxes down/.test(await rackNamed("RACK-01").locator('[data-region="rack-advice"] li[data-kind="top-heavy"]').innerText()), await rackNamed("RACK-01").locator('[data-region="rack-advice"]').innerText());
await rackNamed("RACK-01").locator('[data-region="rack-advice"] li[data-kind="top-heavy"] button').click();
await page.waitForTimeout(200);
check("clicking a line chooses the box it is about", /ACC-SW-1/.test(await page.locator('[data-region="rack-chosen"]').innerText()));
await st(() => window.__cvStore.getState().setRackDetails("sw1", { weightKg: 0 }));
await st(() => window.__cvStore.getState().updateEdgeData("c1", { cableLength: "2 m" }));
await page.waitForTimeout(300);
check("and nothing is said once it is put right", !(await advice().evaluateAll((els) => els.map((e) => e.dataset.kind))).some((k) => k === "top-heavy" || k === "cable-short"));

// ------------------------------------------------------------- several at once, the keyboard, find, a layout copied

// Two switches at known free U, well apart.
const freeU = await st(() => {
  const s = window.__cvStore.getState();
  const taken = new Set();
  for (const n of s.doc.pages[0].nodes) if (n.data.rack === "RACK-01" && n.data.rackU !== undefined && n.data.rackUnits > 0) for (let u = n.data.rackU; u < n.data.rackU + n.data.rackUnits; u++) taken.add(u);
  for (const f of s.doc.racks.find((r) => r.id === "r1").items ?? []) if (f.u !== undefined && f.units > 0) for (let u = f.u; u < f.u + f.units; u++) taken.add(u);
  const free = [];
  for (let u = 34; u >= 1 && free.length < 8; u--) if (!taken.has(u)) free.push(u);
  return free;
});
const uA = freeU[0];
const uB = freeU[4];
await st(([a, b]) => { const s = window.__cvStore.getState(); return [s.placeInRack("sw2", "r1", a), s.placeInRack("sw3", "r1", b)]; }, [uA, uB]);
await page.waitForTimeout(200);
const uOf = (id) => st((x) => window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === x).data.rackU, id);
await item("sw2").click();
await item("sw3").click({ modifiers: ["Shift"] });
await page.waitForTimeout(150);
check("Shift-click chooses a second box, and the bar says so", /2 chosen/.test(await page.locator('[data-region="rack-chosen"]').innerText()) && (await item("sw3").evaluate((e) => e.classList.contains("is-also"))), await page.locator('[data-region="rack-chosen"]').innerText());
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(200);
check("the arrows move them together", (await uOf("sw2")) === uA - 1 && (await uOf("sw3")) === uB - 1, JSON.stringify([uA, uB, await uOf("sw2"), await uOf("sw3")]));
await page.locator('[data-region="rack-chosen"] button', { hasText: /^Close the gaps$/ }).click();
await page.waitForTimeout(200);
check("closing the gaps packs the lower one under the higher", (await uOf("sw3")) === uA - 2, String(await uOf("sw3")));
await page.keyboard.press("Delete");
await page.waitForTimeout(200);
check("Delete takes them both out", (await uOf("sw2")) === undefined && (await uOf("sw3")) === undefined);
await page.keyboard.press("Control+z");
await page.waitForTimeout(200);
check("and one undo brings both back", (await uOf("sw2")) === uA - 1 && (await uOf("sw3")) === uA - 2);
await page.getByLabel("Find in racks").fill("srv");
await page.getByLabel("Find in racks").press("Enter");
await page.waitForTimeout(300);
check("the find box chooses a device in another rack and says where it is", /SRV-1/.test(await page.locator('[data-region="rack-chosen"]').innerText()) && /SRV-1: RACK-02 U20 — 1 of 1/.test(await message()), await message());
await page.getByLabel("Find in racks").fill("acc-sw");
await page.getByLabel("Find in racks").press("Enter");
await page.getByLabel("Find in racks").press("Enter");
await page.waitForTimeout(200);
check("Enter again goes to the next match", /2 of 3/.test(await message()) && (await page.locator(".cv-racks-find-count").innerText()) === "2/3", await message());
const r1Items = (await racks()).find((r) => r.id === "r1").items.length;
const r2Before = ((await racks()).find((r) => r.id === "r2").items ?? []).length;
await rackNamed("RACK-01").locator("button", { hasText: /^Where$/ }).click();
await rackNamed("RACK-01").locator("button", { hasText: /^Copy layout$/ }).click();
await rackNamed("RACK-01").locator("button", { hasText: /^Where$/ }).click();
await rackNamed("RACK-02").locator("button", { hasText: /^Where$/ }).click();
await rackNamed("RACK-02").locator("button", { hasText: /^Paste layout$/ }).click();
await page.waitForTimeout(300);
await rackNamed("RACK-02").locator("button", { hasText: /^Where$/ }).click();
const r2Items = (await racks()).find((r) => r.id === "r2").items ?? [];
check("a rack's layout is copied into another: its furniture, with new ids, at the same U where free", r1Items >= 2 && r2Items.length === r2Before + r1Items && new Set(r2Items.map((f) => f.id)).size === r2Items.length && !r2Items.some((f) => f.powerFeeds), JSON.stringify({ r1Items, r2Before, r2: r2Items.map((f) => [f.kind, f.u]) }));
check("and says what it did", /\d+ of \d+ from RACK-01 placed in RACK-02/.test(await message()), await message());

// ------------------------------------------------------------- the floor

{
  await page.locator(".cv-seg button", { hasText: "Floor" }).click();
  await page.waitForTimeout(400);
  const fp = (name) => page.locator(`.cv-floor-rack[data-rack="${name}"]`);
  check("the floor shows the room's racks as footprints", (await page.locator(".cv-floor").count()) >= 1 && (await page.locator(".cv-floor-rack").count()) === 2);
  check("stood in their rows an aisle apart, the second row facing the first", (await fp("RACK-01").getAttribute("data-y")) === "0" && (await fp("RACK-02").getAttribute("data-y")) === "2200" && (await fp("RACK-02").getAttribute("data-facing")) === "n", JSON.stringify([await fp("RACK-01").getAttribute("data-y"), await fp("RACK-02").getAttribute("data-y"), await fp("RACK-02").getAttribute("data-facing")]));
  check("the air is shaded: RACK-01's mixed airflow gives a mixed band both sides, RACK-02's boxes say nothing", (await page.locator(".cv-floor-air.is-mixed").count()) === 2 && (await page.locator(".cv-floor-air").count()) === 2);
  check("with a legend", /cold[\s\S]*hot[\s\S]*mixed[\s\S]*1 m grid/.test(await page.locator('[data-region="floor-legend"]').textContent()), await page.locator('[data-region="floor-legend"]').textContent());
  // Drag RACK-02 up beside RACK-01: 600 mm right, 2200 mm up, at a pixel per centimetre times the zoom.
  const zoomNow = await page.locator(".cv-racks-zoom").evaluate((e) => new DOMMatrixReadOnly(getComputedStyle(e).transform).a || 1);
  const b2 = await fp("RACK-02").boundingBox();
  await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
  await page.mouse.down();
  await page.mouse.move(b2.x + b2.width / 2 + 60 * zoomNow, b2.y + b2.height / 2 - 220 * zoomNow, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const r2 = (await racks()).find((r) => r.id === "r2");
  check("a rack dragged across the floor keeps the spot, snapped to 100 mm", r2.floorX === 600 && r2.floorY === 0, JSON.stringify({ x: r2.floorX, y: r2.floorY, zoomNow }));
  check("and says where it went", /RACK-02 moved to 0\.6 m, 0\.0 m/.test(await message()), await message());
  await page.locator(".cv-floor button", { hasText: /^Number as they stand$/ }).first().click();
  await page.waitForTimeout(300);
  const rs = await racks();
  check("Number as they stand reads rows and positions back off the floor", rs.find((r) => r.id === "r1").row === "A" && rs.find((r) => r.id === "r1").position === "01" && rs.find((r) => r.id === "r2").row === "A" && rs.find((r) => r.id === "r2").position === "02", JSON.stringify(rs.map((r) => [r.name, r.row, r.position])));
  await page.locator(".cv-floor button", { hasText: /^Turn RACK-02$/ }).click();
  await page.waitForTimeout(300);
  check("a rack can be turned a quarter", (await fp("RACK-02").getAttribute("data-facing")) === "w" && (await racks()).find((r) => r.id === "r2").facing === "w");
  await page.locator(".cv-racks button", { hasText: "Export floor as SVG" }).click();
  await page.waitForTimeout(400);
  const floorSvgText = await page.evaluate(() => (window.__exports ?? []).at(-1) ?? "");
  check("the floor exports as an SVG with both racks and the air", floorSvgText.startsWith("<svg") && /class="cv-floor"/.test(floorSvgText) && />RACK-01</.test(floorSvgText) && />RACK-02</.test(floorSvgText) && /cold aisle/.test(floorSvgText), floorSvgText.slice(0, 100));
  await page.locator(".cv-floor button", { hasText: /^Back to its row$/ }).click();
  await page.waitForTimeout(300);
  check("Back to its row forgets the spot", (await racks()).find((r) => r.id === "r2").floorX === undefined);
  await fp("RACK-01").dispatchEvent("dblclick");
  await page.waitForTimeout(400);
  check("double-clicking a footprint opens the rack's elevation", (await page.locator(".cv-seg button[aria-pressed='true']").first().innerText()) === "Front" && /RACK-01: its elevation/.test(await message()) && (await rackNamed("RACK-01").getAttribute("class")).includes("is-target"), await message());
}

// ------------------------------------------------------------- links that leave the rack

{
  const stubs = page.locator('.cv-rack-slots[data-rack="RACK-01"] ~ * .cv-rack-patch-cable.is-elsewhere, .cv-rack-slots[data-rack="RACK-01"] .cv-rack-patch-cable.is-elsewhere');
  const titles = await stubs.locator("title").evaluateAll((els) => els.map((e) => e.textContent));
  check("a link to a device in no rack draws no stub on the elevation", titles.length > 0 && !titles.some((t) => /not racked/.test(t)), JSON.stringify(titles));
  check("the two links to the other rack keep a stub each, spread apart", titles.filter((t) => /RACK-02/.test(t)).length === 2 && (await (async () => { const ys = await stubs.locator("text").evaluateAll((els) => els.map((e) => Number(e.getAttribute("y")))); return ys.length === 2 && Math.abs(ys[0] - ys[1]) >= 9; })()), JSON.stringify(await stubs.locator("text").evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute("y")]))));
  const badge = item("sw1").locator('[data-region="links-out"]');
  check("the faceplate carries the count of links out, naming them on hover", (await badge.count()) === 1 && /^4/.test((await badge.textContent()).trim()) && /Gi1\/0\/1 → AP-1 eth0/.test(await badge.getAttribute("title")), await badge.getAttribute("title"));
  check("and the rack lists them underneath", /ACC-SW-1 4 links out: Gi1\/0\/1 → AP-1 eth0 · Gi1\/0\/2 → AP-2 eth0/.test(await rackNamed("RACK-01").locator('[data-region="rack-links-out"]').innerText()), await rackNamed("RACK-01").locator('[data-region="rack-links-out"]').innerText());
}

// ------------------------------------------------------------- the lit cable follows the choice; a cable coloured from the bar

{
  await page.locator(".cv-seg button", { hasText: "Front" }).click();
  await page.waitForTimeout(300);
  const c1 = rackNamed("RACK-01").locator('[data-region="rack-patch"] .cv-rack-patch-cable[data-edge="c1"]');
  await c1.dispatchEvent("click");
  await page.waitForTimeout(200);
  check("a selected cable glows in its own colour, a little wider than the rest", (await c1.getAttribute("class")).includes("is-lit") && (await c1.evaluate((g) => g.style.color)) !== "" && Math.abs(parseFloat(await c1.locator("path").evaluate((p) => getComputedStyle(p).strokeWidth)) - 2.2) < 0.2, await c1.locator("path").evaluate((p) => getComputedStyle(p).strokeWidth));
  check("and a bar names its two ends", /ACC-SW-1 Gi1\/0\/47 ↔ ACC-SW-2 Gi1\/0\/48/.test(await page.locator('[data-region="cable-bar"]').innerText()), await page.locator('[data-region="cable-bar"]').innerText().catch(() => "no bar"));
  await page.locator('[data-region="cable-colour"] button[aria-label="Cable colour #e4564a"]').click();
  await page.waitForTimeout(300);
  const e = await st(() => window.__cvStore.getState().doc.pages[0].edges.find((x) => x.id === "c1").data);
  check("a swatch gives the link a colour of its own, on the diagram too", e.color === "#e4564a" && e.colorMode === "fixed" && (await c1.locator("path").getAttribute("stroke")) === "#e4564a", JSON.stringify({ color: e.color, mode: e.colorMode, stroke: await c1.locator("path").getAttribute("stroke") }));
  await page.locator('[data-region="cable-colour"] button.is-none').click();
  await page.waitForTimeout(300);
  check("and × puts it back to its cable type's colour", (await st(() => window.__cvStore.getState().doc.pages[0].edges.find((x) => x.id === "c1").data.colorMode)) !== "fixed" && (await c1.locator("path").getAttribute("stroke")) === "#5ea1ff", await c1.locator("path").getAttribute("stroke"));
  await item("fw").dispatchEvent("click");
  await page.waitForTimeout(200);
  check("choosing another box drops the selected link, so its cable is no longer lit", !(await c1.getAttribute("class")).includes("is-lit") && (await st(() => window.__cvStore.getState().selectedEdgeId)) === null && (await page.locator('[data-region="cable-bar"]').count()) === 0, await c1.getAttribute("class"));
}

// ------------------------------------------------------------- a rack duplicated

{
  const before = (await racks()).length;
  await page.locator('button[aria-label="Duplicate rack RACK-02"]').click();
  await page.waitForTimeout(300);
  const all = await racks();
  const copy = all.find((r) => r.name === "RACK-02 copy");
  const original = all.find((r) => r.id === "r2");
  check("⧉ makes a copy of the rack beside it: its size, place and furniture with new ids", all.length === before + 1 && !!copy && copy.units === original.units && copy.room === original.room && (copy.items ?? []).length === (original.items ?? []).length && (copy.items ?? []).every((f) => !(original.items ?? []).some((g) => g.id === f.id)), JSON.stringify({ before, after: all.length, copy: copy && { name: copy.name, position: copy.position, items: (copy.items ?? []).length } }));
  check("and says so", /Added RACK-02 copy, a copy/.test(await message()), await message());
  check("the stage draws it", (await rackNamed("RACK-02 copy").count()) === 1);
  check("Print is offered for one rack per page", (await page.locator(".cv-racks button", { hasText: /^Print$/ }).count()) === 1);
}

// ------------------------------------------------------------- removing a rack asks first

{
  await st(() => window.__cvStore.getState().addRack("TMP-RACK", 12));
  await page.waitForTimeout(300);
  const before = (await racks()).length;
  let asked = "";
  page.once("dialog", (d) => { asked = d.message(); void d.dismiss(); });
  await page.locator('button[aria-label="Remove rack TMP-RACK"]').click();
  await page.waitForTimeout(300);
  check("the × asks before removing a rack, naming it and what it holds", /Remove rack TMP-RACK\? It holds 0 boxes and 0 items/.test(asked) && (await racks()).length === before, asked);
  page.once("dialog", (d) => void d.accept());
  await page.locator('button[aria-label="Remove rack TMP-RACK"]').click();
  await page.waitForTimeout(300);
  check("and removes it when told yes", (await racks()).length === before - 1 && !(await racks()).some((r) => r.name === "TMP-RACK"));
}

await browser.close();
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall rack-room checks passed");
