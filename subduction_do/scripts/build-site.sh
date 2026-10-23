#!/usr/bin/env bash
#
# Assemble the deployable static site into ./public (the wrangler `assets`
# directory). The service ships the landing page plus the live workspace demo
# under /demo — the chat under examples/chat is a standalone example and is
# intentionally NOT deployed here.
#
# Sources live in ./site (committed); ./public is a build artifact (gitignored).
# The demo needs the browser wasm bindings built with the `idb` feature so it
# can persist Automerge documents in IndexedDB; those are compiled fresh into
# ./public/demo/pkg here (never committed).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$here/site"
out="$here/public"

# Resolve wasm-pack: prefer the local devDependency, fall back to PATH.
if [[ -x "$here/node_modules/.bin/wasm-pack" ]]; then
  wasm_pack="$here/node_modules/.bin/wasm-pack"
elif command -v wasm-pack >/dev/null 2>&1; then
  wasm_pack="wasm-pack"
else
  echo "error: wasm-pack not found (run 'npm install' in subduction_do)" >&2
  exit 1
fi

# Bundle the self-hosted Automerge (same-origin, wasm embedded) for the demo.
echo "bundling demo Automerge -> site/demo/automerge.js"
node "$here/scripts/vendor-automerge.mjs"

rm -rf "$out"
mkdir -p "$out"
cp -R "$src"/. "$out"/

# Never ship a stale, locally-built dev pkg; build it fresh for the deploy.
rm -rf "$out/demo/pkg"
echo "building demo wasm bindings (idb) -> $out/demo/pkg"
"$wasm_pack" build "$here/../subduction_wasm" \
  --target web --release \
  --out-dir "$out/demo/pkg" \
  --out-name subduction_wasm \
  -- --features idb

echo "site assembled -> $out"
