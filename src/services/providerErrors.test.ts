import { describe, expect, it } from "vitest";
import { explainProviderFailure, providerHostIn, summarizeFailure } from "./providerErrors";
import type { PipelineOutputLine } from "../types/telemetry";

/** The real thing, copied from a run of the bundled runtime with a bad key. */
const REAL_401 =
  "ERROR: unexpected status 401 Unauthorized: Authentication Fails, Your api key: " +
  "****0000 is invalid (request_id: 3aba3fb8-d117-46d7-8833-31ca966c1899), " +
  "url: https://api.deepseek.com/v1/responses";

const line = (content: string): PipelineOutputLine => ({
  line_number: 0,
  content,
  stream: "stderr",
  is_json: false,
});

/** The shape the runtime actually prints: one retry notice per attempt, then the error twice. */
const retryRun = [
  line("2026-09-24T11:34:38Z WARN codex_core::responses_retry: stream disconnected - retrying sampling request (1/5 in 192ms)... sampling_error=unexpected status 401 Unauthorized: Authentication Fails, Your api key: ****0000 is invalid, url: https://api.deepseek.com/v1/responses"),
  line("ERROR: Reconnecting... 1/5"),
  line("ERROR: Reconnecting... 5/5"),
  line(REAL_401),
  line(REAL_401),
];

describe("explaining a provider failure", () => {
  it("turns a rejected key into an instruction, and names the host", () => {
    const explained = explainProviderFailure(REAL_401);
    expect(explained).toContain("rejected the API key");
    expect(explained).toContain("api.deepseek.com");
    // Where to fix it, not just what broke.
    expect(explained).toContain("Settings");
  });

  it("distinguishes the failures a user would fix differently", () => {
    expect(explainProviderFailure("unexpected status 429 Too Many Requests")).toContain("rate limiting");
    expect(explainProviderFailure('402 Payment Required: Insufficient Balance')).toContain("no credit");
    expect(explainProviderFailure("404 model not found: deepseek-v9")).toContain("model name");
    expect(explainProviderFailure("error sending request: dns error")).toContain("Could not reach");
    expect(explainProviderFailure("502 Bad Gateway")).toContain("server error");
    expect(explainProviderFailure("maximum context length exceeded")).toContain("context window");
  });

  it("says nothing rather than guessing at a failure it does not know", () => {
    // The important one. A confident wrong diagnosis sends someone to fix the wrong
    // thing, so an unrecognised failure must leave the old generic sentence alone.
    expect(explainProviderFailure("the turn ended without producing an answer")).toBeNull();
    expect(explainProviderFailure("")).toBeNull();
  });

  it("reads the host out of a URL, and copes when there is not one", () => {
    expect(providerHostIn(REAL_401)).toBe("api.deepseek.com");
    expect(providerHostIn("401 Unauthorized")).toBeNull();
    // No host, no parenthetical — not "(null)".
    expect(explainProviderFailure("401 Unauthorized")).not.toContain("(");
  });
});

describe("summarising a failed run", () => {
  it("finds the informative error instead of the retry notices", () => {
    const summary = summarizeFailure(retryRun);
    expect(summary).toContain("rejected the API key");
    expect(summary).not.toContain("Reconnecting");
  });

  it("finds it even when the informative line comes first", () => {
    // The retry notices are *not* errors, so the filter keeps the real one and the
    // walk finds it whichever end it sits at.
    const summary = summarizeFailure([line(REAL_401), line("ERROR: Reconnecting... 5/5")]);
    expect(summary).toContain("rejected the API key");
  });

  it("returns nothing when the output explains nothing", () => {
    expect(summarizeFailure([line("ERROR: something we have never seen")])).toBeNull();
    // And does not reach into stdout for a diagnosis.
    expect(
      summarizeFailure([{ ...line("ERROR: unexpected status 401 Unauthorized"), stream: "stdout" }]),
    ).toBeNull();
  });
});
