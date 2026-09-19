// The address register, driven through the real app (LT-285).
//
// "Is it possible to add an IPAM to the app" — this is the answer, and the
// checks here are the ones that decide whether it is worth having: subnets
// that appear without being typed, a mask taken from a device's own connected
// route, a next-free address that is actually free, and holding one back.
//
// Documentation addresses only, and invented names: nothing from anyone's
// network is a fixture (D-027).
//
//     npm run dev            # in another terminal
//     node e2e/ipam.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const device = (id, label, x, addresses, extra = {}) => ({
  id, type: "device", position: { x, y: 0 }, width: 76, height: 76,
  data: {
    label, deviceType: "access-switch", tags: [], locked: false, maintenance: false, showDetails: true,
    addresses: addresses.map((address, i) => ({ id: `${id}-a${i}`, label: i === 0 ? "Management" : "Loopback0", address, isPrimary: i === 0 })),
    ...extra,
  },
});

const project = {
  meta: { id: "ipam", name: "Addresses", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    nodes: [
      // A crawled router that knows its own mask: a /25, not the /24 that
      // guessing would give.
      device("n1", "LAB-RTR", 0, ["192.0.2.129"], {
        discoveredVia: "CDP",
        mac: "00:00:5e:00:53:01",
        inventory: {
          collectedAt: NOW, ports: [], vlans: [], spanningTree: [],
          routes: [
            { family: 4, prefix: "192.0.2.128/25", protocol: "connected", nextHops: [], interface: "Vlan10" },
            { family: 4, prefix: "0.0.0.0/0", protocol: "static", nextHops: ["192.0.2.254"] },
          ],
        },
      }),
      device("n2", "LAB-SW", 200, ["192.0.2.130"]),
      // On a different network entirely, so a second block has to appear.
      device("n3", "LAB-SRV", 400, ["198.51.100.10"]),
    ],
    edges: [],
    probes: [],
    canvas: {},
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

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

// LT-300: the register is a screen of its own now, opened from the toolbar.
await page.locator(".cv-btn-register").click();
await page.waitForTimeout(500);
await page.locator('.cv-register-tabs button', { hasText: "Addresses" }).click();
await page.waitForTimeout(400);

const rowFor = (cidr) => page.locator(".cv-ipam-subnet", { hasText: cidr }).first();
const cellText = async (cidr, n) => (await rowFor(cidr).locator("td").nth(n).innerText()).trim();

// ----------------------------------------------- what it knows without being told

check("the register opens on what the project already knows",
  (await page.locator(".cv-ipam-subnet").count()) === 2, `${await page.locator(".cv-ipam-subnet").count()} subnet row(s)`);
check("a crawled connected route gives the real mask, not a guessed /24",
  (await rowFor("192.0.2.128/25").count()) === 1);
check("and it is named after the interface it is on", (await cellText("192.0.2.128/25", 1)) === "Vlan10");
check("a device with no route falls back to its /24",
  (await rowFor("198.51.100.0/24").count()) === 1);
check("the /25 counts both devices on it", (await cellText("192.0.2.128/25", 3)).includes("2 of 126"),
  await cellText("192.0.2.128/25", 3));
check("and offers the first address nothing is on", (await cellText("192.0.2.128/25", 5)).startsWith("192.0.2.131"),
  await cellText("192.0.2.128/25", 5));
check("it says where the subnet came from", (await cellText("192.0.2.128/25", 6)) === "connected route",
  await cellText("192.0.2.128/25", 6));

// Expanding shows the addresses themselves.
// Opens a subnet, and leaves an already-open one open: the toggle bit me.
const expand = async (cidr) => {
  const toggle = rowFor(cidr).locator("button.cv-link");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
    await page.waitForTimeout(250);
  }
};
await expand("192.0.2.128/25");
const addressRows = await page.locator(".cv-ipam-addresses tbody tr").allInnerTexts();
check("expanding a subnet lists what is on it",
  addressRows.some((t) => t.includes("192.0.2.129") && t.includes("LAB-RTR")), addressRows.join(" | "));
check("with the interface each address is on", addressRows.some((t) => t.includes("Management")));
check("and where it was learned", addressRows.some((t) => t.includes("found by a crawl")));

// LT-290: the address rows used to be laid out under the subnet's headings, so
// an interface label printed under "Used" and a MAC under "Free". Read the
// cells against their own header, which is the only way to catch that.
const addressCell = async (address, heading) => {
  // Several subnets can be open at once, so pick the table the address is in
  // rather than the first one on the page.
  const table = page.locator(".cv-ipam-addresses", { has: page.locator(`tbody tr:has-text("${address}")`) }).first();
  const headings = await table.locator("thead th").allInnerTexts();
  // The headings are uppercased by the stylesheet, so compare without case.
  const at = headings.findIndex((h) => h.trim().toLowerCase() === heading.toLowerCase());
  if (at < 0) return `no such column: ${headings.join("|")}`;
  const row = table.locator("tbody tr", { hasText: address }).first();
  return (await row.locator("td").nth(at).innerText()).trim();
};
check("the interface sits under Interface", (await addressCell("192.0.2.129", "Interface")) === "Management",
  await addressCell("192.0.2.129", "Interface"));
check("the device's name sits under Name", (await addressCell("192.0.2.129", "Name")) === "LAB-RTR",
  await addressCell("192.0.2.129", "Name"));
check("the MAC sits under MAC", (await addressCell("192.0.2.129", "MAC")) === "00:00:5e:00:53:01",
  await addressCell("192.0.2.129", "MAC"));
check("a device's address is held as nothing in particular",
  (await addressCell("192.0.2.129", "Held as")) === "", await addressCell("192.0.2.129", "Held as"));

// ------------------------------------------------------------ declaring a subnet

await page.locator("button", { hasText: "Add subnet" }).first().click();
await page.waitForTimeout(200);
const field = (label, root = ".cv-ipam-add") =>
  page.locator(`${root} .cv-field`, { has: page.locator(`span:text-is("${label}")`) }).locator("input, select").first();
await field("Subnet").fill("203.0.113.64/29");
await field("Name").fill("Point to point");
await field("VLAN").fill("40");
await page.locator(".cv-ipam-add button", { hasText: "Add" }).first().click();
await page.waitForTimeout(400);

check("a declared subnet joins the register", (await rowFor("203.0.113.64/29").count()) === 1);
check("with its name and VLAN", (await cellText("203.0.113.64/29", 1)) === "Point to point" && (await cellText("203.0.113.64/29", 2)) === "40");
check("empty, and saying so", (await cellText("203.0.113.64/29", 3)).includes("0 of 6"), await cellText("203.0.113.64/29", 3));

// A subnet typed inside its own range is stored as the network address.
await page.locator("button", { hasText: "Add subnet" }).first().click();
await page.waitForTimeout(200);
await field("Subnet").fill("203.0.113.70/29");
await page.locator(".cv-ipam-add button", { hasText: "Add" }).first().click();
await page.waitForTimeout(300);
check("the same subnet typed from inside it is refused, once",
  (await page.locator(".cv-problem").innerText()).includes("already in the register"),
  await page.locator(".cv-problem").innerText());
await page.locator("button", { hasText: "Cancel" }).first().click();
await page.waitForTimeout(200);

// ------------------------------------------- LT-289: addresses the register owns

await rowFor("203.0.113.64/29").locator("button", { hasText: "Add address" }).click();
await page.waitForTimeout(250);
check("the address form starts on the next free address",
  (await field("Address").inputValue()) === "203.0.113.65", await field("Address").inputValue());
await field("Name").fill("New firewall");
await field("Note").fill("Waiting on the circuit");
await page.locator(".cv-ipam-add button", { hasText: "Add" }).first().click();
await page.waitForTimeout(400);

check("a held address counts as used", (await cellText("203.0.113.64/29", 3)).includes("1 of 6"),
  await cellText("203.0.113.64/29", 3));
check("and the next free address moves past it", (await cellText("203.0.113.64/29", 5)).startsWith("203.0.113.66"),
  await cellText("203.0.113.64/29", 5));

let entries = await page.evaluate(() => window.__cvStore.getState().doc.ipam.entries);
check("the record is kept on the project, with its kind and note",
  entries.length === 1 && entries[0].address === "203.0.113.65" && entries[0].label === "New firewall"
    && entries[0].kind === "reserved" && entries[0].note === "Waiting on the circuit",
  JSON.stringify(entries));

await expand("203.0.113.64/29");
check("and it is listed with the rest of the subnet",
  (await addressCell("203.0.113.65", "Name")) === "New firewall", await addressCell("203.0.113.65", "Name"));
check("saying what it is held as", (await addressCell("203.0.113.65", "Held as")) === "reserved",
  await addressCell("203.0.113.65", "Held as"));

// An address in use by something not on the diagram — a printer, a server.
await rowFor("203.0.113.64/29").locator("button", { hasText: "Add address" }).click();
await page.waitForTimeout(250);
await field("Address").fill("203.0.113.67");
await field("Name").fill("Warehouse printer");
await field("Held as").selectOption("in-use");
await page.locator(".cv-ipam-add button", { hasText: "Add" }).first().click();
await page.waitForTimeout(400);
check("an address in use elsewhere can be recorded", (await cellText("203.0.113.64/29", 3)).includes("2 of 6"),
  await cellText("203.0.113.64/29", 3));

// An excluded address is neither free nor used.
await rowFor("203.0.113.64/29").locator("button", { hasText: "Add address" }).click();
await page.waitForTimeout(250);
await field("Address").fill("203.0.113.70");
await field("Name").fill("Reserved by the router");
await field("Held as").selectOption("excluded");
await page.locator(".cv-ipam-add button", { hasText: "Add" }).first().click();
await page.waitForTimeout(400);
check("an excluded address is not counted as used", (await cellText("203.0.113.64/29", 3)).includes("2 of 6"),
  await cellText("203.0.113.64/29", 3));
check("and is not counted as free either", (await cellText("203.0.113.64/29", 4)) === "3",
  await cellText("203.0.113.64/29", 4));

// Editing one.
await expand("203.0.113.64/29");
await page.locator(".cv-ipam-addresses tbody tr", { hasText: "203.0.113.67" }).first()
  .locator("button", { hasText: "Edit" }).click();
await page.waitForTimeout(250);
await field("Name", ".cv-ipam-addresses .cv-ipam-add").fill("Warehouse printer 2");
await page.locator(".cv-ipam-addresses .cv-ipam-add button", { hasText: "Save" }).first().click();
await page.waitForTimeout(400);
entries = await page.evaluate(() => window.__cvStore.getState().doc.ipam.entries);
check("an address record can be renamed",
  entries.some((e) => e.address === "203.0.113.67" && e.label === "Warehouse printer 2"), JSON.stringify(entries));

// Removing one.
await page.locator(".cv-ipam-addresses tbody tr", { hasText: "203.0.113.70" }).first()
  .locator("button", { hasText: "Remove" }).click();
await page.waitForTimeout(400);
entries = await page.evaluate(() => window.__cvStore.getState().doc.ipam.entries);
check("and removed", !entries.some((e) => e.address === "203.0.113.70"), JSON.stringify(entries));

// ------------------------------------------------- LT-288: editing the subnets

// A subnet the app worked out for itself is named, which adopts it.
await rowFor("198.51.100.0/24").locator("button", { hasText: "Name it" }).click();
await page.waitForTimeout(250);
await field("Name").fill("Server VLAN");
await field("VLAN").fill("120");
await page.locator(".cv-ipam-add button", { hasText: "Save" }).first().click();
await page.waitForTimeout(400);
check("naming a derived subnet adopts it into the register",
  (await cellText("198.51.100.0/24", 1)) === "Server VLAN", await cellText("198.51.100.0/24", 1));
check("and it now says it was declared", (await cellText("198.51.100.0/24", 6)).startsWith("declared"),
  await cellText("198.51.100.0/24", 6));
check("while still saying what derived it",
  (await cellText("198.51.100.0/24", 6)).includes("from addresses"), await cellText("198.51.100.0/24", 6));
check("the device on it is still there", (await page.evaluate(() =>
  window.__cvStore.getState().doc.ipam.subnets.length)) === 2);

// Renaming a declared one.
await rowFor("203.0.113.64/29").locator("button", { hasText: "Edit" }).click();
await page.waitForTimeout(250);
await field("Name").fill("Point to point — renamed");
await page.locator(".cv-ipam-add button", { hasText: "Save" }).first().click();
await page.waitForTimeout(400);
check("a declared subnet can be renamed",
  (await cellText("203.0.113.64/29", 1)) === "Point to point — renamed", await cellText("203.0.113.64/29", 1));

// A bad VLAN is refused rather than stored.
await rowFor("203.0.113.64/29").locator("button", { hasText: "Edit" }).click();
await page.waitForTimeout(250);
await field("VLAN").fill("9999");
await page.locator(".cv-ipam-add button", { hasText: "Save" }).first().click();
await page.waitForTimeout(300);
check("a VLAN outside 1–4094 is refused",
  (await page.locator(".cv-problem").innerText()).includes("1 to 4094"), await page.locator(".cv-problem").innerText());
await page.locator(".cv-ipam-add button", { hasText: "Cancel" }).first().click();
await page.waitForTimeout(250);

// Removing a subnet returns it to derived — the addresses on it are real.
await rowFor("198.51.100.0/24").locator("button", { hasText: "Remove" }).click();
await page.waitForTimeout(400);
check("removing an adopted subnet leaves the subnet itself",
  (await rowFor("198.51.100.0/24").count()) === 1);
check("derived again, and unnamed", (await cellText("198.51.100.0/24", 6)) === "from addresses",
  await cellText("198.51.100.0/24", 6));
check("with its address still on it", (await cellText("198.51.100.0/24", 3)).includes("1 of 254"),
  await cellText("198.51.100.0/24", 3));

// One undo puts it back, because the register is part of the document.
// Undo from the register itself: the diagram is behind this screen, and the
// shortcut is on the window rather than on the canvas.
await page.keyboard.press("Control+z");
await page.waitForTimeout(400);
check("one undo restores a removed subnet",
  (await page.evaluate(() => window.__cvStore.getState().doc.ipam.subnets.length)) === 2);

// ----------------------------------------------- LT-294: ranges, and what free means

await rowFor("203.0.113.64/29").locator("button", { hasText: "Add range" }).click();
await page.waitForTimeout(250);
await field("From").fill("203.0.113.68");
await field("To").fill("203.0.113.69");
await field("Name").fill("Guest pool");
await page.locator(".cv-ipam-add button", { hasText: "Add" }).first().click();
await page.waitForTimeout(400);

check("a DHCP pool is not counted as used", (await cellText("203.0.113.64/29", 3)).includes("2 of 6"),
  await cellText("203.0.113.64/29", 3));
check("and the subnet says how many are in it", (await cellText("203.0.113.64/29", 3)).includes("in a pool"),
  await cellText("203.0.113.64/29", 3));
// Six usable, two taken by records, two in the pool.
check("the pool comes out of free, not out of nowhere", (await cellText("203.0.113.64/29", 4)) === "2",
  await cellText("203.0.113.64/29", 4));

const ranges = await page.evaluate(() => window.__cvStore.getState().doc.ipam.ranges);
check("the range is kept on the project",
  ranges.length === 1 && ranges[0].from === "203.0.113.68" && ranges[0].kind === "dhcp", JSON.stringify(ranges));

await expand("203.0.113.64/29");
check("and it is listed above the addresses",
  (await page.locator(".cv-ipam-ranges tbody tr").allInnerTexts()).some((t) => t.includes("Guest pool")));

// A range that runs backwards is refused rather than stored.
await rowFor("203.0.113.64/29").locator("button", { hasText: "Add range" }).click();
await page.waitForTimeout(250);
await field("From").fill("203.0.113.70");
await field("To").fill("203.0.113.66");
await page.locator(".cv-ipam-add button", { hasText: "Add" }).first().click();
await page.waitForTimeout(300);
check("a range that runs backwards is refused",
  (await page.locator(".cv-problem").innerText()).includes("before"), await page.locator(".cv-problem").innerText());
await page.locator(".cv-ipam-add button", { hasText: "Cancel" }).first().click();
await page.waitForTimeout(200);

// Removing it gives the addresses back.
await expand("203.0.113.64/29");
await page.locator(".cv-ipam-ranges tbody tr", { hasText: "Guest pool" }).first()
  .locator("button", { hasText: "Remove" }).click();
await page.waitForTimeout(400);
check("removing the pool returns its addresses to free", (await cellText("203.0.113.64/29", 4)) === "4",
  await cellText("203.0.113.64/29", 4));

// ------------------------- LT-295: a device's own address, edited from here

await expand("192.0.2.128/25");
await page.locator(".cv-ipam-addresses tbody tr", { hasText: "192.0.2.130" }).first()
  .locator("button", { hasText: "Edit" }).click();
await page.waitForTimeout(300);
const deviceForm = page.locator(".cv-ipam-addresses .cv-ipam-add").first();
check("editing a device's address says it edits the device",
  (await deviceForm.locator(".cv-help").innerText()).includes("on the diagram"),
  (await deviceForm.locator(".cv-help").innerText()).slice(0, 60));
await deviceForm.locator('.cv-field', { has: page.locator('span:text-is("Name")') })
  .locator("input").first().fill("LAB-SW renamed");
await deviceForm.locator('.cv-field', { has: page.locator('span:text-is("Address")') })
  .locator("input").first().fill("192.0.2.131");
await deviceForm.locator("button", { hasText: "Save" }).first().click();
await page.waitForTimeout(500);

const moved = await page.evaluate(() => {
  const n = window.__cvStore.getState().doc.pages[0].nodes.find((x) => x.id === "n2");
  return { label: n.data.label, address: n.data.addresses[0].address };
});
check("the edit writes through to the device on the diagram",
  moved.label === "LAB-SW renamed" && moved.address === "192.0.2.131", JSON.stringify(moved));
check("and the register shows it where it now is",
  (await addressCell("192.0.2.131", "Name")) === "LAB-SW renamed", await addressCell("192.0.2.131", "Name"));

// Undo from the register itself: the diagram is behind this screen, and the
// shortcut is on the window rather than on the canvas.
await page.keyboard.press("Control+z");
await page.waitForTimeout(500);
const back = await page.evaluate(() => {
  const n = window.__cvStore.getState().doc.pages[0].nodes.find((x) => x.id === "n2");
  return { label: n.data.label, address: n.data.addresses[0].address };
});
check("one undo puts the device back", back.label === "LAB-SW" && back.address === "192.0.2.130",
  JSON.stringify(back));

// ------------------------------------------------ LT-297: the fuller record

await rowFor("192.0.2.128/25").locator("button", { hasText: "Add address" }).click();
await page.waitForTimeout(250);
await field("Address").fill("192.0.2.200");
await field("Name").fill("Badge reader");
await field("Used as").selectOption("static");
await field("Hostname").fill("badge-01");
await field("FQDN").fill("badge-01.example.invalid");
await field("MAC").fill("00:00:5e:00:53:23");
await field("Owner").fill("Facilities");
await field("Purpose").fill("Door controller");
await page.locator(".cv-ipam-add button", { hasText: "Add" }).first().click();
await page.waitForTimeout(400);
await expand("192.0.2.128/25");
check("an address record carries a hostname", (await addressCell("192.0.2.200", "Hostname")) === "badge-01");
check("an owner", (await addressCell("192.0.2.200", "Owner")) === "Facilities");
check("a purpose", (await addressCell("192.0.2.200", "Purpose")) === "Door controller");
check("and what it is used as", (await addressCell("192.0.2.200", "Used as")) === "static",
  await addressCell("192.0.2.200", "Used as"));

// The filter box reaches all of it.
await page.locator(".cv-ipam-filter").fill("Facilities");
await page.waitForTimeout(300);
// Other open subnets keep their heading and say they match nothing, so count
// the rows that are actually addresses.
const left = (await page.locator(".cv-ipam-addresses tbody tr").allInnerTexts())
  .filter((x) => /\d+\.\d+\.\d+\.\d+/.test(x));
check("the filter finds an address by its owner",
  left.length === 1 && left[0].includes("192.0.2.200"), left.join(" | "));
await page.locator(".cv-ipam-filter").fill("");
await page.waitForTimeout(250);

// -------------------------------------------------------------- the CSV export

const csv = await page.evaluate(async () => {
  const { ipamCsv } = await import("/src/lib/tableCsv.ts");
  return ipamCsv(window.__cvStore.getState().doc);
});
// Three devices and three typed records, plus the header.
check("the register exports a row per known address",
  csv.split("\n").filter(Boolean).length === 7, `${csv.split("\n").filter(Boolean).length} line(s)`);
check("the export carries the subnet, the device and the interface",
  csv.includes("192.0.2.128/25") && csv.includes("LAB-RTR") && csv.includes("Management"));
check("and what a typed address is held as",
  csv.includes("Warehouse printer 2") && csv.includes("in-use"), csv.split("\n").find((l) => l.includes("Warehouse")) ?? "");

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
