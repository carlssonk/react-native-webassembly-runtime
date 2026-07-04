// RISKS.md #1: memory growth through wasm-bindgen glue.
//
// Huge strings passed to the SDK are copied into wasm memory (via
// __wbindgen_malloc) *before* validation rejects them, forcing memory.grow.
// After growth, the glue's cached Uint8Array view is stale (its
// byteLength===0 detachment check can never fire on JSI buffers), so string
// traffic may silently corrupt. Run twice via globalThis.__PRESIZE_PAGES__:
//   0    -> demonstrate/observe the hazard (informational)
//   1024 -> mitigation: pre-sized memory, growth never happens (gated)
import { installWebAssemblyPolyfill } from '../src/polyfill/core';

import init, { Mnemonic, version } from '../../rusty-kaspa/wasm/web/kaspa-keygen/kaspa.js';

const FIXED_MNEMONIC =
  'hunt bitter praise lift buyer topic crane leopard uniform network inquiry over grain pass match crush marine strike doll relax fortune trumpet sunny silk';
const EXPECTED_SEED =
  'c5d1fcaedbc58d17870e37b48581ef2b01c4c63a7fb82d5400b8b32ec68af006caa021f6b58234934e680ad7a49118f1aa25437d0093458dff5b2fd742d4b6d3';

const presizePages = globalThis.__PRESIZE_PAGES__ || 0;

installWebAssemblyPolyfill({ memoryInitialPages: presizePages });

(async () => {
  const wasm = await init({
    module_or_path: __readFileArrayBuffer(__KASPA_WASM_PATH__),
  });

  const seedOk = () => new Mnemonic(FIXED_MNEMONIC).toSeed('') === EXPECTED_SEED;

  const before = wasm.memory.buffer.byteLength;
  const baseline = seedOk();

  // Force allocations well past the initial memory (keygen starts ~2.1MB).
  for (const mb of (globalThis.__SMALL__ ? [0.001] : [4, 8, 16])) {
    try {
      // Invalid phrase: rejected only after the string lands in wasm memory.
      new Mnemonic('x'.repeat(mb * 1024 * 1024));
    } catch {
      // expected
    }
  }

  const after = wasm.memory.buffer.byteLength;
  const grew = after > before;

  // Fine-grained probes isolating WHERE corruption lives.
  const probe = (fn) => {
    try {
      return { ok: true, value: String(fn()).slice(0, 48) };
    } catch (e) {
      return { ok: false, value: String((e && e.message) || e).slice(0, 80) };
    }
  };

  // Reads wasm data segment + returns a string (no JS-string input).
  const versionProbe = probe(() => version());
  // Internal wordlist generation + string output (no JS-string input).
  const randomProbe = probe(() => Mnemonic.random(24).phrase.split(/\s+/).length);
  // Full JS-string round-trip (write + read).
  let integrity = false;
  let error = null;
  try {
    integrity = seedOk();
  } catch (e) {
    error = String((e && e.stack) || e).slice(0,200);
  }

  globalThis.__testResult = JSON.stringify(
    {
      presizePages,
      baseline,
      beforeBytes: before,
      afterBytes: after,
      grew,
      versionProbe,
      randomProbe,
      integrityAfterGrowth: integrity,
      error,
    },
    null,
    2
  );
})().catch((e) => {
  globalThis.__testError = String((e && e.stack) || e);
});
