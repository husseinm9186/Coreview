// Drives the ping sweep panel through the real path (LT-121).
//
// A sweep needs ICMP, which a browser cannot send, so the Tauri bridge is
// stubbed and the sweep events are fed in exactly as the backend emits them.
// Everything above the stub is the real application.
//
// The rows are not invented. They are what
// `cargo run -p coreview-probe --example sweep_subnet -- 192.168.77.0/24`
// actually printed against the operator's own network on 2026-09-12, which is
// the whole point: the panel is checked against the data it will really get,
// including the awkward cases — a host with no name, a host with no MAC
// because it is this machine, and a host with five open ports.
//
//     npm run dev            # in another terminal
//     node e2e/discover.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

const port = (p, service) => ({ port: p, service });

// Straight off the live run.
const hits = [
  {
    ip: "192.168.77.1", rttMs: 0.5, hostname: "_gateway", nameSource: "dns",
    mac: "ac:71:2e:00:00:04", vendor: "Fortinet",
    ports: [port(22, "SSH"), port(53, "DNS")],
  },
  {
    ip: "192.168.77.7", rttMs: 3.0, hostname: null, nameSource: null,
    mac: "cc:7f:75:00:00:03", vendor: "Cisco Systems",
    ports: [port(22, "SSH"), port(23, "Telnet"), port(80, "HTTP"), port(443, "HTTPS")],
    // LT-124: what this switch's plain-HTTP page really sends.
    webServer: "cisco-IOS", webTitle: null,
  },
  {
    ip: "192.168.77.23", rttMs: 3.0, hostname: "LAB-OFFICE-AP-0001.local", nameSource: "mdns",
    mac: "00:0c:e6:00:00:a0", vendor: "Fortinet", ports: [],
  },
  {
    ip: "192.168.77.129", rttMs: 0.5, hostname: "LabDesktop01", nameSource: "llmnr",
    mac: "74:56:3c:00:00:01", vendor: "GIGA-BYTE TECHNOLOGY CO.,LTD.",
    ports: [port(22, "SSH"), port(80, "HTTP"), port(135, "MSRPC"), port(139, "NetBIOS"), port(445, "SMB")],
  },
  // This machine: it answers, but a host has no ARP entry for itself.
  {
    ip: "192.168.77.213", rttMs: 0.5, hostname: "fabricforge", nameSource: "dns",
    mac: null, vendor: null,
    ports: [port(22, "SSH"), port(80, "HTTP"), port(443, "HTTPS")],
  },
  {
    ip: "192.168.77.221", rttMs: 0.5, hostname: "NAS000001", nameSource: "netBios",
    mac: "24:5e:be:00:00:9e", vendor: "QNAP Systems",
    ports: [port(22, "SSH"), port(443, "HTTPS"), port(445, "SMB")],
  },
  // LT-124: two hosts nothing but their certificates could identify, in the
  // shapes the lab's Cisco and Fortinet switches present — with invented
  // names and serials (D-027), not the lab's real ones.
  {
    ip: "192.168.77.250", rttMs: 1.0, hostname: "LAB-EDGE-SW.example.test", nameSource: "certificate",
    mac: null, vendor: null, ports: [port(443, "HTTPS")],
    serial: "FOC0000TEST", product: null,
  },
  {
    ip: "192.168.77.251", rttMs: 1.0, hostname: null, nameSource: null,
    mac: null, vendor: null, ports: [port(443, "HTTPS")],
    serial: "S000TESTSERIAL00", product: "Fortinet FortiSwitch",
  },
];

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const project = {
  meta: { id: "sweep", name: "Sweep", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    // LT-125: what an earlier crawl drew. The switch at .7 is one the sweep
    // cannot name at all; the desktop is matched to LabDesktop01 by its MAC,
    // under a different label, which is the case address alone would miss.
    // Names and serial are invented for the test (D-027).
    nodes: [
      {
        id: "crawled-switch", type: "device", position: { x: 100, y: 100 },
        data: {
          label: "LAB-CORE-SW", hostname: "LAB-CORE-SW", deviceType: "switch", tags: [],
          model: "WS-C2960CX-8PC-L", serial: "FOC0000TEST", osVersion: "15.2(7)E",
          discoveredVia: "SSH login",
          addresses: [{ id: "a1", label: "Mgmt", address: "192.168.77.7", isPrimary: true }],
          locked: false, maintenance: false, showDetails: true,
        },
      },
      {
        id: "crawled-desk", type: "device", position: { x: 400, y: 100 },
        data: {
          label: "DESK-PC-1", deviceType: "generic", tags: [],
          mac: "74:56:3c:00:00:01", switchPort: "LAB-CORE-SW Gi1/0/11",
          discoveredVia: "Seen on a switch port",
          addresses: [], locked: false, maintenance: false, showDetails: true,
        },
      },
    ],
    edges: [], probes: [], canvas: {},
  },
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
  // What the panel asked the backend to do, so the options it sends can be
  // checked rather than assumed.
  window.__cvSweepCalls = [];
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
      // The panel shows the size of each subnet as it is typed, and a row
      // whose info is the wrong shape takes the whole panel down — so this
      // answers with the shape the backend really sends.
      if (cmd === "describe_subnet") {
        return Promise.resolve({ network: "192.168.77.0", broadcast: "192.168.77.255", prefix: 24, hosts: 254 });
      }
      if (cmd === "start_sweep") { window.__cvSweepCalls.push(args); return Promise.resolve(254); }
      if (cmd === "get_settings") return Promise.resolve({});
      // LT-124: an unlocked vault with one saved SNMP credential, and a
      // gateway whose ARP table holds a routed host the sweep had no MAC
      // for, plus one it already had. Invented MACs.
      if (cmd === "vault_status") return Promise.resolve({ exists: true, unlocked: true, credentials: 1, minimumPassphrase: 12 });
      if (cmd === "list_credentials") return Promise.resolve([
        { id: "snmp-lab", label: "Lab SNMP", kind: "snmp", username: "", detail: "", hasSecondSecret: false },
        { id: "ssh-lab", label: "Lab SSH", kind: "ssh", username: "e2e", detail: "", hasSecondSecret: false },
      ]);
      if (cmd === "read_gateway_arp") {
        window.__cvGatewayCalls = [...(window.__cvGatewayCalls ?? []), args];
        return Promise.resolve([
          { ip: "192.168.77.250", mac: "00:0c:29:aa:bb:cc", vendor: "VMware, Inc." },
          { ip: "192.168.77.129", mac: "02:00:5e:00:00:99", vendor: null },
        ]);
      }
      return Promise.resolve([]);
    },
  };
}, { p: project });

await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(700);

// Open the sweep panel.
await page.locator("button", { hasText: "Ping sweep" }).first().click();
await page.waitForTimeout(400);
await page.locator(".cv-subnet-row input").first().fill("192.168.77.0/24");
await page.waitForTimeout(300);

check("the sweep panel opens on the desktop path",
  (await page.locator("button", { hasText: /^Sweep$/ }).count()) >= 1);

// Both switches are on before anything is touched: a sweep that says only
// "it answered" is what LT-121 was raised about.
const identifyOn = await page.locator(".cv-check", { hasText: "Identify" }).locator("input").isChecked();
const portsOn = await page.locator(".cv-check", { hasText: "Ports" }).locator("input").isChecked();
check("identification is on by default", identifyOn);
check("the port scan is on by default", portsOn);

await page.locator("button", { hasText: /^Sweep$/ }).first().click();
await page.waitForTimeout(300);

const sent = await page.evaluate(() => window.__cvSweepCalls[0]);
check("the panel asks the backend to identify and to scan ports",
  sent?.options?.identify === true && sent?.options?.scanPorts === true,
  JSON.stringify(sent?.options));

await page.evaluate((rows) => {
  window.__cvEmit("coreview://sweep", { kind: "started", total: 254 });
  for (const r of rows) window.__cvEmit("coreview://sweep", { kind: "alive", ...r });
  window.__cvEmit("coreview://sweep", { kind: "finished", alive: rows.length, scanned: 254, cancelled: false });
}, hits);
await page.waitForTimeout(500);

const headers = await page.locator(".cv-discover-table thead th").allTextContents();
check("the table has a column for every thing the sweep learns",
  ["Address", "Name", "MAC address", "Manufacturer", "Open ports", "Round trip"]
    .every((h) => headers.includes(h)),
  headers.join(" | "));

const rowFor = (ip) => page.locator(".cv-discover-table tbody tr", { hasText: ip }).first();

// The case the operator reported: a host with no PTR record. It had a dash in
// the NAME column and now carries the name the host answered with itself.
const ap = await rowFor("192.168.77.23").locator("td").allTextContents();
check("a host with no PTR record is named from mDNS",
  ap[2] === "LAB-OFFICE-AP-0001.local", ap.join(" | "));
check("and its manufacturer is named from the MAC",
  ap[3] === "00:0c:e6:00:00:a0" && ap[4] === "Fortinet", ap.join(" | "));

const nas = await rowFor("192.168.77.221").locator("td").allTextContents();
check("a Samba host is named from NetBIOS", nas[2] === "NAS000001", nas.join(" | "));

// LLMNR over the multicast group is the only thing that gets a Windows host's
// real name; NetBIOS would say LABDESKTOP01, which is not what it is called.
const win = await rowFor("192.168.77.129").locator("td").allTextContents();
// The name itself, exactly. Since LT-125 a host that is also drawn under
// another label carries " · on diagram as …" after it, which is checked on
// its own further down.
check("a Windows host is named from LLMNR, capitals intact",
  win[2].split(" · on diagram as ")[0] === "LabDesktop01", win.join(" | "));
const winTitle = await rowFor("192.168.77.129").locator("td").nth(2).getAttribute("title");
check("and says LLMNR gave it", /LLMNR/.test(winTitle ?? ""), winTitle ?? "");

// Where the name came from is in the title, because a `.local` from mDNS and
// a PTR record from the network's own DNS are not the same claim.
const apTitle = await rowFor("192.168.77.23").locator("td").nth(2).getAttribute("title");
const nasTitle = await rowFor("192.168.77.221").locator("td").nth(2).getAttribute("title");
const gwTitle = await rowFor("192.168.77.1").locator("td").nth(2).getAttribute("title");
check("the name column says where the name came from",
  /mDNS/.test(apTitle ?? "") && /NetBIOS/.test(nasTitle ?? "") && /DNS \(PTR\)/.test(gwTitle ?? ""),
  [apTitle, nasTitle, gwTitle].join(" | "));

// Ports are chips, one per open port, so a host with five does not push the
// round trip off the edge of the panel.
const chips = await rowFor("192.168.77.129").locator(".cv-port-chip").allTextContents();
check("open ports are listed per host",
  chips.join(",") === "22,80,135,139,445", chips.join(","));

// A switch is recognisable from its ports alone, which is the point.
const cisco = await rowFor("192.168.77.7").locator(".cv-port-chip").allTextContents();
check("a managed switch shows its management ports",
  cisco.join(",") === "22,23,80,443", cisco.join(","));

// This machine answers its own sweep and has no ARP entry for itself. A dash
// is correct; the address repeated back, or a wrong MAC, is not.
const self = await rowFor("192.168.77.213").locator("td").allTextContents();
check("a host with no ARP entry shows a dash rather than a guess",
  self[3] === "—" && self[4] === "—", self.join(" | "));
const selfTitle = await rowFor("192.168.77.213").locator("td").nth(3).getAttribute("title");
check("and says why", /segment/.test(selfTitle ?? ""), selfTitle ?? "");

// A host with nothing listening shows a dash, not an empty cell.
const apPorts = await rowFor("192.168.77.23").locator("td").nth(5).innerText();
check("a host with no open ports shows a dash", apPorts.trim() === "—", apPorts);

// Turning identification off has to reach the backend, for the network where
// a port scan would be noticed.
await page.locator(".cv-check", { hasText: "Identify" }).locator("input").uncheck();
await page.waitForTimeout(150);
const portsDisabled = await page.locator(".cv-check", { hasText: "Ports" }).locator("input").isDisabled();
check("turning identification off disables the port scan with it", portsDisabled);

// What lands on the canvas carries the manufacturer, so a discovered device
// does not have to be told who made it.
await page.locator("button", { hasText: "Select none" }).first().click();
await rowFor("192.168.77.221").locator("input[type=checkbox]").check();
await page.locator("button", { hasText: /Add 1 to diagram/ }).first().click();
await page.waitForTimeout(400);
const added = await page.evaluate(() => {
  const d = window.__cvStore.getState().doc;
  // Every page, because which one is active is not what is being tested here.
  const nodes = d.pages ? Object.values(d.pages).flatMap((pg) => pg.nodes ?? []) : d.nodes ?? [];
  const n = nodes.find((x) => x.data?.label === "NAS000001");
  return n ? { label: n.data.label, vendor: n.data.vendor, hostname: n.data.hostname } : null;
});
check("a discovered device arrives named, with its manufacturer",
  added?.label === "NAS000001" && added?.vendor === "QNAP Systems",
  JSON.stringify(added));

// ------------------------------------ LT-125: what the crawl already knows

// Raw text, not rendered: the header row is uppercased by CSS.
const crawlHeaders = await page.locator(".cv-discover-table thead th").allTextContents();
const col = (name) => crawlHeaders.findIndex((h) => h.trim() === name);
const cell = async (ip, name) =>
  (await rowFor(ip).locator("td").nth(col(name)).innerText()).trim();
check("the table has columns for what the crawl learned", col("Model") > 0 && col("Switch port") > 0,
  JSON.stringify(crawlHeaders));
check("a host the sweep cannot name shows the crawl's name for it",
  (await cell("192.168.77.7", "Name")).includes("LAB-CORE-SW"), await cell("192.168.77.7", "Name").catch(() => ""));
const knownTitle = await rowFor("192.168.77.7").locator("td").nth(col("Name")).getAttribute("title");
check("and says the name came from the diagram, and how the crawl found it",
  /diagram/i.test(knownTitle ?? "") && /SSH login/.test(knownTitle ?? ""), knownTitle ?? "");
check("the crawl's model is shown", (await cell("192.168.77.7", "Model").catch(() => "")) === "WS-C2960CX-8PC-L");
check("a host matched by MAC under another label shows where it is plugged in",
  (await cell("192.168.77.129", "Switch port").catch(() => "")) === "LAB-CORE-SW Gi1/0/11");
check("and its own sweep name is kept, with the diagram's label beside it",
  (await cell("192.168.77.129", "Name").catch(() => "")).includes("LabDesktop01") &&
    (await cell("192.168.77.129", "Name").catch(() => "")).includes("DESK-PC-1"),
  await cell("192.168.77.129", "Name").catch(() => ""));
check("a host the crawl never saw shows dashes, not guesses",
  (await cell("192.168.77.221", "Model").catch(() => "")) === "—" &&
    (await cell("192.168.77.221", "Switch port").catch(() => "")) === "—");

// LT-155: adding a host the crawl drew must not erase what the crawl recorded.
const countNodes = () => page.evaluate(() => {
  const d = window.__cvStore.getState().doc;
  return (d.pages ? Object.values(d.pages).flatMap((pg) => pg.nodes ?? []) : d.nodes ?? []).length;
});
const beforeAdd = await countNodes();
await page.locator("button", { hasText: "Select none" }).first().click();
await rowFor("192.168.77.7").locator("input[type=checkbox]").check();
await rowFor("192.168.77.129").locator("input[type=checkbox]").check();
await page.locator("button", { hasText: /Add 2 to diagram/ }).first().click();
await page.waitForTimeout(400);
const afterAdd = await page.evaluate(() => {
  const d = window.__cvStore.getState().doc;
  const nodes = d.pages ? Object.values(d.pages).flatMap((pg) => pg.nodes ?? []) : d.nodes ?? [];
  const pick = (id) => {
    const n = nodes.find((x) => x.id === id);
    return n && { label: n.data.label, hostname: n.data.hostname, via: n.data.discoveredVia,
      model: n.data.model, ports: n.data.openPorts, switchPort: n.data.switchPort, vendor: n.data.vendor };
  };
  return { sw: pick("crawled-switch"), desk: pick("crawled-desk") };
});
check("adding hosts the crawl drew draws nothing new", (await countNodes()) === beforeAdd, `${beforeAdd} -> ${await countNodes()}`);
check("the crawl's record of how a switch was found survives the sweep",
  afterAdd.sw?.via === "SSH login", JSON.stringify(afterAdd.sw));
check("and so do its label, model and hostname",
  afterAdd.sw?.label === "LAB-CORE-SW" && afterAdd.sw?.model === "WS-C2960CX-8PC-L" && afterAdd.sw?.hostname === "LAB-CORE-SW",
  JSON.stringify(afterAdd.sw));
check("while what the sweep newly proved is still added",
  /22\/SSH/.test(afterAdd.sw?.ports ?? "") && afterAdd.desk?.vendor === "GIGA-BYTE TECHNOLOGY CO.,LTD." &&
    afterAdd.desk?.via === "Seen on a switch port" && afterAdd.desk?.switchPort === "LAB-CORE-SW Gi1/0/11",
  JSON.stringify(afterAdd));

// ------------------------------------------ LT-124: what a certificate said

const certTitle = await rowFor("192.168.77.250").locator("td").nth(col("Name")).getAttribute("title");
check("a host named by its certificate says so",
  (await cell("192.168.77.250", "Name").catch(() => "")) === "LAB-EDGE-SW.example.test" && /certificate/i.test(certTitle ?? ""),
  certTitle ?? "");
check("a certificate that names a product fills the Model column",
  (await cell("192.168.77.251", "Model").catch(() => "")) === "Fortinet FortiSwitch");
const productTitle = await rowFor("192.168.77.251").locator("td").nth(col("Model")).getAttribute("title");
check("and its tooltip gives the serial, from the certificate",
  /certificate/i.test(productTitle ?? "") && /S000TESTSERIAL00/.test(productTitle ?? ""), productTitle ?? "");

await page.locator("button", { hasText: "Select none" }).first().click();
await rowFor("192.168.77.250").locator("input[type=checkbox]").check();
await rowFor("192.168.77.251").locator("input[type=checkbox]").check();
await page.locator("button", { hasText: /Add 2 to diagram/ }).first().click();
await page.waitForTimeout(400);
const certNodes = await page.evaluate(() => {
  const d = window.__cvStore.getState().doc;
  const nodes = d.pages ? Object.values(d.pages).flatMap((pg) => pg.nodes ?? []) : d.nodes ?? [];
  const at = (ip) => nodes.find((n) => (n.data?.addresses ?? []).some((a) => a.address === ip));
  const pick = (n) => n && { label: n.data.label, serial: n.data.serial };
  return { cisco: pick(at("192.168.77.250")), forti: pick(at("192.168.77.251")) };
});
check("a device added from the sweep carries the serial its certificate gave",
  certNodes.cisco?.serial === "FOC0000TEST" && certNodes.forti?.serial === "S000TESTSERIAL00" &&
    certNodes.cisco?.label === "LAB-EDGE-SW.example.test",
  JSON.stringify(certNodes));

// LT-124: a web banner is shown on the web port's chip, and nowhere it could
// pass for a name.
const chipTitle = async (ip, n) =>
  (await rowFor(ip).locator(".cv-port-chip", { hasText: new RegExp(`^${n}$`) }).first().getAttribute("title")) ?? "";
check("a web port's chip says which software answered",
  /Server: cisco-IOS/.test(await chipTitle("192.168.77.7", 80)), await chipTitle("192.168.77.7", 80));
check("and other ports' chips do not",
  !/Server:/.test(await chipTitle("192.168.77.7", 22)), await chipTitle("192.168.77.7", 22));
check("and the banner is not passed off as the host's name",
  !(await cell("192.168.77.7", "Name").catch(() => "")).includes("cisco-IOS"));

// --------------------------- LT-124: MACs from the gateway's ARP table

const arp = page.locator(".cv-gateway-arp");
const arpCred = arp.locator(".cv-field", { has: page.locator('span:text-is("SNMP credential")') }).locator("select");
const arpGateway = arp.locator(".cv-field", { has: page.locator('span:text-is("Gateway")') }).locator("input");
const arpButton = arp.locator("button", { hasText: /ARP table|Reading/ });
check("the optional gateway read is offered with only SNMP credentials",
  (await arpCred.locator("option").allTextContents()).join("|") === "Choose one|Lab SNMP",
  (await arpCred.locator("option").allTextContents()).join("|"));
check("the gateway starts as the subnet's first address", (await arpGateway.inputValue()) === "192.168.77.1",
  await arpGateway.inputValue());
check("nothing is read until a credential is chosen", await arpButton.isDisabled());
const macBefore129 = await cell("192.168.77.129", "MAC address");
await arpCred.selectOption("snmp-lab");
await arpButton.click();
await page.waitForTimeout(400);
const gwCalls = await page.evaluate(() => window.__cvGatewayCalls ?? []);
check("the gateway and the chosen credential are what is sent",
  gwCalls.length === 1 && gwCalls[0].gateway === "192.168.77.1" && gwCalls[0].credentialId === "snmp-lab",
  JSON.stringify(gwCalls));
check("a routed host the sweep had no MAC for gains one, with its manufacturer",
  (await cell("192.168.77.250", "MAC address")) === "00:0c:29:aa:bb:cc" &&
    (await cell("192.168.77.250", "Manufacturer")) === "VMware, Inc.",
  `${await cell("192.168.77.250", "MAC address")} / ${await cell("192.168.77.250", "Manufacturer")}`);
const arpMacTitle = await rowFor("192.168.77.250").locator("td").nth(col("MAC address")).getAttribute("title");
check("and says it came from the gateway", /192\.168\.77\.1.s ARP table/.test(arpMacTitle ?? ""), arpMacTitle ?? "");
check("a MAC the sweep already had is never replaced",
  (await cell("192.168.77.129", "MAC address")) === macBefore129, await cell("192.168.77.129", "MAC address"));
check("the result is summarised",
  (await arp.innerText()).includes("filled 1 MAC address"), await arp.innerText());

if (process.env.CV_SHOT) {
  await page.locator(".cv-discover-table").first().screenshot({ path: process.env.CV_SHOT });
}

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
