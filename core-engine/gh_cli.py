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

import re
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import tool_paths

# These lists are network-bound and can take seconds on a large repository, so the
# git module's local timeout would cut them off.
GH_TIMEOUT = 30

# A failed matrix build's log is fetched before it can be trimmed, so this one
# waits longer than a list does.
LOG_TIMEOUT = 60

# The tail kept by default, and the range a caller may ask for: enough to hold the
# error and the lines that explain it, not so much that the pane becomes the log.
DEFAULT_TAIL = 120
MIN_TAIL = 20
MAX_TAIL = 500

# `gh run view --log` prints one line per log line as
# `job<TAB>step<TAB><timestamp> <text>`; the timestamp is noise in a pane that
# already says when the run happened.
LOG_LINE_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?")

# Only the fields the page draws. Asking for JSON is the whole point: the table
# output is laid out for people, and parsing it means guessing at column widths.
RUN_FIELDS = (
    "databaseId,displayTitle,workflowName,status,conclusion,"
    "headBranch,event,createdAt,updatedAt,url,headSha"
)

# How many of the branch's runs the summary describes. Deep enough for a pass rate
# to mean something, shallow enough that one `gh` call answers it.
STATS_LIMIT = 20
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
    """Split out so a test can say what happens when there is no `gh`.

    Not `shutil.which` alone: a window launched from the Dock does not inherit the
    PATH from the user's shell, so a `gh` installed with Homebrew — which is what
    this app's own error message tells the user to do — is invisible to `which`
    even though it runs in their terminal. See `tool_paths`.
    """
    return tool_paths.find("gh")


def _gh(*args: str) -> list[str]:
    """`gh <args>`, through the path that was found rather than the bare name.

    The name alone is resolved against PATH — the PATH this process may not have.
    The absolute path is the fact; the name is the guess.
    """
    return [_gh_path() or "gh", *args]


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
                # The commit the run was for, so a row can link to it.
                "sha": str(item.get("headSha") or ""),
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
    ok, out, err = _run(_gh(*args, "--repo", slug), os.getcwd())
    if not ok:
        return False, [], (err or out).strip()
    try:
        parsed = json.loads(out or "[]")
    except json.JSONDecodeError as exc:
        return False, [], f"gh returned something that is not JSON: {exc}"
    return True, parsed if isinstance(parsed, list) else [], ""


def parse_log(text: str, tail: int = DEFAULT_TAIL) -> dict:
    """The end of a `gh run view --log` dump, as plain lines.

    Keeps the end on purpose: the reason a run is red is at the bottom, and a
    matrix build can emit tens of thousands of lines above it. `dropped` is how
    many were left behind, so the panel can say it is showing a tail rather than
    let a person believe they are reading the whole thing.

    The job and step of each line are collected rather than prefixed to every one:
    they repeat for hundreds of lines, and what the header needs is the distinct
    set — which job, which step.
    """
    jobs: list[str] = []
    steps: list[str] = []
    lines: list[str] = []

    for raw in text.replace("\r\n", "\n").split("\n"):
        line = raw.lstrip("\ufeff")
        if not line.strip():
            continue
        # `split("\t", 2)` and not `split("\t")`: log text can itself contain tabs,
        # and everything after the second one is the line, verbatim.
        parts = line.split("\t", 2)
        if len(parts) == 3:
            job, step, rest = parts
            if job and job not in jobs:
                jobs.append(job)
            # gh writes `UNKNOWN STEP` when it cannot map a line to one, which is
            # not a step name and would read as a bug.
            if step and step != "UNKNOWN STEP" and step not in steps:
                steps.append(step)
            line = rest
        lines.append(LOG_LINE_TIMESTAMP.sub("", line, count=1).rstrip())

    dropped = max(0, len(lines) - tail)
    return {
        "lines": lines[dropped:],
        "dropped": dropped,
        "jobs": jobs,
        "steps": steps,
    }


def run_log(payload: dict) -> dict:
    """Why a run is red: the tail of its failed steps' logs.

    `--log-failed` prints nothing at all when no step failed — a cancelled run and
    an expired log look the same — so an empty answer is reported as a fact about
    the run rather than rendered as an empty log, which would read as "nothing went
    wrong".
    """
    cwd = _cwd(payload)
    run_id = str(payload.get("runId") or "").strip()
    if not run_id.isdigit():
        return {
            "success": False,
            "available": False,
            "reason": "bad-run",
            "detail": "That is not a workflow run id.",
            "raw": "",
            "lines": [],
            "dropped": 0,
            "jobs": [],
            "steps": [],
        }

    if _gh_path() is None:
        return _unavailable_log("not-installed", "The GitHub CLI (gh) is not installed.")

    slug = parse_remote_slug(_remote_url(cwd))
    if not slug:
        return _unavailable_log(
            "not-github", "This repository has no github.com remote."
        )

    ok, out, err = _run(
        _gh("run", "view", run_id, "--log-failed", "--repo", slug),
        cwd,
        LOG_TIMEOUT,
    )
    if not ok:
        reason = classify_error(err or out)
        detail = {
            "not-authenticated": "The GitHub CLI is not signed in.",
            "offline": "GitHub could not be reached.",
        }.get(reason, "GitHub could not be asked for that run's log.")
        return _unavailable_log(reason, detail, (err or out).strip())

    parsed = parse_log(out, _tail(payload))
    if not parsed["lines"]:
        return _unavailable_log(
            "no-log",
            "This run has no failed-step log — it may have been cancelled, or the "
            "log may have expired (GitHub keeps them for 90 days).",
        )
    return {
        "success": True,
        "available": True,
        "reason": None,
        "detail": "",
        "raw": "",
        **parsed,
    }


def _tail(payload: dict) -> int:
    """A nonsense tail is a shorter log, not a failed call."""
    try:
        wanted = int(payload.get("tail") or DEFAULT_TAIL)
    except (TypeError, ValueError):
        return DEFAULT_TAIL
    return max(MIN_TAIL, min(MAX_TAIL, wanted))


def _unavailable_log(reason: str, detail: str, raw: str = "") -> dict:
    return {
        "success": True,
        "available": False,
        "reason": reason,
        "detail": detail,
        "raw": raw,
        "lines": [],
        "dropped": 0,
        "jobs": [],
        "steps": [],
    }


# What a finished run's conclusion means for a pass rate. A cancelled run is
# neither: it did not pass and nothing was tested to fail, so it is counted apart
# rather than being folded in as a failure and reporting a health nobody measured.
PASSING_CONCLUSIONS = ("success",)
FAILING_CONCLUSIONS = ("failure", "startup_failure", "timed_out")


def _current_branch(cwd: str) -> str:
    """The branch the working tree is on, or "" when there is no answer.

    A detached HEAD answers `HEAD`, which is not a branch any run was made on, and
    an empty answer means the summary describes the repository rather than a branch.
    """
    ok, out, _ = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd, 10)
    name = out.strip() if ok else ""
    return "" if name in ("", "HEAD") else name


def summarize_runs(runs: list[dict], branch: str = "") -> dict:
    """The recent runs as the few numbers worth putting beside a branch.

    Everything here is derived, and every derivation has a case where it has no
    answer: a rate over runs that have not finished would be a guess, and an average
    of no durations is `None` rather than zero — the panel says "—" instead of a
    number it made up.
    """
    completed = [run for run in runs if str(run.get("status") or "") == "completed"]
    passed = [run for run in completed if run.get("conclusion") in PASSING_CONCLUSIONS]
    failed = [run for run in completed if run.get("conclusion") in FAILING_CONCLUSIONS]
    decided = len(passed) + len(failed)
    durations = [
        run["durationSeconds"]
        for run in completed
        if isinstance(run.get("durationSeconds"), int)
    ]
    return {
        "branch": branch,
        "total": len(runs),
        "passed": len(passed),
        "failed": len(failed),
        # Finished runs that were neither: cancelled, skipped, neutral.
        "other": len(completed) - decided,
        "passRate": (len(passed) / decided) if decided else None,
        "averageDurationSeconds": (
            sum(durations) // len(durations) if durations else None
        ),
        # Newest first, as `gh run list` gives them.
        "latest": runs[0] if runs else None,
        # Oldest first, so a bar chart reads left to right.
        "history": list(reversed(runs)),
    }


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
        "summary": summarize_runs([]),
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

    # The summary describes *this branch* — "is my branch green" is the question a
    # checks widget answers — while the list below stays the repository's recent
    # runs, because a red `main` while you are on `dev` is worth seeing too. Without
    # a branch to ask about (a detached HEAD), the summary falls back to the same
    # runs the list shows and says so by carrying an empty branch.
    branch = _current_branch(cwd)
    summary_runs: list = []
    summary_branch = ""
    if branch:
        ok_branch, branch_raw, branch_error = _gh_json(
            slug, ["run", "list", "-b", branch, "-L", str(STATS_LIMIT), "--json", RUN_FIELDS]
        )
        if ok_branch:
            summary_runs = parse_runs(branch_raw)
            summary_branch = branch
        else:
            # A failed summary is one section failing, not the panel: the list above
            # it is still true, and the panel says which part it could not read.
            errors["summary"] = branch_error
    if not summary_branch:
        # Nothing to describe but the repository itself — a detached HEAD, say — so
        # the summary covers the runs the list is showing.
        summary_runs = parse_runs(raw_runs)

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
        "summary": summarize_runs(summary_runs, summary_branch),
        "pullRequests": parse_pull_requests(raw_prs),
        "issues": parse_issues(raw_issues),
        "errors": errors,
    }


COMMANDS = {"overview": overview, "run-log": run_log}


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
