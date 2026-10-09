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
if(WIN32)
  set(CAPTURE_SOURCES
    src/platform/windows/factory.cpp
    src/binding.cpp
    src/platform/windows/process_list.cpp
    src/platform/windows/screen_capture.cpp
    src/platform/windows/png_writer.cpp
    src/platform/windows/wgc_source.cpp
    src/platform/windows/audio_capture.cpp
    src/platform/windows/voice_trigger.cpp
    src/platform/windows/encoder_factory.cpp
    src/platform/windows/mf_hardware_encoder.cpp
    src/platform/windows/software_encoder.cpp
    src/core/ring_buffer.cpp
    src/platform/windows/clip_writer.cpp
    src/platform/windows/clip_exporter.cpp
    src/platform/windows/clip_trimmer.cpp
    src/platform/windows/smart_render.cpp
    src/platform/windows/audio_decode.cpp
  )

elseif(UNIX AND NOT APPLE)
  find_package(PkgConfig REQUIRED)
  pkg_check_modules(LINUX_MEDIA REQUIRED IMPORTED_TARGET
    libpipewire-0.3 libavcodec libavformat libavutil libswscale libswresample gio-2.0 gio-unix-2.0)
  find_package(Threads REQUIRED)
  set(PLATFORM_LIBS PkgConfig::LINUX_MEDIA Threads::Threads)
  file(GLOB LINUX_SOURCES CONFIGURE_DEPENDS src/platform/linux/*.cpp)
  set(CAPTURE_SOURCES src/binding.cpp src/core/ring_buffer.cpp ${LINUX_SOURCES})
else()
  message(FATAL_ERROR "Flash capture supports Windows and Linux only")
endif()

# Build as Node.js native addon
add_library(flash_capture SHARED ${CAPTURE_SOURCES} ${CMAKE_JS_SRC})
set_target_properties(flash_capture PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)
target_link_libraries(flash_capture ${CMAKE_JS_LIB} ${PLATFORM_LIBS})

# Windows.Graphics.Capture, used to record fullscreen games that Desktop
# Duplication cannot see. The C++/WinRT projection ships with the Windows SDK
# but is not on the default include path, so point at the version CMake has
# already selected rather than hardcoding one.
if(WIN32)
  target_link_libraries(flash_capture windowsapp)
  if(CMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION)
    set(FLASH_CPPWINRT
      "$ENV{ProgramFiles\(x86\)}/Windows Kits/10/Include/${CMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION}/cppwinrt")
    if(EXISTS "${FLASH_CPPWINRT}")
      target_include_directories(flash_capture PRIVATE "${FLASH_CPPWINRT}")
    else()
      message(WARNING "C++/WinRT headers not found at ${FLASH_CPPWINRT}; fullscreen capture will not build")
    endif()
  endif()
endif()

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
enable_testing()
set(FLASH_TEST_TARGETS "" CACHE INTERNAL "self-check targets")
function(flash_add_test name)
  add_executable(${name} EXCLUDE_FROM_ALL ${ARGN})
  set(FLASH_TEST_TARGETS ${FLASH_TEST_TARGETS} ${name} CACHE INTERNAL "self-check targets")
  add_test(NAME ${name} COMMAND ${name})
  target_link_libraries(${name} ${PLATFORM_LIBS})
  if(MSVC)
    target_compile_options(${name} PRIVATE /W4 /EHsc /UNDEBUG)
    target_compile_definitions(${name} PRIVATE NOMINMAX)
  else()
    target_compile_options(${name} PRIVATE -UNDEBUG)
  endif()
endfunction()

flash_add_test(flash_ring_buffer_test test/ring_buffer_test.cpp src/core/ring_buffer.cpp)
flash_add_test(flash_quality_test test/quality_test.cpp)
flash_add_test(flash_audio_track_test test/audio_track_test.cpp)
flash_add_test(flash_clip_trimmer_test test/clip_trimmer_test.cpp)
flash_add_test(flash_export_budget_test test/export_budget_test.cpp)
flash_add_test(flash_color_space_test test/color_space_test.cpp)
flash_add_test(flash_audio_decode_test test/audio_decode_test.cpp)
flash_add_test(flash_smart_render_test test/smart_render_test.cpp)
flash_add_test(flash_voice_trigger_test test/voice_trigger_test.cpp)
if(WIN32)
  flash_add_test(flash_screenshot_test
    test/screenshot_test.cpp
    src/platform/windows/screen_capture.cpp
    src/platform/windows/png_writer.cpp
    src/platform/windows/wgc_source.cpp
  )
  flash_add_test(flash_process_list_test test/process_list_test.cpp src/platform/windows/process_list.cpp)
  target_link_libraries(flash_screenshot_test windowsapp)
  if(FLASH_CPPWINRT)
    target_include_directories(flash_screenshot_test PRIVATE "${FLASH_CPPWINRT}")
  endif()

  # Reports rather than asserts: whether a speech language pack is installed is
  # a fact about the machine, not a defect. Answers whether SpeechRecognizer
  # works at all from an unpackaged Win32 process before anything is built on it.
  flash_add_test(flash_voice_probe test/voice_probe.cpp)
  target_link_libraries(flash_voice_probe windowsapp)
  if(FLASH_CPPWINRT)
    target_include_directories(flash_voice_probe PRIVATE "${FLASH_CPPWINRT}")
  endif()

  # A measuring tool, not a check: it needs a microphone and a person talking.
  # The confidence floor the design depends on comes out of this, rather than
  # out of a number someone picked.
  flash_add_test(flash_voice_calibrate test/voice_calibrate.cpp)
  target_link_libraries(flash_voice_calibrate windowsapp)
  if(FLASH_CPPWINRT)
    target_include_directories(flash_voice_calibrate PRIVATE "${FLASH_CPPWINRT}")
  endif()
endif()

# One target for every self-check, so a test run cannot quietly grade last
# week's binaries. `pnpm test` builds this before it runs anything.
add_custom_target(flash_tests DEPENDS ${FLASH_TEST_TARGETS})
