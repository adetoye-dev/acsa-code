/**
 * GitDashboard.tsx — source control as a page rather than a column.
 *
 * The sidebar version could show a list and a commit box; a page can show the
 * list *and* the diff you are deciding about, side by side, which is the whole
 * reason to open source control. Nothing here is new plumbing: it is the same
 * `git` engine commands the sidebar called (`status`, `diff-file`, `stage`,
 * `unstage`, `discard`, `stage-all`, `unstage-all`, `commit`, `pull`, `push`),
 * arranged so the decision and its evidence are on screen together.
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  FileCode,
  GitBranch,
  GitCommitHorizontal,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
} from "lucide-react";
import { Icon } from "../ui/Icon";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { FileIcon } from "../ui/FileIcon";
import { SurfaceFallback } from "../ui/SurfaceFallback";
import { CommitGraph } from "./CommitGraph";
import { gitFetch } from "../../services/gitClient";
import type { GitCommit, GitCommitFile, GitRef } from "../../services/gitGraph";

/* Monaco is ~1.5 MB. This page is part of the workbench bundle, so the diff
   surface loads only when a file is actually being reviewed — the same rule the
   dockview panels follow. */
const MonacoDiffContainer = lazy(() =>
  import("../editor/MonacoDiffContainer").then((m) => ({ default: m.MonacoDiffContainer }))
);

export interface ChangedGitFile {
  path: string;
  indexStatus: string;
  workTreeStatus: string;
  isStaged: boolean;
}

interface GitDashboardProps {
  projectCwd: string;
  /** Something on disk moved: refresh the tree and the branch in the titlebar. */
  onWorkspaceChanged?: () => void;
}

interface GitResponse {
  success?: boolean;
  error?: string;
  output?: string;
  message?: string;
  isGit?: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  staged?: ChangedGitFile[];
  unstaged?: ChangedGitFile[];
  originalContent?: string;
  modifiedContent?: string;
  commits?: GitCommit[];
  refs?: GitRef[];
  head?: string;
  commit?: GitCommit;
  files?: GitCommitFile[];
}

/**
 * What the right-hand pane is about.
 *
 * The change lists and the graph both feed that pane, so the two cases are one
 * piece of state rather than two flags that can disagree about what is selected.
 */
type Selection =
  | { kind: "change"; file: ChangedGitFile; staged: boolean }
  | { kind: "commit"; commit: GitCommit };

/** `git status --porcelain` letters, in the colours people expect for them. */
function statusTone(status: string): string {
  switch (status) {
    case "A":
    case "??":
      return "text-emerald-400";
    case "D":
      return "text-red-400";
    case "R":
      return "text-sky-400";
    case "M":
      return "text-amber-300";
    default:
      return "text-zinc-400";
  }
}

const shortName = (path: string) => path.split("/").pop() || path;
/** The dimmed half of a path, the way source control lists truncate to. */
const parentDir = (path: string) => {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
};

/** A commit's timestamp, short enough to sit in a header. */
const shortDate = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

/**
 * What the two sides of the open diff are, in words.
 *
 * A commit is its parent against the commit itself; a working-tree change is
 * HEAD against the index when staged and the index against the file when not.
 * The pane reads a commit *or* a change, so it has to name which.
 */
function diffScopeLabel(selection: Selection | null, detail: { commit: GitCommit } | null): string {
  if (selection?.kind === "commit") return `${detail?.commit.short ?? ""} — parent vs commit`;
  if (selection?.kind === "change" && selection.staged) return "staged — HEAD vs index";
  return "unstaged — index vs working tree";
}

/** A centred line for a pane that is busy or has nothing to show. */
function PaneMessage({
  headline,
  detail,
  icon = GitCommitHorizontal,
}: {
  headline: string;
  detail?: string;
  icon?: typeof GitCommitHorizontal;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
      <Icon icon={icon} className="w-5 h-5 text-zinc-500" />
      <div className="text-2xs text-zinc-300">{headline}</div>
      {detail && <p className="max-w-md truncate text-4xs text-zinc-500">{detail}</p>}
    </div>
  );
}

/** An action that belongs beside the diff it acts on, not only in a list row. */
function HeaderAction({
  icon,
  label,
  onClick,
  disabled,
  destructive = false,
}: {
  icon: typeof Plus;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md p-1.5 text-zinc-400 transition-colors disabled:opacity-40 ${
        destructive ? "hover:bg-red-950/60 hover:text-red-300" : "hover:bg-white/5 hover:text-zinc-100"
      }`}
    >
      <Icon icon={icon} className="w-3.5 h-3.5" />
    </button>
  );
}

export function GitDashboard({ projectCwd, onWorkspaceChanged }: GitDashboardProps) {
  const [isGit, setIsGit] = useState(true);
  const [branch, setBranch] = useState("main");
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
  const [staged, setStaged] = useState<ChangedGitFile[]>([]);
  const [unstaged, setUnstaged] = useState<ChangedGitFile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const [commitMessage, setCommitMessage] = useState("");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [commitDetail, setCommitDetail] = useState<{ commit: GitCommit; files: GitCommitFile[] } | null>(null);
  const [diff, setDiff] = useState<{ path: string; original: string; modified: string } | null>(null);
  const [isDiffLoading, setIsDiffLoading] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<ChangedGitFile | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [refs, setRefs] = useState<GitRef[]>([]);
  const [head, setHead] = useState("");
  const [isLogLoading, setIsLogLoading] = useState(true);
  /** A history that could not be read is not an empty history, and says so. */
  const [logError, setLogError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const call = useCallback(
    async (action: string, payload: Record<string, unknown> = {}): Promise<GitResponse> => {
      try {
        const res = await gitFetch(`/api/git/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: projectCwd, ...payload }),
        });
        return (await res.json()) as GitResponse;
      } catch (error) {
        return { success: false, error: String((error as Error)?.message ?? error) };
      }
    },
    [projectCwd]
  );

  const fetchStatus = useCallback(async () => {
    setIsLoading(true);
    const data = await call("status");
    setIsGit(data.isGit !== false);
    setBranch(data.branch || "main");
    setAhead(data.ahead || 0);
    setBehind(data.behind || 0);
    setStaged(data.staged || []);
    setUnstaged(data.unstaged || []);
    setIsLoading(false);
    return data;
  }, [call]);

  /**
   * The history, which the graph draws. Sixty is enough to fill the pane at any
   * window size and cheap for git to read; the count is shown, so a truncated
   * history says so rather than looking like the whole repository.
   */
  const fetchLog = useCallback(async () => {
    setIsLogLoading(true);
    const data = await call("log", { limit: 60 });
    const failed = data.success === false;
    setLogError(failed ? data.error || "The history could not be read." : null);
    setCommits(failed ? [] : data.commits || []);
    setRefs(failed ? [] : data.refs || []);
    setHead(failed ? "" : data.head || "");
    setIsLogLoading(false);
  }, [call]);

  useEffect(() => {
    setSelected(null);
    setCommitDetail(null);
    setDiff(null);
    setNotice(null);
    setCommitMessage("");
    void fetchStatus();
    void fetchLog();
  }, [fetchStatus, fetchLog]);

  /** Preview a file's diff. The newest request wins; older ones are dropped. */
  const preview = useCallback(
    async (file: ChangedGitFile, isStaged: boolean) => {
      setSelected({ kind: "change", file, staged: isStaged });
      setCommitDetail(null);
      setIsDiffLoading(true);
      const seq = ++requestSeq.current;
      const data = await call("diff-file", { filePath: file.path, staged: isStaged });
      if (seq !== requestSeq.current) return;
      setDiff({
        path: file.path,
        original: data.originalContent ?? "",
        modified: data.modifiedContent ?? "",
      });
      setIsDiffLoading(false);
    },
    [call]
  );

  /**
   * Open a commit: its header and files, then the first file's diff.
   *
   * Picking the first file rather than showing a list-only view matters — a commit
   * with three files and no diff on screen is the panel being coy about the one
   * thing you opened it to read.
   */
  const openCommit = useCallback(
    async (commit: GitCommit) => {
      setSelected({ kind: "commit", commit });
      setCommitDetail(null);
      setDiff(null);
      setIsDiffLoading(true);
      const seq = ++requestSeq.current;

      const data = await call("commit-info", { sha: commit.sha });
      if (seq !== requestSeq.current) return;
      if (data.success === false) {
        setNotice({ tone: "error", text: data.error || "That commit could not be read." });
        setIsDiffLoading(false);
        return;
      }
      const files = data.files || [];
      // The graph already knows the subject and author, so the header is filled
      // in from the row while the rest of the detail is read.
      setCommitDetail({ commit: { ...commit, ...(data.commit ?? {}) }, files });

      const first = files[0];
      if (first) {
        const sides = await call("commit-file", { sha: commit.sha, filePath: first.path });
        if (seq !== requestSeq.current) return;
        setDiff({ path: first.path, original: sides.originalContent ?? "", modified: sides.modifiedContent ?? "" });
      }
      setIsDiffLoading(false);
    },
    [call]
  );

  /** One file inside the commit that is open. */
  const openCommitFile = useCallback(
    async (path: string) => {
      if (selected?.kind !== "commit") return;
      setIsDiffLoading(true);
      const seq = ++requestSeq.current;
      const sides = await call("commit-file", { sha: selected.commit.sha, filePath: path });
      if (seq !== requestSeq.current) return;
      setDiff({ path, original: sides.originalContent ?? "", modified: sides.modifiedContent ?? "" });
      setIsDiffLoading(false);
    },
    [call, selected]
  );

  /**
   * Run a mutation, then reconcile: the status is re-read, the file tree and the
   * titlebar's branch are told, and a preview of a file that no longer has
   * changes is dropped rather than left showing a diff that is already committed.
   */
  const runAction = useCallback(
    async (label: string, action: string, payload: Record<string, unknown> = {}) => {
      setBusy(label);
      setNotice(null);
      const data = await call(action, payload);
      if (data.success === false) {
        setNotice({ tone: "error", text: data.error || `${action} failed` });
        setBusy(null);
        return false;
      }
      setNotice({ tone: "ok", text: data.output || data.message || `${action} done` });
      const status = await fetchStatus();
      // A commit moves the graph; so does a fetch, which can bring commits in.
      await fetchLog();
      onWorkspaceChanged?.();
      if (selected?.kind === "change") {
        const stillChanged = [...(status.staged || []), ...(status.unstaged || [])].some(
          (file) => file.path === selected.file.path
        );
        if (!stillChanged) {
          setSelected(null);
          setDiff(null);
        }
      }
      setBusy(null);
      return true;
    },
    [call, fetchStatus, fetchLog, onWorkspaceChanged, selected]
  );

  const commit = useCallback(async () => {
    const committed = await runAction("commit", "commit", { message: commitMessage });
    if (committed) {
      setCommitMessage("");
      setSelected(null);
      setCommitDetail(null);
      setDiff(null);
    }
  }, [commitMessage, runAction]);

  const totalChanges = staged.length + unstaged.length;
  const canCommit = commitMessage.trim().length > 0 && staged.length > 0;
  // Hoisted, so the actions below close over a value TypeScript has narrowed once
  // rather than re-narrowing the union inside each handler.
  const openChange = selected?.kind === "change" ? selected : null;

  return (
    <div className="flex h-full w-full min-h-0 select-none">
      {/* ── Changes ───────────────────────────────────────────────────────── */}
      <div className="flex w-[clamp(20rem,24vw,27rem)] max-w-[46%] min-h-0 shrink-0 flex-col border-r border-hairline bg-workbench">
        <div className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Icon icon={GitBranch} className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
            <span className="truncate font-mono text-2xs text-zinc-100">{branch}</span>
            {(ahead > 0 || behind > 0) && (
              <span className="flex items-center gap-1 font-mono text-4xs text-zinc-400">
                {behind > 0 && <span title={`${behind} behind the remote`}>↓{behind}</span>}
                {ahead > 0 && <span title={`${ahead} ahead of the remote`}>↑{ahead}</span>}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              title="Pull"
              aria-label="Pull"
              disabled={busy !== null}
              onClick={() => void runAction("pull", "pull")}
              className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100 disabled:opacity-40"
            >
              <Icon icon={ArrowDownToLine} className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              title="Push"
              aria-label="Push"
              disabled={busy !== null}
              onClick={() => void runAction("push", "push")}
              className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100 disabled:opacity-40"
            >
              <Icon icon={ArrowUpFromLine} className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              title="Refresh"
              aria-label="Refresh"
              disabled={isLoading}
              onClick={() => void fetchStatus()}
              className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100 disabled:opacity-40"
            >
              <Icon icon={RefreshCw} className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {/* ── The commit, and the changes it is about ─────────────────────
            Message first, as source control does: the box at the bottom of the
            panel is the one thing you have to scroll to find after staging. */}
        <div className="flex min-h-0 flex-[1.5] flex-col">
        <div className="shrink-0 border-b border-hairline p-2.5">
          <textarea
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canCommit) {
                event.preventDefault();
                void commit();
              }
            }}
            rows={2}
            placeholder="Commit message"
            aria-label="Commit message"
            data-testid="git-commit-message"
            className="w-full resize-none rounded-lg border border-hairline bg-canvas px-2.5 py-2 font-sans text-2xs text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-accent"
          />
          <button
            type="button"
            disabled={!canCommit || busy !== null}
            onClick={() => void commit()}
            data-testid="git-commit"
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-700 px-2.5 py-1.5 text-2xs font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-40"
          >
            <Icon icon={GitCommitHorizontal} className="w-3.5 h-3.5" />
            <span>
              Commit {staged.length > 0 ? `${staged.length} file${staged.length === 1 ? "" : "s"}` : ""}
            </span>
          </button>
          <div className="mt-1.5 truncate text-4xs text-zinc-500">
            {busy ? `${busy}…` : notice ? notice.text : `${totalChanges} changed`}
          </div>
          {notice?.tone === "error" && (
            <div className="mt-2 rounded-lg border border-red-800 bg-red-950/50 px-2.5 py-2 text-4xs text-red-300">
              {notice.text}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="git-changes">
          {!isGit ? (
            <div className="p-4 text-2xs leading-relaxed text-zinc-400">
              This folder is not a git repository, so there is nothing to review here. Initialize
              one in a terminal and this page fills in.
            </div>
          ) : (
            <>
              <ChangeGroup
                title="Staged changes"
                files={staged}
                isStaged
                busy={busy}
                selectedPath={openChange?.staged ? openChange.file.path : null}
                onPreview={(file) => void preview(file, true)}
                onAction={(action, file) =>
                  void runAction(action, action, { filePath: file.path })
                }
                onActionAll={() => void runAction("unstage-all", "unstage-all")}
                actionIcon={Minus}
                actionTitle="Unstage"
              />
              <ChangeGroup
                title="Changes"
                files={unstaged}
                isStaged={false}
                busy={busy}
                /* Only the group the selection came from highlights it: a file can be
                   both staged and modified again, and two lit rows would say the diff
                   below is two diffs. */
                selectedPath={openChange && !openChange.staged ? openChange.file.path : null}
                onPreview={(file) => void preview(file, false)}
                onAction={(action, file) =>
                  void runAction(action, action, { filePath: file.path })
                }
                onActionAll={() => void runAction("stage-all", "stage-all")}
                actionIcon={Plus}
                actionTitle="Stage"
                onDiscard={(file) => setConfirmDiscard(file)}
              />
              {totalChanges === 0 && !isLoading && (
                <div className="px-3 py-5 text-2xs leading-relaxed text-zinc-400">
                  Nothing to commit — the working tree is clean.
                </div>
              )}
            </>
          )}
        </div>
        </div>

        <CommitGraph
          commits={commits}
          refs={refs}
          head={head}
          isLoading={isLogLoading}
          error={logError}
          selectedSha={selected?.kind === "commit" ? selected.commit.sha : undefined}
          onSelectCommit={(commit) => void openCommit(commit)}
          onRefresh={() => void fetchLog()}
        />
      </div>

      {/* ── The commit, or the file, you are looking at ───────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col bg-canvas">
        {/* A commit's own header, when a commit is open. */}
        {selected?.kind === "commit" && commitDetail && (
          <div className="shrink-0 border-b border-hairline px-3 py-2">
            <div className="flex items-center gap-2">
              <Icon icon={GitCommitHorizontal} className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
              <span className="min-w-0 flex-1 truncate text-2xs font-medium text-zinc-100">
                {commitDetail.commit.subject}
              </span>
              <span className="flex shrink-0 items-center gap-1.5 font-mono text-4xs text-zinc-500">
                <span title={commitDetail.commit.sha}>{commitDetail.commit.short}</span>
                <span>·</span>
                <span className="truncate">{commitDetail.commit.author}</span>
                <span>·</span>
                <span>{shortDate(commitDetail.commit.date)}</span>
              </span>
            </div>
            {commitDetail.commit.body && (
              <p className="mt-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap text-2xs leading-relaxed text-zinc-400">
                {commitDetail.commit.body}
              </p>
            )}
          </div>
        )}

        {/*
          One row, and one diff surface, for both a commit's file and a
          working-tree change. The surface is deliberately kept in a single place
          in the tree: mounting a second `<DiffEditor>` where the first one stood
          made Monaco dispose a model the widget was still holding — "TextModel
          got disposed before DiffEditorWidget model got reset" — and rebuilt the
          editor on every switch between a commit and a change.
        */}
        <div className="flex min-h-0 flex-1">
          {/* The commit's files. Selecting one swaps the diff beside it, the same
              way the change lists feed the same pane. */}
          {selected?.kind === "commit" && commitDetail && (
            <div className="flex w-[clamp(12rem,16vw,19rem)] shrink-0 flex-col overflow-y-auto border-r border-hairline">
              <div className="px-2.5 py-1.5 text-4xs font-semibold uppercase tracking-wider text-zinc-500">
                {commitDetail.files.length} file{commitDetail.files.length === 1 ? "" : "s"} in this commit
              </div>
              {commitDetail.files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => void openCommitFile(file.path)}
                  title={file.path}
                  data-testid={`git-commit-file-${file.path}`}
                  className={`flex items-center gap-2 px-2.5 py-1 text-left transition-colors ${
                    diff?.path === file.path ? "bg-white/10" : "hover:bg-white/5"
                  }`}
                >
                  <span className={`shrink-0 font-mono text-2xs ${statusTone(file.status)}`}>
                    {file.status}
                  </span>
                  <FileIcon fileName={file.path} className="w-3.5 h-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-2xs text-zinc-200">
                    {shortName(file.path)}
                  </span>
                  <span className="shrink-0 font-mono text-4xs">
                    {file.additions !== null && <span className="text-emerald-400">+{file.additions}</span>}
                    {file.deletions !== null && <span className="ml-1 text-red-400">-{file.deletions}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="flex min-w-0 flex-1 flex-col">
            {diff ? (
              <>
                <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5 text-2xs">
                  <Icon icon={FileCode} className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
                  <span className="truncate font-mono text-zinc-200">{diff.path}</span>
                  <span className="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-4xs text-zinc-400">
                    {diffScopeLabel(selected, commitDetail)}
                  </span>
                  {isDiffLoading && <span className="shrink-0 text-4xs text-zinc-500">loading…</span>}
                  {/* The same actions the row offers, where you are actually
                      looking at the diff you are deciding about. */}
                  {openChange && (
                    <span className="ml-auto flex shrink-0 items-center gap-1">
                      {openChange.staged ? (
                        <HeaderAction
                          icon={Minus}
                          label="Unstage this file"
                          disabled={busy !== null}
                          onClick={() =>
                            void runAction("unstage", "unstage", { filePath: openChange.file.path })
                          }
                        />
                      ) : (
                        <>
                          <HeaderAction
                            icon={Plus}
                            label="Stage this file"
                            disabled={busy !== null}
                            onClick={() => void runAction("stage", "stage", { filePath: openChange.file.path })}
                          />
                          <HeaderAction
                            icon={Undo2}
                            label="Discard changes in this file"
                            disabled={busy !== null}
                            destructive
                            onClick={() => setConfirmDiscard(openChange.file)}
                          />
                        </>
                      )}
                    </span>
                  )}
                </div>
                {/* No accept/reject callbacks: a git diff is read, not applied. */}
                <div className="relative min-h-0 flex-1">
                  <Suspense fallback={<SurfaceFallback label="the diff" />}>
                    {/* No toolbar: the header above already names the file and the scope. */}
                    <MonacoDiffContainer
                      originalContent={diff.original}
                      modifiedContent={diff.modified}
                      filePath={diff.path}
                      showToolbar={false}
                    />
                  </Suspense>
                  {/*
                    A binary file — or an empty one — has nothing on either side,
                    and Monaco answers that with two blank panes and no reason.
                    The note is laid *over* the editor rather than instead of it:
                    swapping the editor out for it would dispose models the diff
                    widget is still holding.
                  */}
                  {diff.original === "" && diff.modified === "" && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                      <PaneMessage
                        icon={FileCode}
                        headline="Nothing to compare"
                        detail="Both sides are empty — the file is binary, or it is empty."
                      />
                    </div>
                  )}
                </div>
              </>
            ) : selected?.kind === "commit" ? (
              <PaneMessage
                headline={commitDetail ? "No files in this commit" : "Reading the commit…"}
                detail={commitDetail ? "It is an empty commit." : selected.commit.subject}
              />
            ) : selected ? (
              <PaneMessage headline="Reading the diff…" detail={selected.file.path} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <Icon icon={GitCommitHorizontal} className="w-6 h-6 text-zinc-500" />
                <div className="text-body font-medium text-zinc-300">Review a change</div>
                <p className="max-w-md text-2xs leading-relaxed text-zinc-500">
                  Pick a file on the left and its diff appears here — staged changes as HEAD against the
                  index, working-tree changes as the index against the file on disk.
                </p>
                <div className="mt-1 flex items-center gap-3 text-4xs text-zinc-500">
                  <span className="flex items-center gap-1">
                    <Icon icon={Plus} className="w-3 h-3" /> stage
                  </span>
                  <span className="flex items-center gap-1">
                    <Icon icon={Minus} className="w-3 h-3" /> unstage
                  </span>
                  <span className="flex items-center gap-1">
                    <Icon icon={Undo2} className="w-3 h-3" /> discard
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmDiscard !== null}
        title="Discard changes?"
        message={`This throws away the working-tree changes in ${shortName(confirmDiscard?.path ?? "")}. It cannot be undone.`}
        confirmText="Discard"
        isDestructive
        onCancel={() => setConfirmDiscard(null)}
        onConfirm={() => {
          const file = confirmDiscard;
          setConfirmDiscard(null);
          if (file) void runAction("discard", "discard", { filePath: file.path });
        }}
      />
    </div>
  );
}

interface ChangeGroupProps {
  title: string;
  files: ChangedGitFile[];
  isStaged: boolean;
  busy: string | null;
  selectedPath: string | null;
  onPreview: (file: ChangedGitFile) => void;
  onAction: (action: string, file: ChangedGitFile) => void;
  onActionAll: () => void;
  actionIcon: typeof Plus;
  actionTitle: string;
  onDiscard?: (file: ChangedGitFile) => void;
}

function ChangeGroup({
  title,
  files,
  isStaged,
  busy,
  selectedPath,
  onPreview,
  onAction,
  onActionAll,
  actionIcon,
  actionTitle,
  onDiscard,
}: ChangeGroupProps) {
  if (files.length === 0) return null;
  return (
    <section className="py-1">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span className="text-4xs font-semibold uppercase tracking-wider text-zinc-500">
          {title} · {files.length}
        </span>
        <button
          type="button"
          title={`${actionTitle} all`}
          disabled={busy !== null}
          onClick={onActionAll}
          className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200 disabled:opacity-40"
        >
          <Icon icon={actionIcon} className="w-3 h-3" />
        </button>
      </div>
      {files.map((file) => {
        const status = isStaged ? file.indexStatus : file.workTreeStatus;
        const active = selectedPath === file.path;
        return (
          <div
            key={`${file.path}-${isStaged ? "s" : "w"}`}
            className={`group flex items-center gap-2 px-2.5 py-1.5 ${
              active ? "bg-white/10" : "hover:bg-white/5"
            }`}
          >
            <button
              type="button"
              onClick={() => onPreview(file)}
              data-testid={`git-file-${file.path}`}
              title={file.path}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left"
            >
              <FileIcon fileName={file.path} className="w-3.5 h-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-2xs text-zinc-200">
                {shortName(file.path)}
              </span>
              {parentDir(file.path) && (
                <span className="hidden min-w-0 shrink-0 truncate font-mono text-4xs text-zinc-500 xl:inline">
                  {parentDir(file.path)}
                </span>
              )}
            </button>
            <span
              className={`shrink-0 font-mono text-2xs ${statusTone(status)}`}
              title={status?.trim() || "M"}
            >
              {status?.trim() || "M"}
            </span>
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <button
                type="button"
                title={actionTitle}
                aria-label={`${actionTitle} ${shortName(file.path)}`}
                disabled={busy !== null}
                onClick={() => onAction(isStaged ? "unstage" : "stage", file)}
                className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100 disabled:opacity-40"
              >
                <Icon icon={actionIcon} className="w-3 h-3" />
              </button>
              {onDiscard && (
                <button
                  type="button"
                  title="Discard changes"
                  aria-label={`Discard changes in ${shortName(file.path)}`}
                  disabled={busy !== null}
                  onClick={() => onDiscard(file)}
                  className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-red-950/60 hover:text-red-300 disabled:opacity-40"
                >
                  <Icon icon={Undo2} className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

export default GitDashboard;
