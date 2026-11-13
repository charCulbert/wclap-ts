# Heavy Main: stereo gain and pan with no interface of its own.
#
#   cmake -B build && cmake --build build     CLAP, VST3, AU (macOS), standalone
#   WCLAP: see README.md for the one extra flag (the WASI SDK toolchain).
cmake_minimum_required(VERSION 3.28)

# macOS plugins here are universal (Apple silicon and Intel).
if(CMAKE_HOST_APPLE AND NOT CMAKE_SYSTEM_NAME AND NOT DEFINED CMAKE_OSX_ARCHITECTURES)
    set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64")
endif()

project(HeavyMain VERSION 1.0.0 LANGUAGES C CXX)
if(APPLE)
    enable_language(OBJC OBJCXX)
endif()
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release)
endif()
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON) # build/compile_commands.json, where clangd finds the downloaded headers
if(MSVC) # clap-wrapper and the VST3 SDK use the DLL runtime (/MD)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")
endif()
if(CMAKE_SYSTEM_NAME STREQUAL "Linux") # VST3 modules link static libraries
    set(CMAKE_POSITION_INDEPENDENT_CODE ON)
endif()

# This template's libraries (libs/), at a release: read its release notes before
# changing GIT_TAG. To build against a local checkout of it instead:
#   cmake -B build -DFETCHCONTENT_SOURCE_DIR_CLAP_TEMPLATE=<checkout>
include(FetchContent)
FetchContent_Declare(clap_template
    GIT_REPOSITORY https://github.com/charCulbert/char-clap-template.git
    GIT_TAG v0.6.1
    GIT_SHALLOW TRUE
    SOURCE_SUBDIR none) # only libs/: the template's own CMakeLists isn't for plugins
FetchContent_MakeAvailable(clap_template)
set(LIBS "${clap_template_SOURCE_DIR}/libs")
include(${LIBS}/core/core.cmake)

add_library(HeavyMain_impl STATIC plugin.cpp)
core_add_to(HeavyMain_impl)

set(formats CLAP VST3)
if(APPLE)
    list(APPEND formats AUV2)
endif()
if(CMAKE_SYSTEM_NAME STREQUAL "WASI")
    set(formats WCLAP)
endif()

make_clapfirst_plugins(
    TARGET_NAME HeavyMain
    IMPL_TARGET HeavyMain_impl
    ENTRY_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/entry.cpp"
    OUTPUT_NAME "Heavy Main"
    BUNDLE_IDENTIFIER "com.charlieculbert.heavy-main"
    BUNDLE_VERSION "${PROJECT_VERSION}"
    AUV2_MANUFACTURER_NAME "Charlie Culbert"
    AUV2_MANUFACTURER_CODE "Chcu"
    AUV2_SUBTYPE_CODE "hvmn"
    AUV2_INSTRUMENT_TYPE "aufx"
    PLUGIN_FORMATS ${formats}
    STANDALONE_CONFIGURATIONS standalone "Heavy Main" "com.charlieculbert.heavy-main"
    COPY_AFTER_BUILD FALSE)

core_ship_resources(HeavyMain "") # no files to ship: this signs and packages the plugins
