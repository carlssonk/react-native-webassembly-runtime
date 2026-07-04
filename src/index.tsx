/**
 * The package exports the standard WebAssembly JS API (a "ponyfill": no
 * globals are touched). To install it as `globalThis.WebAssembly` for
 * libraries that expect the global, import 'react-native-webassembly-runtime/polyfill'.
 *
 * There is deliberately no wrapper API: write against the standard API and
 * the same code runs on the web — and survives a future backend swap.
 */
import { Image } from 'react-native';

import NativeWebassembly from './NativeWebassembly';

export * from './polyfill/core';

const nativeGlobal = globalThis as { RNWebassembly_instantiate?: unknown };

// Creating the TurboModule installs the JSI bindings (iOS: at module
// creation; Android: on the install() call). New-Architecture RN only.
if (
  typeof nativeGlobal.RNWebassembly_instantiate !== 'function' &&
  !NativeWebassembly.install()
) {
  throw new Error('Unable to bind WebAssembly to React Native JSI.');
}

/**
 * Non-standard helper: resolve a Metro-bundled `.wasm` asset (the number
 * produced by `require('./module.wasm')`) to its bytes.
 */
export async function fetchAssetArrayBuffer(
  moduleId: number
): Promise<ArrayBuffer> {
  const maybeUri = Image.resolveAssetSource(moduleId)?.uri;

  if (typeof maybeUri !== 'string' || !maybeUri.length) {
    throw new Error(
      `Expected non-empty string uri, encountered "${String(maybeUri)}".`
    );
  }

  return new Promise<ArrayBuffer>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', maybeUri, true);
    request.responseType = 'arraybuffer';
    request.onload = () => {
      const response: unknown = request.response;

      if (!(response instanceof ArrayBuffer)) {
        return reject(
          new Error(`Failed to fetch an ArrayBuffer from "${maybeUri}".`)
        );
      }

      resolve(response);
    };
    request.onerror = () => reject(new Error(`Failed to fetch "${maybeUri}".`));
    request.send();
  });
}
