"""log_setup.py — one structured logger, on stdout and in a rotating file.

The engine's loggers each configured themselves: a `StreamHandler` on stdout, a
JSON format string, and the component name written into that string by hand. Three
modules meant three copies, and a fourth would mean a fourth. It also meant the
engine's own diagnostics existed only on stdout — which the app reads and forwards
to the OUTPUT panel and then forgets. So a packaged build that misbehaved left
nothing to look at afterwards, and "no rotation or retention" was really "no file".

This is the one place a logger is built. It writes the same line to stdout (the app
parses the last of them for its envelope) and to `logs/engine.log` in the data
directory, rotating at 2 MB and keeping two older files. Standard library only: the
engine is frozen into a sidecar and stdlib-only on purpose.

    from log_setup import configure
    logger = configure("ProjectIndexer")
"""

from __future__ import annotations

import json
import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

# A cap, not a policy: two megabytes is weeks of ordinary engine output, and two
# older files mean a crash loop cannot fill a disk.
MAX_BYTES = 2 * 1024 * 1024
BACKUP_COUNT = 2


class JsonFormatter(logging.Formatter):
    """One line of JSON per record, with the component taken from the logger name."""

    def format(self, record: logging.LogRecord) -> str:
        return json.dumps(
            {
                "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
                "level": record.levelname,
                "component": record.name,
                "message": record.getMessage(),
            }
        )


def log_dir() -> Path:
    """Where engine logs live. Resolved late, so `ACSA_DATA_DIR` still wins."""
    import app_db  # the one place that decides where app state lives

    return app_db.data_dir() / "logs"


def log_file() -> Path:
    return log_dir() / "engine.log"


def configure(name: str) -> logging.Logger:
    """The logger for `name`, set up once.

    Idempotent: a module that is imported twice, or a test that re-imports it, must
    not end up with two handlers writing each line twice.
    """
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger

    formatter = JsonFormatter()
    stdout = logging.StreamHandler(sys.stdout)
    stdout.setFormatter(formatter)
    logger.addHandler(stdout)

    try:
        path = log_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        to_file = RotatingFileHandler(
            path, maxBytes=MAX_BYTES, backupCount=BACKUP_COUNT, encoding="utf-8"
        )
        to_file.setFormatter(formatter)
        logger.addHandler(to_file)
    except OSError:
        # An unwritable data directory is not worth failing a run over, and stdout
        # still carries every line. The app's exit code reports the real problem.
        pass

    logger.setLevel(logging.INFO)
    return logger
