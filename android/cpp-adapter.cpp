#include <jni.h>
#include <jsi/jsi.h>

#include "react-native-webassembly.h"

extern "C" JNIEXPORT void JNICALL
Java_com_webassembly_WebassemblyModule_nativeInstall(JNIEnv * /*env*/, jobject /*thiz*/, jlong jsiRuntimePointer) {
  auto *runtime = reinterpret_cast<facebook::jsi::Runtime *>(jsiRuntimePointer);
  if (runtime) {
    webassembly::install(*runtime);
  }
}
