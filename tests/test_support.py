"""The support bundle: the file a user attaches to a public bug report.

It is written *because* there is no telemetry, so the only way a report can be
diagnosed is if the user hands over the evidence. That shapes the one property
this suite exists to defend: the bundle is safe to paste in public. Counts are
fine, values are not — no credential, no transcript, no environment.
"""

import importlib
import io
import json
import os
import platform
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core-engine"))
app_db = importlib.import_module("app_db")
crash_log = importlib.import_module("crash_log")
support = importlib.import_module("support")

SECRET = "sk-super-secret-value-123456"
INLINE_SECRET = "sk-inline-secret-abcdef123456"
TRANSCRIPT = "please rewrite the tax calculator so it stops rounding up"


class SupportTestCase(unittest.TestCase):
    def setUp(self):
        self.data_dir = Path(tempfile.mkdtemp(prefix="acsa-support-"))
        self.work = Path(tempfile.mkdtemp(prefix="acsa-support-out-"))
        self._previous = os.environ.get("ACSA_DATA_DIR")
        os.environ["ACSA_DATA_DIR"] = str(self.data_dir)
        app_db.init_db()
        app_db.set_setting("theme", {"id": "obsidian"})
        # A credential stored where credentials go, and one pasted into a normal
        # setting — both have to stay out of the bundle.
        app_db.set_secret("deepseek_api_key", SECRET)
        app_db.set_setting("notes", f"my key is {INLINE_SECRET} keep it safe")
        app_db.save_chat("/tmp/project", [{"id": "m1", "role": "user", "content": TRANSCRIPT}])

    def tearDown(self):
        if self._previous is None:
            os.environ.pop("ACSA_DATA_DIR", None)
        else:
            os.environ["ACSA_DATA_DIR"] = self._previous
        shutil.rmtree(self.data_dir, ignore_errors=True)
        shutil.rmtree(self.work, ignore_errors=True)

    def bundle(self) -> dict:
        return support.collect()


class CollectTests(SupportTestCase):
    def test_it_reports_the_machine_and_the_store(self):
        bundle = self.bundle()

        self.assertEqual(bundle["secretsIncluded"], False)
        self.assertEqual(bundle["counts"]["secrets"], 1)
        self.assertEqual(bundle["counts"]["chat_messages"], 1)
        self.assertTrue(bundle["paths"]["database"].endswith(".db"))
        self.assertEqual(bundle["settings"]["theme"], {"id": "obsidian"})
        self.assertIsInstance(bundle["crashes"], list)

    def test_no_credential_value_survives(self):
        # The load-bearing assertion: this whole file gets pasted in public.
        blob = json.dumps(self.bundle(), default=str)
        self.assertNotIn(SECRET, blob)
        self.assertNotIn(INLINE_SECRET, blob)
        # Redaction kept the shape, so the reader can tell *that* a key was set.
        self.assertIn("***", blob)

    def test_the_transcript_is_not_shipped(self):
        blob = json.dumps(self.bundle(), default=str)
        self.assertNotIn(TRANSCRIPT, blob)
        # It is still counted, so an empty transcript and an unreadable one differ.
        self.assertIn("chat_messages", blob)

    def test_a_recent_crash_rides_along_redacted(self):
        crash_log.record({"where": "chat.send", "error": f"401 with key {SECRET}"})

        bundle = self.bundle()

        self.assertEqual(len(bundle["crashes"]), 1)
        entry = json.dumps(bundle["crashes"][0])
        self.assertIn("chat.send", entry)
        self.assertNotIn(SECRET, entry)

    def test_absolute_home_paths_do_not_reach_a_public_issue(self):
        # `agent_threads` is keyed by project path, so the leak is in the *keys*,
        # not the values — which is exactly what value-only redaction misses.
        home = str(Path.home())
        app_db.set_setting("agent_threads", {f"{home}/work/lighthouse": "thread-1"})
        app_db.set_setting("last_project", {"path": f"{home}/work/lighthouse/src"})

        blob = json.dumps(self.bundle(), default=str)

        self.assertNotIn(home, blob)
        self.assertIn("~/work/lighthouse", blob)


class ShortenTests(unittest.TestCase):
    def test_it_rewrites_keys_as_well_as_values(self):
        home = "/Users/someone"
        shortened = support._shorten(
            {f"{home}/work/api": [f"{home}/work/api/src", {"deep": f"{home}/x"}]},
            home,
        )
        self.assertEqual(
            shortened,
            {"~/work/api": ["~/work/api/src", {"deep": "~/x"}]},
        )

    def test_it_leaves_unrelated_text_and_types_alone(self):
        self.assertEqual(support._shorten("plain text", "/Users/someone"), "plain text")
        self.assertEqual(support._shorten(7, "/Users/someone"), 7)
        self.assertIsNone(support._shorten(None, "/Users/someone"))

class CliTests(SupportTestCase):
    def test_it_writes_a_bundle_the_user_can_attach(self):
        out = self.work / "support.json"
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            self.assertEqual(support.main(["bundle", str(out)]), 0)

        self.assertIn('"ok": true', buffer.getvalue())
        self.assertNotIn(SECRET, out.read_text())
        self.assertEqual(json.loads(out.read_text())["secretsIncluded"], False)

    def test_the_bundle_is_owner_only(self):
        out = self.work / "support.json"
        with redirect_stdout(io.StringIO()):
            support.main(["bundle", str(out)])
        self.assertEqual(out.stat().st_mode & 0o777, 0o600)

    def test_bad_usage_returns_nonzero(self):
        for bad in ([], ["bundle"], ["nonsense"]):
            with redirect_stdout(io.StringIO()):
                self.assertNotEqual(support.main(bad), 0)

    def test_an_unwritable_path_reports_rather_than_raises(self):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = support.main(["bundle", str(self.work / "nested" / "\0bad.json")])
        self.assertEqual(code, 1)
        self.assertIn('"ok": false', buffer.getvalue())


if __name__ == "__main__":
    unittest.main()


if __name__ == "__main__":
    unittest.main()


class VersionsTests(unittest.TestCase):
    """What the Performance panel's runtime line reads.

    It used to read three fields nothing supplied, so the line said
    "Node unknown · Vite unknown · Python unknown" on every machine. The Python
    version in particular cannot come from the shell: a packaged build carries an
    embedded interpreter, so asking the *machine* would answer with one this app
    does not use — or with nothing.
    """

    def test_versions_reports_the_interpreter_it_is_running_in(self):
        data = support.versions()
        self.assertEqual(data["python"], platform.python_version())
        self.assertIn("platform", data)
        self.assertIn("machine", data)

    def test_node_is_probed_and_absence_is_not_an_error(self):
        # The app does not run on Node; an npx-based MCP server would. A machine
        # without it gets "", which the panel renders as a dash rather than as a
        # version that is not there.
        data = support.versions()
        self.assertIsInstance(data["node"], str)

    def test_the_command_prints_an_envelope_the_ipc_path_can_unwrap(self):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = support.main(["versions"])
        self.assertEqual(code, 0)
        payload = json.loads(buffer.getvalue())
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["data"]["python"], platform.python_version())

