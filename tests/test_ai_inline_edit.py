"""Inline edits, driven through the engine.

The bug these pin was reported from use as "Fix with AI is failing", with a toast
reading only `Inline edit request failed (200)`. The HTTP call had indeed
succeeded — the engine reports a refusal *in the body*, under `error`, and the
page read only `reason` (which the sanitizer path fills). So every engine refusal
— a missing key, a provider error, a model that answered without code — reached
the reader as a status code.

That reporting behaviour is pinned on the page side, in
`src/services/aiAutocomplete.inlineEdit.test.ts`. What belongs here is the engine
half: what it puts in the body when a model answers with nothing, and that a
provider failure keeps its own words.
"""

import importlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core-engine"))
ai_cli = importlib.import_module("ai_cli")

PAYLOAD = {
    "provider": "ollama",
    "model": "qwen2.5-coder:7b",
    "instruction": "Add aria-pressed to the toggle.",
    "selectedCode": '<button className="theme-toggle" onClick={toggleTheme}>',
    "surroundingPrefix": "function App() {\n",
    "surroundingSuffix": "\n}\n",
}


class AiInlineEditTests(unittest.TestCase):
    def setUp(self):
        self._review_completion = ai_cli._review_completion
        self._record_usage = ai_cli._record_usage
        ai_cli._record_usage = lambda *args, **kwargs: None

    def tearDown(self):
        ai_cli._review_completion = self._review_completion
        ai_cli._record_usage = self._record_usage

    def _reply(self, *, ok=True, raw="", error=""):
        ai_cli._review_completion = lambda *args, **kwargs: (ok, raw, error, (10, 5))

    def test_an_empty_reply_says_what_to_do_about_it(self):
        # "The provider returned an empty replacement" was accurate and useless: it
        # names neither what happened from the reader's side nor what to do. A local
        # model does answer with nothing now and then, and "run it again" works.
        self._reply(raw="")

        result = ai_cli.inline_edit(dict(PAYLOAD))

        self.assertFalse(result["ok"])
        self.assertIn("returned no code", result["error"])
        self.assertIn("again", result["error"])
        self.assertEqual(result["replacement"], "")

    def test_a_provider_failure_keeps_its_own_words(self):
        # The control for the sentence above: a real provider error must not be
        # replaced by the friendly one.
        self._reply(ok=False, error="An API key is required for provider 'deepseek'.")

        result = ai_cli.inline_edit(dict(PAYLOAD))

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "An API key is required for provider 'deepseek'.")
        # And under `error`, which is the key the page now reads.
        self.assertNotIn("reason", result)

    def test_a_usable_reply_comes_back_as_the_replacement(self):
        self._reply(raw='<button className="theme-toggle" onClick={toggleTheme} aria-pressed={theme === "dark"}>')

        result = ai_cli.inline_edit(dict(PAYLOAD))

        self.assertTrue(result["ok"])
        self.assertIn("aria-pressed", result["replacement"])


if __name__ == "__main__":
    unittest.main()
