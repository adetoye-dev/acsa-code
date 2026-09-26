"""gh_cli.py — the state of the remote, read through the GitHub CLI.

The repository page can describe everything that exists on this machine: the
branch, the working tree, the history. What it cannot see is the remote's half of
the same work — whether this branch's checks pass, which pull requests are open,
what is assigned to you. That state lives on github.com, and asking for it means
credentials.

So this shells out to `gh`, the CLI the user has already signed into, rather than
inventing a token of its own: nothing new to store, no second login, and the
scopes already granted (`repo`, `workflow`) are exactly the ones this needs.

Every way this can come up short is named — no CLI, no GitHub remote, signed out,
no network — because an empty list and a list that could not be read are different
facts, and a panel showing no checks when the truth is "you are not signed in"
would be lying to the user.

Reached as `acsa-engine gh overview <json>`.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# These lists are network-bound and can take seconds on a large repository, so the
# git module's local timeout would cut them off.
GH_TIMEOUT = 30

# Only the fields the page draws. Asking for JSON is the whole point: the table
# output is laid out for people, and parsing it means guessing at column widths.
RUN_FIELDS = (
    "databaseId,displayTitle,workflowName,status,conclusion,"
    "headBranch,event,createdAt,updatedAt,url"
)
PR_FIELDS = (
    "number,title,author,isDraft,reviewDecision,headRefName,"
    "createdAt,updatedAt,url,additions,deletions,changedFiles"
)
ISSUE_FIELDS = "number,title,author,labels,updatedAt,url"

DEFAULT_LIMIT = 5
MAX_LIMIT = 20


def _cwd(payload: dict) -> str:
    candidate = str(payload.get("cwd") or os.getcwd())
    return candidate if Path(candidate).is_dir() else os.getcwd()


def _limit(payload: dict) -> int:
    """A nonsense limit is a shorter list, not a failed call."""
    try:
        wanted = int(payload.get("limit") or DEFAULT_LIMIT)
    except (TypeError, ValueError):
        return DEFAULT_LIMIT
    return max(1, min(MAX_LIMIT, wanted))


def _gh_path() -> str | None:
    """Split out so a test can say what happens when there is no `gh`."""
    return shutil.which("gh")


def _run(args: list[str], cwd: str, timeout: int = GH_TIMEOUT) -> tuple[bool, str, str]:
    """Run one command, returning (ok, stdout, stderr).

    Decoded as UTF-8 with replacement, for the same reason `git_cli` does it: the
    bytes are whatever the user wrote, and a decode error must not be able to fail
    a whole panel.
    """
    try:
        result = subprocess.run(
            args,
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except FileNotFoundError:
        return False, "", f"{args[0]} is not installed or not on PATH."
    except subprocess.TimeoutExpired:
        return False, "", f"{args[0]} {' '.join(args[1:])} timed out."
    except OSError as exc:
        return False, "", str(exc)
    return result.returncode == 0, result.stdout, result.stderr


def parse_remote_slug(url: str) -> str | None:
    """`owner/repo` for a github.com remote, or None for anything else.

    Both shapes git stores are handled — the `https://` one and the
    `git@host:owner/repo` one — because which one is in `.git/config` depends on
    how the repository was cloned, not on anything chosen here. A remote on
    another host is not a GitHub repository, and saying so is the honest answer;
    guessing a URL from a GitLab remote would produce links that 404.
    """
    text = (url or "").strip()
    if not text:
        return None

    host = ""
    path = ""
    if "://" in text:
        scheme, _, rest = text.partition("://")
        if not scheme:
            return None
        rest = rest.split("@")[-1]
        host, _, path = rest.partition("/")
    elif ":" in text.split("@")[-1]:
        # scp-like: git@github.com:owner/repo.git
        after_at = text.split("@")[-1]
        host, _, path = after_at.partition(":")
    else:
        return None

    if host.split(":")[0].lower() != "github.com":
        return None

    slug = path.strip("/")
    if slug.endswith(".git"):
        slug = slug[: -len(".git")]
    parts = [part for part in slug.split("/") if part]
    if len(parts) < 2:
        return None
    return "/".join(parts[:2])


def _remote_url(cwd: str) -> str:
    """`origin` first; another remote only when there is no origin at all."""
    ok, out, _ = _run(["git", "remote", "get-url", "origin"], cwd, 10)
    if ok and out.strip():
        return out.strip()
    ok, out, _ = _run(["git", "remote"], cwd, 10)
    if not ok:
        return ""
    names = [line.strip() for line in out.splitlines() if line.strip()]
    if not names:
        return ""
    ok, out, _ = _run(["git", "remote", "get-url", names[0]], cwd, 10)
    return out.strip() if ok else ""


def classify_error(text: str) -> str:
    """Which kind of not-working this is, from what `gh` printed.

    The strings are the ones `gh` really emits: without a session, `gh run list`
    answers "To get started with GitHub CLI, please run:  gh auth login" and exits
    4. Naming the kind is what lets the panel tell the user which step they are on
    — install it, sign in, get online — instead of showing them stderr.
    """
    lower = (text or "").lower()
    if (
        "auth login" in lower
        or "not logged in" in lower
        or "authenticat" in lower
        or "bad credentials" in lower
        or "gh_token" in lower
    ):
        return "not-authenticated"
    if (
        "could not resolve host" in lower
        or "no such host" in lower
        or "dial tcp" in lower
        or "network is unreachable" in lower
        or "connection refused" in lower
        or "timed out" in lower
    ):
        return "offline"
    return "failed"


def _seconds_between(created: str, updated: str) -> int | None:
    """How long the remote took, from the two timestamps gh gives.

    None rather than 0 when either is missing or unparseable: a run whose length
    is unknown must not read as a run that took no time.
    """
    try:
        start = datetime.fromisoformat(created.replace("Z", "+00:00"))
        end = datetime.fromisoformat(updated.replace("Z", "+00:00"))
    except (AttributeError, TypeError, ValueError):
        return None
    seconds = int((end - start).total_seconds())
    return seconds if seconds >= 0 else None


def parse_runs(payload: list) -> list[dict]:
    """Workflow runs, in the order `gh run list` returns them (newest first)."""
    runs: list[dict] = []
    for item in payload or []:
        if not isinstance(item, dict):
            continue
        created = str(item.get("createdAt") or "")
        updated = str(item.get("updatedAt") or "")
        status = str(item.get("status") or "")
        runs.append(
            {
                "id": item.get("databaseId"),
                "title": str(item.get("displayTitle") or ""),
                "workflow": str(item.get("workflowName") or ""),
                "status": status,
                "conclusion": str(item.get("conclusion") or ""),
                "branch": str(item.get("headBranch") or ""),
                "event": str(item.get("event") or ""),
                "createdAt": created,
                "updatedAt": updated,
                # A run still going has no length yet — its `updatedAt` is the last
                # update, and reporting that as a duration would understate it by
                # more every second.
                "durationSeconds": (
                    _seconds_between(created, updated) if status == "completed" else None
                ),
                "url": str(item.get("url") or ""),
            }
        )
    return runs


def parse_pull_requests(payload: list) -> list[dict]:
    pull_requests: list[dict] = []
    for item in payload or []:
        if not isinstance(item, dict):
            continue
        author = item.get("author") or {}
        pull_requests.append(
            {
                "number": item.get("number"),
                "title": str(item.get("title") or ""),
                "author": str((author.get("login") if isinstance(author, dict) else author) or ""),
                "isDraft": bool(item.get("isDraft")),
                "reviewDecision": str(item.get("reviewDecision") or ""),
                "branch": str(item.get("headRefName") or ""),
                "createdAt": str(item.get("createdAt") or ""),
                "updatedAt": str(item.get("updatedAt") or ""),
                "url": str(item.get("url") or ""),
                "additions": item.get("additions"),
                "deletions": item.get("deletions"),
                "changedFiles": item.get("changedFiles"),
            }
        )
    return pull_requests


def parse_issues(payload: list) -> list[dict]:
    """Issues with their labels, which is the only extra an issue row carries."""
    issues: list[dict] = []
    for item in payload or []:
        if not isinstance(item, dict):
            continue
        author = item.get("author") or {}
        labels = []
        for label in item.get("labels") or []:
            if isinstance(label, dict):
                labels.append(
                    {
                        "name": str(label.get("name") or ""),
                        # gh reports the colour without its `#`; a CSS colour is
                        # wanted here, so it is normalised once, in the engine.
                        "color": "#" + str(label.get("color") or "").lstrip("#"),
                    }
                )
        issues.append(
            {
                "number": item.get("number"),
                "title": str(item.get("title") or ""),
                "author": str((author.get("login") if isinstance(author, dict) else author) or ""),
                "labels": labels,
                "updatedAt": str(item.get("updatedAt") or ""),
                "url": str(item.get("url") or ""),
            }
        )
    return issues


def _gh_json(slug: str, args: list[str]) -> tuple[bool, list, str]:
    """One `gh` list call, as parsed JSON.

    `--repo` is passed explicitly rather than letting gh infer the repository from
    the working directory: the slug has already been read from the remote, and
    being explicit means the answer cannot change with the process's cwd.
    """
    ok, out, err = _run(["gh", *args, "--repo", slug], os.getcwd())
    if not ok:
        return False, [], (err or out).strip()
    try:
        parsed = json.loads(out or "[]")
    except json.JSONDecodeError as exc:
        return False, [], f"gh returned something that is not JSON: {exc}"
    return True, parsed if isinstance(parsed, list) else [], ""


def _unavailable(reason: str, detail: str, repo: str = "", raw: str = "") -> dict:
    """A state the panel can explain, not an error it has to interpret."""
    return {
        "success": True,
        "available": False,
        "reason": reason,
        "detail": detail,
        "raw": raw,
        "repo": repo,
        "runs": [],
        "pullRequests": [],
        "issues": [],
        "errors": {},
    }


def overview(payload: dict) -> dict:
    """The remote's state in one call: checks, pull requests, and your issues.

    One action rather than three, because the panel wants all of it at once and
    three trips through IPC to the same host would each pay for themselves in
    latency. The checks query is the one that decides whether gh works at all; if
    it fails, the reason is classified once and nothing else is attempted.
    """
    cwd = _cwd(payload)
    limit = _limit(payload)

    if _gh_path() is None:
        return _unavailable(
            "not-installed",
            "The GitHub CLI (gh) is not installed, so checks and pull requests cannot be read.",
        )

    slug = parse_remote_slug(_remote_url(cwd))
    if not slug:
        return _unavailable(
            "not-github",
            "This repository has no github.com remote, so there is nothing on GitHub to read.",
        )

    ok, raw_runs, error = _gh_json(slug, ["run", "list", "-L", str(limit), "--json", RUN_FIELDS])
    if not ok:
        reason = classify_error(error)
        detail = {
            "not-authenticated": (
                "The GitHub CLI is not signed in, so checks and pull requests cannot be read."
            ),
            "offline": (
                "GitHub could not be reached, so checks and pull requests cannot be read."
            ),
        }.get(reason, "GitHub could not be asked for this repository's state.")
        return _unavailable(reason, detail, slug, error)

    errors: dict[str, str] = {}

    ok_prs, raw_prs, pr_error = _gh_json(
        slug, ["pr", "list", "-L", str(limit), "--json", PR_FIELDS]
    )
    if not ok_prs:
        # One section failing is not the whole panel failing: the checks above are
        # still true, and an error per section beats an empty list that reads as
        # "you have no pull requests".
        errors["pullRequests"] = pr_error
        raw_prs = []

    ok_issues, raw_issues, issue_error = _gh_json(
        slug, ["issue", "list", "-L", str(limit), "--assignee", "@me", "--json", ISSUE_FIELDS]
    )
    if not ok_issues:
        errors["issues"] = issue_error
        raw_issues = []

    return {
        "success": True,
        "available": True,
        "reason": None,
        "detail": "",
        "raw": "",
        "repo": slug,
        "runs": parse_runs(raw_runs),
        "pullRequests": parse_pull_requests(raw_prs),
        "issues": parse_issues(raw_issues),
        "errors": errors,
    }


COMMANDS = {"overview": overview}


def run(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(json.dumps({"ok": False, "error": f"usage: gh_cli.py <{'|'.join(COMMANDS)}> [json]"}))
        return 2

    handler = COMMANDS.get(argv[1])
    if handler is None:
        print(json.dumps({"ok": False, "error": f"unknown command: {argv[1]}"}))
        return 2

    try:
        payload = json.loads(argv[2]) if len(argv) > 2 and argv[2] else {}
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"bad payload: {exc}"}))
        return 2

    print(json.dumps({"ok": True, "data": handler(payload if isinstance(payload, dict) else {})}))
    return 0


if __name__ == "__main__":
    sys.exit(run(sys.argv))
