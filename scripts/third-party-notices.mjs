// The notices that have to ship with an installer (LT-308, corrected by LT-312).
//
// Coreview's own licence is proprietary — free to use, everything else
// reserved. That changes nothing about the components it is built on. MIT says
// "the above copyright notice and this permission notice shall be included in
// all copies"; Apache-2.0 §4 says the same in more words. A *list of package
// names is not enough* — the licence text itself has to travel with the binary,
// which is what this collects.
//
//     node scripts/third-party-notices.mjs
//
// It walks the two real dependency trees, reads each component's own licence
// file off disk, groups identical texts so the result is readable, and writes
// THIRD-PARTY-NOTICES.md. That file is listed in tauri.conf.json under
// `bundle.resources`, so it is installed beside the application.
//
// Development-only packages are left out on purpose: the test runner and the
// dev server never reach an installer, so their notices do not have to.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Licences that would actually stop Coreview being distributed as proprietary.
 *  None are present today; this fails the run loudly if one ever arrives. */
const COPYLEFT = /\b(AGPL|GPL-[23]|GPL-2\.0|GPL-3\.0|SSPL|OSL|EUPL|CPAL)\b/i;
/** File-level copyleft: fine to link, but the source must be pointed at. */
const FILE_COPYLEFT = /\bMPL-2\.0\b/i;

const LICENCE_FILE = /^(LICEN[CS]E|COPYING|NOTICE|UNLICENSE)([-.].*)?$/i;

const licenceOf = (pkg) => {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return "";
};

/** Every licence-ish file in a directory, as text. */
function textsIn(dir) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!LICENCE_FILE.test(name)) continue;
    const full = join(dir, name);
    try {
      if (!statSync(full).isFile()) continue;
      const body = readFileSync(full, "utf8").trim();
      if (body) out.push(body);
    } catch {
      // Unreadable is the same as absent for our purposes.
    }
  }
  return out;
}

// ---------------------------------------------------------------- JavaScript

function productionNames() {
  const out = new Set();
  const walk = (node) => {
    for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
      out.add(name);
      walk(dep);
    }
  };
  walk(JSON.parse(execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], {
    maxBuffer: 64 * 1024 * 1024, encoding: "utf8",
  })));
  return out;
}

function installed(dir, found = new Map()) {
  if (!existsSync(dir)) return found;
  for (const name of readdirSync(dir)) {
    if (name === ".bin" || name === ".package-lock.json") continue;
    const full = join(dir, name);
    if (name.startsWith("@")) {
      installed(full, found);
      continue;
    }
    const manifest = join(full, "package.json");
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (pkg.name && !found.has(pkg.name)) found.set(pkg.name, { pkg, dir: full });
      } catch {
        // A package with an unreadable manifest is not one we can credit.
      }
    }
    installed(join(full, "node_modules"), found);
  }
  return found;
}

const wanted = productionNames();
const manifests = installed("node_modules");
const npm = [...wanted]
  .map((name) => manifests.get(name))
  .filter(Boolean)
  .map(({ pkg, dir }) => ({
    name: pkg.name,
    version: pkg.version,
    licence: licenceOf(pkg) || "see the text below",
    url: pkg.homepage ?? (typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url) ?? "",
    texts: textsIn(dir),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

// ---------------------------------------------------------------------- Rust

const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--all-features"], {
  cwd: "src-tauri", maxBuffer: 256 * 1024 * 1024, encoding: "utf8",
}));
const ownCrates = new Set(meta.workspace_members.map((id) => id.split(/[ #]/)[0].split("/").pop()));
const crates = meta.packages
  .filter((p) => !ownCrates.has(p.name) && !p.license?.startsWith("LicenseRef-Almoola"))
  .map((p) => ({
    name: p.name,
    version: p.version,
    licence: p.license ?? "see the text below",
    url: p.repository ?? "",
    // `manifest_path` points into the registry checkout, where the crate's own
    // licence files sit beside Cargo.toml.
    texts: textsIn(p.manifest_path.replace(/[/\\]Cargo\.toml$/, "")),
  }))
  .filter((p, i, all) => all.findIndex((x) => x.name === p.name && x.version === p.version) === i)
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

// -------------------------------------------------------------------- checks

const all = [...npm, ...crates];
const blocking = all.filter((c) => COPYLEFT.test(c.licence) && !/ OR /i.test(c.licence));
if (blocking.length) {
  console.error("Copyleft licences that a proprietary build cannot ship:");
  for (const c of blocking) console.error(`  ${c.name} ${c.version} — ${c.licence}`);
  process.exit(1);
}
const fileCopyleft = all.filter((c) => FILE_COPYLEFT.test(c.licence));
const missing = all.filter((c) => c.texts.length === 0);

// -------------------------------------------------------------------- output

/** Identical texts are printed once, with everything that shares them. */
function grouped(rows) {
  const by = new Map();
  for (const r of rows) {
    for (const text of r.texts) {
      const key = text.replace(/\s+/g, " ").trim();
      if (!by.has(key)) by.set(key, { text, users: new Set() });
      by.get(key).users.add(`${r.name} ${r.version}`);
    }
  }
  return [...by.values()].sort((a, b) => b.users.size - a.users.size);
}

const tally = (rows) => {
  const by = new Map();
  for (const r of rows) by.set(r.licence, (by.get(r.licence) ?? 0) + 1);
  return [...by].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} (${n})`).join(", ");
};

const table = (rows) =>
  ["| Component | Version | Licence |", "| --- | --- | --- |",
    ...rows.map((r) => `| ${r.name} | ${r.version} | ${r.licence} |`)].join("\n");

const texts = (rows) =>
  grouped(rows)
    .map(({ text, users }) => {
      const who = [...users].sort();
      const heading = who.length === 1 ? who[0] : `${who.length} components`;
      const list = who.length === 1 ? "" : `\n${who.map((u) => `- ${u}`).join("\n")}\n`;
      return `### ${heading}\n${list}\n\`\`\`\n${text}\n\`\`\``;
    })
    .join("\n\n");

writeFileSync("THIRD-PARTY-NOTICES.md", `# Third-party notices

Coreview is proprietary software, free to use — see \`LICENSE\`. It is built on
the open-source components listed here, which keep their own licences. Nothing
in Coreview's licence changes them, and the notices those licences require are
reproduced in full below, which is why this file is installed alongside the
application rather than only kept in the repository.

Generated from the real dependency trees by \`scripts/third-party-notices.mjs\`.
Run it again whenever dependencies change.

**No component is under a licence that prevents Coreview being distributed as
proprietary software.** There is no GPL, AGPL or SSPL anywhere in either tree —
the generator fails rather than writes this file if one ever appears.

${fileCopyleft.length ? `## Mozilla Public License 2.0 components

${fileCopyleft.length} component${fileCopyleft.length === 1 ? " is" : "s are"} under the MPL-2.0, which is
copyleft *per file*: linking them into a larger proprietary work is expressly
allowed, and the only obligation is to make the source of any **modified**
MPL-covered file available. Coreview uses them unmodified, as published. Their
source is at the addresses below.

${fileCopyleft.map((c) => `- **${c.name} ${c.version}** — ${c.url || "see crates.io"}`).join("\n")}
` : ""}
## JavaScript — ${npm.length} packages in the shipped bundle

${tally(npm)}

${table(npm)}

## Rust — ${crates.length} crates in the executable

${tally(crates)}

${table(crates)}
${missing.length ? `
## Components shipping no licence file of their own

These declare a licence in their manifest but ship no licence file in the
package. The declared licence is the one that applies; its standard text is the
one published by SPDX at \`https://spdx.org/licenses/\`.

${missing.map((c) => `- ${c.name} ${c.version} — ${c.licence}`).join("\n")}
` : ""}
---

# Licence texts

Every licence file found in the components above, reproduced in full. Identical
texts are shown once with the components that share them.

## JavaScript

${texts(npm)}

## Rust

${texts(crates)}
`);

console.log(
  `THIRD-PARTY-NOTICES.md: ${npm.length} npm packages, ${crates.length} crates, ` +
  `${grouped(all).length} distinct licence texts` +
  (missing.length ? `, ${missing.length} with no licence file of their own` : "") +
  (fileCopyleft.length ? `, ${fileCopyleft.length} MPL-2.0` : ""),
);
