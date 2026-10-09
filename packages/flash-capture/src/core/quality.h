#pragma once
#include <cstdint>
#include <cmath>

namespace flash {
inline uint32_t ComputeEvenWidth(uint32_t sourceWidth, uint32_t sourceHeight, uint32_t targetHeight) {
    if (!sourceWidth || !sourceHeight || !targetHeight) return 0;
    const double scaled = static_cast<double>(sourceWidth) * targetHeight / sourceHeight;
    uint32_t width = static_cast<uint32_t>(std::lround(scaled));
    return (width + 1) & ~1u;
}
}
