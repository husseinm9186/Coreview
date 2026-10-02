// A device keeps its own username and password — encrypted, and never in the
// project (LT-318).
//
// The inspector could always *choose* a credential somebody had already built
// in Settings. This is the half that was missing: type the login on the device
// itself, press Save, and press Clear to take it away again. The thing that
// must stay true throughout is D-006 — the secret goes to the vault and the
// document gets an id, so a `.coreview` file can be handed to somebody without
// handing over the login.
//
//     npm run dev            # in another terminal
//     node e2e/credentials.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

// Distinctive on purpose: a leak is unmistakable wherever it surfaces.
const SECRETS = {
  password: "PLAINTEXT-DEVICE-SSH-4a91",
  enable: "PLAINTEXT-DEVICE-ENABLE-77c2",
  community: "PLAINTEXT-DEVICE-COMMUNITY-0b3e",
};

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const project = {
  meta: { id: "creds", name: "Creds", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: {
    activePageId: "p1",
    probes: [],
    pages: [{
      id: "p1", name: "Core",
      canvas: { gridEnabled: true, snapEnabled: true, minimap: false, nodeStyle: "glyph" },
      edges: [],
      nodes: [{
        id: "a", type: "device", position: { x: 0, y: 0 }, width: 76, height: 76,
        data: { label: "CORE-SW1", deviceType: "core-switch", tags: [],
          addresses: [{ id: "x", label: "Mgmt", address: "192.0.2.10", isPrimary: true }] },
      }],
    }],
  },
};

// LT-335: a second project on the same machine. The vault is shared — it is
// one encrypted store per computer — but what each project *shows* must not be.
const other = {
  meta: { id: "other", name: "Other", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: { activePageId: "p1", probes: [],
    pages: [{ id: "p1", name: "Core",
      canvas: { gridEnabled: true, snapEnabled: true, minimap: false, nodeStyle: "glyph" },
      edges: [], nodes: [] }] },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
// LT-677: a device's inspector is tabbed; the control a check wants is under
// its tab, and the choice holds across selections.
const inspectorTab = async (name) => {
  const tab = page.locator('.cv-inspector-tabs button[role="tab"]', { hasText: new RegExp(`^${name}$`) });
  if (await tab.count()) { await tab.click(); await page.waitForTimeout(150); }
};

await page.addInitScript(({ p, o }) => {
  const listeners = {}, callbacks = {};
  let next = 1;
  window.__saved = [];        // every save_credential payload
  window.__deleted = [];      // every delete_credential id
  window.__documents = [];    // every document written back to the backend
  window.__tested = [];       // every ssh_test_credential payload
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  // A vault that behaves like the real one: locked until made, and only then
  // does it list anything.
  const vault = { exists: false, unlocked: false, kept: false, creds: [] };
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const id = next++; callbacks[id] = cb; return id; },
    invoke(cmd, args) {
      if (cmd === "plugin:event|listen") { listeners[args.event] = args.handler; return Promise.resolve(next++); }
      void listeners; void callbacks;
      const meta = { id: p.meta.id, name: p.meta.name, customer: "", site: "", ticket: "",
        engineer: "", description: "", created_at: p.meta.createdAt,
        updated_at: p.meta.updatedAt, archived: false };
      const otherMeta = { id: o.meta.id, name: o.meta.name, customer: "", site: "", ticket: "",
        engineer: "", description: "", created_at: o.meta.createdAt, updated_at: o.meta.updatedAt, archived: false };
      if (cmd === "list_projects") return Promise.resolve([meta, otherMeta]);
      if (cmd === "load_project")
        return args.id === o.meta.id
          ? Promise.resolve({ meta: otherMeta, document_version: o.documentVersion, document: o.document })
          : Promise.resolve({ meta, document_version: p.documentVersion, document: p.document });
      if (cmd === "save_project") {
        window.__documents.push(JSON.stringify(args.package.document));
        return Promise.resolve();
      }
      if (cmd === "get_settings") return Promise.resolve({});
      if (cmd === "vault_status")
        return Promise.resolve({ exists: vault.exists, unlocked: vault.unlocked,
          credentials: vault.creds.length, minimumPassphrase: 12, keptInKeychain: vault.kept });
      if (cmd === "create_vault") { vault.exists = true; vault.unlocked = true; return Promise.resolve(); }
      if (cmd === "unlock_vault") { vault.unlocked = true; return Promise.resolve(); }
      if (cmd === "remember_vault_key") { vault.kept = true; return Promise.resolve(); }
      if (cmd === "unlock_vault_from_keychain") return Promise.resolve(vault.kept ? "opened" : "off");
      if (cmd === "list_credentials")
        return Promise.resolve(vault.unlocked ? vault.creds.map(({ secret, ...rest }) => rest) : []);
      if (cmd === "save_credential") {
        const c = args.credential;
        window.__saved.push(JSON.stringify(c));
        const existing = c.id && vault.creds.find((x) => x.id === c.id);
        if (existing) {
          Object.assign(existing, { label: c.label, username: c.username, secret: c.secret, detail: c.detail ?? "" });
          return Promise.resolve(existing.id);
        }
        const id = `cred-${vault.creds.length + 1}`;
        vault.creds.push({ id, label: c.label, kind: c.kind, username: c.username,
          detail: c.detail ?? "", hasSecondSecret: Boolean(c.secondSecret), secret: c.secret });
        return Promise.resolve(id);
      }
      if (cmd === "ssh_test_credential") {
        window.__tested.push(args);
        if (args.address === "192.0.2.10") {
          return Promise.resolve({ outcome: "reached", detail: `${args.address} accepted this login.`, millis: 412 });
        }
        if (args.address === "192.0.2.99") {
          return Promise.resolve({ outcome: "refused", detail: `${args.address} rejected the credentials`, millis: 380 });
        }
        return Promise.resolve({ outcome: "unreachable", detail: "did not answer within 8s. The login itself was not tested.", millis: 8000 });
      }
      if (cmd === "delete_credential") {
        window.__deleted.push(args.id);
        const at = vault.creds.findIndex((c) => c.id === args.id);
        if (at >= 0) vault.creds.splice(at, 1);
        return Promise.resolve();
      }
      return Promise.resolve([]);
    },
  };
}, { p: project, o: other });

page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open", { hasText: "Creds" }).first().click();
await page.waitForTimeout(800);

// ------------------------------------------------------- find the override

await page.locator(".cv-node, .react-flow__node").first().click();
await page.waitForTimeout(400);

await inspectorTab("Identity");
const overrides = page.locator(".cv-cred-overrides");
check("a device offers a login of its own", (await overrides.count()) === 1);
await overrides.locator("summary").first().click();
await page.waitForTimeout(300);

const ssh = page.locator('.cv-cred-override[data-kind="ssh"]');
const snmp = page.locator('.cv-cred-override[data-kind="snmp"]');
check("with a section for SSH and one for SNMP",
  (await ssh.count()) === 1 && (await snmp.count()) === 1);

const field = (root, label) =>
  root.locator(".cv-field", { has: page.locator(`span:text-is("${label}")`) }).locator("input, select").first();

// ------------------------------------------------- half a login is refused

await field(ssh, "Username").fill("netadmin");
await page.waitForTimeout(200);
const saveSsh = ssh.locator("button", { hasText: /^Save$/ }).first();
check("Save is held back until there is a password to save",
  await saveSsh.isDisabled(), await saveSsh.getAttribute("title"));

// ----------------------------------------- saving makes the vault on the way

await field(ssh, "Password").fill(SECRETS.password);
await field(ssh, "Enable password").fill(SECRETS.enable);
await page.waitForTimeout(250);
check("and offered once both are there", !(await saveSsh.isDisabled()));
await saveSsh.click();
await page.waitForTimeout(400);

// No vault yet, so it asks for a passphrase rather than failing.
const passphrase = field(ssh, "Vault passphrase");
check("with no vault on the machine, it asks for a passphrase rather than failing",
  (await passphrase.count()) === 1);

// LT-329: the minimum stands, and the form now says what it is waiting for
// rather than greying the button out in silence. "can't create vault and save"
// was that silence, not the rule.
const create = ssh.locator("button", { hasText: "Create vault and save" }).first();
await passphrase.fill("short");
await page.waitForTimeout(250);
check("a passphrase under the minimum is still refused", await create.isDisabled());
check("and the form says how many more characters it wants",
  /7 more characters/.test(await ssh.textContent()), (await ssh.textContent()).slice(0, 200));

await passphrase.fill("not-a-real-passphrase");
await page.waitForTimeout(250);
check("then it asks for the confirmation, which is the next thing missing",
  (await create.isDisabled()) && /again to confirm/.test(await ssh.textContent()),
  (await ssh.textContent()).slice(0, 200));

await field(ssh, "Again").fill("not-the-same-passphrase");
await page.waitForTimeout(250);
check("and says so when the two do not match, before anything is created",
  (await create.isDisabled()) && /do not match/.test(await ssh.textContent()),
  (await ssh.textContent()).slice(0, 200));

await field(ssh, "Again").fill("not-a-real-passphrase");
await page.waitForTimeout(250);
check("with both right, it is offered", !(await create.isDisabled()));
await create.click();
await page.waitForTimeout(700);

const saved = await page.evaluate(() => window.__saved);
check("the login went to the vault", saved.length === 1, String(saved.length));
check("with the password and the enable secret in it",
  saved.some((s) => s.includes(SECRETS.password) && s.includes(SECRETS.enable)));
check("named after the device, because the vault is shared by every project",
  saved.some((s) => s.includes("CORE-SW1 \\u2014 netadmin (SSH)") || s.includes("CORE-SW1 — netadmin (SSH)")),
  saved[0]?.slice(0, 120));

check("and the device now says what it holds",
  (await ssh.locator("text=Saved as").count()) === 1);
check("with a button to replace it and a button to clear it",
  (await ssh.locator("button", { hasText: /^Replace$/ }).count()) === 1 &&
  (await ssh.locator("button", { hasText: /^Clear$/ }).count()) === 1);

// ------------------------------------------------- and nowhere near the file

await page.keyboard.press("Control+s");
await page.waitForTimeout(700);
const docs = await page.evaluate(() => window.__documents);
check("the project was written back", docs.length > 0, String(docs.length));
check("and the password is not in it — the document carries an id, not a secret",
  !docs.some((d) => d.includes(SECRETS.password) || d.includes(SECRETS.enable)));
check("the id is, which is how the crawl finds the login again",
  docs.some((d) => d.includes("cred-1")), docs[docs.length - 1]?.slice(0, 200));

// ----------------------------------------------------------- SNMP, v2c

const version = field(snmp, "Version");
check("SNMP offers both versions", (await version.count()) === 1);
await field(snmp, "Community (read-only)").fill(SECRETS.community);
await page.waitForTimeout(250);
await snmp.locator("button", { hasText: /^Save$/ }).first().click();
await page.waitForTimeout(700);

const saved2 = await page.evaluate(() => window.__saved);
check("the community went to the vault too", saved2.length === 2, String(saved2.length));
check("as a v2c record, which an empty username is what says",
  saved2[1]?.includes(`"username":""`) && saved2[1]?.includes(SECRETS.community),
  saved2[1]?.slice(0, 160));
check("and the vault did not have to be made a second time",
  (await field(snmp, "Vault passphrase").count()) === 0);

// ------------------------------------------------------------ clearing it

await ssh.locator("button", { hasText: /^Clear$/ }).first().click();
await page.waitForTimeout(300);
check("clearing asks first, because the password goes with it",
  (await ssh.locator("button", { hasText: "Clear it" }).count()) === 1);
await ssh.locator("button", { hasText: "Clear it" }).first().click();
await page.waitForTimeout(700);

check("the credential was deleted from the vault",
  (await page.evaluate(() => window.__deleted)).includes("cred-1"));
check("and the device is back to asking for a username",
  (await field(ssh, "Username").count()) === 1);

await page.keyboard.press("Control+s");
await page.waitForTimeout(700);
const after = await page.evaluate(() => window.__documents);
check("the device no longer points at it",
  !JSON.parse(after[after.length - 1]).pages[0].nodes[0].data.sshCredentialId,
  String(JSON.parse(after[after.length - 1]).pages[0].nodes[0].data.sshCredentialId));


// ------------------------- LT-335 another project does not see these logins

// The SSH credential was wiped above; put one back so there is something that
// could leak, and make it the project's own.
await field(ssh, "Username").fill("netadmin");
await field(ssh, "Password").fill(SECRETS.password);
await page.waitForTimeout(250);
await ssh.locator("button", { hasText: /^Save$/ }).first().click();
await page.waitForTimeout(700);
await page.evaluate(() => window.__cvStore.getState().rememberCredential("ssh", "cred-3"));
await page.waitForTimeout(300);

// ------------------------------------------- LT-345 does this login work?

// A credential has just been saved above, so there is one to test. The device
// knows its own address, so the box is filled in without being typed.
const testAt = ssh.locator('.cv-cred-test-at input');
check("a saved SSH login offers to be tested", (await testAt.count()) === 1);
check("against the device's own address, without it being typed",
  (await testAt.inputValue()) === "192.0.2.10", await testAt.inputValue());

const testBtn = ssh.locator("button", { hasText: /^Test it$/ });
await testBtn.click();
await page.waitForTimeout(600);
check("testing asks the backend, by address and credential id",
  (await page.evaluate(() => window.__tested)).length === 1 &&
  (await page.evaluate(() => window.__tested))[0].address === "192.0.2.10",
  JSON.stringify(await page.evaluate(() => window.__tested)));
check("and says it worked, with how long it took",
  /accepted this login/.test(await ssh.textContent()) && /412 ms/.test(await ssh.textContent()),
  (await ssh.textContent()).slice(-160));

// A wrong password and an unreachable host are different problems.
await testAt.fill("192.0.2.99");
await page.waitForTimeout(200);
await testBtn.click();
await page.waitForTimeout(600);
check("a device that answered and said no reads as a credential problem",
  /rejected the credentials/.test(await ssh.textContent()), (await ssh.textContent()).slice(-160));

await testAt.fill("192.0.2.123");
await page.waitForTimeout(200);
await testBtn.click();
await page.waitForTimeout(600);
check("and one that never answered says the login was not tested at all",
  /login itself was not tested/.test(await ssh.textContent()), (await ssh.textContent()).slice(-160));

check("SNMP is not offered a login test, because a shell cannot check one",
  (await snmp.locator("button", { hasText: /^Test it$/ }).count()) === 0);


const settings = async () => {
  if (!(await page.locator(".cv-tools").count())) {
    await page.locator(".cv-btn-tools").first().click();
    await page.waitForTimeout(300);
  }
  await page.locator(".cv-tools .cv-tabs button", { hasText: "Settings" }).first().click();
  await page.waitForTimeout(500);
};

await settings();
const mine = page.locator('[data-region="project-credentials"]');
check("this project's Settings lists the login it uses",
  /CORE-SW1|netadmin/.test(await mine.textContent()), (await mine.textContent()).slice(0, 200));

// LT-497: a project keeps several logins. Save one for the project; a place
// for the next appears, and the first stays.
{
  const logins = page.locator('[data-region="project-logins"]');
  const first = logins.locator('.cv-cred-override[data-kind="ssh"]').first();
  await field(first, "Username").fill("backup-reader");
  await field(first, "Password").fill(SECRETS.password);
  await page.waitForTimeout(200);
  await first.locator("button", { hasText: /^Save$/ }).first().click();
  await page.waitForTimeout(600);
  const sshBlocks = logins.locator('.cv-cred-override[data-kind="ssh"]');
  check("a project can keep more than one SSH login: saving one offers a place for the next",
    (await sshBlocks.count()) === 2 && /Another SSH login for this project/.test(await logins.textContent()),
    String(await sshBlocks.count()) + " " + (await logins.textContent()).slice(0, 200));
  check("and the crawl would try the project's logins in order",
    (await page.evaluate(() => window.__cvStore.getState().doc.credentialDefaults?.ssh)) !== undefined);
}

// Now the other project on the same machine and the same vault.
await page.locator(".cv-tools .cv-register-back").first().click();
await page.waitForTimeout(300);
await page.locator(".cv-more summary").click(); // LT-675: under More
await page.locator(".cv-more button", { hasText: "Close project" }).first().click();
await page.waitForTimeout(900);
await page.locator(".cv-project-open", { hasText: "Other" }).first().click();
await page.waitForTimeout(900);
await settings();

const theirs = await page.locator('[data-region="project-credentials"]').textContent();
check("another project does not show the first one's logins",
  !/netadmin/.test(theirs ?? ""), (theirs ?? "").slice(0, 200));
check("it says it refers to none of its own instead",
  /refers to no saved login/.test(theirs ?? ""), (theirs ?? "").slice(0, 200));
// D-059 (superseding LT-335's shut disclosure): no other project's login is
// reachable from inside this one at all — no vault table, no reveal — and
// the page says where the whole vault is managed.
check("and no other project's login can be listed or revealed from here",
  (await page.locator(".cv-settings-vault").count()) === 0 &&
  (await page.locator(".cv-tools .cv-vault-table").count()) === 0 &&
  (await page.locator(".cv-tools .cv-eye").count()) === 0 &&
  /managed from the start screen/.test(await page.locator('[data-region="project-credentials"]').textContent()));
check("the SSH and SNMP boxes are empty for it, not carrying the other project's",
  !/Saved as/.test(await page.locator('.cv-cred-override[data-kind="ssh"]').textContent()));

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
