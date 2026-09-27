import { describe, expect, it } from "vitest";
import { PROVIDER_RETRY_LIMIT, providerRetryReason } from "./providerRetry";

/**
 * The lines are copied from a real run: NVIDIA NIM's gateway answered 504 to every
 * attempt, the runtime retried, and the chat showed nothing at all for twenty
 * minutes. Both shapes appear — the plain tracing line and the JSON form the
 * app-server writes.
 */
describe("reading a provider retry out of a runtime line", () => {
  const PLAIN =
    "2026-09-27T13:43:03Z  WARN codex_core::responses_retry: stream disconnected - retrying " +
    "sampling request (1/5 in 207ms)... turn_id=01a0e31a retries=1 max_retries=5 " +
    "sampling_error=stream disconnected before completion: the provider timed out at its own gateway (504) — a loaded free tier does this";

  const JSON_FORM =
    '{"timestamp":"2026-09-27T13:22:20.974130Z","level":"WARN","fields":{"message":"stream ' +
    'disconnected - retrying sampling request (1/5 in 190ms)...","turn_id":"01a0e303",' +
    '"sampling_error":"stream disconnected before completion: the provider timed out at its own gateway (504)"}}';

  it("keeps the provider's own words, not the transport's wrapper", () => {
    expect(providerRetryReason(PLAIN)).toBe(
      "the provider timed out at its own gateway (504) — a loaded free tier does this",
    );
  });

  it("reads the JSON shape the app-server writes", () => {
    expect(providerRetryReason(JSON_FORM)).toBe(
      "the provider timed out at its own gateway (504)",
    );
  });

  it("falls back to a sentence when the line names no reason", () => {
    expect(
      providerRetryReason("stream disconnected - retrying sampling request (2/5 in 399ms)..."),
    ).toBe("the provider failed and the runtime is retrying it");
  });

  it("is a filter: ordinary runtime lines are not retries", () => {
    for (const line of [
      "",
      "warning: Model metadata for `x` not found.",
      "codex_models_manager: unknown model is used",
      "turn.completed",
      "apply_patch verification failed: invalid hunk at line 2",
    ]) {
      expect(providerRetryReason(line), line).toBeNull();
    }
  });

  it("lets a handful through before giving up — a blip is not a failure", () => {
    expect(PROVIDER_RETRY_LIMIT).toBeGreaterThan(1);
    expect(PROVIDER_RETRY_LIMIT).toBeLessThanOrEqual(6);
  });
});
