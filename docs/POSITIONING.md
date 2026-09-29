# Positioning — what this is for, and how we say it

A working document, not copy. It exists because the landing page drifted twice: once into
someone else's visual language, once into reworded headings. Both times the words were
written before the argument. This is the argument.

Everything below has to survive one test: **can the app do this today?** If not, it does not
go on the page, however good it sounds.

---

## 1. The problem: agentic coding is being sold as a walled garden

The first version of this document led with *"It changed eleven files. Now work out what it
did."* That is a symptom, not a problem. Nobody changes tools to be slightly less confused.
A problem statement needs an enemy, a cost, and a person who feels it.

The enemy is that the two good options each charge a toll:

- **The CLI agents** — Codex CLI, Claude Code — are terminal-first. Excellent agents, no
  workbench: no map of the codebase, no review surface, a transcript you scroll, diffs you
  read through `git`, and no way to put a whole turn back.
- **The AI IDEs** — Cursor, Copilot, Windsurf — are account-first. A subscription, a login,
  telemetry, your code through their service, and while a change is reviewable it is not
  *reversible as a unit*.
- **Neither tells you the bill.** A subscription hides what a session cost, on purpose.

So the person who wants the capability pays for it in one of two currencies: the terminal,
or their account and their code. That is the sentence to lead with, and it is the reason
someone would switch rather than be mildly interested.

**The one sentence:**

> **An open-source desktop workbench for coding agents: the Codex CLI runtime inside a real
> app — code map, reviewable diffs, undo a turn, any model behind it, no account.**

The unit of value is not "AI writes code". Everyone has that. It is *the agent, without the
toll* — the workbench the terminal tools never had, and the model freedom the account-first
tools do not offer.

---

## 2. Framing: the three candidates, assessed

### A. "The open-source alternative to X" — yes, but the X decides whether we are honest

Instantly legible, and it borrows demand we would otherwise have to create. Which X:

| Candidate X | Verdict |
| --- | --- |
| **Claude Code** | **Do not use.** Anthropic's API is not supported in agent mode — it is a different protocol and the adapter cannot front it (`src/services/agentApproval.ts`, `NOT_ADAPTER_CAPABLE_PROVIDER_IDS`). A reader arriving from that framing plugs in an Anthropic key and hits a documented wall on the first click. That is a false promise, and it would cost us exactly the reader we most want. |
| **Cursor / Windsurf** | Strong demand, wrong contest. The comparison is autocomplete, polish and instant-apply — where we are not trying to win. Invites a test we fail. |
| **Codex CLI's missing GUI** | Honest and true, but that is not an "alternative", it is a front end. See C. |
| **A $20/month agent subscription** | **Honest, legible, and where we actually win.** It names the bill rather than a product, so there is no feature-for-feature comparison to lose. This is the version of "alternative to" I would back. |

The general risk with "alternative to": it frames us as a follower. Naming the *cost* instead
of a competitor avoids that — nobody is flattered into switching, but a bill is a bill.

### B. "A harness for Codex CLI that works with any model, agent or provider" — accurate, and insider language

This is the most truthful description of the architecture, and it should be a *strength* we
state rather than something we let a reader discover: keep OpenAI's agent engineering, gain
the workbench and the choice of engine. The runtime is bundled, pinned, and Apache-2.0, and
we should say so before someone else does.

Two cautions:

- **"Harness" is insider vocabulary.** Perfect in `docs/`, opaque on a landing page. On the
  page: "built on Codex CLI" — the reader knows the name, and it is the honest headline fact.
- **"Any model" is an overclaim.** It is *any OpenAI-compatible provider, or a local model*.
  Anthropic is out in agent mode, and a provider has to serve either the Responses API or
  chat completions. The precise sentence belongs on the page, because the imprecise one
  would be caught.

The sharp version of this frame is the cost argument, which is the strongest thing we have
that nobody else can say: **the model is a commodity, the workbench is the product.** Put a
cheap hosted model — the free tiers, a flash-tier, a mini-tier — behind a frontier-grade
runtime and the same work costs what you decide it costs. (A *local* model is a different
claim and a weaker one: good for chat and inline edits, usually unable to drive the agent at
all. See §4.) That is also the bill-by-bill alternative to a subscription.

### C. "It connects you to what you already have" — true, and strongest as a pillar

Nothing to migrate and nothing to sign up for: your folder, your keys, your git, your shell,
the editor inside VS Code (Monaco), the skills already in `~/.agents/skills`, the repository
you already run CI on. No account, no import step, no new cloud.

On its own it does not say why to switch — familiarity is a reason not to leave, not a reason
to arrive. It belongs as a supporting pillar under the walled-garden story, not as the headline.

### Recommendation

Lead with **A's priced version**, support it with **B's mechanism** and **C's trust**, against
the single enemy in §1. That gives one argument instead of three adjectives:

> **The models are getting cheaper. The wrappers are getting more expensive.**
> ACSA Code is an open-source workbench for Codex CLI: the agent out of the terminal, with a
> code map, diffs you can review, an undo for the turn — and any model, local or hosted,
> behind it. No account. MIT.

### Hero candidates to choose between

Written as problem-first, because the loudest text should be the reader's situation:

1. *"Agentic coding costs $20 a month. Or it costs whatever you point at it."*
2. *"Rent the model. Own the workbench."*
3. *"The agent, without the terminal, the account, or the subscription."*

My preference is 2 for the hero — it is nine words, it carries the cost story, and it does
not require the reader to know any product name — with 3 as the sub-line, where there is
room to be explanatory.

---

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
