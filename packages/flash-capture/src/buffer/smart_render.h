#pragma once

#include <algorithm>
#include <cstdint>
#include <vector>

namespace flash {

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
