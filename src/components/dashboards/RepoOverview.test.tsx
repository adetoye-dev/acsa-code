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
  render(<RepoOverview data={data} isLoading={isLoading} checkedAt={Date.now()} onRefresh={() => {}} />);

afterEach(() => {
  cleanup();
  opened.urls = [];
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
});
