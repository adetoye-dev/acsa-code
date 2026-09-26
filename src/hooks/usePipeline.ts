/**
 * usePipeline.ts — Agent runs and project workspace state.
 *
 * Connects the workbench to real files, real processes and the agent runtime:
 * 1. Native folder picking (via macOS osascript / Tauri dialog).
 * 2. Real filesystem reading and writing to physical disk via Tauri IPC.
 * 3. Real project template scaffolding on physical disk.
 * 4. Agent tasks executed by the Codex runtime, streamed into the chat.
 * 5. Multi-provider AI support (Ollama, OpenAI-compatible APIs, local models).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { FileNode } from "../components/FileTree";
import type { OpenFileTab } from "../types/workbench";
import type { AISettings } from "../components/SettingsModal";
import type { PipelineOutputLine, PipelineStatus } from "../types/telemetry";
import { DESKTOP_REQUIRED_MESSAGE } from "../services/engineBridge";
import type { AgentStep } from "../services/aiChatService";
import {
  getActiveSelectedModel,
  isModelVisionCapable,
  loadAllProviders,
} from "../services/aiModelManager";
import {
  AGENT_APPROVAL_MODES,
  DEFAULT_AGENT_APPROVAL_MODE,
  DEFAULT_AGENT_TRANSPORT,
  localProviderFor,
  localToolCallingNote,
  resolveApprovalMode,
  type AgentApprovalMode,
  type AgentTransport,
  type ApprovalDecision,
} from "../services/agentApproval";
import { ensureProvidersHydrated } from "../services/aiModelManager";
import {
  DEFAULT_TURN_LIMIT_MINUTES,
  shouldStopTurn,
  turnLimitNotice,
} from "../services/agentTurnLimit";
import { restoreTurnSnapshot, takeTurnSnapshot } from "../services/turnSnapshot";

/**
 * The provider id a local run uses once the tool adapter is in front of it.
 *
 * It cannot be `ollama`: that id is built into the runtime, and a
 * `[model_providers.ollama]` table is a hard config error ("Built-in providers
 * cannot be overridden").
 */
const LOCAL_ADAPTER_PROVIDER_ID = "acsa-local";

/**
 * Provider ids the runtime ships itself. Offering one as our own
 * `[model_providers.*]` table does not just lose to the built-in — it is a **hard
 * config error**, so the whole config is refused and the run silently proceeds
 * against whatever the runtime defaults to. Asked the binary directly, offering
 * all thirteen of our ids in one file, it names exactly these:
 *
 *     Error loading config.toml: model_providers contains reserved built-in
 *     provider IDs: `lmstudio`, `ollama`, `openai`
 *
 * That is why OpenAI models answered in prose and touched no files while
 * DeepSeek edited them: only `openai` of our hosted ids is reserved. Verified by
 * running one task headlessly against both providers with nothing else changed —
 * with the id renamed, `gpt-5.3-codex` made 12 command calls and changed the file.
 *
 * The list is asserted in `usePipeline.agentProtocol.test.ts`, so a new id here
 * fails the suite rather than the user's run.
 */
export const RESERVED_RUNTIME_PROVIDER_IDS = ["openai", "ollama", "lmstudio"] as const;

/**
 * The id our generated provider table uses for a hosted provider.
 *
 * Every hosted id is namespaced, not only the reserved ones: the runtime's
 * built-in list is not ours to keep up with, and a collision costs a confusing
 * silent fallback rather than an error the user could act on.
 */
export function hostedProviderId(providerId: string): string {
  return `acsa-${providerId}`;
}

/**
 * Start the local-model tool adapter and return its Responses base URL.
 *
 * Best effort by design: a build without the adapter still runs, just without
 * tool calls, and the caller logs which of the two happened.
 */
async function startLocalToolAdapter(providerId: string): Promise<string | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const url = await invoke<string>("local_adapter_start", { providerId });
    return typeof url === "string" && url.startsWith("http") ? url : null;
  } catch {
    return null;
  }
}


/**
 * Run an agent task on Codex, when its runtime is present.
 *
 * Replaces our own loop, which could not do native tool calling: the model narrated
 * `read_file` in prose and the harness answered with a guard message, so nothing was
 * ever edited. Verified by driving Codex headlessly against a configured provider — it
 * edited a file correctly and streamed `thread`/`turn`/`item` events.
 *
 * Returns true when Codex handled the run (including a mid-run failure, so the caller
 * does not then also run our pipeline and edit the project twice). False means the
 * runtime is absent and the caller should fall back.
 */
async function runAgent(params: {
  prompt: string;
  projectRoot: string;
  /** Which runtime to use. `exec` is the long-standing path. */
  transport?: AgentTransport;
  /** The runtime wants an answer before it can continue (app-server only). */
  onApproval?: (request: {
    id: unknown;
    method: string;
    params: any;
    changes?: PendingFileChange[];
  }) => void;
  /** The runtime says it is blocked on the human (`thread/status/changed`). */
  onWaitingForUser?: (status: string) => void;
  /** A `request_user_input` question, which needs answers, not a decision. */
  onQuestion?: (request: { id: unknown; questions: AgentQuestion[] }) => void;
  /**
   * Called immediately before the turn is handed to the runtime — the last moment
   * the pre-turn state can still be read. See `undoLastTurn`.
   */
  onBeforeTurn?: () => Promise<void>;
  /** Provider/model the user picked for this message; wins over the saved default. */
  selection?: { providerId: string; model: string };
  /** How much the agent may do unattended. Defaults to "approve for me". */
  approvalMode?: AgentApprovalMode;
  onEvent: (event: any) => void;
  log: (line: string) => void;
  /** Something the run itself should say, beyond the model's own messages. */
  note?: (note: { name: string; detail: string; status: "done" | "failed" }) => void;
  /** Continue this thread instead of starting a new one. */
  resumeThreadId?: string;
  /** `data:` URLs from the composer; written to files and passed with `-i`. */
  images?: string[];
  /** Called with the thread that ran, so the caller can resume it next time. */
  onThread?: (threadId: string) => void;
  /** Why the run failed, in words the chat can show. */
  onFailure?: (detail: string) => void;
}): Promise<"unavailable" | "success" | "failed"> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const { getActiveSelectedModel, loadAllProviders } = await import("../services/aiModelManager");

  // The chat's model picker is per-message, so it is passed in. Without it the agent
  // silently ran on the saved default — which is how a run could use a different model
  // than the one shown in the composer.
  const saved = getActiveSelectedModel() as { providerId?: string; model?: string } | null;
  const providers = loadAllProviders() as Record<string, any>;
  const providerId =
    params.selection?.providerId ||
    saved?.providerId ||
    (Object.values(providers).find((p: any) => p.isDefault) as any)?.id;
  const provider = providerId ? providers[providerId] : undefined;
  const model = params.selection?.model || saved?.model || provider?.selectedModel;
  params.log(
    `[agent] codex: provider=${providerId ?? "none"} model=${model ?? "none"} baseUrl=${
      provider?.baseUrl ? "set" : "missing"
    }`,
  );
  if (!providerId || !model || !provider?.baseUrl) return "unavailable";

  const approval =
    AGENT_APPROVAL_MODES[params.approvalMode ?? DEFAULT_AGENT_APPROVAL_MODE] ??
    AGENT_APPROVAL_MODES[DEFAULT_AGENT_APPROVAL_MODE];

  // `wire_api` must be "responses": this Codex version rejects "chat" outright. The key
  // name matches what the Rust side sets in the child's environment, so the credential
  // itself never travels over IPC.
  //
  // Approvals: `approval_policy = "never"` DENIES tool calls that need approval (the
  // runtime says "requires approval, but approval policy is never"), so the working
  // default routes them through the automatic reviewer instead. Verified against the
  // binary: `on-request` + `auto_review` completes tool calls that `never` refuses.
  //
  // A local runtime needs help that a hosted one does not. Ollama's Responses
  // API accepts `tools` and drops them, so a local model reads and replies and
  // never acts. The adapter speaks Responses to the runtime and Ollama's native
  // `/api/chat` to the model, which is where tool calls actually work.
  const localProvider = localProviderFor(providerId);
  const adapterBaseUrl = localProvider ? await startLocalToolAdapter(providerId) : null;
  if (adapterBaseUrl) {
    params.log(`[agent] local models run through the tool adapter at ${adapterBaseUrl}`);
  } else {
    // No adapter: fall back to the runtime's own local-provider switch, which
    // reaches the model but cannot run tools. Say so rather than let an empty run
    // look like a broken agent.
    const note = localToolCallingNote(providerId);
    if (note) params.log(note);
  }
  // With the adapter the provider is a plain Responses endpoint, so it gets a
  // table like any hosted provider — under a name of its own, because `ollama`
  // is reserved and cannot be overridden.
  const runtimeProviderId = adapterBaseUrl ? LOCAL_ADAPTER_PROVIDER_ID : hostedProviderId(providerId);
  const runtimeBaseUrl = adapterBaseUrl ?? provider.baseUrl;
  const runtimeProviderName = adapterBaseUrl ? "Local models (ACSA tool adapter)" : provider.name || providerId;
  const configToml = [
    `model = "${model}"`,
    ...(localProvider && !adapterBaseUrl ? [] : [`model_provider = "${runtimeProviderId}"`]),
    `approval_policy = "${approval.approvalPolicy}"`,
    `approvals_reviewer = "${approval.approvalsReviewer}"`,
    `sandbox_mode = "${approval.sandboxMode}"`,
    // Host skills, the plugin marketplace, the structured-question gate and the
    // under-development warning. Each one, and why, is documented once on
    // `AGENT_RUNTIME_FLAGS` — this app has been bitten twice by writing the
    // wrong thing into this config, so it is asserted there rather than only
    // appearing here.
    ...AGENT_RUNTIME_FLAGS,
    ...(localProvider && !adapterBaseUrl
      ? []
      : [
          "",
          `[model_providers.${runtimeProviderId}]`,
          `name = "${runtimeProviderName}"`,
          `base_url = "${runtimeBaseUrl}"`,
          // A local runtime has no credential, and `env_key` naming a variable
          // that is not set is a startup failure. Hosted providers still get it.
          ...(adapterBaseUrl ? [] : ['env_key = "ACSA_CODEX_API_KEY"']),
          'wire_api = "responses"',
        ]),
  ].join("\n");

  // Codex ships metadata only for its own models, so without a catalog entry for ours it
  // warns that it is "defaulting to fallback metadata" — the error the UI was showing.
  // Verified against a working Codex install: `model_catalog_json` must point at a FILE
  // (an inline value parses without error and is silently ignored), and this field set
  // mirrors a known-good catalog. Context window is conservative on purpose; too small
  // only compacts earlier.
  const catalogJson = JSON.stringify(
    {
      models: (provider.availableModels?.length ? provider.availableModels : [model]).map(
        (slug: string) => agentCatalogEntry(providerId, provider.name || providerId, slug),
      ),
    },
    null,
    2,
  );

  let sawEvent = false;
  // Installed MCP servers, emitted in Codex's own format so what the marketplace installs
  // is actually usable by the agent. Shape taken from a working Codex install:
  // `[mcp_servers.x]` with either `command`+`args` or a streamable-HTTP `url`, and an
  // optional `[mcp_servers.x.env]` table. Read from our registry rather than written into
  // Codex's config by the engine, because this run regenerates that config each time.
  // Checked against the bundled runtime: with this exact shape on disk,
  // `codex mcp list` reports the server as `enabled`.
  let mcpToml = "";
  try {
    const { marketplaceFetch } = await import("../services/marketplaceClient");
    const res = await marketplaceFetch(
      `/api/mcp/servers?projectRoot=${encodeURIComponent(params.projectRoot)}`,
    );
    const servers = ((await res.json())?.servers ?? {}) as Record<string, any>;
    for (const [id, cfg] of Object.entries(servers)) {
      if (!cfg || typeof cfg !== "object") continue;
      if (cfg.url) {
        mcpToml += `\n[mcp_servers.${id}]\nurl = "${cfg.url}"\n`;
        continue;
      }
      if (!cfg.command) continue;
      mcpToml += `\n[mcp_servers.${id}]\ncommand = "${cfg.command}"\n`;
      if (Array.isArray(cfg.args)) {
        mcpToml += `args = [${cfg.args.map((a: any) => `"${String(a)}"`).join(", ")}]\n`;
      }
      if (cfg.env && typeof cfg.env === "object") {
        mcpToml += `\n[mcp_servers.${id}.env]\n`;
        for (const [key, value] of Object.entries(cfg.env)) mcpToml += `${key} = "${value}"\n`;
      }
    }
    if (mcpToml) params.log(`[agent] codex: passing ${Object.keys(servers).length} MCP server(s) to the agent`);
  } catch {
    /* MCP is optional; a registry that cannot be read must not block the run */
  }

  if (params.transport === "app-server") {
    return runAgentOnAppServer({
      prompt: params.prompt,
      projectRoot: params.projectRoot,
      configToml: configToml + mcpToml,
      // Same two ids the exec path uses, so both transports reach the same provider
      // and resolve the same credential.
      providerId,
      runtimeProviderId,
      images: params.images,
      catalogJson,
      model,
      approvalMode: params.approvalMode ?? DEFAULT_AGENT_APPROVAL_MODE,
      resumeThreadId: params.resumeThreadId,
      onEvent: params.onEvent,
      log: params.log,
      note: params.note,
      onThread: params.onThread,
      onFailure: params.onFailure,
      onApproval: params.onApproval,
      onWaitingForUser: params.onWaitingForUser,
      onQuestion: params.onQuestion,
      onBeforeTurn: params.onBeforeTurn,
    });
  }

  let finished = false;
  let failed = false;
  // Did the run actually *do* anything? A model that cannot drive the tool
  // protocol answers in prose — or writes the tool call out as text — and the
  // turn still completes. Observed with a local 7B coder: it emitted
  // `{"name":"spawn_agent",…}` as its message, edited nothing, and the run
  // reported success. Saying so is the difference between a silent no-op and a
  // diagnosable one.
  // Boxed for the same reason as `usageBox` below.
  const toolCallCount = { value: 0 };
  // The id of the thread this run is using, so the caller can resume it.
  const threadIdBox: { value: string } = { value: params.resumeThreadId || "" };
  // Token counts arrive on their own event just before `codex:exit`; the ledger
  // is the only place a run's real cost shows up, so they are worth carrying.
  // Boxed because it is written from a listener closure: a bare `let` would be
  // narrowed to `null` at the read below, since TypeScript cannot see the write.
  const usageBox: { value: { promptTokens: number; completionTokens: number } | null } = {
    value: null,
  };
  const startedAt = Date.now();
  const unlisten: Array<() => void> = [];
  try {
    unlisten.push(
      await listen<{ line?: string } | string>("codex:event", (event) => {
        sawEvent = true;
        // Rust emits `AiFrame { line }` — a struct. Reading the payload as a string
        // yields "[object Object]", so nothing rendered at all. Same shape mistake as
        // the chat and terminal streams; the field is the point.
        const payload = event.payload;
        const line = typeof payload === "string" ? payload : String(payload?.line ?? "");
        if (!sawEvent) params.log(`[agent] codex: first frame — ${line.slice(0, 180)}`);
        try {
          const parsed = JSON.parse(line);
          const itemType = parsed?.item?.type;
          // The stream says plainly whether the turn failed. Error *items* are not
          // failures: Codex emits them for warnings too — a missing model metadata
          // entry, and a `code-mode-host` helper it ships separately. Matching on
          // their prose marked a run that edited the file correctly as "needs
          // attention", and would have done it again for the next warning it adds.
          if (parsed?.type === "turn.failed") failed = true;
          if (itemType === "error") {
            params.log(`[agent] codex warning — ${String(parsed?.item?.message ?? "")}`);
          }
          // Remembered for the next turn: `resume` continues this thread rather
          // than starting from nothing.
          if (parsed?.type === "thread.started" && parsed?.thread_id) {
            threadIdBox.value = String(parsed.thread_id);
          }
          if (
            itemType === "command_execution" ||
            itemType === "file_change" ||
            itemType === "mcp_tool_call" ||
            itemType === "web_search"
          ) {
            toolCallCount.value += 1;
          }
          params.onEvent(parsed);
        } catch {
          /* a partial or non-JSON line carries nothing to show */
        }
      }),
    );
    unlisten.push(
      await listen<{ line?: string } | string>("codex:usage", (event) => {
        const payload = event.payload;
        const line = typeof payload === "string" ? payload : String(payload?.line ?? "");
        try {
          const parsed = JSON.parse(line);
          usageBox.value = {
            promptTokens: Number(parsed?.promptTokens) || 0,
            completionTokens: Number(parsed?.completionTokens) || 0,
          };
        } catch {
          /* no counts to record */
        }
      }),
    );
    unlisten.push(
      await listen<string>("codex:exit", (event) => {
        finished = true;
        const note = String(event.payload ?? "").trim();
        params.log(`[agent] codex: exited${note ? ` — ${note.slice(0, 180)}` : ""}`);
      }),
    );

    try {
      await invoke("codex_exec", {
        prompt: params.prompt,
        projectRoot: params.projectRoot,
        configToml: configToml + mcpToml,
        // Two ids, because they answer different questions. `providerId` keys the
        // credential we resolve shell-side (`{provider}_api_key`); `runtimeProviderId`
        // is what the generated table and the runtime's routing use.
        providerId,
        runtimeProviderId,
        catalogJson,
        model,
        localProvider: adapterBaseUrl ? null : localProvider,
        resumeThreadId: params.resumeThreadId,
        images: params.images ?? [],
      });
      params.log("[agent] codex: runtime started");
    } catch (error) {
      // A missing or unusable runtime has to be visible here — otherwise it is
      // indistinguishable from a run that simply produced no events.
      params.log(`[agent] codex: not started — ${String(error)}`);
      return "unavailable";
    }

    // Wait for the stream to end, so the caller only continues once the run is over.
    for (let i = 0; i < 7200 && !finished; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (threadIdBox.value) params.onThread?.(threadIdBox.value);
    const usage = usageBox.value;
    if (usage) {
      // Fire and forget: a spent ledger row must not delay the chat's own update,
      // and the engine computes the cost from its pricing table.
      const elapsed = Date.now() - startedAt;
      void (async () => {
        try {
          const { engineCall } = await import("../services/engineBridge");
          await engineCall("db", [
            "usage.record",
            JSON.stringify({
              provider: providerId,
              model,
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              latencyMs: elapsed,
              projectPath: params.projectRoot,
            }),
          ]);
        } catch {
          /* metering is diagnostics; never let it surface as a run failure */
        }
      })();
    }
    if (toolCallCount.value === 0 && !failed) {
      // A run that finished without touching a single tool is either a genuine
      // question or a model that could not act. Both are worth one line, because
      // the second looks identical to the first from the transcript.
      params.note?.({
        name: "No tools used",
        detail:
          "The model replied without running any tool, so nothing in the project changed.",
        status: "done",
      });
      params.log(
        "[agent] no tool calls this run. If you asked for a change, the model could not drive " +
          "tool calling — smaller local models often cannot. Try a cloud model or a larger local one.",
      );
    }
    return failed ? "failed" : "success";
  } catch {
    // A missing runtime is the expected miss and the caller must fall back. Anything
    // thrown after a real event is a mid-run failure, which is ours to report rather
    // than retry underneath — retrying would edit the project twice.
    return sawEvent ? (failed ? "failed" : "success") : "unavailable";
  } finally {
    unlisten.forEach((off) => off());
  }
}

/**
 * Run an agent task over the app-server protocol.
 *
 * The difference from `exec` is not the transport so much as what the runtime
 * can do once it is a live session: it streams the answer as it is written,
 * it can be interrupted mid-turn, and — the reason for the whole exercise — it
 * can *ask* before running something, which `exec` has no channel for.
 *
 * Requests and replies are matched by id on the Rust side; this only maps
 * notifications onto the progress surfaces the chat already renders.
 */
async function runAgentOnAppServer(params: {
  prompt: string;
  projectRoot: string;
  configToml: string;
  /** Keys the credential, shell-side. */
  providerId: string;
  /** Routes inside the runtime; namespaced so it cannot be a built-in name. */
  runtimeProviderId: string;
  /** Data URLs from the composer, delivered as `input_image` items with the turn. */
  images?: string[];
  catalogJson: string;
  model: string;
  approvalMode: AgentApprovalMode;
  resumeThreadId?: string;
  onEvent: (event: any) => void;
  log: (line: string) => void;
  note?: (note: { name: string; detail: string; status: "done" | "failed" }) => void;
  onThread?: (threadId: string) => void;
  onFailure?: (detail: string) => void;
  /** A request the runtime needs an answer to before it can continue. */
  onApproval?: (request: {
    id: unknown;
    method: string;
    params: any;
    changes?: PendingFileChange[];
  }) => void;
  /**
   * The runtime says it is blocked on the human — `waitingOnUserInput` after a
   * skill asked a question, `waitingOnApproval` before running something.
   *
   * Nothing consumed `thread/status/changed` before this, so an agent that had
   * stopped to ask looked exactly like one that had finished.
   */
  onWaitingForUser?: (status: string) => void;
  /** A `request_user_input` question, which needs answers, not a decision. */
  onQuestion?: (request: { id: unknown; questions: AgentQuestion[] }) => void;
  /** Called immediately before the turn is handed to the runtime. See `undoLastTurn`. */
  onBeforeTurn?: () => Promise<void>;
}): Promise<"unavailable" | "success" | "failed"> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  const approval =
    AGENT_APPROVAL_MODES[params.approvalMode] ?? AGENT_APPROVAL_MODES[DEFAULT_AGENT_APPROVAL_MODE];

  let finished = false;
  let failed = false;
  // Set by turn/completed or turn/failed — the only signals that end a turn.
  const turnFinished = { value: false };
  const failureBox: { value: string } = { value: "" };
  const unlisten: Array<() => void> = [];
  const startedAt = Date.now();

  // Thread items the runtime has announced, by id. A file-change approval names
  // only an `itemId`, so the announced item is the only place the paths and the
  // diff exist. Bounded: a long turn announces a lot of items and only the recent
  // ones can still be waiting on an answer.
  const announcedItems = new Map<string, unknown>();

  try {
    unlisten.push(
      await listen<{ line?: string } | string>("agent:event", (event) => {
        const payload = event.payload;
        const line = typeof payload === "string" ? payload : String(payload?.line ?? "");
        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        const method = String(parsed?.method ?? "");

        // A message with an id *and* a method is a request from the runtime —
        // an approval. It blocks the turn until answered, so it goes straight to
        // the UI rather than into the transcript.
        if (method && parsed?.id !== undefined) {
          // A question's payload is not a secret, and its shape is exactly what an
          // answer has to match — so it is the one request worth showing in full
          // when someone is working out why a turn is holding.
          const detail =
            method === "item/tool/requestUserInput"
              ? ` ${JSON.stringify(parsed.params ?? {}).slice(0, 600)}`
              : "";
          params.log(`[agent] the runtime is asking: ${method}${detail}`);
          if (method === "item/tool/requestUserInput") {
            params.onQuestion?.({
              id: parsed.id,
              questions: Array.isArray(parsed.params?.questions)
                ? (parsed.params.questions as AgentQuestion[])
                : [],
            });
          } else {
            const itemId = String(parsed.params?.itemId ?? "");
            params.onApproval?.({
              id: parsed.id,
              method,
              params: parsed.params,
              changes: summarizeItemChanges(announcedItems.get(itemId)),
            });
          }
          return;
        }

        // Remember the item itself, so an approval that arrives later can say
        // what it is about to change.
        if (method === "item/started" || method === "item/completed") {
          const item = parsed?.params?.item;
          const itemId = String(item?.id ?? "");
          if (itemId) {
            announcedItems.set(itemId, item);
            if (announcedItems.size > 50) {
              const oldest = announcedItems.keys().next().value;
              if (oldest !== undefined) announcedItems.delete(oldest);
            }
          }
        }

        if (method === "turn/completed" || method === "turn/failed") {
          turnFinished.value = true;
        }

        // The runtime narrates its own state, including the two that mean it is
        // blocked on a person. Set on *every* status change, not only a waiting
        // one: an approval that gets answered moves the thread on, and a flag
        // that is only ever raised leaves a finished run claiming to be waiting.
        if (method === "thread/status/changed") {
          params.onWaitingForUser?.(waitingStatusIn(parsed?.params));
        }

        if (method === "turn/failed") {
          failed = true;
          const detail = String(
            parsed?.params?.error?.message ??
              parsed?.params?.error ??
              "the agent turn failed",
          );
          failureBox.value = detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
        }
        params.onEvent(parsed);
      }),
    );
    unlisten.push(
      // The runtime's own warnings and errors. Worth surfacing: a missing model
      // entry or an unsupported feature shows up here and nowhere else.
      await listen<{ line?: string } | string>("agent:stderr", (event) => {
        const payload = event.payload;
        const line = (typeof payload === "string" ? payload : String(payload?.line ?? "")).trim();
        if (line) params.log(`[agent] runtime: ${line.slice(0, 200)}`);
      }),
    );
    unlisten.push(
      await listen<{ line?: string } | string>("agent:exit", (event) => {
        // Emitted when the runtime's stdout reaches EOF — the real exit. It no
        // longer fires when stderr closes, which the runtime does early while
        // staying alive.
        finished = true;
        turnFinished.value = true;
        // Same frame as the other two agent channels; unwrap it the same way, or
        // the note prints as "[object Object]".
        const payload = event.payload;
        const note = (typeof payload === "string" ? payload : String(payload?.line ?? "")).trim();
        params.log(`[agent] app-server exited${note ? ` — ${note.slice(0, 180)}` : ""}`);
      }),
    );

    let threadId: string;
    // Same reason as the exec path: a local provider cannot run tools on this
    // transport either, and a silent run is worse than a stated one.
    {
      const note = localToolCallingNote(params.providerId);
      if (note) params.log(note);
    }
    try {
      threadId = await invoke<string>("agent_start", {
        projectRoot: params.projectRoot,
        configToml: params.configToml,
        providerId: params.providerId,
        runtimeProviderId: params.runtimeProviderId,
        catalogJson: params.catalogJson,
        model: params.model,
        resumeThreadId: params.resumeThreadId ?? null,
        // The mode decides this, not the transport: `ask-me` is the whole point
        // of being on app-server.
        approvalPolicy: approval.approvalPolicy,
        approvalsReviewer: approval.approvalsReviewer,
        sandboxMode: approval.sandboxMode,
      });
    } catch (error) {
      params.log(`[agent] app-server: not started — ${String(error)}`);
      return "unavailable";
    }
    if (threadId) params.onThread?.(threadId);
    params.log(`[agent] app-server: thread ${threadId.slice(0, 8)}`);

    try {
      // Before the runtime touches anything: the pre-turn state, so the turn can
      // be undone. Best effort — see `takeTurnSnapshot`.
      await params.onBeforeTurn?.();
      // Same gate as the exec path, for the same reason: an image the model cannot
      // read is a provider 400 the runtime retries five times before failing the
      // turn. Declaring it here as well keeps the two transports honest about the
      // same model — this path used to drop every image instead.
      const turnImages = isModelVisionCapable(params.providerId, params.model)
        ? params.images ?? []
        : [];
      if ((params.images?.length ?? 0) > 0 && turnImages.length === 0) {
        params.log(
          `[agent] ${params.images!.length} image(s) not attached: ${params.model} does not take image input. Pick a vision model, or say what is in the image.`,
        );
      }
      await invoke("agent_turn", { text: params.prompt, images: turnImages });
    } catch (error) {
      params.log(`[agent] app-server: turn rejected — ${String(error)}`);
      return "unavailable";
    }

    // Wait for the turn to end. The ceiling matches the run budget; a live
    // session means "still running" is visible, so this is only a backstop.
    const deadline = Date.now() + 3600_000;
    while (!finished && !failed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (turnFinished.value) break;
    }

    if (failed && failureBox.value) params.onFailure?.(failureBox.value);
    params.log(`[agent] app-server: turn finished in ${Math.round((Date.now() - startedAt) / 1000)}s`);
    return failed ? "failed" : "success";
  } catch (error) {
    params.log(`[agent] app-server: ${String(error)}`);
    return "unavailable";
  } finally {
    unlisten.forEach((off) => off());
  }
}

/**
 * Map one app-server notification onto the chat's progress surfaces.
 *
 * The vocabulary differs from `exec`'s: camelCase item types, a dedicated delta
 * channel for the answer, and usage as its own notification rather than a field
 * on the turn event.
 */
export function applyAppServerEvent(
  event: any,
  update: {
    setSteps: (fn: (prev: any[]) => any[]) => void;
    appendAnswer: (text: string) => void;
    setAnswer: (text: string) => void;
    logOutput: (line: any) => void;
    markTouched: (paths: string[]) => void;
    recordChanges?: (changes: PendingFileChange[]) => void;
    fail: (detail: string) => void;
  },
): void {
  const method = String(event?.method ?? "");
  const p = event?.params ?? {};

  // The runtime reports transport trouble as its own notification — "Reconnecting…
  // waiting for network", with a retry delay. Without this it retried silently
  // for minutes and the run looked like it had simply stopped.
  if (method === "error") {
    const message = String(p.error?.message ?? p.message ?? "the runtime reported an error");
    const retrying = p.willRetry ? " (retrying)" : "";
    update.logOutput({
      line_number: 0,
      content: `${message}${retrying}`,
      stream: p.willRetry ? "stdout" : "stderr",
      is_json: false,
    });
    // An error the runtime will not retry is the end of the turn. Without this
    // the run finished instantly and reported success — which is how a missing
    // API key looked like "Task completed."
    if (!p.willRetry) {
      update.fail?.(message);
    }
    return;
  }

  if (method === "item/agentMessage/delta" && typeof p.delta === "string") {
    update.appendAnswer(p.delta);
    return;
  }

  if (method !== "item/completed" || !p.item) return;
  const item = p.item;

  if (item.type === "agentMessage" && typeof item.text === "string") {
    // Authoritative: the streamed deltas are a preview of exactly this.
    update.setAnswer(item.text);
    return;
  }
  if (item.type === "commandExecution") {
    update.setSteps((prev) => {
      const step = {
        id: item.id || `as-${Date.now()}-${prev.length}`,
        name: "Run Command",
        detail: String(item.command || "").slice(0, 120),
        status: item.exitCode === 0 || item.exitCode === undefined ? "done" : "failed",
      };
      const idx = prev.findIndex((s: any) => s.id === step.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...step };
        return next;
      }
      return [...prev, step];
    });
    return;
  }
  if (item.type === "fileChange") {
    const changed: string[] = Array.isArray(item.changes)
      ? item.changes
          .map((c: any) => String(c?.path ?? ""))
          .filter((path: string) => path.length > 0)
      : [];
    if (changed.length > 0) {
      update.markTouched(changed);
      // The item carries the diff too, which is what makes a change summary
      // possible: turn-scoped, and it counts only what the agent did — unlike a
      // `git diff`, which would also count the user's own uncommitted edits.
      update.recordChanges?.(summarizeItemChanges(item));
      update.setSteps((prev) => [
        ...prev,
        {
          id: `as-edit-${changed.join("|").slice(0, 60)}`,
          name: "Edit Files",
          detail: changed.map((path) => path.split(/[\\/]/).pop()).join(", ").slice(0, 120),
          status: "done",
        },
      ]);
    }
  }
}

/**
 * Compose the single string the agent runtime receives.
 *
 * The runtime is a one-shot process, so everything the user attached to the
 * message has to travel inside the prompt: the file they are looking at, the
 * code they selected, and the recent turns. Dropping these silently is how
 * "can you fix this?" arrived with no subject.
 */
function buildAgentPrompt(
  request: string,
  activeFilePath?: string,
  selectedCode?: string,
  history?: Array<{ role: string; content: string }>,
): string {
  const parts: string[] = [];
  if (activeFilePath) parts.push(`Active file: ${activeFilePath}`);
  if (selectedCode) {
    parts.push(
      [
        "The user selected this code in the editor. Treat it as the subject of the request:",
        "```",
        selectedCode,
        "```",
      ].join("\n"),
    );
  }
  parts.push(request);
  if (history && history.length > 0) {
    const transcript = history
      .filter((m) => m && m.content)
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");
    if (transcript) {
      parts.push(`Earlier in this conversation:\n\n${transcript}`);
    }
  }
  return parts.join("\n\n");
}

/**
 * Map one Codex stream event onto the progress surfaces the chat already renders.
 * Separate from the runner so the mapping is readable and testable on its own.
 */
export function applyCodexEvent(
  event: any,
  update: {
    setSteps: (fn: (prev: any[]) => any[]) => void;
    appendAnswer: (text: string) => void;
    logOutput: (line: any) => void;
    markTouched: (paths: string[]) => void;
    recordChanges?: (changes: PendingFileChange[]) => void;
  },
): void {
  if (event?.type === "thread.started") {
    update.setSteps(() => []);
    return;
  }
  const item = event?.item;
  if (event?.type !== "item.completed" || !item) return;

  if (item.type === "agent_message" && item.text) {
    update.appendAnswer(String(item.text));
    return;
  }
  if (item.type === "command_execution") {
    update.setSteps((prev) => {
      const step = {
        id: item.id || `codex-${Date.now()}-${prev.length}`,
        name: "Run Command",
        detail: String(item.command || "").slice(0, 120),
        status: item.exit_code === 0 || item.exit_code === undefined ? "done" : "failed",
      };
      const idx = prev.findIndex((s: any) => s.id === step.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...step };
        return next;
      }
      return [...prev, step];
    });
    return;
  }
  if (item.type === "file_change") {
    // Codex reports each edited file here. Surfacing them marks the file tree, so a
    // run that touched six files is visible without reading the transcript.
    const changed: string[] = Array.isArray(item.changes)
      ? item.changes
          .map((c: any) => String(c?.path ?? c?.file ?? ""))
          .filter((p: string) => p.length > 0)
      : [];
    if (changed.length > 0) {
      update.markTouched(changed);
      update.setSteps((prev) => {
        const step = {
          id: `codex-edit-${changed.join("|").slice(0, 80)}`,
          name: "Edit Files",
          detail: changed.map((p) => p.split(/[\\/]/).pop()).join(", ").slice(0, 120),
          status: "done",
        };
        const idx = prev.findIndex((s: any) => s.id === step.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...next[idx], ...step };
          return next;
        }
        return [...prev, step];
      });
    }
    return;
  }
  if (item.type === "error") {
    update.logOutput({
      line_number: 0,
      content: String(item.message || "Agent error"),
      stream: "stderr",
      is_json: false,
    });
  }
}
import { hydrateChatHistory } from "../services/aiChatPersistence";

/**
 * The runtime flags this app always sets, in one place so they can be asserted
 * rather than only appearing inside a large function.
 *
 * Every one of these exists because the runtime's default behaviour is wrong for
 * a third-party provider, and each was found by reading what the runtime
 * actually printed on a run:
 *
 * - `default_mode_request_user_input` — the runtime only lets the agent ask a
 *   structured question in specific modes, and the default is not one of them.
 *   Without it the agent can only ask in prose.
 * - `features.plugins = false` — Codex's *plugin* marketplace. On every start
 *   the runtime reached for OpenAI's curated plugin repo: a `featured plugin
 *   ids cache` call to chatgpt.com (401 without an OpenAI login), a `git fetch`
 *   of the curated repo, then a GitHub archive download when that timed out —
 *   ~45s of a ~75s run, retrying on 30s timeouts, for something that can never
 *   succeed off-provider. It governs Codex plugins, not what this app installs:
 *   with the flag set, an `[mcp_servers.*]` entry still reports `enabled` from
 *   `codex mcp list` and a mirrored skill still reaches the prompt.
 * - `suppress_unstable_features_warning` — because the line above turns on an
 *   under-development feature, the runtime warned about that on *every* start
 *   ("may behave unpredictably"), which surfaced to the user as an error in
 *   OUTPUT. The key is the runtime's own documented fix for it.
 *
 * Host skills (`~/.agents/skills`) are deliberately *not* suppressed. They were
 * the reason a run of "build a small todo app" stopped after a few read-only
 * commands: `superpowers:brainstorming` told the agent to present a design and
 * wait for a human, it did exactly that, and the transcript still read like a
 * completed report. `features.skip_host_skill_discovery = true` was tried and
 * does not work (the flag is still "under development" upstream), and skipping
 * was the wrong instinct anyway — those skills encode a way of working worth
 * having, and they only looked broken because the app could not play the other
 * half of the conversation.
 */
export const AGENT_RUNTIME_FLAGS: readonly string[] = [
  "features.default_mode_request_user_input = true",
  "features.plugins = false",
  "suppress_unstable_features_warning = true",
];

/**
 * The standing instruction the app hands the agent, written into the model
 * catalog on every run because the runtime takes it from there.
 *
 * The second half is about cost, and it is the answer to a gap found in a live
 * run: asked to add task priorities to a small project, the agent spent most of a
 * ~6 minute turn writing its own headless-browser test harness — unprompted, and
 * more elaborate than the change. The instinct is right and the result was good,
 * but nothing bounded it, and a run that quietly triples its own length is
 * indistinguishable from one that is stuck. So: verify with what the project
 * already has (`npm run build`, its tests, its own dev server); build new
 * verification only when the task asks for it.
 *
 * This is an expectation, not an enforcement. It cannot be proven by reading
 * code, and a single run cannot show it works — the honest statement is that it
 * sets the ceiling the agent was missing, and that a hard wall-clock cap would
 * be the enforcing version of this.
 */
export const AGENT_BASE_INSTRUCTIONS =
  "You are a coding assistant. Help the user complete their task accurately, use available tools, and verify your changes. " +
  "Verify with the checks the project already has — its build, its tests, its own dev server — and prefer the smallest change that satisfies the request. " +
  "Do not build new test harnesses or verification infrastructure unless the task asks for it.";

import { appStore } from "../services/appStore";
import {
  syncProjectIndex,
  getIndexStatus,
  type ProjectIndexProfile,
} from "../services/agentHarness";

export interface ProjectMeta {
  path: string;
  name: string;
}

/**
 * A cheap "did anything change on disk" signature: every file's path and size.
 *
 * Exists because a run can report confident, well-written work and have written
 * nothing at all — watched happening twice, both times because a skill from the
 * user's personal Codex config told the agent to stop and present a design. The
 * transcript read like a report; `git status` was empty.
 *
 * It is a signature, not a hash: an edit that keeps the byte count identical
 * would slip through. That is why the wording it drives says what was measured
 * rather than asserting "nothing changed".
 */
export function fileSignature(nodes: FileNode[]): string {
  const parts: string[] = [];
  const walk = (list: FileNode[]) => {
    for (const node of list) {
      if (node.is_dir) {
        walk(node.children ?? []);
      } else {
        parts.push(`${node.path}:${node.size_bytes}`);
      }
    }
  };
  walk(nodes);
  return parts.sort().join("\n");
}

/**
 * Which "the runtime is blocked on the human" status, if any, this payload
 * carries — its own name (`waitingOnUserInput` / `waitingOnApproval`) or "".
 *
 * Matched by substring rather than by field path on purpose: `thread/status/changed`
 * carries a struct that moves between releases, and the failure mode of reading it
 * too cleverly is a paused run that still looks finished. Unknown extra fields are
 * harmless, a missed status is not.
 */
export function waitingStatusIn(payload: unknown): string {
  const serialised = JSON.stringify(payload ?? {});
  for (const status of ["waitingOnUserInput", "waitingOnApproval"]) {
    if (serialised.includes(status)) return status;
  }
  return "";
}

/**
 * One `request_user_input` question, exactly as the runtime sends it
 * (`ToolRequestUserInputQuestion` in its own schema).
 */
export type AgentQuestion = {
  id: string;
  header: string;
  question: string;
  /** Free text is allowed in addition to the options. */
  isOther?: boolean;
  isSecret?: boolean;
  options?: { label: string; description: string }[] | null;
};

/**
 * The answer payload the runtime expects, built from question ids → option
 * labels (or free text).
 *
 * Shape read from the runtime's own schema rather than inferred: the response is
 * `{"answers": {"<questionId>": {"answers": ["<string>", …]}}}`
 * (`ToolRequestUserInputResponse` / `ToolRequestUserInputAnswer`, which were
 * generated with `codex app-server generate-json-schema`). Getting this wrong
 * leaves the turn holding forever — the same failure as the old
 * `{decision: "approved"}` on the approval path.
 */
export function userInputResponse(answers: Record<string, string[]>): {
  answers: Record<string, { answers: string[] }>;
} {
  return {
    answers: Object.fromEntries(
      Object.entries(answers).map(([questionId, values]) => [
        questionId,
        { answers: values.filter((value) => value.trim().length > 0) },
      ]),
    ),
  };
}

/**
 * What an approval request is actually asking for, in a sentence.
 *
 * The runtime sends a method and, for a command, the command; for a file change
 * it sends only an `itemId` (`FileChangeRequestApprovalParams` has no paths), so
 * there is nothing to show but a description. Without this the card rendered the
 * raw method as the "command" — literally `$ item/fileChange/requestApproval` —
 * which asks the user to approve something they cannot see.
 */
export function approvalSummary(method: string): string {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "run a command";
    case "item/fileChange/requestApproval":
      return "change files in this project";
    case "item/permissions/requestApproval":
      return "use permissions it does not have yet";
    case "mcpServer/elicitation/request":
      return "connect to an MCP server";
    default:
      return "do something it needs your approval for";
  }
}

/** One file a pending approval would change, with the runtime's own diff. */
export type PendingFileChange = { path: string; kind: string; diff: string };

/**
 * Added and removed line counts from a unified diff.
 *
 * Counted from the runtime's own diff, so the numbers describe *this turn*
 * rather than the working tree — a `git diff` would also include the user's own
 * uncommitted edits to the same file. `+++`/`---` are file headers, not changes.
 */
export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/**
 * Pull the changed files out of a `fileChange` thread item.
 *
 * The approval request itself carries only an `itemId` — no paths, no diff — so
 * on its own it asks the user to approve something they cannot see. The item is
 * announced first (`item/started` includes `changes[{path, kind, diff}]`, and
 * `changes` is required on the item), which is what makes showing it possible.
 */
export function summarizeItemChanges(item: unknown): PendingFileChange[] {
  const changes = (item as { changes?: unknown } | undefined)?.changes;
  if (!Array.isArray(changes)) return [];
  return changes
    .map((change) => {
      const c = (change ?? {}) as { path?: unknown; kind?: unknown; diff?: unknown };
      return {
        path: String(c.path ?? ""),
        kind: String(c.kind ?? "update"),
        // Long enough to judge, short enough to render in a card.
        diff: typeof c.diff === "string" ? c.diff.slice(0, 4000) : "",
      };
    })
    .filter((change) => change.path.length > 0);
}

export interface ProjectIndexState {
  indexed: boolean;
  totalSymbols: number;
  profile: ProjectIndexProfile | null;
}

export interface UsePipelineReturn {
  // Project & Files
  activeProject: ProjectMeta;
  projectFiles: FileNode[];
  selectedFile: FileNode | null;
  setSelectedFile: (file: FileNode | null) => void;
  openTabs: OpenFileTab[];
  activeTabPath: string | null;
  currentDiff: string;
  setCurrentDiff: (diff: string) => void;
  applyPatchToTab: (path: string, newContent: string) => void;
  touchedPaths: string[];
  /** What this turn changed, from the runtime's own item diffs. */
  turnChanges: PendingFileChange[];
  /** Open a file's two sides in the diff viewer. */
  openDiff: (filePath: string) => Promise<void>;
  /** Set when `openDiff` has sides ready; cleared once the viewer has them. */
  reviewDiff: {
    filePath: string;
    originalContent: string;
    modifiedContent: string;
  } | null;
  clearReviewDiff: () => void;
  isProjectModalOpen: boolean;
  setIsProjectModalOpen: (open: boolean) => void;
  isSettingsModalOpen: boolean;
  setIsSettingsModalOpen: (open: boolean) => void;
  aiSettings: AISettings;
  setAiSettings: (settings: AISettings) => void;

  // Folder & File Actions
  pickFolder: () => Promise<string | null>;
  openFolder: (folderPath: string) => Promise<void>;
  openFile: (file: FileNode) => Promise<void>;
  closeTab: (path: string) => void;
  selectTab: (path: string) => void;
  updateTabContent: (path: string, newContent: string) => void;
  saveFile: (path: string) => Promise<void>;
  createFileOrFolder: (parentPath: string, name: string, isDir: boolean) => Promise<void>;
  deleteFile: (path: string) => Promise<void>;
  createProject: (name: string, template: string, parentDir?: string) => Promise<void>;
  refreshProjectFiles: () => Promise<FileNode[]>;
  /**
   * How many times the workspace has been re-read.
   *
   * Every path that looks at the filesystem again — a branch switch, an agent's
   * writes, the tree's own refresh, a new project — goes through
   * `refreshProjectFiles`, so this is the one honest signal that the files on disk
   * may have moved. The repository page re-reads its own view when it changes;
   * without that it kept describing the branch it had seen when it mounted.
   */
  workspaceRevision: number;

  // Code Intelligence & Indexer State
  indexStatus: ProjectIndexState;
  /** A finished run that left every file's path and size untouched. */
  noFileChanges: boolean;
  /**
   * The runtime's own name for a state where it is blocked on the human —
   * `waitingOnUserInput` after a skill asked a question, `waitingOnApproval`
   * before running something. Empty when it is not waiting.
   */
  waitingForUser: string;
  /** Working time on the current turn, excluding time blocked on the human. */
  turnElapsedMs: number;
  /** The ceiling applied to one turn, in minutes; zero means no limit. */
  turnLimitMinutes: number;
  isIndexing: boolean;
  syncIndex: () => Promise<void>;

  // Pipeline State & Execution
  sliders?: { budget_vs_scale: string; speed_vs_precision: string; simplicity_vs_futureproof: string };
  setSliders?: (s: any) => void;
  status: PipelineStatus;
  activityLog: PipelineOutputLine[];
  activeCenterView: "editor" | "diff";
  setActiveCenterView: (v: "editor" | "diff") => void;

  // Real-time Streaming & Agent Step State
  streamingAnswer: string;
  streamingThought: string;
  agentSteps: AgentStep[];
  /** Why the last agent run failed, for the chat to show in place of a generic line. */
  failureDetail: string;
  /** A request the agent is blocked on, if it is waiting for one. */
  pendingApproval: { id: unknown; method: string; command: string; reason: string } | null;
  /** A `request_user_input` question the runtime is holding the turn for. */
  pendingQuestion: { id: unknown; questions: AgentQuestion[] } | null;
  respondToQuestion: (answers: Record<string, string[]>) => Promise<void>;
  respondToApproval: (decision: ApprovalDecision) => Promise<void>;

  runPipeline: (
    customPrompt?: string,
    modelOverride?: { provider: string; model: string; apiKey?: string; baseUrl?: string },
    activeFilePath?: string,
    selectedCode?: string,
    conversationHistory?: Array<{ role: string; content: string }>,
    images?: string[]
  ) => Promise<void>;
  cancelPipeline: () => void;
  /**
   * Add a message to the turn that is already running. Resolves to `null` on
   * success, or a sentence to show the user — and to put the unsent text back for.
   */
  steerPipeline: (text: string) => Promise<string | null>;
  /**
   * Put the last turn's file changes back, from the snapshot taken before it ran.
   * Resolves to `null` on success, or a sentence to show.
   */
  undoLastTurn: () => Promise<string | null>;
  clearLog: () => void;
  isTauriAvailable: boolean;
}

const DEFAULT_SLIDERS = {
  budget_vs_scale: "medium",
  speed_vs_precision: "medium",
  simplicity_vs_futureproof: "medium",
};

const DEFAULT_AI_SETTINGS: AISettings = {
  provider: "ollama",
  model: "qwen2.5-coder:7b",
  apiKey: "",
  baseUrl: "http://127.0.0.1:11434",
  approvalMode: DEFAULT_AGENT_APPROVAL_MODE,
};

/**
 * The "AI Models & Providers" page is the single source of truth for API keys,
 * while `aide_ai_settings` only persists provider/model/baseUrl (secrets are
 * deliberately not duplicated there). Hydrate the key, base URL and model from
 * the provider registry so editor AI and the pipeline always see the
 * credentials the user actually configured.
 *
 * Which provider is *active* is not decided here. The model picker writes that
 * choice to `selected_model`, and this record keeps its own copy of it — and the
 * two versions can drift, because nothing kept them in step. Found in the real
 * database: `ai_settings.provider` was `ollama` / `qwen2.5-coder:7b` while the
 * selection was `deepseek` / `deepseek-flash`, so the editor chat and the agent
 * were silently pointed at different models, and "why didn't it use the
 * DeepSeek key I configured?" had no answer on screen. The selection wins here,
 * and the stale copy is repaired on boot.
 */
export function hydrateAiSettings(settings: AISettings): AISettings {
  try {
    const providers = loadAllProviders() as Record<string, any>;
    const selected = getActiveSelectedModel();
    const provider = selected?.providerId || settings.provider;
    const cfg = providers?.[provider];
    if (!cfg) return settings;
    return {
      ...settings,
      provider,
      model: selected?.model || settings.model || cfg.selectedModel || "",
      apiKey: cfg.apiKey ?? settings.apiKey ?? "",
      baseUrl: cfg.baseUrl ?? settings.baseUrl ?? "",
    };
  } catch {
    return settings;
  }
}

export function usePipeline(): UsePipelineReturn {
  const isTauriAvailable = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  // AI settings
  // The database is the source of truth; this is the first-paint default until
  // the bootstrap effect below restores the saved selection.
  const [aiSettings, setAiSettingsState] = useState<AISettings>(() =>
    hydrateAiSettings(DEFAULT_AI_SETTINGS)
  );

  /**
   * Merge settings in, rather than rebuilding the record from the fields this
   * function happens to know about.
   *
   * The old version enumerated every field, which meant any caller passing a
   * partial object silently reset the ones it did not mention. Two separate
   * bugs came from that: the approval mode and the agent engine were dropped
   * from the persisted record on the next save, so both pickers reverted to
   * their defaults and looked like they did nothing.
   *
   * Fields the caller leaves `undefined` are simply not part of the merge, so a
   * partial update is a partial update.
   */
  const setAiSettings = (newSettings: AISettings) => {
    setAiSettingsState((prev) => {
      const incoming = Object.fromEntries(
        Object.entries(newSettings ?? {}).filter(([, value]) => value !== undefined),
      ) as AISettings;
      const merged = hydrateAiSettings({
        ...prev,
        ...incoming,
        // Secrets never live in this record; the provider registry owns them.
        apiKey: incoming.apiKey ?? prev.apiKey ?? "",
      });
      // Only the non-secret parts are persisted; credentials live in the app
      // database and are resolved server-side.
      const { apiKey: _apiKey, ...persistable } = merged;
      void appStore.setSetting("ai_settings", persistable).catch(() => {});
      return merged;
    });
  };

  /**
   * Bootstrap the app's own state from the database.
   *
   * Runs once: hydrating the provider registry (which also performs the one-time
   * migration of any registry left in localStorage, credentials included),
   * restoring the last-opened project, and loading that project's transcript.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureProvidersHydrated();
        const [settings, active] = await Promise.all([
          appStore.getSettings(),
          appStore.getActiveProject(),
        ]);
        if (cancelled) return;

        // Threads the agent ran in, so a follow-up after a relaunch still
        // continues the same conversation instead of starting from nothing.
        const storedThreads = settings["agent_threads"];
        if (storedThreads && typeof storedThreads === "object" && !cancelled) {
          for (const [key, id] of Object.entries(storedThreads as Record<string, unknown>)) {
            if (typeof id === "string" && id) agentThreadsRef.current.set(key, id);
          }
        }

        // One-time migration of the pre-database settings blob.
        let savedAi = settings["ai_settings"] as AISettings | undefined;
        if (!savedAi) {
          try {
            const legacy =
              localStorage.getItem("aide_ai_settings") || localStorage.getItem("ide_ai_settings");
            if (legacy) {
              const parsed = JSON.parse(legacy);
              if (parsed && typeof parsed === "object" && parsed.provider) {
                savedAi = { provider: parsed.provider, model: parsed.model || "", apiKey: "", baseUrl: parsed.baseUrl || "" };
                void appStore
                  .setSetting("ai_settings", {
                    provider: savedAi.provider,
                    model: savedAi.model,
                    baseUrl: savedAi.baseUrl,
                  })
                  .catch(() => {});
              }
              localStorage.removeItem("aide_ai_settings");
              localStorage.removeItem("ide_ai_settings");
            }
          } catch {
            /* storage disabled */
          }
        }
        // Repair a drifted copy rather than only ignoring it. The writer below
        // keeps appending its own provider/model to this record, so without this
        // the database goes on holding a second, contradictory answer that
        // whoever debugs the next "why didn't it use my key?" has to reconcile by
        // hand. Repaired once, on boot, from the selection that actually decides.
        const selection = getActiveSelectedModel();
        if (savedAi?.provider && selection?.providerId && savedAi.provider !== selection.providerId) {
          void appStore
            .setSetting("ai_settings", {
              ...savedAi,
              provider: selection.providerId,
              model: selection.model,
            })
            .catch(() => {});
        }

        if (savedAi?.provider) {
          // Every saved field is restored, by spreading them in rather than
          // listing them. The list is what broke this: it silently dropped each
          // field added after it was written, so the approval mode and the agent
          // engine — both saved correctly — reverted to their defaults on every
          // launch, and the pickers looked like they did nothing.
          setAiSettingsState((prev) =>
            hydrateAiSettings({
              ...prev,
              ...savedAi,
              apiKey: "",
            })
          );
        }

        if (active?.path && active.path !== "." && active.path !== "./") {
          setActiveProjectState({ name: active.name, path: active.path });
          void hydrateChatHistory(active.path);
        }
        // The active project lives in the database now; drop the old browser
        // pointer so it cannot resurrect an unrelated project later.
        try {
          localStorage.removeItem("aide_active_project");
        } catch {
          /* storage disabled */
        }
      } catch {
        // Database unavailable: the defaults above keep the app usable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-hydrate keys/base URLs whenever the AI Models & Providers page saves,
  // or another tab changes storage, so editor AI never runs with a stale key.
  useEffect(() => {
    const refresh = () => setAiSettingsState((prev: any) => hydrateAiSettings(prev));
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key.includes("ai_providers") || e.key.includes("ai_settings")) refresh();
    };
    window.addEventListener("acsa:models-updated", refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("acsa:models-updated", refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Active project state
  const [activeProject, setActiveProjectState] = useState<ProjectMeta>(() => {
    // No project until hydration says which one (see the bootstrap effect).
    //
    // This used to be `"."`, which is resolved against the process working
    // directory — for an app launched from Finder that is `/`, so a cold start
    // listed the whole filesystem in the Explorer until the database answered,
    // and an agent run started before hydration would have run there. A blank
    // path renders the "open a folder" empty state instead, and the guards
    // below refuse to touch the filesystem without one.
    return { name: "", path: "" };
  });

  const setActiveProject = (proj: ProjectMeta) => {
    setActiveProjectState(proj);
    void appStore.touchProject(proj.path, proj.name).catch(() => {});
  };

  const [projectFiles, setProjectFiles] = useState<FileNode[]>([]);
  /** See `workspaceRevision` in the context: a count, not a value. */
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);

  // Editor tabs state
  const [openTabs, setOpenTabs] = useState<OpenFileTab[]>([]);
  /**
   * The tabs as of the last committed render.
   *
   * `saveFile` is handed to the editor panels and to Monaco itself. Reading the
   * tabs through this ref instead of closing over them is what keeps its
   * identity stable: rebuilt on every keystroke it would defeat the memo around
   * the editor, and an editor panel that captured an old copy once wrote that
   * old buffer back to disk.
   */
  const openTabsRef = useRef<OpenFileTab[]>(openTabs);
  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [activeCenterView, setActiveCenterView] = useState<"editor" | "diff">("editor");

  // Pipeline & AI state
  const [sliders, setSliders] = useState<any>(DEFAULT_SLIDERS);
  const [status, setStatus] = useState<PipelineStatus>("idle");
  const [activityLog, setActivityLog] = useState<PipelineOutputLine[]>([]);
  const [currentDiff, setCurrentDiff] = useState<string>("");
  const [touchedPaths, setTouchedPaths] = useState<string[]>([]);

  /**
   * What this turn changed, straight off the runtime's own item diffs.
   *
   * Codex answers "what did it just do?" with a summary card instead of asking
   * before every write, and that is the better trade: a write inside your own
   * project is not a decision you want to make twenty times, but you do want to
   * see it afterwards. Turn-scoped on purpose — a `git diff` would also count
   * your own uncommitted edits.
   */
  const [turnChanges, setTurnChanges] = useState<PendingFileChange[]>([]);

  /** Sides of a file to open in the diff viewer, for the card's "Review". */
  const [reviewDiff, setReviewDiff] = useState<{
    filePath: string;
    originalContent: string;
    modifiedContent: string;
  } | null>(null);

  const openDiff = useCallback(
    async (filePath: string) => {
      try {
        const { engineCall } = await import("../services/engineBridge");
        const sides = await engineCall<{ originalContent: string; modifiedContent: string }>(
          "git",
          ["diff-file", JSON.stringify({ cwd: activeProject.path, filePath })],
        );
        setReviewDiff({
          filePath,
          originalContent: sides.originalContent ?? "",
          modifiedContent: sides.modifiedContent ?? "",
        });
      } catch (error) {
        setActivityLog((prev) => [
          ...prev,
          {
            line_number: prev.length + 1,
            content: `[agent] could not open a diff for ${filePath}: ${String(error)}`,
            stream: "stderr",
            is_json: false,
          },
        ]);
      }
    },
    [activeProject.path],
  );

  const clearReviewDiff = useCallback(() => setReviewDiff(null), []);
  const [streamingAnswer, setStreamingAnswer] = useState<string>("");
  const [streamingThought, setStreamingThought] = useState<string>("");
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([]);
  // The reason a run failed, in the runtime's own words. The chat used to get
  // this from the orchestration result; when that was removed nothing filled it
  // in, so every failure fell through to "the task needs attention".
  const [failureDetail, setFailureDetail] = useState("");
  // True when a finished run left every file's path and size exactly as it found
  // them. The chat says so, because otherwise a design-first reply and a
  // completed edit look identical in the transcript.
  const [noFileChanges, setNoFileChanges] = useState(false);
  // Non-empty when the runtime says it is blocked on the human. Holds the
  // runtime's own status name (`waitingOnUserInput` / `waitingOnApproval`).
  const [waitingForUser, setWaitingForUser] = useState("");
  // Code Intelligence & Symbol Graph Indexer state
  const [indexStatus, setIndexStatus] = useState<ProjectIndexState>({
    indexed: false,
    totalSymbols: 0,
    profile: null,
  });
  const [isIndexing, setIsIndexing] = useState<boolean>(false);

  const syncIndex = useCallback(async () => {
    if (!activeProject?.path) return;
    setIsIndexing(true);
    try {
      const res = await syncProjectIndex(activeProject.path);
      if (res) {
        setIndexStatus({
          indexed: true,
          totalSymbols: res.totalSymbols,
          profile: res.profile,
        });
      }
    } finally {
      setIsIndexing(false);
    }
  }, [activeProject.path]);

  // Initial index probe when project path is ready
  useEffect(() => {
    if (activeProject?.path) {
      if (!activeProject.path) return;
      getIndexStatus(activeProject.path).then((stat) => {
        setIndexStatus({
          indexed: stat.indexed,
          totalSymbols: stat.totalSymbols,
          profile: stat.profile,
        });
        if (!stat.indexed && activeProject.path !== ".") {
          void syncIndex();
        }
      });
    }
  }, [activeProject.path, syncIndex]);

  // ── File Tree Loading ─────────────────────────────────────────────────────
  const refreshProjectFiles = useCallback(async (): Promise<FileNode[]> => {
    // Bumped before the read rather than after: what a consumer of this signal
    // needs is "look again", and a read that fails still means the app asked the
    // filesystem a question it should not keep assuming the answer to.
    setWorkspaceRevision((count) => count + 1);
    if (!activeProject.path) {
      setProjectFiles([]);
      return [];
    }
    if (isTauriAvailable) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const nodes = await invoke<FileNode[]>("list_project_files", {
          projectPath: activeProject.path,
        });
        setProjectFiles(nodes);
        return nodes;
      } catch (err) {
        console.warn("Tauri list_project_files failed:", err);
      }
    } else {
      console.warn(DESKTOP_REQUIRED_MESSAGE);
    }
    return [];
  }, [isTauriAvailable, activeProject.path]);

  /**
   * Something changed the files on disk: bring the tree *and* the symbol index
   * back in step with it.
   *
   * `refreshProjectFiles` alone was the whole story, so the Code Map, symbol
   * search and the agent's structural context kept describing the project as it
   * was before the turn. Watching it happen: the status bar read "3 files
   * synced" before a run that created two new `.tsx` files, and still read 3
   * afterwards, until someone clicked "re-index" by hand.
   *
   * Re-indexing is a full walk, but a cheap one — measured through the frozen
   * engine, 123 files/1011 symbols took 0.28s and 172 files/60k LOC took 0.39s —
   * so it is affordable to do on every write rather than trying to guess whether
   * a write was interesting.
   */
  const refreshWorkspace = useCallback(async (): Promise<FileNode[]> => {
    const nodes = await refreshProjectFiles();
    try {
      await syncIndex();
    } catch {
      // Keep the previous index. It is stale, which the status bar already says,
      // and a failed re-index must not turn into a failed save or a failed turn.
    }
    return nodes;
  }, [refreshProjectFiles, syncIndex]);

  // Initial load
  useEffect(() => {
    refreshProjectFiles();
  }, [refreshProjectFiles]);

  // ── Native Folder Selection ───────────────────────────────────────────────
  const pickFolder = useCallback(async (): Promise<string | null> => {
    if (isTauriAvailable) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const picked = await invoke<string | null>("pick_folder");
        return picked;
      } catch (err) {
        console.error("pick_folder failed:", err);
        return null;
      }
    } else {
      console.warn(DESKTOP_REQUIRED_MESSAGE);
      return null;
    }
  }, [isTauriAvailable]);

  const openFolder = useCallback(
    async (folderPath: string) => {
      const cleanPath = folderPath.trim();
      if (!cleanPath) return;

      const folderName = cleanPath.split(/[/\\]/).filter(Boolean).pop() || "project";
      setActiveProject({ name: folderName, path: cleanPath });
      setOpenTabs([]);
      setActiveTabPath(null);
      setCurrentDiff("");

      // Automatically trigger AST Symbol Graph indexing
      setIsIndexing(true);
      try {
        const syncRes = await syncProjectIndex(cleanPath);
        if (syncRes) {
          setIndexStatus({
            indexed: true,
            totalSymbols: syncRes.totalSymbols,
            profile: syncRes.profile,
          });
        }
      } finally {
        setIsIndexing(false);
      }
    },
    []
  );

  // ── File Operations ───────────────────────────────────────────────────────
  const openFile = useCallback(
    async (file: FileNode) => {
      setSelectedFile(file);
      if (file.is_dir) return;

      const existing = openTabs.find((t) => t.path === file.path);
      if (existing) {
        setActiveTabPath(file.path);
        setActiveCenterView("editor");
        return;
      }

      let content = "";
      if (isTauriAvailable) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          content = await invoke<string>("read_file_content", {
            filePath: file.path,
            projectRoot: activeProject.path,
          });
        } catch (err) {
          content = `# Error reading file: ${err}`;
        }
      } else {
        // Shown in the editor rather than thrown: a browser preview should say why
        // the file is missing, not look like the file is empty.
        content = `# ${DESKTOP_REQUIRED_MESSAGE}`;
      }

      const newTab: OpenFileTab = {
        path: file.path,
        name: file.name,
        content,
        originalContent: content,
        isDirty: false,
      };

      setOpenTabs((prev) => [...prev, newTab]);
      setActiveTabPath(file.path);
      setActiveCenterView("editor");
    },
    [isTauriAvailable, openTabs, activeProject.path]
  );

  const closeTab = useCallback(
    (path: string) => {
      setOpenTabs((prev) => {
        const next = prev.filter((t) => t.path !== path);
        if (activeTabPath === path) {
          const nextActive = next.length > 0 ? next[next.length - 1].path : null;
          setActiveTabPath(nextActive);
        }
        return next;
      });
    },
    [activeTabPath]
  );

  const selectTab = useCallback((path: string) => {
    setActiveTabPath(path);
    setActiveCenterView("editor");
  }, []);

  const updateTabContent = useCallback((path: string, newContent: string) => {
    setOpenTabs((prev) =>
      prev.map((tab) => {
        if (tab.path === path) {
          return {
            ...tab,
            content: newContent,
            isDirty: newContent !== tab.originalContent,
          };
        }
        return tab;
      })
    );
  }, []);

  const applyPatchToTab = useCallback((path: string, newContent: string) => {
    setOpenTabs((prev) =>
      prev.map((tab) => {
        if (tab.path === path) {
          return {
            ...tab,
            content: newContent,
            originalContent: newContent,
            isDirty: false,
          };
        }
        return tab;
      })
    );
  }, []);

  const saveFile = useCallback(
    async (path: string) => {
      const tab = openTabsRef.current.find((t) => t.path === path);
      if (!tab) return;

      if (isTauriAvailable) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("write_file_content", {
            filePath: path,
            content: tab.content,
            projectRoot: activeProject.path,
          });
        } catch (err) {
          alert(`Failed to save: ${err}`);
          return;
        }
      } else {
        alert(DESKTOP_REQUIRED_MESSAGE);
        return;
      }

      setOpenTabs((prev) =>
        prev.map((t) =>
          t.path === path
            ? { ...t, originalContent: t.content, isDirty: false }
            : t
        )
      );
    },
    [isTauriAvailable, activeProject.path]
  );

  const createFileOrFolder = useCallback(
    async (parentPath: string, name: string, isDir: boolean) => {
      const cleanName = name.trim().replace(/^[/\\]+/, "");
      if (!cleanName) return;

      let targetPath: string;
      if (parentPath && parentPath !== activeProject.path) {
        targetPath = `${parentPath}/${cleanName}`;
      } else {
        targetPath = `${activeProject.path}/${cleanName}`;
      }

      if (isTauriAvailable) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("create_file_or_folder", {
            path: targetPath,
            isDir,
            projectRoot: activeProject.path,
          });
          await refreshWorkspace();
          if (!isDir) {
            openFile({
              name: cleanName.split("/").pop() || cleanName,
              path: targetPath,
              is_dir: false,
              size_bytes: 0,
            });
          }
        } catch (err) {
          alert(`Failed to create: ${err}`);
        }
      } else {
        alert(DESKTOP_REQUIRED_MESSAGE);
      }
    },
    [isTauriAvailable, activeProject.path, refreshWorkspace, openFile]
  );

  const deleteFile = useCallback(
    async (path: string) => {
      if (isTauriAvailable) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("delete_project_file", {
            path,
            projectRoot: activeProject.path,
          });
          closeTab(path);
          await refreshWorkspace();
        } catch (err) {
          console.error("Delete failed:", err);
        }
      } else {
        console.warn(DESKTOP_REQUIRED_MESSAGE);
      }
    },
    [isTauriAvailable, activeProject.path, closeTab, refreshWorkspace]
  );

  const createProject = useCallback(
    async (name: string, template: string, parentDir?: string) => {
      if (!isTauriAvailable) {
        throw new Error(DESKTOP_REQUIRED_MESSAGE);
      }
      // Deliberately uncaught: the caller owns the dialog the user is looking
      // at, and it is the only place a message ends up next to the field that
      // caused it. Swallowing it here meant the dialog had already closed by the
      // time the user was told anything.
      const { invoke } = await import("@tauri-apps/api/core");
      const createdPath = await invoke<string>("create_project_template", {
        name,
        template,
        parentDir: parentDir || null,
      });
      setActiveProject({ name, path: createdPath });
      setOpenTabs([]);
      setActiveTabPath(null);
      setCurrentDiff("");
    },
    [isTauriAvailable]
  );

  // ── Run Pipeline (100% Real Subprocess Execution) ─────────────────────────
  const pipelineAbortRef = useRef<AbortController | null>(null);

  /**
   * Live agent threads, keyed by everything that would invalidate one.
   *
   * A follow-up turn resumes the thread the previous turn ran in, so the agent
   * still has what it read and did — instead of being handed a fresh process and
   * a pasted-in transcript. Changing the model, provider or approval mode starts
   * a new thread, because resuming across those is not the same conversation.
   * Held in memory on purpose: a relaunch starts clean, like the CLI does.
   */
  const agentThreadsRef = useRef<Map<string, string>>(new Map());

  /**
   * A request the runtime is blocked on.
   *
   * Only the `ask-me` mode produces one, and only on the app-server transport —
   * `exec` is one-shot with no channel to answer on, so a request there is
   * auto-denied rather than shown. That is the whole reason the transport exists.
   */
  const [pendingApproval, setPendingApproval] = useState<{
    id: unknown;
    method: string;
    command: string;
    reason: string;
    /** Files this would change, when the runtime has announced the item. */
    changes?: PendingFileChange[];
  } | null>(null);
  const pendingApprovalRef = useRef(pendingApproval);
  pendingApprovalRef.current = pendingApproval;

  // A `request_user_input` question is a different thing from an approval: it
  // carries its own options and expects answers keyed by question id, so it gets
  // its own state rather than being squeezed into the approval card. Rendered as
  // an approval it read "APPROVAL NEEDED … $ item/tool/requestUserInput", which
  // is what a paused run looked like before this existed.
  const [pendingQuestion, setPendingQuestion] = useState<{
    id: unknown;
    questions: AgentQuestion[];
  } | null>(null);
  const pendingQuestionRef = useRef(pendingQuestion);
  pendingQuestionRef.current = pendingQuestion;

  const respondToQuestion = useCallback(async (answers: Record<string, string[]>) => {
    const request = pendingQuestionRef.current;
    if (!request) return;
    setPendingQuestion(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("agent_respond", {
        requestId: request.id,
        decision: userInputResponse(answers),
      });
    } catch (error) {
      setActivityLog((prev) => [
        ...prev,
        {
          line_number: prev.length + 1,
          content: `[agent] could not answer the question: ${String(error)}`,
          stream: "stderr",
          is_json: false,
        },
      ]);
    }
  }, []);

  const respondToApproval = useCallback(async (decision: ApprovalDecision) => {
    const request = pendingApprovalRef.current;
    if (!request) return;
    setPendingApproval(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // The runtime's own vocabulary, sent as-is. Its schema wants a decision
      // *string* — `accept` / `acceptForSession` / `decline` / `cancel` — and
      // rejects anything else, which is how an earlier `{decision: "approved"}`
      // left the turn waiting for an answer it never got.
      await invoke("agent_respond", {
        requestId: request.id,
        decision: { decision },
      });
    } catch (error) {
      setActivityLog((prev) => [
        ...prev,
        {
          line_number: prev.length + 1,
          content: `[agent] could not answer the approval: ${String(error)}`,
          stream: "stderr",
          is_json: false,
        },
      ]);
    }
  }, []);

  /**
   * Write the thread map back to the database.
   *
   * Small and infrequent — one entry per project + model + approval mode — so it
   * is written whole rather than patched. Best-effort: losing the pointers only
   * costs a fresh thread on the next turn, which is what the caller already
   * copes with when a resume fails.
   */
  const persistAgentThreads = useCallback(() => {
    const entries = Array.from(agentThreadsRef.current.entries());
    // Keep the map from growing without bound across projects and models.
    const trimmed = Object.fromEntries(entries.slice(-40));
    void appStore.setSetting("agent_threads", trimmed).catch(() => {});
  }, []);

  /**
   * The snapshot taken for the turn in flight, or null.
   *
   * The id is ours rather than the runtime's: the snapshot has to exist *before*
   * the turn starts, and the runtime's turn id only arrives in the reply to
   * `turn/start`, which is after the point of no return.
   */
  const turnSnapshotRef = useRef<string | null>(null);

  const beginTurnSnapshot = useCallback(async (projectRoot: string) => {
    if (!projectRoot) {
      turnSnapshotRef.current = null;
      return;
    }
    const id = `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const taken = await takeTurnSnapshot(projectRoot, id);
    // Null means the engine could not take one at all; the turn still runs, and
    // Undo will say it has nothing to undo rather than pretending.
    turnSnapshotRef.current = taken ? id : null;
  }, []);

  /**
   * Put the last turn's changes back.
   *
   * Returns `null` on success, or a sentence to show. The paths come from the turn
   * itself (`turnChanges`), so files the turn did not touch are not ours to move —
   * which is what keeps this from becoming a second `git checkout --` that also
   * discards work the user did by hand.
   */
  const undoLastTurn = useCallback(async (): Promise<string | null> => {
    const id = turnSnapshotRef.current;
    const root = activeProject.path;
    const paths = turnChanges.map((change) => change.path);
    if (!id) return "There is no snapshot for the last turn, so it cannot be undone.";
    if (!root || paths.length === 0) return "There is nothing to undo.";
    try {
      const result = await restoreTurnSnapshot(root, id, paths);
      turnSnapshotRef.current = null;
      setTurnChanges([]);
      setNoFileChanges(false);
      // The tree and the symbol index both describe the project as it was a moment
      // ago now; the same refresh an agent turn does.
      await refreshProjectFiles();
      void syncIndex();
      const files = result.restored.length + result.removed.length;
      setActivityLog((prev) => [
        ...prev,
        {
          line_number: prev.length + 1,
          content: `Undid the last turn: ${result.restored.length} file(s) restored, ${result.removed.length} removed.`,
          stream: "stdout" as const,
          is_json: false,
        },
      ]);
      return files === 0 ? "Nothing needed changing." : null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, [activeProject.path, turnChanges, refreshProjectFiles, syncIndex]);

  const runPipeline = useCallback(
    async (
      customPrompt?: string,
      modelOverride?: { provider: string; model: string; apiKey?: string; baseUrl?: string },
      activeFilePath?: string,
      selectedCode?: string,
      conversationHistory?: Array<{ role: string; content: string }>,
      images?: string[]
    ) => {
      // The composer owns its own text now (services/chatDraft.ts); every caller
      // that wants to run something passes it in.
      const activePrompt = customPrompt ?? "";
      if (!activePrompt.trim()) return;
      if (!activeProject.path) {
        setStatus("failed");
        setFailureDetail("No project is open. Open a folder first — the agent runs inside it.");
        setAgentSteps([]);
        setActivityLog([
          {
            line_number: 1,
            content:
              "[agent] No project is open. Open a folder first — the agent runs inside it.",
            stream: "stderr",
            is_json: false,
          },
        ]);
        return;
      }

      setStatus("running");
      setPendingApproval(null);
      setPendingQuestion(null);
      setFailureDetail("");
      setNoFileChanges(false);
      setWaitingForUser("");
      setTurnChanges([]);
      setActivityLog([]);
      setCurrentDiff("");
      // The pre-run snapshot. `projectFiles` is the last list we loaded, and
      // nothing else refreshes it mid-run, so this is what the workspace looked
      // like when the agent started.
      const before = fileSignature(projectFiles);
      setStreamingAnswer("");
      setStreamingThought("");
      setAgentSteps([]);
      setTouchedPaths([]);

      // The thread key must reflect what the run will actually use, so resolve
      // the model the same way `runAgentOnCodex` does before asking for a thread.
      const activeSelection = getActiveSelectedModel() as
        | { providerId?: string; model?: string }
        | null;
      const threadProvider = modelOverride?.provider || activeSelection?.providerId || "";
      const threadModel = modelOverride?.model || activeSelection?.model || "";
      const threadKey = [
        activeProject.path,
        threadProvider,
        threadModel,
        aiSettings.approvalMode ?? "approve-for-me",
      ].join("\u0000");
      const resumeThreadId = agentThreadsRef.current.get(threadKey);

      const agentPrompt = buildAgentPrompt(
        activePrompt,
        activeFilePath,
        selectedCode,
        // A resumed thread already holds the earlier turns; re-sending them would
        // duplicate the conversation inside its own context.
        resumeThreadId ? undefined : conversationHistory,
      );
      if (resumeThreadId) {
        setActivityLog((prev) => [
          ...prev,
          {
            line_number: prev.length + 1,
            content: `[agent] continuing thread ${resumeThreadId.slice(0, 8)}`,
            stream: "stdout",
            is_json: false,
          },
        ]);
      }
      // The runtime will happily hand an image to a model that cannot read one,
      // and the provider answers 400 "Multimodal data provided, but model does
      // not support multimodal requests" — which the runtime retries five times
      // and then reports as a failed turn. Verified. So the check happens here:
      // an image the model cannot use is a warning, not a dead run.
      const visionCapable = isModelVisionCapable(threadProvider, threadModel);
      const usableImages = visionCapable ? images : undefined;
      if (images && images.length > 0) {
        setActivityLog((prev) => [
          ...prev,
          {
            line_number: prev.length + 1,
            content: visionCapable
              ? `[agent] attaching ${images.length} image(s)`
              : `[agent] ${images.length} image(s) not attached: ${threadModel || "this model"} does not take image input. Pick a vision model, or say what is in the image.`,
            stream: visionCapable ? "stdout" : "stderr",
            is_json: false,
          },
        ]);
      }

      if (isTauriAvailable) {
        // Unset means the default, which is `app-server`: reading it as "not
        // app-server, therefore exec" would have quietly kept every existing
        // install on the transport that cannot ask anything.
        const transport: AgentTransport =
          aiSettings.agentTransport === "exec" ? "exec" : DEFAULT_AGENT_TRANSPORT;
        const approvalMode = resolveApprovalMode(
          aiSettings.approvalMode ?? DEFAULT_AGENT_APPROVAL_MODE,
          transport,
        );
        if (transport === "app-server" && approvalMode === "ask-me") {
          setActivityLog((prev) => [
            ...prev,
            {
              line_number: prev.length + 1,
              content: "[agent] the runtime will ask before running anything risky",
              stream: "stdout",
              is_json: false,
            },
          ]);
        }

        // The two transports speak different event vocabularies, so the mapping
        // lives here and the runner stays transport-agnostic.
        const agentUpdate = {
          setSteps: setAgentSteps,
          appendAnswer: (text: string) => setStreamingAnswer((prev) => prev + text),
          logOutput: (line: any) => setActivityLog((prev) => [...prev, line]),
          markTouched: (paths: string[]) =>
            setTouchedPaths((prev) => [...prev, ...paths.filter((p) => !prev.includes(p))]),
          recordChanges: (changes: PendingFileChange[]) =>
            setTurnChanges((prev) => {
              // One row per file, keeping the latest diff for it: an edit tool
              // can touch the same file more than once in a turn.
              const byPath = new Map(prev.map((change) => [change.path, change]));
              for (const change of changes) byPath.set(change.path, change);
              return Array.from(byPath.values());
            }),
        };
        const onAgentEvent = (event: any) =>
          transport === "app-server"
            ? applyAppServerEvent(event, {
                ...agentUpdate,
                setAnswer: (text: string) => setStreamingAnswer(text),
                fail: (detail) => {
                  setFailureDetail(detail);
                  setStatus("failed");
                },
              })
            : applyCodexEvent(event, agentUpdate);

        const runOnce = (resume?: string, via: AgentTransport = transport) =>
          runAgent({
            prompt: agentPrompt,
            transport: via,
            // Re-resolved per transport: `ask-me` needs app-server, and silently
            // keeping it on a fallback run would auto-deny rather than ask.
            approvalMode: resolveApprovalMode(aiSettings.approvalMode ?? DEFAULT_AGENT_APPROVAL_MODE, via),
            onApproval: (request) => {
              const p = request.params ?? {};
              setPendingApproval({
                id: request.id,
                method: request.method,
                // Empty when there is no command to show. The old fallback was
                // the method name, which put `$ item/fileChange/requestApproval`
                // where a command belongs.
                command: String(p.command ?? p.path ?? ""),
                reason: String(p.reason ?? ""),
                changes: request.changes ?? [],
              });
            },
            onWaitingForUser: setWaitingForUser,
            onQuestion: setPendingQuestion,
            // Last moment before the runtime can touch a file.
            onBeforeTurn: () => beginTurnSnapshot(activeProject.path),
            onEvent: onAgentEvent,
            resumeThreadId: resume,
            images: usableImages,
            onThread: (id) => {
              agentThreadsRef.current.set(threadKey, id);
              persistAgentThreads();
            },
            onFailure: setFailureDetail,
            projectRoot: activeProject.path,
          selection: modelOverride
            ? { providerId: modelOverride.provider, model: modelOverride.model }
            : undefined,
          // Diagnostics go to the OUTPUT panel: this is read by a human when the chat
          // shows nothing, so it says which branch ran and what actually arrived.
          log: (line) =>
            setActivityLog((prev) => [
              ...prev,
              { line_number: prev.length + 1, content: line, stream: "stdout", is_json: false },
            ]),
          note: (note) =>
            setAgentSteps((prev) => {
              const step = { id: `note-${note.name}`, ...note };
              const idx = prev.findIndex((s) => s.id === step.id);
              if (idx < 0) return [...prev, step];
              const next = [...prev];
              next[idx] = { ...next[idx], ...step };
              return next;
            }),
          });

        let usedTransport: AgentTransport = transport;
        let codexStatus = await runOnce(resumeThreadId);

        // The fallback. `app-server` is the default because it is the only
        // transport that can ask, but a runtime that cannot start it must not
        // leave the user with nothing: retry once on `exec`, which cannot ask
        // anything but does run, and say so rather than swapping transports
        // behind their back.
        if (codexStatus === "unavailable" && usedTransport === "app-server") {
          setActivityLog((prev) => [
            ...prev,
            {
              line_number: prev.length + 1,
              content:
                "[agent] this runtime could not start the live session; falling back to one-shot exec (no approvals or questions on this run).",
              stream: "stderr",
              is_json: false,
            },
          ]);
          usedTransport = "exec";
          codexStatus = await runOnce(undefined, "exec");
        }

        // A resumed thread can be gone — a cleared session directory, a stale id.
        // That fails before the model sees anything, so starting over is safe and
        // is not the "two edits" risk a mid-run retry would be.
        if (codexStatus === "unavailable" && resumeThreadId) {
          agentThreadsRef.current.delete(threadKey);
          persistAgentThreads();
          setActivityLog((prev) => [
            ...prev,
            {
              line_number: prev.length + 1,
              content: "[agent] that thread could not be resumed; starting a fresh one.",
              stream: "stdout",
              is_json: false,
            },
          ]);
          codexStatus = await runOnce(undefined);
        }

        // No fallback to our own loop. It narrated tool calls in prose and answered
        // refusals with a guard message, editing nothing — degrading to it silently is
        // worse than failing. If the runtime is missing, say so and how to fix it.
        // Measured *before* the terminal status is set. The chat builds its
        // message from `status`, so a flag set afterwards is a flag the message
        // never sees — which is how the first version of this shipped invisible.
        const after = await refreshWorkspace();
        setNoFileChanges(fileSignature(after) === before);

        if (codexStatus === "unavailable") {
          setStatus("failed");
          setFailureDetail(
            "The agent runtime is unavailable. Run scripts/fetch_codex_sidecar.sh, then relaunch the app.",
          );
          setActivityLog((prev) => [
            ...prev,
            {
              line_number: prev.length + 1,
              content:
                "[agent] The Codex runtime is unavailable. Run scripts/fetch_codex_sidecar.sh and relaunch the app.",
              stream: "stderr",
              is_json: false,
            },
          ]);
        } else {
          // The chat derives its state from `status`, and a finished run leaves it on
          // "running" unless something clears it — which is why the panel once sat on
          // "Working (195s)" after a perfectly good edit.
          setStatus(codexStatus);
        }

      } else {
        // Agent runs need the desktop shell: the runtime, the engine and the
        // project live behind Tauri IPC. There is no browser fallback — the dev
        // bridge used to spawn the Python orchestrator here, and that whole
        // pipeline is gone. Say so instead of pretending to run.
        setStatus("failed");
        setActivityLog((prev) => [
          ...prev,
          {
            line_number: prev.length + 1,
            content:
              "[agent] Agent runs require the desktop app. Launch it with `npm run dev:app`.",
            stream: "stderr",
            is_json: false,
          },
        ]);
      }
      pipelineAbortRef.current = null;
    },
    [
      activeProject.path,
      aiSettings,
      isTauriAvailable,
      refreshWorkspace,
      persistAgentThreads,
      projectFiles,
      beginTurnSnapshot,
    ]
  );

  const cancelPipeline = useCallback(async () => {
    pipelineAbortRef.current?.abort();
    pipelineAbortRef.current = null;
    if (isTauriAvailable) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("chat_cancel");
      } catch {}
    }
    setStatus("idle");
  }, [isTauriAvailable]);

  /**
   * How long the current turn has actually been working.
   *
   * Ticks only while a turn is running and is *not* blocked on the human, so the
   * clock matches what the user is waiting for. It is shown in the composer
   * beside the stop button, because "rolling for 500s with no idea what is
   * happening" is the complaint this answers, and it is what the limit reads.
   */
  const [turnElapsedMs, setTurnElapsedMs] = useState(0);
  useEffect(() => {
    if (status !== "running" || waitingForUser) return;
    const startedAt = Date.now() - turnElapsedMs;
    const id = window.setInterval(() => setTurnElapsedMs(Date.now() - startedAt), 1000);
    return () => window.clearInterval(id);
    // `turnElapsedMs` is deliberately not a dependency: it is the accumulated
    // value at the moment this effect starts, and re-running on every tick would
    // rebuild the interval each second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, waitingForUser]);

  // A new turn starts from zero, and a finished one stops showing a clock.
  useEffect(() => {
    setTurnElapsedMs(0);
  }, [status]);

  /**
   * The ceiling. Stops the turn through the same path as the Stop button — this
   * adds a reason, not a second way to cancel — and says why in OUTPUT so a
   * stopped run is never indistinguishable from a crashed one.
   */
  const turnLimitMinutes = aiSettings.turnLimitMinutes ?? DEFAULT_TURN_LIMIT_MINUTES;
  useEffect(() => {
    if (status !== "running") return;
    if (!shouldStopTurn({ elapsedMs: turnElapsedMs, limitMinutes: turnLimitMinutes, blockedOnUser: Boolean(waitingForUser) })) {
      return;
    }
    setActivityLog((prev) => [
      ...prev,
      {
        line_number: prev.length + 1,
        content: turnLimitNotice(turnLimitMinutes),
        stream: "stderr" as const,
        is_json: false,
      },
    ]);
    void cancelPipeline();
  }, [status, turnElapsedMs, turnLimitMinutes, waitingForUser, cancelPipeline]);

  const clearLog = useCallback(() => {
    setActivityLog([]);
  }, []);

  /**
   * Add a message to the turn that is already running.
   *
   * Returns `null` on success, or a sentence to show on failure — it does not
   * throw, because every failure here is one the user can act on and the caller
   * needs to put the unsent text back rather than lose it.
   *
   * The failures are real and distinguishable. The runtime refuses a steer whose
   * `expectedTurnId` no longer matches ("the turn moved on"), and refuses one
   * aimed at a turn that cannot accept same-turn steering — `/review` and manual
   * `/compact` answer `ActiveTurnNotSteerable`. Say which, rather than leaving a
   * message that appeared to send and did nothing.
   */
  const steerPipeline = useCallback(async (text: string): Promise<string | null> => {
    const message = text.trim();
    if (!message) return "There is nothing to send.";
    if (!isTauriAvailable) return DESKTOP_REQUIRED_MESSAGE;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("agent_steer", { text: message });
      return null;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (/ActiveTurnNotSteerable|not steerable/i.test(raw)) {
        return "This turn cannot be steered — a review or a compaction is running. Wait for it to finish.";
      }
      if (/expectedTurnId|precondition|no turn is running/i.test(raw)) {
        return "That turn had already finished, so the message was not sent.";
      }
      return `Could not send: ${raw}`;
    }
  }, [isTauriAvailable]);

  return {
    activeProject,
    projectFiles,
    selectedFile,
    setSelectedFile,
    openTabs,
    activeTabPath,
    currentDiff,
    setCurrentDiff,
    applyPatchToTab,
    touchedPaths,
    turnChanges,
    openDiff,
    reviewDiff,
    clearReviewDiff,
    isProjectModalOpen,
    setIsProjectModalOpen,
    isSettingsModalOpen,
    setIsSettingsModalOpen,
    aiSettings,
    setAiSettings,
    pickFolder,
    openFolder,
    openFile,
    closeTab,
    selectTab,
    updateTabContent,
    saveFile,
    createFileOrFolder,
    deleteFile,
    createProject,
    refreshProjectFiles,
    workspaceRevision,
    indexStatus,
    noFileChanges,
    waitingForUser,
    turnElapsedMs,
    turnLimitMinutes,
    isIndexing,
    syncIndex,
    sliders,
    setSliders,
    status,
    activityLog,
    activeCenterView,
    setActiveCenterView,
    runPipeline,
    cancelPipeline,
    steerPipeline,
    undoLastTurn,
    clearLog,
    isTauriAvailable,
    streamingAnswer,
    streamingThought,
    agentSteps,
    failureDetail,
    pendingApproval,
    pendingQuestion,
    respondToQuestion,
    respondToApproval,
  };
}

export default usePipeline;

/**
 * One model's entry in the catalog the runtime reads.
 *
 * Extracted so the modality question is testable: this catalog is built inline
 * inside a long agent run, and its `input_modalities` was `["text"]` for every
 * model for several releases. The runtime believes the catalog over the request,
 * so a vision model declared text-only has its `view_image` tool refused with
 * "you do not support image inputs" and any attached image is dropped — reported
 * from a run that fell back to OCR-ing a screenshot off the Desktop.
 */
export function agentCatalogEntry(providerId: string, providerName: string, slug: string) {
  return {

        slug,
        display_name: slug,
    description: `${slug} via ${providerName}.`,
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "low", description: "Low reasoning" },
          { effort: "high", description: "High reasoning" },
        ],
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: 1,
        base_instructions: AGENT_BASE_INSTRUCTIONS,
        context_window: 131072,
        max_context_window: 131072,
        effective_context_window_percent: 95,
        truncation_policy: { mode: "tokens", limit: 10000 },
        // Per model, not per app. This said `["text"]` for everything, and the
        // runtime believes its catalog over the request: a vision model declared
        // text-only gets its `view_image` tool refused with "you do not support
        // image inputs", and any attached image is dropped. Reported from a run
        // where the model hunted for a screenshot on disk and then had to OCR it.
        // `isModelVisionCapable` is the same gate the attach path uses, so the
        // two cannot disagree about what a model can read.
        input_modalities: isModelVisionCapable(providerId, slug)
          ? ["text", "image"]
          : ["text"],
        apply_patch_tool_type: "freeform",
        support_verbosity: true,
        default_verbosity: "low",
        default_reasoning_summary: "none",
        supports_parallel_tool_calls: true,
        use_responses_lite: false,
        prefer_websockets: false,
    experimental_supported_tools: [],
  };
}
