import { describe, expect, it } from "vitest";
import {
  isPlaceholderPath,
  normalizeProjectPath,
  selectRecentProjects,
} from "./recentProjects";

const active = { path: "/work/acsa-code", name: "acsa-code" };

describe("selectRecentProjects", () => {
  it("leads with the active project, then the most recent that still exist", () => {
    const chosen = selectRecentProjects(active, [
      { path: "/work/lighthouse", name: "lighthouse" },
      { path: "/work/banking-expert", name: "banking-expert" },
    ]);
    expect(chosen.map((p) => p.name)).toEqual(["acsa-code", "lighthouse", "banking-expert"]);
  });

  it("does not spend a slot on a project whose folder is gone", () => {
    // The bug this exists for: eight deleted test projects were the most recent
    // rows, so the three menu slots all went to folders that no longer existed
    // and the two real projects were never offered.
    const chosen = selectRecentProjects(active, [
      { path: "/Users/someone/AcsaProjects/ask-hard", name: "ask-hard", missing: true },
      { path: "/Users/someone/AcsaProjects/loop-hard", name: "loop-hard", missing: true },
      { path: "/Users/someone/AcsaProjects/todo-hard", name: "todo-hard", missing: true },
      { path: "/work/lighthouse", name: "lighthouse" },
      { path: "/work/banking-expert", name: "banking-expert" },
    ]);
    expect(chosen.map((p) => p.name)).toEqual(["acsa-code", "lighthouse", "banking-expert"]);
  });

  it("keeps a missing project out but does not reorder the rest", () => {
    const chosen = selectRecentProjects(active, [
      { path: "/work/first", name: "first" },
      { path: "/work/gone", name: "gone", missing: true },
      { path: "/work/second", name: "second" },
      { path: "/work/third", name: "third" },
    ]);
    expect(chosen.map((p) => p.name)).toEqual(["acsa-code", "first", "second"]);
  });

  it("never offers the same folder twice, however it is spelled", () => {
    const chosen = selectRecentProjects(active, [
      { path: "/work/acsa-code/", name: "acsa-code again" },
      { path: "/work/lighthouse", name: "lighthouse" },
    ]);
    expect(chosen.map((p) => p.name)).toEqual(["acsa-code", "lighthouse"]);
  });

  it("ignores paths that identify no folder", () => {
    expect(isPlaceholderPath(".")).toBe(true);
    expect(isPlaceholderPath("./")).toBe(true);
    expect(isPlaceholderPath("")).toBe(true);
    expect(normalizeProjectPath("/work/x///")).toBe("/work/x");
    const chosen = selectRecentProjects(
      { path: ".", name: "" },
      [{ path: "./", name: "nothing" }, { path: "/work/lighthouse", name: "lighthouse" }]
    );
    expect(chosen.map((p) => p.name)).toEqual(["lighthouse"]);
  });

  it("returns the active project alone when nothing else is remembered", () => {
    expect(selectRecentProjects(active, [])).toEqual([active]);
  });

  it("survives a stored list that is not a list", () => {
    // The rows cross an IPC boundary, where the type is a claim rather than a
    // guarantee: an unavailable database or an error object must not be iterated
    // — this threw inside the titlebar and took the shell down with it.
    for (const notAList of [undefined, null, {}, "nope", 7]) {
      expect(selectRecentProjects(active, notAList as never)).toEqual([active]);
    }
  });
});
