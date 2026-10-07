"""What a chat turn tells the model about the project it is being asked about.

The turn used to carry a *map* — LOC, frameworks, the names of 35 symbols — and no
code at all. A frontier model can sometimes bluff past that; a small local model
cannot, so it answers generically about a repository it has never seen. These pin
the parts that decide whether the code reaches it: which words of a question count
as signals, which files those signals find, and whether the thing that was found
is the thing the reader needs to see.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "core-engine"))

import ai_cli  # noqa: E402


class QuestionTermsTests(unittest.TestCase):
    def test_two_letter_identifiers_survive(self):
        # The whole reason the floor is 2: `gh` is the subject of the question and
        # the name of nothing else in it.
        self.assertIn("gh", ai_cli._question_terms("where is the gh binary found"))

    def test_stopwords_are_dropped(self):
        terms = ai_cli._question_terms("what is the reason for this in the file")
        for word in ("what", "the", "for", "this", "in"):
            self.assertNotIn(word, terms)

    def test_an_identifier_contributes_itself_and_its_parts(self):
        # The file may be named either way, so both are worth searching for.
        terms = ai_cli._question_terms("why does useThemeColor ignore the dark value")
        self.assertIn("usethemecolor", terms)
        self.assertIn("theme", terms)
        self.assertIn("color", terms)

    def test_snake_case_is_split_too(self):
        terms = ai_cli._question_terms("what does tool_paths do")
        self.assertIn("tool_paths", terms)
        self.assertIn("paths", terms)


class RangeTests(unittest.TestCase):
    def test_overlapping_and_touching_ranges_are_merged(self):
        hits = [
            {"start_line": 10, "end_line": 12},
            {"start_line": 13, "end_line": 15},
            {"start_line": 40, "end_line": 41},
        ]
        self.assertEqual(ai_cli._merge_ranges(hits, 0), [(10, 15), (40, 41)])

    def test_padding_widens_each_range(self):
        self.assertEqual(ai_cli._merge_ranges([{"start_line": 10, "end_line": 10}], 2), [(8, 12)])

    def test_a_range_at_the_top_of_the_file_does_not_go_negative(self):
        for start, end in ai_cli._merge_ranges([{"start_line": 1, "end_line": 2}], 5):
            self.assertGreaterEqual(start, 1)

    def test_junk_lines_are_skipped_rather_than_crashing(self):
        self.assertEqual(ai_cli._merge_ranges([{"start_line": None}, {"nope": 1}], 0), [])

    def test_matched_lines_merge_into_ranges(self):
        self.assertEqual(ai_cli._merge_line_numbers([5, 6, 20], 1), [(4, 7), (19, 21)])

    def test_a_slice_keeps_only_those_lines(self):
        text = "\n".join(f"line{i}" for i in range(1, 11))
        self.assertEqual(ai_cli._slice_lines(text, [(3, 4)]), "line3\nline4")


class RankFilesTests(unittest.TestCase):
    def _files(self):
        return {
            "core-engine/tool_paths.py": {
                "symbols": [{"name": "find", "file_path": "core-engine/tool_paths.py"}],
                "line_count": 80,
            },
            "src/unrelated.ts": {"symbols": [], "line_count": 40},
        }

    def test_a_symbol_the_question_names_outranks_a_file_that_merely_matches(self):
        ranked = ai_cli._rank_files(self._files(), {}, {}, ["find"], "")
        self.assertEqual(ranked[0][1], "core-engine/tool_paths.py")
        self.assertEqual([s["name"] for s in ranked[0][2]], ["find"])

    def test_the_open_file_is_worth_more_than_a_weak_match(self):
        # Nothing in the question names it; it is still the file they are looking at.
        ranked = ai_cli._rank_files(self._files(), {}, {}, ["find"], "src/unrelated.ts")
        self.assertIn("src/unrelated.ts", [entry[1] for entry in ranked])

    def test_rarer_words_outweigh_common_ones(self):
        # `gh` in 2 files, `path` in 40: the file with the rare word wins.
        content = {"a.py": ([3], {"gh"}), "b.py": ([9], {"path"})}
        per_term = {"gh": 2, "path": 40}
        ranked = ai_cli._rank_files({}, content, per_term, ["gh", "path"], "")
        self.assertEqual(ranked[0][1], "a.py")


class CodeContextTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="acsa-chat-context-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))

    def _write(self, relative: str, text: str) -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def _block(self, question: str, active_path: str = "", selection: str = "") -> str:
        files = {
            "core-engine/tool_paths.py": {
                "symbols": [{"name": "find", "file_path": "core-engine/tool_paths.py"}],
                "line_count": 4,
            }
        }
        return ai_cli._code_context_block(str(self.root), {"files": files}, question, active_path, selection)

    def test_a_file_the_question_points_at_is_included_with_its_text(self):
        self._write(
            "core-engine/tool_paths.py",
            '"""Where the gh binary lives when PATH does not have it."""\n\n'
            "def find(name):\n    return name\n",
        )
        # Neither "tool_paths" nor "find" is in the question. The words that do
        # match — "gh", "binary" — are in the file's docstring, which is the only
        # reason searching the contents finds a file no name matches.
        block = self._block("where is the gh binary looked up")
        self.assertIn("core-engine/tool_paths.py", block)
        self.assertIn("def find(name)", block)

    def test_the_open_file_arrives_whole_when_it_is_small(self):
        self._write("src/App.tsx", "export function App() {\n  return null;\n}\n")
        block = self._block("anything at all", active_path="src/App.tsx")
        self.assertIn("src/App.tsx", block)
        self.assertIn("export function App()", block)

    def test_a_selection_is_sent_instead_of_the_whole_file(self):
        self._write("src/App.tsx", "const first = 1;\nconst second = 2;\n")
        block = self._block("what does this do", active_path="src/App.tsx", selection="const second = 2;")
        self.assertIn("const second = 2;", block)
        self.assertNotIn("const first = 1;", block)

    def test_nothing_found_says_so_instead_of_letting_the_model_guess(self):
        # The failure this is here to prevent is a confident, invented answer.
        block = self._block("unzqx wibble frobnicate")
        self.assertIn("Nothing was retrieved", block)
        self.assertIn("guessing about this project", block)

    def test_a_big_file_is_truncated_and_says_so(self):
        # Matching lines so wide that the snippet alone is over the per-file budget.
        self._write("big.py", "\n".join("gh " + ("x" * 3000) for _ in range(3)))
        block = self._block("where is the gh binary looked up")
        self.assertIn("big.py", block)
        self.assertIn("truncated", block)

    def test_the_whole_block_stays_inside_the_budget(self):
        for index in range(6):
            self._write(f"core-engine/module{index}.py", "\n".join(f"gh line {i}" for i in range(400)))
        block = self._block("where is the gh binary looked up")
        # The budget is on the source; the framing and headers are small but real.
        self.assertLess(len(block), ai_cli.CHAT_CONTEXT_BUDGET_BYTES * 2)

    def test_it_never_reads_outside_the_project(self):
        self._write("inside.py", "gh = 1\n")
        outside = self.root.parent / "acsa-outside-the-project.txt"
        outside.write_text("gh secret\n", encoding="utf-8")
        self.addCleanup(lambda: outside.unlink(missing_ok=True))

        self.assertIsNone(ai_cli._read_project_source(str(self.root), "../acsa-outside-the-project.txt"))


if __name__ == "__main__":
    unittest.main()
