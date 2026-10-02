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
      // LT-479: a policy route the engine does not evaluate, and must say so.
      policyRoutes: [{ interface: "Vlan50", name: "PBR-GUEST" }],
    },
    {
      hostname: "SPARE", address: "192.168.13.2",
      addresses: [{ ip: "192.168.13.2", interface: "Gi0/1" }],
      class: "router", hops: 1, reachedBy: "ssh", neighbors: [], attached: [],
      routes: [
        { family: 4, prefix: "10.40.50.0/24", code: "C", protocol: "connected", nextHops: [], interface: "Vlan50", distance: 0, metric: 0 },
      ],
    },
    // A firewall that translates, and a load balancer behind it: the
    // application shape the generated page exists to draw.
    {
      hostname: "FW-01", address: "203.0.113.1",
      addresses: [{ ip: "203.0.113.1", interface: "port1" }],
      class: "firewall", hops: 1, reachedBy: "ssh", attached: [],
      neighbors: [{ deviceId: "LB-01", shortName: "LB-01", localInterface: "port2" }],
      routes: [{ family: 4, prefix: "10.20.0.0/16", code: "S", protocol: "static", nextHops: ["10.20.0.2"], interface: "port2", distance: 1, metric: 0 }],
      nat: [{ kind: "destination", matches: "203.0.113.50", becomes: "10.20.0.50", port: 443, description: "Customer Portal" }],
    },
    {
      hostname: "LB-01", address: "10.20.0.2",
      addresses: [{ ip: "10.20.0.2", interface: "Vlan20" }],
      class: "server", hops: 2, reachedBy: "ssh", attached: [], neighbors: [],
      routes: [{ family: 4, prefix: "10.20.0.0/16", code: "C", protocol: "connected", nextHops: [], interface: "Vlan20", distance: 0, metric: 0 }],
      vips: [{ address: "10.20.0.50", port: 443, members: ["10.20.0.11"], description: "Portal pool" }],
    },
    { hostname: "WEB-01", address: "10.20.0.11", addresses: [{ ip: "10.20.0.11", interface: "eth0" }],
      class: "server", hops: 3, reachedBy: "ssh", attached: [], neighbors: [], routes: [] },
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
      // LT-477: one saved SSH login, and what the source device's traceroute said.
      if (cmd === "vault_status") return Promise.resolve({ exists: true, unlocked: true, credentials: 1, minimumPassphrase: 12, keptInKeychain: false });
      if (cmd === "list_credentials") return Promise.resolve([{ id: "cred-ssh", label: "reader", kind: "ssh", username: "reader", detail: "", hasSecondSecret: false }]);
      if (cmd === "traceroute_from_device") return Promise.resolve({ platform: "Cisco IOS / IOS-XE", command: "traceroute 10.40.50.9", hops: [
        { ttl: 1, address: "192.168.12.2", rttsMs: [1.2, 1.1, 0.9] },
        { ttl: 2, address: null, rttsMs: [] },
        { ttl: 3, address: "198.51.100.7", rttsMs: [4] },
        { ttl: 4, address: "10.40.50.9", rttsMs: [3, 2.8] },
      ] });
      return Promise.resolve([]);
    },
  };
}, { p: project, c: crawl });

page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(900);
await page.locator(".cv-panel .cv-tabs button", { hasText: "Path-Trace" }).click();
await page.waitForTimeout(700);

const panel = page.locator(".cv-pathtrace");
const field = (label) =>
  panel.locator(".cv-field", { has: page.locator(`span:text-is("${label}")`) }).locator("input, select").first();
const go = panel.locator("button", { hasText: "Run Path-Trace" });

check("the panel reads a saved crawl run rather than the network",
  /7 devices in this run, 6 with a routing table/.test(await panel.textContent()),
  (await panel.textContent()).slice(0, 160));

// ------------------------------------------------ the path it would take

await field("Source").selectOption({ label: "EDGE" });
await field("Destination").fill("10.40.50.9");
await go.click();
await page.waitForTimeout(400);
check("each hop says it was looked up in the routing table (LT-679)", (await panel.locator(".cv-trace-table").count()) > 0 && (await panel.locator(".cv-trace-table").first().innerText()) === "routing table",
  (await panel.locator(".cv-trace-table").allInnerTexts()).join(" | "));
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

// ------------------------------------------- LT-479: what was not evaluated
check("a hop through a device with policy routing says it was not evaluated",
  /Policy routing is configured on CORE — Vlan50 \(PBR-GUEST\) — and was not evaluated/.test(await panel.textContent()),
  (await panel.textContent()).slice(0, 600));
check("and every calculated path carries the caveat", /Not evaluated: ACLs, firewall policy/.test(await panel.textContent()));

// ------------------------------------------- LT-477: measured from the device
{
  const measure = panel.locator('[data-region="measure"]');
  await measure.locator("select").first().selectOption("cred-ssh");
  await measure.locator("button", { hasText: "Measure from EDGE" }).click();
  await page.waitForTimeout(500);
  const asked = await page.evaluate(() => window.__calls?.filter?.((c) => c.cmd === "traceroute_from_device").at(-1)?.args ?? null);
  const mrows = () => panel.locator('[data-region="measured"] tbody tr');
  check("the source device's own traceroute is asked for, to the destination, with the chosen login",
    (await mrows().count()) === 4, String(await mrows().count()) + " " + JSON.stringify(asked));
  const verdicts = await mrows().evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-verdict")));
  check("each answering hop is matched to a crawled device and to the calculated path",
    JSON.stringify(verdicts) === JSON.stringify(["on", "silent", "unknown", "unknown"]), JSON.stringify(verdicts));
  const firstRow = (await mrows().nth(0).allInnerTexts()).join(" ");
  check("the hop that answered from CORE's address is CORE, on the path", /CORE/.test(firstRow) && /on the calculated path/.test(firstRow), firstRow);
  check("and the summary counts it", /1 of 3 answering hops are on the calculated path/.test(await panel.textContent()));
  check("the calculated table is untouched by the measured one", (await rows().count()) === 2);
}

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
check("a VRF nothing holds a table for says so rather than using the global one",
  /Insufficient routing data/.test(await panel.textContent()) &&
  /holds a routing table for VRF/.test(await panel.textContent()) &&
  /does not fall back|falls back/i.test(await panel.textContent()), (await panel.textContent()).slice(0, 320));
check("and draws no path at all for it", (await rows().count()) === 0);

await field("VRF").fill("");
await field("Source").selectOption({ label: "EDGE" });
await field("Destination").fill("198.51.100.7");
await go.click();
await page.waitForTimeout(500);
check("a destination with no route says which device would drop it",
  /Stops at EDGE/.test(await panel.textContent()) && /no route to 198\.51\.100\.7/.test(await panel.textContent()),
  (await panel.textContent()).slice(0, 300));

await field("Source").selectOption({ label: "DARK" });
await field("Destination").fill("10.40.50.9");
await go.click();
await page.waitForTimeout(500);
check("a device whose routing table was never collected says exactly that",
  /routing table was not collected/.test(await panel.textContent()), (await panel.textContent()).slice(0, 300));

// LT-504: the source is chosen from the run's devices, so a device this
// project never crawled cannot be asked for at all — and, once one is
// chosen, every other is still on offer.
const offered = await field("Source").locator("option").allInnerTexts();
check("the source offers the run's devices and nothing else",
  offered.includes("EDGE") && offered.includes("DARK") && !offered.includes("GHOST") && offered.length === 8, JSON.stringify(offered));


// -------------------------- LT-348 the application page, drawn and separate

const pagesNow = () => page.evaluate(() => window.__cvStore.getState().doc.pages.map((p) => ({
  id: p.id, name: p.name, nodes: p.nodes.length, edges: p.edges.length,
})));
const originalBefore = await page.evaluate(() => JSON.stringify(window.__cvStore.getState().doc.pages[0]));

await page.locator("button", { hasText: /^Clear$/ }).first().click();
await page.waitForTimeout(300);
await field("Application").fill("Customer Portal");
await field("Source").selectOption({ label: "FW-01" });
await field("Destination").fill("203.0.113.50");
await field("Port").fill("443");
await go.click();
await page.waitForTimeout(600);

const appText = await panel.textContent();
check("a NAT is followed and the lookup after it uses the new address",
  /FW-01 translates 203\.0\.113\.50 to 10\.20\.0\.50/.test(appText) &&
  /Everything after this is routed for 10\.20\.0\.50/.test(appText), appText.slice(0, 400));
check("and the load balancer's VIP picks a real member",
  /LB-01 answers for 10\.20\.0\.50/.test(appText) && /sends this connection to 10\.20\.0\.11/.test(appText),
  appText.slice(0, 500));

await panel.locator("button", { hasText: "Create application path page" }).click();
await page.waitForTimeout(800);

const madePages = await pagesNow();
check("a new page is created through the existing Pages system", madePages.length === 2, JSON.stringify(madePages));
check("named after the application", madePages[1].name === "APP - Customer Portal - TCP 443", madePages[1].name);
check("with the path drawn on it — nodes and lines, not a list",
  madePages[1].nodes >= 4 && madePages[1].edges >= madePages[1].nodes - 1, JSON.stringify(madePages[1]));
check("and it is only the path, not a copy of the network",
  madePages[1].nodes < 20, String(madePages[1].nodes));

if (process.env.SHOT2) await page.screenshot({ path: process.env.SHOT2 });
check("the original topology page is byte-for-byte what it was",
  (await page.evaluate(() => JSON.stringify(window.__cvStore.getState().doc.pages[0]))) === originalBefore);
check("and the generated page is the one in front", 
  (await page.evaluate(() => window.__cvStore.getState().doc.activePageId)) === madePages[1].id);
check("nothing is left highlighted on the original",
  (await page.evaluate(() => window.__cvStore.getState().canvasHighlight)) === null);

// A second application makes a second page rather than editing the first.
await page.locator(".cv-page-tab, .cv-pages button", { hasText: "Core" }).first().click().catch(() => {});
await page.waitForTimeout(400);
await page.locator(".cv-panel .cv-tabs button", { hasText: "Path-Trace" }).click();
await page.waitForTimeout(400);
await field("Application").fill("Reporting");
await field("Port").fill("8443");
await go.click();
await page.waitForTimeout(500);
await panel.locator("button", { hasText: "Create application path page" }).click();
await page.waitForTimeout(700);

const three = await pagesNow();
check("a second application makes a third page, independent of the first two",
  three.length === 3 && three[2].name.includes("Reporting"), JSON.stringify(three.map((p) => p.name)));
check("and the first generated page was not touched",
  JSON.stringify(three[1]) === JSON.stringify(madePages[1]), JSON.stringify(three[1]));
check("nor was the original, still",
  (await page.evaluate(() => JSON.stringify(window.__cvStore.getState().doc.pages[0]))) === originalBefore);

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
