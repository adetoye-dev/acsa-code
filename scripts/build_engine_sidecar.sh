#!/usr/bin/env bash
# Freeze the Python engine into the single binary the desktop app ships.
#
# Why: the app's backend is Python, and macOS no longer ships a usable
# interpreter while Windows ships none, so on a clean machine nothing worked.
# `acsa-engine` bundles the engine, the standard library and a Python runtime
# into one executable, so the app needs nothing installed.
#
# Usage:  scripts/build_engine_sidecar.sh
# Output: .tauri/engine/acsa-engine/acsa-engine  (an onedir tree, shipped as a resource)
#
# Tauri resolves `externalBin` entries by that triple suffix and strips it when
# bundling, so the app looks for a plain `acsa-engine` next to its executable.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TRIPLE="$(rustc -vV | awk '/^host:/{print $2}')"
if [[ -z "${TRIPLE}" ]]; then
  echo "error: could not determine the Rust target triple (is rustc installed?)" >&2
  exit 1
fi

# `DISTPATH` is overridable so a build can be produced beside the shipped one
# and tested on its own — the sidecar is what the app spawns for every call, so
# "did this freeze actually work?" is worth being able to answer without
# guessing which binary is on disk.
DISTPATH="${ACSA_ENGINE_DISTPATH:-.tauri/engine}"
VENV="${ACSA_FREEZE_VENV:-/tmp/acsa-freeze-venv}"
if [[ ! -x "${VENV}/bin/pyinstaller" ]]; then
  echo "Creating build virtualenv at ${VENV}…"
  python3 -m venv "${VENV}"
  "${VENV}/bin/pip" install --quiet --disable-pip-version-check pyinstaller
fi

mkdir -p .tauri/binaries
# `skill_loader` resolves the built-in skills relative to its own file, so the
# markdown has to travel with it — otherwise the frozen engine reports an empty
# skill catalog and the marketplace looks broken in the packaged app.

# The dispatcher imports its entry points dynamically, so they are declared
# explicitly; PyInstaller's static analysis cannot see them.
# `--onedir`, not `--onefile`: onefile writes a NEW executable to a temp directory on
# every launch, so macOS scans a fresh binary every time. Measured on this machine:
# 8.5s per call warm, versus 0.06s for a stable onedir binary — the cost of a scan,
# not of unpacking (the payload is only 14 MB). Since every IPC call spawns the
# engine, onefile made the whole app feel broken.
"${VENV}/bin/pyinstaller" \
  --onedir --noconfirm --clean \
  --name acsa-engine \
  --distpath "${DISTPATH}" \
  --workpath "${TMPDIR:-/tmp}/acsa-freeze-build" \
  --specpath "${TMPDIR:-/tmp}/acsa-freeze-spec" \
  --paths core-engine \
  --paths core-engine/data-map \
  --paths core-engine/mcp_servers \
  --paths core-engine/skills \
  --paths scripts \
  --hidden-import db_cli \
  --hidden-import project_indexer \
  --hidden-import pty_bridge \
  --hidden-import app_db \
  --hidden-import env_file \
  --hidden-import ollama_cli \
  --hidden-import git_cli \
  --hidden-import gh_cli \
  --hidden-import tool_paths \
  --hidden-import indexer_cli \
  --hidden-import skills_cli \
  --hidden-import mcp_cli \
  --hidden-import ai_cli \
  --hidden-import project_cli \
  --hidden-import fs_cli \
  --hidden-import skill_loader \
  --add-data "${REPO_ROOT}/core-engine/skills:skills" \
  --hidden-import mcp_client \
  --hidden-import responses_adapter \
  --hidden-import crash_log \
  --hidden-import backup \
  --hidden-import support \
  --hidden-import snapshot_cli \
  core-engine/acsa_engine.py

ENGINE_BIN="${DISTPATH}/acsa-engine/acsa-engine"

echo
echo "Built ${ENGINE_BIN}"
echo "Smoke test:"
"${ENGINE_BIN}" db info
