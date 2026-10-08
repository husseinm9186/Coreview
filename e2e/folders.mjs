// Folders and sub-folders on the project screen. The backend is a
// stub that keeps the folder rules the way the Rust does — nesting, no
// folder inside itself, deleting a folder moves its contents up — so the page
// is exercised against a store that behaves, not one that says yes.
// Invented names only.
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await page.addInitScript(({ now }) => {
  const meta = (id, name) => ({ id, name, customer: "", site: "", ticket: "", engineer: "", description: "", created_at: now, updated_at: now, archived: false });
  const db = {
    projects: [meta("p1", "Branch refresh"), meta("p2", "Core swap"), meta("p3", "Wireless survey")],
    folders: [],
    placement: {},
  };
  window.__db = db;
  window.__calls = [];
  let next = 1;
  const subtree = (id) => {
    const out = new Set([id]);
    let grew = true;
    while (grew) { grew = false; for (const f of db.folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; } }
    return out;
  };
  const refuse = (m) => Promise.reject(new Error(m));
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return next++; },
    invoke(cmd, args = {}) {
      window.__calls.push({ cmd, args });
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      if (cmd === "list_projects") return Promise.resolve(db.projects);
      if (cmd === "get_settings") return Promise.resolve({});
      if (cmd === "save_project") {
        const m = args.package.meta;
        const row = meta(m.id, m.name);
        db.projects = [row, ...db.projects.filter((p) => p.id !== m.id)];
        return Promise.resolve();
      }
      if (cmd === "load_project") {
        const p = db.projects.find((x) => x.id === args.id);
        return Promise.resolve(p ? { meta: p, document_version: 1, document: { nodes: [], edges: [], probes: [], canvas: {} } } : null);
      }
      if (cmd === "list_project_folders") return Promise.resolve({ folders: db.folders, placement: db.placement });
      if (cmd === "create_project_folder") {
        const name = String(args.name).trim();
        if (db.folders.some((f) => (f.parentId ?? null) === (args.parentId ?? null) && f.name.toLowerCase() === name.toLowerCase())) return refuse(`There is already a folder called “${name}” here.`);
        const f = { id: `f${next++}`, name, parentId: args.parentId ?? null };
        db.folders.push(f);
        return Promise.resolve(f);
      }
      if (cmd === "rename_project_folder") { db.folders.find((f) => f.id === args.id).name = args.name.trim(); return Promise.resolve(); }
      if (cmd === "move_project_folder") {
        if (args.parentId && subtree(args.id).has(args.parentId)) return refuse("A folder cannot be moved into itself or into a folder inside it.");
        db.folders.find((f) => f.id === args.id).parentId = args.parentId ?? null;
        return Promise.resolve();
      }
      if (cmd === "delete_project_folder") {
        const gone = db.folders.find((f) => f.id === args.id);
        for (const [p, f] of Object.entries(db.placement)) if (f === gone.id) { if (gone.parentId) db.placement[p] = gone.parentId; else delete db.placement[p]; }
        for (const f of db.folders) if (f.parentId === gone.id) f.parentId = gone.parentId;
        db.folders = db.folders.filter((f) => f.id !== gone.id);
        return Promise.resolve();
      }
      if (cmd === "move_project_to_folder") {
        if (args.folderId) db.placement[args.id] = args.folderId; else delete db.placement[args.id];
        return Promise.resolve();
      }
      return Promise.resolve([]);
    },
  };
}, { now: NOW });
page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(500);

const region = page.locator('[data-region="projects"]');
const names = () => region.locator(".cv-project-list > li .cv-project-title").allInnerTexts();
// textContent, not innerText: the heading is styled upper-case.
const heading = () => region.locator("h2").first().textContent();
const newFolder = async (name) => {
  await region.locator("button", { hasText: "New folder" }).click();
  await region.locator('input[aria-label="Folder name"]').fill(name);
  await region.locator("button", { hasText: "Create folder" }).click();
  await page.waitForTimeout(250);
};

// ------------------------------------------------------------- at the top
check("with no folders, every project is listed at the top as before",
  JSON.stringify(await names()) === JSON.stringify(["Branch refresh", "Core swap", "Wireless survey"]), JSON.stringify(await names()));
check("and no move menu is offered while there is nowhere to move to", (await region.locator(".cv-pfolder-move").count()) === 0);

await newFolder("Customer A");
await newFolder("Customer B");
const rows = await names();
check("folders come first, by name, then the projects", JSON.stringify(rows.slice(0, 2).map((r) => r.replace(/^▸\s*/, ""))) === JSON.stringify(["Customer A", "Customer B"]), JSON.stringify(rows));
await region.locator("button", { hasText: "New folder" }).click();
await region.locator('input[aria-label="Folder name"]').fill("customer a");
await region.locator("button", { hasText: "Create folder" }).click();
await page.waitForTimeout(250);
check("a second folder of the same name beside the first is refused, and says why",
  /already a folder called “customer a”/.test(await region.locator(".cv-pfolder-problem").innerText()));
await region.locator("button", { hasText: /^Cancel$/ }).click();

// ------------------------------------------------------- moving by menu
// Matched on a row's own title: a move menu in another row names this one too.
const exact = (name) => new RegExp(`^(▸\\s*)?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const projectRow = (name) => region.locator(".cv-project-list > li[data-project]", { has: page.locator(".cv-project-title", { hasText: exact(name) }) });
const folderRow = (name) => region.locator(".cv-project-list > li.cv-pfolder-row", { has: page.locator(".cv-project-title", { hasText: exact(name) }) });
await projectRow("Branch refresh").locator("select.cv-pfolder-move").selectOption({ label: "Customer A" });
await page.waitForTimeout(300);
check("a project moved into a folder leaves the top", !(await names()).includes("Branch refresh"), JSON.stringify(await names()));
check("and the folder counts it", /1 project/.test(await folderRow("Customer A").innerText()));

// ------------------------------------------------------- into a folder
await folderRow("Customer A").locator(".cv-pfolder-open").click();
await page.waitForTimeout(250);
check("opening a folder shows its name and a way back up",
  (await heading()) === "Customer A" && (await region.locator(".cv-pfolder-crumbs").innerText()).includes("All projects"), await heading());
check("and only what is in it", JSON.stringify(await names()) === JSON.stringify(["Branch refresh"]), JSON.stringify(await names()));
await newFolder("Site 1");
check("a folder made here is a sub-folder", (await names()).some((n) => n.includes("Site 1")));

// A new project made while inside a folder lands in it.
await page.evaluate(() => window.__cvStore.getState().createProject({ name: "Site 1 cutover" }));
await page.waitForTimeout(400);
await page.evaluate(() => window.__cvStore.getState().closeProject());
await page.waitForTimeout(500);
check("a project created inside a folder is filed in that folder",
  (await page.evaluate(() => Object.entries(window.__db.placement).find(([p]) => window.__db.projects.find((x) => x.id === p)?.name === "Site 1 cutover")?.[1])) ===
    (await page.evaluate(() => window.__db.folders.find((f) => f.name === "Customer A").id)));
check("and the screen comes back to the folder it was made in", (await heading()) === "Customer A", await heading());

// ------------------------------------------------------- moving by drag
await projectRow("Site 1 cutover").dragTo(folderRow("Site 1"));
await page.waitForTimeout(300);
check("dragging a project onto a sub-folder moves it there", !(await names()).includes("Site 1 cutover"), JSON.stringify(await names()));
await folderRow("Site 1").locator(".cv-pfolder-open").click();
await page.waitForTimeout(250);
const crumbs = await region.locator(".cv-pfolder-crumbs").innerText();
check("two levels down, the path says so", /All projects\s*›\s*Customer A\s*›\s*Site 1/.test(crumbs), crumbs);
check("and the dragged project is there", JSON.stringify(await names()) === JSON.stringify(["Site 1 cutover"]), JSON.stringify(await names()));
await projectRow("Site 1 cutover").dragTo(region.locator(".cv-pfolder-crumb", { hasText: "All projects" }));
await page.waitForTimeout(300);
check("dragging onto a crumb moves it up to that level", (await names()).length === 0);
check("an empty folder says what to do", /This folder is empty/.test(await region.innerText()));

// ------------------------------------------------ a folder cannot go inside itself
await region.locator(".cv-pfolder-crumb", { hasText: "All projects" }).click();
await page.waitForTimeout(250);
const aMoves = await folderRow("Customer A").locator("select.cv-pfolder-move option").allInnerTexts();
check("a folder's move menu leaves out itself and everything under it",
  !aMoves.some((o) => o.startsWith("Customer A")) && aMoves.includes("Customer B"), JSON.stringify(aMoves));
await folderRow("Customer B").locator("select.cv-pfolder-move").selectOption({ label: "Customer A / Site 1" });
await page.waitForTimeout(300);
check("a folder moves under another", !(await names()).some((n) => n.includes("Customer B")), JSON.stringify(await names()));

// ------------------------------------------------------------- renaming
await folderRow("Customer A").locator("button", { hasText: "Rename" }).click();
await region.locator('.cv-pfolder-row input[aria-label="Folder name"]').fill("Customer Alpha");
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
check("a folder is renamed in place", (await names()).some((n) => n.includes("Customer Alpha")), JSON.stringify(await names()));

// ------------------------------------------------------------- deleting
await folderRow("Customer Alpha").locator("button", { hasText: "Delete folder" }).click();
const dialog = page.locator('[role="dialog"][aria-label="Confirm folder deletion"]');
const said = await dialog.innerText();
check("deleting a folder says what moves where and that no project is deleted",
  /1 project and 2 folders move to All projects\. No project is deleted\./.test(said), said);
await dialog.locator("button", { hasText: "Delete folder" }).click();
await page.waitForTimeout(400);
const after = await names();
check("its project comes up to the top, and its sub-folder with it",
  after.includes("Branch refresh") && after.some((n) => n.includes("Site 1")), JSON.stringify(after));
check("no project was deleted", (await page.evaluate(() => window.__db.projects.length)) === 4);

// ------------------------------------------------------------- archived
await projectRow("Core swap").locator("select.cv-pfolder-move").selectOption({ label: "Site 1" });
await page.waitForTimeout(250);
await page.evaluate(() => { window.__db.projects.find((p) => p.name === "Core swap").archived = true; });
await page.evaluate(() => window.__cvStore.getState().refreshProjects());
await page.locator("label", { hasText: "Show archived" }).locator("input").check();
await page.waitForTimeout(250);
check("archived projects are one flat list, each saying which folder it is in",
  /Core swap/.test(await region.innerText()) && /in Site 1/.test(await region.innerText()) && (await region.locator(".cv-pfolder-row").count()) === 0,
  (await region.innerText()).slice(0, 300));

// Nothing about a folder was written into a project.
const saved = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "save_project").map((c) => JSON.stringify(c.args)));
check("no folder is ever written into a project's package", saved.length > 0 && saved.every((s) => !/folder/i.test(s)), saved.join(" ").slice(0, 200));

await browser.close();
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
