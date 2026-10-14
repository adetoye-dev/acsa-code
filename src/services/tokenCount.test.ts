import { describe, expect, it } from "vitest";
import { formatTokens } from "./tokenCount";

/**
 * Three or four characters, in a line of 11px metadata beside a model name.
 *
 * The failure mode this guards is a header that jumps around as a run gets
 * expensive — `0`, `942`, `1234`, `12345`, `1234567` all fitting differently — and
 * a number nobody can read at a glance.
 */
describe("a token count, for a header", () => {
  it("stays short as the number grows", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(942)).toBe("942");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(213_964)).toBe("214k");
    expect(formatTokens(1_234_567)).toBe("1.2M");
  });

  it("survives a number the provider did not send", () => {
    // A missing field arrives as NaN or a negative from a bad sum, and "NaN
    // tokens" in the header is worse than no number at all.
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
  });
});
