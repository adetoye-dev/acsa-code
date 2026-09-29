# Changelog

Notable changes to ACSA Code, newest first.

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Every release has a section here, and the release workflow publishes it as the
release notes — so this file is what a user reads, rather than a generated list of
commits. Two things are checked by the build rather than left to discipline:
`tests/test_changelog.py` fails if the version in the four carriers has no section,
and `scripts/changelog_section.py` is what the workflow cuts the notes with, so a
release with nothing written for it cannot go out.

Write for the person deciding whether to update. A bullet should say what changed
for them, not which file moved.

## [Unreleased]

## [0.2.23] - 2026-09-29

### Fixed

- **A plan run's reply says where the plan went, every time.** The note was built
  before the write it describes had finished, so the first plan run could finish
  with no note at all, and a second run in the same mode could inherit the
  previous run's success. The reply now waits for its own write, and each plan run
  starts from a clean slate — including the record of what was last written, so an
  identical plan is written again rather than skipped as already done.
- **Undo moved onto the message it applies to.** It sat above the composer, where
  it read as a setting unrelated to what you were reading. It is now a button
  beside Copy on the reply, and its outcome is stated there too.

## [0.2.22] - 2026-09-29

### Fixed

- **A long reply scrolls into view, along with anything it adds underneath.** The
  transcript decided whether to follow the tail by measuring the container *after*
  the new message was in it, so a tall reply — a plan, typically — looked like a
  reader who had scrolled away and the view stayed put. It now goes by the last
  scroll event, which is the last thing the reader actually did. The **Implement
  plan** button renders when the plan reaches disk, after the reply, so the write
  result is a dependency of the follow too: the one thing the reply had just
  announced was the one thing below the fold.

## [0.2.21] - 2026-09-29

### Fixed

- **Plan mode writes `implementation-plan.md`, and only offers to implement it once
  it has.** The write was gated on the mode at the moment the turn *finished*, so
  changing modes mid-run skipped it — the reply then said nothing had changed and no
  file appeared. Whether a run is a plan run is now recorded when it is sent, and the
  note and the file read the same flag.
- **Implement plan moved out of the composer** and into the transcript, under the
  plan it refers to. In the composer it was present as soon as plan mode was on —
  before anything had been planned — and clicking it started a write-enabled agent
  turn naming a file that did not exist. It now appears only after the plan is on
  disk, and disappears once implementation starts.
- **Groq is back behind the tool adapter.** 0.2.20 sent its agent runs straight to
  Groq's Responses API, which answers 200 to a probe and then rejects the runtime's
  real request body: a run against `openai/gpt-oss-120b` failed with
  `invalid JSON body`. Serving the protocol and accepting this client's shape of it
  are different claims, and the earlier probes only proved the first. Groq's agent
  runs work on the adapter path, as they did before 0.2.20.

## [0.2.20] - 2026-09-29

### Added

- **The model picker offers what the mode can use.** Agent and plan runs list only
  models that can drive them: providers the runtime can reach, plus local models
  the Ollama daemon itself reports as supporting tools. Chat lists everything,
  because chat only needs a model that can talk. When the model you have selected
  cannot run the current mode, the menu says why and offers the best one that can —
  and the app no longer auto-selects a local model it has measured failing.
- **Plan mode reads the project, and writes the plan down.** It runs on the same
  runtime as agent mode with the sandbox pinned read-only, so it can read files and
  the index it is planning against, and it cannot edit code even if it decides to.
  The plan is written to `implementation-plan.md` on every plan turn, and
  **Implement plan** hands that file to agent mode in one click.
- **Modes moved into the `+` menu**, beside the other things that decide what a
  turn is. An active mode shows as a chip you can dismiss; agent is the default, so
  it shows nothing.
- **A landing page** (`site/`) — the app in its own words, with six real screenshots
  of it running a real project, filed under a sticky index of what each screen is
  for. It is its own package with its own lockfile and workflow, so the app's build
  and release pipeline cannot be affected by it.

### Fixed

- **Groq works at all now — your key was never the problem.** Every request the app
  sent to a provider went out as `Python-urllib/3.x`, and Groq's edge refuses that
  signature with `403 error code: 1010` *before* it looks at the credential. So a
  valid key was reported as "the provider refused the request as not permitted" and
  nothing the user could do to the key would have changed it. Requests now identify
  the app. Chat and inline edit were failing the same way, not just the test button.
- **Groq's agent runs talk to Groq directly.** Its `/responses` serves the Responses
  API with real `function_call` items, so the translation layer is not in the path
  any more.
- **Groq's model list is what an account actually has.** The default was
  `deepseek-r1-distill-llama-70b`, which Groq has retired, so a fresh setup offered a
  model that could only ever fail.
- **The site's Download button downloads the app.** It used to open the GitHub
  release page and leave you to find the file. It now points at
  `releases/latest/download/ACSA-Code.app.zip`, which GitHub serves from whatever
  the newest release is, so it needs no edit per release.
- **A local agent run now says why it did nothing.** When a local model answers
  without calling a single tool, the reply said only that no files had changed —
  which reads like a finished task. It now says the model never reached for a tool,
  and that a hosted provider is what agent runs want. Measured, not assumed: behind
  the tool adapter, `qwen3.5:9b`, `qwen2.5-coder:7b` and `deepseek-coder:6.7b` each
  emit no function call for the runtime's real prompt. The same `qwen3.5:9b` does
  call tools when the prompt is short, so this is the model's ceiling, not the
  transport's. `docs/AGENT_RUNTIME.md` has the whole trace.
- **The provider list no longer calls local engines "Offline"** while the row beside
  it reads "Connected & Verified". The group is named for where the model runs —
  now "On-Device" — and the dot keeps carrying the state.
- **Links the terminal prints are clickable.** Running `npm run dev` printed
  `http://localhost:5173/` as plain text that could not be clicked; any `http(s)`
  URL in a command's output opens in the browser now, hover underline and all.
  OSC 8 hyperlinks take the same route, which also removes the stock `confirm()`
  prompt they used to raise.

## [0.2.19] - 2026-09-27

### Added

- **NVIDIA NIM** as a provider, with its own mark.
- A README.

### Changed

- The tool adapter fronts **any** OpenAI-compatible chat-only provider, rather
  than one shape at a time.
- **Google Gemini** points at its OpenAI-compatible surface, so chat and agent
  turns work instead of only "Test Connection" passing.
- The credential-store documentation says what ships: keychain-first, with the
  unencrypted fallback named.

### Fixed

- The adapter keeps the upstream reason, says what the provider said, retries a
  refusal the provider will not explain, closes the message item before the tool
  call it led to, ends its lifetime with the app's, and carries the reasoning
  effort.
- The agent gives up on a provider that keeps failing and says why in the chat,
  treats a concrete instruction as the assignment rather than a plan to confirm,
  and stops asking a cheap tier for deep reasoning.
- A model fetch no longer drops the models the registry curates, a local engine's
  installed list is left alone, and a model id keeps its owner.
- A file's review is one thread per line instead of one card per finding, and
  review zones are no longer rebuilt on every pass.
- The history graph stops painting over the commit panel, a chat opens on its
  newest message, and the page can reach the `gh` and `crash` subcommands.

## [0.2.18] - 2026-09-26

### Added

- The **Repository** page: a commit graph, a commit pane that reads a commit's
  files and its diff, a CI status card with the branch's history and rates, a
  failed run's log in place, hunk-by-hunk staging, and a comparison of any commit
  against the working tree.

### Fixed

- Renames, quoted paths, merge conflicts and the two sides of a diff read
  correctly, and the page hears about checkouts and agent writes it did not make.

## [0.2.17] - 2026-09-26

### Changed

- The empty editor is one quick-action panel on a halftone field.
- The rail's icons, highlights and brand mark are smaller, and the shortcut chips
  are gone.

### Fixed

- The editor takes a burst of typing again — the tab-to-panel sync was
  reactivating the panel and stealing focus on every keystroke.
- A finding's whole band passes clicks through to the code.
- A stalled lazy surface says so instead of loading forever.

## [0.2.16] - 2026-09-25

### Fixed

- **Run dev server / Build** hand the command to the terminal panel, instead of a
  session it immediately killed.

## [0.2.15] - 2026-09-25

### Fixed

- The review overlay no longer blocks the code underneath it.

## [0.2.14] - 2026-09-25

### Fixed

- **Drag and drop works** — the webview sees the drop instead of the OS
  swallowing it.

## [0.2.13] - 2026-09-25

### Fixed

- An install keeps running, and stays visible in the title bar, after Settings is
  closed. The banner reports the phase itself — percent, installing, restart,
  retry.
- A chat opens on its newest message rather than the top of its history.

## [0.2.12] - 2026-09-25

### Added

- Drag and drop onto the composer, taking the same route as paste and the file
  picker.

### Fixed

- **Images reach the model** on the app-server transport: attachments are written
  to disk once and sent as `localImage {path}`, the same file `exec` passes to
  `--image=`, so no base64 rides the JSON-RPC.

## [0.2.11] - 2026-09-25

### Fixed

- **Images reach the model**: input modalities are per model rather than
  hard-coded to text, and an app-server turn carries the image item the runtime
  itself builds. Unrecognised models are text-only now — a wrong yes is a failed
  run, a wrong no is a warning.
- The keychain migration no longer orphans keys: the name is indexed before the
  plaintext copy is released.

## [0.2.10] - 2026-09-25

### Fixed

- The update flow is reachable from everywhere it is announced: a check publishes
  on `acsa:update`, every surface showing update state listens, and
  **Settings → About** carries the whole flow (download → progress → installed →
  restart).
- Quitting after an install and relaunching no longer offers the download it just
  completed.

## [0.2.9] - 2026-09-24

### Fixed

- The reserved-provider-id fix, without which every OpenAI selection failed.

## [0.2.8] - 2026-09-24

### Fixed

- **Credentials move to the OS keychain.** The keyring backends are named now,
  without which nothing was ever encrypted.

## [0.2.7] - 2026-09-24

### Fixed

- The frozen engine sidecar can verify TLS again.
- A failed provider test says why.

## [0.2.6] - 2026-09-24

### Added

- One structured log, on stdout and in a rotating file.
- A retention window on the usage ledger.

### Fixed

- A dead local adapter is restarted rather than reused.
- A dead provider says which provider it was, and what to do about it.
- The Tauri updater crate is aligned with its npm package.

### Accessibility

- `prefers-reduced-motion` is honoured.

## [0.2.5] - 2026-09-24

### Added

- **Steering**: a message sent mid-turn goes into that turn.
- A turn has a wall-clock ceiling, and the clock excludes time spent waiting for
  you.

### Fixed

- A blocked turn is announced and visible outside the chat.
- The runtime's own model-metadata warning is dropped from **Output**.

## [0.2.4] - 2026-09-20

### Changed

- The macOS bundle runs on purpose rather than on every push to `dev`.
- Performance: the composer's text and the host's telemetry leave the app tree,
  and Monaco options are not re-applied on every keystroke.

### Fixed

- A deleted project no longer hides the real ones in the switcher.
- The Rust dependency graph is pinned, so the desktop bundle stops drifting.

## [0.2.3] - 2026-09-20

### Added

- The **Apex** mark and the indigo accent; the palette and the type scale are
  single-sourced.

### Changed

- Performance: chat and console stop re-rendering and re-scrolling what did not
  change.

### Fixed

- An open editor shows the file it is on, not the one it was opened with.

### Accessibility

- Contrast measured, focus ring fixed, dialogs trapped.

## [0.2.2] - 2026-09-19

### Changed

- Agent: writes are logged rather than gated one at a time, a file-change
  approval shows what it would change, the runtime's `request_user_input` is
  answered in its own shape, and host skills are played rather than skipped.

### Fixed

- Two bugs in the waiting/unchanged signals, both found by running it.

## [0.2.1] - 2026-09-19

### Fixed

- A run that changed nothing says so.
- The symbol index no longer goes stale when the agent writes a file.
- "Ask me" means what it sounds like.
- The template picker stops lying about five of six templates, and the default
  project destination works.
- Backups and support bundles stay out of the project.
- `npm run dev:app` can start the app, and the legacy "Autonomous" name is off
  screen.

## [0.2.0] - 2026-09-18

### Added

- A visible **update** button, with a check the user can turn off.
- Backup export and import.
- A local crash log.

### Fixed

- Release artifacts are named so GitHub cannot rewrite them; what Tauri leaves
  behind is signed, and an unsigned image is no longer shipped.

## [0.1.0] - 2026-09-16

### Added

- First public build: the workbench, the bundled engine sidecar, the integrated
  terminal, and signed, notarised macOS releases.

[Unreleased]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.23...dev
[0.2.23]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.22...v0.2.23
[0.2.22]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.21...v0.2.22
[0.2.21]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.20...v0.2.21
[0.2.20]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.19...v0.2.20
[0.2.19]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.18...v0.2.19
[0.2.18]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.17...v0.2.18
[0.2.17]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.16...v0.2.17
[0.2.16]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.15...v0.2.16
[0.2.15]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.14...v0.2.15
[0.2.14]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.13...v0.2.14
[0.2.13]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.12...v0.2.13
[0.2.12]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/adetoye-dev/acsa-code/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/adetoye-dev/acsa-code/releases/tag/v0.1.0
