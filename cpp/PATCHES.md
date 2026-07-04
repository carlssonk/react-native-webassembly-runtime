# Local patches to the vendored wasm3

The `m3_*.{h,c}` sources in this directory are vendored from
[wasm3](https://github.com/wasm3/wasm3) v0.5.0, plus cherry-picked upstream
fixes and local patches. Upstream is in slow-maintenance mode; this fork
owns the copy. Local modifications carry `RN-WEBASSEMBLY PATCH` comments.

wasm3 is MIT-licensed; see [LICENSE-wasm3](./LICENSE-wasm3) for the upstream
copyright and permission notice.

## Provenance: cherry-picked upstream fixes (audited 2026-07-02)

Applied from upstream (all memory-safety/correctness; validated by the full
suite — spec 14,977/14,977, kaspa tiers, grow test):

- #506 overflow fix (m3_compile.c)
- #507 null-pointer dereference on "main" (m3_compile.c)
- #508 heap buffer overflow in DeallocateSlot (m3_compile.c)
- #467 uninitialized result in the parser (m3_parse.c)
- #469 missing stddef.h include (wasm3.h)
- #559 v128 accepted as opaque slot, so modules with v128 locals parse

Deliberately skipped: #528/#568 and #553/#564 (added then reverted
upstream), AVR/ESP32/CI-only changes, and #539 (big-endian-only argument
marshalling fix; all RN targets are little-endian). Re-run this audit
periodically: diff cpp/ against upstream `source/` and review new commits.

## Native-stack recursion guard (`m3_config.h`, `m3_env.h`, `m3_exec.h`)

wasm3 recurses the native C stack once per wasm function call with no bound;
deeply recursive wasm (including the spec suite's `assert_exhaustion` tests,
or any buggy/malicious module) overflows the host stack and crashes the
process. This matters doubly on React Native, where the JS thread stack is
much smaller than a desktop main thread.

- `m3_config.h`: adds `d_m3MaxCallDepth` (default 1000, overridable at build
  time).
- `m3_env.h`: makes `M3Runtime.callDepth` unconditional (previously only
  compiled under `d_m3EnableStrace >= 2`).
- `m3_exec.h`: `op_Call` and `op_CallIndirect` increment/decrement the depth
  around the recursive `Call`, and trap with `m3Err_trapStackOverflow`
  (surfaced to JS as a `RuntimeError`) when the cap is exceeded.

Sizing note (measured, not estimated): runaway recursion with the cap at
1000 traps cleanly on a thread with a 128 KiB stack — i.e. ≤ ~130 bytes of
native stack per interpreter call frame on arm64. The default cap therefore
has an order of magnitude of headroom on any realistic React Native JS
thread and can be raised via `-Dd_m3MaxCallDepth=<n>` if an SDK legitimately
recurses deeper.

## Non-moving linear memory (`m3_config.h`, `m3_env.h`, `m3_env.c`)

Upstream grows linear memory with `realloc`, which relocates the block at
multi-megabyte sizes. Any JS view over the memory (wasm-bindgen caches,
Rust-side held views like getrandom's entropy buffer, app-held buffers)
then dangles — and JSI ArrayBuffers cannot detach, so this corrupts
silently. `d_m3EnableNonMovingMemory` (default on, POSIX) reserves address
space for `maxPages` at first allocation (`mmap PROT_NONE`; a 4GiB
reservation costs no RAM on 64-bit iOS/Android) and commits pages in place
with `mprotect` on grow. The block never moves; teardown `munmap`s the
reservation. Falls back to the realloc path if reservation fails.

## op_CallRawFunction memory refresh (`m3_exec.h`)

Upstream refreshes the interpreter's memory pointer after a raw (imported)
function call only on the trap path. JS imports in this binding may reenter
wasm exports and grow memory, so the pointer is now refreshed
unconditionally.
