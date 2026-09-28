# Positioning — what this is for, and how we say it

A working document, not copy. It exists because the landing page drifted twice: once into
someone else's visual language, once into rewording headings. Both times the words were
written before the argument. This is the argument.

Everything below has to survive one test: **can the app do this today?** If not, it does not
go on the page, however good it sounds.

---

## 1. The one sentence

> **A coding agent that works inside your real project — so every change arrives as a diff
> you can read, verify with your own build, and undo as a unit.** Your model, your keys, no
> account.

The unit of value is not "AI writes code". Everyone has that. The unit is *a change you can
still control after it has been made*.

## 2. The reader's problem, in their words

Not "AI is powerful". The sentence a developer says out loud after using an agent:

> "It changed eleven files. Now I have to work out what it did."

Three versions of the same complaint, depending on what they use today:

- **Chat and paste.** *"I'm copying files into a chat window and copying answers back, and
  nothing there knows about my build, my tests or my git."*
- **A CLI agent.** *"It really did the work — and left me a `git diff` to read in a
  terminal, with no way to put the whole turn back."*
- **An AI IDE.** *"It's good at the line I'm on. I still can't tell what it did across the
  repo, and I don't know what it costs me or where my code goes."*

Pick one of these to lead the page with; do not lead with a category.

## 3. What is actually different here

Ordered by how hard it is to copy, strongest first. Each one is a capability that exists in
this repository today, with the file that proves it.

| Pillar | The claim | Why the alternatives do not have it |
| --- | --- | --- |
| **Undo the turn** | One control restores every file the turn touched | The runtime refuses this in its own schemas — `thread/rollback`: *"does not revert local file changes that have been made by the agent. Clients are responsible for reverting these changes"*, and `thread/revert`: *"It does not revert local file changes"* — so the engine captures the pre-turn state itself (`core-engine/snapshot_cli.py`) |
| **See the whole change** | A turn reports "Edited N files +X −Y", one row per file; the diff viewer opens any file two-sided; git gets hunk-level staging and a commit graph | The agent's own transcript is the only record in a terminal client |
| **Understand the codebase** | Code map: the dependency graph plus a plain-language line about what each file is for, built locally (`core-engine/indexer_cli.py`) | Editor products index for completion; they do not show the reader the shape |
| **Verified, not asserted** | The agent is instructed to check with the project's own build, tests and dev server — and a turn that changed no files says so | Chat tools cannot; CLI agents can but leave you to interpret it |
| **Your terms** | Eleven providers plus local models; keys in the OS keychain; no account; no analytics or crash-reporting SDK anywhere | The AI-IDE category is account-first and telemetry-rich |
| **What it cost** | A ledger of tokens and cost per provider, including what a local model saved (`privacy`/usage tables, Performance page) | Subscriptions are opaque by design |
| **Nothing to install** | One download: the Python engine and the Codex CLI runtime are inside the bundle | Both CLI agents need a package manager first |

## 4. What we must not claim

These stay on the page, because a page that only lists wins reads as advertising.

- **macOS 11+ only.** Windows and Linux are written for, not shipped.
- **Local models often cannot drive the agent.** A model that chats but cannot call tools
  reads and replies and changes nothing. Use a hosted provider for agent runs.
- **Anthropic's API is not supported in agent mode** — different protocol, no adapter.
- **Undo covers the turn that just finished**, and only the files it touched.
- **Verification is an instruction, not enforcement.** The app tells the agent to use your
  tooling; it does not guarantee the agent obeyed.
- **Free tiers throttle**, and a URL the terminal wraps is left as text.
- **The app is not the agent.** The runtime is the open-source Codex CLI, Apache-2.0. Our
  claim is the workbench around it, and we should say so before someone else does.

## 5. Who it is for

- A developer who already uses an agent and is uneasy about what it did to their repo.
- Someone who cannot paste their code into an unapproved service — a local model, or an
  endpoint their employer has cleared, both work.
- Someone paying per token who wants to see the bill.

**Not for:** anyone who wants autocomplete-led editing; anyone who wants a hosted assistant
with nothing to configure; anyone who wants it on Windows today. Saying this out loud costs
us those readers and earns the others' trust.

## 6. How to communicate it

The reference worth following is [skillbox.so](https://skillbox.so), and the reason is
structural rather than visual:

1. **The headline is the problem, and it is the loudest thing on the page.** Theirs reads
   *"Your AI skills are scattered."* in ink, with the fix in grey beneath it. Weight is the
   argument: the reader's pain is loud, our answer is quiet. Ours should open the same way —
   *"It changed eleven files. Now work out what it did."* — then the one sentence above it.
2. **The pillars are tabs of one demo, not four sections.** Theirs: *Your skill library ·
   Across your tools · Keep it updated · With your team*, each switching one frame. Ours:
   **the change · the map · the verification · your terms** — each tab a real screen we can
   draw or capture, not a paragraph.
3. **Almost no prose.** Every sentence on the page has to be doing one of three jobs: name
   the problem, show the mechanism, or admit a limit.

### Proposed page order

| # | Section | Job |
| --- | --- | --- |
| 1 | Problem headline + one sentence + two buttons | Say the pain, then the promise |
| 2 | One demo frame, four tabs | The pillars, demonstrated |
| 3 | "How a turn goes" — ask, watch, read the diff, keep or undo | The loop, in order |
| 4 | Providers and what it costs | Your terms, with the free routes named |
| 5 | What it does not do | The limits above, unsoftened |
| 6 | Get it running | One download, ten minutes |

Nothing in sections 3–6 needs new art: the drawings already on the page (the agent's step
list with *Undo this turn*, the code map, the diff, the cost bars) are the demonstrations.
They were the strongest part of the page and they survive this.

## 7. Open questions for the owner

- **Which problem do we lead with** — "you can't tell what it did", or "you can't put it
  back"? They are one sentence apart in the reader's head, and the first is broader.
- **Is the audience the individual or the team?** The page currently speaks to one person.
  A team story would want the marketplace and shared skills, which exist but are thinner.
- **Do we name the competitors?** Naming Codex CLI is unavoidable and honest. Naming the
  AI-IDEs invites a comparison we do not win on autocomplete.
