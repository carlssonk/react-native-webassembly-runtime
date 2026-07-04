/**
 * UTF-8 TextEncoder/TextDecoder for React Native (Hermes has neither).
 * Same shim validated against the kaspa SDK in the library's harness
 * (harness/env.js). Unlike fast-text-encoding, the TextDecoder constructor
 * accepts the `fatal`/`ignoreBOM` options wasm-bindgen glue passes.
 */

class TextEncoderShim {
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
      if (cp < 0x80) {
        out.push(cp);
      } else if (cp < 0x800) {
        out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
      } else if (cp < 0x10000) {
        out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else {
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 63),
          0x80 | ((cp >> 6) & 63),
          0x80 | (cp & 63)
        );
      }
    }
    return new Uint8Array(out);
  }
  encodeInto(source, destination) {
    const bytes = this.encode(source);
    const written = Math.min(bytes.length, destination.length);
    destination.set(bytes.subarray(0, written));
    return {read: source.length, written};
  }
}

class TextDecoderShim {
  constructor(encoding = 'utf-8', _options) {
    const name = String(encoding).toLowerCase();
    if (name !== 'utf-8' && name !== 'utf8') {
      throw new RangeError('Only utf-8 is supported.');
    }
  }
  get encoding() {
    return 'utf-8';
  }
  decode(input) {
    if (input === undefined) {
      return '';
    }
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

if (typeof global.TextEncoder !== 'function') {
  global.TextEncoder = TextEncoderShim;
}
if (typeof global.TextDecoder !== 'function') {
  global.TextDecoder = TextDecoderShim;
}
