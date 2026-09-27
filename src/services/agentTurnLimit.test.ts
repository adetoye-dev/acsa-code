import { describe, expect, it } from "vitest";
import {
  DEFAULT_TURN_LIMIT_MINUTES,
  formatDuration,
  shouldStopTurn,
  turnLimitMs,
  turnLimitNotice,
} from "./agentTurnLimit";

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
