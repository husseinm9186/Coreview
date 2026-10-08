// Discover as a mode — the crawl form in four steps (where to start,
// how to log in, what to read and keep, Advanced), the engine's own view (the
// old Collect tab) folded under Advanced, Ping sweep as Discover's second tab,
// and the Discover button at the end. Stubbed backend; nothing is sent.
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const project = {
  meta: { id: "discovermode", name: "Discover mode", customer: "", site: "", ticket: "", engineer: "", description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: { nodes: [], edges: [], probes: [], canvas: {} },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.addInitScript(({ p }) => {
  localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
  localStorage.setItem("coreview.view.panelOpen", "1");
  let next = 1;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return next++; },
    invoke(cmd) {
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "", engineer: "", description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({});
      if (cmd === "list_collection_runs" || cmd === "list_crawl_runs" || cmd === "list_credentials") return Promise.resolve([]);
      // The sweep's subnet list asks what a subnet holds; an array back is not an answer.
      if (cmd === "describe_subnet") return Promise.resolve({ network: "192.0.2.0", broadcast: "192.0.2.255", prefix: 24, hosts: 254 });
      return Promise.resolve([]);
    },
  };
}, { p: project });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(700);

const st = (fn, arg) => page.evaluate(fn, arg);
const step = (name) => page.locator(`.cv-step[data-step="${name}"]`);
const labelsIn = async (name) => (await step(name).locator("label > span, legend, .cv-subnets-label").allTextContents()).map((s) => s.trim());

// ------------------------------------------------------------- the mode

const discoverTabs = page.locator('.cv-tab-group[data-group="discover"] button[role="tab"]');
check("Discover's dock group is Discover devices and Ping sweep, in that order",
  JSON.stringify(await discoverTabs.allInnerTexts()) === JSON.stringify(["Discover devices", "Ping sweep"]), (await discoverTabs.allInnerTexts()).join(" | "));
check("and no Collect tab", (await page.locator('.cv-panel button[role="tab"]', { hasText: /^Collect$/ }).count()) === 0);
await page.locator(".cv-nav-item", { hasText: /^Discover$/ }).click();
await page.waitForTimeout(400);
check("the rail's Discover opens Discover devices", (await st(() => window.__cvStore.getState().dockTab)) === "crawl");
const form = page.locator(".cv-discover");
check("with the form", (await form.count()) === 1);

// ------------------------------------------------------------- four steps

const heads = await form.locator(".cv-step-head").allInnerTexts();
check("the form is four numbered steps",
  JSON.stringify(heads.map((h) => h.replace(/\s+/g, " ").trim())) === JSON.stringify(["1 Where to start", "2 How to log in", "3 What to read and keep", "4 Advanced"]), heads.join(" | "));
const seeds = await labelsIn("seeds");
check("1 holds the seeds, how far, and what to log in to",
  ["Seed devices", "Hops", "Probe address", "Stay inside these subnets", "Log in to"].every((l) => seeds.includes(l)), seeds.join(", "));
check("and the From CSV and Fill from this project buttons",
  (await step("seeds").locator("label.cv-seed-csv").count()) === 1 && (await step("seeds").locator("button.cv-fill-from-project").count()) === 1);
const logins = await labelsIn("logins");
check("2 holds the login, the port and the transport",
  ["Username", "Password", "Enable", "Port", "Reach devices over"].every((l) => logins.includes(l)), logins.join(", "));
check("the second login, the rules and SNMP",
  (await step("logins").locator("details.cv-backup-creds").count()) === 1 && (await step("logins").locator(".cv-cred-rules").count()) === 1 && (await step("logins").locator("details.cv-snmp").count()) === 1);
check("and the push-factor tick", (await step("logins").locator("label.cv-check", { hasText: /Duo or another push factor/ }).count()) === 1);
const options = await labelsIn("options");
check("3 holds how hard to push and what else to read",
  ["At once", "Give up after", "Retries", "Also read from each device"].every((l) => options.includes(l)), options.join(", "));
check("and the diagnostic tick", (await step("options").locator("label.cv-support-capture").count()) === 1);
check("the Discover button comes after the steps, not inside one",
  (await form.locator(".cv-discover-run button", { hasText: /^Discover$/ }).count()) === 1 && (await form.locator(".cv-step .cv-discover-run").count()) === 0);
check("and is disabled until there is a seed and a login", await form.locator(".cv-discover-run button", { hasText: /^Discover$/ }).isDisabled());

// ------------------------------------------------------------- Advanced

const adv = page.locator("details.cv-discover-advanced");
check("Advanced starts folded", (await adv.evaluate((el) => el.open)) === false);
check("so the engine choice is out of sight", await page.locator('[data-field="discover-engine"]').isHidden());
await adv.locator("summary").click();
await page.waitForTimeout(300);
check("unfolded, it offers the engine", await page.locator('[data-field="discover-engine"]').isVisible());
check("the collector by default", (await page.locator('[data-field="discover-engine"]').inputValue()) === "collector");
check("a dry run and the SNMP walks", (await adv.locator("button", { hasText: /^Dry run$/ }).count()) === 1 && (await adv.getByLabel("Open SNMP walk files").count()) === 1);
check("and the engine's own view — the old Collect tab", (await adv.locator('[data-region="collect"]').count()) === 1 && (await adv.locator('[data-region="collect-runs"]').count()) === 1);
check("which the store remembers as open", (await st(() => window.__cvStore.getState().discoverAdvanced)) === true);

// ------------------------------------------------------------- every control works with the engine chosen, or says why not

{
  const engine = page.locator('[data-field="discover-engine"]');
  const chip = (label) => step("seeds").locator(".cv-chip", { hasText: new RegExp(`^${label}$`) });
  for (const which of ["collector", "classic"]) {
    await engine.selectOption(which);
    await page.waitForTimeout(200);
    const before = await chip("Servers").getAttribute("aria-pressed");
    await chip("Servers").click();
    await page.waitForTimeout(100);
    check(`${which}: a "Log in to" chip toggles when pressed`, (await chip("Servers").getAttribute("aria-pressed")) !== before && !(await chip("Servers").isDisabled()), `${before} → ${await chip("Servers").getAttribute("aria-pressed")}`);
    await chip("Servers").click();
    await step("logins").locator("select.cv-input", { has: page.locator('option[value="sshThenTelnet"]') }).selectOption("sshThenTelnet");
    await page.waitForTimeout(100);
    check(`${which}: Reach devices over takes a choice, and the telnet warning follows`, (await step("logins").locator("select.cv-input", { has: page.locator('option[value="sshThenTelnet"]') }).inputValue()) === "sshThenTelnet" && (await step("logins").locator(".cv-transport-warning").count()) === 1);
    await step("logins").locator("select.cv-input", { has: page.locator('option[value="sshThenTelnet"]') }).selectOption("ssh");
    const backup = step("logins").locator("details.cv-backup-creds");
    if (!(await backup.evaluate((d) => d.open))) await backup.locator("summary").click();
    await backup.locator("input").first().fill("second-reader");
    check(`${which}: the second login takes a username`, (await backup.locator("input").first().inputValue()) === "second-reader" && !(await backup.locator("input").first().isDisabled()));
    await backup.locator("input").first().fill("");
  }
  await engine.selectOption("collector");
  await page.waitForTimeout(200);
  const push = step("logins").locator("label.cv-check", { hasText: /Duo or another push factor/ });
  check("with the collector the push-factor tick is on, held, and says the collector always logs in one at a time", (await push.locator("input").isChecked()) && (await push.locator("input").isDisabled()) && /one device at a time/.test(await push.locator('[data-region="push-note"]').textContent()));
  check("and the controls that are the classic crawler's say so beside them", /classic crawler/.test(await step("options").locator('[data-region="options-classic-note"]').textContent()));
  await engine.selectOption("classic");
  await page.waitForTimeout(200);
  check("with the classic crawler the push-factor tick is the operator's own", !(await push.locator("input").isDisabled()) && (await push.locator("input").isChecked()) === false);
}


// What used to open the Collect tab opens Discover devices with Advanced unfolded.
await adv.locator("summary").click();
await page.waitForTimeout(200);
check("folded again", (await adv.evaluate((el) => el.open)) === false);
await page.locator('.cv-panel button[role="tab"]', { hasText: "Ping sweep" }).click();
await page.waitForTimeout(200);
check("Ping sweep is Discover's second tab", (await st(() => window.__cvStore.getState().dockTab)) === "discover" && (await page.locator(".cv-discover-form").count()) > 0);
await st(() => window.__cvStore.getState().requestPanelTab("collect"));
await page.waitForTimeout(400);
check("asking for Collect lands on Discover devices", (await st(() => window.__cvStore.getState().dockTab)) === "crawl");
check("with Advanced unfolded", (await adv.evaluate((el) => el.open)) === true && (await adv.locator('[data-region="collect"]').count()) === 1);
check("and the rail still says Discover", (await page.locator(".cv-nav-item.is-current").innerText()) === "Discover");

// The tall dock and the folded state hold across the dock's other tabs.
await page.locator('.cv-panel button[role="tab"]', { hasText: "Monitored objects" }).click();
await page.waitForTimeout(200);
await page.locator('.cv-panel button[role="tab"]', { hasText: "Discover devices" }).click();
await page.waitForTimeout(300);
check("Advanced stays as it was left across a tab change", (await adv.evaluate((el) => el.open)) === true);

await browser.close();
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall discover-mode checks passed");
