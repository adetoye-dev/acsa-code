#!/usr/bin/env python3
"""ollama_cli.py — local Ollama state, for the workbench UI.

Why this exists: the app used to learn about Ollama only from
`vite-fs-bridge.ts`, which is a Vite dev-server middleware. `configureServer`
never runs in a build, so a packaged app could not see a running Ollama at all —
the dashboard reported "Not installed" and an empty model list while the agent,
which talks to 127.0.0.1:11434 from Python, used it happily. The probe lives here
so the packaged IPC path and the dev bridge can share one implementation.

Usage: python3 ollama_cli.py status
       python3 ollama_cli.py start
       python3 ollama_cli.py install
       python3 ollama_cli.py pull '{"model": "qwen2.5-coder:7b"}'
       python3 ollama_cli.py delete '{"model": "qwen2.5-coder:7b"}'
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
import time
import tool_paths
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")

# Ollama's own macOS installer leaves the engine inside the app bundle. The other
# places it can live — Homebrew, `/usr/local/bin` — are in `tool_paths`, which also
# knows why a window launched from the Dock cannot see them on PATH.
OLLAMA_APP_BINARY = "/Applications/Ollama.app/Contents/Resources/ollama"


def _binary() -> str | None:
    """The Ollama binary, wherever it is.

    In order: one already on PATH, then the copy this app installed itself, then
    the bundle Ollama's installer left, then the usual install directories.
    """
    ours = _installed_binary()
    extra = [str(ours)] if ours is not None else []
    extra.append(OLLAMA_APP_BINARY)
    return tool_paths.find("ollama", extra_paths=extra)


def _install_root() -> Path:
    """Where this app keeps an Ollama it installed itself.

    Deliberately under the app's own data directory: installing here needs no
    administrator password, replaces nothing the user already has, and is
    removed by the same uninstall that removes the app.
    """
    override = os.environ.get("ACSA_OLLAMA_HOME")
    if override:
        return Path(override).expanduser()
    home = Path.home()
    if sys.platform == "darwin":
        base = home / "Library" / "Application Support" / "ACSA Code"
    elif os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or (home / "AppData" / "Local")) / "ACSA Code"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or (home / ".local" / "share")) / "acsa-code"
    return base / "engines" / "ollama"


def _installed_binary() -> Path | None:
    """The engine binary inside our own install root, if it is already there."""
    root = _install_root()
    if sys.platform == "darwin":
        candidate = root / "Ollama.app" / "Contents" / "Resources" / "ollama"
    elif os.name == "nt":
        candidate = root / "ollama.exe"
    else:
        candidate = root / "ollama"
    return candidate if candidate.is_file() else None


def _artifact_url() -> str | None:
    """Ollama's own signed release for this machine, or None if we cannot say.

    These are Ollama's published builds, fetched from Ollama — not something we
    re-host. That is the whole reason this is allowed to exist: the previous
    version refused to install on the grounds that "a copy we fetch can be
    neither signed nor notarised", which was true of a copy *we* built and false
    of the one the vendor publishes.
    """
    if sys.platform == "darwin":
        return "https://ollama.com/download/Ollama-darwin.zip"
    if os.name == "nt":
        machine = platform.machine().lower()
        if machine in ("arm64", "aarch64"):
            return "https://ollama.com/download/ollama-windows-arm64.zip"
        return "https://ollama.com/download/ollama-windows-amd64.zip"
    return None


def _get(path: str, timeout: float = 2.0) -> dict | None:
    """GET a JSON document, or None when the server is not answering."""
    try:
        with urllib.request.urlopen(f"{OLLAMA_HOST}{path}", timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None


def _post(path: str, payload: dict, timeout: float = 2.0) -> dict | None:
    try:
        request = urllib.request.Request(
            f"{OLLAMA_HOST}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None


def _total_ram_gb() -> int:
    try:
        if sys.platform == "darwin":
            out = subprocess.run(
                ["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5
            )
            return round(int(out.stdout.strip()) / (1024**3))
        with open("/proc/meminfo", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("MemTotal:"):
                    return round(int(line.split()[1]) / (1024**2))
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return 0


def _recommended_model(total_ram_gb: int) -> str:
    if total_ram_gb >= 16:
        return "qwen2.5-coder:7b"
    if total_ram_gb >= 8:
        return "qwen2.5-coder:3b"
    return "qwen2.5-coder:1.5b"


def _format_size(size_bytes: int) -> str:
    if size_bytes <= 0:
        return ""
    if size_bytes >= 1024**3:
        return f"{size_bytes / (1024 ** 3):.1f} GB"
    return f"{round(size_bytes / (1024 ** 2))} MB"


def _model_detail(entry: dict) -> dict:
    name = entry.get("name") or ""
    size_bytes = entry.get("size") if isinstance(entry.get("size"), int) else 0
    capabilities: list[str] = []
    context_length: int | None = None
    parameter_count: int | None = None

    # `/api/show` is the only place that reports what the model can actually do
    # and the context window it was built with.
    show = _post("/api/show", {"name": name}, timeout=1.5) or {}
    if isinstance(show.get("capabilities"), list):
        capabilities = show["capabilities"]
    info = show.get("model_info")
    if isinstance(info, dict):
        for key, value in info.items():
            if key.endswith(".context_length") and isinstance(value, int):
                context_length = value
                break
        if isinstance(info.get("general.parameter_count"), int):
            parameter_count = info["general.parameter_count"]

    details = entry.get("details") or {}
    return {
        "name": name,
        "tag": name,
        "sizeBytes": size_bytes,
        "sizeFormatted": _format_size(size_bytes),
        "parameterSize": details.get("parameter_size"),
        "family": details.get("family"),
        "quantizationLevel": details.get("quantization_level"),
        "modifiedAt": entry.get("modified_at"),
        "capabilities": capabilities,
        "contextLength": context_length,
        "parameterCount": parameter_count,
    }


def status(payload: dict | None = None) -> dict:
    """Install/running state plus the model inventory.

    A server that is not answering is reported as `running: false`, not as an
    error — that is a real answer. `error` is reserved for "detection could not
    be performed", so the UI never presents a failed probe as a finding.
    """
    binary = _binary()
    tags = _get("/api/tags")
    running = tags is not None
    raw_models = (tags or {}).get("models") or []
    total_ram_gb = _total_ram_gb()
    return {
        "installed": bool(binary),
        "running": running,
        "models": [m.get("name") for m in raw_models if m.get("name")],
        "modelsDetails": [_model_detail(m) for m in raw_models if m.get("name")],
        "recommendedModel": _recommended_model(total_ram_gb),
        "totalRamGb": total_ram_gb,
        "binaryPath": binary,
        "error": None,
    }


def start(payload: dict | None = None) -> dict:
    """Start the daemon, then wait for it to answer."""
    if _get("/api/tags", timeout=1.0) is not None:
        return {"started": True, "alreadyRunning": True}

    binary = _binary()
    if not binary:
        return {"started": False, "error": "Ollama is not installed."}

    try:
        subprocess.Popen(
            [binary, "serve"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as exc:
        return {"started": False, "error": f"Could not start Ollama: {exc}"}

    for _ in range(20):
        time.sleep(0.5)
        if _get("/api/tags", timeout=1.0) is not None:
            return {"started": True, "alreadyRunning": False}
    return {"started": False, "error": "Ollama did not report ready in time."}


def _download(url: str, destination: Path) -> int:
    """Stream `url` into `destination`, emitting percent frames. Returns bytes."""
    request = urllib.request.Request(url, headers={"User-Agent": "ACSA-Code"})
    # No read deadline: a large build on a slow line is legitimately slow, and
    # aborting a download that is still moving is the worst thing an installer
    # can do. Only the connection needs a bound.
    with urllib.request.urlopen(request, timeout=30) as response:
        total = int(response.headers.get("Content-Length") or 0)
        received = 0
        # One frame per whole percent, not one per socket read. A chunked read
        # fires ~750 times for a build this size, and every frame becomes a
        # Tauri event and a React state update — a download that stutters the
        # whole window it is reporting to.
        last_percent = -1
        with open(destination, "wb") as handle:
            while True:
                chunk = response.read(262_144)
                if not chunk:
                    break
                handle.write(chunk)
                received += len(chunk)
                if total:
                    percent = min(99, round(received / total * 100))
                    if percent != last_percent:
                        last_percent = percent
                        _emit(
                            {
                                "percent": percent,
                                "status": (
                                    f"Downloading Ollama… {_format_size(received)} of {_format_size(total)}"
                                ),
                            }
                        )
    return received


def install(payload: dict | None = None) -> None:
    """Fetch Ollama for the user and unpack it where this app can run it.

    Installing used to be the user's job: the wizard threw an error telling them
    to go to ollama.com, download the right build for their chip, and come back.
    That is a support ticket, not a setup step — a developer who has never used a
    local model should not have to leave the app at all.

    We unpack Ollama's own published release into a directory this app owns.
    Nothing outside that folder is touched, so there is no password prompt; and
    we do not run Ollama's installer or its `curl | sh` script, both of which
    want root and write into system paths.
    """
    existing = _binary()
    if existing:
        _emit({"done": True, "alreadyInstalled": True, "binaryPath": existing})
        return

    url = _artifact_url()
    if url is None:
        _emit(
            {
                "done": True,
                "error": (
                    "Automatic setup is not available on this system yet. "
                    "Install Ollama from ollama.com, then choose Retry."
                ),
            }
        )
        return

    root = _install_root()
    parent = root.parent
    staging = parent / (root.name + ".staging")
    archive = parent / (root.name + ".download")

    try:
        parent.mkdir(parents=True, exist_ok=True)
        if staging.exists():
            shutil.rmtree(staging)
        staging.mkdir(parents=True)

        _emit({"percent": 0, "status": "Starting the Ollama download…"})
        if _download(url, archive) <= 0:
            raise RuntimeError("the download came back empty")

        _emit({"percent": 100, "status": "Unpacking Ollama…"})
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(staging)

        # Swap the finished tree into place only once it is complete, so a
        # download that dies halfway never leaves a half-installed engine that
        # looks installed.
        if root.exists():
            shutil.rmtree(root)
        shutil.move(str(staging), str(root))

        binary = _installed_binary()
        if binary is None:
            raise RuntimeError("the archive did not contain the Ollama engine")
        if os.name != "nt":
            os.chmod(binary, 0o755)
        _emit({"done": True, "binaryPath": str(binary)})
    except Exception as exc:  # noqa: BLE001 - the CLI reports, it does not raise
        _emit({"done": True, "error": f"Could not set up Ollama: {exc}"})
    finally:
        try:
            archive.unlink(missing_ok=True)
        except OSError:
            pass
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)


def pull(payload: dict | None = None) -> None:
    """Download a model, writing one NDJSON progress frame per line.

    Streaming, because a download is minutes long and a silent wait is
    indistinguishable from a hang. Frames carry `percent`/`status` while it runs
    and exactly one terminal frame: `{"done": true, "model": …}` or
    `{"done": true, "error": …}`.
    """
    model = str((payload or {}).get("model") or "").strip()
    if not model:
        _emit({"done": True, "error": "No model was given."})
        return
    if _get("/api/tags", timeout=1.5) is None:
        _emit({"done": True, "error": "Ollama is not running. Start it and try again."})
        return

    request = urllib.request.Request(
        f"{OLLAMA_HOST}/api/pull",
        data=json.dumps({"model": model, "stream": True}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        # No timeout: a large model on a slow line is legitimately slow, and a
        # deadline here would abort a download that is still making progress.
        with urllib.request.urlopen(request) as response:
            for raw in response:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    frame = json.loads(line)
                except ValueError:
                    continue
                if frame.get("error"):
                    _emit({"done": True, "error": str(frame["error"])})
                    return
                total = frame.get("total") or 0
                completed = frame.get("completed") or 0
                percent = round((completed / total) * 100) if total else 0
                _emit(
                    {
                        "percent": percent,
                        "status": frame.get("status") or f"Downloading {model}",
                    }
                )
    except (urllib.error.HTTPError, urllib.error.URLError, OSError) as exc:
        _emit({"done": True, "error": f"Download failed: {exc}"})
        return
    _emit({"done": True, "model": model, "percent": 100, "status": "Ready"})


def _emit(frame: dict) -> None:
    sys.stdout.write(json.dumps(frame) + "\n")
    sys.stdout.flush()


def _require_model(payload: dict | None) -> str:
    model = str((payload or {}).get("model") or "").strip()
    if not model:
        raise ValueError("No model was given.")
    return model


def delete(payload: dict | None = None) -> dict:
    """Remove a downloaded model. There is no undo, so it reports what happened."""
    model = _require_model(payload)
    request = urllib.request.Request(
        f"{OLLAMA_HOST}/api/delete",
        data=json.dumps({"model": model}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="DELETE",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            response.read()
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return {"ok": False, "error": f"{model} is not installed."}
        return {"ok": False, "error": f"Ollama refused the delete ({exc.code})."}
    except (urllib.error.URLError, OSError) as exc:
        return {"ok": False, "error": f"Ollama is not reachable: {exc}"}
    return {"ok": True, "model": model}


def show(payload: dict | None = None) -> dict:
    """The model's own manifest: parameters, template, capabilities."""
    model = _require_model(payload)
    document = _post("/api/show", {"model": model}, timeout=10)
    if document is None:
        return {"ok": False, "error": f"Ollama could not describe {model}."}
    return {"ok": True, "model": model, **document}


COMMANDS = {
    "status": status,
    "start": start,
    "install": install,
    "pull": pull,
    "delete": delete,
    "show": show,
}
STREAMING = {"pull", "install"}


def run(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(json.dumps({"ok": False, "error": f"usage: ollama_cli.py <{'|'.join(COMMANDS)}>"}))
        return 2

    handler = COMMANDS.get(argv[1])
    if handler is None:
        print(json.dumps({"ok": False, "error": f"unknown command: {argv[1]}"}))
        return 2

    try:
        raw = argv[2] if len(argv) > 2 else (sys.stdin.read() or "{}")
        payload = json.loads(raw or "{}")
        result = handler(payload)
        # `pull` writes its own frames and has no envelope.
        if argv[1] in STREAMING:
            return 0
        print(json.dumps({"ok": True, "data": result}))
        return 0
    except Exception as exc:  # noqa: BLE001 - the CLI reports, it does not raise
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(run(sys.argv))
