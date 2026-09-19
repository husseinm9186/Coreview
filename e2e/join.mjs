// Sweep first, crawl second — and the diagram has to end up as one network
// (LT-126).
//
// The report this exists for: "the cdp/lldp crowler and the sweep don't really
// build the diagram like they are disconnected". A sweep placed hosts, a crawl
// drew the infrastructure, and nothing joined them — so the same host appeared
// twice and the swept copy stayed floating.
//
// Both halves are stubbed at the Tauri bridge; everything above it is the real
// application, including the topology builder that does the joining.
//
//     npm run dev            # in another terminal
//     node e2e/join.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

// The switch itself, swept before it was crawled. No name came back, so the
// sweep labels it with the address — which is the case LT-132 was about.
const SWEPT_SWITCH = {
  ip: "192.168.77.7",
  rttMs: 3.0,
  hostname: null,
  nameSource: null,
  mac: "cc:7f:75:00:00:03",
  vendor: "Cisco Systems",
  ports: [{ port: 22, service: "SSH" }],
};

// The Windows host from the operator's own subnet, as the sweep reports it.
const SWEPT = {
  ip: "192.168.77.129",
  rttMs: 0.5,
  hostname: "LabDesktop01",
  nameSource: "llmnr",
  mac: "74:56:3c:00:00:01",
  vendor: "GIGA-BYTE TECHNOLOGY CO.,LTD.",
  ports: [{ port: 445, service: "SMB" }],
};

// The same machine as the switch sees it: Cisco's spelling of that MAC, on a
// port. Nothing here says "LabDesktop01" — the MAC is the only thing the two
// halves share, which is the whole point.
const crawlResult = {
  devices: [
    {
      hostname: "ACC-SW1",
      serial: null,
      // LT-145: its own default route, so the layout has evidence rather than
      // a glyph to go on.
      defaultNextHop: "192.168.77.1",
      address: "192.168.77.7",
      addresses: [{ ip: "192.168.77.7", interface: null, isManagement: true }],
      probeTarget: "192.168.77.7",
      class: "switch",
      platform: "C9300-24T",
      version: null,
      neighbors: [],
      hops: 0,
      reachedBy: "ssh",
      attached: [
        {
          mac: "7456.3c00.0001",
          port: "GigabitEthernet1/0/11",
          address: null,
          vendor: "GIGA-BYTE TECHNOLOGY CO.,LTD.",
          hostname: null,
          class: null,
          portPopulation: 1,
          vlan: "10",
        },
      ],
      portChannels: [],
    },
  ],
  notVisited: [],
  failures: [],
  cancelled: false,
};

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const project = {
  meta: { id: "join", name: "Join", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: { nodes: [], edges: [], probes: [], canvas: {} },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });

await page.addInitScript(({ p }) => {
  localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
  const listeners = {}, callbacks = {};
  let next = 1;
  window.__cvEmit = (event, payload) => {
    const id = listeners[event];
    if (id && callbacks[id]) callbacks[id]({ event, id, payload });
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const id = next++; callbacks[id] = cb; return id; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") { listeners[args.event] = args.handler; return Promise.resolve(next++); }
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "",
        engineer: "", description: "", created_at: p.meta.createdAt,
        updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project")
        return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "describe_subnet")
        return Promise.resolve({ network: "192.168.77.0", broadcast: "192.168.77.255", prefix: 24, hosts: 254 });
      if (cmd === "start_sweep") return Promise.resolve(254);
      if (cmd === "get_settings") return Promise.resolve({});
      return Promise.resolve([]);
    },
  };
}, { p: project });

page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(700);

const nodes = () =>
  page.evaluate(() => {
    const d = window.__cvStore.getState().doc;
    const pages = d.pages ? Object.values(d.pages) : [{ nodes: d.nodes, edges: d.edges }];
    return pages.flatMap((pg) => pg.nodes ?? []).map((n) => ({
      id: n.id,
      label: n.data?.label,
      mac: n.data?.mac,
      vlan: n.data?.vlan,
      notes: n.data?.notes,
    }));
  });
const edges = () =>
  page.evaluate(() => {
    const d = window.__cvStore.getState().doc;
    const pages = d.pages ? Object.values(d.pages) : [{ nodes: d.nodes, edges: d.edges }];
    return pages.flatMap((pg) => pg.edges ?? []).map((e) => ({
      source: e.source,
      target: e.target,
      sourcePort: e.data?.sourcePortLabel,
      pathType: e.data?.pathType,
    }));
  });

// ---------------------------------------------------------------- the sweep

await page.locator("button", { hasText: "Ping sweep" }).first().click();
await page.waitForTimeout(400);
await page.evaluate((hits) => {
  window.__cvEmit("coreview://sweep", { kind: "started", total: 254 });
  for (const h of hits) window.__cvEmit("coreview://sweep", { kind: "alive", ...h });
  window.__cvEmit("coreview://sweep", { kind: "finished", alive: hits.length, scanned: 254, cancelled: false });
}, [SWEPT, SWEPT_SWITCH]);
await page.waitForTimeout(400);

await page.locator("button", { hasText: /Add 2 to diagram/ }).first().click();
await page.waitForTimeout(500);

const afterSweep = await nodes();
check("the sweep puts both hosts on the diagram", afterSweep.length === 2, JSON.stringify(afterSweep));
const sweptHost = afterSweep.find((n) => n.label === "LabDesktop01");
const sweptSwitch = afterSweep.find((n) => n.label === "192.168.77.7");
check("and records the MAC it read from the ARP table",
  sweptHost?.mac === "74:56:3c:00:00:01", JSON.stringify(sweptHost));
check("a host with no name is labelled with its address",
  !!sweptSwitch, JSON.stringify(afterSweep.map((n) => n.label)));

// ---------------------------------------------------------------- the crawl

await page.locator("button", { hasText: "Discover devices" }).first().click();
await page.waitForTimeout(400);
await page.evaluate((r) => window.__cvEmit("coreview://crawl-result", r), crawlResult);
await page.waitForTimeout(800);

// The attached devices are behind a disclosure that has to be opened, the
// same way an operator would.
const attachedToggle = page.locator(".cv-attached summary").first();
if (await attachedToggle.count()) {
  await attachedToggle.click();
  await page.waitForTimeout(400);
}

const addToDiagram = page.locator("button").filter({ hasText: /^Add .* to diagram$/ }).last();
await addToDiagram.click();
await page.waitForTimeout(900);
// LT-216: the crawl's changes are reviewed, then applied.
await page.locator(".cv-reconcile button", { hasText: /^Apply \d+ changes?$/ }).click();
await page.waitForTimeout(600);

const afterCrawl = await nodes();
const links = await edges();

// The heart of it: two devices, not three. A third means the crawl drew the
// host a second time and the swept copy is still floating.
// Two devices, not three or four. The crawl names the switch it met at
// 192.168.77.7 `ACC-SW1`; the sweep had drawn that address as its own label.
// Before LT-132/LT-133 those were two nodes -- and worse, every address-
// labelled host shared the identity `n:192`.
check("the crawl adds nothing new and duplicates nothing",
  afterCrawl.length === 2,
  JSON.stringify(afterCrawl.map((n) => n.label)));
check("the switch the sweep drew by address is the switch the crawl named",
  afterCrawl.some((n) => n.id === sweptSwitch?.id && n.label === "192.168.77.7") ||
    afterCrawl.some((n) => n.id === sweptSwitch?.id),
  JSON.stringify(afterCrawl));

const host = afterCrawl.find((n) => n.id === sweptHost?.id);
check("the swept host is still the same node", !!host, JSON.stringify(afterCrawl));
check("it kept the name the sweep gave it", host?.label === "LabDesktop01", host?.label);

const sw = afterCrawl.find((n) => n.id === sweptSwitch?.id);
check("the switch is on the diagram, as one node", !!sw,
  JSON.stringify(afterCrawl.map((n) => n.label)));

const cable = links.find(
  (e) => (e.source === sw?.id && e.target === host?.id) || (e.source === host?.id && e.target === sw?.id),
);
check("the host is cabled to the switch", !!cable, JSON.stringify(links));
check("on the port the switch actually learned it on",
  cable?.sourcePort === "Gi1/0/11", JSON.stringify(cable));
check("and the VLAN the switch reported is on the host",
  host?.vlan === "10", JSON.stringify(host));

// LT-130: whatever draws a link, it arrives Bezier unless the operator has
// saved a different default. This one was drawn by a crawl.
check("a link a crawl drew defaults to Bezier",
  cable?.pathType === "bezier", JSON.stringify(cable));

// ------------------------------------------------- LT-141: sweep again

// The reported fault: a second sweep laid a fresh block of boxes over the
// network already drawn. Same hosts, same addresses, drawn twice.
await page.locator("button", { hasText: "Ping sweep" }).first().click();
await page.waitForTimeout(400);
await page.evaluate((hits) => {
  window.__cvEmit("coreview://sweep", { kind: "started", total: 254 });
  for (const h of hits) window.__cvEmit("coreview://sweep", { kind: "alive", ...h });
  window.__cvEmit("coreview://sweep", { kind: "finished", alive: hits.length, scanned: 254, cancelled: false });
}, [SWEPT, SWEPT_SWITCH]);
await page.waitForTimeout(500);

const addAgain = page.locator("button").filter({ hasText: /^Add 2 to diagram$/ }).first();
await addAgain.click();
await page.waitForTimeout(700);

const afterSecondSweep = await nodes();
check("sweeping again does not draw the same hosts a second time",
  afterSecondSweep.length === afterCrawl.length,
  `${afterCrawl.length} -> ${afterSecondSweep.length}: ${JSON.stringify(afterSecondSweep.map((n) => n.label))}`);
check("and the host keeps the identity it already had",
  afterSecondSweep.some((n) => n.id === sweptHost?.id),
  JSON.stringify(afterSecondSweep.map((n) => n.id)));

// ------------------------------------- LT-146: the device carries the facts

// "whatever we disover and add to the diagram must auto fill the devices
// option such as mac, vendor, serial number". The panel is one thing; the
// device record is what an operator opens and what the export reads.
const hostData = await page.evaluate((id) => {
  const d = window.__cvStore.getState().doc;
  const pages = d.pages ? Object.values(d.pages) : [{ nodes: d.nodes }];
  const n = pages.flatMap((pg) => pg.nodes ?? []).find((x) => x.id === id);
  return n?.data ?? null;
}, sweptHost?.id);

check("the swept host carries the MAC discovery read",
  hostData?.mac === "74:56:3c:00:00:01", JSON.stringify(hostData?.mac));
check("and its manufacturer", hostData?.vendor?.includes("GIGA-BYTE"), hostData?.vendor);
check("and the ports it answered on",
  (hostData?.openPorts ?? "").includes("445"), hostData?.openPorts);
check("and says a sweep found it", !!hostData?.discoveredVia, hostData?.discoveredVia);
check("and the switch port the crawl learned it on",
  (hostData?.switchPort ?? "").includes("Gi1/0/11"), hostData?.switchPort);
check("and the VLAN", hostData?.vlan === "10", hostData?.vlan);

// Every one of those must be editable, not a read-only badge: a value a
// person corrects is theirs.
await page.locator(".react-flow__node").first().click();
await page.waitForTimeout(400);
const inspectorFields = await page.locator(".cv-inspector label span, .cv-field span").allTextContents();
for (const label of ["MAC address", "VLAN", "Software", "Connects to", "Open ports", "Found by"]) {
  check(`the inspector shows ${label}`, inspectorFields.includes(label),
    inspectorFields.slice(0, 30).join(" | "));
}

// ----------------------------------------- LT-145: arranged by what it is

// "Arrange top to bottom" must put the way out at the top. The switch here
// forwards to 192.168.77.1; the host hangs off the switch. So the order down
// the page is switch, then host — whatever glyph either of them happens to
// have, which for a swept host is a plain one.
const before = await page.evaluate(() => {
  const d = window.__cvStore.getState().doc;
  const pages = d.pages ? Object.values(d.pages) : [{ nodes: d.nodes }];
  return Object.fromEntries(
    pages.flatMap((pg) => pg.nodes ?? []).map((n) => [n.id, n.position.y]),
  );
});

const arranged = await page.evaluate(() => window.__cvStore.getState().flowLayout());
check("the arrange action moves devices", (arranged?.moved ?? 0) > 0, JSON.stringify(arranged));

const after = await page.evaluate(() => {
  const d = window.__cvStore.getState().doc;
  const pages = d.pages ? Object.values(d.pages) : [{ nodes: d.nodes }];
  return Object.fromEntries(
    pages.flatMap((pg) => pg.nodes ?? []).map((n) => [n.id, { y: n.position.y, label: n.data?.label }]),
  );
});
const switchRow = Object.values(after).find(
  (n) => n.label === "ACC-SW1" || n.label === "192.168.77.7",
);
const hostRow = Object.values(after).find((n) => n.label === "LabDesktop01");
check("the switch sits above the host it feeds",
  switchRow !== undefined && hostRow !== undefined && switchRow.y < hostRow.y,
  JSON.stringify({ switchRow, hostRow }));

// Undo has to put the arrangement back, because this rearranges rather than
// tidies and that is a big change to a diagram someone may have arranged.
await page.evaluate(() => window.__cvStore.getState().undo());
await page.waitForTimeout(300);
const restored = await page.evaluate(() => {
  const d = window.__cvStore.getState().doc;
  const pages = d.pages ? Object.values(d.pages) : [{ nodes: d.nodes }];
  return Object.fromEntries(
    pages.flatMap((pg) => pg.nodes ?? []).map((n) => [n.id, n.position.y]),
  );
});
check("undo puts every device back where it was",
  JSON.stringify(restored) === JSON.stringify(before),
  `${JSON.stringify(before)} -> ${JSON.stringify(restored)}`);

if (process.env.CV_SHOT) {
  await page.locator(".react-flow").first().screenshot({ path: process.env.CV_SHOT });
}

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
