"""Inline completions, driven through the engine.

The key fact these pin: a completion for a cloud provider has to be asked here,
server-side. Credentials are write-only across the app's own API — the registry
never hands a key back to the page — so a completion requested straight from the
renderer arrives with no key and quietly returns nothing, which looks exactly
like a model that cannot complete.

The other half is the local prompt. Ollama applies a model's own fill-in-the-middle
template when `suffix` is set, and that is the only shape measured to answer with
code: hand-rolled `<|fim_prefix|>` tokens came back as a chat reply.
"""

import importlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core-engine"))
ai_cli = importlib.import_module("ai_cli")


class _Recorder:
    """Stands in for one outbound POST, capturing exactly what would be sent."""

    def __init__(self, status=200, body=None):
        self.calls = []
        self.status = status
        self.body = body if body is not None else {}

    def __call__(self, url, headers, body, timeout):
        self.calls.append({"url": url, "headers": headers, "body": body, "timeout": timeout})
        return self.status, self.body


class AiCompleteTests(unittest.TestCase):
    def setUp(self):
        self.usage = []
        self._post_json = ai_cli._post_json
        self._resolve_key = ai_cli._resolve_key
        self._record_usage = ai_cli._record_usage
        ai_cli._record_usage = lambda *args, **kwargs: self.usage.append(args)
        # A key is resolved server-side, so the page never has to send one.
        ai_cli._resolve_key = lambda provider, explicit: explicit or "resolved-key"

    def tearDown(self):
        ai_cli._post_json = self._post_json
        ai_cli._resolve_key = self._resolve_key
        ai_cli._record_usage = self._record_usage

    def test_asks_ollama_with_a_suffix_and_holds_the_model_in_memory(self):
        post = _Recorder(200, {"response": " email },\n    });", "eval_count": 7})
        ai_cli._post_json = post

        out = ai_cli.complete(
            {
                "provider": "ollama",
                "model": "qwen2.5-coder:7b",
                "prefix": "const u = await db.user.findUnique({ where: {",
                "suffix": " },\n});",
            }
        )

        self.assertTrue(out["ok"])
        self.assertEqual(out["completion"], " email },\n    });")
        self.assertEqual(len(post.calls), 1)
        sent = post.calls[0]
        self.assertTrue(sent["url"].endswith("/api/generate"))
        self.assertEqual(sent["body"]["suffix"], " },\n});")
        self.assertNotIn("<|fim_prefix|>", sent["body"]["prompt"])
        self.assertEqual(sent["body"]["keep_alive"], "30m")
        # 24 tokens, measured at ~1.15s warm against 2.3s for 48.
        self.assertEqual(sent["body"]["options"]["num_predict"], ai_cli.COMPLETION_MAX_TOKENS)
        # Metered, so ghost text shows up in the usage totals it contributes to.
        self.assertEqual(len(self.usage), 1)

    def test_never_sends_an_empty_suffix_which_takes_the_model_out_of_fim_mode(self):
        # Measured against the daemon: with nothing after the cursor the model
        # answered as a chat bot ("It looks like you're trying to find a user…")
        # and took ~4s. A newline put it back to code in 257ms.
        post = _Recorder(200, {"response": "\n  });\n}"})
        ai_cli._post_json = post

        out = ai_cli.complete({"provider": "ollama", "model": "qwen2.5-coder:7b", "prefix": "a", "suffix": ""})

        self.assertEqual(post.calls[0]["body"]["suffix"], "\n")
        self.assertEqual(out["completion"], "\n  });\n}")

    def test_asks_a_cloud_provider_with_the_key_the_page_cannot_hold(self):
        post = _Recorder(
            200,
            {
                "choices": [{"message": {"content": " email },"}}],
                "usage": {"prompt_tokens": 30, "completion_tokens": 6},
            },
        )
        ai_cli._post_json = post

        out = ai_cli.complete(
            {
                "provider": "groq",
                "model": "openai/gpt-oss-120b",
                "baseUrl": "https://api.groq.com/openai/v1",
                "prefix": "const u = await db.user.findUnique({ where: {",
                "suffix": " },\n});",
            }
        )

        self.assertTrue(out["ok"])
        self.assertEqual(out["completion"], " email },")
        sent = post.calls[0]
        self.assertEqual(sent["url"], "https://api.groq.com/openai/v1/chat/completions")
        self.assertEqual(sent["headers"]["Authorization"], "Bearer resolved-key")
        # A completion is a couple of lines: a generous cap is what turns a
        # suggestion into a patch.
        self.assertEqual(sent["body"]["max_tokens"], ai_cli.COMPLETION_MAX_TOKENS)
        self.assertIn("complete the code", sent["body"]["messages"][1]["content"].lower())
        self.assertEqual(self.usage[0][2:4], (30, 6))

    def test_sends_the_raw_text_because_the_frontend_owns_the_sanitizer(self):
        # A model that echoes the prefix must reach the one sanitizer, not a second
        # copy of the rules: `aiAutocomplete.sanitizeCompletion` is where they live.
        ai_cli._post_json = _Recorder(200, {"response": "```ts\nconst u = 1\n```"})
        out = ai_cli.complete({"provider": "ollama", "prefix": "const u =", "suffix": ""})
        self.assertEqual(out["completion"], "```ts\nconst u = 1\n```")

    def test_reports_a_models_refusal_instead_of_inventing_a_completion(self):
        # deepseek-coder:6.7b has no FIM template and answers 400. The old fallback
        # sent a fabricated prompt anyway and got prose back.
        ai_cli._post_json = _Recorder(400, {"error": "does not support insert"})
        out = ai_cli.complete({"provider": "ollama", "model": "deepseek-coder:6.7b", "prefix": "a", "suffix": "b"})
        self.assertFalse(out["ok"])
        self.assertEqual(out["completion"], "")
        self.assertIn("does not support insert", out["reason"])
        self.assertEqual(self.usage, [])


if __name__ == "__main__":
    unittest.main()
