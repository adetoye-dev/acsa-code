/**
 * check-page.mjs — the built page, in a real browser, measured rather than eyeballed.
 *
 * Same shape as the app's `gui-check.mjs`: serve the build, drive headless Chrome
 * over CDP, and assert the things a marketing page fails at quietly — horizontal
 * overflow at a narrow width, console errors from the animation code, a missing alt,
 * a skipped heading level, a link with nowhere to go.
 *
 * `--shots` also writes full-page screenshots to /tmp/acsa-site-shots.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4173;
const CDP_PORT = 9455;
const SHOTS = process.argv.includes("--shots");
const SHOT_DIR = "/tmp/acsa-site-shots";

const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((path) => existsSync(path));

if (!CHROME) {
  console.error("check-page: no Chrome — install one, or skip this check.");
  process.exit(0);
}

const children = [];
const cleanup = () => {
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

async function waitFor(url, label, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// `--host 127.0.0.1`: preview binds `localhost` only, which is IPv6 here, and the
// CDP client speaks to 127.0.0.1 — the check timed out before it was pinned.
children.push(spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: "ignore" }));
await waitFor(`http://127.0.0.1:${PORT}/`, "the preview server");

// Runners are LTS images where Chrome is happy as root only with --no-sandbox; a
// developer machine should keep the sandbox, so it is added only under CI.
const sandboxFlags = process.env.CI ? ["--no-sandbox"] : [];

children.push(spawn(CHROME, [
  ...sandboxFlags,
  "--headless=new", `--remote-debugging-port=${CDP_PORT}`, "--remote-debugging-address=127.0.0.1",
  "--user-data-dir=/tmp/acsa-site-profile", "--window-size=1440,900", "--hide-scrollbars",
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
], { stdio: "ignore" }));
await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`, "chrome");
if (SHOTS) mkdirSync(SHOT_DIR, { recursive: true });

const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/`)}`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let id = 0;
const pending = new Map();
const problems = [];
ws.onmessage = (message) => {
  const msg = JSON.parse(message.data);
  if (msg.id) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (p) msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.exceptionThrown") {
    problems.push(`uncaught: ${msg.params.exceptionDetails?.exception?.description?.split("\n")[0] ?? "?"}`);
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    problems.push(`console.error: ${msg.params.args?.[0]?.value ?? ""}`);
  }
};

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const AUDIT = `(() => {
  const vw = window.innerWidth;
  // An element wider than the viewport is only a problem if nothing clips it: the
  // hero glow sits under overflow:clip, and the feature index is a scrollable
  // strip by design. Page-level scrolling is asserted separately, so this stays
  // about elements that actually escape.
  const clipped = (el) => {
    let parent = el.parentElement;
    while (parent && parent !== document.documentElement) {
      const style = getComputedStyle(parent);
      if (style.overflowX !== "visible" || style.overflowY !== "visible") return true;
      parent = parent.parentElement;
    }
    return false;
  };
  const overflow = [...document.querySelectorAll("body *")]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 1 || r.left < -1); })
    .filter((el) => !clipped(el))
    .map((el) => el.tagName.toLowerCase() + "." + String(el.className).split(" ")[0])
    .slice(0, 5);
  const imagesWithoutAlt = [...document.querySelectorAll("img")].filter((img) => !img.hasAttribute("alt")).length;
  const linksWithoutHref = [...document.querySelectorAll("a")].filter((a) => !a.getAttribute("href")).length;
  const levels = [...document.querySelectorAll("h1,h2,h3,h4")].map((h) => Number(h.tagName[1]));
  const skips = levels.filter((level, i) => i > 0 && level - levels[i - 1] > 1).length;
  return {
    vw,
    scrollWidth: document.documentElement.scrollWidth,
    docHeight: document.documentElement.scrollHeight,
    overflow,
    h1: document.querySelectorAll("h1").length,
    imagesWithoutAlt,
    linksWithoutHref,
    headingSkips: skips,
    revealed: document.querySelectorAll("[data-reveal].is-in").length,
    reveals: document.querySelectorAll("[data-reveal]").length,
    typed: (document.getElementById("heroTerm")?.textContent || "").length,
    shots: [...document.querySelectorAll('img[src*="shots/"]')].map((img) => ({
      src: img.getAttribute("src"),
      loaded: img.complete && img.naturalWidth > 0,
    })),
  };
})()`;

for (const [width, height] of [[1440, 900], [1024, 800], [390, 844]]) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 500 });
  await evaluate("window.scrollTo(0, 0)");
  await sleep(900);
  // Scroll the whole page so every reveal fires, then come back for the audit.
  await evaluate(`(async () => {
    document.documentElement.style.scrollBehavior = "auto";
    const step = Math.round(window.innerHeight * 0.75);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 250));
  })()`);
  const audit = await evaluate(AUDIT);
  const label = `${width}px`;
  check(`${label}: no element overflows the viewport`, audit.overflow.length === 0, audit.overflow.join(", "));
  check(`${label}: no page-level horizontal scroll`, audit.scrollWidth <= width + 1, `scrollWidth ${audit.scrollWidth}`);
  if (width === 1440) {
    check("one h1", audit.h1 === 1, String(audit.h1));
    check("every image has alt", audit.imagesWithoutAlt === 0, `${audit.imagesWithoutAlt} missing`);
    check("every link has an href", audit.linksWithoutHref === 0, `${audit.linksWithoutHref} missing`);
    check("headings never skip a level", audit.headingSkips === 0, `${audit.headingSkips} skips`);
    check("scroll reveals fired", audit.revealed === audit.reveals, `${audit.revealed}/${audit.reveals}`);
    check("the terminal typed itself", audit.typed > 40, `${audit.typed} chars`);
    const broken = (audit.shots ?? []).filter((shot) => !shot.loaded);
    check(`${audit.shots?.length ?? 0} real screenshots load`, (audit.shots?.length ?? 0) >= 4 && broken.length === 0,
      broken.map((shot) => shot.src).join(", "));
  }
  if (SHOTS) {
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    writeFileSync(`${SHOT_DIR}/page-${width}.png`, Buffer.from(shot.data, "base64"));
  }
}

check("no console errors or uncaught exceptions", problems.length === 0, problems.slice(0, 3).join(" | "));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
cleanup();
process.exit(failed.length ? 1 : 0);
