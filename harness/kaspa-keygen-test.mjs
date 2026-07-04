// Shared kaspa-keygen exercise: runs unmodified in Node (native WebAssembly,
// the reference) and in the JSI harness (wasm3 + polyfill). The caller
// supplies the wasm bytes; everything derived below is deterministic except
// the entropy check.
import init, {
  Mnemonic,
  PrivateKey,
  XPrv,
  version,
} from '../../rusty-kaspa/wasm/web/kaspa-keygen/kaspa.js';

const FIXED_MNEMONIC =
  'hunt bitter praise lift buyer topic crane leopard uniform network inquiry over grain pass match crush marine strike doll relax fortune trumpet sunny silk';

const FIXED_PRIVATE_KEY_HEX =
  'b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef';

export async function runKaspaKeygenTest(wasmBytes) {
  await init({ module_or_path: wasmBytes });

  const sdkVersion = version();

  // Deterministic path: fixed mnemonic -> seed -> xprv -> derived xprv.
  const mnemonic = new Mnemonic(FIXED_MNEMONIC);
  const seed = mnemonic.toSeed('');

  const xprv = new XPrv(seed);
  const derived = xprv.derivePath("m/44'/111111'/0'/0/0");
  const derivedXprv = derived.intoString('kprv');

  // Deterministic address from a fixed private key.
  const address = new PrivateKey(FIXED_PRIVATE_KEY_HEX)
    .toAddress('mainnet')
    .toString();

  // Entropy path: proves crypto.getRandomValues is wired through wasm.
  const randomPhrase = Mnemonic.random(24).phrase;
  const randomWordCount = randomPhrase.trim().split(/\s+/).length;

  // A second random mnemonic must differ (no stuck RNG).
  const distinctRandom = Mnemonic.random(24).phrase !== randomPhrase;

  // WebAssembly API behaviour (native on Node, polyfill in the harness).
  const validReject = WebAssembly.validate(new Uint8Array([1, 2, 3, 4]));
  let compileErrorName = 'none';
  try {
    new WebAssembly.Module(new Uint8Array([1, 2, 3, 4]));
  } catch (e) {
    compileErrorName = e.name;
  }

  return {
    sdkVersion,
    seed,
    derivedXprv,
    address,
    randomWordCount,
    distinctRandom,
    validReject,
    compileErrorName,
  };
}
