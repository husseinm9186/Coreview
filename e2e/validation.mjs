// Validation and live operations, driven through the real app with the Tauri
// bridge stubbed (Phase 3): UDP, DNS-server and SNMP uptime probes (LT-217,
// LT-219, LT-220), probe templates (LT-222), history sparklines (LT-224), path checks (LT-225) and comparing two
// sessions or two crawls, saved as Markdown or CSV (LT-226–228).
// Invented names, documentation addresses (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/validation.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const dev = (id, label, x, address) => ({
  id, type: "device", position: { x, y: 0 }, width: 76, height: 76,
  data: { label, deviceType: "access-switch", tags: [], locked: false, maintenance: false, showDetails: true,
    addresses: address ? [{ id: `${id}-a`, label: "Management", address, isPrimary: true }] : [] },
});
const project = {
  meta: { id: "validation", name: "Validation", createdAt: NOW, updatedAt: NOW },
  documentVersion: 1,
  document: {
    activePageId: "p1", probes: [],
    pages: [{ id: "p1", name: "P", canvas: { gridEnabled: true, snapEnabled: true, minimap: false, nodeStyle: "glyph" }, edges: [
        { id: "ab", source: "a", target: "b", type: "live", data: { sourcePortLabel: "", targetPortLabel: "", label: "", enabled: true, maintenance: false, healthRule: { type: "manual", manualStatus: "healthy" } } },
        { id: "bc", source: "b", target: "c", type: "live", data: { sourcePortLabel: "", targetPortLabel: "", label: "", enabled: true, maintenance: false, healthRule: { type: "manual", manualStatus: "down" } } },
      ],
      nodes: [dev("a", "SW-A", 0, "192.0.2.10"), dev("b", "SW-B", 200, "192.0.2.11"), dev("c", "SW-C", 400, "192.0.2.12"), dev("d", "NO-ADDR", 600, null)] }],
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
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
      if (cmd === "vault_status") return Promise.resolve({ exists: true, unlocked: true, credentials: 1, minimumPassphrase: 12 });
      if (cmd === "list_credentials") return Promise.resolve([
        { id: "snmp-ro", label: "Read-only SNMP", kind: "snmp", username: "", detail: "", hasSecondSecret: false },
        { id: "ssh-ro", label: "Read-only SSH", kind: "ssh", username: "reader", detail: "", hasSecondSecret: false },
      ]);
      if (cmd === "probe_history") return Promise.resolve(Array.from({ length: 40 }, (_, i) => ({
        timestampMs: 1000 + i * 5000, status: i === 20 ? "down" : "healthy", outcome: i === 20 ? "timeout" : "success", rttMs: i === 20 ? null : 3 + (i % 5),
      })));
      if (cmd === "test_probe_now") return Promise.resolve(args.config.kind === "snmp" ? {
        probe_id: args.config.id, timestamp_ms: 1, outcome: "restarted", rtt_ms: 3, resolved: [],
        summary: "Restarted: up 2m (was 58d 2h)", error_message: null,
      } : { probe_id: args.config.id, timestamp_ms: 1, outcome: "success", rtt_ms: 2, resolved: [], summary: "Connected to port 443, 2 ms", error_message: null });
      if (cmd === "list_sessions") return Promise.resolve([
        { id: "s2", startedAt: 1756100000000, stoppedAt: 1756103600000, samples: 720, transitions: 3 },
        { id: "s1", startedAt: 1756000000000, stoppedAt: 1756003600000, samples: 700, transitions: 0 },
      ]);
      if (cmd === "session_summary") {
        const probe = window.__cvStore.getState().doc.probes.find((x) => x.objectId === "b");
        return Promise.resolve(args.sessionId === "s1"
          ? [{ probeId: probe.id, samples: 700, healthy: 700, warning: 0, down: 0, avgRttMs: 3, p95RttMs: 5 }]
          : [{ probeId: probe.id, samples: 720, healthy: 648, warning: 0, down: 72, avgRttMs: 30, p95RttMs: 80 }]);
      }
      if (cmd === "list_crawl_runs") return Promise.resolve([
        { id: "c2", takenAt: 1756100000000, seed: "192.0.2.10", devices: 1 },
        { id: "c1", takenAt: 1756000000000, seed: "192.0.2.10", devices: 1 },
      ]);
      if (cmd === "crawl_run_result") {
        const d = (version) => ({ hostname: "SW-A", address: "192.0.2.10", addresses: [], probeTarget: "", class: "switch", platform: null, serial: null, version, neighbors: [], hops: 0, reachedBy: "ssh", attached: [] });
        return Promise.resolve({ devices: [d(args.id === "c1" ? "15.2(6)E" : "15.2(7)E")], notVisited: [], failures: [], cancelled: false });
      }
      if (cmd === "plugin:dialog|save") return Promise.resolve("/tmp/coreview-compare.out");
      if (cmd === "save_export") {
        const bytes = Uint8Array.from(atob(args.contentsB64), (c) => c.charCodeAt(0));
        (window.__exports ??= []).push(new TextDecoder().decode(bytes));
        return Promise.resolve(null);
      }
      if (cmd === "ping_from_device") return Promise.resolve({ sent: 3, received: 2, minMs: 1, avgMs: 2, maxMs: 4, output: "" });
      return Promise.resolve([]);
    },
  };
}, { p: project });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(800);

const st = (fn, arg) => page.evaluate(fn, arg);
const select = (id) => st((id) => window.__cvStore.getState().select(id, null), id);
const probes = () => st(() => window.__cvStore.getState().doc.probes);

await select("a");
await page.waitForTimeout(300);
const inspector = page.locator(".cv-inspector");
await inspector.locator("button", { hasText: /^Add probe$/ }).click();
await page.waitForTimeout(300);
const editor = inspector.locator(".cv-probe").first();
const typeSelect = editor.locator(".cv-field", { hasText: /^Type/ }).locator("select");

// ------------------------------------------------------------ LT-217 UDP
await typeSelect.selectOption("udp");
await page.waitForTimeout(150);
check("a probe can check a UDP service", (await editor.locator(".cv-field", { hasText: /^Send/ }).count()) === 1);
check("defaulting to port 53", (await editor.locator(".cv-field", { hasText: /^Port/ }).locator("input").inputValue()) === "53");
await editor.locator(".cv-field", { hasText: /^Send/ }).locator("select").selectOption("ntp");
await editor.locator(".cv-field", { hasText: /^Port/ }).locator("input").fill("123");
let saved = (await probes())[0];
check("with what to send kept on the probe", saved.kind === "udp" && saved.udpPayload === "ntp" && saved.tcpPort === 123, JSON.stringify(saved));
await editor.locator(".cv-field", { hasText: /^Send/ }).locator("select").selectOption("hex");
await editor.locator(".cv-field", { hasText: /^Hex bytes/ }).locator("input").fill("deadbeef");
check("or bytes in hex", (await probes())[0].udpPayload === "deadbeef");

// ----------------------------------------------------- LT-219 DNS server
await typeSelect.selectOption("dns");
await editor.locator(".cv-field", { hasText: /^Ask this server/ }).locator("input").fill("192.0.2.53");
await editor.locator(".cv-field", { hasText: /^Record/ }).locator("select").selectOption("MX");
saved = (await probes())[0];
check("a DNS probe can ask one server for one record type", saved.dnsServer === "192.0.2.53" && saved.dnsRecord === "MX", JSON.stringify(saved));

// ------------------------------------------------------- LT-220 SNMP uptime
await typeSelect.selectOption("snmp");
await page.waitForTimeout(300);
const cred = editor.getByLabel("Saved SNMP credential for this check");
check("an SNMP uptime probe offers the vault's SNMP credentials", (await cred.locator("option").allTextContents()).join("|") === "None|Read-only SNMP");
await cred.selectOption("snmp-ro");
await editor.locator("button", { hasText: /^Test now$/ }).click();
await page.waitForTimeout(300);
const sent = await st(() => window.__calls.filter((c) => c.cmd === "test_probe_now").at(-1)?.args.config);
check("and sends only the credential's id to be tested", sent?.kind === "snmp" && sent?.snmp_credential_id === "snmp-ro" && !JSON.stringify(sent).includes("community"),
  JSON.stringify(sent));
check("a restart reads as reachable, with what happened", /OK — Restarted: up 2m \(was 58d 2h\)/.test(await editor.textContent()));

// ---------------------------------------------------------- LT-222 templates
await editor.locator("button", { hasText: /^Save as template$/ }).click();
await editor.getByLabel("Template name").fill("Core SNMP uptime");
await editor.locator(".cv-probe-template-save button", { hasText: "Save" }).click();
await page.waitForTimeout(200);
const templates = await st(() => window.__cvStore.getState().doc.probeTemplates);
check("a probe saves as a template without its target", templates?.length === 1 && templates[0].name === "Core SNMP uptime" &&
  templates[0].snmpCredentialId === "snmp-ro" && !JSON.stringify(templates).includes("192.0.2.10"), JSON.stringify(templates));

await select("b");
await page.waitForTimeout(300);
await inspector.getByLabel("Add a probe from a template").selectOption({ label: "Core SNMP uptime" });
await page.waitForTimeout(200);
const forB = (await probes()).filter((p) => p.objectId === "b");
check("another device gets it from the template, aimed at its own address", forB.length === 1 && forB[0].target === "192.0.2.11" && forB[0].kind === "snmp",
  JSON.stringify(forB));

await st(() => {
  const s = window.__cvStore.getState();
  s.onNodesChange(["b", "c", "d"].map((id) => ({ type: "select", id, selected: true })));
});
await page.waitForTimeout(300);
const past = await st(() => window.__cvStore.getState().past.length);
await inspector.getByLabel("Add a check from a template to the selection").selectOption({ label: "Core SNMP uptime" });
await page.waitForTimeout(200);
const all = await probes();
check("a selection gets it at once, each device aimed at its own address",
  all.filter((p) => p.name === "Core SNMP uptime" && p.objectId === "c" && p.target === "192.0.2.12").length === 1 &&
  all.filter((p) => p.objectId === "b").length === 2, JSON.stringify(all.map((p) => [p.objectId, p.target])));
check("skipping a device with no address, and saying so",
  !all.some((p) => p.objectId === "d") && /NO-ADDR has no address/.test(await st(() => window.__cvStore.getState().statusMessage ?? "")));
check("as one undo step", await st((n) => window.__cvStore.getState().past.length === n + 1, past));

// ---------------------------------------------------------- LT-224 history
await st(() => {
  const s = window.__cvStore.getState();
  s.onNodesChange(s.doc.pages[0].nodes.map((n) => ({ type: "select", id: n.id, selected: n.id === "b" })));
  s.select("b", null);
});
await page.waitForTimeout(300);
const bProbe = (await probes()).find((p) => p.objectId === "b");
await page.evaluate((id) => {
  const emit = (e) => window.__cvEmit("coreview://engine", e);
  [4, 6, 5, null, 7].forEach((rtt, i) => emit({
    kind: "sample", session_id: "s1", status: rtt === null ? "down" : "healthy",
    result: { probe_id: id, timestamp_ms: 2000 + i, outcome: rtt === null ? "timeout" : "success", rtt_ms: rtt, resolved: [], summary: "", error_message: null },
  }));
}, bProbe.id);
await page.waitForTimeout(300);
const history = inspector.locator(".cv-probe-history").first();
check("a probe shows its live results as a sparkline", (await history.locator("svg.cv-sparkline path.cv-sparkline-line").count()) === 1 &&
  (await history.locator("rect.cv-sparkline-bar").count()) === 5);
check("with availability and the response time range", /5 results · 80% up · 4–7 ms/.test(await history.textContent()), await history.textContent());
await history.getByLabel("History window").selectOption({ label: "24 hours" });
await page.waitForTimeout(300);
const asked = await st(() => window.__calls.filter((c) => c.cmd === "probe_history").at(-1)?.args);
check("and a stored window, asked for by probe and time", asked?.probeId === bProbe.id && asked.sinceMs > Date.now() - 86_400_000 - 60_000, JSON.stringify(asked));
check("drawn the same way", /40 results · 97\.5% up · 3–7 ms/.test(await history.textContent()) &&
  (await history.locator("rect.cv-sparkline-bar.is-down").count()) === 1, await history.textContent());

// ------------------------------------------------------------ LT-225 path check
await page.locator(".cv-panel button", { hasText: /^Path check$/ }).click();
await page.waitForTimeout(300);
const pathPanel = page.locator(".cv-path-check");
await pathPanel.locator("label", { hasText: /^To/ }).locator("select").selectOption({ label: "SW-C (192.0.2.12)" });
await pathPanel.locator("label", { hasText: /^Protocol/ }).locator("select").selectOption("tcp");
await pathPanel.locator("button", { hasText: /^Check$/ }).click();
await page.waitForTimeout(400);
const fromMachine = await st(() => window.__calls.filter((c) => c.cmd === "test_probe_now").at(-1)?.args.config);
check("from this machine, a path check tests the protocol and port", fromMachine?.kind === "tcp" && fromMachine?.tcp_port === 443 && fromMachine?.target === "192.0.2.12",
  JSON.stringify(fromMachine));
check("and says whether it got through", /Reachable\. From this machine to SW-C \(192\.0\.2\.12 TCP 443\): Connected/.test(await pathPanel.locator(".cv-path-result").textContent()));

await pathPanel.locator("label", { hasText: /^From/ }).locator("select").selectOption({ label: "SW-A (192.0.2.10)" });
await page.waitForTimeout(200);
const hops = await pathPanel.locator(".cv-path-hop").allTextContents();
check("from a device, the drawn path between them is shown hop by hop", hops.join(" → ") === "SW-A → SW-B → SW-C", hops.join(" → "));
check("with the first hop that is down named", /Down on the drawing at the link after SW-B/.test(await pathPanel.textContent()), await pathPanel.textContent());
await pathPanel.getByLabel("Saved SSH credential for the source device").selectOption("ssh-ro");
await pathPanel.locator("button", { hasText: /^Check$/ }).click();
await page.waitForTimeout(400);
const fromDevice = await st(() => window.__calls.filter((c) => c.cmd === "ping_from_device").at(-1)?.args);
check("and the device's own ping is asked for, by address and credential id", JSON.stringify(fromDevice) ===
  JSON.stringify({ device: "192.0.2.10", credentialId: "ssh-ro", target: "192.0.2.12", count: 3 }), JSON.stringify(fromDevice));
check("with its result", /Reachable\. SW-A pinged SW-C \(192\.0\.2\.12\): 2 of 3 replies, 2 ms average\./.test(await pathPanel.locator(".cv-path-result").textContent()));

// ------------------------------------------------------- LT-226–228 compare
await page.locator(".cv-panel button", { hasText: /^Compare$/ }).first().click();
await page.waitForTimeout(400);
const cmp = page.locator(".cv-compare");
await cmp.locator("label", { hasText: /^First/ }).locator("select").selectOption({ index: 2 });
await cmp.locator("label", { hasText: /^Second/ }).locator("select").selectOption({ index: 1 });
await cmp.locator("button", { hasText: /^Compare$/ }).click();
await page.waitForTimeout(400);
let cmpRows = await cmp.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent).join("|")));
check("two sessions compared show what got worse, worst first", JSON.stringify(cmpRows) === JSON.stringify([
  "SW-B — Core SNMP uptime|▼ Less available|100%|90%",
  "SW-B — Core SNMP uptime|▼ Slower at the 95th percentile|5 ms|80 ms",
  "SW-B — Core SNMP uptime|▼ Slower on average|3 ms|30 ms",
]), JSON.stringify(cmpRows));
await cmp.locator("button", { hasText: /^Save as Markdown$/ }).click();
await page.waitForTimeout(400);
const md = await page.evaluate(() => (window.__exports ?? []).at(-1) ?? "");
check("and save as Markdown", md.startsWith("# Validation sessions compared") && md.includes("| SW-B — Core SNMP uptime | Less available | 100% | 90% |"), md.slice(0, 200));
await cmp.locator("button", { hasText: /^Crawls$/ }).click();
await page.waitForTimeout(400);
await cmp.locator("label", { hasText: /^First/ }).locator("select").selectOption({ index: 2 });
await cmp.locator("label", { hasText: /^Second/ }).locator("select").selectOption({ index: 1 });
await cmp.locator("button", { hasText: /^Compare$/ }).click();
await page.waitForTimeout(400);
cmpRows = await cmp.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent).join("|")));
check("two crawls compared show firmware that changed", JSON.stringify(cmpRows) === JSON.stringify(["SW-A|Firmware changed|15.2(6)E|15.2(7)E"]), JSON.stringify(cmpRows));
await cmp.locator("button", { hasText: /^Save as CSV$/ }).click();
await page.waitForTimeout(400);
const csvOut = await page.evaluate(() => (window.__exports ?? []).at(-1) ?? "");
check("and save as CSV", csvOut === "What,Change,First,Second\r\nSW-A,Firmware changed,15.2(6)E,15.2(7)E", JSON.stringify(csvOut));

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
