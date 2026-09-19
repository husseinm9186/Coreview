// Checks against a backup run, driven through the real Backups tab (LT-153).
//
// The Tauri bridge is stubbed — deciding pass or fail is Rust and is tested in
// `checks.rs` against real files — and every call is recorded. What is checked
// here is that the panel sends exactly the checks that are ready, against the
// run chosen, and shows what came back in the order that needs attention.
//
// Every name, command and line here is invented for the test (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/checks.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const project = {
  meta: { id: "chk", name: "Checks", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: { nodes: [], edges: [], probes: [], canvas: {} },
};

const RUNS = [
  { stamp: "20260828-120000", devices: 2, kinds: ["running"] },
  { stamp: "20260828-110000", devices: 2, kinds: ["running", "show-commands"] },
  { stamp: "20260828-090000", devices: 2, kinds: ["show-commands"] },
];

// Results the stub gives back, keyed by the check's name, per device.
const ANSWERS = {
  "Default route": [
    { device: "LAB-SW-A", verdict: "pass", line: 3, evidence: "S*    0.0.0.0/0 [1/0] via 192.0.2.254", why: "found `0.0.0.0/0`" },
    { device: "LAB-RTR-B", verdict: "fail", line: null, evidence: null, why: "no line has `0.0.0.0/0`" },
  ],
  "No link flaps": [
    { device: "LAB-SW-A", verdict: "fail", line: 12, evidence: "%LINK-3-UPDOWN: Interface Gi0/1, changed state to down", why: "found `UPDOWN`" },
    { device: "LAB-RTR-B", verdict: "notCaptured", line: null, evidence: null, why: "`show logging` is not in this device's capture" },
  ],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });

await page.addInitScript(({ p, runs, answers }) => {
  if (!localStorage.getItem("coreview.projects.v1")) {
    localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
  }
  let next = 1;
  const SKEY = "cv.e2e.checks.settings";
  window.__cvSettings = { backupFolder: "/tmp/coreview-e2e-not-a-real-folder",
    ...JSON.parse(localStorage.getItem(SKEY) ?? "{}") };
  window.__cvCalls = [];
  window.__cvRefuse = false;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return next++; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "",
        engineer: "", description: "", created_at: p.meta.createdAt,
        updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project")
        return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({ ...window.__cvSettings });
      if (cmd === "set_setting") {
        window.__cvCalls.push({ cmd, args });
        if (args.value === null || args.value === undefined) delete window.__cvSettings[args.key];
        else window.__cvSettings[args.key] = args.value;
        const { backupFolder, ...rest } = window.__cvSettings;
        void backupFolder;
        localStorage.setItem(SKEY, JSON.stringify(rest));
        return Promise.resolve();
      }
      if (cmd === "list_backup_runs") return Promise.resolve(runs);
      if (cmd === "run_backup_checks") {
        window.__cvCalls.push({ cmd, args });
        if (window.__cvRefuse) {
          return Promise.reject("check `No link flaps`: the pattern is not a valid regular expression — unclosed group");
        }
        return Promise.resolve(args.checks.flatMap((c) =>
          (answers[c.name] ?? []).map((a) => ({ ...a, checkId: c.id }))));
      }
      if (cmd === "vault_status") return Promise.resolve({ exists: false, unlocked: false });
      return Promise.resolve([]);
    },
  };
}, { p: project, runs: RUNS, answers: ANSWERS });

page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));

const openBackups = async () => {
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.locator(".cv-project-open").first().click();
  await page.waitForTimeout(700);
  await page.locator("button", { hasText: "Backups" }).first().click();
  await page.waitForTimeout(500);
};

await openBackups();

const section = page.locator(".cv-backup-checks");
const rows = section.locator(".cv-check-row");
const runSelect = section.locator(".cv-field", { has: page.locator('span:text-is("Run")') }).locator("select");
const runButton = section.locator("button", { hasText: /^Run|Checking/ });
const rowField = (i, label, tag = "input") =>
  rows.nth(i).locator(".cv-field", { has: page.locator(`span:text-is("${label}")`) }).locator(tag).first();

check("the Backups tab has a checks section", (await section.count()) === 1);
check("no check ships built in (D-027)", (await rows.count()) === 0);
check("with no checks there is nothing to run", await runButton.isDisabled());

const runOptions = await runSelect.locator("option").allTextContents();
check("only runs with show commands can be checked", runOptions.length === 2 &&
  runOptions[0].includes("2026-08-28 11:00:00"), runOptions.join(" | "));

await section.locator("button", { hasText: "Add check" }).click();
await page.waitForTimeout(150);
check("a new check starts empty",
  (await rowField(0, "Command").inputValue()) === "" && (await rowField(0, "Text or pattern").inputValue()) === "");
await rowField(0, "Name").fill("Default route");
await rowField(0, "Command").fill("show ip route");
await rowField(0, "Text or pattern").fill("0.0.0.0/0");

await section.locator("button", { hasText: "Add check" }).click();
await page.waitForTimeout(150);
await rowField(1, "Name").fill("No link flaps");
await rowField(1, "Command").fill("show logging");
await rowField(1, "Output", "select").selectOption("notContains");
await rowField(1, "Text or pattern").fill("updown");
await rows.nth(1).locator(".cv-check", { hasText: "Ignore case" }).locator("input").check();

await section.locator("button", { hasText: "Add check" }).click();
await page.waitForTimeout(150);
await rowField(2, "Command").fill("show version");
await page.waitForTimeout(200);

check("an incomplete check is counted as not running",
  (await section.innerText()).includes("1 check is missing a command or text"), await section.innerText());
check("the button counts only the checks that will run", (await runButton.innerText()).includes("Run 2 checks"),
  await runButton.innerText());

await runButton.click();
await page.waitForTimeout(400);
const call = await page.evaluate(() => [...window.__cvCalls].reverse().find((c) => c.cmd === "run_backup_checks"));
check("the newest run with show commands is the one checked", call?.args?.stamp === "20260828-110000",
  JSON.stringify(call?.args?.stamp));
const sent = call?.args?.checks ?? [];
check("exactly the complete checks are sent", sent.length === 2 &&
  sent[0].command === "show ip route" && sent[0].expect === "contains" && sent[0].pattern === "0.0.0.0/0" &&
  sent[1].expect === "notContains" && sent[1].ignoreCase === true, JSON.stringify(sent));

const summary = await section.locator(".cv-check-summary").innerText();
check("a summary counts every verdict", summary.includes("1 passed") && summary.includes("2 failed") &&
  summary.includes("1 not captured"), summary);

const resultRows = section.locator(".cv-check-results tbody tr");
check("every device and check is a row", (await resultRows.count()) === 4);
const firstTwo = [await resultRows.nth(0).innerText(), await resultRows.nth(1).innerText()];
check("failures come first", firstTwo.every((t) => t.startsWith("Fail")), JSON.stringify(firstTwo));
check("failures are ordered by device",
  firstTwo[0].includes("LAB-RTR-B") && firstTwo[0].includes("Default route") &&
    firstTwo[1].includes("LAB-SW-A") && firstTwo[1].includes("No link flaps"), JSON.stringify(firstTwo));
const flap = resultRows.filter({ hasText: "No link flaps" }).filter({ hasText: "LAB-SW-A" });
check("a failure quotes the line that decided it, with its number",
  (await flap.innerText()).includes("line 12: %LINK-3-UPDOWN"), await flap.innerText());
check("a gap in collection is not called a failure",
  (await resultRows.filter({ hasText: "Not captured" }).innerText()).includes("is not in this device's capture"));

await section.locator(".cv-check", { hasText: "Only what did not pass" }).locator("input").check();
await page.waitForTimeout(150);
check("only what did not pass hides the passes",
  (await resultRows.count()) === 3 && !(await section.locator(".cv-check-results").innerText()).includes("Pass"));

const writes = await page.evaluate(() =>
  window.__cvCalls.filter((c) => c.cmd === "set_setting" && c.args.key === "backupChecks"));
check("the checks are saved as a setting",
  String(writes.at(-1)?.args?.value).includes("No link flaps"), JSON.stringify(writes.at(-1)));

await openBackups();
check("after a restart every check comes back, the incomplete one too",
  (await page.locator(".cv-backup-checks .cv-check-row").count()) === 3);

await page.evaluate(() => { window.__cvRefuse = true; });
await page.locator(".cv-backup-checks button", { hasText: /^Run/ }).click();
await page.waitForTimeout(400);
const problem = await page.locator(".cv-backup-checks .cv-discover-problem").innerText().catch(() => "");
check("a refused pattern is shown as the backend said it, naming the check",
  problem.includes("No link flaps") && problem.includes("not a valid regular expression"), problem);
check("and the button is usable again", !(await page.locator(".cv-backup-checks button", { hasText: /^Run/ }).isDisabled()));

await page.locator(".cv-backup-checks .cv-check-row").nth(2).locator("button", { hasText: "Remove check" }).click();
await page.waitForTimeout(150);
check("a check can be removed", (await page.locator(".cv-backup-checks .cv-check-row").count()) === 2);

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
