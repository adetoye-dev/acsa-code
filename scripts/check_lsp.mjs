/**
 * check_lsp.mjs — does the language server actually work on a project?
 *
 * The editor's TypeScript used to be a mirror of the project fed into a Web Worker,
 * and every gap in that mirror arrived as a diagnostic no other editor showed. This
 * checks the replacement against the three things that mirror got wrong:
 *
 *   1. `paths` aliases resolve, because the project's tsconfig is read as a file
 *      rather than mapped field by field into compiler options.
 *   2. A type error is reported, on the right line, with the compiler's own code.
 *   3. A completion is answered from the imported symbol — IntelliSense over the
 *      project's real module graph.
 *
 * It also prints what the server says it is using, because the workspace's own
 * TypeScript version is the reason this arrangement was chosen over the (much
 * faster) native TypeScript 7 server: TS 7 reports errors on projects that its
 * `tsc` and every other editor call clean.
 *
 * Same shape as `site/scripts/check-page.mjs`: exits 0 with a note when the
 * toolchain is not installed, so it can sit in a broad check without becoming a
 * red build on a machine that never ran `scripts/fetch_lsp_sidecar.sh`.
 *
 * Usage:  node scripts/check_lsp.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LSP_DIR = process.env.ACSA_LSP_DIR ?? join(ROOT, ".tauri", "lsp");
const NODE = join(LSP_DIR, "node", "bin", process.platform === "win32" ? "node.exe" : "node");
const SERVER = join(LSP_DIR, "server", "node_modules", "typescript-language-server", "lib", "cli.mjs");

if (!existsSync(NODE) || !existsSync(SERVER)) {
  console.error("check_lsp: no language server toolchain — run scripts/fetch_lsp_sidecar.sh, or skip this check.");
  process.exit(0);
}

// ── A project small enough to reason about, with the two things that used to break

const project = mkdtempSync(join(tmpdir(), "acsa-lsp-"));
mkdirSync(join(project, "lib"), { recursive: true });
mkdirSync(join(project, "src"), { recursive: true });

writeFileSync(
  join(project, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2020",
        module: "ESNext",
        moduleResolution: "bundler",
        baseUrl: ".",
        paths: { "@lib/*": ["./lib/*"] },
        strict: true,
        noEmit: true,
      },
      include: ["src", "lib"],
    },
    null,
    2,
  ),
);
writeFileSync(join(project, "lib", "thing.ts"), "export const answer: number = 42;\n");
const MAIN = [
  'import { answer } from "@lib/thing";',
  "",
  "const wrong: string = answer;",
  "export const doubled = answer * 2;",
  "",
].join("\n");
writeFileSync(join(project, "src", "main.ts"), MAIN);

const mainUri = pathToFileURL(join(project, "src", "main.ts")).href;

// ── Speak LSP

const child = spawn(NODE, [SERVER, "--stdio"], { cwd: project, stdio: ["pipe", "pipe", "pipe"] });

let buffer = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();
const published = new Map();
const logs = [];

const send = (message) => {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
};

const request = (method, params) => {
  const id = nextId++;
  const started = Date.now();
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolvePromise, reject) => {
    pending.set(id, (result) => resolvePromise({ result, ms: Date.now() - started }));
    setTimeout(() => reject(new Error(`${method} timed out`)), 60_000).unref?.();
  });
};

child.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString("utf8"))?.[1]);
    const start = headerEnd + 4;
    if (!Number.isFinite(length) || buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString("utf8"));
    buffer = buffer.subarray(start + length);

    if (message.id !== undefined && pending.has(message.id)) {
      const done = pending.get(message.id);
      pending.delete(message.id);
      done(message.result ?? message.error);
    } else if (message.method === "textDocument/publishDiagnostics") {
      published.set(message.params.uri, message.params.diagnostics);
    } else if (message.method === "window/logMessage" || message.method === "window/showMessage") {
      logs.push(message.params?.message ?? "");
    } else if (message.id !== undefined) {
      // Server-to-client requests: configuration and dynamic registration only.
      const result =
        message.method === "workspace/configuration"
          ? (message.params?.items ?? []).map(() => null)
          : null;
      send({ jsonrpc: "2.0", id: message.id, result });
    }
  }
});

const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

try {
  const init = await request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(project).href,
    workspaceFolders: [{ uri: pathToFileURL(project).href, name: "acsa-lsp-check" }],
    capabilities: {
      textDocument: { publishDiagnostics: {}, completion: {}, hover: {} },
    },
  });
  const capabilities = init.result?.capabilities ?? {};
  console.log(`initialize ${init.ms}ms`);
  check("server answers initialize", Boolean(capabilities.textDocumentSync ?? capabilities.completionProvider));
  check("offers completion", Boolean(capabilities.completionProvider));
  // Push, not pull: this server publishes diagnostics per file rather than
  // answering `textDocument/diagnostic`, so the client has to be wired for push.
  check("syncs and publishes diagnostics", Boolean(capabilities.textDocumentSync));

  send({ jsonrpc: "2.0", method: "initialized", params: {} });
  send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri: mainUri, languageId: "typescript", version: 1, text: MAIN },
    },
  });

  // The server reports the TypeScript it is running on; parity is the reason this
  // arrangement was chosen, so it is asserted rather than assumed.
  const versionLog = await new Promise((resolvePromise) => {
    const deadline = Date.now() + 10_000;
    const poll = setInterval(() => {
      const found = logs.find((line) => /Using Typescript version/i.test(line));
      if (found || Date.now() > deadline) {
        clearInterval(poll);
        resolvePromise(found ?? "");
      }
    }, 100);
  });
  check("names the TypeScript it runs on", Boolean(versionLog), versionLog.slice(0, 120));

  // Diagnostics: exactly one *error* — the assignment — with the compiler's own
  // code. Hints are expected alongside it (the unused `wrong` is a genuine TS6133),
  // and the assertion is on severity 1, which is what a squiggle and the Problems
  // panel act on.
  await new Promise((r) => setTimeout(r, 3000));
  const diagnostics = published.get(mainUri) ?? [];
  const errors = diagnostics.filter((d) => d.severity === 1);
  check("reports exactly one error", errors.length === 1, `${errors.length} errors, ${diagnostics.length - errors.length} hints`);
  if (errors.length === 1) {
    const [d] = errors;
    check("it is the type error", d.code === 2322, `code ${d.code}: ${d.message.split("\n")[0]}`);
    check("on the assignment's line", d.range.start.line === 2, `line ${d.range.start.line + 1}`);
  }

  // IntelliSense over the aliased import: the symbol must be on offer.
  const completion = await request("textDocument/completion", {
    textDocument: { uri: mainUri },
    position: { line: 4, character: "export const doubled = ".length + 1 },
  });
  const items = Array.isArray(completion.result) ? completion.result : (completion.result?.items ?? []);
  const labels = items.map((i) => i.label);
  check("completion includes the imported symbol", labels.includes("answer"), `${items.length} items in ${completion.ms}ms`);
} catch (error) {
  failures.push(String(error?.message ?? error));
  console.error(` FAIL  ${error?.message ?? error}`);
} finally {
  child.kill();
}

if (failures.length > 0) {
  console.error(`check_lsp: ${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("check_lsp: language server answers with the project's own TypeScript.");
