"""The Responses <-> Ollama chat translation, exercised without a network.

The adapter exists because Codex requires the Responses API and Ollama's
implementation of it drops tool definitions. Every shape below was found by a
real Codex run failing in a way that pointed somewhere else, so these assert the
exact shapes rather than a plausible-looking approximation.
"""

import importlib
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core-engine"))
adapter = importlib.import_module("responses_adapter")


class ToolTranslationTests(unittest.TestCase):
    def test_flat_responses_tool_becomes_nested_chat_tool(self):
        # Codex sends `{type, name, description, parameters}` -- flat. Ollama
        # wants the same thing nested under `function`.
        converted = adapter.chat_tools(
            [
                {
                    "type": "function",
                    "name": "exec_command",
                    "description": "run a command",
                    "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}},
                }
            ]
        )
        self.assertEqual(len(converted), 1)
        self.assertEqual(converted[0]["type"], "function")
        self.assertEqual(converted[0]["function"]["name"], "exec_command")
        self.assertEqual(converted[0]["function"]["parameters"]["properties"]["cmd"]["type"], "string")

    def test_non_function_tools_are_dropped_not_mangled(self):
        # Codex also advertises `namespace` and `web_search` entries. Ollama has
        # no idea what those are; passing them through is a schema error there.
        converted = adapter.chat_tools(
            [
                {"type": "namespace", "name": "multi_agent_v1"},
                {"type": "web_search"},
                {"type": "function", "name": "get_goal", "parameters": {}},
            ]
        )
        self.assertEqual([t["function"]["name"] for t in converted], ["get_goal"])


class ArgumentTests(unittest.TestCase):
    def test_null_arguments_are_dropped(self):
        # A real failure: llama3.2:3b sent `"yield_time_ms": null`, and Codex's own
        # schema for exec_command wants a u64, so the call died with
        # "invalid type: null, expected u64" even though the model meant "default".
        cleaned = json.loads(
            adapter.clean_arguments('{"cmd": "echo hi", "yield_time_ms": null, "tty": true}')
        )
        self.assertEqual(cleaned, {"cmd": "echo hi", "tty": True})

    def test_arguments_that_cannot_match_the_schema_are_dropped(self):
        # llama3.2:3b sent `"prefix_rule": ""` where exec_command declares an
        # array, and the call died with 'invalid type: string "", expected a
        # sequence' before anything ran. The tool's own schema is in the request,
        # so the guess can be dropped instead of failing the call.
        schema = {
            "type": "object",
            "properties": {
                "cmd": {"type": "string"},
                "yield_time_ms": {"type": "integer"},
                "prefix_rule": {"type": ["array", "null"]},
            },
        }
        cleaned = json.loads(
            adapter.clean_arguments(
                '{"cmd": "echo hi", "yield_time_ms": null, "prefix_rule": ""}', schema
            )
        )
        self.assertEqual(cleaned, {"cmd": "echo hi"})

    def test_unknown_arguments_survive_unless_the_schema_forbids_them(self):
        permissive = {"properties": {"cmd": {"type": "string"}}}
        self.assertEqual(
            json.loads(adapter.clean_arguments('{"cmd":"x","extra":1}', permissive)),
            {"cmd": "x", "extra": 1},
        )
        strict = {"properties": {"cmd": {"type": "string"}}, "additionalProperties": False}
        self.assertEqual(
            json.loads(adapter.clean_arguments('{"cmd":"x","extra":1}', strict)), {"cmd": "x"}
        )

    def test_a_boolean_is_not_accepted_where_a_number_was_asked_for(self):
        # `True` is an `int` in Python, so this needs saying explicitly.
        schema = {"properties": {"n": {"type": "integer"}}}
        self.assertEqual(json.loads(adapter.clean_arguments('{"n": true}', schema)), {})
        self.assertEqual(json.loads(adapter.clean_arguments('{"n": 3}', schema)), {"n": 3})

    def test_unparseable_arguments_pass_through_so_the_error_survives(self):
        broken = '{"cmd": "echo hi"'
        self.assertEqual(adapter.clean_arguments(broken), broken)

    def test_object_arguments_are_accepted_and_used_for_chat(self):
        # Ollama wants an object here; posting a string is a 400.
        self.assertEqual(adapter.as_object('{"a": 1}'), {"a": 1})
        self.assertEqual(adapter.as_object({"a": 1}), {"a": 1})
        self.assertEqual(adapter.as_object("not json"), {})


class RecoveredToolCallTests(unittest.TestCase):
    """Models that cannot emit native tool calls write them as text instead."""

    SCHEMAS = {"exec_command": {"type": "object", "properties": {"cmd": {"type": "string"}}}}

    def test_a_bare_json_call_is_recovered(self):
        # Measured: `qwen2.5-coder:7b` answers with exactly this and the tool never
        # runs, because the runtime sees prose.
        recovered = adapter.tool_call_from_text(
            '{"name": "exec_command", "arguments": {"cmd": "echo hi"}}', self.SCHEMAS
        )
        self.assertEqual(recovered, ("exec_command", {"cmd": "echo hi"}))

    def test_a_fenced_json_call_is_recovered(self):
        recovered = adapter.tool_call_from_text(
            '```json\n{"name": "exec_command", "arguments": {"cmd": "ls"}}\n```', self.SCHEMAS
        )
        self.assertEqual(recovered, ("exec_command", {"cmd": "ls"}))

    def test_a_call_with_a_sentence_in_front_is_still_recovered(self):
        # The observed shape that started this: `qwen2.5-coder:7b` answers the
        # request to run curl with a preamble, then the call in a fence. Requiring
        # the whole answer to be JSON missed it and the command never ran.
        text = (
            "To execute the shell command, you can use the following approach:\n"
            "1. Run the command with escalated permissions\n"
            "Here is the command you should run: ```json\n"
            '{"name": "exec_command", "arguments": {"cmd": "curl -sS https://example.com"}}\n'
            "``` This will fetch the data."
        )
        self.assertEqual(
            adapter.tool_call_from_text(text, self.SCHEMAS),
            ("exec_command", {"cmd": "curl -sS https://example.com"}),
        )

    def test_a_brace_inside_a_command_does_not_end_the_object(self):
        # Brace matching has to respect strings, or the candidate is truncated and
        # a perfectly good call is dropped.
        text = '{"name": "exec_command", "arguments": {"cmd": "echo \\"}\\" | wc -l"}}'
        self.assertEqual(
            adapter.tool_call_from_text(text, self.SCHEMAS),
            ("exec_command", {"cmd": 'echo "}" | wc -l'}),
        )

    def test_prose_is_not_rewritten_when_no_offered_tool_is_named(self):
        # The gate that keeps the search safe: the name must be a tool this request
        # advertised. Anything else, including JSON that is plainly an answer, is
        # left as prose.
        for text in (
            "I ran exec_command for you.",
            'The config is {"name": "my-app", "arguments": {}}.',
            '{"answer": 42}',
            "",
        ):
            self.assertIsNone(adapter.tool_call_from_text(text, self.SCHEMAS))

    def test_an_unknown_tool_name_is_not_invented(self):
        self.assertIsNone(
            adapter.tool_call_from_text('{"name": "rm_everything", "arguments": {}}', self.SCHEMAS)
        )

    def test_holding_happens_only_for_a_possible_call(self):
        # Prose streams immediately; a JSON blob is held until the stream ends.
        for prose in ("Hello", "```python\nprint(1)", "Sure, here is what I did"):
            self.assertFalse(adapter._might_be_a_tool_call(prose))
        for maybe in ("", "{", "[", '{"name"', "```json", "```{"):
            self.assertTrue(adapter._might_be_a_tool_call(maybe))


class MessageTranslationTests(unittest.TestCase):
    def test_instructions_and_roles_survive(self):
        messages = adapter.chat_messages(
            {
                "instructions": "be brief",
                "input": [
                    {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "rules"}]},
                    {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
                ],
            }
        )
        self.assertEqual([m["role"] for m in messages], ["system", "system", "user"])
        self.assertEqual(messages[0]["content"], "be brief")
        # `developer` is what this runtime calls the system prompt.
        self.assertEqual(messages[1]["content"], "rules")

    def test_tool_history_round_trips_in_the_direction_each_side_wants(self):
        messages = adapter.chat_messages(
            {
                "input": [
                    {
                        "type": "function_call",
                        "name": "exec_command",
                        "call_id": "call_1",
                        "arguments": '{"cmd": "echo hi"}',
                    },
                    {"type": "function_call_output", "call_id": "call_1", "output": "hi\n"},
                ]
            }
        )
        call = messages[0]["tool_calls"][0]["function"]
        self.assertEqual(call["name"], "exec_command")
        # An object, not the Responses string.
        self.assertEqual(call["arguments"], {"cmd": "echo hi"})
        self.assertEqual(messages[1]["role"], "tool")
        self.assertEqual(messages[1]["content"], "hi\n")


if __name__ == "__main__":
    unittest.main()


import ai_cli  # noqa: E402  (the engine's provider client)


class TestConnectionErrorTextTests(unittest.TestCase):
    """A failed provider test has to say why.

    Every hosted provider nests its reason differently, and the settings page reads
    one field. Handing the payload through unchanged meant a dict arrived as
    "[object Object]" and, on the page that read `message`, nothing arrived at all —
    so a rejected key, an account with no credit and a dead network all produced
    "Connection failed. Please check endpoint or API key."
    """

    def test_reads_the_message_openai_nests_inside_error(self):
        body = {"error": {"message": "Incorrect API key provided: sk-***", "type": "invalid_request_error"}}
        self.assertEqual(ai_cli._error_text(body), "Incorrect API key provided: sk-***")

    def test_reads_a_bare_string_and_a_bare_message(self):
        self.assertEqual(ai_cli._error_text("rate limit exceeded"), "rate limit exceeded")
        self.assertEqual(ai_cli._error_text({"message": "quota exhausted"}), "quota exhausted")

    def test_says_nothing_rather_than_guessing_at_an_unknown_shape(self):
        # Gemini returns a list of attempts, and some providers return nothing useful.
        # An empty string is what lets the caller fall back to the status code.
        self.assertEqual(ai_cli._error_text({"error": [{"reason": "x"}]}), "")
        self.assertEqual(ai_cli._error_text(None), "")
        self.assertEqual(ai_cli._error_text({"error": {}}), "")

    def test_the_failure_keeps_the_status(self):
        # The status is half the diagnosis: 401 and 429 need different fixes, and the
        # frontend's classifier keys off it.
        source = (Path(__file__).resolve().parent.parent / "core-engine" / "ai_cli.py").read_text(encoding="utf-8")
        self.assertIn('f"HTTP {status or \'unreachable\'}: {_error_text(body)}"', source)


class OpenAIUpstream(unittest.TestCase):
    """The second upstream shape: any OpenAI-compatible `/chat/completions`.

    This is the path every provider without a Responses API has to take — NVIDIA
    NIM among them, which is why it exists: measured against NIM's public host,
    `POST /v1/responses` is `404 page not found` while `/chat/completions` answers
    403 without a key. The runtime will not speak chat completions itself, so the
    adapter has to, and the translation is what these tests pin down.
    """

    def setUp(self):
        self.saved = (adapter.UPSTREAM_MODE, adapter.UPSTREAM_URL, adapter.UPSTREAM_KEY)
        adapter.UPSTREAM_MODE = "openai"
        adapter.UPSTREAM_URL = "https://integrate.api.nvidia.com/v1"
        adapter.UPSTREAM_KEY = "nvapi-test"

    def tearDown(self):
        adapter.UPSTREAM_MODE, adapter.UPSTREAM_URL, adapter.UPSTREAM_KEY = self.saved

    def test_the_base_url_splits_into_scheme_host_port_and_path(self):
        self.assertEqual(
            adapter.upstream_endpoint(),
            ("https", "integrate.api.nvidia.com", 443, "/v1/chat/completions"),
        )

    def test_a_plain_http_base_url_keeps_its_port(self):
        adapter.UPSTREAM_URL = "http://127.0.0.1:11434/v1"
        self.assertEqual(
            adapter.upstream_endpoint(),
            ("http", "127.0.0.1", 11434, "/v1/chat/completions"),
        )

    def test_a_non_streaming_reply_becomes_an_ollama_message(self):
        result = {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "hi",
                        "tool_calls": [
                            {"id": "call_1", "function": {"name": "f", "arguments": '{"a": 1}'}}
                        ],
                    }
                }
            ]
        }
        message = adapter.upstream_message(result)
        self.assertEqual(message["content"], "hi")
        self.assertEqual(message["tool_calls"][0]["function"]["arguments"], '{"a": 1}')
        self.assertEqual(message["tool_calls"][0]["id"], "call_1")

    def test_tool_history_keeps_the_string_and_pairs_the_call_id(self):
        # OpenAI wants the Responses shape as it already is: a JSON *string*, and
        # the id that pairs a call with the message answering it. Ollama is the
        # opposite on both counts, which is why the direction is explicit.
        messages = adapter.chat_messages(
            {
                "input": [
                    {
                        "type": "function_call",
                        "name": "f",
                        "arguments": '{"a": 1}',
                        "call_id": "call_1",
                    },
                    {"type": "function_call_output", "call_id": "call_1", "output": "done"},
                ]
            }
        )
        self.assertEqual(messages[0]["tool_calls"][0]["function"]["arguments"], '{"a": 1}')
        self.assertEqual(messages[1]["tool_call_id"], "call_1")
        self.assertNotIn("tool_name", messages[1])

    def test_the_ollama_direction_is_untouched_by_the_mode(self):
        adapter.UPSTREAM_MODE = "ollama"
        messages = adapter.chat_messages(
            {"input": [{"type": "function_call", "name": "f", "arguments": '{"a": 1}'}]}
        )
        self.assertEqual(messages[0]["tool_calls"][0]["function"]["arguments"], {"a": 1})

    def test_a_fragmented_streamed_tool_call_arrives_complete_and_once(self):
        # The reason the accumulator exists: OpenAI sends the name in one chunk and
        # the JSON arguments over the next few, and the consumer emits on first
        # sight of a call — without this it would hand the runtime `{}` for every
        # tool the model called.
        stream = adapter.OpenAiStream()
        chunks = []
        for obj in [
            # The name arrives whole in the first delta; the arguments are the part
            # that is streamed in pieces.
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_1", "function": {"name": "get_weather", "arguments": ""}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '{"ci'}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": 'ty": "Lagos"}'}}]}}]},
            {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
            {"choices": [], "usage": {"prompt_tokens": 11, "completion_tokens": 3}},
        ]:
            chunks.extend(stream.feed(obj))

        calls = [
            call
            for chunk in chunks
            for call in (chunk.get("message") or {}).get("tool_calls") or []
        ]
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["function"]["name"], "get_weather")
        self.assertEqual(calls[0]["function"]["arguments"], '{"city": "Lagos"}')
        self.assertEqual(calls[0]["id"], "call_1")
        counters = [chunk for chunk in chunks if "eval_count" in chunk]
        self.assertEqual(len(counters), 1, "usage is reported once, not per chunk")
        self.assertEqual(counters[0]["prompt_eval_count"], 11)

    def test_a_call_still_open_at_the_end_is_flushed(self):
        # A stream that ends without `finish_reason` — a dropped connection, a
        # provider that omits it — must not swallow the call the model made.
        stream = adapter.OpenAiStream()
        stream.feed({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c", "function": {"name": "f", "arguments": "{}"}}]}}]})
        flushed = stream.flush()
        self.assertEqual(flushed[0]["message"]["tool_calls"][0]["function"]["name"], "f")
        self.assertEqual(stream.flush(), [], "flushing twice must not repeat the call")

    def test_text_deltas_pass_through_untouched(self):
        stream = adapter.OpenAiStream()
        self.assertEqual(
            stream.feed({"choices": [{"delta": {"content": "hel"}}]})[0]["message"]["content"],
            "hel",
        )
