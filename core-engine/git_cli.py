#!/usr/bin/env python3
"""git_cli.py — the source-control actions the workbench asks for.

Why this exists: these were implemented in `vite-fs-bridge.ts`, a Vite dev-server
middleware, by shelling out to the `git` CLI. `configureServer()` never runs in a
build, so source control was dead in the packaged app — the whole panel, on a
repository the user was probably already working in.

Nothing here is new behaviour: each action is the same `git` invocation the bridge
made, with the same response shape, so the callers did not have to change.

Usage: python3 git_cli.py status '{"cwd": "/path/to/repo"}'
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

# Local actions are instant; anything that talks to a remote can take a while.
LOCAL_TIMEOUT = 20
REMOTE_TIMEOUT = 180


def _run(cwd: str, args: list[str], timeout: int = LOCAL_TIMEOUT) -> tuple[bool, str, str]:
    """Run git, returning (ok, stdout, stderr).

    Decoded as UTF-8 with `errors="replace"` rather than the locale default: git
    hands back whatever bytes a file contains, so `git show` on a PNG used to
    raise `UnicodeDecodeError` out of `subprocess` and fail the whole action. A
    replacement character in a diff is a much smaller problem than a dead panel,
    and commit messages in other encodings no longer take the log down with them.
    """
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except FileNotFoundError:
        return False, "", "git is not installed or not on PATH."
    except subprocess.TimeoutExpired:
        return False, "", f"git {' '.join(args)} timed out."
    except OSError as exc:
        return False, "", str(exc)
    return result.returncode == 0, result.stdout, result.stderr


def _cwd(payload: dict) -> str:
    candidate = str(payload.get("cwd") or os.getcwd())
    return candidate if Path(candidate).is_dir() else os.getcwd()


def _text_only(original: str, modified: str) -> tuple[str, str]:
    """Drop both sides when either is binary.

    The diff pane can only draw text, and a committed PNG arrives from `git show`
    as a screenful of replacement characters. Git's own test for "not text" is a
    NUL byte, so the same test blanks the pair — the pane then says there is
    nothing to compare, which is true, instead of pretending to diff mojibake.
    """
    if "\0" in original or "\0" in modified:
        return "", ""
    return original, modified


# The paths git writes while an operation is stopped half-way. `--git-path` prints
# them whether or not they exist, so one call answers "what is going on here" and
# the existence checks afterwards cost nothing.
_OPERATION_MARKERS = [
    ("rebase", "rebase-merge"),
    ("rebase", "rebase-apply"),
    ("merge", "MERGE_HEAD"),
    ("cherry-pick", "CHERRY_PICK_HEAD"),
    ("revert", "REVERT_HEAD"),
]


def _operation(cwd: str) -> str:
    """`merge`, `rebase`, `cherry-pick`, `revert`, or "" when nothing is in flight."""
    args = ["rev-parse"]
    for _, marker in _OPERATION_MARKERS:
        args += ["--git-path", marker]
    ok, out, _ = _run(cwd, args, 10)
    if not ok:
        return ""
    paths = [line.strip() for line in out.splitlines() if line.strip()]
    for (name, _), path in zip(_OPERATION_MARKERS, paths):
        if path and Path(cwd, path).exists():
            return name
    return ""


def _split_rename(raw: str) -> tuple[str, str] | None:
    """`old -> new` from a rename or copy line, or None for a plain path."""
    if " -> " not in raw:
        return None
    old, _, new = raw.partition(" -> ")
    return old.strip(), new.strip()


# The escapes git writes inside a quoted path. `quote_c_style` uses the short form
# for the characters C has one for, and three octal digits for any other byte.
_PATH_ESCAPES = {
    "a": 0x07,
    "b": 0x08,
    "f": 0x0C,
    "n": 0x0A,
    "r": 0x0D,
    "t": 0x09,
    "v": 0x0B,
    "\\": 0x5C,
    '"': 0x22,
}


def unquote_path(raw: str) -> str:
    """Undo git's C-style path quoting; an unquoted path comes back unchanged.

    `core.quotePath` is on by default, so a path holding a non-ASCII byte, a
    control character, a quote or a backslash is printed *quoted and escaped*:
    `"caf\\303\\251.py"` is `café.py`. That form is for reading, and handing it back
    to git asks about a file whose name really contains the quotes — which is why
    staging, diffing and discarding those files all failed with "did not match any
    file(s) known to git".

    The escapes stand for *bytes*, so they are collected as bytes and decoded as
    UTF-8 at the end: `\\303\\251` is one `é`, and decoding each escape on its own
    would produce two replacement characters.
    """
    if len(raw) < 2 or not raw.startswith('"') or not raw.endswith('"'):
        return raw

    out = bytearray()
    index = 1
    end = len(raw) - 1
    while index < end:
        char = raw[index]
        if char != "\\":
            # Inside a quoted path this is ASCII; a non-ASCII character can only
            # appear when git was told not to quote, and then it is already text.
            out.extend(char.encode("utf-8", "surrogatepass"))
            index += 1
            continue
        index += 1
        if index >= end:
            out.append(0x5C)
            break
        escaped = raw[index]
        if escaped in _PATH_ESCAPES:
            out.append(_PATH_ESCAPES[escaped])
            index += 1
            continue
        if escaped.isdigit():
            digits = ""
            while index < end and len(digits) < 3 and raw[index].isdigit():
                digits += raw[index]
                index += 1
            out.append(int(digits, 8) & 0xFF)
            continue
        # An escape git does not write. Both characters are kept rather than one
        # dropped: a path this function got wrong should be visible, not mangled.
        out.append(0x5C)
        out.extend(escaped.encode("utf-8", "surrogatepass"))
        index += 1

    return out.decode("utf-8", "replace")


def _is_unmerged(index_status: str, worktree_status: str) -> bool:
    """Git's own marks for a conflict: `UU`, `AA`, `DD`, `AU`, `UA`, `DU`, `UD`."""
    if index_status == "U" or worktree_status == "U":
        return True
    return (index_status, worktree_status) in (("A", "A"), ("D", "D"))


def _file(payload: dict) -> str:
    return str(payload.get("filePath") or "").strip()


def parse_status(stdout: str) -> dict:
    """Turn `git status --porcelain=v1 -b` output into the shape the panel expects."""
    lines = stdout.strip().split("\n")
    header = lines[0] if lines else ""
    branch = "main"
    ahead = behind = 0

    # `## main...origin/main [ahead 1, behind 2]`
    head = header[3:] if header.startswith("## ") else ""
    if head:
        branch = head.split("...")[0].split(" ")[0] or branch
    if "ahead " in header:
        ahead = int("".join(c for c in header.split("ahead ")[1].split(",")[0] if c.isdigit()) or 0)
    if "behind " in header:
        behind = int("".join(c for c in header.split("behind ")[1].split("]")[0] if c.isdigit()) or 0)

    staged: list[dict] = []
    unstaged: list[dict] = []
    conflicted: list[dict] = []
    files: list[dict] = []
    for line in lines[1:]:
        if not line.strip() or len(line) < 3:
            continue
        index_status, worktree_status = line[0], line[1]
        raw_path = line[3:].strip()
        # A rename is one entry for two names. Keeping git's combined
        # `old.py -> new.py` as the path meant stage, discard and diff all asked
        # git about a file with an arrow in its name: they failed, and a renamed
        # file showed an empty diff.
        renamed = _split_rename(raw_path)
        item = {
            # Both sides of a rename are quoted separately, so the split comes first
            # and the unquoting after.
            "path": unquote_path(renamed[1]) if renamed else unquote_path(raw_path),
            "fromPath": unquote_path(renamed[0]) if renamed else "",
            "indexStatus": index_status,
            "workTreeStatus": worktree_status,
        }
        files.append({**item, "isStaged": index_status not in (" ", "?")})
        if _is_unmerged(index_status, worktree_status):
            # Neither group: an unresolved conflict is not a staged change to be
            # committed and not a working-tree change to be discarded. Listed under
            # staged, the commit button offered to commit it and git refused.
            conflicted.append({**item, "isStaged": False})
            continue
        if index_status not in (" ", "?"):
            staged.append({**item, "isStaged": True})
        if worktree_status != " " or index_status == "?":
            unstaged.append({**item, "isStaged": False})

    return {
        "isGit": True,
        "branch": branch,
        "ahead": ahead,
        "behind": behind,
        "staged": staged,
        "unstaged": unstaged,
        "conflicted": conflicted,
        "files": files,
    }


def status(payload: dict) -> dict:
    cwd = _cwd(payload)
    ok, stdout, _ = _run(cwd, ["status", "--porcelain=v1", "-b"])
    if not ok:
        return {
            "isGit": False,
            "branch": "none",
            "staged": [],
            "unstaged": [],
            "conflicted": [],
            "operation": "",
            "files": [],
        }
    parsed = parse_status(stdout)
    # The porcelain header says files are unmerged, never *what* is half-finished,
    # so the operation is asked for separately.
    parsed["operation"] = _operation(cwd)
    return parsed


# `git log` and `for-each-ref` output is read back with control characters rather
# than newlines as separators, because a commit subject can contain anything. The
# readers are pure functions, so the graph's inputs are testable without needing a
# repository on the machine running the tests.
LOG_FIELD = "\x1f"
LOG_RECORD = "\x1e"
LOG_FIELDS = ["%H", "%h", "%P", "%an", "%aI", "%s"]
REF_FIELDS = ["%(refname)", "%(refname:short)", "%(objectname)", "%(*objectname)", "%(HEAD)"]


def parse_log(stdout: str) -> list[dict]:
    """Commits, newest first, with the parents a graph draws its lanes from."""
    commits: list[dict] = []
    for record in stdout.split(LOG_RECORD):
        record = record.strip("\n")
        if not record:
            continue
        fields = record.split(LOG_FIELD)
        if len(fields) < len(LOG_FIELDS):
            continue
        sha, short, parents, author, date, subject = fields[: len(LOG_FIELDS)]
        commits.append(
            {
                "sha": sha,
                "short": short,
                "parents": [parent for parent in parents.split() if parent],
                "author": author,
                "date": date,
                "subject": subject,
            }
        )
    return commits


def parse_refs(stdout: str) -> list[dict]:
    """Which refs point at which commit, for the graph's badges.

    On an annotated tag `%(objectname)` is the *tag* object rather than the
    commit, so the peeled name is preferred — otherwise the tagged commit shows no
    badge at all, and that is the commit people scan for.
    """
    refs: list[dict] = []
    for line in stdout.split("\n"):
        fields = line.rstrip("\n").split(LOG_FIELD)
        if len(fields) < len(REF_FIELDS):
            continue
        full, short, object_name, peeled, head = fields[: len(REF_FIELDS)]
        if not short or short.endswith("/HEAD") or full.endswith("/HEAD"):
            # `refs/remotes/origin/HEAD` points at another ref and only adds noise
            # to a badge. It has to be matched on the *full* name as well: git
            # shortens it to just `origin`, which no suffix check would catch.
            continue
        if full.startswith("refs/heads/"):
            kind = "branch"
        elif full.startswith("refs/remotes/"):
            kind = "remote"
        elif full.startswith("refs/tags/"):
            kind = "tag"
        else:
            continue
        refs.append(
            {
                "name": short,
                "kind": kind,
                "target": peeled or object_name,
                "current": head.strip() == "*",
            }
        )
    return refs


def log_limit(payload: dict, default: int = 60, ceiling: int = 400) -> int:
    """How many commits to ask for.

    A bad value is not an error — the panel still wants a graph, just a shorter
    one — so it falls back rather than failing the call.
    """
    try:
        value = int(payload.get("limit") or default)
    except (TypeError, ValueError):
        value = default
    return max(1, min(value, ceiling))


def log(payload: dict) -> dict:
    """The commit history, plus the refs that label it."""
    cwd = _cwd(payload)
    pretty = LOG_FIELD.join(LOG_FIELDS) + LOG_RECORD
    ok, stdout, _ = _run(
        cwd, ["log", f"--max-count={log_limit(payload)}", f"--pretty=format:{pretty}"]
    )
    if not ok:
        return {"isGit": False, "commits": [], "refs": [], "head": ""}

    ref_format = LOG_FIELD.join(REF_FIELDS) + "\n"
    ok_refs, refs_out, _ = _run(
        cwd,
        [
            "for-each-ref",
            f"--format={ref_format}",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )
    ok_head, head_out, _ = _run(cwd, ["rev-parse", "HEAD"])

    return {
        "isGit": True,
        "commits": parse_log(stdout),
        # A ref list is a nicety; a repository with none still has a graph.
        "refs": parse_refs(refs_out) if ok_refs else [],
        "head": head_out.strip() if ok_head else "",
    }


# One commit's header, for the panel that opens when a graph row is picked.
# `commit` is already taken by the verb — creating one — so reading one is
# `commit-info`, and `commit-file` is one file's two sides inside it.
COMMIT_FIELDS = ["%H", "%h", "%an", "%aI", "%s", "%b"]


def parse_commit_meta(stdout: str) -> dict:
    """A commit's header fields; an empty subject or body stays an empty string."""
    fields = stdout.split(LOG_RECORD)[0].split(LOG_FIELD)
    if len(fields) < len(COMMIT_FIELDS):
        return {}
    sha, short, author, date, subject, body = fields[: len(COMMIT_FIELDS)]
    return {
        "sha": sha,
        "short": short,
        "author": author,
        "date": date,
        "subject": subject,
        "body": body.strip(),
    }


def parse_commit_files(name_status: str, numstat: str) -> list[dict]:
    """Pair `--name-status` with `--numstat`, line by line.

    Both come out of the same diff walk in the same order, so they line up
    one-to-one — which is cheaper and far more predictable than parsing either
    into a format git does not emit. Both are asked for with `--find-renames`, so a
    rename is one line with two paths on each; suppressing that (the previous
    `--no-renames`) showed one change as two rows and left an empty side.

    A binary file has no counts (`-` rather than digits), so its additions and
    deletions are `None` rather than a misleading zero.
    """
    statuses = [line.split("\t") for line in name_status.splitlines() if line.strip()]
    stats = [line.split("\t") for line in numstat.splitlines() if line.strip()]

    files: list[dict] = []
    for index, parts in enumerate(statuses):
        if len(parts) < 2:
            continue
        # A rename or a copy is the one status with two paths on the line:
        # `R100<TAB>old<TAB>new`.
        letter = (parts[0] or "M")[:1]
        from_path = (
            unquote_path(parts[1]) if letter in ("R", "C") and len(parts) >= 3 else ""
        )
        additions = deletions = None
        if index < len(stats) and len(stats[index]) >= 3:
            added, removed = stats[index][0].strip(), stats[index][1].strip()
            additions = int(added) if added.isdigit() else None
            deletions = int(removed) if removed.isdigit() else None
        files.append(
            {
                "path": unquote_path(parts[-1]),
                "fromPath": from_path,
                "status": letter,
                "additions": additions,
                "deletions": deletions,
            }
        )
    return files


def commit_info(payload: dict) -> dict:
    """One commit: its header, and the files it touched."""
    cwd = _cwd(payload)
    sha = str(payload.get("sha") or "HEAD").strip() or "HEAD"

    ok, meta_out, stderr = _run(
        cwd,
        [
            "show",
            "--no-patch",
            f"--pretty=format:{LOG_FIELD.join(COMMIT_FIELDS)}{LOG_RECORD}",
            sha,
        ],
    )
    if not ok:
        return {"success": False, "error": (stderr or "could not read that commit").strip()}

    # `--name-status` and `--no-patch` cannot be combined, and neither can the file
    # list be asked for with the patch suppressed — an empty `--format=` is what
    # keeps the message out while leaving the file list intact. Rename detection is
    # requested explicitly: it is what makes a moved file one row with two names
    # instead of an add and a delete that each look half-empty.
    ok_names, names, _ = _run(cwd, ["show", "--find-renames", "--name-status", "--format=", sha])
    ok_stats, stats, _ = _run(cwd, ["show", "--find-renames", "--numstat", "--format=", sha])

    return {
        "success": True,
        "commit": parse_commit_meta(meta_out),
        # A commit that touched nothing is still a commit, not a failure.
        "files": parse_commit_files(names, stats) if (ok_names and ok_stats) else [],
    }


def commit_file(payload: dict) -> dict:
    """The two sides of one file *inside* a commit, for the diff editor.

    The same shape `diff-file` returns: the parent's copy against the commit's,
    with either side empty when the file was added or deleted in that commit.
    """
    cwd = _cwd(payload)
    sha = str(payload.get("sha") or "HEAD").strip() or "HEAD"
    path = _file(payload)
    # A renamed file's previous side lives under its old name.
    from_path = str(payload.get("fromPath") or "").strip() or path
    ok_before, before, _ = _run(cwd, ["show", f"{sha}^:{from_path}"])
    ok_after, after, _ = _run(cwd, ["show", f"{sha}:{path}"])
    original, modified = _text_only(before if ok_before else "", after if ok_after else "")
    return {
        "success": True,
        "originalContent": original,
        "modifiedContent": modified,
    }


def diff_file(payload: dict) -> dict:
    """The two sides of a file, as the label over them promises.

    The pane says which pair it is showing — "HEAD vs index" for a staged change,
    "index vs working tree" for an unstaged one — so the sides have to be those.
    The unstaged side used to be read from HEAD, which meant a file with something
    already staged showed that staged work as if it were still outstanding: the
    diff contradicted its own label, and `discard` (which restores from the index)
    then threw away less than the diff appeared to cover.

    A rename is two names, so the side that predates it is read from `fromPath`
    and the side that has it from `path`. An empty side means the file is new (or
    gone) on that side, which is what makes a new file read as an addition.
    """
    cwd, file_path = _cwd(payload), _file(payload)
    from_path = str(payload.get("fromPath") or "").strip() or file_path
    staged = bool(payload.get("staged"))

    if staged:
        ok_head, head_content, _ = _run(cwd, ["show", f"HEAD:{from_path}"])
        ok_index, index_content, _ = _run(cwd, ["show", f":{file_path}"])
        original = head_content if ok_head else ""
        modified = index_content if ok_index else ""
    else:
        # An untracked file has no index entry at all, so its "before" is empty
        # rather than missing.
        ok_index, index_content, _ = _run(cwd, ["show", f":{from_path}"])
        try:
            modified = Path(cwd, file_path).read_text(encoding="utf-8", errors="replace")
        except OSError:
            modified = ""
        original = index_content if ok_index else ""

    original, modified = _text_only(original, modified)
    return {"success": True, "originalContent": original, "modifiedContent": modified}


def _simple(payload: dict, args: list[str], *, ok_key: str = "output") -> dict:
    ok, stdout, stderr = _run(_cwd(payload), args)
    if not ok:
        return {"success": False, "error": (stderr or stdout or "git failed").strip()}
    return {"success": True, ok_key: (stdout or stderr).strip()}


def stage(payload: dict) -> dict:
    return _simple(payload, ["add", "--", _file(payload)])


def unstage(payload: dict) -> dict:
    """Unstage without losing the change: restore, then two older fallbacks."""
    cwd, file_path = _cwd(payload), _file(payload)
    for args in (
        ["restore", "--staged", "--", file_path],
        ["rm", "--cached", "--", file_path],
        ["reset", "HEAD", "--", file_path],
    ):
        ok, stdout, _ = _run(cwd, args)
        if ok:
            return {"success": True, "output": stdout.strip()}
    return {"success": False, "error": "Could not unstage the file."}


def discard(payload: dict) -> dict:
    """Revert working-tree changes; untracked files are removed."""
    cwd, file_path = _cwd(payload), _file(payload)
    ok, stdout, _ = _run(cwd, ["checkout", "--", file_path])
    if ok:
        return {"success": True, "output": stdout.strip()}
    ok, stdout, stderr = _run(cwd, ["clean", "-f", "--", file_path])
    if ok:
        return {"success": True, "output": stdout.strip()}
    return {"success": False, "error": (stderr or "Could not discard changes.").strip()}


def conflicted_paths(cwd: str) -> list[str]:
    """The paths git still counts as unmerged."""
    ok, out, _ = _run(cwd, ["diff", "--name-only", "--diff-filter=U"])
    # `--name-only` quotes the same way `status` does, so these have to be unquoted
    # before they are handed back to `git add`.
    return (
        [unquote_path(line.strip()) for line in out.splitlines() if line.strip()]
        if ok
        else []
    )


def resolve_all(payload: dict) -> dict:
    """Mark every conflicted file resolved — and nothing else.

    `git add` is what "resolved" means to git, but only for the unmerged paths: a
    blanket `add -A` would sweep unrelated work into the index at exactly the
    moment the user is least able to review it, and the commit that follows would
    contain changes they never chose. Mid-conflict is also the one time clicking
    twelve files is genuinely worse than one button.
    """
    cwd = _cwd(payload)
    paths = conflicted_paths(cwd)
    if not paths:
        return {"success": True, "message": "Nothing left to resolve."}
    ok, stdout, stderr = _run(cwd, ["add", "--", *paths])
    if not ok:
        return {
            "success": False,
            "error": (stderr or stdout or "Could not mark them resolved.").strip(),
        }
    return {
        "success": True,
        "message": f"Marked {len(paths)} file{'s' if len(paths) != 1 else ''} resolved.",
    }


def stage_all(payload: dict) -> dict:
    return _simple(payload, ["add", "-A"])


def unstage_all(payload: dict) -> dict:
    ok, stdout, _ = _run(_cwd(payload), ["restore", "--staged", "."])
    if ok:
        return {"success": True, "output": stdout.strip()}
    return _simple(payload, ["reset", "HEAD", "."])


def commit(payload: dict) -> dict:
    cwd = _cwd(payload)
    message = str(payload.get("message") or "").strip()
    if not message:
        return {"success": False, "error": "A commit message is required."}
    if payload.get("stageAll"):
        ok, _, stderr = _run(cwd, ["add", "-A"])
        if not ok:
            return {"success": False, "error": stderr.strip()}
    ok, stdout, stderr = _run(cwd, ["commit", "-m", message])
    if not ok:
        return {"success": False, "error": (stderr or stdout).strip()}
    return {"success": True, "message": (stdout or stderr).strip()}


def branches(payload: dict) -> dict:
    ok, stdout, _ = _run(_cwd(payload), ["branch", "--format=%(refname:short)|%(HEAD)"])
    if not ok:
        return {"branches": []}
    parsed = []
    for line in stdout.strip().split("\n"):
        if not line.strip():
            continue
        name, _, marker = line.partition("|")
        parsed.append({"name": name.strip(), "current": marker.strip() == "*"})
    return {"branches": parsed}


def checkout(payload: dict) -> dict:
    branch = str(payload.get("branch") or "").strip()
    if not branch:
        return {"success": False, "error": "A branch name is required."}
    args = ["checkout", "-b", branch] if payload.get("createNew") else ["checkout", branch]
    return _simple(payload, args)


def pull(payload: dict) -> dict:
    return _simple(payload, ["pull"], ok_key="output")


def push(payload: dict) -> dict:
    cwd = _cwd(payload)
    ok, stdout, stderr = _run(cwd, ["push"], timeout=REMOTE_TIMEOUT)
    if ok:
        return {"success": True, "output": (stdout or stderr).strip()}
    # A branch with no upstream is the common first-push failure; set it and retry
    # rather than making the user do it in a terminal.
    if "no upstream" in (stderr or "").lower() or "set-upstream" in (stderr or "").lower():
        ok, stdout, stderr = _run(cwd, ["push", "-u", "origin", "HEAD"], timeout=REMOTE_TIMEOUT)
        if ok:
            return {"success": True, "output": (stdout or stderr).strip()}
    return {"success": False, "error": (stderr or stdout or "git push failed").strip()}


def clone(payload: dict) -> dict:
    url = str(payload.get("url") or "").strip()
    target = str(payload.get("targetDir") or "").strip()
    if not url:
        return {"success": False, "error": "A repository URL is required."}
    if not target:
        return {"success": False, "error": "A target directory is required."}
    dest = Path(os.path.expanduser(target))
    if dest.exists() and any(dest.iterdir()):
        return {"success": False, "error": f"{dest} already exists and is not empty."}
    dest.parent.mkdir(parents=True, exist_ok=True)
    ok, stdout, stderr = _run(
        str(dest.parent), ["clone", url, str(dest)], timeout=REMOTE_TIMEOUT
    )
    if not ok:
        return {"success": False, "error": (stderr or stdout).strip()}
    return {"success": True, "targetDir": str(dest), "output": (stdout or stderr).strip()}


COMMANDS = {
    "status": status,
    "diff-file": diff_file,
    "stage": stage,
    "unstage": unstage,
    "discard": discard,
    "stage-all": stage_all,
    "unstage-all": unstage_all,
    "commit": commit,
    "branches": branches,
    "log": log,
    "commit-info": commit_info,
    "commit-file": commit_file,
    "resolve-all": resolve_all,
    "checkout": checkout,
    "pull": pull,
    "push": push,
    "clone": clone,
}


def run(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(json.dumps({"ok": False, "error": f"usage: git_cli.py <{'|'.join(COMMANDS)}> [json]"}))
        return 2

    handler = COMMANDS.get(argv[1])
    if handler is None:
        print(json.dumps({"ok": False, "error": f"unknown command: {argv[1]}"}))
        return 2

    try:
        raw = argv[2] if len(argv) > 2 else (sys.stdin.read() or "{}")
        payload = json.loads(raw or "{}")
        print(json.dumps({"ok": True, "data": handler(payload)}))
        return 0
    except Exception as exc:  # noqa: BLE001 - the CLI reports, it does not raise
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(run(sys.argv))
