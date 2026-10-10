// Clusters: a device holding six or more folds to a chip that says what is
// inside and the worst of it; zoomed out past the line where labels go, the
// fans fold on their own; the Arrange menu folds by site and below a role;
// a breadcrumb names the way back in; and the Monitor table is a site ›
// role › device tree that fits the panel and follows the canvas selection.
// Stubbed backend. Invented names only.
//
//     npm run dev            # in another terminal
//     node e2e/clusters.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const device = (id, label, deviceType, x, y, site) => ({
  id, type: "device", position: { x, y }, width: 76, height: 76,
  data: { label, deviceType, tags: [], addresses: [], locked: false, maintenance: false, showDetails: false, ...(site ? { site } : {}) },
});
const link = (source, target) => ({
  id: `${source}-${target}`, source, target, sourceHandle: "b", targetHandle: "t", type: "live",
  data: { sourcePortLabel: "", targetPortLabel: "", label: "", pathType: "straight", direction: "none", width: 2,
    color: "#5c6b7c", enabled: true, maintenance: false, healthRule: { type: "manual", manualStatus: "unknown" } },
});

const nodes = [
  device("core", "CORE-1", "core-switch", 600, 0, "HQ"),
  device("dist1", "DIST-1", "distribution-switch", 600, 220, "HQ"),
  device("r1", "EDGE-R1", "router", 2400, 0, "Branch"),
  device("dist2", "DIST-2", "distribution-switch", 2400, 220, "Branch"),
  device("srv1", "APP-1", "server", 0, 760),
  device("srv2", "APP-2", "server", 200, 760),
];
const edges = [link("core", "dist1"), link("core", "r1"), link("r1", "dist2")];
for (let i = 1; i <= 8; i += 1) { nodes.push(device(`a${i}`, `ACC-${i}`, "access-switch", (i - 1) * 180, 460, "HQ")); edges.push(link("dist1", `a${i}`)); }
for (let i = 1; i <= 7; i += 1) { nodes.push(device(`b${i}`, `BR-ACC-${i}`, "access-switch", 1900 + (i - 1) * 180, 460, "Branch")); edges.push(link("dist2", `b${i}`)); }
const probes = ["a1", "a2", "a3"].map((id) => ({ id: `p-${id}`, objectId: id, kind: "icmp", target: `192.0.2.${id.slice(1)}`, isPrimary: true, enabled: true, intervalMs: 5000 }));

const project = {
  meta: { id: "clusters", name: "Clusters", customer: "", site: "", ticket: "", engineer: "", description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: { nodes, edges, probes, canvas: {} },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.addInitScript(({ p }) => {
  localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
  localStorage.removeItem("coreview.view.foldFans");
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
      return Promise.resolve([]);
    },
  };
}, { p: project });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(800);

const st = (fn, arg) => page.evaluate(fn, arg);
const chips = () => page.locator('[data-region="cluster-chip"]');
const chipTexts = () => chips().allInnerTexts();
const crumbs = () => page.locator('[data-region="canvas-crumbs"]');
const message = () => page.locator(".cv-panel-message").innerText().catch(() => "");
const zoomTo = async (pc) => {
  await page.locator('[data-region="zoom-level"]').click();
  await page.waitForTimeout(150);
  await page.locator(".cv-zoom-menu .cv-dropdown-menu button", { hasText: new RegExp(`^${pc} %`) }).click();
  await page.waitForTimeout(500);
};
/** Brings a set of devices into view: selected, Shift+F, deselected. */
const bring = async (ids) => {
  await st((ids) => {
    const s = window.__cvStore.getState();
    s.onNodesChange(s.doc.pages[0].nodes.map((n) => ({ type: "select", id: n.id, selected: ids.includes(n.id) })));
  }, ids);
  await page.keyboard.press("Shift+F");
  await page.waitForTimeout(500);
  await st(() => window.__cvStore.getState().select(null, null));
  await page.waitForTimeout(200);
};
const zoomNow = () => page.locator('[data-region="zoom-level"]').innerText();
const arrangeItem = async (region) => {
  await page.locator('[data-region="arrange-menu"]').click();
  await page.waitForTimeout(200);
  const item = page.locator(`.cv-arrange-menu [data-region="${region}"]`);
  const text = (await item.count()) ? (await item.innerText()).trim() : "";
  if (await item.count()) await item.click();
  else await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  return text;
};

// Two access switches down, with checks running, so the chips have
// something to say.
await st(() => {
  const s = window.__cvStore.getState();
  const runtime = new Map(s.runtime);
  for (const id of ["a1", "a2", "a3"]) {
    const down = id !== "a3";
    runtime.set(`p-${id}`, { probeId: `p-${id}`, status: down ? "down" : "healthy", lastRttMs: down ? null : 2,
      lastSuccessMs: down ? null : Date.now() - 2000, lastFailureMs: down ? Date.now() - 2000 : null,
      lastSummary: down ? "no reply" : "reply", consecutiveFailures: down ? 3 : 0, failureThreshold: 3 });
  }
  window.__cvStore.setState({ runtime, session: { id: "e2e", state: "running", startedAt: Date.now() } });
});
await zoomTo(100);

// ------------------------------------------------------------- a chip by hand
{
  check("at 100 % nothing is folded and there is no chip", (await chips().count()) === 0 && (await crumbs().count()) === 0);
  await bring(["dist1", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]);
  const dist1 = page.locator('.react-flow__node[data-id="dist1"]');
  await dist1.click({ button: "right" });
  await page.waitForTimeout(250);
  const item = page.locator(".cv-menu button", { hasText: "Collapse — 8 devices" });
  check("the menu offers to collapse the switch's eight", (await item.count()) === 1);
  await item.click();
  await page.waitForTimeout(500);
  check("a chip under it says what it holds and the worst of it", (await chipTexts()).join("|") === "8 access · 2 down", (await chipTexts()).join("|"));
  check("the chip carries the worst status for the eye", (await chips().first().getAttribute("data-worst")) === "down");
  check("the eight are off the page", (await page.locator('.react-flow__node[data-id^="a"]').count()) === 0);
  check("a breadcrumb says where the view is and how much is folded",
    /^Diagram/.test(await crumbs().innerText()) && /1 fan folded/.test(await crumbs().innerText()) && /8 devices behind chips/.test(await crumbs().innerText()),
    await crumbs().innerText());

  await zoomTo(200);
  await bring(["dist1"]);
  const zoomBefore = await zoomNow();
  await chips().first().click();
  await page.waitForTimeout(600);
  check("opening the chip brings the fan back", (await page.locator('.react-flow__node[data-id^="a"]').count()) === 8 && (await chips().count()) === 0);
  check("and the breadcrumb names the way in", /Diagram\s*›\s*DIST-1/.test(await crumbs().innerText()), await crumbs().innerText());
  check("and brought the view to the fan", (await zoomNow()) !== zoomBefore, `${zoomBefore} -> ${await zoomNow()}`);

  await crumbs().locator("button", { hasText: /^Diagram$/ }).click();
  await page.waitForTimeout(600);
  check("the root crumb folds it again", (await page.locator('[data-region="cluster-chip"][data-id="dist1"]').count()) === 1 && (await page.locator('.react-flow__node[data-id^="a"]').count()) === 0,
    `${await chipTexts()} / ${await page.locator('.react-flow__node[data-id^="a"]').count()} access drawn`);
  await crumbs().locator('[data-region="expand-all"]').click();
  await page.waitForTimeout(600);
  await zoomTo(100);
  check("Expand all opens everything and the breadcrumb goes", (await chips().count()) === 0 && (await crumbs().count()) === 0);
}

// ------------------------------------------------------------- folding by zoom
{
  await zoomTo(25);
  const texts = (await chipTexts()).sort();
  check("zoomed out past the labels, every fan of six or more folds on its own", texts.length === 2, texts.join("|"));
  check("each chip says what it holds", texts.join("|") === "7 access|8 access · 2 down", texts.join("|"));
  check("the breadcrumb counts them", /2 fans folded/.test(await crumbs().innerText()), await crumbs().innerText());
  await zoomTo(100);
  check("back at 100 % the fans are drawn again", (await chips().count()) === 0 && (await page.locator('.react-flow__node[data-id^="b"]').count()) === 7);

  // Off, by its setting on the Arrange menu.
  const toggleFoldFans = async () => {
    await page.locator('[data-region="arrange-menu"]').click();
    await page.locator(".cv-arrange-menu[open]").waitFor();
    await page.waitForTimeout(250);
    await page.locator('.cv-arrange-menu[open] [data-region="fold-fans"]').click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  };
  await toggleFoldFans();
  await zoomTo(25);
  check("with the setting off, zooming out folds nothing", (await chips().count()) === 0);
  await toggleFoldFans();
  await page.waitForTimeout(300);
  check("and on again, the fans fold", (await chips().count()) === 2);
  check("the setting is remembered for this machine", (await st(() => localStorage.getItem("coreview.view.foldFans"))) === "1");
  await zoomTo(100);
}

// ------------------------------------------------------------- the Arrange menu
{
  const below = await arrangeItem("collapse-below-distribution");
  check("the menu offers to fold below the distribution layer, counting the fans", below === "Collapse below Distribution (2 fans, 15 devices)", below);
  check("and does: two chips at 100 %", (await chips().count()) === 2, (await chipTexts()).join("|"));
  if (process.env.CV_SHOT) { await page.keyboard.press("f"); await page.waitForTimeout(500); await page.screenshot({ path: `${process.env.CV_SHOT}-chips.png` }); }
  check("saying what it did", /^Folded 2 fans under Distribution: 15 devices behind chips/.test(await message()), await message());
  const all = await arrangeItem("expand-everything");
  check("Expand everything opens them", all === "Expand everything" && (await chips().count()) === 0);

  const bySite = await arrangeItem("collapse-by-site");
  check("Collapse by site counts the sites the devices carry", bySite === "Collapse by site (2)", bySite);
  const boxes = page.locator('.react-flow__node[data-id^="collapsed:"]');
  check("and folds each into one box", (await boxes.count()) === 2, String(await boxes.count()));
  const texts = (await chipTexts()).sort();
  check("with a chip naming the site and what is inside", texts.join("|") === "Branch · 9 devices|HQ · 10 devices · 2 down", texts.join("|"));
  check("the devices with no site stay as they were", (await page.locator('.react-flow__node[data-id="srv1"]').count()) === 1);
  // The whole page in view, so the site's chip is on screen to click.
  await page.keyboard.press("f");
  await page.waitForTimeout(600);
  await chips().filter({ hasText: /^HQ/ }).click();
  await page.waitForTimeout(600);
  check("opening a site's chip brings the site back and names it on the breadcrumb",
    (await boxes.count()) === 1 && /Diagram\s*›\s*HQ/.test(await crumbs().innerText()), await crumbs().innerText());
  await arrangeItem("expand-everything");
  await zoomTo(100);
  check("everything open again", (await boxes.count()) === 0 && (await crumbs().count()) === 0);
}

// ------------------------------------------------------------- the dock tree
{
  await page.locator('.cv-panel button[role="tab"]', { hasText: "Monitored objects" }).click();
  await page.waitForTimeout(400);
  const branches = page.locator(".cv-panel table tr.cv-tree-branch");
  const labels = async () => branches.locator(".cv-tree-label").allInnerTexts();
  const rowText = async (row) => (await row.innerText()).replace(/\s+/g, " ").trim();
  const hq = () => branches.filter({ hasText: /^HQ/ }).first();
  check("the table is a tree: the sites first", (await labels()).slice(0, 3).join("|") === "Branch|HQ|No site", (await labels()).join("|"));
  check("a site row counts what it holds — devices and links — and says what is wrong", /^HQ\s*20\s*2 down$/.test(await rowText(hq())), await rowText(hq()));
  check("the count in the head is still the devices and links, not the branches", /^39 of 39$/.test((await page.locator(".cv-panel-count").innerText()).trim()), await page.locator(".cv-panel-count").innerText());

  // Tall — six tenths of the window — the roles show under the sites.
  await page.locator(".cv-dock-grip").dblclick();
  await page.waitForTimeout(500);
  if ((await hq().getAttribute("aria-expanded")) !== "true") { await hq().click(); await page.waitForTimeout(300); }
  check("roles sit under a site in tier order, links last", /Core.*Distribution.*Access.*Links/s.test((await labels()).join(" ")), (await labels()).join("|"));

  // Selecting on the canvas opens the branch and marks the row.
  await st(() => window.__cvStore.getState().select("b4", null));
  await page.waitForTimeout(400);
  const selectedRow = page.locator('.cv-panel table tr[data-id="b4"]');
  check("selecting a device on the canvas opens its branch and marks its row", (await selectedRow.count()) === 1 && /is-selected/.test(await selectedRow.getAttribute("class")));
  check("and the row is in view", await selectedRow.isVisible());

  // Short — a third — the rows that will not fit fold: all but the branch
  // holding the selection.
  await page.locator(".cv-dock-grip").dblclick();
  await page.waitForTimeout(500);
  const closed = page.locator('.cv-panel table tr.cv-tree-branch[aria-expanded="false"]');
  check("in a short panel the branches that will not fit are folded", (await closed.count()) >= 3, String(await closed.count()));
  check("but the selected device's branch stays open", (await selectedRow.count()) === 1, String(await selectedRow.count()));
  if (process.env.CV_SHOT) await page.screenshot({ path: `${process.env.CV_SHOT}-tree.png` });
  check("and a folded site still says what is wrong inside", /2 down/.test(await rowText(hq())), await rowText(hq()));

  // A click opens a branch by hand, and it stays open.
  const noSite = () => branches.filter({ hasText: /^No site/ }).first();
  const compute = () => branches.filter({ hasText: /^Compute/ }).first();
  await noSite().click();
  await page.waitForTimeout(400);
  check("a click opens a site: its roles appear", (await noSite().getAttribute("aria-expanded")) === "true" && (await compute().count()) === 1, (await labels()).join("|"));
  await compute().click();
  await page.waitForTimeout(400);
  check("and a click on a role shows its devices", (await page.locator('.cv-panel table tr[data-id="srv2"]').count()) === 1);
  await page.locator(".cv-dock-grip").dblclick();
  await page.waitForTimeout(500);
  check("taller again, the hand-opened branches are still open", (await noSite().getAttribute("aria-expanded")) === "true" && (await page.locator('.cv-panel table tr[data-id="srv2"]').count()) === 1);
}

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
