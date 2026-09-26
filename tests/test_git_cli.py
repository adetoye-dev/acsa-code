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

    def test_a_rename_carries_both_names(self):
        # `path` is where the file is now and `fromPath` where it was: every later
        # action asks git about one of them, and the actor of a rename is the pair.
        parsed = git_cli.parse_status("## dev\nR  old.py -> new.py\n")
        entry = parsed["files"][0]
        self.assertEqual(entry["path"], "new.py")
        self.assertEqual(entry["fromPath"], "old.py")
        self.assertEqual(parsed["staged"][0]["path"], "new.py")

    def test_unmerged_files_are_their_own_group(self):
        """A conflict is not a staged change, and not a working-tree change.

        Under "staged", the commit button offered to commit a file full of conflict
        markers and git answered with an error the page did not explain.
        """
        parsed = git_cli.parse_status("## dev\nUU src/one.ts\n M src/two.ts\n")
        self.assertEqual([f["path"] for f in parsed["conflicted"]], ["src/one.ts"])
        self.assertEqual(parsed["conflicted"][0]["workTreeStatus"], "U")
        self.assertEqual([f["path"] for f in parsed["staged"]], [])
        self.assertEqual([f["path"] for f in parsed["unstaged"]], ["src/two.ts"])
        # It is still a changed file, so a tree decoration can find it.
        self.assertEqual([f["path"] for f in parsed["files"]], ["src/one.ts", "src/two.ts"])

    def test_both_added_and_both_deleted_count_as_conflicts(self):
        parsed = git_cli.parse_status("## dev\nAA added.ts\nDD gone.ts\n")
        self.assertEqual([f["path"] for f in parsed["conflicted"]], ["added.ts", "gone.ts"])
        self.assertEqual(parsed["staged"], [])

    def test_an_added_file_has_no_previous_name(self):
        parsed = git_cli.parse_status("## dev\nA  added.ts\n")
        self.assertEqual(parsed["staged"][0]["fromPath"], "")


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
                # Compared whole, `fromPath` included: an accidental extra or
                # missing key is the kind of shape change a caller breaks on.
                {"path": ".tauri/Cargo.lock", "fromPath": "", "status": "M", "additions": 1, "deletions": 1},
                {"path": "src/new.ts", "fromPath": "", "status": "A", "additions": 42, "deletions": 0},
                {"path": "docs/old.md", "fromPath": "", "status": "D", "additions": 0, "deletions": 17},
            ],
        )

    def test_a_rename_in_a_commit_is_one_row_with_two_names(self):
        files = git_cli.parse_commit_files(
            "R100\told.py\tnew.py\n", "0\t0\told.py => new.py\n"
        )
        self.assertEqual(
            files,
            [
                {"path": "new.py", "fromPath": "old.py", "status": "R", "additions": 0, "deletions": 0},
            ],
        )

    def test_a_copy_in_a_commit_keeps_its_source(self):
        files = git_cli.parse_commit_files("C75\tsrc/a.ts\tsrc/b.ts\n", "3\t0\tsrc/a.ts => src/b.ts\n")
        self.assertEqual(files[0]["fromPath"], "src/a.ts")
        self.assertEqual(files[0]["path"], "src/b.ts")
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


class DiffSidesTests(unittest.TestCase):
    """Which two things the diff pane is comparing.

    Both failures here were found by running the engine against a real repository:
    a rename asked git about a file with an arrow in its name, and the unstaged
    side read HEAD, so a partly-staged file showed work that was already staged.
    """

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="acsa-git-sides-")).resolve()
        git(self.root, "init", "-q")
        git(self.root, "config", "user.email", "t@local")
        git(self.root, "config", "user.name", "t")
        (self.root / "old.py").write_text("one\ntwo\n", encoding="utf-8")
        (self.root / "other.txt").write_text("settled\n", encoding="utf-8")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-qm", "base")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_a_staged_rename_diffs_the_old_name_against_the_new_one(self):
        git(self.root, "mv", "old.py", "new.py")
        status = git_cli.status({"cwd": str(self.root)})
        entry = status["staged"][0]
        sides = git_cli.diff_file(
            {
                "cwd": str(self.root),
                "filePath": entry["path"],
                "fromPath": entry["fromPath"],
                "staged": True,
            }
        )
        # Both sides real: reading only the new name gave an empty original, which
        # made a rename look like a brand-new file.
        self.assertEqual(sides["originalContent"], "one\ntwo\n")
        self.assertEqual(sides["modifiedContent"], "one\ntwo\n")

    def test_the_combined_rename_path_is_not_a_path_any_more(self):
        # The old shape handed `old.py -> new.py` to `git show`, which failed
        # silently and rendered "nothing to compare" for a changed file.
        git(self.root, "mv", "old.py", "new.py")
        entry = git_cli.status({"cwd": str(self.root)})["staged"][0]
        self.assertEqual(entry["path"], "new.py")
        self.assertEqual(entry["fromPath"], "old.py")

    def test_an_unstaged_change_compares_the_index_not_head(self):
        # Committed, staged, then edited again: the unstaged half is two → three,
        # and HEAD (one) must not appear on either side.
        (self.root / "old.py").write_text("two\n", encoding="utf-8")
        git(self.root, "add", "old.py")
        (self.root / "old.py").write_text("three\n", encoding="utf-8")
        self.assertEqual(git_cli.status({"cwd": str(self.root)})["unstaged"][0]["indexStatus"], "M")

        sides = git_cli.diff_file({"cwd": str(self.root), "filePath": "old.py", "staged": False})
        self.assertEqual(sides["originalContent"], "two\n")
        self.assertEqual(sides["modifiedContent"], "three\n")

    def test_an_untracked_file_has_an_empty_before(self):
        (self.root / "fresh.txt").write_text("brand new\n", encoding="utf-8")
        sides = git_cli.diff_file({"cwd": str(self.root), "filePath": "fresh.txt", "staged": False})
        self.assertEqual(sides["originalContent"], "")
        self.assertEqual(sides["modifiedContent"], "brand new\n")

    def test_a_committed_rename_reads_as_a_rename_not_an_add_and_a_delete(self):
        """The whole path: git's rename detection, the parse, and both diff sides.

        With `--no-renames` this was two rows — an add with an empty original and a
        delete with an empty modified — for one file that had only moved.
        """
        git(self.root, "mv", "other.txt", "renamed.txt")
        git(self.root, "commit", "-qm", "move it")
        sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(self.root), check=True, capture_output=True, text=True,
        ).stdout.strip()

        info = git_cli.commit_info({"cwd": str(self.root), "sha": sha})
        self.assertEqual([f["path"] for f in info["files"]], ["renamed.txt"])
        entry = info["files"][0]
        self.assertEqual(entry["status"], "R")
        self.assertEqual(entry["fromPath"], "other.txt")

        sides = git_cli.commit_file(
            {
                "cwd": str(self.root),
                "sha": sha,
                "filePath": entry["path"],
                "fromPath": entry["fromPath"],
            }
        )
        self.assertEqual(sides["originalContent"], "settled\n")
        self.assertEqual(sides["modifiedContent"], "settled\n")
    def test_a_file_changed_since_a_commit_reads_against_the_commit(self):
        # The commit has "one\n"; the file on disk has two lines since.
        (self.root / "old.py").write_text("one\ntwo\nthree\n", encoding="utf-8")
        sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=str(self.root), capture_output=True, text=True
        ).stdout.strip()
        sides = git_cli.diff_since({"cwd": str(self.root), "ref": sha, "filePath": "old.py"})
        self.assertTrue(sides["success"])
        self.assertEqual(sides["originalContent"], "one\ntwo\n")
        self.assertEqual(sides["modifiedContent"], "one\ntwo\nthree\n")

    def test_the_disk_is_the_after_side_even_when_the_change_is_staged(self):
        # "Since this commit" is about the working tree, so what is in the index
        # must not be what the diff shows.
        (self.root / "old.py").write_text("staged version\n", encoding="utf-8")
        git(self.root, "add", "old.py")
        (self.root / "old.py").write_text("disk version\n", encoding="utf-8")
        sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=str(self.root), capture_output=True, text=True
        ).stdout.strip()
        sides = git_cli.diff_since({"cwd": str(self.root), "ref": sha, "filePath": "old.py"})
        self.assertEqual(sides["originalContent"], "one\ntwo\n")
        self.assertEqual(sides["modifiedContent"], "disk version\n")

    def test_a_file_the_commit_did_not_have_is_an_addition(self):
        (self.root / "fresh.txt").write_text("brand new\n", encoding="utf-8")
        sides = git_cli.diff_since({"cwd": str(self.root), "ref": "HEAD", "filePath": "fresh.txt"})
        self.assertEqual(sides["originalContent"], "")
        self.assertEqual(sides["modifiedContent"], "brand new\n")

    def test_a_file_deleted_since_is_a_deletion(self):
        (self.root / "other.txt").unlink()
        sides = git_cli.diff_since({"cwd": str(self.root), "ref": "HEAD", "filePath": "other.txt"})
        self.assertEqual(sides["originalContent"], "settled\n")
        self.assertEqual(sides["modifiedContent"], "")

    def test_a_ref_that_cannot_be_read_is_an_error_not_an_addition(self):
        # A stale sha would otherwise read as "every line is new".
        sides = git_cli.diff_since(
            {"cwd": str(self.root), "ref": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "filePath": "old.py"}
        )
        self.assertFalse(sides["success"])
        self.assertIn("could not be read", sides["error"])

class ConflictTests(unittest.TestCase):
    """A real merge, stopped on a conflict."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="acsa-git-conflict-")).resolve()
        git(self.root, "init", "-q")
        git(self.root, "config", "user.email", "t@local")
        git(self.root, "config", "user.name", "t")
        (self.root / "f.txt").write_text("base\n", encoding="utf-8")
        (self.root / "untouched.txt").write_text("mine\n", encoding="utf-8")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-qm", "base")
        git(self.root, "checkout", "-q", "-b", "other")
        (self.root / "f.txt").write_text("theirs\n", encoding="utf-8")
        git(self.root, "commit", "-qam", "theirs")
        git(self.root, "checkout", "-q", "-")
        (self.root / "f.txt").write_text("ours\n", encoding="utf-8")
        git(self.root, "commit", "-qam", "ours")
        # A merge that conflicts (and one unrelated edit, to prove the bulk action
        # does not sweep it up).
        subprocess.run(
            ["git", "merge", "other"], cwd=str(self.root), capture_output=True, text=True
        )
        (self.root / "untouched.txt").write_text("mine, edited mid-conflict\n", encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_the_conflict_is_its_own_group_and_the_operation_is_named(self):
        status = git_cli.status({"cwd": str(self.root)})
        self.assertEqual([f["path"] for f in status["conflicted"]], ["f.txt"])
        self.assertEqual(status["staged"], [])
        self.assertEqual(status["operation"], "merge")
        # The unrelated edit is what the commit button should still be about.
        self.assertEqual([f["path"] for f in status["unstaged"]], ["untouched.txt"])

    def test_the_conflicted_file_still_has_a_readable_diff(self):
        sides = git_cli.diff_file({"cwd": str(self.root), "filePath": "f.txt", "staged": False})
        # The markers are in the working tree, which is what a person resolves.
        self.assertIn("<<<<<<<", sides["modifiedContent"])

    def test_resolving_all_stages_the_conflict_and_nothing_else(self):
        result = git_cli.resolve_all({"cwd": str(self.root)})
        self.assertTrue(result["success"])
        self.assertIn("1 file", result["message"])

        status = git_cli.status({"cwd": str(self.root)})
        self.assertEqual(status["conflicted"], [])
        self.assertEqual([f["path"] for f in status["staged"]], ["f.txt"])
        # The unrelated work is exactly where it was.
        self.assertEqual([f["path"] for f in status["unstaged"]], ["untouched.txt"])

    def test_nothing_left_to_resolve_says_so_rather_than_failing(self):
        git_cli.resolve_all({"cwd": str(self.root)})
        again = git_cli.resolve_all({"cwd": str(self.root)})
        self.assertTrue(again["success"])
        self.assertEqual(again["message"], "Nothing left to resolve.")

    def test_the_operation_is_empty_in_a_repository_at_rest(self):
        git(self.root, "merge", "--abort")
        self.assertEqual(git_cli.status({"cwd": str(self.root)})["operation"], "")

class UnquotePathTests(unittest.TestCase):
    """Git's quoted paths, undone.

    Every string here is what `git status --porcelain=v1` actually printed for a
    file with that name, tab-escapes and all, in a throwaway repository.
    """

    def test_an_unquoted_path_is_left_alone(self):
        self.assertEqual(git_cli.unquote_path("src/plain.py"), "src/plain.py")
        # A quote in the middle does not make it a quoted path.
        self.assertEqual(git_cli.unquote_path('a"b.py'), 'a"b.py')

    def test_a_non_ascii_name_is_octal_bytes_not_letters(self):
        # "caf\303\251.py" → café.py: the two escapes are one character once the
        # bytes are decoded together, which is the part a naive decoder gets wrong.
        self.assertEqual(git_cli.unquote_path('"caf\\303\\251.py"'), "café.py")

    def test_the_named_escapes(self):
        self.assertEqual(git_cli.unquote_path('"tab\\there.py"'), "tab\there.py")
        self.assertEqual(git_cli.unquote_path('"new\\nline.py"'), "new\nline.py")
        self.assertEqual(git_cli.unquote_path('"ctrl\\001char.py"'), "ctrl\x01char.py")
        self.assertEqual(git_cli.unquote_path('"del\\177char.py"'), "del\x7fchar.py")

    def test_a_quote_or_backslash_inside_the_name(self):
        self.assertEqual(git_cli.unquote_path('"a\\"b.py"'), 'a"b.py')
        self.assertEqual(git_cli.unquote_path('"back\\\\slash.py"'), "back\\slash.py")

    def test_an_escape_git_does_not_write_is_kept_visible(self):
        # Better a visibly odd path than a silently mangled one.
        self.assertEqual(git_cli.unquote_path('"a\\qb.py"'), "a\\qb.py")


class QuotedStatusTests(unittest.TestCase):
    def test_a_quoted_path_in_status_is_unquoted(self):
        parsed = git_cli.parse_status('## dev\n?? "caf\\303\\251.py"\n')
        self.assertEqual([f["path"] for f in parsed["files"]], ["café.py"])
        self.assertEqual([f["path"] for f in parsed["unstaged"]], ["café.py"])

    def test_both_sides_of_a_quoted_rename(self):
        parsed = git_cli.parse_status('## dev\nR  "caf\\303\\251.py" -> "caf\\303\\251-2.py"\n')
        entry = parsed["staged"][0]
        self.assertEqual(entry["path"], "café-2.py")
        self.assertEqual(entry["fromPath"], "café.py")

    def test_a_quoted_path_in_a_commit(self):
        files = git_cli.parse_commit_files('M\t"caf\\303\\251.py"\n', "1\t0\t\"caf\\303\\251.py\"\n")
        self.assertEqual(files[0]["path"], "café.py")
        renamed = git_cli.parse_commit_files(
            'R100\t"caf\\303\\251.py"\t"caf\\303\\251-2.py"\n', "0\t0\tx\n"
        )
        self.assertEqual(renamed[0]["path"], "café-2.py")
        self.assertEqual(renamed[0]["fromPath"], "café.py")


class QuotedPathRepositoryTests(unittest.TestCase):
    """The same names, through real git: this is what used to fail."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="acsa-git-quoted-")).resolve()
        git(self.root, "init", "-q")
        git(self.root, "config", "user.email", "t@local")
        git(self.root, "config", "user.name", "t")
        # Pinned on purpose: the default is on, but a machine that turned it off
        # would make this test pass without exercising anything.
        git(self.root, "config", "core.quotePath", "true")
        self.name = "café.py"
        (self.root / self.name).write_text("one\n", encoding="utf-8")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-qm", "base")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_status_reports_the_name_a_person_can_type(self):
        (self.root / self.name).write_text("one\ntwo\n", encoding="utf-8")
        status = git_cli.status({"cwd": str(self.root)})
        self.assertEqual([f["path"] for f in status["unstaged"]], [self.name])

    def test_staging_and_diffing_it_works(self):
        (self.root / self.name).write_text("one\ntwo\n", encoding="utf-8")
        entry = git_cli.status({"cwd": str(self.root)})["unstaged"][0]

        staged = git_cli.stage({"cwd": str(self.root), "filePath": entry["path"]})
        self.assertTrue(staged["success"], staged.get("error"))

        status = git_cli.status({"cwd": str(self.root)})
        self.assertEqual([f["path"] for f in status["staged"]], [self.name])

        sides = git_cli.diff_file({"cwd": str(self.root), "filePath": self.name, "staged": True})
        self.assertEqual(sides["originalContent"], "one\n")
        self.assertEqual(sides["modifiedContent"], "one\ntwo\n")

    def test_a_rename_of_one_is_carried_by_both_names(self):
        git(self.root, "mv", self.name, "café-2.py")
        entry = git_cli.status({"cwd": str(self.root)})["staged"][0]
        self.assertEqual(entry["path"], "café-2.py")
        self.assertEqual(entry["fromPath"], self.name)
        sides = git_cli.diff_file(
            {
                "cwd": str(self.root),
                "filePath": entry["path"],
                "fromPath": entry["fromPath"],
                "staged": True,
            }
        )
        self.assertEqual(sides["originalContent"], "one\n")


if __name__ == "__main__":
    unittest.main()
