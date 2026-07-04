#!/bin/bash
# CI entry: builds the harness, then runs the binding-semantics tests and the
# WebAssembly spec suite (MVP, wg-1.0). Gated spec assertions must pass 100%.
# The kaspa SDK tests run only when the sibling rusty-kaspa checkout exists.
set -euo pipefail

cd "$(dirname "$0")"

./build.sh
./spec/prepare.sh

SPEC_DIR="$(pwd)/build/spec"

npx --yes esbuild spec/spec-runner-entry.mjs \
  --bundle --format=iife --platform=neutral \
  --define:__SPEC_DIR__="\"$SPEC_DIR\"" \
  --outfile=build/spec-runner.bundle.js

npx --yes esbuild binding-tests-entry.mjs \
  --bundle --format=iife --platform=neutral \
  --outfile=build/binding-tests.bundle.js

echo "== binding-semantics tests =="
./build/harness env.js build/binding-tests.bundle.js

echo "== WebAssembly spec suite =="
./build/harness env.js build/spec-runner.bundle.js > build/spec-results.json

node -e "
const r = require('./build/spec-results.json');
console.log('gated:', r.gated, '| validation (informational):', r.reported, '| skipped:', r.skipped);
if (r.gatedPassRate !== 1) {
  console.error('GATED SPEC FAILURES:');
  r.failures.forEach((f) => console.error(' ', f));
  process.exit(1);
}
// Guard against silent coverage loss (e.g. files dropping out of conversion):
// the full suite gates ~15k assertions.
const total = Number(r.gated.split('/')[1]);
if (total < 14000) {
  console.error('SPEC COVERAGE DROPPED: only ' + total + ' gated assertions ran (expected ~15000).');
  process.exit(1);
}
"

if [ -f build/kaspa-keygen-test.bundle.js ]; then
  echo "== kaspa SDK tests =="
  ./build/harness env.js build/kaspa-keygen-test.bundle.js
  ./build/harness env.js build/kaspa-rpc-test.bundle.js
  ./build/harness env.js build/kaspa-sdk-test.bundle.js

  echo "== memory-grow integrity (non-moving memory) =="
  ./build/harness env.js build/presize-0.js build/grow-test.bundle.js > build/grow-result.json
  node -e "
  const r = require('./build/grow-result.json');
  if (!r.grew || !r.integrityAfterGrowth) {
    console.error('GROW INTEGRITY FAILED:', JSON.stringify(r));
    process.exit(1);
  }
  console.log('grew and stayed intact:', r.beforeBytes, '->', r.afterBytes, 'bytes');
  "
fi

echo "HARNESS CI OK"
