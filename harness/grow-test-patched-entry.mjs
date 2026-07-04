// Same grow test, but against the glue with the buffer-identity view-cache
// transform applied at SOURCE level (see scripts note in RISKS.md #1).
import { installWebAssemblyPolyfill } from '../src/polyfill/core';
import init, { Mnemonic, version } from './build/kaspa-glue-patched.js';

installWebAssemblyPolyfill();

const FIXED =
  'hunt bitter praise lift buyer topic crane leopard uniform network inquiry over grain pass match crush marine strike doll relax fortune trumpet sunny silk';
const SEED =
  'c5d1fcaedbc58d17870e37b48581ef2b01c4c63a7fb82d5400b8b32ec68af006caa021f6b58234934e680ad7a49118f1aa25437d0093458dff5b2fd742d4b6d3';

(async () => {
  const wasm = await init({ module_or_path: __readFileArrayBuffer(__KASPA_WASM_PATH__) });
  const ok = () => new Mnemonic(FIXED).toSeed('') === SEED;
  const before = wasm.memory.buffer.byteLength;
  const baseline = ok();
  const steps = [];
  for (const mb of [4, 8, 16]) {
    try { new Mnemonic('x'.repeat(mb * 1024 * 1024)); } catch {}
    let v; try { v = version(); } catch (e) { v = 'ERR:' + String(e.message).slice(0, 40); }
    steps.push(mb + 'MB->' + v + '@' + wasm.memory.buffer.byteLength);
  }
  const grew = wasm.memory.buffer.byteLength > before;
  const probe = (fn) => { try { return String(fn()).slice(0, 40); } catch (e) { return 'ERR:' + String((e && e.message) || e).slice(0, 60); } };
  const versionProbe = probe(() => version());
  const randomProbe = probe(() => Mnemonic.random(24).phrase.split(/\s+/).length);
  let integrity = false, error = null;
  try { integrity = ok(); } catch (e) { error = String((e && e.stack) || e).slice(0, 160); }
  globalThis.__testResult = JSON.stringify({ baseline, steps, grew, versionProbe, randomProbe, integrity, error });
})().catch((e) => { globalThis.__testError = String((e && e.stack) || e); });
