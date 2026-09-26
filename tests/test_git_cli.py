"""Unit tests for the git parsers behind the source-control panel.

`git status --porcelain=v1 -b` is a terse format and the panel reads its shape
directly, as does the history graph from `git log` and `git for-each-ref`, so the
parses are worth pinning down without needing a repository.
"""

from __future__ import annotations

import sys
import unittest
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core-engine"))

import git_cli  # noqa: E402


class ParseStatusTests(unittest.TestCase):
    def test_branch_and_divergence(self):
        parsed = git_cli.parse_status("## dev...origin/dev [ahead 2, behind 3]\n")
        self.assertEqual(parsed["branch"], "dev")
        self.assertEqual(parsed["ahead"], 2)
        self.assertEqual(parsed["behind"], 3)
        self.assertTrue(parsed["isGit"])

    def test_branch_without_upstream(self):
        parsed = git_cli.parse_status("## main\n")
        self.assertEqual(parsed["branch"], "main")
        self.assertEqual((parsed["ahead"], parsed["behind"]), (0, 0))

    def test_staged_unstaged_and_untracked(self):
        parsed = git_cli.parse_status(
            "## dev\n"
            "M  staged-only.py\n"
            " M worktree-only.py\n"
            "MM both.py\n"
            "?? new.py\n"
        )
        staged = {f["path"] for f in parsed["staged"]}
        unstaged = {f["path"] for f in parsed["unstaged"]}
        self.assertEqual(staged, {"staged-only.py", "both.py"})
        self.assertEqual(unstaged, {"worktree-only.py", "both.py", "new.py"})
        self.assertEqual(len(parsed["files"]), 4)

    def test_clean_tree(self):
        parsed = git_cli.parse_status("## dev\n")
        self.assertEqual(parsed["files"], [])
        self.assertEqual(parsed["staged"], [])
        self.assertEqual(parsed["unstaged"], [])

    def test_renames_keep_the_path(self):
        parsed = git_cli.parse_status("## dev\nR  old.py -> new.py\n")
        self.assertEqual([f["path"] for f in parsed["files"]], ["old.py -> new.py"])


class ResponseShapeTests(unittest.TestCase):
    def test_log_falls_back_to_a_sane_limit(self):
        """A nonsense limit is a shorter graph, not a failed call."""
        self.assertEqual(git_cli.log_limit({}), 60)
        self.assertEqual(git_cli.log_limit({"limit": "25"}), 25)
        self.assertEqual(git_cli.log_limit({"limit": "lots"}), 60)
        # `0` reads as "unset" — nobody wants a graph of no commits — while a
        # negative or absurd number is clamped rather than refused.
        self.assertEqual(git_cli.log_limit({"limit": 0}), 60)
        self.assertEqual(git_cli.log_limit({"limit": -5}), 1)
        self.assertEqual(git_cli.log_limit({"limit": 10_000}), 400)

    def test_missing_cwd_falls_back_to_the_current_directory(self):
        """A stale project path must not break the panel.

        The dev bridge defaulted to `process.cwd()` the same way; this keeps that
        behaviour explicit instead of accidental.
        """
        self.assertEqual(git_cli._cwd({"cwd": "/nonexistent-directory-for-tests"}), os.getcwd())
        self.assertEqual(git_cli._cwd({}), os.getcwd())


class ParseLogTests(unittest.TestCase):
    """The graph is drawn from these parents, so a mis-parse shows up as lanes
    that connect the wrong commits rather than as an error."""

    def record(self, sha, short, parents, author, date, subject):
        return git_cli.LOG_FIELD.join([sha, short, parents, author, date, subject])

    def test_a_merge_keeps_both_parents_in_order(self):
        stdout = (
            self.record("a" * 40, "aaaaaaa", "b" * 40 + " " + "c" * 40, "Ada", "2026-09-26T12:00:00+01:00", "Merge branch 'x'")
            + git_cli.LOG_RECORD
            + self.record("b" * 40, "bbbbbbb", "c" * 40, "Ada", "2026-09-25T12:00:00+01:00", "Second")
            + git_cli.LOG_RECORD
            + self.record("c" * 40, "ccccccc", "", "Grace", "2026-09-24T12:00:00+01:00", "Root")
            + git_cli.LOG_RECORD
        )
        commits = git_cli.parse_log(stdout)
        self.assertEqual(len(commits), 3)
        self.assertEqual(commits[0]["sha"], "a" * 40)
        # Order matters: the first parent is the lane the commit itself continues.
        self.assertEqual(commits[0]["parents"], ["b" * 40, "c" * 40])
        self.assertEqual(commits[1]["parents"], ["c" * 40])
        self.assertEqual(commits[2]["parents"], [])
        self.assertEqual(commits[2]["subject"], "Root")
        self.assertEqual(commits[0]["author"], "Ada")
        self.assertEqual(commits[0]["short"], "aaaaaaa")

    def test_a_subject_containing_a_newline_does_not_split_the_commit(self):
        # `%s` is a subject, but a message body can be folded into it, and the
        # record separator — not the newline — is what bounds a commit.
        stdout = (
            self.record("a" * 40, "aaaaaaa", "", "Ada", "2026-09-26T12:00:00+01:00", "Line one\nLine two")
            + git_cli.LOG_RECORD
        )
        commits = git_cli.parse_log(stdout)
        self.assertEqual(len(commits), 1)
        self.assertEqual(commits[0]["subject"], "Line one\nLine two")

    def test_empty_output_is_an_empty_history(self):
        self.assertEqual(git_cli.parse_log(""), [])
        self.assertEqual(git_cli.parse_log("\n"), [])
        # A truncated record is skipped rather than turned into a commit with
        # blank fields, which would draw a lane to nowhere.
        self.assertEqual(git_cli.parse_log("deadbeef" + git_cli.LOG_FIELD + "dead"), [])


class ParseRefsTests(unittest.TestCase):
    def line(self, full, short, object_name, peeled, head):
        return git_cli.LOG_FIELD.join([full, short, object_name, peeled, head])

    def test_kinds_and_the_peeled_tag(self):
        stdout = "\n".join(
            [
                self.line("refs/heads/dev", "dev", "a" * 40, "", "*"),
                self.line("refs/remotes/origin/dev", "origin/dev", "b" * 40, "", ""),
                # An annotated tag: the tag object is `c*40`, the commit it labels
                # is the peeled `d*40`.
                self.line("refs/tags/v1", "v1", "c" * 40, "d" * 40, ""),
                # Git shortens the remote's HEAD symref to the remote's own name,
                # so this one can only be recognised by its full ref.
                self.line("refs/remotes/origin/HEAD", "origin", "b" * 40, "", ""),
                "",
            ]
        )
        refs = git_cli.parse_refs(stdout)
        self.assertEqual([r["name"] for r in refs], ["dev", "origin/dev", "v1"])
        self.assertEqual([r["kind"] for r in refs], ["branch", "remote", "tag"])
        self.assertEqual(refs[0]["current"], True)
        self.assertEqual(refs[0]["target"], "a" * 40)
        # The badge has to land on the commit the tag names, not on the tag object.
        self.assertEqual(refs[2]["target"], "d" * 40)

    def test_nothing_to_report(self):
        self.assertEqual(git_cli.parse_refs(""), [])


if __name__ == "__main__":
    unittest.main()
