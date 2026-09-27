/**
 * The lane assignment is the part of the graph that can be wrong without looking
 * wrong: a mis-parse or a mishandled merge draws a line between the wrong two
 * commits, which is invisible until you read the graph closely. These are the
 * shapes a history actually takes.
 */
import { describe, expect, it } from "vitest";
import { layoutGraph, type GitCommit, type GitRef } from "./gitGraph";

let counter = 0;
/** Short, readable shas: `a` for the first commit written, `b` for the second. */
const sha = (letter: string) => letter.repeat(40);

function commit(
  letter: string,
  parents: string[],
  subject = `commit ${letter}`,
): GitCommit {
  counter += 1;
  return {
    sha: sha(letter),
    short: letter.repeat(7),
    parents: parents.map(sha),
    author: "Ada",
    date: `2026-09-${String(counter).padStart(2, "0")}T12:00:00+01:00`,
    subject,
  };
}

describe("layoutGraph", () => {
  it("draws a straight run of commits down one lane", () => {
    const { rows, laneCount } = layoutGraph([
      commit("c", ["b"]),
      commit("b", ["a"]),
      commit("a", []),
    ]);

    expect(laneCount).toBe(1);
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    // The first row is the tip: nothing above it, and its lane carries on.
    expect(rows[0].enters).toBe(false);
    expect(rows[0].continues).toBe(true);
    // Middle commit: both neighbours on the same lane.
    expect(rows[1].enters).toBe(true);
    expect(rows[1].through).toEqual([]);
    // The root has nothing below it.
    expect(rows[2].continues).toBe(false);
  });

  it("opens a second lane for a merge and closes it at the commit it joins", () => {
    // m is a merge of `side` into `main`; both sides share the root.
    const { rows, laneCount } = layoutGraph([
      commit("m", ["n", "s"]), // merge: first parent main, second parent side
      commit("n", ["r"]),
      commit("s", ["r"]),
      commit("r", []),
    ]);

    expect(laneCount).toBe(2);
    // The merge's dot is on the main line, and it opens the side lane.
    expect(rows[0].lane).toBe(0);
    expect(rows[0].branchOut).toEqual([1]);
    expect(rows[0].continues).toBe(true);
    // The main line carries on through the side commit's row.
    expect(rows[2].lane).toBe(1);
    expect(rows[2].through).toEqual([0]);
    // The root is reached from both lanes: the side lane merges into it.
    expect(rows[3].mergeIn).toEqual([1]);
    expect(rows[3].lane).toBe(0);
    expect(rows[3].through).toEqual([]);
  });

  it("keeps a divergent branch on its own lane until it merges back", () => {
    const { rows, laneCount } = layoutGraph([
      commit("d", ["c", "b"]), // merge
      commit("c", ["a"]),
      commit("b", ["a"]),
      commit("a", []),
    ]);

    expect(laneCount).toBe(2);
    expect(rows[1].lane).toBe(0);
    expect(rows[2].lane).toBe(1);
    expect(rows[3].mergeIn.length).toBe(1);
  });

  it("gives a second root its own lane instead of losing the row", () => {
    // A truncated history, or two unrelated histories in one repository: the
    // commit that nothing points at still has to appear.
    const { rows } = layoutGraph([commit("b", []), commit("a", [])]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.enters)).toEqual([false, false]);
    expect(rows[1].lane).toBe(0);
  });

  it("attaches refs to the commit they point at, and marks HEAD", () => {
    const refs: GitRef[] = [
      { name: "v0.2.17", kind: "tag", target: sha("b"), current: false },
      { name: "dev", kind: "branch", target: sha("c"), current: true },
      { name: "origin/dev", kind: "remote", target: sha("c"), current: false },
      { name: "main", kind: "branch", target: sha("b"), current: false },
    ];
    const { rows } = layoutGraph(
      [commit("c", ["b"]), commit("b", [])],
      refs,
      sha("c")
    );

    // The branch you are on reads first, then remote, then the other branch, then
    // the tag — the order a badge is scanned in.
    expect(rows[0].refs.map((ref) => ref.name)).toEqual(["dev", "origin/dev"]);
    expect(rows[1].refs.map((ref) => ref.name)).toEqual(["main", "v0.2.17"]);
    expect(rows[0].isHead).toBe(true);
    expect(rows[1].isHead).toBe(false);
  });

  it("returns nothing for an empty history", () => {
    expect(layoutGraph([])).toEqual({ rows: [], laneCount: 0 });
  });
});
