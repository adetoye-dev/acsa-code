// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GhOverview } from "../../services/ghClient";

const opened = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("../../services/openExternal", () => ({
  openExternal: async (url: string) => {
    opened.urls.push(url);
    return true;
  },
}));

/** What the run-log call answers, and what it was asked for. */
const logMock = vi.hoisted(() => ({
  runIds: [] as number[],
  result: {
    success: true,
    available: true,
    reason: null as string | null,
    detail: "",
    raw: "",
    lines: [
      "npm test",
      "AssertionError: expected 1 to be 2",
      "##[error]Process completed with exit code 1.",
    ],
    dropped: 1814,
    jobs: ["Verify (typecheck, tests, build)"],
    steps: ["Rust shell compiles"],
  },
}));
vi.mock("../../services/ghClient", () => ({
  ghRunLog: async (_cwd: string, runId: number) => {
    logMock.runIds.push(runId);
    return logMock.result;
  },
}));

const { RepoOverview } = await import("./RepoOverview");

const RUN = {
  id: 36207865178,
  title: "release: 0.2.17",
  workflow: "Release",
  status: "completed",
  conclusion: "success",
  branch: "v0.2.17",
  event: "push",
  createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  updatedAt: new Date(Date.now() - 3 * 3600_000 + 487_000).toISOString(),
  durationSeconds: 487,
  url: "https://github.com/adetoye-dev/asca-code/actions/runs/36207865178",
};

const FAILED_RUN = {
  ...RUN,
  id: 36207824813,
  title: "Add agent controls, project snapshots, and workbench UI updates",
  workflow: "CI",
  conclusion: "failure",
  branch: "dev",
  durationSeconds: 523,
  url: "https://github.com/adetoye-dev/asca-code/actions/runs/36207824813",
};

const PR = {
  number: 3,
  title: "Add agent controls, project snapshots, and workbench UI updates",
  author: "adetoye-dev",
  isDraft: false,
  reviewDecision: "CHANGES_REQUESTED",
  branch: "dev",
  createdAt: "2026-09-24T18:04:42Z",
  updatedAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
  url: "https://github.com/adetoye-dev/asca-code/pull/3",
  additions: 11582,
  deletions: 2735,
  changedFiles: 97,
};

const available = (over: Partial<GhOverview> = {}): GhOverview => ({
  success: true,
  available: true,
  reason: null,
  detail: "",
  raw: "",
  repo: "adetoye-dev/asca-code",
  runs: [RUN],
  pullRequests: [PR],
  issues: [],
  errors: {},
  ...over,
});

const unavailable = (reason: string, detail: string, over: Partial<GhOverview> = {}): GhOverview => ({
  ...available(),
  available: false,
  reason,
  detail,
  runs: [],
  pullRequests: [],
  ...over,
});

const renderPanel = (data: GhOverview | null, isLoading = false) =>
  render(
    <RepoOverview
      projectCwd="/work/acsa-code"
      data={data}
      isLoading={isLoading}
      checkedAt={Date.now()}
      onRefresh={() => {}}
    />
  );

afterEach(() => {
  cleanup();
  opened.urls = [];
  logMock.runIds = [];
  logMock.result = { ...logMock.result, available: true, reason: null, dropped: 1814, lines: [
    "npm test",
    "AssertionError: expected 1 to be 2",
    "##[error]Process completed with exit code 1.",
  ] };
});

describe("the repository landing panel", () => {
  it("says it is reading rather than showing an empty repository", () => {
    renderPanel(null, true);
    expect(screen.getByText(/Reading GitHub/)).toBeTruthy();
  });

  it("names the repository and each run's outcome, workflow, branch and length", () => {
    renderPanel(available());
    expect(screen.getByText("adetoye-dev/asca-code")).toBeTruthy();
    expect(screen.getByText("release: 0.2.17")).toBeTruthy();
    expect(screen.getByText("Release · v0.2.17 · success")).toBeTruthy();
    // 487 seconds is the 8m07s `gh run list` prints for this run.
    expect(screen.getByText("8m 7s")).toBeTruthy();
    expect(screen.getByText("#3")).toBeTruthy();
    expect(screen.getByText(/@adetoye-dev/)).toBeTruthy();
    expect(screen.getByText("CHANGES")).toBeTruthy();
  });

  it("opens the run and the pull request it names", () => {
    renderPanel(available());
    fireEvent.click(screen.getByTestId("gh-run-36207865178"));
    expect(opened.urls).toEqual([RUN.url]);
    fireEvent.click(screen.getByTestId("gh-pr-3"));
    expect(opened.urls[1]).toBe(PR.url);
  });

  it("explains a missing GitHub CLI, and offers the install", () => {
    renderPanel(unavailable("not-installed", "The GitHub CLI (gh) is not installed, so checks and pull requests cannot be read."));
    expect(screen.getByText(/is not installed/)).toBeTruthy();
    // The command is the action, so it is shown rather than described.
    fireEvent.click(screen.getByTitle("Copy to clipboard"));
    fireEvent.click(screen.getByText("Install the GitHub CLI"));
    expect(opened.urls).toEqual(["https://cli.github.com"]);
  });

  it("tells a signed-out user the one command that fixes it", () => {
    renderPanel(unavailable("not-authenticated", "The GitHub CLI is not signed in, so checks and pull requests cannot be read."));
    expect(screen.getByText(/not signed in/)).toBeTruthy();
    expect(screen.getByText("gh auth login")).toBeTruthy();
  });

  it("never renders an unreadable section as an empty one", () => {
    renderPanel(
      available({ pullRequests: [], errors: { pullRequests: "HTTP 403: Resource not accessible" } })
    );
    expect(screen.getByText(/could not be read/)).toBeTruthy();
    expect(screen.queryByText("No open pull requests.")).toBeNull();
    // The checks above it are still true, so they are still on screen.
    expect(screen.getByText("release: 0.2.17")).toBeTruthy();
  });

  it("says 'none' only when the list really is empty and was read", () => {
    renderPanel(available({ pullRequests: [] }));
    expect(screen.getByText("No open pull requests.")).toBeTruthy();
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });

  it("hides the issues card until there is something on your plate", () => {
    renderPanel(available());
    expect(screen.queryByText("Assigned to you")).toBeNull();
    renderPanel(
      available({
        issues: [
          {
            number: 12,
            title: "Crash when opening a project",
            author: "ada",
            labels: [{ name: "bug", color: "#d73a4a" }],
            updatedAt: new Date().toISOString(),
            url: "https://github.com/adetoye-dev/asca-code/issues/12",
          },
        ],
      })
    );
    expect(screen.getAllByText("Assigned to you").length).toBeGreaterThan(0);
    expect(screen.getByText("Crash when opening a project")).toBeTruthy();
    expect(screen.getByText("bug")).toBeTruthy();
  });

  it("reads why a failed run is red, and says when it is only a tail", async () => {
    renderPanel(available({ runs: [RUN, FAILED_RUN] }));
    fireEvent.click(await screen.findByTestId("gh-why-36207824813"));

    const body = await screen.findByTestId("gh-log-lines");
    expect(body.textContent).toContain("AssertionError: expected 1 to be 2");
    // The header names the job and step, so the tail is not anonymous.
    expect(screen.getByText(/Verify \(typecheck, tests, build\) · Rust shell compiles/)).toBeTruthy();
    // And the reader is told they are not seeing the whole log.
    expect(screen.getByText(/Last 3 of 1817 lines/)).toBeTruthy();
    expect(logMock.runIds).toEqual([36207824813]);
  });

  it("closes the log again, and offers nothing for a run that passed", async () => {
    renderPanel(available({ runs: [RUN, FAILED_RUN] }));
    // The passing run has no failed step for a log to explain.
    expect(screen.queryByTestId("gh-why-36207865178")).toBeNull();

    fireEvent.click(await screen.findByTestId("gh-why-36207824813"));
    await screen.findByTestId("gh-log-lines");
    // Clicking it again is a toggle, not a second fetch.
    fireEvent.click(screen.getByTestId("gh-why-36207824813"));
    expect(screen.queryByTestId("gh-log-lines")).toBeNull();
    expect(logMock.runIds.length).toBe(1);
  });

  it("says when a run has no failed log instead of showing an empty one", async () => {
    logMock.result = {
      ...logMock.result,
      available: false,
      reason: "no-log",
      detail:
        "This run has no failed-step log — it may have been cancelled, or the log may have expired (GitHub keeps them for 90 days).",
      lines: [],
      dropped: 0,
    };
    renderPanel(available({ runs: [FAILED_RUN] }));
    fireEvent.click(await screen.findByTestId("gh-why-36207824813"));

    expect(await screen.findByTestId("gh-log-message")).toBeTruthy();
    expect(screen.getByText(/no failed-step log/)).toBeTruthy();
    expect(screen.queryByTestId("gh-log-lines")).toBeNull();
  });
});
