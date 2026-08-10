#pragma once

#include <algorithm>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

namespace flash {

// One walk of the video stream yields everything the trimmer and the editor
// both need: where the keyframes are, how many bytes the stream actually uses,
// and where it ends. Kept together because it is one pass over every sample and
// doing it twice is the expensive part.
struct VideoScan {
    std::vector<int64_t> keyframesUs;
    uint64_t bytes = 0;
    int64_t lastTimeUs = 0;
};

// Opens the clip itself. The trimmer uses the reader-taking overload instead,
// since it already has one open.
VideoScan ScanClipVideo(const std::string& path);

// Bits per second the source video really uses, or 0 when it cannot be told.
inline uint32_t VideoBitrate(const VideoScan& scan) {
    const double seconds = scan.lastTimeUs / 1000000.0;
    if (seconds <= 0.0) return 0;
    return static_cast<uint32_t>((std::min)(
        static_cast<double>((std::numeric_limits<uint32_t>::max)()),
        static_cast<double>(scan.bytes) * 8.0 / seconds));
}

struct SmartRenderPlan {
    bool needsHeadEncode = false;
    int64_t headStartUs = 0;
    int64_t headEndUs = 0;
    int64_t copyStartUs = 0;
};

// keyframesUs must be sorted ascending. The returned plan re-encodes
// [headStartUs, headEndUs) and copies samples from copyStartUs onward.
//
// toleranceUs exists because real keyframes land on timestamps like 3728650,
// never on round numbers. Matching exactly means missing by a single
// microsecond re-encodes an entire GOP: measured at 93ms versus 24s on the
// same clip, for a 50us difference in the requested in-point. Callers should
// pass half a frame duration, which is below anything a user can perceive and
// far above float round-trip noise.
inline SmartRenderPlan PlanSmartRender(const std::vector<int64_t>& keyframesUs,
                                       int64_t startUs, int64_t endUs,
                                       int64_t toleranceUs = 0) {
    SmartRenderPlan plan;
    if (endUs <= startUs) {
        plan.headStartUs = plan.headEndUs = plan.copyStartUs = startUs;
        return plan;
    }
    bool onKeyframe = false;
    for (const int64_t key : keyframesUs) {
        const int64_t distance = key > startUs ? key - startUs : startUs - key;
        if (distance <= toleranceUs) { onKeyframe = true; break; }
        if (key > startUs) break;   // sorted, so nothing later can be closer
    }
    if (onKeyframe) {
        plan.copyStartUs = startUs;
        return plan;
    }
    const auto next = std::upper_bound(keyframesUs.begin(), keyframesUs.end(), startUs);
    const int64_t boundary = next == keyframesUs.end() ? endUs : (std::min)(*next, endUs);
    plan.needsHeadEncode = true;
    plan.headStartUs = startUs;
    plan.headEndUs = boundary;
    plan.copyStartUs = boundary;
    return plan;
}

} // namespace flash
