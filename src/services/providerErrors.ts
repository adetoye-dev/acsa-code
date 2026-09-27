/**
 * providerErrors.ts — what actually went wrong, in words the user can act on.
 *
 * A dead provider used to reach the transcript as "The task needs attention.
 * Review Problems or Output for details." — which is true, and useless. The runtime
 * does say what happened, but it says it in its own vocabulary, five times, with a
 * retry line between each:
 *
 *     ERROR: unexpected status 401 Unauthorized: Authentication Fails, Your api
 *     key: ****0000 is invalid (request_id: ...), url: https://api.deepseek.com/v1/responses
 *     ERROR: Reconnecting... 5/5
 *
 * Captured by running the bundled runtime against a deliberately bad key. The job
 * here is to turn that into one sentence that names the cause, the provider and the
 * next step — and to return nothing at all rather than invent a cause it cannot
 * support, so an unrecognised failure keeps the old behaviour instead of acquiring
 * a confident wrong explanation.
 */
import type { PipelineOutputLine } from "../types/telemetry";

/** The host a failure mentions, when it names one. `api.deepseek.com`. */
export function providerHostIn(raw: string): string | null {
  const match = raw.match(/https?:\/\/([^/\s"')]+)/i);
  return match ? match[1] : null;
}

/**
 * One sentence for a provider failure, or `null` when this is not one we recognise.
 *
 * `null` is deliberate: guessing a cause is worse than the generic sentence,
 * because a wrong diagnosis sends the user to fix the wrong thing.
 */
export function explainProviderFailure(raw: string): string | null {
  const text = raw.toLowerCase();
  const host = providerHostIn(raw);
  const at = host ? ` (${host})` : "";

  // Order matters: a 401 body often contains the word "invalid", and a quota
  // message often arrives as a 429, so the specific statuses come first.
  if (/\b401\b|unauthorized/.test(text)) {
    return `The provider rejected the API key${at}. Check the key for this provider in Settings → Providers & API keys.`;
  }
  if (/\b403\b|forbidden/.test(text)) {
    return `The provider refused the request as not permitted${at}. The key may lack access to this model.`;
  }
  if (/\b402\b|insufficient|quota|credit|balance/.test(text)) {
    return `The provider says the account has no credit left${at}. Top it up, or pick another provider.`;
  }
  if (/\b429\b|rate limit|too many requests/.test(text)) {
    return `The provider is rate limiting this account${at}. Wait a moment and send again.`;
  }
  if (/\b404\b|model[_ ]not[_ ]found|unknown model|does not exist/.test(text)) {
    return `The provider does not recognise that model name${at}. Pick another model for this provider.`;
  }
  if (/context length|maximum context|too many tokens|context window/.test(text)) {
    return "This conversation no longer fits the model's context window. Start a new chat, or pick a model with a larger one.";
  }
  if (/\b5(00|02|03|04)\b|internal server error|bad gateway|service unavailable/.test(text)) {
    return `The provider returned a server error${at}. That is usually temporary — send again in a moment.`;
  }
  if (/dns|failed to connect|connection refused|connection reset|timed out|timeout|error sending request/.test(text)) {
    return `Could not reach the provider${at}. Check your network, or the base URL in Settings → Providers & API keys.`;
  }
  return null;
}

/**
 * The most useful sentence available from a run's output.
 *
 * Scans the *stderr* lines only, skips the "Reconnecting… n/5" notices the runtime
 * prints around a real error, and ignores anything it cannot classify rather than
 * promoting noise into the transcript.
 */
export function summarizeFailure(log: PipelineOutputLine[]): string | null {
  const errors = log
    .filter((line) => line.stream === "stderr")
    .map((line) => line.content)
    .filter((content) => /\berror\b/i.test(content) && !/reconnecting/i.test(content));

  // Last first: it is the line that ended the run. The informative one is often the
  // *first* of a retry run, so keep walking until one explains something.
  for (let i = errors.length - 1; i >= 0; i -= 1) {
    const explained = explainProviderFailure(errors[i]);
    if (explained) return explained;
  }
  return null;
}
