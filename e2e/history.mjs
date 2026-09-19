// Undo history: two hundred steps, and they outlive a reload (LT-185).
//
// The stubbed backend keeps what was saved in sessionStorage, so a page reload
// opens the project as it was saved — as reopening the app would. Invented
// names only (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/history.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const device = (id, label, x, y) => ({
  id, type: "device", position: { x, y }, width: 76, height: 76,
  data: { label, deviceType: "router", tags: [], addresses: [], locked: false, maintenance: false, showDetails: false },
});
const initial = {
  meta: { id: "history", name: "History", customer: "", site: "", ticket: "", engineer: "", description: "",
    created_at: NOW, updated_at: NOW, archived: false },
  document_version: 1,
  document: { nodes: [device("n1", "LAB-ONE", 0, 0), device("n2", "LAB-TWO", 300, 0)], edges: [], probes: [], canvas: {} },
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await context.newPage();
await page.addInitScript(({ initial }) => {
  let next = 1;
  const saved = () => JSON.parse(sessionStorage.getItem("cv-saved") ?? "null") ?? initial;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return next++; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      if (cmd === "save_project") {
        sessionStorage.setItem("cv-saved", JSON.stringify(args.package));
        return Promise.resolve(null);
      }
      if (cmd === "list_projects") return Promise.resolve([saved().meta]);
      if (cmd === "load_project") return Promise.resolve(saved());
      if (cmd === "get_settings") return Promise.resolve({});
      return Promise.resolve([]);
    },
  };
}, { initial });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));

const open = async () => {
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.locator(".cv-project-open").first().click();
  await page.waitForTimeout(1200);
  if (await page.locator(".cv-recovery").count()) {
    await page.locator(".cv-recovery button", { hasText: "Keep what was saved" }).click();
  }
};
const state = () => page.evaluate(() => {
  const s = window.__cvStore.getState();
  return { past: s.past.length, future: s.future.length, label: s.doc.pages[0].nodes.find((n) => n.id === "n2").data.label };
});

await open();

// 205 separate edits, each its own undo step.
await page.evaluate(() => {
  const s = window.__cvStore.getState();
  for (let i = 1; i <= 205; i++) {
    s.commit();
    s.updateNodeData("n2", { label: `LAB-EDIT-${i}` });
  }
});
let st = await state();
check("205 edits keep the last two hundred undo steps", st.past === 200 && st.label === "LAB-EDIT-205", JSON.stringify(st));
await page.keyboard.press("Control+z");
await page.waitForTimeout(200);
st = await state();
check("undo steps back one edit", st.label === "LAB-EDIT-204" && st.future === 1, JSON.stringify(st));

await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press("Control+s");
await page.waitForTimeout(1500);
const savedLabel = await page.evaluate(() => JSON.parse(sessionStorage.getItem("cv-saved") ?? "null")?.document?.pages?.[0]?.nodes?.find((n) => n.id === "n2")?.data?.label);
check("the project saves", savedLabel === "LAB-EDIT-204", JSON.stringify(savedLabel));

// Reopen, as a restart would.
await open();
st = await state();
check("after reopening, the undo history is still there", st.past === 199 && st.future === 1 && st.label === "LAB-EDIT-204",
  JSON.stringify(st));
await page.keyboard.press("Control+z");
await page.waitForTimeout(200);
check("and undo carries on from where it was", (await state()).label === "LAB-EDIT-203", JSON.stringify(await state()));
await page.keyboard.press("Control+y");
await page.keyboard.press("Control+y");
await page.waitForTimeout(200);
check("redo too, into the step undone before saving", (await state()).label === "LAB-EDIT-205", JSON.stringify(await state()));

// The file changed since that history was kept — as when it was edited on
// another machine — so the history belongs to another version and is not offered.
await page.evaluate(() => {
  const pkg = JSON.parse(sessionStorage.getItem("cv-saved"));
  pkg.meta.updated_at += 1;
  sessionStorage.setItem("cv-saved", JSON.stringify(pkg));
});
await open();
st = await state();
check("a project changed since its history was kept opens with no history", st.past === 0 && st.future === 0,
  JSON.stringify(st));

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
