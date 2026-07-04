const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const root = path.resolve(__dirname, '..');

const escapeForRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const blockList = new RegExp(
  '(' +
    [
      path.join(root, 'node_modules'),
      path.join(root, 'harness', 'build'),
    ]
      .map(p => `${escapeForRegExp(p)}/.*`)
      .join('|') +
    ')$'
);

/**
 * The library is symlinked from the parent directory. Metro must watch it,
 * resolve `react-native-webassembly-runtime` to it, and never resolve anything from
 * its own node_modules (which may hold a different react-native).
 */
const config = {
  watchFolders: [root],
  resolver: {
    blockList,
    // Resolve the library's source export condition so the app runs the
    // live TypeScript in ../src instead of the compiled lib/ output.
    // 'import' must stay OFF this list: it routes @babel/runtime helpers to
    // their ESM variants, which react-native's compiled CJS calls directly —
    // crashing at startup with "[runtime not ready]: Object is not a function".
    unstable_conditionNames: [
      'react-native-webassembly-runtime-source',
      'require',
      'react-native',
    ],
    extraNodeModules: {
      'react-native-webassembly-runtime': root,
      react: path.join(__dirname, 'node_modules/react'),
      'react-native': path.join(__dirname, 'node_modules/react-native'),
      // The library's compiled output (lib/) imports babel helpers, which
      // must resolve from this app since the parent node_modules is blocked.
      '@babel/runtime': path.join(__dirname, 'node_modules/@babel/runtime'),
    },
  },
  transformer: {
    // kaspa's workflow-rs runtime compares constructor names, so class and
    // function names must survive release-mode minification.
    minifierConfig: {
      keep_classnames: true,
      keep_fnames: true,
      mangle: {keep_classnames: true, keep_fnames: true},
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
