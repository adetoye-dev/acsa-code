import { describe, expect, it } from "vitest";
import { durationLabel, relativeDate } from "./relativeTime";

describe("relativeDate", () => {
  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

  it("reads as the units a person uses", () => {
    expect(relativeDate(ago(5))).toBe("just now");
    expect(relativeDate(ago(90))).toBe("1m ago");
    expect(relativeDate(ago(3 * 3600))).toBe("3h ago");
    expect(relativeDate(ago(3 * 86400))).toBe("3d ago");
  });

  it("says nothing for a timestamp it cannot read", () => {
    expect(relativeDate("")).toBe("");
    expect(relativeDate("not a date")).toBe("");
  });
});

describe("durationLabel", () => {
  it("formats a real run's length the way gh prints it", () => {
    // 487 seconds is what `gh run list` shows as "8m 7s".
    expect(durationLabel(487)).toBe("8m 7s");
    expect(durationLabel(31)).toBe("31s");
    expect(durationLabel(120)).toBe("2m");
    expect(durationLabel(3900)).toBe("1h 5m");
  });

  it("renders nothing for an unknown length instead of a zero", () => {
    expect(durationLabel(null)).toBe("");
    expect(durationLabel(undefined)).toBe("");
    expect(durationLabel(Number.NaN)).toBe("");
  });
});
