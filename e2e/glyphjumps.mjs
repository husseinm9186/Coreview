// The stacked glyph, the HA checkbox and hops on curved links, driven through
// the real app (LT-159, LT-160, LT-161).
//
// LT-159 — "stack should show something like this": a device a stack was
// reported on draws the glyph doubled.
// LT-160 — "we need an option or check box to enabel HA manualy": ticking it
// draws the device stacked, unticking puts the single glyph back, and the
// saved project carries it.
// LT-161 — "all link path types should have the jump like the smooth step":
// two crossing bezier links hop.
//
// A fixture of its own; invented names only (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/glyphjumps.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const device = (id, label, x, y, over = {}) => ({
  id, type: "device", position: { x, y }, width: 76, height: 76,
  data: { label, deviceType: "access-switch", tags: [], addresses: [], locked: false, maintenance: false,
    showDetails: true, ...over },
});
const curve = (id, source, target, sourceHandle, targetHandle) => ({
  id, source, target, sourceHandle, targetHandle, type: "live",
  data: {
    sourcePortLabel: "", targetPortLabel: "", label: "", pathType: "bezier", direction: "forward", width: 2,
    color: "#2fbf6b", enabled: true, maintenance: false, healthRule: { type: "manual", manualStatus: "healthy" },
  },
});

const project = {
  meta: { id: "glyphjumps", name: "Glyphs and jumps", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    nodes: [
      device("n1", "LAB-TOP", 0, 0),
      device("n2", "LAB-BOTTOM", 0, 400),
      device("n3", "LAB-LEFT", -300, 200),
      device("n4", "LAB-RIGHT", 300, 200),
      device("n5", "LAB-STACK", 600, 0, { stackKind: "StackWise", stackMembers: "1 active S000TESTSERIAL00" }),
    ],
    // A link down the middle and one across it, both bezier.
    edges: [curve("down", "n1", "n2", "b", "t"), curve("across", "n3", "n4", "r", "l")],
    probes: [],
    canvas: {},
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

await page.addInitScript(({ p }) => {
  localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
  window.__saved = [];
  let next = 1;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return next++; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      if (/save/i.test(cmd)) window.__saved.push({ cmd, body: JSON.stringify(args ?? null) });
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "", engineer: "",
        description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project")
        return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({});
      if (/save/i.test(cmd)) return Promise.resolve(meta);
      return Promise.resolve([]);
    },
  };
}, { p: project });

page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(1200);
if (await page.locator(".cv-recovery").count()) {
  await page.locator(".cv-recovery button", { hasText: "Keep what was saved" }).click();
  await page.waitForTimeout(300);
}

const stackedIn = (id) => page.locator(`.react-flow__node[data-id="${id}"] svg[data-stacked]`).count();

// ------------------------------------------------------------- LT-159
check("a device a stack was reported on draws the stacked glyph", (await stackedIn("n5")) === 1);
check("a single switch draws the single glyph", (await stackedIn("n1")) === 0);

// ------------------------------------------------------------- LT-160
await page.evaluate(() => window.__cvStore.getState().select("n1", null));
await page.waitForTimeout(400);
const ha = page.locator(".cv-inspector label.cv-check", { hasText: "HA pair or cluster" });
check("the device inspector offers an HA checkbox", (await ha.count()) === 1);
const haOf = () => page.evaluate(() => {
  const d = window.__cvStore.getState().doc;
  const nodes = d.pages ? Object.values(d.pages).flatMap((pg) => pg.nodes ?? []) : d.nodes ?? [];
  return nodes.find((n) => n.id === "n1")?.data?.ha;
});
if ((await ha.count()) === 1) {
  await ha.locator("input").check();
  await page.waitForTimeout(300);
  check("ticking HA draws the device stacked", (await stackedIn("n1")) === 1);
  check("and records it on the device", (await haOf()) === true, JSON.stringify(await haOf()));

  // Focus is still on the checkbox, where the save shortcut is not taken.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(1200);
  const saved = await page.evaluate(() => window.__saved);
  const last = saved[saved.length - 1];
  check("the saved project carries it", Boolean(last && last.body.includes('"ha":true')),
    saved.map((s) => s.cmd).join(", ") || "nothing saved");

  await ha.locator("input").uncheck();
  await page.waitForTimeout(300);
  check("unticking puts the single glyph back", (await stackedIn("n1")) === 0);
}

// ------------------------------------------------------------- LT-161
await page.keyboard.press("Escape");
await page.waitForTimeout(900); // the path register settles after a quiet moment
const hopsOn = (id) => page.locator(`.react-flow__edge[data-id="${id}"] path`).evaluateAll(
  (paths) => paths.filter((p) => /A\d/.test(p.getAttribute("d") ?? "")).length > 0,
);
const down = await hopsOn("down");
const across = await hopsOn("across");
check("two crossing bezier links hop", down || across, `down=${down} across=${across}`);
check("on one of them, not both", !(down && across), `down=${down} across=${across}`);
check("and the across link is the one that hops, as on a step path", across && !down,
  `down=${down} across=${across}`);

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
