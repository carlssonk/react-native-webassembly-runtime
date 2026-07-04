#!/bin/bash
# Fetches the MVP-era (wg-1.0) WebAssembly spec tests and converts them to
# wast2json form under harness/build/spec/, plus a manifest the in-harness
# runner iterates. Requires wabt (brew install wabt).
set -euo pipefail

cd "$(dirname "$0")/.."

OUT=build/spec
SRC=build/spec-src

command -v wast2json >/dev/null || { echo "wast2json not found (brew install wabt)"; exit 69; }

if [ ! -d "$SRC" ]; then
  git clone --depth 1 --branch wg-1.0 https://github.com/WebAssembly/spec "$SRC"
fi

# Several wg-1.0 files use the retired assert_return_canonical_nan syntax
# that modern wabt rejects; the current testsuite carries the same content
# in modern syntax. Fetched as the fallback source.
FALLBACK=build/spec-testsuite
if [ ! -d "$FALLBACK" ]; then
  git clone --depth 1 https://github.com/WebAssembly/testsuite "$FALLBACK"
fi

mkdir -p "$OUT"

manifest="$OUT/manifest.json"
echo -n '[' > "$manifest"
first=1

for wast in "$SRC"/test/core/*.wast; do
  name="$(basename "${wast%.wast}")"

  ok=0
  if wast2json --no-check -o "$OUT/$name.json" "$wast" 2> "$OUT/$name.err"; then
    ok=1
  elif [ -f "$FALLBACK/$name.wast" ] &&
       wast2json --no-check -o "$OUT/$name.json" "$FALLBACK/$name.wast" 2>> "$OUT/$name.err"; then
    ok=1
    echo "note: $name converted from the modern testsuite (wg-1.0 syntax rejected)"
  fi

  if [ $ok -eq 1 ]; then
    rm -f "$OUT/$name.err"
    [ $first -eq 1 ] || echo -n ',' >> "$manifest"
    first=0
    echo -n "\"$name\"" >> "$manifest"
  else
    echo "SKIP (wast2json failed in both sources): $name"
  fi
done

echo ']' >> "$manifest"
echo "prepared $(ls "$OUT"/*.json | wc -l | tr -d ' ') json files in $OUT"
