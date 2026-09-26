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
import { useState } from "react";
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
import type { GhIssue, GhOverview, GhPullRequest, GhRun } from "../../services/ghClient";

interface RepoOverviewProps {
  data: GhOverview | null;
  isLoading: boolean;
  /** When the answer was read, epoch ms; 0 before the first one arrives. */
  checkedAt: number;
  onRefresh: () => void;
}

/** How a run's outcome reads: an icon, its colour, and the word for it. */
function runAppearance(run: GhRun): { icon: typeof CheckCircle2; tone: string; label: string } {
  if (run.status && run.status !== "completed") {
    return {
      icon: Loader2,
      tone: "text-sky-400",
      label: run.status.replace(/_/g, " "),
    };
  }
  switch ((run.conclusion || "").toLowerCase()) {
    case "success":
      return { icon: CheckCircle2, tone: "text-emerald-400", label: "success" };
    case "failure":
    case "startup_failure":
    case "timed_out":
      return { icon: XCircle, tone: "text-red-400", label: run.conclusion.replace(/_/g, " ") };
    case "cancelled":
      return { icon: CircleSlash, tone: "text-amber-300", label: "cancelled" };
    default:
      // A conclusion nobody predicted is worth showing as-is rather than hiding.
      return { icon: CircleDashed, tone: "text-zinc-400", label: run.conclusion || "unknown" };
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
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/5"
    >
      {children}
    </button>
  );
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

export function RepoOverview({ data, isLoading, checkedAt, onRefresh }: RepoOverviewProps) {
  const [copied, setCopied] = useState(false);

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

      <SectionHeader title="Checks" href={actionsUrl}>
        <span className="text-4xs text-zinc-500">{data.runs.length} recent</span>
      </SectionHeader>
      {data.runs.length === 0 ? (
        <p className={MUTED_LINE}>No workflow runs.</p>
      ) : (
        data.runs.map((run) => {
          const look = runAppearance(run);
          return (
            <RowLink key={`${run.id}-${run.createdAt}`} url={run.url} testId={`gh-run-${run.id}`}>
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
