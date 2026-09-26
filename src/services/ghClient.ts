/**
 * ghClient.ts — what the remote knows, through the engine's `gh` subcommand.
 *
 * The engine shells out to the GitHub CLI the user already signed into, so there
 * is no token of ours to store and no second login to perform. This is only the
 * transport for it, and it never throws: a page that cannot reach GitHub has to
 * render a sentence, not an exception, so every failure comes back as a state the
 * panel can name (see `reason`).
 */
import { DESKTOP_REQUIRED_MESSAGE, engineCall, hasIpc } from "./engineBridge";

/** One workflow run, as `gh run list` describes it. */
export interface GhRun {
  id: number | null;
  title: string;
  workflow: string;
  status: string;
  conclusion: string;
  branch: string;
  event: string;
  createdAt: string;
  updatedAt: string;
  /** Null while a run is still going: an unknown length is not a short one. */
  durationSeconds: number | null;
  url: string;
}

export interface GhPullRequest {
  number: number | null;
  title: string;
  author: string;
  isDraft: boolean;
  /** `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or empty for none. */
  reviewDecision: string;
  branch: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}

export interface GhIssueLabel {
  name: string;
  /** A CSS colour the engine has already prefixed with `#`. */
  color: string;
}

export interface GhIssue {
  number: number | null;
  title: string;
  author: string;
  labels: GhIssueLabel[];
  updatedAt: string;
  url: string;
}

/**
 * The remote's state, or the reason it could not be read.
 *
 * `available: false` is not an error: it is a normal state with a `reason` the
 * panel turns into a sentence — `not-installed`, `not-github`, `not-authenticated`,
 * `offline`, `failed`. `errors` carries a per-section failure so one unreadable
 * list does not blank the others.
 */
export interface GhOverview {
  success: boolean;
  available: boolean;
  reason: string | null;
  detail: string;
  raw: string;
  repo: string;
  runs: GhRun[];
  pullRequests: GhPullRequest[];
  issues: GhIssue[];
  errors: Record<string, string>;
}

/**
 * The tail of a run's failed steps: why it is red.
 *
 * `dropped` is how many lines the tail left behind, and it is shown — a log that
 * quietly starts mid-way reads as the whole story. `reason` is `no-log` when
 * nothing failed in that run (`--log-failed` prints nothing for a cancelled run or
 * an expired log), which is a fact about the run rather than an error.
 */
export interface GhRunLog {
  success: boolean;
  available: boolean;
  reason: string | null;
  detail: string;
  raw: string;
  lines: string[];
  dropped: number;
  jobs: string[];
  steps: string[];
}

const EMPTY: Omit<GhOverview, "reason" | "detail"> = {
  success: false,
  available: false,
  raw: "",
  repo: "",
  runs: [],
  pullRequests: [],
  issues: [],
  errors: {},
};

export async function ghOverview(cwd: string, limit = 5): Promise<GhOverview> {
  if (!hasIpc()) {
    return { ...EMPTY, reason: "desktop-required", detail: DESKTOP_REQUIRED_MESSAGE };
  }
  try {
    return await engineCall<GhOverview>("gh", ["overview", JSON.stringify({ cwd, limit })]);
  } catch (error) {
    return {
      ...EMPTY,
      reason: "failed",
      detail: "The GitHub CLI could not be run.",
      raw: String((error as Error)?.message ?? error),
    };
  }
}

export async function ghRunLog(cwd: string, runId: number, tail = 120): Promise<GhRunLog> {
  if (!hasIpc()) {
    return {
      success: false,
      available: false,
      reason: "desktop-required",
      detail: DESKTOP_REQUIRED_MESSAGE,
      raw: "",
      lines: [],
      dropped: 0,
      jobs: [],
      steps: [],
    };
  }
  try {
    return await engineCall<GhRunLog>("gh", [
      "run-log",
      JSON.stringify({ cwd, runId, tail }),
    ]);
  } catch (error) {
    return {
      success: false,
      available: false,
      reason: "failed",
      detail: "The GitHub CLI could not be run.",
      raw: String((error as Error)?.message ?? error),
      lines: [],
      dropped: 0,
      jobs: [],
      steps: [],
    };
  }
}
