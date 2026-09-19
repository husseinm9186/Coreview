// The Backups tab's show-command capture, driven through the real panel (LT-149).
//
// The Tauri bridge is stubbed — a browser cannot open SSH — and every call the
// panel makes is recorded, so what it would ask the backend to do can be
// checked exactly. Everything above the stub is the real application.
//
// Every name, address and command here is invented for the test (D-027): the
// devices use RFC 5737 documentation addresses, the credentials are
// obviously fake, and nothing is taken from any real network.
//
//     npm run dev            # in another terminal
//     node e2e/showcommands.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const device = (id, label, address, showCommands, role, tags = []) => ({
  id,
  type: "device",
  position: { x: 100, y: 100 },
  data: {
    label,
    deviceType: "generic",
    tags,
    ...(role ? { role } : {}),
    addresses: [{ id: `${id}-a`, label: "Mgmt", address, isPrimary: true }],
    locked: false,
    maintenance: false,
    showDetails: true,
    ...(showCommands ? { showCommands } : {}),
  },
});

const project = {
  meta: { id: "show", name: "Show", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    nodes: [
      device("a", "LAB-SW-A", "192.0.2.10", "show interfaces status\nshow vlan brief", "", ["bench"]),
      device("b", "LAB-RTR-B", "192.0.2.20"),
      device("c", "LAB-FW-C", "192.0.2.30", undefined, "Lab Firewall"),
    ],
    edges: [],
    probes: [],
    canvas: {},
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });

await page.addInitScript(({ p }) => {
  if (!localStorage.getItem("coreview.projects.v1")) {
    localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
  }
  const listeners = {}, callbacks = {};
  let next = 1;
  // Settings survive a reload through localStorage, because addInitScript runs
  // again on every navigation and would otherwise wipe them.
  const SKEY = "cv.e2e.show.settings";
  const stored = JSON.parse(localStorage.getItem(SKEY) ?? "{}");
  window.__cvSettings = { backupFolder: "/tmp/coreview-e2e-not-a-real-folder", ...stored };
  window.__cvCalls = [];
  window.__cvRefuse = false;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const id = next++; callbacks[id] = cb; return id; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") { listeners[args.event] = args.handler; return Promise.resolve(next++); }
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
      if (cmd === "start_backup") {
        window.__cvCalls.push({ cmd, args });
        // The backend's own refusal, as it words it, so the panel is checked
        // for showing it rather than for inventing one.
        if (window.__cvRefuse) {
          return Promise.reject("Nothing was run. Only commands that read are allowed: `reload` — only show, display and get commands are run — `reload` could change the device");
        }
        return Promise.resolve();
      }
      if (cmd === "vault_status") return Promise.resolve({ exists: false, unlocked: false });
      return Promise.resolve([]);
    },
  };
}, { p: project });

page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));

const openBackups = async () => {
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.locator(".cv-project-open").first().click();
  await page.waitForTimeout(700);
  await page.locator("button", { hasText: "Backups" }).first().click();
  await page.waitForTimeout(500);
};

const checkbox = (label) => page.locator(".cv-check", { hasText: label }).locator("input").first();
const field = (label) =>
  page.locator(".cv-field", { has: page.locator(`span:text-is("${label}")`) }).locator("input").first();
const backUp = () => page.locator("button", { hasText: /^Back up/ }).first();
const lastStart = () =>
  page.evaluate(() => [...window.__cvCalls].reverse().find((c) => c.cmd === "start_backup")?.args ?? null);

await openBackups();

// ------------------------------------------------------------ the option

check("the Backups tab offers show commands", (await checkbox("Show commands").count()) === 1);
check("show commands are off until ticked", !(await checkbox("Show commands").isChecked()));
check("the command list is hidden until then", (await page.locator(".cv-show-commands").count()) === 0);

await checkbox("Show commands").check();
await page.waitForTimeout(200);
check("ticking it opens the list and the paging choice",
  (await page.locator(".cv-show-commands textarea").count()) === 1 &&
    (await page.locator(".cv-show-commands select").count()) === 1);

const pagingOptions = await page.locator(".cv-show-commands select option").allTextContents();
check("paging offers every vendor choice", pagingOptions.length === 9, pagingOptions.join(" | "));
check("and starts on automatic", (await page.locator(".cv-show-commands select").inputValue()) === "auto");
check("the list ships empty — nothing pre-filled (D-027)",
  (await page.locator(".cv-show-commands textarea").inputValue()) === "");

// The per-device list set in the inspector shows up as a count.
const rowA = page.locator(".cv-discover-table tbody tr", { hasText: "LAB-SW-A" }).first();
const rowB = page.locator(".cv-discover-table tbody tr", { hasText: "LAB-RTR-B" }).first();
check("a device's own commands are counted in the table",
  (await rowA.locator("td").nth(3).innerText()).trim() === "2",
  await rowA.locator("td").nth(3).innerText());
check("a device with none shows a dash", (await rowB.locator("td").nth(3).innerText()).trim() === "—");

// ----------------------------------------------- what the backend is asked

await field("Username").fill("e2e-user");
await field("Password").fill("e2e-not-a-password");
await checkbox("Running config").uncheck();
await page.locator('input[aria-label="Back up LAB-SW-A"]').check();
await page.locator('input[aria-label="Back up LAB-RTR-B"]').check();
await page.waitForTimeout(200);

// With no configuration ticked and no global list, the device's own commands
// are still something to run.
check("a device's own commands are enough to enable the run", !(await backUp().isDisabled()));

await page.locator(".cv-show-commands textarea").fill("show version\n\n  show clock  \nshow version\n");
await page.locator(".cv-show-commands select").selectOption("cisco-asa");
await page.waitForTimeout(200);
await backUp().click();
await page.waitForTimeout(400);

const sent = await lastStart();
check("the global list is sent trimmed, without blanks or repeats",
  JSON.stringify(sent?.input?.showCommands) === JSON.stringify(["show version", "show clock"]),
  JSON.stringify(sent?.input?.showCommands));
check("the paging choice is sent", sent?.input?.paging === "cisco-asa", sent?.input?.paging);
check("no configuration is asked for when none is ticked",
  JSON.stringify(sent?.input?.kinds) === "[]", JSON.stringify(sent?.input?.kinds));
const targetA = sent?.input?.targets?.find((t) => t.name === "LAB-SW-A");
const targetB = sent?.input?.targets?.find((t) => t.name === "LAB-RTR-B");
check("each device carries its own commands",
  JSON.stringify(targetA?.commands) === JSON.stringify(["show interfaces status", "show vlan brief"]) &&
    JSON.stringify(targetB?.commands) === "[]",
  JSON.stringify(sent?.input?.targets));

// ------------------------------------------------ unticked sends nothing

await page.reload({ waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(700);
await page.locator("button", { hasText: "Backups" }).first().click();
await page.waitForTimeout(600);

check("after a restart the list comes back",
  (await (async () => {
    await checkbox("Show commands").check();
    await page.waitForTimeout(200);
    return page.locator(".cv-show-commands textarea").inputValue();
  })()).includes("show clock"));
check("and so does the paging choice",
  (await page.locator(".cv-show-commands select").inputValue()) === "cisco-asa");

await checkbox("Show commands").uncheck();
await field("Username").fill("e2e-user");
await field("Password").fill("e2e-not-a-password");
await page.locator('input[aria-label="Back up LAB-SW-A"]').check();
await page.waitForTimeout(200);
await backUp().click();
await page.waitForTimeout(400);
const plain = await lastStart();
check("an ordinary backup never runs a list someone typed earlier",
  JSON.stringify(plain?.input?.showCommands) === "[]" &&
    JSON.stringify(plain?.input?.targets?.[0]?.commands) === "[]",
  JSON.stringify(plain?.input));
check("and still asks for the running config", JSON.stringify(plain?.input?.kinds) === '["running"]');

// ---------------------------------------------- the refusal is shown as said

const settingWrites = await page.evaluate(() => window.__cvCalls.filter((c) => c.cmd === "set_setting"));
check("the list is saved as a setting",
  settingWrites.some((w) => w.args.key === "backupShowCommands" && String(w.args.value).includes("show version")));
check("and nothing that looks like a credential is",
  !JSON.stringify(settingWrites).includes("e2e-not-a-password"));

await page.reload({ waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(700);
await page.locator("button", { hasText: "Backups" }).first().click();
await page.waitForTimeout(600);
await page.evaluate(() => { window.__cvRefuse = true; });
await checkbox("Show commands").check();
await page.locator(".cv-show-commands textarea").fill("show version\nreload");
await field("Username").fill("e2e-user");
await field("Password").fill("e2e-not-a-password");
await page.locator('input[aria-label="Back up LAB-SW-A"]').check();
await page.waitForTimeout(200);
await backUp().click();
await page.waitForTimeout(500);
const problem = await page.locator(".cv-discover-problem").first().innerText().catch(() => "");
check("a refused list shows the backend's reason, naming the command",
  problem.includes("reload") && problem.includes("Nothing was run"), problem);
check("and the button is usable again afterwards", !(await backUp().isDisabled()));

// ------------------------------------------ command sets by role or tag (LT-150)

await openBackups();
await checkbox("Show commands").check();
await page.waitForTimeout(200);
await page.locator(".cv-show-commands textarea").first().fill("");
check("no command set ships built in (D-027)", (await page.locator(".cv-command-set").count()) === 0);

const setField = (i, label, tag = "input") =>
  page.locator(".cv-command-set").nth(i)
    .locator(".cv-field", { has: page.locator(`span:text-is("${label}")`) }).locator(tag).first();

await page.locator("button", { hasText: "Add command set" }).click();
await page.waitForTimeout(150);
check("a new set starts with nothing in it",
  (await setField(0, "Roles").inputValue()) === "" &&
    (await setField(0, "Commands — one per line", "textarea").inputValue()) === "");
await setField(0, "Name").fill("Edge set");
await setField(0, "Roles").fill("lab firewall, other role");
await setField(0, "Commands — one per line", "textarea").fill("show route\nshow version");

await page.locator("button", { hasText: "Add command set" }).click();
await page.waitForTimeout(150);
await setField(1, "Name").fill("Bench set");
await setField(1, "Tags").fill("BENCH");
await setField(1, "Commands — one per line", "textarea").fill("show clock\nshow interfaces status");
await page.waitForTimeout(300);

const rowC = page.locator(".cv-discover-table tbody tr", { hasText: "LAB-FW-C" }).first();
const cellC = (await rowC.locator("td").nth(3).innerText()).trim();
check("a device matched by role, in another case, gets the set", cellC.startsWith("2") && cellC.includes("Edge set"), cellC);
const cellA = (await page.locator(".cv-discover-table tbody tr", { hasText: "LAB-SW-A" }).first()
  .locator("td").nth(3).innerText()).trim();
check("a device matched by tag gets the set and keeps its own, repeats once",
  cellA.startsWith("3") && cellA.includes("Bench set") && cellA.includes("own"), cellA);
const cellB = (await page.locator(".cv-discover-table tbody tr", { hasText: "LAB-RTR-B" }).first()
  .locator("td").nth(3).innerText()).trim();
check("a device no set matches is untouched", cellB === "—", cellB);

await field("Username").fill("e2e-user");
await field("Password").fill("e2e-not-a-password");
await checkbox("Running config").uncheck();
await page.locator('input[aria-label="Back up LAB-FW-C"]').check();
await page.locator('input[aria-label="Back up LAB-SW-A"]').check();
await page.waitForTimeout(200);
check("a set alone is enough to enable the run", !(await backUp().isDisabled()));
await backUp().click();
await page.waitForTimeout(400);
const bySet = await lastStart();
const tC = bySet?.input?.targets?.find((t) => t.name === "LAB-FW-C");
const tA = bySet?.input?.targets?.find((t) => t.name === "LAB-SW-A");
check("the role-matched device is sent the set's commands",
  JSON.stringify(tC?.commands) === JSON.stringify(["show route", "show version"]), JSON.stringify(tC));
check("the tag-matched device gets the set, then its own, without repeats",
  JSON.stringify(tA?.commands) ===
    JSON.stringify(["show clock", "show interfaces status", "show vlan brief"]), JSON.stringify(tA));

const setWrites = await page.evaluate(() =>
  window.__cvCalls.filter((c) => c.cmd === "set_setting" && c.args.key === "backupCommandSets"));
check("the sets are saved as a setting",
  setWrites.length > 0 && String(setWrites.at(-1).args.value).includes("Bench set"));
check("and carry no credential", !JSON.stringify(setWrites).includes("e2e-not-a-password"));

await openBackups();
await checkbox("Show commands").check();
await page.waitForTimeout(300);
check("after a restart both sets come back",
  (await page.locator(".cv-command-set").count()) === 2 &&
    (await setField(1, "Tags").inputValue()) === "BENCH");

await page.locator(".cv-command-set").nth(0).locator("button", { hasText: "Remove set" }).click();
await page.waitForTimeout(300);
const cellCAfter = (await page.locator(".cv-discover-table tbody tr", { hasText: "LAB-FW-C" }).first()
  .locator("td").nth(3).innerText()).trim();
check("removing a set takes its commands off the devices it matched", cellCAfter === "—", cellCAfter);

// ------------------------------------------------- file name patterns (LT-151)

await openBackups();
const patternInput = page.locator(".cv-file-pattern input");
const patternHelp = page.locator(".cv-file-pattern .cv-help");
check("the file name field ships blank — the default naming", (await patternInput.inputValue()) === "");
check("and previews the default name",
  (await patternHelp.innerText()).includes("20260828-101530-running-config.txt"), await patternHelp.innerText());

await field("Username").fill("e2e-user");
await field("Password").fill("e2e-not-a-password");
await page.locator('input[aria-label="Back up LAB-SW-A"]').check();
await patternInput.fill("{device}-{kind}");
await page.waitForTimeout(200);
check("a pattern that would overwrite captures says why",
  (await patternHelp.innerText()).includes("{stamp}"), await patternHelp.innerText());
check("and Back up stays off until it is fixed", await backUp().isDisabled());

await patternInput.fill("{sit}_{stamp}_{kind}");
await page.waitForTimeout(200);
check("a mistyped token is named", (await patternHelp.innerText()).includes("{sit}"), await patternHelp.innerText());

await patternInput.fill("{site}_{device}_{stamp}_{kind}");
await page.waitForTimeout(200);
check("a good pattern previews the picked device's name",
  (await patternHelp.innerText()).includes("_LAB-SW-A_20260828-101530_running-config.txt"),
  await patternHelp.innerText());
check("and Back up is available again", !(await backUp().isDisabled()));
await backUp().click();
await page.waitForTimeout(400);
const named = await lastStart();
check("the pattern is sent with the run", named?.input?.filePattern === "{site}_{device}_{stamp}_{kind}",
  JSON.stringify(named?.input?.filePattern));
check("each device carries a site for {site}",
  named?.input?.targets?.every((t) => typeof t.site === "string"), JSON.stringify(named?.input?.targets));

const patternWrites = await page.evaluate(() =>
  window.__cvCalls.filter((c) => c.cmd === "set_setting" && c.args.key === "backupFilePattern"));
check("the pattern is saved as a setting",
  patternWrites.at(-1)?.args?.value === "{site}_{device}_{stamp}_{kind}", JSON.stringify(patternWrites.at(-1)));
await openBackups();
check("and comes back after a restart",
  (await page.locator(".cv-file-pattern input").inputValue()) === "{site}_{device}_{stamp}_{kind}");

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
