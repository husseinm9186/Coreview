// Drives the Meraki tab through the real path (LT-404, LT-405, LT-406).
//
// There is no Meraki key on this machine and no Dashboard to talk to, so the
// Tauri bridge is stubbed and the backend's answers handed back the way Rust
// hands them back. Everything above the stub is the real application: the real
// Settings screen, the real pickers, the real report.
//
// This is the check that catches the failure this feature is most likely to
// have — a tab that renders and never calls anything, or calls with the wrong
// argument names and silently shows nothing. The unit tests cannot see that.
//
//     npm run dev            # in another terminal
//     node e2e/meraki.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const project = {
  meta: { id: "mk", name: "Meraki", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: { nodes: [], edges: [], probes: [], canvas: {} },
};

// Invented throughout (D-027): the shapes are Meraki's, the values are not.
const credentials = [
  { id: "cred-ssh", label: "Core switches", kind: "ssh", username: "admin", detail: "", hasSecondSecret: false },
  { id: "cred-meraki", label: "Example Dashboard key", kind: "meraki", username: "", detail: "", hasSecondSecret: false },
];

const organizations = [
  { id: "111", name: "Example Group", url: null },
  { id: "222", name: "Second Customer", url: null },
];

const networks = {
  111: [
    { id: "N_1", name: "Head Office", productTypes: ["appliance", "switch", "wireless"], organizationId: "111", timeZone: null, tags: [] },
    { id: "N_2", name: "Branch", productTypes: ["appliance"], organizationId: "111", timeZone: null, tags: [] },
  ],
  222: [],
};

const profiles = [
  { id: "smb", label: "Small business", summary: "Only faults that affect service count as actions.",
    thresholds: { latencyMs: 250, lossPct: 3, chanUtilPct: 65, nonWifiPct: 30, wifiFailPct: 15, clientFailCount: 5, licenceDays: 30, stpEventCount: 20 },
    defaultSeverity: "advisory", actions: ["uplink.down"] },
  { id: "regulated", label: "High security", summary: "Every gap counts as an action.",
    thresholds: { latencyMs: 120, lossPct: 1, chanUtilPct: 45, nonWifiPct: 20, wifiFailPct: 5, clientFailCount: 3, licenceDays: 90, stpEventCount: 8 },
    defaultSeverity: "action", actions: ["uplink.down", "ids.not_prevention"] },
];

const report = (profileId) => ({
  takenAt: "2026-09-23T10:15:00Z",
  organization: "Example Group",
  network: "Head Office",
  profile: profiles.find((p) => p.id === profileId) ?? profiles[0],
  dataWindows: "settings as they are now; clients over 24 hours; security events over 7 days.",
  checks: [
    { id: "device-status", num: "1.1", title: "Device status", navigation: "Organization › Overview",
      status: "attention", summary: "1 device of 3 not online.", observations: [],
      details: [{ label: "Devices not online", columns: ["Kind", "Name"], rows: [["switch", "Closet B"]] }],
      action: "Check power and upstream connectivity.", findings: [{ code: "device.switch_offline", severity: "action" }] },
    { id: "threat-protection", num: "2.1", title: "Threat protection", navigation: "Security & SD-WAN › Threat protection",
      status: profileId === "regulated" ? "attention" : "advisory",
      summary: "IDS is in detection mode.", observations: [], details: [], action: null,
      findings: [{ code: "ids.not_prevention", severity: profileId === "regulated" ? "action" : "advisory" }] },
    { id: "content-filtering", num: "2.4", title: "Content filtering", navigation: "Security & SD-WAN › Content filtering",
      status: "manual", summary: "Content filtering was not returned.", observations: [], details: [],
      action: "Not returned by the API for this network — the dashboard page named above shows it.", findings: [] },
    { id: "wireless-health", num: "5.1", title: "Wireless health", navigation: "Wireless › Wireless health",
      status: "pass", summary: "2.0% of connection attempts failed.", observations: [], details: [], action: null, findings: [] },
  ],
});

const calls = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
await page.addInitScript(({ p, creds, orgs, nets, profs, rep }) => {
  localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
  window.__cvCalls = [];
  const listeners = {}, callbacks = {};
  let next = 1;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const id = next++; callbacks[id] = cb; return id; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") { listeners[args.event] = args.handler; return Promise.resolve(next++); }
      window.__cvCalls.push({ cmd, args });
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "",
        engineer: "", description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project")
        return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({});
      if (cmd === "list_credentials") return Promise.resolve(creds);
      if (cmd === "vault_status") return Promise.resolve({ exists: true, unlocked: true, remembered: false });

      if (cmd === "meraki_profiles") return Promise.resolve(profs);
      if (cmd === "meraki_organizations") {
        // The page must send the id of a vault credential, never a key.
        if (args.credentialId !== "cred-meraki") return Promise.reject("wrong credential");
        return Promise.resolve(orgs);
      }
      if (cmd === "meraki_networks") return Promise.resolve(nets[args.organizationId] ?? []);
      if (cmd === "meraki_backup")
        return Promise.resolve({ path: "/backups/Meraki-Example-Group/2026-09-23.json",
          networks: (args.networkIds ?? []).length, read: 9, asked: 10 });
      if (cmd === "meraki_health_check") return Promise.resolve(rep(args.profile));
      return Promise.resolve([]);
    },
  };
}, { p: project, creds: credentials, orgs: organizations, nets: networks, profs: profiles,
     rep: (id) => id });

// The stub above cannot hold a function, so the report is built here instead.
await page.addInitScript((built) => {
  const inner = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
    if (cmd === "meraki_health_check") {
      window.__cvCalls.push({ cmd, args });
      return Promise.resolve(built[args.profile] ?? built.smb);
    }
    return inner(cmd, args);
  };
}, { smb: report("smb"), regulated: report("regulated") });

await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(700);

// Tools › Settings — where he looked for it.
await page.locator("button", { hasText: "Tools" }).first().click();
await page.waitForTimeout(400);
await page.locator("button", { hasText: "Settings" }).first().click();
await page.waitForTimeout(500);

const meraki = page.locator(".cv-meraki");
check("Meraki is on the Settings screen", (await meraki.count()) === 1);

// Only the Meraki key is offered — an SSH password must never be sendable to
// api.meraki.com, and the first guard against that is not offering it.
const keyOptions = await meraki.locator("select").first().locator("option").allTextContents();
check("only Meraki keys are offered as the key",
  keyOptions.length === 1 && /Example Dashboard key/.test(keyOptions[0]),
  JSON.stringify(keyOptions));

await meraki.locator("button", { hasText: "Connect" }).first().click();
await page.waitForTimeout(600);

const customerOptions = await meraki.locator("select").nth(1).locator("option").allTextContents();
check("the customers come back from the key and are picked, not typed",
  customerOptions.join(" ").includes("Example Group") && customerOptions.join(" ").includes("Second Customer"),
  JSON.stringify(customerOptions));

await meraki.locator("select").nth(1).selectOption("111");
await page.waitForTimeout(600);

const networkOptions = await meraki.locator("select").nth(2).locator("option").allTextContents();
check("choosing a customer loads its networks",
  networkOptions.join(" ").includes("Head Office") && networkOptions.join(" ").includes("Branch"),
  JSON.stringify(networkOptions));

// The backup, over the whole customer when no single network is chosen.
await meraki.locator("button", { hasText: "Back up configuration" }).first().click();
await page.waitForTimeout(600);
const note = await meraki.locator(".cv-saved-note").first().innerText().catch(() => "");
check("a backup says where it was written", /Meraki-Example-Group/.test(note), note);
check("and says so when the key could not read everything", /9 of 10/.test(note), note);

await meraki.locator("select").nth(2).selectOption("N_1");
await page.waitForTimeout(300);
await meraki.locator("button", { hasText: "Run health check" }).first().click();
await page.waitForTimeout(700);

const reportView = page.locator(".cv-meraki-report");
check("the health check renders on screen", (await reportView.count()) === 1);

const tiles = await reportView.locator(".cv-meraki-tile").allTextContents();
check("every verdict is counted, including the ones with none",
  tiles.length === 5 && tiles.join(" ").includes("Not reported"), JSON.stringify(tiles));

// Ranked: attention first. The order is the point of the report.
const titles = await reportView.locator(".cv-meraki-check-title").allTextContents();
check("what needs attention is at the top", titles[0] === "Device status", JSON.stringify(titles));

const actionRows = await reportView.locator(".cv-meraki-actions tbody tr").count();
check("only actions are in the action items table", actionRows === 1, `${actionRows} rows`);

// An advisory is still reported, with its evidence — ranked, not hidden.
check("an advisory is still shown", titles.includes("Threat protection"), JSON.stringify(titles));

// Evidence opens.
await reportView.locator(".cv-meraki-check-head", { hasText: "Device status" }).first().click();
await page.waitForTimeout(300);
const evidence = await reportView.locator(".cv-meraki-check-body table").count();
check("a finding shows the rows it was drawn from", evidence >= 1, `${evidence} tables`);

// The profile changes the grading and nothing else. Same network, read again.
await meraki.locator("select").last().selectOption("regulated");
await page.waitForTimeout(300);
await meraki.locator("button", { hasText: "Run health check" }).first().click();
await page.waitForTimeout(700);

const regulatedRows = await reportView.locator(".cv-meraki-actions tbody tr").count();
check("a stricter profile promotes the same finding to an action",
  regulatedRows === 2, `${regulatedRows} rows under High security`);

const summaries = await reportView.locator(".cv-meraki-summary").allTextContents();
check("and the finding's own words do not change",
  summaries.some((s) => /IDS is in detection mode/.test(s)), JSON.stringify(summaries));

// The key itself must never cross the bridge in either direction.
const sent = await page.evaluate(() => JSON.stringify(window.__cvCalls));
check("no API key is ever sent from the page",
  !/X-Cisco|apiKey|"secret"/.test(sent) && /credentialId/.test(sent));

const merakiCalls = await page.evaluate(() =>
  window.__cvCalls.filter((c) => c.cmd.startsWith("meraki_")).map((c) => c.cmd));
check("the page reached the backend for each step",
  merakiCalls.includes("meraki_organizations") && merakiCalls.includes("meraki_networks")
    && merakiCalls.includes("meraki_backup") && merakiCalls.includes("meraki_health_check"),
  JSON.stringify(merakiCalls));

if (process.argv[2]) await page.screenshot({ path: `${process.argv[2]}/meraki.png`, fullPage: true });
await browser.close();
console.log(failures === 0 ? "\nall Meraki checks passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
