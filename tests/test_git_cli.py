"""Unit tests for the git parsers behind the source-control panel.

`git status --porcelain=v1 -b` is a terse format and the panel reads its shape
directly, as does the history graph from `git log` and `git for-each-ref`, so the
parses are worth pinning down without needing a repository.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core-engine"))

import git_cli  # noqa: E402


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=str(root), check=True, capture_output=True, text=True)


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


class ParseCommitTests(unittest.TestCase):
    """What the commit panel opens with when a graph row is picked."""

    def test_header_fields_including_a_multi_line_body(self):
        stdout = git_cli.LOG_FIELD.join(
            [
                "a" * 40,
                "aaaaaaa",
                "Ada",
                "2026-09-26T12:00:00+01:00",
                "Release 0.2.17",
                "The editor takes a burst of typing again.\n\nSecond paragraph.\n",
            ]
        ) + git_cli.LOG_RECORD
        parsed = git_cli.parse_commit_meta(stdout)
        self.assertEqual(parsed["short"], "aaaaaaa")
        self.assertEqual(parsed["subject"], "Release 0.2.17")
        # The body keeps its paragraphs but not the trailing newline.
        self.assertEqual(parsed["body"], "The editor takes a burst of typing again.\n\nSecond paragraph.")

    def test_a_commit_with_no_body(self):
        stdout = git_cli.LOG_FIELD.join(
            ["b" * 40, "bbbbbbb", "Ada", "2026-09-26T12:00:00+01:00", "Only a subject", ""]
        ) + git_cli.LOG_RECORD
        self.assertEqual(git_cli.parse_commit_meta(stdout)["body"], "")

    def test_a_truncated_header_is_no_commit(self):
        self.assertEqual(git_cli.parse_commit_meta("a" * 40 + git_cli.LOG_FIELD + "aaaaaaa"), {})

    def test_files_pair_the_status_list_with_the_counts(self):
        files = git_cli.parse_commit_files(
            "M\t.tauri/Cargo.lock\nA\tsrc/new.ts\nD\tdocs/old.md\n",
            "1\t1\t.tauri/Cargo.lock\n42\t0\tsrc/new.ts\n0\t17\tdocs/old.md\n",
        )
        self.assertEqual(
            files,
            [
                {"path": ".tauri/Cargo.lock", "status": "M", "additions": 1, "deletions": 1},
                {"path": "src/new.ts", "status": "A", "additions": 42, "deletions": 0},
                {"path": "docs/old.md", "status": "D", "additions": 0, "deletions": 17},
            ],
        )

    def test_a_binary_file_has_no_counts_rather_than_zeroes(self):
        # `-` is what git prints for a binary; reporting it as 0/0 would claim the
        # panel knows something it does not.
        files = git_cli.parse_commit_files(
            "M\tpublic/logo.png\n", "-\t-\tpublic/logo.png\n"
        )
        self.assertEqual(files[0]["additions"], None)
        self.assertEqual(files[0]["deletions"], None)

    def test_a_missing_count_line_leaves_the_file_in_the_list(self):
        # Half a diff is still worth listing: the file changed, even if the counts
        # could not be read.
        files = git_cli.parse_commit_files("M\tsrc/one.ts\nM\tsrc/two.ts\n", "3\t1\tsrc/one.ts\n")
        self.assertEqual([f["path"] for f in files], ["src/one.ts", "src/two.ts"])
        self.assertEqual(files[1]["additions"], None)

    def test_nothing_changed(self):
        self.assertEqual(git_cli.parse_commit_files("", ""), [])


class BinaryTextTests(unittest.TestCase):
    """A binary blob must never reach the diff pane as text.

    Parsing cannot see this one: the failure is in how the bytes come back from
    `git show`, so the helper is pinned here and the whole path is pinned below
    against a real repository.
    """

    def test_a_nul_byte_blanks_both_sides(self):
        self.assertEqual(git_cli._text_only("\x89PNG\x00rest", "text"), ("", ""))
        self.assertEqual(git_cli._text_only("text", "PK\x03\x04\x00"), ("", ""))

    def test_text_is_left_alone(self):
        original, modified = git_cli._text_only("one\n", "two\n")
        self.assertEqual((original, modified), ("one\n", "two\n"))

    def test_an_empty_and_a_missing_side_stay_empty(self):
        self.assertEqual(git_cli._text_only("", ""), ("", ""))


class BinaryRepositoryTests(unittest.TestCase):
    """The same guard, end to end through `commit-info` and `commit-file`."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="acsa-git-binary-")).resolve()
        git(self.root, "init", "-q")
        git(self.root, "config", "user.email", "t@local")
        git(self.root, "config", "user.name", "t")
        (self.root / "readme.md").write_text("first\n", encoding="utf-8")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-qm", "base")

        # A real PNG: bytes that are not UTF-8 and that contain a NUL.
        self.blob = b"\x89PNG\r\n\x1a\n" + b"\x00\x01binary payload" + bytes(range(0, 32))
        (self.root / "logo.png").write_text("placeholder\n", encoding="utf-8")
        (self.root / "logo.png").write_bytes(self.blob)
        git(self.root, "add", "-A")
        git(self.root, "commit", "-qm", "add a logo")
        self.sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(self.root), check=True, capture_output=True, text=True,
        ).stdout.strip()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_a_committed_binary_is_listed_without_counts(self):
        info = git_cli.commit_info({"cwd": str(self.root), "sha": self.sha})
        self.assertTrue(info["success"])
        logo = next(f for f in info["files"] if f["path"] == "logo.png")
        self.assertIsNone(logo["additions"])
        self.assertIsNone(logo["deletions"])

    def test_reading_a_committed_binary_returns_no_text_rather_than_raising(self):
        # The regression this pins: `git show` on the blob raised
        # UnicodeDecodeError out of subprocess and the whole action failed.
        sides = git_cli.commit_file({"cwd": str(self.root), "sha": self.sha, "filePath": "logo.png"})
        self.assertTrue(sides["success"])
        self.assertEqual(sides["originalContent"], "")
        self.assertEqual(sides["modifiedContent"], "")

    def test_a_binary_working_tree_change_returns_no_text(self):
        (self.root / "logo.png").write_bytes(self.blob + b"more")
        sides = git_cli.diff_file({"cwd": str(self.root), "filePath": "logo.png", "staged": False})
        self.assertTrue(sides["success"])
        self.assertEqual(sides["originalContent"], "")
        self.assertEqual(sides["modifiedContent"], "")


if __name__ == "__main__":
    unittest.main()
