#!/usr/bin/env python3
"""A Responses API -> Ollama /api/chat adapter, so local models can run tools.

Why this exists
───────────────
Codex requires `wire_api = "responses"` for a custom provider ("chat" is a hard
config error on this build). Its Ollama path therefore lands on Ollama's
`/v1/responses`, which accepts `tools` and *ignores* them: a direct POST with a
tool array comes back with the call rendered as plain text and never a
`function_call`, so an agent run reads and replies but never acts.

Ollama's *native* `/api/chat` does support tools. This speaks the Responses API
to Codex and `/api/chat` to Ollama, translating tool calls and results in both
directions, and forwards Ollama's text deltas untouched.

Stdlib only, on purpose: it ships inside the app and must not add a dependency.

Verified, not assumed: with a provider table pointed at this and
`llama3.2:3b` as the model, `codex exec "Run the shell command: echo
adapter-works"` returned
`item.completed command_execution … aggregated_output: "adapter-works\n",
exit_code: 0` — the local model called a tool and the tool ran.

Two shape differences cost the most time, so they are named here:
Ollama's `/api/chat` wants tool-call `arguments` as an **object** (posting the
Responses string is a 400, "Value looks like object, but can't find closing
'}'"), and small models emit `null` for optional numeric fields, which Codex's
own tool schema rejects — so nulls are dropped on the way out.
"""

from __future__ import annotations

import http.client
import http.server
import json
import os
import socketserver
import sys
import threading
import time
import uuid

UPSTREAM_HOST = os.environ.get("ACSA_OLLAMA_HOST", "127.0.0.1")
UPSTREAM_PORT = int(os.environ.get("ACSA_OLLAMA_PORT", "11434"))

# Which shape the upstream speaks.
#
# "ollama" is the original: Ollama's native `/api/chat`. "openai" is any
# OpenAI-compatible `/chat/completions` — which is most of the registry, and the
# only way to reach one of them: the runtime requires the Responses API
# (`wire_api = "chat"` is rejected outright by the Codex build this ships), and
# almost no hosted provider implements Responses. Measured on NVIDIA NIM's public
# host, which is the case that prompted this:
#
#     POST https://integrate.api.nvidia.com/v1/responses        -> 404 page not found
#     POST https://integrate.api.nvidia.com/v1/chat/completions -> 403 (exists; needs a key)
#     GET  https://integrate.api.nvidia.com/v1/models           -> 200, 82 models
#
# So NIM cannot be pointed at directly, and neither can Groq, Mistral, xAI,
# Moonshot, Together, Cohere or OpenRouter unless their Responses support is
# verified first. Fronting them with this adapter is what makes them work.
UPSTREAM_MODE = os.environ.get("ACSA_ADAPTER_UPSTREAM", "ollama").strip().lower()
UPSTREAM_URL = os.environ.get("ACSA_ADAPTER_URL", "").strip()
UPSTREAM_KEY = os.environ.get("ACSA_ADAPTER_KEY", "")
DEBUG = os.environ.get("ACSA_ADAPTER_DEBUG") == "1"


def log(*parts: object) -> None:
    if DEBUG:
        print("[adapter]", *parts, file=sys.stderr, flush=True)


def warn(*parts: object) -> None:
    """A line the operator needs, whether or not debugging is on.

    `log` sits behind `ACSA_ADAPTER_DEBUG`, and a failure is not a debugging aid:
    when a provider stalls, this process is the only component that knows why, and
    its stderr is what a support bundle can read. It used to be thrown away at
    spawn — see `local_adapter_start` in `.tauri/src/main.rs`.
    """
    print("[adapter]", *parts, file=sys.stderr, flush=True)


def stdin_ended(source) -> bool:
    """Whether the pipe this process was handed has closed.

    Split out from the watcher below so it can be tested without exiting the test
    process: `watch_stdin` turns "True" into a process exit.
    """
    while True:
        try:
            if not source.read(1):
                return True
        except (OSError, ValueError):
            return True


def watch_stdin() -> None:
    """Exit when the app that started us goes away.

    This process is handed the provider's credential in its environment, and it
    used to outlive the app: a crashed or killed app left the adapter running, still
    holding the key, until the machine was rebooted — found by spotting an orphan
    from a killed run and reading its environment.

    The app holds the write end of our stdin and never writes to it, so the pipe
    closing is the app being gone — whatever killed it. Only used when the app asks
    for it (`ACSA_ADAPTER_WATCH_STDIN=1`), because a manually started adapter has a
    terminal on stdin and must not read from it.
    """
    source = getattr(sys.stdin, "buffer", None)
    if source is None:
        return
    if not stdin_ended(source):
        return
    log("the app that started this adapter is gone; exiting rather than holding its credential")
    os._exit(0)


def upstream_is_openai() -> bool:
    """Whether the upstream is an OpenAI-compatible `/chat/completions`."""
    return UPSTREAM_MODE == "openai"


def upstream_endpoint() -> tuple[str, str, int, str]:
    """`(scheme, host, port, path)` for the OpenAI upstream, from its base URL."""
    scheme, _, rest = UPSTREAM_URL.partition("://")
    scheme = scheme or "https"
    hostport, _, path = rest.partition("/")
    host, _, port = hostport.partition(":")
    return (
        scheme,
        host,
        int(port) if port else (443 if scheme == "https" else 80),
        "/" + path.strip("/") + "/chat/completions" if path else "/v1/chat/completions",
    )


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def now() -> int:
    return int(time.time())


# ── Responses -> chat ───────────────────────────────────────────────────────


def chat_tools(tools) -> list:
    """Responses tools are flat (`{type, name, description, parameters}`); chat
    wants them nested under `function`. Accept both so a chat-shaped request is
    not silently double-wrapped."""
    out = []
    for tool in tools or []:
        if not isinstance(tool, dict) or tool.get("type") != "function":
            continue
        fn = tool.get("function") if isinstance(tool.get("function"), dict) else tool
        name = fn.get("name") or ""
        if not name:
            continue
        out.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": fn.get("description") or "",
                    "parameters": fn.get("parameters") or {"type": "object", "properties": {}},
                },
            }
        )
    return out


def as_object(raw):
    """A tool-call argument blob as an object, for the chat direction."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


# JSON Schema type name -> the Python type an instance must have to be valid.
_SCHEMA_TYPES = {
    "array": list,
    "object": dict,
    "string": str,
    "boolean": bool,
    "integer": int,
    "number": (int, float),
}


def clean_arguments(raw, schema=None) -> str:
    """Tool arguments as a JSON string, with the model's guesses removed.

    Small local models do not leave optional fields alone. They fill them with
    something shaped like a value, and Codex's own tool schemas are strict, so the
    call is rejected outright before anything runs:

        "yield_time_ms": null        -> "invalid type: null, expected u64"
        "prefix_rule": ""            -> "invalid type: string \"\", expected a sequence"

    Both are the model saying "use the default" in a way the schema cannot accept.
    The tool's own `parameters` is right here in the request, so an argument that
    cannot possibly be valid for its declared type is dropped rather than passed
    on to fail — that is what the model meant. Anything unparseable is left
    untouched so the real error stays visible.
    """
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return raw
    elif raw is None:
        return "{}"
    else:
        parsed = raw
    if not isinstance(parsed, dict):
        return json.dumps(parsed)

    schema = schema if isinstance(schema, dict) else {}
    properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    strict = schema.get("additionalProperties") is False

    cleaned = {}
    for key, value in parsed.items():
        if value is None:
            continue
        declared = properties.get(key)
        if declared is None:
            # Not in the schema: only dropped when the schema says extras are not
            # allowed, which is exactly when it would fail.
            if not strict:
                cleaned[key] = value
            continue
        declared_type = declared.get("type") if isinstance(declared, dict) else None
        # Codex writes nullable fields as `["array", "null"]`; the non-null arm is
        # the one that says what a value would have to look like.
        if isinstance(declared_type, list):
            declared_type = next((part for part in declared_type if part != "null"), None)
        want = _SCHEMA_TYPES.get(declared_type) if isinstance(declared_type, str) else None
        if want is not None:
            # `True` is an `int` in Python; a boolean where a number was asked for
            # is a guess, not a number.
            if isinstance(value, bool) and want is not bool:
                continue
            if not isinstance(value, want):
                continue
        cleaned[key] = value
    return json.dumps(cleaned)


def _might_be_a_tool_call(text: str) -> bool:
    """Hold this text back: it could still turn out to be a tool call.

    Only the opening decides. A prose answer streams the moment it is recognisable
    as prose, so holding costs nothing in the normal case.
    """
    stripped = text.lstrip()
    if not stripped:
        return True
    if stripped[0] in "{[":
        return True
    if stripped.startswith("```"):
        rest = stripped[3:].lstrip()
        # ```json / ```{ / ```[ / a bare fence still being typed. "```python" is
        # an answer, not a tool call, and streams straight away.
        return rest[:1] in ("", "{", "[", "j", "J")
    return False


def _json_objects(text: str):
    """Every balanced `{...}` span, outermost first.

    Brace matching with a string/escape guard, so a `}` inside a command string
    does not end the object early.
    """
    depth = 0
    start = None
    in_string = False
    escaped = False
    for index, char in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            if depth == 0:
                start = index
            depth += 1
        elif char == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start is not None:
                    yield text[start : index + 1]
                    start = None


def tool_call_from_text(text: str, schemas: dict):
    """Recover a tool call that a model wrote as text.

    Not every local model can emit native tool calls. `qwen2.5-coder` and
    `deepseek-coder` answer with the call as JSON in the message body — and often
    with a sentence in front of it, "Here is the command you should run:" — which
    the runtime then shows as prose and never executes. Measured, both ways.

    So any balanced JSON object in the answer is a candidate, and it counts only
    if it names a tool this request actually offered with an object of arguments.
    That gate is what makes searching the whole answer safe: the name has to be
    one of a handful of tools the runtime just advertised, so prose that merely
    mentions a tool is not rewritten into one.
    """
    if not schemas:
        return None
    for candidate in _json_objects(text):
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if not isinstance(parsed, dict):
            continue

        inner = parsed.get("function") if isinstance(parsed.get("function"), dict) else {}
        name = parsed.get("name") or inner.get("name") or parsed.get("tool")
        if not isinstance(name, str) or name not in schemas:
            continue

        arguments = parsed.get("arguments")
        if arguments is None:
            arguments = inner.get("arguments")
        if arguments is None:
            arguments = parsed.get("parameters")
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError:
                continue
        if not isinstance(arguments, dict):
            continue
        return name, arguments
    return None


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks = []
        for part in content:
            if isinstance(part, dict):
                chunks.append(str(part.get("text") or ""))
            elif isinstance(part, str):
                chunks.append(part)
        return "".join(chunks)
    return ""


def reasoning_effort_of(body: dict) -> str:
    """The effort the caller asked for, or `""` when it did not ask.

    The runtime sends `reasoning: {"effort": "low"}` — confirmed by dumping a real
    request from the app (`ACSA_ADAPTER_DEBUG=1`) — so the level our model catalog
    declares does reach this process. It has to be carried one hop further.
    """
    reasoning = body.get("reasoning")
    if not isinstance(reasoning, dict):
        return ""
    effort = reasoning.get("effort")
    return effort if isinstance(effort, str) else ""


def chat_body_for_request(body: dict, model: str) -> dict:
    """One Responses request as the chat body its upstream wants."""
    chat_body: dict = {
        "model": model,
        "messages": chat_messages(body),
        "stream": True,
    }
    tools = chat_tools(body.get("tools"))
    if tools:
        chat_body["tools"] = tools
    # The effort, passed on where the field exists.
    #
    # It was being dropped here, which made the catalog's `default_reasoning_level`
    # decorative: the runtime asked for "low", this process discarded it, and a
    # cheap tier went on reasoning as hard as it liked. vLLM-backed servers — NVIDIA
    # NIM among them, whose own samples show `reasoning_effort` — take it as a
    # chat-body field. Ollama's native API has no equivalent (it takes `think` /
    # `options`), so that direction is left alone rather than sent a field it would
    # refuse.
    effort = reasoning_effort_of(body)
    if upstream_is_openai() and effort:
        chat_body["reasoning_effort"] = effort
    return chat_body


def without_reasoning_effort(payload: dict) -> dict:
    """A copy of a chat body with the effort field taken out."""
    return {key: value for key, value in payload.items() if key != "reasoning_effort"}


def should_retry_without_effort(status: int, payload: dict) -> bool:
    """Whether to take our own extra field back out and ask again.

    Any 400 or 422 counts, not only one that names the field. This first required
    the refusal to say "reasoning_effort", and a real one arrived as a single `{` —
    the gateway got one byte of its error body out before the connection went — so
    the retry never fired, four identical 400s were reported, and a provider looked
    broken for a reason we had introduced.

    Retrying once costs one request and settles which it was: if the refusal was
    about something else, it happens again, with the provider's own words by then.
    """
    return status in (400, 422) and "reasoning_effort" in payload


def chat_messages(body: dict) -> list:
    messages = []
    instructions = body.get("instructions")
    if instructions:
        messages.append({"role": "system", "content": str(instructions)})
    incoming = body.get("input")
    if isinstance(incoming, str):
        messages.append({"role": "user", "content": incoming})
        return messages
    for item in incoming or []:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind == "message":
            role = item.get("role") or "user"
            if role == "developer":
                role = "system"
            messages.append({"role": role, "content": text_of(item.get("content"))})
        elif kind == "function_call":
            # The model's earlier tool call, replayed as history.
            #
            # The two upstreams disagree here, in opposite directions. Ollama
            # wants `arguments` as an object — posting the Responses string is a
            # 400, "Value looks like object, but can't find closing '}'" — and has
            # no notion of a call id. OpenAI wants the exact shape the Responses
            # API already carries: a JSON *string*, plus the id that pairs the call
            # with the `role: "tool"` message answering it.
            if upstream_is_openai():
                messages.append(
                    {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": item.get("call_id") or new_id("call"),
                                "type": "function",
                                "function": {
                                    "name": item.get("name") or "",
                                    "arguments": item.get("arguments") or "{}",
                                },
                            }
                        ],
                    }
                )
            else:
                messages.append(
                    {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "function": {
                                    "name": item.get("name") or "",
                                    "arguments": as_object(item.get("arguments")),
                                }
                            }
                        ],
                    }
                )
        elif kind == "function_call_output":
            output = (
                item.get("output")
                if isinstance(item.get("output"), str)
                else text_of(item.get("output"))
            )
            if upstream_is_openai():
                messages.append(
                    {"role": "tool", "tool_call_id": item.get("call_id") or "", "content": output}
                )
            else:
                messages.append(
                    {"role": "tool", "content": output, "tool_name": item.get("name") or ""}
                )
        elif kind == "reasoning":
            continue
        else:
            log("unhandled input item type:", kind)
    return messages


# ── OpenAI, replayed as the shape everything below was written for ──────────
#
# Everything downstream of the handler was built against Ollama's `/api/chat`:
# a `message` carrying `content` and `tool_calls`, and counters named
# `prompt_eval_count` / `eval_count`. Rather than teach all of it a second
# dialect, the two OpenAI entry points are converted into exactly that.


def upstream_message(result: dict) -> dict:
    """A non-streaming OpenAI reply as Ollama's `message`."""
    choice = ((result or {}).get("choices") or [{}])[0]
    message = choice.get("message") or {}
    content = message.get("content")
    calls = []
    for call in message.get("tool_calls") or []:
        fn = call.get("function") or {}
        calls.append(
            {
                "id": call.get("id"),
                "function": {
                    "name": fn.get("name") or "",
                    "arguments": fn.get("arguments") or "{}",
                },
            }
        )
    return {
        "content": content if isinstance(content, str) else (text_of(content) if content else ""),
        "tool_calls": calls,
    }


class OpenAiStream:
    """An OpenAI SSE stream, replayed as Ollama-shaped chunks.

    Two differences are load-bearing. OpenAI splits one tool call across chunks —
    the name in one, the JSON arguments over the next few — while the consumer
    here emits on first sight of a call, so without this the runtime would be
    handed an empty argument object. And OpenAI reports usage in a final chunk
    carrying no choices, where Ollama puts the counters on the last message.
    """

    def __init__(self) -> None:
        self.calls: dict[int, dict] = {}
        self.pending_prompt: int | None = None
        self.pending_output: int | None = None

    def feed(self, obj: dict) -> list[dict]:
        out: list[dict] = []
        usage = obj.get("usage") or {}
        if isinstance(usage.get("prompt_tokens"), int):
            self.pending_prompt = usage["prompt_tokens"]
        if isinstance(usage.get("completion_tokens"), int):
            self.pending_output = usage["completion_tokens"]

        for choice in obj.get("choices") or []:
            delta = choice.get("delta") or {}
            content = delta.get("content")
            if content:
                out.append(
                    {
                        "message": {
                            "content": content if isinstance(content, str) else text_of(content)
                        }
                    }
                )
            for call in delta.get("tool_calls") or []:
                index = call.get("index")
                key = index if isinstance(index, int) else len(self.calls)
                slot = self.calls.setdefault(key, {"id": None, "name": "", "arguments": ""})
                if call.get("id"):
                    slot["id"] = call["id"]
                fn = call.get("function") or {}
                if fn.get("name"):
                    slot["name"] += fn["name"]
                if fn.get("arguments"):
                    slot["arguments"] += fn["arguments"]
            if choice.get("finish_reason"):
                out.extend(self.flush())

        # Reported once, when it arrives, rather than repeated on every chunk.
        counters: dict = {}
        if self.pending_prompt is not None:
            counters["prompt_eval_count"] = self.pending_prompt
            self.pending_prompt = None
        if self.pending_output is not None:
            counters["eval_count"] = self.pending_output
            self.pending_output = None
        if counters:
            out.append(counters)
        return out

    def flush(self) -> list[dict]:
        """Emit the collected tool calls, if any are still open."""
        if not self.calls:
            return []
        calls = [
            {
                "id": slot["id"] or new_id("call"),
                "function": {"name": slot["name"], "arguments": slot["arguments"] or "{}"},
            }
            for _, slot in sorted(self.calls.items())
        ]
        self.calls.clear()
        return [{"message": {"content": "", "tool_calls": calls}}]


# ── The Responses envelope (field-for-field what Ollama emits) ───────────────


def upstream_failure_message(status: int, body: bytes) -> str:
    """A sentence for a provider failure, rather than a status code on its own.

    Written for the case that prompted it: NVIDIA NIM's free tier answered 504 to
    every attempt, and all anyone could see was "upstream 504: b''" in a log file.
    """
    detail = body_hint(body)
    known = {
        400: "the provider refused the request (400) — a model or a field it does not accept",
        401: "the provider refused the credential (401)",
        403: "the provider refused the request (403)",
        404: "the provider has no such endpoint or model (404)",
        422: "the provider refused the request (422)",
        429: "the provider is rate limiting (429)",
        500: "the provider failed internally (500)",
        502: "the provider's gateway failed (502)",
        503: "the provider is unavailable (503)",
        504: "the provider timed out at its own gateway (504) — a loaded free tier does this",
    }
    sentence = known.get(status, f"the provider answered HTTP {status or 'nothing'}")
    return f"{sentence}: {detail}" if detail else sentence


def body_hint(body: bytes) -> str:
    """The provider's own words, when the body actually carries any.

    A gateway that refuses mid-write leaves a fragment — a real one produced a
    single `{` — and printing that after a sentence makes the message look broken
    rather than the request. So a body is used only when it says something: a
    readable fragment, or a JSON error's message.
    """
    text = (body or b"").decode("utf-8", "replace").strip()
    if not text:
        return ""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        # A fragment worth repeating is one with words in it, `{` is not.
        return text[:200] if len(text) >= 12 else ""
    if isinstance(parsed, dict):
        for key in ("message", "detail", "title", "error"):
            value = parsed.get(key)
            if isinstance(value, str) and value:
                return value[:200]
            if isinstance(value, dict):
                inner = value.get("message") or value.get("detail")
                if isinstance(inner, str) and inner:
                    return inner[:200]
    return ""


def envelope(resp_id: str, model: str, status: str, output, usage=None, error=None) -> dict:
    return {
        "background": False,
        "completed_at": now() if status == "completed" else None,
        "created_at": now(),
        # A failed response has to say *why*. Sent empty, the runtime reads the
        # failure as a stream that ended early and retries five times — verified by
        # pointing it at an upstream that always answers 504: "stream disconnected
        # before completion: response.failed event received", five times, then
        # nothing. With a reason in it the same answer is reportable.
        "error": error,
        "frequency_penalty": 0,
        "id": resp_id,
        "incomplete_details": None,
        "instructions": None,
        "max_output_tokens": None,
        "max_tool_calls": None,
        "metadata": {},
        "model": model,
        "object": "response",
        "output": output,
        "parallel_tool_calls": True,
        "presence_penalty": 0,
        "previous_response_id": None,
        "prompt_cache_key": None,
        "reasoning": None,
        "safety_identifier": None,
        "service_tier": "default",
        "status": status,
        "store": False,
        "temperature": 1,
        "text": {"format": {"type": "text"}},
        "tool_choice": "auto",
        "tools": [],
        "top_logprobs": 0,
        "top_p": 1,
        "truncation": "disabled",
        "usage": usage,
    }


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # quiet
        pass

    def _chunk(self, payload: bytes) -> None:
        self.wfile.write(b"%x\r\n" % len(payload) + payload + b"\r\n")
        self.wfile.flush()

    def _sse(self, event: str, data: dict) -> None:
        self._chunk(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", "/v1/health", ""):
            body = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        if not self.path.rstrip("/").endswith("/responses"):
            self.send_error(404, "only /v1/responses is implemented")
            return
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError as error:
            self.send_error(400, f"bad json: {error}")
            return

        if DEBUG:
            # Best effort: this is a debugging aid, and it used to take the whole
            # request down when the directory did not exist yet — so turning the
            # env var on replaced a working adapter with one that answered nothing.
            try:
                dump = os.environ.get("ACSA_ADAPTER_DUMP", "/tmp/resp-adapter/last-request.json")
                os.makedirs(os.path.dirname(dump), exist_ok=True)
                with open(dump, "w") as fh:
                    json.dump(body, fh, indent=1)
            except OSError as error:  # noqa: BLE001 - never fail the request for this
                log("could not write the request dump:", error)

        model = body.get("model") or "llama3.2:3b"
        stream = bool(body.get("stream", True))
        # name -> declared parameters, so a tool call can be checked against the
        # schema the model was actually given.
        schemas = {
            tool.get("name"): tool.get("parameters")
            for tool in (body.get("tools") or [])
            if isinstance(tool, dict) and tool.get("type") == "function" and tool.get("name")
        }
        chat_body = chat_body_for_request(body, model)
        log(
            "request",
            model,
            len(chat_body["messages"]),
            "messages,",
            len(chat_body.get("tools") or []),
            "tools,",
            f"effort={chat_body.get('reasoning_effort') or 'unset'}",
        )

        if not stream:
            self._respond_once(chat_body, model, schemas)
            return
        self._respond_stream(chat_body, model, schemas)

    # ── non-streaming ───────────────────────────────────────────────────────
    def _respond_once(self, chat_body: dict, model: str, schemas: dict) -> None:
        payload = dict(chat_body, stream=False)
        try:
            result = self._ollama_chat(payload, stream=False)
        except Exception as error:  # noqa: BLE001 - reported to the client
            self.send_error(502, f"upstream: {error}")
            return
        resp_id = new_id("resp")
        message = (result or {}).get("message") or {}
        output, _ = self._output_items(message, resp_id, 0, schemas)
        body = json.dumps(envelope(resp_id, model, "completed", output)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ── streaming ───────────────────────────────────────────────────────────
    def _respond_stream(self, chat_body: dict, model: str, schemas: dict) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        resp_id = new_id("resp")
        item_id = new_id("msg")
        self._pending_calls = []
        seq = 0

        def send(event: str, data: dict) -> None:
            data.setdefault("type", event)
            nonlocal seq
            data["sequence_number"] = seq
            seq += 1
            self._sse(event, data)

        send("response.created", {"response": envelope(resp_id, model, "in_progress", [])})
        send("response.in_progress", {"response": envelope(resp_id, model, "in_progress", [])})
        send(
            "response.output_item.added",
            {"output_index": 0, "item": {"content": [], "id": item_id, "role": "assistant", "status": "in_progress", "type": "message"}},
        )
        send(
            "response.content_part.added",
            {
                "content_index": 0,
                "item_id": item_id,
                "output_index": 0,
                "part": {"annotations": [], "logprobs": [], "text": "", "type": "output_text"},
            },
        )

        # Finish the message item, once.
        #
        # The runtime's stream has exactly one active output item at a time, and it
        # says so out loud when that is violated: a real run on NVIDIA NIM logged
        # `ERROR … "OutputTextDelta without active item"` because the model wrote
        # text and then called a tool in the same turn, and this adapter went on
        # sending text deltas — and closed the message item — *after* the function
        # call had become the active item. Closing the message first is also just the
        # right order: text item completes, then the call it led to.
        closed_message = False

        def close_message(final_text: str) -> None:
            nonlocal closed_message
            if closed_message:
                return
            closed_message = True
            if final_text:
                send(
                    "response.output_text.done",
                    {"content_index": 0, "item_id": item_id, "logprobs": [], "output_index": 0, "text": final_text},
                )
                send(
                    "response.content_part.done",
                    {
                        "content_index": 0,
                        "item_id": item_id,
                        "output_index": 0,
                        "part": {"annotations": [], "logprobs": [], "text": final_text, "type": "output_text"},
                    },
                )
            send(
                "response.output_item.done",
                {
                    "output_index": 0,
                    "item": {
                        "content": (
                            [{"annotations": [], "logprobs": [], "text": final_text, "type": "output_text"}]
                            if final_text
                            else []
                        ),
                        "id": item_id,
                        "role": "assistant",
                        "status": "completed",
                        "type": "message",
                    },
                },
            )

        text = ""
        # Text not yet sent, while it could still be a tool call.
        held = ""
        streaming = False
        prompt_tokens = 0
        output_tokens = 0
        try:
            for chunk in self._ollama_chat_stream(chat_body):
                if isinstance(chunk.get("prompt_eval_count"), int):
                    prompt_tokens = chunk["prompt_eval_count"]
                if isinstance(chunk.get("eval_count"), int):
                    output_tokens = chunk["eval_count"]
                message = chunk.get("message") or {}
                delta = message.get("content") or ""
                if delta:
                    text += delta
                    if closed_message:
                        # Text after a call: the call is the active item now, so a
                        # delta here is the error above in the other direction.
                        # The text is still the turn's text, just not streamed.
                        pass
                    elif streaming:
                        send(
                            "response.output_text.delta",
                            {"content_index": 0, "delta": delta, "item_id": item_id, "logprobs": [], "output_index": 0},
                        )
                    else:
                        held += delta
                        if not _might_be_a_tool_call(held):
                            streaming = True
                            send(
                                "response.output_text.delta",
                                {"content_index": 0, "delta": held, "item_id": item_id, "logprobs": [], "output_index": 0},
                            )
                            held = ""
                calls = message.get("tool_calls") or []
                if calls:
                    close_message(text if streaming else "")
                    self._emit_tool_calls(calls, output_index=1, send=send, resp_id=resp_id, schemas=schemas)
        except Exception as error:  # noqa: BLE001 - surfaced as a failed response
            warn("stream failed:", error)
            send(
                # `response.failed`, with the reason in it.
                #
                # The runtime reads this event as a stream that ended early and
                # retries five times — measured against a local upstream that always
                # answers 504: five "stream disconnected before completion" lines and
                # then nothing, i.e. twenty minutes of a turn spent on a provider
                # that had already said no. Completing the stream with a failed
                # response does stop the retrying, and was tried and reverted: the
                # runtime then reports *nothing at all* and the app reads the turn as
                # an empty success, which is worse than a loud retry.
                #
                # So the retry is left to the runtime, and the reason goes in the
                # event and the log — which is what the OUTPUT panel shows and what
                # `friendly_agent_line` turns into a sentence.
                "response.failed",
                {
                    "response": envelope(
                        resp_id,
                        model,
                        "failed",
                        [],
                        error={
                            "code": "upstream_error",
                            "message": str(error) or "the provider failed without saying why",
                        },
                    )
                },
            )
            self._chunk(b"")
            return

        # Nothing streamed, so decide now what the held text was.
        recovered = None
        # Not when a call already went out: that *is* the turn's action, and
        # recovering a second one from leftover text would add a tool call the model
        # never made as its answer.
        if held and not streaming and not closed_message:
            recovered = tool_call_from_text(held, schemas)
            if recovered:
                log("recovered a tool call the model wrote as text:", recovered[0], json.dumps(recovered[1])[:200])
                self._emit_tool_calls(
                    [
                        {
                            "id": new_id("call"),
                            "function": {"name": recovered[0], "arguments": json.dumps(recovered[1])},
                        }
                    ],
                    output_index=1,
                    send=send,
                    resp_id=resp_id,
                    schemas=schemas,
                )
            else:
                streaming = True
                send(
                    "response.output_text.delta",
                    {"content_index": 0, "delta": held, "item_id": item_id, "logprobs": [], "output_index": 0},
                )
            held = ""

        # A recovered call is not also an answer: the message item stays empty, so
        # the chat does not show `{"name": …}` as prose beside the tool it drove.
        message_text = "" if recovered else text
        # Idempotent: a turn that called a tool already closed it, with whatever text
        # came before the call.
        close_message(message_text)

        finished = []
        if message_text:
            finished.append(
                {
                    "content": [{"annotations": [], "logprobs": [], "text": message_text, "type": "output_text"}],
                    "id": item_id,
                    "role": "assistant",
                    "status": "completed",
                    "type": "message",
                }
            )
        finished.extend(self._pending_calls)
        # Report the counters Ollama gives us, so the app's usage ledger and cost
        # page show real numbers for local runs instead of zeros.
        usage = None
        if prompt_tokens or output_tokens:
            usage = {
                "input_tokens": prompt_tokens,
                "input_tokens_details": {"cached_tokens": 0},
                "output_tokens": output_tokens,
                "output_tokens_details": {"reasoning_tokens": 0},
                "total_tokens": prompt_tokens + output_tokens,
            }
        send("response.completed", {"response": envelope(resp_id, model, "completed", finished, usage)})
        self._chunk(b"")

    def _emit_tool_calls(self, calls, output_index: int, send, resp_id: str, schemas: dict) -> None:
        for call in calls:
            fn = call.get("function") or {}
            name = fn.get("name") or ""
            arguments = clean_arguments(fn.get("arguments"), schemas.get(name))
            call_id = call.get("id") or new_id("call")
            item_id = new_id("fc")
            send(
                "response.output_item.added",
                {
                    "output_index": output_index,
                    "item": {
                        "arguments": "",
                        "call_id": call_id,
                        "id": item_id,
                        "name": name,
                        "status": "in_progress",
                        "type": "function_call",
                    },
                },
            )
            send(
                "response.function_call_arguments.delta",
                {"delta": arguments, "item_id": item_id, "output_index": output_index},
            )
            send(
                "response.function_call_arguments.done",
                {"arguments": arguments, "item_id": item_id, "output_index": output_index},
            )
            done = {
                "arguments": arguments,
                "call_id": call_id,
                "id": item_id,
                "name": name,
                "status": "completed",
                "type": "function_call",
            }
            send("response.output_item.done", {"output_index": output_index, "item": done})
            self._pending_calls.append(done)
            output_index += 1

    def _output_items(self, message: dict, resp_id: str, index: int, schemas: dict):
        items = []
        text = message.get("content") or ""
        if text:
            items.append(
                {
                    "content": [{"annotations": [], "logprobs": [], "text": text, "type": "output_text"}],
                    "id": new_id("msg"),
                    "role": "assistant",
                    "status": "completed",
                    "type": "message",
                }
            )
        for call in message.get("tool_calls") or []:
            fn = call.get("function") or {}
            args = clean_arguments(fn.get("arguments"), schemas.get(fn.get("name")))
            items.append(
                {
                    "arguments": args,
                    "call_id": call.get("id") or new_id("call"),
                    "id": new_id("fc"),
                    "name": fn.get("name") or "",
                    "status": "completed",
                    "type": "function_call",
                }
            )
        return items, index

    # ── upstream ────────────────────────────────────────────────────────────
    def _upstream_post(self, payload: dict, stream: bool):
        """POST to the upstream, whichever shape it speaks. → `(conn, response)`."""
        timeout = 600
        if upstream_is_openai():
            scheme, host, port, path = upstream_endpoint()
            if not host:
                warn("no upstream base URL: pass --base-url (or ACSA_ADAPTER_URL)")
                raise RuntimeError("no upstream base URL: pass --base-url (or ACSA_ADAPTER_URL)")
            conn = (
                http.client.HTTPSConnection(host, port, timeout=timeout)
                if scheme == "https"
                else http.client.HTTPConnection(host, port, timeout=timeout)
            )
            body = dict(payload)
            if stream:
                # OpenAI sends usage only in the final chunk, and only when asked.
                body["stream_options"] = {"include_usage": True}
            headers = {
                "Content-Type": "application/json",
                "Accept": "text/event-stream" if stream else "application/json",
            }
            if UPSTREAM_KEY:
                headers["Authorization"] = f"Bearer {UPSTREAM_KEY}"
            conn.request("POST", path, body=json.dumps(body).encode(), headers=headers)
            return conn, conn.getresponse()

        conn = http.client.HTTPConnection(UPSTREAM_HOST, UPSTREAM_PORT, timeout=timeout)
        conn.request(
            "POST",
            "/api/chat",
            body=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        return conn, conn.getresponse()

    def _ollama_chat(self, payload: dict, stream: bool) -> dict:
        """The upstream's reply, reshaped to what `/api/chat` returns."""
        conn, response = self._upstream_post(payload, stream=False)
        raw = response.read()
        conn.close()
        if should_retry_without_effort(response.status, payload):
            warn(f"upstream answered {response.status}; retrying once without reasoning_effort")
            payload = without_reasoning_effort(payload)
            conn, response = self._upstream_post(payload, stream=False)
            raw = response.read()
            conn.close()
        if response.status != 200:
            reason = upstream_failure_message(response.status, raw)
            warn("upstream answered", response.status, "—", reason)
            raise RuntimeError(reason)
        result = json.loads(raw)
        if not upstream_is_openai():
            return result
        return {"message": upstream_message(result)}

    def _ollama_chat_stream(self, payload: dict):
        conn, response = self._upstream_post(payload, stream=True)
        if should_retry_without_effort(response.status, payload):
            # Only a *rejection* is read here. On a 200 the body is the stream
            # itself, and peeking at it would swallow the first chunk.
            raw = response.read()
            conn.close()
            warn(f"upstream answered {response.status}; retrying once without reasoning_effort")
            payload = without_reasoning_effort(payload)
            conn, response = self._upstream_post(payload, stream=True)
        if response.status != 200:
            raw = response.read()
            conn.close()
            reason = upstream_failure_message(response.status, raw)
            warn("upstream answered", response.status, "—", reason)
            raise RuntimeError(reason)
        # OpenAI's stream is SSE and, unlike Ollama's, splits one tool call over
        # several chunks; the accumulator puts those back together and hands the
        # rest of this file the shape it was written for.
        accumulator = OpenAiStream() if upstream_is_openai() else None
        buffer = b""
        while True:
            block = response.read(1)
            if not block:
                break
            buffer += block
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                line = line.strip()
                if not line:
                    continue
                if accumulator is None:
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    continue
                if line.startswith(b"data:"):
                    line = line[5:].strip()
                if line == b"[DONE]":
                    for chunk in accumulator.flush():
                        yield chunk
                    conn.close()
                    return
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                for chunk in accumulator.feed(obj):
                    yield chunk
        if accumulator is not None:
            for chunk in accumulator.flush():
                yield chunk
        conn.close()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    """Run the adapter. Reached as `acsa-engine adapter`, or directly.

    The caller chooses the port and waits for `/health`, so startup order is not
    a race and no port is guessed.
    """
    global UPSTREAM_HOST, UPSTREAM_PORT, UPSTREAM_MODE, UPSTREAM_URL, UPSTREAM_KEY
    args = sys.argv[1:]
    port = int(os.environ.get("ACSA_ADAPTER_PORT", "11500"))
    host = "127.0.0.1"
    for index, arg in enumerate(args):
        nxt = args[index + 1] if index + 1 < len(args) else ""
        if arg == "--port" and nxt:
            port = int(nxt)
        elif arg == "--host" and nxt:
            host = nxt
        elif arg == "--ollama-host" and nxt:
            UPSTREAM_HOST = nxt
        elif arg == "--ollama-port" and nxt:
            UPSTREAM_PORT = int(nxt)
        elif arg == "--upstream" and nxt:
            UPSTREAM_MODE = nxt.strip().lower()
        elif arg == "--base-url" and nxt:
            UPSTREAM_URL = nxt.strip()
        # The credential arrives in the environment (`ACSA_ADAPTER_KEY`), never as
        # an argument: this process's argv is readable by any process on the
        # machine, and a key in it would be the same mistake as a key in a URL.
    with Server((host, port), Handler) as server:
        target = (
            f"openai {UPSTREAM_URL or '(no base URL — set --base-url)'}"
            if upstream_is_openai()
            else f"ollama {UPSTREAM_HOST}:{UPSTREAM_PORT}"
        )
        log(f"listening on {host}:{port} -> {target}")
        if os.environ.get("ACSA_ADAPTER_WATCH_STDIN") == "1":
            threading.Thread(target=watch_stdin, daemon=True).start()
        server.serve_forever()


if __name__ == "__main__":
    main()
