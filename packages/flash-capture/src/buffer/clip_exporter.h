#pragma once

#include <cstdint>
#include <string>

namespace flash {

struct ExportOptions {
    uint64_t maxBytes = 10ull * 1024 * 1024;
    uint32_t maxHeight = 0;      // 0 = no ceiling beyond the source
    int64_t startUs = 0;
    int64_t endUs = 0;           // 0 = to the end of the clip
};

struct ExportResult {
    std::string filePath;
    double durationSeconds = 0.0;
    uint32_t width = 0, height = 0;
    uint64_t bytes = 0;
    uint32_t bitrateKbps = 0;
};

// Re-encodes a saved clip into a small copy that fits maxBytes, mixing every
// audio track down to one. Capture bitrate stays archival-high on purpose; this
// produces a sibling that can actually be uploaded.
ExportResult ExportClip(const std::string& inputPath, const std::string& outputPath,
                        const ExportOptions& options);

} // namespace flash
