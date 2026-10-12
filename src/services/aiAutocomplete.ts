/**
 * aiAutocomplete.ts — Monaco Inline Completions (AI Ghost Text)
 *
 * Implements monaco.languages.registerInlineCompletionsProvider with:
 * 1. Fill-In-The-Middle for local models, using Ollama's own template (`suffix`)
 *    rather than hand-rolled `<|fim_*|>` tokens — see `fetchCompletion`.
 * 2. Keystroke debouncing, a bounded wait, and an answer cache.
 * 3. Local Ollama directly; every cloud provider through the engine, which is the
 *    only side that can see a credential; a heuristic synthesizer as the last resort.
 *
 * Every number here came from measuring the daemon rather than guessing: see the
 * comments on the constants below.
 */

import type * as MonacoType from "monaco-editor";
import { aiFetch } from "./aiClient";
import { modelCapabilities } from "./aiModelManager";
/**
 * The fields editor AI calls actually need. Both the legacy `AISettings` blob
 * and the resolved editor config (which prefers a configured cloud provider)
 * satisfy this, so callers are free to pass either.
 */
export interface EditorAiSettings {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  /**
   * Ghost text is on unless this says otherwise.
   *
   * It spends tokens on every pause, so it has to be something a person can turn
   * off — but shipping it off would mean the feature nobody finds is the one that
   * costs the user nothing to have on. Absent means on.
   */
  inlineCompletion?: boolean;
}

let activeAbortController: AbortController | null = null;
let debounceTimer: any = null;
let pendingResolver: ((value: any) => void) | null = null;

/**
 * A suggestion that arrives after the reader typed on is worse than none, so the
 * wait is bounded and a late answer is dropped.
 *
 * The bound has to clear the floor, though. Measured on a warm 7B local model: 24
 * tokens in ~1.15s, 48 in ~2.3s — generation dominates, at roughly 48ms a token, and
 * a first call that has to load the model measured 4.4s. So the cap sits above the
 * steady state and deliberately drops the cold-load case: `keep_alive` below makes
 * that a one-per-session cost rather than one per keystroke. A tighter cap does not
 * make local completions arrive sooner, it only makes sure they never arrive.
 */
const COMPLETION_TIMEOUT_MS = 2500;
/** A local model pays for the load, not the trip; a cloud one is the other way. */
const LOCAL_DEBOUNCE_MS = 200;
const CLOUD_DEBOUNCE_MS = 120;
/** A completion is a few lines, never a patch. Measured: 24 tokens covers ~2 lines. */
const COMPLETION_MAX_TOKENS = 24;
/** Beyond a few lines it is not an autocomplete, it is a patch. */
const COMPLETION_MAX_LINES = 6;
const COMPLETION_MAX_CHARS = 400;
const CACHE_LIMIT = 200;

/**
 * Re-typing a character is free.
 *
 * Keyed on the model and the text either side of the cursor, which is everything
 * the answer depends on.
 */
const completionCache = new Map<string, string>();

function cacheKey(settings: EditorAiSettings, prefix: string, suffix: string): string {
  return `${settings.provider}:${settings.model}::${prefix.slice(-200)}::${suffix.slice(0, 80)}`;
}

function rememberCompletion(key: string, suggestion: string): void {
  completionCache.set(key, suggestion);
  if (completionCache.size > CACHE_LIMIT) {
    const oldest = completionCache.keys().next().value;
    if (oldest !== undefined) completionCache.delete(oldest);
  }
}

/**
 * What the model returned, reduced to something safe to insert.
 *
 * The fence handling is not defensive tidiness. A Qwen model asked with the
 * hand-rolled FIM tokens answered with the whole prefix echoed back inside a
 * ```typescript block — inserting that writes the file into itself — so an answer
 * that repeats what is already there is dropped, and a fence is never code.
 */
export function sanitizeCompletion(raw: string, prefix: string, suffix: string): string {
  let text = (raw || "").replace(/\r\n?/g, "\n");

  const fenced = text.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) text = fenced[1];
  text = text.replace(/^\s*```[^\n]*\n?/, "").replace(/\n?```\s*$/, "");

  // A prefix echoed back is not part of the completion: keep what follows it.
  const tail = prefix.slice(-120).trimEnd();
  if (tail) {
    const echoed = text.indexOf(tail);
    if (echoed !== -1) {
      // The echo boundary falls mid-line, so the space that follows it is part of
      // the repeat, not part of the answer.
      text = text.slice(echoed + tail.length).replace(/^[ \t]*\n?/, "");
    }
  }

  text = text.replace(/[ \t]+$/gm, "");
  if (!text.trim()) return "";

  const lines = text.split("\n");
  if (lines.length > COMPLETION_MAX_LINES) text = lines.slice(0, COMPLETION_MAX_LINES).join("\n");
  if (text.length > COMPLETION_MAX_CHARS) text = text.slice(0, COMPLETION_MAX_CHARS);

  // Saying the same thing again is not a suggestion, and neither is a line the
  // reader is already inside a comment on.
  if (prefix.endsWith(text)) return "";
  const alreadyThere = suffix.replace(/^\s+/, "").slice(0, 40).trim();
  if (alreadyThere && text.trim() === alreadyThere) return "";
  const currentLine = prefix.slice(prefix.lastIndexOf("\n") + 1);
  if (/\/\//.test(currentLine) || currentLine.includes("/*")) return "";

  return text;
}

export function registerAiInlineCompletions(
  monaco: typeof MonacoType,
  getSettings: () => EditorAiSettings
): MonacoType.IDisposable {
  return monaco.languages.registerInlineCompletionsProvider("*", {
    provideInlineCompletions: async (model, position, _context, token) => {
      // Abort previous in-flight completion if user keeps typing
      if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
      }

      if (debounceTimer) {
        pendingResolver?.({ items: [] });
        pendingResolver = null;
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }

      // Check cancellation token
      if (token.isCancellationRequested) {
        return { items: [] };
      }

      const settings = getSettings();
      if (settings.inlineCompletion === false) {
        return { items: [] };
      }

      // Extract context around cursor
      const textBeforeCursor = model.getValueInRange({
        startLineNumber: Math.max(1, position.lineNumber - 50),
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      const textAfterCursor = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: Math.min(model.getLineCount(), position.lineNumber + 30),
        endColumn: model.getLineMaxColumn(Math.min(model.getLineCount(), position.lineNumber + 30)),
      });

      // Avoid suggesting if cursor is on whitespace-only and text before is empty
      if (!textBeforeCursor.trim() && !textAfterCursor.trim()) {
        return { items: [] };
      }

      const key = cacheKey(settings, textBeforeCursor, textAfterCursor);
      const cached = completionCache.get(key);
      if (cached !== undefined) {
        // Answered before the debounce, so holding a key costs nothing.
        return cached
          ? {
              items: [
                {
                  insertText: cached,
                  range: new monaco.Range(
                    position.lineNumber,
                    position.column,
                    position.lineNumber,
                    position.column
                  ),
                },
              ],
            }
          : { items: [] };
      }

      return new Promise((resolve) => {
        pendingResolver = resolve;
        debounceTimer = setTimeout(async () => {
          pendingResolver = null;
          debounceTimer = null;
          if (token.isCancellationRequested) {
            resolve({ items: [] });
            return;
          }

          const controller = new AbortController();
          activeAbortController = controller;
          // The deadline and the fetch share a controller: past it, the request is
          // abandoned rather than left to arrive as a suggestion nobody wants.
          const deadline = setTimeout(() => controller.abort(), COMPLETION_TIMEOUT_MS);

          try {
            const raw = await fetchCompletion({
              prefix: textBeforeCursor,
              suffix: textAfterCursor,
              settings,
              signal: controller.signal,
            });

            if (token.isCancellationRequested) {
              resolve({ items: [] });
              return;
            }

            const suggestion = sanitizeCompletion(raw, textBeforeCursor, textAfterCursor);
            // Remembered either way: "nothing here" is an answer too, and asking
            // again for the same text is the most expensive way to learn it.
            rememberCompletion(key, suggestion);

            if (!suggestion) {
              resolve({ items: [] });
              return;
            }

            resolve({
              items: [
                {
                  insertText: suggestion,
                  range: new monaco.Range(
                    position.lineNumber,
                    position.column,
                    position.lineNumber,
                    position.column
                  ),
                },
              ],
            });
          } catch {
            resolve({ items: [] });
          } finally {
            clearTimeout(deadline);
            if (activeAbortController === controller) {
              activeAbortController = null;
            }
          }
        }, settings.provider === "ollama" ? LOCAL_DEBOUNCE_MS : CLOUD_DEBOUNCE_MS);
      });
    },
    disposeInlineCompletions: () => {},
  });
}

export interface FetchParams {
  prefix: string;
  suffix: string;
  settings: EditorAiSettings;
  signal: AbortSignal;
}

/**
 * At most one engine completion in flight.
 *
 * An engine call spawns a Python process and cannot be aborted from here, so the
 * keystroke that cancels a request cancels nothing on that side. Firing one per
 * pause would leave a process behind each time. A second request while one is out
 * gets no suggestion rather than the first one's answer: a completion for text
 * that has moved is worse than none.
 */
let cloudCompletion: Promise<string | null> | null = null;

function requestEngineCompletion(params: FetchParams): Promise<string | null> {
  if (cloudCompletion) return Promise.resolve(null);
  const { prefix, suffix, settings } = params;
  const { provider, model, apiKey, baseUrl } = settings;
  const pending: Promise<string | null> = aiFetch("/api/ai/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, model, prefix, suffix, baseUrl, apiKey }),
  })
    .then(async (res) => {
      if (!res.ok) return null;
      const data = (await res.json()) as { ok?: boolean; completion?: string };
      return data?.ok && typeof data.completion === "string" ? data.completion : null;
    })
    .catch(() => null)
    .finally(() => {
      if (cloudCompletion === pending) cloudCompletion = null;
    });
  cloudCompletion = pending;
  return pending;
}

/** Wait for `work`, but not past `ms`. A late answer is not an answer. */
function withDeadline(work: Promise<string | null>, ms: number): Promise<string | null> {
  return Promise.race([
    work,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * The suffix a fill-in-the-middle request needs, which is not always the suffix
 * that is there.
 *
 * With nothing after the cursor — the end of the file, which is the most common
 * place to want a completion — an empty suffix takes the model out of FIM mode
 * entirely and it answers as a chat bot. Measured, all three of "end of file",
 * "mid-identifier" and "after a dot" returned prose on every attempt ("It looks
 * like you're trying to find a user in your database using Prisma, but the code
 * snippet you provided is…") and took ~4s, past any deadline worth having.
 *
 * A newline is enough to put it back: the same call returned `"\n  });\n}"` in
 * 257ms. It is also the honest assumption — a file ends with a newline, so the
 * cursor at the end of one has a line break after it.
 */
export function fimSuffix(suffix: string): string {
  return suffix || "\n";
}

export async function fetchCompletion({
  prefix,
  suffix,
  settings,
  signal,
}: FetchParams): Promise<string> {
  const { provider, model, apiKey, baseUrl } = settings;

  // 1. Ollama, asked only the way the model itself supports fill-in-the-middle.
  //
  // `suffix` makes Ollama apply the model's own FIM template, which is the one
  // thing that works: measured, qwen2.5-coder returned `email },` and carried on
  // correctly. The hand-rolled `<|fim_prefix|>…<|fim_middle|>` prompt that used to
  // be the fallback is a template most models do not have, and every way it misses
  // was measured. qwen2.5-coder handed it echoed the whole prefix back inside a
  // ```typescript fence — a suggestion that writes the file into itself.
  // deepseek-coder:6.7b, which has no FIM template and answers HTTP 400 to
  // `suffix`, answered the tokens with a paragraph of prose ("The function you
  // provided is a TypeScript function that uses Prisma…") that would be typed
  // straight into the file. Neither is a completion, so the fallback is gone: a
  // model that cannot insert gets no suggestion, which is the honest answer.
  //
  // Ollama already says which models those are — `insert` is the capability flag
  // for "the template has a FIM section", and it agreed with the measurement on
  // every model here. Asking anyway is not free: the daemon loads the model to
  // refuse, and a 9B took 15.9s to say no. Capabilities we have not been told are
  // not held against the model; it gets the request and a 400 returns nothing.
  if (provider === "ollama") {
    const capabilities = modelCapabilities("ollama", model);
    if (capabilities && !capabilities.includes("insert")) return "";

    const url = (baseUrl || "http://127.0.0.1:11434") + "/api/generate";
    const options = { num_predict: COMPLETION_MAX_TOKENS, temperature: 0.1 };
    // `keep_alive`, so the model is not unloaded between keystrokes: a cold load
    // measured 4.4s against ~1.15s warm (24 tokens), and that is the difference
    // between a suggestion and an interruption.
    const common = {
      model: model || "qwen2.5-coder:7b",
      stream: false,
      options,
      keep_alive: "30m",
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...common, prompt: prefix, suffix: fimSuffix(suffix) }),
      signal,
    });
    if (res.ok) {
      const data = await res.json();
      return data.response || "";
    }
    return "";
  }

  // 2. Cloud, through the engine — because that is where the key is.
  //
  // Credentials are write-only across the app's own API: the registry never hands
  // a key back to the page, so `apiKey` below is empty for a provider the user has
  // configured, and a direct call from here goes out unauthenticated and returns
  // nothing. The engine resolves the key exactly as it does for review and inline
  // edit, which is why this is the first attempt for anything that is not the local
  // daemon. A browser (no IPC) gets a 501 and falls through to the direct call,
  // which is the best a page with no backend can do.
  const viaEngine = await withDeadline(
    requestEngineCompletion({ prefix, suffix, settings, signal }),
    COMPLETION_TIMEOUT_MS,
  );
  if (viaEngine !== null && viaEngine !== "") return viaEngine;

  /**
   * Cohere is the one provider here that does not speak the OpenAI dialect.
   *
   * Every other entry in the registry — OpenAI, Groq, DeepSeek, xAI, NVIDIA,
   * Google's compatibility endpoint, Moonshot, Together, OpenRouter — is a
   * `/chat/completions` call against its own `baseUrl`. Naming only `openai` here
   * meant the resolver could hand this function a Groq key and get nothing back:
   * completion was silently dead for every provider but two, which is exactly the
   * "all capable models, local or cloud" this exists to provide. These branches
   * are the fallback now — reached when a key *was* handed to the page, or when
   * the engine is unreachable.
   */
  if (provider === "cohere" && apiKey) {
    const res = await fetch((baseUrl || "https://api.cohere.ai/v1") + "/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        message: `Prefix:\n${prefix}\n\nSuffix:\n${suffix}\n\nComplete the code:`,
        preamble:
          "You are an inline code autocomplete engine. Output ONLY the code to insert. No markdown fences, no explanation.",
        max_tokens: COMPLETION_MAX_TOKENS,
        temperature: 0.1,
      }),
      signal,
    });
    if (res.ok) {
      const data = await res.json();
      return data.text || "";
    }
    return "";
  }

  // 3. Every OpenAI-compatible provider, by its own base URL.
  if (apiKey) {
    const url = (baseUrl || "https://api.openai.com/v1") + "/chat/completions";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are an inline code autocomplete engine. Complete the code at the cursor. Output ONLY the code to insert. Do NOT include markdown code blocks or explanations.",
          },
          {
            role: "user",
            content: `Prefix:\n${prefix}\n\nSuffix:\n${suffix}\n\nComplete the code:`,
          },
        ],
        max_tokens: COMPLETION_MAX_TOKENS,
        temperature: 0.1,
      }),
      signal,
    });

    if (res.ok) {
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "";
    }
  }

  // 4. Deterministic Offline AST / Heuristic Synthesizer Fallback
  return getOfflineSnippetCompletion(prefix);
}

function getOfflineSnippetCompletion(prefix: string): string {
  const lastLine = prefix.split("\n").pop() || "";
  const trimmed = lastLine.trim();

  if (trimmed.startsWith("def ") && trimmed.endsWith(":")) {
    return "\n    \"\"\"Docstring generated by ACSA Code.\"\"\"\n    pass";
  }
  if (trimmed === "import ") {
    return "sys, os, time\nfrom typing import Dict, List, Optional";
  }
  if (trimmed.startsWith("class ") && trimmed.endsWith(":")) {
    return "\n    def __init__(self):\n        super().__init__()";
  }
  if (trimmed.includes("try:") || trimmed === "try:") {
    return "\n    result = True\nexcept Exception as exc:\n    logger.error(exc)";
  }
  if (trimmed.startsWith("if __name__ ==")) {
    return ' "__main__":\n    main()';
  }

  return "";
}

export interface InlineEditResult {
  ok: boolean;
  replacement?: string;
  reason?: string;
}

/**
 * Last line of defence before an AI replacement is applied to the editor.
 *
 * The bridge already cleans and bounds the replacement, but that guard must
 * never be the only one: a replacement far larger than the range it replaces
 * rewrites the file (the reported "review broke my file"). Returns a reason
 * when the replacement must not be applied.
 */
export function validateReplacement(
  replacement: string,
  replacedCode: string
): { ok: boolean; reason: string } {
  const next = (replacement || "").replace(/\r\n/g, "\n").trim();
  if (!next) return { ok: false, reason: "The model returned no usable code." };
  if (next.includes("```")) {
    return { ok: false, reason: "The model wrapped its answer in a code fence; nothing was applied." };
  }
  const replacedLines = Math.max(1, (replacedCode || "").split("\n").length);
  const producedLines = next.split("\n").length;
  const ceiling = Math.max(replacedLines * 3, replacedLines + 60);
  if (producedLines > ceiling) {
    return {
      ok: false,
      reason: `The model returned ${producedLines} lines for a ${replacedLines}-line edit, so it was not applied.`,
    };
  }
  if (next === (replacedCode || "").replace(/\r\n/g, "\n").trim()) {
    return { ok: false, reason: "The model returned the code unchanged." };
  }
  return { ok: true, reason: "" };
}

export async function executeInlineEdit({
  instruction,
  selectedCode,
  surroundingPrefix,
  surroundingSuffix,
  settings,
  signal,
}: {
  instruction: string;
  selectedCode: string;
  surroundingPrefix: string;
  surroundingSuffix: string;
  settings: EditorAiSettings;
  signal?: AbortSignal;
}): Promise<InlineEditResult> {
  const { provider, model, apiKey, baseUrl } = settings;
  const timeoutController = new AbortController();
  const timeoutId = window.setTimeout(() => timeoutController.abort(), 30000);
  const abortRelay = () => timeoutController.abort();
  signal?.addEventListener("abort", abortRelay, { once: true });
  const requestSignal = timeoutController.signal;
  const finish = (result: InlineEditResult) => {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortRelay);
    return result;
  };

  // 1. Try server bridge /api/ai/inline-edit (supports all providers, avoids browser CORS)
  try {
    const res = await aiFetch("/api/ai/inline-edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        model,
        instruction,
        selectedCode,
        surroundingPrefix,
        surroundingSuffix,
        baseUrl,
        apiKey,
      }),
      signal: requestSignal,
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      if (data.ok && typeof data.replacement === "string" && data.replacement.trim()) {
        return finish({ ok: true, replacement: data.replacement });
      }
      return finish({ ok: false, reason: data.reason || `Inline edit request failed (${res.status})` });
    }
  } catch (err: any) {
    if (err?.name === "AbortError") return finish({ ok: false, reason: "Inline edit request was cancelled or timed out." });
    return finish({ ok: false, reason: `Inline edit request failed: ${err?.message || err}` });
  }

  // 2. Direct client fallback for local Ollama
  if (provider === "ollama") {
    const systemPrompt =
      "You are a precise code editing assistant. Given existing code and user instructions, return ONLY the updated replacement code without commentary, explanations, or markdown fences.";
    const userPrompt = `Context before:\n${surroundingPrefix.slice(-600)}\n\nCode to edit:\n${selectedCode}\n\nContext after:\n${surroundingSuffix.slice(0, 600)}\n\nInstruction: ${instruction}\n\nEmit updated code:`;
    const url = (baseUrl || "http://127.0.0.1:11434") + "/api/generate";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model || "qwen2.5-coder:7b",
          prompt: `${systemPrompt}\n\n${userPrompt}`,
          stream: false,
          options: { temperature: 0.2, num_predict: 1024 },
        }),
        signal: requestSignal,
      });
      if (res.ok) {
        const data = await res.json();
        let text = (data.response || "").trim();
        if (text.startsWith("```")) {
          text = text.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "");
        }
        return text ? finish({ ok: true, replacement: text }) : finish({ ok: false, reason: "The model returned an empty replacement." });
      }
      return finish({ ok: false, reason: `Ollama request failed (${res.status})` });
    } catch (err: any) {
      return finish({ ok: false, reason: err?.name === "AbortError" ? "Inline edit request was cancelled or timed out." : `Ollama request failed: ${err?.message || err}` });
    }
  }

  return finish({ ok: false, reason: `Inline edits are not supported for provider '${provider}'.` });
}
