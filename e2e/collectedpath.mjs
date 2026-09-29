// P3 in the window (LT-531–LT-536): Path-Trace over a run built from a
// collection, calculated by the Rust path builder.
//
// The stubbed backend answers `collection_path` with the very JSON the builder
// wrote in its own tests (crates/coreview-path/fixtures), so what is driven here
// is the page reading the builder's real output: the request it sends, the hop
// table and highlight it already had, and what P3 adds — decisions, switches,
// firewall verdicts and NAT, the way back, the traceroute comparison, the live
// check, and the three exports.
//
//     npm run dev            # in another terminal
//     node e2e/collectedpath.mjs
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;
const fixture = (name) => JSON.parse(readFileSync(new globalThis.URL(`../crates/coreview-path/fixtures/${name}.json`, import.meta.url), "utf8"));
const core = fixture("path-outcome");
const firewall = fixture("path-outcome-firewall");

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const node = (id, label, x) => ({
  id, type: "device", position: { x, y: 0 }, width: 76, height: 76,
  data: { label, hostname: label, deviceType: "router", tags: [] },
});

const project = {
  meta: { id: "cpath", name: "Collected path", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    activePageId: "p1", probes: [],
    pages: [{ id: "p1", name: "Core",
      canvas: { gridEnabled: true, snapEnabled: true, minimap: false, nodeStyle: "glyph" }, edges: [],
      nodes: [node("a", "ACC1", 0), node("b", "CORE1", 240), node("c", "CORE2", 480), node("d", "DC1", 720), node("e", "FGT1", 960)] }],
  },
};

// The stored crawl run LT-527 writes for a collection: its seed names the collection.
const crawl = {
  devices: ["ACC1", "CORE1", "CORE2", "DC1", "FGT1"].map((h, i) => ({
    hostname: h, address: `198.51.100.${i + 1}`, addresses: [], class: "router", hops: 0, reachedBy: "ssh", neighbors: [], attached: [], routes: [],
  })),
  notVisited: [],
};

// LT-535: what the devices on the path said, as `collection_live` returns it.
const live = {
  path: 0,
  hops: [
    { device: "ACC1", host: "192.0.2.1", os: "cisco_ios",
      run: { host: "192.0.2.1", hostKey: "SHA256:fake", hostKeyFirstSeen: false, failure: null, log: [], answers: [
        { id: "show_ip_route_dst", command: "show ip route 203.0.113.50", status: "ok", rows: [], raw: "Routing entry for 203.0.113.0/24\n  * 198.51.100.2, from 192.0.2.254, via GigabitEthernet1/0/49", reason: null, verified: "lab" },
        { id: "show_mac_address_table_address_mac", command: "show mac address-table address {mac}", status: "skipped", rows: [], raw: "", reason: "needs {mac}, which the trace does not give", verified: "unverified" },
      ] },
      check: { agrees: true, detail: "show ip route 203.0.113.50 names 198.51.100.2, the modeled next hop." } },
    { device: "CORE1", host: "198.51.100.2", os: "cisco_ios", run: null, check: { agrees: null, detail: "Not asked: the session failed (auth)." } },
  ],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });

await page.addInitScript(({ p, c, core, firewall, live }) => {
  let next = 1; const cbs = {};
  window.__calls = [];
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const id = next++; cbs[id] = cb; return id; },
    invoke(cmd, args) {
      window.__calls.push({ cmd, args });
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "",
        engineer: "", description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "get_settings") return Promise.resolve({});
      if (cmd === "list_crawl_runs") return Promise.resolve([{ id: "topo-col-1-1", takenAt: 1756000000000, seed: "collection col-1", devices: 5 }]);
      if (cmd === "crawl_run_result") return Promise.resolve(c);
      if (cmd === "collection_path") return Promise.resolve(args.request.to === "203.0.113.10" ? firewall : core);
      if (cmd === "collection_live") return Promise.resolve(live);
      if (cmd === "vault_status") return Promise.resolve({ exists: true, unlocked: true, credentials: 1, minimumPassphrase: 12, keptInKeychain: false });
      if (cmd === "list_credentials") return Promise.resolve([{ id: "cred-ssh", label: "reader", kind: "ssh", username: "reader", detail: "", hasSecondSecret: false }]);
      if (cmd === "traceroute_from_device") return Promise.resolve({ platform: "Cisco IOS / IOS-XE", command: "traceroute 203.0.113.50", hops: [
        { ttl: 1, address: "198.51.100.2", rttsMs: [1.2] },
        { ttl: 2, address: "198.51.100.10", rttsMs: [2.1] },
        { ttl: 3, address: "203.0.113.50", rttsMs: [3.0] },
      ] });
      if (cmd === "pick_export_target") return Promise.resolve({ token: `t-${next++}`, path: `/tmp/${args.filename}` });
      return Promise.resolve([]);
    },
  };
}, { p: project, c: crawl, core, firewall, live });

page.on("pageerror", (e) => { failures++; console.log("PAGE EXCEPTION:", String(e).slice(0, 300)); });
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(900);
await page.locator(".cv-panel .cv-tabs button", { hasText: "Path-Trace" }).click();
await page.waitForTimeout(700);

const panel = page.locator(".cv-pathtrace").first();
const field = (label) => panel.locator(".cv-field", { has: page.locator(`span:text-is("${label}")`) }).locator("input, select").first();
const go = panel.locator("button", { hasText: "Run Path-Trace" });
const text = async () => (await panel.textContent()) ?? "";
const lastCall = (cmd) => page.evaluate((c) => window.__calls.filter((x) => x.cmd === c).at(-1)?.args ?? null, cmd);

check("a run built from a collection says so, and that it is traced with every table",
  /Built from collection col-1/.test(await text()), (await text()).slice(0, 200));
check("and it takes an address as the source, not only a device", await field("Or from an address").isVisible());

// ------------------------------------------------ an endpoint to a server
await field("Or from an address").fill("192.0.2.50");
await field("Destination").fill("203.0.113.50");
await field("Protocol").selectOption("tcp");
await field("Port").fill("443");
await go.click();
await page.waitForTimeout(700);

const asked = await lastCall("collection_path");
check("the Rust builder is asked, for the collection, with the flow",
  asked?.runId === "col-1" && asked.request.from === "192.0.2.50" && asked.request.to === "203.0.113.50" && asked.request.protocol === "tcp" && asked.request.port === 443,
  JSON.stringify(asked));
check("with nothing the page may not set", asked && !("returnOf" in asked.request), JSON.stringify(asked?.request));
check("the hop table it already had shows both equal-cost legs", (await panel.locator('[data-region="trace-path"]').count()) === 2);
check("and the first hop is ACC1's OSPF route",
  /ACC1/.test(await panel.locator('[data-region="trace-path"] tbody tr').first().innerText()) && /ospf/.test(await panel.locator('[data-region="trace-path"] tbody tr').first().innerText()));
const lit = await page.evaluate(() => { const h = window.__cvStore.getState().canvasHighlight; return h ? [...h].sort() : null; });
check("every device on either leg is lit on the diagram", JSON.stringify(lit) === JSON.stringify(["a", "b", "c", "d"]), JSON.stringify(lit));
check("the source is placed where its MAC is learned", /The source is on ACC1 Gi1\/0\/5/.test(await panel.locator('[data-region="path-source"]').innerText()));
check("each hop says how it decided", /longest match/.test(await panel.locator('[data-region="collected-hops"]').first().innerText()));
check("and a path ends where the destination is attached, behind its switch port",
  /behind DC1 Eth1\/10/.test(await panel.locator('[data-region="collected-hops"]').first().innerText()));
check("the way back is traced and found the same", /The way back — the same routers both ways/.test(await panel.locator('[data-region="reverse"] summary').innerText()));
check("the caveat is the collection's, not the crawl's", /Calculated from the collection/.test(await text()) && !/Not evaluated: ACLs, firewall policy/.test(await text()));

// ------------------------------------------------ through a firewall
await field("Or from an address").fill("203.0.113.99");
await field("Destination").fill("203.0.113.10");
await go.click();
await page.waitForTimeout(700);
const fwRow = await panel.locator('[data-region="collected-hops"] tbody tr').first().innerText();
check("a firewall hop shows its verdict, the rule that decided and its zones", /allowed · web-in \(1\)/.test(fwRow) && /port1 → port2/.test(fwRow), fwRow);
check("and the VIP's translation", /203\.0\.113\.10 → 10\.1\.1\.10/.test(fwRow), fwRow);
check("the way back through it is the flow's own return, passed by the session",
  /session/.test((await panel.locator('[data-region="reverse-hops"] td[data-verdict="allow"] span').first().getAttribute("title")) ?? ""));

// ------------------------------------------------ verify: against a traceroute
await field("Or from an address").fill("");
await field("Source").selectOption({ label: "ACC1" });
await field("Destination").fill("203.0.113.50");
await go.click();
await page.waitForTimeout(600);
const measure = panel.locator('[data-region="measure"]');
await measure.locator("select").first().selectOption("cred-ssh");
await measure.locator("button", { hasText: "Measure from ACC1" }).click();
await page.waitForTimeout(800);
const verifyAsk = await lastCall("collection_path");
check("the traceroute's hops are sent back to the builder to compare",
  JSON.stringify(verifyAsk?.request?.traceroute) === JSON.stringify(["198.51.100.2", "198.51.100.10", "203.0.113.50"]), JSON.stringify(verifyAsk?.request));
check("and the match is shown hop by hop", /matches the modeled path at 100%/.test(await panel.locator('[data-region="verify"]').innerText()));

// ------------------------------------------------ live: the devices asked now
await panel.locator("button", { hasText: "Ask the devices on this path" }).click();
await page.waitForTimeout(600);
const liveAsk = await lastCall("collection_live");
check("the live check is asked for the path, with the chosen login and the port",
  liveAsk?.input?.runId === "col-1" && liveAsk.input.credentialId === "cred-ssh" && liveAsk.input.port === 22 && liveAsk.input.path === 0 && liveAsk.input.request.to === "203.0.113.50",
  JSON.stringify(liveAsk));
const liveText = await panel.locator('[data-region="live-answers"]').innerText();
check("each device's answer is held against the model", /agrees/.test(liveText) && /names 198\.51\.100\.2, the modeled next hop/.test(liveText), liveText);
check("a device not asked says why", /Not asked: the session failed \(auth\)/.test(liveText), liveText);
check("a skipped command says what it needed", (await panel.locator('[data-region="live-answers"]').textContent()).includes("needs {mac}"));

// ------------------------------------------------ exports
for (const [label, ext, needle] of [["Export JSON", "json", '"forward"'], ["Export CSV", "csv", "direction,path,hop,device"], ["Export markdown", "md", "# Path from"]]) {
  await panel.locator('[data-region="path-export"] button', { hasText: label }).click();
  await page.waitForTimeout(300);
  const saved = await page.evaluate(() => window.__calls.filter((x) => x.cmd === "save_export").at(-1)?.args ?? null);
  const body = saved ? Buffer.from(saved.contentsB64, "base64").toString("utf8") : "";
  const target = await lastCall("pick_export_target");
  check(`${label} writes the path as ${ext}`, target?.filename?.endsWith(`.${ext}`) && body.includes(needle), `${target?.filename} ${body.slice(0, 80)}`);
}

// ------------------------------------------------ what-if
const simulate = panel.locator('[data-region="simulate"]');
await simulate.locator("summary").click();
await simulate.locator("label", { hasText: "CORE1" }).locator("input").check();
await page.waitForTimeout(600);
check("marking a device down asks the builder again, with it down",
  JSON.stringify((await lastCall("collection_path"))?.request?.downDevices) === JSON.stringify(["CORE1"]), JSON.stringify(await lastCall("collection_path")));

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
