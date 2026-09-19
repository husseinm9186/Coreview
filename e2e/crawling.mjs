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
      neighbors: [], hops: 0, reachedBy: "ssh", attached: [], portChannels: [],
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
await page.addInitScript(({ p }) => {
  const listeners = {}, callbacks = {};
  let next = 1;
  window.__calls = [];
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
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "", engineer: "",
        description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({});
      if (cmd === "start_crawl") return Promise.resolve(null);
      if (cmd === "vault_status") return Promise.resolve({ exists: true, unlocked: true, credentials: 2, minimumPassphrase: 12 });
      if (cmd === "list_credentials") return Promise.resolve([
        { id: "cred-core", label: "Core login", kind: "ssh", username: "reader", detail: "", hasSecondSecret: false },
        { id: "cred-snmp", label: "Read-only SNMP", kind: "snmp", username: "", detail: "", hasSecondSecret: false },
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
const snmpFor = page.getByLabel("Saved SNMP credential for this device");
check("a device's inspector offers the vault's saved credentials", (await snmpFor.locator("option").allTextContents()).join("|") === "None|Read-only SNMP");
await snmpFor.selectOption("cred-snmp");
check("and keeps only the id", await page.evaluate(() =>
  window.__cvStore.getState().doc.pages[0].nodes.find((n) => n.id === "drawn-core").data.snmpCredentialId === "cred-snmp"));

await page.locator("button", { hasText: "Discover devices" }).first().click();
await page.waitForTimeout(400);
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
check("the crawl offers ports and VLANs, spanning tree, routes and reverse DNS, all on", (await tables.count()) === 4 &&
  (await tables.evaluateAll((els) => els.every((e) => e.checked))));
await panel.locator(".cv-crawl-details label", { hasText: "Routing table" }).locator("input").uncheck();
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
check("and sends nothing: no crawl, sweep or lookup is asked for", newCalls.every((c) => c === "list_credentials"), JSON.stringify(newCalls));
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
await panel.locator(".cv-crawl-details label", { hasText: "Routing table" }).locator("input").check();
await panel.locator("label", { hasText: /^Profile/ }).locator("select").selectOption({ label: "Branch sites" });
await page.waitForTimeout(200);
check("choosing a profile puts its settings back",
  (await panel.locator("label", { hasText: "At once" }).locator("select").inputValue()) === "8" &&
  (await panel.locator("label", { hasText: "Seed devices" }).locator("input").first().inputValue()) === "192.0.2.10, 192.0.2.11, 198.51.100.0/30" &&
  !(await panel.locator(".cv-crawl-details label", { hasText: "Routing table" }).locator("input").isChecked()));
await panel.getByLabel("Profile name").fill("Core");
await panel.locator("button", { hasText: /^Save profile$/ }).click();
await panel.getByLabel("Profile name").fill("core");
await panel.locator("button", { hasText: /^Save profile$/ }).click();
const names = await page.evaluate(() => window.__cvStore.getState().doc.crawlProfiles.map((p) => p.name).join(","));
check("saving under a name already used replaces that profile", names === "Branch sites,core", names);
await panel.locator("button", { hasText: /^Delete profile$/ }).click();
check("and a profile can be deleted", await page.evaluate(() => window.__cvStore.getState().doc.crawlProfiles.length) === 1);

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
  JSON.stringify({ routes: false, spanningTree: true, vlans: true }) && started?.input?.reverseDns === true, JSON.stringify(started?.input?.details));

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
const savedRun = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "save_crawl_run").at(-1)?.args);
check("every crawl result is kept, to compare later (LT-227)", savedRun?.projectId === "crawling" && savedRun?.result?.devices?.length === 2 &&
  savedRun?.seed === "192.0.2.10, 192.0.2.11, 198.51.100.0/30", JSON.stringify(savedRun)?.slice(0, 120));
// -------------------------------------------------------- LT-213 findings
const findings = await panel.locator(".cv-findings li").evaluateAll((lis) => lis.map((li) => [li.dataset.kind, li.textContent]));
check("the result lists what is wrong", JSON.stringify(findings) === JSON.stringify([
  ["unidentified", "Unidentified link CORE-SW1 Gi0/1 is an up trunk with no neighbour reporting on it."],
  ["orphan", "Orphan CORE-SW1 was reached but has no link to anything the crawl found."],
  ["orphan", "Orphan EDGE-RTR1 was reached but has no link to anything the crawl found."],
]), JSON.stringify(findings));
// LT-215: with Physical and Logical views on the page, a layer-3 hop between
// crawled devices is drawn on the Logical one.
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

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
