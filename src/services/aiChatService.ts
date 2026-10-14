/**
 * aiChatService.ts — Conversational AI Streaming Service
 *
 * Communicates with the /api/ai/chat bridge endpoint to stream real
 * conversational responses from Ollama, OpenAI, Groq, DeepSeek, or
 * the local Deterministic AST engine.
 */

import { DESKTOP_REQUIRED_MESSAGE, hasIpc } from "./engineBridge";

/**
 * Stream a reply through the app's own IPC channel.
 *
 * The engine writes NDJSON frames (`{delta}` … `{done}`) and the Rust side forwards
 * each line as an `ai:frame` event, so the three payload shapes the SSE reader
 * handled below are unchanged — only the transport differs.
 */
async function streamViaIpc(params: any): Promise<void> {
  const { provider, model, messages, images, projectRoot, activePath, selection, baseUrl, apiKey, signal, onDelta, onDone, onError } = params;
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  let finished = false;
  let unlisten: Array<() => void> = [];
  const cleanup = () => {
    unlisten.forEach((off) => off());
    unlisten = [];
  };
  const abort = () => {
    if (!finished) invoke("chat_cancel").catch(() => {});
  };
  signal?.addEventListener?.("abort", abort);

  try {
    unlisten.push(
      await listen<string>("ai:exit", (event) => {
        if (finished) return;
        finished = true;
        // The engine always sends its own final frame on success, so reaching here
        // first means it died — and stderr is the only explanation available.
        if (event.payload) onError(String(event.payload));
        else if (signal?.aborted) onDone({ aborted: true });
        else onError("The assistant stopped before finishing.");
        cleanup();
      }),
    );
    unlisten.push(
      await listen<{ line: string }>("ai:frame", (event) => {
        if (finished) return;
        try {
          const frame = JSON.parse(event.payload.line);
          if (frame.error) {
            finished = true;
            onError(frame.error);
            cleanup();
            return;
          }
          if (frame.delta) onDelta(frame.delta);
          if (frame.done) {
            finished = true;
            onDone(frame);
            cleanup();
          }
        } catch {
          /* a partial or non-JSON line carries nothing to show */
        }
      }),
    );

    await invoke("chat_stream", {
      payload: JSON.stringify({
        provider,
        model,
        messages,
        images,
        projectRoot,
        activePath,
        selection,
        baseUrl,
        apiKey,
      }),
    });
  } catch (err: any) {
    if (!finished) {
      finished = true;
      // `invoke` rejects with the raw string from Rust's `Err(..)`, which has no
      // `.message` — reading only that replaced the real reason with a generic one
      // and made this undiagnosable.
      onError(
        typeof err === "string" ? err : err?.message || "Failed to communicate with the assistant.",
      );
    }
    cleanup();
  } finally {
    signal?.removeEventListener?.("abort", abort);
  }
}

export interface AgentStep {
  id?: string;
  name: string;
  detail?: string;
  status: "running" | "done" | "failed" | "success";
  /**
   * This entry is the model's reasoning rather than an action it took, and `text`
   * is what it said.
   *
   * Reasoning lives in the *same ordered list* as the actions on purpose. The
   * runtime narrates what it is about to do and then does it, so ordering is the
   * part that makes the flow readable — "I'm checking the payout reset" followed by
   * the command that checked it — and two arrays would have to be re-interleaved on
   * a timestamp apiece to get that back, after the fact.
   */
  kind?: "reasoning";
  /** The reasoning text, when `kind` is "reasoning". */
  text?: string;
  /**
   * What the command printed, for a step that ran one.
   *
   * Captured from the runtime's own output deltas, which this side used to drop —
   * so a step read "Run Command — npm test" with no way to see what it said, and
   * the answer to "why did that fail?" was to run it again by hand. Capped, because
   * this is stored on the message: the terminal and the Output panel are where a
   * full log belongs.
   */
  output?: string;
  /**
   * The files a change step touched, by path.
   *
   * `detail` names them for reading; these are what makes the row *do* something —
   * one file opens its diff, several open a list of the same. Without them a step
   * that edited six files was a label with no way through to any of them.
   */
  paths?: string[];
  /**
   * What an MCP tool call reported while it ran, when it reported anything.
   *
   * A tool call that talks to a server can take a while and says so; without this
   * the step sat unchanged for the whole time, which reads as a hang.
   */
  progress?: string;
}

/**
 * What one run cost, as the provider counted it.
 *
 * Reported by the runtime on every turn and, until now, dropped — so the only way
 * to answer "what did that cost me?" was the provider's dashboard. Input tokens
 * dominate (one real run on this machine: 197,625 in against 16,339 out, because
 * context is re-sent every step), which is a thing worth seeing while you work
 * rather than afterwards.
 */
export interface RunTokens {
  input: number;
  output: number;
  /** Input tokens served from the provider's cache — the cheap ones. */
  cached?: number;
  /** Output tokens the model spent thinking, when the provider separates them. */
  reasoning?: number;
  total: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  images?: string[];
  /**
   * Files folded into this message's prompt, by path. The prompt carries their
   * text; the transcript shows these, because a reader wants to see what they
   * attached rather than a hundred lines of it.
   */
  attachedPaths?: string[];
  timestamp: number;
  /**
   * How long this turn worked for, so the transcript can say so.
   *
   * A start time answers "when did I ask?"; after a run that took seven minutes, what
   * the reader wants to know is that it took seven minutes — and the start time is
   * the less interesting half of that. Absent while it is still running, and on
   * messages recorded before this existed.
   *
   * A duration rather than an end time on purpose: an agent turn stops its clock
   * while it is waiting on the human, so the number that matters is the work it did,
   * not `end - start` (which would count the waiting).
   */
  durationMs?: number;
  /** What the provider counted for this turn, when it reported it. */
  tokens?: RunTokens;
  provider?: string;
  model?: string;
  isStreaming?: boolean;
  steps?: AgentStep[];
  error?: boolean;
  errorType?: "offline" | "timeout" | "syntax" | "api" | "general";
  /**
   * Files this turn changed, with line counts — the change log.
   *
   * Stored on the message so it survives: it answers "what did it just do?" live,
   * and "what did it do an hour ago?" when you scroll back. Replaces a
   * `diffPreview` field that nothing ever read or wrote.
   */
  changes?: { path: string; added: number; removed: number }[];
}

export interface StreamChatParams {
  provider: string;
  model: string;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  images?: string[];
  projectRoot?: string;
  /**
   * What the reader is looking at. The engine turns these into code context for
   * the turn — see `_code_context_block` in `core-engine/ai_cli.py`.
   *
   * A chat turn used to carry a map of the project (LOC, frameworks, symbol
   * names) and no code at all, which is fine for a frontier model and useless for
   * a small local one: with nothing to read it answers generically about a
   * repository it has never seen.
   */
  activePath?: string;
  selection?: string;
  baseUrl?: string;
  apiKey?: string;
  signal?: AbortSignal;
  onDelta: (deltaText: string) => void;
  onDone: (metadata?: any) => void;
  onError: (errorMessage: string) => void;
}

export async function streamChatCompletion({
  provider,
  model,
  messages,
  images,
  projectRoot = "",
  activePath = "",
  selection = "",
  baseUrl = "",
  apiKey = "",
  signal,
  onDelta,
  onDone,
  onError,
}: StreamChatParams): Promise<void> {
  // The packaged app has no dev server; prefer the app's own channel when it exists.
  if (hasIpc()) {
    await streamViaIpc({
      provider,
      model,
      messages,
      images,
      projectRoot,
      activePath,
      selection,
      baseUrl,
      apiKey,
      signal,
      onDelta,
      onDone,
      onError,
    });
    return;
  }

  // No desktop shell: `chat_stream` is how a reply arrives, and there is no
  // fallback transport any more.
  onError(DESKTOP_REQUIRED_MESSAGE);
}
