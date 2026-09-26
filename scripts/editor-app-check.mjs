/**
 * editor-app-check.mjs — the whole app, in a browser, driven like a user.
 *
 * The editor's typing bug — one keystroke landing per click — does not reproduce
 * when the editor is mounted on its own, which says the cause is in the app
 * around it: the dockview panels, the workbench context, a per-keystroke effect.
 * So this runs the *real* app with a stubbed Tauri IPC layer, opens a file from
 * the explorer, and types into it with real key events. It reproduced the bug
 * (`a{hello` -> `a{h`) and names the culprit in a focusout stack.
 *
 * Why a stub rather than the packaged app: a Tauri rebuild is minutes and gives
 * no DOM to inspect; this is seconds and lets the test read exactly what the
 * user sees. The assertions are on the rendered text, so they cannot pass
 * because a mocked model said so.
 *
 *   node scripts/editor-app-check.mjs            # against the dev server
 *   node scripts/editor-app-check.mjs --dist     # against the built bundle
 *
 * Two things about the browser that this had to work around, and neither is
 * obvious from a failure:
 *
 *   * Monaco chooses its input mechanism from `typeof globalThis.EditContext`,
 *     which Chrome has and the macOS webview the app actually ships in does
 *     not. The stub deletes it, so Chrome exercises the same path a user does;
 *     without that this silently tests a mechanism no user has.
 *   * Monaco renders a space as `&nbsp;` so layout will not collapse it, so the
 *     text read back out of `.view-lines` is full of U+00A0 where the file has
 *     U+0020. `editorText` normalises, which keeps assertions from failing on a
 *     rendering detail — and from passing by accident.
 *
 * And one for whoever verifies the packaged app by hand instead: two copies can
 * be installed at once (a build under `.tauri/target` and the released one),
 * `cua.getApp("ACSA Code")` may bind to either, and a screenshot can show one
 * while the AX tree describes the other — which is how a fixed build gets
 * reported as still broken. Kill every copy, confirm none remain, and bind by
 * full app path.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 5202;
const CDP_PORT = 9446;
const APP = `http://127.0.0.1:${PORT}/`;
/**
 * `--dist` serves the built bundle instead of the dev server.
 *
 * The dev server and the shipped app are not the same artifact, and a bug that
 * only appears in one is exactly the kind that ships. This is how the packaged
 * bundle gets checked from the same browser that checks the source.
 */
const SERVE_DIST = process.argv.includes("--dist");
const SHOT_DIR = "/tmp/acsa-editor-app-check";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error("editor-app-check: no Chrome/Chromium found.");
  process.exit(0);
}

/**
 * The smallest Tauri that this app's startup path actually talks to.
 *
 * `EditContext` is removed on purpose. Monaco picks its input mechanism from
 * `typeof globalThis.EditContext === 'function'` and Chrome has it while the
 * macOS webview the app actually ships in does not — so leaving it in would
 * test a code path no user has.
 */
const TAURI_STUB = `(() => {
  globalThis.EditContext = undefined;
  window.__engineCalls = [];
  window.__writes = [];
  // What the repository page is given: a tree with staged and unstaged files, and
  // a history whose second commit is a merge of two lines.
  (() => {
    const sha = (letter) => letter.repeat(40);
    const at = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600e3).toISOString();
    const changed = (path, indexStatus, workTreeStatus, isStaged) => ({ path, indexStatus, workTreeStatus, isStaged });
    window.__git = {
      status: {
        isGit: true,
        branch: "dev",
        ahead: 2,
        behind: 1,
        staged: [
          changed("src/components/layout/IdeLayout.tsx", "M", " ", true),
          changed("src/services/usePipeline.ts", "A", " ", true),
        ],
        unstaged: [
          changed("src/components/dashboards/GitDashboard.tsx", " ", "M", false),
          changed("core-engine/git_cli.py", " ", "M", false),
          changed("docs/RELEASING.md", " ", "M", false),
        ],
      },
      log: {
        isGit: true,
        head: sha("a"),
        commits: [
          { sha: sha("a"), short: "aaaaaaa", parents: [sha("b"), sha("c")], author: "Ada", date: at(1), subject: "Merge the sidebar rework" },
          { sha: sha("b"), short: "bbbbbbb", parents: [sha("d")], author: "Ada", date: at(5), subject: "Tighten the rail highlight" },
          { sha: sha("c"), short: "ccccccc", parents: [sha("d")], author: "Grace", date: at(9), subject: "Draw the commit graph" },
          { sha: sha("d"), short: "ddddddd", parents: [sha("e")], author: "Ada", date: at(30), subject: "Read the history from the engine" },
          { sha: sha("e"), short: "eeeeeee", parents: [], author: "Grace", date: at(72), subject: "First commit" },
        ],
        refs: [
          { name: "dev", kind: "branch", target: sha("a"), current: true },
          { name: "origin/dev", kind: "remote", target: sha("b"), current: false },
          { name: "v0.2.0", kind: "tag", target: sha("d"), current: false },
          { name: "main", kind: "branch", target: sha("e"), current: false },
        ],
      },
    };
  })();
  // What the engine answers for the two AI actions the editor can make. Set per
  // check, so a review or an inline edit is deterministic rather than a
  // question about which model happened to reply.
  window.__ai = { review: { ok: true, issues: [] }, inline: { ok: true, replacement: "" } };
  const callbacks = new Map();
  let nextCallbackId = 1;
  let nextEventId = 1;

  const TREE = [
    { name: "probe.ts", path: "/probe/probe.ts", is_dir: false, size_bytes: 6, children: null },
  ];
  const CONTENTS = { "/probe/probe.ts": "a{\\n}\\n" };
  const SETTINGS = {};
  const DB = {
    "settings.get": () => SETTINGS,
    "settings.set": () => ({ ok: true }),
    "providers.get": () => ({}),
    "secrets.list": () => [],
    "projects.list": () => [{ path: "/probe", name: "probe", last_opened_at: Date.now(), is_active: 1 }],
    "projects.active": () => ({ path: "/probe", name: "probe", last_opened_at: Date.now(), is_active: 1 }),
    "projects.touch": () => ({ ok: true }),
    "projects.forget": () => ({ ok: true }),
    "chat.load": () => null,
    "usage.summary": () => ({}),
  };

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback(callback, once) {
      const id = nextCallbackId++;
      callbacks.set(id, { callback, once });
      return id;
    },
    async invoke(cmd, args) {
      window.__engineCalls.push(cmd + (args && args.subcommand ? ":" + args.subcommand : "") + (args && args.args && args.args[0] ? ":" + args.args[0] : ""));
      if (cmd === "plugin:event|listen") return nextEventId++;
      if (cmd === "plugin:event|unlisten") return null;
      if (cmd === "engine_call") {
        const sub = args && args.subcommand;
        const list = args && args.args;
        if (sub === "db") {
          const fn = DB[list && list[0]];
          return JSON.stringify({ ok: true, data: fn ? fn() : null });
        }
        if (sub === "git") {
          // A history with a merge in it, so the graph has two lanes and a join to
          // draw — a straight line would pass without exercising any of that.
          const action = list && list[0];
          if (action === "status") return JSON.stringify({ ok: true, data: window.__git.status });
          if (action === "log") return JSON.stringify({ ok: true, data: window.__git.log });
          return JSON.stringify({ ok: true, data: { success: true } });
        }
        if (sub === "indexer") return JSON.stringify({ ok: true, data: { indexed: true, totalSymbols: 0, profile: null } });
        if (sub === "ai") {
          const action = list && list[0];
          if (action === "review-file") return JSON.stringify({ ok: true, data: window.__ai.review });
          if (action === "inline-edit") return JSON.stringify({ ok: true, data: window.__ai.inline });
          return JSON.stringify({ ok: true, data: null });
        }
        if (sub === "ollama") return JSON.stringify({ ok: true, data: { installed: false, running: false, models: [], recommendedModel: "qwen2.5-coder:3b", totalRamGb: 0 } });
        // A real status shape: the empty editor's action panel shows the
        // project's own commands when it has any, and a stub that answers with
        // a bare truthy object leaves that half of the panel untested.
        if (sub === "project") return JSON.stringify({ ok: true, data: {
          projectRoot: "/probe", hasPackageJson: true, hasNodeModules: true, needsInstall: false,
          manager: "npm", installCommand: "npm install", devCommand: "npm run dev",
          buildCommand: "npm run build", testCommand: "npm test", scripts: {},
        } });
        if (sub === "crash") return JSON.stringify({ ok: true, data: { ok: true } });
        return JSON.stringify({ ok: true, data: null });
      }
      if (cmd === "list_project_files") return TREE;
      if (cmd === "read_file_content") return CONTENTS[args && args.filePath] || "";
      if (cmd === "write_file_content") {
        // Recorded, not applied: a save has to be observable without the harness
        // pretending to be a filesystem.
        window.__writes.push({ filePath: args && args.filePath, content: args && args.content });
        return null;
      }
      if (cmd === "create_file_or_folder") return null;
      if (cmd === "delete_project_file") return null;
      if (cmd === "pick_folder") return null;
      if (cmd === "fetch_system_metrics") return { cpu_usage: 1, memory_usage: 1, disk_usage: 1 };
      return null;
    },
  };
})();`;

/** Records every focus change with a stack, so a focus thief names itself. */
const FOCUS_LOGGER = `(() => {
  window.__focusLog = [];
  const describe = (el) => {
    if (!el) return null;
    const cls = String(el.className || '').split(/\\s+/).filter(Boolean).slice(0, 3).join('.');
    return el.tagName + (cls ? '.' + cls : '');
  };
  const record = (type) => (event) => {
    window.__focusLog.push({
      type,
      target: describe(event.target),
      now: describe(document.activeElement),
      stack: String((new Error()).stack || '').split('\\n').slice(2, 7).join(' <- '),
    });
  };
  document.addEventListener('focusout', record('focusout'), true);
  document.addEventListener('focusin', record('focusin'), true);
})();`;

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
    try { const res = await fetch(url); if (res.ok) return; } catch { /* not up */ }
    await sleep(500);
  }
  throw new Error(`${label} never came up at ${url}`);
}

class Session {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; this.console = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (p) msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
        return;
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
        this.console.push(`${msg.params.type}: ${text}`.slice(0, 240));
        if (msg.params.type === "error") this.errors.push(text.slice(0, 240));
      }
      if (msg.method === "Fetch.requestPaused") {
        const { requestId } = msg.params;
        if (this.hold) {
          this.held.push(requestId);
          return;
        }
        this.send("Fetch.continueRequest", { requestId }).catch(() => {});
      }
      if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        this.console.push(`log: ${msg.params.entry.text}`.slice(0, 240));
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const details = msg.params.exceptionDetails;
        const head = (details?.exception?.description || details?.text || "exception").split("\n")[0];
        const frames = (details?.stackTrace?.callFrames || [])
          .slice(0, 8)
          .map((f) => `${f.functionName || "?"} @ ${String(f.url).replace(/^http:\/\/127\.0\.0\.1:\d+/, "")}:${f.lineNumber + 1}:${f.columnNumber + 1}`);
        this.errors.push([head, ...frames].join("\n      "));
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
  async click(x, y) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
    }
  }
  async char(ch) {
    const code = ch.codePointAt(0);
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown", text: ch, unmodifiedText: ch, key: ch,
      windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: ch, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
    });
  }
  async type(text, delay = 70) {
    for (const ch of text) { await this.char(ch); await sleep(delay); }
  }
  async chord(key, code) {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await this.send("Input.dispatchKeyEvent", { type, key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: 4 });
    }
  }
  /**
   * Cmd+C / Cmd+X / Cmd+V.
   *
   * A real keyboard makes the browser run its own editing command; a synthesised
   * key event alone does not, and the page never sees a copy or cut event at all.
   * `commands` is what makes this a keypress rather than a key code.
   */
  async editingCommand(letter, code, command) {
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: letter, code: `Key${letter.toUpperCase()}`, modifiers: 4,
      windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, commands: [command],
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: letter, code: `Key${letter.toUpperCase()}`, modifiers: 4,
      windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
    });
  }
  copy() { return this.editingCommand("c", 67, "copy"); }
  cut() { return this.editingCommand("x", 88, "cut"); }
  paste() { return this.editingCommand("v", 86, "paste"); }
  /**
   * A non-character key. `text` is what the browser would insert for the key,
   * and CDP only models a real Enter if it is given the carriage return the
   * keyboard would produce — without it the editor sees a key code and nothing
   * else, which is not what a user's Enter does.
   */
  async press(key, code, { modifiers = 0, text } = {}) {
    for (const type of ["rawKeyDown", "keyUp"]) {
      const params = { type, key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
      if (text && type === "rawKeyDown") { params.type = "keyDown"; params.text = text; params.unmodifiedText = text; }
      await this.send("Input.dispatchKeyEvent", params);
    }
  }
  /**
   * Hold matching requests at the network layer instead of letting them through.
   *
   * This reproduces a *stalled* chunk: the request neither completes nor fails,
   * which is the failure `Suspense` cannot report and an error boundary never
   * sees.
   */
  async holdRequests(pattern) {
    this.hold = true;
    this.held = [];
    await this.send("Fetch.enable", {
      patterns: [{ urlPattern: pattern, requestStage: "Request" }],
    });
  }
  async releaseHeld() {
    this.hold = false;
    const held = this.held;
    this.held = [];
    for (const requestId of held) {
      await this.send("Fetch.continueRequest", { requestId }).catch(() => {});
    }
    await this.send("Fetch.disable").catch(() => {});
    return held.length;
  }
  /** Written to disk so a layout can be looked at, not just asserted on. */
  async screenshot(name) {
    const shot = await this.send("Page.captureScreenshot", { format: "png" });
    mkdirSync(SHOT_DIR, { recursive: true });
    writeFileSync(`${SHOT_DIR}/${name}.png`, Buffer.from(shot.data, "base64"));
  }
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/**
 * The file's text as the editor has it on screen.
 *
 * Read per line, with two rendering details removed, because reading the whole
 * container's `innerText` gets both wrong:
 *
 *  * Monaco renders a space as `&nbsp;`, so the text comes back with U+00A0
 *    where the file has U+0020.
 *  * Monaco draws suggestions *into the view lines* — the inline preview of the
 *    selected completion (`suggest.preview` is on here, and it renders as
 *    `.ghost-text-decoration`) and any ghost text. A buffer of `x\ny` reads back
 *    as `x\nyield`, and the assertion then fails on a word the file never held.
 *    Matched on substring because Monaco names these spans more than one way.
 */
const editorText = (s) =>
  s.eval(`(() => {
    const lines = [...document.querySelectorAll('.monaco-editor .view-lines .view-line')];
    return lines.map((line) => {
      const copy = line.cloneNode(true);
      copy.querySelectorAll(
        '[class*="ghost"], [class*="suggest-preview"], [class*="inline-suggestions"], .codicon, .monaco-reserved-space'
      ).forEach((node) => node.remove());
      return (copy.textContent || '').replace(/\\u00a0/g, ' ');
    }).join('\\n');
  })()`);
const readClipboard = (s) => s.eval("navigator.clipboard.readText()");
const writeClipboard = (s, text) =>
  s.eval(`navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => true)`);
const inlinePromptOpen = (s) =>
  s.eval(`Boolean(document.querySelector('input[placeholder^="Describe changes or ask AI"]'))`);
/** What the engine will answer next, injected as data rather than as source. */
const setAi = (s, key, value) => s.eval(`(window.__ai.${key} = ${JSON.stringify(value)}, true)`);
/** Any element whose text matches, so a class rename cannot break the check. */
const textMatching = (s, pattern) =>
  s.eval(`(() => {
    const wanted = ${pattern};
    const nodes = [...document.querySelectorAll('div, span, p')]
      .filter((node) => wanted.test(node.textContent || ''));
    const leaf = nodes[nodes.length - 1];
    return leaf ? (leaf.textContent || '').trim() : null;
  })()`);
const reviewState = (s) =>
  s.eval(`({
    cards: document.querySelectorAll('.acsa-review-card').length,
    warningLines: document.querySelectorAll('.acsa-review-line-warning').length,
    infoLines: document.querySelectorAll('.acsa-review-line-info').length,
  })`);
/**
 * A point on a finding's overlay *outside* the card itself.
 *
 * This is the surface that matters: the wrapper spans the zone so a card can be
 * positioned at its line, the card re-enables pointer events for its own
 * buttons, and everything else on that wrapper has to let a click through to the
 * code. Clicking somewhere the overlay does not reach proves nothing.
 */
const overlaySurfacePoint = (s) =>
  s.eval(`(() => {
    const cards = [...document.querySelectorAll('.acsa-review-card')].map((c) => c.getBoundingClientRect());
    for (const wrap of document.querySelectorAll('.acsa-review-card-wrap')) {
      const box = wrap.getBoundingClientRect();
      for (let y = box.top + 1; y < box.bottom; y += 2) {
        for (let x = box.left + 1; x < box.right; x += 4) {
          const onCard = cards.some((c) => x >= c.left && x <= c.right && y >= c.top && y <= c.bottom);
          if (!onCard) return { x: Math.round(x), y: Math.round(y) };
        }
      }
    }
    return null;
  })()`);
const overlayPointerEvents = (s) =>
  s.eval(`(() => {
    const zone = document.querySelector('.acsa-review-zone');
    const wrap = document.querySelector('.acsa-review-card-wrap');
    const card = document.querySelector('.acsa-review-card');
    return {
      zone: zone ? getComputedStyle(zone).pointerEvents : null,
      wrapper: wrap ? getComputedStyle(wrap).pointerEvents : null,
      card: card ? getComputedStyle(card).pointerEvents : null,
    };
  })()`);
/**
 * Is the code *visible*, or merely present?
 *
 * Every other assertion here reads text out of the DOM, and DOM text survives
 * being laid out at zero size, made transparent, or painted in the background
 * colour — so on its own it cannot tell "the file is on screen" from "the file
 * is there but you cannot see it". This is the one check that looks at layout
 * and colour instead of content.
 */
const editorInk = (s) =>
  s.eval(`(() => {
    const lines = [...document.querySelectorAll('.monaco-editor .view-line')];
    const laidOut = lines.filter((line) => {
      const r = line.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).length;
    const span = document.querySelector('.monaco-editor .view-line span');
    const style = span ? getComputedStyle(span) : null;
    const surface = document.querySelector('.monaco-editor');
    const background = surface ? getComputedStyle(surface).backgroundColor : null;
    return {
      lines: lines.length,
      laidOut,
      color: style ? style.color : null,
      opacity: style ? style.opacity : null,
      visibility: style ? style.visibility : null,
      background,
      firstLine: lines[0] ? (lines[0].textContent || '').slice(0, 12) : null,
    };
  })()`);
const inputState = (s) => s.eval(`(() => {
  const t = document.querySelector('.monaco-editor textarea');
  return t ? { readOnly: t.readOnly, active: document.activeElement === t, start: t.selectionStart } : null;
})()`);

/**
 * Open the probe file and put the caret in it, the way a user does.
 *
 * `waitForEditor: false` is for when the editor is deliberately not going to
 * arrive — waiting for it there would hang the run instead of the surface.
 */
async function openFileAndFocus(session, { waitForEditor = true } = {}) {
  for (let i = 0; i < 60; i++) {
    const ready = await session
      .eval(`Boolean([...document.querySelectorAll('[role="treeitem"]')].find((n) => /probe\\.ts/.test(n.textContent || '')))`)
      .catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  await session.eval(`[...document.querySelectorAll('[role="treeitem"]')].find((n) => /probe\\.ts/.test(n.textContent || '')).click()`);
  if (!waitForEditor) return null;
  for (let i = 0; i < 60; i++) {
    const ready = await session.eval(`Boolean(document.querySelector('.monaco-editor .view-lines'))`).catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  await sleep(700);
  const point = await session.eval(`(() => {
    const el = document.querySelector('.monaco-editor .view-lines');
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + 30), y: Math.round(r.top + 8) };
  })()`);
  await session.click(point.x, point.y);
  await sleep(400);
  return point;
}

if (SERVE_DIST) {
  // Build from the tree in front of us. Serving whatever `dist/` happens to
  // hold makes a stale bundle's behaviour look like this commit's — which cost
  // a confusing round of "why does the fix not work in the built app".
  const build = spawnSync("npm", ["run", "build"], { stdio: "inherit" });
  if (build.status !== 0) {
    console.error("editor-app-check: the build failed, so there is nothing to check");
    process.exit(1);
  }
}

children.push(
  SERVE_DIST
    ? spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" })
    : spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: "ignore" })
);
await waitFor(APP, "vite");

children.push(spawn(chrome, [
  "--headless=new", `--remote-debugging-port=${CDP_PORT}`, "--remote-debugging-address=127.0.0.1",
  "--user-data-dir=/tmp/acsa-editor-app-check/chrome-profile", "--window-size=1440,900",
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
], { stdio: "ignore" }));
await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`, "chrome");

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const session = new Session(ws);
await session.send("Page.enable");
await session.send("Runtime.enable");
await session.send("Log.enable");
// Hermetic: this app's editor asks a model for inline completions, and a real
// Ollama (or a cloud key) on this machine answers it. Ghost text then lands in
// `.view-lines` and the assertions read the suggestion instead of the file —
// observed as `helloHello! How can I assist you today?`. Only the harness's own
// origin is allowed through.
await session.send("Network.enable");
await session.send("Network.setBlockedURLs", {
  urls: [
    "*://localhost:*/*",
    "*://127.0.0.1:11434/*",
    "*://127.0.0.1:1234/*",
    "*://127.0.0.1:8080/*",
    "https://*/*",
  ],
});
await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
// Without this the page cannot read or write the clipboard, and copy/paste are
// untestable rather than broken.
await session
  .send("Browser.grantPermissions", {
    origin: `http://127.0.0.1:${PORT}`,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  })
  .catch(() => {});
await session.send("Page.addScriptToEvaluateOnNewDocument", { source: TAURI_STUB });
await session.send("Page.addScriptToEvaluateOnNewDocument", { source: FOCUS_LOGGER });
await session.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await session.send("Page.navigate", { url: APP });

// ── The empty editor, before anything is open ────────────────────────────
// One panel, with the project's commands in it and the shortcuts under one
// divider — the merge, in the state a user actually lands on.
const emptyState = async () => {
  for (let i = 0; i < 24; i++) {
    const state = await session.eval(`(() => {
      const panel = document.querySelector('[data-testid="watermark-actions"]');
      if (!panel) return null;
      return {
        panels: document.querySelectorAll('[data-testid="watermark-actions"]').length,
        rows: [...panel.querySelectorAll('button')].map((b) => {
          const span = b.querySelector('span');
          return span ? (span.textContent || '').trim() : '';
        }),
        dividers: panel.querySelectorAll('div.h-px').length,
      };
    })()`);
    if (state && state.rows.length >= 5) return state;
    await sleep(500);
  }
  return null;
};

const empty = await emptyState();
check("the empty editor is one panel, holding the project's commands and the shortcuts",
  empty && empty.panels === 1 && empty.dividers === 1 &&
    ["Run dev server", "Build", "Search files", "Command palette", "Ask the assistant"].every((label) =>
      empty.rows.includes(label)),
  empty ? JSON.stringify(empty) : "the empty-state panel never appeared");
await session.screenshot("empty-editor");

const point = await openFileAndFocus(session);
console.log(`  clicking into line 1 at ${point.x},${point.y}`);
console.log("  editor shows:", JSON.stringify(await editorText(session)));

const focused = await inputState(session);
check("clicking the code focuses the editor's input", Boolean(focused && focused.active && !focused.readOnly), JSON.stringify(focused));

const ink = await editorInk(session);
check("the code is laid out and painted, not merely in the DOM",
  ink.lines >= 2 && ink.laidOut === ink.lines && ink.opacity === "1" &&
    ink.visibility === "visible" && Boolean(ink.color) && ink.color !== ink.background,
  JSON.stringify(ink));

// One character, with a stack for every focus change it causes. This is where
// "one keystroke per focus" is either explained or is not happening.
await session.eval("window.__focusLog.length = 0");
await session.char("h");
await sleep(500);
console.log(`  after one 'h': text=${JSON.stringify(await editorText(session))} ${JSON.stringify(await inputState(session))}`);
for (const entry of await session.eval("window.__focusLog")) {
  console.log(`    ${entry.type} target=${entry.target} now=${entry.now}`);
  if (entry.type === "focusout") console.log(`      ${entry.stack}`);
}

// Back to a clean slate for the real assertions.
await session.send("Page.navigate", { url: APP });
await sleep(1500);
const point2 = await openFileAndFocus(session);
check("the editor is focused with its input writable", Boolean(await inputState(session).then((s) => s && s.active && !s.readOnly)), JSON.stringify(await inputState(session)));

await session.type("hello");
await sleep(700);
const afterBurst = await editorText(session);
console.log("  after a burst of 'hello':", JSON.stringify(afterBurst));
check("all five characters of one burst land", afterBurst.includes("hello"), JSON.stringify(afterBurst));

// A second focus and one more character: the caret must survive the refocus.
await session.click(point2.x, point2.y);
await sleep(300);
await session.type("Z");
await sleep(600);
const afterRefocus = await editorText(session);
console.log("  after click + 'Z':", JSON.stringify(afterRefocus));
check("a character after a refocus still lands", afterRefocus.includes("Z"), JSON.stringify(afterRefocus));

// Undo has to take that one character back.
await session.chord("z", 90);
await sleep(600);
const afterUndo = await editorText(session);
console.log("  after Cmd+Z:", JSON.stringify(afterUndo));
check("Cmd+Z undoes the last character", !afterUndo.includes("Z") && afterUndo.includes("hello"), JSON.stringify(afterUndo));

// Typing is only half of "can I edit this file by hand": the keys that are not
// characters have to reach the editor too. Tab is the one the user called out —
// with focus on the body it moved to the Review button instead of indenting.
await session.chord("a", 65);
await session.press("ArrowLeft", 37);
await session.press("Tab", 9);
await sleep(400);
const afterTab = await editorText(session);
const tabFocus = await inputState(session);
const tabIndented = /^[ \t]+a\{hello/.test(afterTab);
const tabKeptFocus = Boolean(tabFocus?.active);
check("Tab indents in the editor instead of leaving it",
  tabIndented && tabKeptFocus,
  `indented=${tabIndented} focused=${tabKeptFocus} text=${JSON.stringify(afterTab)}`);

// Enter and backspace, asserted against a document typed from scratch: where
// the caret sits after a select-all has to be constructed, not guessed.
await session.chord("a", 65);
await session.type("x");
await sleep(700);
// Typing a letter opens the suggest widget, and Enter accepts the highlighted
// suggestion rather than adding a line — which is what the editor should do, and
// is why the widget has to be dismissed before this test means anything. Left
// in, the assertion caught `XMLDocumenty`: Enter had completed `x`.
await session.press("Escape", 27);
await sleep(300);
await session.press("Enter", 13, { text: "\r" });
await sleep(300);
await session.type("y");
await sleep(400);
const afterEnter = await editorText(session);
if (process.env.DUMP_DOM) {
  console.log("  view-lines html:", await session.eval(
    `(document.querySelector('.monaco-editor .view-lines') || {}).innerHTML || ''`));
  console.log("  classes inside:", await session.eval(
    `[...new Set([...document.querySelectorAll('.monaco-editor .view-lines *')].map((n) => String(n.className)))].join(' | ')`));
}
check("Enter opens a new line and the next text lands on it",
  afterEnter === "x\ny", JSON.stringify(afterEnter));

await session.press("Backspace", 8);
await session.press("Backspace", 8);
await sleep(400);
const afterBackspace = await editorText(session);
check("Backspace deletes inside the editor", afterBackspace === "x", JSON.stringify(afterBackspace));

// The caret has to follow the arrow keys, not stay pinned. Asserted after each
// press: left then right would land back where it started and prove nothing.
const beforeArrow = (await inputState(session)).start;
await session.press("ArrowLeft", 37);
await sleep(250);
const afterLeft = await inputState(session);
await session.press("ArrowRight", 39);
await sleep(250);
const afterRight = await inputState(session);
check("arrow keys move the caret and focus stays put",
  Boolean(afterLeft?.active) && afterLeft.start === beforeArrow - 1 && afterRight.start === beforeArrow,
  `${beforeArrow} -> ${afterLeft?.start} -> ${afterRight?.start} focused=${afterLeft?.active}`);

// ── Clipboard ────────────────────────────────────────────────────────────
// Rebuilt from scratch so the caret position is constructed, not guessed.
await session.chord("a", 65);
await session.type("hello");
await sleep(400);
check("select-all then typing replaces the buffer",
  (await editorText(session)) === "hello", JSON.stringify(await editorText(session)));

await session.chord("a", 65);
await session.copy();
await sleep(500);
const copied = await readClipboard(session);
check("Cmd+C copies the file without changing it",
  copied === "hello" && (await editorText(session)) === "hello",
  `clipboard=${JSON.stringify(copied)} text=${JSON.stringify(await editorText(session))}`);

await session.chord("a", 65);
await session.cut();
await sleep(500);
const afterCut = await editorText(session);
const cutClipboard = await readClipboard(session);
check("Cmd+X cuts the selection into the clipboard",
  afterCut === "" && cutClipboard === "hello",
  `text=${JSON.stringify(afterCut)} clipboard=${JSON.stringify(cutClipboard)}`);

await session.chord("z", 90);
await sleep(500);
check("a cut is one undo", (await editorText(session)) === "hello", JSON.stringify(await editorText(session)));

await writeClipboard(session, "PASTED");
await session.press("End", 35);
await session.paste();
await sleep(600);
const afterPaste = await editorText(session);
check("Cmd+V pastes at the caret", afterPaste === "helloPASTED", JSON.stringify(afterPaste));

await session.chord("z", 90);
await sleep(500);
check("a paste is one undo", (await editorText(session)) === "hello", JSON.stringify(await editorText(session)));

// ── Save ─────────────────────────────────────────────────────────────────
await session.chord("s", 83);
await sleep(700);
const writes = await session.eval("window.__writes");
const lastWrite = writes[writes.length - 1];
check("Cmd+S writes the buffer to the host",
  Boolean(lastWrite) && lastWrite.content === "hello",
  JSON.stringify(writes.map((w) => ({ path: w.filePath, len: (w.content || "").length }))));

// ── The Cmd+K prompt, and getting back out of it ─────────────────────────
// Reported as "Cmd+K opens it and there is no way to close it".
await session.chord("k", 75);
await sleep(500);
const openedByChord = await inlinePromptOpen(session);
check("Cmd+K opens the inline edit prompt", openedByChord, `open=${openedByChord}`);

await session.press("Escape", 27);
await sleep(500);
const closedByEscape = !(await inlinePromptOpen(session));
const focusedAfterEscape = await inputState(session);
check("Escape closes it and hands focus back to the editor",
  closedByEscape && Boolean(focusedAfterEscape?.active),
  `closed=${closedByEscape} focused=${focusedAfterEscape?.active}`);

await session.chord("k", 75);
await sleep(500);
const reopened = await inlinePromptOpen(session);
const clickedCancel = await session.eval(`(() => {
  const button = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Cancel');
  if (button) button.click();
  return Boolean(button);
})()`);
await sleep(500);
const closedByCancel = !(await inlinePromptOpen(session));
const focusedAfterCancel = await inputState(session);
check("Cancel closes it too, and does not leave the editor behind",
  reopened && clickedCancel && closedByCancel && Boolean(focusedAfterCancel?.active),
  `reopened=${reopened} clicked=${clickedCancel} closed=${closedByCancel} focused=${focusedAfterCancel?.active}`);

// ── Review ───────────────────────────────────────────────────────────────
// The engine answers, not a model: what is under test is how the editor handles
// findings, not which model produced them.
await setAi(session, "review", {
  ok: true,
  provider: "ollama",
  model: "stub-reviewer",
  issues: [
    { line: 1, severity: "warning", title: "Stub finding one", detail: "The first detail.", suggestion: "Try this instead." },
    { line: 3, severity: "info", title: "Stub finding two", detail: "The second detail." },
  ],
});

// A three-line file for the findings to land on.
await session.chord("a", 65);
await session.press("Backspace", 8);
await session.press("Escape", 27);
for (const [index, line] of ["aa", "bb", "cc"].entries()) {
  await session.type(line);
  // Typing opens the suggest widget, and a stray Enter would accept from it.
  await session.press("Escape", 27);
  if (index < 2) await session.press("Enter", 13, { text: "\r" });
  await session.press("Escape", 27);
}
await sleep(600);
const reviewed = await editorText(session);
check("three lines are in the buffer to review", reviewed === "aa\nbb\ncc", JSON.stringify(reviewed));

const clickedReview = await session.eval(`(() => {
  const button = document.querySelector('button[title^="Review this file"]');
  if (button) button.click();
  return Boolean(button) && !button.disabled;
})()`);
await sleep(1000);
const afterReview = await reviewState(session);
check("Review renders one inline thread per finding",
  clickedReview && afterReview.cards === 2, `clicked=${clickedReview} ${JSON.stringify(afterReview)}`);
check("the reviewed lines are marked in the editor",
  afterReview.warningLines >= 1 && afterReview.infoLines >= 1, JSON.stringify(afterReview));
check("a review does not touch the file",
  (await editorText(session)) === "aa\nbb\ncc", JSON.stringify(await editorText(session)));

// The findings overlay the editor. When clicks landed on that overlay instead of
// the code, the file could not be edited for as long as a finding existed.
const overlay = await overlayPointerEvents(session);
check("the finding overlay is transparent to clicks and its card is not",
  overlay.zone === "none" && overlay.wrapper === "none" && overlay.card === "auto",
  JSON.stringify(overlay));

const overlayPoint = await overlaySurfacePoint(session);
if (overlayPoint) {
  await session.click(overlayPoint.x, overlayPoint.y);
  await sleep(400);
}
const clickThrough = await inputState(session);
const hitAt = overlayPoint
  ? await session.eval(`(() => {
      const el = document.elementFromPoint(${overlayPoint.x}, ${overlayPoint.y});
      if (!el) return null;
      const cls = String(el.className || '').split(/\\s+/).filter(Boolean).slice(0, 3).join('.');
      return { tag: el.tagName, cls, insideViewLines: Boolean(el.closest('.view-lines')) };
    })()`)
  : null;
check("a click inside a finding's band reaches the code, not the overlay",
  Boolean(overlayPoint) && hitAt?.insideViewLines === true,
  `point=${JSON.stringify(overlayPoint)} hit=${JSON.stringify(hitAt)}`);

// ...and the card's own controls still work, which is the other half of the
// trade: the overlay is transparent, the card is not.
const cardHit = await session.eval(`(() => {
  const card = document.querySelector('.acsa-review-card');
  const button = card && card.querySelector('button');
  if (!button) return { buttons: card ? card.querySelectorAll('button').length : 0 };
  const box = button.getBoundingClientRect();
  const hit = document.elementFromPoint(Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2));
  return {
    buttons: card.querySelectorAll('button').length,
    hitInsideCard: Boolean(hit && hit.closest('.acsa-review-card')),
  };
})()`);
check("the finding card's own controls are still reachable",
  cardHit.buttons > 0 && cardHit.hitInsideCard === true, JSON.stringify(cardHit));

// An answer the editor cannot use must be reported, not written into the file.
await setAi(session, "review", { ok: true, issues: [], warning: "The reply was not a findings list." });
await session.eval(`document.querySelector('button[title^="Review this file"]').click()`);
await sleep(1000);
const warningText = await textMatching(session, "/not a findings list/");
check("an unusable review answer is reported and the file is untouched",
  Boolean(warningText) && (await editorText(session)) === "aa\nbb\ncc",
  `error=${JSON.stringify(warningText)} text=${JSON.stringify(await editorText(session))}`);

// ── Inline edit ──────────────────────────────────────────────────────────
// A fenced answer is the shape that used to be written into the file whole —
// the reported "review broke my entire code file".
await setAi(session, "inline", { ok: true, replacement: "```ts\nconst boom = 1;\n```" });
await session.chord("a", 65);
await session.chord("k", 75);
await sleep(500);
await session.type("replace this");
await session.press("Enter", 13, { text: "\r" });
await sleep(900);
const refusedText = await editorText(session);
const refusal = await textMatching(session, "/code fence/i");
check("a fenced answer is refused and the file is untouched",
  refusedText === "aa\nbb\ncc" && Boolean(refusal),
  `error=${JSON.stringify(refusal)} text=${JSON.stringify(refusedText)}`);

// And a usable answer is applied to the selection, closing the prompt.
await session.press("Escape", 27);
await sleep(300);
await setAi(session, "inline", { ok: true, replacement: "REPLACED" });
await session.chord("a", 65);
await session.chord("k", 75);
await sleep(500);
await session.chord("a", 65);
await session.press("Backspace", 8);
await session.type("replace this");
await session.press("Enter", 13, { text: "\r" });
await sleep(900);
const applied = await editorText(session);
const promptClosed = !(await inlinePromptOpen(session));
const focusAfterApply = await inputState(session);
check("an accepted answer replaces the selection, closes the prompt and refocuses the editor",
  applied === "REPLACED" && promptClosed && Boolean(focusAfterApply?.active),
  `text=${JSON.stringify(applied)} closed=${promptClosed} focused=${focusAfterApply?.active}`);

await session.chord("z", 90);
await sleep(600);
check("an applied inline edit is one undo",
  (await editorText(session)) === "aa\nbb\ncc", JSON.stringify(await editorText(session)));

// ── The repository page ──────────────────────────────────────────────────
// Layout, in order: the commit box, then the changes it is about, then the
// history. The box at the *bottom* of the panel was the thing you had to scroll
// to find, and the graph is what the page was missing.
await session.eval(`document.querySelector('[data-testid="nav-item-git"]').click()`);
await sleep(1500);
const repo = await session.eval(`(() => {
  const box = document.querySelector('[data-testid="git-commit-message"]');
  const changes = document.querySelector('[data-testid="git-changes"]');
  const graph = document.querySelector('[data-testid="git-graph"]');
  const rows = [...document.querySelectorAll('[data-testid^="git-graph-row-"]')];
  if (!box || !changes || !graph) {
    // Say what *is* on screen instead. A missing panel is usually a screen that
    // never switched, and the test ids are the quickest way to see that.
    return {
      found: { box: Boolean(box), changes: Boolean(changes), graph: Boolean(graph) },
      onScreen: {
        back: Boolean(document.querySelector('[aria-label="Back to the editor"]')),
        testids: [...document.querySelectorAll('[data-testid]')]
          .map((node) => node.getAttribute('data-testid')).slice(0, 24),
        text: (document.body.innerText || '').slice(0, 160),
      },
    };
  }
  const top = (el) => Math.round(el.getBoundingClientRect().top);
  const widths = rows.map((row) => Math.round(row.querySelector('svg')?.width?.baseVal?.value ?? 0));
  return {
    found: { box: true, changes: true, graph: true },
    order: [top(box), top(changes), top(graph)],
    rows: rows.length,
    widestRow: widths.length ? Math.max(...widths) : 0,
    graphText: graph.textContent || "",
  };
})()`);
check("the repository page puts the commit box above the changes and the graph below",
  Boolean(repo.order) && repo.order[0] < repo.order[1] && repo.order[1] < repo.order[2],
  JSON.stringify(repo.order ?? repo.onScreen ?? repo.found));
check("the history is drawn as lanes, not a list",
  // Two lanes' worth of pitch: the merge has to widen the graph past one line.
  repo.rows === 5 && repo.widestRow >= 2 * 11,
  `rows=${repo.rows} widest=${repo.widestRow}px`);
check("its refs are badged onto the commits they point at",
  /dev/.test(repo.graphText ?? "") && /v0\.2\.0/.test(repo.graphText ?? "") && /main/.test(repo.graphText ?? ""),
  JSON.stringify((repo.graphText ?? "").slice(0, 120)));
await session.screenshot("repository-page");

// ── A surface that never arrives ─────────────────────────────────────────
// `Suspense` reports nothing when a chunk stalls rather than fails: no error, no
// timeout, nothing to click, and the surface stays "loading" forever. That is
// what the packaged app did with the editor. Hold the chunk at the network layer
// and check the app says so — then that it can get out.
const stallNoteShown = async (s) => {
  for (let i = 0; i < 30; i++) {
    const state = await s.eval(`(() => {
      const note = document.querySelector('[data-testid="surface-stalled"]');
      return {
        note: Boolean(note),
        text: note ? (note.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90) : null,
        reload: Boolean(document.querySelector('[data-testid="surface-reload"]')),
      };
    })()`);
    if (state.note) return state;
    await sleep(500);
  }
  return { note: false };
};

await session.holdRequests("*MonacoEditorContainer*");
await session.send("Page.navigate", { url: APP });
await sleep(1500);
await openFileAndFocus(session, { waitForEditor: false });
const stalled = await stallNoteShown(session);
check("a stalled surface says so instead of loading forever",
  stalled.note === true && stalled.reload === true,
  JSON.stringify(stalled));

// The note accompanies the load rather than replacing it: let the chunk through
// and the surface arrives on its own, with nothing for the user to do.
const released = await session.releaseHeld();
await sleep(3000);
const recoveredText = await editorText(session);
const noteCleared = await session.eval(`!document.querySelector('[data-testid="surface-stalled"]')`);
check("the note does not block the load — the surface arrives once the chunk does",
  stalled.note === true && released > 0 && noteCleared === true && recoveredText.includes("a{"),
  `shown=${stalled.note} released=${released} cleared=${noteCleared} text=${JSON.stringify(recoveredText)}`);

check("no uncaught errors in the console", session.errors.length === 0, session.errors.slice(0, 4).join(" || "));
if (process.env.DUMP_CALLS) {
  console.log("\ncalls:", JSON.stringify(await session.eval("window.__engineCalls")));
  console.log("getIndexStatus ->", await session.eval(
    `(async () => { const m = await import('/src/services/agentHarness.ts'); return JSON.stringify(await m.getIndexStatus('/probe')); })()`
  ));
}

ws.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\neditor-app-check: ${results.length - failed}/${results.length} passed`);
cleanup();
process.exit(failed === 0 ? 0 : 1);
