/**
 * A spec-shaped `WebAssembly` namespace over the native wasm3 binding.
 *
 * Runtime-environment free: no react-native imports, no DOM. The native
 * globals (`RNWebassembly_instantiate`, `RNWebassembly_validate`) must be
 * installed before any Module/Instance is constructed — importing
 * `react-native-webassembly-runtime/polyfill` (see ./index.ts) takes care of that in
 * a React Native app.
 *
 * Coverage (wasm3 backend):
 * - Module, Instance, instantiate (both overloads), compile, validate,
 *   CompileError/LinkError/RuntimeError: supported.
 * - Module.exports/imports/customSections: supported (scanned from bytes).
 * - Memory/Global/Table exports: supported (Table is read-only `get`).
 * - Importing a Memory/Global/Table constructed in JS: NOT supported —
 *   `env.memory`'s `initial` is honoured as a best-effort grow hint only.
 * - instantiateStreaming/compileStreaming: intentionally absent so callers
 *   (e.g. wasm-bindgen glue) take their ArrayBuffer fallback path.
 */
/* eslint-disable no-bitwise -- LEB128/UTF-8 decoding in the binary scanner */

type NativeInstantiateOptions = {
  readonly stackSizeInBytes: number;
  readonly memoryInitialPages: number;
};

type NativeGlobals = {
  readonly RNWebassembly_instantiate?: (
    bufferSource: ArrayBuffer,
    importObject: object,
    options: NativeInstantiateOptions
  ) => object;
  readonly RNWebassembly_validate?: (bufferSource: ArrayBuffer) => boolean;
};

const nativeGlobal = globalThis as unknown as NativeGlobals;

const TAG_COMPILE = '[WebAssembly.CompileError]';
const TAG_LINK = '[WebAssembly.LinkError]';
const TAG_RUNTIME = '[WebAssembly.RuntimeError]';

export class CompileError extends Error {
  override readonly name = 'CompileError';
}

export class LinkError extends Error {
  override readonly name = 'LinkError';
}

export class RuntimeError extends Error {
  override readonly name = 'RuntimeError';
}

/** Re-throws native binding errors as their spec-shaped classes. */
const rethrowClassified = (e: unknown): never => {
  if (e instanceof Error && typeof e.message === 'string') {
    const make = (Ctor: new (message: string) => Error, tag: string) => {
      const error = new Ctor(e.message.slice(tag.length).trim());
      error.stack = e.stack;
      return error;
    };

    if (e.message.startsWith(TAG_COMPILE)) {
      throw make(CompileError, TAG_COMPILE);
    }
    if (e.message.startsWith(TAG_LINK)) {
      throw make(LinkError, TAG_LINK);
    }
    if (e.message.startsWith(TAG_RUNTIME)) {
      throw make(RuntimeError, TAG_RUNTIME);
    }
  }

  throw e;
};

export type BufferSource = ArrayBuffer | ArrayBufferView;

const toArrayBuffer = (source: BufferSource): ArrayBuffer => {
  if (source instanceof ArrayBuffer) {
    return source;
  }

  if (ArrayBuffer.isView(source)) {
    return source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength
    ) as ArrayBuffer;
  }

  throw new TypeError(
    '[WebAssembly] Expected bufferSource to be an ArrayBuffer or ArrayBufferView.'
  );
};

/* ------------------------------------------------------------------ */
/* Binary scanning (Module.exports / imports / customSections)         */
/* ------------------------------------------------------------------ */

export type ImportExportKind = 'function' | 'table' | 'memory' | 'global';

export type ModuleExportDescriptor = {
  readonly name: string;
  readonly kind: ImportExportKind;
};

export type ModuleImportDescriptor = {
  readonly module: string;
  readonly name: string;
  readonly kind: ImportExportKind;
};

const KINDS: readonly ImportExportKind[] = [
  'function',
  'table',
  'memory',
  'global',
];

class ByteReader {
  private offset: number;

  constructor(
    private readonly bytes: Uint8Array,
    offset = 0
  ) {
    this.offset = offset;
  }

  get position(): number {
    return this.offset;
  }

  get atEnd(): boolean {
    return this.offset >= this.bytes.length;
  }

  u8(): number {
    if (this.atEnd) {
      throw new CompileError('Unexpected end of module bytes.');
    }
    return this.bytes[this.offset++]!;
  }

  leb(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      result |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) {
        return result >>> 0;
      }
      shift += 7;
      if (shift >= 35) {
        throw new CompileError('Malformed LEB128 in module bytes.');
      }
    }
  }

  bytes_(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) {
      throw new CompileError('Unexpected end of module bytes.');
    }
    const view = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return view;
  }

  name(): string {
    return utf8Decode(this.bytes_(this.leb()));
  }

  skip(length: number): void {
    this.bytes_(length);
  }
}

/** Minimal UTF-8 decoder: wasm names are almost always ASCII, and this file
 *  cannot assume a TextDecoder global exists. */
const utf8Decode = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const a = bytes[i]!;
    if (a < 0x80) {
      out += String.fromCharCode(a);
      i += 1;
    } else if (a < 0xe0) {
      out += String.fromCharCode(((a & 0x1f) << 6) | (bytes[i + 1]! & 0x3f));
      i += 2;
    } else if (a < 0xf0) {
      out += String.fromCharCode(
        ((a & 0x0f) << 12) |
          ((bytes[i + 1]! & 0x3f) << 6) |
          (bytes[i + 2]! & 0x3f)
      );
      i += 3;
    } else {
      const cp =
        (((a & 0x07) << 18) |
          ((bytes[i + 1]! & 0x3f) << 12) |
          ((bytes[i + 2]! & 0x3f) << 6) |
          (bytes[i + 3]! & 0x3f)) -
        0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      i += 4;
    }
  }
  return out;
};

/** Calls `visit(sectionId, reader, size)` for each section; the visitor must
 *  not read past its section. Returning `false` stops the walk. */
const walkSections = (
  bytes: Uint8Array,
  visit: (id: number, reader: ByteReader, size: number) => boolean
): void => {
  if (bytes.length < 8) {
    throw new CompileError('Module is too short to be WebAssembly.');
  }

  const reader = new ByteReader(bytes, 8); // magic + version

  while (!reader.atEnd) {
    const id = reader.u8();
    const size = reader.leb();
    const start = reader.position;

    if (
      !visit(id, new ByteReader(bytes.subarray(0, start + size), start), size)
    ) {
      return;
    }

    reader.skip(start + size - reader.position);
  }
};

const skipLimits = (reader: ByteReader): void => {
  const flags = reader.u8();
  reader.leb(); // min
  if (flags & 1) {
    reader.leb();
  } // max
};

const scanExports = (bytes: Uint8Array): ModuleExportDescriptor[] => {
  const result: ModuleExportDescriptor[] = [];

  walkSections(bytes, (id, reader) => {
    if (id !== 7) {
      return true;
    }

    const count = reader.leb();
    for (let i = 0; i < count; i += 1) {
      const name = reader.name();
      const kind = KINDS[reader.u8()];
      reader.leb(); // index
      if (kind) {
        result.push({ name, kind });
      }
    }

    return false;
  });

  return result;
};

const scanImports = (bytes: Uint8Array): ModuleImportDescriptor[] => {
  const result: ModuleImportDescriptor[] = [];

  walkSections(bytes, (id, reader) => {
    if (id !== 2) {
      return true;
    }

    const count = reader.leb();
    for (let i = 0; i < count; i += 1) {
      const module = reader.name();
      const name = reader.name();
      const kindByte = reader.u8();
      const kind = KINDS[kindByte];

      switch (kindByte) {
        case 0: // function: typeidx
          reader.leb();
          break;
        case 1: // table: elemtype + limits
          reader.u8();
          skipLimits(reader);
          break;
        case 2: // memory: limits
          skipLimits(reader);
          break;
        case 3: // global: valtype + mutability
          reader.u8();
          reader.u8();
          break;
        default:
          throw new CompileError('Malformed import descriptor.');
      }

      if (kind) {
        result.push({ module, name, kind });
      }
    }

    return false;
  });

  return result;
};

const scanCustomSections = (bytes: Uint8Array, name: string): ArrayBuffer[] => {
  const result: ArrayBuffer[] = [];

  walkSections(bytes, (id, reader, size) => {
    if (id !== 0) {
      return true;
    }

    const start = reader.position;
    const sectionName = reader.name();

    if (sectionName === name) {
      const payload = reader.bytes_(size - (reader.position - start));
      result.push(payload.slice().buffer as ArrayBuffer);
    }

    return true;
  });

  return result;
};

/* ------------------------------------------------------------------ */
/* The WebAssembly namespace                                           */
/* ------------------------------------------------------------------ */

export type WebAssemblyPolyfillOptions = {
  /** Replace an existing `globalThis.WebAssembly` if one is present. */
  readonly force?: boolean;
  /**
   * Grow every instance's linear memory to this many 64KiB pages at
   * instantiation. Pre-sizing to peak usage avoids memory growth at runtime —
   * important for callers (like wasm-bindgen glue) that cache typed-array
   * views over the memory and cannot observe a grow.
   */
  readonly memoryInitialPages?: number;
  /** wasm3 interpreter stack size for every instance. Defaults to 512KiB. */
  readonly stackSizeInBytes?: number;
};

const DEFAULT_STACK_SIZE_IN_BYTES = 512 * 1024;

let defaults: Required<Omit<WebAssemblyPolyfillOptions, 'force'>> = {
  memoryInitialPages: 0,
  stackSizeInBytes: DEFAULT_STACK_SIZE_IN_BYTES,
};

const nativeInstantiate = (
  bytes: ArrayBuffer,
  importObject: object
): object => {
  const instantiate = nativeGlobal.RNWebassembly_instantiate;

  if (typeof instantiate !== 'function') {
    throw new Error(
      '[WebAssembly] Native binding is not installed. In React Native, import "react-native-webassembly-runtime" (or ".../polyfill") before use.'
    );
  }

  // An `env.memory` import declares the caller's expected initial size; the
  // backend honours it as a grow hint for the instance's own memory.
  const envMemory = (
    importObject as { env?: { memory?: { initial?: unknown } } }
  ).env?.memory;
  const hintedPages =
    typeof envMemory?.initial === 'number' ? envMemory.initial : 0;

  try {
    return instantiate(bytes, importObject, {
      stackSizeInBytes: defaults.stackSizeInBytes,
      memoryInitialPages: Math.max(defaults.memoryInitialPages, hintedPages),
    });
  } catch (e) {
    return rethrowClassified(e);
  }
};

export class Module {
  /** @internal */
  readonly __bytes: ArrayBuffer;

  constructor(bytes: BufferSource) {
    this.__bytes = toArrayBuffer(bytes);

    const validateNative = nativeGlobal.RNWebassembly_validate;

    if (typeof validateNative === 'function' && !validateNative(this.__bytes)) {
      throw new CompileError('WebAssembly.Module(): module validation failed.');
    }
  }

  static exports(module: Module): ModuleExportDescriptor[] {
    return scanExports(new Uint8Array(module.__bytes));
  }

  static imports(module: Module): ModuleImportDescriptor[] {
    return scanImports(new Uint8Array(module.__bytes));
  }

  static customSections(module: Module, sectionName: string): ArrayBuffer[] {
    return scanCustomSections(new Uint8Array(module.__bytes), sectionName);
  }
}

export class Instance<Exports extends object = Record<string, unknown>> {
  readonly exports: Exports;

  constructor(module: Module, importObject: object = {}) {
    if (!(module instanceof Module)) {
      throw new TypeError(
        '[WebAssembly] Instance expects a WebAssembly.Module.'
      );
    }

    this.exports = nativeInstantiate(module.__bytes, importObject) as Exports;
  }
}

export type WebAssemblyMemoryDescriptor = {
  readonly initial?: number;
  readonly maximum?: number;
  readonly shared?: boolean;
};

/**
 * Importable-memory stand-in. wasm3 cannot import a memory, so this only
 * carries the descriptor: the native binding reads `initial` from an
 * `env.memory` import as a grow hint for the instance's own memory.
 * Accessing `buffer` on a JS-constructed Memory therefore throws — use
 * `instance.exports.memory.buffer` instead.
 */
export class Memory {
  readonly initial: number;
  readonly maximum: number | undefined;

  constructor(descriptor: WebAssemblyMemoryDescriptor = {}) {
    if (descriptor?.shared) {
      throw new LinkError(
        'Shared memories are not supported by the wasm3 backend.'
      );
    }

    this.initial = descriptor?.initial ?? 0;
    this.maximum = descriptor?.maximum;
  }

  get buffer(): ArrayBuffer {
    throw new LinkError(
      'JS-constructed memories are not backed by the wasm3 backend; read `buffer` from `instance.exports.memory` instead.'
    );
  }
}

export class Global {
  constructor() {
    throw new LinkError(
      'JS-constructed globals cannot be imported with the wasm3 backend. Exported globals are available on `instance.exports`.'
    );
  }
}

export class Table {
  constructor() {
    throw new LinkError(
      'JS-constructed tables cannot be imported with the wasm3 backend. Exported tables are available (read-only) on `instance.exports`.'
    );
  }
}

export type WebAssemblyInstantiatedSource<
  Exports extends object = Record<string, unknown>,
> = {
  readonly module: Module;
  readonly instance: Instance<Exports>;
};

export function validate(bytes: BufferSource): boolean {
  const validateNative = nativeGlobal.RNWebassembly_validate;

  if (typeof validateNative !== 'function') {
    throw new Error('[WebAssembly] Native binding is not installed.');
  }

  return validateNative(toArrayBuffer(bytes));
}

export async function compile(bytes: BufferSource): Promise<Module> {
  return new Module(bytes);
}

export async function instantiate<
  Exports extends object = Record<string, unknown>,
>(source: Module, importObject?: object): Promise<Instance<Exports>>;

export async function instantiate<
  Exports extends object = Record<string, unknown>,
>(
  source: BufferSource,
  importObject?: object
): Promise<WebAssemblyInstantiatedSource<Exports>>;

export async function instantiate<
  Exports extends object = Record<string, unknown>,
>(
  source: Module | BufferSource,
  importObject: object = {}
): Promise<Instance<Exports> | WebAssemblyInstantiatedSource<Exports>> {
  if (source instanceof Module) {
    return new Instance<Exports>(source, importObject);
  }

  const module = new Module(source);

  return { module, instance: new Instance<Exports>(module, importObject) };
}

/** The value installed as `globalThis.WebAssembly`. */
export const WebAssemblyPolyfill = {
  Module,
  Instance,
  Memory,
  Global,
  Table,
  CompileError,
  LinkError,
  RuntimeError,
  compile,
  instantiate,
  validate,
} as const;

export function installWebAssemblyPolyfill(
  options: WebAssemblyPolyfillOptions = {}
): typeof WebAssemblyPolyfill {
  defaults = {
    memoryInitialPages:
      options.memoryInitialPages ?? defaults.memoryInitialPages,
    stackSizeInBytes: options.stackSizeInBytes ?? defaults.stackSizeInBytes,
  };

  const host = globalThis as { WebAssembly?: unknown };

  if (!host.WebAssembly || options.force) {
    host.WebAssembly = WebAssemblyPolyfill;
  }

  return WebAssemblyPolyfill;
}
