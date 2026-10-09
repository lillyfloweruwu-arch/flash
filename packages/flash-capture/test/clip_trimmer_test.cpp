#include "../src/core/clip_trimmer.h"
#include <cassert>
#include <iostream>

int main() {
    constexpr int64_t requested = 55000000; // 5.5 s
    constexpr int64_t keyframe = 40000000;  // seek snapped back to 4 s
    static_assert(flash::RebaseTrimTimestamp(requested, keyframe) == 15000000);
    static_assert(flash::RebaseTrimTimestamp(keyframe - 1, keyframe) == 0);
    static_assert(flash::TrimTimestampSeconds(keyframe) == 4.0);
    assert(flash::TrimTimestampSeconds(
        flash::RebaseTrimTimestamp(100000000, keyframe)) == 6.0);
    std::cout << "clip trimmer self-check passed: requested 5.5s, actual 4s, rebased 1.5s\n";
}
