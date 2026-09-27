"""Tests for the skills registry the marketplace installs into."""

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from skills.skill_loader import import_skill, list_skills


class SkillImportTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="acsa-skills-"))

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def _install(self, name: str, content: str, description: str = ""):
        return import_skill(name, content, "project", str(self.root), description=description)

    def test_a_description_from_the_catalogue_is_what_the_runtime_shows(self):
        # The runtime lists skills by name and description and lets the model pick;
        # a placeholder description makes every installed skill look the same.
        skill = self._install(
            "code-review",
            "# Steps\nRead the diff.",
            description="Reviews a diff for correctness and safety.",
        )
        written = Path(skill.path).read_text(encoding="utf-8")
        self.assertIn("description: Reviews a diff for correctness and safety.", written)
        self.assertNotIn("User imported skill", written)

    def test_without_one_it_still_parses_and_says_something_useful(self):
        skill = self._install("plain-skill", "# Body")
        written = Path(skill.path).read_text(encoding="utf-8")
        self.assertIn("description: Imported skill plain-skill", written)
        self.assertTrue(skill.description)

    def test_the_file_carries_its_triggers_and_shows_up_in_the_list(self):
        # Our own loader's shape: a flat markdown file with triggers it understands.
        # The runtime's shape is produced separately when a run starts.
        self._install("verify-skill", "# Body", description="Says VERIFIED.")
        names = [s.name for s in list_skills(str(self.root))]
        self.assertIn("verify-skill", names)
        written = (self.root / ".acsa" / "skills" / "verify-skill.md").read_text(encoding="utf-8")
        self.assertIn('triggers: ["/verify-skill", "verify-skill"]', written)

    def test_content_that_is_already_frontmatter_is_left_alone(self):
        given = "---\nname: mine\ndescription: Mine.\n---\n\nBody"
        skill = self._install("mine", given, description="ignored, the file says so")
        self.assertEqual(Path(skill.path).read_text(encoding="utf-8"), given)


if __name__ == "__main__":
    unittest.main()
