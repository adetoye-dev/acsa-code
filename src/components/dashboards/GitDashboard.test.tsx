// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/** What the fake engine answers, and what it was asked. */
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
          : action === "commit"
            ? engine.commit
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
});
