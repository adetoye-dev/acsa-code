"""The engine's structured log: one line of JSON, on stdout and in a file.

The engine's loggers each configured themselves before this, and nothing wrote a
file — so the diagnostics of a packaged build existed only on a stdout the app
parsed and forgot. "No rotation or retention" was really "no file".
"""

import importlib
import json
import logging
import os
import shutil
import sys
import tempfile
import unittest
from logging.handlers import RotatingFileHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core-engine"))

import app_db  # noqa: E402
import log_setup  # noqa: E402


def quiet(logger: logging.Logger) -> logging.Logger:
    """Drop the stdout handler, so a test's log lines do not fill the CI output.

    The file handler is the one under test; stdout is the same bytes going somewhere
    else. `RotatingFileHandler` subclasses `StreamHandler`, hence the exclusion.
    """
    for handler in list(logger.handlers):
        if isinstance(handler, logging.StreamHandler) and not isinstance(handler, RotatingFileHandler):
            logger.removeHandler(handler)
    return logger


class LogSetupTests(unittest.TestCase):
    def setUp(self):
        self.data_dir = Path(tempfile.mkdtemp(prefix="acsa-logs-"))
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

    def test_a_line_is_json_with_the_component_taken_from_the_logger_name(self):
        # The component used to be written into each module's own format string, so
        # a new logger meant copying a format and hoping the name matched.
        logger = quiet(log_setup.configure("TestComponent"))
        logger.info("hello from the engine")

        lines = log_setup.log_file().read_text(encoding="utf-8").strip().splitlines()
        record = json.loads(lines[-1])
        self.assertEqual(record["component"], "TestComponent")
        self.assertEqual(record["message"], "hello from the engine")
        self.assertEqual(record["level"], "INFO")
        self.assertIn("ts", record)

    def test_the_log_lands_in_the_data_directory(self):
        log_setup.configure("WhereComponent")
        self.assertEqual(log_setup.log_file().parent, self.data_dir / "logs")

    def test_configuring_twice_does_not_write_every_line_twice(self):
        # A module imported twice, or a test that reloads it, must not end up with
        # two handlers — every line would appear twice in the panel.
        first = log_setup.configure("TwiceComponent")
        second = log_setup.configure("TwiceComponent")
        self.assertIs(first, second)
        self.assertEqual(
            len([h for h in first.handlers if isinstance(h, RotatingFileHandler)]), 1
        )

    def test_the_file_rotates_and_keeps_a_bounded_number_of_files(self):
        # The point of the item: without a cap, the log grows for as long as the app
        # is installed.
        original = log_setup.MAX_BYTES
        log_setup.MAX_BYTES = 512
        try:
            logger = quiet(log_setup.configure("RotatingComponent"))
            for index in range(200):
                logger.info("line %d %s", index, "x" * 40)
            files = sorted(path.name for path in log_setup.log_dir().iterdir())
        finally:
            log_setup.MAX_BYTES = original

        self.assertIn("engine.log", files)
        # The live file plus at most BACKUP_COUNT older ones.
        self.assertLessEqual(len(files), log_setup.BACKUP_COUNT + 1)
        self.assertGreater(len(files), 1, "rotation should have produced an older file")


if __name__ == "__main__":
    unittest.main()
