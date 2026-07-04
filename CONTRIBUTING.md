# Contributing

Contributions are always welcome, no matter how large or small!

## Development workflow

This repository contains two packages:

- The library in the root directory (managed with [pnpm](https://pnpm.io)).
- An example app in the `example/` directory (managed with npm).

Make sure you have the correct version of [Node.js](https://nodejs.org/) installed — see the [`.nvmrc`](./.nvmrc) file. With [corepack](https://nodejs.org/api/corepack.html) enabled, the right pnpm version is picked up automatically from `package.json`.

Install the dependencies for both packages:

```sh
pnpm bootstrap
```

### Codegen

The library ships its New Architecture codegen output (`codegenConfig.includesGeneratedCode` in `package.json`), generated into `ios/generated` and `android/generated`. These directories are not committed, so run Codegen:

- when running the project for the first time (the example app will not build without it), and
- whenever you change the TurboModule spec in `src/NativeWebassembly.ts`.

```sh
pnpm exec bob build --target codegen
```

### Example app

The [example app](/example/) demonstrates usage of the library. It resolves the library's live TypeScript in `src/` (via the `react-native-webassembly-runtime-source` export condition), so JavaScript changes are reflected without a rebuild; native code changes require rebuilding the app.

```sh
pnpm example start    # start Metro
pnpm example ios      # build and run on iOS (run `pod install` in example/ios first)
pnpm example android  # build and run on Android
```

To edit native code, open `example/ios/WebassemblyExample.xcworkspace` in Xcode (the library's sources are under `Pods > Development Pods`), or `example/android` in Android Studio.

### Checks

```sh
pnpm typecheck  # TypeScript
pnpm lint       # ESLint + Prettier
pnpm prepack    # build the package with react-native-builder-bob
```

### WebAssembly spec suite

The `harness/` directory contains a native test harness that runs the official WebAssembly spec suite and binding tests against the wasm3 backend (JSC-based, macOS only; requires `wabt` for `wast2json`):

```sh
brew install wabt
./harness/run-ci.sh
```

## Commit messages

Commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org) specification, e.g.:

- `fix: correct memory grow hint handling`
- `feat: support Module.customSections`
- `docs: update polyfill usage`
- `chore: bump dependencies`

This is enforced by commitlint via a [lefthook](https://lefthook.dev) `commit-msg` hook (installed automatically on `pnpm install`), and it matters: releases and changelogs are generated automatically by [release-please](https://github.com/googleapis/release-please) from the commit history. The pre-commit hook also lints and typechecks staged files.

## Publishing

Releases are automated: release-please maintains a release PR from the commits on `main`; merging it tags a release and CI publishes to npm with provenance. There is no manual publish step.

## Sending a pull request

- Prefer small pull requests focused on one change.
- Verify that `pnpm typecheck`, `pnpm lint`, and the harness suite pass locally.
- Follow the pull request template when opening a pull request.
