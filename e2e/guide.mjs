// The guided sample (LT-271): opened from the project screen, its tour ticks
// each step off as it is done, through the real app with the bridge stubbed.
// Invented names and documentation addresses (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/guide.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript(() => {
  const listeners = {}, callbacks = {};
  let next = 1;
  let saved = null;
  window.__cvEmit = (event, payload) => {
    const id = listeners[event];
    if (id && callbacks[id]) callbacks[id]({ event, id, payload });
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const id = next++; callbacks[id] = cb; return id; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") { listeners[args.event] = args.handler; return Promise.resolve(next++); }
      if (cmd === "list_projects") return Promise.resolve(saved ? [saved.meta] : []);
      if (cmd === "save_project") { saved = args.package; return Promise.resolve(null); }
      if (cmd === "load_project") return Promise.resolve(saved);
      if (cmd === "get_settings") return Promise.resolve({});
      if (cmd === "vault_status") return Promise.resolve({ exists: false, unlocked: false, credentials: 0, minimumPassphrase: 12 });
      if (cmd === "start_validation") return Promise.resolve({ session_id: "s1", project_id: args.projectId, state: "running", probe_count: args.probes.length });
      return Promise.resolve([]);
    },
  };
});
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-sample", { hasText: "Guided tour" }).click();
await page.waitForTimeout(1200);

const guide = page.getByRole("complementary", { name: "Guided tour" });
check("the guided sample opens with its tour", (await guide.count()) === 1 && /0 of 6/.test(await guide.textContent()));
check("starting at the first step, explained", /Click Core switch/.test(await guide.textContent()));

const st = (fn, arg) => page.evaluate(fn, arg);
await st(() => {
  const s = window.__cvStore.getState();
  const core = s.doc.pages[0].nodes.find((n) => n.data.label === "Core switch");
  s.onNodesChange(s.doc.pages[0].nodes.map((n) => ({ type: "select", id: n.id, selected: n.id === core.id })));
});
await page.waitForTimeout(300);
check("picking a device ticks it off and moves on", /1 of 6/.test(await guide.textContent()) && /Click the line/.test(await guide.textContent()));

await st(() => {
  const s = window.__cvStore.getState();
  const nodes = s.doc.pages[0].nodes;
  const id = (label) => nodes.find((n) => n.data.label === label).id;
  const edge = s.doc.pages[0].edges.find((e) => e.source === id("Core switch") && e.target === id("Access switch 1"));
  s.onNodesChange(nodes.map((n) => ({ type: "select", id: n.id, selected: false })));
  s.onEdgesChange(s.doc.pages[0].edges.map((e) => ({ type: "select", id: e.id, selected: e.id === edge.id })));
  s.select(null, edge.id);
});
await page.waitForTimeout(400);
check("reading a link does too, and its ports show the errors it hides", /2 of 6/.test(await guide.textContent()) && /790 CRC/.test(await page.locator(".cv-inspector").textContent()), (await guide.textContent()).slice(0, 80));
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

await page.locator("button", { hasText: "Start validation" }).first().click();
await page.waitForTimeout(400);
await st(() => {
  const s = window.__cvStore.getState();
  const emit = (e) => window.__cvEmit("coreview://engine", e);
  s.doc.probes.forEach((p, i) => emit({ kind: "sample", session_id: "s1", status: p.target === "127.0.0.1" ? "healthy" : "down",
    result: { probe_id: p.id, timestamp_ms: 1000 + i, outcome: p.target === "127.0.0.1" ? "success" : "timeout", rtt_ms: null, resolved: [], summary: "", error_message: null } }));
});
await page.waitForTimeout(400);
check("validation and its answers tick off two more", /4 of 6/.test(await guide.textContent()));

await page.keyboard.press("Control+k");
await page.waitForTimeout(300);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check("opening search is the fifth", /5 of 6/.test(await guide.textContent()));

const kept = await st(() => window.__cvStore.getState().doc.guide.done);
check("what was done is kept on the project", JSON.stringify(kept) === JSON.stringify(["select", "link", "validate", "answer", "search"]), JSON.stringify(kept));
await guide.getByRole("button", { name: "Hide the tour" }).click();
await page.waitForTimeout(200);
check("and the tour hides for good", (await guide.count()) === 0 && (await st(() => window.__cvStore.getState().doc.guide.hidden)) === true);

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
