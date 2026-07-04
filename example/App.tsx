/**
 * kaspa-keygen smoke test: runs the same deterministic flow as
 * harness/kaspa-keygen-test.mjs on-device, so every expectation below is
 * cross-checked against native WebAssembly (Node) and the local harness.
 */
import React from 'react';
import {ScrollView, StatusBar, StyleSheet, Text, View} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';

import init, {Mnemonic, PrivateKey, XPrv, version} from './src/kaspa/kaspa';
import {kaspaWasmBytes} from './src/kaspa/kaspa-wasm';

const FIXED_MNEMONIC =
  'hunt bitter praise lift buyer topic crane leopard uniform network inquiry over grain pass match crush marine strike doll relax fortune trumpet sunny silk';

const FIXED_PRIVATE_KEY_HEX =
  'b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef';

// Reference values produced by Node's native WebAssembly (harness/node-ref.mjs).
const EXPECTED_SEED =
  'c5d1fcaedbc58d17870e37b48581ef2b01c4c63a7fb82d5400b8b32ec68af006caa021f6b58234934e680ad7a49118f1aa25437d0093458dff5b2fd742d4b6d3';
const EXPECTED_XPRV =
  'kprv68wbWBNyHBZP6JiPCgkkRh9V5d35T7z436vkvW6sCrQGJn1XL1fmAkzW8pGqDP9TwuVxdbAH2UVd6HwscVkESKZgCnqCM3qmQpQxytw1tqG';
const EXPECTED_ADDRESS =
  'kaspa:qr0lr4ml9fn3chekrqmjdkergxl93l4wrk3dankcgvjq776s9wn9jkdskewva';

type CheckResult = {label: string; ok: boolean; detail?: string};

async function runSmokeTest(): Promise<{
  checks: CheckResult[];
  elapsedMs: number;
}> {
  const checks: CheckResult[] = [];
  const check = (label: string, ok: boolean, detail?: string) =>
    checks.push({label, ok, detail});

  const startedAt = Date.now();

  // Informational: wasm-bindgen's --weak-refs glue stubs FinalizationRegistry
  // when absent (as on RN 0.86 Hermes). Everything works, but Rust-side
  // objects are not auto-freed on GC — call .free() on SDK objects manually.
  check(
    'FinalizationRegistry (informational; glue stubs it when absent)',
    true,
    typeof FinalizationRegistry === 'function' ? 'native' : 'stubbed by glue'
  );
  check('TextEncoder polyfilled', typeof TextEncoder === 'function');
  check(
    'crypto.getRandomValues polyfilled',
    typeof global.crypto?.getRandomValues === 'function'
  );
  check(
    'WebAssembly polyfill installed',
    typeof WebAssembly === 'object' &&
      typeof WebAssembly.instantiate === 'function'
  );

  const bytes = kaspaWasmBytes();
  check('wasm bytes embedded', bytes.length > 1_000_000);

  await init({module_or_path: bytes.buffer});

  check('sdk version', version().length > 0, version());

  const seed = new Mnemonic(FIXED_MNEMONIC).toSeed('');
  check('seed matches native reference', seed === EXPECTED_SEED);

  const derived = new XPrv(seed)
    .derivePath("m/44'/111111'/0'/0/0")
    .intoString('kprv');
  check('derived xprv matches native reference', derived === EXPECTED_XPRV);

  const address = new PrivateKey(FIXED_PRIVATE_KEY_HEX)
    .toAddress('mainnet')
    .toString();
  check(
    'address matches native reference',
    address === EXPECTED_ADDRESS,
    address
  );

  const phrase = Mnemonic.random(24).phrase;
  check(
    'random mnemonic has 24 words',
    phrase.trim().split(/\s+/).length === 24
  );
  check('entropy is live', Mnemonic.random(24).phrase !== phrase);

  check(
    'validate rejects garbage',
    WebAssembly.validate(new Uint8Array([1, 2, 3, 4])) === false
  );

  await (await import('./src/extended-tests')).runExtendedTests(check);

  return {checks, elapsedMs: Date.now() - startedAt};
}

export default function App() {
  const [state, setState] = React.useState<
    | {status: 'running'}
    | {status: 'done'; checks: CheckResult[]; elapsedMs: number}
    | {status: 'error'; message: string}
  >({status: 'running'});

  React.useEffect(() => {
    runSmokeTest()
      .then(({checks, elapsedMs}) => {
        const failed = checks.filter(c => !c.ok);
        console.log(
          `[kaspa-smoke] ${checks.length - failed.length}/${checks.length} passed in ${elapsedMs}ms`
        );
        failed.forEach(f => console.error('[kaspa-smoke] FAILED:', f.label));
        setState({status: 'done', checks, elapsedMs});
      })
      .catch(e => {
        console.error('[kaspa-smoke] ERROR:', e);
        setState({status: 'error', message: String(e?.stack || e)});
      });
  }, []);

  const allPassed = state.status === 'done' && state.checks.every(c => c.ok);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="dark-content" />
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>kaspa-keygen smoke test</Text>

          {state.status === 'running' && (
            <Text style={styles.running}>Running…</Text>
          )}

          {state.status === 'error' && (
            <Text style={styles.fail}>{state.message}</Text>
          )}

          {state.status === 'done' && (
            <>
              <Text style={allPassed ? styles.pass : styles.fail}>
                {allPassed ? 'ALL CHECKS PASSED' : 'FAILURES DETECTED'} (
                {state.elapsedMs}ms)
              </Text>
              {state.checks.map(c => (
                <View key={c.label} style={styles.row}>
                  <Text style={c.ok ? styles.pass : styles.fail}>
                    {c.ok ? '✓' : '✗'} {c.label}
                  </Text>
                  {c.detail ? (
                    <Text style={styles.detail}>{c.detail}</Text>
                  ) : null}
                </View>
              ))}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#fff'},
  content: {padding: 16},
  title: {fontSize: 20, fontWeight: '600', marginBottom: 12},
  running: {fontSize: 16, color: '#666'},
  row: {marginTop: 8},
  pass: {color: '#0a7d33', fontSize: 15},
  fail: {color: '#c0392b', fontSize: 15},
  detail: {color: '#666', fontSize: 12, marginLeft: 18},
});
