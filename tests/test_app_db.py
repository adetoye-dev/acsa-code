"""The app's own database: one owner, secrets kept out of the UI."""

import importlib
import json
import os
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import app_db


class AppDbTestCase(unittest.TestCase):
    """Every test gets a private database so the real one is never touched."""

    def setUp(self):
        self.data_dir = Path(tempfile.mkdtemp(prefix="acsa-appdb-"))
        self._previous = os.environ.get("ACSA_DATA_DIR")
        os.environ["ACSA_DATA_DIR"] = str(self.data_dir)
        importlib.reload(app_db)
        app_db.init_db()

    def tearDown(self):
        if self._previous is None:
            os.environ.pop("ACSA_DATA_DIR", None)
        else:
            os.environ["ACSA_DATA_DIR"] = self._previous
        shutil.rmtree(self.data_dir, ignore_errors=True)
        importlib.reload(app_db)


class SchemaTests(AppDbTestCase):
    def test_a_scoped_connection_closes_when_its_block_ends(self):
        # `with sqlite3.connect(...) as conn` only commits; it does not close.
        # The connection here is a subclass that does, because every caller
        # treats the block as the connection's lifetime — and the ones that did
        # not left open handles for the collector (Python 3.14 warns about it).
        with app_db.connect() as conn:
            self.assertEqual(conn.execute("SELECT 1").fetchone()[0], 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            conn.execute("SELECT 1")

    def test_database_file_is_owner_only(self):
        app_db.connect().close()
        mode = stat.S_IMODE(app_db.db_path().stat().st_mode)
        self.assertEqual(mode, 0o600, f"expected 0600, got {oct(mode)}")

    def test_migrations_are_idempotent(self):
        app_db.init_db()
        app_db.init_db()
        with app_db.connect() as conn:
            applied = conn.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0]
        self.assertEqual(applied, app_db.SCHEMA_VERSION)

    def test_expected_tables_exist(self):
        with app_db.connect() as conn:
            names = {
                row[0]
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
        for table in ("settings", "providers", "secrets", "projects", "chat_messages",
                      "usage_events"):
            self.assertIn(table, names)


class SettingsAndProvidersTests(AppDbTestCase):
    def test_settings_round_trip_json_values(self):
        app_db.set_setting("selected_model", {"id": "m", "n": 2})
        app_db.set_setting("ollama_ready", True)
        settings = app_db.get_settings()
        self.assertEqual(settings["selected_model"], {"id": "m", "n": 2})
        self.assertIs(settings["ollama_ready"], True)

    def test_provider_upsert_is_partial(self):
        app_db.upsert_provider("deepseek", base_url="https://api.deepseek.com/v1")
        app_db.upsert_provider("deepseek", selected_model="deepseek-flash")
        provider = app_db.get_providers()["deepseek"]
        self.assertEqual(provider["baseUrl"], "https://api.deepseek.com/v1")
        self.assertEqual(provider["selectedModel"], "deepseek-flash")

    def test_providers_report_key_presence_without_the_key(self):
        app_db.set_secret("deepseek_api_key", "sk-super-secret")
        provider = app_db.get_providers().get("deepseek")
        # No providers row needed for the flag to be meaningful, but the settings
        # payload itself must never carry the value.
        self.assertNotIn("sk-super-secret", json.dumps(app_db.get_providers()))
        self.assertTrue(app_db.has_secret("deepseek_api_key"))
        if provider is not None:
            self.assertTrue(provider["hasApiKey"])

    def test_clearing_a_secret_with_empty_value(self):
        app_db.set_secret("groq_api_key", "abc")
        app_db.set_secret("groq_api_key", "")
        self.assertFalse(app_db.has_secret("groq_api_key"))


class SecretResolutionTests(AppDbTestCase):
    def test_environment_wins_over_the_database(self):
        app_db.set_secret("deepseek_api_key", "from-database")
        os.environ["ACSA_DEEPSEEK_API_KEY"] = "from-environment"
        try:
            self.assertEqual(app_db.resolve_api_key("deepseek"), "from-environment")
        finally:
            os.environ.pop("ACSA_DEEPSEEK_API_KEY", None)
        self.assertEqual(app_db.resolve_api_key("deepseek"), "from-database")

    def test_generic_environment_key_is_a_fallback(self):
        os.environ["AIDE_API_KEY"] = "generic-env-key"
        try:
            self.assertEqual(app_db.resolve_api_key("openai"), "generic-env-key")
        finally:
            os.environ.pop("AIDE_API_KEY", None)

    def test_resolution_is_none_when_nothing_is_configured(self):
        os.environ.pop("AIDE_API_KEY", None)
        os.environ.pop("ACSA_API_KEY", None)
        self.assertIsNone(app_db.resolve_api_key("openai"))


class ProjectRegistryTests(AppDbTestCase):
    def test_active_project_is_singular_and_tracks_the_latest(self):
        app_db.touch_project("/tmp/one", "one")
        app_db.touch_project("/tmp/two", "two")
        self.assertEqual(app_db.get_active_project()["path"], "/tmp/two")
        with app_db.connect() as conn:
            active = conn.execute("SELECT COUNT(*) FROM projects WHERE is_active = 1").fetchone()[0]
        self.assertEqual(active, 1)
        self.assertEqual([p["path"] for p in app_db.list_projects()][0], "/tmp/two")

    def test_a_remembered_project_whose_folder_is_gone_is_flagged_not_dropped(self):
        # A project row outlives its folder, and the switcher only shows three, so
        # the UI has to be able to tell a live row from a dead one. Flagged rather
        # than deleted: a folder can come back (an unmounted volume, a rename), and
        # discarding the user's history is not the database's call.
        alive = os.path.join(str(self.data_dir), "alive")
        os.makedirs(alive, exist_ok=True)
        app_db.touch_project(alive, "alive")
        app_db.touch_project(os.path.join(str(self.data_dir), "deleted-by-hand"), "gone")

        rows = {row["path"]: row for row in app_db.list_projects()}
        self.assertIn(os.path.join(str(self.data_dir), "deleted-by-hand"), rows)
        self.assertTrue(rows[os.path.join(str(self.data_dir), "deleted-by-hand")]["missing"])
        self.assertFalse(rows[alive]["missing"])

        # And it is still there afterwards: flagged, not pruned.
        self.assertEqual(len(app_db.list_projects()), 2)

    def test_forget_project_also_drops_its_transcript(self):
        app_db.touch_project("/tmp/one", "one")
        app_db.save_chat("/tmp/one", [{"id": "m1", "role": "user", "content": "hi", "timestamp": 1_700_000_000_000}])
        app_db.forget_project("/tmp/one")
        self.assertEqual(app_db.list_projects(), [])
        self.assertEqual(app_db.load_chat("/tmp/one"), [])


class ChatHistoryTests(AppDbTestCase):
    def test_round_trip_and_project_isolation(self):
        messages = [
            {"id": "m1", "role": "user", "content": "build a thing", "timestamp": 1_700_000_000_000},
            {"id": "m2", "role": "assistant", "content": "done", "model": "deepseek-flash", "timestamp": 1_700_000_001_000},
        ]
        app_db.save_chat("/tmp/a", messages)
        app_db.save_chat("/tmp/b", [{"id": "x", "role": "user", "content": "other", "timestamp": 1}])
        loaded = app_db.load_chat("/tmp/a")
        self.assertEqual([m["id"] for m in loaded], ["m1", "m2"])
        self.assertEqual(loaded[1]["model"], "deepseek-flash")
        self.assertEqual([m["content"] for m in app_db.load_chat("/tmp/b")], ["other"])

    def test_saving_replaces_rather_than_appends(self):
        app_db.save_chat("/tmp/a", [{"id": "m1", "role": "user", "content": "one", "timestamp": 1}])
        app_db.save_chat("/tmp/a", [{"id": "m2", "role": "user", "content": "two", "timestamp": 2}])
        self.assertEqual([m["content"] for m in app_db.load_chat("/tmp/a")], ["two"])

    def test_error_and_provider_flags_survive(self):
        app_db.save_chat("/tmp/a", [
            {"id": "m1", "role": "assistant", "content": "boom", "error": True, "provider": "deepseek", "timestamp": 5}
        ])
        message = app_db.load_chat("/tmp/a")[0]
        self.assertTrue(message["error"])
        self.assertEqual(message["provider"], "deepseek")

    def test_ui_only_fields_round_trip(self):
        # Attached images and step telemetry live only on the message object, so
        # the stored payload has to carry them.
        app_db.save_chat("/tmp/a", [
            {
                "id": "m1",
                "role": "user",
                "content": "look at this",
                "images": ["data:image/png;base64,AAAA"],
                "steps": [{"name": "Read File", "status": "done"}],
                "timestamp": 5,
            }
        ])
        message = app_db.load_chat("/tmp/a")[0]
        self.assertEqual(message["images"], ["data:image/png;base64,AAAA"])
        self.assertEqual(message["steps"][0]["name"], "Read File")

    def test_the_change_log_survives_a_reload(self):
        # The chat shows "Edited N files +X −Y" from the message itself, so a
        # field that failed to round-trip would mean the log vanished on reload —
        # which is the whole reason logging was chosen over gating writes.
        app_db.save_chat("/tmp/a", [
            {
                "id": "m1",
                "role": "assistant",
                "content": "done",
                "changes": [
                    {"path": "src/App.tsx", "added": 5, "removed": 0},
                    {"path": "src/main.tsx", "added": 4, "removed": 1},
                ],
                "timestamp": 5,
            }
        ])
        changes = app_db.load_chat("/tmp/a")[0]["changes"]
        self.assertEqual([c["path"] for c in changes], ["src/App.tsx", "src/main.tsx"])
        self.assertEqual(changes[1], {"path": "src/main.tsx", "added": 4, "removed": 1})


class UsageLedgerTests(AppDbTestCase):
    def test_summary_aggregates_and_filters(self):
        app_db.record_usage("deepseek", "deepseek-flash", 100, 50, 1200.0, 0.01, "/tmp/a")
        app_db.record_usage("deepseek", "deepseek-flash", 200, 80, 900.0, 0.02, "/tmp/a")
        app_db.record_usage("ollama", "qwen2.5-coder:7b", 10, 5, 100.0, 0.0, "/tmp/b")

        everything = app_db.usage_summary()
        self.assertEqual(everything["total_calls"], 3)
        self.assertEqual(everything["prompt_tokens"], 310)
        self.assertEqual(everything["total_tokens"], 310 + 135)
        self.assertAlmostEqual(everything["cost_usd"], 0.03, places=6)
        # One entry per day of the window, even on days with no activity.
        self.assertEqual(len(everything["daily"]), 14)
        self.assertEqual(sum(day["calls"] for day in everything["daily"]), 3)
        self.assertEqual(len(everything["recent"]), 3)

        scoped = app_db.usage_summary("/tmp/a")
        self.assertEqual(scoped["total_calls"], 2)
        self.assertEqual([row["model"] for row in scoped["by_model"]], ["deepseek-flash"])

    def test_cost_is_derived_when_the_caller_omits_it(self):
        # Callers used to pass cost_usd=0 for hosted providers, so the spend
        # panel read $0.00 while real money was being spent.
        app_db.record_usage("deepseek", "deepseek-flash", 1_000_000, 1_000_000)
        row = app_db.usage_summary()["recent"][0]
        self.assertAlmostEqual(row["cost_usd"], 0.27 + 1.10, places=6)

    def test_local_models_are_free(self):
        app_db.record_usage("ollama", "qwen2.5-coder:7b", 10_000, 10_000)
        self.assertEqual(app_db.usage_summary()["recent"][0]["cost_usd"], 0.0)

    def test_the_ledger_does_not_grow_without_bound(self):
        # The one table nothing bounded: the chat is trimmed to its most recent
        # messages, but every call ever made stayed here forever — a row per model
        # call, each with a project path and a model name. A slow leak rather than a
        # bug, which is why it survived: nothing breaks until a database nobody
        # looks at is large.
        old = time.time() - (app_db.USAGE_RETENTION_DAYS + 10) * 86_400
        with app_db.connect() as conn:
            conn.execute(
                "INSERT INTO usage_events (ts, provider, model, prompt_tokens,"
                " completion_tokens, latency_ms, cost_usd)"
                " VALUES (?, 'deepseek', 'deepseek-flash', 1, 1, 1, 0)",
                (old,),
            )

        # Writing a call is what prunes, so there is no schedule to forget.
        app_db.record_usage("deepseek", "deepseek-flash", 10, 5)

        with app_db.connect() as conn:
            remaining = conn.execute("SELECT ts FROM usage_events").fetchall()
        self.assertEqual(len(remaining), 1, "the out-of-window row should be gone")
        self.assertGreater(remaining[0]["ts"], old)

    def test_pruning_keeps_the_window_the_page_draws(self):
        # Fourteen days are drawn; ninety are kept. A row inside the window must
        # survive, or the Performance page would lose history it is meant to show.
        inside = time.time() - 20 * 86_400
        with app_db.connect() as conn:
            conn.execute(
                "INSERT INTO usage_events (ts, provider, model, prompt_tokens,"
                " completion_tokens, latency_ms, cost_usd)"
                " VALUES (?, 'deepseek', 'deepseek-flash', 1, 1, 1, 0)",
                (inside,),
            )
        app_db.record_usage("deepseek", "deepseek-flash", 10, 5)
        with app_db.connect() as conn:
            kept = conn.execute("SELECT COUNT(*) AS n FROM usage_events").fetchone()["n"]
        self.assertEqual(kept, 2)


class DatabaseCliTests(AppDbTestCase):
    """The bridge and the packaged app talk to the database through this CLI."""

    def _run(self, *args, stdin: str = ""):
        cli = Path(__file__).resolve().parent.parent / "core-engine" / "db_cli.py"
        env = {**os.environ, "ACSA_DATA_DIR": str(self.data_dir)}
        proc = subprocess.run(
            [sys.executable, str(cli), *args],
            input=stdin, capture_output=True, text=True, env=env, timeout=60,
        )
        return proc.returncode, json.loads(proc.stdout.strip().splitlines()[-1])

    def test_settings_and_secret_round_trip(self):
        code, out = self._run("settings.set", json.dumps({"key": "k", "value": {"a": 1}}))
        self.assertEqual(code, 0, out)
        self.assertTrue(out["ok"])

        code, out = self._run("secrets.set", json.dumps({"name": "openai_api_key", "value": "sk-1"}))
        self.assertTrue(out["ok"])

        _, out = self._run("providers.resolveKey", json.dumps({"id": "openai"}))
        self.assertEqual(out["data"], "sk-1")

        _, out = self._run("secrets.list")
        self.assertEqual(out["data"], ["openai_api_key"])

    def test_resolved_key_never_appears_in_providers_payload(self):
        self._run("secrets.set", json.dumps({"name": "deepseek_api_key", "value": "sk-secret"}))
        self._run("providers.upsert", json.dumps({"id": "deepseek", "selectedModel": "deepseek-flash"}))
        _, out = self._run("providers.get")
        self.assertNotIn("sk-secret", json.dumps(out))
        self.assertTrue(out["data"]["deepseek"]["hasApiKey"])

    def test_project_and_chat_commands(self):
        self._run("projects.touch", json.dumps({"path": "/tmp/x", "name": "x"}))
        _, out = self._run("projects.active")
        self.assertEqual(out["data"]["path"], "/tmp/x")

        self._run("chat.save", json.dumps({
            "projectPath": "/tmp/x",
            "messages": [{"id": "m1", "role": "user", "content": "hi", "timestamp": 1}],
        }))
        _, out = self._run("chat.load", json.dumps({"projectPath": "/tmp/x"}))
        self.assertEqual(out["data"][0]["content"], "hi")

    def test_a_turns_change_log_survives_the_round_trip(self):
        # The checklist called this "live-only ... a log that scrolls back needs it
        # persisted as a transcript entry". It already is: `save_chat` stores the
        # whole message object in `payload` and `load_chat` merges it back, so the
        # file counts a turn reported are still on the message after a relaunch.
        # Pinned because the failure would be silent — the card would simply not be
        # there on the older messages, which reads as "nothing happened" rather than
        # as a lost field.
        changes = [{"path": "src/a.ts", "added": 3, "removed": 1}]
        self._run("chat.save", json.dumps({
            "projectPath": "/tmp/x",
            "messages": [{
                "id": "m1", "role": "assistant", "content": "Done.", "timestamp": 2,
                "changes": changes,
            }],
        }))
        _, out = self._run("chat.load", json.dumps({"projectPath": "/tmp/x"}))
        self.assertEqual(out["data"][0]["changes"], changes)

    def test_the_accounts_surface_is_gone_not_dormant(self):
        # Removed on purpose, so this pins the removal: an unreachable endpoint
        # with no screen is a claim the app cannot back, and it is the sort of
        # thing that quietly comes back.
        for command in ("auth.register", "auth.login", "auth.me", "accounts.list"):
            code, _ = self._run(command, json.dumps({"email": "a@b.com", "password": "pw"}))
            self.assertNotEqual(code, 0, f"{command} still exists")

    def test_unknown_command_is_reported(self):
        code, out = self._run("nope.nope")
        self.assertEqual(code, 2)
        self.assertFalse(out["ok"])


if __name__ == "__main__":
    unittest.main()
