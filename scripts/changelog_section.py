"""changelog_section.py — cut one release's notes out of CHANGELOG.md.

Why this exists
───────────────
The release workflow used to hand GitHub a paragraph of boilerplate, so a release
said "Built from <sha>" whether it fixed a crash or renamed a button. The changelog
is the curated record, so the notes are taken from it — which has the useful side
effect that a release with nothing written for it is obvious rather than silent.

One implementation, two callers: the workflow takes the notes with this, and
`tests/test_changelog.py` checks the same file with the same parser. A second parser
that drifted from the first is the failure this avoids.

Usage:
    python3 scripts/changelog_section.py 0.2.19     # the section, verbatim
    python3 scripts/changelog_section.py --check    # exit 1 if package.json's
                                                   # version has no section
    python3 scripts/changelog_section.py --list     # versions, in file order
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANGELOG = ROOT / "CHANGELOG.md"

# `## [0.2.19] - 2026-09-27`, and `## [Unreleased]` with no date.
_SECTION = re.compile(r"^##\s+\[(?P<version>[^\]]+)\](?:\s*-\s*(?P<date>\d{4}-\d{2}-\d{2}))?\s*$")
# The reference-link block that closes a Keep a Changelog file: `[0.2.19]: https://…`
_LINK = re.compile(r"^\[(?P<version>[^\]]+)\]:\s+(?P<url>\S+)\s*$")


def parse_sections(text: str) -> list[tuple[str, str, str]]:
    """Every `## [...]` section as `(version, date, body)`.

    Order is the file's. `date` is `""` for a section without one (`Unreleased`).
    A section's body ends at the next heading, or at the reference-link block —
    which is why a link line is a boundary rather than content.
    """
    sections: list[tuple[str, str, list[str]]] = []
    current: tuple[str, str, list[str]] | None = None
    for line in text.splitlines():
        heading = _SECTION.match(line)
        if heading:
            if current is not None:
                sections.append(current)
            current = (heading.group("version"), heading.group("date") or "", [])
            continue
        if _LINK.match(line):
            if current is not None:
                sections.append(current)
                current = None
            continue
        if current is not None:
            current[2].append(line)
    if current is not None:
        sections.append(current)
    return [(version, date, "\n".join(body).strip()) for version, date, body in sections]


def link_targets(text: str) -> dict[str, str]:
    """The `[version]: url` reference definitions, so a section's link can be checked."""
    found: dict[str, str] = {}
    for line in text.splitlines():
        match = _LINK.match(line)
        if match:
            found[match.group("version")] = match.group("url")
    return found


def normalize(version: str) -> str:
    """`v0.2.19` and `0.2.19` name the same release; the file uses bare versions."""
    return version.strip().lstrip("vV")


def section_for(text: str, version: str) -> str | None:
    wanted = normalize(version).lower()
    for name, _date, body in parse_sections(text):
        if normalize(name).lower() == wanted:
            return body
    return None


def current_version() -> str:
    """The version the app is, from the carrier the workflow always has."""
    return str(json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"])


def read_changelog() -> str:
    return CHANGELOG.read_text(encoding="utf-8")


def main(argv: list[str]) -> int:
    text = read_changelog()

    if "--list" in argv:
        for name, date, _body in parse_sections(text):
            print(f"{name}{f' ({date})' if date else ''}")
        return 0

    if "--check" in argv:
        version = current_version()
        body = section_for(text, version)
        if body is None:
            print(
                f"CHANGELOG.md has no section for {version}. Add one — move what is under "
                f"[Unreleased] into `## [{version}] - <date>`, and leave [Unreleased] empty.",
                file=sys.stderr,
            )
            return 1
        if not body.strip():
            print(f"CHANGELOG.md's section for {version} is empty.", file=sys.stderr)
            return 1
        return 0

    version = next((argument for argument in argv if not argument.startswith("-")), "")
    if not version:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    body = section_for(text, version)
    if body is None:
        print(f"CHANGELOG.md has no section for {normalize(version)}.", file=sys.stderr)
        return 1
    print(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
