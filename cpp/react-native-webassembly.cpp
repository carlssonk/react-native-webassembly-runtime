#include "react-native-webassembly.h"

#include <jsi/jsi.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "wasm3.h"
#include "m3_env.h"

using namespace facebook::jsi;

namespace {

constexpr uint32_t kWasmPageSizeInBytes = 65536;
constexpr uint32_t kDefaultStackSizeInBytes = 64 * 1024;

// Sentinel trap result returned by the import trampoline when the JavaScript
// import throws (or is missing). Detected by pointer identity after m3_Call,
// at which point InstanceState::pendingException is rethrown. This keeps C++
// exceptions from unwinding through wasm3's C stack frames.
const char kTrapJsException[] = "JavaScript import raised an exception";

// Stable message prefixes the JS polyfill maps onto the web's
// WebAssembly.CompileError / LinkError / RuntimeError classes.
constexpr char kTagCompile[] = "[WebAssembly.CompileError]";
constexpr char kTagLink[] = "[WebAssembly.LinkError]";
constexpr char kTagRuntime[] = "[WebAssembly.RuntimeError]";

struct InstanceState;

struct ImportEntry {
  InstanceState* state;
  std::shared_ptr<Function> fn; // null when the import was not provided
  std::string moduleName;
  std::string fieldName;
};

struct InstanceState {
  IM3Environment environment = nullptr;
  IM3Runtime runtime = nullptr;
  // Owned by the runtime after m3_LoadModule; valid for the runtime's life.
  IM3Module module = nullptr;
  // wasm3 sizes module->table0 by the element segments only; the declared
  // table minimum (scanned from the table section) can be larger, with the
  // uninitialised tail reading as null slots.
  uint32_t declaredTableSize = 0;
  // wasm3 requires the wasm bytes to stay alive for the module's lifetime.
  std::vector<uint8_t> moduleBytes;
  // unique_ptr keeps addresses stable; raw pointers are wasm3 link userdata.
  std::vector<std::unique_ptr<ImportEntry>> imports;
  std::exception_ptr pendingException;
  // Neither JSI nor wasm3 is thread-safe, and JSI objects belong to exactly
  // one runtime; every entry point into the instance checks against these.
  Runtime* jsRuntime = nullptr;
  std::thread::id jsThreadId;

  ~InstanceState() {
    if (runtime) m3_FreeRuntime(runtime);
    if (environment) m3_FreeEnvironment(environment);
  }
};

// Thrown as std::runtime_error rather than JSError: constructing a JSError
// requires touching the (possibly wrong) runtime, while the JSI host-function
// wrapper converts std::exception into a JS error safely.
void guardInstanceAccess(Runtime& rt, InstanceState& state) {
  if (&rt != state.jsRuntime || std::this_thread::get_id() != state.jsThreadId)
    throw std::runtime_error(
        "[WebAssembly] Instance accessed from a different JS runtime or "
        "thread than the one it was instantiated on.");
}

char valueTypeToChar(M3ValueType type) {
  switch (type) {
    case c_m3Type_i32: return 'i';
    case c_m3Type_i64: return 'I';
    case c_m3Type_f32: return 'f';
    case c_m3Type_f64: return 'F';
    default: return 0;
  }
}

// Builds a wasm3 signature string, e.g. "i(if)", from a function's type.
bool buildSignature(IM3Function f, std::string& o_signature) {
  uint32_t numRets = m3_GetRetCount(f);
  uint32_t numArgs = m3_GetArgCount(f);

  if (numRets > 1) return false;

  std::string signature;

  if (numRets == 0) {
    signature += 'v';
  } else {
    char c = valueTypeToChar(m3_GetRetType(f, 0));
    if (!c) return false;
    signature += c;
  }

  signature += '(';

  for (uint32_t i = 0; i < numArgs; i += 1) {
    char c = valueTypeToChar(m3_GetArgType(f, i));
    if (!c) return false;
    signature += c;
  }

  signature += ')';

  o_signature = std::move(signature);
  return true;
}

int64_t doubleToInt64(double value) {
  if (std::isnan(value)) return 0;
  if (value >= 9223372036854775807.0) return INT64_MAX;
  if (value <= -9223372036854775808.0) return INT64_MIN;
  return static_cast<int64_t>(value);
}

double toDouble(Runtime& rt, const Value& value) {
  if (value.isNumber()) return value.getNumber();
  if (value.isBigInt())
    return static_cast<double>(value.getBigInt(rt).getInt64(rt));
  if (value.isBool()) return value.getBool() ? 1 : 0;
  if (value.isNull()) return 0;
  if (value.isUndefined()) return std::nan("");
  throw JSError(rt, "[WebAssembly] Cannot convert value to a wasm number.");
}

int64_t toInt64(Runtime& rt, const Value& value) {
  if (value.isBigInt()) return value.getBigInt(rt).getInt64(rt);
  return doubleToInt64(toDouble(rt, value));
}

// Reads a wasm value from a 64-bit interpreter slot.
Value slotToValue(Runtime& rt, M3ValueType type, const uint64_t* slot) {
  switch (type) {
    case c_m3Type_i32:
      return Value(static_cast<double>(*reinterpret_cast<const int32_t*>(slot)));
    case c_m3Type_i64:
      return BigInt::fromInt64(rt, *reinterpret_cast<const int64_t*>(slot));
    case c_m3Type_f32:
      return Value(static_cast<double>(*reinterpret_cast<const float*>(slot)));
    case c_m3Type_f64:
      return Value(*reinterpret_cast<const double*>(slot));
    default:
      throw JSError(rt, "[WebAssembly] Unsupported wasm value type.");
  }
}

void valueToSlot(Runtime& rt, M3ValueType type, const Value& value, uint64_t* slot) {
  *slot = 0;
  switch (type) {
    case c_m3Type_i32:
      *reinterpret_cast<int32_t*>(slot) =
          static_cast<int32_t>(toInt64(rt, value));
      break;
    case c_m3Type_i64:
      *reinterpret_cast<int64_t*>(slot) = toInt64(rt, value);
      break;
    case c_m3Type_f32:
      *reinterpret_cast<float*>(slot) =
          static_cast<float>(toDouble(rt, value));
      break;
    case c_m3Type_f64:
      *reinterpret_cast<double*>(slot) = toDouble(rt, value);
      break;
    default:
      throw JSError(rt, "[WebAssembly] Unsupported wasm value type.");
  }
}

[[noreturn]] void throwWasmError(
    Runtime& rt,
    InstanceState& state,
    M3Result result,
    const char* tag = kTagRuntime) {
  if (result == kTrapJsException && state.pendingException) {
    std::exception_ptr pending = state.pendingException;
    state.pendingException = nullptr;
    std::rethrow_exception(pending);
  }

  std::string message = std::string(tag) + " " + result;

  M3ErrorInfo info;
  m3_GetErrorInfo(state.runtime, &info);

  if (info.message && info.message[0] && std::strcmp(info.message, result) != 0)
    message += std::string(": ") + info.message;

  m3_ResetErrorInfo(state.runtime);

  // Traps surface from export calls, which the polyfill does not wrap (that
  // would tax the hot path). Set `name` on the Error here so callers can
  // distinguish trap errors (e.name === "RuntimeError") without wrappers;
  // the tagged message additionally supports the polyfill's classification.
  const char* errorName = tag == kTagCompile ? "CompileError"
      : tag == kTagLink                      ? "LinkError"
                                             : "RuntimeError";

  Object errorObject = rt.global()
                           .getPropertyAsFunction(rt, "Error")
                           .callAsConstructor(rt, message)
                           .getObject(rt);
  errorObject.setProperty(rt, "name", errorName);

  throw JSError(rt, Value(rt, errorObject));
}

// The web's WebAssembly API throws RangeError for out-of-range sizes and
// indices (Memory.grow, Table.get); plain JSError surfaces as a generic Error.
[[noreturn]] void throwRangeError(Runtime& rt, const std::string& message) {
  Value error = rt.global()
                    .getPropertyAsFunction(rt, "RangeError")
                    .callAsConstructor(rt, message);
  throw JSError(rt, std::move(error));
}

// Trampoline invoked by wasm3 for every linked import. Per wasm3's raw call
// convention, _sp holds the return slots first, then the argument slots.
const void* CallImportedFunction(IM3Runtime /*runtime*/, IM3ImportContext ctx, uint64_t* _sp, void* /*_mem*/) {
  auto* entry = static_cast<ImportEntry*>(ctx->userdata);

  // Imports only run beneath an export call, which guardInstanceAccess has
  // already checked, so the instantiation runtime is the current one.
  Runtime& rt = *entry->state->jsRuntime;

  IM3Function func = ctx->function;

  uint32_t argCount = m3_GetArgCount(func);
  uint32_t retCount = m3_GetRetCount(func);

  if (!entry->fn) {
    entry->state->pendingException = std::make_exception_ptr(std::runtime_error(
        "[WebAssembly] Attempted to call missing import \"" +
        entry->moduleName + "." + entry->fieldName + "\"."));
    return kTrapJsException;
  }

  if (retCount > 1) return m3Err_tooManyArgsRets;

  try {
    std::vector<Value> args;
    args.reserve(argCount);

    for (uint32_t i = 0; i < argCount; i += 1)
      args.push_back(slotToValue(rt, m3_GetArgType(func, i), &_sp[retCount + i]));

    const Value* argValues = args.data();
    Value result = entry->fn->call(rt, argValues, args.size());

    if (retCount == 1)
      valueToSlot(rt, m3_GetRetType(func, 0), result, &_sp[0]);

    return m3Err_none;
  } catch (...) {
    entry->state->pendingException = std::current_exception();
    return kTrapJsException;
  }
}

// A snapshot of the linear memory's current allocation. The pointer is fixed
// at creation because JSI requires MutableBuffer::data() to stay stable, while
// wasm3 reallocates the backing store on memory.grow — WasmMemory hands out a
// fresh snapshot after a grow instead of mutating this one.
class MemorySnapshotBuffer : public MutableBuffer {
 public:
  MemorySnapshotBuffer(std::shared_ptr<InstanceState> state, uint8_t* data, size_t size)
      : state_(std::move(state)), data_(data), size_(size) {}

  size_t size() const override { return size_; }

  uint8_t* data() override { return data_; }

 private:
  std::shared_ptr<InstanceState> state_; // keeps the instance (and bytes) alive
  uint8_t* data_;
  size_t size_;
};

// WebAssembly.Memory lookalike: `buffer` is an ArrayBuffer over the current
// allocation and `grow(deltaPages)` grows it, returning the previous page
// count. `buffer` keeps a stable identity until the backing allocation moves
// (a grow from JS or from inside wasm), after which the next access hands out
// a fresh ArrayBuffer — mirroring the web, where a grow detaches the old
// buffer. As on the web, a buffer captured before a grow must not be used
// afterwards.
class WasmMemory : public HostObject {
 public:
  explicit WasmMemory(std::shared_ptr<InstanceState> state)
      : state_(std::move(state)) {}

  Value get(Runtime& rt, const PropNameID& nameId) override {
    guardInstanceAccess(rt, *state_);

    std::string name = nameId.utf8(rt);

    if (name == "buffer") return getBuffer(rt);
    if (name == "grow") return getGrow(rt);

    return Value::undefined();
  }

  std::vector<PropNameID> getPropertyNames(Runtime& rt) override {
    std::vector<PropNameID> names;
    names.push_back(PropNameID::forAscii(rt, "buffer"));
    names.push_back(PropNameID::forAscii(rt, "grow"));
    return names;
  }

 private:
  Value getBuffer(Runtime& rt) {
    uint32_t size = 0;
    uint8_t* data = m3_GetMemory(state_->runtime, &size, 0);

    if (buffer_.isUndefined() || data != bufferData_ || size != bufferSize_) {
      bufferData_ = data;
      bufferSize_ = size;
      buffer_ = Value(
          rt,
          ArrayBuffer(rt, std::make_shared<MemorySnapshotBuffer>(state_, data, size)));
    }

    return Value(rt, buffer_);
  }

  Value getGrow(Runtime& rt) {
    if (grow_.isUndefined()) {
      std::shared_ptr<InstanceState> state = state_;

      grow_ = Value(rt, Function::createFromHostFunction(
          rt,
          PropNameID::forAscii(rt, "grow"),
          1,
          [state](Runtime& runtime, const Value& /*thisValue*/, const Value* arguments, size_t count) -> Value {
            guardInstanceAccess(runtime, *state);

            double delta = count > 0 ? toDouble(runtime, arguments[0]) : std::nan("");

            if (std::isnan(delta) || delta < 0 || delta != std::floor(delta))
              throwRangeError(runtime, "[WebAssembly] Memory.grow expects a non-negative integer page count.");

            uint32_t size = 0;
            m3_GetMemory(state->runtime, &size, 0);
            uint32_t previousPages = size / kWasmPageSizeInBytes;

            if (delta > 4294967295.0 ||
                previousPages + static_cast<uint64_t>(delta) > 4294967295.0)
              throwRangeError(runtime, "[WebAssembly] Failed to grow memory: page count overflow.");

            M3Result result = ResizeMemory(
                state->runtime, previousPages + static_cast<uint32_t>(delta));

            if (result != m3Err_none)
              throwRangeError(runtime, std::string("[WebAssembly] Failed to grow memory: ") + result);

            return Value(static_cast<double>(previousPages));
          }));
    }

    return Value(rt, grow_);
  }

  std::shared_ptr<InstanceState> state_;
  Value buffer_;
  uint8_t* bufferData_ = nullptr;
  uint32_t bufferSize_ = 0;
  Value grow_;
};

// WebAssembly.Global lookalike exposing the spec's `value` property and
// `valueOf()` method. wasm3's m3_SetGlobal does not (yet) enforce mutability,
// so it is enforced here.
class WasmGlobal : public HostObject {
 public:
  WasmGlobal(std::shared_ptr<InstanceState> state, IM3Global global, std::string name)
      : state_(std::move(state)), global_(global), name_(std::move(name)) {}

  Value get(Runtime& rt, const PropNameID& nameId) override {
    guardInstanceAccess(rt, *state_);

    std::string name = nameId.utf8(rt);

    if (name == "value") return readValue(rt, global_, name_);
    if (name == "valueOf") return getValueOf(rt);

    return Value::undefined();
  }

  void set(Runtime& rt, const PropNameID& nameId, const Value& value) override {
    guardInstanceAccess(rt, *state_);

    if (nameId.utf8(rt) != "value")
      throw JSError(rt, "[WebAssembly] Globals only expose a \"value\" property.");

    if (!global_->isMutable)
      throw JSError(rt, "[WebAssembly] Global \"" + name_ + "\" is immutable.");

    M3TaggedValue tagged;
    tagged.type = m3_GetGlobalType(global_);

    switch (tagged.type) {
      case c_m3Type_i32:
        tagged.value.i32 = static_cast<uint32_t>(static_cast<int32_t>(toInt64(rt, value)));
        break;
      case c_m3Type_i64:
        tagged.value.i64 = static_cast<uint64_t>(toInt64(rt, value));
        break;
      case c_m3Type_f32:
        tagged.value.f32 = static_cast<float>(toDouble(rt, value));
        break;
      case c_m3Type_f64:
        tagged.value.f64 = toDouble(rt, value);
        break;
      default:
        throw JSError(rt, "[WebAssembly] Global \"" + name_ + "\" has an unsupported type.");
    }

    M3Result result = m3_SetGlobal(global_, &tagged);

    if (result != m3Err_none)
      throw JSError(rt, "[WebAssembly] Failed to set global \"" + name_ + "\": " + result);
  }

  std::vector<PropNameID> getPropertyNames(Runtime& rt) override {
    std::vector<PropNameID> names;
    names.push_back(PropNameID::forAscii(rt, "value"));
    names.push_back(PropNameID::forAscii(rt, "valueOf"));
    return names;
  }

 private:
  static Value readValue(Runtime& rt, IM3Global global, const std::string& name) {
    M3TaggedValue tagged;
    M3Result result = m3_GetGlobal(global, &tagged);

    if (result != m3Err_none)
      throw JSError(rt, "[WebAssembly] Failed to read global \"" + name + "\": " + result);

    switch (tagged.type) {
      case c_m3Type_i32:
        return Value(static_cast<double>(static_cast<int32_t>(tagged.value.i32)));
      case c_m3Type_i64:
        return BigInt::fromInt64(rt, static_cast<int64_t>(tagged.value.i64));
      case c_m3Type_f32:
        return Value(static_cast<double>(tagged.value.f32));
      case c_m3Type_f64:
        return Value(tagged.value.f64);
      default:
        throw JSError(rt, "[WebAssembly] Global \"" + name + "\" has an unsupported type.");
    }
  }

  Value getValueOf(Runtime& rt) {
    if (valueOf_.isUndefined()) {
      std::shared_ptr<InstanceState> state = state_;
      IM3Global global = global_;
      std::string name = name_;

      valueOf_ = Value(rt, Function::createFromHostFunction(
          rt,
          PropNameID::forAscii(rt, "valueOf"),
          0,
          [state, global, name](Runtime& runtime, const Value& /*thisValue*/, const Value* /*arguments*/, size_t /*count*/) -> Value {
            guardInstanceAccess(runtime, *state);
            return readValue(runtime, global, name);
          }));
    }

    return Value(rt, valueOf_);
  }

  std::shared_ptr<InstanceState> state_;
  IM3Global global_;
  std::string name_;
  Value valueOf_;
};

Function makeExportFunction(
    Runtime& rt,
    std::shared_ptr<InstanceState> state,
    IM3Function fn,
    const std::string& name);

// Read-only WebAssembly.Table lookalike over wasm3's single funcref table:
// `length` and `get(index)` (returning a callable, or null for an empty
// slot) are supported — enough for wasm-bindgen's closure machinery, which
// only ever calls `get`. wasm3 has no public API for mutating the table, so
// `set` and `grow` throw.
class WasmTable : public HostObject {
 public:
  explicit WasmTable(std::shared_ptr<InstanceState> state)
      : state_(std::move(state)) {}

  Value get(Runtime& rt, const PropNameID& nameId) override {
    guardInstanceAccess(rt, *state_);

    std::string name = nameId.utf8(rt);

    if (name == "length")
      return Value(static_cast<double>(tableLength(*state_)));

    if (name == "get") return getGet(rt);

    if (name == "set" || name == "grow") return getUnsupported(rt, name);

    return Value::undefined();
  }

  std::vector<PropNameID> getPropertyNames(Runtime& rt) override {
    std::vector<PropNameID> names;
    names.push_back(PropNameID::forAscii(rt, "length"));
    names.push_back(PropNameID::forAscii(rt, "get"));
    names.push_back(PropNameID::forAscii(rt, "set"));
    names.push_back(PropNameID::forAscii(rt, "grow"));
    return names;
  }

 private:
  static uint32_t tableLength(const InstanceState& state) {
    return std::max(state.declaredTableSize, state.module->table0Size);
  }

  Value getGet(Runtime& rt) {
    if (get_.isUndefined()) {
      std::shared_ptr<InstanceState> state = state_;

      get_ = Value(rt, Function::createFromHostFunction(
          rt,
          PropNameID::forAscii(rt, "get"),
          1,
          [state](Runtime& runtime, const Value& /*thisValue*/, const Value* arguments, size_t count) -> Value {
            guardInstanceAccess(runtime, *state);

            double index = count > 0 ? toDouble(runtime, arguments[0]) : std::nan("");

            if (std::isnan(index) || index < 0 || index != std::floor(index) ||
                index >= static_cast<double>(tableLength(*state)))
              throwRangeError(runtime, "[WebAssembly] Table.get index out of bounds.");

            // Beyond the element-initialised extent (but within the declared
            // size) every slot is null, as on the web.
            if (index >= static_cast<double>(state->module->table0Size))
              return Value::null();

            IM3Function fn = state->module->table0[static_cast<uint32_t>(index)];

            // An uninitialised table slot is null, as on the web.
            if (!fn) return Value::null();

            const char* name = m3_GetFunctionName(fn);

            return makeExportFunction(runtime, state, fn, name ? name : "table.get");
          }));
    }

    return Value(rt, get_);
  }

  Value getUnsupported(Runtime& rt, const std::string& name) {
    std::shared_ptr<InstanceState> state = state_;

    return Function::createFromHostFunction(
        rt,
        PropNameID::forUtf8(rt, name),
        0,
        [state, name](Runtime& runtime, const Value&, const Value*, size_t) -> Value {
          guardInstanceAccess(runtime, *state);
          throw JSError(runtime, "[WebAssembly] Table." + name + " is not supported by the wasm3 backend.");
        });
  }

  std::shared_ptr<InstanceState> state_;
  Value get_;
};

struct ExportRecord {
  std::string name;
  uint8_t kind; // 0 = function, 1 = table, 2 = memory, 3 = global
  uint32_t index;
};

bool readLebU32(const uint8_t*& p, const uint8_t* end, uint32_t& o_value) {
  uint32_t result = 0;
  uint32_t shift = 0;

  while (p < end && shift < 35) {
    uint8_t byte = *p++;
    result |= static_cast<uint32_t>(byte & 0x7f) << shift;
    if (!(byte & 0x80)) {
      o_value = result;
      return true;
    }
    shift += 7;
  }

  return false;
}

// wasm3 keeps only one name per exported entity (functions exported under
// several names lose all but one; the same for globals), so the export
// section is re-scanned from the module bytes — already validated by
// m3_ParseModule — to recover the exact (name, kind, index) list.
bool scanExportSection(const std::vector<uint8_t>& bytes, std::vector<ExportRecord>& o_exports) {
  const uint8_t* p = bytes.data();
  const uint8_t* end = p + bytes.size();

  if (end - p < 8) return false;
  p += 8; // magic + version

  while (p < end) {
    uint8_t sectionId = *p++;

    uint32_t sectionSize = 0;
    if (!readLebU32(p, end, sectionSize) || sectionSize > static_cast<size_t>(end - p))
      return false;

    if (sectionId != 7) { // not the export section
      p += sectionSize;
      continue;
    }

    const uint8_t* sectionEnd = p + sectionSize;

    uint32_t count = 0;
    if (!readLebU32(p, sectionEnd, count)) return false;

    for (uint32_t i = 0; i < count; i += 1) {
      uint32_t nameLength = 0;
      if (!readLebU32(p, sectionEnd, nameLength) || nameLength > static_cast<size_t>(sectionEnd - p))
        return false;

      ExportRecord record;
      record.name.assign(reinterpret_cast<const char*>(p), nameLength);
      p += nameLength;

      if (p >= sectionEnd) return false;
      record.kind = *p++;

      if (!readLebU32(p, sectionEnd, record.index)) return false;

      o_exports.push_back(std::move(record));
    }

    return true;
  }

  return true; // no export section: nothing exported
}

// The declared minimum size of the module's (single, MVP) table. wasm3 does
// not parse the table section at all, so it is scanned from the bytes.
uint32_t scanDeclaredTableSize(const std::vector<uint8_t>& bytes) {
  const uint8_t* p = bytes.data();
  const uint8_t* end = p + bytes.size();

  if (end - p < 8) return 0;
  p += 8;

  while (p < end) {
    uint8_t sectionId = *p++;

    uint32_t sectionSize = 0;
    if (!readLebU32(p, end, sectionSize) || sectionSize > static_cast<size_t>(end - p))
      return 0;

    if (sectionId != 4) { // not the table section
      p += sectionSize;
      continue;
    }

    const uint8_t* sectionEnd = p + sectionSize;

    uint32_t count = 0;
    if (!readLebU32(p, sectionEnd, count) || count < 1) return 0;

    if (p >= sectionEnd) return 0;
    p += 1; // element type (funcref)

    if (p >= sectionEnd) return 0;
    uint8_t limitFlags = *p++;
    (void)limitFlags;

    uint32_t minSize = 0;
    if (!readLebU32(p, sectionEnd, minSize)) return 0;

    return minSize;
  }

  return 0;
}

std::shared_ptr<Function> resolveImport(
    Runtime& rt,
    const Object& importObject,
    const char* moduleName,
    const char* fieldName) {
  Value moduleValue = importObject.getProperty(rt, moduleName);
  if (!moduleValue.isObject()) return nullptr;

  Value fieldValue = moduleValue.getObject(rt).getProperty(rt, fieldName);
  if (!fieldValue.isObject()) return nullptr;

  Object fieldObject = fieldValue.getObject(rt);
  if (!fieldObject.isFunction(rt)) return nullptr;

  return std::make_shared<Function>(fieldObject.getFunction(rt));
}

Function makeExportFunction(
    Runtime& rt,
    std::shared_ptr<InstanceState> state,
    IM3Function fn,
    const std::string& name) {
  return Function::createFromHostFunction(
      rt,
      PropNameID::forUtf8(rt, name),
      m3_GetArgCount(fn),
      [state, fn](Runtime& runtime, const Value& /*thisValue*/, const Value* arguments, size_t count) -> Value {
        guardInstanceAccess(runtime, *state);

        uint32_t argCount = m3_GetArgCount(fn);
        uint32_t retCount = m3_GetRetCount(fn);

        std::vector<uint64_t> argSlots(argCount);
        std::vector<const void*> argPtrs(argCount);

        const Value undefined = Value::undefined();

        for (uint32_t i = 0; i < argCount; i += 1) {
          // Missing arguments coerce as undefined, per the JS-API spec.
          const Value& arg = i < count ? arguments[i] : undefined;
          valueToSlot(runtime, m3_GetArgType(fn, i), arg, &argSlots[i]);
          argPtrs[i] = &argSlots[i];
        }

        state->pendingException = nullptr;

        M3Result result = m3_Call(fn, argCount, argPtrs.data());
        if (result != m3Err_none) throwWasmError(runtime, *state, result);

        if (retCount == 0) return Value::undefined();

        std::vector<uint64_t> retSlots(retCount);
        std::vector<const void*> retPtrs(retCount);

        for (uint32_t i = 0; i < retCount; i += 1) retPtrs[i] = &retSlots[i];

        result = m3_GetResults(fn, retCount, retPtrs.data());
        if (result != m3Err_none) throwWasmError(runtime, *state, result);

        if (retCount == 1)
          return slotToValue(runtime, m3_GetRetType(fn, 0), &retSlots[0]);

        Array results(runtime, retCount);

        for (uint32_t i = 0; i < retCount; i += 1)
          results.setValueAtIndex(runtime, i, slotToValue(runtime, m3_GetRetType(fn, i), &retSlots[i]));

        return results;
      });
}

Value instantiate(Runtime& rt, const Value* arguments, size_t count) {
  if (count < 1 || !arguments[0].isObject() || !arguments[0].getObject(rt).isArrayBuffer(rt))
    throw JSError(rt, "[WebAssembly] Expected bufferSource to be an ArrayBuffer.");

  ArrayBuffer bufferSource = arguments[0].getObject(rt).getArrayBuffer(rt);

  Object importObject = count > 1 && arguments[1].isObject()
      ? arguments[1].getObject(rt)
      : Object(rt);

  uint32_t stackSizeInBytes = kDefaultStackSizeInBytes;
  uint32_t memoryInitialPages = 0;

  if (count > 2 && arguments[2].isObject()) {
    Object options = arguments[2].getObject(rt);

    Value stackSize = options.getProperty(rt, "stackSizeInBytes");
    if (stackSize.isNumber() && stackSize.getNumber() > 0)
      stackSizeInBytes = static_cast<uint32_t>(stackSize.getNumber());

    Value initialPages = options.getProperty(rt, "memoryInitialPages");
    if (initialPages.isNumber() && initialPages.getNumber() > 0)
      memoryInitialPages = static_cast<uint32_t>(initialPages.getNumber());
  }

  auto state = std::make_shared<InstanceState>();

  state->jsRuntime = &rt;
  state->jsThreadId = std::this_thread::get_id();

  state->moduleBytes.assign(
      bufferSource.data(rt), bufferSource.data(rt) + bufferSource.size(rt));

  state->environment = m3_NewEnvironment();
  if (!state->environment)
    throw JSError(rt, "[WebAssembly] Failed to create environment.");

  state->runtime = m3_NewRuntime(state->environment, stackSizeInBytes, nullptr);
  if (!state->runtime)
    throw JSError(rt, "[WebAssembly] Failed to create runtime.");

  IM3Module module = nullptr;

  M3Result result = m3_ParseModule(
      state->environment,
      &module,
      state->moduleBytes.data(),
      static_cast<uint32_t>(state->moduleBytes.size()));

  if (result != m3Err_none) {
    if (module) m3_FreeModule(module);
    throw JSError(rt, std::string(kTagCompile) + " Failed to parse module: " + result);
  }

  result = m3_LoadModule(state->runtime, module);

  if (result != m3Err_none) {
    m3_FreeModule(module);
    throw JSError(rt, std::string(kTagCompile) + " Failed to load module: " + result);
  }

  // The runtime owns the module from here on.
  state->module = module;
  state->declaredTableSize = scanDeclaredTableSize(state->moduleBytes);

  for (u32 i = 0; i < module->numFunctions; i += 1) {
    const IM3Function f = &module->functions[i];

    if (!f->import.moduleUtf8 || !f->import.fieldUtf8) continue;

    std::string importName = std::string(f->import.moduleUtf8) + "." + f->import.fieldUtf8;

    std::string signature;
    if (!buildSignature(f, signature))
      throw JSError(rt,
          std::string(kTagLink) + " Import \"" + importName +
          "\" has an unsupported signature: wasm3 only supports numeric "
          "arguments and at most one return value.");

    auto entry = std::make_unique<ImportEntry>();
    entry->state = state.get();
    entry->fn = resolveImport(rt, importObject, f->import.moduleUtf8, f->import.fieldUtf8);
    entry->moduleName = f->import.moduleUtf8;
    entry->fieldName = f->import.fieldUtf8;

    // Missing imports still get linked (with a null fn) so calling them
    // traps with a descriptive error instead of failing instantiation.
    result = m3_LinkRawFunctionEx(
        module,
        f->import.moduleUtf8,
        f->import.fieldUtf8,
        signature.c_str(),
        &CallImportedFunction,
        entry.get());

    if (result != m3Err_none)
      throw JSError(rt,
          std::string(kTagLink) + " Failed to link import \"" + importName + "\": " + result);

    state->imports.push_back(std::move(entry));
  }

  result = m3_CompileModule(module);
  if (result != m3Err_none) throwWasmError(rt, *state, result, kTagCompile);

  uint32_t memorySizeInBytes = 0;
  bool hasMemory = m3_GetMemory(state->runtime, &memorySizeInBytes, 0) != nullptr;

  // Best-effort: wasm3 has no true support for imported memories, so
  // env.memory's initial page count is honoured only when the module's own
  // memory can be grown to it. Oversized requests (e.g. emscripten's 2GiB
  // defaults) fall back to the module's declared memory rather than failing.
  if (hasMemory && memoryInitialPages > 0) {
    uint32_t currentPages = memorySizeInBytes / kWasmPageSizeInBytes;

    if (memoryInitialPages > currentPages)
      ResizeMemory(state->runtime, memoryInitialPages);
  }

  state->pendingException = nullptr;

  result = m3_RunStart(module);
  if (result != m3Err_none) throwWasmError(rt, *state, result);

  Object exports(rt);

  Value memoryValue = hasMemory
      ? Value(rt, Object::createFromHostObject(rt, std::make_shared<WasmMemory>(state)))
      : Value::undefined();

  std::vector<ExportRecord> exportRecords;

  if (scanExportSection(state->moduleBytes, exportRecords)) {
    bool memoryExported = false;

    for (const ExportRecord& record : exportRecords) {
      switch (record.kind) {
        case 0: // function (the index space includes imports, as does wasm3's array)
          if (record.index < module->numFunctions)
            exports.setProperty(
                rt,
                PropNameID::forUtf8(rt, record.name),
                makeExportFunction(rt, state, &module->functions[record.index], record.name));
          break;
        case 2: // memory
          if (hasMemory) {
            exports.setProperty(rt, PropNameID::forUtf8(rt, record.name), memoryValue);
            memoryExported = true;
          }
          break;
        case 3: // global
          if (record.index < module->numGlobals)
            exports.setProperty(
                rt,
                PropNameID::forUtf8(rt, record.name),
                Object::createFromHostObject(
                    rt,
                    std::make_shared<WasmGlobal>(state, &module->globals[record.index], record.name)));
          break;
        case 1: // table (wasm MVP has exactly one, wasm3's table0)
          if (record.index == 0)
            exports.setProperty(
                rt,
                PropNameID::forUtf8(rt, record.name),
                Object::createFromHostObject(rt, std::make_shared<WasmTable>(state)));
          break;
        default:
          break;
      }
    }

    // Non-standard nicety kept from earlier versions: a module memory that
    // was never exported is still reachable as `memory`.
    if (hasMemory && !memoryExported && !exports.hasProperty(rt, "memory"))
      exports.setProperty(rt, "memory", memoryValue);
  } else {
    // Defensive fallback (the scan should always succeed on a module wasm3
    // accepted): expose wasm3's own single-name view of the exports.
    for (u32 i = 0; i < module->numFunctions; i += 1) {
      const IM3Function f = &module->functions[i];

      if (!f->export_name) continue;

      exports.setProperty(rt, f->export_name, makeExportFunction(rt, state, f, f->export_name));
    }

    if (hasMemory) exports.setProperty(rt, "memory", memoryValue);
  }

  return Value(rt, exports);
}

} // namespace

namespace webassembly {

void install(Runtime& jsiRuntime) {
  auto RNWebassembly_instantiate = Function::createFromHostFunction(
      jsiRuntime,
      PropNameID::forAscii(jsiRuntime, "RNWebassembly_instantiate"),
      3,
      [](Runtime& runtime, const Value& /*thisValue*/, const Value* arguments, size_t count) -> Value {
        return instantiate(runtime, arguments, count);
      });

  jsiRuntime.global().setProperty(
      jsiRuntime, "RNWebassembly_instantiate", std::move(RNWebassembly_instantiate));

  // WebAssembly.validate: a parse-only pass over the bytes.
  auto RNWebassembly_validate = Function::createFromHostFunction(
      jsiRuntime,
      PropNameID::forAscii(jsiRuntime, "RNWebassembly_validate"),
      1,
      [](Runtime& runtime, const Value& /*thisValue*/, const Value* arguments, size_t count) -> Value {
        if (count < 1 || !arguments[0].isObject() || !arguments[0].getObject(runtime).isArrayBuffer(runtime))
          throw JSError(runtime, "[WebAssembly] Expected bufferSource to be an ArrayBuffer.");

        ArrayBuffer buffer = arguments[0].getObject(runtime).getArrayBuffer(runtime);

        IM3Environment environment = m3_NewEnvironment();
        if (!environment) return Value(false);

        IM3Module module = nullptr;
        M3Result result = m3_ParseModule(
            environment, &module, buffer.data(runtime), static_cast<uint32_t>(buffer.size(runtime)));

        if (module) m3_FreeModule(module);
        m3_FreeEnvironment(environment);

        return Value(result == m3Err_none);
      });

  jsiRuntime.global().setProperty(
      jsiRuntime, "RNWebassembly_validate", std::move(RNWebassembly_validate));
}

} // namespace webassembly
