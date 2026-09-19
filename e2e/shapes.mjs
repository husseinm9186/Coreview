// The built-in shapes and what they bring, driven through the real app
// (LT-163–165, LT-171).
//
// A class shape dropped from the palette arrives with generic ports, a rack
// height and an empty management address; a link's port label then offers the
// port names of the device at each end. Invented names only (D-027); no vendor
// naming anywhere (D-028).
//
//     npm run dev            # in another terminal
//     node e2e/shapes.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const device = (id, label, x, y, over = {}) => ({
  id, type: "device", position: { x, y }, width: 76, height: 76,
  data: { label, deviceType: "l2-switch", tags: [], addresses: [], locked: false, maintenance: false,
    showDetails: true, ...over },
});

const project = {
  meta: { id: "shapes", name: "Shapes", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    nodes: [
      device("sw", "LAB-SW", 0, 0, { portCount: 3, portNaming: "Port {n}" }),
      device("pp", "LAB-PANEL", 0, 300, { deviceType: "patch-panel", portCount: 2, portNaming: "{n}" }),
    ],
    edges: [{
      id: "e1", source: "sw", target: "pp", sourceHandle: "b", targetHandle: "t", type: "live",
      data: { sourcePortLabel: "", targetPortLabel: "", label: "", pathType: "smoothstep", direction: "forward",
        width: 2, color: "#2fbf6b", enabled: true, maintenance: false, healthRule: { type: "manual", manualStatus: "healthy" } },
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
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      // Exports: the save dialog answers with a path, and what would be
      // written is kept for the checks to read (LT-170).
      if (cmd === "plugin:dialog|save") return Promise.resolve("/tmp/coreview-shapes-test.svg");
      if (cmd === "save_export") {
        const bytes = Uint8Array.from(atob(args.contentsB64), (c) => c.charCodeAt(0));
        (window.__exports ??= []).push({ path: args.path, text: new TextDecoder().decode(bytes) });
        return Promise.resolve(null);
      }
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
await page.waitForTimeout(1000);
if (await page.locator(".cv-recovery").count()) {
  await page.locator(".cv-recovery button", { hasText: "Keep what was saved" }).click();
  await page.waitForTimeout(300);
}

const nodes = () => page.evaluate(() => {
  const d = window.__cvStore.getState().doc;
  return (d.pages ? Object.values(d.pages).flatMap((pg) => pg.nodes ?? []) : d.nodes ?? [])
    .map((n) => ({ id: n.id, ...n.data }));
});

// ------------------------------------------------------------- the palette
for (const [label, type] of [["L3 switch", "l3-switch"], ["Load balancer", "load-balancer"],
  ["Web application firewall", "waf"], ["MPLS cloud", "mpls-cloud"], ["Patch panel", "patch-panel"],
  ["PDU", "pdu"], ["UPS", "ups"], ["VM host", "vm-host"], ["Blade chassis", "blade-chassis"], ["IP phone", "ip-phone"],
  ["Rack", "rack"], ["L2 switch", "l2-switch"]]) {
  const item = page.locator(".cv-palette-item", { hasText: new RegExp(`^\\s*${label}\\s*$`) });
  check(`the palette offers ${label}`, (await item.count()) === 1, `${await item.count()} match(es)`);
}

const before = (await nodes()).length;
await page.locator(".cv-palette-item", { hasText: /^\s*L2 switch\s*$/ }).dragTo(page.locator(".react-flow__pane"), {
  targetPosition: { x: 700, y: 200 },
});
await page.waitForTimeout(500);
const after = await nodes();
const dropped = after.find((n) => !["sw", "pp"].includes(n.id));
check("dragging L2 switch from the palette adds one device", after.length === before + 1, `${before} -> ${after.length}`);
check("of the L2 switch class", dropped?.deviceType === "l2-switch", JSON.stringify(dropped?.deviceType));
check("with 24 ports named by number", dropped?.portCount === 24 && dropped?.portNaming === "Port {n}",
  JSON.stringify({ c: dropped?.portCount, n: dropped?.portNaming }));
check("one rack unit high", dropped?.rackUnits === 1, JSON.stringify(dropped?.rackUnits));
check("and an empty management address to fill in",
  dropped?.addresses?.length === 1 && dropped.addresses[0].label === "Management" && dropped.addresses[0].address === "",
  JSON.stringify(dropped?.addresses));
check("its glyph is drawn", (await page.locator(`.react-flow__node[data-id="${dropped?.id}"] svg`).count()) > 0);

// ------------------------------------------------------------- the inspector
await page.evaluate((id) => window.__cvStore.getState().select(id, null), dropped?.id);
await page.waitForTimeout(300);
const field = (label) => page.locator(".cv-inspector label", { hasText: new RegExp(`^${label}`) }).locator("input").first();
check("the inspector shows its ports", (await field("Ports").inputValue()) === "24");
check("and its rack units", (await field("Rack units").inputValue()) === "1");
await field("Ports").fill("8");
await page.waitForTimeout(200);
check("and the ports can be changed", (await nodes()).find((n) => n.id === dropped?.id)?.portCount === 8);

// ------------------------------------------------------------- port names on a link
await page.evaluate(() => window.__cvStore.getState().select(null, "e1"));
await page.waitForTimeout(300);
const offered = (which) => page.evaluate((w) => {
  const input = [...document.querySelectorAll(".cv-inspector label")]
    .find((l) => l.textContent.startsWith(w))?.querySelector("input");
  const list = input?.list;
  return list ? [...list.options].map((o) => o.value) : null;
}, which);
const s = await offered("Source port label");
const t = await offered("Target port label");
check("a link's source port label offers the switch's ports", JSON.stringify(s) === JSON.stringify(["Port 1", "Port 2", "Port 3"]),
  JSON.stringify(s));
check("and its target the patch panel's", JSON.stringify(t) === JSON.stringify(["1", "2"]), JSON.stringify(t));

// ------------------------------------------------------------- cable type (LT-167)
const cable = page.locator(".cv-inspector label", { hasText: /^Cable/ }).locator("select");
check("the link inspector offers a cable type", (await cable.count()) === 1);
check("no tag while none is set", (await page.locator(".cv-cable-tag").count()) === 0);
await cable.selectOption("fiber-sm");
await page.waitForTimeout(300);
const edgeData = await page.evaluate(() => {
  const d = window.__cvStore.getState().doc;
  const edges = d.pages ? Object.values(d.pages).flatMap((pg) => pg.edges ?? []) : d.edges ?? [];
  return edges.find((e) => e.id === "e1")?.data;
});
check("choosing single-mode fibre records it on the link", edgeData?.cableType === "fiber-sm", JSON.stringify(edgeData?.cableType));
const tags = await page.locator(".cv-cable-tag").allTextContents();
check("and the link, with no label of its own, shows an SMF tag", JSON.stringify(tags) === JSON.stringify(["SMF"]),
  JSON.stringify(tags));

// ------------------------------------------------------------- a described stencil (LT-169)
// The folder scan is Rust; the harness stages its answer the way the app does
// once it arrives — one icon a manifest described.
await page.evaluate(() => window.__cvStore.getState().select(null, null));
await page.evaluate(() => window.__cvStore.setState({
  iconLibraryDir: "/tmp/lab-shapes",
  iconLibrary: [{
    id: "lab-lb", name: "Lab LB", category: "Lab",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>',
    meta: { class: "load-balancer", vendor: "Example Networks", model: "LB-2", ports: 4, portNaming: "eth{n}",
      rackUnits: 2, licence: "Drawn by the lab team" },
  }],
}));
await page.waitForTimeout(300);
const libItem = page.locator(".cv-palette-item", { hasText: /^\s*Lab LB\s*$/ });
check("a described stencil is offered in the palette", (await libItem.count()) === 1, `${await libItem.count()}`);
if ((await libItem.count()) === 1) {
  const had = new Set((await nodes()).map((n) => n.id));
  await libItem.dragTo(page.locator(".react-flow__pane"), { targetPosition: { x: 900, y: 420 } });
  await page.waitForTimeout(500);
  const lb = (await nodes()).find((n) => !had.has(n.id));
  check("dropping it makes a device of the class its manifest names", lb?.deviceType === "load-balancer",
    JSON.stringify(lb?.deviceType));
  check("with the manifest's vendor, model, ports and rack units",
    lb?.vendor === "Example Networks" && lb?.model === "LB-2" && lb?.portCount === 4 && lb?.portNaming === "eth{n}" &&
      lb?.rackUnits === 2, JSON.stringify(lb));
  check("drawn with its own artwork, and carrying the licence statement",
    /^data:image\/svg\+xml/.test(lb?.imageDataUrl ?? "") && lb?.stencilLicence === "Drawn by the lab team");
}

// ------------------------------------------------------------- logical boundaries (LT-166)
await page.evaluate(() => window.__cvStore.getState().select(null, null));
const kindsOffered = await page.locator(".cv-palette-group", { has: page.locator("h3", { hasText: "Logical boundaries" }) })
  .locator(".cv-palette-item").allInnerTexts();
check("the palette offers the six logical boundaries",
  JSON.stringify(kindsOffered.map((t) => t.trim())) ===
    JSON.stringify(["VLAN boundary", "Subnet", "Security zone", "VRF", "BGP AS", "OSPF area"]), JSON.stringify(kindsOffered));
const hadB = new Set((await nodes()).map((n) => n.id));
// Somewhere empty inside the pane, whatever the panels beside it leave: near
// its top-right corner, clear of the minimap and controls at the bottom.
const paneBox = await page.locator(".react-flow__pane").boundingBox();
await page.locator(".cv-palette-item", { hasText: /^\s*VLAN boundary\s*$/ }).dragTo(page.locator(".react-flow__pane"), {
  targetPosition: { x: Math.round(paneBox.width - 120), y: 40 },
});
await page.waitForTimeout(500);
const zone = (await nodes()).find((n) => !hadB.has(n.id));
check("dropping one makes a section of that kind", zone?.deviceType === "zone" && zone?.boundaryKind === "vlan",
  JSON.stringify({ t: zone?.deviceType, k: zone?.boundaryKind }));
await page.evaluate((id) => window.__cvStore.getState().select(id, null), zone?.id);
await page.waitForTimeout(300);
const ident = page.locator(".cv-inspector label", { hasText: /^Identifier/ }).locator("input");
check("the inspector asks for its identifier", (await ident.count()) === 1);
await ident.fill("20");
await page.waitForTimeout(300);
const chip = page.locator(`.react-flow__node[data-id="${zone?.id}"] .cv-boundary-chip`);
check("the section shows a VLAN 20 chip", (await chip.count()) === 1 && (await chip.innerText()) === "VLAN 20",
  (await chip.count()) ? await chip.innerText() : "no chip");
check("drawn with its kind's dashed outline",
  (await page.locator(`.react-flow__node[data-id="${zone?.id}"] .cv-boundary-outline rect`).count()) === 1);
await ident.fill("5000");
await page.waitForTimeout(300);
check("an out-of-range VLAN is flagged on the chip", /is-invalid/.test((await chip.getAttribute("class")) ?? ""));
// textContent, not innerText: the hint is uppercased by CSS for display.
const hint = await page.locator(".cv-inspector label", { hasText: /^Identifier/ }).textContent();
check("and the inspector says why", /1 to 4094/.test(hint), JSON.stringify(hint));
await ident.fill("20");
await page.evaluate(() => window.__cvStore.getState().select(null, null));
await page.waitForTimeout(300);
await page.screenshot({ path: process.env.SHOT ?? "/tmp/coreview-shapes.png" });

// ------------------------------------------------------------- solid glyphs (LT-168)
await page.evaluate(() => window.__cvStore.getState().select(null, null));
const solidCount = () => page.locator(".react-flow__node svg[data-solid]").count();
check("devices are drawn as outlines by default", (await solidCount()) === 0);
// A point where the pane itself is on top — not a device, a section, the
// minimap or the controls — found by asking the page rather than guessing.
const bare = await page.evaluate(() => {
  const r = document.querySelector(".react-flow__pane").getBoundingClientRect();
  for (let y = r.top + 30; y < r.bottom - 30; y += 25) {
    for (let x = r.left + 30; x < r.right - 30; x += 25) {
      if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
    }
  }
  return null;
});
check("the pane has a bare spot to open its menu on", bare !== null);
await page.mouse.click(bare.x, bare.y, { button: "right" });
await page.waitForTimeout(300);
const solidItem = page.getByText("Draw devices as solid tiles", { exact: true });
check("the canvas menu offers solid tiles", (await solidItem.count()) === 1);
if (await solidItem.count()) {
  await solidItem.click();
  await page.waitForTimeout(400);
  const glyphDevices = await page.evaluate(() => {
    const d = window.__cvStore.getState().doc;
    const ns = d.pages ? Object.values(d.pages).flatMap((pg) => pg.nodes ?? []) : d.nodes ?? [];
    return ns.filter((n) => n.type === "device" && n.data.deviceType !== "zone" && !n.data.imageDataUrl).map((n) => n.id);
  });
  check("every built-in device glyph on the page turns solid", (await solidCount()) === glyphDevices.length && glyphDevices.length > 0,
    `${await solidCount()} solid of ${glyphDevices.length}`);
  await page.evaluate((id) => window.__cvStore.getState().select(id, null), glyphDevices[0]);
  await page.waitForTimeout(300);
  await page.locator(".cv-inspector label", { hasText: /^Glyph/ }).locator("select").selectOption("outline");
  await page.waitForTimeout(300);
  check("one device can stay an outline on a solid page",
    (await page.locator(`.react-flow__node[data-id="${glyphDevices[0]}"] svg[data-solid]`).count()) === 0 &&
      (await solidCount()) === glyphDevices.length - 1, `${await solidCount()}`);
  await page.evaluate(() => window.__cvStore.getState().select(null, null));
  await page.waitForTimeout(300);
  await page.screenshot({ path: (process.env.SHOT ?? "/tmp/coreview-shapes.png").replace(".png", "-solid.png") });
}

// ------------------------------------------------------------- export warning (LT-170)
const exportMenu = page.locator("details.cv-dropdown", { has: page.locator("summary", { hasText: "Export" }) });
const openExport = async () => {
  if (!(await exportMenu.evaluate((d) => d.open))) await exportMenu.locator("summary").click();
  await page.waitForTimeout(200);
};
const lastExport = () => page.evaluate(() => (window.__exports ?? []).at(-1)?.text ?? "");
const LAB_IMAGE = "data:image/svg+xml;base64,";

await page.evaluate(() => window.__cvStore.getState().select(null, null));
await openExport();
const warning = page.locator(".cv-export-artwork");
const warningText = (await warning.count()) ? await warning.innerText() : "";
check("the export menu warns that imported artwork is in the project",
  /1 device uses imported stencils/.test(warningText) && /third-party artwork/.test(warningText), JSON.stringify(warningText));
check("and names the licence it came with", warningText.includes("Licences: Drawn by the lab team"), JSON.stringify(warningText));

await page.locator(".cv-dropdown-menu button", { hasText: "Diagram as SVG" }).click();
await page.waitForTimeout(600);
const plain = await lastExport();
check("an ordinary SVG export carries the imported artwork", plain.includes(LAB_IMAGE), `${plain.length} chars`);
const said = await page.evaluate(() => window.__cvStore.getState().statusMessage ?? "");
check("and the status line says so after saving", /includes artwork from imported stencils/.test(said), JSON.stringify(said));

await openExport();
await page.locator(".cv-export-artwork input[type=checkbox]").check();
await page.locator(".cv-dropdown-menu button", { hasText: "Diagram as SVG" }).click();
await page.waitForTimeout(600);
const safe = await lastExport();
check("a vendor-safe SVG export carries none of it", safe.length > 0 && safe !== plain && !safe.includes(LAB_IMAGE),
  `${safe.length} chars, image ${safe.includes(LAB_IMAGE)}`);
check("but still draws the device, as its class", safe.includes("Lab LB"), "label missing");
const saidSafe = await page.evaluate(() => window.__cvStore.getState().statusMessage ?? "");
check("and does not warn", !/imported stencils/.test(saidSafe), JSON.stringify(saidSafe));

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
