# Known risks and testing gaps

Honest inventory of what is and is not yet evidenced, ordered by risk.
The deterministic compute path is strongly verified (WebAssembly spec suite
100% gated on the harness; kaspa flows byte-identical across Node native
wasm, the JSC harness, and an RN 0.86 device build). The residual risk is
*temporal*: growth, leaks, reloads, long sessions.

## 0. Entropy path — highest stakes (PARTIALLY ADDRESSED)

The strongest validation in this repo covers the *deterministic* path
(fixed mnemonic -> seed -> address, byte-identical across Node, the JSC
harness and device). A wallet's security, however, rests on the
*nondeterministic* path: OS entropy -> `react-native-get-random-values` ->
glue import -> JS view -> wasm memory -> key generation. Coverage of that
path is cosmetic ("24 words", "two mnemonics differ") — a heavily biased
RNG would pass every existing check.

This is not theoretical: the grow-corruption bug's mechanism WAS
`getRandomValues` writing entropy into freed memory. Nothing crashed;
mnemonics still looked valid. Memory-safety bugs in this stack
preferentially convert into entropy bugs, because the RNG path is the one
place where wrong bytes are indistinguishable from right bytes in any
functional test. Deterministic corruption fails loudly; entropy corruption
fails silently by construction.

**Actions:**

1. (OPEN) Mix entropy at the source in app code: generate key-material
   entropy JS-side (one hop from the OS) and pass it INTO the SDK where the
   API allows, rather than letting Rust pull it through four layers.
2. (DONE) Device checks in `example/src/extended-tests.ts`, built on the
   measured mechanism (validated under the JSC harness): the SDK seeds an
   in-wasm CSPRNG with ONE 32-byte getRandomValues pull per ~64KiB of
   output, and the pull fills a JS temp buffer that the glue then copies
   into wasm memory — that copy is what the freed-memory bug corrupted.
   The tests capture a seed at getRandomValues, force a pull, and assert
   the exact seed bytes appear in the live linear memory (the CSPRNG
   retains its key state; a seed copied into a stale buffer is absent);
   plus a distribution smoke check (spread / zero runs / mean) over 4KB of
   key material read back via `Mnemonic.entropy`. Either arm turns the
   silent failure mode loud.
3. (POLICY, standing) Any memory-corruption finding in this stack is a
   KEY-SAFETY incident, not a stability bug — the response includes
   auditing what entropy was generated during the affected window.

## 1. Rust-object leaks without FinalizationRegistry — UNTESTED at duration

RN 0.86 Hermes does not expose `FinalizationRegistry`; wasm-bindgen's
`--weak-refs` glue stubs it, so every SDK object (Mnemonic, XPrv,
PrivateKey, …) leaks wasm-side memory unless `.free()` is called. Leaks
also *force* memory growth, compounding risk 1. The on-device validation
ran 149ms; a wallet session runs hours.

**Guidance:** treat `.free()` as mandatory in app code for long-lived flows.
**Status:** a bounded on-device soak now exists (`example/src/extended-tests.ts`):
300 freed create/use cycles gate on flat `memory.buffer.byteLength`, and an
unfreed arm reports the leak rate (informational — the leak is expected).
Multi-hour sessions remain unexercised; the bounded soak bounds the
mechanism, not the duration.

## 2. Dev-reload (Metro) semantics — UNTESTED

A reload tears down the Hermes runtime while `InstanceState` (holding
`jsi::Function` references and a captured `Runtime*`) may still be alive.
Teardown ordering has been reasoned about, not exercised. The runtime/thread
guard converts *use* after reload into a thrown error, but destruction-order
crashes during teardown itself are unprobed.

One concrete reload bug was found in review and fixed: Android's `install()`
used a `static` installed flag that survived runtime re-creation, so after a
reload the fresh runtime never got the JSI globals (loud JS failure, not a
crash). It is now per-module-instance.

**Next test:** dev build; instantiate, hammer reload repeatedly, watch for
native crashes.

## 3. Spec suite has run on JSC, not Hermes — COVERAGE GAP

All 14,977 gated spec assertions ran on JavaScriptCore (macOS harness). The
device ran only the keygen smoke test. The binding is engine-agnostic JSI,
but Hermes differs in fussy places (BigInt edges, NaN handling).

**Next test:** the spec-runner bundle already exists; give it a screen in
the example app and run it on-device once.

## 4. Android — MIGRATED, NOT YET EXERCISED ON A DEVICE

The Java side now mirrors the validated iOS implementation: codegen spec +
`BaseReactPackage`, AGP 8.6 / prefab / CMake against modern RN, shipped
codegen glue (`includesGeneratedCode`), JSI bindings installed via a sync
`install()` on the JS thread. What remains is evidence, not migration: no
emulator or device run has executed the smoke/extended tests on Android.
64-bit-only ABIs are deliberate (the non-moving-memory reservation is
64-bit); on a 32-bit device the failure mode is an `UnsatisfiedLinkError`
at library load, not graceful degradation.

## 5. Standing trust assumptions

- wasm3 upstream is unmaintained; this repo owns the interpreter
  (`cpp/PATCHES.md`). Its lenient static validation means malformed-but-
  parseable modules execute — acceptable only because the artifact is
  first-party and audited, not arbitrary third-party wasm.
- `import.meta` stripping in `example/scripts/sync-kaspa.js` is a regex over
  generated glue; a wasm-bindgen upgrade could change the pattern (hermesc
  fails loudly if it does).
- MVP compatibility hangs on `RUSTFLAGS=-Ctarget-cpu=mvp` in rusty-kaspa's
  `build-web`, which upstream documents as a *temporary compiler-bug
  workaround* — they do not know this project depends on it. Tell them, or
  pin/vendor the artifact version, and keep a CI check that fails loudly if
  an artifact stops parsing under wasm3.
- Every performance number here is Apple M-series silicon. Low-end Android
  under interpretation could be another order of magnitude slower (the
  1.2s / 1000-address restore could become 30s+) — measure on a cheap
  Android device before committing to restore/scan UX designs.
- Embedding wasm as base64 roughly doubles peak memory during module load
  (fine at 1.5MB keygen; revisit for the 11.7MB full SDK).
- Import closures that reference the instance's own exports — the standard
  wasm-bindgen glue shape — form a JS↔native reference cycle the GC cannot
  trace (imports pinned natively via `shared_ptr<jsi::Function>`, exports
  pinning the instance). Such an instance, its wasm3 runtime, and its
  linear memory are reclaimed only at full JS-runtime teardown, never by
  GC. Fine for app-lifetime singletons; matters for re-instantiate loops.
- Non-moving linear memory falls back to relocating `realloc` if the
  `mmap` reservation fails; in that mode a grow silently invalidates held
  JS views again (the exact bug class the patch exists to kill). Believed
  unreachable on shipped 64-bit targets; consider making grow fail loudly
  (RangeError) in fallback mode instead of relocating.