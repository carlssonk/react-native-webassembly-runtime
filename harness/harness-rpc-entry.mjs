// Supplementary harness test against the kaspa-rpc tier (3.1MB, 165 imports,
// exports a function table): validates instantiation of a closure-using
// module and the read-only Table.get path that wasm-bindgen's closure
// destructors rely on.
import { installWebAssemblyPolyfill } from '../src/polyfill/core';

import init, {
  Resolver,
  RpcClient,
  version,
} from '../../rusty-kaspa/wasm/web/kaspa-rpc/kaspa.js';

installWebAssemblyPolyfill();

const bytes = __readFileArrayBuffer(__KASPA_RPC_WASM_PATH__);

const startedAt = __hrtimeMs();

(async () => {
  const wasm = await init({ module_or_path: bytes });

  const table = wasm.__wbindgen_export_4;

  const tableLength = table.length;

  // Slot 0 of a wasm funcref table is conventionally null/reserved; scan for
  // the first occupied slot and call nothing — just verify callability shape.
  let firstCallable = -1;
  for (let i = 0; i < Math.min(tableLength, 32); i += 1) {
    const entry = table.get(i);
    if (typeof entry === 'function') {
      firstCallable = i;
      break;
    }
  }

  let outOfRangeThrows = false;
  try {
    table.get(tableLength + 1);
  } catch {
    outOfRangeThrows = true;
  }

  // Constructing an RpcClient wires wasm-bindgen closures (event handlers,
  // resolver callbacks) without touching the network.
  const client = new RpcClient({
    resolver: new Resolver(),
    networkId: 'mainnet',
  });

  const clientConstructed = typeof client.url !== 'object';

  globalThis.__testResult = JSON.stringify(
    {
      sdkVersion: version(),
      tableLength,
      firstCallable,
      outOfRangeThrows,
      clientConstructed,
      elapsedMs: Math.round(__hrtimeMs() - startedAt),
    },
    null,
    2
  );
})().catch((e) => {
  globalThis.__testError = String((e && e.stack) || e);
});
