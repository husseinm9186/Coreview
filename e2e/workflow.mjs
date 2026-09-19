// UX and workflow, driven through the real app (Phase 4): the command palette
// and project search (LT-230, LT-231), the canvas filter (LT-232) and focus
// (LT-233), and the device inspector's neighbours and attachments (LT-234), a link's ports (LT-235) bulk editing
// devices and links (LT-236) sticky notes in Markdown (LT-237) freehand ink (LT-238) comments (LT-239) keyboard navigation (LT-240)
// and a name for every control and every device and link (LT-241).
// Invented names, documentation addresses (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/workflow.mjs
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
  data: { label, deviceType: type, tags: [], locked: false, maintenance: false, showDetails: true, addresses: [], ...extra },
});
const link = (id, source, target, extra = {}) => ({
  id, source, target, type: "live",
  data: { sourcePortLabel: "", targetPortLabel: "", label: "", enabled: true, maintenance: false, healthRule: { type: "manual", manualStatus: "unknown" }, ...extra },
});
const canvas = { gridEnabled: true, snapEnabled: true, minimap: false, nodeStyle: "glyph" };
export const project = {
  meta: { id: "workflow", name: "Workflow", createdAt: NOW, updatedAt: NOW },
  documentVersion: 1,
  document: {
    activePageId: "p1", probes: [],
    pages: [
      { id: "p1", name: "Core", canvas, nodes: [
          dev("fw", "EDGE-FW", 200, 0, "firewall", { addresses: [{ id: "a1", label: "Management", address: "192.0.2.1", isPrimary: true }], vendor: "Acme", role: "Firewall", tags: ["dmz"] }),
          dev("core", "CORE-SW1", 200, 200, "core-switch", { addresses: [{ id: "a2", label: "Management", address: "192.0.2.10", isPrimary: true }], vendor: "Acme", role: "Core", vlan: "10",
            inventory: { collectedAt: 1, ports: [{ port: "Gi1/0/2", status: "connected", speed: "a-1000", duplex: "a-full", mode: "trunk", vlan: 1, trunkVlans: "1,10-12",
              errors: { input: 1532, crc: 1498, output: 0, collisions: 0, resets: 1, drops: 40 } }], vlans: [], routes: [], spanningTree: [] } }),
          dev("acc1", "ACC-SW1", 0, 400, "access-switch", { addresses: [{ id: "a3", label: "Management", address: "192.0.2.21", isPrimary: true }], vendor: "Other", role: "Access", tags: ["floor-1"] }),
          dev("acc2", "ACC-SW2", 400, 400, "access-switch", { addresses: [{ id: "a4", label: "Management", address: "198.51.100.22", isPrimary: true }], vendor: "Other", role: "Access" }),
          dev("host", "DESK-12", 0, 600, "endpoint", { mac: "00:00:5e:00:53:01", notes: "Reception desk" }),
          { id: "note1", type: "note", position: { x: 600, y: 0 }, width: 200, height: 120, data: { title: "Change window", body: "Saturday 22:00", locked: false } },
        ],
        edges: [link("e1", "fw", "core", { sourcePortLabel: "port1", targetPortLabel: "Gi1/0/1" }), link("e2", "core", "acc1", { sourcePortLabel: "Gi1/0/2", targetPortLabel: "Gi0/1" }),
          link("e3", "core", "acc2"), link("e4", "acc1", "host", { sourcePortLabel: "Gi0/12" })] },
      { id: "p2", name: "Branch", canvas, nodes: [dev("br", "BRANCH-RTR", 0, 0, "router", { addresses: [{ id: "b1", label: "Management", address: "203.0.113.5", isPrimary: true }] })], edges: [] },
    ],
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript(({ p }) => {
  let next = 1;
  window.__calls = [];
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return next++; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      window.__calls.push({ cmd, args });
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "", engineer: "",
        description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({});
      if (cmd === "describe_subnet") return Promise.resolve({ network: "192.0.2.0", broadcast: "192.0.2.255", prefix: 24, hosts: 254 });
      return Promise.resolve([]);
    },
  };
}, { p: project });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(800);

const st = (fn, arg) => page.evaluate(fn, arg);
const blur = () => page.evaluate(() => document.activeElement?.blur());
const activePage = () => st(() => window.__cvStore.getState().doc.activePageId);
const selected = () => st(() => { const s = window.__cvStore.getState(); return s.doc.pages.find((p) => p.id === s.doc.activePageId).nodes.filter((n) => n.selected).map((n) => n.id); });

// --------------------------------------------------- LT-230, LT-231 palette
await blur();
await page.keyboard.press("Control+k");
await page.waitForTimeout(200);
const palette = page.locator(".cv-command-palette");
check("Ctrl+K opens the command palette", (await palette.count()) === 1);
await page.keyboard.type("5e0053");
await page.waitForTimeout(150);
const firstRow = palette.locator("li").first();
check("it finds a device by its MAC without the punctuation", /MAC.*00:00:5e:00:53:01.*DESK-12/.test(await firstRow.textContent()), await firstRow.textContent());
await palette.getByRole("combobox").fill("br rtr");
await page.waitForTimeout(150);
check("and by initials, on another page", /Device.*BRANCH-RTR.*Branch/.test(await palette.locator("li").first().textContent()), await palette.locator("li").first().textContent());
await page.keyboard.press("Enter");
await page.waitForTimeout(500);
check("choosing it goes to that page and selects it", (await activePage()) === "p2" && JSON.stringify(await selected()) === '["br"]', `${await activePage()} ${JSON.stringify(await selected())}`);
check("and closes the palette", (await palette.count()) === 0);

await blur();
await page.keyboard.press("Control+k");
await page.keyboard.type("gi1/0/2");
await page.waitForTimeout(150);
const portRows = await palette.locator("li").allTextContents();
// Read by a crawl and drawn on a link, the port is one result, with the crawl's facts.
check("ports are found by the device and port name, once", JSON.stringify(portRows) === JSON.stringify(["PortCORE-SW1 Gi1/0/2connected · trunk"]), JSON.stringify(portRows));
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Escape");
check("Escape closes it", (await palette.count()) === 0);

await blur();
await page.keyboard.press("Control+k");
await page.keyboard.type(">rack");
await page.waitForTimeout(150);
check("> lists commands", /Command.*Open Racks/.test(await palette.locator("li").first().textContent()), await palette.locator("li").first().textContent());
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
check("and a command runs", (await page.locator(".cv-panel button.is-active", { hasText: /^Racks$/ }).count()) === 1);

await blur();
await page.keyboard.press("Control+k");
await page.keyboard.type("load balancer");
await page.waitForTimeout(150);
const before = await st(() => window.__cvStore.getState().doc.pages.find((p) => p.id === "p2").nodes.length);
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
check("a shape found in the palette is added to the page", await st((n) => window.__cvStore.getState().doc.pages.find((p) => p.id === "p2").nodes.length === n + 1, before));

// -------------------------------------------------------- LT-232 filter
await st(() => window.__cvStore.getState().setActivePage("p1"));
await page.waitForTimeout(400);
const dimmed = () => page.locator(".react-flow__node.is-dimmed").evaluateAll((els) => els.map((e) => e.dataset.id).sort());
const filterMenu = page.locator(".cv-filter-menu");
await filterMenu.locator("summary").click();
await page.waitForTimeout(200);
const roleOptions = await filterMenu.locator("label", { hasText: /^Role/ }).locator("option").allTextContents();
check("the filter offers the roles the page has", roleOptions.join("|") === "Any|Access|Core|Firewall", roleOptions.join("|"));
await filterMenu.locator("label", { hasText: /^Role/ }).locator("select").selectOption("Access");
await page.waitForTimeout(300);
check("filtering by role dims everything else", JSON.stringify(await dimmed()) === JSON.stringify(["core", "fw", "host", "note1"]), JSON.stringify(await dimmed()));
check("and says what is lit", /Filtered · 2 of 6 lit/.test(await page.locator(".cv-dim-chip").textContent()), await page.locator(".cv-dim-chip").textContent());
check("links to dimmed devices are dimmed too", (await page.locator('.react-flow__edge.is-dimmed').count()) === 4);
await filterMenu.locator("label", { hasText: /^Role/ }).locator("select").selectOption("");
await filterMenu.locator("label", { hasText: /^Subnet/ }).locator("input").fill("192.0.2.0/24");
await page.waitForTimeout(300);
check("a subnet filter keeps devices with an address inside it", JSON.stringify(await dimmed()) === JSON.stringify(["acc2", "host", "note1"]), JSON.stringify(await dimmed()));
await filterMenu.locator("button", { hasText: "Clear the filter" }).click();
await page.waitForTimeout(300);
check("clearing it lights everything", (await dimmed()).length === 0 && (await page.locator(".cv-dim-chip").count()) === 0);
await filterMenu.locator("summary").click();

// ---------------------------------------------------------- LT-233 focus
await page.locator("button", { hasText: "Fit view" }).first().click().catch(() => {});
await page.waitForTimeout(400);
const coreBox = await page.locator('.react-flow__node[data-id="core"]').boundingBox();
await page.mouse.click(coreBox.x + coreBox.width / 2, coreBox.y + coreBox.height / 2, { button: "right" });
await page.waitForTimeout(250);
await page.locator(".cv-menu button", { hasText: "Focus on this — 1 link out" }).click();
await page.waitForTimeout(300);
check("focusing on a device lights it and its neighbours one link out", JSON.stringify(await dimmed()) === JSON.stringify(["host", "note1"]), JSON.stringify(await dimmed()));
check("and says so", /Focused on CORE-SW1, 1 link out/.test(await page.locator(".cv-dim-chip").textContent()));
await blur();
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("Escape leaves focus", (await dimmed()).length === 0);

// ------------------------------------------------ LT-234 device inspector
await st(() => {
  const s = window.__cvStore.getState();
  s.onNodesChange(s.doc.pages[0].nodes.map((n) => ({ type: "select", id: n.id, selected: n.id === "core" })));
  s.select("core", null);
});
await page.waitForTimeout(300);
const neighbours = page.locator(".cv-inspector section[aria-label=Neighbours] tbody tr");
const nRows = await neighbours.evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td")].slice(0, 3).map((td) => td.textContent).join("|")));
check("a device lists what it is linked to, port by port", JSON.stringify(nRows) === JSON.stringify(["Gi1/0/1|EDGE-FW|port1", "Gi1/0/2|ACC-SW1|Gi0/1", "—|ACC-SW2|—"]), JSON.stringify(nRows));
const attach = page.locator(".cv-inspector section[aria-label=Attachments]");
await attach.getByLabel("Attachment path").fill("/srv/site-docs/core-rack.pdf");
await attach.locator("button", { hasText: /^Add$/ }).click();
await page.waitForTimeout(200);
check("a file can be attached by its path, named from the file", await st(() => {
  const a = window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === "core").data.attachments;
  return a?.length === 1 && a[0].label === "core-rack.pdf" && a[0].path === "/srv/site-docs/core-rack.pdf";
}));
await attach.locator("button", { hasText: /^Show in folder$/ }).click();
await page.waitForTimeout(200);
const opened = await st(() => window.__calls.filter((c) => c.cmd === "open_attachment").at(-1)?.args);
check("and shown in its folder through the app", JSON.stringify(opened) === JSON.stringify({ path: "/srv/site-docs/core-rack.pdf", reveal: true }), JSON.stringify(opened));

// ------------------------------------------------------------ LT-235 ports
await st(() => {
  const s = window.__cvStore.getState();
  s.onNodesChange(s.doc.pages[0].nodes.map((n) => ({ type: "select", id: n.id, selected: false })));
  s.select(null, "e2");
});
await page.waitForTimeout(300);
const ports = page.locator(".cv-inspector .cv-port-view");
const ends = await ports.locator(".cv-port-end").allTextContents();
check("a link shows the port at each end, with what the crawl read", /CORE-SW1 Gi1\/0\/2Plugged intoACC-SW1 Gi0\/1StatusconnectedSpeeda-1000, a-fullVLANtrunk, native 1 \(1,10-12\)Errors1532 in \(1498 CRC\), 0 out, 0 collisions, 40 dropped, 1 resets/.test(ends[0]), ends[0]);
check("errors stand out", (await ports.locator("dd.is-warning").count()) === 1);
check("and says when the far end has not been read", /ACC-SW1 Gi0\/1No crawl has read this port yet\./.test(ends[1]), ends[1]);

// ------------------------------------------------------------ LT-236 bulk
await st(() => {
  const s = window.__cvStore.getState();
  s.onNodesChange(s.doc.pages[0].nodes.map((n) => ({ type: "select", id: n.id, selected: ["acc1", "acc2", "core"].includes(n.id) })));
});
await page.waitForTimeout(300);
const roleBulk = page.getByLabel("Role for every selected device");
check("a mixed selection says its role is mixed", (await roleBulk.getAttribute("placeholder")) === "Mixed" && (await roleBulk.inputValue()) === "");
const pastB = await st(() => window.__cvStore.getState().past.length);
await page.getByLabel("Site for every selected device").fill("HQ");
await page.getByLabel("Site for every selected device").press("Enter");
await page.waitForTimeout(200);
check("typing a site sets it on every selected device, in one undo step", await st((n) => {
  const s = window.__cvStore.getState();
  return ["acc1", "acc2", "core"].every((id) => s.doc.pages[0].nodes.find((x) => x.id === id).data.site === "HQ") &&
    s.doc.pages[0].nodes.find((x) => x.id === "fw").data.site === undefined && s.past.length === n + 1;
}, pastB));

await st(() => {
  const s = window.__cvStore.getState();
  s.onNodesChange(s.doc.pages[0].nodes.map((n) => ({ type: "select", id: n.id, selected: false })));
  s.select(null, null);
  s.onEdgesChange(s.doc.pages[0].edges.map((e) => ({ type: "select", id: e.id, selected: ["e1", "e2", "e3"].includes(e.id) })));
});
await page.waitForTimeout(300);
check("several links selected get their own editor", /3 links selected/.test(await page.locator(".cv-inspector").textContent()));
await page.getByLabel("Cable for every selected link").selectOption("fiber-sm");
await page.getByLabel("Line style for every selected link").selectOption("dashed");
await page.waitForTimeout(200);
check("and a cable and line style set on all of them", await st(() => {
  const edges = window.__cvStore.getState().doc.pages[0].edges;
  return ["e1", "e2", "e3"].every((id) => { const d = edges.find((e) => e.id === id).data; return d.cableType === "fiber-sm" && d.lineStyle === "dashed"; }) &&
    edges.find((e) => e.id === "e4").data.cableType === undefined;
}));

// ----------------------------------------------------------- LT-237 notes
await st(() => {
  const s = window.__cvStore.getState();
  s.onEdgesChange(s.doc.pages[0].edges.map((e) => ({ type: "select", id: e.id, selected: false })));
  s.updateNodeData("note1", { body: "### Order\n1. drain *core*\n2. move ~~Gi0/1~~\n> rollback ready\n---\n- [x] backup `taken`" });
});
await page.waitForTimeout(300);
const noteBody = page.locator('.react-flow__node[data-id="note1"] .cv-note-body');
const shape = await noteBody.evaluate((el) => ({
  h5: el.querySelector("h5")?.textContent, em: el.querySelector("em")?.textContent, s: el.querySelector("s")?.textContent,
  quote: el.querySelector("blockquote")?.textContent, hr: el.querySelectorAll("hr").length, numbers: [...el.querySelectorAll(".cv-note-number")].map((p) => p.textContent),
  code: el.querySelector("code")?.textContent,
}));
check("a note draws headings, numbered steps, italics, strikes, quotes, rules and code", JSON.stringify(shape) === JSON.stringify({
  h5: "Order", em: "core", s: "Gi0/1", quote: "rollback ready", hr: 1, numbers: ["1. drain core", "2. move Gi0/1"], code: "taken",
}), JSON.stringify(shape));
await st(() => window.__cvStore.getState().setPanelOpen(false));
await page.waitForTimeout(300);
// A spot where the bare canvas is on top — not a device, the minimap or a panel.
const spot = await page.evaluate(() => {
  const pane = document.querySelector(".react-flow__pane").getBoundingClientRect();
  for (let y = pane.top + 40; y < pane.bottom - 40; y += 30) {
    for (let x = pane.left + 40; x < pane.right - 40; x += 30) {
      if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
    }
  }
  return null;
});
await page.mouse.click(spot.x, spot.y, { button: "right" });
await page.waitForTimeout(250);
await page.locator(".cv-menu button", { hasText: "Add sticky note" }).click();
await page.waitForTimeout(300);
check("a sticky note can be added", await st(() => window.__cvStore.getState().doc.pages[0].nodes.some((n) => n.type === "note" && n.data.variant === "sticky")) &&
  (await page.locator(".cv-note.is-sticky").count()) === 1);

// ------------------------------------------------------------- LT-238 ink
await blur();
await page.keyboard.press("Escape");
const ink = () => st(() => window.__cvStore.getState().doc.pages[0].canvas.ink ?? []);
await page.locator(".cv-ink-bar button", { hasText: "Pen" }).click();
await page.locator(".cv-ink-bar").getByLabel("Blue ink").click();
const sheet = await page.locator(".cv-ink-sheet").boundingBox();
const [sx, sy] = [sheet.x + sheet.width * 0.3, sheet.y + sheet.height * 0.35];
await page.mouse.move(sx, sy);
await page.mouse.down();
for (let i = 1; i <= 20; i++) await page.mouse.move(sx + i * 8, sy + Math.sin(i / 3) * 20);
await page.mouse.up();
await page.waitForTimeout(250);
const strokes = await ink();
check("the pen draws a stroke that is kept on the page", strokes.length === 1 && strokes[0].color === "#4ea8f0" && strokes[0].points.length >= 6 && strokes[0].points.length < 42,
  JSON.stringify(strokes.map((s) => [s.color, s.points.length])));
check("and drawn on the canvas", (await page.locator("svg.cv-ink path[data-stroke]").count()) === 1);
await page.locator(".cv-ink-bar button", { hasText: "Hide ink" }).click();
await page.waitForTimeout(200);
check("hiding ink takes it off the canvas and keeps it", (await page.locator("svg.cv-ink path[data-stroke]").count()) === 0 && (await ink()).length === 1);
await page.locator(".cv-ink-bar button", { hasText: /^Show ink/ }).click();
await page.locator(".cv-ink-bar button", { hasText: "Eraser" }).click();
const box = await page.locator("svg.cv-ink path[data-stroke]").boundingBox();
await page.mouse.click(sx, sy);
await page.waitForTimeout(250);
check("the eraser removes a stroke it touches", (await ink()).length === 0, `${JSON.stringify(box)}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
check("Escape puts the tool down", (await page.locator(".cv-ink-sheet").count()) === 0);

// -------------------------------------------------------- LT-239 comments
await st(() => {
  const s = window.__cvStore.getState();
  s.onNodesChange(s.doc.pages[0].nodes.map((n) => ({ type: "select", id: n.id, selected: n.id === "acc2" })));
  s.select("acc2", null);
});
await page.waitForTimeout(300);
const comments = page.locator(".cv-inspector section[aria-label=Comments]");
await comments.getByLabel("Your name").fill("Sam");
await comments.getByLabel("New comment").fill("Is the uplink fibre?");
await comments.locator("button", { hasText: /^Comment$/ }).click();
await page.waitForTimeout(200);
await comments.getByLabel("Reply").fill("Yes, single-mode");
await comments.getByLabel("Reply").press("Enter");
await page.waitForTimeout(200);
const thread = await st(() => window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === "acc2").data.comments);
check("a comment and a reply are kept on the device", thread?.length === 1 && thread[0].author === "Sam" && thread[0].text === "Is the uplink fibre?" &&
  thread[0].replies[0].text === "Yes, single-mode" && thread[0].replies[0].author === "Sam", JSON.stringify(thread));
check("the device shows it has an open comment", (await page.locator('.react-flow__node[data-id="acc2"] .cv-comment-badge').textContent())?.includes("1"));
await comments.locator("button", { hasText: /^Resolve$/ }).click();
await page.waitForTimeout(200);
check("resolving clears the badge but keeps the thread", (await page.locator('.react-flow__node[data-id="acc2"] .cv-comment-badge').count()) === 0 &&
  await st(() => window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === "acc2").data.comments[0].resolved === true));
check("and the name is remembered for next time", await page.evaluate(() => localStorage.getItem("coreview.commentAuthor")) === "Sam");

// ------------------------------------------------------- LT-240 keyboard
await st(() => {
  const s = window.__cvStore.getState();
  s.setPanelOpen(true);
  s.onNodesChange(s.doc.pages[0].nodes.map((n) => ({ type: "select", id: n.id, selected: n.id === "fw" })));
  s.select("fw", null);
});
await blur();
await page.keyboard.press("Alt+ArrowDown");
await page.waitForTimeout(200);
check("Alt+Down selects the device below", JSON.stringify(await selected()) === '["core"]', JSON.stringify(await selected()));
check("and says so for a screen reader", /CORE-SW1 selected/.test(await page.locator(".cv-panel-message[role=status]").textContent()));
await st(() => {
  const s = window.__cvStore.getState();
  s.onNodesChange(s.doc.pages[0].nodes.map((n) => ({ type: "select", id: n.id, selected: n.id === "acc1" })));
});
await page.keyboard.press("Alt+ArrowRight");
await page.waitForTimeout(200);
check("Alt+Right selects the device to the right on the same row", JSON.stringify(await selected()) === '["acc2"]', JSON.stringify(await selected()));
const pos = await st(() => window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === "acc2").position);
check("and moves nothing", pos.x === 400 && pos.y === 400, JSON.stringify(pos));

await blur();
await page.keyboard.press("F6");
const region1 = await page.evaluate(() => ["cv-topbar", "cv-palette", "react-flow", "cv-inspector", "cv-panel"].find((c) => document.activeElement?.closest(`.${c}`)));
await page.keyboard.press("F6");
const region2 = await page.evaluate(() => ["cv-topbar", "cv-palette", "react-flow", "cv-inspector", "cv-panel"].find((c) => document.activeElement?.closest(`.${c}`)));
check("F6 moves focus from one part of the window to the next", region1 === "cv-topbar" && region2 === "cv-palette", `${region1} → ${region2}`);
await page.keyboard.press("Shift+F6");
const region3 = await page.evaluate(() => ["cv-topbar", "cv-palette", "react-flow", "cv-inspector", "cv-panel"].find((c) => document.activeElement?.closest(`.${c}`)));
check("and Shift+F6 back", region3 === "cv-topbar", region3);

const activeTab = page.locator(".cv-tabs [role=tab][aria-selected=true]");
const tabBefore = await activeTab.textContent();
await activeTab.focus();
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(200);
const after = await page.locator(".cv-tabs [role=tab][aria-selected=true]").textContent();
check("arrow keys move along the panel's tabs", tabBefore !== after && (await page.evaluate(() => document.activeElement?.getAttribute("aria-selected"))) === "true", `${tabBefore} → ${after}`);

// ----------------------------------------------------- LT-242 high contrast
await page.locator("label", { hasText: /^High contrast$/ }).locator("input").check();
await page.waitForTimeout(200);
const contrast = await page.evaluate(() => {
  const app = document.querySelector(".cv-workspace");
  const css = getComputedStyle(app);
  return { on: app.classList.contains("is-contrast"), text: css.getPropertyValue("--text").trim(), ink: css.getPropertyValue("--ink").trim(), kept: localStorage.getItem("coreview.view.highContrast") };
});
check("high contrast can be turned on, for the chrome and the canvas, and is remembered",
  contrast.on && contrast.text === "#ffffff" && contrast.ink === "#ffffff" && contrast.kept === "1", JSON.stringify(contrast));
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
await page.locator("label", { hasText: /^High contrast$/ }).locator("input").uncheck();

// -------------------------------------------------- LT-241 accessible names
const devLabel = await page.locator('.react-flow__node[data-id="core"]').getAttribute("aria-label");
check("a device has a spoken name: what it is, its name, role and address", devLabel === "Core switch CORE-SW1, Core, 192.0.2.10", devLabel);
const linkLabel = await page.locator('.react-flow__edge[data-id="e1"]').getAttribute("aria-label");
check("a link has one: what it joins, on which ports", linkLabel === "Link from EDGE-FW port1 to CORE-SW1 Gi1/0/1", linkLabel);
const audit = async (where) => page.evaluate((where) => {
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label") || (el.getAttribute("aria-labelledby") && document.getElementById(el.getAttribute("aria-labelledby"))?.textContent);
    if (aria?.trim()) return aria.trim();
    if (el.id) { const l = document.querySelector(`label[for="${el.id}"]`); if (l?.textContent.trim()) return l.textContent.trim(); }
    const wrap = el.closest("label");
    if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
    if (el.tagName === "BUTTON" || el.getAttribute("role") === "button") {
      const clone = el.cloneNode(true);
      clone.querySelectorAll("[aria-hidden=true]").forEach((x) => x.remove());
      const t = clone.textContent.trim();
      if (t && /[\p{L}\p{N}]{2,}/u.test(t)) return t;
    }
    if (el.getAttribute("title")?.trim()) return el.getAttribute("title").trim();
    return "";
  };
  const out = [];
  for (const el of document.querySelectorAll("button, input:not([type=hidden]), select, textarea, [role=button]")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (!nameOf(el)) out.push(`${where}: <${el.tagName.toLowerCase()} class="${el.className}"> ${el.outerHTML.slice(0, 140)}`);
  }
  return out;
}, where);
const all = [];
all.push(...await audit("workspace"));
await page.evaluate(() => { const s = window.__cvStore.getState(); s.onNodesChange(s.doc.pages[0].nodes.map((n) => ({ type: "select", id: n.id, selected: false }))); s.onEdgesChange(s.doc.pages[0].edges.map((e) => ({ type: "select", id: e.id, selected: false }))); s.select("core", null); });
await page.waitForTimeout(400);
all.push(...await audit("device inspector"));
await page.evaluate(() => { const s = window.__cvStore.getState(); s.select(null, "e1"); });
await page.waitForTimeout(400);
all.push(...await audit("link inspector"));
for (const tab of ["Monitored objects", "Event timeline", "Ping sweep", "Discover devices", "Backups", "From a file", "From a drawing", "Racks", "Path check", "Compare"]) {
  await page.locator(".cv-tabs button", { hasText: tab }).first().click().catch(() => {});
  await page.waitForTimeout(300);
  all.push(...await audit(tab));
}
check("every visible control has an accessible name, in every panel", all.length === 0, JSON.stringify([...new Set(all)].slice(0, 5)));

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
