// Security hardening, driven through the real app with the Tauri bridge stubbed
// (Phase 7): structured inputs carry only what the backend declares (LT-259),
// a refused start is shown as the backend words it (LT-260), the vault opens
// from the system keychain when this machine keeps its key (LT-262), and the
// credential use log (LT-264).
// Invented names, documentation addresses, obviously fake secrets (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/security.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const project = {
  meta: { id: "security", name: "Security lab", createdAt: NOW, updatedAt: NOW },
  documentVersion: 1,
  document: {
    activePageId: "p1",
    probes: [{ id: "pr1", projectId: "security", objectKind: "node", objectId: "a", name: "Ping", kind: "icmp", target: "192.0.2.10", intervalSeconds: 5, timeoutMs: 1000, failureThreshold: 3, recoveryThreshold: 2, enabled: true, maintenance: false, isPrimary: true, notes: "document only" }],
    pages: [{ id: "p1", name: "Core", canvas: { gridEnabled: true, snapEnabled: true, minimap: false, nodeStyle: "glyph" }, edges: [],
      nodes: [{ id: "a", type: "device", position: { x: 0, y: 0 }, width: 76, height: 76, data: { label: "CORE-SW1", deviceType: "core-switch", tags: [], addresses: [{ id: "x", label: "Mgmt", address: "192.0.2.10", isPrimary: true }] } }] }],
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript(({ p }) => {
  let next = 1;
  window.__calls = [];
  window.__keychain = "opened";
  window.__kept = true;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return next++; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      window.__calls.push({ cmd, args });
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "", engineer: "", description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({});
      if (cmd === "unlock_vault_from_keychain") return Promise.resolve(window.__keychain);
      if (cmd === "vault_status") return Promise.resolve({ exists: true, unlocked: window.__keychain === "opened", credentials: 1, minimumPassphrase: 12, keptInKeychain: window.__kept });
      if (cmd === "list_credentials") return Promise.resolve([{ id: "cred-ssh", label: "Read-only SSH", kind: "ssh", username: "reader", detail: "", hasSecondSecret: false }]);
      if (cmd === "remember_vault_key") { window.__kept = true; return Promise.resolve(null); }
      if (cmd === "forget_vault_key") { window.__kept = false; return Promise.resolve(null); }
      if (cmd === "list_credential_use") return Promise.resolve([
        { credentialId: "cred-ssh", label: "Read-only SSH", purpose: "Crawl", target: "CORE-SW1 (192.0.2.10)", firstMs: 1756000000000, lastMs: 1756000600000, uses: 3 },
        { credentialId: "cred-old", label: "Retired SNMP", purpose: "SNMP uptime check", target: "192.0.2.20", firstMs: 1755000000000, lastMs: 1755000000000, uses: 1 },
      ]);
      if (cmd === "start_validation") return Promise.reject("Validation was started 10 times in the last minute, which is more than a person does. Wait 42 s and try again.");
      if (cmd === "save_project") return Promise.resolve(null);
      return Promise.resolve([]);
    },
  };
}, { p: project });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
const calls = (cmd) => page.evaluate((cmd) => window.__calls.filter((c) => c.cmd === cmd), cmd);

// ------------------------------------------------------------ LT-262 keychain
check("the app asks the keychain once, at start", (await calls("unlock_vault_from_keychain")).length === 1);
const keep = page.getByLabel("Open by itself on this computer");
check("an open vault offers to open by itself, and shows that it does", (await keep.count()) === 1 && (await keep.isChecked()));
await keep.click();
await page.waitForTimeout(400);
check("unticking forgets the kept key", (await calls("forget_vault_key")).length === 1 && !(await keep.isChecked()));
await keep.click();
await page.waitForTimeout(400);
check("ticking keeps it again", (await calls("remember_vault_key")).length === 1 && (await keep.isChecked()));

// ------------------------------------------------------- LT-264 the use log
await page.getByText("Where they were used").click();
await page.waitForTimeout(400);
const log = page.locator(".cv-credential-use");
check("the use log lists where each credential went", (await log.locator("tr", { hasText: "CORE-SW1 (192.0.2.10)" }).count()) === 1 && /Crawl/.test(await log.textContent()));
check("a deleted credential is still named in the log", (await log.locator("td", { hasText: "Retired SNMP (deleted)" }).count()) === 1);
check("and it says the log stays on this machine", /never sent anywhere/.test(await log.textContent()));
await log.locator("select").selectOption("cred-ssh");
await page.waitForTimeout(300);
check("one credential's use can be picked out", (await calls("list_credential_use")).at(-1)?.args.credentialId === "cred-ssh");

// --------------------------------------------- LT-259 what the backend is sent
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(800);
await page.locator("button", { hasText: "Start validation" }).first().click();
await page.waitForTimeout(500);
const sent = (await calls("start_validation")).at(-1)?.args.probes?.[0];
check("a probe is sent with the engine's fields only", sent && sent.target === "192.0.2.10" && !("notes" in sent) && !("is_primary" in sent) && !("isPrimary" in sent), JSON.stringify(sent));
// ------------------------------------------------------- LT-260 rate limit
const shown = await page.locator(".cv-panel-message, [role=status], .cv-topbar").allTextContents();
check("a start the backend refuses for coming too often says why", shown.some((t) => /more than a person does\. Wait 42 s/.test(t)), JSON.stringify(shown).slice(0, 400));

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
