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
const runs = [{ id: "col-1", projectId: "collect", seed: "192.0.2.10", startedMs: NOW, finishedMs: NOW + 9000, status: "finished", planOnly: false, diagnosticDir: "/tmp/diag", source: "live", devices: 1 }];
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
const arpRows = [
  { _device: "dev-192-0-2-10", _command: "show_ip_arp", ip: "192.0.2.1", mac: "0000.0000.0001", interface: "Vlan10", age: "0" },
  { _device: "dev-192-0-2-10", _command: "show_ip_arp", ip: "192.0.2.2", mac: "0000.0000.0002", interface: "Vlan10", age: "3" },
  { _device: "dev-192-0-2-10", _command: "show_ip_arp", ip: "192.0.2.3", mac: "0000.0000.0003", interface: "Vlan20", age: "-" },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript(({ p, r, d, a, sh }) => {
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
      if (cmd === "vault_status") return Promise.resolve({ exists: true, unlocked: true, credentials: 1, minimumPassphrase: 12, keptInKeychain: false });
      if (cmd === "list_credentials") return Promise.resolve([{ id: "cred-ssh", label: "reader", kind: "ssh", username: "reader", detail: "", hasSecondSecret: false }]);
      if (cmd === "list_collection_runs") return Promise.resolve(r);
      if (cmd === "collection_run") return Promise.resolve(d);
      if (cmd === "collection_table") return Promise.resolve(args.table === "arp" ? a : []);
      if (cmd === "collection_raw") return Promise.resolve("Cisco IOS Software, C2960X Software\nnot-a-real-secret was <removed-by-coreview>");
      if (cmd === "start_collection") return Promise.resolve("col-2");
      return Promise.resolve([]);
    },
  };
}, { p: project, r: runs, d: detail, a: arpRows, sh: shadowLines });

page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(900);
await page.locator(".cv-panel .cv-tabs button", { hasText: "Collect" }).click();
await page.waitForSelector('[data-region="collect"]');
const region = page.locator('[data-region="collect"]');
check("the Collect tab opens with its help and a run to pick", await region.locator("p.cv-help").first().isVisible() && (await region.locator('[data-region="collect-runs"] select option').count()) === 2);

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
check("ticking it stores the project setting", await page.evaluate(() => window.__calls.some((c) => c.cmd === "set_setting" && c.args.key === "collectorShadow" && c.args.value === "true")));
const versionRow = region.locator('[data-region="collect-log"] tbody tr').nth(1);
check("the log shows a mismatch, with what differed on hover", (await versionRow.textContent()).includes("mismatch") && (await versionRow.locator("td[title]").getAttribute("title")).includes("field uptime"));
const report = region.locator('[data-region="collect-shadow"]');
check("the report lists each command both parsers read", (await report.locator("tbody tr").count()) === 2);
check("a command with a mismatch is marked, one with none is not", (await report.locator("tbody tr").nth(1).getAttribute("class")).includes("is-warning") && !((await report.locator("tbody tr").nth(0).getAttribute("class")) ?? "").includes("is-warning"));

// Starting a preview sends exactly the declared input, with the saved login and no typed one.
await region.locator("textarea").fill("192.0.2.10\n192.0.2.11");
await region.locator("select", { has: page.locator('option[value="cred-ssh"]') }).first().selectOption("cred-ssh");
await region.getByRole("button", { name: "Preview plan" }).click();
await page.waitForTimeout(200);
const started = await page.evaluate(() => window.__calls.find((c) => c.cmd === "start_collection"));
check("Preview plan sends the input with planOnly and the saved login", !!started && started.args.input.planOnly === true && started.args.input.credentialId === "cred-ssh" && started.args.input.targets.includes("192.0.2.11") && started.args.credentials === undefined);
check("nothing typed travels when a saved login is chosen", !!started && !("password" in (started.args.credentials ?? {})));

await browser.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
