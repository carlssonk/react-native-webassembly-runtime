# react-native-webassembly-runtime

The standard [WebAssembly JS API](https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface) for React Native, backed by the [wasm3](https://github.com/wasm3/wasm3) interpreter over JSI.

Write against the same `WebAssembly` API you use on the web — `Module`, `Instance`, `instantiate`, `compile`, `validate` — and run it on iOS and Android without a JS bridge round-trip. Requires React Native 0.76 or newer with the New Architecture (the binding installs through a TurboModule).

> [!WARNING]
> This library is in **active development** and has not yet stabilised. Expect breaking changes between minor versions until 1.0, and read [`RISKS.md`](./RISKS.md) for what is and is not yet covered by tests before relying on it in production.

## Installation

```sh
npm install react-native-webassembly-runtime
cd ios && pod install
```

Expo: works in dev clients / prebuild out of the box (the module autolinks; no config plugin needed). Not supported in Expo Go.

On Android, only 64-bit ABIs ship (`arm64-v8a` and `x86_64`) — this is deliberate; 32-bit devices are not supported and fail at native-library load (`UnsatisfiedLinkError`) rather than degrading gracefully.

## Usage

### Quick start

```ts
import { instantiate } from 'react-native-webassembly-runtime';

const response = await fetch('https://example.com/add.wasm');
const bytes = await response.arrayBuffer();

const { instance } = await instantiate<{
  add(a: number, b: number): number;
}>(bytes);

instance.exports.add(1, 2); // 3
```

The type parameter types `instance.exports`; without it, exports are `Record<string, unknown>`. Nothing global is touched here — `Module`, `Instance`, `compile`, and `validate` are importable the same way (ponyfill usage).

A complete real-world integration lives in [`example/App.tsx`](./example/App.tsx): it instantiates a full wasm-bindgen SDK on-device and cross-checks every result against Node's native WebAssembly.

### As a global polyfill

Import once, early in your app entry (before anything that touches `WebAssembly`):

```ts
import 'react-native-webassembly-runtime/polyfill';
```

This installs a spec-shaped `WebAssembly` namespace on `globalThis` (unless one already exists), so libraries that expect the global — e.g. wasm-bindgen glue — work unmodified.

To configure the polyfill, call the installer instead:

```ts
import { installWebAssemblyPolyfill } from 'react-native-webassembly-runtime/polyfill';

installWebAssemblyPolyfill({
  // Pre-size every instance's linear memory (64KiB pages) so it never
  // grows at runtime.
  memoryInitialPages: 1024,
  // wasm3 interpreter stack per instance. Defaults to 512KiB.
  stackSizeInBytes: 512 * 1024,
});
```

### Loading `.wasm` assets bundled by Metro

```ts
import { fetchAssetArrayBuffer, instantiate } from 'react-native-webassembly-runtime';

const bytes = await fetchAssetArrayBuffer(require('./module.wasm'));
const { instance } = await instantiate(bytes);
```

(Add `wasm` to `resolver.assetExts` in your `metro.config.js`.)

### Imports

Functions in the `importObject` are callable from inside the module. Wasm `i64` values cross the boundary as `BigInt`, everything else as `number`:

```ts
const { instance } = await instantiate(bytes, {
  env: {
    now_ms: () => Date.now(),
    log_event: (code: number, timestamp: bigint) => {
      console.log(code, timestamp);
    },
  },
});
```

Two behaviours to know about:

- A declared import you don't provide does not fail instantiation (the web throws `LinkError` there); the module traps with a "missing import" error if it actually calls it.
- An `env.memory` import can't bind a JS-constructed `Memory` (see the coverage table below) — its `initial` field is used as a pre-size hint for the instance's own memory instead.

### Working with exported memory

Each instance has a single linear memory (a wasm3 limit). When the module exports it, read and write it through an `ArrayBuffer` view over the live native memory:

```ts
const { instance } = await instantiate<{
  memory: { buffer: ArrayBuffer; grow(delta: number): number };
  greet(): number; // returns a pointer into linear memory
}>(bytes);

const ptr = instance.exports.greet();
const view = new Uint8Array(instance.exports.memory.buffer, ptr, 5);
```

As on the web, growing the memory (from JS via `grow()` or from inside the module) invalidates previously obtained buffers — re-read `memory.buffer` after any growth. Code that caches typed-array views and can't observe a grow (some wasm-bindgen glue) should pre-size the memory with the `memoryInitialPages` polyfill option instead.

## API coverage (wasm3 backend)

| API | Status | Notes |
| --- | :---: | --- |
| `WebAssembly.instantiate()` | ✅ | Both overloads (`BufferSource` and `Module`). |
| `WebAssembly.compile()` | ✅ | |
| `WebAssembly.validate()` | ✅ | |
| `WebAssembly.Module` | ✅ | |
| `Module.exports` / `Module.imports` / `Module.customSections` | ✅ | Scanned directly from the module bytes. |
| `WebAssembly.Instance` | ✅ | |
| `CompileError` / `LinkError` / `RuntimeError` | ✅ | Native errors are rethrown as their spec-shaped classes. |
| Function imports (JS functions in `importObject`) | ✅ | |
| Exported `Memory` | ✅ | `buffer` and `grow()`. |
| Exported `Global` | ✅ | `value` getter/setter (mutability enforced) and `valueOf()`; `i64` globals surface as `BigInt`. |
| Exported `Table` | ⚠️ | `length` and `get()` only — enough for wasm-bindgen's closure machinery. `set()` / `grow()` throw (wasm3 has no table-mutation API). |
| Importing a JS-constructed `Memory` | ❌ | `env.memory`'s `initial` is honoured as a best-effort grow hint for the instance's own memory; `buffer` on a JS-constructed `Memory` throws. |
| Importing a JS-constructed `Global` / `Table` | ❌ | Constructors throw `LinkError`. |
| `Memory({ shared: true })` | ❌ | No threads in the wasm3 backend. |
| `instantiateStreaming` / `compileStreaming` | ❌ | Intentionally absent, so callers (e.g. wasm-bindgen glue) take their `ArrayBuffer` fallback path. |
| `WebAssembly.Tag` / `WebAssembly.Exception` | ❌ | wasm3 does not support the exception-handling proposal. |

Non-standard extras: `fetchAssetArrayBuffer(require('./module.wasm'))` and `installWebAssemblyPolyfill(options)`.

`compile()` and `instantiate()` are spec-shaped async functions, but the work happens synchronously on the JS thread (wasm3 parses eagerly and compiles function bodies lazily on first call) — very large modules can block briefly at instantiation.

One deviation from the JS-API spec's type coercions: `i64` parameters accept plain JS numbers as well as `BigInt` (the spec mandates BigInt-only with a `TypeError` otherwise), and a `BigInt` passed where `f64`/`f32` is expected is truncated rather than rejected. Pass `BigInt` for `i64` and numbers for floats and the behaviour matches the web exactly.

### Building compatible modules

wasm3 executes the WebAssembly MVP plus a few extensions: sign-extension operators, `memory.copy` / `memory.fill`, and tail calls. Modules using SIMD, threads/atomics, exception handling, reference types, or multi-value returns fail with a `CompileError`, so build with those features off:

- **Emscripten** — the defaults are fine; avoid `-msimd128`, `-pthread`, and `-fwasm-exceptions`.
- **Rust** — recent toolchains enable post-MVP features by default on `wasm32-unknown-unknown`; build with `RUSTFLAGS="-C target-cpu=mvp"` if a module fails to compile.

## Contributing

- `pnpm bootstrap` — install dependencies for the library and the example app
- `pnpm typecheck` / `pnpm lint` — validate the TypeScript and lint rules
- `pnpm example start` — run the example app
- `./harness/run-ci.sh` — build the native harness and run the WebAssembly spec suite against the wasm3 backend

[`RISKS.md`](./RISKS.md) keeps an honest inventory of what is and is not yet evidenced by tests, ordered by risk.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) (enforced by commitlint; releases are automated with release-please).

## License

ISC

The vendored [wasm3](https://github.com/wasm3/wasm3) sources in `cpp/` are MIT-licensed — see [`cpp/LICENSE-wasm3`](./cpp/LICENSE-wasm3).
