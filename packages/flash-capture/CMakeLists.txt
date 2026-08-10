cmake_minimum_required(VERSION 3.20)
project(flash_capture LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Node.js addon via cmake-js
include_directories(${CMAKE_JS_INC})

# Windows APIs
if(WIN32)
  set(PLATFORM_LIBS
    d3d11
    dxgi
    d3dcompiler
    windowscodecs
    mfplat
    mfuuid
    mf
    mfreadwrite
    ole32
    uuid
    winmm
    mmdevapi
  )
endif()

# Source files
set(CAPTURE_SOURCES
  src/binding.cpp
  src/capture/screen_capture.cpp
  src/capture/audio_capture.cpp
  src/encoding/encoder_factory.cpp
  src/encoding/mf_hardware_encoder.cpp
  src/encoding/software_encoder.cpp
  src/buffer/ring_buffer.cpp
  src/buffer/clip_writer.cpp
  src/buffer/clip_exporter.cpp
  src/buffer/clip_trimmer.cpp
  src/buffer/audio_decode.cpp
)

# Build as Node.js native addon
add_library(flash_capture SHARED ${CAPTURE_SOURCES} ${CMAKE_JS_SRC})
set_target_properties(flash_capture PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)
target_link_libraries(flash_capture ${CMAKE_JS_LIB} ${PLATFORM_LIBS})

# node-addon-api (N-API wrapper)
execute_process(
  COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
target_include_directories(flash_capture PRIVATE ${NODE_ADDON_API_DIR})

# Optional public hardware SDK headers. The runtime DLLs are always loaded
# dynamically, so neither SDK adds a link-time dependency.
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/third_party/nv-codec-headers/include/nvEncodeAPI.h")
  target_include_directories(flash_capture PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/third_party/nv-codec-headers/include")
endif()
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/third_party/AMF/amf/public/include/core/Factory.h")
  target_include_directories(flash_capture PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/third_party/AMF/amf")
endif()

if(MSVC)
  target_compile_options(flash_capture PRIVATE /W4 /EHsc)
  target_compile_definitions(flash_capture PRIVATE
    NOMINMAX
    _SILENCE_CXX20_U8PATH_DEPRECATION_WARNING
  )
endif()

# NAPI version
target_compile_definitions(flash_capture PRIVATE NAPI_VERSION=8)

# Self-checks. Not built by default — cmake-js only builds the addon.
#
# /UNDEBUG is the point of this helper. CMake's Release config passes /DNDEBUG,
# which compiles every assert() to nothing, so a Release test exits 0 whether or
# not its assertions hold. Undefining it keeps the asserts live in every config.
function(flash_add_test name)
  add_executable(${name} EXCLUDE_FROM_ALL ${ARGN})
  target_link_libraries(${name} ${PLATFORM_LIBS})
  if(MSVC)
    target_compile_options(${name} PRIVATE /W4 /EHsc /UNDEBUG)
    target_compile_definitions(${name} PRIVATE NOMINMAX)
  endif()
endfunction()

flash_add_test(flash_ring_buffer_test test/ring_buffer_test.cpp src/buffer/ring_buffer.cpp)
flash_add_test(flash_quality_test test/quality_test.cpp)
flash_add_test(flash_audio_track_test test/audio_track_test.cpp)
flash_add_test(flash_clip_trimmer_test test/clip_trimmer_test.cpp)
flash_add_test(flash_export_budget_test test/export_budget_test.cpp)
flash_add_test(flash_color_space_test test/color_space_test.cpp)
flash_add_test(flash_audio_decode_test test/audio_decode_test.cpp)
flash_add_test(flash_smart_render_test test/smart_render_test.cpp)
