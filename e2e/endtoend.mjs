// One engineer's afternoon, end to end (LT-268): an inventory imported from a
// spreadsheet, a crawl that finds more and corrects what was imported, the
// changes reviewed and applied, validation run against it, the diagram
// exported, and a report made — through the real app in one session, with
// only the Tauri bridge stubbed.
// Invented names, documentation addresses, obviously fake secrets (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/endtoend.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const project = {
  meta: { id: "afternoon", name: "Branch refresh", createdAt: NOW, updatedAt: NOW },
  documentVersion: 1,
  document: { activePageId: "p1", probes: [], pages: [{ id: "p1", name: "Branch", canvas: { gridEnabled: true, snapEnabled: true, minimap: false, nodeStyle: "glyph" }, nodes: [], edges: [] }] },
};

const inventory = "Hostname,Mgmt IP,Model,Site\nCORE-SW1,192.0.2.10,C9300-24T,Branch\nEDGE-FW1,192.0.2.1,FG-100F,Branch\n";

const crawled = {
  devices: [
    {
      hostname: "CORE-SW1", address: "192.0.2.10", addresses: [{ ip: "192.0.2.10", interface: "Vlan1", isManagement: true }], probeTarget: "192.0.2.10",
      class: "switch", platform: "C9300-24T", serial: "FOC0000X0CC", version: "Cisco IOS XE Software, Version 17.9.4", hops: 0, reachedBy: "ssh",
      neighbors: [{ deviceId: "ACCESS-SW2", shortName: "ACCESS-SW2", addresses: [{ ip: "192.0.2.20", interface: null, isManagement: true }], localInterface: "Gi1/0/2", remoteInterface: "Gi0/1", platform: "cisco C9200L-24P-4G", capabilities: ["Switch"], version: null, class: "switch", discoveredBy: "cdp", serial: null, chassisId: null, vendor: null }],
      attached: [], portChannels: [], routes: [], spanningTree: [], vlans: [], portVlans: [], ports: [],
    },
    {
      hostname: "ACCESS-SW2", address: "192.0.2.20", addresses: [{ ip: "192.0.2.20", interface: "Vlan1", isManagement: true }], probeTarget: "192.0.2.20",
      class: "switch", platform: "C9200L-24P-4G", serial: "JAE0000X0DD", version: null, hops: 1, reachedBy: "ssh",
      neighbors: [{ deviceId: "CORE-SW1", shortName: "CORE-SW1", addresses: [{ ip: "192.0.2.10", interface: null, isManagement: true }], localInterface: "Gi0/1", remoteInterface: "Gi1/0/2", platform: "cisco C9300-24T", capabilities: ["Switch"], version: null, class: "switch", discoveredBy: "cdp", serial: null, chassisId: null, vendor: null }],
      attached: [], portChannels: [], routes: [], spanningTree: [], vlans: [], portVlans: [], ports: [],
    },
  ],
  notVisited: [], failures: [], cancelled: false,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript(({ p, inventory }) => {
  const listeners = {}, callbacks = {};
  let next = 1;
  window.__calls = [];
  window.__exports = [];
  window.__cvEmit = (event, payload) => {
    const id = listeners[event];
    if (id && callbacks[id]) callbacks[id]({ event, id, payload });
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const id = next++; callbacks[id] = cb; return id; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") { listeners[args.event] = args.handler; return Promise.resolve(next++); }
      window.__calls.push({ cmd, args });
      const meta = { id: p.meta.id, name: p.meta.name, customer: "Example Co", site: "Branch", ticket: "CHG-2044", engineer: "", description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({});
      if (cmd === "vault_status") return Promise.resolve({ exists: false, unlocked: false, credentials: 0, minimumPassphrase: 12 });
      if (cmd === "describe_subnet") return Promise.resolve({ network: "192.0.2.0", broadcast: "192.0.2.255", prefix: 24, hosts: 254 });
      if (cmd === "plugin:dialog|open") return Promise.resolve("/home/user/inventory.csv");
      if (cmd === "plugin:dialog|save") return Promise.resolve(`/tmp/${args.options?.defaultPath ?? "out"}`);
      if (cmd === "read_import") return Promise.resolve(inventory);
      if (cmd === "start_crawl") return Promise.resolve(null);
      if (cmd === "save_crawl_run") return Promise.resolve("crawl-1");
      if (cmd === "start_validation") return Promise.resolve({ session_id: "session-1", project_id: p.meta.id, state: "running", probe_count: args.probes.length });
      if (cmd === "list_sessions" || cmd === "list_crawl_runs") return Promise.resolve([]);
      if (cmd === "diagram_pdf_pages") return Promise.resolve([37, 80, 68, 70]);
      if (cmd === "save_export") {
        const bytes = Uint8Array.from(atob(args.contentsB64), (c) => c.charCodeAt(0));
        window.__exports.push({ path: args.path, text: new TextDecoder().decode(bytes) });
        return Promise.resolve(null);
      }
      return Promise.resolve([]);
    },
  };
}, { p: project, inventory });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(800);

const st = (fn, arg) => page.evaluate(fn, arg);
const devices = () => st(() => window.__cvStore.getState().doc.pages[0].nodes.filter((n) => n.type === "device").map((n) => n.data));
const calls = (cmd) => st((cmd) => window.__calls.filter((c) => c.cmd === cmd), cmd);
const panel = page.locator(".cv-panel");
const tab = (name) => panel.locator(".cv-tabs button", { hasText: name }).first().click();

// 1. Import the inventory.
await tab("From a file");
await page.waitForTimeout(300);
await panel.locator("button", { hasText: "Choose a file" }).click();
await page.waitForTimeout(400);
await panel.locator("button", { hasText: /^Add 2 to diagram/ }).click();
await page.waitForTimeout(400);
let now = await devices();
check("1. the inventory arrives as devices with their sites and models", now.length === 2 && now.find((d) => d.label === "CORE-SW1")?.model === "C9300-24T" && now.every((d) => d.site === "Branch"), JSON.stringify(now.map((d) => d.label)));
const probesAfterImport = await st(() => window.__cvStore.getState().doc.probes.length);
check("   and each device with an address is watched", probesAfterImport === 2);

// 2. Crawl from the core.
await tab("Discover devices");
await page.waitForTimeout(300);
await panel.getByPlaceholder("10.1.1.1, core-sw1, 10.1.2.0/24").fill("192.0.2.10");
await panel.locator("label", { hasText: /^Username/ }).locator("input").first().fill("reader");
await panel.locator("label", { hasText: /^Password/ }).locator("input").first().fill("not-a-real-password");
await panel.locator("button", { hasText: /^Discover$/ }).click();
await page.waitForTimeout(300);
const crawl = (await calls("start_crawl")).at(-1)?.args;
check("2. the crawl starts from the seed with the typed login", crawl?.input.seed === "192.0.2.10" && crawl.credentials.username === "reader");
await st((r) => window.__cvEmit("coreview://crawl-result", r), crawled);
await page.waitForTimeout(600);
check("   and what it found is listed", (await panel.locator("tr", { hasText: "ACCESS-SW2" }).count()) >= 1);

// 3. Review and apply.
await panel.locator("button").filter({ hasText: /^Add .* to diagram$/ }).last().click();
await page.waitForTimeout(400);
const review = panel.locator(".cv-reconcile");
const reviewText = await review.textContent();
check("3. the review shows the new switch and what changed on the imported one", /ACCESS-SW2/.test(reviewText) && /CORE-SW1/.test(reviewText), reviewText.slice(0, 300));
await review.locator("button", { hasText: /^Apply/ }).click();
await page.waitForTimeout(500);
now = await devices();
const core = now.find((d) => d.label === "CORE-SW1");
check("   applied, the imported switch gains its serial and the new one appears, not a copy", now.length === 3 && core?.serial === "FOC0000X0CC" && now.filter((d) => d.label === "CORE-SW1").length === 1, JSON.stringify(now.map((d) => [d.label, d.serial])));
const edges = await st(() => window.__cvStore.getState().doc.pages[0].edges.map((e) => e.data));
check("   with the link between them and its ports", edges.some((e) => e.sourcePortLabel === "Gi1/0/2" || e.targetPortLabel === "Gi1/0/2"), JSON.stringify(edges));

// 4. Validate.
await page.locator("button", { hasText: "Start validation" }).first().click();
await page.waitForTimeout(400);
const started = (await calls("start_validation")).at(-1)?.args;
check("4. validation checks every watched device", started?.probes.length >= 3 && started.probes.every((p) => p.target && !("notes" in p)), JSON.stringify(started?.probes?.map((p) => p.target)));
await st((probes) => {
  const nodes = window.__cvStore.getState().doc.pages[0].nodes;
  const emit = (e) => window.__cvEmit("coreview://engine", e);
  for (const p of probes) {
    const node = nodes.find((n) => n.id === p.object_id);
    const down = node?.data.label === "EDGE-FW1";
    emit({ kind: "sample", session_id: "session-1", status: down ? "down" : "healthy", result: { probe_id: p.id, timestamp_ms: Date.now(), outcome: down ? "timeout" : "success", rtt_ms: down ? null : 2, resolved: [], summary: down ? "No reply within 1000 ms" : "Reply in 2 ms", error_message: null } });
    emit({ kind: "transition", session_id: "session-1", transition: { probe_id: p.id, object_kind: "node", object_id: p.object_id, timestamp_ms: Date.now(), previous: "unknown", current: down ? "down" : "healthy", message: down ? "No reply within 1000 ms" : "Reply in 2 ms" } });
  }
}, started.probes);
await page.waitForTimeout(500);
const counts = await page.locator(".cv-counts").textContent();
check("   and the results reach the diagram", /Down 1/.test(counts) && /Healthy [1-9]/.test(counts), counts);

// 5. Export and report.
const menu = page.locator(".cv-dropdown").filter({ has: page.locator("summary", { hasText: "Export" }) });
await menu.locator("summary").click();
await menu.locator("button", { hasText: "Diagram for draw.io" }).click();
await page.waitForTimeout(500);
const drawio = (await st(() => window.__exports)).at(-1)?.text ?? "";
check("5. the diagram exports with everything that was found", ["CORE-SW1", "EDGE-FW1", "ACCESS-SW2", "Gi1/0/2"].every((w) => drawio.includes(w)), drawio.slice(0, 200));
await menu.locator("summary").click();
await menu.locator("button", { hasText: "Report as PDF…" }).click();
const dialog = page.getByRole("dialog", { name: "PDF report" });
await dialog.getByLabel(/Post-change verification/).check();
await dialog.getByRole("button", { name: "Make the PDF" }).click();
await page.waitForTimeout(1200);
const report = ((await calls("diagram_pdf_pages")).at(-1)?.args.svgs ?? []).join("\n");
check("   and the report says what is down, with the drawing", /POST-CHANGE VERIFICATION/.test(report) && /Needs attention/.test(report) && /EDGE-FW1/.test(report) && /No reply within 1000 ms/.test(report) && /Diagram — Branch/.test(report));

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
