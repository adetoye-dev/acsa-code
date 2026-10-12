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
# Output: .tauri/lsp/        (gitignored; ~50 MB compressed, ~130 MB on disk)
# Override the pins with LSP_NODE_VERSION / LSP_SERVER_VERSION.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NODE_VERSION="${LSP_NODE_VERSION:-v24.21.0}"
SERVER_VERSION="${LSP_SERVER_VERSION:-6.0.2}"
TS_VERSION="${LSP_TS_VERSION:-6.0.3}"
TRIPLE="$(rustc -vV | awk '/^host:/{print $2}')"
DEST="$REPO_ROOT/.tauri/lsp"
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

# Present *and* the pinned versions. Checking only for presence meant bumping a pin
# here changed nothing until someone deleted the directory by hand — the toolchain
# would sit at the old version and the check would happily pass.
if [ -x "$NODE" ] && [ -f "$SERVER_PKG" ] && [ -f "$TS_PKG" ]; then
  have_node="$("$NODE" --version)"
  have_server="$("$NODE" -p "require('$SERVER_PKG').version")"
  have_ts="$("$NODE" -p "require('$TS_PKG').version")"
  if [ "$have_node" = "$NODE_VERSION" ] && [ "$have_server" = "$SERVER_VERSION" ] && [ "$have_ts" = "$TS_VERSION" ]; then
    echo "Already present: node $have_node, server $have_server, fallback TypeScript $have_ts"
    exit 0
  fi
  echo "Refreshing: have node $have_node / server $have_server / TypeScript $have_ts; want $NODE_VERSION / $SERVER_VERSION / $TS_VERSION"
fi

mkdir -p "$DEST"

# ── The runtime ─────────────────────────────────────────────────────────────
# The official build, unmodified. It is the runtime `tsserver` is written for, and
# the one a language server can be expected to behave on.
if [ ! -x "$NODE" ]; then
  ARCHIVE="${TMPDIR:-/tmp}/node-${NODE_VERSION}-${NODE_ARCH}.tar.gz"
  echo "Downloading Node ${NODE_VERSION} (${NODE_ARCH})…"
  # `-C -` and `--retry`: this is a large asset, and a truncated file otherwise
  # fails at extract time with an error that says nothing about the download.
  curl -fsSL --retry 3 --retry-all-errors -C - -o "$ARCHIVE" \
    "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${NODE_ARCH}.tar.gz"
  mkdir -p "$DEST/node"
  tar xzf "$ARCHIVE" -C "$DEST/node" --strip-components=1
  rm -f "$ARCHIVE"
fi

# ── The server ──────────────────────────────────────────────────────────────
# The TypeScript pinned beside the server is the *fallback*: the one used when a
# project has no TypeScript of its own (a fresh clone before `npm install`, or a
# directory of loose `.ts` files). Every project that has one gets its own version
# instead, whatever that is, because that is the version its `tsc` and its CI use —
# and the log line quoted above is that working.
#
# 6.0.3, not 7.x: TypeScript 7 is the native port and its npm package no longer
# contains `tsserver.js` at all (only `lib/tsc` and a new API under `dist/api/`),
# so there is no JS language service in it for this server to load. 6.x is the
# newest line that still ships one. See docs/LANGUAGE_SERVICE.md for the
# measurements, including TS 7's disagreements with this project's own `tsc`.
# workspace's own copy when a project has one — verified in its log: "Using
# Typescript version (workspace) 5.9.3 from .../node_modules/typescript/lib/
# tsserver.js" — which is what makes the editor's diagnostics match the project's
# `npm run typecheck` instead of matching whatever we happened to pin. The bundled
# copy is the fallback for a project with no TypeScript of its own.
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
  # The official tarball brings its own npm; use that one rather than whatever is
  # on PATH, so the install is the pinned Node's behaviour and not the machine's.
  "$NODE" "$NPM_CLI" install --prefix "$DEST/server" --no-fund --no-audit
else
  npm install --prefix "$DEST/server" --no-fund --no-audit
fi

echo "LSP ready: node $("$NODE" --version), server $("$NODE" -p "require('$SERVER_PKG').version"), fallback TypeScript $("$NODE" -p "require('$TS_PKG').version")"
echo "Check it:  node scripts/check_lsp.mjs"
