/**
 * make-og.mjs — render og.html to public/og.png at 1200x630.
 *
 * Social platforms want a raster card, and a checked-in drawing would drift from the
 * headline it quotes. So the card is a page, and this is the press: run it when the
 * headline or the tokens change, and commit the PNG it writes.
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4188;
const CDP = 9457;
const ROOT = "/Users/adetoyeadewoye/Desktop/work/acsa-code/site";
const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find((path) => existsSync(path));

if (!CHROME) {
  console.error("make-og: no Chrome found.");
  process.exit(1);
}

const children = [];
const stop = () => { for (const child of children) { try { child.kill("SIGTERM"); } catch { /* gone */ } } };
process.on("exit", stop);

children.push(spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" }));
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/og.html`)).ok) break; } catch { /* not up */ } await sleep(400); }

children.push(spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP}`, "--remote-debugging-address=127.0.0.1",
  "--user-data-dir=/tmp/acsa-og-profile", "--hide-scrollbars", "--no-first-run",
  "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore" }));
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch { /* not up */ } await sleep(400); }

const target = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/og.html`)}`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = (message) => {
  const msg = JSON.parse(message.data);
  if (!msg.id) return;
  const p = pending.get(msg.id);
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false });
await sleep(1500); // fonts and the two SVG marks

const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
writeFileSync(`${ROOT}/public/og.png`, Buffer.from(shot.data, "base64"));
console.log("wrote public/og.png");
stop();
process.exit(0);
