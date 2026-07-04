// Local JSI host for exercising the binding end-to-end without a device:
// JavaScriptCore (macOS system framework) + the wasm3 JSI binding.
//
// Usage: harness <script.js> [more scripts...]
// Scripts run in order in one runtime. The process exits 0 iff a script set
// `globalThis.__testResult` and no script set `globalThis.__testError`.
//
// Host functions provided to JS:
//   __print(...args)                      -> stdout
//   __readFileArrayBuffer(path)           -> ArrayBuffer
//   __fillRandom(arrayBuffer, off, len)   -> arc4random_buf into the buffer
//   __hrtimeMs()                          -> monotonic ms

#include <jsi/jsi.h>

#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "JSCRuntime.h"
#include "react-native-webassembly.h"

using namespace facebook;

namespace {

class VectorBuffer : public jsi::MutableBuffer {
 public:
  explicit VectorBuffer(std::vector<uint8_t> data) : data_(std::move(data)) {}
  size_t size() const override { return data_.size(); }
  uint8_t* data() override { return data_.data(); }

 private:
  std::vector<uint8_t> data_;
};

std::string coerceToString(jsi::Runtime& rt, const jsi::Value& value) {
  return rt.global()
      .getPropertyAsFunction(rt, "String")
      .call(rt, value)
      .getString(rt)
      .utf8(rt);
}

void installHostFunctions(jsi::Runtime& rt) {
  rt.global().setProperty(
      rt,
      "__print",
      jsi::Function::createFromHostFunction(
          rt,
          jsi::PropNameID::forAscii(rt, "__print"),
          1,
          [](jsi::Runtime& runtime, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
            std::string line;
            for (size_t i = 0; i < count; i += 1) {
              if (i) line += " ";
              line += coerceToString(runtime, args[i]);
            }
            fprintf(stdout, "%s\n", line.c_str());
            fflush(stdout);
            return jsi::Value::undefined();
          }));

  rt.global().setProperty(
      rt,
      "__readFileArrayBuffer",
      jsi::Function::createFromHostFunction(
          rt,
          jsi::PropNameID::forAscii(rt, "__readFileArrayBuffer"),
          1,
          [](jsi::Runtime& runtime, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
            std::string path = args[0].asString(runtime).utf8(runtime);
            std::ifstream file(path, std::ios::binary);
            if (!file) throw jsi::JSError(runtime, "Cannot open file: " + path);
            std::vector<uint8_t> data(
                (std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
            return jsi::ArrayBuffer(
                runtime, std::make_shared<VectorBuffer>(std::move(data)));
          }));

  rt.global().setProperty(
      rt,
      "__fillRandom",
      jsi::Function::createFromHostFunction(
          rt,
          jsi::PropNameID::forAscii(rt, "__fillRandom"),
          3,
          [](jsi::Runtime& runtime, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
            jsi::ArrayBuffer buffer =
                args[0].asObject(runtime).getArrayBuffer(runtime);
            size_t offset = static_cast<size_t>(args[1].asNumber());
            size_t length = static_cast<size_t>(args[2].asNumber());
            if (offset + length > buffer.size(runtime))
              throw jsi::JSError(runtime, "__fillRandom out of bounds.");
            arc4random_buf(buffer.data(runtime) + offset, length);
            return jsi::Value::undefined();
          }));

  rt.global().setProperty(
      rt,
      "__hrtimeMs",
      jsi::Function::createFromHostFunction(
          rt,
          jsi::PropNameID::forAscii(rt, "__hrtimeMs"),
          0,
          [](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) -> jsi::Value {
            struct timespec ts;
            clock_gettime(CLOCK_MONOTONIC, &ts);
            return jsi::Value(ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6);
          }));
}

} // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s <script.js> [more scripts...]\n", argv[0]);
    return 64;
  }

  std::unique_ptr<jsi::Runtime> runtime = facebook::jsc::makeJSCRuntime();
  jsi::Runtime& rt = *runtime;

  installHostFunctions(rt);
  webassembly::install(rt);

  for (int i = 1; i < argc; i += 1) {
    std::ifstream file(argv[i]);
    if (!file) {
      fprintf(stderr, "cannot open script: %s\n", argv[i]);
      return 66;
    }
    std::stringstream source;
    source << file.rdbuf();

    try {
      rt.evaluateJavaScript(
          std::make_shared<jsi::StringBuffer>(source.str()), argv[i]);
      rt.drainMicrotasks();
    } catch (const jsi::JSError& e) {
      fprintf(stderr, "JS error in %s: %s\n%s\n", argv[i], e.getMessage().c_str(), e.getStack().c_str());
      return 1;
    } catch (const std::exception& e) {
      fprintf(stderr, "native error in %s: %s\n", argv[i], e.what());
      return 1;
    }
  }

  jsi::Value error = rt.global().getProperty(rt, "__testError");
  if (!error.isUndefined()) {
    fprintf(stderr, "TEST ERROR: %s\n", coerceToString(rt, error).c_str());
    return 1;
  }

  jsi::Value result = rt.global().getProperty(rt, "__testResult");
  if (result.isUndefined()) {
    fprintf(stderr, "TEST INCOMPLETE: __testResult was never set\n");
    return 1;
  }

  fprintf(stdout, "%s\n", coerceToString(rt, result).c_str());
  return 0;
}
