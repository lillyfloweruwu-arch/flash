#pragma once
#include <chrono>
#include <cstdint>

namespace flash {
inline int64_t CaptureClockUs() {
    using Clock = std::chrono::steady_clock;
    static const auto epoch = Clock::now();
    return std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - epoch).count();
}
} // namespace flash
