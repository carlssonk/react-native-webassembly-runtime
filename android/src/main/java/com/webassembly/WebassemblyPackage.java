package com.webassembly;

import androidx.annotation.Nullable;

import com.facebook.react.BaseReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.module.model.ReactModuleInfo;
import com.facebook.react.module.model.ReactModuleInfoProvider;

import java.util.HashMap;
import java.util.Map;

public class WebassemblyPackage extends BaseReactPackage {
  @Nullable
  @Override
  public NativeModule getModule(String name, ReactApplicationContext reactContext) {
    if (name.equals(WebassemblyModule.NAME)) {
      return new WebassemblyModule(reactContext);
    }
    return null;
  }

  @Override
  public ReactModuleInfoProvider getReactModuleInfoProvider() {
    return () -> {
      Map<String, ReactModuleInfo> map = new HashMap<>();
      map.put(
          WebassemblyModule.NAME,
          new ReactModuleInfo(
              WebassemblyModule.NAME,
              WebassemblyModule.NAME,
              false, // canOverrideExistingModule
              false, // needsEagerInit
              false, // isCxxModule
              true // isTurboModule
              ));
      return map;
    };
  }
}
