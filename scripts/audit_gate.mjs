/**
 * The dependency-advisory gate.
 *
 * `npm audit --audit-level=high` was the whole of this, and its flaw only shows
 * up over time: the tree carries a high advisory whose *only* resolution is a
 * breaking change, and a gate that cannot be satisfied without breaking
 * something is a gate that gets ignored — which is how it ends up unwired.
 *
 * The level is unchanged: high and critical fail, everything below is reported
 * and left alone. What is new is that an advisory with no fixed version can be
 * named here, with the reason it is safe to carry, and everything else still
 * fails. A carried advisory that stops being reported also fails, so the list
 * cannot quietly outlive its cause.
 *
 * It takes a report of its own (`--report <path>`) so the decisions below can be
 * checked against a known report rather than only against whatever the registry
 * says today — a gate whose exceptions are only exercised by the live feed is a
 * gate nobody can be sure still works.
 *
 *   node scripts/audit_gate.mjs
 *   node scripts/audit_gate.mjs --report fixture.json
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Advisories carried on purpose. Each has no published fix, so `npm audit fix`
 * cannot clear it and `--force` would only cross a breaking change — the choice
 * is to name it or to stop gating.
 */
const CARRIED = [
  {
    url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
    why:
      "braces — a DoS in a glob matcher reached only through Tailwind 3's file " +
      "watcher, at build time. Nothing the app ships or runs on a user's machine " +
      "is affected, and there is no fixed version to move to: 3.0.3, the latest, " +
      "is inside the vulnerable range. Goes away with Tailwind 4.",
  },
];

/** High and critical fail. Moderate and low are the floor the app already lives with. */
const GATED = new Set(["high", "critical"]);

const reportFlag = process.argv.indexOf("--report");
const reportPath = reportFlag === -1 ? null : process.argv[reportFlag + 1];

let report;
if (reportPath) {
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    console.error(`audit_gate: could not read the report at ${reportPath} — ${error.message}`);
    process.exit(1);
  }
} else {
  const audit = spawnSync("npm", ["audit", "--json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    // A gate that passes when it could not run is worse than no gate at all.
    console.error("audit_gate: `npm audit --json` produced no readable report");
    if (audit.stderr?.trim()) console.error(audit.stderr.trim());
    process.exit(1);
  }
}

if (report.error) {
  const detail = report.error.summary || report.error.detail || "unknown error";
  console.error(`audit_gate: npm audit could not run — ${detail}`);
  process.exit(1);
}

/**
 * The advisories themselves, not the packages they reach through: a `via` entry
 * that is a string is a parent name, and it fails only because a leaf below it
 * did. Allowing the leaf is what clears the branch.
 */
const advisories = new Map();
for (const [pkg, info] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of info.via ?? []) {
    if (typeof via !== "object" || via === null) continue;
    if (!GATED.has(via.severity) || advisories.has(via.url)) continue;
    advisories.set(via.url, { severity: via.severity, package: pkg, range: via.range, title: via.title });
  }
}

const carriedUrls = new Set(CARRIED.map((entry) => entry.url));
const blocking = [...advisories.entries()].filter(([url]) => !carriedUrls.has(url));
const stillReported = [...advisories.keys()].filter((url) => carriedUrls.has(url));
const stale = CARRIED.filter((entry) => !advisories.has(entry.url));

const counts = report.metadata?.vulnerabilities ?? {};
console.log(
  `audit: ${counts.total ?? 0} advisories ` +
    `(${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ` +
    `${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low)`,
);

for (const [url, advisory] of blocking) {
  console.log(`  ${advisory.severity.toUpperCase().padEnd(8)} ${advisory.package} ${advisory.range}`);
  console.log(`           ${advisory.title}`);
  console.log(`           ${url}`);
}
for (const entry of CARRIED.filter((e) => stillReported.includes(e.url))) {
  console.log(`  carried  ${entry.url} — ${entry.why}`);
}

if (stale.length > 0) {
  console.error(
    "\naudit_gate: a carried advisory is no longer reported — remove it from CARRIED" +
      " so the next one is not silently allowed:",
  );
  for (const entry of stale) console.error(`  ${entry.url}`);
}
if (blocking.length > 0) {
  console.error(
    `\naudit_gate: ${blocking.length} high or critical advisory(ies) with no carried reason.` +
      " Fix it, or add it to CARRIED with the reason it is safe to carry.",
  );
}
if (stale.length > 0 || blocking.length > 0) process.exit(1);

console.log("\naudit: no unreviewed high or critical advisories");
