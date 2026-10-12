#!/usr/bin/env bash
# Fetch the TypeScript language server the editor will run on.
#
# Why this replaces the in-editor TypeScript: Monaco ships a TypeScript compiled
# into a Web Worker, which has no filesystem, so imports only resolve against a
# mirror of the project that this app builds by hand (`monacoProjectFiles.ts`,
# ~950 lines, with file/byte/package budgets). Every case the mirror does not
# cover arrives as a diagnostic other editors do not show, and the fixes are
# per-symptom. A real language server reads the project — its tsconfig, its
# `node_modules`, its `paths`, its own TypeScript version — so there is nothing to
# approximate.
#
# Standard arrangement, the one VS Code uses: a JS runtime plus `tsserver`, spoken
# to over LSP. Measured against this repository (see docs/LANGUAGE_SERVICE.md for
# the full comparison):
#
#   initialize          724 ms
#   first diagnostics  1886 ms      (native TS 7: 131 ms, but see below)
#   completion          290 ms, 1014 items
#   TypeScript version  the workspace's 5.9.3, from node_modules
#
# The last line is the point. TypeScript 7 ships a native compiler with its own
# LSP server, and it is dramatically faster — but it always type-checks with TS 7
# semantics, and on this repository it reports six errors that `tsc` (5.9.3) and
# every other editor say are not there. Version parity with the project is worth
# more than startup time, so the JS server is what ships; the native one is a
# candidate for projects that are themselves on TS 7.
#
# Usage:  scripts/fetch_lsp_sidecar.sh
# Output: .lsp/              (gitignored; ~50 MB compressed, ~130 MB on disk)
# Override the pins with LSP_NODE_VERSION / LSP_SERVER_VERSION.
#
# Deliberately *not* `.tauri/lsp/`, unlike `engine/` and `engine-codex/`. The
# other two are a frozen binary and a native executable; this one is an npm
# package, so it contains a `package.json` — and `tauri build` finds the app's
# package root by looking for one under the app directory. With `package.json` in
# `.tauri/lsp/server/`, `tauri build` ran `beforeBuildCommand` (`npm run build`)
# *there*, against a manifest with no build script:
#
#   npm error Missing script: "build"
#
# An empty `.tauri/lsp/` is harmless, which is what made this a puzzle worth
# writing down rather than a path to just change.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NODE_VERSION="${LSP_NODE_VERSION:-v24.21.0}"
SERVER_VERSION="${LSP_SERVER_VERSION:-6.0.2}"
TS_VERSION="${LSP_TS_VERSION:-6.0.3}"
TRIPLE="$(rustc -vV | awk '/^host:/{print $2}')"
DEST="$REPO_ROOT/.lsp"
NODE="$DEST/node/bin/node"

case "$TRIPLE" in
  aarch64-apple-darwin)      NODE_ARCH="darwin-arm64" ;;
  x86_64-apple-darwin)       NODE_ARCH="darwin-x64" ;;
  aarch64-unknown-linux-gnu) NODE_ARCH="linux-arm64" ;;
  x86_64-unknown-linux-gnu)  NODE_ARCH="linux-x64" ;;
  x86_64-pc-windows-msvc)    NODE_ARCH="win-x64" ;;
  *) echo "error: no pinned Node build for ${TRIPLE}" >&2; exit 1 ;;
esac

SERVER_PKG="$DEST/server/node_modules/typescript-language-server/package.json"
TS_PKG="$DEST/server/node_modules/typescript/package.json"

mkdir -p "$DEST"

# Each part is checked on its own version rather than with one "already present"
# flag. Twice now the flag skipped work that needed doing — a bumped pin changed
# nothing, and then the prune below never ran on a tree that was already there.
have() { [ -f "$1" ] && "$NODE" -p "require('$1').version" 2>/dev/null; }

# ── The runtime ─────────────────────────────────────────────────────────────
if [ ! -x "$NODE" ] || [ "$("$NODE" --version 2>/dev/null)" != "$NODE_VERSION" ]; then
  ARCHIVE="${TMPDIR:-/tmp}/node-${NODE_VERSION}-${NODE_ARCH}.tar.gz"
  echo "Downloading Node ${NODE_VERSION} (${NODE_ARCH})…"
  # `-C -` and `--retry`: this is a large asset, and a truncated file otherwise
  # fails at extract time with an error that says nothing about the download.
  curl -fsSL --retry 3 --retry-all-errors -C - -o "$ARCHIVE" \
    "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${NODE_ARCH}.tar.gz"
  rm -rf "$DEST/node"
  mkdir -p "$DEST/node"
  tar xzf "$ARCHIVE" -C "$DEST/node" --strip-components=1
  rm -f "$ARCHIVE"
fi

# ── The server ──────────────────────────────────────────────────────────────
# The server resolves the workspace's own TypeScript when a project has one —
# verified in its log: "Using Typescript version (workspace) 5.9.3 from
# .../node_modules/typescript/lib/tsserver.js" — which is what makes the editor's
# diagnostics match the project's `npm run typecheck` instead of matching whatever
# we happened to pin.
#
# The TypeScript pinned beside it is the *fallback*: the one used when a project has
# no TypeScript of its own (a fresh clone before `npm install`, or a directory of
# loose `.ts` files). 6.0.3, not 7.x: TypeScript 7 is the native port and its npm
# package no longer contains `tsserver.js` at all (only `lib/tsc` and a new API
# under `dist/api/`), so there is no JS language service in it for this server to
# load. 6.x is the newest line that still ships one. See docs/LANGUAGE_SERVICE.md
# for the measurements, including TS 7's disagreements with this project's `tsc`.
if [ "$(have "$SERVER_PKG")" != "$SERVER_VERSION" ] || [ "$(have "$TS_PKG")" != "$TS_VERSION" ]; then
  mkdir -p "$DEST/server"
  cat > "$DEST/server/package.json" <<JSON
{
  "name": "acsa-lsp-server",
  "private": true,
  "description": "Pinned TypeScript language server. See scripts/fetch_lsp_sidecar.sh.",
  "dependencies": {
    "typescript-language-server": "${SERVER_VERSION}",
    "typescript": "${TS_VERSION}"
  }
}
JSON
  echo "Installing typescript-language-server ${SERVER_VERSION}…"
  # `--prefix` keeps npm from walking up into the app's own package.json.
  NPM_CLI="$(cd "$(dirname "$NODE")/.." && pwd)/lib/node_modules/npm/bin/npm-cli.js"
  if [ -f "$NPM_CLI" ]; then
    # The official tarball brings its own npm; use that rather than whatever is on
    # PATH, so the install is the pinned Node's behaviour, not the machine's.
    "$NODE" "$NPM_CLI" install --prefix "$DEST/server" --no-fund --no-audit
  else
    npm install --prefix "$DEST/server" --no-fund --no-audit
  fi
fi

# The install above uses the bundled npm, so it runs before the prune that removes it.
# ── Prune the runtime down to what runs ─────────────────────────────────────
# The official tarball is 199 MB and 116 MB of that is the binary: the rest is npm
# with its own dependency tree, C++ headers, man pages and docs, none of which
# execute. Everything here ships inside the app, so it is worth removing — and the
# licences stay, because a shipped binary's licence has to travel with it.
if [ -d "$DEST/node/include" ] || [ -d "$DEST/node/lib/node_modules" ]; then
  before="$(du -sm "$DEST/node" | cut -f1)"
  find "$DEST/node" -mindepth 1 -maxdepth 1 ! -name bin ! -name LICENSE -exec rm -rf {} +
  find "$DEST/node/bin" -mindepth 1 ! -name node ! -name node.exe -exec rm -rf {} +
  # Deliberately not stripped. `strip -x` removes 22 MB of symbols and invalidates
  # the binary's signature, and macOS kills a binary whose signature does not match
  # — "Killed: 9", which is what this script said the first time it tried. 22 MB is
  # not worth a runtime that is one signing step away from not starting.
  after="$(du -sm "$DEST/node" | cut -f1)"
  echo "Pruned the runtime: ${before} MB -> ${after} MB"
fi

"$NODE" --version > /dev/null || { echo "error: the runtime does not run after pruning" >&2; exit 1; }

echo "LSP ready: node $("$NODE" --version), server $("$NODE" -p "require('$SERVER_PKG').version"), fallback TypeScript $("$NODE" -p "require('$TS_PKG').version")"
echo "Check it:  node scripts/check_lsp.mjs"
