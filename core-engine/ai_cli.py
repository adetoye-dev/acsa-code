#!/usr/bin/env python3
"""ai_cli.py — provider connectivity, verified server-side.

Why this exists: `/api/ai/test-connection` was a ~250-line pile of per-vendor
branches in `vite-fs-bridge.ts`, a Vite dev-server middleware. In the packaged app
"Test Connection" therefore always failed, in both Settings and the AI dashboard —
and the failure looked like a bad key rather than a missing backend.

The credential never leaves the machine: it is resolved here, server-side, from the
provider registry (env first, then the database), exactly as the engine resolves it
for real requests. The page only learns whether the provider answered.

Usage: python3 ai_cli.py test-connection '{"provider": "deepseek"}'
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import http_identity
import tls_context

# Vendors that speak the OpenAI wire format (`GET /models`, bearer token).
OPENAI_COMPATIBLE = {
    "openai",
    "deepseek",
    "groq",
    "mistral",
    "moonshot",
    "together",
    "openrouter",
    "xai",
    "perplexity",
    "huggingface",
}

DEFAULT_BASE_URLS = {
    "openai": "https://api.openai.com/v1",
    "deepseek": "https://api.deepseek.com/v1",
    "groq": "https://api.groq.com/openai/v1",
    "mistral": "https://api.mistral.ai/v1",
    "moonshot": "https://api.moonshot.cn/v1",
    "together": "https://api.together.xyz/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "xai": "https://api.x.ai/v1",
    "perplexity": "https://api.perplexity.ai",
    "huggingface": "https://api-inference.huggingface.co/v1",
    "anthropic": "https://api.anthropic.com",
    # Gemini's OpenAI-compatible surface. The bare host is a different API: a call
    # to `{host}/chat/completions` 404s, and `{host}/v1beta/models` answers — which
    # is exactly the combination that made "Test Connection" pass while every chat
    # and agent turn failed.
    "google": "https://generativelanguage.googleapis.com/v1beta/openai",
    "ollama": "http://127.0.0.1:11434",
}


def _resolve_key(provider: str, explicit: str) -> str:
    """Explicit value first, then the registry (environment, then database)."""
    if explicit.strip():
        return explicit.strip()
    try:
        import db_cli

        resolved = db_cli._cmd_providers_resolve_key({"id": provider})
        return (resolved or "").strip()
    except Exception:  # noqa: BLE001 - no key is a valid answer, not a crash
        return ""


def _get(url: str, headers: dict[str, str], timeout: float = 12.0):
    # Identity first, so a caller cannot forget it and reintroduce the Groq 403 —
    # `urllib` fills in `Python-urllib/3.x` for any request that does not say.
    request = urllib.request.Request(
        url, headers={"User-Agent": http_identity.USER_AGENT, **headers}, method="GET"
    )
    try:
        # The engine ships frozen, and the interpreter that froze it decides
        # whether TLS can verify anything at all. See tls_context.
        with urllib.request.urlopen(
            request, timeout=timeout, context=tls_context.https_context()
        ) as response:
            return response.status, json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            body = json.loads(exc.read().decode("utf-8", "replace"))
            detail = (body.get("error") or {}).get("message") or body.get("message") or ""
        except Exception:  # noqa: BLE001 - the status code is the useful part
            detail = ""
        return exc.code, {"error": detail}
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return 0, {"error": str(exc)}


def _error_text(body: object) -> str:
    """A provider's failure, as one string.

    Every hosted provider nests the reason differently — OpenAI and Anthropic put a
    `message` inside an `error` object, others return a bare string, Gemini returns a
    list of attempts — and this used to hand whatever it found straight to the UI. A
    dict arrived as "[object Object]", and the settings page reads `.message`, so the
    real reason was dropped and every failure read "Connection failed. Please check
    endpoint or API key." whatever had actually happened. Which is what a person sees
    when a key is rejected, when an account has no credit, and when the network is
    down — the same sentence for three different fixes.
    """
    if isinstance(body, str):
        return body.strip()
    if not isinstance(body, dict):
        return ""
    error = body.get("error")
    if isinstance(error, str):
        return error.strip()
    if isinstance(error, dict):
        for key in ("message", "detail", "reason"):
            value = error.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    for key in ("message", "detail", "reason", "error_description"):
        value = body.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _names(payload: dict) -> list[str]:
    """OpenAI-shaped `{"data": [{"id": ...}]}` or Gemini's `{"models": [...]}`."""
    entries = payload.get("data") or payload.get("models") or []
    names: list[str] = []
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        name = entry.get("id") or entry.get("name") or entry.get("model")
        # Gemini reports `models/gemini-2.0-flash`.
        if isinstance(name, str) and name:
            # `models/` is a route prefix Gemini puts on every id, and its call takes
            # the bare id. Any *other* slash is part of the id: `deepseek-ai/deepseek-v4.1-flash`
            # and `anthropic/claude-3.7-sonnet` are what those providers serve, and
            # stripping the owner produced models they had never heard of — so the app
            # listed a model and then 404ed on the very next call. NVIDIA NIM is the
            # case that surfaced it: all 82 of its ids are owner-qualified.
            names.append(name[len("models/"):] if name.startswith("models/") else name)
    return names


def test_connection(payload: dict) -> dict:
    provider = str(payload.get("provider") or "").strip()
    base_url = str(payload.get("baseUrl") or DEFAULT_BASE_URLS.get(provider, "")).rstrip("/")
    key = _resolve_key(provider, str(payload.get("apiKey") or ""))

    if provider == "deterministic":
        return {"ok": True, "success": True, "latencyMs": 2, "message": "Deterministic AST compiler ready"}

    if provider == "ollama":
        started = time.monotonic()
        status, body = _get(f"{base_url or DEFAULT_BASE_URLS['ollama']}/api/tags", {})
        latency = int((time.monotonic() - started) * 1000)
        if status != 200:
            return {
                "ok": False,
                "success": False,
                "latencyMs": latency,
                "error": _error_text(body) or "Ollama is not reachable on 127.0.0.1:11434.",
            }
        return {
            "ok": True,
            "success": True,
            "latencyMs": latency,
            "models": [m.get("name") for m in body.get("models", []) if m.get("name")],
        }

    if not key:
        return {"ok": False, "success": False, "latencyMs": 0, "error": "API Key is required"}

    started = time.monotonic()
    if provider in OPENAI_COMPATIBLE:
        status, body = _get(
            f"{base_url}/models",
            {"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )
    elif provider == "anthropic":
        status, body = _get(
            f"{base_url}/v1/models",
            {"x-api-key": key, "anthropic-version": "2023-06-01"},
        )
    else:
        # Gemini's OpenAI-compatible surface lists models with the same bearer it
        # takes for chat, now that the base URL is that surface rather than the host.
        status, body = _get(f"{base_url}/models", {"Authorization": f"Bearer {key}"})

    latency = int((time.monotonic() - started) * 1000)
    if status != 200:
        return {
            "ok": False,
            "success": False,
            "latencyMs": latency,
            "error": (
                f"HTTP {status or 'unreachable'}: {_error_text(body)}"
                if _error_text(body)
                else f"Provider returned HTTP {status or 'unreachable'}"
            ),
        }

    models = _names(body)
    return {
        "ok": True,
        "success": True,
        "latencyMs": latency,
        "models": models,
        "message": f"Connection verified — {len(models)} models available." if models else "Connection verified!",
    }


def _post_json(url: str, headers: dict[str, str], body: dict, timeout: float):
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"User-Agent": http_identity.USER_AGENT, **headers},
        method="POST",
    )
    try:
        # The engine ships frozen, and the interpreter that froze it decides
        # whether TLS can verify anything at all. See tls_context.
        with urllib.request.urlopen(
            request, timeout=timeout, context=tls_context.https_context()
        ) as response:
            return response.status, json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        return exc.code, {"error": f"HTTP {exc.code}"}
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return 0, {"error": str(exc)}


def _record_usage(
    provider: str,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    latency_ms: float,
    project_root: Any = "",
) -> None:
    """Append one call to the app's usage ledger. Best-effort by design.

    Metering is diagnostics: it must never be the reason a review, an inline
    edit or a chat reply fails, so every failure here is swallowed. Cost is left
    to the ledger, which owns the pricing table.
    """
    try:
        import db_cli

        db_cli._cmd_usage_record(
            {
                "provider": provider,
                "model": model or provider,
                "prompt_tokens": int(prompt_tokens or 0),
                "completion_tokens": int(completion_tokens or 0),
                "latency_ms": float(latency_ms or 0.0),
                "project_path": str(project_root or "") or None,
            }
        )
    except Exception:  # noqa: BLE001 - see docstring
        pass


def usage(payload: dict) -> dict:
    """Aggregated usage for the Performance page."""
    import db_cli

    return db_cli._cmd_usage_summary(
        {
            "projectPath": payload.get("projectRoot") or payload.get("projectPath"),
            "sinceTs": payload.get("sinceTs") or payload.get("since_ts") or 0,
            "days": payload.get("days") or 14,
        }
    )


# The review prompt is the behaviour, so it is ported verbatim: strict JSON, real
# line numbers from the gutter, and a hard cap on how much of a big file is sent.
REVIEW_SYSTEM_PROMPT = (
    "You are a meticulous senior code reviewer. Analyse the provided file and report concrete issues: bugs, logic errors, edge cases, security problems, and worthwhile refactors. "
    'Respond with ONLY a JSON object whose top-level key is exactly "issues": {"issues":[{"line":<number>,"severity":"error|warning|info","title":"<short>","detail":"<why>","suggestion":"<concrete fix>"}]}. '
    'Example of the exact shape expected (illustrative only): {"issues":[{"line":42,"severity":"warning","title":"Missing null check","detail":"provider can be undefined here","suggestion":"Guard with if (!provider) return;"}]}. '
    "The file is given with its real line numbers in a left gutter formatted 'NNNN| code'. Set `line` to the exact number shown in that gutter for the code you are describing. "
    "Never invent line numbers and never cite a line that is not shown. Different findings normally sit on different lines; only repeat a line when two findings genuinely concern that one line. "
    'Report at most 12 issues, most important first. If the file is clean, return {"issues":[]}. No prose, no markdown fences.'
)

REVIEW_CHAR_BUDGET = 12000


def _number_lines(content: str) -> tuple[str, int, int, int]:
    """Number the lines the model is allowed to cite, within a character budget."""
    lines = content.split("\n")
    numbered: list[str] = []
    used = 0
    first = last = 1
    for index, line in enumerate(lines, start=1):
        entry = f"{index:4d}| {line}"
        if numbered and used + len(entry) + 1 > REVIEW_CHAR_BUDGET:
            break
        if not numbered:
            first = index
        numbered.append(entry)
        used += len(entry) + 1
        last = index
    return "\n".join(numbered), first, last, len(lines)


def _extract_issues(raw: str) -> list[dict]:
    """Pull the findings out of a model reply, tolerating fences and stray prose."""
    candidate = raw.strip()
    if candidate.startswith("```"):
        candidate = candidate.split("```", 2)[1] if candidate.count("```") >= 2 else candidate
        candidate = candidate.split("\n", 1)[1] if "\n" in candidate else candidate
    start, end = candidate.find("{"), candidate.rfind("}")
    if start == -1 or end <= start:
        return []
    try:
        parsed = json.loads(candidate[start : end + 1])
    except ValueError:
        return []
    issues = parsed.get("issues") if isinstance(parsed, dict) else None
    if not isinstance(issues, list):
        return []
    cleaned = []
    for issue in issues[:12]:
        if not isinstance(issue, dict):
            continue
        try:
            line = int(issue.get("line"))
        except (TypeError, ValueError):
            continue
        cleaned.append(
            {
                "line": line,
                "severity": str(issue.get("severity") or "info"),
                "title": str(issue.get("title") or "Finding"),
                "detail": str(issue.get("detail") or ""),
                "suggestion": str(issue.get("suggestion") or ""),
            }
        )
    return cleaned


def _review_completion(
    provider: str, model: str, base_url: str, api_key: str, system: str, user: str
) -> tuple[bool, str, str, tuple[int, int]]:
    """One non-streaming completion. Returns (ok, text, error, (in_tokens, out_tokens)).

    Providers report real token counts on the same response, so metering uses
    them instead of guessing from character counts.
    """
    timeout = 180.0
    if provider == "ollama":
        status, body = _post_json(
            f"{base_url or DEFAULT_BASE_URLS['ollama']}/api/chat",
            {"Content-Type": "application/json"},
            {
                "model": model or "qwen2.5-coder:7b",
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "stream": False,
                "options": {"temperature": 0.1, "num_predict": 1600},
            },
            timeout,
        )
        if status != 200:
            return False, "", body.get("error") or f"Ollama request failed ({status})", (0, 0)
        return (
            True,
            ((body.get("message") or {}).get("content") or "").strip(),
            "",
            (int(body.get("prompt_eval_count") or 0), int(body.get("eval_count") or 0)),
        )

    if not api_key:
        return False, "", f"An API key is required for provider '{provider}'.", (0, 0)

    if provider == "anthropic":
        status, body = _post_json(
            f"{base_url or DEFAULT_BASE_URLS['anthropic']}/v1/messages",
            {"Content-Type": "application/json", "x-api-key": api_key, "anthropic-version": "2023-06-01"},
            {
                "model": model or "claude-3-5-sonnet-latest",
                "max_tokens": 1600,
                "system": system,
                "messages": [{"role": "user", "content": user}],
            },
            timeout,
        )
        if status != 200:
            return False, "", body.get("error") or f"Anthropic request failed ({status})", (0, 0)
        content = body.get("content") or [{}]
        tokens = body.get("usage") or {}
        return (
            True,
            (content[0].get("text") or "").strip(),
            "",
            (int(tokens.get("input_tokens") or 0), int(tokens.get("output_tokens") or 0)),
        )

    status, body = _post_json(
        f"{base_url or DEFAULT_BASE_URLS.get(provider, 'https://api.openai.com/v1')}/chat/completions",
        {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        {
            "model": model or "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.1,
        },
        timeout,
    )
    if status != 200:
        return False, "", body.get("error") or f"Provider request failed ({status})", (0, 0)
    choices = body.get("choices") or [{}]
    tokens = body.get("usage") or {}
    return (
        True,
        ((choices[0].get("message") or {}).get("content") or "").strip(),
        "",
        (int(tokens.get("prompt_tokens") or 0), int(tokens.get("completion_tokens") or 0)),
    )


def review_file(payload: dict) -> dict:
    """Review one file and return findings anchored to real line numbers."""
    content = str(payload.get("content") or "")
    if not content.strip():
        return {"ok": False, "error": "File is empty.", "issues": []}

    provider = str(payload.get("provider") or "ollama").strip()
    model = str(payload.get("model") or "").strip()
    base_url = str(payload.get("baseUrl") or "").rstrip("/")
    api_key = _resolve_key(provider, str(payload.get("apiKey") or ""))

    numbered, first_line, last_line, total_lines = _number_lines(content)
    language = str(payload.get("language") or "")
    excerpt = (
        f"Only lines {first_line}-{last_line} of {total_lines} are shown (the file was truncated). Report issues only within that range."
        if last_line < total_lines
        else f"The whole file ({total_lines} lines) is shown."
    )
    user_prompt = (
        f"File: {payload.get('path') or ''}{f' ({language})' if language else ''}\n"
        f"{excerpt}\n\n{numbered}\n\nReturn the JSON review object."
    )

    started = time.monotonic()
    ok, raw, error, tokens = _review_completion(
        provider, model, base_url, api_key, REVIEW_SYSTEM_PROMPT, user_prompt
    )
    elapsed_ms = int((time.monotonic() - started) * 1000)
    if not ok:
        return {"ok": False, "error": error, "issues": []}

    # A citation outside the excerpt cannot have been seen, and repeats would stack
    # two threads on one line — the same guards the dev bridge applied.
    visible = set(range(first_line, last_line + 1))
    seen: set[str] = set()
    issues = []
    for issue in _extract_issues(raw):
        key = f"{issue['line']}|{issue['title']}"
        if issue["line"] not in visible or key in seen:
            continue
        seen.add(key)
        issues.append(issue)

    _record_usage(
        provider, model, tokens[0], tokens[1], elapsed_ms, payload.get("projectRoot")
    )

    return {
        "ok": True,
        "model": model,
        "provider": provider,
        "note": "",
        "warning": ""
        if issues or '"issues"' in raw
        else "The model returned a response that could not be parsed as review findings.",
        "issues": issues,
    }


INLINE_SYSTEM_PROMPT = (
    "You are an expert code editing assistant. Given existing code and instructions, return ONLY the updated replacement code. "
    "Do not include conversational commentary, explanations, or markdown code fences."
)


def _sanitize_inline_replacement(replacement: str, selected: str, prefix: str, suffix: str) -> dict:
    """Reduce a model reply to just the edited code, or explain why it cannot be.

    Ported because it is what makes the feature safe to apply: models routinely wrap
    output in fences, echo the context back, or answer a small edit with a whole
    rewritten file.
    """
    selected = (selected or "").replace("\r\n", "\n")
    replacement = (replacement or "").replace("\r\n", "\n").strip()

    # 1. Unwrap a fenced block, discarding prose around it.
    fenced = re.search(r"```[a-zA-Z0-9_+-]*\n([\s\S]*?)```", replacement)
    if fenced:
        replacement = fenced.group(1).strip()
    else:
        replacement = re.sub(r"^```[a-zA-Z0-9_+-]*\n?", "", replacement)
        replacement = re.sub(r"\n?```\s*$", "", replacement).strip()

    # 2. If the model echoed the surrounding context, keep only the edited region.
    prefix_tail = (prefix or "").replace("\r\n", "\n")[-160:].strip()
    if len(prefix_tail) >= 60:
        at = replacement.find(prefix_tail)
        if at > 0:
            replacement = re.sub(r"^\n+", "", replacement[at + len(prefix_tail) :])
    suffix_head = (suffix or "").replace("\r\n", "\n")[:160].strip()
    if len(suffix_head) >= 60:
        at = replacement.find(suffix_head)
        if at >= 0:
            replacement = re.sub(r"\n+$", "", replacement[:at])
    replacement = replacement.strip()

    if not replacement:
        return {"replacement": "", "reason": "the model returned no usable code"}

    # 3. Refuse implausible growth: the edit was requested for a small range, so a
    #    much larger answer is a rewritten file, not an edit.
    selected_lines = max(1, len(selected.split("\n")))
    produced_lines = len(replacement.split("\n"))
    if produced_lines > max(selected_lines * 3, selected_lines + 60):
        return {
            "replacement": "",
            "reason": f"the model returned {produced_lines} lines for a {selected_lines}-line edit, so it was not applied",
        }

    # 4. Trim a trailing explanation block the model added after the code.
    prose_tail = re.search(
        r"\n\s*\n\s*(?:Explanation|Note|This|The (?:code|change|edit|fix)|Changes?:)[\s\S]{40,}$",
        replacement,
        re.IGNORECASE,
    )
    if prose_tail:
        trimmed = replacement[: prose_tail.start()].rstrip()
        if trimmed and len(trimmed.split("\n")) >= max(1, selected_lines - 5):
            replacement = trimmed

    return {"replacement": replacement, "reason": ""}


def inline_edit(payload: dict) -> dict:
    """Rewrite the selected code and return only the replacement."""
    provider = str(payload.get("provider") or "ollama").strip()
    model = str(payload.get("model") or "").strip()
    api_key = _resolve_key(provider, str(payload.get("apiKey") or ""))
    selected = str(payload.get("selectedCode") or "")
    prefix = str(payload.get("surroundingPrefix") or "")
    suffix = str(payload.get("surroundingSuffix") or "")

    user_prompt = (
        f"Context before:\n{prefix[-600:]}\n\n"
        f"Code to edit:\n{selected}\n\n"
        f"Context after:\n{suffix[:600]}\n\n"
        f"Instruction: {payload.get('instruction') or ''}\n\nEmit updated code:"
    )

    started = time.monotonic()
    ok, raw, error, tokens = _review_completion(
        provider,
        model,
        str(payload.get("baseUrl") or "").rstrip("/"),
        api_key,
        INLINE_SYSTEM_PROMPT,
        user_prompt,
    )
    elapsed_ms = int((time.monotonic() - started) * 1000)
    if not ok:
        return {"ok": False, "error": error, "replacement": ""}
    if not raw:
        return {"ok": False, "error": "The provider returned an empty replacement.", "replacement": ""}

    _record_usage(
        provider, model, tokens[0], tokens[1], elapsed_ms, payload.get("projectRoot")
    )
    cleaned = _sanitize_inline_replacement(raw, selected, prefix, suffix)
    if not cleaned["replacement"]:
        return {"ok": False, "reason": cleaned["reason"], "replacement": ""}
    return {"ok": True, "replacement": cleaned["replacement"], "reason": cleaned["reason"]}


COMMANDS = {
    "test-connection": test_connection,
    "review-file": review_file,
    "inline-edit": inline_edit,
    "usage": usage,
}


# ── Streaming chat ──────────────────────────────────────────────────────────
#
# Chat streams, so it does not use the {ok, data} envelope: it writes NDJSON lines
# the caller forwards to the UI (`{"delta": …}` … `{"done": true}`), which is the
# same three frames the dev bridge produced over SSE.

def _emit(frame: dict) -> None:
    sys.stdout.write(json.dumps(frame) + "\n")
    sys.stdout.flush()


def _chat_context(project_root: str, needs_git: bool) -> str:
    """Project intelligence + workspace git context, as the assistant prompt saw it."""
    if not project_root or not Path(project_root).is_dir():
        return ""

    index_context = ""
    try:
        import indexer_cli

        data = indexer_cli._load(project_root)
        if data:
            profile = data.get("profile") or {}
            names = list((data.get("symbols") or {}).keys())
            shown = names[:35]
            more = f" (+{len(names) - 35} more)" if len(names) > 35 else ""
            index_context = (
                "\n\n--- Project Intelligence & Symbol Graph ---\n"
                f"Scale Tier: {profile.get('scale_tier') or 'standard'} "
                f"({profile.get('total_loc') or 0} LOC across {profile.get('indexed_files') or 0} files)\n"
                f"Frameworks / Stack: {', '.join(profile.get('frameworks') or []) or profile.get('primary_language') or 'General'}\n"
                f"Indexed Symbols: {', '.join(shown)}{more}\n"
                "--- End of Project Intelligence ---\n"
            )
    except Exception:  # noqa: BLE001 - context is an enhancement, never a failure
        index_context = ""

    workspace = ""
    if needs_git:
        try:
            import git_cli

            def git(*args):
                ok, out, _ = git_cli._run(project_root, list(args), timeout=5)
                return out.strip() if ok else ""

            status, diff, log = git("status", "-s"), git("diff", "--stat"), git("log", "-n", "5", "--oneline")
            workspace = f"\n\n--- Current Workspace Git Context ---\nProject directory: {project_root}\n"
            if status:
                workspace += f"Uncommitted changes (git status):\n{status}\n\n"
            if diff:
                workspace += f"Diff summary:\n{diff}\n\n"
            if log:
                workspace += f"Recent commits:\n{log}\n"
            workspace += "--- End of Workspace Context ---\n"
        except Exception:  # noqa: BLE001 - same
            pass

    return index_context + (f"\n{workspace}" if workspace else "")


CHAT_SYSTEM_PROMPT = (
    "You are ACSA Code AI Assistant, an expert, thoughtful, and pragmatic coding companion integrated into ACSA Code. "
    "Help the user understand, write, review, debug, and navigate their code. Provide clear explanations and clean "
    "markdown code blocks with language tags when showing code."
)


def _iter_sse(response):
    """Yield the `data:` payloads of an event-stream response."""
    for raw in response:
        line = raw.decode("utf-8", "replace").strip()
        if line.startswith("data:"):
            yield line[5:].strip()


def _stream_completion(provider, model, base_url, api_key, messages, images, on_delta, on_usage):
    """Stream one completion, calling on_delta per token. Returns (ok, error).

    `on_usage(prompt_tokens, completion_tokens)` is called once when the provider
    reports real counts — Ollama's final chunk, Anthropic's `message_start`/
    `message_delta`, or the OpenAI-compatible final chunk. Providers that never
    report counts simply do not call it, and the ledger falls back to an
    estimate rather than inventing a number here.
    """
    if provider == "ollama":
        payload_messages = [dict(m) for m in messages]
        if images:
            payload_messages[-1]["images"] = [
                img.split("base64,", 1)[-1] for img in images if isinstance(img, str)
            ]
        body = {
            "model": model or "qwen2.5-coder:7b",
            "messages": payload_messages,
            "stream": True,
            "options": {"temperature": 0.7},
        }
        url = f"{base_url or DEFAULT_BASE_URLS['ollama']}/api/chat"
        headers = {"Content-Type": "application/json"}
    elif provider == "anthropic":
        if not api_key:
            return False, "An API key is required for the Anthropic provider."
        system = "\n".join(m["content"] for m in messages if m["role"] == "system")
        turns = [m for m in messages if m["role"] != "system"]
        body = {
            "model": model or "claude-3-5-sonnet-latest",
            "max_tokens": 4096,
            "system": system,
            "messages": turns,
            "stream": True,
        }
        url = f"{base_url or DEFAULT_BASE_URLS['anthropic']}/v1/messages"
        headers = {"Content-Type": "application/json", "x-api-key": api_key, "anthropic-version": "2023-06-01"}
    else:
        if not api_key:
            return False, f"An API key is required for provider '{provider}'."
        body = {
            "model": model or "gpt-4o-mini",
            "messages": messages,
            "stream": True,
            "temperature": 0.7,
            # Ask for a final chunk carrying token counts. Retried without it below
            # if the provider rejects the field.
            "stream_options": {"include_usage": True},
        }
        url = f"{base_url or DEFAULT_BASE_URLS.get(provider, 'https://api.openai.com/v1')}/chat/completions"
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}

    def open_stream(payload_body):
        request = urllib.request.Request(
            url, data=json.dumps(payload_body).encode("utf-8"), headers=headers, method="POST"
        )
        return urllib.request.urlopen(
            request, timeout=300.0, context=tls_context.https_context()
        )

    try:
        try:
            response = open_stream(body)
        except urllib.error.HTTPError as exc:
            # Not every OpenAI-compatible gateway knows `stream_options`; a 400 on
            # it must cost the token counts, not the whole reply.
            if exc.code == 400 and "stream_options" in body:
                body.pop("stream_options", None)
                response = open_stream(body)
            else:
                raise
        with response:
            if provider == "ollama":
                for raw in response:  # newline-delimited JSON
                    line = raw.decode("utf-8", "replace").strip()
                    if not line:
                        continue
                    chunk = json.loads(line)
                    token = (chunk.get("message") or {}).get("content")
                    if token:
                        on_delta(token)
                    if chunk.get("done"):
                        on_usage(
                            int(chunk.get("prompt_eval_count") or 0),
                            int(chunk.get("eval_count") or 0),
                        )
                        break
            else:
                for payload in _iter_sse(response):
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                    except ValueError:
                        continue
                    if chunk.get("type") == "message_start":
                        usage = (chunk.get("message") or {}).get("usage") or {}
                        on_usage(int(usage.get("input_tokens") or 0), 0)
                    if chunk.get("type") == "content_block_delta":
                        text = (chunk.get("delta") or {}).get("text")
                    else:
                        choices = chunk.get("choices") or [{}]
                        text = (choices[0].get("delta") or {}).get("content")
                    if text:
                        on_delta(text)
                    if chunk.get("type") == "message_delta":
                        usage = chunk.get("usage") or {}
                        on_usage(0, int(usage.get("output_tokens") or 0))
                    usage = chunk.get("usage")
                    if isinstance(usage, dict) and usage:
                        on_usage(
                            int(usage.get("prompt_tokens") or 0),
                            int(usage.get("completion_tokens") or 0),
                        )
    except urllib.error.HTTPError as exc:
        return False, f"Provider request failed ({exc.code})"
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return False, str(exc)
    return True, ""


def chat_stream(payload: dict) -> None:
    """Stream a reply as NDJSON frames: {delta}, then {done} or {error}."""
    provider = str(payload.get("provider") or "ollama").strip()
    model = str(payload.get("model") or "").strip()
    api_key = _resolve_key(provider, str(payload.get("apiKey") or ""))
    images = payload.get("images") or []
    messages = payload.get("messages") or []

    system = CHAT_SYSTEM_PROMPT + _chat_context(
        str(payload.get("projectRoot") or ""), bool(payload.get("needsGitContext", True))
    )
    sent = [{"role": "system", "content": system}]
    for message in messages:
        role = message.get("role")
        if role in ("user", "assistant", "system"):
            sent.append({"role": role, "content": str(message.get("content") or "")})

    started = time.monotonic()
    answer: list[str] = []
    # Providers report counts in pieces (`message_start` gives input, the last
    # `message_delta` gives output), so keep the high-water mark per field rather
    # than letting a later zero-clamp overwrite a real number.
    tokens = [0, 0]

    def on_delta(token: str) -> None:
        answer.append(token)
        _emit({"delta": token})

    def on_usage(prompt_tokens: int, completion_tokens: int) -> None:
        tokens[0] = max(tokens[0], int(prompt_tokens or 0))
        tokens[1] = max(tokens[1], int(completion_tokens or 0))

    ok, error = _stream_completion(
        provider, model, str(payload.get("baseUrl") or "").rstrip("/"), api_key, sent,
        images, on_delta, on_usage,
    )
    elapsed_ms = int((time.monotonic() - started) * 1000)
    if not ok:
        _emit({"error": error, "done": True})
        return
    # A provider that does not report counts still gets metered — roughly. Four
    # characters per token is the usual English/ASCII ratio and is stated in the
    # ledger's own docs rather than presented as a measurement.
    estimated = tokens[0] == 0 and tokens[1] == 0
    prompt_tokens = tokens[0] or max(1, len(json.dumps(sent)) // 4)
    completion_tokens = tokens[1] or max(1, len("".join(answer)) // 4)
    _record_usage(
        provider,
        model,
        prompt_tokens,
        completion_tokens,
        elapsed_ms,
        payload.get("projectRoot"),
    )
    _emit(
        {
            "done": True,
            "provider": provider,
            "model": model,
            "elapsedMs": elapsed_ms,
            "promptTokens": prompt_tokens,
            "completionTokens": completion_tokens,
            "usageEstimated": estimated,
        }
    )


STREAMING = {"chat"}
COMMANDS["chat"] = chat_stream


def run(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(json.dumps({"ok": False, "error": f"usage: ai_cli.py <{'|'.join(COMMANDS)}> [json]"}))
        return 2

    handler = COMMANDS.get(argv[1])
    if handler is None:
        print(json.dumps({"ok": False, "error": f"unknown command: {argv[1]}"}))
        return 2

    try:
        raw = argv[2] if len(argv) > 2 else (sys.stdin.read() or "{}")
        payload = json.loads(raw or "{}")
        # Streaming commands write their own NDJSON frames and have no envelope.
        if argv[1] in STREAMING:
            handler(payload)
            return 0
        print(json.dumps({"ok": True, "data": handler(payload)}))
        return 0
    except Exception as exc:  # noqa: BLE001 - the CLI reports, it does not raise
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(run(sys.argv))
