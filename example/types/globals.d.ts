/**
 * Types for the globals installed at runtime by the polyfills in index.js
 * (react-native-get-random-values, ./src/text-encoding, and
 * react-native-webassembly-runtime/polyfill). The React Native tsconfig
 * includes no DOM lib, so none of these names exist otherwise.
 */

declare global {
  var global: typeof globalThis;

  var WebAssembly: typeof import('react-native-webassembly-runtime').WebAssemblyPolyfill;

  var crypto:
    | { getRandomValues<T extends ArrayBufferView>(array: T): T }
    | undefined;

  class TextEncoder {
    readonly encoding: string;
    encode(input?: string): Uint8Array;
  }

  class TextDecoder {
    readonly encoding: string;
    constructor(
      label?: string,
      options?: { fatal?: boolean; ignoreBOM?: boolean },
    );
    decode(input?: ArrayBuffer | ArrayBufferView): string;
  }
}

export {};
