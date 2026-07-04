package com.webassembly;

import com.facebook.react.bridge.ReactApplicationContext;

// Codegen-generated spec (from src/NativeWebassembly.ts). The JSI bindings
// are installed when JS calls install(); there is no legacy-architecture
// path (modern-RN floor, mirroring the validated iOS implementation).
public class WebassemblyModule extends NativeWebassemblySpec {
  public static final String NAME = "Webassembly";

  // Per-instance, NOT static: a dev reload creates a fresh JS runtime (with
  // no bindings) and a fresh module instance. A static flag would survive
  // the reload and skip re-installation into the new runtime.
  private boolean installed = false;

  static {
    System.loadLibrary("react-native-webassembly-runtime");
  }

  private native void nativeInstall(long jsiRuntimePointer);

  public WebassemblyModule(ReactApplicationContext reactContext) {
    super(reactContext);
  }

  @Override
  public String getName() {
    return NAME;
  }

  @Override
  public boolean install() {
    if (installed) {
      return true;
    }

    long runtimePointer =
        getReactApplicationContext().getJavaScriptContextHolder().get();

    if (runtimePointer == 0) {
      return false;
    }

    nativeInstall(runtimePointer);
    installed = true;
    return true;
  }
}
