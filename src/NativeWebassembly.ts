import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /**
   * The JSI bindings (RNWebassembly_instantiate / RNWebassembly_validate)
   * are installed when this TurboModule is created, via
   * RCTTurboModuleWithJSIBindings. Calling install() only reports success —
   * it exists so JS can fail loudly when the binding is absent.
   */
  install(): boolean;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Webassembly');
