"""Unit tests for the GitHub half of the repository page.

Every fixture here is a real `gh --json` payload, copied from what the CLI printed
against this repository and one public one, rather than a shape invented from the
docs. The parsers exist to match that output exactly, so a fixture that drifts
from it would test nothing.

The states — no gh, no GitHub remote, signed out — are driven by patching, because
they are the ones a developer's own machine cannot reproduce on demand and the
ones that decide whether the panel tells the truth.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core-engine"))

import gh_cli  # noqa: E402

# `gh run list -L 2 --json …` against adetoye-dev/asca-code.
REAL_RUNS = [
    {
        "conclusion": "success",
        "createdAt": "2026-09-26T01:16:26Z",
        "databaseId": 36207865178,
        "displayTitle": "release: 0.2.17",
        "event": "push",
        "headBranch": "v0.2.17",
        "headSha": "913d48b1473857d8f3e09176479d1417b3ad9562",
        "status": "completed",
        "updatedAt": "2026-09-26T01:24:33Z",
        "url": "https://github.com/adetoye-dev/asca-code/actions/runs/36207865178",
        "workflowName": "Release",
    },
    {
        "conclusion": "success",
        "createdAt": "2026-09-26T01:15:43Z",
        "databaseId": 36207824813,
        "displayTitle": "Add agent controls, project snapshots, and workbench UI updates",
        "event": "pull_request",
        "headBranch": "dev",
        "headSha": "913d48b1473857d8f3e09176479d1417b3ad9562",
        "status": "completed",
        "updatedAt": "2026-09-26T01:24:26Z",
        "url": "https://github.com/adetoye-dev/asca-code/actions/runs/36207824813",
        "workflowName": "CI",
    },
]

# `gh pr list -L 1 --json …` against the same repository.
REAL_PULL_REQUESTS = [
    {
        "additions": 11582,
        "author": {"id": "MDQ6VXNlcjcxMzgyMzAx", "is_bot": False, "login": "adetoye-dev", "name": "Adetoye Adewoye"},
        "changedFiles": 97,
        "createdAt": "2026-09-24T18:04:42Z",
        "deletions": 2735,
        "headRefName": "dev",
        "isDraft": False,
        "number": 3,
        "reviewDecision": "",
        "title": "Add agent controls, project snapshots, and workbench UI updates",
        "updatedAt": "2026-09-26T01:15:51Z",
        "url": "https://github.com/adetoye-dev/asca-code/pull/3",
    }
]

# `gh issue list -R cli/cli -L 1 --json …` — a real issue with real labels.
REAL_ISSUES = [
    {
        "author": {"id": "MDQ6VXNlcjQ3Mzk0MjAw", "is_bot": False, "login": "BagToad", "name": "Kynan Ware"},
        "labels": [
            {"id": "MDU6TGFiZWwxNjk4MDc2MTcz", "name": "enhancement", "description": "a request to improve CLI", "color": "0dd8ac"},
            {"id": "LA_kwDODKw3uc8AAAABZDtRDQ", "name": "gh-issue", "description": "relating to the gh issue command", "color": "430568"},
        ],
        "number": 14529,
        "title": "gh issue artifact: attach files to issues",
        "updatedAt": "2026-09-25T23:22:31Z",
        "url": "https://github.com/cli/cli/issues/14529",
    }
]


class RemoteSlugTests(unittest.TestCase):
    """The remote is what decides whether any of this is possible at all."""

    def test_https_with_and_without_a_git_suffix(self):
        self.assertEqual(gh_cli.parse_remote_slug("https://github.com/acme/api.git"), "acme/api")
        self.assertEqual(gh_cli.parse_remote_slug("https://github.com/acme/api"), "acme/api")

    def test_scp_like_ssh(self):
        self.assertEqual(gh_cli.parse_remote_slug("git@github.com:acme/api.git"), "acme/api")

    def test_ssh_scheme_with_a_user(self):
        self.assertEqual(gh_cli.parse_remote_slug("ssh://git@github.com/acme/api.git"), "acme/api")

    def test_another_host_is_not_a_github_remote(self):
        # A GitLab or self-hosted remote must not produce github.com links.
        self.assertIsNone(gh_cli.parse_remote_slug("git@gitlab.com:acme/api.git"))
        self.assertIsNone(gh_cli.parse_remote_slug("https://git.example.com/acme/api.git"))

    def test_junk(self):
        self.assertIsNone(gh_cli.parse_remote_slug(""))
        self.assertIsNone(gh_cli.parse_remote_slug("   "))
        self.assertIsNone(gh_cli.parse_remote_slug("/tmp/a-repo"))
        self.assertIsNone(gh_cli.parse_remote_slug("https://github.com/onlyowner"))


class ErrorClassificationTests(unittest.TestCase):
    """The messages are copied from the real CLI, not paraphrased."""

    def test_signed_out(self):
        # Verbatim from `gh run list` with no session (exit code 4).
        message = (
            "To get started with GitHub CLI, please run:  gh auth login\n"
            "Alternatively, populate the GH_TOKEN environment variable with a GitHub API "
            "authentication token."
        )
        self.assertEqual(gh_cli.classify_error(message), "not-authenticated")

    def test_offline(self):
        self.assertEqual(
            gh_cli.classify_error("dial tcp: lookup api.github.com: no such host"), "offline"
        )

    def test_anything_else_is_a_plain_failure(self):
        self.assertEqual(gh_cli.classify_error("HTTP 404: Not Found"), "failed")
        self.assertEqual(gh_cli.classify_error(""), "failed")


class ParseRunTests(unittest.TestCase):
    def test_fields_and_a_real_duration(self):
        runs = gh_cli.parse_runs(REAL_RUNS)
        self.assertEqual(len(runs), 2)
        first = runs[0]
        self.assertEqual(first["workflow"], "Release")
        self.assertEqual(first["title"], "release: 0.2.17")
        self.assertEqual(first["conclusion"], "success")
        self.assertEqual(first["branch"], "v0.2.17")
        self.assertEqual(first["id"], 36207865178)
        self.assertTrue(first["url"].endswith("/actions/runs/36207865178"))
        # 01:16:26 → 01:24:33 is 8m07s, which is what `gh run list` prints too.
        self.assertEqual(first["durationSeconds"], 487)

    def test_a_run_still_going_has_no_duration(self):
        running = [{**REAL_RUNS[0], "status": "in_progress", "conclusion": ""}]
        self.assertIsNone(gh_cli.parse_runs(running)[0]["durationSeconds"])

    def test_an_unparseable_timestamp_is_not_zero_seconds(self):
        broken = [{**REAL_RUNS[0], "createdAt": "", "updatedAt": ""}]
        self.assertIsNone(gh_cli.parse_runs(broken)[0]["durationSeconds"])

    def test_junk_entries_are_skipped_rather_than_crashing(self):
        self.assertEqual(gh_cli.parse_runs([None, "nope", 7]), [])
        self.assertEqual(gh_cli.parse_runs([]), [])


class ParsePullRequestTests(unittest.TestCase):
    def test_fields_include_the_author_and_the_size(self):
        prs = gh_cli.parse_pull_requests(REAL_PULL_REQUESTS)
        self.assertEqual(len(prs), 1)
        pr = prs[0]
        self.assertEqual(pr["number"], 3)
        self.assertEqual(pr["author"], "adetoye-dev")
        self.assertEqual(pr["branch"], "dev")
        self.assertEqual(pr["changedFiles"], 97)
        self.assertEqual((pr["additions"], pr["deletions"]), (11582, 2735))
        self.assertFalse(pr["isDraft"])
        # An empty reviewDecision is the normal case, not a missing field.
        self.assertEqual(pr["reviewDecision"], "")

    def test_a_draft_with_changes_requested(self):
        payload = [{**REAL_PULL_REQUESTS[0], "isDraft": True, "reviewDecision": "CHANGES_REQUESTED"}]
        pr = gh_cli.parse_pull_requests(payload)[0]
        self.assertTrue(pr["isDraft"])
        self.assertEqual(pr["reviewDecision"], "CHANGES_REQUESTED")


class ParseIssueTests(unittest.TestCase):
    def test_labels_come_out_as_css_colours(self):
        issues = gh_cli.parse_issues(REAL_ISSUES)
        self.assertEqual(len(issues), 1)
        issue = issues[0]
        self.assertEqual(issue["number"], 14529)
        self.assertEqual(issue["author"], "BagToad")
        self.assertEqual([label["name"] for label in issue["labels"]], ["enhancement", "gh-issue"])
        # gh prints "0dd8ac"; a `#` has to be added once, here.
        self.assertEqual(issue["labels"][0]["color"], "#0dd8ac")


class OverviewStateTests(unittest.TestCase):
    """The states decide what the panel says, so each one is pinned."""

    def _overview(
        self, gh_path="/usr/bin/gh", remote="https://github.com/acme/api.git", run=None, limit=None
    ):
        payload = {"cwd": "."}
        if limit is not None:
            payload["limit"] = limit
        with mock.patch.object(gh_cli, "_gh_path", lambda: gh_path), mock.patch.object(
            gh_cli, "_remote_url", lambda cwd: remote
        ), mock.patch.object(gh_cli, "_run", run or (lambda *a, **k: (True, "[]", ""))):
            return gh_cli.overview(payload)

    def test_no_gh_installed(self):
        result = self._overview(gh_path=None)
        self.assertTrue(result["success"])
        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "not-installed")
        self.assertIn("gh", result["detail"])

    def test_no_github_remote(self):
        result = self._overview(remote="git@gitlab.com:acme/api.git")
        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "not-github")

    def test_signed_out(self):
        real = (
            "To get started with GitHub CLI, please run:  gh auth login\n"
            "Alternatively, populate the GH_TOKEN environment variable with a GitHub API "
            "authentication token."
        )
        result = self._overview(run=lambda *a, **k: (False, "", real))
        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "not-authenticated")
        self.assertIn("not signed in", result["detail"])
        # The raw text is kept, so a bug report can quote what gh actually said.
        self.assertIn("gh auth login", result["raw"])

    def test_a_successful_read_parses_all_three_lists(self):
        def run(args, *rest, **kwargs):
            joined = " ".join(args)
            # The overview asks git which branch it is describing, then gh for the
            # list, the branch's runs, the pull requests and the issues.
            if args[0] == "git":
                return True, "dev\n", ""
            if "run" in args:
                return True, __import__("json").dumps(REAL_RUNS), ""
            if "pr" in args:
                return True, __import__("json").dumps(REAL_PULL_REQUESTS), ""
            if "issue" in args:
                return True, __import__("json").dumps(REAL_ISSUES), ""
            raise AssertionError(f"unexpected call: {joined}")

        result = self._overview(run=run)
        self.assertTrue(result["available"])
        self.assertEqual(result["repo"], "acme/api")
        self.assertEqual(len(result["runs"]), 2)
        self.assertEqual(len(result["pullRequests"]), 1)
        self.assertEqual(len(result["issues"]), 1)
        self.assertEqual(result["errors"], {})

    def test_pull_requests_failing_does_not_take_the_checks_with_it(self):
        def run(args, *rest, **kwargs):
            if args[0] == "git":
                return True, "dev\n", ""
            if "run" in args:
                return True, __import__("json").dumps(REAL_RUNS), ""
            if "pr" in args:
                return False, "", "HTTP 403: Resource not accessible"
            return True, "[]", ""

        result = self._overview(run=run)
        self.assertTrue(result["available"])
        self.assertEqual(len(result["runs"]), 2)
        self.assertEqual(result["pullRequests"], [])
        # ... and the empty list is explained rather than presented as truth.
        self.assertIn("pullRequests", result["errors"])
        self.assertIn("403", result["errors"]["pullRequests"])

    def test_a_nonsense_limit_is_clamped_not_fatal(self):
        seen: list[str] = []

        def run(args, *rest, **kwargs):
            seen.append(" ".join(args))
            return True, "[]", ""

        for wanted in ("0", "-3", "nonsense", "9999", 3):
            result = self._overview(run=run, limit=wanted)
            self.assertEqual(result["success"], True)
        # The *list* query is the one the caller's limit governs; the summary's own
        # branch query has a fixed depth of its own and is excluded here.
        limits = [
            args.split("-L ")[1].split(" ")[0]
            for args in seen
            if " run " in f" {args} " and " -b " not in f" {args} "
        ]
        self.assertEqual(limits, ["1", "1", str(gh_cli.DEFAULT_LIMIT), str(gh_cli.MAX_LIMIT), "3"])

# Two lines of `gh run view --log` output, copied from a real run: a tab between
# the job, the step and the text, then a UTC timestamp on every line.
REAL_LOG = (
    "\ufeffmacos\tUNKNOWN STEP\t2026-09-26T01:16:35.6949930Z Current runner version: '2.337.0'\n"
    "macos\tRun tests\t2026-09-26T01:16:36.1000000Z npm test\n"
    "ubuntu-latest\tRun tests\t2026-09-26T01:16:37.0000000Z AssertionError: expected 1 to be 2\n"
)


class ParseLogTests(unittest.TestCase):
    def test_job_step_and_timestamp_come_off_the_line(self):
        parsed = gh_cli.parse_log(REAL_LOG)
        self.assertEqual(
            parsed["lines"],
            [
                "Current runner version: '2.337.0'",
                "npm test",
                "AssertionError: expected 1 to be 2",
            ],
        )
        # Both runners and the step that failed, without repetition: a header wants
        # the distinct set, not the prefix of every line.
        self.assertEqual(parsed["jobs"], ["macos", "ubuntu-latest"])
        self.assertEqual(parsed["steps"], ["Run tests"])
        self.assertEqual(parsed["dropped"], 0)

    def test_the_unknown_step_gh_prints_is_not_treated_as_a_step(self):
        self.assertEqual(gh_cli.parse_log(REAL_LOG)["steps"], ["Run tests"])

    def test_the_tail_is_kept_and_the_count_says_how_much_was_left_behind(self):
        parsed = gh_cli.parse_log(REAL_LOG, tail=2)
        self.assertEqual(
            parsed["lines"], ["npm test", "AssertionError: expected 1 to be 2"]
        )
        self.assertEqual(parsed["dropped"], 1)

    def test_a_line_that_is_not_a_log_line_is_kept_whole(self):
        # Anything gh prints without the job/step columns is still worth showing.
        parsed = gh_cli.parse_log("just a line\n\n")
        self.assertEqual(parsed["lines"], ["just a line"])
        self.assertEqual(parsed["jobs"], [])

    def test_tabs_inside_the_log_text_survive(self):
        line = "macos\tRun tests\t2026-09-26T01:16:36.1000000Z col1\tcol2\tcol3\n"
        self.assertEqual(gh_cli.parse_log(line)["lines"], ["col1\tcol2\tcol3"])

    def test_an_empty_log_is_no_lines(self):
        parsed = gh_cli.parse_log("")
        self.assertEqual(parsed["lines"], [])
        self.assertEqual(parsed["dropped"], 0)


class RunLogStateTests(unittest.TestCase):
    """`--log-failed` prints nothing when nothing failed, which is a fact."""

    def _run_log(self, gh_path="/usr/bin/gh", remote="https://github.com/acme/api.git", run=None):
        payload = {"cwd": ".", "runId": 42}
        with mock.patch.object(gh_cli, "_gh_path", lambda: gh_path), mock.patch.object(
            gh_cli, "_remote_url", lambda cwd: remote
        ), mock.patch.object(gh_cli, "_run", run or (lambda *a, **k: (True, REAL_LOG, ""))):
            return gh_cli.run_log(payload)

    def test_a_failed_log_comes_back_as_lines_and_a_summary(self):
        result = self._run_log()
        self.assertTrue(result["available"])
        self.assertEqual(len(result["lines"]), 3)
        self.assertEqual(result["jobs"], ["macos", "ubuntu-latest"])

    def test_an_empty_answer_is_reported_rather_than_shown_as_an_empty_log(self):
        result = self._run_log(run=lambda *a, **k: (True, "", ""))
        self.assertTrue(result["success"])
        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "no-log")
        self.assertIn("cancelled", result["detail"])

    def test_a_nonsense_run_id_never_reaches_gh(self):
        calls: list[list[str]] = []

        def run(args, *rest, **kwargs):
            calls.append(list(args))
            return True, "", ""

        payload = {"cwd": ".", "runId": "36207865178; rm -rf /"}
        with mock.patch.object(gh_cli, "_gh_path", lambda: "/usr/bin/gh"), mock.patch.object(
            gh_cli, "_remote_url", lambda cwd: "https://github.com/acme/api.git"
        ), mock.patch.object(gh_cli, "_run", run):
            result = gh_cli.run_log(payload)
        self.assertFalse(result["success"])
        self.assertEqual(result["reason"], "bad-run")
        self.assertEqual(calls, [])

    def test_signed_out_is_named(self):
        result = self._run_log(
            run=lambda *a, **k: (False, "", "To get started with GitHub CLI, please run:  gh auth login")
        )
        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "not-authenticated")

    def test_the_tail_is_clamped(self):
        seen: list[int] = []

        def run(args, *rest, **kwargs):
            seen.append(1)
            return True, "\n".join(f"macos\tRun tests\t2026-09-26T01:16:36.1000000Z line {i}" for i in range(50)), ""

        for wanted in ("nonsense", 1, 9999):
            payload = {"cwd": ".", "runId": "7", "tail": wanted}
            with mock.patch.object(gh_cli, "_gh_path", lambda: "/usr/bin/gh"), mock.patch.object(
                gh_cli, "_remote_url", lambda cwd: "https://github.com/acme/api.git"
            ), mock.patch.object(gh_cli, "_run", run):
                result = gh_cli.run_log(payload)
            self.assertTrue(result["available"])
            self.assertEqual(len(result["lines"]), min(50, max(gh_cli.MIN_TAIL, min(gh_cli.MAX_TAIL, wanted if isinstance(wanted, int) else gh_cli.DEFAULT_TAIL))))
        self.assertEqual(len(seen), 3)


class SummarizeRunsTests(unittest.TestCase):
    """The numbers beside a branch, and the cases where there are none."""

    def _run(self, status="completed", conclusion="success", minutes=8, **over):
        run = {
            "status": status,
            "conclusion": conclusion,
            "durationSeconds": minutes * 60,
            "createdAt": "2026-09-26T01:00:00Z",
        }
        run.update(over)
        return run

    def test_a_pass_rate_counts_only_runs_that_finished(self):
        runs = [
            self._run(),
            self._run(conclusion="failure"),
            self._run(conclusion="cancelled"),
            self._run(conclusion="skipped"),
            # Still going: nobody's outcome yet.
            self._run(status="in_progress", conclusion="", durationSeconds=None),
        ]
        summary = gh_cli.summarize_runs(runs, "dev")
        self.assertEqual(summary["branch"], "dev")
        self.assertEqual((summary["passed"], summary["failed"]), (1, 1))
        # Cancelled and skipped are neither, so they are counted apart rather than
        # dragging the rate down to a health nobody measured.
        self.assertEqual(summary["other"], 2)
        self.assertEqual(summary["passRate"], 0.5)
        self.assertEqual(summary["total"], 5)

    def test_the_average_ignores_the_runs_with_no_duration(self):
        runs = [self._run(minutes=10), self._run(minutes=8), self._run(minutes=0, durationSeconds=None)]
        self.assertEqual(gh_cli.summarize_runs(runs)["averageDurationSeconds"], 9 * 60)

    def test_no_answer_is_not_zero(self):
        empty = gh_cli.summarize_runs([])
        self.assertIsNone(empty["passRate"])
        self.assertIsNone(empty["averageDurationSeconds"])
        self.assertIsNone(empty["latest"])
        self.assertEqual(empty["history"], [])
        # Every run cancelled: a rate would be a division by nothing.
        cancelled = gh_cli.summarize_runs([self._run(conclusion="cancelled")])
        self.assertIsNone(cancelled["passRate"])

    def test_the_latest_is_the_newest_and_the_history_reads_oldest_first(self):
        runs = [self._run(conclusion="failure"), self._run(conclusion="success")]
        summary = gh_cli.summarize_runs(runs)
        self.assertEqual(summary["latest"]["conclusion"], "failure")
        # A bar chart reads left to right, so the history is the other way round.
        self.assertEqual([r["conclusion"] for r in summary["history"]], ["success", "failure"])


class BranchSummaryTests(unittest.TestCase):
    """Which runs the summary describes, and what it does when it cannot tell."""

    def _overview(self, run, branch="dev"):
        payload = {"cwd": "."}
        with mock.patch.object(gh_cli, "_gh_path", lambda: "/usr/bin/gh"), mock.patch.object(
            gh_cli, "_remote_url", lambda cwd: "https://github.com/acme/api.git"
        ), mock.patch.object(gh_cli, "_current_branch", lambda cwd: branch), mock.patch.object(
            gh_cli, "_run", run
        ):
            return gh_cli.overview(payload)

    def _json_runner(self, branch_runs, listed=None):
        """What `gh` answers: the list, then the branch's runs."""
        calls: list[list[str]] = []

        def run(args, *rest, **kwargs):
            calls.append(list(args))
            if "-b" in args:
                return True, __import__("json").dumps(branch_runs), ""
            return True, __import__("json").dumps(listed or branch_runs), ""

        run.calls = calls  # type: ignore[attr-defined]
        return run

    def test_the_summary_describes_the_branch_it_was_asked_about(self):
        run = self._json_runner(REAL_RUNS)
        result = self._overview(run)
        self.assertEqual(result["summary"]["branch"], "dev")
        # And the runs query really carried the branch, rather than being filtered
        # here from whatever happened to come back.
        branch_calls = [call for call in run.calls if "-b" in call]
        self.assertEqual(len(branch_calls), 1)
        self.assertIn("dev", branch_calls[0])
        # The list itself stays the repository's runs, with its own limit.
        self.assertEqual(len(result["runs"]), len(REAL_RUNS))

    def test_a_detached_head_summarizes_the_runs_the_list_shows(self):
        run = self._json_runner(REAL_RUNS)
        result = self._overview(run, branch="")
        self.assertEqual(result["summary"]["branch"], "")
        self.assertEqual(result["summary"]["total"], len(REAL_RUNS))
        # Nothing was asked about a branch, because there is none to name.
        self.assertEqual([call for call in run.calls if "-b" in call], [])

    def test_a_branch_query_that_fails_does_not_take_the_panel_with_it(self):
        def run(args, *rest, **kwargs):
            if "-b" in args:
                return False, "", "HTTP 500: Internal Server Error"
            return True, __import__("json").dumps(REAL_RUNS), ""

        result = self._overview(run)
        self.assertTrue(result["available"])
        self.assertEqual(len(result["runs"]), 2)
        self.assertIn("summary", result["errors"])
        # The summary falls back to what the list shows, and says it is not a branch.
        self.assertEqual(result["summary"]["branch"], "")

    def test_the_branch_helper_asks_git_and_rejects_a_detached_head(self):
        asked: list[list[str]] = []

        def run(args, *rest, **kwargs):
            asked.append(list(args))
            return True, "dev\n", ""

        with mock.patch.object(gh_cli, "_run", run):
            self.assertEqual(gh_cli._current_branch("."), "dev")
        # The argv has to name git itself: this module runs the command as given.
        self.assertEqual(asked[0][:2], ["git", "rev-parse"])

        with mock.patch.object(gh_cli, "_run", lambda *a, **k: (True, "HEAD\n", "")):
            self.assertEqual(gh_cli._current_branch("."), "")

        with mock.patch.object(gh_cli, "_run", lambda *a, **k: (False, "", "not a repository")):
            self.assertEqual(gh_cli._current_branch("."), "")


class RunShaTests(unittest.TestCase):
    def test_each_run_carries_the_commit_it_was_for(self):
        runs = gh_cli.parse_runs(REAL_RUNS)
        self.assertEqual(runs[0]["sha"], "913d48b1473857d8f3e09176479d1417b3ad9562")
        self.assertEqual(runs[1]["sha"], "913d48b1473857d8f3e09176479d1417b3ad9562")


if __name__ == "__main__":
    unittest.main()
