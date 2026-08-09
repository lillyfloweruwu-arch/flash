#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace flash {

// Converts mono/stereo/interleaved input to stereo and linearly resamples it.
inline std::vector<float> ResampleStereo(const float* input, uint32_t frames, uint32_t channels,
    uint32_t inputRate, uint32_t outputRate = 48000) {
    if (!input || !frames || !channels || !inputRate || !outputRate) return {};
    const uint32_t outFrames = static_cast<uint32_t>((static_cast<uint64_t>(frames) * outputRate + inputRate / 2) / inputRate);
    std::vector<float> output(static_cast<size_t>(outFrames) * 2);
    for (uint32_t i = 0; i < outFrames; ++i) {
        const double position = static_cast<double>(i) * inputRate / outputRate;
        const uint32_t a = (std::min)(static_cast<uint32_t>(position), frames - 1);
        const uint32_t b = (std::min)(a + 1, frames - 1);
        const float t = static_cast<float>(position - a);
        for (uint32_t c = 0; c < 2; ++c) {
            const uint32_t sourceChannel = channels == 1 ? 0 : (std::min)(c, channels - 1);
            const float av = input[static_cast<size_t>(a) * channels + sourceChannel];
            const float bv = input[static_cast<size_t>(b) * channels + sourceChannel];
            output[static_cast<size_t>(i) * 2 + c] = av + (bv - av) * t;
        }
    }
    return output;
}

inline int64_t AudioPacketStartUs(int64_t devicePositionFrames, int64_t firstDevicePosition,
    int64_t firstClockUs, uint32_t sampleRate) {
    return firstClockUs + (devicePositionFrames - firstDevicePosition) * 1000000LL / sampleRate;
}
} // namespace flash
