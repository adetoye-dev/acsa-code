<p align="center">
  <img src="docs/brand/apex-icon.svg" alt="Apex, the ACSA Code mark" width="96">
</p>

<h1 align="center">ACSA Code</h1>

<p align="center">
  <strong>Local-first agentic engineering workbench.</strong><br>
  An editor, a map of your codebase and a coding agent in one desktop app — with your
  code, your keys and your history staying on your machine.
</p>

<p align="center">
  <a href="https://github.com/adetoye-dev/asca-code/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/adetoye-dev/asca-code/actions/workflows/ci.yml/badge.svg?branch=dev"></a>
  <a href="https://github.com/adetoye-dev/asca-code/actions/workflows/release.yml"><img alt="Release" src="https://github.com/adetoye-dev/asca-code/actions/workflows/release.yml/badge.svg?branch=dev"></a>
  <a href="https://github.com/adetoye-dev/asca-code/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/adetoye-dev/asca-code?label=download&color=6366f1"></a>
  <img alt="Platform: macOS 11+" src="https://img.shields.io/badge/platform-macOS%2011%2B-lightgrey">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#what-you-can-do">Features</a> ·
  <a href="#providers-and-models">Providers</a> ·
  <a href="#build-from-source">Build</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

ACSA Code is a desktop workbench for working on a codebase with an AI agent. It is
built around a simple constraint: **the machine you are sitting at is where the work
happens.** Projects open as folders on disk, the search index and code map are built
locally, credentials live in the operating system's keychain, and the agent runs as a
process you can watch, approve and stop.

It ships with everything it needs to do that: a bundled Python runtime for its
engine, and a bundled [Codex CLI](https://github.com/openai/codex) as the agent
runtime. Bring your own model — a local one, or an API key for a hosted provider.

## Contents

- [What you can do](#what-you-can-do)
- [Requirements](#requirements)
- [Install](#install)
- [First run](#first-run)
- [Providers and models](#providers-and-models)
- [Using the app](#using-the-app)
- [How it is put together](#how-it-is-put-together)
- [Build from source](#build-from-source)
- [Testing](#testing)
- [Your data, and what leaves your machine](#your-data-and-what-leaves-your-machine)
- [Troubleshooting](#troubleshooting)
- [Project status](#project-status)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## What you can do

**Work on real files.** Open a folder and edit in a Monaco editor with tabs, a file
tree, real paths and real saves. There is a terminal (and an Output/Problems panel)
in the bottom dock.

**See the shape of a codebase.** The **Code map** indexes the project in the
background and draws the relationships between files, with a summary of what each one
does. The **Editor** screen pairs the file tree with the editor, so navigation does
not cost you the tree.

**Review and commit with git.** The **Repository** screen holds the commit box, the
working-tree changes, staged changes, a commit graph, per-file diffs — and, on a
matching repository, your **GitHub** picture: the latest CI run, pull requests, and
a failed run's log without opening a browser.

**Ask an agent to do the work.** Chat with a model, or put the chat in **Agent** mode
and give it a task. Agent runs stream as they go, show each tool call as a step, ask
for approval when they reach past your project, ask a *question* when they genuinely
need a decision, can be steered mid-run, and can be undone afterwards.

**Fix things without leaving the file.** In the editor, **⌘K** opens an inline
edit/review flow over the selection: ask for a change and it comes back as a diff you
accept or reject. A whole-file review lands as comments anchored to the lines they
are about.

**Install tools, skills and MCP servers.** The **Marketplace** installs real MCP
servers and skills into your project and hands them to the agent — skills you install
are mirrored into the runtime's own home, so it uses them. Your existing skills under
`~/.agents/skills` keep working too.

**Watch the cost.** **Models** manages providers, keys and model lists;
**Performance** shows host metrics and per-provider token and cost accounting.

## Requirements

**To use the app — macOS 11 or newer.** That is the platform releases are built,
signed and notarised for today; Windows and Linux are not shipped yet (see
[Project status](#project-status)). Nothing else needs installing: the agent runtime
and the Python engine are inside the app bundle. It is a large download — around
110 MB — and the agent runtime alone unpacks to roughly 220 MB.

You will need one of:

- an API key for a hosted provider ([there are free options](#providers-and-models)), or
- a local model server — [Ollama](https://ollama.com) is detected automatically.

**To build or contribute —** Node.js 22, Python 3.12 and a stable Rust toolchain.
See [Build from source](#build-from-source).

## Install

Download the latest release from the
[releases page](https://github.com/adetoye-dev/asca-code/releases/latest) and drag
**ACSA Code** into Applications.

Release builds are signed with a Developer ID certificate and notarised, so macOS
opens them normally. The app checks for updates on launch and offers an **Update**
button in the title bar when one is available; it can also update itself from
**Settings → About**.

> Building it yourself? A locally built bundle is *not* signed unless you sign it —
> see [Build from source](#build-from-source). macOS treats an unsigned build as a
> different application: the keychain will not hand it your saved credentials, and
> it may refuse to launch the bundled engine.

## First run

1. **Open a project** — the folder switcher opens a folder, and recent projects come
   back next time. New projects can be scaffolded from a template.
2. **Pick a model** in the composer, or open **Models** to configure a provider. Keys
   go to the operating system keychain (macOS Keychain, Windows Credential Manager,
   Linux Secret Service) and are write-only: the page can set or clear one and ask
   whether it exists, never read the value back. See
   [Your data](#your-data-and-what-leaves-your-machine) for the fallback when a
   keychain is not usable.
3. **Choose how much the agent may do** — *Read only*, *Approve for me*, *Ask me* or
   *Full access*. The mode decides whether the agent stops to ask, or an automatic
   reviewer answers for you.
4. **Ask for something.** Start in chat to talk about the code, or switch to **Agent**
   to have it change files and run commands.

## Providers and models

The app speaks the OpenAI API shapes, so anything OpenAI-compatible can be added.
Eleven providers ship in the picker — OpenAI, DeepSeek, Groq, Google Gemini, xAI,
NVIDIA NIM, Moonshot, Cohere, Together, OpenRouter and Ollama — and any other
endpoint can be added under **Models** with a base URL and a key.

**Free ways to start.** Hosted free tiers work here, with your own key:

| Provider | Get a key | Notes |
| --- | --- | --- |
| [Groq](https://console.groq.com/keys) | free tier | the fastest of the free tiers; OpenAI-compatible |
| [Google Gemini](https://aistudio.google.com/apikey) | free tier | the most capable of the free tiers |
| [NVIDIA NIM](https://build.nvidia.com) | free tier | a wide catalogue; the free tier is heavily shared and the most likely to time out |
| [Ollama](https://ollama.com) | nothing to sign up for | runs on your machine; no key, no network |

Free tiers are rate-limited and shared, so expect variable latency, and occasional
gateway timeouts under load. The app stops a run that keeps failing and tells you why
rather than waiting out its wall-clock limit.

**Which providers can drive the agent.** The agent runtime only speaks the
**Responses API**, and only some providers implement it. The app handles this for
you:

- providers verified to serve Responses (OpenAI, DeepSeek) are used directly;
- every other chat-completions provider is reached through a bundled **tool
  adapter**, which speaks Responses to the runtime and chat completions to the
  provider;
- Anthropic's API is a different protocol and is **not** supported in agent mode.
- a model that can chat but cannot call tools will read and reply without changing
  anything; small local models frequently cannot drive the tool protocol, so a run
  with no tool calls is reported as such rather than as a finished task.

`docs/AGENT_RUNTIME.md` records what was verified against the runtime binary — which
settings it accepts, what local models can and cannot do, and why the adapter exists.

## Using the app

The left rail holds the main screens; the right panel holds the assistant. Click the
rail's logo to pin it open, or let it expand on hover.

| Shortcut | What it does |
| --- | --- |
| `⌘P` | Search files |
| `⌘⇧P` | Command palette |
| `⌘L` | Toggle the AI assistant |
| `⌘B` | Pin or release the navigation rail |
| `⌘J` | Toggle the bottom panel (terminal, output, problems) |
| `⌘⇧E` | Editor |
| `⌘⇧G` | Repository |
| `⌘⇧X` | Marketplace |
| `⌘K` | Inline edit or review the selection, in the editor |
| `⌘,` | Settings |
| `⌘K ⌘T` | Theme editor |
| `⌘S` | Save |

## How it is put together

Three layers, each doing what it is good at:

| Layer | What it is | What it does |
| --- | --- | --- |
| **Shell** | Rust + Tauri v2 | windows, IPC, the process boundary, the security allowlist for what the page may ask for, credentials |
| **Interface** | React + TypeScript + Vite | the workbench, editor, map, chat, marketplace, dashboards |
| **Engine** | Python, frozen into a sidecar | git, the filesystem, the database, AI calls, the code index, MCP, skills |

The **agent runtime** is the bundled Codex CLI, spawned by the shell and given its
own home directory, so it never touches a Codex CLI you have configured yourself.
The engine and the runtime are shipped as resources: users install nothing.

Credentials are handed to the runtime in its environment, never over IPC, and the
adapter that fronts chat-completions providers receives its key the same way.

## Build from source

Requirements: **Node.js 22**, **Python 3.12**, a **stable Rust toolchain**, and
macOS for the desktop bundle. Both sidecars are gitignored build outputs, so a fresh
checkout builds them first:

```bash
git clone https://github.com/adetoye-dev/asca-code.git
cd asca-code

npm ci
scripts/fetch_codex_sidecar.sh     # the agent runtime (Apache-2.0, pinned version)
scripts/build_engine_sidecar.sh    # freezes the Python engine (uses PyInstaller)

npm run dev:app                    # tauri dev: the app, with hot reload
```

To produce a bundle:

```bash
npm run tauri build -- --bundles app
```

**Sign it, or macOS will not trust it.** An unsigned bundle cannot read the
keychain, and may be refused when it launches its own engine. With a Developer ID
certificate in your keychain:

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
  scripts/sign_bundle.sh
```

`scripts/sign_bundle.sh` signs the nested binaries Tauri leaves alone, then re-seals
the bundle. Without a certificate, `--sign -` produces an ad-hoc signature that is
enough for local work as long as you understand the keychain consequence above.

`docs/RELEASING.md` covers version bumps, the signing secrets CI needs, and
notarisation.

## Testing

```bash
npm run verify          # lint, typecheck, class/contrast checks, Python + UI tests
npm run test            # Python engine tests
npm run test:ui         # UI tests (vitest)
cd .tauri && cargo test # the Rust shell
```

Two of the checks drive the **real application** through a browser protocol rather
than a simulated DOM, because the parts that broke most often were the parts only a
running app exercises:

```bash
npm run gui:check           # the shell, panels and layout
npm run gui:check:editor    # the editor: typing, editing, review, commands
```

Please run `npm run verify` before opening a pull request.

## Your data, and what leaves your machine

- **Credentials** go to the operating system keychain, and are write-only across the
  app's own API: a page can set or clear a key and ask whether one exists, but never
  receives the value. If a keychain cannot be used on a machine — a headless Linux
  box, a locked keyring, or a build the OS will not trust — the app says so and keeps
  the key in its own `0600` database file instead, which is **not** encrypted.
- **Projects, history, usage and settings** live in a local SQLite database in the
  app's data directory, along with logs and per-turn snapshots (which are what *undo
  this turn* restores from).
- **Nothing is sent anywhere except the model calls you configure.** There is no
  analytics or crash-reporting SDK in the app or the engine.
- A local model keeps even those calls on your machine.

## Troubleshooting

**"The provider says connected, but the model does not appear in the picker."** On
macOS, a rebuild has a different code signature, and the keychain treats it as a
different application — so a bundle you built yourself cannot read keys the released
app saved. Sign your build as above, or re-enter the key; macOS may ask you to allow
access once.

**"The agent does nothing, or the provider returns 404."** That provider probably has
no Responses API. It should have gone through the tool adapter automatically — check
the Output panel for the line naming the adapter, and see
`docs/AGENT_RUNTIME.md`.

**"A run stalls and then fails with 502/503/504."** That is the provider's gateway,
not the app: free tiers throttle and time out under load. The app stops the run after
repeated failures and names the reason.

**"I want to see what the agent did."** The Output panel has the runtime's own lines,
and every run keeps its steps and a diff of what changed.

## Project status

ACSA Code is at **0.2.x** — usable, and still moving quickly.

- Releases are cut from the `dev` branch; macOS builds are signed, notarised and
  delivered through the built-in updater.
- Agent mode runs on the bundled Codex CLI. It is the part of the app that changes
  most, and the part where a provider's own quirks show through.
- Windows and Linux are not built by CI yet. The code has been written for all three,
  and `docs/RELEASING.md` covers what the icon set already carries for them.

## Contributing

Issues and pull requests are welcome. A few things make changes land faster:

- **Open an issue first for anything structural** — a new screen, a change to how the
  agent runs, or a new provider. It is cheaper to agree on the shape before the code.
- **Run `npm run verify`** and make sure it is green. If your change touches the UI,
  `npm run gui:check` too.
- **Keep the tests honest.** This codebase prefers a test that fails when the fix is
  removed over a test that passes either way, and it documents *why* a thing is the
  way it is — the comments explaining a past bug are load-bearing.
- **Commit messages** follow `type(scope): summary` (`fix(adapter): …`,
  `feat(providers): …`), with the reasoning in the body.
- **Do not commit build outputs.** The engine sidecar, the Codex runtime, `dist/` and
  `.tauri/target/` are generated.

The design notes for the trickiest parts live in `docs/` — start with
`AGENT_RUNTIME.md` (how the agent is wired) and `PRODUCTION_CHECKLIST.md` (what has
to be true before shipping).

## Security

Please **do not** open a public issue for a vulnerability. Use GitHub's private
[security advisory](https://github.com/adetoye-dev/asca-code/security/advisories/new)
form instead, with what you did, what happened, and what you expected.

Worth knowing when you assess a report: the runtime is a separate process with its
own sandbox and approval policy; the webview can only ask the engine for an
allowlisted set of subcommands; and credentials are passed to child processes in
their environment, which any process running as you can read.

## License

[MIT](LICENSE) © 2026 Adetoye Adewoye.

Third-party components, their licences and what is deliberately *not* distributed are
listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), which is generated from
the dependency tree and checked in CI.

## Acknowledgements

This app is mostly assembly of other people's good work:

- **[Codex CLI](https://github.com/openai/codex)** (Apache-2.0) is the agent runtime.
  Native tool calling, approvals and session resumption are its design, not ours.
- **[Tauri](https://tauri.app)**, **[React](https://react.dev)**,
  **[Monaco](https://microsoft.github.io/monaco-editor/)**,
  **[xterm.js](https://xtermjs.org)**, **[Dockview](https://dockview.dev)**,
  **[Tailwind CSS](https://tailwindcss.com)** build the shell and the interface.
- **[Graphology](https://graphology.github.io)** and
  **[react-force-graph](https://github.com/vasturiano/react-force-graph)** draw the
  code map.
- **[PyInstaller](https://pyinstaller.org)** freezes the Python engine so users do not
  need Python installed.
- The bundled fonts are licensed under the SIL Open Font License.

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the full list.
