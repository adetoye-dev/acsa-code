/**
 * RepoOverview.tsx — the repository page's landing view: what the remote knows.
 *
 * Everything else on this page is about the working tree, which exists on this
 * machine. This is the half that does not: whether the branch's checks pass, what
 * pull requests are open, what is assigned to you. Those three are the questions
 * that otherwise cost a browser trip, so they are what the empty pane is for
 * instead of a placeholder.
 *
 * Three rules shape it:
 *
 * * **Nothing here duplicates the page.** The branch, the divergence, the changes
 *   and the history are already in the sidebar and the titlebar; this shows only
 *   what cannot be read locally.
 * * **A row is a link.** Every row opens the thing it names on github.com, because
 *   a list you cannot act on is a screenshot.
 * * **A failure names itself.** No gh, no GitHub remote, signed out, offline are
 *   four different sentences with four different next steps — and a section that
 *   failed says so rather than rendering as an empty list, which would read as
 *   "you have none".
 */
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Clock,
  GitPullRequest,
  Loader2,
  RefreshCw,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { Icon } from "../ui/Icon";
import { openExternal } from "../../services/openExternal";
import { durationLabel, relativeDate } from "../../services/relativeTime";
import { ghRunLog } from "../../services/ghClient";
import type {
  GhIssue,
  GhOverview,
  GhPullRequest,
  GhRun,
  GhRunLog,
  GhRunSummary,
} from "../../services/ghClient";

interface RepoOverviewProps {
  /** Needed for the one call this panel makes on demand: a failed run's log. */
  projectCwd: string;
  data: GhOverview | null;
  isLoading: boolean;
  /** When the answer was read, epoch ms; 0 before the first one arrives. */
  checkedAt: number;
  onRefresh: () => void;
}

/**
 * How a run's outcome reads: an icon, its colour, the word for it, and the
 * background its bar in the history gets.
 *
 * The bar colour is a value rather than a class assembled at the call site, so a
 * conclusion nobody predicted cannot end up as a bar with no colour at all.
 */
function runAppearance(run: GhRun): {
  icon: typeof CheckCircle2;
  tone: string;
  bar: string;
  /** The value form, for a list row's meta line. */
  label: string;
  /** The sentence form, for the card's status line: "Successful", "Failed". */
  word: string;
} {
  if (run.status && run.status !== "completed") {
    return {
      icon: Loader2,
      tone: "text-sky-400",
      bar: "bg-sky-500",
      label: run.status.replace(/_/g, " "),
      word: "Running",
    };
  }
  switch ((run.conclusion || "").toLowerCase()) {
    case "success":
      return {
        icon: CheckCircle2,
        tone: "text-emerald-400",
        bar: "bg-emerald-500",
        label: "success",
        word: "Successful",
      };
    case "failure":
    case "startup_failure":
    case "timed_out":
      return {
        icon: XCircle,
        tone: "text-red-400",
        bar: "bg-red-500",
        label: run.conclusion.replace(/_/g, " "),
        word: "Failed",
      };
    case "cancelled":
      return {
        icon: CircleSlash,
        tone: "text-amber-300",
        bar: "bg-amber-400",
        label: "cancelled",
        word: "Cancelled",
      };
    default:
      // A conclusion nobody predicted is worth showing as-is rather than hiding.
      return {
        icon: CircleDashed,
        tone: "text-zinc-400",
        bar: "bg-zinc-500",
        label: run.conclusion || "unknown",
        word: run.conclusion === "skipped" ? "Skipped" : "Finished",
      };
  }
}

/**
 * The pull request's review state as one badge, or nothing.
 *
 * A pull request with no review decision is the ordinary case, and an empty badge
 * for it would be a chip that says nothing — the row's other columns already say
 * the rest.
 */
function reviewBadge(pr: GhPullRequest): { label: string; className: string } | null {
  if (pr.isDraft) return { label: "DRAFT", className: "bg-white/5 text-zinc-400" };
  switch (pr.reviewDecision) {
    case "APPROVED":
      return { label: "APPROVED", className: "bg-emerald-950/60 text-emerald-300" };
    case "CHANGES_REQUESTED":
      return { label: "CHANGES", className: "bg-red-950/60 text-red-300" };
    case "REVIEW_REQUIRED":
      return { label: "REVIEW", className: "bg-amber-950/60 text-amber-300" };
    default:
      return null;
  }
}

function SectionHeader({
  title,
  href,
  children,
}: {
  title: string;
  href?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-2.5 pb-1 pt-4">
      <span className="text-4xs font-semibold uppercase tracking-wider text-zinc-500">{title}</span>
      {children}
      {href && (
        <button
          type="button"
          onClick={() => void openExternal(href)}
          className="ml-auto flex shrink-0 items-center gap-1 text-4xs text-zinc-500 transition-colors hover:text-zinc-200"
        >
          <span>See all</span>
          <Icon icon={ArrowUpRight} className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

/** The row's shared shell: a full-width click that opens the thing it names. */
function RowLink({
  url,
  testId,
  children,
}: {
  url: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={url}
      onClick={() => void openExternal(url)}
      className="flex w-full min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/5"
    >
      {children}
    </button>
  );
}

/**
 * Runs whose failed-step log can say something.
 *
 * A cancelled run is included on purpose: the panel then answers "GitHub has no
 * failed-step log" rather than leaving a person wondering whether the button is
 * missing because the run somehow passed.
 */
function hasFailure(run: GhRun): boolean {
  const conclusion = (run.conclusion || "").toLowerCase();
  return ["failure", "startup_failure", "timed_out", "cancelled", "action_required"].includes(
    conclusion
  );
}

/**
 * Why a run is red: the tail of its failed steps' logs, in place.
 *
 * Fetched here rather than from the page's own hook because it is wanted one run
 * at a time, on a click, and only for the row that asked.
 */
function RunLogPanel({
  run,
  log,
  isLoading,
  onClose,
}: {
  run: GhRun;
  log: GhRunLog | null;
  isLoading: boolean;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLPreElement | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // The end of the tail is where the error is; making someone scroll to it would
    // undo the point of showing a tail at all.
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [log]);

  const summary = log ? [...log.jobs, ...log.steps].join(" · ") : "";

  return (
    <div
      data-testid={`gh-log-${run.id}`}
      className="mx-2.5 mb-2 overflow-hidden rounded-lg border border-hairline bg-black/30"
    >
      <div className="flex items-center gap-2 border-b border-hairline px-2.5 py-1.5">
        <span className="shrink-0 text-4xs font-semibold uppercase tracking-wider text-zinc-500">
          Why it failed
        </span>
        <span className="min-w-0 flex-1 truncate text-4xs text-zinc-500" title={summary}>
          {summary}
        </span>
        {log?.available && log.lines.length > 0 && (
          <button
            type="button"
            data-testid={`gh-log-copy-${run.id}`}
            onClick={() => {
              void navigator.clipboard?.writeText(log.lines.join("\n")).then(
                () => setCopied(true),
                () => setCopied(false)
              );
            }}
            className="shrink-0 text-4xs text-zinc-500 transition-colors hover:text-zinc-200"
          >
            {copied ? "copied" : "Copy"}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the log"
          className="shrink-0 text-4xs text-zinc-500 transition-colors hover:text-zinc-200"
        >
          Close
        </button>
      </div>

      {isLoading ? (
        <p className="px-2.5 py-2 text-2xs text-zinc-500">Reading the log…</p>
      ) : !log ? (
        null
      ) : !log.available ? (
        <p
          data-testid="gh-log-message"
          className="px-2.5 py-2 text-2xs leading-relaxed text-zinc-400"
        >
          {log.detail}
        </p>
      ) : (
        <>
          <pre
            ref={bodyRef}
            data-testid="gh-log-lines"
            className="max-h-72 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-2xs leading-relaxed text-zinc-300"
          >
            {log.lines.join("\n")}
          </pre>
          <div className="border-t border-hairline px-2.5 py-1 text-4xs text-zinc-500">
            {/* A log that quietly starts mid-way reads as the whole story. */}
            {log.dropped > 0
              ? `Last ${log.lines.length} of ${log.lines.length + log.dropped} lines — the run has the rest.`
              : `${log.lines.length} lines, all of them.`}
          </div>
        </>
      )}
    </div>
  );
}

/** A labelled value, the way the status widget lays out its columns. */
function StatColumn({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-4xs font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-1 min-w-0 truncate text-2xs text-zinc-300">{children}</div>
    </div>
  );
}

/** One bar per run, oldest on the left, height by how long it took. */
function HistoryBars({ summary }: { summary: GhRunSummary }) {
  const longest = Math.max(
    1,
    ...summary.history.map((run) => run.durationSeconds ?? 0)
  );
  return (
    // `h-6` belongs here rather than on a wrapper: the bars are percentage heights,
    // and a percentage against a container with no height of its own computes to
    // zero — which is a bar chart that renders as nothing.
    <div className="flex h-6 items-end gap-[2px]" data-testid="gh-history-bars">
      {summary.history.map((run) => {
        const look = runAppearance(run);
        // A run with no length yet (or which took no time) still gets a visible bar:
        // a bar chart with gaps where the runs are reads as missing data.
        const height = Math.max(0.3, (run.durationSeconds ?? 0) / longest);
        return (
          <button
            key={`${run.id}-${run.createdAt}`}
            type="button"
            title={`${look.label} · ${durationLabel(run.durationSeconds) || "unknown length"} · ${relativeDate(run.createdAt)}`}
            aria-label={`${look.label} run, ${relativeDate(run.createdAt)}`}
            onClick={() => void openExternal(run.url)}
            style={{ height: `${Math.round(height * 100)}%` }}
            className={`w-[5px] shrink-0 rounded-sm ${look.bar}`}
          />
        );
      })}
    </div>
  );
}

/**
 * The branch's CI as a status widget: what the last run was, how long runs take,
 * and how often they pass.
 *
 * The list below answers "what has been running"; this answers "how is this branch
 * doing", which is the part no list of individual runs shows. Aggregates are the
 * only thing here that is not already in the list, so the columns deliberately stay
 * to one line each — a second copy of the list would be clutter.
 */
function RunStatsCard({
  summary,
  error,
  actionsUrl,
}: {
  summary: GhRunSummary;
  error?: string;
  actionsUrl: string;
}) {
  const latest = summary.latest;
  const look = latest ? runAppearance(latest) : null;
  const scope = summary.branch ? `CI on ${summary.branch}` : "Recent runs";
  const compareUrl = summary.branch ? `${actionsUrl}?query=branch%3A${encodeURIComponent(summary.branch)}` : actionsUrl;

  if (error) {
    return (
      <div className="mx-2.5 mt-3 rounded-lg border border-hairline bg-black/20 px-2.5 py-2">
        <div className="text-4xs font-semibold uppercase tracking-wider text-zinc-500">{scope}</div>
        <SectionError message={error} />
      </div>
    );
  }

  if (!latest || !look) {
    // Nothing has run on this branch. Saying so is the whole content of the card;
    // columns and bars made of dashes would be chrome around an absence.
    return (
      <div className="mx-2.5 mt-3 rounded-lg border border-hairline bg-black/20 px-2.5 py-2">
        <div className="flex items-center gap-2">
          <Icon icon={CircleDashed} className="w-3.5 h-3.5 shrink-0 text-zinc-500" />
          <span className="min-w-0 flex-1 truncate text-2xs text-zinc-400">
            No workflow runs on {summary.branch || "this repository"} yet.
          </span>
          <button
            type="button"
            onClick={() => void openExternal(compareUrl)}
            className="shrink-0 text-4xs text-zinc-500 transition-colors hover:text-zinc-200"
          >
            See all
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="mx-2.5 mt-3 overflow-hidden rounded-lg border border-hairline bg-black/20"
      data-testid="gh-run-stats"
    >
      {/* What the last run did, in one line. */}
      <div className="flex items-center gap-2 px-2.5 pt-2">
        <Icon icon={look.icon} className={`w-3.5 h-3.5 shrink-0 ${look.tone}`} />
        <span className="min-w-0 flex-1 truncate text-2xs text-zinc-200">
          {look.word}
          {summary.branch && <span className="text-zinc-500"> · {scope}</span>}
        </span>
        <span className="shrink-0 text-4xs text-zinc-500">{relativeDate(latest.createdAt)}</span>
        <button
          type="button"
          onClick={() => void openExternal(compareUrl)}
          className="shrink-0 text-4xs text-zinc-500 transition-colors hover:text-zinc-200"
        >
          See all
        </button>
      </div>

      {/* The columns the status widget is read for. */}
      <div className="flex gap-3 px-2.5 pb-2 pt-1.5">
        <StatColumn label="Latest">{shortWhen(latest.createdAt)}</StatColumn>
        <StatColumn label="Duration">{durationLabel(latest.durationSeconds) || "—"}</StatColumn>
        <StatColumn label="Trigger">{latest.event || "—"}</StatColumn>
        <StatColumn label="Commit">
          {latest.sha ? (
            <button
              type="button"
              onClick={() => void openExternal(`${latest.url.split("/actions/")[0]}/commit/${latest.sha}`)}
              className="font-mono text-sky-300 transition-colors hover:text-sky-200"
              title={latest.sha}
            >
              {latest.sha.slice(0, 7)}
            </button>
          ) : (
            "—"
          )}
        </StatColumn>
      </div>

      {/* How the branch has been doing, which is what the list cannot say. */}
      <div className="flex items-stretch gap-3 border-t border-hairline px-2.5 py-2" data-testid="gh-run-stats-band">
        <div className="flex min-w-0 flex-[1.4] flex-col justify-center">
          <div className="text-4xs font-semibold uppercase tracking-wider text-zinc-500">History</div>
          <div className="mt-1 flex items-end gap-2">
            <HistoryBars summary={summary} />
            <span className="shrink-0 text-4xs text-zinc-500">
              {summary.total} run{summary.total === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <div className="w-px shrink-0 bg-hairline" />
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <div className="text-4xs font-semibold uppercase tracking-wider text-zinc-500">
            Average duration
          </div>
          <div className="mt-1 truncate text-2xs text-zinc-300">
            {durationLabel(summary.averageDurationSeconds) || "—"}
          </div>
        </div>
        <div className="w-px shrink-0 bg-hairline" />
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <div className="text-4xs font-semibold uppercase tracking-wider text-zinc-500">
            Pass – fail
          </div>
          <div className="mt-1 truncate text-2xs">
            {summary.passRate === null ? (
              <span className="text-zinc-300" title="No finished runs to count yet.">
                —
              </span>
            ) : (
              <>
                <span className="text-emerald-300">{Math.round(summary.passRate * 100)}%</span>
                <span className="text-zinc-500"> – </span>
                <span className="text-red-300">
                  {100 - Math.round(summary.passRate * 100)}%
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A timestamp short enough for a column: `26 Sep, 01:16`. */
function shortWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A section that could not be read: the reason, not an empty list. */
function SectionError({ message }: { message: string }) {
  return (
    <p
      className="mx-2.5 mb-1 rounded-lg border border-amber-900/60 bg-amber-950/30 px-2.5 py-2 text-4xs leading-relaxed text-amber-200"
      title={message}
    >
      This list could not be read: {message}
    </p>
  );
}

const MUTED_LINE = "px-2.5 py-2 text-2xs leading-relaxed text-zinc-500";

export function RepoOverview({
  projectCwd,
  data,
  isLoading,
  checkedAt,
  onRefresh,
}: RepoOverviewProps) {
  const [copied, setCopied] = useState(false);
  /**
   * The run whose failed-step log is open, if any. One at a time.
   *
   * Row ids are the `gh-run-` namespace and the harness counts rows by it, so the
   * panel's own ids stay out of it.
   */
  const [openRunId, setOpenRunId] = useState<number | null>(null);
  const [log, setLog] = useState<GhRunLog | null>(null);
  const [isLogLoading, setIsLogLoading] = useState(false);
  /** The newest request wins; a closed panel's answer is dropped. */
  const logSeq = useRef(0);

  const toggleLog = async (run: GhRun) => {
    if (openRunId === run.id) {
      logSeq.current += 1;
      setOpenRunId(null);
      setLog(null);
      return;
    }
    const seq = ++logSeq.current;
    setOpenRunId(run.id);
    setLog(null);
    setIsLogLoading(true);
    const next = await ghRunLog(projectCwd, run.id ?? 0);
    if (seq !== logSeq.current) return;
    setLog(next);
    setIsLogLoading(false);
  };

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-2xs text-zinc-500">
        <Icon icon={Loader2} className="w-3.5 h-3.5 animate-spin" />
        <span>Reading GitHub…</span>
      </div>
    );
  }

  if (!data.available) {
    // Each reason has a different next step, so each gets its own sentence and
    // its own action rather than one "something went wrong".
    const command =
      data.reason === "not-authenticated"
        ? "gh auth login"
        : data.reason === "not-installed"
          ? "brew install gh"
          : "";
    return (
      <div className="mx-auto flex h-full max-w-lg flex-col items-center justify-center gap-3 px-6 text-center">
        <Icon icon={TriangleAlert} className="w-5 h-5 text-zinc-500" />
        <p className="text-2xs leading-relaxed text-zinc-400">{data.detail}</p>
        {command && (
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(command).then(
                () => setCopied(true),
                () => setCopied(false)
              );
            }}
            className="rounded-lg border border-hairline bg-white/5 px-2.5 py-1.5 font-mono text-2xs text-zinc-200 transition-colors hover:bg-white/10"
            title="Copy to clipboard"
          >
            {copied ? "copied" : command}
          </button>
        )}
        <div className="flex items-center gap-3 text-4xs">
          {data.reason === "not-installed" && (
            <button
              type="button"
              onClick={() => void openExternal("https://cli.github.com")}
              className="text-sky-300 hover:text-sky-200"
            >
              Install the GitHub CLI
            </button>
          )}
          <button
            type="button"
            onClick={onRefresh}
            data-testid="gh-check-again"
            className="text-zinc-400 hover:text-zinc-200"
          >
            Check again
          </button>
        </div>
        {data.raw && (
          <p className="max-w-full truncate font-mono text-4xs text-zinc-500" title={data.raw}>
            {data.raw.split("\n")[0]}
          </p>
        )}
        {/* There is still a useful pane here without GitHub, so say what it is
            rather than leaving the reason on its own. */}
        <p className="mt-2 text-4xs leading-relaxed text-zinc-500">
          Pick a file on the left, or a commit in the graph, to read its diff here.
        </p>
      </div>
    );
  }

  const actionsUrl = data.repo ? `https://github.com/${data.repo}/actions` : "";
  const pullsUrl = data.repo ? `https://github.com/${data.repo}/pulls` : "";

  return (
    <div className="h-full overflow-y-auto pb-4">
      {/* What this is, which repository, and how old the answer is — a list of
          checks with no timestamp is a list you have to guess about. */}
      <div className="flex items-center gap-2 px-2.5 pt-3">
        <Icon icon={GitPullRequest} className="w-3.5 h-3.5 text-zinc-500" />
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-zinc-300">{data.repo}</span>
        <span className="shrink-0 text-4xs text-zinc-500">
          {isLoading ? "refreshing…" : checkedAt ? `checked ${relativeDate(new Date(checkedAt).toISOString())}` : ""}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={isLoading}
          aria-label="Refresh GitHub state"
          data-testid="gh-refresh"
          className="shrink-0 rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200 disabled:opacity-40"
        >
          <Icon icon={RefreshCw} className="w-3.5 h-3.5" />
        </button>
      </div>

      <RunStatsCard
        summary={data.summary}
        error={data.errors.summary}
        actionsUrl={actionsUrl}
      />

      <SectionHeader title="Checks" href={actionsUrl}>
        <span className="text-4xs text-zinc-500">{data.runs.length} recent</span>
      </SectionHeader>
      {data.runs.length === 0 ? (
        <p className={MUTED_LINE}>No workflow runs.</p>
      ) : (
        data.runs.map((run) => {
          const look = runAppearance(run);
          return (
            <div key={`${run.id}-${run.createdAt}`}>
              <div className="flex items-center gap-1 pr-2.5">
                <RowLink url={run.url} testId={`gh-run-${run.id}`}>
                  <Icon icon={look.icon} className={`w-3.5 h-3.5 shrink-0 ${look.tone}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-2xs text-zinc-200">
                      {run.title || run.workflow || "workflow run"}
                    </span>
                    <span className="mt-0.5 block truncate text-4xs text-zinc-500">
                      {[run.workflow, run.branch, look.label].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1 font-mono text-4xs text-zinc-400">
                    {run.durationSeconds !== null && <Clock className="w-3 h-3 text-zinc-500" />}
                    {durationLabel(run.durationSeconds)}
                  </span>
                  <span className="w-16 shrink-0 text-right text-4xs text-zinc-500">
                    {relativeDate(run.createdAt)}
                  </span>
                </RowLink>
                {/* Beside the row, not inside it: a button within a button is not a
                    thing a browser will render, and this needs its own click. */}
                {hasFailure(run) && run.id !== null && (
                  <button
                    type="button"
                    data-testid={`gh-why-${run.id}`}
                    title="Read the failed step's log"
                    onClick={() => void toggleLog(run)}
                    className="shrink-0 rounded-md px-1.5 py-1 text-4xs text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
                  >
                    {openRunId === run.id ? "Hide" : "Why?"}
                  </button>
                )}
              </div>
              {openRunId === run.id && (
                <RunLogPanel
                  run={run}
                  log={log}
                  isLoading={isLogLoading}
                  onClose={() => {
                    logSeq.current += 1;
                    setOpenRunId(null);
                    setLog(null);
                  }}
                />
              )}
            </div>
          );
        })
      )}

      <SectionHeader title="Pull requests" href={pullsUrl}>
        <span className="text-4xs text-zinc-500">{data.pullRequests.length} open</span>
      </SectionHeader>
      {data.errors.pullRequests ? (
        <SectionError message={data.errors.pullRequests} />
      ) : data.pullRequests.length === 0 ? (
        <p className={MUTED_LINE}>No open pull requests.</p>
      ) : (
        data.pullRequests.map((pr) => {
          const badge = reviewBadge(pr);
          return (
            <RowLink key={pr.number ?? pr.url} url={pr.url} testId={`gh-pr-${pr.number}`}>
              <span className="shrink-0 font-mono text-4xs text-zinc-500">#{pr.number}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-2xs text-zinc-200">{pr.title}</span>
                <span className="mt-0.5 block truncate text-4xs text-zinc-500">
                  {[pr.author && `@${pr.author}`, pr.branch, pr.changedFiles !== null ? `${pr.changedFiles} files` : ""]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              {badge && (
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-4xs font-semibold ${badge.className}`}>
                  {badge.label}
                </span>
              )}
              <span className="w-16 shrink-0 text-right text-4xs text-zinc-500">
                {relativeDate(pr.updatedAt)}
              </span>
            </RowLink>
          );
        })
      )}

      {/* Only when there is something on your plate, plus the error case — a card
          that is empty for every user is a card that should not be drawn. */}
      {(data.issues.length > 0 || data.errors.issues) && (
        <>
          <SectionHeader title="Assigned to you" href="https://github.com/issues/assigned">
            <span className="text-4xs text-zinc-500">{data.issues.length} open</span>
          </SectionHeader>
          {data.errors.issues ? (
            <SectionError message={data.errors.issues} />
          ) : (
            data.issues.map((issue: GhIssue) => (
              <RowLink key={issue.number ?? issue.url} url={issue.url} testId={`gh-issue-${issue.number}`}>
                <span className="shrink-0 font-mono text-4xs text-zinc-500">#{issue.number}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-2xs text-zinc-200">{issue.title}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 truncate text-4xs text-zinc-500">
                    {issue.author && <span>@{issue.author}</span>}
                    {issue.labels.length > 0 && (
                      <span className="flex min-w-0 items-center gap-1.5 truncate">
                        {issue.labels.slice(0, 3).map((label) => (
                          <span key={label.name} className="flex shrink-0 items-center gap-1">
                            <span
                              className="inline-block h-1.5 w-1.5 rounded-full"
                              style={{ backgroundColor: label.color }}
                            />
                            {label.name}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </span>
                <span className="w-16 shrink-0 text-right text-4xs text-zinc-500">
                  {relativeDate(issue.updatedAt)}
                </span>
              </RowLink>
            ))
          )}
        </>
      )}

      <p className="mt-4 px-2.5 text-4xs leading-relaxed text-zinc-500">
        Pick a file on the left, or a commit in the graph, to read its diff here.
      </p>
    </div>
  );
}
