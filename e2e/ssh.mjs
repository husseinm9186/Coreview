// Open shells, one tab each, the way SecureCRT does it (LT-320) — and the
// controls that make one usable for a day's work (LT-321–325).
//
// Right-click a device, choose SSH to this device, and the session opens as a
// tab in the bottom panel beside every other shell. What is checked here is
// the whole path through the window: the menu entry, the two ways it refuses
// before anything is sent, the terminal that draws what the device says, the
// keystrokes that go back, the PTY resize, and closing.
//
// The backend is stubbed — a real device is not available in a test — but the
// stub is the real protocol: base64 in `ssh_send`, base64 out on
// `coreview://ssh`, and a session id the window has to keep straight when two
// are open at once.
//
//     npm run dev            # in another terminal
//     node e2e/ssh.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

let at = 0;
const node = (id, label, over = {}) => {
  const x = at;
  at += 220;
  return {
    id, type: "device", position: { x, y: 0 }, width: 76, height: 76,
    data: { label, deviceType: "core-switch", tags: [], ...over },
  };
};

const project = {
  meta: { id: "ssh", name: "SSH", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    activePageId: "p1", probes: [],
    pages: [{ id: "p1", name: "Core",
      canvas: { gridEnabled: true, snapEnabled: true, minimap: false, nodeStyle: "glyph" }, edges: [],
      nodes: [
        node("a", "CORE-SW1", { hostname: "CORE-SW1", sshCredentialId: "cred-1",
          addresses: [{ id: "x", label: "Mgmt", address: "192.0.2.10", isPrimary: true }] }),
        node("b", "ACCESS-SW7", { sshCredentialId: "cred-1",
          addresses: [{ id: "y", label: "Mgmt", address: "192.0.2.11", isPrimary: true }] }),
        node("c", "NO-LOGIN", { addresses: [{ id: "z", label: "Mgmt", address: "192.0.2.12", isPrimary: true }] }),
        node("d", "NO-ADDRESS", { sshCredentialId: "cred-1", addresses: [] }),
      ] }],
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });

await page.addInitScript(({ p }) => {
  const listeners = {}, callbacks = {};
  let next = 1;
  window.__opened = [];   // every ssh_open payload
  window.__sent = [];     // every ssh_send payload, decoded
  window.__resized = [];  // every ssh_resize payload
  window.__closed = [];   // every ssh_close id
  window.__closedAll = 0;
  window.__logStarts = [];  // every ssh_log_start payload
  window.__logStops = [];   // every ssh_log_stop id
  window.__keepalives = []; // every ssh_keepalive payload
  window.__external = [];   // every ssh_external payload
  // A configuration folder is already chosen, as it would be on a machine
  // that takes backups — that is where a session log goes (LT-324).
  window.__settings = { backupFolder: "/tmp/cv-configs" };
  let sessions = 0;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  // Pushes bytes to the window as the real session task does.
  window.__fromDevice = (id, text) => {
    const handler = listeners["coreview://ssh"];
    if (handler && callbacks[handler]) {
      callbacks[handler]({ event: "coreview://ssh", id: handler,
        payload: { kind: "data", id, bytes: btoa(text) } });
    }
  };
  // The ids below are `ssh-1`, `ssh-2` … in the order sessions are opened, and
  // the checks further down name them. A session opened and closed in the
  // middle would shift every one after it, so the counter can be put back.
  window.__resetSessions = () => { sessions = 0; window.__opened.length = 0; };
  window.__deviceIsAlive = (id, at) => {
    const handler = listeners["coreview://ssh"];
    if (handler && callbacks[handler]) {
      callbacks[handler]({ event: "coreview://ssh", id: handler, payload: { kind: "alive", id, at } });
    }
  };
  window.__deviceHungUp = (id, reason) => {
    const handler = listeners["coreview://ssh"];
    if (handler && callbacks[handler]) {
      callbacks[handler]({ event: "coreview://ssh", id: handler,
        payload: { kind: "closed", id, reason } });
    }
  };
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const id = next++; callbacks[id] = cb; return id; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") { listeners[args.event] = args.handler; return Promise.resolve(next++); }
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "",
        engineer: "", description: "", created_at: p.meta.createdAt, updated_at: p.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta]);
      if (cmd === "load_project") return Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "vault_status") return Promise.resolve({ exists: true, unlocked: true, credentials: 1, minimumPassphrase: 12, keptInKeychain: true });
      if (cmd === "list_credentials") return Promise.resolve([{ id: "cred-1", label: "Lab", kind: "ssh", username: "ops", detail: "", hasSecondSecret: false }]);
      if (cmd === "ssh_open") {
        window.__opened.push(args);
        if (args.address === "192.0.2.99") return Promise.reject("192.0.2.99 did not answer within 8s");
        sessions += 1;
        return Promise.resolve(`ssh-${sessions}`);
      }
      if (cmd === "ssh_send") { window.__sent.push({ id: args.id, text: atob(args.bytes) }); return Promise.resolve(); }
      if (cmd === "ssh_resize") { window.__resized.push(args); return Promise.resolve(); }
      if (cmd === "ssh_close") { window.__closed.push(args.id); return Promise.resolve(); }
      if (cmd === "ssh_close_all") { window.__closedAll += 1; return Promise.resolve(window.__closed.length); }
      if (cmd === "ssh_sessions") return Promise.resolve([]);
      if (cmd === "ssh_log_start") {
        window.__logStarts.push(args);
        if (!args.folder) return Promise.reject("No configuration folder has been chosen yet.");
        const path = `${args.folder}/${args.device}/20260919-000000-session.txt`;
        const handler = listeners["coreview://ssh"];
        if (handler && callbacks[handler]) {
          callbacks[handler]({ event: "coreview://ssh", id: handler,
            payload: { kind: "logging", id: args.id, path } });
        }
        return Promise.resolve(path);
      }
      if (cmd === "ssh_log_stop") {
        window.__logStops.push(args.id);
        const handler = listeners["coreview://ssh"];
        if (handler && callbacks[handler]) {
          callbacks[handler]({ event: "coreview://ssh", id: handler,
            payload: { kind: "logging", id: args.id, path: null } });
        }
        return Promise.resolve();
      }
      if (cmd === "ssh_keepalive") { window.__keepalives.push(args); return Promise.resolve(); }
      if (cmd === "ssh_external") {
        window.__external.push(args);
        return Promise.resolve(["putty", "-ssh", `${args.username}@${args.address}`, "-P", String(args.port ?? 22)]);
      }
      if (cmd === "get_settings") return Promise.resolve({ ...window.__settings });
      if (cmd === "set_setting") {
        if (args.value === null || args.value === undefined) delete window.__settings[args.key];
        else window.__settings[args.key] = args.value;
        return Promise.resolve();
      }
      if (cmd === "save_project") return Promise.resolve();
      return Promise.resolve([]);
    },
  };
}, { p: project });

page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(900);

const st = (fn, arg) => page.evaluate(fn, arg);
const rightClick = async (label) => {
  const n = page.locator(".react-flow__node", { hasText: label }).first();
  await n.click({ button: "right" });
  await page.waitForTimeout(300);
};
const menuItem = (text) => page.locator(".cv-context-menu button, .cv-menu button", { hasText: text }).first();
const message = () => page.locator(".cv-panel-message").textContent().catch(() => "");

// ------------------------------------------------- the two honest refusals

await rightClick("NO-ADDRESS");
check("a device offers SSH on the right-click menu", (await menuItem("SSH to this device").count()) === 1);
await menuItem("SSH to this device").click();
await page.waitForTimeout(500);
check("a device with no address says so instead of timing out",
  /no address/i.test(await message()), await message());
check("and nothing was sent", (await st(() => window.__opened)).length === 0);

await rightClick("NO-LOGIN");
await menuItem("SSH to this device").click();
await page.waitForTimeout(500);
check("a device with no login of its own says which half is missing",
  /No login for this device, and none saved for the project/i.test(await message()), await message());
check("and still nothing was sent", (await st(() => window.__opened)).length === 0);

// ------------------------------------------------ LT-330 inheriting one

// The project now has a login of its own, which is what a device with none
// falls back to: "by default all devices should inherit the global ssh and
// snmp password, admin can override".
await st(() => window.__cvStore.getState().rememberCredential("ssh", "cred-1"));
await page.waitForTimeout(300);
await rightClick("NO-LOGIN");
await menuItem("SSH to this device").click();
await page.waitForTimeout(900);
const inherited = await st(() => window.__opened);
check("a device with no login of its own uses the project's", inherited.length === 1 &&
  inherited[0].address === "192.0.2.12" && inherited[0].credentialId === "cred-1", JSON.stringify(inherited[0]));
// Back to a clean slate for the checks below, which count sessions.
await page.locator(".cv-ssh-tab", { hasText: "NO-LOGIN" }).locator(".cv-ssh-close").click();
await page.waitForTimeout(400);
await st(() => window.__resetSessions());

// ------------------------------------------------------------ a session

await rightClick("CORE-SW1");
await menuItem("SSH to this device").click();
await page.waitForTimeout(900);

const opened = await st(() => window.__opened);
check("SSH to a device asks the backend for a session", opened.length === 1, JSON.stringify(opened));
check("by address and credential id — never a password",
  opened[0]?.address === "192.0.2.10" && opened[0]?.credentialId === "cred-1" &&
  !JSON.stringify(opened[0]).toLowerCase().includes("password"), JSON.stringify(opened[0]));
check("with a terminal size the device can use straight away",
  opened[0]?.cols > 0 && opened[0]?.rows > 0, JSON.stringify(opened[0]));

const panel = page.locator(".cv-panel");
check("the panel comes forward on its SSH tab",
  (await panel.locator("button.is-active", { hasText: /^SSH/ }).count()) === 1);
check("with a tab named after the device",
  (await page.locator(".cv-ssh-tab", { hasText: "CORE-SW1" }).count()) === 1);

// ------------------------------------------ what the device says is drawn

await st(() => window.__fromDevice("ssh-1", "\r\nCORE-SW1#show version\r\nCisco IOS Software\r\n"));
await page.waitForTimeout(600);
const screen = await page.locator(".cv-ssh-screen:not([hidden]) .xterm-rows").textContent();
check("what the device sends is drawn in the terminal",
  /Cisco IOS Software/.test(screen ?? ""), (screen ?? "").slice(0, 120));

// ---------------------------------------------- what is typed goes back

await page.locator(".cv-ssh-screen:not([hidden]) .xterm-helper-textarea").first().focus();
await page.keyboard.type("show ip int brief");
await page.keyboard.press("Enter");
await page.waitForTimeout(500);
const sent = await st(() => window.__sent);
check("keystrokes go back to the session they were typed in",
  sent.length > 0 && sent.every((s) => s.id === "ssh-1"), JSON.stringify(sent.slice(0, 3)));
check("as typed, with the Enter as a carriage return and nothing added",
  sent.map((s) => s.text).join("") === "show ip int brief\r",
  JSON.stringify(sent.map((s) => s.text).join("")));

// --------------------------------------------------- a second session

await rightClick("ACCESS-SW7");
await menuItem("SSH to this device").click();
await page.waitForTimeout(900);
check("a second device opens a second session, not a second window",
  (await st(() => window.__opened)).length === 2 &&
  (await page.locator(".cv-ssh-tab").count()) === 2);
check("and it is the one in front", (await page.locator(".cv-ssh-tab.is-active").first().textContent())?.includes("ACCESS-SW7"));

await st(() => window.__fromDevice("ssh-2", "ACCESS-SW7>"));
await st(() => window.__fromDevice("ssh-1", "CORE-SW1#"));
await page.waitForTimeout(500);
const front = await page.locator(".cv-ssh-screen:not([hidden]) .xterm-rows").textContent();
check("each session's output lands on its own screen",
  /ACCESS-SW7>/.test(front ?? "") && !/show version/.test(front ?? ""), (front ?? "").slice(0, 120));

await page.locator(".cv-ssh-tab", { hasText: "CORE-SW1" }).locator("button").first().click();
await page.waitForTimeout(500);
const back = await page.locator(".cv-ssh-screen:not([hidden]) .xterm-rows").textContent();
// The scrollback survived being hidden, which is the point: a terminal that
// is unmounted to switch tabs loses everything the device said.
check("and going back to a tab still has everything that was said in it",
  /CORE-SW1#show version/.test(back ?? "") && /Cisco IOS Software/.test(back ?? ""), (back ?? "").slice(0, 200));

if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

// ------------------------------------------------------------ resizing

const resized = await st(() => window.__resized);
check("the device is told the real terminal size once it has been laid out",
  resized.length > 0 && resized.every((r) => r.cols > 0 && r.rows > 0), JSON.stringify(resized.slice(0, 2)));


// ------------------------------------------------- LT-323 font and size

const controls = page.locator(".cv-ssh-controls");
const control = (label) =>
  controls.locator(".cv-field", { has: page.locator(`span:text-is("${label}")`) }).locator("input, select").first();

check("the terminal offers a font and a size", (await control("Font").count()) === 1 && (await control("Size").count()) === 1);
const fontsNow = () => st(() => [...document.querySelectorAll(".cv-ssh-screen .xterm-rows")].map((e) => getComputedStyle(e).fontSize));
const sizeBefore = await fontsNow();
await control("Size").fill("18");
await page.waitForTimeout(600);
const sizeAfter = await fontsNow();
check("changing the size changes every open session, not just the one in front",
  sizeAfter.length === 2 && sizeAfter.every((s) => s === "18px") && sizeBefore[0] !== sizeAfter[0],
  `${JSON.stringify(sizeBefore)} -> ${JSON.stringify(sizeAfter)}`);
check("and it is remembered on this machine, not in the project",
  (await st(() => window.__settings)).sshFontSize === "18",
  JSON.stringify(await st(() => window.__settings)));

await control("Font").selectOption({ label: "Courier New" });
await page.waitForTimeout(500);
check("the font follows too",
  (await st(() => getComputedStyle(document.querySelector(".cv-ssh-screen:not([hidden]) .xterm-rows")).fontFamily)).includes("Courier New"));

// ------------------------------------------------------ LT-322 colour

const colour = controls.locator(".cv-check", { hasText: "Colour the output" }).locator("input");
check("colouring is offered and is on to begin with", await colour.isChecked());
await st(() => window.__fromDevice("ssh-1", "Gi1/0/1 is down, line protocol is down\r\n"));
await page.waitForTimeout(500);
// xterm draws each colour run in its own span, so a coloured line is several
// spans and a plain one is not.
const coloured = await st(() => {
  const rows = [...document.querySelectorAll(".cv-ssh-screen:not([hidden]) .xterm-rows > div")];
  const row = rows.find((r) => (r.textContent ?? "").includes("line protocol"));
  return row ? [...row.querySelectorAll("span")].filter((s) => getComputedStyle(s).color).map((s) => getComputedStyle(s).color) : [];
});
check("a device that sends plain text gets its state words coloured",
  new Set(coloured).size > 1, JSON.stringify([...new Set(coloured)]));

await colour.uncheck();
await page.waitForTimeout(300);
await st(() => window.__fromDevice("ssh-1", "Gi1/0/2 is down, line protocol is down\r\n"));
await page.waitForTimeout(500);
const plainRow = await st(() => {
  const rows = [...document.querySelectorAll(".cv-ssh-screen:not([hidden]) .xterm-rows > div")];
  const row = rows.find((r) => (r.textContent ?? "").includes("Gi1/0/2"));
  return row ? [...row.querySelectorAll("span")].map((s) => getComputedStyle(s).color) : [];
});
check("and switching it off leaves the next line exactly as the device sent it",
  new Set(plainRow).size <= 1, JSON.stringify([...new Set(plainRow)]));
await colour.check();
await page.waitForTimeout(300);

// --------------------------------------------------- LT-324 the log

const logging = controls.locator(".cv-check", { hasText: "Save the log" }).locator("input");
check("saving the log is offered and is off to begin with", !(await logging.isChecked()));
// Controlled by what the backend says, not by the click: the box ticks when
// the log is actually open, which is a round trip away.
await logging.click();
await page.waitForTimeout(700);
check("the box ticks once the log is actually open, not when it was asked for",
  await logging.isChecked());
const starts = await st(() => window.__logStarts);
check("it is asked for by device and folder, the same two a backup uses",
  starts.length === 1 && starts[0].folder === "/tmp/cv-configs" && starts[0].device === "CORE-SW1" &&
  starts[0].address === "192.0.2.10", JSON.stringify(starts[0]));
check("and the tab says where it is being written",
  /Logging to .*CORE-SW1/.test(await controls.textContent()), (await controls.textContent()).slice(0, 160));
check("with a mark on the tab itself, so it is visible from any other one",
  (await page.locator(".cv-ssh-tab", { hasText: "CORE-SW1" }).textContent())?.includes("✎"));

await logging.click();
await page.waitForTimeout(600);
check("and it can be stopped without ending the session",
  (await st(() => window.__logStops)).includes("ssh-1") &&
  (await page.locator(".cv-ssh-tab", { hasText: "CORE-SW1" }).count()) === 1);

// ------------------------------------------------ LT-325 keepalive

check("the session was opened with a keepalive interval",
  (await st(() => window.__opened))[0]?.keepaliveSeconds === 30,
  JSON.stringify((await st(() => window.__opened))[0]));
await control("Keepalive").fill("45");
await page.waitForTimeout(600);
const alives = await st(() => window.__keepalives);
check("changing it reaches every open session, not just the next one opened",
  alives.length === 2 && alives.every((a) => a.seconds === 45) &&
  new Set(alives.map((a) => a.id)).size === 2, JSON.stringify(alives));

await st(() => window.__deviceIsAlive("ssh-1", 1758240000000));
await page.waitForTimeout(400);
check("and the panel says when the device last took one",
  /Last confirmed/.test(await controls.textContent()), (await controls.textContent()).slice(0, 200));

// --------------------------------------- LT-321 somebody else's terminal

await rightClick("CORE-SW1");
check("a device also offers the terminal the machine already has",
  (await menuItem("SSH in an external terminal").count()) === 1);
await menuItem("SSH in an external terminal").click();
await page.waitForTimeout(600);
const external = await st(() => window.__external);
check("which is handed the address and the username", external.length === 1 &&
  external[0].address === "192.0.2.10" && external[0].username === "ops", JSON.stringify(external[0]));
check("and never the password — no external client takes one safely",
  !JSON.stringify(external[0]).toLowerCase().includes("password") &&
  !JSON.stringify(external[0]).includes("credentialId"), JSON.stringify(external[0]));
check("and the window says so rather than leaving it a mystery",
  /does not pass/.test(await message()), await message());
check("no session was opened here — it belongs to the other terminal now",
  (await st(() => window.__opened)).length === 2, String((await st(() => window.__opened)).length));

// ------------------------------------------------ the device hangs up

await st(() => window.__deviceHungUp("ssh-2", "The device closed the session."));
await page.waitForTimeout(500);
const closedTab = page.locator(".cv-ssh-tab", { hasText: "ACCESS-SW7" });
check("a session that ends leaves its tab, so the reason can be read",
  (await closedTab.count()) === 1);
await closedTab.locator("button").first().click();
await page.waitForTimeout(400);
const ended = await page.locator(".cv-ssh-screen:not([hidden]) .xterm-rows").textContent();
check("and says so on the screen", /closed the session/.test(ended ?? ""), (ended ?? "").slice(-120));

// ------------------------------------------------------------ closing

await closedTab.locator(".cv-ssh-close").click();
await page.waitForTimeout(400);
check("closing a tab takes it away", (await page.locator(".cv-ssh-tab").count()) === 1);
check("and tells the backend to end it", (await st(() => window.__closed)).includes("ssh-2"));

// ------------------------------------ closing the project ends every shell

await page.locator("button", { hasText: "Close project" }).first().click();
await page.waitForTimeout(900);
check("closing the project closes every session", (await st(() => window.__closedAll)) === 1);

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
