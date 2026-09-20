// Trace Path (LT-346): where a packet would go, from the routing tables a
// crawl already collected.
//
// The Path check tab beside it asks "can A reach B" and finds out by sending
// something. This asks which way it would go and sends nothing at all — so
// what is driven here is the whole path through the window: a saved crawl run
// read back, a route lookup per device, the hop table, the "Why this path?"
// panel, the highlight on the diagram, and the failure simulation.
//
// What matters as much as the happy path is what it refuses: a named VRF and a
// device with no routing table both stop with a reason rather than a guess.
//
//     npm run dev            # in another terminal
//     node e2e/pathtrace.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const node = (id, label, x) => ({
  id, type: "device", position: { x, y: 0 }, width: 76, height: 76,
  data: { label, hostname: label, deviceType: "router", tags: [] },
});

const project = {
  meta: { id: "trace", name: "Trace", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    activePageId: "p1", probes: [],
    pages: [{ id: "p1", name: "Core",
      canvas: { gridEnabled: true, snapEnabled: true, minimap: false, nodeStyle: "glyph" }, edges: [],
      nodes: [node("a", "EDGE", 0), node("b", "CORE", 240), node("c", "SPARE", 480), node("d", "DARK", 720)] }],
  },
};

// A small but real routing picture: EDGE learns 10.40.50.0/24 by BGP with a
// next hop it can only reach through the IGP, which is the case the engine
// exists for. SPARE is a worse-metric alternative for the failure simulation.
const crawl = {
  devices: [
    {
      hostname: "EDGE", address: "192.168.12.1",
      addresses: [{ ip: "192.168.12.1", interface: "Gi0/0" }],
      class: "router", hops: 0, reachedBy: "ssh", neighbors: [], attached: [],
      routes: [
        { family: 4, prefix: "10.40.50.0/24", code: "B", protocol: "bgp", nextHops: ["10.255.2.1"], interface: null, distance: 20, metric: 0 },
        { family: 4, prefix: "10.40.50.0/24", code: "O", protocol: "ospf", nextHops: ["192.168.13.2"], interface: null, distance: 110, metric: 40 },
        { family: 4, prefix: "10.255.2.1/32", code: "O", protocol: "ospf", nextHops: ["192.168.12.2"], interface: null, distance: 110, metric: 3 },
        { family: 4, prefix: "192.168.12.0/30", code: "C", protocol: "connected", nextHops: [], interface: "Gi0/0", distance: 0, metric: 0 },
        { family: 4, prefix: "192.168.13.0/30", code: "C", protocol: "connected", nextHops: [], interface: "Gi0/1", distance: 0, metric: 0 },
      ],
    },
    {
      hostname: "CORE", address: "192.168.12.2",
      addresses: [{ ip: "192.168.12.2", interface: "Gi0/0" }, { ip: "10.255.2.1", interface: "Loopback0" }],
      class: "router", hops: 1, reachedBy: "ssh", neighbors: [], attached: [],
      routes: [
        { family: 4, prefix: "10.40.50.0/24", code: "C", protocol: "connected", nextHops: [], interface: "Vlan50", distance: 0, metric: 0 },
      ],
    },
    {
      hostname: "SPARE", address: "192.168.13.2",
      addresses: [{ ip: "192.168.13.2", interface: "Gi0/1" }],
      class: "router", hops: 1, reachedBy: "ssh", neighbors: [], attached: [],
      routes: [
        { family: 4, prefix: "10.40.50.0/24", code: "C", protocol: "connected", nextHops: [], interface: "Vlan50", distance: 0, metric: 0 },
      ],
    },
    // Crawled, but without its routing table — a different thing from an
    // empty one, and the engine must say so.
    {
      hostname: "DARK", address: "192.168.77.2",
      addresses: [{ ip: "192.168.77.2", interface: "Gi0/2" }],
      class: "router", hops: 1, reachedBy: "ssh", neighbors: [], attached: [],
    },
  ],
  notVisited: [],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });

await page.addInitScript(({ p, c }) => {
  let next = 1; const cbs = {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const id = next++; cbs[id] = cb; return id; },
    invoke(cmd) {
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "",
        engineer: "", description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({});
      if (cmd === "list_crawl_runs") return Promise.resolve([{ id: "run-1", takenAt: 1756000000000, seed: "192.168.12.1", devices: 4 }]);
      if (cmd === "crawl_run_result") return Promise.resolve(c);
      return Promise.resolve([]);
    },
  };
}, { p: project, c: crawl });

page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(900);
await page.locator(".cv-panel .cv-tabs button", { hasText: "Trace path" }).click();
await page.waitForTimeout(700);

const panel = page.locator(".cv-pathtrace");
const field = (label) =>
  panel.locator(".cv-field", { has: page.locator(`span:text-is("${label}")`) }).locator("input, select").first();
const go = panel.locator("button", { hasText: "Trace path" });

check("the panel reads a saved crawl run rather than the network",
  /4 devices in this run, 3 with a routing table/.test(await panel.textContent()),
  (await panel.textContent()).slice(0, 160));

// ------------------------------------------------ the path it would take

await field("Source").fill("EDGE");
await field("Destination").fill("10.40.50.9");
await go.click();
await page.waitForTimeout(600);

const rows = () => page.locator('[data-region="trace-path"] tbody tr');
check("it walks hop by hop", (await rows().count()) === 2, String(await rows().count()));
const first = await rows().nth(0).allInnerTexts();
check("the first decision is the BGP route, by longest prefix and distance",
  /bgp/.test(first.join(" ")) && /10\.40\.50\.0\/24/.test(first.join(" ")), first.join(" "));
check("and it resolved the BGP next hop down to a real interface",
  /10\.255\.2\.1/.test(first.join(" ")) && /Gi0\/0/.test(first.join(" ")), first.join(" "));
const second = await rows().nth(1).allInnerTexts();
check("the last hop is CORE, connected", /CORE/.test(second.join(" ")) && /connected/.test(second.join(" ")), second.join(" "));

check("it explains why that route won",
  /Why this path/.test(await panel.textContent()) &&
  /lower administrative distance|longest prefix/.test(await panel.textContent()),
  (await panel.textContent()).slice(0, 400));
check("and shows the recursion that made the next hop a cable",
  /resolved through/.test(await panel.textContent()));

// The calculated path is lit on the diagram, and everything else dimmed.
const lit = await page.evaluate(() => {
  const h = window.__cvStore.getState().canvasHighlight;
  return h ? [...h] : null;
});
check("the path is highlighted on the topology", Array.isArray(lit) && lit.length === 2 && lit.includes("a") && lit.includes("b"),
  JSON.stringify(lit));

if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

// --------------------------------------------------- simulating a failure

await page.locator('[data-region="simulate"] summary').click();
await page.waitForTimeout(300);
const targets = page.locator('[data-region="simulate"] input[type="checkbox"]');
check("the failure simulation offers the devices on the path", (await targets.count()) === 2);
await page.locator('[data-region="simulate"] .cv-check', { hasText: "CORE" }).locator("input").check();
await page.waitForTimeout(600);

const after = await rows().allInnerTexts();
check("taking CORE out finds the alternate route EDGE already holds",
  after.join(" ").includes("SPARE") && after.join(" ").includes("ospf"), after.join(" ").slice(0, 200));
check("and says that is the table's second choice, not a reconvergence",
  /preferred route's next hop is on a device this simulation removed/.test(await panel.textContent()));

await page.locator('[data-region="simulate"] .cv-check', { hasText: "SPARE" }).locator("input").check();
await page.waitForTimeout(600);
check("with every way out taken away, it says unreachable rather than inventing one",
  /Stops at EDGE/.test(await panel.textContent()), (await panel.textContent()).slice(0, 300));

// ------------------------------------------------- what it refuses to do

await page.locator("button", { hasText: /^Clear$/ }).first().click();
await page.waitForTimeout(300);
await field("VRF").fill("CUSTOMER-A");
await go.click();
await page.waitForTimeout(500);
check("a named VRF says the data is not there rather than using the global table",
  /Insufficient routing data/.test(await panel.textContent()) &&
  /global table only/.test(await panel.textContent()), (await panel.textContent()).slice(0, 300));
check("and draws no path at all for it", (await rows().count()) === 0);

await field("VRF").fill("");
await field("Source").fill("EDGE");
await field("Destination").fill("198.51.100.7");
await go.click();
await page.waitForTimeout(500);
check("a destination with no route says which device would drop it",
  /Stops at EDGE/.test(await panel.textContent()) && /no route to 198\.51\.100\.7/.test(await panel.textContent()),
  (await panel.textContent()).slice(0, 300));

await field("Source").fill("DARK");
await field("Destination").fill("10.40.50.9");
await go.click();
await page.waitForTimeout(500);
check("a device whose routing table was never collected says exactly that",
  /routing table was not collected/.test(await panel.textContent()), (await panel.textContent()).slice(0, 300));

await field("Source").fill("GHOST");
await go.click();
await page.waitForTimeout(500);
check("a device this project never crawled is refused by name",
  /not a device this project has crawled/.test(await panel.textContent()), (await panel.textContent()).slice(0, 300));

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
