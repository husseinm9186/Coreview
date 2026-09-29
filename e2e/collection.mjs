// LT-517: the Collect tab — the plan preview per device (recognised as,
// each command with its gate, parser and tables; each skip with its
// reason), the command log with status, duration and rows, a kept reply,
// and the tables a run filled. Stubbed backend. Invented names and
// documentation addresses (D-027).
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const project = {
  meta: { id: "collect", name: "Collect", customer: "", site: "", ticket: "", engineer: "", description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: { nodes: [], edges: [], probes: [], canvas: {} },
};
const runs = [
  { id: "col-1", projectId: "collect", seed: "192.0.2.10", startedMs: NOW, finishedMs: NOW + 9000, status: "finished", planOnly: false, diagnosticDir: "/tmp/diag", source: "live", devices: 1 },
  // LT-542: an earlier run to compare with.
  { id: "col-0", projectId: "collect", seed: "192.0.2.10", startedMs: NOW - 86400000, finishedMs: NOW - 86391000, status: "finished", planOnly: false, diagnosticDir: null, source: "live", devices: 1 },
];
// LT-542: what collection_diff answers for col-0 → col-1.
const runDiff = {
  changes: [
    { kind: "device", change: "new", subject: "SW-C", before: "", after: "WS-C2960X-24TS-L" },
    { kind: "link", change: "lost", subject: "SW-A Gi1/0/1 — SW-B Gi1/0/2", before: "cdp, confidence 1.0", after: "" },
    { kind: "route", change: "changed", subject: "SW-A 203.0.113.0/24", before: "S via 198.51.100.9", after: "S via 198.51.100.13" },
  ],
  counts: [
    { kind: "device", new: 1, lost: 0, changed: 0 }, { kind: "link", new: 0, lost: 1, changed: 0 }, { kind: "neighbor", new: 0, lost: 0, changed: 0 },
    { kind: "routing_neighbor", new: 0, lost: 0, changed: 0 }, { kind: "route", new: 0, lost: 0, changed: 1 }, { kind: "overlay", new: 0, lost: 0, changed: 0 },
  ],
};
const detail = {
  run: runs[0],
  devices: [{
    deviceId: "dev-192-0-2-10", host: "192.0.2.10", os: "cisco_ios", role: "switch", caps: ["switching", "cdp", "lldp", "ospf", "routing"], versionText: "Cisco IOS Software", prompt: "SW-A#", contextKind: null, contexts: [], failure: null, log: [],
    plan: {
      steps: [
        { id: "show_version", cmd: "show version", gate: "always", because: [], parser: "textfsm:cisco_ios_show_version", feeds: ["device"], weight: "light", timeout: 30, verified: "lab", context: null, scope: null },
        { id: "show_ip_ospf_neighbor", cmd: "show ip ospf neighbor", gate: "cap.ospf", because: ["cap.ospf"], parser: "textfsm:cisco_ios_show_ip_ospf_neighbor", feeds: ["routing_neighbor"], weight: "light", timeout: 30, verified: "lab", context: null, scope: null },
        { id: "show_running_config", cmd: "show running-config", gate: "always", because: [], parser: "raw", feeds: ["raw_config"], weight: "heavy", timeout: 120, verified: "docs", context: null, scope: null },
      ],
      skipped: [{ id: "show_bgp_all_summary", cmd: "show bgp all summary", reason: "gate `cap.bgp` is not met" }],
    },
    collectedAt: NOW,
  }],
  log: [
    { deviceId: "dev-192-0-2-10", seq: 1, stepId: "show_ip_protocols", cmd: "show ip protocols", kind: "probe", contextKind: null, contextName: null, gate: "", parser: "regex", feeds: [], status: "ok", durationMs: 40, rows: 2, rawRef: "192.0.2.10/001-show-ip-protocols.txt", error: null, verified: null },
    { deviceId: "dev-192-0-2-10", seq: 2, stepId: "show_version", cmd: "show version", kind: "command", contextKind: null, contextName: null, gate: "always", parser: "textfsm:cisco_ios_show_version", feeds: ["device"], status: "ok", durationMs: 120, rows: 1, rawRef: "192.0.2.10/002-show-version.txt", error: null, verified: "lab", shadow: "mismatch", shadowDetail: "row 0 field uptime: \"3 weeks\" vs \"3 weeks, 2 days\"", engine: "sidecar" },
    { deviceId: "dev-192-0-2-10", seq: 3, stepId: "show_ip_ospf_neighbor", cmd: "show ip ospf neighbor", kind: "command", contextKind: null, contextName: null, gate: "cap.ospf", parser: "textfsm:cisco_ios_show_ip_ospf_neighbor", feeds: ["routing_neighbor"], status: "unsupported", durationMs: 30, rows: 0, rawRef: null, error: "rejected by device", verified: "lab" },
  ],
  tables: [["device", 1], ["interface", 0], ["arp", 3], ["routing_neighbor", 0]],
};
const shadowLines = [
  { os: "cisco_ios", cmd: "show ip arp", parser: "textfsm:cisco_ios_show_ip_arp", compared: 12, mismatches: 0, errors: 0, lastDetail: null },
  { os: "cisco_ios", cmd: "show version", parser: "textfsm:cisco_ios_show_version", compared: 3, mismatches: 1, errors: 0, lastDetail: "row 0 field uptime: \"3 weeks\" vs \"3 weeks, 2 days\"" },
];
// LT-527: what collection_topology answers — two switches, one cable seen
// from both ends, the firewall placed by MAC, one finding.
const topology = {
  crawlRunId: "topo-col-1",
  devices: [
    { hostname: "SW-A", address: "192.0.2.10", addresses: [{ ip: "192.0.2.10", interface: null, isManagement: true }], probeTarget: "192.0.2.10", class: "switch", platform: "WS-C2960X-24TS-L", serial: "FAKE0000001", version: "15.2(4)E7", neighbors: [{ deviceId: "SW-B", shortName: "SW-B", addresses: [{ ip: "192.0.2.11", interface: null, isManagement: true }], localInterface: "Gi1/0/1", remoteInterface: "Gi1/0/2", platform: null, capabilities: [], version: null, class: "switch", discoveredBy: "cdp", serial: null, chassisId: null, vendor: null }], hops: 0, reachedBy: "ssh", attached: [{ mac: "000000000301", port: "Gi1/0/5", address: "192.0.2.254", vendor: null, hostname: "FW-1", class: "firewall", portPopulation: 1, vlan: null }], portChannels: [], defaultNextHop: null, stack: null, routes: [], dnsName: null, evidence: {} },
    { hostname: "SW-B", address: "192.0.2.11", addresses: [{ ip: "192.0.2.11", interface: null, isManagement: true }], probeTarget: "192.0.2.11", class: "switch", platform: null, serial: null, version: null, neighbors: [{ deviceId: "SW-A", shortName: "SW-A", addresses: [{ ip: "192.0.2.10", interface: null, isManagement: true }], localInterface: "Gi1/0/2", remoteInterface: "Gi1/0/1", platform: null, capabilities: [], version: null, class: "switch", discoveredBy: "cdp", serial: null, chassisId: null, vendor: null }], hops: 0, reachedBy: "ssh", attached: [], portChannels: [], defaultNextHop: null, stack: null, routes: [], dnsName: null, evidence: {} },
  ],
  notVisited: [],
  graph: {
    nodes: [
      { id: "n-a", name: "SW-A", kind: "collected", os: "cisco_ios", role: "switch", model: null, stack_kind: null, members: [], pair: null, mgmt_ip: "192.0.2.10" },
      { id: "n-b", name: "SW-B", kind: "collected", os: "cisco_ios", role: "switch", model: null, stack_kind: null, members: [], pair: null, mgmt_ip: "192.0.2.11" },
      { id: "n-fw", name: "FW-1", kind: "collected", os: "cisco_asa", role: "firewall", model: null, stack_kind: null, members: [], pair: null, mgmt_ip: "192.0.2.254" },
    ],
    links: [
      { a: { node: "n-a", port: "GigabitEthernet1/0/1" }, b: { node: "n-b", port: "GigabitEthernet1/0/2" }, kind: "cdp", confidence: 1.0, both_directions: true, bundle: null, evidence: [{ device: "dev-a", command: "show_cdp_neighbors_detail", note: "CDP says SW-B on Gi1/0/1 is Gi1/0/2" }, { device: "dev-b", command: "show_cdp_neighbors_detail", note: "CDP says SW-A on Gi1/0/2 is Gi1/0/1" }] },
      { a: { node: "n-a", port: "GigabitEthernet1/0/5" }, b: { node: "n-fw", port: null }, kind: "inferred_mac", confidence: 0.6, both_directions: false, bundle: null, evidence: [{ device: "dev-a", command: "show_mac_address_table", note: "MAC 000000000301 of FW-1 learned on GigabitEthernet1/0/5 (1 MAC on that port); no CDP/LLDP neighbour there" }] },
    ],
    l3: [{ a: "n-a", a_if: "Vlan10", b: "n-fw", b_if: "inside", subnet: "192.0.2.0/24", confirmed_by: [], confidence: 0.4 }],
    overlays: [],
    endpoints: [],
    findings: [{ kind: "bundle_member_unseen", note: "Port-channel1 on SW-A lists 2 members; a neighbour was seen on 1", nodes: ["n-a"] }],
  },
};
const arpRows = [
  { _device: "dev-192-0-2-10", _command: "show_ip_arp", ip: "192.0.2.1", mac: "0000.0000.0001", interface: "Vlan10", age: "0" },
  { _device: "dev-192-0-2-10", _command: "show_ip_arp", ip: "192.0.2.2", mac: "0000.0000.0002", interface: "Vlan10", age: "3" },
  { _device: "dev-192-0-2-10", _command: "show_ip_arp", ip: "192.0.2.3", mac: "0000.0000.0003", interface: "Vlan20", age: "-" },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript(({ p, r, d, a, sh, tp, rd }) => {
  let next = 1;
  window.__calls = [];
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return next++; },
    invoke(cmd, args = {}) {
      window.__calls.push({ cmd, args });
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "", engineer: "", description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve(window.__shadowSetting ? { collectorShadow: "true" } : {});
      if (cmd === "set_setting") { if (args.key === "collectorShadow") window.__shadowSetting = args.value === "true"; return Promise.resolve(); }
      if (cmd === "shadow_report") return Promise.resolve(sh);
      if (cmd === "collection_topology") return Promise.resolve(tp);
      if (cmd === "collection_diff") return Promise.resolve(rd);
      if (cmd === "pick_export_target") return Promise.resolve({ token: "t-diff", path: `/tmp/${args.filename}` });
      if (cmd === "vault_status") return Promise.resolve({ exists: true, unlocked: true, credentials: 1, minimumPassphrase: 12, keptInKeychain: false });
      if (cmd === "list_credentials") return Promise.resolve([
        { id: "cred-ssh", label: "reader", kind: "ssh", username: "reader", detail: "", hasSecondSecret: false },
        // LT-518: an API login, offered only where an API login is asked for.
        { id: "cred-api", label: "fmc reader", kind: "api", username: "reader", detail: "", hasSecondSecret: false },
      ]);
      if (cmd === "list_collection_runs") return Promise.resolve(r);
      if (cmd === "collection_run") return Promise.resolve(d);
      if (cmd === "collection_table") return Promise.resolve(args.table === "arp" ? a : []);
      if (cmd === "collection_raw") return Promise.resolve("Cisco IOS Software, C2960X Software\nnot-a-real-secret was <removed-by-coreview>");
      if (cmd === "start_collection") return Promise.resolve("col-2");
      return Promise.resolve([]);
    },
  };
}, { p: project, r: runs, d: detail, a: arpRows, sh: shadowLines, tp: topology, rd: runDiff });

page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(900);
await page.locator(".cv-panel .cv-tabs button", { hasText: "Collect" }).click();
await page.waitForSelector('[data-region="collect"]');
const region = page.locator('[data-region="collect"]');
check("the Collect tab opens with its help and a run to pick", await region.locator("p.cv-help").first().isVisible() && (await region.locator('[data-region="collect-runs"] select option').count()) === 3);

await region.locator('[data-region="collect-runs"] select').selectOption("col-1");
await page.waitForSelector('[data-region="collect-devices"]');
const deviceRow = region.locator('[data-region="collect-devices"] tbody tr').first();
check("the device row says what it was recognised as and what it can do", (await deviceRow.textContent()).includes("cisco_ios") && (await deviceRow.textContent()).includes("ospf"));

const plan = region.locator('[data-region="collect-plan"]');
check("the plan preview lists each command with its gate, parser and tables", (await plan.locator(":scope > table tbody tr").count()) === 3 && (await plan.textContent()).includes("cap.ospf") && (await plan.textContent()).includes("textfsm:cisco_ios_show_version") && (await plan.textContent()).includes("routing_neighbor"));
check("the plan preview counts what will be sent and what was skipped", (await plan.locator("p.cv-help").textContent()).includes("3 commands will be sent") && (await plan.locator("p.cv-help").textContent()).includes("1 skipped"));
await plan.locator("details summary").click();
check("a skipped command says why", (await plan.locator("details").textContent()).includes("gate `cap.bgp` is not met"));
check("light before heavy in the preview", (await plan.locator(":scope > table tbody tr").nth(2).textContent()).includes("show running-config"));

const log = region.locator('[data-region="collect-log"]');
check("the command log shows status, rows and duration per command", (await log.locator("tbody tr").count()) === 3 && (await log.locator("tbody tr").nth(1).textContent()).includes("120 ms") && (await log.locator("tbody tr").nth(2).textContent()).includes("unsupported"));
check("a failure keeps its reason", (await log.locator("tbody tr").nth(2).textContent()).includes("rejected by device"));
check("a reply that was not kept says so", (await log.locator("tbody tr").nth(2).textContent()).includes("not kept"));
await log.locator("tbody tr").nth(1).getByRole("button", { name: "Show reply" }).click();
await page.waitForSelector('[data-region="collect-raw"]');
check("a kept reply is read from the run's folder by its reference",
  (await region.locator('[data-region="collect-raw"] pre').textContent()).includes("<removed-by-coreview>")
  && (await page.evaluate(() => window.__calls.some((c) => c.cmd === "collection_raw" && c.args.runId === "col-1" && c.args.rawRef === "192.0.2.10/002-show-version.txt"))));

const tables = region.locator('[data-region="collect-tables"]');
check("only tables with rows are offered", (await tables.locator("button").count()) === 2 && (await tables.textContent()).includes("arp · 3 rows"));
await tables.getByRole("button", { name: /^arp/ }).click();
await page.waitForSelector('[data-region="collect-table"]');
check("a table shows its rows by column", (await region.locator('[data-region="collect-table"] tbody tr').count()) === 3 && (await region.locator('[data-region="collect-table"] thead').textContent()).includes("mac"));

// LT-521: shadow mode — the tick is a project setting, the log shows each verdict, the report counts per platform and command.
const shadowTick = region.locator("label.cv-check", { hasText: "Shadow the Rust parser" }).locator("input");
check("the shadow tick starts off", !(await shadowTick.isChecked()));
await shadowTick.check();
await page.waitForFunction(() => window.__calls.some((c) => c.cmd === "set_setting" && c.args.key === "collectorShadow"), null, { timeout: 5000 }).catch(() => {});
check("ticking it stores the project setting", await page.evaluate(() => window.__calls.some((c) => c.cmd === "set_setting" && c.args.key === "collectorShadow" && c.args.value === "true")));
const versionRow = region.locator('[data-region="collect-log"] tbody tr').nth(1);
check("the log shows a mismatch, with what differed on hover", (await versionRow.textContent()).includes("mismatch") && (await versionRow.locator("td[title]").getAttribute("title")).includes("field uptime"));
const report = region.locator('[data-region="collect-shadow"]');
check("the report lists each command both parsers read", (await report.locator("tbody tr").count()) === 2);
check("a command with a mismatch is marked, one with none is not", (await report.locator("tbody tr").nth(1).getAttribute("class")).includes("is-warning") && !((await report.locator("tbody tr").nth(0).getAttribute("class")) ?? "").includes("is-warning"));

// LT-527: the topology — built with the toggles, summarised, its links with evidence, handed to Discover devices.
const topoRegion = region.locator('[data-region="collect-topology"]');
await topoRegion.locator("label.cv-check", { hasText: "Stacks as one node" }).locator("input").uncheck();
await topoRegion.locator("select").selectOption("0.7");
await topoRegion.getByRole("button", { name: "Build topology" }).click();
await page.waitForSelector('[data-region="collect-topology-summary"]');
const built = await page.evaluate(() => window.__calls.find((c) => c.cmd === "collection_topology"));

// LT-548: the built topology written out, three ways.
for (const [label, ext, needle] of [["Export JSON", "json", '"links"'], ["Export CSV", "csv", "a_device,a_port,b_device"], ["Export markdown", "md", "# Topology from collection col-1"]]) {
  await region.locator('[data-region="collect-topology-export"] button', { hasText: label }).click();
  await page.waitForTimeout(200);
  const saved = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "save_export").at(-1)?.args ?? null);
  const target = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "pick_export_target").at(-1)?.args ?? null);
  const body = saved ? Buffer.from(saved.contentsB64, "base64").toString("utf8") : "";
  check(`the topology's ${label} writes a .${ext}`, target?.filename === `topology-col-1.${ext}` && body.includes(needle), `${target?.filename} ${body.slice(0, 80)}`);
}

// LT-542: the selected run against an earlier one.
{
  const diff = region.locator('[data-region="collect-diff"]');
  const against = diff.locator("select");
  check("the comparison offers the earlier run and not the one selected", (await against.locator('option[value="col-0"]').count()) === 1 && (await against.locator('option[value="col-1"]').count()) === 0);
  await against.selectOption("col-0");
  await diff.getByRole("button", { name: "Compare" }).click();
  await page.waitForTimeout(200);
  const asked = await page.evaluate(() => window.__calls.find((c) => c.cmd === "collection_diff")?.args ?? null);
  check("Compare asks for the earlier run against this one", asked?.before === "col-0" && asked?.after === "col-1", JSON.stringify(asked));
  const counts = (await diff.locator('[data-region="collect-diff-counts"]').textContent()) ?? "";
  check("the counts say what changed, kind by kind", counts.includes("device: 1 new, 0 gone, 0 changed") && counts.includes("link: 0 new, 1 gone") && !counts.includes("overlay"), counts);
  const rows = diff.locator('[data-region="collect-diff-table"] tbody tr');
  check("each change is a row, a lost one marked", (await rows.count()) === 3 && ((await rows.nth(1).getAttribute("class")) ?? "").includes("is-warning") && ((await rows.nth(1).textContent()) ?? "").includes("link gone"));
  check("a changed route shows before and after", ((await rows.nth(2).textContent()) ?? "").includes("198.51.100.9") && ((await rows.nth(2).textContent()) ?? "").includes("198.51.100.13"));
  await diff.getByRole("button", { name: "Export markdown" }).click();
  await page.waitForTimeout(200);
  const saved = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "save_export").at(-1)?.args ?? null);
  const body = saved ? Buffer.from(saved.contentsB64, "base64").toString("utf8") : "";
  check("the comparison exports as markdown", body.includes("# Collection runs compared") && body.includes("SW-A Gi1/0/1"), body.slice(0, 120));
}
check("Build topology sends the run and the toggles", !!built && built.args.runId === "col-1" && built.args.options.collapseStacks === false && built.args.options.minConfidence === 0.7 && built.args.options.collapseBundles === true);
check("the summary counts devices, links, both-ended and MAC-placed", (await region.locator('[data-region="collect-topology-summary"]').textContent()).includes("3 devices, 2 links (1 seen from both ends, 1 placed by MAC)"));
check("a finding is shown", (await region.locator('[data-region="collect-topology-findings"]').textContent()).includes("Port-channel1"));
const linkRows = region.locator('[data-region="collect-topology-links"] tbody tr');
check("each link shows its ends, how it was seen and its confidence", (await linkRows.count()) === 2 && (await linkRows.nth(0).textContent()).includes("SW-B") && (await linkRows.nth(0).textContent()).includes("1.0"));
check("a MAC-placed link is marked inferred", ((await linkRows.nth(1).getAttribute("class")) ?? "").includes("is-inferred"));
await linkRows.nth(1).locator("summary").click();
check("its evidence is one click away", (await linkRows.nth(1).textContent()).includes("no CDP/LLDP neighbour there"));
await topoRegion.getByRole("button", { name: "Review and draw" }).click();
await page.waitForTimeout(600);
const crawlPanelText = (await page.locator(".cv-panel").textContent()) ?? "";
check("Review and draw opens Discover devices with the built devices", crawlPanelText.includes("Topology from collection run col-1: 2 devices") && crawlPanelText.includes("SW-A") && crawlPanelText.includes("SW-B"));
await page.locator(".cv-panel .cv-tabs button", { hasText: "Collect" }).click();
await page.waitForSelector('[data-region="collect"]');
await region.locator('[data-region="collect-runs"] select').selectOption("col-1");
await page.waitForSelector('[data-region="collect-log"]');

// Starting a preview sends exactly the declared input, with the saved login and no typed one.
await region.locator("textarea").fill("192.0.2.10\n192.0.2.11");
await region.locator("select", { has: page.locator('option[value="cred-ssh"]') }).first().selectOption("cred-ssh");
// LT-518, LT-541: an API login and the FMC that manages the FTDs.
const apiSelect = region.locator('select[aria-label="API login"]');
check("the API login offers only API logins", (await apiSelect.locator('option[value="cred-api"]').count()) === 1 && (await apiSelect.locator('option[value="cred-ssh"]').count()) === 0);
check("and the SSH login does not offer an API one", (await region.locator('select', { has: page.locator('option[value="cred-ssh"]') }).first().locator('option[value="cred-api"]').count()) === 0);
await apiSelect.selectOption("cred-api");
await region.locator(".cv-field", { has: page.locator('span:text-is("FMC for FTDs")') }).locator("input").fill("192.0.2.5");
await region.getByRole("button", { name: "Preview plan" }).click();
await page.waitForTimeout(200);
const started = await page.evaluate(() => window.__calls.find((c) => c.cmd === "start_collection"));
check("Preview plan sends the input with planOnly and the saved login", !!started && started.args.input.planOnly === true && started.args.input.credentialId === "cred-ssh" && started.args.input.targets.includes("192.0.2.11") && started.args.credentials === undefined);
check("the API login and the FMC travel with the input", !!started && started.args.input.apiCredentialId === "cred-api" && started.args.input.fmcHost === "192.0.2.5");
check("nothing typed travels when a saved login is chosen", !!started && !("password" in (started.args.credentials ?? {})));

await browser.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
