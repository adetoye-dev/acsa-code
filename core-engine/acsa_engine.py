#!/usr/bin/env python3
"""acsa_engine.py — one entry point for the whole Python engine.

The app shells out to Python for its backend, and an end user cannot be assumed
to have an interpreter: macOS no longer ships a usable one and Windows ships
none. This module is the single entry point, so the engine can be frozen into a
self-contained binary:

    acsa-engine db settings.get '{}'
    acsa-engine index --project-root ... --json
    acsa-engine git status '{}'
    acsa-engine pty

It is equally the development entry point (`python3 core-engine/acsa_engine.py
manager …`), so the freeze adds a packaging step rather than a second code path.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path


def _bundle_root() -> Path:
    """Directory holding the engine modules.

    PyInstaller unpacks to `sys._MEIPASS`; running from source it is this file's
    directory. Everything is resolved from here so both cases behave the same.
    """
    meipass = getattr(sys, "_MEIPASS", None)
    return Path(meipass) if meipass else Path(__file__).resolve().parent


def _extend_path() -> Path:
    root = _bundle_root()
    for sub in ("", "data-map", "mcp_servers", "skills"):
        candidate = (root / sub) if sub else root
        if candidate.is_dir() and str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))
    # `pty_bridge.py` lives in the repository's scripts/ directory, not in the
    # engine package. A frozen build has already collected it as a top-level
    # module; running from source needs this path, or `pty` fails to import and
    # the integrated terminal exits with "No module named 'pty_bridge'".
    repo_scripts = root.parent / "scripts"
    if repo_scripts.is_dir() and str(repo_scripts) not in sys.path:
        sys.path.insert(0, str(repo_scripts))
    return root


ROOT = _extend_path()

# subcommand -> (module, entry function)
COMMANDS: dict[str, tuple[str, str]] = {
    "db": ("db_cli", "run"),
    "index": ("project_indexer", "main"),
    "pty": ("pty_bridge", "main"),
    "ollama": ("ollama_cli", "run"),
    "git": ("git_cli", "run"),
    # The remote's state — checks, pull requests, your issues — through the `gh`
    # the user already signed into. See gh_cli for why it is not a token of ours.
    "gh": ("gh_cli", "run"),
    "indexer": ("indexer_cli", "run"),
    "skills": ("skills_cli", "run"),
    "mcp": ("mcp_cli", "run"),
    "ai": ("ai_cli", "run"),
    "project": ("project_cli", "run"),
    "fs": ("fs_cli", "run"),
    "adapter": ("responses_adapter", "main"),
    "crash": ("crash_log", "main"),
    "backup": ("backup", "main"),
    "support": ("support", "main"),
    # The file half of "undo this turn": the runtime's own rollback/revert
    # primitives both state that they do not revert local file changes, so the
    # pre-turn state has to be captured before a turn runs.
    "snapshot": ("snapshot_cli", "run"),
}


def _selftest_report() -> tuple[dict[str, object], dict[str, str]]:
    """Every reason this build cannot work, as `(tls, failures)`.

    Split from the printing so a test can assert on it directly: the TLS check
    below is the only thing standing between a capless freeze and a user whose
    every hosted-model call fails, and it has to be falsifiable.
    """
    failures: dict[str, str] = {}
    for name, (module_name, _func) in COMMANDS.items():
        try:
            importlib.import_module(module_name)
        except Exception as exc:  # noqa: BLE001 - the report is the point
            failures[name] = f"{type(exc).__name__}: {exc}"

    # A frozen engine inherits the CA store of whatever interpreter froze it, and
    # PyInstaller adds none. A python.org framework build missing its
    # `etc/openssl/cert.pem` (that file only appears after the installer's
    # `Install Certificates.command`) reports ZERO roots, and then nothing
    # over HTTPS can be verified: every hosted-model call — provider test, chat,
    # inline edit, review — dies with CERTIFICATE_VERIFY_FAILED, on a machine
    # where the browser is fine. That is not hypothetical: 0.2.6 shipped that way.
    # Asserting it here makes the `sidecar` job fail instead of the user.
    try:
        import tls_context

        tls: dict[str, object] = dict(tls_context.describe())
        if not tls.get("certificates"):
            failures["tls"] = (
                "no CA certificates: every HTTPS call will fail with "
                "CERTIFICATE_VERIFY_FAILED"
            )
    except Exception as exc:  # noqa: BLE001 - report, do not traceback at the user
        tls = {"error": f"{type(exc).__name__}: {exc}"}
        failures["tls"] = str(tls["error"])
    return tls, failures


def _selftest() -> int:
    """Import every entry point and report what failed.

    Each subcommand is reached through `importlib`, so a module that the runtime
    cannot see fails only when that subcommand is used — which is how a missing
    `scripts/` path silently broke the integrated terminal. This makes the whole
    surface checkable in one call, in both source and frozen mode.
    """
    tls, failures = _selftest_report()

    print(
        json.dumps(
            {
                "ok": not failures,
                "data": {
                    "root": str(ROOT),
                    "frozen": bool(getattr(sys, "_MEIPASS", None)),
                    "checked": sorted(COMMANDS),
                    "tls": tls,
                    "failures": failures,
                },
            }
        )
    )
    return 0 if not failures else 1


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"usage: acsa-engine <{'|'.join([*COMMANDS, 'selftest'])}> [args...]",
                }
            )
        )
        return 2

    if argv[0] == "selftest":
        return _selftest()

    name, rest = argv[0], argv[1:]
    entry = COMMANDS.get(name)
    if entry is None:
        print(json.dumps({"ok": False, "error": f"unknown command: {name}"}))
        return 2

    module_name, func_name = entry
    try:
        module = importlib.import_module(module_name)
    except Exception as exc:  # noqa: BLE001 - report, do not traceback at the user
        print(json.dumps({"ok": False, "error": f"cannot load {module_name}: {exc}"}))
        return 1

    func = getattr(module, func_name)
    # Each module reads sys.argv; present the subcommand's own arguments.
    sys.argv = [f"acsa-engine {name}", *rest]
    result = func(sys.argv) if func_name == "run" else func()
    return result if isinstance(result, int) else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
