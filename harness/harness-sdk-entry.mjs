// Harness entry for the full-SDK test + benchmarks.
import { installWebAssemblyPolyfill } from '../src/polyfill/core';

import { runKaspaSdkTest } from './kaspa-sdk-test.mjs';

installWebAssemblyPolyfill({ force: true });

const bytes = __readFileArrayBuffer(__KASPA_SDK_WASM_PATH__);

const startedAt = __hrtimeMs();

runKaspaSdkTest(bytes, () => __hrtimeMs())
  .then(({ results, bench }) => {
    globalThis.__testResult = JSON.stringify(
      { ...results, bench, totalMs: Math.round(__hrtimeMs() - startedAt) },
      null,
      2
    );
  })
  .catch((e) => {
    globalThis.__testError = String((e && e.stack) || e);
  });
