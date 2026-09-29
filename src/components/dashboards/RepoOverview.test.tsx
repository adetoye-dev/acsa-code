// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  sha: "913d48b1473857d8f3e09176479d1417b3ad9562",
  url: "https://github.com/adetoye-dev/acsa-code/actions/runs/36207865178",
};

const FAILED_RUN = {
  ...RUN,
  id: 36207824813,
  title: "Add agent controls, project snapshots, and workbench UI updates",
  workflow: "CI",
  conclusion: "failure",
  branch: "dev",
  durationSeconds: 523,
  url: "https://github.com/adetoye-dev/acsa-code/actions/runs/36207824813",
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
  url: "https://github.com/adetoye-dev/acsa-code/pull/3",
  additions: 11582,
  deletions: 2735,
  changedFiles: 97,
};

/** A run as a history bar needs it: its own id, result, length and time. */
const bar = (id: number, conclusion: string, seconds: number, at: string) => ({
  ...RUN,
  id,
  conclusion,
  durationSeconds: seconds,
  createdAt: at,
  updatedAt: at,
  url: `https://github.com/adetoye-dev/acsa-code/actions/runs/${id}`,
});

/** Four runs on dev, three of which passed, oldest first for the bars. */
const HISTORY = [
  bar(9001, "success", 300, "2026-09-25T10:00:00Z"),
  bar(9002, "failure", 600, "2026-09-25T12:00:00Z"),
  bar(9003, "success", 420, "2026-09-25T14:00:00Z"),
  bar(9004, "success", 408, "2026-09-25T16:00:00Z"),
];

const SUMMARY = {
  branch: "dev",
  total: 4,
  passed: 3,
  failed: 1,
  other: 0,
  passRate: 0.75,
  averageDurationSeconds: 432,
  latest: RUN,
  history: HISTORY,
};

const available = (over: Partial<GhOverview> = {}): GhOverview => ({
  success: true,
  available: true,
  reason: null,
  detail: "",
  raw: "",
  repo: "adetoye-dev/acsa-code",
  runs: [RUN],
  summary: SUMMARY,
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
    expect(screen.getByText("adetoye-dev/acsa-code")).toBeTruthy();
    // Scoped to the row: the status card above it shows the same run's length, and
    // an unscoped query would be ambiguous rather than wrong.
    const row = within(screen.getByTestId("gh-run-36207865178"));
    expect(row.getByText("release: 0.2.17")).toBeTruthy();
    expect(row.getByText("Release · v0.2.17 · success")).toBeTruthy();
    // 487 seconds is the 8m07s `gh run list` prints for this run.
    expect(row.getByText("8m 7s")).toBeTruthy();
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
            url: "https://github.com/adetoye-dev/acsa-code/issues/12",
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

  it("shows the branch's CI as a status card, with the columns and the aggregates", async () => {
    renderPanel(available());
    // Everything inside the card, so the list row below it (same run, same
    // duration) cannot make a query ambiguous.
    const card = within(await screen.findByTestId("gh-run-stats"));

    // What the last run did, and which branch this is about.
    expect(card.getByText(/Successful/)).toBeTruthy();
    expect(card.getByText(/CI on dev/)).toBeTruthy();
    // The columns the status widget is read for.
    for (const label of ["Latest", "Duration", "Trigger", "Commit"]) {
      expect(card.getByText(label)).toBeTruthy();
    }
    expect(card.getByText("push")).toBeTruthy();
    expect(card.getByText("8m 7s")).toBeTruthy();
    expect(card.getByText("913d48b")).toBeTruthy();
    // And the aggregates no list of runs shows.
    expect(card.getByText("4 runs")).toBeTruthy();
    expect(card.getByText("7m 12s")).toBeTruthy();
    expect(card.getByText("75%")).toBeTruthy();
    expect(card.getByText("25%")).toBeTruthy();
    expect(screen.getByTestId("gh-history-bars").children.length).toBe(4);
  });

  it("opens the run a history bar stands for, and the commit besides it", async () => {
    renderPanel(available());
    await screen.findByTestId("gh-history-bars");
    const bars = screen.getByTestId("gh-history-bars").children;
    fireEvent.click(bars[bars.length - 1]);
    expect(opened.urls.at(-1)).toBe(HISTORY[HISTORY.length - 1].url);

    fireEvent.click(screen.getByText("913d48b"));
    expect(opened.urls.at(-1)).toBe(
      "https://github.com/adetoye-dev/acsa-code/commit/913d48b1473857d8f3e09176479d1417b3ad9562"
    );
  });

  it("says when a branch has had no runs, instead of a card of dashes", async () => {
    renderPanel(
      available({
        summary: { ...SUMMARY, branch: "release", total: 0, latest: null, history: [] },
      })
    );
    expect(await screen.findByText(/No workflow runs on release yet/)).toBeTruthy();
    expect(screen.queryByTestId("gh-run-stats")).toBeNull();
  });

  it("says which part of the summary it could not read", async () => {
    renderPanel(available({ errors: { summary: "HTTP 500: Internal Server Error" } }));
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    // No columns to read, because there is nothing to put in them.
    expect(screen.queryByTestId("gh-run-stats")).toBeNull();
  });

  it("leaves the rate as a dash when nothing finished either way", async () => {
    renderPanel(
      available({
        summary: { ...SUMMARY, passRate: null, averageDurationSeconds: null },
      })
    );
    await screen.findByTestId("gh-run-stats");
    // The average has no answer either, and neither is rendered as a zero.
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
