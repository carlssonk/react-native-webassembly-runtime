// Node reference run of the full-SDK test (native WebAssembly + JIT).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { runKaspaSdkTest } from './kaspa-sdk-test.mjs';

const wasmPath = fileURLToPath(
  new URL('../../rusty-kaspa/wasm/web/kaspa/kaspa_bg.wasm', import.meta.url)
);

const bytes = await readFile(wasmPath);

const { results, bench } = await runKaspaSdkTest(bytes, () => performance.now());

console.log(JSON.stringify({ ...results, bench }, null, 2));
