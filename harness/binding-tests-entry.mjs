// Binding-semantics tests: JS-facing behaviour the spec suite does not
// cover. Fixtures are hand-assembled MVP wasm (validated against Node in
// harness/node-binding-ref.mjs, which runs the same modules natively where
// the semantics overlap).
import { installWebAssemblyPolyfill, Module } from '../src/polyfill/core';

// force: the host JSC may ship its own WebAssembly (newer JSC exposes one
// even without JIT); these suites must always exercise the wasm3 binding.
installWebAssemblyPolyfill({ force: true });

const results = [];
const check = (label, cond) => results.push({ label, ok: !!cond });
const throws = (fn, ErrorClass) => {
  try {
    fn();
    return false;
  } catch (e) {
    return ErrorClass ? e instanceof ErrorClass || e.name === ErrorClass.name : true;
  }
};

/* (func (export "a") (export "b") (result i32) i32.const 42)
   (global (export "g") (mut i32) i32.const 5)
   (global (export "c") i64 i64.const 7) */
const ALIAS_GLOBALS = new Uint8Array([
  0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00,
  0x01,0x05,0x01,0x60,0x00,0x01,0x7f,
  0x03,0x02,0x01,0x00,
  0x06,0x0b,0x02,0x7f,0x01,0x41,0x05,0x0b,0x7e,0x00,0x42,0x07,0x0b,
  0x07,0x11,0x04,0x01,0x61,0x00,0x00,0x01,0x62,0x00,0x00,
                 0x01,0x67,0x03,0x00,0x01,0x63,0x03,0x01,
  0x0a,0x06,0x01,0x04,0x00,0x41,0x2a,0x0b,
]);

/* (memory (export "memory") 1 4) plus store/load helpers */
const MEMORY_1_4 = new Uint8Array([
  0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00,
  0x05,0x04,0x01,0x01,0x01,0x04,
  0x07,0x0a,0x01,0x06,0x6d,0x65,0x6d,0x6f,0x72,0x79,0x02,0x00,
]);

/* (table (export "t") 2 funcref) (elem 0 (i32.const 0) $f)
   (func $f (export "f") (result i32) i32.const 7) */
const TABLE_EXPORT = new Uint8Array([
  0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00,
  0x01,0x05,0x01,0x60,0x00,0x01,0x7f,
  0x03,0x02,0x01,0x00,
  0x04,0x04,0x01,0x70,0x00,0x02,
  0x07,0x09,0x02,0x01,0x74,0x01,0x00,0x01,0x66,0x00,0x00,
  0x09,0x07,0x01,0x00,0x41,0x00,0x0b,0x01,0x00,
  0x0a,0x06,0x01,0x04,0x00,0x41,0x07,0x0b,
]);

/* (func (export "u") unreachable) */
const UNREACHABLE = new Uint8Array([
  0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00,
  0x01,0x04,0x01,0x60,0x00,0x00,
  0x03,0x02,0x01,0x00,
  0x07,0x05,0x01,0x01,0x75,0x00,0x00,
  0x0a,0x05,0x01,0x03,0x00,0x00,0x0b,
]);

(async () => {
  /* Guard against silently testing the host engine instead of the binding. */
  check('polyfill is active', globalThis.WebAssembly.Module === Module);

  /* --- aliased exports + globals --- */
  {
    const { instance } = await WebAssembly.instantiate(ALIAS_GLOBALS);
    const e = instance.exports;

    check('aliased exports both callable', e.a() === 42 && e.b() === 42);
    check('exports enumerable', Object.keys(e).sort().join(',') === 'a,b,c,g');
    check('mutable global reads', e.g.value === 5);
    e.g.value = 9;
    check('mutable global writes', e.g.value === 9);
    check('global valueOf reads current value', e.g.valueOf() === 9);
    check('i64 global is BigInt', e.c.value === 7n);
    check('i64 global valueOf is BigInt', e.c.valueOf() === 7n);
    check('immutable global write throws', throws(() => { e.c.value = 1n; }));
    check('missing export is undefined', e.nope === undefined);
  }

  /* --- memory object semantics --- */
  {
    const { instance } = await WebAssembly.instantiate(MEMORY_1_4);
    const memory = instance.exports.memory;

    const b1 = memory.buffer;
    check('buffer identity stable between reads', memory.buffer === b1);
    check('initial byteLength is 1 page', b1.byteLength === 65536);

    const prev = memory.grow(1);
    check('grow returns previous pages', prev === 1);
    check('buffer identity changes after grow', memory.buffer !== b1);
    check('grown byteLength is 2 pages', memory.buffer.byteLength === 131072);
    check('grow past maximum throws RangeError', throws(() => memory.grow(100), RangeError));
    check('negative grow throws RangeError', throws(() => memory.grow(-1), RangeError));
  }

  /* --- env.memory initial-pages hint --- */
  {
    const { instance } = await WebAssembly.instantiate(MEMORY_1_4, {
      env: { memory: { initial: 3 } },
    });
    check(
      'env.memory hint pre-grows',
      instance.exports.memory.buffer.byteLength === 3 * 65536
    );
  }

  /* --- table exports --- */
  {
    const { instance } = await WebAssembly.instantiate(TABLE_EXPORT);
    const t = instance.exports.t;

    check('table length', t.length === 2);
    check('occupied slot returns callable', t.get(0)() === 7);
    check('empty slot returns null', t.get(1) === null);
    check('out-of-range get throws RangeError', throws(() => t.get(2), RangeError));
    check('table.set throws (unsupported)', throws(() => t.set(0, null)));
    check('table.grow throws (unsupported)', throws(() => t.grow(1)));
  }

  /* --- error classes + validate + Module scanning --- */
  {
    const garbage = new Uint8Array([1, 2, 3, 4]);

    check('validate rejects garbage', WebAssembly.validate(garbage) === false);
    check('validate accepts real module', WebAssembly.validate(ALIAS_GLOBALS));
    check(
      'Module ctor throws CompileError',
      throws(() => new WebAssembly.Module(garbage), WebAssembly.CompileError)
    );

    const { instance } = await WebAssembly.instantiate(UNREACHABLE);
    check(
      'trap throws RuntimeError',
      throws(() => instance.exports.u(), WebAssembly.RuntimeError)
    );

    const mod = new Module(ALIAS_GLOBALS);
    const exps = Module.exports(mod);
    check(
      'Module.exports scans kinds',
      exps.length === 4 &&
        exps.filter((x) => x.kind === 'function').length === 2 &&
        exps.filter((x) => x.kind === 'global').length === 2
    );
    check('Module.imports empty', Module.imports(mod).length === 0);
  }

  /* --- deep recursion traps instead of crashing the process --- */
  {
    /* (func $r (export "r") call $r) — infinite recursion */
    const RUNAWAY = new Uint8Array([
      0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00,
      0x01,0x04,0x01,0x60,0x00,0x00,
      0x03,0x02,0x01,0x00,
      0x07,0x05,0x01,0x01,0x72,0x00,0x00,
      0x0a,0x06,0x01,0x04,0x00,0x10,0x00,0x0b,
    ]);
    const { instance } = await WebAssembly.instantiate(RUNAWAY);
    check(
      'runaway recursion traps as RuntimeError',
      throws(() => instance.exports.r(), WebAssembly.RuntimeError)
    );
  }

  const failed = results.filter((r) => !r.ok);

  if (failed.length)
    globalThis.__testError =
      'binding tests failed:\n' + failed.map((f) => '  ' + f.label).join('\n');
  else
    globalThis.__testResult = JSON.stringify({
      passed: results.length,
      failed: 0,
    });
})().catch((e) => {
  globalThis.__testError = String((e && e.stack) || e);
});
