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
  /**
   * Set when nothing can produce a completion. Asking anyway costs a process per
   * pause and returns a refusal, so it is not asked. See `resolveCompletionAiConfig`.
   */
  completionsUnavailable?: "no-insertion-model" | "no-provider";
}

let activeAbortController: AbortController | null = null;
let debounceTimer: any = null;
let pendingResolver: ((value: any) => void) | null = null;

/**
 * A suggestion that arrives after the reader typed on is worse than none, so the
 * wait is bounded and a late answer is dropped.
 *
 * The bound has to clear the floor, though, and there are two of those. Ollama
 * reuses the prompt it has already evaluated, so a pause that continues the last
 * one is cheap — measured ~0.9s warm. A pause after an edit elsewhere in the file
 * is not: the prompt is evaluated from scratch, and measured 2.5s for the 287-token
 * window this used to send, 2.9s for the 470-token one it sends now. At 2.5s the
 * second case was dropped every time, which is the reader's most useful pause
 * disappearing. So the cap sits above it. Beyond that it really is too late, and
 * the cold-load case is still deliberately dropped: `keep_alive` makes that a
 * once-per-session cost rather than one per keystroke.
 */
const COMPLETION_TIMEOUT_MS = 3500;
/** A local model pays for the load, not the trip; a cloud one is the other way. */
const LOCAL_DEBOUNCE_MS = 200;
const CLOUD_DEBOUNCE_MS = 120;
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

/**
 * One provider for the app, however many editors are open.
 *
 * `registerInlineCompletionsProvider` registers against a *language*, not against an
 * editor, and Monaco asks every provider registered for the model
 * (`inlineCompletionsProvider.all(model)`). Registering from each editor tab — which
 * is what this did, once per mounted tab — therefore meant N identical providers
 * answering one cursor: the same suggestion offered N times as it becomes the "next"
 * one, and, worse, a keystroke in one pane aborting the request another pane was
 * waiting on, because the debounce and the in-flight request are one per module.
 *
 * Every editor is handed the same settings record, so a single registration reads
 * the same thing N of them did. The getter is replaced on each mount instead, so the
 * newest reader is the one consulted and an unmount costs nothing.
 *
 * The returned disposable is deliberately inert: the registration outlives any one
 * tab, and a tab closing must not take ghost text out of the workbench.
 */
let appRegistration: MonacoType.IDisposable | null = null;
let readSettings: (() => EditorAiSettings) | null = null;
const INERT: MonacoType.IDisposable = { dispose: () => {} };

export function registerAiInlineCompletions(
  monaco: typeof MonacoType,
  getSettings: () => EditorAiSettings
): MonacoType.IDisposable {
  readSettings = getSettings;
  if (appRegistration) return INERT;

  appRegistration = monaco.languages.registerInlineCompletionsProvider("*", {
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

      const settings = readSettings?.();
      if (!settings) return { items: [] };
      if (settings.inlineCompletion === false) {
        return { items: [] };
      }
      if (settings.completionsUnavailable) {
        return { items: [] };
      }

      const { prefix: textBeforeCursor, suffix: textAfterCursor } = completionContext(
        model,
        position
      );

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

  return INERT;
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

/** The head of the file: its imports, its types, its top-level constants. */
const CONTEXT_HEAD_LINES = 40;
/** The flow that leads to the cursor, and the code that follows it. */
const CONTEXT_BEFORE_LINES = 50;
const CONTEXT_AFTER_LINES = 30;
/** Marks where the stitched pieces skip from, so the jump is visible to the model. */
const CONTEXT_GAP = "// …";

/**
 * The text a completion is asked for, which is more than the cursor's neighbours.
 *
 * Measured on a realistic case — an interface declared near the top of a 253-line
 * file, the cursor ~75 lines later in a function that must return exactly its
 * fields — sending the 50 lines above the cursor produced `name: raw.name` and
 * `updatedAt: raw.updatedAt`: fields that do not exist. The interface was simply
 * not in the prompt, so the model guessed what a user record looks like, and a
 * confident wrong field is what gets inserted.
 *
 * Sending the whole file fixed it (email, displayName, createdAt — exactly right)
 * and was not slower, but a real file is not 253 lines. So the head and the tail
 * are stitched: the head carries the declarations, the tail carries the flow, and
 * the prompt stays bounded however long the file grows. The same answer, at 470
 * prompt tokens against 4748 for the whole file.
 *
 * When the two windows meet, they are one contiguous read instead — a duplicated
 * copy of the file in the prompt would be worse than either.
 */
export function completionContext(
  model: MonacoType.editor.ITextModel,
  position: MonacoType.IPosition
): { prefix: string; suffix: string } {
  const lineCount = model.getLineCount();
  const line = position.lineNumber;

  const headEnd = Math.min(CONTEXT_HEAD_LINES, lineCount);
  const tailStart = Math.max(1, line - CONTEXT_BEFORE_LINES);

  // Contiguous from line 1 when the windows would otherwise overlap or touch: for
  // a short file, or a cursor near the top, that is the whole file up to the
  // cursor, and it already contains the head.
  const prefix =
    tailStart <= headEnd + 1
      ? model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: line,
          endColumn: position.column,
        })
      : [
          model.getValueInRange({
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: headEnd,
            endColumn: model.getLineMaxColumn(headEnd),
          }),
          CONTEXT_GAP,
          model.getValueInRange({
            startLineNumber: tailStart,
            startColumn: 1,
            endLineNumber: line,
            endColumn: position.column,
          }),
        ].join("\n");

  const afterEnd = Math.min(lineCount, line + CONTEXT_AFTER_LINES);
  const suffix = model.getValueInRange({
    startLineNumber: line,
    startColumn: position.column,
    endLineNumber: afterEnd,
    endColumn: model.getLineMaxColumn(afterEnd),
  });

  return { prefix, suffix };
}

/**
 * One completion, from the engine.
 *
 * There used to be a second implementation here — direct HTTP from the page to
 * the daemon, and to whichever cloud dialect matched — and it could not work in
 * the app that ships. The webview is served under a CSP whose `connect-src` is
 * `'self'` plus one loopback dev port, so a fetch to Ollama on 11434 is refused
 * before it leaves the page: local completions were alive in a dev preview and
 * dead in the packaged build, which is the worst way for a feature to be wrong.
 * Cloud was no better — credentials are write-only across the app's own API, so
 * the key the page would need is never in the page.
 *
 * The engine resolves both: the daemon on loopback, or the provider's key, in the
 * same process that already serves review and inline edit. That is also one
 * implementation of each provider's dialect instead of two that have to be kept in
 * step, which is the lesson `engineBridge.ts` already records. Measured, the round
 * trip costs about 150ms on a warm 7B — 1.31s against 1.23s — because the model is
 * the slow part, not the transport.
 *
 * The fill-in-the-middle details (Ollama's `suffix`, the `insert` capability, the
 * newline an empty suffix needs) live with the engine that now sends the request;
 * see `complete` in `core-engine/ai_cli.py`, where they are measured and pinned.
 */
export async function fetchCompletion({
  prefix,
  suffix,
  settings,
  signal,
}: FetchParams): Promise<string> {
  const answered = await withDeadline(
    requestEngineCompletion({ prefix, suffix, settings, signal }),
    COMPLETION_TIMEOUT_MS,
  );
  // Nothing arrives when the engine is unreachable, the request was superseded, or
  // the deadline passed. There is deliberately no synthesizer underneath: a
  // deterministic stub rendered as ghost text is a completion that looks like the
  // model's work and is not, which is the failure this whole path exists to avoid.
  return answered ?? "";
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
  // 60s, not 30: a local model's *first* edit pays for loading the model, and a cold
  // 7B there can outlast a half-minute before it has produced a token. The engine's
  // own ceiling is 180s; this one exists so a request cannot hang the editor forever.
  const timeoutId = window.setTimeout(() => timeoutController.abort(), 60000);
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
      if (data.ok && typeof data.replacement === "string") {
        if (data.replacement.trim()) return finish({ ok: true, replacement: data.replacement });
        // `ok` with nothing in it: a model that answered without code. Worth its own
        // sentence, because "try again" is the actual remedy and the reader cannot
        // read that from a status code.
        return finish({
          ok: false,
          reason: "The model returned no code for this edit — try again, or choose another model for editor edits.",
        });
      }
      /*
       * The engine reports its refusals under `error`; only the sanitizer path fills
       * `reason`. Reading `reason` alone turned every one of them — a missing key, an
       * empty reply, a provider 402 — into "Inline edit request failed (200)", because
       * the HTTP call itself had succeeded. Reported from use as "Fix with AI is
       * failing", with no way to tell what had failed. `aiReview` reads `error` and
       * always did; this was the one path that did not.
       */
      return finish({
        ok: false,
        reason: data.reason || data.error || `The inline edit returned nothing (${res.status}).`,
      });
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
