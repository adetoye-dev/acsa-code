/**
 * gitGraph.ts — turning a commit list into lanes.
 *
 * `git log` gives a flat, newest-first list with each commit's parents, which is
 * exactly the input a graph needs and not at all the output one can draw. A
 * renderer wants to know, per row, which lanes cross it, which lanes *end* at the
 * commit, and which ones it opens for its parents. Working that out is the whole
 * of this file, and it is pure so it can be tested against a history rather than
 * against a screenshot.
 */

export interface GitCommit {
  sha: string;
  short: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
}

export interface GitRef {
  name: string;
  kind: "branch" | "remote" | "tag";
  target: string;
  /** The ref the working tree is on, as far as git's own ref list knows. */
  current: boolean;
}

export interface GraphRow {
  commit: GitCommit;
  /** The lane the commit's dot sits in. */
  lane: number;
  /** Something above was waiting for this commit, so its lane enters the row. */
  enters: boolean;
  /** Lanes crossing the row from top to bottom without meeting the dot. */
  through: number[];
  /** Lanes whose line ends at this dot — a branch merging back in. */
  mergeIn: number[];
  /** Lanes the dot opens downward, one per parent after the first. */
  branchOut: number[];
  /** The lane carries on past the dot, because the commit has a first parent. */
  continues: boolean;
  /** Refs pointing here, most interesting first. */
  refs: GitRef[];
  isHead: boolean;
}

export interface GraphLayout {
  rows: GraphRow[];
  /** How many lanes the widest row needs. */
  laneCount: number;
}

/** The order a badge reads best in: what you are on, then branches, tags, remotes. */
const refRank = (ref: GitRef): number =>
  ref.current ? 0 : ref.kind === "branch" ? 1 : ref.kind === "tag" ? 2 : 3;

/**
 * Assign every commit a lane, and every row the segments that connect it to the
 * rows around it.
 *
 * `lanes` is the state between rows: each slot holds the commit that lane is
 * still looking for, or `null` when the slot is free. A lane that finds its
 * commit ends there; a commit's first parent inherits its lane (so a straight run
 * of commits is one straight line) and any further parents open lanes of their
 * own, which is what makes a merge visible.
 */
export function layoutGraph(
  commits: GitCommit[],
  refs: GitRef[] = [],
  head = ""
): GraphLayout {
  const refsByCommit = new Map<string, GitRef[]>();
  for (const ref of refs) {
    const list = refsByCommit.get(ref.target) ?? [];
    list.push(ref);
    refsByCommit.set(ref.target, list);
  }
  for (const list of refsByCommit.values()) {
    list.sort((a, b) => refRank(a) - refRank(b) || a.name.localeCompare(b.name));
  }

  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let laneCount = 0;

  for (const commit of commits) {
    let lane = lanes.indexOf(commit.sha);
    const enters = lane !== -1;
    if (!enters) {
      // Nothing above was waiting for this commit — a second root, or the oldest
      // commit of a truncated history. It takes a free lane rather than being
      // dropped, which keeps the row list and the commit list the same length.
      const free = lanes.indexOf(null);
      lane = free === -1 ? lanes.push(null) - 1 : free;
    }

    const next = lanes.slice();

    // Any other lane that was waiting for this commit merges into the dot.
    const mergeIn: number[] = [];
    for (let index = 0; index < next.length; index += 1) {
      if (index !== lane && next[index] === commit.sha) {
        next[index] = null;
        mergeIn.push(index);
      }
    }

    next[lane] = commit.parents[0] ?? null;
    const branchOut: number[] = [];
    for (const parent of commit.parents.slice(1)) {
      let index = next.indexOf(parent);
      if (index === -1) {
        const free = next.indexOf(null);
        index = free === -1 ? next.push(null) - 1 : free;
        next[index] = parent;
      }
      branchOut.push(index);
    }

    const through: number[] = [];
    for (let index = 0; index < next.length; index += 1) {
      if (index === lane || mergeIn.includes(index) || branchOut.includes(index)) continue;
      if (lanes[index] && next[index]) through.push(index);
    }

    rows.push({
      commit,
      lane,
      enters,
      through,
      mergeIn,
      branchOut,
      continues: Boolean(commit.parents[0]),
      refs: refsByCommit.get(commit.sha) ?? [],
      isHead: Boolean(head) && commit.sha === head,
    });

    lanes.length = 0;
    lanes.push(...next);
    laneCount = Math.max(laneCount, lanes.length);
  }

  return { rows, laneCount };
}
