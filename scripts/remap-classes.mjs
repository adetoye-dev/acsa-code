/**
 * Repo-wide class remaps, in one place so they can be reviewed and gated.
 *
 * Group 1 moves the hand-written sizes onto the scale.
 * Group 2 fixes contrast: "muted" grey was 3.67:1 on the app's lightest surface,
 * and the dense type scale is 9-11px, which needs the full 4.5 rather than the
 * 3.0 large text is allowed.
 *
 * The UI had 402 arbitrary font sizes and a scattering of arbitrary radii. They
 * are not wrong, they are just unrelated: `text-[11px]` and `text-[10px]` and
 * `text-[13px]` were each typed by hand, so nothing could be adjusted together.
 *
 * Every mapping here is **the same pixel value under a name** — the scale steps
 * in `tailwind.config.js` are size-only for the same reason an arbitrary
 * `text-[11px]` is: no line-height is set either way. That is what made it safe
 * to run across the whole tree in one go, and it is no longer quite true: the
 * scale has since been raised so nothing renders below 11px, so the `9px` and
 * `10px` entries below now map *up* to the floor on purpose. Every other entry
 * still cannot change how anything looks, and none of them are applied anywhere
 * today — `--check` reports zero would-change files.
 *
 * Two values are deliberately left alone: `text-[12.5px]` (2 uses) has no step
 * on the scale, and inventing one for two call sites is how the sprawl started.
 *
 * Idempotent: running it twice does nothing the second time.
 *
 *   node scripts/remap-classes.mjs [--check]
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const REPLACEMENTS = [
  [/\btext-\[9px\]/g, "text-4xs"],
  [/\btext-\[10px\]/g, "text-3xs"],
  [/\btext-\[11px\]/g, "text-2xs"],
  [/\btext-\[13px\]/g, "text-body"],
  // `text-[12px]` is deliberately NOT mapped to `text-xs`: the named step is
  // 12px *and* sets a 16px line-height, while the arbitrary form sets only the
  // size. One call site would silently gain a taller row. Line-heights are a
  // scale decision; this script only renames.
  // Tailwind's own steps: lg is 8px, md is 6px.
  [/\brounded-\[8px\]/g, "rounded-lg"],
  [/\brounded-\[6px\]/g, "rounded-md"],
  [/\brounded-\[4px\]/g, "rounded"],
  [ /\brounded-\[2px\]/g, "rounded-sm" ],

  // ── Contrast ────────────────────────────────────────────────────────────────
  // Measured with `scripts/check_contrast.mjs`, not guessed. `text-zinc-600` is
  // 2.29:1 on a card and `text-zinc-500` was 3.67:1, against the 4.5 that text
  // this small needs. 600 is too dark to be text at all on these surfaces, so its
  // uses move up one step, which now passes.
  [ /\btext-zinc-600\b/g, "text-zinc-500" ],
  [ /\bplaceholder-zinc-600\b/g, "placeholder-zinc-500" ],
  [ /\btext-purple-500\b/g, "text-purple-400" ],
];

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const check = process.argv.includes("--check");
const files = walk("src").filter((p) => [".ts", ".tsx"].includes(extname(p)));

let changedFiles = 0;
const totals = new Map();

for (const file of files) {
  const before = readFileSync(file, "utf8");
  let after = before;
  for (const [pattern, replacement] of REPLACEMENTS) {
    const hits = (after.match(pattern) || []).length;
    if (hits > 0) {
      totals.set(replacement, (totals.get(replacement) || 0) + hits);
      after = after.replace(pattern, replacement);
    }
  }
  if (after !== before) {
    changedFiles += 1;
    if (!check) writeFileSync(file, after);
  }
}

for (const [replacement, count] of [...totals].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${replacement.padEnd(12)} ${count}`);
}

const total = [...totals.values()].reduce((sum, n) => sum + n, 0);
console.log(`${check ? "would change" : "changed"} ${total} classes in ${changedFiles} files`);

if (check && total > 0) {
  console.error("remap-classes: classes that should have been remapped remain — run without --check");
  process.exit(1);
}
