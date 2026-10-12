#pragma once

#include <array>
#include <cstdint>
#include <string>

#include "audio_tracks.h"

namespace flash {

// What the caller asked for. Auto walks the platform's codec ladder and takes
// the first one with a hardware encoder; the result says which it got.
enum class ExportCodecChoice { H264, Auto };

struct ExportOptions {
    uint64_t maxBytes = 10ull * 1024 * 1024;
    uint32_t maxHeight = 0;      // 0 = no ceiling beyond the source
    int64_t startUs = 0;
    int64_t endUs = 0;           // 0 = to the end of the clip
    // One gain per track, in kAudioTrackOrder. Zero is silence.
    std::array<float, kAudioTrackCount> gains{1.0f, 1.0f, 1.0f, 1.0f, 1.0f};
    uint32_t saturation = 100;   // percent; 100 skips the chroma pass entirely
    ExportCodecChoice codec = ExportCodecChoice::H264;
    uint32_t maxFps = 0;         // 0 = keep the source frame rate
};

struct ExportResult {
    std::string filePath;
    double durationSeconds = 0.0;
    uint32_t width = 0, height = 0;
    uint64_t bytes = 0;
    uint32_t bitrateKbps = 0;
    std::string codec = "h264";  // "av1", "hevc" or "h264": what was actually encoded
};

// Re-encodes a saved clip into a small copy that fits maxBytes, mixing every
// audio track down to one. Capture bitrate stays archival-high on purpose; this
// produces a sibling that can actually be uploaded.
ExportResult ExportClip(const std::string& inputPath, const std::string& outputPath,
                        const ExportOptions& options);

} // namespace flash
