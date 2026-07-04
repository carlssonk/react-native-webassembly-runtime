/**
 * React Native entry point for the WebAssembly polyfill.
 *
 * Importing this module is the opt-in: it installs the native JSI binding
 * (via the main package import) and then assigns a spec-shaped `WebAssembly`
 * namespace to `globalThis` — unless one already exists.
 *
 *   import 'react-native-webassembly-runtime/polyfill';
 *
 * To configure (e.g. pre-size memory so it never grows at runtime), import
 * the installer instead:
 *
 *   import { installWebAssemblyPolyfill } from 'react-native-webassembly-runtime/polyfill';
 *   installWebAssemblyPolyfill({ memoryInitialPages: 1024 });
 */
import '../index';

import { installWebAssemblyPolyfill } from './core';

export * from './core';

installWebAssemblyPolyfill();
