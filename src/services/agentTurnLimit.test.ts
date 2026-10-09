import { describe, expect, it } from "vitest";
import { DEFAULT_TURN_LIMIT_MINUTES, formatDuration, shouldStopTurn, turnLimitMs, turnLimitNotice, stopReason, turnStepLimitNotice, repeatedAction, turnRepeatNotice, actionSignature } from "./agentTurnLimit";

describe("the turn limit", () => {
  it("converts minutes to milliseconds, and zero to no limit at all", () => {
    expect(turnLimitMs(20)).toBe(20 * 60_000);
    expect(turnLimitMs(0)).toBe(Infinity);
    // A missing or nonsense value falls back to the default rather than to no
    // limit — the failure mode of "no limit" is the one this exists to prevent.
    expect(turnLimitMs(undefined)).toBe(DEFAULT_TURN_LIMIT_MINUTES * 60_000);
    expect(turnLimitMs(Number.NaN)).toBe(DEFAULT_TURN_LIMIT_MINUTES * 60_000);
  });

  it("stops a turn that has run past its limit", () => {
    expect(shouldStopTurn({ elapsedMs: 20 * 60_000, limitMinutes: 20, blockedOnUser: false })).toBe(true);
    expect(shouldStopTurn({ elapsedMs: 19 * 60_000, limitMinutes: 20, blockedOnUser: false })).toBe(false);
  });

  it("never stops a turn that is waiting on the user", () => {
    // The case that would make this feature hated: the agent asked a question
    // before lunch and the cap fired while the answer was being typed.
    expect(shouldStopTurn({ elapsedMs: 60 * 60_000, limitMinutes: 20, blockedOnUser: true })).toBe(false);
  });

  it("never stops anything when the limit is off", () => {
    expect(shouldStopTurn({ elapsedMs: 6 * 60 * 60_000, limitMinutes: 0, blockedOnUser: false })).toBe(false);
  });

  it("says how long it ran, in a size that fits one line", () => {
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(252_000)).toBe("4m 12s");
    expect(formatDuration(3_780_000)).toBe("1h 03m");
    expect(formatDuration(-5)).toBe("0s");
  });

  it("explains a stop instead of letting the turn vanish", () => {
    const notice = turnLimitNotice(20);
    expect(notice).toMatch(/20 minute/);
    expect(notice).toMatch(/Settings/);
  });
});

describe("the step ceiling", () => {
  const base = { elapsedMs: 0, limitMinutes: 20, blockedOnUser: false };

  it("stops a busy turn that a clock would never catch", () => {
    // 3m15s and 29 steps is the measured case: well inside the clock, far past
    // what a five-item plan needs.
    expect(stopReason({ ...base, steps: 29 })).toBeNull();
    expect(stopReason({ ...base, steps: 60 })).toBe("steps");
    expect(stopReason({ ...base, steps: 200 })).toBe("steps");
  });

  it("reports time as time, so the sentence can be the right one", () => {
    expect(stopReason({ ...base, elapsedMs: 21 * 60_000 })).toBe("time");
    expect(turnStepLimitNotice(60)).toContain("60 steps");
  });

  it("keeps the old boolean answer, and neither bound counts a waiting turn", () => {
    expect(shouldStopTurn({ ...base, steps: 500 })).toBe(true);
    expect(shouldStopTurn({ elapsedMs: 99 * 60_000, steps: 500, limitMinutes: 20, blockedOnUser: true })).toBe(false);
    expect(stopReason({ ...base, steps: 500, blockedOnUser: true })).toBeNull();
  });
});

describe("the repeat detector", () => {
  const base = { elapsedMs: 0, limitMinutes: 20, blockedOnUser: false };

  it("fires on the same action five times, not on five different ones", () => {
    // Reading files is the flow. Reading the same file five times is not.
    expect(stopReason({ ...base, signatures: ["cat a", "cat a", "cat a", "cat a"] })).toBeNull();
    expect(
      stopReason({ ...base, signatures: ["cat a", "cat a", "cat a", "cat a", "cat a"] })
    ).toBe("repeats");
    expect(
      stopReason({ ...base, signatures: ["cat a", "cat b", "cat c", "cat d", "cat e", "cat f"] })
    ).toBeNull();
  });

  it("compares whole actions, so different paths are not a loop", () => {
    // Normalising is the caller's job and is where this could go wrong: a
    // normaliser that stripped the path would call these a loop.
    expect(repeatedAction(["cat src/a.ts", "cat src/b.ts", "cat src/c.ts"], 3)).toBeNull();
    expect(repeatedAction(["npm test", "npm test", "npm test"], 3)).toEqual({
      signature: "npm test",
      count: 3,
    });
  });

  it("counts across the run, so an alternating loop still fires", () => {
    expect(
      stopReason({ ...base, repeatLimit: 3, signatures: ["npm test", "cat a", "npm test", "cat a", "npm test"] })
    ).toBe("repeats");
  });

  it("names the action, because 'too many steps' tells the reader nothing", () => {
    expect(turnRepeatNotice("npm test", 5)).toContain("npm test");
  });

  it("keeps the total as a backstop, and a loop wins over it", () => {
    expect(stopReason({ ...base, steps: 60, signatures: ["a", "b", "c"] })).toBe("steps");
    expect(stopReason({ ...base, steps: 500, signatures: ["a", "a", "a", "a", "a"] })).toBe("repeats");
  });

  it("still counts neither bound while the turn waits on the user", () => {
    expect(
      stopReason({ ...base, blockedOnUser: true, steps: 500, signatures: ["a", "a", "a", "a", "a"] })
    ).toBeNull();
  });
});

describe("what counts as the same step", () => {
  it("tells a repeated command from two different ones", () => {
    const a = actionSignature({ name: "Run Command", detail: "npm test" });
    expect(actionSignature({ name: "Run Command", detail: "npm test" })).toBe(a);
    expect(actionSignature({ name: "Run Command", detail: "npm run build" })).not.toBe(a);
    // The detail is one truncated string and may wrap; wrapping is not a difference.
    expect(actionSignature({ name: "Run Command", detail: "npm  test\n" })).toBe(a);
  });

  it("does not confuse an edit to one file with an edit to another", () => {
    expect(actionSignature({ name: "Edit Files", detail: "Home.js" })).not.toBe(
      actionSignature({ name: "Edit Files", detail: "App.js" })
    );
  });
});
