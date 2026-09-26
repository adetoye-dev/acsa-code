// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/** What the fake engine answers, and what it was asked. */
type HunkFixture = {
  index: number;
  header: string;
  additions: number;
  deletions: number;
  preview: string;
};

const engine = vi.hoisted(() => ({
  calls: [] as string[],
  /** What each call was asked, so a request's payload can be asserted. */
  payloads: [] as { action: string; body: Record<string, unknown> }[],
  /** Per-test deviations from the fixture below, cleared before each test. */
  overrides: {} as Record<string, Record<string, unknown>>,
  status: {
    isGit: true,
    branch: "dev",
    ahead: 2,
    behind: 1,
    staged: [{ path: "src/a.ts", indexStatus: "M", workTreeStatus: " ", isStaged: true }],
    unstaged: [
      { path: "src/b.ts", indexStatus: " ", workTreeStatus: "M", isStaged: false },
      { path: "src/new.ts", indexStatus: " ", workTreeStatus: "??", isStaged: false },
    ],
    conflicted: [] as unknown[],
    operation: "",
  },
  diff: { success: true, originalContent: "before", modifiedContent: "after" },
  /** A commit's own change, and the same file against the file on disk now. */
  commitInfo: {
    success: true,
    commit: { sha: "c".repeat(40), short: "ccccccc", author: "Ada", date: new Date().toISOString(), subject: "a commit" },
    files: [{ path: "src/a.ts", fromPath: "", status: "M", additions: 1, deletions: 1 }],
  },
  commitFile: { success: true, originalContent: "parent", modifiedContent: "in the commit" },
  sinceDiff: { success: true, originalContent: "in the commit", modifiedContent: "on disk" },
  /** Two hunks of one file, as the engine describes them. */
  hunks: {
    success: true,
    hunks: [
      { index: 0, header: "@@ -1,4 +1,5 @@", additions: 2, deletions: 1, preview: "first change" },
      { index: 1, header: "@@ -20,3 +21,3 @@", additions: 1, deletions: 1, preview: "second change" },
    ],
    // A failed read has no hunks and a reason instead, which a test sets.
    error: undefined as string | undefined,
    // Widened on purpose: a test sets a failed read, which has no hunks and a reason.
  } as { success: boolean; hunks?: HunkFixture[]; error?: string },
  applyHunk: { success: true, message: "Staged hunk 1 of 2." },
  commit: { success: true, message: "committed" },
}));

vi.mock("../../services/gitClient", () => ({
  gitFetch: async (path: string, init?: RequestInit) => {
    const action = path.replace("/api/git/", "");
    engine.calls.push(action);
    if (init?.body) {
      engine.payloads.push({ action, body: JSON.parse(String(init.body)) });
    }
    const body =
      action === "status"
        ? { ...engine.status, ...(engine.overrides.status ?? {}) }
        : action === "diff-file"
          ? engine.diff
          : action === "commit-info"
            ? engine.commitInfo
            : action === "commit-file"
              ? engine.commitFile
              : action === "diff-since"
                ? engine.sinceDiff
                : action === "hunks"
                  ? engine.hunks
                  : action === "apply-hunk"
                    ? engine.applyHunk
                : action === "commit"
                    ? engine.commit
                    : action === "log"
                      ? { success: true, commits: [], refs: [], head: "", ...(engine.overrides.log ?? {}) }
                      : { success: true, output: `${action} ok` };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
}));

// The real one mounts Monaco; what this page hands it is the test's subject.
vi.mock("../editor/MonacoDiffContainer", () => ({
  MonacoDiffContainer: ({ filePath, originalContent, modifiedContent }: any) => (
    <div data-testid="diff-surface">
      <div data-testid="diff-path">{filePath}</div>
      <div data-testid="diff-sides">{`${originalContent} → ${modifiedContent}`}</div>
    </div>
  ),
}));

const { GitDashboard } = await import("./GitDashboard");

beforeEach(() => {
  engine.calls = [];
  engine.payloads = [];
  engine.overrides = {};
});
afterEach(cleanup);

describe("the source control page", () => {
  it("shows the branch, its divergence, and both groups of changes", async () => {
    render(<GitDashboard projectCwd="/work/acsa-code" />);
    await waitFor(() => expect(screen.getByText("dev")).toBeTruthy());
    expect(screen.getByTitle("2 ahead of the remote")).toBeTruthy();
    expect(screen.getByTitle("1 behind the remote")).toBeTruthy();
    expect(screen.getByText("Staged changes · 1")).toBeTruthy();
    expect(screen.getByText("Changes · 2")).toBeTruthy();
  });

  it("previews the diff of the file that was chosen", async () => {
    render(<GitDashboard projectCwd="/work/acsa-code" />);
    await waitFor(() => expect(screen.getByText("Changes · 2")).toBeTruthy());

    fireEvent.click(screen.getByTestId("git-file-src/b.ts"));

    await waitFor(() => expect(screen.getByTestId("diff-path").textContent).toBe("src/b.ts"));
    expect(screen.getByTestId("diff-sides").textContent).toBe("before → after");
    // And it asked the engine for the working-tree side, not the staged one.
    expect(engine.calls).toContain("diff-file");
  });

  it("will not commit with nothing staged, or with no message", async () => {
    render(<GitDashboard projectCwd="/work/acsa-code" />);
    await waitFor(() => expect(screen.getByTestId("git-commit")).toBeTruthy());
    // One file is staged, so the message is the only thing missing.
    const commit = screen.getByTestId("git-commit");
    expect(commit.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByTestId("git-commit-message"), {
      target: { value: "fix: the thing" },
    });
    expect(commit.hasAttribute("disabled")).toBe(false);
  });

  it("commits, then clears the box and the preview", async () => {
    render(<GitDashboard projectCwd="/work/acsa-code" />);
    await waitFor(() => expect(screen.getByText("Staged changes · 1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("git-file-src/a.ts"));
    await waitFor(() => expect(screen.getByTestId("diff-path")).toBeTruthy());

    fireEvent.change(screen.getByTestId("git-commit-message"), { target: { value: "feat: it" } });
    fireEvent.click(screen.getByTestId("git-commit"));

    await waitFor(() => expect(engine.calls).toContain("commit"));
    await waitFor(() =>
      expect((screen.getByTestId("git-commit-message") as HTMLTextAreaElement).value).toBe("")
    );
    expect(screen.queryByTestId("diff-path")).toBeNull();
  });

  it("asks before discarding, and says what will be lost", async () => {
    render(<GitDashboard projectCwd="/work/acsa-code" />);
    await waitFor(() => expect(screen.getByText("Changes · 2")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Discard changes in b.ts"));
    expect(await screen.findByText("Discard changes?")).toBeTruthy();
    expect(screen.getByText(/throws away the working-tree changes in b\.ts/)).toBeTruthy();

    // Cancelling must not touch the engine.
    engine.calls = [];
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByText("Discard changes?")).toBeNull());
    expect(engine.calls).not.toContain("discard");
  });

  it("says so when the folder is not a repository", async () => {
    engine.status = { ...engine.status, isGit: false };
    render(<GitDashboard projectCwd="/tmp/not-a-repo" />);
    expect(await screen.findByText(/not a git repository/)).toBeTruthy();
    engine.status = { ...engine.status, isGit: true };
  });

  it("puts a conflict in its own group, names the operation, and refuses to commit", async () => {
    engine.overrides.status = {
      staged: [],
      unstaged: [],
      conflicted: [
        { path: "f.txt", fromPath: "", indexStatus: "U", workTreeStatus: "U", isStaged: false },
      ],
      operation: "merge",
    };
    render(<GitDashboard projectCwd="/work/acsa-code" />);

    expect(await screen.findByText("Merge conflicts · 1")).toBeTruthy();
    expect(screen.getByTestId("git-operation").textContent).toContain("Merging");
    expect(screen.getByTestId("git-operation").textContent).toContain("1 file still has conflicts");

    // Even with a message typed, git would refuse: the button must not offer it.
    fireEvent.change(screen.getByTestId("git-commit-message"), { target: { value: "wip" } });
    expect(screen.getByTestId("git-commit").hasAttribute("disabled")).toBe(true);
    // A conflicted file is changed work, so the page does not claim to be clean.
    expect(screen.getByText("1 changed")).toBeTruthy();
  });

  it("marks every conflict resolved through one action", async () => {
    engine.overrides.status = {
      conflicted: [
        { path: "f.txt", fromPath: "", indexStatus: "U", workTreeStatus: "U", isStaged: false },
      ],
      operation: "merge",
    };
    render(<GitDashboard projectCwd="/work/acsa-code" />);
    await waitFor(() => expect(screen.getByText("Merge conflicts · 1")).toBeTruthy());

    fireEvent.click(screen.getByTitle("Mark resolved all"));
    await waitFor(() => expect(engine.calls).toContain("resolve-all"));
  });

  it("shows where a renamed file came from, and asks about both names", async () => {
    engine.overrides.status = {
      unstaged: [
        { path: "src/new.ts", fromPath: "src/old.ts", indexStatus: " ", workTreeStatus: "R", isStaged: false },
      ],
    };
    render(<GitDashboard projectCwd="/work/acsa-code" />);

    fireEvent.click(await screen.findByTestId("git-file-src/new.ts"));
    await waitFor(() => expect(screen.getByTestId("diff-path").textContent).toBe("src/new.ts"));
    // The old name is on the row — the new one cannot answer "what was this".
    expect(screen.getByText("← old.ts")).toBeTruthy();
    // And the engine is told both, or the original side is empty.
    const request = engine.payloads.filter((call) => call.action === "diff-file").at(-1);
    expect(request?.body.fromPath).toBe("src/old.ts");
    expect(request?.body.filePath).toBe("src/new.ts");
  });

  it("re-reads when the workspace revision moves under it", async () => {
    const { rerender } = render(
      <GitDashboard projectCwd="/work/acsa-code" workspaceRevision={1} />
    );
    await waitFor(() => expect(screen.getByText("Staged changes · 1")).toBeTruthy());

    engine.calls = [];
    // What a checkout from the titlebar, or an agent's writes, look like from here.
    rerender(<GitDashboard projectCwd="/work/acsa-code" workspaceRevision={2} />);
    await waitFor(() => expect(engine.calls).toContain("status"));
    expect(engine.calls).toContain("log");
  });

  it("re-reads the diff of the file it is showing when the tree is re-read", async () => {
    render(<GitDashboard projectCwd="/work/acsa-code" />);
    fireEvent.click(await screen.findByTestId("git-file-src/b.ts"));
    await waitFor(() => expect(screen.getByTestId("diff-sides").textContent).toBe("before → after"));

    // The file changed under the page — an agent wrote to it, or an editor outside
    // the app — and the diff on screen no longer matches it.
    engine.diff = { success: true, originalContent: "before", modifiedContent: "after, again" };
    fireEvent.click(screen.getByLabelText("Refresh"));

    await waitFor(() =>
      expect(screen.getByTestId("diff-sides").textContent).toBe("before → after, again")
    );
    // Same file, so the pane stays where it was.
    expect(screen.getByTestId("diff-path").textContent).toBe("src/b.ts");
  });

  it("drops the diff of a file that is no longer changed", async () => {
    render(<GitDashboard projectCwd="/work/acsa-code" />);
    fireEvent.click(await screen.findByTestId("git-file-src/b.ts"));
    await waitFor(() => expect(screen.getByTestId("diff-path")).toBeTruthy());

    // Committed from under it: the file is in neither group any more.
    engine.overrides.status = { staged: [], unstaged: [], conflicted: [] };
    fireEvent.click(screen.getByLabelText("Refresh"));

    await waitFor(() => expect(screen.queryByTestId("diff-path")).toBeNull());
    // And nothing is claimed to be selected, so the page offers the landing view.
    expect(screen.getByText(/Pick a file on the left/)).toBeTruthy();
  });

  it("follows the file when it moves between the groups", async () => {
    engine.overrides.status = {
      unstaged: [{ path: "src/b.ts", indexStatus: " ", workTreeStatus: "M", isStaged: false }],
    };
    render(<GitDashboard projectCwd="/work/acsa-code" />);
    fireEvent.click(await screen.findByTestId("git-file-src/b.ts"));
    await waitFor(() => expect(screen.getByTestId("diff-path")).toBeTruthy());

    // Something staged it: the same change is now the staged side.
    engine.overrides.status = {
      staged: [{ path: "src/b.ts", indexStatus: "M", workTreeStatus: " ", isStaged: true }],
      unstaged: [],
    };
    fireEvent.click(screen.getByLabelText("Refresh"));

    await waitFor(() => {
      const ask = engine.payloads.filter((p) => p.action === "diff-file").at(-1);
      expect(ask?.body.staged).toBe(true);
    });
    expect(screen.getByTestId("diff-path").textContent).toBe("src/b.ts");
  });

  it("offers more history when the window comes back full", async () => {
    // Exactly as many commits as one read asks for: the window is full, so there
    // may be older ones behind it.
    const many = Array.from({ length: 60 }, (_, index) => ({
      sha: `${index}`.padStart(40, "a"),
      short: `c${index}`,
      parents: [],
      author: "Ada",
      date: new Date().toISOString(),
      subject: `commit ${index}`,
    }));
    engine.overrides.log = { commits: many, refs: [], head: many[0].sha };
    render(<GitDashboard projectCwd="/work/acsa-code" />);

    const more = await screen.findByTestId("git-graph-load-more");
    engine.payloads = [];
    fireEvent.click(more);
    // The next read asks for a bigger window, rather than re-reading the same one.
    await waitFor(() => {
      const ask = engine.payloads.filter((call) => call.action === "log").at(-1);
      expect(ask?.body.limit).toBe(120);
    });
  });

  it("hides it when the history is shorter than the window", async () => {
    engine.overrides.log = {
      commits: [
        {
          sha: "a".repeat(40),
          short: "aaaaaaa",
          parents: [],
          author: "Ada",
          date: new Date().toISOString(),
          subject: "the only commit",
        },
      ],
      refs: [],
      head: "a".repeat(40),
    };
    render(<GitDashboard projectCwd="/work/acsa-code" />);
    await screen.findByText("the only commit");
    expect(screen.queryByTestId("git-graph-load-more")).toBeNull();
  });

  it("compares an open commit against the file on disk when asked", async () => {
    engine.overrides.log = {
      commits: [
        {
          sha: "c".repeat(40),
          short: "ccccccc",
          parents: [],
          author: "Ada",
          date: new Date().toISOString(),
          subject: "a commit",
        },
      ],
      refs: [],
      head: "c".repeat(40),
    };
    render(<GitDashboard projectCwd="/work/acsa-code" />);

    fireEvent.click(await screen.findByTestId("git-graph-row-ccccccc"));
    // Opening a commit shows its own change: parent against commit.
    await waitFor(() => expect(screen.getByTestId("diff-sides").textContent).toBe("parent → in the commit"));
    expect(screen.getByText("ccccccc — parent vs commit")).toBeTruthy();

    fireEvent.click(screen.getByTestId("git-compare-scope"));

    // Now it is that commit against the working tree, and the engine was asked for
    // exactly that rather than for the commit's own change again.
    await waitFor(() => expect(screen.getByTestId("diff-sides").textContent).toBe("in the commit → on disk"));
    expect(screen.getByText("ccccccc — commit vs working tree")).toBeTruthy();
    const ask = engine.payloads.filter((call) => call.action === "diff-since").at(-1);
    expect(ask?.body.ref).toBe("c".repeat(40));
    expect(ask?.body.filePath).toBe("src/a.ts");

    // And back again.
    fireEvent.click(screen.getByTestId("git-compare-scope"));
    await waitFor(() => expect(screen.getByTestId("diff-sides").textContent).toBe("parent → in the commit"));
  });

  it("says when nothing has changed since the commit instead of drawing an empty diff", async () => {
    engine.overrides.log = {
      commits: [
        {
          sha: "c".repeat(40),
          short: "ccccccc",
          parents: [],
          author: "Ada",
          date: new Date().toISOString(),
          subject: "a commit",
        },
      ],
      refs: [],
      head: "c".repeat(40),
    };
    engine.sinceDiff = { success: true, originalContent: "same", modifiedContent: "same" };
    render(<GitDashboard projectCwd="/work/acsa-code" />);

    fireEvent.click(await screen.findByTestId("git-graph-row-ccccccc"));
    await screen.findByTestId("diff-sides");
    fireEvent.click(screen.getByTestId("git-compare-scope"));

    expect(await screen.findByText("No changes since this commit")).toBeTruthy();
    expect(screen.getByText(/matches the commit/)).toBeTruthy();
  });

  it("stages one hunk of a file, through the same path as every other action", async () => {
    render(<GitDashboard projectCwd="/work/acsa-code" />);
    fireEvent.click(await screen.findByTestId("git-file-src/b.ts"));

    // The strip names how many hunks there are, and the diff itself is untouched.
    const toggle = await screen.findByTestId("git-hunks-toggle");
    expect(toggle.textContent).toContain("2 hunks");
    expect(screen.queryByTestId("git-hunks")).toBeNull();

    fireEvent.click(toggle);
    // Collapsed by default: the diff is the point, the hunks are a tool beside it.
    expect(screen.getByTestId("git-hunks").children.length).toBe(2);
    // Both are described well enough to choose between them.
    expect(screen.getByText("@@ -1,4 +1,5 @@")).toBeTruthy();
    expect(screen.getByText("second change")).toBeTruthy();

    engine.payloads = [];
    fireEvent.click(screen.getByTestId("git-hunk-1"));
    await waitFor(() => {
      const ask = engine.payloads.filter((call) => call.action === "apply-hunk").at(-1);
      // The second hunk of this file, and the group it is in — not the file as a whole.
      expect(ask?.body).toMatchObject({ filePath: "src/b.ts", hunk: 1, staged: false });
    });
    // The engine's own words are what the page reports.
    expect(await screen.findByText("Staged hunk 1 of 2.")).toBeTruthy();
  });

  it("offers no hunks for a file that has none", async () => {
    // An untracked file, or a binary one: there is nothing to split.
    engine.hunks = { success: true, hunks: [] };
    render(<GitDashboard projectCwd="/work/acsa-code" />);
    fireEvent.click(await screen.findByTestId("git-file-src/b.ts"));
    await screen.findByTestId("diff-surface");
    expect(screen.queryByTestId("git-hunks-toggle")).toBeNull();
  });

  it("says when the hunks could not be read", async () => {
    engine.hunks = { success: false, error: "fatal: bad revision" };
    render(<GitDashboard projectCwd="/work/acsa-code" />);
    fireEvent.click(await screen.findByTestId("git-file-src/b.ts"));
    expect(await screen.findByTestId("git-hunks-error")).toBeTruthy();
    expect(screen.getByText("fatal: bad revision")).toBeTruthy();
  });
});
