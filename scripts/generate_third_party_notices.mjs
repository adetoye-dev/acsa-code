#!/usr/bin/env node
/**
 * Generate THIRD-PARTY-NOTICES.md.

 * Shipping binaries means shipping other people's code, and most permissive
 * licences require their notice to travel with it. The bundled fonts are the
 * strict case: OFL-1.1 requires the licence *text* to accompany the font, so it
 * is embedded here rather than merely referenced.

 * Regenerate after changing dependencies:
 *
 *     node scripts/generate_third_party_notices.mjs
 *
 * `--check` exits non-zero when the committed file is out of date, so CI can
 * catch a dependency bump that forgot to regenerate it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(REPO_ROOT, "THIRD-PARTY-NOTICES.md");
const NODE_MODULES = path.join(REPO_ROOT, "node_modules");

const checkOnly = process.argv.includes("--check");

/** Runtime dependency tree, including transitive packages that ship in a build. */
function runtimePackages() {
  const raw = execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], {
    cwd: REPO_ROOT,
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const tree = JSON.parse(raw);
  const found = new Map();
  const walk = (node) => {
    for (const [name, dep] of Object.entries(node.dependencies || {})) {
      if (!found.has(name)) found.set(name, dep.version || "");
      walk(dep);
    }
  };
  walk(tree);
  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function readManifest(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(NODE_MODULES, name, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

function licenseOf(manifest) {
  if (typeof manifest.license === "string" && manifest.license.trim()) return manifest.license.trim();
  if (Array.isArray(manifest.licenses) && manifest.licenses.length) {
    return manifest.licenses.map((l) => l.type || l).filter(Boolean).join(" OR ");
  }
  return "";
}

function repositoryOf(manifest) {
  const repo = manifest.repository;
  let url = typeof repo === "string" ? repo : repo?.url;
  if (!url) return "";
  url = url
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "");
  if (!/^https?:\/\//.test(url)) url = `https://github.com/${url}`;
  return url;
}

/** The OFL text must accompany the fonts, so it is embedded verbatim. */
function fontLicenceText(pkg) {
  for (const candidate of ["LICENSE", "LICENSE.txt", "LICENSE.md", "OFL.txt"]) {
    const file = path.join(NODE_MODULES, pkg, candidate);
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  }
  return "_(licence file not found in the installed package — regenerate after npm install)_";
}

/**
 * The toolchain `scripts/fetch_lsp_sidecar.sh` fetches, which ships inside the app
 * beside the engine and the Codex runtime: Node itself, the language server, and the
 * TypeScript that stands in for a project that has none of its own.
 *
 * The versions are read from that script's pins rather than from `.lsp/`, because
 * that directory is fetched build output and the notices have to be identical on a
 * machine that has fetched it and on CI, which has not. Reading the pins also means a
 * version bump there fails `notices:check` until this file is regenerated, which is
 * the point of the check.
 */
function bundledToolchain() {
  const script = fs.readFileSync(path.join(REPO_ROOT, "scripts", "fetch_lsp_sidecar.sh"), "utf8");
  const pin = (name, override) => {
    const match = new RegExp(`${name}="\\$\\{${override}:-([^}]+)\\}"`).exec(script);
    if (!match) throw new Error(`could not read the ${name} pin out of fetch_lsp_sidecar.sh`);
    return match[1];
  };

  return [
    { name: "node", version: pin("NODE_VERSION", "LSP_NODE_VERSION").replace(/^v/, ""), license: "MIT", repo: "https://github.com/nodejs/node" },
    { name: "typescript-language-server", version: pin("SERVER_VERSION", "LSP_SERVER_VERSION"), license: "MIT", repo: "https://github.com/typescript-language-server/typescript-language-server" },
    { name: "typescript", version: pin("TS_VERSION", "LSP_TS_VERSION"), license: "Apache-2.0", repo: "https://github.com/microsoft/TypeScript" },
  ];
}

const packages = runtimePackages();
const rows = [];
const unknown = [];
const notInstalled = [];

for (const [name, version] of packages) {
  const manifest = readManifest(name);
  if (!Object.keys(manifest).length) {
    // In the dependency tree but not installed — an unfulfilled optional or peer
    // dependency. Nothing of theirs ends up in a build, so nothing to attribute.
    notInstalled.push(name);
    continue;
  }
  const license = licenseOf(manifest);
  if (!license) unknown.push(`${name}@${version || manifest.version || ""}`);
  rows.push({
    name,
    version: version || manifest.version || "",
    license: license || "UNKNOWN",
    repo: repositoryOf(manifest),
  });
}

rows.push(...bundledToolchain());
rows.sort((a, b) => a.name.localeCompare(b.name));

const fonts = rows.filter((r) => r.license === "OFL-1.1" || r.name.startsWith("@fontsource/"));
const componentNames = rows
  .filter((r) => r.license !== "OFL-1.1")
  .map((r) => r.name)
  .sort();

const lines = [];
lines.push("# Third-party notices");
lines.push("");
lines.push(
  "ACSA Code is distributed under the MIT licence (see `LICENSE`). It bundles the"
);
lines.push(
  "components below, each under its own terms. Generated — do not edit by hand:"
);
lines.push("");
lines.push("```bash");
lines.push("node scripts/generate_third_party_notices.mjs");
lines.push("```");
lines.push("");
lines.push(
  "Build-only tooling (Vite, Tailwind, PostCSS, the Tauri CLI) is not distributed and"
);
lines.push(
  "is therefore not listed. The TypeScript language server, its Node runtime and the"
);
lines.push(
  "TypeScript it falls back to *are* distributed — fetched by"
);
lines.push("`scripts/fetch_lsp_sidecar.sh` and shipped in the bundle — so they are below.");
lines.push("");

lines.push("## Runtime libraries");
lines.push("");
for (const row of rows) {
  if (row.license === "OFL-1.1") continue;
  const repo = row.repo ? `[${row.repo.replace(/^https?:\/\//, "")}](${row.repo})` : "—";
  lines.push(`- **${row.name}** ${row.version} — ${row.license} — ${repo}`);
}
lines.push("");

lines.push("## Bundled fonts (SIL Open Font License 1.1)");
lines.push("");
lines.push(
  "The application bundles these fonts, so their licence text is reproduced below in full."
);
lines.push("");
for (const font of fonts) {
  lines.push(`### ${font.name} ${font.version}`);
  lines.push("");
  lines.push("```");
  lines.push(fontLicenceText(font.name));
  lines.push("```");
  lines.push("");
}

lines.push("## Components outside the npm tree");
lines.push("");
lines.push(
  "- **Python standard library** — Python Software Foundation Licence. The engine has no third-party Python dependencies."
);
lines.push(
  "- **PyInstaller** (build tool for the frozen `acsa-engine` sidecar) — GPL-2.0 **with the bootloader exception**, which explicitly permits distributing frozen applications under any licence. PyInstaller itself is not part of the frozen output beyond the bootloader it embeds."
);
lines.push(
  "- **Tauri and its Rust crates** — MIT or Apache-2.0, at your option."
);
lines.push("");

if (unknown.length) {
  lines.push("## Unresolved licences");
  lines.push("");
  lines.push("These packages did not declare a licence and need manual confirmation:");
  lines.push("");
  for (const entry of unknown) lines.push(`- ${entry}`);
  lines.push("");
}

if (notInstalled.length) {
  lines.push("## Not distributed");
  lines.push("");
  lines.push(
    "Declared in the dependency tree but not installed (unfulfilled optional or peer" +
      " dependencies). None of their code is bundled:"
  );
  lines.push("");
  for (const entry of notInstalled.sort()) lines.push(`- ${entry}`);
  lines.push("");
}

const content = `${lines.join("\n").trimEnd()}\n`;

if (checkOnly) {
  const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : "";
  if (current !== content) {
    console.error(
      "THIRD-PARTY-NOTICES.md is out of date. Run: node scripts/generate_third_party_notices.mjs"
    );
    process.exit(1);
  }
  console.log(
    `THIRD-PARTY-NOTICES.md is current (${componentNames.length} libraries, ${fonts.length} fonts).`
  );
  process.exit(0);
}

fs.writeFileSync(OUTPUT, content);
console.log(
  `Wrote THIRD-PARTY-NOTICES.md — ${componentNames.length} libraries, ${fonts.length} fonts.`
);
if (unknown.length) {
  console.warn(`Warning: ${unknown.length} package(s) have no declared licence: ${unknown.join(", ")}`);
}
