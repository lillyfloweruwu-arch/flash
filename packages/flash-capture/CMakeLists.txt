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
  )
endif()

# Source files
set(CAPTURE_SOURCES
  src/binding.cpp
  src/capture/screen_capture.cpp
  src/capture/audio_capture.cpp
  src/encoding/encoder_factory.cpp
  src/encoding/nvenc_encoder.cpp
  src/encoding/amf_encoder.cpp
  src/encoding/software_encoder.cpp
  src/buffer/ring_buffer.cpp
  src/buffer/clip_writer.cpp
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
endif()

# NAPI version
target_compile_definitions(flash_capture PRIVATE NAPI_VERSION=8)
