"""The file half of "undo this turn".

The runtime cannot do this: both `thread/rollback` and `thread/revert` state in
their own schemas that they change conversation history and *not* local file
changes. These tests are about the property that makes an undo safe rather than
destructive — that the user's own uncommitted work survives it.
"""

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core-engine"))

import snapshot_cli  # noqa: E402


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=str(root), check=True, capture_output=True, text=True)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="acsa-snap-project-")).resolve()
        self.data = Path(tempfile.mkdtemp(prefix="acsa-snap-data-")).resolve()
        git(self.root, "init", "-q")
        git(self.root, "config", "user.email", "t@local")
        git(self.root, "config", "user.name", "t")
        (self.root / "clean.txt").write_text("head version\n", encoding="utf-8")
        (self.root / "doomed.txt").write_text("will be deleted before the turn\n", encoding="utf-8")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-qm", "base")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)
        shutil.rmtree(self.data, ignore_errors=True)

    def take(self, turn="t1"):
        return snapshot_cli.take(
            {"projectRoot": str(self.root), "dataDir": str(self.data), "turnId": turn}
        )[0]

    def test_undo_restores_the_users_work_not_heads_version(self):
        # The user's uncommitted edits, in all three shapes they come in.
        (self.root / "dirty.txt").write_text("head version\n", encoding="utf-8")
        git(self.root, "add", "dirty.txt")
        git(self.root, "commit", "-qm", "add dirty")
        (self.root / "dirty.txt").write_text("the user's own edit\n", encoding="utf-8")
        (self.root / "untracked.txt").write_text("the user's new file\n", encoding="utf-8")
        (self.root / "doomed.txt").unlink()

        result = self.take()
        self.assertTrue(result["ok"])
        self.assertTrue(result["data"]["complete"])

        # Now the turn happens: it rewrites the dirty file, edits a clean one,
        # creates a new one, and resurrects the file the user had deleted.
        (self.root / "dirty.txt").write_text("the agent overwrote it\n", encoding="utf-8")
        (self.root / "clean.txt").write_text("the agent changed a clean file\n", encoding="utf-8")
        (self.root / "created-by-agent.txt").write_text("new\n", encoding="utf-8")
        (self.root / "doomed.txt").write_text("the agent recreated it\n", encoding="utf-8")

        out = snapshot_cli.restore(
            {
                "projectRoot": str(self.root),
                "dataDir": str(self.data),
                "turnId": "t1",
                "paths": ["dirty.txt", "clean.txt", "created-by-agent.txt", "doomed.txt"],
            }
        )[0]
        self.assertTrue(out["ok"], out)

        # The user's edit is back — not HEAD's version, which is the whole point:
        # `git checkout --` alone would have thrown this away.
        self.assertEqual((self.root / "dirty.txt").read_text(), "the user's own edit\n")
        # A clean file goes back to HEAD.
        self.assertEqual((self.root / "clean.txt").read_text(), "head version\n")
        # A file the turn created is removed.
        self.assertFalse((self.root / "created-by-agent.txt").exists())
        # A file the user had already deleted stays deleted.
        self.assertFalse((self.root / "doomed.txt").exists())
        # And the user's untracked file, which the turn never touched, is untouched.
        self.assertEqual((self.root / "untracked.txt").read_text(), "the user's new file\n")

    def test_a_missing_snapshot_refuses_rather_than_guessing(self):
        out, code = snapshot_cli.restore(
            {
                "projectRoot": str(self.root),
                "dataDir": str(self.data),
                "turnId": "never-taken",
                "paths": ["clean.txt"],
            }
        )
        self.assertFalse(out["ok"])
        self.assertEqual(code, 1)
        self.assertIn("cannot be undone", out["error"])
        # And it changed nothing on the way out.
        self.assertEqual((self.root / "clean.txt").read_text(), "head version\n")

    def test_an_incomplete_snapshot_refuses_whole(self):
        oversized = b"x" * (snapshot_cli.MAX_FILE_BYTES + 1)
        (self.root / "big.bin").write_bytes(oversized)
        result = self.take(turn="t-big")
        self.assertTrue(result["ok"])
        self.assertFalse(result["data"]["complete"])
        self.assertEqual(result["data"]["skipped"][0]["path"], "big.bin")

        out, code = snapshot_cli.restore(
            {
                "projectRoot": str(self.root),
                "dataDir": str(self.data),
                "turnId": "t-big",
                "paths": ["clean.txt"],
            }
        )
        # A partial restore would leave a state nobody designed, so it refuses.
        self.assertFalse(out["ok"])
        self.assertEqual(code, 1)
        self.assertIn("incomplete", out["error"])

    def test_a_clean_project_has_nothing_to_capture(self):
        result = self.take(turn="t-clean")
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["files"], 0)
        self.assertTrue(result["data"]["complete"])

    def test_discard_removes_the_snapshot(self):
        self.take(turn="t-discard")
        self.assertTrue((self.data / "turn-snapshots" / "t-discard" / "manifest.json").is_file())
        out = snapshot_cli.discard({"dataDir": str(self.data), "turnId": "t-discard"})[0]
        self.assertTrue(out["ok"])
        self.assertFalse((self.data / "turn-snapshots" / "t-discard").exists())

    def test_only_the_last_few_snapshots_are_kept(self):
        for i in range(snapshot_cli.KEEP_SNAPSHOTS + 3):
            self.take(turn=f"t-{i}")
        kept = sorted(p.name for p in (self.data / "turn-snapshots").iterdir() if p.is_dir())
        self.assertEqual(len(kept), snapshot_cli.KEEP_SNAPSHOTS)


if __name__ == "__main__":
    unittest.main()
