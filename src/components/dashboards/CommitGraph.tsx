/**
 * CommitGraph.tsx — the history, drawn.
 *
 * Each row draws only its own slice of the graph: the lanes crossing it, the
 * lanes that end at its dot, and the lanes its dot opens. Everything the row
 * needs comes from `layoutGraph`, so the drawing here is one row tall and has no
 * knowledge of the rows around it — which is what keeps 60 commits cheap.
 *
 * The rows are read-only on purpose. Opening a commit's diff belongs to the right
 * pane and is not built yet, and a row that highlights on hover but does nothing
 * when clicked is worse than one that does not pretend.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, GitCommitHorizontal, RefreshCw } from "lucide-react";
import { Icon } from "../ui/Icon";
import { layoutGraph, type GitCommit, type GitRef } from "../../services/gitGraph";

/** The row height has to be the row's *actual* height, or the lanes don't meet. */
const ROW_HEIGHT = 24;
const LANE_WIDTH = 11;
const DOT_RADIUS = 3.2;

/**
 * Lane colours, in the order lanes are opened.
 *
 * Fixed hues rather than theme tokens: what matters is that lane 0 and lane 1 are
 * unmistakably different, which a palette derived from one accent cannot promise.
 * They are all mid-tone, so they read against the app's dark surfaces and against
 * each other.
 */
const LANE_COLORS = [
  "#818cf8",
  "#38bdf8",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#a78bfa",
  "#fb923c",
  "#4ade80",
];

const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];
/** Lanes sit on a fixed pitch, so the last one needs half a lane of padding. */
const centerOf = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;

function relativeDate(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  const steps: [number, string][] = [
    [60, "s"],
    [60, "m"],
    [24, "h"],
    [7, "d"],
    [4.35, "w"],
    [12, "mo"],
  ];
  let value = seconds;
  let unit = "s";
  for (const [size, name] of steps) {
    if (value < size) {
      unit = name;
      break;
    }
    value /= size;
    unit = name;
  }
  if (unit === "s" && seconds < 45) return "just now";
  return `${Math.floor(value)}${unit} ago`;
}

/* The prop is `badge`, not `ref`: React intercepts a prop literally named `ref`
   and hands the component an element ref instead, so the badge arrived
   `undefined` and took the whole page down with it. */
function RefBadge({ badge }: { badge: GitRef }) {
  const tone = badge.current
    ? // No opacity modifier on the accent. It is a CSS variable token, so Tailwind
      // drops the class entirely and the badge renders unstyled; the build's
      // generated-classes check is what catches that, so keep to plain tokens.
      // (This comment used to spell the dropped class out, which put it back into
      // the check's scan — the checker reads source text, comments included.)
      "border-accent bg-white/5 text-accent"
    : badge.kind === "tag"
      ? "border-hairline bg-white/5 text-amber-300"
      : badge.kind === "remote"
        ? "border-hairline bg-white/5 text-zinc-400"
        : "border-hairline bg-white/5 text-zinc-200";
  return (
    <span
      title={
        badge.kind === "tag"
          ? `tag ${badge.name}`
          : badge.kind === "remote"
            ? `remote branch ${badge.name}`
            : `branch ${badge.name}`
      }
      className={`shrink-0 overflow-hidden text-ellipsis whitespace-nowrap rounded-md border px-1.5 py-px font-mono text-4xs ${tone}`}
    >
      {badge.name}
    </span>
  );
}

function GraphRow({ row, refsWidth }: { row: ReturnType<typeof layoutGraph>["rows"][number]; refsWidth: number }) {
  const { lane, commit } = row;
  const middle = ROW_HEIGHT / 2;
  return (
    <div
      className="flex items-center gap-2 pr-2"
      style={{ height: ROW_HEIGHT }}
      data-testid={`git-graph-row-${commit.short}`}
      title={`${commit.subject}\n${commit.short} · ${commit.author} · ${relativeDate(commit.date)}`}
    >
      <svg
        aria-hidden="true"
        className="shrink-0"
        width={refsWidth}
        height={ROW_HEIGHT}
        viewBox={`0 0 ${refsWidth} ${ROW_HEIGHT}`}
      >
        {row.through.map((crossing) => (
          <line
            key={`through-${crossing}`}
            x1={centerOf(crossing)}
            y1={0}
            x2={centerOf(crossing)}
            y2={ROW_HEIGHT}
            stroke={laneColor(crossing)}
            strokeWidth={1.4}
          />
        ))}
        {row.mergeIn.map((merging) => (
          <path
            key={`in-${merging}`}
            d={`M ${centerOf(merging)} 0 L ${centerOf(lane)} ${middle}`}
            stroke={laneColor(merging)}
            strokeWidth={1.4}
            fill="none"
          />
        ))}
        {row.enters && (
          <line
            x1={centerOf(lane)}
            y1={0}
            x2={centerOf(lane)}
            y2={middle}
            stroke={laneColor(lane)}
            strokeWidth={1.4}
          />
        )}
        {row.continues && (
          <line
            x1={centerOf(lane)}
            y1={middle}
            x2={centerOf(lane)}
            y2={ROW_HEIGHT}
            stroke={laneColor(lane)}
            strokeWidth={1.4}
          />
        )}
        {row.branchOut.map((branching) => (
          <path
            key={`out-${branching}`}
            d={`M ${centerOf(lane)} ${middle} L ${centerOf(branching)} ${ROW_HEIGHT}`}
            stroke={laneColor(branching)}
            strokeWidth={1.4}
            fill="none"
          />
        ))}
        {/* The dot is filled only on HEAD: an outline everywhere else keeps a long
            history from reading as a line of beads. */}
        <circle
          cx={centerOf(lane)}
          cy={middle}
          r={DOT_RADIUS}
          fill={row.isHead ? laneColor(lane) : "var(--vscode-editor-bg)"}
          stroke={laneColor(lane)}
          strokeWidth={1.6}
        />
      </svg>

      <span className="min-w-0 flex-1 truncate text-2xs text-zinc-300">{commit.subject}</span>

      <span className="flex shrink-0 items-center gap-1">
        {row.refs.slice(0, 3).map((gitRef) => (
          <RefBadge key={`${gitRef.kind}-${gitRef.name}`} badge={gitRef} />
        ))}
        {row.refs.length > 3 && (
          <span className="shrink-0 font-mono text-4xs text-zinc-500" title={row.refs.map((r) => r.name).join(", ")}>
            +{row.refs.length - 3}
          </span>
        )}
      </span>

      <span className="hidden shrink-0 font-mono text-4xs text-zinc-500 xl:inline">
        {commit.author}
      </span>
    </div>
  );
}

export function CommitGraph({
  commits,
  refs,
  head,
  isLoading,
  error,
  onRefresh,
}: {
  commits: GitCommit[];
  refs: GitRef[];
  head: string;
  isLoading?: boolean;
  /** Set when the history could not be read at all. */
  error?: string | null;
  onRefresh?: () => void;
}) {
  const [isOpen, setIsOpen] = useState(true);
  const { rows, laneCount } = layoutGraph(commits, refs, head);
  // One lane of pitch, plus room for the outermost dot's stroke.
  const refsWidth = Math.max(1, laneCount) * LANE_WIDTH + 4;

  return (
    <section className="flex min-h-0 flex-col border-t border-hairline" data-testid="git-graph">
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          aria-expanded={isOpen}
          aria-label={isOpen ? "Collapse the graph" : "Expand the graph"}
          className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
        >
          <Icon icon={isOpen ? ChevronDown : ChevronRight} className="w-3 h-3" />
        </button>
        <Icon icon={GitCommitHorizontal} className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
        <span className="text-4xs font-semibold uppercase tracking-wider text-zinc-500">Graph</span>
        <span className="font-mono text-4xs text-zinc-500">
          {error
            ? "unavailable"
            : commits.length === 0
              ? "no commits"
              : `${commits.length} commit${commits.length === 1 ? "" : "s"}`}
        </span>
        {onRefresh && (
          <button
            type="button"
            title="Reload the history"
            aria-label="Reload the history"
            onClick={onRefresh}
            className="ml-auto rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
          >
            <Icon icon={RefreshCw} className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`} />
          </button>
        )}
      </div>

      {isOpen && (
        <div className="min-h-0 flex-1 overflow-y-auto pb-1" data-testid="git-graph-rows">
          {rows.length === 0 ? (
            error ? (
              <p className="px-3 py-3 text-2xs leading-relaxed text-amber-300" data-testid="git-graph-error">
                {error}
              </p>
            ) : (
              <p className="px-3 py-3 text-2xs leading-relaxed text-zinc-500">
                {isLoading ? "Reading the history…" : "No commits yet — the first one you make appears here."}
              </p>
            )
          ) : (
            rows.map((row) => <GraphRow key={row.commit.sha} row={row} refsWidth={refsWidth} />)
          )}
        </div>
      )}
    </section>
  );
}

export default CommitGraph;
