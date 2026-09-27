import { describe, expect, it } from "vitest";
import { applyAppServerEvent, applyCodexEvent } from "./usePipeline";
import execRun from "./__fixtures__/exec-run.json";

/**
 * The agent's event stream, applied to the chat's progress surfaces.
 *
 * This is the least-covered part of the system and the hardest to notice going
 * wrong: the runtime streams, the reducers assemble, and a mistake shows up as a
 * transcript that looks plausible. The `exec` half below is driven by a **real
 * capture** — the full `codex exec --json` stream from the task-board run in the
 * end-to-end pass, committed as `__fixtures__/exec-run.json` — so the shapes are
 * the runtime's, not invented here. The `app-server` half is written from the
 * protocol schema plus the fake runtime, and says so.
 */

/** Records what a reducer asked the app to do, without React. */
function recorder() {
  const calls: {
    steps: any[];
    answer: string;
    logs: any[];
    touched: string[][];
    changes: any[][];
    failure: string | null;
  } = { steps: [], answer: "", logs: [], touched: [], changes: [], failure: null };

  const update = {
    setSteps: (fn: (prev: any[]) => any[]) => { calls.steps = fn(calls.steps); },
    appendAnswer: (text: string) => { calls.answer += text; },
    setAnswer: (text: string) => { calls.answer = text; },
    logOutput: (line: any) => { calls.logs.push(line); },
    markTouched: (paths: string[]) => { calls.touched.push(paths); },
    recordChanges: (changes: any[]) => { calls.changes.push(changes); },
    fail: (detail: string) => { calls.failure = detail; },
  };
  return { calls, update };
}

describe("an exec run, replayed from a real capture", () => {
  const apply = () => {
    const harness = recorder();
    for (const event of execRun) applyCodexEvent(event, harness.update);
    return harness.calls;
  };

  it("assembles the answer the runtime reported", () => {
    // 2434 characters in the capture. Asserted as a floor rather than a number so
    // the fixture can be re-recorded without editing this.
    expect(apply().answer.length).toBeGreaterThan(2000);
  });

  it("turns each command into a step, and marks every edited file", () => {
    const calls = apply();
    const commands = calls.steps.filter((step) => step.name === "Run Command");
    expect(commands).toHaveLength(7);
    expect(commands.every((step) => step.status === "done")).toBe(true);
    // `markTouched` is what highlights the file tree, so a run that touched files
    // is visible without reading the transcript.
    expect(calls.touched.length).toBeGreaterThan(0);
    expect(calls.touched.flat().length).toBeGreaterThan(0);
  });

  it("logs an error item to the output panel without failing the run", () => {
    // The capture contains an `error` item — the under-development-feature warning,
    // which the runtime reports as an item rather than as a failure. The reducer
    // shows it and lets the turn continue, which is right: the run did continue,
    // and all eight files were written.
    const calls = apply();
    const errors = calls.logs.filter((line) => line.stream === "stderr");
    expect(errors.length).toBeGreaterThan(0);
    expect(calls.failure).toBeNull();
  });

  it("knows nothing about events it was not written for", () => {
    // A guard against the reducer growing a permissive default: an unknown event
    // must be inert rather than half-applied.
    const harness = recorder();
    applyCodexEvent({ type: "something.new", item: { type: "unknown" } }, harness.update);
    expect(harness.calls).toMatchObject({ answer: "", steps: [], logs: [], touched: [] });
  });
});

describe("an app-server run, from the protocol", () => {
  it("accumulates the streamed deltas, then lets the final message win", () => {
    // The deltas are a preview of the item that follows; the item is authoritative.
    const harness = recorder();
    applyAppServerEvent({ method: "item/agentMessage/delta", params: { delta: "Hel" } }, harness.update);
    applyAppServerEvent({ method: "item/agentMessage/delta", params: { delta: "lo" } }, harness.update);
    expect(harness.calls.answer).toBe("Hello");

    applyAppServerEvent(
      { method: "item/completed", params: { item: { type: "agentMessage", text: "Hello there" } } },
      harness.update,
    );
    expect(harness.calls.answer).toBe("Hello there");
  });

  it("fails the run on an error the runtime will not retry", () => {
    // The bug this pins: a missing API key produced a non-retryable error, nothing
    // failed the run, and the transcript read "Task completed." — an install that
    // had never made a single call reporting success.
    const harness = recorder();
    applyAppServerEvent(
      { method: "error", params: { willRetry: false, error: { message: "missing API key" } } },
      harness.update,
    );
    expect(harness.calls.failure).toBe("missing API key");
  });

  it("does not fail a run the runtime says it will retry", () => {
    const harness = recorder();
    applyAppServerEvent(
      { method: "error", params: { willRetry: true, error: { message: "Reconnecting…" } } },
      harness.update,
    );
    expect(harness.calls.failure).toBeNull();
    // Retrying is progress, not a failure: it goes to stdout rather than stderr.
    expect(harness.calls.logs[0].stream).toBe("stdout");
  });

  it("marks the files a camelCase fileChange names", () => {
    // The app-server vocabulary is camelCase where `exec`'s is snake_case, which is
    // exactly the kind of difference a shared reducer would get wrong.
    const harness = recorder();
    applyAppServerEvent(
      {
        method: "item/completed",
        params: { item: { type: "fileChange", changes: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } },
      },
      harness.update,
    );
    expect(harness.calls.touched).toEqual([["src/a.ts", "src/b.ts"]]);
  });
});
