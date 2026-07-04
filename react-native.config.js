/**
 * The package ships its codegen output (see `codegenConfig` in package.json:
 * `includesGeneratedCode: true`), so consuming apps must build the spec glue
 * from the library's generated directory instead of running codegen
 * themselves.
 *
 * @type {import('@react-native-community/cli-types').UserDependencyConfig}
 */
module.exports = {
  dependency: {
    platforms: {
      android: {
        cmakeListsPath: 'generated/jni/CMakeLists.txt',
      },
    },
  },
};
