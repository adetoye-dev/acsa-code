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
  Check,
  ChevronDown,
  ChevronRight,
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
import { RepoOverview } from "./RepoOverview";
import { useGhOverview } from "../../hooks/useGhOverview";

/* Monaco is ~1.5 MB. This page is part of the workbench bundle, so the diff
   surface loads only when a file is actually being reviewed — the same rule the
   dockview panels follow. */
const MonacoDiffContainer = lazy(() =>
  import("../editor/MonacoDiffContainer").then((m) => ({ default: m.MonacoDiffContainer }))
);

export interface ChangedGitFile {
  path: string;
  /** Where the file was, for a rename or a copy; empty for everything else. */
  fromPath?: string;
  indexStatus: string;
  workTreeStatus: string;
  isStaged: boolean;
}

interface GitDashboardProps {
  projectCwd: string;
  /** Something on disk moved: refresh the tree and the branch in the titlebar. */
  onWorkspaceChanged?: () => void;
  /**
   * Bumped whenever the workspace is re-read, which is how this page hears about
   * changes it did not make: a checkout from the titlebar, an agent writing files
   * in the chat, the tree's own refresh. Without it the page kept showing the
   * branch and the changes it had seen when it mounted.
   */
  workspaceRevision?: number;
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
  conflicted?: ChangedGitFile[];
  /** `merge`, `rebase`, `cherry-pick`, `revert`, or empty when nothing is in flight. */
  operation?: string;
  originalContent?: string;
  modifiedContent?: string;
  commits?: GitCommit[];
  refs?: GitRef[];
  head?: string;
  commit?: GitCommit;
  files?: GitCommitFile[];
  hunks?: ChangeHunk[];
}

/** One hunk of a changed file, as the engine describes it. */
interface ChangeHunk {
  index: number;
  /** The `@@ -1,4 +1,5 @@` line, section heading and all. */
  header: string;
  additions: number;
  deletions: number;
  /** The first changed line's text, which is what tells two hunks apart. */
  preview: string;
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

/**
 * What a commit's file is being compared against.
 *
 * `commit` is the commit's own change — its parent against it, what the row in the
 * graph was about. `since` is that commit against the file on disk now, which is how
 * you find out whether an old commit is still the state of play for a file.
 */
type DiffScope = "commit" | "since";

/** `git status --porcelain` letters, in the colours people expect for them. */
function statusTone(status: string): string {
  switch (status) {
    case "A":
    case "??":
      return "text-emerald-400";
    case "D":
      return "text-red-400";
    // An unresolved conflict: the one status where committing is not possible.
    case "U":
      return "text-red-400";
    case "R":
      return "text-sky-400";
    case "M":
      return "text-amber-300";
    default:
      return "text-zinc-400";
  }
}

/**
 * How many commits one read of the history asks for.
 *
 * Sixty fills the pane at any window size and is cheap for git to read; the graph
 * offers to read more when the window comes back full, rather than guessing a size
 * that suits every repository.
 */
const HISTORY_PAGE = 60;

/** How a half-finished operation reads above the changes it is about. */
const OPERATION_LABELS: Record<string, string> = {
  merge: "Merging",
  rebase: "Rebasing",
  "cherry-pick": "Cherry-picking",
  revert: "Reverting",
};

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
function diffScopeLabel(
  selection: Selection | null,
  detail: { commit: GitCommit } | null,
  scope: DiffScope
): string {
  if (selection?.kind === "commit") {
    return scope === "since"
      ? `${detail?.commit.short ?? ""} — commit vs working tree`
      : `${detail?.commit.short ?? ""} — parent vs commit`;
  }
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

export function GitDashboard({
  projectCwd,
  onWorkspaceChanged,
  workspaceRevision = 0,
}: GitDashboardProps) {
  const [isGit, setIsGit] = useState(true);
  const [branch, setBranch] = useState("main");
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
  const [staged, setStaged] = useState<ChangedGitFile[]>([]);
  const [unstaged, setUnstaged] = useState<ChangedGitFile[]>([]);
  /** Unresolved conflicts, which are neither staged nor a working-tree change. */
  const [conflicted, setConflicted] = useState<ChangedGitFile[]>([]);
  /** A merge, rebase, cherry-pick or revert that is stopped half-way. */
  const [operation, setOperation] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const [commitMessage, setCommitMessage] = useState("");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [commitDetail, setCommitDetail] = useState<{ commit: GitCommit; files: GitCommitFile[] } | null>(null);
  const [diff, setDiff] = useState<{ path: string; original: string; modified: string } | null>(null);
  /** What an open commit's diff is compared against; the change view has its own. */
  const [diffScope, setDiffScope] = useState<DiffScope>("commit");
  /** The hunks of the change on screen, for staging them one at a time. */
  const [hunks, setHunks] = useState<ChangeHunk[]>([]);
  const [hunksError, setHunksError] = useState<string | null>(null);
  const [isHunksOpen, setIsHunksOpen] = useState(false);
  /** Which hunk is being applied, so its own button can say so. */
  const [hunkBusy, setHunkBusy] = useState<number | null>(null);
  const [isDiffLoading, setIsDiffLoading] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<ChangedGitFile | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [refs, setRefs] = useState<GitRef[]>([]);
  const [head, setHead] = useState("");
  const [isLogLoading, setIsLogLoading] = useState(true);
  /** A history that could not be read is not an empty history, and says so. */
  const [logError, setLogError] = useState<string | null>(null);
  /** How much of the history is being read. Sixty fills the pane; "load more" grows it. */
  const [logLimit, setLogLimit] = useState(HISTORY_PAGE);
  const requestSeq = useRef(0);
  /** A pending re-read of the remote half after a push; cleared on unmount. */
  const catchUpTimer = useRef<number | null>(null);
  /**
   * The remote's state, read here rather than inside the landing view: selecting a
   * file swaps that view out, and re-asking GitHub (three `gh` calls, seconds each)
   * every time the user came back to it would be a tax on the commonest gesture.
   */
  const overview = useGhOverview(projectCwd);
  // Destructured for the focus listener, which needs the two values rather than the
  // object: the hook returns a fresh object every render, so depending on it would
  // re-subscribe on every keystroke.
  const { checkedAt: overviewCheckedAt, refresh: refreshOverview } = overview;

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
    setConflicted(data.conflicted || []);
    setOperation(data.operation || "");
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
    const data = await call("log", { limit: logLimit });
    const failed = data.success === false;
    setLogError(failed ? data.error || "The history could not be read." : null);
    setCommits(failed ? [] : data.commits || []);
    setRefs(failed ? [] : data.refs || []);
    setHead(failed ? "" : data.head || "");
    setIsLogLoading(false);
  }, [call, logLimit]);

  useEffect(() => {
    // A different repository: nothing from the old one may linger, down to the
    // half-typed commit message.
    setSelected(null);
    setCommitDetail(null);
    setDiff(null);
    setNotice(null);
    setCommitMessage("");
    void fetchStatus();
    void fetchLog();
  }, [fetchStatus, fetchLog]);

  /** A pending post-push re-read has to die with the page. */
  useEffect(
    () => () => {
      if (catchUpTimer.current !== null) window.clearTimeout(catchUpTimer.current);
    },
    []
  );

  /** Preview a file's diff. The newest request wins; older ones are dropped. */
  const preview = useCallback(
    async (file: ChangedGitFile, isStaged: boolean) => {
      setSelected({ kind: "change", file, staged: isStaged });
      setCommitDetail(null);
      setIsDiffLoading(true);
      const seq = ++requestSeq.current;
      const data = await call("diff-file", {
        filePath: file.path,
        fromPath: file.fromPath,
        staged: isStaged,
      });
      if (seq !== requestSeq.current) return;
      setDiff({
        path: file.path,
        original: data.originalContent ?? "",
        modified: data.modifiedContent ?? "",
      });
      setIsDiffLoading(false);

      // Which hunks this file has. An untracked file has none — there is nothing for
      // git to compare — and neither has a binary one, so the strip stays away and
      // the file-level actions above remain the way to stage those.
      const described = await call("hunks", { filePath: file.path, staged: isStaged });
      if (seq !== requestSeq.current) return;
      setHunks(described.success === false ? [] : described.hunks || []);
      setHunksError(
        described.success === false ? described.error || "The hunks could not be read." : null
      );
    },
    [call]
  );


  /**
   * The open selection, as a ref.
   *
   * The refresh callbacks below must not be re-created when the selection changes:
   * the effects that depend on them would then re-run on every click, which is a
   * status and a history read per file. The ref is written by an effect, so it is
   * current for anything that runs after a render.
   */
  const selectionRef = useRef<Selection | null>(null);
  useEffect(() => {
    selectionRef.current = selected;
  }, [selected]);

  /**
   * A re-read of the status is only half a refresh: what is on screen has to stay
   * true to it.
   *
   * A selected change whose file is still changed gets its diff read again — an
   * agent may have written to that file since, and a diff that no longer matches
   * the file is exactly what this page must not show — following the file between
   * the staged and unstaged groups if it moved. A selected change whose file is no
   * longer changed is dropped rather than left behind, still labelled with a change
   * that has been committed from under it.
   */
  const reconcileSelection = useCallback(
    async (status: GitResponse) => {
      const open = selectionRef.current;
      if (open?.kind !== "change") return;
      const fresh = [...(status.staged || []), ...(status.unstaged || [])].find(
        (file) => file.path === open.file.path
      );
      if (!fresh) {
        setSelected(null);
        setDiff(null);
        return;
      }
      const stagedNow = (status.staged || []).some((file) => file.path === fresh.path);
      await preview(fresh, stagedNow === open.staged ? open.staged : stagedNow);
    },
    [preview]
  );

  /** Re-read the working tree, and make what is on screen true to it. */
  const readWorkspace = useCallback(async () => {
    const status = await fetchStatus();
    await reconcileSelection(status);
  }, [fetchStatus, reconcileSelection]);

  /**
   * The workspace moved under the page — a checkout from the titlebar, an agent
   * writing files in the chat, the file tree's own refresh — so the data is read
   * again. Only the data: the open file, a half-typed commit message and the
   * scroll position belong to the person using the page, not to a refresh.
   */
  useEffect(() => {
    if (workspaceRevision === 0) return;
    void readWorkspace();
    void fetchLog();
  }, [workspaceRevision, readWorkspace, fetchLog]);

  /**
   * Coming back to the window re-reads the working tree, because the likeliest
   * reason this page is wrong is that something happened while it was in the
   * background — a terminal in another window, an editor outside the app. The
   * remote half is network-bound, so it waits until what is on screen is old
   * enough to be worth asking about again.
   */
  useEffect(() => {
    const onFocus = () => {
      void readWorkspace();
      void fetchLog();
      if (overviewCheckedAt && Date.now() - overviewCheckedAt > 10 * 60_000) {
        refreshOverview();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [readWorkspace, fetchLog, overviewCheckedAt, refreshOverview]);

  /**
   * Open a commit: its header and files, then the first file's diff.
   *
   * Picking the first file rather than showing a list-only view matters — a commit
   * with three files and no diff on screen is the panel being coy about the one
   * thing you opened it to read.
   */
  /**
   * The two sides of one file in an open commit.
   *
   * Both scopes go through here so the diff shown for the first file of a commit
   * and for the file you click later cannot disagree about what they are comparing.
   */
  const commitFileSides = useCallback(
    (sha: string, file: GitCommitFile, scope: DiffScope) =>
      scope === "since"
        ? call("diff-since", { ref: sha, filePath: file.path })
        : call("commit-file", { sha, filePath: file.path, fromPath: file.fromPath }),
    [call]
  );

  const openCommit = useCallback(
    async (commit: GitCommit) => {
      setSelected({ kind: "commit", commit });
      setCommitDetail(null);
      setDiff(null);
      setHunks([]);
      setHunksError(null);
      // A commit opens as its own change; the scope is a question you ask after.
      setDiffScope("commit");
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
        const sides = await commitFileSides(commit.sha, first, "commit");
        if (seq !== requestSeq.current) return;
        setDiff({ path: first.path, original: sides.originalContent ?? "", modified: sides.modifiedContent ?? "" });
      }
      setIsDiffLoading(false);
    },
    [call, commitFileSides]
  );

  /** One file inside the commit that is open. */
  const openCommitFile = useCallback(
    async (file: GitCommitFile, scope: DiffScope = diffScope) => {
      if (selected?.kind !== "commit") return;
      setIsDiffLoading(true);
      const seq = ++requestSeq.current;
      const sides = await commitFileSides(selected.commit.sha, file, scope);
      if (seq !== requestSeq.current) return;
      setDiff({
        path: file.path,
        original: sides.originalContent ?? "",
        modified: sides.modifiedContent ?? "",
      });
      setIsDiffLoading(false);
    },
    [commitFileSides, diffScope, selected]
  );

  /**
   * Flip what the open commit is compared against, and re-read the file on screen.
   *
   * The new scope is passed straight through rather than read back from state: the
   * re-read happens in the same tick, when `diffScope` still holds the old value,
   * and asking for the diff you just asked for is the one thing a toggle must not do.
   */
  const changeDiffScope = useCallback(
    async (next: DiffScope) => {
      setDiffScope(next);
      if (selected?.kind !== "commit" || !commitDetail || !diff) return;
      const open = commitDetail.files.find((file) => file.path === diff.path);
      if (open) await openCommitFile(open, next);
    },
    [commitDetail, diff, openCommitFile, selected]
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
      // Pushing changes what the remote knows about this branch, so the GitHub half
      // is re-read too — and once more a few seconds later, because a new run takes
      // that long to appear and "checked just now" beside the pre-push list would be
      // worse than not refreshing at all.
      if (action === "push" || action === "pull") {
        overview.refresh();
        if (action === "push") {
          if (catchUpTimer.current !== null) window.clearTimeout(catchUpTimer.current);
          catchUpTimer.current = window.setTimeout(() => {
            catchUpTimer.current = null;
            overview.refresh();
          }, 8000);
        }
      }
      await reconcileSelection(status);
      setBusy(null);
      return true;
    },
    [call, fetchStatus, fetchLog, onWorkspaceChanged, overview, reconcileSelection]
  );

  /**
   * Stage or unstage one hunk, through the same path as every other mutation.
   *
   * `runAction` re-reads the status, tells the workspace (which re-reads this file's
   * diff and hunks) and reconciles the selection. That is what makes the loop close:
   * once the last hunk of a file is staged, the file moves to the staged group, the
   * selection follows it there, and the strip offers to take a hunk back out instead
   * of the pane jumping away from the file being worked on.
   */
  const applyOneHunk = useCallback(
    async (index: number) => {
      if (selected?.kind !== "change") return;
      setHunkBusy(index);
      await runAction(`hunk-${index}`, "apply-hunk", {
        filePath: selected.file.path,
        hunk: index,
        staged: selected.staged,
      });
      setHunkBusy(null);
    },
    [runAction, selected]
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

  // A conflicted file is changed work, so it counts here — otherwise a page full of
  // conflicts would claim the working tree was clean.
  const totalChanges = staged.length + unstaged.length + conflicted.length;
  // Git refuses to commit an unresolved conflict, so the button must not offer it.
  const canCommit = commitMessage.trim().length > 0 && staged.length > 0 && conflicted.length === 0;
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
            <span data-testid="git-branch" className="truncate font-mono text-2xs text-zinc-100">
              {branch}
            </span>
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
              onClick={() => {
                void readWorkspace();
                void fetchLog();
              }}
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
          {/* A half-finished merge is the context for everything below it, and the
              one state where the commit button deliberately refuses to work. */}
          {operation && (
            <div
              data-testid="git-operation"
              className="mb-2 rounded-lg border border-amber-900/60 bg-amber-950/30 px-2.5 py-2 text-4xs leading-relaxed text-amber-200"
            >
              {OPERATION_LABELS[operation] ?? "In progress"}
              {conflicted.length > 0 ? (
                <>
                  {" — "}
                  {conflicted.length} file{conflicted.length === 1 ? "" : "s"} still{" "}
                  {conflicted.length === 1 ? "has" : "have"} conflicts. Mark{" "}
                  {conflicted.length === 1 ? "it" : "them"} resolved to carry on.
                </>
              ) : (
                " — every conflict is resolved. Commit to finish."
              )}
            </div>
          )}
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
              {/* Conflicts come first: nothing else on this list can be committed
                  until they are gone. */}
              <ChangeGroup
                title="Merge conflicts"
                files={conflicted}
                isStaged={false}
                busy={busy}
                selectedPath={openChange?.file.path ?? null}
                onPreview={(file) => void preview(file, false)}
                /* `git add` is what "resolved" means to git. */
                onAction={(action, file) => void runAction(action, action, { filePath: file.path })}
                onActionAll={() => void runAction("resolve-all", "resolve-all")}
                actionIcon={Check}
                actionTitle="Mark resolved"
              />
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
          hasMore={commits.length >= logLimit}
          onLoadMore={() => setLogLimit((limit) => limit + HISTORY_PAGE)}
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
          working-tree change. One surface, in one place in the tree, because a
          second one would be built (and the first thrown away) on every switch
          between a commit and a change: the container takes the new text and
          updates what it is already showing. The disposal order that used to make
          that swap unsafe is the container's business now.
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
                      onClick={() => void openCommitFile(file)}
                      title={file.fromPath ? `${file.fromPath} → ${file.path}` : file.path}
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
                      {/* The commit's file list had only the name, so two files
                          called `index.ts` were told apart by a hover. The change
                          rows already dim the directory; this matches them. */}
                      <span className="hidden min-w-0 shrink-0 truncate font-mono text-4xs text-zinc-500 xl:inline">
                        {file.fromPath ? `← ${parentDir(file.fromPath) || shortName(file.fromPath)}` : parentDir(file.path)}
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
                    {diffScopeLabel(selected, commitDetail, diffScope)}
                  </span>
                  {/* A commit's own change, or that commit against the file on disk:
                      the second is how you find out whether an old commit is still
                      the state of play. Only a commit has two scopes — a working-tree
                      change has exactly one thing it can be compared with. */}
                  {selected?.kind === "commit" && commitDetail && (
                    <button
                      type="button"
                      data-testid="git-compare-scope"
                      onClick={() => void changeDiffScope(diffScope === "since" ? "commit" : "since")}
                      title={
                        diffScope === "since"
                          ? "Show this commit's own change"
                          : "Show what has changed since this commit"
                      }
                      className="shrink-0 rounded-md px-1.5 py-0.5 text-4xs text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
                    >
                      {diffScope === "since" ? "Back to the commit" : "Compare with working tree"}
                    </button>
                  )}
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
                {/* Hunks, so part of a file can be staged. Only a working-tree change
                    can be staged at all, which is why the commit view does not offer
                    them: a commit's diff is history, not an index to move. */}
                {openChange && hunksError && (
                  <p
                    data-testid="git-hunks-error"
                    className="shrink-0 border-b border-hairline px-3 py-1 text-4xs text-amber-300"
                  >
                    {hunksError}
                  </p>
                )}
                {openChange && !hunksError && hunks.length > 0 && (
                  <div className="shrink-0 border-b border-hairline">
                    <button
                      type="button"
                      data-testid="git-hunks-toggle"
                      onClick={() => setIsHunksOpen((open) => !open)}
                      className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-4xs text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
                    >
                      <Icon
                        icon={isHunksOpen ? ChevronDown : ChevronRight}
                        className="w-3 h-3 shrink-0"
                      />
                      <span className="shrink-0">
                        {hunks.length} hunk{hunks.length === 1 ? "" : "s"}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {isHunksOpen
                          ? "stage or unstage one at a time"
                          : "of this file — stage one at a time"}
                      </span>
                    </button>
                    {isHunksOpen && (
                      <div
                        data-testid="git-hunks"
                        className="max-h-40 overflow-y-auto border-t border-hairline"
                      >
                        {hunks.map((hunk) => (
                          <div key={hunk.index} className="flex items-center gap-2 px-3 py-1">
                            <span
                              className="shrink-0 font-mono text-4xs text-zinc-500"
                              title={hunk.header}
                            >
                              {hunk.header}
                            </span>
                            <span className="shrink-0 font-mono text-4xs">
                              <span className="text-emerald-400">+{hunk.additions}</span>
                              <span className="ml-1 text-red-400">-{hunk.deletions}</span>
                            </span>
                            {/* Which hunk is which is answered by the text, not the
                                line numbers, so the first changed line is shown. */}
                            <span
                              className="min-w-0 flex-1 truncate text-4xs text-zinc-400"
                              title={hunk.preview}
                            >
                              {hunk.preview}
                            </span>
                            <button
                              type="button"
                              data-testid={`git-hunk-${hunk.index}`}
                              disabled={busy !== null || hunkBusy !== null}
                              onClick={() => void applyOneHunk(hunk.index)}
                              className="shrink-0 rounded-md px-1.5 py-0.5 text-4xs text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100 disabled:opacity-40"
                            >
                              {hunkBusy === hunk.index
                                ? "working…"
                                : openChange.staged
                                  ? "Unstage hunk"
                                  : "Stage hunk"}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

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
                  {/*
                    Identical sides mean there is nothing to draw — for a binary file
                    that is "both sides are empty", and for a comparison against the
                    working tree it means the file has not moved since that commit.
                  */}
                  {diff.original === diff.modified && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                      <PaneMessage
                        icon={FileCode}
                        headline={
                          diffScope === "since" ? "No changes since this commit" : "Nothing to compare"
                        }
                        detail={
                          diffScope === "since"
                            ? `${diff.path} on disk matches the commit.`
                            : "Both sides are empty — the file is binary, or it is empty."
                        }
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
              /* Nothing local is selected, so the pane answers the questions that
                 are not local: checks, pull requests, and your issues. */
              <RepoOverview
                projectCwd={projectCwd}
                data={overview.data}
                isLoading={overview.isLoading}
                checkedAt={overview.checkedAt}
                onRefresh={overview.refresh}
              />
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
              {/* A rename is two names; the old one is the answer to "what was
                  this before", which the new name cannot give. */}
              {file.fromPath && (
                <span
                  className="hidden min-w-0 shrink-0 truncate font-mono text-4xs text-zinc-500 xl:inline"
                  title={`${file.fromPath} → ${file.path}`}
                >
                  ← {shortName(file.fromPath)}
                </span>
              )}
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
