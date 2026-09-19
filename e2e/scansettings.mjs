// A scan remembers how it was set up — and never remembers a secret (LT-135).
//
// Two things are checked here and the second matters more than the first:
//
//  1. what a discovery run was shaped like survives a restart, so repeating a
//     scan is one button rather than a form;
//  2. **no password, enable secret, community string or v3 passphrase is ever
//     written to the settings table.** That table is plain text in the same
//     database as the projects. Secrets belong in the vault, which is
//     encrypted, and are referenced from settings only by credential id.
//
// The operator asked for this in as many words: "i just don't want any secrit
// I type in my app or provide you here gets pushed to the github".
//
//     npm run dev            # in another terminal
//     node e2e/scansettings.mjs
import { chromium } from "playwright";

const URL = process.env.CV_URL ?? "http://localhost:5173/";
const NOW = 1756000000000;

// Deliberately distinctive, so a leak is unmistakable wherever it surfaces.
const SECRETS = {
  password: "PLAINTEXT-SSH-SECRET-9f2a",
  enable: "PLAINTEXT-ENABLE-SECRET-7c4b",
  community: "PLAINTEXT-COMMUNITY-3e8d",
  authPass: "PLAINTEXT-V3-AUTH-1b6f",
  privPass: "PLAINTEXT-V3-PRIV-5a0c",
};

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ""}`); }
};

const project = {
  meta: { id: "scan", name: "Scan", customer: "", site: "", ticket: "", engineer: "",
    description: "", createdAt: NOW, updatedAt: NOW, archived: false },
  documentVersion: 1,
  document: { nodes: [], edges: [], probes: [], canvas: {} },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });

await page.addInitScript(({ p }) => {
  if (!localStorage.getItem("coreview.projects.v1")) {
    localStorage.setItem("coreview.projects.v1", JSON.stringify({ [p.meta.id]: p }));
  }
  const listeners = {}, callbacks = {};
  let next = 1;
  // A settings table that behaves like the real one, and a log of every write
  // so the test can inspect what was actually stored.
  // Backed by localStorage: addInitScript runs again on reload, so a plain
  // object here would be wiped and "restart" would test nothing.
  const SKEY = "cv.e2e.settings";
  window.__cvSettings = JSON.parse(localStorage.getItem(SKEY) ?? "{}");
  window.__cvSettingWrites = [];
  window.__cvVaultCalls = [];
  const persist = () => localStorage.setItem(SKEY, JSON.stringify(window.__cvSettings));
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
      if (cmd === "load_project") {
        const saved = localStorage.getItem("cv.e2e.doc");
        return Promise.resolve({ meta, document_version: p.documentVersion,
          document: saved ? JSON.parse(saved) : p.document });
      }
      if (cmd === "get_settings") return Promise.resolve({ ...window.__cvSettings });
      if (cmd === "set_setting") {
        window.__cvSettingWrites.push(args);
        if (args.value === null || args.value === undefined) delete window.__cvSettings[args.key];
        else window.__cvSettings[args.key] = args.value;
        persist();
        return Promise.resolve();
      }
      if (cmd === "describe_subnet")
        return Promise.resolve({ network: "192.168.77.0", broadcast: "192.168.77.255", prefix: 24, hosts: 254 });
      // LT-286: a vault that behaves like the real one, so "Keep for this
      // project" can be driven end to end. Backed by localStorage, because
      // the restart below has to find it again.
      const VKEY = "cv.e2e.vault";
      const vault = () => JSON.parse(localStorage.getItem(VKEY) ?? '{"exists":false,"unlocked":false,"kept":false,"creds":[]}');
      const putVault = (v) => localStorage.setItem(VKEY, JSON.stringify(v));
      if (cmd === "vault_status") {
        const v = vault();
        return Promise.resolve({ exists: v.exists, unlocked: v.unlocked, credentials: v.creds.length,
          minimumPassphrase: 12, keptInKeychain: v.kept });
      }
      if (cmd === "create_vault") {
        putVault({ exists: true, unlocked: true, kept: false, creds: [] });
        window.__cvVaultCalls.push(cmd);
        return Promise.resolve();
      }
      if (cmd === "unlock_vault") {
        const v = vault(); v.unlocked = true; putVault(v);
        return Promise.resolve();
      }
      if (cmd === "remember_vault_key") {
        const v = vault(); v.kept = true; putVault(v);
        window.__cvVaultCalls.push(cmd);
        return Promise.resolve();
      }
      if (cmd === "unlock_vault_from_keychain") {
        const v = vault();
        if (!v.kept) return Promise.resolve("off");
        v.unlocked = true; putVault(v);
        return Promise.resolve("opened");
      }
      if (cmd === "delete_credential") {
        const v = vault();
        v.creds = v.creds.filter((c) => c.id !== args.id);
        putVault(v);
        window.__cvVaultCalls.push(cmd);
        return Promise.resolve();
      }
      if (cmd === "save_credential") {
        const v = vault();
        const c = args.credential;
        // LT-293: an id that is already there is an overwrite, exactly as the
        // real command's ON CONFLICT(id) DO UPDATE does.
        const existing = c.id && v.creds.find((x) => x.id === c.id);
        if (existing) {
          Object.assign(existing, { label: c.label, username: c.username, secret: c.secret });
          putVault(v);
          window.__cvVaultCalls.push("save_credential:replace");
          return Promise.resolve(existing.id);
        }
        const id = `cred-${v.creds.length + 1}`;
        // The whole point: the secret goes in here, and nowhere else.
        v.creds.push({ id, label: c.label, kind: c.kind, username: c.username,
          detail: c.detail ?? "", hasSecondSecret: Boolean(c.second_secret ?? c.secondSecret),
          secret: c.secret });
        putVault(v);
        window.__cvVaultCalls.push(cmd);
        return Promise.resolve(id);
      }
      if (cmd === "list_credentials") {
        const v = vault();
        if (!v.unlocked) return Promise.resolve([]);
        return Promise.resolve(v.creds.map(({ secret, ...rest }) => rest));
      }
      if (cmd === "save_project") {
        localStorage.setItem("cv.e2e.doc", JSON.stringify(args.package.document));
        return Promise.resolve();
      }
      return Promise.resolve([]);
    },
  };
}, { p: project });

page.on("pageerror", (e) => console.log("PAGE EXCEPTION:", String(e).slice(0, 300)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(700);

await page.locator("button", { hasText: "Discover devices" }).first().click();
await page.waitForTimeout(500);

// ------------------------------------------------------------ set a scan up

const field = (label) =>
  page.locator(".cv-field", { has: page.locator(`span:text-is("${label}")`) }).locator("input, select").first();

await page.locator(".cv-subnet-row input").first().fill("192.168.77.0/24");
await page.waitForTimeout(200);

// The seed and the login, as an operator would type them.
const seed = page.locator('input[placeholder*="10."], .cv-crawl-seed input').first();
if (await seed.count()) await seed.fill("192.168.77.7");
await field("Username").fill("Coreview").catch(() => {});
await field("Password").fill(SECRETS.password).catch(() => {});
await field("Enable password").fill(SECRETS.enable).catch(() => {});

// Open the SNMP section and fill in a v3 credential.
const snmp = page.locator(".cv-snmp summary").first();
if (await snmp.count()) {
  await snmp.click();
  await page.waitForTimeout(300);
  const version = field("Version");
  if (await version.count()) await version.selectOption("v3");
  await page.waitForTimeout(250);
  await field("User").fill("LABUSR").catch(() => {});
  await field("Auth password").fill(SECRETS.authPass).catch(() => {});
  await field("Privacy password").fill(SECRETS.privPass).catch(() => {});
}
await page.waitForTimeout(700);

// ------------------------------------------- nothing secret reached settings

const writes = await page.evaluate(() => window.__cvSettingWrites);
const stored = await page.evaluate(() => window.__cvSettings);
const blob = JSON.stringify({ writes, stored });

check("the scan shape was written to settings",
  writes.some((w) => w.key === "scanSubnets"), JSON.stringify(writes.map((w) => w.key)));

for (const [what, secret] of Object.entries(SECRETS)) {
  check(`the ${what} never reaches the settings table`, !blob.includes(secret));
}

// Every key written must be one the backend's allow-list accepts. A key it
// rejects is a silent no-op, which would look like "it did not save".
const ALLOWED = new Set([
  "backupFolder", "exportFolder", "iconLibraryDir", "addressPreference",
  "scanSeed", "scanSubnets", "scanPort", "scanMaxHops", "scanCredentialId",
  // LT-142: the SNMP credentials' shape as one JSON string. Never their
  // secrets — the check above asserts that.
  "scanSnmpRows",
]);
const rejected = writes.map((w) => w.key).filter((k) => !ALLOWED.has(k));
check("every key written is one the backend actually stores",
  rejected.length === 0, rejected.join(", "));

// --------------------------------------------- LT-286: keep it, once, ever
// The report: "its still not saving the passwords to the app after installed
// … everytime I need to rescan or take a backup I have to type the passwords".
// A fresh install has no vault, so this starts from nothing, exactly as his
// does.

const loginFormEarly = page.locator('.cv-discover-form', { has: page.locator('span:text-is("Username")') }).first();
const keep = page.locator("button", { hasText: "Keep for this project" }).first();
check("the run's own form offers to keep the credential", (await keep.count()) === 1);
await keep.click();
await page.waitForTimeout(300);
await field("Vault passphrase").fill("not-a-real-passphrase");
await field("Again").fill("not-a-real-passphrase");
await page.locator("button", { hasText: "Create vault and keep" }).first().click();
await page.waitForTimeout(700);

const vaultCalls = await page.evaluate(() => window.__cvVaultCalls);
check("it makes the vault, keeps the credential and the key",
  ["create_vault", "save_credential", "remember_vault_key"].every((c) => vaultCalls.includes(c)),
  vaultCalls.join(", "));

const afterKeep = JSON.stringify({
  writes: await page.evaluate(() => window.__cvSettingWrites),
  stored: await page.evaluate(() => window.__cvSettings),
  doc: await page.evaluate(() => window.__cvStore.getState().doc),
});
for (const [what, secret] of Object.entries(SECRETS)) {
  check(`keeping it puts no ${what} in settings or the project`, !afterKeep.includes(secret));
}
const kept = await page.evaluate(() => window.__cvStore.getState().doc.credentialDefaults);
check("the project records which credential it uses, by id", kept?.ssh === "cred-1", JSON.stringify(kept));

// --------------------------------- LT-292: the SNMP credential is kept as well
// "I need to save the credentials please both SNMP and discovery on the
// projects." The SSH half is above; this is the other one.

const snmpRow = page.locator(".cv-snmp-row").first();
if (await snmpRow.count()) {
  await snmpRow.locator("button", { hasText: "Keep for this project" }).first().click();
  await page.waitForTimeout(600);
  const keptSnmp = await page.evaluate(() => window.__cvStore.getState().doc.credentialDefaults?.snmp ?? []);
  check("the project records its SNMP credential too", keptSnmp.length === 1, JSON.stringify(keptSnmp));
  const blob = JSON.stringify({
    settings: await page.evaluate(() => window.__cvSettings),
    doc: await page.evaluate(() => window.__cvStore.getState().doc),
  });
  check("and neither the community nor the v3 passphrases went with it",
    !blob.includes(SECRETS.authPass) && !blob.includes(SECRETS.privPass) && !blob.includes(SECRETS.community));
}

// ------------------------------- LT-291: the form no longer says it never saves

const formText = await page.locator(".cv-discover-status").innerText();
check("the form does not claim credentials are never saved",
  !/never saved|this run only/i.test(formText), formText.slice(0, 90));
check("and says what keeping one does", /vault/i.test(formText), formText.slice(0, 90));

// ------------------------- LT-293: replace, forget for this project, and wipe

const heldButton = (label) => page.locator(".cv-keep-cred-held button", { hasText: label }).first();
check("a kept credential offers to be replaced", (await heldButton("Replace it").count()) === 1);
check("to be dropped by this project", (await heldButton("Forget for this project").count()) === 1);
check("and to be deleted outright", (await heldButton("Delete from the vault").count()) === 1);

// Replace: the same record is overwritten, so the project's reference holds.
await heldButton("Replace it").click();
await page.waitForTimeout(300);
await field("Username").fill("Coreview2");
await field("Password").fill("PLAINTEXT-REPLACED-4d1e");
await page.locator("button", { hasText: "Save over it" }).first().click();
await page.waitForTimeout(600);
const replaced = await page.evaluate(() => window.__cvVaultCalls);
check("replacing writes over the same saved credential",
  replaced.includes("save_credential:replace"), replaced.join(", "));
check("and the project still points at it",
  (await page.evaluate(() => window.__cvStore.getState().doc.credentialDefaults?.ssh)) === "cred-1");
const vaultNow = await page.evaluate(() => JSON.parse(localStorage.getItem("cv.e2e.vault")));
check("the new password went into the vault, not the settings",
  vaultNow.creds.find((c) => c.id === "cred-1")?.secret === "PLAINTEXT-REPLACED-4d1e",
  JSON.stringify(vaultNow.creds.map((c) => c.id)));
check("and no password is in the settings table",
  !JSON.stringify(await page.evaluate(() => window.__cvSettings)).includes("PLAINTEXT-REPLACED-4d1e"));

// Forget: this project stops using it; the vault keeps it.
await heldButton("Forget for this project").click();
await page.waitForTimeout(400);
check("forgetting it clears the project's reference",
  !(await page.evaluate(() => window.__cvStore.getState().doc.credentialDefaults?.ssh)));
// The SSH one is forgotten by the project; it and the SNMP one both stay.
check("but leaves the credential in the vault",
  (await page.evaluate(() => JSON.parse(localStorage.getItem("cv.e2e.vault")).creds.some((c) => c.id === "cred-1"))));

// Choose it again, then delete it outright.
await field("Credentials").selectOption("cred-1");
await page.waitForTimeout(400);
check("choosing it again records it on the project",
  (await page.evaluate(() => window.__cvStore.getState().doc.credentialDefaults?.ssh)) === "cred-1");
await heldButton("Delete from the vault").click();
await page.waitForTimeout(250);
check("deleting asks first", (await page.locator(".cv-keep-cred-held .cv-help").count()) === 1);
await page.locator(".cv-keep-cred-held button", { hasText: "Delete it" }).first().click();
await page.waitForTimeout(600);
// Only that one goes: the SNMP credential kept above is nothing to do with it.
check("deleting takes that credential out of the vault",
  !(await page.evaluate(() => JSON.parse(localStorage.getItem("cv.e2e.vault")).creds.some((c) => c.id === "cred-1"))));
check("and leaves the others alone",
  (await page.evaluate(() => JSON.parse(localStorage.getItem("cv.e2e.vault")).creds.length)) === 1);
check("and the project stops referring to it",
  !(await page.evaluate(() => window.__cvStore.getState().doc.credentialDefaults?.ssh)));
check("so the password fields come back",
  (await loginFormEarly.locator('.cv-field', { has: page.locator('span:text-is("Password")') }).count()) === 1);

// Put one back, so the restart below has something to find.
await field("Username").fill("Coreview");
await field("Password").fill(SECRETS.password);
await page.locator("button", { hasText: "Keep for this project" }).first().click();
await page.waitForTimeout(600);

// ------------------------------------------------- and it survives a restart

await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(700);
await page.locator(".cv-project-open").first().click();
await page.waitForTimeout(600);
await page.locator("button", { hasText: "Discover devices" }).first().click();
await page.waitForTimeout(800);

const subnetBack = await page.locator(".cv-subnet-row input").first().inputValue();
check("the subnet comes back after a restart", subnetBack === "192.168.77.0/24", subnetBack);

// Read from the settings table rather than the field: with a credential kept
// for the project the row shows the chooser, and the typed user is not on
// screen at all. The property under test is what was *stored* (LT-135).
const snmpShape = (await page.evaluate(() => window.__cvSettings)).scanSnmpRows ?? "";
check("the SNMP v3 user comes back, because it is not a secret",
  snmpShape.includes("LABUSR"), snmpShape.slice(0, 120));

check("but the v3 passphrase does not, because it is",
  !snmpShape.includes(SECRETS.authPass) && !snmpShape.includes(SECRETS.privPass), snmpShape.slice(0, 120));

// LT-292: the SNMP row comes back on its kept credential, with no passphrase
// asked for — the same bargain as the SSH one.
const snmpBack = page.locator(".cv-snmp-row").first();
if (await snmpBack.count()) {
  const chosen = await snmpBack
    .locator('.cv-field', { has: page.locator('span:text-is("Credentials")') })
    .locator("select").first().inputValue().catch(() => "");
  check("the SNMP row comes back on its kept credential", chosen.startsWith("cred-"), chosen);
  check("so no v3 passphrase is asked for again",
    (await snmpBack.locator('.cv-field', { has: page.locator('span:text-is("Auth password")') }).count()) === 0);
}

// LT-286: and after the restart the password is not asked for at all.
const credBack = await field("Credentials").inputValue().catch(() => "");
check("the kept credential is chosen again by itself", /^cred-\d+$/.test(credBack), credBack);
// Scoped to the form the chooser is in: the fallback login further down the
// panel is a different question and stays where it is.
const loginForm = page.locator('.cv-discover-form', { has: page.locator('span:text-is("Credentials")') }).first();
check("so no password is asked for a second time",
  (await loginForm.locator('.cv-field', { has: page.locator('span:text-is("Password")') }).count()) === 0,
  `${await loginForm.locator('.cv-field', { has: page.locator('span:text-is("Password")') }).count()} field(s)`);

await browser.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
