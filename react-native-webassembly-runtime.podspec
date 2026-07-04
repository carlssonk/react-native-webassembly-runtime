require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "react-native-webassembly-runtime"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  # release-please tags releases as v<version> (include-v-in-tag).
  s.source       = { :git => "https://github.com/carlssonk/react-native-webassembly-runtime.git", :tag => "v#{s.version}" }

  s.source_files = "ios/**/*.{h,m,mm}", "cpp/**/*.{h,c,cpp}"

  s.pod_target_xcconfig = {
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++20",
    "CLANG_CXX_LIBRARY" => "libc++"
  }

  # Adds the correct React/folly/codegen dependencies for the consumer's
  # React Native version (available since RN 0.71).
  install_modules_dependencies(s)
end
