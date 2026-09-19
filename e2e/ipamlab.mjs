// The IPAM tab: hierarchy, allocation, split and merge, history (LT-297).
//
// "Build them and design a new dedicated tab for them to switch over to."
// These are the checks that decide whether that tab is worth having: a
// container that knows what is left in it, a wizard that refuses a bad
// address, a split that will not cut a DHCP pool in half, and a history that
// says what changed.
//
// Documentation addresses and invented names only (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/ipamlab.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const device = (id, label, type, x, address, extra = {}) => ({
  id, type: "device", position: { x, y: 0 }, width: 76, height: 76,
  data: {
    label, deviceType: type, tags: [], locked: false, maintenance: false, showDetails: true,
    addresses: [{ id: `${id}-a`, label: "Management", address, isPrimary: true }],
    ...extra,
  },
});

const project = {
  meta: { id: "lab", name: "Lab", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    nodes: [
      device("n1", "Core", "core-switch", 0, "192.0.2.10", { mac: "00:00:5e:00:53:01" }),
      device("n2", "Access", "access-switch", 200, "192.0.2.11"),
    ],
    edges: [], probes: [], canvas: {},
    ipam: {
      containers: [
        { id: "c1", name: "All of our space", cidr: "198.51.0.0/16" },
        { id: "c2", name: "Site", cidr: "198.51.100.0/22" },
      ],
      subnets: [
        { id: "s1", cidr: "192.0.2.0/24", name: "Office", vlan: 30 },
        { id: "s2", cidr: "198.51.100.0/24", name: "Voice", vlan: 31, containerId: "c2" },
      ],
      ranges: [{ id: "r1", from: "192.0.2.50", to: "192.0.2.80", kind: "dhcp", name: "Staff laptops" }],
      entries: [
        { id: "e1", address: "192.0.2.40", label: "Badge reader", kind: "in-use",
          assignment: "static", mac: "00:00:5e:00:53:23", owner: "Facilities" },
      ],
    },
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1750, height: 1000 } });

await page.addInitScript(({ p }) => {
  localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
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
      if (cmd === "vault_status") return Promise.resolve({ exists: false, unlocked: false, credentials: 0, minimumPassphrase: 12 });
      return Promise.resolve([]);
    },
  };
}, { p: project });

page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(900);
if (await page.locator(".cv-recovery").count()) {
  await page.locator(".cv-recovery button", { hasText: "Keep what was saved" }).click();
  await page.waitForTimeout(300);
}

// ------------------------------------------------------------- the tab itself

// LT-300: one screen, reached from the toolbar, with one bar of five views —
// and neither of the old bottom-panel tabs left behind.
check("the toolbar opens the register", (await page.locator(".cv-btn-register").count()) === 1);
const panelTabs = page.locator('.cv-panel-head button[role="tab"]');
check("and the bottom panel no longer carries it",
  (await panelTabs.filter({ hasText: "IPAM" }).count()) === 0 &&
  (await panelTabs.filter({ hasText: "Addresses" }).count()) === 0,
  (await panelTabs.allInnerTexts()).join(", "));

await page.locator(".cv-btn-register").click();
await page.waitForTimeout(500);
check("the register takes the screen", (await page.locator(".cv-register").count()) === 1);
check("the diagram and the bottom panel give way to it",
  (await page.locator(".cv-panel").count()) === 0 &&
  (await page.locator(".cv-main.is-behind").count()) === 1);
check("five views, in one bar",
  (await page.locator(".cv-register-tabs button").allInnerTexts()).join("|") ===
    "Addresses|Hierarchy|Allocate|Split & merge|History",
  (await page.locator(".cv-register-tabs button").allInnerTexts()).join("|"));
check("and it opens on the addresses", (await page.locator(".cv-ipam-table").count()) === 1);

const view = (name) => page.locator(".cv-register-tabs button", { hasText: name }).first();
await view("Hierarchy").click();
await page.waitForTimeout(400);
check("switching to the hierarchy shows the containers",
  (await page.locator(".cv-lab-container").count()) > 0);

// ------------------------------------------------------- LT-297: the hierarchy

const containerRow = (cidr) => page.locator(".cv-lab-container", { hasText: cidr }).first();
const cell = async (row, n) => (await row.locator("td").nth(n).innerText()).trim();

check("containers nest by what contains what",
  (await page.locator(".cv-lab-container").count()) === 2,
  `${await page.locator(".cv-lab-container").count()} container row(s)`);
check("a container knows its whole capacity",
  (await cell(containerRow("198.51.0.0/16"), 1)) === "65,536", await cell(containerRow("198.51.0.0/16"), 1));
check("what it has given out", (await cell(containerRow("198.51.0.0/16"), 2)) === "1,024",
  await cell(containerRow("198.51.0.0/16"), 2));
check("and what is left to give", (await cell(containerRow("198.51.0.0/16"), 3)) === "64,512",
  await cell(containerRow("198.51.0.0/16"), 3));
check("the subnet sits under the most specific container that holds it",
  (await page.locator(".cv-lab-subnet", { hasText: "198.51.100.0/24" }).count()) === 1);
check("and a subnet in no container is listed apart",
  (await page.locator("h3", { hasText: "Not in a container" }).count()) === 1);

// Taking a subnet out of a container's free space.
await containerRow("198.51.100.0/22").locator("button", { hasText: "Take a subnet from this" }).click();
await page.waitForTimeout(300);
const takeForm = page.locator(".cv-ipam-form-row .cv-ipam-add").first();
const blockPick = takeForm.locator('.cv-field', { has: page.locator('span:text-is("Which block")') }).locator("select");
const offered = await blockPick.locator("option").allInnerTexts();
check("it offers the free blocks of that size, lowest first",
  offered[0] === "198.51.101.0/26", offered.join(" | "));

// LT-302: and the subnet is defined as it is taken, not afterwards.
await takeForm.locator('.cv-field', { has: page.locator('span:text-is("Name")') }).locator("input").fill("Third floor");
await takeForm.locator('.cv-field', { has: page.locator('span:text-is("VLAN")') }).locator("input").fill("140");
await takeForm.locator('.cv-field', { has: page.locator('span:text-is("Note")') }).locator("input").fill("For the new APs");
await takeForm.locator("button", { hasText: "Take it" }).click();
await page.waitForTimeout(500);
const taken = await page.evaluate(() =>
  window.__cvStore.getState().doc.ipam.subnets.find((x) => x.cidr === "198.51.101.0/26"));
check("taking one adds it to the register", Boolean(taken), JSON.stringify(taken));
check("with the name, VLAN and note it was given",
  taken?.name === "Third floor" && taken?.vlan === 140 && taken?.note === "For the new APs",
  JSON.stringify(taken));
check("inside the container it came from", taken?.containerId === "c2");

// A block other than the first can be chosen.
await containerRow("198.51.100.0/22").locator("button", { hasText: "Take a subnet from this" }).click();
await page.waitForTimeout(300);
await page.locator(".cv-ipam-form-row .cv-ipam-add").first()
  .locator('.cv-field', { has: page.locator('span:text-is("Which block")') })
  .locator("select").selectOption("198.51.101.128/26");
await page.locator(".cv-ipam-form-row .cv-ipam-add").first()
  .locator('.cv-field', { has: page.locator('span:text-is("Name")') }).locator("input").fill("Spare");
await page.locator(".cv-ipam-form-row .cv-ipam-add").first().locator("button", { hasText: "Take it" }).click();
await page.waitForTimeout(500);
check("a block further down the list can be taken instead",
  (await page.evaluate(() => window.__cvStore.getState().doc.ipam.subnets.map((s) => s.cidr)))
    .includes("198.51.101.128/26"));

// LT-301: a container can be edited, which it could not be at all.
await containerRow("198.51.0.0/16").locator("button", { hasText: "Edit" }).click();
await page.waitForTimeout(300);
const editForm = page.locator(".cv-ipam-form-row .cv-ipam-add").first();
await editForm.locator('.cv-field', { has: page.locator('span:text-is("Name")') })
  .locator("input").fill("All of our space, renamed");
await editForm.locator('.cv-field', { has: page.locator('span:text-is("Note")') })
  .locator("input").fill("Owned since 2019");
await editForm.locator("button", { hasText: "Save" }).click();
await page.waitForTimeout(500);
const renamed = await page.evaluate(() =>
  window.__cvStore.getState().doc.ipam.containers.find((c) => c.id === "c1"));
check("a container can be renamed", renamed?.name === "All of our space, renamed", JSON.stringify(renamed));
check("and given a note", renamed?.note === "Owned since 2019", JSON.stringify(renamed));
check("the row shows the new name",
  (await containerRow("198.51.0.0/16").innerText()).includes("All of our space, renamed"));

// Its prefix can be corrected too, and a bad one is refused.
await containerRow("198.51.0.0/16").locator("button", { hasText: "Edit" }).click();
await page.waitForTimeout(300);
await page.locator(".cv-ipam-form-row .cv-ipam-add").first()
  .locator('.cv-field', { has: page.locator('span:text-is("Subnet")') }).locator("input").fill("not a subnet");
await page.locator(".cv-ipam-form-row .cv-ipam-add").first().locator("button", { hasText: "Save" }).click();
await page.waitForTimeout(300);
check("a container's prefix is validated like any other",
  (await page.locator(".cv-problem").innerText()).includes("not an IPv4 subnet"),
  (await page.locator(".cv-problem").innerText()).slice(0, 80));
await page.locator(".cv-ipam-form-row .cv-ipam-add").first().locator("button", { hasText: "Cancel" }).click();
await page.waitForTimeout(300);

// LT-302: a container with every address given out says what is using it.
await page.evaluate(() => {
  const st = window.__cvStore.getState();
  st.addIpamContainer({ name: "Filled", cidr: "203.0.113.0/24" });
  st.addIpamSubnet("203.0.113.0/24", { name: "All of it" });
});
await page.waitForTimeout(500);
await containerRow("203.0.113.0/24").locator("button", { hasText: "Take a subnet from this" }).click();
await page.waitForTimeout(400);
const whyNot = await page.locator(".cv-ipam-form-row .cv-help").first().innerText();
check("a full container says what is using the space, not just that none is free",
  whyNot.includes("203.0.113.0/24") && whyNot.includes("All of it"), whyNot.slice(0, 160));
await page.locator(".cv-ipam-form-row .cv-ipam-add").first().locator("button", { hasText: "Cancel" }).click();
await page.waitForTimeout(300);

// A routing table of its own.
await page.locator("button", { hasText: "Routing tables" }).first().click();
await page.waitForTimeout(300);
await page.locator('.cv-field', { has: page.locator('span:text-is("Add routing table")') })
  .locator("input").fill("Lab");
await page.locator(".cv-ipam-add button", { hasText: "Add" }).first().click();
await page.waitForTimeout(400);
const vrfs = await page.evaluate(() => window.__cvStore.getState().doc.ipam.vrfs ?? []);
check("a routing table can be added", vrfs.length === 1 && vrfs[0].name === "Lab", JSON.stringify(vrfs));
check("and the default one is offered beside it",
  (await page.locator(".cv-lab-head select option").allInnerTexts()).includes("Global"));

// ------------------------------------------------------- LT-297: the wizard

await view("Allocate").click();
await page.waitForTimeout(400);
check("the wizard asks in four steps", (await page.locator(".cv-lab-wizard section").count()) === 4);
check("and refuses to start without a subnet",
  await page.locator("button", { hasText: "Allocate it" }).first().isDisabled());

const subnetPick = page.locator('.cv-field', { has: page.locator('span:text-is("Which subnet")') })
  .locator("select");
await subnetPick.selectOption({ index: 1 });
await page.waitForTimeout(400);
check("choosing a subnet offers its next free address",
  (await page.locator(".cv-lab-view").innerText()).includes("192.0.2.1"),
  (await page.locator(".cv-lab-view").innerText()).slice(0, 120));

// A specific address inside the DHCP pool is refused, and says why.
await page.locator('input[type="radio"]').nth(1).check();
await page.waitForTimeout(200);
await page.locator('.cv-field', { has: page.locator('span:text-is("Address")') }).locator("input").fill("192.0.2.60");
await page.waitForTimeout(400);
let problems = await page.locator(".cv-lab-problems").innerText();
check("an address inside a DHCP pool is refused", problems.includes("DHCP pool Staff laptops"), problems.slice(0, 120));
check("and it will not allocate", await page.locator("button", { hasText: "Allocate it" }).first().isDisabled());

// The broadcast address is refused too.
await page.locator('.cv-field', { has: page.locator('span:text-is("Address")') }).locator("input").fill("192.0.2.255");
await page.waitForTimeout(400);
problems = await page.locator(".cv-lab-problems").innerText();
check("so is the broadcast address", problems.includes("broadcast"), problems.slice(0, 120));

// A duplicate MAC anywhere in the project is caught.
await page.locator('.cv-field', { has: page.locator('span:text-is("Address")') }).locator("input").fill("192.0.2.90");
await page.locator('.cv-field', { has: page.locator('span:text-is("MAC")') }).locator("input").fill("00:00:5E:00:53:23");
await page.waitForTimeout(400);
problems = await page.locator(".cv-lab-problems").innerText();
check("a MAC already used elsewhere is caught, whatever its case",
  problems.includes("192.0.2.40"), problems.slice(0, 160));

// A clean one goes through.
await page.locator('.cv-field', { has: page.locator('span:text-is("MAC")') }).locator("input").fill("00:00:5e:00:53:44");
await page.locator('.cv-field', { has: page.locator('span:text-is("Name")') }).locator("input").first().fill("New camera");
await page.locator('.cv-field', { has: page.locator('span:text-is("Owner")') }).locator("input").fill("Security");
await page.waitForTimeout(400);
check("a clean address passes every check",
  (await page.locator(".cv-lab-view").innerText()).includes("passes every check"));
await page.locator("button", { hasText: "Allocate it" }).first().click();
await page.waitForTimeout(500);
const made = await page.evaluate(() =>
  window.__cvStore.getState().doc.ipam.entries.find((e) => e.address === "192.0.2.90"));
check("allocating writes the whole record",
  made?.label === "New camera" && made?.owner === "Security" && made?.mac === "00:00:5e:00:53:44",
  JSON.stringify(made));

// ------------------------------------------------- LT-297: split, and merge

await view("Split & merge").click();
await page.waitForTimeout(400);
const splitPick = page.locator('.cv-field', { has: page.locator('span:text-is("Subnet")') }).locator("select");
await splitPick.selectOption({ label: "192.0.2.0/24 · Office" });
await page.waitForTimeout(400);
check("a split is reviewed before it happens",
  (await page.locator(".cv-lab-view table tbody tr").count()) === 4,
  `${await page.locator(".cv-lab-view table tbody tr").count()} row(s)`);
check("and a range crossing a boundary stops it",
  (await page.locator(".cv-lab-problems").innerText()).includes("crosses a boundary"),
  (await page.locator(".cv-lab-problems").innerText()).slice(0, 140));
check("so the split button is refused",
  await page.locator("button", { hasText: "Split it" }).first().isDisabled());

// Splitting the other subnet, which nothing straddles, works.
await splitPick.selectOption({ label: "198.51.100.0/24 · Voice" });
await page.waitForTimeout(400);
check("a split with nothing in the way is offered",
  !(await page.locator("button", { hasText: "Split it" }).first().isDisabled()));
await page.locator("button", { hasText: "Split it" }).first().click();
await page.waitForTimeout(600);
const after = await page.evaluate(() => window.__cvStore.getState().doc.ipam.subnets.map((s) => s.cidr));
check("the subnet becomes its children", after.includes("198.51.100.0/26") && !after.includes("198.51.100.0/24"),
  JSON.stringify(after));
check("which keep the container they came out of",
  (await page.evaluate(() => {
    const s = window.__cvStore.getState().doc.ipam.subnets.find((x) => x.cidr === "198.51.100.64/26");
    return s?.containerId;
  })) === "c2");

// And merging two of them back.
const firstPick = page.locator('.cv-field', { has: page.locator('span:text-is("First subnet")') }).locator("select");
const secondPick = page.locator('.cv-field', { has: page.locator('span:text-is("Second subnet")') }).locator("select");
// Adjacent, and still not a pair: .64 and .128 touch, but the halves of a /25
// are .0+.64 or .128+.192. Merging these two would take in space that is not
// theirs, and it says so.
await firstPick.selectOption({ label: "198.51.100.64/26" });
await secondPick.selectOption({ label: "198.51.100.128/26" });
await page.waitForTimeout(400);
check("two that touch but are not halves of one block are refused",
  (await page.locator(".cv-problem").innerText()).includes("halves of one"),
  (await page.locator(".cv-problem").innerText()).slice(0, 120));
await firstPick.selectOption({ label: "198.51.100.0/26" });
await secondPick.selectOption({ label: "198.51.100.64/26" });
await page.waitForTimeout(400);
check("two real halves say what they would become",
  (await page.locator(".cv-lab-view").innerText()).includes("198.51.100.0/25"));
await page.locator("button", { hasText: "Merge them" }).first().click();
await page.waitForTimeout(600);
const merged = await page.evaluate(() => window.__cvStore.getState().doc.ipam.subnets.map((s) => s.cidr));
check("and merging makes the one", merged.includes("198.51.100.0/25"), JSON.stringify(merged));

// ------------------------------------------------------ LT-297: the history

await view("History").click();
await page.waitForTimeout(400);
const history = await page.locator(".cv-lab-view table tbody tr").allInnerTexts();
check("every change is in the history", history.length >= 5, `${history.length} row(s)`);
check("the newest is first", history[0]?.includes("Merged subnet 198.51.100.0/25"), history[0]?.slice(0, 80));
check("an allocation is recorded with what it was",
  history.some((h) => h.includes("Added address 192.0.2.90") && h.includes("New camera")),
  history.find((h) => h.includes("192.0.2.90"))?.slice(0, 160) ?? "");
check("and a split says what it became",
  history.some((h) => h.includes("Split subnet") && h.includes("198.51.100.64/26")));

// Undo reaches all of it, because the register is part of the document.
await page.keyboard.press("Control+z");
await page.waitForTimeout(500);
check("one undo puts the merge back",
  (await page.evaluate(() => window.__cvStore.getState().doc.ipam.subnets.map((s) => s.cidr)))
    .includes("198.51.100.64/26"));

// And the way back.
await page.locator(".cv-register-back").click();
await page.waitForTimeout(500);
check("leaving comes back to the diagram", (await page.locator(".cv-register").count()) === 0);
check("with the bottom panel where it was", (await page.locator(".cv-panel").count()) === 1);
check("and the diagram still on the page", (await page.locator(".react-flow").count()) === 1);

// ------------------------------------------------ LT-303: the guide, in the app

await page.locator(".cv-btn-help").click();
await page.waitForTimeout(600);
check("Help opens the guide on a screen of its own", (await page.locator(".cv-helpscreen").count()) === 1);
check("with the diagram and panel out of the way",
  (await page.locator(".cv-panel").count()) === 0 && (await page.locator(".cv-main.is-behind").count()) === 1);
const sections = await page.locator(".cv-help-navitem").allInnerTexts();
check("the whole user guide is in it", sections.length > 20, `${sections.length} section(s)`);
check("starting at the beginning", sections[0] === "Create a project", sections[0]);
check("and the first section is shown", (await page.locator(".cv-help-h2").innerText()) === "Create a project");

// The search reads the body, not only the headings.
await page.locator(".cv-help-search").fill("passphrase");
await page.waitForTimeout(400);
const hits = await page.locator(".cv-help-navitem").allInnerTexts();
check("searching finds sections by what is inside them",
  hits.length > 0 && hits.length < sections.length, `${hits.length} of ${sections.length}`);
check("and the body follows the search", hits.includes(await page.locator(".cv-help-h2").innerText()),
  await page.locator(".cv-help-h2").innerText());

await page.locator(".cv-help-search").fill("nothing in here matches this");
await page.waitForTimeout(400);
check("a search that finds nothing says so",
  (await page.locator(".cv-help-body").innerText()).includes("Nothing in the guide matches"));

await page.locator(".cv-helpscreen .cv-register-back").click();
await page.waitForTimeout(500);
check("and it gives the diagram back", (await page.locator(".cv-helpscreen").count()) === 0);
check("with the bottom panel where it was", (await page.locator(".cv-panel").count()) === 1);

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
