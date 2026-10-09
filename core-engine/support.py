"""support.py — one file to attach to a bug report.

The app sends no telemetry, so when something goes wrong the user has to be able
to hand over the evidence themselves. This collects it in one place: versions,
paths, row counts, the settings that are *not* secret, and the crash log.

Three deliberate omissions, because a support bundle is exactly the file people
paste into a public issue:

* **No credential values.** The `secrets` table is counted, never read.
* **No chat history.** Prompts and file contents live there.
* **No environment dump.** It would carry every API key in the shell.

Settings are still run through the crash-log redactor before being written, so a
key that was pasted into a settings *value* does not slip out that way.

Paths are shortened to `~` before they are written. A support bundle is a public
artifact, and the settings carry absolute project paths — `~/work/api` says as
much about the bug as `/Users/ada/work/api` does, without naming the machine's
owner.

Reached as `acsa-engine support bundle <path>`.
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path

import app_db
import crash_log


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _shorten(value, home: str):
    """Rewrite absolute home paths to `~`, in keys as well as values.

    The settings that matter here are keyed by project path (`agent_threads`),
    so redacting values alone would miss the very strings worth hiding.
    """
    if isinstance(value, str):
        return value.replace(home, "~") if home else value
    if isinstance(value, dict):
        return {_shorten(k, home): _shorten(v, home) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_shorten(item, home) for item in value]
    return value


def _count(conn, table: str) -> int:
    try:
        return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    except Exception:  # noqa: BLE001 - a missing table is information, not a failure
        return -1


def collect() -> dict:
    """Everything worth knowing, and nothing worth leaking."""
    settings = app_db.get_settings()
    redacted_settings = {
        key: crash_log._clean(value) for key, value in sorted(settings.items())
    }

    with app_db.connect() as conn:
        counts = {
            table: _count(conn, table)
            for table in ("providers", "projects", "chat_messages", "usage_events", "secrets")
        }
        schema_row = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()
        schema_version = schema_row[0] if schema_row else None

    database = app_db.db_path()
    bundle = {
        "generatedAt": time.time(),
        "app": {
            "version": os.environ.get("ACSA_APP_VERSION", ""),
            "schemaVersion": schema_version,
        },
        "system": {
            "platform": sys.platform,
            "release": platform.release(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "paths": {
            "dataDir": str(app_db.data_dir()),
            "database": str(database),
            "databaseBytes": _size(database),
            "crashLog": str(crash_log.log_path()),
            "crashLogBytes": _size(crash_log.log_path()),
        },
        "counts": counts,
        # Counted above, never read. Said plainly so a reader of the bundle knows.
        "secretsIncluded": False,
        "settings": redacted_settings,
        "crashes": crash_log.read(20),
    }

    home = str(Path.home())
    # A home directory of "/" or "" would rewrite the whole bundle, so only a
    # real, specific prefix is worth shortening.
    return _shorten(bundle, home) if len(home) > 1 else bundle


def _probe_version(command: str, *args: str) -> str:
    """The version a tool prints, or "" when it is not installed.

    Not an error: Node is optional here, and the panel would rather say so than
    show a version this machine does not have.
    """
    try:
        completed = subprocess.run(
            [command, *args], capture_output=True, text=True, timeout=5
        )
        return completed.stdout.strip().lstrip("v")
    except (OSError, subprocess.SubprocessError):
        return ""


def versions() -> dict:
    """What this app runs on, for the Performance panel's runtime line.

    The engine is the only part that knows its own interpreter: a packaged build
    carries an embedded Python, so asking the *machine* for `python3 --version`
    would report a version this app does not use, or nothing at all. Node is
    probed rather than assumed, because the app does not run on Node — the version
    that matters is whichever one an npx-based MCP server would get.
    """
    return {
        "python": platform.python_version(),
        "node": _probe_version("node", "--version"),
        "platform": sys.platform,
        "machine": platform.machine(),
    }


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    action = args[0] if args else "bundle"

    if action == "versions":
        print(json.dumps({"ok": True, "data": versions()}))
        return 0
    if action != "bundle":
        print(json.dumps({"ok": False, "error": "usage: support bundle <path> | support versions"}))
        return 2
    if len(args) < 2:
        print(json.dumps({"ok": False, "error": "support bundle needs a destination path"}))
        return 2

    destination = Path(args[1]).expanduser()
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        bundle = collect()
        destination.write_text(json.dumps(bundle, indent=2, default=str) + "\n")
        try:
            os.chmod(destination, 0o600)
        except OSError:
            pass
    except Exception as exc:  # noqa: BLE001 - reported, not traced back at the user
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 1

    print(
        json.dumps(
            {"ok": True, "data": {"path": str(destination), "bytes": destination.stat().st_size}}
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
