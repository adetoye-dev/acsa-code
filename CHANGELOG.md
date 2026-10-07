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

## [0.2.29] - 2026-10-07

### Added

- **Ask mode reads your code now.** A chat turn used to carry a *map* of the
  project — LOC, frameworks, the names of 35 symbols — and not one line of code. A
  hosted frontier model can sometimes bluff past that; a small local model cannot,
  so it answered generically about a repository it had never seen. That is what
  "local models give generic answers" was. The turn now carries the file you have
  open (or the part you have selected) and the files your question points at,
  found by searching the project's contents and ranked so a rare word like `gh`
  outweighs a common one like `path`. Snippets, not whole files, and inside a
  budget — a local model's window cannot take a 60 KB dump. When nothing matched,
  the model is told to say so rather than invent project detail.

## [0.2.28] - 2026-10-07

### Added

- **Files can be attached to a chat message, from the explorer or from a picker.**
  The **Mentions** entry in the composer's `+` menu typed an `@` that nothing
  handled, so the only way to point the assistant at a file was to describe it and
  hope. It is **Files** now: a filterable list of the project's files, and a file
  row can also be dragged straight from the explorer onto the composer. What is
  attached shows as a removable chip above the input — and again in the transcript,
  on the message it went with — while the file's text travels in the prompt, read
  from disk at the moment the message is sent rather than when it was attached. A
  message carries at most 60 KB of files, and a file that crosses that line arrives
  shortened and labelled, so a model is never quietly handed the start of a file and
  left to answer as though it had read the end.

### Changed

- **The model picker lists every model, and a chat-only one still works.** It used
  to filter out the models that cannot call tools and print "· 2 hidden" — hiding
  exactly the models a reader might want, a local one or a free one, and saying
  nothing about why. Every configured model is listed now. Pick one that cannot
  call tools and the turn runs as a chat instead: agent and plan both need a model
  that calls tools, so running them anyway read files and answered without
  changing anything.
- **A capability switch is the app's business, not the mode chip's.** That
  downgrade used to *move the reader's mode* — the chip flipped to ask mode, which
  is a control they can cancel, putting them back in a mode the model cannot run at
  all. The chip now only ever shows a mode the reader chose; the downgrade happens
  at the moment of sending and is not surfaced as something to undo. The model menu
  says what the turn will do, in a sentence, instead of pushing them at a different
  model.
- **The editor wraps long lines by default instead of clipping them.** The editor
  lives in a pane the assistant dock narrows, so a line that runs past its right
  edge is the common case, not the exception — and a line cut off 15px from the dock
  reads as the dock having eaten it. Anyone who prefers it clipped still has the
  setting; the default only changes for a setting that has never been touched.

- **The assistant dock can be dragged, and it remembers where you put it.** It was
  a `clamp()` — always 30% of the window, with no way to argue — so on a laptop the
  editor was left about 790px and a file with longer lines was clipped by the
  editor's own viewport (`wordWrap` is off by default). That reads as the assistant
  cutting the code off, and the only remedy was to close the dock. Dragging its left
  edge moves the split and the width is kept. To be clear about what was *not*
  happening: the editor was never being covered: its scrollbar, its minimap and the
  review markers on its right edge all sit immediately beside the dock, which is
  how you can tell the pane is the width it should be.
- **The dependency gate can fail for a reason again.** It was a bare
  `npm audit --audit-level=high`, and it had been red on every push — not because
  anything regressed, but because advisories published since have no fix at that
  level: `braces`, a denial of service in a glob matcher reached only through
  Tailwind 3's build-time file watcher, has no released version outside the
  vulnerable range, so the only way to satisfy the old gate was to cross a breaking
  Tailwind upgrade. A gate that can only be satisfied by breaking something gets
  ignored, which is how it ends up unwired — so the level is unchanged, and the one
  unfixable advisory is now named in `scripts/audit_gate.mjs` with the reason it is
  safe to carry. A *new* high or critical still fails, a carried advisory that stops
  being reported fails too, and the lockfile's `source-map-js` was moved to the
  patched 1.2.2 on the way through.

### Fixed

- **The shell builds off macOS again.** File ▸ Open File… added an AppleScript
  helper that is gated to macOS, beside a caller that was deliberately left
  ungated so the script it builds could be tested — which stopped the Rust shell
  compiling at all on Linux, and would have stopped Windows for the same reason.
  Both are gated the same way now, with `test` allowed so the script stays under
  test everywhere. CI had not seen it because the dependency gate above failed
  first and the job stopped before the Rust step ran; narrowing that gate is what
  surfaced this.
- **The repository page finds `gh` where the app actually put it.** It read "The
  GitHub CLI (gh) is not installed" on machines where `gh` was installed and signed
  in — every client's, and this one — because the check was `shutil.which`, which
  reads PATH, and a window launched from the Dock is given launchd's PATH rather
  than the one from the user's shell profile. Homebrew's `/opt/homebrew/bin` is not
  in it, and that is exactly where this app's own advice (`brew install gh`) puts
  the binary. The command was also run by the bare name and re-resolved against the
  same PATH, so the second half of the mistake hid the first. A shared lookup now
  tries PATH, then the install directories the common package managers use — and
  Ollama uses it too, where a copy in `~/.local/bin` had been invisible for the
  same reason.
- **A tooltip in the editor is no longer cut off at the pane's edge.** Hover,
  suggest and parameter-hint widgets are absolutely positioned inside Monaco, and
  every editor pane carries `overflow: hidden` — so a widget reaching past the
  pane's right edge was clipped exactly there and its text was cut mid-word
  ("…: Reco"). It looks like the tooltip is running into the chat panel; it is
  the editor's own boundary hiding it. The editors now render those widgets in a
  viewport-anchored layer the pane cannot clip. Measured in a browser at this
  app's pane width, the same hover went from 599px→1351px with the pane ending at
  955px, to fully readable past that edge.

## [0.2.27] - 2026-10-06

### Added

- **The File menu has the operations a Mac app is expected to have in it.** File
  offered "Close Window" and nothing else — Tauri's default — so opening a file or a
  folder meant finding the button for it somewhere in the workbench. It now opens with
  **Open File… (⌘O)**, **Open Folder… (⇧⌘O)**, **Save (⌘S)** and **Save All (⌥⌘S)**,
  and each of them runs the same function the command palette calls rather than a
  second implementation of it. Open File… starts its panel in the project — where the
  file is, and the only place the reader is allowed to read from. The standard menus
  are untouched: the default menu is kept, and these items are inserted into it.

### Changed

- **The Performance panel no longer draws a machine it has not measured.** With
  telemetry offline it showed a full, plausible host — 15% CPU, 88% memory, 926.4 GB of
  disk, "341 MB reclaimable", and a badge reading "Optimal Health" — all of it literals
  in the component. An unmeasured value is a dash now, the badge says "No Reading", and
  the workspace panel says it has measured nothing. Those fabricated storage numbers
  were also what hid the wire mismatch in the CPU and RAM columns: a missing field
  fell back to the previous value, and the previous value was an example.
- **The runtime line has a supplier.** `Node · Vite · Python` read three fields nothing
  produced, so it said `unknown` on every machine. The engine now reports its own
  interpreter and the host's Node — a packaged build carries an embedded Python, so the
  engine is the only honest source — and the bundler version is captured at build time,
  where it is a fact rather than a guess.
- **The file tree shows the dotfiles you actually work in.** The rule was "skip
  anything starting with a dot", which hid `.env`, `.gitignore`, `.github/` and
  `.vscode/` — files a developer opens constantly — in order to avoid walking caches.
  The caches are named now (`.git`, `.next`, `.turbo`, `.pnpm-store` and the like), so
  `.env` is visible while a tree of generated files still is not.
- **TypeScript files are given the project, so an import resolves rather than being
  hidden.** The editor's TypeScript worker is a Web Worker with no filesystem, so an
  import could only resolve to a file it had been handed — which is why the two "cannot
  find module" diagnostics were suppressed, and why a misspelled import was as invisible
  as a correct relative path. The worker is now handed the project's own source files,
  the type entry of every package the project declares, and the project's own tsconfig:
  `./pagination.js` finds `pagination.ts`, `expo-router` resolves, and `paths` aliases
  work. With that in place the suppression is gone, so an import that really cannot be
  resolved is reported again.
- **Choosing a model that can only chat turns ask mode on, and says why.** Agent and
  plan runs need a model that calls tools, so a local model the daemon reports as
  having no tool support could only read files and answer without changing anything.
  The model menu warned about that and offered a different model — the wrong way
  round, since the model is the thing you chose, often because it is free and stays
  on your machine. The mode moves instead, the chip that appears explains itself on
  hover, and turning agent back on afterwards is left alone rather than undone.
- **…and it is handed back when you pick a model that can run it.** Ask mode in that
  case is the app's doing, so choosing a capable model restores the mode the switch
  took. A mode you set yourself is never overruled.

- **The Performance page's CPU and RAM columns show numbers again, and its host line
  names the host.** Three shell structs serialise their fields in `snake_case`
  (`cpu_percent`, `size_mb`) while the page reads them in `camelCase`, so those fields
  arrived `undefined`: the process table rendered `%` and `MB` with nothing in front of
  them, and the host line read `ACSA Local Engine (unknown unknown)` on every machine.
  The storage numbers had drifted the same way and were *hidden* rather than visible —
  the page keeps the previous value when a field is missing, and the previous value was
  a hardcoded example, so an invented "341 MB reclaimable" looked like a reading. All
  three are aligned, the host line gets its real values, and
  `tests/test_wire_contract.py` now compares the two sides of the boundary: a field the
  frontend declares without a `?` has to be one the shell actually sends.
### Fixed

- **A review card keeps all of its text when the editor gets narrower.** The cards
  live in Monaco view zones, and a zone is applied with a height that is only right
  for the width it was measured at. Opening the chat dock narrows the editor, a card
  whose text needs another line becomes taller than its zone, and its last line was
  clipped — the sentence stopping mid-way, which stayed that way through window
  resizes because nothing asked for a new measurement. The heights are re-measured on
  Monaco's layout change now, the same way they already were on scroll.

- **TypeScript files stop reporting errors that are not there.** Monaco 0.57 moved
  its TypeScript API, and the configuration that sets the compiler options and
  suppresses module-resolution diagnostics was reading the old location — so it
  silently did nothing and the worker fell back to its own defaults. Every `.ts`
  file showed `Cannot find module … (2792)` and a `.tsx` file was underlined end to
  end for want of a `--jsx` flag, while the same files were clean in other editors.
  It now applies, and says so out loud if the API moves again.
- **The file tree no longer stops five folders down.** Projects laid out like
  `apps/api/migrations/app/<migration>/` showed `(empty folder)` for folders that
  had files, because the walk had a hard depth cap of 5. The cap is a backstop now
  rather than a limit, and a symlink pointing back up the tree is recognised
  instead of being walked into.
- **An update that cannot install says why, and offers a way through.** Opened from
  the Downloads folder or straight out of the disk image, macOS runs ACSA Code from
  a read-only copy — and an app in a read-only place cannot replace itself, so the
  update died with `Read-only file system (os error 30)`. That names no cause and
  offers no next step, which is where the reports came from. It now explains which
  copy you are running, tells you to move it into Applications, and links the
  release page so there is a way forward either way.

## [0.2.26] - 2026-10-06

### Added

- **ACSA Code installs Ollama for you.** Setting up a local model used to send you
  to a website: the wizard's install step told you to go and get Ollama yourself,
  and the only way to continue was to come back once you had. It now fetches
  Ollama's own release — about 190 MB on macOS — unpacks it into the app's own data
  folder and starts it. No administrator password, nothing written outside that
  folder, no installer to click through and no `curl | sh`.
- **A run going in circles is stopped, and told which way.** Beyond the clock, an
  agent turn is now bounded by repetition — the same action five times is a loop —
  and by a 60-step backstop, about double the longest legitimate run measured here.
  Whichever fires, the turn stops through the same path as the Stop button, and
  OUTPUT names the repeated action or the count instead of saying only that we
  intervened. A turn waiting on your approval counts against neither.

### Changed

- **The interface type is larger.** The scale started at 9px and the app leaned on
  the bottom of it: badges, metadata and status lines were set at 9–11px, below the
  12px most interfaces start at. Nothing renders below 11px now. This is the
  interface around your code, not your code — the editor and terminal keep their own
  font settings.
- **The setup wizard explains the model it has already chosen.** Its last step said
  "Select Local Model to Download" above a dropdown that arrived filled in. It now
  names the memory it measured, the model that follows from it and why, and it
  disappears once the download starts, with the download named in its place.

### Fixed

- **The local-model page no longer offers downloads there is nowhere to put.** With
  Ollama absent or stopped the page showed the whole catalogue, and clicking Pull
  was how you found out. The catalogue and the installed-models list now appear only
  once the daemon answers; before that the page offers to install it, or to start it.
- **A model whose allowance cannot fit one turn is no longer offered for agent
  runs.** Groq's free tier answers a real run with 413 — 8,000 tokens per minute
  against an 18,000-token request — which trimming cannot fix, because every run
  fails the same way. The refusal is remembered for the session, so the model drops
  out of the agent and plan lists with the picker's existing hidden count, while chat
  still offers it.
- **A per-minute token cap no longer reads like a context window.** The two look
  alike and are opposites: one means the conversation is too long, the other that a
  single request exceeds the tier's entire allowance and no retry will help. The
  message says which, and points at what does.
- **The plan note is on the reply it belongs to.** It was written into the message
  once, at finalisation, so it depended on the plan file's write having finished and
  could be missing altogether. It renders from the same state as the Implement
  button beside it now.
- **A failed usage write says why.** Metering is best-effort and must never fail a
  run, which it does not — but it was also silent, and a missing usage row with no
  reason is undiagnosable. The reason reaches the OUTPUT panel.
- **Marketplace item names are no longer crushed to a single letter.** A
  fixed-width trust badge shared a row with the name, and the name — the only
  shrinkable child — absorbed the whole squeeze once the assistant was docked. The
  badge wraps to its own line instead.

## [0.2.25] - 2026-09-29

### Fixed

- **Agent runs work on every hosted provider the adapter fronts — not just the two
  that speak Responses natively.** The tool adapter opened HTTPS with
  `http.client`'s default TLS context, which in a frozen build carries no CA
  bundle, so the run died with
  `[SSL: CERTIFICATE_VERIFY_FAILED] unable to get local issuer certificate`. Groq,
  NVIDIA NIM, Together, OpenRouter, Moonshot, Cohere and xAI all go through that
  adapter, so all of them failed this way while the connection test and chat — which
  use the engine's `tls_context` — passed. That is exactly the shape the complaints
  had: the key tests fine, the agent does nothing. The adapter verifies through
  `tls_context` now, like the rest of the engine.

## [0.2.24] - 2026-09-29

### Fixed

- **A plan run that fails says so.** 0.2.23 made the reply wait for its plan write
  before finalising, which was right for a run that writes — and wrong for one that
  does not: a failed run, or one that produced no plan text, never started a write,
  so the wait never ended and the transcript showed nothing at all. The wait now
  applies only to a run that is going to write, and the failure message appears as
  it should.

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

[Unreleased]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.29...dev
[0.2.29]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.28...v0.2.29
[0.2.28]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.27...v0.2.28
[0.2.27]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.26...v0.2.27
[0.2.26]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.25...v0.2.26
[0.2.25]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.24...v0.2.25
[0.2.24]: https://github.com/adetoye-dev/acsa-code/compare/v0.2.23...v0.2.24
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
