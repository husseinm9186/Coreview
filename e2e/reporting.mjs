// Reporting, driven through the real app with the Tauri bridge stubbed
// (Phase 6): the PDF report (LT-256) and its templates (LT-257).
// Invented names, documentation addresses (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/reporting.mjs
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
  data: { label, deviceType: "access-switch", tags: [], locked: false, maintenance: false, showDetails: true, serial: `S-${id}`,
    addresses: [{ id: `${id}-a`, label: "Management", address, isPrimary: true }] },
});
const project = {
  meta: { id: "reporting", name: "Report lab", createdAt: NOW, updatedAt: NOW },
  documentVersion: 1,
  document: {
    activePageId: "p1",
    probes: [{ id: "pr1", projectId: "reporting", objectKind: "node", objectId: "a", name: "Ping", kind: "icmp", target: "192.0.2.10", intervalSeconds: 5, timeoutMs: 1000, failureThreshold: 3, recoveryThreshold: 2, enabled: true, maintenance: false, isPrimary: true }],
    pages: [{ id: "p1", name: "Core", canvas: { gridEnabled: true, snapEnabled: true, minimap: false, nodeStyle: "glyph" },
      nodes: [dev("a", "CORE-SW1", 0, "192.0.2.10"), dev("b", "ACCESS-SW1", 300, "192.0.2.11")],
      edges: [{ id: "ab", source: "a", target: "b", type: "live", data: { sourcePortLabel: "Gi1/0/1", targetPortLabel: "Gi0/1", label: "", enabled: true, maintenance: false, healthRule: { type: "manual", manualStatus: "healthy" } } }] }],
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript(({ p }) => {
  const callbacks = {};
  let next = 1;
  window.__calls = [];
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const id = next++; callbacks[id] = cb; return id; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      window.__calls.push({ cmd, args });
      const meta = { id: p.meta.id, name: p.meta.name, customer: "Example Co", site: "HQ", ticket: "CHG-1", engineer: "", description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({});
      if (cmd === "vault_status") return Promise.resolve({ exists: true, unlocked: true, credentials: 0, minimumPassphrase: 12 });
      if (cmd === "list_sessions") return Promise.resolve([
        { id: "s1", startedAt: 1756000000000, stoppedAt: 1756003600000, samples: 700, transitions: 0 },
        { id: "s2", startedAt: 1756100000000, stoppedAt: 1756103600000, samples: 720, transitions: 3 },
      ]);
      if (cmd === "session_summary") return Promise.resolve(args.sessionId === "s1"
        ? [{ probeId: "pr1", samples: 700, healthy: 700, warning: 0, down: 0, avgRttMs: 3, p95RttMs: 5 }]
        : [{ probeId: "pr1", samples: 720, healthy: 648, warning: 0, down: 72, avgRttMs: 30, p95RttMs: 80 }]);
      if (cmd === "list_crawl_runs") return Promise.resolve([]);
      if (cmd === "diagram_pdf_pages") return Promise.resolve([37, 80, 68, 70]);
      if (cmd === "plugin:dialog|save") return Promise.resolve(`/tmp/${args.options?.defaultPath ?? "out"}`);
      if (cmd === "save_export") return Promise.resolve(null);
      return Promise.resolve([]);
    },
  };
}, { p: project });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(800);
const calls = (cmd) => page.evaluate((cmd) => window.__calls.filter((c) => c.cmd === cmd), cmd);

const menu = page.locator(".cv-dropdown").filter({ has: page.locator("summary", { hasText: "Export" }) });
await menu.locator("summary").click();
await menu.locator("button", { hasText: "Report as PDF…" }).click();
await page.waitForTimeout(300);
const dialog = page.getByRole("dialog", { name: "PDF report" });
check("the report dialog opens on its templates", (await dialog.count()) === 1 && (await dialog.getByRole("radio").count()) === 4);
check("a template chooses its sections", (await dialog.getByLabel("Device inventory").isChecked()) && !(await dialog.getByLabel("Changes").isChecked()));
await dialog.getByLabel(/Post-change verification/).check();
check("choosing another changes them", (await dialog.getByLabel("Changes").isChecked()) && !(await dialog.getByLabel("Device inventory").isChecked()));
await dialog.getByLabel("Port inventory").check();
await dialog.getByRole("button", { name: "Make the PDF" }).click();
await page.waitForTimeout(1200);
const svgs = (await calls("diagram_pdf_pages")).at(-1)?.args.svgs ?? [];
const all = svgs.join("\n");
check("the report is made as pages of one PDF", svgs.length >= 5 && svgs.every((s) => s.includes('width="595" height="842"')), `${svgs.length} pages`);
check("with the template's title page", all.includes("POST-CHANGE VERIFICATION") && all.includes("Report lab"));
check("the section added by hand", all.includes("Port inventory"));
check("and not the one the template left out", !svgs.slice(1).some((s) => s.includes(">Device inventory<")));
check("the drawing on its own page", svgs.some((s) => s.includes("Diagram — Core") && s.includes("CORE-SW1")));
check("and what changed between the last two sessions", all.includes("Validation sessions") && /CORE-SW1 — Ping/.test(all));
const saved = (await calls("save_export")).at(-1)?.args.path ?? "";
check("saved under the template's name", /report-lab-verification-report\.pdf$/.test(saved), saved);
check("and the dialog closes", (await dialog.count()) === 0);

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
