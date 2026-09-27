/**
 * gui-check.mjs — render the workbench in a real browser and assert what a unit
 * test cannot see: that every screen paints, that nothing overflows its window,
 * that the sidebar's icons sit on the column's centre line in both states, and
 * that opening an entry's dialog leaves the marketplace grid exactly as it was.
 *
 * Everything here was written because looking at the app found bugs the suite had
 * been happy to miss: images computing to zero width, icons flung across a panel
 * mid-transition, a card that stretched its grid out of shape. A grep cannot see
 * any of that; a screenshot can.
 *
 *   node scripts/gui-check.mjs            # headless, prints a report
 *   node scripts/gui-check.mjs --shots    # also writes PNGs to /tmp
 *
 * Needs Chrome (or Chromium) installed. Starts its own Vite server and its own
 * headless browser, and kills both on the way out.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 5199;
const CDP_PORT = 9444;
const APP = `http://127.0.0.1:${PORT}/`;
const SHOTS = process.argv.includes("--shots");
const shotDir = "/tmp/acsa-gui-check";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error("gui-check: no Chrome or Chromium found — install one, or skip this check.");
  process.exit(0); // Not a failure of the app; this check is optional tooling.
}

const children = [];
const cleanup = () => {
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

async function waitFor(url, label, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`${label} never came up at ${url}`);
}

/** A very small CDP client: evaluate, screenshot, move the mouse. */
class Session {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (p) msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        this.errors.push((msg.params.exceptionDetails?.exception?.description || "exception").split("\n")[0]);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  }
  async move(x, y) { await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 }); }
  async screenshot(name) {
    if (!SHOTS) return;
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${shotDir}/${name}.png`, Buffer.from(r.data, "base64"));
  }
}

const OVERFLOW = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const s = getComputedStyle(el);
    if (s.position === 'fixed' || s.visibility === 'hidden' || s.opacity === '0') continue;
    if (r.right > vw + 1 || r.left < -1 || r.bottom > vh + 1) {
      bad.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 50), right: Math.round(r.right) });
    }
  }
  return { vw, docScrollW: document.documentElement.scrollWidth, docScrollH: document.documentElement.scrollHeight, bad: bad.slice(0, 5) };
})()`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

children.push(spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: "ignore" }));
await waitFor(APP, "vite");

children.push(spawn(chrome, [
  "--headless=new", `--remote-debugging-port=${CDP_PORT}`, "--remote-debugging-address=127.0.0.1",
  `--user-data-dir=${shotDir || "/tmp"}/chrome-profile`, "--window-size=1440,900",
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
], { stdio: "ignore" }));
await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`, "chrome");
if (SHOTS) mkdirSync(shotDir, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === "page") || (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(APP)}`, { method: "PUT" })).json());
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const session = new Session(ws);
await session.send("Page.enable");
await session.send("Runtime.enable");

try {
  // 1. Nothing overflows its window, at three sizes.
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 700]]) {
    await session.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await session.send("Page.navigate", { url: APP });
    await sleep(2200);
    const m = await session.eval(OVERFLOW);
    check(`${width}×${height}: nothing outside the window`,
      m.bad.length === 0 && m.docScrollW <= m.vw && m.docScrollH <= height,
      m.bad.length ? JSON.stringify(m.bad) : `scroll ${m.docScrollW}×${m.docScrollH}`);
    await session.screenshot(`viewport-${width}`);
  }

  await session.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await session.send("Page.navigate", { url: APP });
  await sleep(2200);

  // 2. The sidebar's icons share the column's centre line, in both states.
  const geometry = await session.eval(`(() => {
    const nav = document.querySelector('[data-testid="workbench-nav"]');
    const left = nav.getBoundingClientRect().left;
    const icons = [...nav.querySelectorAll('[data-testid^="nav-item-"] svg')].map((svg) => {
      const r = svg.getBoundingClientRect();
      return +(r.left - left + r.width / 2).toFixed(1);
    });
    // The collapsed highlight, measured while collapsed: it has to be one square,
    // and its corners have to stay gentle rather than the lozenge a 12px radius
    // on a 36px row reads as.
    const row = nav.querySelector('[data-testid^="nav-item-"]');
    const rowBox = row.getBoundingClientRect();
    return {
      collapsed: Number.parseInt(nav.style.width, 10),
      centres: icons,
      highlight: {
        width: +rowBox.width.toFixed(1),
        height: +rowBox.height.toFixed(1),
        radius: Number.parseFloat(getComputedStyle(row).borderTopLeftRadius),
      },
    };
  })()`);
  await session.move(28, 500);
  await sleep(600);
  const expanded = await session.eval(`(() => {
    const nav = document.querySelector('[data-testid="workbench-nav"]');
    const left = nav.getBoundingClientRect().left;
    return {
      width: Number.parseInt(nav.style.width, 10),
      centres: [...nav.querySelectorAll('[data-testid^="nav-item-"] svg')].map((svg) => {
        const r = svg.getBoundingClientRect();
        return +(r.left - left + r.width / 2).toFixed(1);
      }),
    };
  })()`);
  const aligned = (list) => list.every((c) => Math.abs(c - 28) <= 0.6);
  check("sidebar icons sit on the centre line when collapsed", aligned(geometry.centres), `centres ${geometry.centres.join(", ")}`);
  check("sidebar icons still sit on it when expanded", aligned(expanded.centres) && expanded.width > 100, `width ${expanded.width}, centres ${expanded.centres.join(", ")}`);

  // The collapsed highlight is one square — not a rounded rectangle that happens
  // to have equal sides today — and its radius stays gentle. Both were asked for
  // by eye, and both are one class away from silently going back.
  const highlight = geometry.highlight;
  check("the collapsed highlight is one square",
    Math.abs(highlight.width - highlight.height) <= 0.5,
    `${highlight.width}×${highlight.height}`);
  check("the highlight's corners are less rounded than the rail used to be",
    highlight.radius >= 6 && highlight.radius <= 10,
    `radius ${highlight.radius}px`);

  // 2b. The rail is big enough to read, and the brand outranks it.
  //     `Icon` writes its size as an inline style, so a `w-8 h-8` class on a rail
  //     icon is silently ignored — the rail must be sized by the `size` prop, and
  //     this asserts the rendered box, not the class. The brand is an <img>: its
  //     ink carries ~23% padding, so "bigger than the icons" must be checked
  //     against ink, not against the box.
  const scale = await session.eval(`(() => {
    const nav = document.querySelector('[data-testid="workbench-nav"]');
    const img = nav.querySelector('[data-testid="nav-brand"] img');
    const icon = nav.querySelector('[data-testid^="nav-item-"] svg');
    if (!img || !icon) return null;
    const box = icon.getBoundingClientRect().width;
    const unit = box / icon.viewBox.baseVal.width;
    let ink = 0; try { ink = icon.getBBox().height * unit; } catch { /* unmeasurable */ }
    const brand = img.getBoundingClientRect().width;
    const rowH = nav.querySelector('[data-testid^="nav-item-"]').getBoundingClientRect().height;
    return { iconBox: +box.toFixed(1), iconInk: +ink.toFixed(1), brand, brandInk: +(0.7695 * brand).toFixed(1), rowH: +rowH.toFixed(1) };
  })()`);
  // A band rather than an exact number: the rail's size is a single constant
  // that gets tuned by eye, and this check exists to catch it falling back to
  // the 16px default or drifting out of the rail's range — not to pin it. The
  // band moves when the design does; what must not move is the rail's own idea
  // of what it is.
  check("rail icons are sized in the rail's band, not the Icon default",
    scale && scale.iconBox >= 17 && scale.iconBox <= 26,
    scale ? `icon ${scale.iconBox}px` : "no icon found");

  // The brand mark's *centre* has to sit on the same line as the icons'. Its box
  // is wider than an icon's, so this is not automatic: at 40px it landed there by
  // arithmetic coincidence, and shrinking the mark moved it 4px off until the
  // padding was derived from the size instead of copied from the rows.
  const brandCentre = await session.eval(`(() => {
    const nav = document.querySelector('[data-testid="workbench-nav"]');
    const img = nav.querySelector('[data-testid="nav-brand"] img');
    if (!img) return null;
    const navLeft = nav.getBoundingClientRect().left;
    const box = img.getBoundingClientRect();
    return +(box.left - navLeft + box.width / 2).toFixed(1);
  })()`);
  check("the brand mark is centred on the icons' line, not offset by its width",
    brandCentre !== null && Math.abs(brandCentre - 28) <= 1,
    `brand centre ${brandCentre}px`);
  check("the brand mark is larger than the rail icons",
    scale && scale.brand > scale.iconBox && scale.brandInk > scale.iconInk,
    scale ? `brand ${scale.brand}px (ink ~${scale.brandInk}) vs icon ${scale.iconBox}px (ink ~${scale.iconInk})` : "no brand found");
  // The highlight should hug the glyph: a row much taller than the icon reads as
  // a padded bar, and a row at or below the icon size has no highlight at all.
  const gutter = scale ? +((scale.rowH - scale.iconBox) / 2).toFixed(1) : null;
  check("the highlight hugs the icon (2–12px gutter)",
    gutter !== null && gutter >= 2 && gutter <= 12,
    scale ? `row ${scale.rowH}px, icon ${scale.iconBox}px, gutter ${gutter}px` : "no rows found");

  // 2c. A size class actually decides the size. This is the end-to-end form of
  //     the Icon bug: the component used to inline a 16px width on every icon,
  //     so a `w-3.5` class was dead. Only svgs with no inline size are counted —
  //     an explicit `size` prop is *supposed* to win, and it writes one.
  const classOnly = await session.eval(`(() => {
    const rows = [];
    for (const svg of document.querySelectorAll('svg')) {
      if (svg.getAttribute('style')) continue;              // explicitly sized
      const m = (svg.getAttribute('class') || '').match(/(?:^|\\s)w-\\[?([0-9.]+)(px|rem)?\\]?/);
      if (!m) continue;
      const r = svg.getBoundingClientRect();
      if (!r.width) continue;
      const declared = m[2] === 'px' ? parseFloat(m[1]) : m[2] === 'rem' ? parseFloat(m[1]) * 16 : parseFloat(m[1]) * 4;
      rows.push({ cls: m[0].trim(), declared, rendered: +r.width.toFixed(1) });
    }
    return rows;
  })()`);
  const honoured = classOnly.length >= 5 && classOnly.every((r) => Math.abs(r.declared - r.rendered) <= 0.5);
  check("a size class on an icon decides its size",
    honoured,
    `${classOnly.length} class-sized icons, e.g. ${classOnly.slice(0, 3).map((r) => `${r.cls} -> ${r.rendered}px`).join(", ")}`);

  await session.move(1000, 500);
  await sleep(500);
  await session.screenshot("sidebar");

  // 2d. The empty editor: one panel of actions, and it sits *on* the halftone
  //     field rather than above it. The panel used to be two menus, and the
  //     pattern is only worth having if the panel's lower half is over it —
  //     which is a measurement, not a look: the panel's midpoint has to land on
  //     the line where the field stops, and the field has to reach that line.
  const watermark = await session.eval(`(() => {
    const panel = document.querySelector('[data-testid="watermark-actions"]');
    const field = document.querySelector('.acsa-watermark-field');
    if (!panel || !field) return null;
    const host = field.parentElement;
    const p = panel.getBoundingClientRect();
    const f = field.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    return {
      panels: document.querySelectorAll('[data-testid="watermark-actions"]').length,
      rows: panel.querySelectorAll('button').length,
      midlineOffset: Math.round(p.top + p.height / 2 - (h.top + h.height / 2)),
      fieldShareOfHost: +(f.height / h.height).toFixed(3),
      fieldBottomGap: Math.round(h.bottom - f.bottom),
      fieldWidth: Math.round(f.width),
    };
  })()`);
  check("the empty editor offers a single panel of actions",
    watermark && watermark.panels === 1 && watermark.rows >= 3,
    watermark ? JSON.stringify(watermark) : "no watermark panel found");
  // Within a couple of pixels: the panel is what the parent centres, so this is
  // the assertion that the field's edge and the panel's middle are the same line.
  check("that panel is centred on the line where the field stops",
    watermark && Math.abs(watermark.midlineOffset) <= 2 && watermark.fieldBottomGap === 0 &&
      Math.abs(watermark.fieldShareOfHost - 0.5) <= 0.01,
    watermark ? `offset ${watermark.midlineOffset}px, field ${watermark.fieldShareOfHost} of host` : "no watermark panel found");
  await session.screenshot("empty-editor");

  // 3. Every screen paints something with a way back out of it.
  for (const id of ["git", "codeMap", "aiManager", "marketplace", "monitor"]) {
    await session.eval(`document.querySelector('[data-testid="nav-item-${id}"]').click()`);
    await sleep(900);
    const page = await session.eval(`({ back: Boolean(document.querySelector('[aria-label="Back to the editor"]')), text: document.body.innerText.length })`);
    check(`${id} screen renders with a way back`, page.back && page.text > 400);
    await session.screenshot(`screen-${id}`);
  }

  // 4. An entry's dialog opens, and the grid keeps its shape while it is up.
  await session.eval(`document.querySelector('[data-testid="nav-item-marketplace"]').click()`);
  await sleep(900);
  const before = await session.eval(`[...new Set([...document.querySelectorAll('[data-testid^="marketplace-item-"]')].map((b) => Math.round(b.getBoundingClientRect().height)))]`);
  await session.eval(`document.querySelector('[data-testid^="marketplace-item-"]').click()`);
  await sleep(700);
  const after = await session.eval(`(() => ({
    rows: [...new Set([...document.querySelectorAll('[data-testid^="marketplace-item-"]')].map((b) => Math.round(b.getBoundingClientRect().height)))],
    dialog: Boolean(document.querySelector('[data-testid="marketplace-detail"]')),
  }))()`);
  check("an entry's detail opens as a dialog and the grid keeps its height",
    after.dialog && JSON.stringify(before) === JSON.stringify(after.rows),
    `rows ${before.join("/")} -> ${after.rows.join("/")}`);
  await session.screenshot("marketplace-detail");

  // 5. The new-project dialog is a two-step wizard that fits the window it opens
  //    in. The single-step version stacked six template rows, two fields and the
  //    actions into one column taller than a laptop window, so the commit button
  //    was the thing you scrolled to find. Asserted at the shortest window the
  //    app is expected to run in.
  await session.send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false });
  await session.send("Page.navigate", { url: APP });
  await sleep(2200);
  await session.eval(`document.querySelector('[data-testid="project-switcher"]').click()`);
  await sleep(300);
  await session.eval(`document.querySelector('[data-testid="project-switcher-new"]').click()`);
  await sleep(500);
  const wizard = await session.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    const byText = (re) => [...d.querySelectorAll('button')].find((b) => re.test(b.textContent || ''));
    const fits = (el) => { const b = el && el.getBoundingClientRect(); return Boolean(b) && b.top >= 0 && b.bottom <= window.innerHeight && b.width > 0; };
    return {
      templates: d.querySelectorAll('[role="group"] button').length,
      fitsWindow: r.top >= 0 && r.bottom <= window.innerHeight,
      continueVisible: fits(byText(/continue/i)),
      nameFieldYet: Boolean(d.querySelector('input[type="text"]')),
      step1: /step 1 of 2/i.test(d.textContent || ''),
    };
  })()`);
  check("the new-project dialog opens on step 1, fits a 1024x700 window and shows its action",
    wizard && wizard.templates === 6 && wizard.fitsWindow && wizard.continueVisible && wizard.step1 && !wizard.nameFieldYet,
    wizard ? JSON.stringify(wizard) : "dialog did not open");
  await session.screenshot("new-project-step1");

  await session.eval(`[...document.querySelectorAll('[role="dialog"] button')].find((b) => /continue/i.test(b.textContent || '')).click()`);
  await sleep(400);
  // React tracks the value on the DOM node, so the native setter is how you type
  // into a controlled input from outside React.
  await session.eval(`(() => {
    const input = document.querySelector('[role="dialog"] input[type="text"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'My New App');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(400);
  const step2 = await session.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const r = d.getBoundingClientRect();
    const b = [...d.querySelectorAll('button')].find((x) => /create project/i.test(x.textContent || ''));
    const bb = b && b.getBoundingClientRect();
    return {
      step2: /step 2 of 2/i.test(d.textContent || ''),
      destination: d.querySelector('[data-testid="projectmodal-destination"]') ? d.querySelector('[data-testid="projectmodal-destination"]').textContent : null,
      fitsWindow: r.bottom <= window.innerHeight,
      createVisible: Boolean(bb) && bb.top >= 0 && bb.bottom <= window.innerHeight,
    };
  })()`);
  check("step 2 names the folder the two fields add up to, and still fits",
    step2 && step2.step2 && step2.destination === '~/AcsaProjects/my-new-app' && step2.fitsWindow && step2.createVisible,
    step2 ? JSON.stringify(step2) : "step 2 did not render");

  // 5b. The primary action has to be readable. `--action-primary` used to resolve
  //     through the neutral "crisp zinc" accent, so every primary button was white
  //     text on a near-white fill — 1.05:1, which the class-scanning contrast gate
  //     could not see because the colour arrives through a var chain, not a class.
  const cta = await session.eval(`(() => {
    const b = [...document.querySelectorAll('[role="dialog"] button')].find((x) => /create project/i.test(x.textContent || ''));
    if (!b) return null;
    const s = getComputedStyle(b);
    // A colour-mix comes back as "color(srgb 0..1 ...)"; a plain fill as
    // "rgb(0..255 ...)". Normalise before the transfer function.
    const lum = (css) => {
      const m = css.match(/[\\d.]+/g);
      if (!m || m.length < 3) return null;
      const scale = /^color\\(/.test(css.trim()) ? 1 : 255;
      const [r, g, bb] = m.slice(0, 3).map((n) => {
        const v = Number(n) / scale;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * bb;
    };
    const a = lum(s.color), c = lum(s.backgroundColor);
    if (a === null || c === null) return { parseFailed: true, color: s.color, bg: s.backgroundColor };
    const ratio = (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05);
    return { color: s.color, bg: s.backgroundColor, ratio: +ratio.toFixed(2) };
  })()`);
  check("the primary action is readable against its own fill",
    cta && cta.ratio >= 4.5,
    cta ? `${cta.color} on ${cta.bg} = ${cta.ratio}:1` : "no primary action found");

  await session.screenshot("new-project-step2");

  // 6. Reduced motion is honoured. Nothing here respected it: a spinner, a pulsing
  //    status dot, an entrance animation on every dialog and a sidebar that
  //    animates its own width were all unavoidable. Asserted on the rail's width
  //    transition because it is always present, unlike a spinner.
  // Measured before the emulation, so the assertion is about the *change* rather
  // than a threshold: with the rule, `0.15s` becomes `0.00001s`; without it, both
  // readings are `0.15s` and this fails.
  const normalMotion = await session.eval(`(() => {
    const rail = document.querySelector('[data-testid="workbench-nav"]');
    return rail ? getComputedStyle(rail).transitionDuration : null;
  })()`);
  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await session.send("Page.navigate", { url: APP });
  await sleep(2200);
  const reduced = await session.eval(`(() => {
    const rail = document.querySelector('[data-testid="workbench-nav"]');
    return rail ? { duration: getComputedStyle(rail).transitionDuration } : null;
  })()`);
  check("reduced motion is honoured (transitions collapse)",
    Boolean(reduced && normalMotion) && parseFloat(reduced.duration) < parseFloat(normalMotion) / 2,
    reduced ? `rail transition-duration ${normalMotion} -> ${reduced.duration}` : "no rail found");
  // Put it back, so the checks after this one see the normal page.
  await session.send("Emulation.setEmulatedMedia", { features: [] });

  // 7. Nothing threw along the way.
  check("no uncaught errors in the console", session.errors.length === 0, session.errors.slice(0, 3).join(" | "));
} finally {
  ws.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ngui-check: ${results.length - failed}/${results.length} passed${SHOTS ? ` (screenshots in ${shotDir})` : ""}`);
process.exit(failed === 0 ? 0 : 1);
