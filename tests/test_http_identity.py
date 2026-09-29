"""Every outbound request says who it is.

The bug this pins, measured on `api.groq.com/openai/v1/models` with one
deliberately invalid key:

    curl (default)        -> 401 invalid_api_key
    python-requests       -> 401 invalid_api_key
    no user agent         -> 401 invalid_api_key
    Python-urllib/3.12    -> 403 error code: 1010      <- Cloudflare, before auth

`urllib` sends `Python-urllib/3.x` for any request that does not name a user
agent, so the engine's own traffic was refused by Groq's edge as "not permitted"
while the same key worked in curl — and the app reported that as a key problem,
which no amount of re-pasting a key could fix. These tests fail if either
outbound path goes back to asking for nothing.
"""

import importlib
import sys
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core-engine"))
ai_cli = importlib.import_module("ai_cli")
http_identity = importlib.import_module("http_identity")


class UserAgentTests(unittest.TestCase):
    def test_identity_names_the_app_and_never_urllib(self):
        self.assertTrue(http_identity.USER_AGENT.startswith("ACSA-Code"))
        # The exact string Cloudflare refuses.
        self.assertNotIn("Python-urllib", http_identity.USER_AGENT)
        # Header-safe: a stray newline in this value is a malformed request, and
        # this string is built from an environment variable.
        self.assertEqual(http_identity.USER_AGENT, http_identity.USER_AGENT.strip())
        self.assertNotIn("\n", http_identity.USER_AGENT)
        self.assertTrue(http_identity.USER_AGENT.isascii())

    def _headers_sent_by(self, call):
        """The headers `urllib` would put on the wire for one call."""
        seen = {}

        def capture(request, *args, **kwargs):
            seen.update(request.header_items())
            raise Refused

        original = urllib.request.urlopen
        urllib.request.urlopen = capture
        try:
            call()
        except Exception:  # noqa: BLE001 - the capture aborts the call on purpose
            pass
        finally:
            urllib.request.urlopen = original
        return {k.lower(): v for k, v in seen.items()}

    def test_the_connection_test_identifies_itself(self):
        # `_get` is the path the Groq 403 came down: Test Connection, and the model
        # list, and the Ollama tag read.
        headers = self._headers_sent_by(lambda: ai_cli._get("https://example.invalid/models", {}))
        self.assertEqual(headers.get("user-agent"), http_identity.USER_AGENT)

    def test_chat_identifies_itself_and_keeps_the_caller_headers(self):
        headers = self._headers_sent_by(
            lambda: ai_cli._post_json(
                "https://example.invalid/chat/completions",
                {"Authorization": "Bearer test", "Content-Type": "application/json"},
                {"model": "x"},
                5.0,
            )
        )
        self.assertEqual(headers.get("user-agent"), http_identity.USER_AGENT)
        # Injected, not replacing: the credential still travels.
        self.assertEqual(headers.get("authorization"), "Bearer test")

    def test_a_caller_may_still_override_the_identity(self):
        headers = self._headers_sent_by(
            lambda: ai_cli._get("https://example.invalid/models", {"User-Agent": "Something/1"})
        )
        self.assertEqual(headers.get("user-agent"), "Something/1")


if __name__ == "__main__":
    unittest.main()
