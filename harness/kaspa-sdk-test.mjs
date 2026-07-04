// Shared full-SDK (wasm32-sdk tier, ~11.7MB) exercise + wallet benchmarks.
// Runs unmodified in Node (native WebAssembly reference) and the JSI harness
// (wasm3 + polyfill). Everything but signatures is deterministic; schnorr
// signatures use aux randomness, so they are verified rather than compared.
import init, {
  Mnemonic,
  PrivateKey,
  PublicKeyGenerator,
  XPrv,
  createTransaction,
  payToAddressScript,
  signMessage,
  signTransaction,
  verifyMessage,
  version,
} from '../../rusty-kaspa/wasm/web/kaspa/kaspa.js';

const FIXED_MNEMONIC =
  'hunt bitter praise lift buyer topic crane leopard uniform network inquiry over grain pass match crush marine strike doll relax fortune trumpet sunny silk';

const FIXED_PRIVATE_KEY_HEX =
  'b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef';

const timeIt = (now, fn) => {
  const t0 = now();
  const out = fn();
  return { ms: now() - t0, out };
};

export async function runKaspaSdkTest(wasmBytes, now) {
  await init({ module_or_path: wasmBytes });

  const results = { sdkVersion: version() };
  const bench = {};

  /* --- deterministic derivation chain (compared byte-for-byte) --- */

  const seedTimed = timeIt(now, () => new Mnemonic(FIXED_MNEMONIC).toSeed(''));
  bench.mnemonicToSeedMs = seedTimed.ms;
  results.seed = seedTimed.out;

  const xprv = new XPrv(results.seed);

  const generator = PublicKeyGenerator.fromMasterXPrv(xprv, false, 0n);

  // Wallet-restore hot loop: scan a batch of receive addresses.
  const RESTORE_ADDRESSES = 1000;
  const restoreTimed = timeIt(now, () =>
    generator.receiveAddressAsStrings('mainnet', 0, RESTORE_ADDRESSES)
  );
  bench.restore1000AddressesMs = restoreTimed.ms;
  results.firstAddress = restoreTimed.out[0];
  results.lastAddress = restoreTimed.out[RESTORE_ADDRESSES - 1];
  results.addressCount = restoreTimed.out.length;

  /* --- offline transaction build + sign (signature verified, not compared) --- */

  const key = new PrivateKey(FIXED_PRIVATE_KEY_HEX);
  const address = key.toAddress('mainnet');

  const utxos = [
    {
      address,
      outpoint: {
        transactionId:
          '1915dc0dcdb6dcc812d51bfc9e2b17b95f3b1027a03f47f8bcea6d4aec4a9ad2',
        index: 0,
      },
      amount: 500_000_000n,
      scriptPublicKey: payToAddressScript(address),
      blockDaaScore: 50_000_000n,
      isCoinbase: false,
    },
  ];

  const outputs = [{ address, amount: 100_000_000n }];

  const tx = createTransaction(utxos, outputs, 10_000n);
  results.unsignedTxId = tx.id;
  results.txInputs = tx.inputs.length;
  results.txOutputs = tx.outputs.length;

  const signTimed = timeIt(now, () => signTransaction(tx, [key], true));
  bench.signTransactionMs = signTimed.ms;
  results.signedTxAccepted = signTimed.out.inputs[0].signatureScript.length > 0;

  /* --- message signing round-trip --- */

  const MESSAGE = 'kaspa-wasm3-harness';
  const msgTimed = timeIt(now, () =>
    signMessage({ message: MESSAGE, privateKey: key })
  );
  bench.signMessageMs = msgTimed.ms;

  results.messageVerifies = verifyMessage({
    message: MESSAGE,
    signature: msgTimed.out,
    publicKey: key.toPublicKey(),
  });

  results.badMessageRejected = !verifyMessage({
    message: MESSAGE + 'tampered',
    signature: msgTimed.out,
    publicKey: key.toPublicKey(),
  });

  return { results, bench };
}
