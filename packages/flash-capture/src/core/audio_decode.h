#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace flash {

struct DecodedTrack {
    std::string id;
    std::vector<float> samples;
};

// Averaged, not summed: three tracks are mixed downstream and summing here
// would clip before the mixer ever sees the signal.
inline float DownmixToMono(const float* frame, uint32_t channels) {
    if (!frame || !channels) return 0.0f;
    float total = 0.0f;
    for (uint32_t c = 0; c < channels; ++c) total += frame[c];
    return total / static_cast<float>(channels);
}

// Linear interpolation. Preview audio only, so quality past this is wasted.
inline void ResampleLinear(const std::vector<float>& source, uint32_t sourceRate,
                           uint32_t targetRate, std::vector<float>& out) {
    out.clear();
    if (source.empty() || !sourceRate || !targetRate) return;
    if (sourceRate == targetRate) { out = source; return; }
    const double ratio = static_cast<double>(sourceRate) / targetRate;
    const size_t count = static_cast<size_t>(source.size() / ratio);
    out.reserve(count);
    for (size_t i = 0; i < count; ++i) {
        const double at = i * ratio;
        const size_t index = static_cast<size_t>(at);
        const double fraction = at - index;
        const float a = source[index];
        const float b = index + 1 < source.size() ? source[index + 1] : a;
        out.push_back(static_cast<float>(a + (b - a) * fraction));
    }
}

// Returns one entry per audio track present in the clip, in kAudioTrackOrder.
// Tracks that fail to decode are returned empty rather than omitted, so the
// caller can still map results onto lanes by index.
std::vector<DecodedTrack> DecodeClipAudio(const std::string& path, uint32_t targetRate);

} // namespace flash
