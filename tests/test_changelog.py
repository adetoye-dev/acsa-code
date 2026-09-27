"""The changelog has to be able to answer for the version that is shipping.

Why this is a test rather than a note in the checklist: a release is ten minutes of
signing and notarising, and the body GitHub gets is taken from `CHANGELOG.md` (see
`scripts/changelog_section.py`). "Remember to write the notes" is exactly the kind of
step that is skipped at the end of a long day, and the cost of skipping it is a
release whose notes say nothing — or, worse, notes for the *previous* version. So
the build checks it, and the check runs in `npm run verify`, which the release
workflow runs before it spends those ten minutes.

This is deliberately about the document's shape, not its prose: it cannot tell you
the notes are good, only that the version being shipped has some.
"""

import importlib.util
import json
import re
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_helper():
    spec = importlib.util.spec_from_file_location(
        "changelog_section", ROOT / "scripts" / "changelog_section.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


changelog = _load_helper()


class ChangelogTests(unittest.TestCase):
    def setUp(self):
        self.text = changelog.read_changelog()
        self.sections = changelog.parse_sections(self.text)
        self.links = changelog.link_targets(self.text)
        self.version = str(json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"])

    def test_unreleased_is_there_to_write_into(self):
        self.assertEqual(self.sections[0][0], "Unreleased")

    def test_the_shipping_version_has_notes(self):
        body = changelog.section_for(self.text, self.version)
        self.assertIsNotNone(
            body,
            f"CHANGELOG.md has no section for {self.version}, the version in the carriers",
        )
        self.assertTrue(body.strip(), f"CHANGELOG.md's {self.version} section is empty")

    def test_the_newest_released_section_is_the_version_we_are(self):
        # Catches the other half of a forgotten release: bumping the carriers and
        # writing the section but never moving it out of `Unreleased`, which leaves
        # the file claiming the previous release is current.
        self.assertEqual(self.sections[1][0], self.version)

    def test_every_released_version_descends(self):
        released = [name for name, _date, _body in self.sections if name != "Unreleased"]
        numbers = [tuple(int(part) for part in name.split(".")) for name in released]
        self.assertEqual(
            numbers,
            sorted(numbers, reverse=True),
            f"the changelog's versions are not in descending order: {released}",
        )

    def test_every_section_has_a_real_date(self):
        for name, day, _body in self.sections:
            if name == "Unreleased":
                self.assertEqual(day, "", "`Unreleased` should not carry a date")
                continue
            date.fromisoformat(day)  # raises if it is not an ISO date

    def test_every_section_has_a_link(self):
        # A heading like `## [0.2.19]` renders as a link only if a `[0.2.19]: url`
        # definition exists; without one the heading is literal text.
        for name, _date, _body in self.sections:
            self.assertIn(name, self.links, f"`[{name}]` has no reference link")
            self.assertRegex(self.links[name], r"^https?://")

    def test_the_unreleased_link_compares_against_the_last_tag(self):
        # So the diff a reader opens is the work that is not released yet, not the
        # whole history.
        released = [name for name, _date, _body in self.sections if name != "Unreleased"]
        self.assertTrue(
            self.links["Unreleased"].endswith(f"v{released[0]}...dev"),
            f"`[Unreleased]` should compare the last release to dev: {self.links['Unreleased']}",
        )

    def test_sections_use_keep_a_changelog_categories(self):
        allowed = {
            "### Added",
            "### Changed",
            "### Deprecated",
            "### Removed",
            "### Fixed",
            "### Security",
            # Not a Keep a Changelog category, but the one this project needs: an
            # accessibility fix is neither a feature nor a bugfix to a reader.
            "### Accessibility",
        }
        for name, _date, body in self.sections:
            for line in body.splitlines():
                if line.startswith("###"):
                    self.assertIn(line.strip(), allowed, f"{name}: unknown heading {line!r}")

    def test_bullets_are_actually_bullets(self):
        # Catches a body written as loose paragraphs, which GitHub renders as one
        # run-on block under the heading.
        for name, _date, body in self.sections:
            if not body.strip():
                continue
            self.assertTrue(
                any(re.match(r"^(###\s|\s*-\s)", line) for line in body.splitlines()),
                f"{name} has a body but no bullets",
            )


if __name__ == "__main__":
    unittest.main()
