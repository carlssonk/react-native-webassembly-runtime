/**
 * On-device tests beyond the keygen smoke test: memory-grow integrity
 * (validates non-moving memory on Hermes), the rpc tier (closures + Table),
 * core binding fixtures (mirroring the harness tests of the same names),
 * and the device-only entropy-path and soak checks (RISKS.md items 0–1).
 */
import initRpc, { Resolver, RpcClient } from './kaspa-rpc/kaspa';
import { kaspaWasmBytes as rpcWasmBytes } from './kaspa-rpc/kaspa-wasm';
import initKeygen, { Mnemonic } from './kaspa/kaspa';

type Check = (label: string, ok: boolean, detail?: string) => void;

const EXPECTED_SEED =
  'c5d1fcaedbc58d17870e37b48581ef2b01c4c63a7fb82d5400b8b32ec68af006caa021f6b58234934e680ad7a49118f1aa25437d0093458dff5b2fd742d4b6d3';
const FIXED_MNEMONIC =
  'hunt bitter praise lift buyer topic crane leopard uniform network inquiry over grain pass match crush marine strike doll relax fortune trumpet sunny silk';

/* (func $r (export "r") call $r) — runaway recursion must trap, not crash */
const RUNAWAY = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00,
  0x00, 0x03, 0x02, 0x01, 0x00, 0x07, 0x05, 0x01, 0x01, 0x72, 0x00, 0x00, 0x0a,
  0x06, 0x01, 0x04, 0x00, 0x10, 0x00, 0x0b,
]);

/** First offset of `needle` in `haystack`, or -1. indexOf does the skipping
 *  natively, so scanning a multi-MB linear memory stays fast on Hermes. */
const findBytes = (haystack: Uint8Array, needle: Uint8Array): number => {
  for (
    let at = haystack.indexOf(needle[0]!);
    at !== -1 && at + needle.length <= haystack.length;
    at = haystack.indexOf(needle[0]!, at + 1)
  ) {
    let match = true;
    for (let j = 1; j < needle.length && match; j += 1) {
      if (haystack[at + j] !== needle[j]) {
        match = false;
      }
    }
    if (match) {
      return at;
    }
  }
  return -1;
};

export async function runExtendedTests(check: Check): Promise<void> {
  /* --- memory-grow integrity (keygen module already initialised) --- */
  for (const mb of [4, 8]) {
    try {
      // Copied into wasm memory (forcing growth) before validation rejects.
      new Mnemonic('x'.repeat(mb * 1024 * 1024));
    } catch {
      // expected: Bip39 error
    }
  }
  check(
    'string integrity after multi-MB memory growth',
    new Mnemonic(FIXED_MNEMONIC).toSeed('') === EXPECTED_SEED,
  );
  check(
    'entropy alive after growth',
    Mnemonic.random(24).phrase !== Mnemonic.random(24).phrase,
  );

  /* --- rpc tier: closures + Table.get on device --- */
  const rpcWasm: any = await initRpc({ module_or_path: rpcWasmBytes().buffer });

  const table = rpcWasm.__wbindgen_export_4;
  check('rpc tier instantiates (3MB, 165 imports)', !!table);
  check('table length > 0', table.length > 0, String(table.length));
  check(
    'table.get returns callable',
    typeof table.get(1) === 'function' || table.get(1) === null,
  );

  let outOfRange = false;
  try {
    table.get(table.length + 1);
  } catch {
    outOfRange = true;
  }
  check('table.get out-of-range throws', outOfRange);

  const client = new RpcClient({
    resolver: new Resolver(),
    networkId: 'mainnet',
  });
  check(
    'RpcClient constructs (closures wired)',
    typeof client.url !== 'object',
  );

  /* --- runaway recursion traps instead of crashing the app --- */
  const { instance } = await WebAssembly.instantiate<{ r: () => void }>(
    RUNAWAY,
  );
  let trapped = false;
  try {
    instance.exports.r();
  } catch (e: any) {
    trapped = e?.name === 'RuntimeError' || /stack overflow/.test(String(e));
  }
  check('runaway recursion traps as RuntimeError', trapped);

  /* --- entropy path: seed pulls must land in live wasm memory (RISKS 0) --- */
  // Measured mechanism (validated under the JSC harness): the SDK seeds an
  // in-wasm CSPRNG with one 32-byte getRandomValues pull per ~64KiB of
  // output. The pull fills a JS temp buffer which the glue then copies into
  // wasm memory — exactly the copy the historical freed-memory bug
  // corrupted. So: capture the seed bytes at getRandomValues, force a pull,
  // then find those bytes in the live linear memory (the CSPRNG retains its
  // key state). A seed copied into a stale buffer never shows up there.
  const keygenWasm = await initKeygen(); // already initialised: returns exports
  const cryptoObj = global.crypto;
  if (!cryptoObj) {
    throw new Error('crypto.getRandomValues polyfill missing');
  }
  const realGetRandomValues = cryptoObj.getRandomValues;

  const seeds: Uint8Array[] = [];
  cryptoObj.getRandomValues = <T extends ArrayBufferView>(view: T): T => {
    realGetRandomValues.call(cryptoObj, view); // fills `view` in place
    seeds.push(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice(),
    );
    return view;
  };

  let pullIters = 0;
  try {
    // Worst case one full reseed interval away: 64KiB / 32B = 2048 pulls.
    while (seeds.length === 0 && pullIters < 4096) {
      Mnemonic.random(24).free();
      pullIters += 1;
    }
  } finally {
    cryptoObj.getRandomValues = realGetRandomValues;
  }

  const seed = seeds[0];
  check(
    'entropy seed pull observed',
    seed !== undefined && seed.length >= 16,
    `${seeds.length} pull(s) after ${pullIters} mnemonics`,
  );

  const seedOffset = seed
    ? findBytes(new Uint8Array(keygenWasm.memory.buffer), seed)
    : -1;
  check(
    'entropy seed lands in live wasm memory',
    seedOffset >= 0,
    seedOffset >= 0 ? `found at offset ${seedOffset}` : 'seed bytes not found',
  );

  // End-to-end key-material distribution (crude by design, RISKS 0): 4KB of
  // CSPRNG output read back as mnemonic entropy. A stuck, biased, or zeroed
  // RNG fails loudly here while every functional keygen check still passes.
  const material: number[] = [];
  for (let i = 0; i < 128; i += 1) {
    const m = Mnemonic.random(24);
    const hex = m.entropy;
    m.free();
    for (let j = 0; j < hex.length; j += 2) {
      material.push(parseInt(hex.slice(j, j + 2), 16));
    }
  }
  const seen = new Set(material);
  let longestRun = 1;
  let run = 1;
  for (let i = 1; i < material.length; i += 1) {
    run = material[i] === material[i - 1] ? run + 1 : 1;
    longestRun = Math.max(longestRun, run);
  }
  const mean = material.reduce((a, b) => a + b, 0) / material.length;
  check(
    'key material well-distributed (4KB)',
    material.length >= 4096 &&
      seen.size >= 250 &&
      longestRun < 32 &&
      mean > 112 &&
      mean < 144,
    `distinct=${seen.size}/256 maxRun=${longestRun} mean=${mean.toFixed(1)}`,
  );

  /* --- soak: freed create/use cycles must not grow memory (RISKS 1) --- */
  // Without FinalizationRegistry (RN Hermes), unfreed SDK objects leak
  // wasm-side memory and eventually force growth. Freed cycles must hold
  // the linear memory flat; the unfreed arm is informational (that leak is
  // expected and documented — .free() is mandatory in app code).
  for (let i = 0; i < 50; i += 1) {
    Mnemonic.random(24).free(); // warm the allocator before snapshotting
  }
  const freedBefore = keygenWasm.memory.buffer.byteLength;
  for (let i = 0; i < 300; i += 1) {
    const m = Mnemonic.random(24);
    void m.phrase;
    m.free();
  }
  const freedAfter = keygenWasm.memory.buffer.byteLength;
  check(
    'memory flat across 300 freed create/use cycles',
    freedAfter - freedBefore <= 2 * 65536,
    `${freedBefore} -> ${freedAfter} bytes`,
  );

  const unfreedBefore = keygenWasm.memory.buffer.byteLength;
  const leaked: Mnemonic[] = [];
  for (let i = 0; i < 100; i += 1) {
    leaked.push(Mnemonic.random(24));
  }
  const unfreedGrowth = keygenWasm.memory.buffer.byteLength - unfreedBefore;
  leaked.forEach(m => m.free());
  check(
    'unfreed objects leak wasm memory (informational)',
    true,
    `${unfreedGrowth} bytes grown over 100 unfreed objects`,
  );
}
