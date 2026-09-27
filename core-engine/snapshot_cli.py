#!/usr/bin/env python3
"""snapshot_cli.py — the file half of "undo this turn".

The agent runtime cannot do this for us. Both of its history primitives say so in
their own schemas: `thread/rollback` ("DEPRECATED ... This only modifies the
thread's history and does not revert local file changes that have been made by the
agent. Clients are responsible for reverting these changes.") and its replacement
`thread/revert` ("It does not revert local file changes."). So the pre-turn state
has to be captured before the turn runs, and that is what this does.

What is captured, and why only that:

Only files that were *already dirty* — modified, staged or untracked — at the
moment the turn started. A file that was clean then has its pre-turn content in
`HEAD`, so git can hand it back for free and copying the whole tree would be the
expensive way to learn nothing. The user's own uncommitted work is exactly the set
git already reports, and it is small: it is what one person has edited.

That is also what makes an undo *safe*. The trap the checklist called out is that
`git checkout -- <file>` would silently discard the user's own edits to the same
file; here those edits are the thing that was snapshotted, so restoring them is
the point rather than the casualty.

    acsa-engine snapshot take    '{"projectRoot": "...", "dataDir": "...", "turnId": "..."}'
    acsa-engine snapshot restore '{"projectRoot": "...", "dataDir": "...", "turnId": "...", "paths": [...]}'
    acsa-engine snapshot discard '{"dataDir": "...", "turnId": "..."}'
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# A snapshot that cannot be taken completely must say so rather than produce a
# half-undo: a partial restore would leave the project in a state nobody designed.
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024
# Snapshots are kept per turn and pruned oldest-first; a handful covers "undo what
# it just did" without letting them accumulate forever.
KEEP_SNAPSHOTS = 8


def _git(project_root: Path, *args: str) -> tuple[int, str]:
    proc = subprocess.run(
        ["git", *args],
        cwd=str(project_root),
        capture_output=True,
        text=True,
        check=False,
    )
    return proc.returncode, (proc.stdout or "")


def _dirty_files(project_root: Path) -> list[tuple[str, str]]:
    """`(status, path)` for everything git reports as not matching HEAD.

    `--no-renames` keeps the `-z` output one NUL-separated record per path: a
    rename would be two records and reading only the first would record a path
    that no longer exists.
    """
    code, out = _git(project_root, "status", "--porcelain", "-z", "--untracked-files=all", "--no-renames")
    if code != 0:
        return []
    entries: list[tuple[str, str]] = []
    for record in out.split("\0"):
        if len(record) < 4:
            continue
        entries.append((record[:2], record[3:]))
    return entries


def _snapshot_dir(data_dir: Path, turn_id: str) -> Path:
    return data_dir / "turn-snapshots" / turn_id


def _data_dir(payload: dict[str, Any]) -> Path:
    """Where snapshots live. An explicit `dataDir` wins — the tests use one so
    they never touch the real app state — and otherwise this is the engine's own
    resolver, so the page does not have to know or be trusted with it."""
    raw = str(payload.get("dataDir") or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    import app_db  # the single place that decides where app state lives

    return app_db.data_dir()


def _prune(data_dir: Path) -> None:
    root = data_dir / "turn-snapshots"
    if not root.is_dir():
        return
    dirs = sorted((d for d in root.iterdir() if d.is_dir()), key=lambda d: d.stat().st_mtime, reverse=True)
    for stale in dirs[KEEP_SNAPSHOTS:]:
        shutil.rmtree(stale, ignore_errors=True)


def take(payload: dict[str, Any]) -> tuple[dict[str, Any], int]:
    project_root = Path(str(payload.get("projectRoot") or "")).expanduser().resolve()
    data_dir = _data_dir(payload)
    turn_id = str(payload.get("turnId") or "").strip()
    if not project_root.is_dir() or not turn_id:
        return {"ok": False, "error": "projectRoot and turnId are required"}, 2

    dest = _snapshot_dir(data_dir, turn_id)
    files_dir = dest / "files"
    shutil.rmtree(dest, ignore_errors=True)
    files_dir.mkdir(parents=True, exist_ok=True)

    entries: dict[str, dict[str, Any]] = {}
    skipped: list[dict[str, str]] = []
    total = 0
    for status, rel in _dirty_files(project_root):
        source = project_root / rel
        # A path already deleted before the turn: recorded so that undo deletes it
        # again rather than resurrecting the version in HEAD.
        if status.strip() == "D" or not source.is_file():
            entries[rel] = {"state": "deleted"}
            continue
        try:
            size = source.stat().st_size
        except OSError:
            continue
        if size > MAX_FILE_BYTES or total + size > MAX_TOTAL_BYTES:
            skipped.append({"path": rel, "reason": "too large"})
            continue
        try:
            blob = source.read_bytes()
        except OSError as exc:
            skipped.append({"path": rel, "reason": str(exc)})
            continue
        target = files_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)
        entries[rel] = {"state": "dirty", "size": size}
        total += size

    code, head = _git(project_root, "rev-parse", "HEAD")
    manifest = {
        "version": 1,
        "turnId": turn_id,
        "projectRoot": str(project_root),
        "createdAt": time.time(),
        "head": head.strip() if code == 0 else None,
        "complete": not skipped,
        "bytes": total,
        "entries": entries,
        "skipped": skipped,
    }
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    _prune(data_dir)
    return {"ok": True, "data": {"turnId": turn_id, "complete": not skipped, "files": len(entries), "bytes": total, "skipped": skipped}}, 0


def restore(payload: dict[str, Any]) -> tuple[dict[str, Any], int]:
    project_root = Path(str(payload.get("projectRoot") or "")).expanduser().resolve()
    data_dir = _data_dir(payload)
    turn_id = str(payload.get("turnId") or "").strip()
    paths = [str(p) for p in (payload.get("paths") or [])]
    if not project_root.is_dir() or not turn_id or not paths:
        return {"ok": False, "error": "projectRoot, turnId and paths are required"}, 2

    dest = _snapshot_dir(data_dir, turn_id)
    manifest_path = dest / "manifest.json"
    if not manifest_path.is_file():
        return {"ok": False, "error": "no snapshot for that turn; it cannot be undone"}, 1
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not manifest.get("complete", False):
        # Refusing whole is the honest failure: a partial restore would leave a
        # state that never existed.
        return {
            "ok": False,
            "error": "that turn's snapshot is incomplete (a file was too large to capture), so it cannot be undone safely",
        }, 1

    entries = manifest.get("entries") or {}
    restored: list[str] = []
    removed: list[str] = []
    for rel in paths:
        target = project_root / rel
        entry = entries.get(rel)
        if entry and entry.get("state") == "dirty":
            blob = (dest / "files" / rel)
            if blob.is_file():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(blob.read_bytes())
                restored.append(rel)
                continue
        if entry and entry.get("state") == "deleted":
            if target.exists():
                target.unlink()
                removed.append(rel)
            continue
        # Not dirty at turn start, so the pre-turn content is what HEAD holds —
        # for a tracked path. A path HEAD does not know was created by the turn,
        # and undo means deleting it.
        tracked, _ = _git(project_root, "cat-file", "-e", f"HEAD:{rel}")
        if tracked == 0:
            code, _ = _git(project_root, "checkout", "--", rel)
            if code == 0:
                restored.append(rel)
        elif target.exists():
            target.unlink()
            removed.append(rel)
    return {"ok": True, "data": {"turnId": turn_id, "restored": restored, "removed": removed}}, 0


def discard(payload: dict[str, Any]) -> tuple[dict[str, Any], int]:
    data_dir = _data_dir(payload)
    turn_id = str(payload.get("turnId") or "").strip()
    if not turn_id:
        return {"ok": False, "error": "turnId is required"}, 2
    shutil.rmtree(_snapshot_dir(data_dir, turn_id), ignore_errors=True)
    return {"ok": True, "data": {"discarded": turn_id}}, 0


def run(argv: list[str]) -> int:
    action = argv[1] if len(argv) > 1 else ""
    raw = argv[2] if len(argv) > 2 else "{}"
    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"bad json: {exc}"}))
        return 2

    handlers = {"take": take, "restore": restore, "discard": discard}
    handler = handlers.get(action)
    if handler is None:
        print(json.dumps({"ok": False, "error": f"usage: snapshot <{'|'.join(handlers)}> '<json>'"}))
        return 2
    try:
        result, code = handler(payload)
    except Exception as exc:  # noqa: BLE001 - report, never traceback at the user
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 1
    print(json.dumps(result))
    return code


if __name__ == "__main__":
    raise SystemExit(run(sys.argv))
