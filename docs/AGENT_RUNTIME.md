# The agent runtime

Agent mode runs on the **Codex CLI**, shipped as a bundle resource and spawned by
the Rust layer (`codex_exec` in `.tauri/src/main.rs`). This file records what was
*verified against the binary* rather than assumed, because most of these were
found by a run failing in a way that looks like something else.

Fetch or refresh the runtime with `scripts/fetch_codex_sidecar.sh`.

## Configuration facts

Each of these was checked by running the binary, not read off documentation.

| Setting | Accepted | Notes |
| --- | --- | --- |
| `wire_api` | `"responses"` | `"chat"` is rejected outright. |
| `approval_policy` | `untrusted` · `on-failure` · `on-request` · `granular` · `never` | `untrusted` parses but is **refused at runtime** ("no longer supported"). Do not use it. |
| `approvals_reviewer` | `user` · `auto_review` · `guardian_subagent` | `"model"` and `"auto"` are config errors. |
| `sandbox_mode` | `read-only` · `workspace-write` · `danger-full-access` | |
| `model_catalog_json` | a **path** to a file | An inline value parses without error and is silently ignored. A *minimal* catalog silences the metadata warning and the agent then does nothing, so the entry needs the full field set — see `catalogJson` in `src/hooks/usePipeline.ts`. |

`approval_policy = "never"` **denies** tool calls that need approval (the runtime
says "requires approval, but approval policy is never"), so the working default is
`on-request` + `auto_review`.

TOML tables come last, so a top-level key written after a `[table]` lands inside
it and is rejected — which is why `model_catalog_json` is prepended.

Verify a combination before shipping it:

```bash
CODEX_HOME=/tmp/probe \
  .tauri/engine-codex/codex exec --strict-config --skip-git-repo-check "hi"
```

A config that cannot load says so immediately; a config that loads proceeds to
the provider and fails on the missing key instead. That distinction is the test.

## Local models (Ollama, LM Studio)

These are **not** OpenAI-compatible enough for the provider-table path: Ollama
serves `/v1/chat/completions` and does not implement the Responses API, so a
`wire_api = "responses"` entry can never reach it. They go through the runtime's
own switch instead:

```
codex exec --oss --local-provider ollama -m <model> "<task>"
```

`-m` is **required**. Without it `--oss` selects its own default model and will
start downloading it — observed pulling 12.85 GB while the config named an
already-installed 1.5B model.

### What local models can and cannot do

Verified against the installed `qwen2.5-coder:7b`: the model wrote its tool call
out as *message text* (`{"name":"spawn_agent",…}`), the turn completed, and no
file changed. Smaller local models frequently cannot drive the tool protocol.

A run with **zero tool calls** is therefore reported as such in the step list and
the Output panel, instead of being presented as a finished task. The check is
mechanical: `runAgentOnCodex` counts `command_execution`, `file_change`,
`mcp_tool_call` and `web_search` items.

#### The wall is the prompt, not the plumbing — measured

The adapter exists so a local model *can* call tools at all, and it works: the
tools reach Ollama. What fails is the model. Reproduced outside the app by
running the bundled CLI against a copy of the adapter and capturing the exact
body the adapter forwards upstream:

```
codex exec --strict-config --skip-git-repo-check \
  "Add a one-line JSDoc comment above the sortNotes function in src/notes/sort.ts."
```

The upstream body is 36 KB: a 17 KB Codex system prompt, a 10 KB skills block, an
`<environment_context>` user item, and seven tools — `exec_command`, `write_stdin`,
`request_user_input`, `view_image`, `get_goal`, `create_goal`, `update_goal`.
There is no file-read and no patch tool: everything goes through the shell.

| Model | Real prompt | Short probe prompt (2–7 tools, no Codex system text) |
| --- | --- | --- |
| `qwen3.5:9b` | 0 tool calls — prose, then a `<read path="…"/>` tag, or a ```bash fence | **calls tools** (`read_file`) |
| `qwen2.5-coder:7b` | 0 tool calls — writes the finished edit inside a fence | writes the call as JSON *text* |
| `deepseek-coder:6.7b` | HTTP 400 — no tool support at all | HTTP 400 |

So the same model that returns a real `tool_calls` array for a short prompt
returns none for the runtime's own. Three follow-ups were tried against the
captured body and all failed: a system message telling it to use the function
interface and never to write tags, the same appended to the main system prompt,
and the same request non-streamed. Streaming is not the cause.

The practical conclusion is the one the landing page states: **a local model of
this size is for chat and completions; agent runs want a hosted provider.** The
panel now says exactly that when a local run ends with zero tool calls, instead
of the generic "no files changed" line that reads like a finished task.

Two things the same trace settled, because both were assumed rather than checked:

* `tool_call_from_text` recovers a call only when the answer *starts* with `{`,
  `[` or a fence. `qwen2.5-coder` does exactly that, so the recovery path is live
  for the case it was written for — a prose prefix would defeat it, but no
  installed model produces that shape, so the guard stands.
* The two `system` and two `user` messages in the captured body are Codex's own
  (`instructions` plus a `<skills_instructions>` developer item), not a
  duplication introduced by `chat_messages`.

## Continuing a conversation

A follow-up turn runs `codex exec resume <thread-id>` instead of a fresh `exec`,
so the agent still has everything it read and did. The id comes from the first
event of the previous run (`{"type":"thread.started","thread_id":"…"}`); the hook
keeps one live thread per project + provider + model + approval mode, and starts
a new one when any of those changes, because that is no longer the same
conversation. Threads are held in memory: a relaunch starts clean, like the CLI.

Two things about `resume` that are easy to get wrong:

* It **rejects `--oss` / `--local-provider`** ("unexpected argument") — a resumed
  thread keeps the model it was created with.
* It still needs the provider named, or it falls back to OpenAI. Verified: a
  resumed Ollama thread went to `api.openai.com` and 401'd. A config override is
  accepted where the flag is not, so resume passes
  `-c model_provider="<id>"` — the same name as our `[model_providers.*]` table
  for cloud providers, and the built-in `ollama` for local ones.

An unknown thread id fails **before the model sees anything** ("no rollout found
for thread id …"), which is what makes the retry safe: the hook drops the id and
re-runs once from scratch. That is not the two-edits risk a mid-run retry would
carry.

Verified end to end against the local model: after a resume, the thread's rollout
contains both the first turn's message and the second's, so the context travelled.
(The 1.5B model then failed to recall the number it was given — a capability
limit, not a plumbing one.)

## Failure detection

`turn.failed` decides whether a run failed. Error *items* do **not**: Codex emits
them for warnings too — a missing model-metadata entry, and a `code-mode-host`
helper it ships separately. Matching on their prose marked correct runs as
"needs attention" once already, and would again for the next warning it adds.

## Interactive approvals: the app-server protocol

**Implemented — opt-in.** The transport is `agentTransport = "app-server"` in
settings, or `transport: "app-server"` on a run. It exists for one reason: `exec`
is one-shot with no channel to answer an approval on, so a mode that asks the
user (`approvalMode = "ask-me"`) cannot work there. The default is still `exec`
until the remaining gaps below are closed. `scripts/probe_app_server.py` drives a
complete turn over the protocol directly, which is how the vocabulary was pinned
down.

`codex app-server --listen stdio://` speaks newline-delimited JSON-RPC. A run is
**three requests**:

```
initialize     {clientInfo:{name,version}}                  -> userAgent, codexHome, platform
thread/start   {model, modelProvider, cwd, approvalPolicy,  -> {thread:{id,…}}
                approvalsReviewer, sandbox}
turn/start     {threadId, input:[{type:"text", text:…}]}     -> {turn}
```

then the turn streams as notifications. Responses are `{"id":N,"result":…}` —
the `jsonrpc` field is not echoed — and notifications are
`{"method":…,"params":…,"emittedAtMs":…}`.

Observed notification vocabulary on a real turn:

```
thread/started  thread/status/changed
turn/started    turn/completed
item/started    item/completed      item/agentMessage/delta
thread/tokenUsage/updated
warning         account/rateLimits/updated   remoteControl/status/changed
```

Two of those are strictly better than what `exec` gives us: **`item/agentMessage/delta`**
streams the answer as it is produced, where `exec` only delivers whole
`agent_message` items, and **`thread/tokenUsage/updated`** reports usage directly
instead of being reconstructed from `turn.completed`.

Approvals arrive as **server-initiated requests** that must be answered, which is
the whole point: `exec` is one-shot with no channel for them, so with
`approvalsReviewer = "user"` a request is auto-denied rather than shown.

The method name is **`item/commandExecution/requestApproval`** — *not*
`execCommandApproval`. The schema still defines the latter, but only as a legacy
spelling; matching the wrong one means the request is never recognised and the
turn waits forever. The full server-request set is
`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
`item/permissions/requestApproval`, `item/tool/requestUserInput`,
`mcpServer/elicitation/request`, `account/chatgptAuthTokens/refresh`,
`attestation/generate` and `currentTime/read`.

The **response** is a bare decision string, which is easy to get subtly wrong:

```
{"decision":"accept"}            run it
{"decision":"acceptForSession"}  run it, and stop asking for this kind
{"decision":"decline"}           skip it; the turn continues
{"decision":"cancel"}            skip it, and interrupt the turn
```

It is not a boolean, and not `{denied:{rejection:…}}`. An unrecognised value
fails the runtime's deserialization, so the request is never really answered and
the turn hangs — this cost a debugging cycle, so the schema is quoted here rather
than paraphrased.

**Verified live, end to end.** With `ask-me` and a local model, asking for a
network command rendered the card (`Approval needed`, the command, and the three
buttons), and clicking *Approve & run* completed the round trip. The OUTPUT panel
is the evidence:

```
[agent] local models run through the tool adapter at http://127.0.0.1:54422/v1
[agent] app-server: thread 01a0b2d5
[agent] the runtime is asking: item/commandExecution/requestApproval
[agent] app-server: turn finished in 61s
```

The turn *finished*. Before the decision string was corrected this same request
left the turn waiting with no answer, which is what "it just sits there" was.

Note that this can only be exercised on **app-server**. `codex exec` is one-shot
with no channel to answer on: given the same command it runs it and reports the
sandbox's refusal rather than asking, which is why `ask-me` selects the other
transport.

Two more things the schema settles:

- **`turn/interrupt` requires `threadId` *and* `turnId`.** Both are `required`.
  The turn id comes back in the `turn/start` reply and again in the
  `turn/started` notification; the session stores both paths.
- **`error` notifications carry `willRetry`.** A retrying error is transport
  trouble (`"Reconnecting... waiting for network"`), not the end of the turn; a
  non-retrying one is. Treating a retrying error as terminal ends correct runs.

Generate the full definition from the binary rather than guessing — it ships the
schema and TypeScript bindings:

```bash
codex app-server generate-json-schema --out /tmp/cx-schema
codex app-server generate-ts --out /tmp/cx-ts
```

What the transport now does, all covered by
`tests::agent_session_correlates_replies_and_forwards_the_rest` (a scripted
stand-in for the runtime) and `tests::a_turn_completes_over_the_real_runtime`
(the real binary against a local Ollama, `#[ignore]`d because it needs a reachable
provider and localhost):

- a long-lived child instead of a process per run
- request/response correlation by id, with a shared reply map
- notification forwarding, including `item/agentMessage/delta` streaming
- approval requests surfaced to the UI, and the answer written back over the
  same pipe (`AgentSession::respond`, the path the UI command uses)
- lifecycle: one session at a time, superseded sessions stay silent, exit on
  stdout EOF (stderr closes early while the process stays alive — that is not an
  exit). The supersede has to happen **before** the outgoing process is killed:
  otherwise its EOF is read as the new run's exit and the run ends the instant it
  begins — an empty answer on the second message of a session, never the first
  ("turn finished in 0s"). `a_superseded_session_exits_quietly_and_the_current_one_does_not`
  holds that order in place.
- attachments, the model catalog, `--oss` local providers and thread continuity,
  because the credential and `CODEX_HOME` are set the same way `exec` sets them

Still open before this becomes the default:

- **steering** (`turn/steer`) is not wired to the UI
- **the approval card lives in the composer**, so on a long transcript it can be
  below the fold
- **`--listen` also supports `unix://` and `ws://`**, and there is a `daemon`
  subcommand for a shared instance — neither is used
- **the local tool adapter is a process to look after** — it is started on demand
  and reused per provider, but nothing restarts it if it dies mid-run.

## Local models and tools: why this adapter exists

An agent run on a local model reads and replies but never edits a file or runs a
command. It looks like a broken agent; it is an upstream shape mismatch. Measured,
not guessed:

1. **The runtime requires the Responses API.** `wire_api = "chat"` is a hard
   config error on this binary ("no longer supported"), and `ollama` is a
   reserved provider id that cannot be pointed elsewhere — a custom table has to
   use a different name.
2. **The runtime does send tools.** With a logging proxy in front of the
   provider, the request to `/v1/responses` carried nine of them — `exec_command`,
   `write_stdin`, `request_user_input`, `view_image`, the subagent tools, the goal
   tools. The agent is trying to delegate them.
3. **Ollama's Responses endpoint drops them.** A direct
   `POST /v1/responses` with a `tools` array (Ollama 0.34.1) answers with the tool
   call rendered as *plain text* and never emits a `function_call` item. So the
   runtime receives prose where an action should be, and executes nothing.
4. **Ollama's native API is fine.** `POST /api/chat` with the same tool returns a
   real `tool_calls` for `llama3.2:3b` and `qwen3.5:9b`. (It does not for
   `qwen2.5-coder:1.5b` or `:7b` — those models cannot tool-call at all, which is
   a second, independent reason to try a tool-trained model.)

So the break is the Responses shim, not the model and not us — and it is now
fixed by **`core-engine/responses_adapter.py`**: it speaks `/v1/responses` to the
runtime, proxies to Ollama's `/api/chat`, and translates tool calls and results
both ways. Stdlib only, reached as `acsa-engine adapter --port N`.

Verified through that entry point, with no API key set: with a provider table
pointed at the adapter and `llama3.2:3b` as the model,
`codex exec "Run the shell command: echo adapter-e2e-ok"` returned
`item.completed command_execution … aggregated_output: "adapter-e2e-ok\n",
exit_code: 0`. Ollama's `prompt_eval_count` / `eval_count` come back as Responses
usage, so local runs report real tokens.

Two shapes cost the most time and are asserted in `tests/test_responses_adapter.py`:
Ollama wants tool-call `arguments` as an **object** (the Responses string is a 400,
"Value looks like object, but can't find closing '}'"), and small models fill
optional fields with guesses the runtime's strict schemas reject
(`"yield_time_ms": null` → "expected u64"; `"prefix_rule": ""` → "expected a
sequence"). The tool's own `parameters` is in the request, so an argument that
cannot match its declared type is dropped rather than forwarded to fail.

The app wires this in `usePipeline.ts`: a local provider starts the adapter and
gets a normal `[model_providers.acsa-local]` table (not `ollama` — that id is
reserved and cannot be overridden), with no `env_key` because a local runtime has
no credential. If the adapter cannot start, the run falls back to the runtime's
own `--oss --local-provider` path and says so in the OUTPUT panel, because that
path reaches the model but cannot run tools.
