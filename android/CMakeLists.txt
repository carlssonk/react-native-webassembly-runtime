cmake_minimum_required(VERSION 3.22.1)
project(reactnativewebassembly)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_C_STANDARD 11)

find_package(ReactAndroid REQUIRED CONFIG)

add_library(react-native-webassembly-runtime SHARED
    ../cpp/react-native-webassembly.cpp
    cpp-adapter.cpp
    ../cpp/m3_api_libc.c
    ../cpp/m3_api_meta_wasi.c
    ../cpp/m3_api_tracer.c
    ../cpp/m3_api_uvwasi.c
    ../cpp/m3_api_wasi.c
    ../cpp/m3_bind.c
    ../cpp/m3_code.c
    ../cpp/m3_compile.c
    ../cpp/m3_core.c
    ../cpp/m3_env.c
    ../cpp/m3_exec.c
    ../cpp/m3_function.c
    ../cpp/m3_info.c
    ../cpp/m3_module.c
    ../cpp/m3_parse.c
)

target_include_directories(react-native-webassembly-runtime PRIVATE ../cpp)

find_library(log-lib log)

target_link_libraries(react-native-webassembly-runtime
    ReactAndroid::jsi
    ReactAndroid::reactnative
    android
    ${log-lib}
)
