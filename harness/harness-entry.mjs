// Harness entry, bundled by esbuild together with the polyfill, the shared
// test, and the kaspa glue. Installs the polyfill, then reports the test
// result via the globals the C++ host inspects.
import { installWebAssemblyPolyfill } from '../src/polyfill/core';

import { runKaspaKeygenTest } from './kaspa-keygen-test.mjs';

installWebAssemblyPolyfill({ force: true });

const bytes = __readFileArrayBuffer(__KASPA_WASM_PATH__);

const startedAt = __hrtimeMs();

runKaspaKeygenTest(bytes)
  .then((result) => {
    globalThis.__testResult = JSON.stringify(
      { ...result, elapsedMs: Math.round(__hrtimeMs() - startedAt) },
      null,
      2
    );
  })
  .catch((e) => {
    globalThis.__testError = String((e && e.stack) || e);
  });
