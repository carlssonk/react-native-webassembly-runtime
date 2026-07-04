// Node reference run: executes the shared test against Node's native
// WebAssembly. Its JSON output is the expected result for the harness run.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { runKaspaKeygenTest } from './kaspa-keygen-test.mjs';

const wasmPath = fileURLToPath(
  new URL(
    '../../rusty-kaspa/wasm/web/kaspa-keygen/kaspa_bg.wasm',
    import.meta.url
  )
);

const bytes = await readFile(wasmPath);

console.log(JSON.stringify(await runKaspaKeygenTest(bytes), null, 2));
