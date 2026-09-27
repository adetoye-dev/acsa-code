/**
 * providerRetry.ts — when the provider keeps failing, stop and say so.
 *
 * Why this exists: NVIDIA NIM's gateway answered 504 to every attempt, and the
 * runtime's response was to retry the sampling request five times per turn, with
 * minutes between rounds. A user watched "Working … of 20m" for twenty minutes and
 * got nothing back — not an answer, and not a reason either. The reason existed the
 * whole time, in the runtime's stderr and in the adapter's log, which is not where
 * a person looks.
 *
 * The runtime will not stop on our behalf. Measured against an upstream that always
 * answers 504: `response.failed` is a *transport* retry to it (five rounds, then
 * nothing), and completing the stream with a failed response instead stops the
 * retrying but makes it report nothing at all — and the app then reads the turn as
 * an empty success, which is worse. So the app counts, and stops.
 */

/** How many provider-failure lines the app lets past before it gives up. */
export const PROVIDER_RETRY_LIMIT = 4;

/**
 * The provider's own words, when a runtime line says it is retrying a failure.
 *
 * Handles both shapes the runtime writes: the plain tracing line with
 * `sampling_error=…`, and the JSON form (`"sampling_error":"…"`) that the
 * app-server emits. Returns `null` for anything that is not that line, so the
 * caller can use it as a filter.
 */
export function providerRetryReason(line: string): string | null {
  if (!line.includes("retrying sampling request")) return null;
  const match = /sampling_error["']?\s*[:=]\s*["']?([^"\\\n]+)/i.exec(line);
  let reason = (match?.[1] ?? "").trim().replace(/["',\s]+$/, "");
  // The reason is usually wrapped in the transport's own sentence. Keep the part
  // that came from the provider, which is the part that names a fix.
  reason = reason.replace(/^stream disconnected[^:]*:\s*/i, "");
  return reason || "the provider failed and the runtime is retrying it";
}
