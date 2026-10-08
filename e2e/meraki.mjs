// Drives the Meraki tab through the real path.
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

// Invented throughout: the shapes are Meraki's, the values are not.
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
    { id: "mx-device-status", section: "firewall", num: "1", title: "Device Status and Connectivity",
      navigation: "Security & SD-WAN > Appliance status",
      checklist: ["Uplink status (WAN 1, WAN 2 – online, latency, loss)", "Review Recent Events for reboots or failovers"],
      status: "attention", summary: "1 device of 3 not online.", observations: ["Both are on the same switch."],
      details: [{ label: "Devices not online", columns: ["Kind", "Name"], rows: [["switch", "Closet B"]] }],
      steps: ["Open the appliance status page and select the device reported as down.",
              "Confirm the cable to the modem or ISP handoff is seated."],
      findings: [{ code: "device.switch_offline", severity: "action" }] },
    { id: "mx-threat-protection", section: "firewall", num: "5", title: "Threat Protection Configuration",
      navigation: "Security & SD-WAN > Threat protection",
      checklist: ["Advanced Malware Protection (AMP)", "Intrusion Detection and Prevention (IDS/IPS)"],
      status: profileId === "regulated" ? "attention" : "advisory",
      summary: "IDS is in detection mode.", observations: [], details: [],
      steps: ["Open Security & SD-WAN > Threat protection.", "Set intrusion detection to Prevention."],
      findings: [{ code: "ids.not_prevention", severity: profileId === "regulated" ? "action" : "advisory" }] },
    { id: "mx-content-filtering", section: "firewall", num: "6", title: "Content Filtering",
      navigation: "Security & SD-WAN > Content filtering",
      checklist: ["Ensure appropriate category-based filtering is enabled"],
      status: "manual", summary: "Content filtering was not returned.", observations: [], details: [],
      steps: ["Not returned by the API for this network — the dashboard page named above shows it."], findings: [] },
    { id: "wifi-health", section: "wireless", num: "2", title: "Wireless Health Tool",
      navigation: "Wireless > Wireless Health",
      checklist: ["Client connection failures (authentication, DHCP, DNS)"],
      status: "pass", summary: "2.0% of connection attempts failed.", observations: [], details: [], steps: [], findings: [] },
    { id: "sw-ports", section: "switching", num: "2", title: "Port Status and Utilization",
      navigation: "Switch > Switch ports",
      checklist: ["Errors: CRCs, collisions, STP changes, high utilization"],
      status: "pass", summary: "48 ports across 2 switches reporting normally.",
      observations: [], details: [], steps: [], findings: [] },
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
      if (cmd === "meraki_discover")
        return Promise.resolve({
          links: 1,
          notes: [],
          devices: [
            { hostname: "Core switch", address: "192.0.2.10", probeTarget: "192.0.2.10",
              addresses: [{ ip: "192.0.2.10", interface: null, isManagement: true }],
              class: "switch", platform: "MS120-8", serial: "Q1", version: "MS 15.21",
              neighbors: [{ deviceId: "Front desk AP", shortName: "Front desk AP", serial: "Q2",
                addresses: [], localInterface: "12", remoteInterface: "wired0", platform: null,
                capabilities: [], version: null, class: "unknown", discoveredBy: "lldp",
                vendor: null, chassisId: null }],
              hops: 0, reachedBy: "reported", attached: [], portChannels: [],
              defaultNextHop: null, stack: null, routes: [], spanningTree: [], vlans: [],
              portVlans: [], ports: [], uptimeSeconds: null, counters: [], dnsName: null },
            { hostname: "Front desk AP", address: "", probeTarget: "", addresses: [],
              class: "access-point", platform: "MR46", serial: "Q2", version: null,
              neighbors: [{ deviceId: "Core switch", shortName: "Core switch", serial: "Q1",
                addresses: [], localInterface: "wired0", remoteInterface: "12", platform: null,
                capabilities: [], version: null, class: "unknown", discoveredBy: "lldp",
                vendor: null, chassisId: null }],
              hops: 0, reachedBy: "reported", attached: [], portChannels: [],
              defaultNextHop: null, stack: null, routes: [], spanningTree: [], vlans: [],
              portVlans: [], ports: [], uptimeSeconds: null, counters: [], dnsName: null },
          ],
        });
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

// Tools › Settings — where a user would look for it.
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

// The document's front matter, which an earlier version lacked.
const reportText = await reportView.innerText();
check("the report names the customer, the networks and when it was read",
  /customer/i.test(reportText) && /Example Group/.test(reportText)
    && /networks assessed/i.test(reportText) && /date generated/i.test(reportText),
  reportText.slice(0, 260).replace(/\n/g, " | "));
check("it explains what each verdict means before using them",
  /how to read this report/i.test(reportText) && /checked and healthy/i.test(reportText));
check("it says how many items were assessed", /5 items assessed/.test(reportText), reportText.slice(0, 200));

// Three checklists, not one flat list.
const sections = await reportView.locator(".cv-meraki-section > h4").allTextContents();
check("the items are grouped into the three health check lists",
  sections.length === 3 && sections.join(" ").includes("Firewall (MX)")
    && sections.join(" ").includes("Wireless") && sections.join(" ").includes("Switch"),
  JSON.stringify(sections));

// Ranked within a section: attention first.
const firewallTitles = await reportView.locator(".cv-meraki-section").first()
  .locator(".cv-meraki-check-title").allTextContents();
check("what needs attention is at the top of its section",
  firewallTitles[0] === "Device Status and Connectivity", JSON.stringify(firewallTitles));

const actionRows = await reportView.locator(".cv-meraki-actions").first().locator("tbody tr").count();
check("only actions are in the action items table", actionRows === 1, `${actionRows} rows`);

// And advisories get their own table, rather than being dropped.
const tables = await reportView.locator(".cv-meraki-actions").count();
check("advisories are listed separately rather than hidden", tables === 2, `${tables} summary tables`);
check("an advisory is still shown as an item",
  reportText.includes("Threat Protection Configuration"));

// Each item says where to look and what it covers, before its verdict.
check("every item names where in the dashboard it is",
  (await reportView.locator(".cv-meraki-nav").count()) === 5);

await reportView.locator(".cv-meraki-check-head", { hasText: "Device Status" }).first().click();
await page.waitForTimeout(300);
const body = await reportView.locator(".cv-meraki-check-body").first().innerText();
check("an item shows what it covers", /checklist/i.test(body) && /Uplink status/.test(body));
check("an item shows what was observed", /observed/i.test(body));
check("a finding shows the rows it was drawn from",
  (await reportView.locator(".cv-meraki-check-body table").count()) >= 1);
check("and what to do about it, in numbered steps",
  /recommended action/i.test(body) && (await reportView.locator(".cv-meraki-steps li").count()) >= 2, body.slice(0, 300));

// The tool is not named anywhere in the customer's document.
check("the report never names the tool that made it",
  !/Coreview/i.test(reportText), (reportText.match(/.{0,40}Coreview.{0,40}/i) || [""])[0]);

// The profile changes the grading and nothing else. Same network, read again.
await meraki.locator("select").last().selectOption("regulated");
await page.waitForTimeout(300);
await meraki.locator("button", { hasText: "Run health check" }).first().click();
await page.waitForTimeout(700);

const regulatedRows = await reportView.locator(".cv-meraki-actions").first().locator("tbody tr").count();
check("a stricter profile promotes the same finding to an action",
  regulatedRows === 2, `${regulatedRows} rows under High security`);

const summaries = await reportView.locator(".cv-meraki-summary").allTextContents();
check("and the finding's own words do not change",
  summaries.some((s) => /IDS is in detection mode/.test(s)), JSON.stringify(summaries));

// The estate onto the diagram, the same way everything else lands.
await meraki.locator("button", { hasText: "Add to diagram" }).first().click();
await page.waitForTimeout(900);
const placedNote = await meraki.locator(".cv-saved-note").first().innerText().catch(() => "");
check("a Meraki estate can be placed on the diagram",
  /Placed 2 devices/.test(placedNote), placedNote);

await page.locator("button", { hasText: "Back to the diagram" }).first().click();
await page.waitForTimeout(700);
const nodeLabels = await page.locator(".react-flow__node").allTextContents();
check("the devices are really on the canvas, not just counted",
  nodeLabels.join(" ").includes("Core switch") && nodeLabels.join(" ").includes("Front desk AP"),
  JSON.stringify(nodeLabels));
check("and the link the estate reported is drawn between them",
  (await page.locator(".react-flow__edge").count()) >= 1);

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
