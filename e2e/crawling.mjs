// What a crawl reads and how it is run, driven through the real app with the
// Tauri bridge stubbed (Phase 2): ports, VLANs, spanning tree, routes and
// uptime on the device (LT-200, LT-202–204); seeds from a list or a CSV (LT-207); how
// many at once, per-device limits and retries (LT-208); the live crawl table
// (LT-210), a dry run that sends nothing (LT-211), crawl profiles (LT-212), findings (LT-213), layer-3 links on the Logical view (LT-215), reviewing a crawl's changes
// (LT-216) and events that arrive under
// their own kind (LT-278); saved credentials bound to a
// device, a subnet or a vendor, sent as vault ids only (LT-199, LT-209).
// Invented names, documentation addresses (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/crawling.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

export const crawlResult = {
  devices: [
    {
      hostname: "CORE-SW1", serial: null, address: "192.0.2.10",
      addresses: [{ ip: "192.0.2.10", interface: null, isManagement: true }],
      probeTarget: "192.0.2.10", class: "switch", platform: "WS-C2960CX-8PC-L", version: null, dnsName: "core-sw1.example.test",
      neighbors: [], hops: 0, reachedBy: "ssh", portChannels: [],
      // LT-464: two silent devices on their own ports, listed before they are drawn.
      attached: [
        { mac: "0000.5e00.5310", port: "Gi0/5", address: "192.0.2.40", vendor: "Example Printers", hostname: "PRN-1", class: null, vlan: "10", portPopulation: 1 },
        { mac: "0000.5e00.5311", port: "Gi0/6", address: "192.0.2.31", vendor: "Example Cameras", hostname: null, class: null, vlan: "20", portPopulation: 1 },
      ],
      uptimeSeconds: 5019180,
      routes: [
        { family: 4, prefix: "0.0.0.0/0", code: "S*", protocol: "static", nextHops: ["192.0.2.1"], interface: null, distance: 1, metric: 0 },
        { family: 4, prefix: "192.0.2.0/24", code: "C", protocol: "connected", nextHops: [], interface: "Vlan1", distance: null, metric: null },
      ],
      spanningTree: [
        { instance: "VLAN0001", vlan: 1, protocol: "rstp", rootBridge: "0000.5e00.5301", rootPriority: 32768, isRoot: false,
          rootPort: "GigabitEthernet0/1", bridgeAddress: "0000.5e00.5302",
          ports: [{ port: "Gi0/1", role: "Root", state: "FWD", cost: 4 }, { port: "Gi0/2", role: "Altn", state: "BLK", cost: 4 }] },
        { instance: "VLAN0010", vlan: 10, protocol: "rstp", rootBridge: "0000.5e00.5302", rootPriority: 32778, isRoot: true,
          rootPort: null, bridgeAddress: "0000.5e00.5302", ports: [] },
      ],
      vlans: [{ id: 1, name: "default", status: "active", ports: [] }, { id: 10, name: "STAFF", status: "active", ports: ["Gi0/3"] }],
      portVlans: [
        { port: "Gi0/1", mode: "trunk", vlan: 1, trunkVlans: [1, 10, 11, 12] },
        { port: "Gi0/3", mode: "access", vlan: 10, trunkVlans: [] },
      ],
      ports: [
        { port: "Gi0/1", description: "", status: "connected", vlan: "trunk", duplex: "a-full", speed: "1000", media: "" },
        { port: "Gi0/2", description: "", status: "connected", vlan: "trunk", duplex: "a-full", speed: "1000", media: "" },
        { port: "Gi0/3", description: "desk 12", status: "notconnect", vlan: "10", duplex: "auto", speed: "auto", media: "" },
      ],
    },
    {
      hostname: "EDGE-RTR1", serial: null, address: "192.0.2.1",
      addresses: [{ ip: "192.0.2.1", interface: null, isManagement: true }],
      probeTarget: "192.0.2.1", class: "router", platform: null, version: null,
      neighbors: [], hops: 1, reachedBy: "ssh", attached: [], portChannels: [],
      routes: [{ family: 4, prefix: "198.51.100.0/24", code: "S", protocol: "static", nextHops: ["192.0.2.10"], interface: null, distance: 1, metric: 0 }],
    },
  ],
  notVisited: [], failures: [], cancelled: false,
};

const project = {
  meta: { id: "crawling", name: "Crawling", createdAt: NOW, updatedAt: NOW },
  documentVersion: 1,
  document: { nodes: [], edges: [], probes: [], canvas: {} },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
// LT-677: a device's inspector is tabbed; the control a check wants is under
// its tab, and the choice holds across selections.
const inspectorTab = async (name) => {
  const tab = page.locator('.cv-inspector-tabs button[role="tab"]', { hasText: new RegExp(`^${name}$`) });
  if (await tab.count()) { await tab.click(); await page.waitForTimeout(150); }
};
await page.addInitScript(({ p }) => {
  const listeners = {}, callbacks = {};
  let next = 1;
  window.__calls = [];
  // Every listener on the event, as Tauri delivers it — a panel's and the
  // store's (LT-619) both.
  window.__cvEmit = (event, payload) => {
    for (const id of listeners[event] ?? []) if (callbacks[id]) callbacks[id]({ event, id, payload });
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const id = next++; callbacks[id] = cb; return id; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") { (listeners[args.event] ??= []).push(args.handler); return Promise.resolve(next++); }
      window.__calls.push({ cmd, args });
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "", engineer: "",
        description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({});
      if (cmd === "start_crawl") return Promise.resolve(null);
      // LT-576: the collector path.
      if (cmd === "start_collection") return Promise.resolve("col-9");
      if (cmd === "collection_topology") return Promise.resolve({ crawlRunId: "topo-col-9", notVisited: [], graph: { nodes: [], links: [], l3: [], overlays: [], endpoints: [], findings: [] }, devices: [
        { hostname: "SW-COLLECTED", address: "192.0.2.10", addresses: [{ ip: "192.0.2.10", interface: null, isManagement: true }], probeTarget: "192.0.2.10", class: "switch", platform: null, serial: null, version: null, neighbors: [], hops: 0, reachedBy: "ssh", attached: [], portChannels: [], defaultNextHop: null, stack: null, routes: [], dnsName: null, evidence: {} },
      ] });
      if (cmd === "vault_status") return Promise.resolve({ exists: true, unlocked: true, credentials: 2, minimumPassphrase: 12 });
      if (cmd === "list_credentials") return Promise.resolve([
        { id: "cred-core", label: "Core login", kind: "ssh", username: "reader", detail: "", hasSecondSecret: false },
        { id: "cred-snmp", label: "Read-only SNMP", kind: "snmp", username: "", detail: "", hasSecondSecret: false },
        { id: "cred-api", label: "Firewall API", kind: "api", username: "", detail: "13443", hasSecondSecret: false },
      ]);
      return Promise.resolve([]);
    },
  };
}, { p: project });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(700);

const lastCall = (cmd) => page.evaluate((cmd) => window.__calls.filter((c) => c.cmd === cmd).at(-1)?.args, cmd);

// A device already drawn, to bind a credential to (LT-199).
await page.evaluate(() => {
  const s = window.__cvStore.getState();
  s.addNode({ id: "drawn-core", type: "device", position: { x: 0, y: 0 }, width: 76, height: 76,
    data: { label: "EDGE-FW", deviceType: "firewall", tags: [], locked: false, maintenance: false, showDetails: true,
      hostname: "EDGE-FW", addresses: [{ id: "a1", label: "Management", address: "192.0.2.1", isPrimary: true }] } });
  s.select("drawn-core", null);
});
await page.waitForTimeout(400);
await inspectorTab("Identity");
const snmpFor = page.getByLabel("Saved SNMP credential for this device");
check("a device's inspector offers the vault's saved credentials", (await snmpFor.locator("option").allTextContents()).join("|") === "None|Read-only SNMP");
await snmpFor.selectOption("cred-snmp");
check("and keeps only the id", await page.evaluate(() =>
  window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === "drawn-core").data.snmpCredentialId === "cred-snmp"));

await page.locator("button", { hasText: "Discover devices" }).first().click();
await page.waitForTimeout(400);
// LT-620: the collector is the default, and the form below is the classic crawler's — chosen here for it.
check("the collector is the engine by default (D-062)", (await page.locator('[data-field="discover-engine"]').inputValue()) === "collector");
await page.locator('[data-field="discover-engine"]').selectOption("classic");
const panel = page.locator(".cv-discover");

// --------------------------------------------------- LT-209 rules
await panel.locator(".cv-cred-rules summary").click();
await panel.locator(".cv-cred-rules button", { hasText: "Add a rule" }).click();
await panel.getByLabel("Subnet or vendor").fill("192.0.2.300/24");
check("a rule says when its subnet is not one", /not a subnet/.test(await panel.locator(".cv-cred-rule-problem").textContent()));
await panel.getByLabel("Subnet or vendor").fill("192.0.2.0/25");
await panel.getByLabel("Saved credential for this rule").selectOption("cred-core");
await panel.locator(".cv-cred-rules button", { hasText: "Add a rule" }).click();
await panel.getByLabel("Match by").nth(1).selectOption("vendor");
await panel.getByLabel("Subnet or vendor").nth(1).fill("FortiSwitch");
await panel.getByLabel("Saved credential for this rule").nth(1).selectOption("cred-core");
check("rules are kept with the project", await page.evaluate(() => window.__cvStore.getState().doc.credentialRules?.length === 2));

// --------------------------------------------------- LT-200–204 what is read
const tables = panel.locator(".cv-crawl-details input[type=checkbox]");
// LT-347 added two more: per-VRF tables and VXLAN/EVPN. Both are deliberately
// **off** — their parsers were built from documentation and have met no
// hardware (D-051), so a run does not start asking for them uninvited.
check("the crawl offers six tables to read", (await tables.count()) === 6, String(await tables.count()));
// In order: ports and VLANs, spanning tree, routes, per-VRF, VXLAN, reverse DNS.
check("the proven ones are on and the two unproven ones are not",
  await tables.evaluateAll((els) => {
    const on = [0, 1, 2, 5].every((i) => els[i].checked);
    const off = [3, 4].every((i) => !els[i].checked);
    return on && off;
  }));
// Exact, or it also matches "Per-VRF routing tables" (LT-347).
await panel.locator(".cv-crawl-details label").filter({ hasText: /^Routing table$/ }).locator("input").uncheck();
await panel.locator("label", { hasText: "Seed devices" }).locator("input").first().fill("192.0.2.10");
// LT-207: more seeds from a CSV, added to what is typed.
await panel.locator(".cv-seed-csv input").setInputFiles({
  name: "register.csv", mimeType: "text/csv",
  buffer: Buffer.from("Name,Management IP\nCORE-SW1,192.0.2.10\nACC-SW2,192.0.2.11\nBRANCH,198.51.100.0/30\n"),
});
await page.waitForTimeout(300);
check("seeds from a CSV join the typed ones, once each",
  (await panel.locator("label", { hasText: "Seed devices" }).locator("input").first().inputValue()) === "192.0.2.10, 192.0.2.11, 198.51.100.0/30");
await panel.locator("label", { hasText: "Username" }).first().locator("input").fill("reader");
await panel.locator("label", { hasText: "Password" }).first().locator("input").fill("not-a-real-password");
// ---------------------------------------------------------- LT-211 dry run
const callsBefore = await page.evaluate(() => window.__calls.length);
await panel.locator("button", { hasText: /^Dry run$/ }).click();
await page.waitForTimeout(400);
const dry = panel.locator(".cv-dry-run");
check("a dry run shows the plan", (await dry.count()) === 1);
const newCalls = await page.evaluate((n) => window.__calls.slice(n).map((c) => c.cmd), callsBefore);
check("and sends nothing: no crawl, sweep or lookup is asked for", newCalls.every((c) => ["list_credentials", "save_project", "list_projects", "list_project_folders"].includes(c)), JSON.stringify(newCalls));
const seedLines = await dry.locator("li[data-kind]").allTextContents();
check("each seed says what would happen to it", seedLines.length === 3 && /192\.0\.2\.10 — would be dialled with Core login \(192\.0\.2\.0\/25\), then Core login \(if a neighbour reports FortiSwitch\), then reader \(typed above\)/.test(seedLines[0]) &&
  /198\.51\.100\.0\/30 — 2 of 2 addresses/.test(seedLines[2]), JSON.stringify(seedLines));
await dry.getByLabel("Close the dry run").click();
await panel.locator("label", { hasText: "At once" }).locator("select").selectOption("8");
await panel.locator("label", { hasText: "Retries" }).locator("select").selectOption("2");
// --------------------------------------------------------- LT-212 profiles
await panel.getByLabel("Profile name").fill("Branch sites");
await panel.locator("button", { hasText: /^Save profile$/ }).click();
await page.waitForTimeout(200);
const savedProfiles = await page.evaluate(() => window.__cvStore.getState().doc.crawlProfiles);
check("the run's settings save as a named profile", savedProfiles?.length === 1 && savedProfiles[0].name === "Branch sites" &&
  savedProfiles[0].concurrency === 8 && savedProfiles[0].retries === 2 && savedProfiles[0].details.routes === false,
  JSON.stringify(savedProfiles));
check("with no password in it", !JSON.stringify(savedProfiles).includes("not-a-real-password"));
// Change things, then load the profile back.
await panel.locator("label", { hasText: "At once" }).locator("select").selectOption("1");
await panel.locator("label", { hasText: "Seed devices" }).locator("input").first().fill("203.0.113.9");
await panel.locator(".cv-crawl-details label").filter({ hasText: /^Routing table$/ }).locator("input").check();
await panel.locator("label", { hasText: /^Profile/ }).locator("select").selectOption({ label: "Branch sites" });
await page.waitForTimeout(200);
check("choosing a profile puts its settings back",
  (await panel.locator("label", { hasText: "At once" }).locator("select").inputValue()) === "8" &&
  (await panel.locator("label", { hasText: "Seed devices" }).locator("input").first().inputValue()) === "192.0.2.10, 192.0.2.11, 198.51.100.0/30" &&
  !(await panel.locator(".cv-crawl-details label").filter({ hasText: /^Routing table$/ }).locator("input").isChecked()));
await panel.getByLabel("Profile name").fill("Core");
await panel.locator("button", { hasText: /^Save profile$/ }).click();
await panel.getByLabel("Profile name").fill("core");
await panel.locator("button", { hasText: /^Save profile$/ }).click();
const names = await page.evaluate(() => window.__cvStore.getState().doc.crawlProfiles.map((p) => p.name).join(","));
check("saving under a name already used replaces that profile", names === "Branch sites,core", names);
await panel.locator("button", { hasText: /^Delete profile$/ }).click();
check("and a profile can be deleted", await page.evaluate(() => window.__cvStore.getState().doc.crawlProfiles.length) === 1);

// LT-576: the classic crawler, chosen; the collector is the default.
await panel.locator('[data-field="discover-engine"]').selectOption("classic");
await panel.locator("button", { hasText: /^Discover$/ }).click();
await page.waitForTimeout(400);
const started = await lastCall("start_crawl");
check("the run carries every binding, most specific first on the Rust side, as ids",
  JSON.stringify(started?.input?.bindings) === JSON.stringify([
    { scope: "device", value: "192.0.2.1", credentialId: "cred-snmp" },
    { scope: "device", value: "EDGE-FW", credentialId: "cred-snmp" },
    { scope: "subnet", value: "192.0.2.0/25", credentialId: "cred-core" },
    { scope: "vendor", value: "FortiSwitch", credentialId: "cred-core" },
  ]), JSON.stringify(started?.input?.bindings));
check("and no saved secret travels with it", !JSON.stringify(started).includes("secret") &&
  Object.keys(started.input.bindings[0]).join(",") === "scope,value,credentialId");
check("how many at once, when to give up and how often to retry go with the run (LT-208)",
  started?.input?.concurrency === 8 && started?.input?.perHostTimeoutSecs === 300 && started?.input?.retries === 2,
  JSON.stringify({ c: started?.input?.concurrency, t: started?.input?.perHostTimeoutSecs, r: started?.input?.retries }));
check("the whole seed list goes to the crawl", started?.input?.seed === "192.0.2.10, 192.0.2.11, 198.51.100.0/30", started?.input?.seed);
check("and sends what was chosen with the run", JSON.stringify(started?.input?.details) ===
  // LT-483: the two ticks LT-347 added now travel too.
  JSON.stringify({ routes: false, spanningTree: true, vlans: true, vrfs: false, overlay: false }) && started?.input?.reverseDns === true, JSON.stringify(started?.input?.details));

// ------------------------------------------------ LT-210, LT-278 live table
await page.evaluate(() => {
  const emit = (e) => window.__cvEmit("coreview://crawl", e);
  emit({ kind: "started", seed: "192.0.2.10" });
  emit({ kind: "queued", address: "192.0.2.10", hops: 0 });
  emit({ kind: "visiting", address: "192.0.2.10", hops: 0 });
  emit({ kind: "ssh", progress: { kind: "ready", host: "192.0.2.10", hostname: "CORE-SW1" } });
  emit({ kind: "ssh", progress: { kind: "running", host: "192.0.2.10", command: "show spanning-tree" } });
  emit({ kind: "queued", address: "192.0.2.11", hops: 1 });
  emit({ kind: "queued", address: "192.0.2.12", hops: 1 });
  emit({ kind: "visiting", address: "192.0.2.11", hops: 1 });
  emit({ kind: "ssh", progress: { kind: "awaitingSecondFactor", host: "192.0.2.11", message: "Approve the sign-in on your phone" } });
  emit({ kind: "visiting", address: "192.0.2.12", hops: 1 });
  emit({ kind: "retrying", address: "192.0.2.12", attempt: 1 });
  emit({ kind: "failed", failure: { address: "192.0.2.12", reason: "192.0.2.12 did not answer within 8s", kind: "unreachable" } });
});
await page.waitForTimeout(300);
const live = page.locator(".cv-crawl-table tbody tr");
const liveRows = await live.evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent).join("|")));
check("the live table has a row per device with where it is", JSON.stringify(liveRows) === JSON.stringify([
  "192.0.2.10|CORE-SW1|0|Collecting|show spanning-tree",
  "192.0.2.11||1|Waiting for approval|Approve the sign-in on your phone",
  "192.0.2.12||1|Failed|192.0.2.12 did not answer within 8s",
]), JSON.stringify(liveRows));
check("a pending push factor is announced — it never was (LT-278)",
  (await panel.locator(".cv-discover-push").textContent()) === "Approve the sign-in on your phone");
check("and a failure reaches the status line", /192\.0\.2\.12 could not be reached/.test(await panel.locator(".cv-discover-status").textContent()));
await page.evaluate((r) => window.__cvEmit("coreview://crawl-result", r), crawlResult);
await page.waitForTimeout(800);
// LT-424: the run is written by Rust as it goes, so the page no longer sends
// the result back; what it sends is which project the run belongs to.
const noSaveCall = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "save_crawl_run").length);
check("every crawl is kept, by the crawl itself rather than by the page (LT-227, LT-424)",
  started?.input?.projectId === "crawling" && noSaveCall === 0, JSON.stringify({ projectId: started?.input?.projectId, noSaveCall }));
// -------------------------------------------------------- LT-213 findings
// LT-444 put a Details button on each finding; the finding is the text without it.
const findings = await panel.locator(".cv-findings li").evaluateAll((lis) => lis.map((li) => [li.dataset.kind, Array.from(li.childNodes).filter((n) => n.nodeName !== "BUTTON").map((n) => n.textContent).join("").trim()]));
check("the result lists what is wrong", JSON.stringify(findings) === JSON.stringify([
  ["unidentified", "Unidentified link CORE-SW1 Gi0/1 is an up trunk with no neighbour reporting on it."],
  // CORE-SW1 has two silent devices on it since LT-464's fixture, so it is no orphan.
  ["orphan", "Orphan EDGE-RTR1 was reached but has no link to anything the crawl found."],
]), JSON.stringify(findings));
// ------------------------------------------------- LT-464 the attached, listed
{
  const attached = panel.locator(".cv-attached");
  check("the silent devices are counted", /2 more devices were seen on switch ports/.test(await attached.locator("summary").textContent()));
  await attached.locator("summary").click();
  await page.waitForTimeout(150);
  const rowsOf = () => attached.locator(".cv-attached-list tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent).join("|")));
  check("and listed, with what the crawl learned about each, addresses first", JSON.stringify(await rowsOf()) === JSON.stringify([
    "192.0.2.31|0000.5e00.5311|Example Cameras||192.0.2.0/24|CORE-SW1|Gi0/6|20",
    "192.0.2.40|0000.5e00.5310|Example Printers|PRN-1|192.0.2.0/24|CORE-SW1|Gi0/5|10",
  ]), JSON.stringify(await rowsOf()));
  await attached.locator(".cv-th-sort", { hasText: "Port" }).click();
  check("a heading sorts its column", (await rowsOf())[0].includes("Gi0/5"), JSON.stringify(await rowsOf()));
  await attached.locator(".cv-th-sort", { hasText: "Port" }).click();
  check("and again the other way", (await rowsOf())[0].includes("Gi0/6"), JSON.stringify(await rowsOf()));
  // LT-592: open, they are listed and not added; ticked, they are added.
  const addNow = async () => page.locator("button").filter({ hasText: /to diagram$/ }).last().innerText();
  check("opening the list does not add them", !/\+ 2/.test(await addNow()), await addNow());
  await attached.locator('[data-field="add-attached"] input').check();
  await page.waitForTimeout(150);
  check("the tick adds them", /\+ 2 to diagram/.test(await addNow()), await addNow());
  await attached.locator('[data-field="add-attached"] input').uncheck();
  await page.waitForTimeout(150);
  // Closed again, so nothing below draws them.
  await attached.locator("summary").click();
  await page.waitForTimeout(150);
}
// LT-215: with Physical and Logical views on the page, a layer-3 hop between
// crawled devices is drawn on the Logical one.
// ------------------------------------------------- LT-333 choose by role
// Both devices in this crawl are infrastructure, so the count is the check
// that the button is reading the rows rather than showing a constant.
const infra = panel.locator("button").filter({ hasText: /^Infrastructure only \(\d+\)$/ });
check("the review offers a choice by role", (await infra.count()) === 1);
check("and says how many it would tick", /Infrastructure only \(2\)/.test(await infra.first().innerText()),
  await infra.first().innerText());
const selectAll = panel.locator("button").filter({ hasText: /^Select all \d+$/ });
check("and Select all says how many that is too", (await selectAll.count()) === 1,
  (await selectAll.count()) ? await selectAll.first().innerText() : "missing");
await panel.locator("button", { hasText: "Select none" }).first().click();
await page.waitForTimeout(250);
await infra.first().click();
await page.waitForTimeout(250);
const addLabel = await page.locator("button").filter({ hasText: /to diagram$/ }).last().innerText();
check("choosing by role ticks the infrastructure rows", /Add 2\b/.test(addLabel), addLabel);

await page.evaluate(() => window.__cvStore.getState().addStandardLayers());
await page.locator("button").filter({ hasText: /^Add .* to diagram$/ }).last().click();
await page.waitForTimeout(500);
// ---------------------------------------------------------- LT-216 review
const review = page.locator(".cv-reconcile");
check("the crawl's changes are listed for review before anything is drawn",
  (await review.count()) === 1 && await page.evaluate(() => !window.__cvStore.getState().doc.pages[0].nodes.some((n) => n.data.label === "CORE-SW1")));
const groups = await review.locator("h4").allTextContents();
check("grouped as new and changed", groups.join("|") === "New|Changed", groups.join("|"));
const items = await review.locator("li").evaluateAll((lis) => lis.map((li) => [li.querySelector("input").checked, li.querySelector(".cv-reconcile-title").textContent]));
check("with additions and updates ticked", JSON.stringify(items) === JSON.stringify([[true, "CORE-SW1"], [true, "EDGE-FW"]]), JSON.stringify(items));
const undoDepth = await page.evaluate(() => window.__cvStore.getState().past.length);
await review.locator("button", { hasText: /^Apply 2 changes$/ }).click();
await page.waitForTimeout(600);
check("applying them is one undo step", await page.evaluate((d) => window.__cvStore.getState().past.length === d + 1, undoDepth));
const inv = await page.evaluate(() => window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.data.label === "CORE-SW1")?.data.inventory);
check("the device on the diagram carries what the crawl read", inv?.ports?.length === 3 && inv.routes.length === 2 &&
  inv.uptimeSeconds === 5019180 && inv.spanningTree[0].blocked[0] === "Gi0/2", JSON.stringify(inv)?.slice(0, 200));

const l3 = await page.evaluate(() => {
  const pg = window.__cvStore.getState().doc.pages[0];
  const logical = pg.canvas.layers.find((l) => l.name === "Logical").id;
  const name = (id) => pg.nodes.find((n) => n.id === id)?.data.label;
  return pg.edges.filter((e) => e.data.layer3).map((e) => ({ from: name(e.source), to: name(e.target), onLogical: e.data.layers?.[0] === logical, dashed: e.data.lineStyle }));
});
check("a layer-3 hop between crawled devices is drawn on the Logical view (LT-215)",
  // CORE-SW1's default route and EDGE-RTR1's static route point at each
  // other; EDGE-RTR1 answers on 192.0.2.1, which is the EDGE-FW already drawn.
  JSON.stringify(l3) === JSON.stringify([{ from: "CORE-SW1", to: "EDGE-FW", onLogical: true, dashed: "dashed" }]), JSON.stringify(l3));
await page.evaluate(() => {
  const s = window.__cvStore.getState();
  const n = s.doc.pages[0].nodes.find((n) => n.data.label === "CORE-SW1");
  s.select(n.id, null);
});
await page.waitForTimeout(400);
await inspectorTab("Identity");
check("its reverse DNS name is on it (LT-206)", (await page.locator(".cv-inspector .cv-field", { hasText: "DNS name" }).locator("input").inputValue()) === "core-sw1.example.test");
const section = page.locator(".cv-inspector .cv-inventory");
check("its inspector shows it", (await section.count()) === 1 && /up 58d 2h/.test(await section.textContent()),
  (await section.textContent())?.slice(0, 120));
const summaries = await section.locator("summary").allTextContents();
check("ports, VLANs, spanning tree and routes, each summarised", summaries.join(" | ") ===
  "Ports 2/3 connected | VLANs 2 | Spanning tree root for 1 of 2 · 1 with blocked ports | Routes 2", summaries.join(" | "));
await section.locator("summary", { hasText: /^Ports/ }).click();
const rows = await section.locator("table").first().locator("tbody tr").allTextContents();
check("a trunk shows its native VLAN and an access port its VLAN", rows[0].includes("trunk (native 1)") && rows[2].includes("10") && rows[2].includes("desk 12"),
  JSON.stringify(rows));
check("with trunk VLANs compressed", (await section.locator("td[title]").first().getAttribute("title")) === "Trunk VLANs 1,10-12");

// ------------------------------------------------ LT-576 the collector path
await page.locator("button", { hasText: "Discover devices" }).first().click();
await page.waitForTimeout(300);
await page.evaluate(() => window.__cvEmit("coreview://crawl", { kind: "finished", reached: 0, failed: 0, cancelled: false }));
await page.waitForTimeout(200);
await panel.locator('[data-field="discover-engine"]').selectOption("collector");
await panel.locator("label", { hasText: "Seed devices" }).locator("input").first().fill("192.0.2.10");
// LT-598: the REST side, as the Collect tab has it.
await panel.locator(".cv-discover-run select").filter({ has: page.locator('option[value="cred-api"]') }).selectOption("cred-api");
await panel.locator("button", { hasText: /^Discover$/ }).click();
await page.waitForTimeout(400);
const collected = await lastCall("start_collection");
check("the API login chosen on the panel travels with the run", collected?.input?.apiCredentialId === "cred-api", JSON.stringify(collected?.input));
check("the collector starts from the seed and follows neighbours within the panel's limits",
  collected?.input?.targets === "192.0.2.10" && collected?.input?.follow?.maxHops >= 1 && collected?.input?.follow?.maxDevices === 500 && !collected?.input?.planOnly,
  JSON.stringify(collected?.input));
check("and no crawl is started beside it", (await page.evaluate(() => window.__calls.filter((c) => c.cmd === "start_crawl").length)) === 1);
await page.evaluate(() => {
  window.__cvEmit("coreview://collection", { kind: "started", runId: "col-9", targets: 1 });
  window.__cvEmit("coreview://collection", { kind: "device", runId: "col-9", deviceId: "dev-192-0-2-10", host: "192.0.2.10", phase: "connecting" });
});
await page.waitForTimeout(200);
check("its progress is shown", /Collecting 192\.0\.2\.10/.test(await panel.textContent()));
// LT-588: the last command a device answered, so a stall says where.
await page.evaluate(() => window.__cvEmit("coreview://collection", { kind: "step", runId: "col-9", deviceId: "dev-192-0-2-10", stepId: "show_version", cmd: "show version", status: "ok", rows: 1, durationMs: 40, context: null }));
await page.waitForTimeout(200);
check("and the last command the device answered", /Collecting 192\.0\.2\.10 — last answered: show version/.test(await panel.textContent()));
// LT-589: Stop is the collector's own.
await panel.locator("button", { hasText: /^Stop$/ }).click();
await page.waitForTimeout(200);
check("Stop asks the collection to stop, not the classic crawl", (await lastCall("cancel_collection")) !== undefined || (await page.evaluate(() => window.__calls.some((c) => c.cmd === "cancel_collection"))));
// LT-620: the controls only the classic crawler reads are off under the collector, and say so.
check("the classic-only controls are disabled under the collector", await panel.locator("label", { hasText: "At once" }).locator("select").isDisabled() && await panel.locator(".cv-login-classes button").first().isDisabled() && (await panel.locator('[data-region="discover-engine-note"]').count()) === 1);
// LT-619: the run outlives the panel — another tab, and back.
await page.locator(".cv-panel .cv-tabs button", { hasText: "Collect" }).click();
await page.waitForTimeout(300);
await page.evaluate(() => window.__cvEmit("coreview://collection", { kind: "device", runId: "col-9", deviceId: "dev-192-0-2-11", host: "192.0.2.11", phase: "connecting" }));
await page.locator(".cv-panel .cv-tabs button", { hasText: "Discover devices" }).first().click();
await page.waitForTimeout(400);
check("after a tab change the run is still shown as running, with its latest progress", (await panel.locator("button", { hasText: /^Stop$/ }).count()) === 1 && /Collecting 192\.0\.2\.11/.test(await panel.textContent()));
// LT-621: a device that failed is listed with why.
await page.evaluate(() => window.__cvEmit("coreview://collection", { kind: "deviceDone", runId: "col-9", deviceId: "dev-192-0-2-11", host: "192.0.2.11", os: null, failure: "auth", commands: 0 }));
await page.waitForTimeout(100);
await page.evaluate(() => window.__cvEmit("coreview://collection", { kind: "finished", runId: "col-9", devices: 2, failed: 1, cancelled: false }));
await page.waitForTimeout(500);
const topo = await lastCall("collection_topology");
check("when it finishes, the topology of that run is built", topo?.runId === "col-9", JSON.stringify(topo));
check("and what it found fills the table the review reads", (await panel.locator("tr", { hasText: "SW-COLLECTED" }).count()) >= 1);
check("with a status naming the run", /Collected 2 devices, 1 failed — collection run col-9/.test(await panel.textContent()));
check("and the device that failed, with the reason", /192\.0\.2\.11/.test(await panel.textContent()) && /login was refused/.test(await panel.textContent()));

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
