#import "Webassembly.h"

#import <ReactCommon/RCTTurboModuleWithJSIBindings.h>
#import <jsi/jsi.h>

#import "react-native-webassembly.h"

// Bridgeless-native JSI installation: the runtime is handed to the module
// when it is created (first TurboModuleRegistry access), so the bindings
// exist before any JS can call them. Requires React Native's New
// Architecture (RN >= 0.74 for the callInvoker variant; this library
// documents a modern-RN floor and has no legacy-architecture path).
@interface Webassembly () <RCTTurboModuleWithJSIBindings>
@end

@implementation Webassembly

RCT_EXPORT_MODULE()

- (void)installJSIBindingsWithRuntime:(facebook::jsi::Runtime &)runtime
                          callInvoker:(const std::shared_ptr<facebook::react::CallInvoker> &)callInvoker
{
  webassembly::install(runtime);
}

- (NSNumber *)install
{
  // The actual installation happened in installJSIBindingsWithRuntime when
  // this module was created; this method exists so JS can verify.
  return @true;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeWebassemblySpecJSI>(params);
}

@end
