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
  provider?: string;
  model?: string;
  isStreaming?: boolean;
  thinking?: string;
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
