// Environment shims for the JSI harness: the minimal web-ish surface the
// wasm-bindgen glue expects. These mirror what a React Native app must
// provide (TextEncoder/TextDecoder, crypto.getRandomValues) — RN already has
// timers and queueMicrotask; bare JSC does not, so they are shimmed here too.
'use strict';

(function () {
  const g = globalThis;

  g.console = g.console || {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'])
    g.console[level] = (...args) => __print('[' + level + ']', ...args);

  /* --- TextEncoder / TextDecoder (UTF-8 only) --- */

  class TextEncoder {
    get encoding() {
      return 'utf-8';
    }
    encode(input = '') {
      const s = String(input);
      const out = [];
      for (let i = 0; i < s.length; i += 1) {
        let cp = s.charCodeAt(i);
        if (cp >= 0xd800 && cp < 0xdc00 && i + 1 < s.length) {
          const lo = s.charCodeAt(i + 1);
          if (lo >= 0xdc00 && lo < 0xe000) {
            cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
            i += 1;
          }
        }
        if (cp < 0x80) out.push(cp);
        else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
        else if (cp < 0x10000)
          out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        else
          out.push(
            0xf0 | (cp >> 18),
            0x80 | ((cp >> 12) & 63),
            0x80 | ((cp >> 6) & 63),
            0x80 | (cp & 63)
          );
      }
      return new Uint8Array(out);
    }
    encodeInto(source, destination) {
      const bytes = this.encode(source);
      const written = Math.min(bytes.length, destination.length);
      destination.set(bytes.subarray(0, written));
      // `read` is approximate for truncated writes; the wasm-bindgen glue
      // always sizes the destination to fit, so written === bytes.length.
      return { read: source.length, written };
    }
  }

  class TextDecoder {
    constructor(encoding = 'utf-8') {
      const name = String(encoding).toLowerCase();
      if (name !== 'utf-8' && name !== 'utf8')
        throw new RangeError('Harness TextDecoder supports utf-8 only.');
    }
    get encoding() {
      return 'utf-8';
    }
    decode(input) {
      if (input === undefined) return '';
      const bytes =
        input instanceof Uint8Array
          ? input
          : input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      let out = '';
      for (let i = 0; i < bytes.length; ) {
        const a = bytes[i];
        if (a < 0x80) {
          out += String.fromCharCode(a);
          i += 1;
        } else if (a < 0xe0) {
          out += String.fromCharCode(((a & 31) << 6) | (bytes[i + 1] & 63));
          i += 2;
        } else if (a < 0xf0) {
          out += String.fromCharCode(
            ((a & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)
          );
          i += 3;
        } else {
          const cp =
            (((a & 7) << 18) |
              ((bytes[i + 1] & 63) << 12) |
              ((bytes[i + 2] & 63) << 6) |
              (bytes[i + 3] & 63)) -
            0x10000;
          out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
          i += 4;
        }
      }
      return out;
    }
  }

  g.TextEncoder = g.TextEncoder || TextEncoder;
  g.TextDecoder = g.TextDecoder || TextDecoder;

  /* --- crypto.getRandomValues --- */

  g.crypto = g.crypto || {};
  g.crypto.getRandomValues =
    g.crypto.getRandomValues ||
    function getRandomValues(view) {
      if (!ArrayBuffer.isView(view))
        throw new TypeError('getRandomValues expects a typed array.');
      __fillRandom(view.buffer, view.byteOffset, view.byteLength);
      return view;
    };

  /* --- timers / microtasks (JSC drains microtasks at the API boundary) --- */

  g.queueMicrotask = g.queueMicrotask || ((fn) => Promise.resolve().then(fn));
  g.setTimeout =
    g.setTimeout ||
    ((fn, _ms, ...args) => (Promise.resolve().then(() => fn(...args)), 0));
  g.clearTimeout = g.clearTimeout || (() => {});
  g.setInterval = g.setInterval || (() => 0);
  g.clearInterval = g.clearInterval || (() => {});

  g.performance = g.performance || { now: () => __hrtimeMs() };

  /* --- WebSocket (React Native provides a real one; bare JSC does not).
         Construction-only stub: enough for code that wires sockets lazily,
         throws if anything actually tries to connect. --- */

  g.WebSocket =
    g.WebSocket ||
    class WebSocket {
      constructor() {
        throw new Error('Harness WebSocket cannot connect; RN provides a real one.');
      }
    };
})();
