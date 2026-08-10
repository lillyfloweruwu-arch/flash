#pragma once

#include "clip_writer.h"
#include <algorithm>
#include <cstdint>
#include <string>

namespace flash {

inline constexpr int64_t kHundredNanosecondsPerSecond = 10000000;

constexpr int64_t RebaseTrimTimestamp(int64_t timestamp, int64_t actualStart) {
    return (std::max)(int64_t{0}, timestamp - actualStart);
}

constexpr double TrimTimestampSeconds(int64_t timestamp) {
    return static_cast<double>(timestamp) / kHundredNanosecondsPerSecond;
}

ClipMetadata TrimClip(const std::string& inputPath, const std::string& outputPath,
    int64_t startUs, int64_t endUs);

} // namespace flash
