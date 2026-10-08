// The Tracert tab — a traceroute run now, from this machine or by a
// device, its hops named by the crawled device that answered, and a page
// drawn from it the way Path-Trace draws a calculated path. Stubbed backend.
// Invented names and documentation addresses.
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const project = {
  meta: { id: "tracert", name: "Tracert", customer: "", site: "", ticket: "", engineer: "", description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: { nodes: [], edges: [], probes: [], canvas: {} },
};
const crawl = {
  devices: [
    { hostname: "EDGE", address: "192.0.2.1", addresses: [{ ip: "192.0.2.1", interface: "Gi0/0", isManagement: true }], probeTarget: "192.0.2.1", class: "router", hops: 0, reachedBy: "ssh", neighbors: [], attached: [], routes: [] },
    { hostname: "CORE", address: "192.0.2.2", addresses: [{ ip: "192.0.2.2", interface: "Gi0/1", isManagement: true }], probeTarget: "192.0.2.2", class: "router", hops: 1, reachedBy: "ssh", neighbors: [], attached: [], routes: [] },
  ],
  failures: [], notVisited: [], cancelled: false,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript(({ p, c }) => {
  const listeners = {}, callbacks = {};
  let next = 1;
  window.__calls = [];
  // Events to the page, as the backend emits them.
  window.__cvEmit = (event, payload) => {
    const id = listeners[event];
    if (id && callbacks[id]) callbacks[id]({ event, id, payload });
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const id = next++; callbacks[id] = cb; return id; },
    invoke(cmd, args = {}) {
      window.__calls.push({ cmd, args });
      if (cmd === "plugin:event|listen") { listeners[args.event] = args.handler; return Promise.resolve(next++); }
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "", engineer: "", description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({});
      if (cmd === "list_crawl_runs") return Promise.resolve([{ id: "run-1", takenAt: 1756000000000, seed: "192.0.2.1", devices: 2 }]);
      if (cmd === "crawl_run_result") return Promise.resolve(c);
      if (cmd === "vault_status") return Promise.resolve({ exists: true, unlocked: true, credentials: 1, minimumPassphrase: 12, keptInKeychain: false });
      if (cmd === "list_credentials") return Promise.resolve([{ id: "cred-ssh", label: "reader", kind: "ssh", username: "reader", detail: "", hasSecondSecret: false }]);
      if (cmd === "traceroute_now") return Promise.resolve({ target: args.target, complete: true, hops: [
        { hop: 1, probes: [{ host: "192.0.2.1", rtt_ms: 1.2 }, { host: "192.0.2.1", rtt_ms: 1.0 }] },
        { hop: 2, probes: [{ host: null, rtt_ms: null }] },
        { hop: 3, probes: [{ host: "198.51.100.7", rtt_ms: 5 }] },
      ] });
      // A slow device — its answer waits until the page is told to give it.
      if (cmd === "traceroute_from_device" && args.target === "198.51.100.99") return new Promise((resolve) => { window.__finishTrace = resolve; });
      if (cmd === "traceroute_from_device") return Promise.resolve({ platform: "Cisco IOS / IOS-XE", command: `traceroute ${args.target}`, complete: true, elapsedMs: 900, hops: [
        { ttl: 1, address: "192.0.2.2", rttsMs: [2, 2] },
        { ttl: 2, address: "198.51.100.7", rttsMs: [6] },
      ] });
      return Promise.resolve([]);
    },
  };
}, { p: project, c: crawl });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(900);
await page.locator(".cv-panel .cv-tabs button", { hasText: "Tracert" }).click();
await page.waitForTimeout(600);

const panel = page.locator('[data-region="tracert"]');
const field = (label) => panel.locator(".cv-field", { has: page.locator(`span:text-is("${label}")`) }).locator("input, select").first();
const rows = () => panel.locator('[data-region="tracert-hops"] tbody tr');

check("the tab is there and offers this machine and the run's devices as the source",
  JSON.stringify(await field("From").locator("option").allInnerTexts()) === JSON.stringify(["This machine", "EDGE", "CORE"]),
  JSON.stringify(await field("From").locator("option").allInnerTexts()));

// ------------------------------------------------- from this machine
await field("To").fill("198.51.100.7");
await panel.locator("button", { hasText: "Run tracert" }).click();
await page.waitForTimeout(600);
check("a trace from this machine asks the backend and lists every hop, silent ones included",
  (await rows().count()) === 3 && (await page.evaluate(() => window.__calls.some((c) => c.cmd === "traceroute_now" && c.args.target === "198.51.100.7"))),
  String(await rows().count()));
// The trace outlives the tab. Away to another tab and back, the hops are still there.
await page.locator(".cv-panel .cv-tabs button", { hasText: "Path check" }).click();
await page.waitForTimeout(300);
await page.locator(".cv-panel .cv-tabs button", { hasText: "Tracert" }).click();
await page.waitForTimeout(300);
check("a finished trace is still shown after a tab change", (await rows().count()) === 3 && /Run from this machine/.test(await panel.textContent()), String(await rows().count()));
const first = (await rows().nth(0).allInnerTexts()).join(" ");
check("a hop that answered from a crawled device is named by it", /192\.0\.2\.1/.test(first) && /EDGE/.test(first), first);
check("and the second run says the path is the same",
  /First trace to this target/.test(await panel.textContent()));

// ------------------------------------------------- a page from it
const pagesBefore = await page.evaluate(() => window.__cvStore.getState().doc.pages.length);
await panel.locator("button", { hasText: "Create application path page" }).click();
await page.waitForTimeout(600);
const pages = await page.evaluate(() => window.__cvStore.getState().doc.pages.map((p) => ({ name: p.name, nodes: p.nodes.length, edges: p.edges.length })));
const made = pages[pages.length - 1];
check("Create application path page draws the measured hops on a page of their own",
  pages.length === pagesBefore + 1 && /Tracert 198\.51\.100\.7/.test(made.name) && made.nodes === 5 && made.edges === 4,
  JSON.stringify(made));
const labels = await page.evaluate(() => window.__cvStore.getState().doc.pages.at(-1).nodes.map((n) => n.data.label));
check("with the source, each hop by its device or address, the silent hop as silent, and the destination",
  JSON.stringify(labels) === JSON.stringify(["This machine", "EDGE", "* (hop 2)", "198.51.100.7", "198.51.100.7"]), JSON.stringify(labels));

// ------------------------------------------------- from a device
await page.locator(".cv-panel .cv-tabs button", { hasText: "Tracert" }).click();
await page.waitForTimeout(300);
await field("From").selectOption({ label: "EDGE" });
await panel.locator("select").nth(1).selectOption("cred-ssh");
check("the chosen login says the project's other saved logins are tried after it",
  /every other saved login of this project is tried/.test((await panel.locator('[data-hint="others-tried"]').allInnerTexts()).join(" ")));
await panel.locator("button", { hasText: "Run tracert" }).click();
await page.waitForTimeout(600);
const asked = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "traceroute_from_device").at(-1)?.args);
check("a trace from a device runs on the device, by its address, with the chosen login",
  asked?.device === "192.0.2.1" && asked?.credentialId === "cred-ssh" && asked?.target === "198.51.100.7" && (await rows().count()) === 2,
  JSON.stringify(asked) + " rows=" + (await rows().count()));
check("and says what ran", /ran `traceroute 198\.51\.100\.7`/.test(await panel.textContent()));
check("naming the hop that answered from CORE", /CORE/.test((await rows().nth(0).allInnerTexts()).join(" ")));

// ------------------------------------------------- a slow device
await panel.locator(".cv-field", { has: page.locator('span:text-is("To")') }).locator("input").fill("198.51.100.99");
await panel.locator("button", { hasText: "Run tracert" }).click();
await page.waitForTimeout(1300);
check("while a device traces, the button counts the seconds", /Tracing… [1-9] s/.test(await panel.textContent()), (await panel.locator("button.cv-btn-start").textContent()));
check("and says a device's trace can take minutes", (await panel.locator('[data-region="tracert-live"]').count()) === 1);
await page.evaluate(() => window.__cvEmit("coreview://tracert", { device: "192.0.2.1", target: "198.51.100.99", elapsedMs: 4000, hops: [
  { ttl: 1, address: "192.0.2.2", rttsMs: [2] },
  { ttl: 2, address: "203.0.113.1", rttsMs: [11] },
] }));
await page.waitForTimeout(300);
check("the hops appear as the device prints them", (await rows().count()) === 2, "rows=" + (await rows().count()));
await page.evaluate(() => window.__finishTrace({ platform: "Cisco IOS / IOS-XE", command: "traceroute 198.51.100.99", complete: false, elapsedMs: 180000, hops: [
  { ttl: 1, address: "192.0.2.2", rttsMs: [2] },
  { ttl: 2, address: "203.0.113.1", rttsMs: [11] },
  { ttl: 3, address: null, rttsMs: [] },
] }));
await page.waitForTimeout(400);
check("a trace stopped at the limit keeps its hops and says it was cut short",
  (await rows().count()) === 3 && /Cut short/.test(await panel.textContent()) && (await panel.locator('[data-region="tracert-live"]').count()) === 0,
  "rows=" + (await rows().count()));

await browser.close();
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
