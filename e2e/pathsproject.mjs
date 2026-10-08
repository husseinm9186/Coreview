// One question for the four path tools — the destination,
// application, protocol, port and VRF typed once and carried from
// Path-Trace to Tracert, Path check and Where is — and the project screen
// as folders down the left, cards with a health line, samples on the right.
// Stubbed backend; nothing is sent.
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const device = (id, label, x, y, address) => ({
  id, type: "device", position: { x, y }, width: 76, height: 76,
  data: { label, deviceType: "access-switch", tags: [], addresses: [{ id: `${id}-a`, label: "Management", address, isPrimary: true }], locked: false, maintenance: false, showDetails: true },
});
const meta = (id, name, customer, site, ticket, updatedAt, archived = false) =>
  ({ id, name, customer, site, ticket, engineer: "", description: "", createdAt: NOW, updatedAt, archived });

const projects = [
  { meta: meta("p-branch", "Branch 12 refresh", "Example Customer", "Branch 12", "CHG-100", NOW), documentVersion: 1,
    document: { nodes: [device("n1", "SW-A", 0, 0, "192.0.2.10"), device("n2", "SW-B", 0, 300, "192.0.2.11")], edges: [], probes: [], canvas: {} } },
  { meta: meta("p-dc", "Data centre move", "Example Customer", "DC-1", "", NOW - 86400000), documentVersion: 1,
    document: { nodes: [], edges: [], probes: [], canvas: {} } },
  { meta: meta("p-old", "Decommissioned site", "Old Customer", "", "", NOW - 5 * 86400000, true), documentVersion: 1,
    document: { nodes: [], edges: [], probes: [], canvas: {} } },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.addInitScript(({ ps }) => {
  localStorage.setItem("coreview.projects.v1", JSON.stringify(Object.fromEntries(ps.map((p) => [p.meta.id, p]))));
  localStorage.setItem("coreview.view.panelOpen", "1");
  // What the first project's card says: written by the last save on this machine.
  localStorage.setItem("coreview.summary.p-branch", JSON.stringify({ devices: 2, links: 1, pages: 2, healthy: 1, warning: 0, down: 1, unknown: 0, at: Date.now() }));
  let next = 1;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return next++; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      const metas = ps.map((p) => ({ ...p.meta, created_at: p.meta.createdAt, updated_at: p.meta.updatedAt }));
      if (cmd === "list_projects") return Promise.resolve(metas);
      if (cmd === "load_project") { const p = ps.find((x) => x.meta.id === args?.id) ?? ps[0]; return Promise.resolve({ meta: metas.find((m) => m.id === p.meta.id), document_version: 1, document: p.document }); }
      if (cmd === "get_settings") return Promise.resolve({});
      if (cmd === "list_crawl_runs" || cmd === "list_collection_runs" || cmd === "list_credentials") return Promise.resolve([]);
      if (cmd === "describe_subnet") return Promise.resolve({ network: "192.0.2.0", broadcast: "192.0.2.255", prefix: 24, hosts: 254 });
      return Promise.resolve([]);
    },
  };
}, { ps: projects });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(500);

const st = (fn, arg) => page.evaluate(fn, arg);

// ------------------------------------------------------------- the project screen

const side = page.locator('[data-region="project-folders"] .cv-proj-side-item');
check("folders run down the left: All projects, then Archived", (await side.count()) === 2 && (await side.first().innerText()).startsWith("All projects") && (await side.last().innerText()).startsWith("Archived"),
  (await side.allInnerTexts()).join(" | "));
check("All projects is current and counts the live ones", (await side.first().getAttribute("aria-current")) === "true" && /2$/.test(await side.first().innerText()), await side.first().innerText());
const cards = page.locator('[data-region="projects"] .cv-project-card');
check("projects are cards", (await cards.count()) === 2);
const branch = cards.filter({ hasText: "Branch 12 refresh" });
const health = branch.locator('[data-region="project-health"]');
check("a card carries its health line from the last save here", (await health.count()) === 1 && /1 healthy.*0 warning.*1 down.*2 devices.*2 pages/.test(await health.innerText()), await health.innerText().catch(() => "none"));
check("a project never saved on this machine has no line", (await cards.filter({ hasText: "Data centre move" }).locator('[data-region="project-health"]').count()) === 0);
check("the samples are on the right", (await page.locator(".cv-proj-samples .cv-sample").count()) > 0 &&
  (await page.locator(".cv-proj-samples").boundingBox()).x > (await page.locator('[data-region="projects"]').boundingBox()).x);
check("beside the folders on the left", (await page.locator('[data-region="project-folders"]').boundingBox()).x < (await page.locator('[data-region="projects"]').boundingBox()).x);

const search = page.getByLabel("Search projects");
await search.fill("centre");
await page.waitForTimeout(200);
check("search narrows the cards by name", (await cards.count()) === 1 && (await cards.first().innerText()).includes("Data centre move"));
await search.fill("CHG-100");
await page.waitForTimeout(200);
check("or by ticket", (await cards.count()) === 1 && (await cards.first().innerText()).includes("Branch 12"));
await search.fill("nothing-like-it");
await page.waitForTimeout(200);
check("and says when nothing matches", (await page.locator('[data-region="projects"] li', { hasText: "No project matches that." }).count()) === 1);
await search.fill("");
await page.waitForTimeout(200);

await side.last().click();
await page.waitForTimeout(200);
check("Archived shows the archived project", (await cards.count()) === 1 && (await cards.first().innerText()).includes("Decommissioned site"));
check("and ticks Show archived, which still works as before", await page.locator("label", { hasText: "Show archived" }).locator("input").isChecked());
await side.first().click();
await page.waitForTimeout(200);
check("All projects brings the live ones back", (await cards.count()) === 2);

// ------------------------------------------------------------- one question, four answers

await branch.locator(".cv-project-open").click();
await page.waitForTimeout(800);
const tab = (name) => page.locator('.cv-panel button[role="tab"]', { hasText: new RegExp(`^${name}`) });
const field = (scope, label) => page.locator(scope).locator(".cv-field", { has: page.locator(`span:text-is("${label}")`) }).locator("input, select").first();

await tab("Path-Trace").click();
await page.waitForTimeout(400);
await field(".cv-pathtrace", "Destination").fill("192.0.2.11");
await field(".cv-pathtrace", "Application").fill("Customer Portal");
await field(".cv-pathtrace", "Protocol").selectOption("udp");
await field(".cv-pathtrace", "Port").fill("514");
await field(".cv-pathtrace", "VRF").fill("CUST-A");
await page.waitForTimeout(150);
const q = await st(() => window.__cvStore.getState().pathQuestion);
check("the question is kept in one place", q.to === "192.0.2.11" && q.app === "Customer Portal" && q.protocol === "udp" && q.port === "514" && q.vrf === "CUST-A", JSON.stringify(q));
check("Path-Trace offers Measure and Where is beside Trace",
  (await page.locator(".cv-pathtrace .cv-discover-form button", { hasText: /^Measure$/ }).count()) === 1 && (await page.locator(".cv-pathtrace .cv-discover-form button", { hasText: /^Where is$/ }).count()) === 1);

await tab("Tracert").click();
await page.waitForTimeout(300);
check("Tracert asks about the same destination", (await field(".cv-tracert", "To").inputValue()) === "192.0.2.11");
await field(".cv-tracert", "To").fill("192.0.2.10");
await page.waitForTimeout(150);

await tab("Path check").click();
await page.waitForTimeout(300);
const toSelect = page.locator(".cv-path-check label", { hasText: /^To/ }).locator("select");
check("Path check has the drawn device at that address chosen", /SW-A/.test(await toSelect.locator("option:checked").innerText()), await toSelect.locator("option:checked").innerText());
check("and the protocol and port", (await page.locator(".cv-path-check label", { hasText: /^Protocol/ }).locator("select").inputValue()) === "udp" &&
  (await page.locator(".cv-path-check label", { hasText: /^Port/ }).locator("input").inputValue()) === "514");
await toSelect.selectOption({ label: "SW-B (192.0.2.11)" });
await page.waitForTimeout(150);
check("choosing a device there sets the destination for the others", (await st(() => window.__cvStore.getState().pathQuestion.to)) === "192.0.2.11");

await tab("Path-Trace").click();
await page.waitForTimeout(300);
check("which Path-Trace now shows", (await field(".cv-pathtrace", "Destination").inputValue()) === "192.0.2.11");
await page.locator(".cv-pathtrace .cv-discover-form button", { hasText: /^Where is$/ }).click();
await page.waitForTimeout(400);
check("Where is asks about it", (await st(() => window.__cvStore.getState().dockTab)) === "whereis" && (await page.locator(".cv-whereis input.cv-mono").inputValue()) === "192.0.2.11");
await tab("Path-Trace").click();
await page.waitForTimeout(300);
await page.locator(".cv-pathtrace .cv-discover-form button", { hasText: /^Measure$/ }).click();
await page.waitForTimeout(400);
check("Measure goes to Tracert with it", (await st(() => window.__cvStore.getState().dockTab)) === "tracert" && (await field(".cv-tracert", "To").inputValue()) === "192.0.2.11");

await browser.close();
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall paths-and-project checks passed");
