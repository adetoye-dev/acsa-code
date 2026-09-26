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
import type { GitCommit, GitRef } from "../../services/gitGraph";

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
}

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
  const [selected, setSelected] = useState<{ file: ChangedGitFile; staged: boolean } | null>(null);
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
    setDiff(null);
    setNotice(null);
    setCommitMessage("");
    void fetchStatus();
    void fetchLog();
  }, [fetchStatus, fetchLog]);

  /** Preview a file's diff. The newest request wins; older ones are dropped. */
  const preview = useCallback(
    async (file: ChangedGitFile, isStaged: boolean) => {
      setSelected({ file, staged: isStaged });
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
      if (selected) {
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
      setDiff(null);
    }
  }, [commitMessage, runAction]);

  const totalChanges = staged.length + unstaged.length;
  const canCommit = commitMessage.trim().length > 0 && staged.length > 0;

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
                selectedPath={selected?.file.path ?? null}
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
                selectedPath={selected?.file.path ?? null}
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
          onRefresh={() => void fetchLog()}
        />
      </div>

      {/* ── Diff ──────────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col bg-canvas">
        {diff ? (
          <>
            <div className="flex items-center gap-2 border-b border-hairline px-3 py-2 text-2xs">
              <Icon icon={FileCode} className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
              <span className="truncate font-mono text-zinc-200">{diff.path}</span>
              <span className="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-4xs text-zinc-400">
                {selected?.staged ? "staged — HEAD vs index" : "unstaged — index vs working tree"}
              </span>
              {isDiffLoading && (
                <span className="shrink-0 text-4xs text-zinc-500">loading…</span>
              )}
            </div>
            {/* No accept/reject callbacks: a git diff is read, not applied. */}
            <div className="min-h-0 flex-1">
              <Suspense fallback={<SurfaceFallback label="the diff" />}>
                <MonacoDiffContainer
                  originalContent={diff.original}
                  modifiedContent={diff.modified}
                  filePath={diff.path}
                />
              </Suspense>
            </div>
          </>
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
