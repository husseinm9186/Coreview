// "Where is this?" (LT-338): one search over everything a crawl found.
//
// The point of the feature is the things that are *not* on the diagram — a
// printer nobody drew is still a MAC on a port. So the fixture deliberately
// draws one device and has the crawl know about several more, and the checks
// are that the undrawn ones are findable.
//
// A wireless client is the other half: a FortiGate reports its clients with
// the SSID where a switch reports a port, so asking where a handset is must
// answer with its SSID and the controller that saw it.
//
//     npm run dev            # in another terminal
//     node e2e/whereis.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const project = {
  meta: { id: "whereis", name: "Where is", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    activePageId: "p1", probes: [],
    pages: [{ id: "p1", name: "Core",
      canvas: { gridEnabled: true, snapEnabled: true, minimap: false, nodeStyle: "glyph" }, edges: [],
      nodes: [{ id: "a", type: "device", position: { x: 0, y: 0 }, width: 76, height: 76,
        data: { label: "LAB-ACCESS-SW1", hostname: "LAB-ACCESS-SW1", deviceType: "access-switch", tags: [] } }] }],
  },
};

const attached = (a) => ({
  mac: "00:00:5e:00:53:99", port: "Gi0/9", address: null, vendor: null,
  hostname: null, class: null, vlan: null, portPopulation: 1, ...a,
});

const crawl = {
  devices: [
    {
      hostname: "LAB-ACCESS-SW1", address: "192.0.2.11",
      addresses: [{ ip: "192.0.2.11", interface: "Vlan1", isManagement: false }],
      probeTarget: "192.0.2.11", class: "switch", platform: "WS-C2960CX-8PC-L",
      serial: "FOC0000TEST", version: null, neighbors: [], hops: 0, reachedBy: "ssh",
      attached: [
        attached({ mac: "00:0c:e6:00:00:a0", port: "Gi0/7", vlan: "14",
          hostname: "PRINTER-2F", vendor: "Hewlett Packard", address: "192.0.2.60" }),
        attached({ mac: "74:56:3c:00:00:01", port: "Gi0/1", vlan: "1", portPopulation: 9 }),
      ],
    },
    {
      hostname: "LAB-FW1", address: "192.0.2.1",
      addresses: [{ ip: "192.0.2.1", interface: "wan1", isManagement: false }],
      probeTarget: "192.0.2.1", class: "firewall", platform: "FortiGate-60F",
      serial: "FGT0000TEST", version: null, neighbors: [], hops: 1, reachedBy: "ssh",
      attached: [
        attached({ mac: "aa:bb:cc:00:00:01", port: "CORP-WIFI", hostname: "handset-7",
          vendor: "Apple", address: "192.0.2.90" }),
      ],
    },
  ],
  failures: [],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.addInitScript(({ p, c }) => {
  localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
  let next = 1;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return next++; },
    invoke(cmd) {
      if (cmd === "plugin:event|listen") return Promise.resolve(next++);
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "",
        engineer: "", description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({});
      if (cmd === "list_crawl_runs") return Promise.resolve([{ id: "run-1", takenAt: 1756000000000, seed: "192.0.2.11", devices: 2 }]);
      if (cmd === "crawl_run_result") return Promise.resolve(c);
      return Promise.resolve([]);
    },
  };
}, { p: project, c: crawl });

page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(900);
if (await page.locator(".cv-recovery").count()) {
  await page.locator(".cv-recovery button", { hasText: "Keep what was saved" }).click();
  await page.waitForTimeout(300);
}

const tab = page.getByRole("tab", { name: "Where is", exact: true });
check("the panel offers a Where is tab", (await tab.count()) === 1);
await tab.click();
await page.waitForTimeout(500);

const box = page.locator(".cv-whereis input.cv-mono").first();
check("it offers something to type into", (await box.count()) === 1);

const rows = () => page.locator(".cv-whereis table tbody tr");
const rowText = async () => (await rows().allTextContents()).join(" | ");

check("nothing is listed before a question is asked", (await rows().count()) === 0);

// A MAC, written the way a Cisco writes it rather than the way the fixture does.
await box.fill("000c.e600.00a0");
await page.waitForTimeout(400);
check("a MAC finds the thing however it is punctuated", (await rows().count()) === 1, await rowText());
check("and says which switch and port it is on", /LAB-ACCESS-SW1/.test(await rowText()) && /Gi0\/7/.test(await rowText()), await rowText());
// Read the VLAN cell itself: joined row text runs "Gi0/7" and "14" together.
const cell = (n) => rows().first().locator("td").nth(n).innerText();
check("and the VLAN it was learned on", (await cell(5)).trim() === "14", await cell(5));

// The printer is not on the diagram at all; that is the point of the feature.
check("a thing that was never drawn is still found", /PRINTER-2F/.test(await rowText()), await rowText());

await box.fill("handset-7");
await page.waitForTimeout(400);
check("a wireless client answers with its SSID", /CORP-WIFI/.test(await rowText()), await rowText());
check("and the controller that saw it", /LAB-FW1/.test(await rowText()), await rowText());

await box.fill("hewlett");
await page.waitForTimeout(400);
check("a maker's name finds what it made", /PRINTER-2F/.test(await rowText()), await rowText());

await box.fill("74:56:3c:00:00:01");
await page.waitForTimeout(400);
check("a port leading to another switch is marked shared", /shared/i.test(await rowText()), await rowText());

await box.fill("LAB-FW1");
await page.waitForTimeout(400);
check("a crawled device is findable in its own right", /crawled/i.test(await rowText()), await rowText());

await box.fill("nothing-like-this-at-all");
await page.waitForTimeout(400);
check("a miss says so rather than listing everything", (await rows().count()) === 0);
check("and says which query missed", /nothing-like-this-at-all/.test(await page.locator(".cv-whereis").innerText()));

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
