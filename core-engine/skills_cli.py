#!/usr/bin/env python3
"""skills_cli.py — the skill catalog the Marketplace surface reads.

Why this exists: `/api/skills/*` was implemented in `vite-fs-bridge.ts`, a Vite
dev-server middleware, and it re-scanned the skill directories in JavaScript even
though `core-engine/skills/skill_loader.py` already does exactly that — so the
packaged app had no skills at all and the two could drift. This delegates to the
loader instead of duplicating it.

Usage: python3 skills_cli.py list '{"projectRoot": "/path/to/repo"}'
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def _root(payload: dict) -> str:
    candidate = str(payload.get("projectRoot") or os.getcwd())
    return candidate if Path(candidate).is_dir() else os.getcwd()


def list_skills(payload: dict) -> dict:
    import skill_loader

    return {"ok": True, "skills": [s.to_dict() for s in skill_loader.list_skills(_root(payload))]}


def import_skill(payload: dict) -> dict:
    import skill_loader

    name = str(payload.get("name") or "").strip()
    content = str(payload.get("content") or "")
    if not name or not content:
        return {"ok": False, "error": "name and content are required"}

    scope = str(payload.get("scope") or "project")
    skill = skill_loader.import_skill(
        name,
        content,
        scope,
        _root(payload),
        description=str(payload.get("description") or ""),
    )
    return {"ok": True, "name": skill.name, "path": skill.path, "scope": scope}


COMMANDS = {"list": list_skills, "import": import_skill}


def run(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(json.dumps({"ok": False, "error": f"usage: skills_cli.py <{'|'.join(COMMANDS)}> [json]"}))
        return 2

    handler = COMMANDS.get(argv[1])
    if handler is None:
        print(json.dumps({"ok": False, "error": f"unknown command: {argv[1]}"}))
        return 2

    try:
        raw = argv[2] if len(argv) > 2 else (sys.stdin.read() or "{}")
        payload = json.loads(raw or "{}")
        result = handler(payload)
        # `import` reports failure in-band rather than as a transport error.
        print(json.dumps({"ok": True, "data": result}) if result.get("ok", True) else json.dumps({"ok": False, "error": result.get("error")}))
        return 0 if result.get("ok", True) else 1
    except Exception as exc:  # noqa: BLE001 - the CLI reports, it does not raise
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(run(sys.argv))
