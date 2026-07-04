/**
 * @format
 */

// Environment polyfills must load before the kaspa glue evaluates.
// (Not fast-text-encoding: its TextDecoder rejects the `fatal` option that
// wasm-bindgen glue passes.)
import 'react-native-get-random-values';
import './src/text-encoding';
import 'react-native-webassembly-runtime/polyfill';

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
