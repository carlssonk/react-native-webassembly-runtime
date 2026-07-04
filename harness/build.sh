#!/bin/bash
# Builds the JSI harness (JavaScriptCore + wasm3 binding) and the bundled
# kaspa-keygen test script.
set -euo pipefail

cd "$(dirname "$0")"

RN=../node_modules/react-native
OUT=./build
mkdir -p "$OUT"

echo "== compiling wasm3 (C) =="
for f in ../cpp/m3_*.c; do
  o="$OUT/$(basename "${f%.c}").o"
  [ "$o" -nt "$f" ] || clang -O2 -std=c11 -DRNWASM_LOG_RESIZE -I../cpp -c "$f" -o "$o"
done

echo "== compiling jsi + binding + harness (C++) =="
CXXFLAGS="-O2 -std=c++17 -mmacosx-version-min=15.0 -I$RN/ReactCommon/jsi -I../cpp -I."

clang++ $CXXFLAGS -c "$RN/ReactCommon/jsi/jsi/jsi.cpp" -o "$OUT/jsi.o"
clang++ $CXXFLAGS -c JSCRuntime.cpp -o "$OUT/JSCRuntime.o"
clang++ $CXXFLAGS -c ../cpp/react-native-webassembly.cpp -o "$OUT/binding.o"
clang++ $CXXFLAGS -c main.cpp -o "$OUT/main.o"

echo "== linking =="
clang++ -o "$OUT/harness" "$OUT"/*.o -framework JavaScriptCore

# --keep-names matters: kaspa's workflow-rs runtime compares constructor
# names, which minified/renamed classes would break (also applies to Metro).
# The kaspa bundles need the sibling rusty-kaspa checkout; skipped when absent
# (e.g. in CI).
KASPA_WEB="$(cd ../.. && pwd)/rusty-kaspa/wasm/web"

if [ -d "$KASPA_WEB/kaspa-keygen" ]; then
  echo "== bundling kaspa tests =="
  npx --yes esbuild harness-entry.mjs \
    --bundle --format=iife --platform=neutral --keep-names \
    --define:__KASPA_WASM_PATH__="\"$KASPA_WEB/kaspa-keygen/kaspa_bg.wasm\"" \
    --outfile="$OUT/kaspa-keygen-test.bundle.js"

  npx --yes esbuild harness-rpc-entry.mjs \
    --bundle --format=iife --platform=neutral --keep-names \
    --define:__KASPA_RPC_WASM_PATH__="\"$KASPA_WEB/kaspa-rpc/kaspa_bg.wasm\"" \
    --outfile="$OUT/kaspa-rpc-test.bundle.js"

  npx --yes esbuild harness-sdk-entry.mjs \
    --bundle --format=iife --platform=neutral --keep-names \
    --define:__KASPA_SDK_WASM_PATH__="\"$KASPA_WEB/kaspa/kaspa_bg.wasm\"" \
    --outfile="$OUT/kaspa-sdk-test.bundle.js"

  npx --yes esbuild grow-test-entry.mjs \
    --bundle --format=iife --platform=neutral --keep-names \
    --define:__KASPA_WASM_PATH__="\"$KASPA_WEB/kaspa-keygen/kaspa_bg.wasm\"" \
    --outfile="$OUT/grow-test.bundle.js"
  echo 'globalThis.__PRESIZE_PAGES__ = 0;' > "$OUT/presize-0.js"
else
  echo "== rusty-kaspa checkout not found; skipping kaspa bundles =="
fi

echo "OK: $OUT/harness"
