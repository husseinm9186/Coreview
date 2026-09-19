// Canvas benchmark (LT-190): opening, idle, pan, zoom and drag at 1k, 5k and
// 10k devices, each measured separately — a change that wins on idle and loses
// on drag is not a win (LT-188's protocol).
//
// The diagram is invented: devices named BENCH-00001… on a grid, each linked to
// its right-hand neighbour. Nothing about a real network (D-027).
//
// What is measured is the browser's frame pacing while each scenario runs:
// requestAnimationFrame intervals, so a frame the main thread was too busy to
// paint shows as a long interval. Headless Chromium paces at 60 Hz, so ~16.7 ms
// is the floor. Numbers are for comparing builds on the same machine, not
// absolute truths about any other.
//
//     npm run dev            # in another terminal
//     SIZES=1000,5000 OUT=bench.json node e2e/bench-canvas.mjs
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const SIZES = (process.env.SIZES ?? "1000,5000,10000").split(",").map(Number);
const STEPS = Number(process.env.STEPS ?? 60);
/** A scenario stops after this long and reports how many steps it managed —
 *  at 10k devices a slow build would otherwise take hours to say it is slow. */
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 90_000);
const NOW = 1756000000000;

function project(n) {
  const cols = Math.ceil(Math.sqrt(n));
  const nodes = [];
  const edges = [];
  for (let i = 0; i < n; i++) {
    const id = `b${i}`;
    nodes.push({
      id, type: "device", position: { x: (i % cols) * 180, y: Math.floor(i / cols) * 160 }, width: 76, height: 76,
      data: { label: `BENCH-${String(i + 1).padStart(5, "0")}`, deviceType: "access-switch", tags: [], addresses: [],
        locked: false, maintenance: false, showDetails: true },
    });
    if ((i + 1) % cols !== 0 && i + 1 < n) {
      edges.push({
        id: `l${i}`, source: id, target: `b${i + 1}`, sourceHandle: "r", targetHandle: "l", type: "live",
        data: { sourcePortLabel: "", targetPortLabel: "", label: "", pathType: "smoothstep", direction: "none",
          width: 2, color: "#2fbf6b", enabled: true, maintenance: false, healthRule: { type: "manual", manualStatus: "unknown" } },
      });
    }
  }
  return {
    meta: { id: `bench-${n}`, name: `Bench ${n}`, customer: "", site: "", ticket: "", engineer: "", description: "",
      createdAt: NOW, updatedAt: NOW, archived: false },
    documentVersion: 1,
    document: { nodes, edges, probes: [], canvas: {} },
  };
}

const stats = (intervals) => {
  const d = [...intervals].sort((a, b) => a - b);
  if (d.length === 0) return { frames: 0, meanMs: null, p95Ms: null, maxMs: null, over50Pct: null };
  const mean = d.reduce((s, x) => s + x, 0) / d.length;
  return {
    frames: d.length,
    meanMs: +mean.toFixed(1),
    p95Ms: +d[Math.min(d.length - 1, Math.floor(d.length * 0.95))].toFixed(1),
    maxMs: +d[d.length - 1].toFixed(1),
    over50Pct: +((100 * d.filter((x) => x > 50).length) / d.length).toFixed(1),
  };
};

async function measure(page, run) {
  let steps = 0;
  const started0 = Date.now();
  const step = () => {
    steps += 1;
    return Date.now() - started0 < BUDGET_MS;
  };
  await page.evaluate(() => {
    window.__frames = [];
    window.__framesOn = true;
    const tick = (t) => {
      if (!window.__framesOn) return;
      window.__frames.push(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const started = Date.now();
  await run(step);
  // Let the last frames of the gesture land before stopping the clock.
  await page.waitForTimeout(250);
  const wallMs = Date.now() - started;
  const times = await page.evaluate(() => {
    window.__framesOn = false;
    return window.__frames;
  });
  const intervals = times.slice(1).map((t, i) => t - times[i]);
  return { wallMs, steps, ...stats(intervals) };
}

async function benchOne(browser, n) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await context.newPage();
  const p = project(n);
  await page.addInitScript(({ p }) => {
    // Past ~5 MB (10,000 devices) the browser refuses this; the stubbed backend
    // below serves the project either way.
    try {
      localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
    } catch {
      /* quota */
    }
    let next = 1;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      transformCallback() { return next++; },
      invoke(cmd) {
        if (cmd === "plugin:event|listen") return Promise.resolve(next++);
        const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "", engineer: "",
          description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
        if (cmd === "list_projects") return Promise.resolve([meta]);
        if (cmd === "load_project")
          return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
        if (cmd === "get_settings") return Promise.resolve({});
        return Promise.resolve([]);
      },
    };
  }, { p });
  page.on("pageerror", (e) => console.log(`  PAGE EXCEPTION (${n}):`, String(e).slice(0, 200)));

  await page.goto(URL, { waitUntil: "networkidle" });
  const opened = Date.now();
  await page.locator(".cv-project-open").first().click();
  // Opened: the device count in the DOM has stopped changing for a second.
  let last = -1;
  let stableSince = Date.now();
  for (;;) {
    const count = await page.locator(".react-flow__node").count();
    if (count !== last) { last = count; stableSince = Date.now(); }
    else if (count > 0 && Date.now() - stableSince > 1000) break;
    if (Date.now() - opened > 240_000) break;
    await page.waitForTimeout(200);
  }
  const open = { wallMs: stableSince - opened, renderedNodes: last };
  if (await page.locator(".cv-recovery").count()) {
    await page.locator(".cv-recovery button", { hasText: "Keep what was saved" }).click();
  }
  // Links finish registering their paths a little after the devices appear; a
  // large page is given longer so the first scenario does not measure that.
  await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 1000));

  const pane = await page.locator(".react-flow__pane").boundingBox();
  const cx = pane.x + pane.width / 2;
  const cy = pane.y + pane.height / 2;

  const idle = await measure(page, () => page.waitForTimeout(2000));

  const pan = await measure(page, async (step) => {
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "middle" });
    for (let i = 1; i <= STEPS && step(); i++) await page.mouse.move(cx - i * 6, cy - i * 3);
    await page.mouse.up({ button: "middle" });
  });

  const zoom = await measure(page, async (step) => {
    await page.mouse.move(cx, cy);
    for (let i = 0; i < STEPS / 2 && step(); i++) await page.mouse.wheel(0, -60);
    for (let i = 0; i < STEPS / 2 && step(); i++) await page.mouse.wheel(0, 60);
  });

  // A device near the middle of what is on screen.
  const target = await page.evaluate(({ cx, cy }) => {
    let best = null;
    for (const el of document.querySelectorAll(".react-flow__node")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      const d = Math.hypot(r.x + r.width / 2 - cx, r.y + r.height / 2 - cy);
      if (!best || d < best.d) best = { d, x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    return best;
  }, { cx, cy });
  const drag = target
    ? await measure(page, async (step) => {
      await page.mouse.move(target.x, target.y);
      await page.mouse.down();
      for (let i = 1; i <= STEPS && step(); i++) await page.mouse.move(target.x + i * 4, target.y + i * 2);
      await page.mouse.up();
    })
    : { error: "no device on screen to drag" };

  const domNodes = await page.locator(".react-flow__node").count();
  await context.close();
  return { size: n, open, idle, pan, zoom, drag, domNodesAfter: domNodes };
}

const browser = await chromium.launch();
const results = [];
for (const n of SIZES) {
  process.stdout.write(`benchmarking ${n} devices…\n`);
  const r = await benchOne(browser, n);
  results.push(r);
  const row = (name, s) =>
    `  ${name.padEnd(5)} mean ${String(s.meanMs).padStart(6)} ms  p95 ${String(s.p95Ms).padStart(6)} ms  ` +
    `max ${String(s.maxMs).padStart(7)} ms  >50ms ${String(s.over50Pct).padStart(5)}%  (${s.frames} frames, ${s.steps} steps, ${s.wallMs} ms)`;
  console.log(`  open  ${r.open.wallMs} ms, ${r.open.renderedNodes} device elements`);
  for (const k of ["idle", "pan", "zoom", "drag"]) console.log(row(k, r[k]));
}
await browser.close();
if (process.env.OUT) writeFileSync(process.env.OUT, `${JSON.stringify({ at: new Date().toISOString(), steps: STEPS, results }, null, 2)}\n`);
