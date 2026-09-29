/**
 * agentApproval.ts — how much the agent may do without asking.
 *
 * Mapped onto the agent runtime's own three settings. Every value here was
 * checked against the shipped binary rather than assumed:
 *
 *   - `approval_policy` accepts `untrusted` | `on-failure` | `on-request` |
 *     `granular` | `never`, but `untrusted` is refused at *runtime* ("no longer
 *     supported"), so "read only" is expressed through the sandbox instead.
 *   - `approvals_reviewer` accepts `user` | `auto_review` | `guardian_subagent`.
 *   - `sandbox_mode` accepts `read-only` | `workspace-write` | `danger-full-access`.
 *
 * A rejected value is a config error that stops the run before it starts, so
 * these three combinations were each loaded with `--strict-config` and confirmed
 * to reach the provider.
 */

export const AGENT_APPROVAL_MODES = {
  "read-only": {
    label: "Read only",
    description: "The agent can read and search, but cannot change files or run commands.",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandboxMode: "read-only",
  },
  "approve-for-me": {
    label: "Approve for me",
    description:
      // "Inside your project" was not the whole truth. The runtime's
      // workspace-write sandbox also allows the system temporary directory —
      // builds need scratch space — so a run can create files outside the
      // project without asking anyone. Found by watching an agent write its own
      // test harness to /tmp while this mode was on and no prompt appeared.
      "Edits and commands run inside your project, and in temporary directories a build needs, without asking. Anything reaching further is reviewed automatically, so a run does not stop to interrupt you.",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandboxMode: "workspace-write",
  },
  "ask-me": {
    label: "Ask me",
    description:
      // Says what the sandbox actually does, because the honest answer surprised
      // us too: `workspace-write` lets the agent edit and build inside the project
      // (and in temporary directories) *without* asking,
      // so "Ask me" is not "approve every change" — it is
      // "I answer the escalations, not an automatic reviewer". Verified by running
      // a multi-file refactor under this mode: no prompt appeared.
      "Edits and commands run inside your project, and in temporary directories, without asking. Anything reaching past that — the network, other folders, destructive commands — waits for your approval in the chat. Needs the app-server engine below.",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxMode: "workspace-write",
  },
  "full-access": {
    label: "Full access",
    description: "No review at all. The agent can run anything, anywhere.",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxMode: "danger-full-access",
  },
} as const;

export type AgentApprovalMode = keyof typeof AGENT_APPROVAL_MODES;

export const DEFAULT_AGENT_APPROVAL_MODE: AgentApprovalMode = "approve-for-me";

/** Guard for values that came out of storage, which may be stale or hand-edited. */
export function isAgentApprovalMode(value: unknown): value is AgentApprovalMode {
  return typeof value === "string" && value in AGENT_APPROVAL_MODES;
}

/**
 * The runtime's answers to an approval request, verbatim from its schema.
 *
 * `CommandExecutionRequestApprovalResponse.decision` is one of these strings.
 * It is not a boolean and not `{denied: {...}}`: an unrecognized value fails the
 * runtime's deserialization, so the request is never really answered and the
 * turn waits forever. Generating the protocol schema is what settled this.
 */
export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

/**
 * Provider ids that are a local runtime rather than an OpenAI-compatible API.
 *
 * These have to be handed to the agent runtime through its own local-provider
 * switch. A custom `model_providers` entry cannot reach them: that path is
 * OpenAI-compatible HTTP and is configured with `wire_api = "responses"`, which
 * Ollama does not implement, so the run fails before its first token.
 */
export const LOCAL_PROVIDER_IDS = new Set(["ollama", "lmstudio", "local"]);

export function localProviderFor(providerId: string | undefined): string | null {
  const id = (providerId || "").toLowerCase();
  if (id === "ollama") return "ollama";
  if (id === "lmstudio") return "lmstudio";
  return null;
}

/**
 * Providers measured to serve the Responses API, so the runtime can reach them
 * directly.
 *
 * Each was confirmed by running the agent against it: the runtime posts to
 * `<base>/responses` and gets a stream back. Everything else goes through the
 * tool adapter, and that default is the fix for a specific trap: the registry
 * offered fifteen providers, the runtime speaks Responses and nothing else
 * (`wire_api = "chat"` is a hard config error on this Codex build), and only
 * these implement it. So a dozen entries were advertised as agent-capable and
 * answered 404 on the first tool call — verified on NVIDIA NIM, Mistral and
 * Anthropic. Routing an OpenAI-compatible provider through the adapter always
 * works, because the adapter speaks the chat completions API they all have;
 * pointing the runtime straight at one works only once its Responses support has
 * been checked. One extra hop, no 404s.
 *
 * Groq joined on a probe rather than on its documentation, because the two have
 * disagreed before (its docs list two models a live account does not have). Asked
 * for a tool call with `openai/gpt-oss-120b`, `POST /openai/v1/responses`
 * answered 200 with a real `function_call` item — name, `call_id`, JSON-string
 * arguments — alongside a `reasoning` item and the token counts. Then the
 * runtime's own request was pointed at the same URL with a deliberately invalid
 * key, because the edge in front of Groq blocks some clients before it looks at
 * credentials: it answered `401 Unauthorized … url:
 * https://api.groq.com/openai/v1/responses`, i.e. it reached Groq's auth. A 403
 * would have meant keeping the adapter regardless of what the API supports.
 */
export const RESPONSES_CAPABLE_PROVIDER_IDS = new Set(["openai", "deepseek", "groq"]);

/**
 * Providers whose API is not OpenAI-shaped, so the adapter cannot front them
 * either.
 *
 * Anthropic's is `/v1/messages` — its own body, its own auth header — and the
 * chat path special-cases it in the engine. A Responses⇄chat-completions adapter
 * has nothing to translate to, so agent mode is honestly unavailable rather than
 * silently doing nothing.
 */
export const NOT_ADAPTER_CAPABLE_PROVIDER_IDS = new Set(["anthropic"]);

/** Whether the agent must reach this provider through the tool adapter. */
export function needsToolAdapter(providerId: string | undefined): boolean {
  const id = (providerId || "").toLowerCase();
  if (!id) return false;
  if (RESPONSES_CAPABLE_PROVIDER_IDS.has(id)) return false;
  return !NOT_ADAPTER_CAPABLE_PROVIDER_IDS.has(id);
}

/**
 * Why an agent run on a local model does nothing — for the OUTPUT panel.
 *
 * Measured, not guessed: the runtime sends its tools to `/v1/responses`
 * (`exec_command`, `write_stdin`, … — captured on the wire), and Ollama 0.34.1
 * answers with the tool call as *plain text* rather than a `function_call`, so
 * no action is ever executed. Ollama's native `/api/chat` does support tools,
 * and the runtime will not use it (`wire_api = "chat"` is rejected), so this is
 * the Responses shim. Reported once at run start so a run that reads and replies
 * but changes nothing explains itself instead of looking broken.
 */
export function localToolCallingNote(providerId: string | undefined): string | null {
  const local = localProviderFor(providerId);
  if (!local) return null;
  // Reached only when the tool adapter could not be started. Against Ollama's own
  // Responses endpoint the reason is that it accepts `tools` and ignores them; that
  // is the plumbing gap the adapter exists to close. When the adapter *is* running
  // the remaining limit is the model, not the transport — measured, not assumed:
  // `qwen3.5:9b`, `qwen2.5-coder:7b` and `deepseek-coder:6.7b` each emit no function
  // call for the runtime's real prompt. See docs/AGENT_RUNTIME.md.
  return `[agent] ${local} is reachable but this run has no tool adapter: the model can read and reply but will not edit files or run commands. Use a hosted provider for agent mode.`;
}

/**
 * How much of the agent can run unattended.
 *
 * `ask-me` is the one mode that needs the app-server transport: `codex exec` is
 * one-shot with no channel to answer an approval request on, so a request under
 * `approvalsReviewer = "user"` would be auto-denied rather than shown.
 */
export type AgentTransport = "exec" | "app-server";

export const AGENT_TRANSPORTS = {
  exec: {
    label: "Codex exec",
    description:
      "One process per turn. Proven, but cannot ask for approval, cannot be steered mid-run, and reports the answer only once it is whole.",
  },
  "app-server": {
    label: "App-server",
    description:
      "A live session: streams the answer as it is written, can be interrupted, and can ask you before running something risky.",
  },
} as const;

/**
 * `app-server` by default, because it is the only transport that can ask.
 *
 * `exec` is one-shot: no approval card, no question card, no steering. Those
 * affordances were built and verified, and on `exec` nobody ever saw them. `exec`
 * stays as the fallback for a runtime that cannot start the app-server, and is
 * still selectable on purpose — see `src/hooks/usePipeline.ts`.
 */
export const DEFAULT_AGENT_TRANSPORT: AgentTransport = "app-server";

export function isAgentTransport(value: unknown): value is AgentTransport {
  return value === "exec" || value === "app-server";
}

/** Whether a mode can be honoured on a transport, and what to use if not. */
export function resolveApprovalMode(
  mode: AgentApprovalMode,
  transport: AgentTransport,
): AgentApprovalMode {
  if (mode === "ask-me" && transport !== "app-server") return DEFAULT_AGENT_APPROVAL_MODE;
  return mode;
}
