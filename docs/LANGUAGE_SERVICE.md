# The editor's language service

What answers "is this code correct?" in the editor, why it is a language server
rather than anything we wrote, and how it is versioned.

## What was wrong before

Monaco bundles a TypeScript compiled into a Web Worker. A worker has no
filesystem, so an import can only resolve against files that have been handed to
it, and this app built that mirror by hand: `src/services/monacoProjectFiles.ts`,
~950 lines, with budgets (1,500 files, 8 MB, 250 packages, 12 subpaths each) and a
tsconfig mapped field by field into compiler options.

Every gap in that mirror became a diagnostic no other editor shows, and the fixes
were per-symptom. The record is in the git history and in the code comments: path
aliases, `.d.mts` declarations, the JSX runtime, package imports, and a suppression
list (`DIAGNOSTIC_CODES_TO_IGNORE = [2307, 2792]`) that hides a genuinely misspelled
import along with the noise. The decisive evidence was simply that this repository
passes `tsc --noEmit` while the editor painted errors on files VS Code and
Antigravity show clean.

## What it is now

The standard arrangement, the one VS Code uses: **`tsserver` (the project's own) in
a child process, spoken to over LSP.** Monaco stays as the surface.

|  | |
|---|---|
| Runtime | Node (pinned, `scripts/fetch_lsp_sidecar.sh` → `.lsp/`, shipped in the bundle) |
| Server | `typescript-language-server` (pinned) |
| TypeScript | **the workspace's**, from `node_modules/typescript` — the bundled copy (6.0.3) is only the fallback |
| Transport | LSP over stdio, spawned by the shell like the engine and Codex |

Measured against this repository (Apple silicon, warm):

| | value |
|---|---|
| `initialize` | 724 ms |
| first diagnostics | 1.9 s |
| completion | 290 ms, 1,014 items |
| what it says it runs on | `Using Typescript version (workspace) 5.9.3 from .../node_modules/typescript/lib/tsserver.js` |

That last line is the point of the whole arrangement: the editor's diagnostics come
from the same compiler the project's `npm run typecheck`, its CI and every other
editor use, so they cannot disagree.

## Why not the native (TypeScript 7) server

TypeScript 7 ships a native compiler with its own LSP server — `tsc --lsp --stdio`,
`serverInfo: typescript-go 7.0.2`. It is dramatically faster, and it is where the
ecosystem is going:

| | TS 7 native | JS `tsserver` |
|---|---|---|
| `initialize` | **43 ms** | 724 ms |
| first diagnostics | **131 ms** | 1.9 s |
| completion | 246 ms, 9,222 items | 290 ms, 1,014 items |
| runtime needed | none | Node |
| agrees with this project's `tsc` | **no** | **yes** |

It does not agree, and that is not a preference — it is measured. On this
repository, with its tsconfig unchanged:

| | `@types/node` files in the program | errors |
|---|---|---|
| `tsc` 5.9.3 (the project's, CI's, VS Code's) | 68 | **0** |
| `tsc` 7.0.2 native | **0** | **6** — `node:fs`, `node:fs/promises`, `node:url`, `node:os`, `node:path` unresolved |

Whatever the cause (a gap in 7.0.2's automatic `@types` inclusion, or a change that
wants `"types": ["node"]` written out), shipping it as the editor's compiler today
would recreate exactly the complaint this work exists to end: the editor disagreeing
with the project. Making it agree would mean asking users to change their
`devDependencies` before our editor could be correct, which is the dependency
pointing the wrong way.

The fallback TypeScript is therefore **6.0.3**, the newest line that still ships
`tsserver.js` — 7.x has none, so it has no JS language service to load.

Two further facts make it a *routing* question rather than a version choice:

* `typescript@7`'s npm package **no longer contains `tsserver.js`** — only `lib/tsc`
  (the native entry point) and a new API under `dist/api/`. A project pinning TS 7
  therefore has no workspace language service for the JS server to load.
* The JS server picks up the workspace version automatically, whatever it is.

So the policy, once TS 7 adoption appears:

| workspace TypeScript | server |
|---|---|
| ≤ 6.x | JS `tsserver` at the **workspace** version — parity |
| 7.x (no `tsserver.js`) | TS 7's native server — parity **and** 20–40× faster startup |
| none installed | the bundled JS server + the pinned TypeScript |

## What this removed

`monacoProjectFiles.ts` (953 lines of mirror, with file, byte, package and subpath
budgets), `projectTsConfig.ts` (the tsconfig mapped field by field into compiler
options, including `extends` by package name, which was recorded as a gap), the
`read_file_for_types` and `list_directory` shell commands that existed only to feed
the mirror, and their tests. Thirty-six of this repository's tests were the mirror's
own; they are gone with it, and what replaces them is sixteen tests around the
handshake, the framing and the protocol conversions.

Definition and references are served too, and they needed one thing the other
features did not: `StandaloneCodeEditorService.findModel` returns `null` for any
resource the current editor is not already showing, so Monaco's own go-to-definition
dead-ends on a file that is not open. `monaco.editor.registerEditorOpener` is the
handover for exactly that — Monaco calls it for a resource other than the current
model, and the app opens the file the way a click in the tree would, revealing the
line. Links are not claimed by it: its own handler puts `http(s)` in a browser.

Completions and hover are served over LSP as well, so the worker's own providers are
switched off with `setModeConfiguration` while a server runs. Monaco still bundles
`ts.worker` (6.7 MB) — removing the worker outright is a separate step, and it needs
care: the fallback path is the worker.

**The fallback is weaker than it was.** With no language server, the worker has no
project files — the mirror that gave it some is what was deleted — so it reports
syntax errors and the libraries it is bundled with, and not much else. That is why
the editor says which engine is checking, and why the toolchain ships inside the
bundle rather than being optional.

## Checking it

```bash
scripts/fetch_lsp_sidecar.sh   # ~50 MB compressed, once
node scripts/check_lsp.mjs     # speaks LSP to a scratch project; exits 0 if the
                               # toolchain is absent, so it is safe in a broad check
```

`check_lsp.mjs` asserts the three things the old mirror got wrong: a `paths` alias
resolves, a type error is reported at the right line with the compiler's own code,
and a completion offers the symbol behind the aliased import.

## completionItem/resolve is not optional

Measured against the real server, a completion list item is `{label, kind, sortText,
data}` and nothing else — no `textEdit`, no `insertText`, no detail, no
documentation. Everything else arrives when that `data` is sent back to
`completionItem/resolve`:

| resolve gives | |
|---|---|
| `detail` | `Auto import from './lib'\nfunction greetName(who: string): string` |
| `documentation` | the doc comment |
| `additionalTextEdits` | `import { greetName } from "./lib";` |

So a client that skips resolve inserts `greetName` with no import — an identifier
that is not defined — and shows a list of bare names with no signatures. The editor
resolves every item that carries `data`, which is the protocol's own signal that
there is more to fetch.
